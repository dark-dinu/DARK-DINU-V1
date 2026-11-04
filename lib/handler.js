const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const config = require('../config');
const store = require('./store');
const U = require('./utils');

const commands = new Map();
const aliases = new Map();
const events = new Map();

/**
 * Register a command.
 * cmd({ pattern, alias, desc, category, owner, group, pm, admin, botAdmin, react }, async (sock, m, ctx) => {})
 * ctx = { S, args, text, prefix, isOwner, cfg, config, command }
 */
function cmd(info, func) {
    if (!info.pattern) throw new Error('Command must have a pattern.');
    const c = {
        pattern: info.pattern.toLowerCase(),
        alias: (info.alias || []).map((a) => a.toLowerCase()),
        desc: info.desc || '',
        category: info.category || 'general',
        owner: !!(info.owner || info.fromMe),
        group: !!(info.group || info.onlyGroup),
        pm: !!(info.pm || info.onlyPm),
        admin: !!(info.admin || info.onlyAdmin),
        botAdmin: !!info.botAdmin,
        react: info.react || null,
        execute: func
    };
    commands.set(c.pattern, c);
    c.alias.forEach((a) => aliases.set(a, c.pattern));
    return c;
}

/** Register an event listener: on({ on: 'message' | 'call' | 'tick' }, async (sock, payload, S) => {}) */
function on(info, func) {
    const name = info.on || 'message';
    if (!events.has(name)) events.set(name, []);
    events.get(name).push(func);
}

function loadPlugins() {
    commands.clear(); aliases.clear(); events.clear();
    const dir = path.join(__dirname, '../plugins');
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort()) {
        try {
            const p = path.join(dir, file);
            delete require.cache[require.resolve(p)];
            require(p);
        } catch (e) {
            console.error(chalk.red(`[PLUGIN ERROR] ${file}:`), e.message);
        }
    }
    console.log(chalk.cyan(`[HANDLER] ${commands.size} commands, ${aliases.size} aliases, ` +
        `${[...events.values()].reduce((a, b) => a + b.length, 0)} event listeners loaded.`));
}

async function emit(name, S, payload) {
    const list = events.get(name) || [];
    await Promise.all(list.map((fn) =>
        Promise.resolve().then(() => fn(S.sock, payload, S)).catch((e) =>
            console.error(`[EVENT ERROR ${name}]:`, e.message))
    ));
}

// ───────────── Serializer ─────────────
function tsToSec(ts) {
    if (!ts) return Math.floor(Date.now() / 1000);
    if (typeof ts === 'object') return ts.toNumber ? ts.toNumber() : (ts.low || 0);
    return Number(ts);
}

function serialize(raw, S) {
    const sock = S.sock;
    const key = raw.key;
    const jid = key.remoteJid;
    const self = S.selfJid || U.normJid(sock.user?.id);
    const isGroup = jid.endsWith('@g.us');
    const isStatus = jid === 'status@broadcast';
    const fromMe = !!key.fromMe;
    const pn = (primary, alt) => (primary && primary.endsWith('@lid') && alt ? alt : primary);

    const sender = fromMe
        ? self
        : U.normJid((isGroup || isStatus)
            ? pn(key.participant || raw.participant, key.participantAlt)
            : pn(jid, key.remoteJidAlt));

    const { content, viewOnce } = U.unwrap(raw.message);
    const type = U.contentType(content);
    const msg = type ? content[type] : null;
    const ctxInfo = msg && msg.contextInfo ? msg.contextInfo : null;

    const m = {
        raw, key, id: key.id, jid, isGroup, isStatus, fromMe, sender,
        pushName: raw.pushName || '',
        messageTimestamp: raw.messageTimestamp,
        content, type, msg,
        protocol: content?.protocolMessage || null,
        isViewOnce: viewOnce || msg?.viewOnce === true,
        body: U.bodyOf(content),
        mentionedJid: ctxInfo?.mentionedJid || [],
        contextInfo: ctxInfo,
        quoted: null
    };

    if (ctxInfo && ctxInfo.quotedMessage) {
        const { content: qc, viewOnce: qv } = U.unwrap(ctxInfo.quotedMessage);
        const qType = U.contentType(qc);
        const qMsg = qType ? qc[qType] : null;
        const qSender = U.normJid(ctxInfo.participant);
        m.quoted = {
            id: ctxInfo.stanzaId,
            sender: qSender,
            fromMe: !!qSender && U.jidNum(qSender) === U.jidNum(self),
            isStatus: ctxInfo.remoteJid === 'status@broadcast',
            message: qc, type: qType, msg: qMsg,
            viewOnce: qv || qMsg?.viewOnce === true,
            text: U.bodyOf(qc),
            kind: U.MEDIA[qType] || null,
            isMedia: !!U.MEDIA[qType],
            download: () => U.downloadBuffer(qMsg, U.MEDIA[qType])
        };
    }

    m.download = () => (U.MEDIA[type] ? U.downloadBuffer(msg, U.MEDIA[type]) : null);
    m.reply = (text, o = {}) => sock.sendMessage(jid, { text, ...o }, { quoted: raw });
    m.react = (emoji) => sock.sendMessage(jid, { react: { text: emoji, key } });

    // owner check
    const owners = new Set([U.jidNum(self), S.number, ...config.SUDO].filter(Boolean));
    m.isOwner = fromMe || owners.has(U.jidNum(sender));
    m.isOld = Date.now() / 1000 - tsToSec(raw.messageTimestamp) > 120;
    return m;
}

// ───────────── Dispatcher ─────────────
async function dispatch(S, raw) {
    if (!raw || !raw.message || !raw.key || !raw.key.remoteJid) return;
    const sock = S.sock;
    if (!sock) return;

    const m = serialize(raw, S);
    if (!m.isStatus && !m.protocol) store.put(S.id, raw);

    // events run for EVERY message (media, view-once, deletes, status ...)
    emit('message', S, m);

    if (!m.body || m.isStatus || m.protocol || m.isOld) return;

    const prefix = S.cfg.get('prefix') || config.DEFAULT_PREFIX || '.';
    if (!m.body.startsWith(prefix)) return;

    const args = m.body.slice(prefix.length).trim().split(/\s+/);
    const trigger = (args.shift() || '').toLowerCase();
    if (!trigger) return;

    const name = commands.has(trigger) ? trigger : aliases.get(trigger);
    const command = name && commands.get(name);
    if (!command) return;

    const isOwner = m.isOwner;

    // work type (public / private / group / inbox) – owner is never blocked
    const mode = S.cfg.get('mode') || 'public';
    if (!isOwner) {
        if (mode === 'private') return;
        if (mode === 'group' && !m.isGroup) return;
        if (mode === 'inbox' && m.isGroup) return;
    }

    if (command.owner && !isOwner) return m.reply('❌ මෙම විධානය Owner හට පමණි.');
    if (command.pm && m.isGroup) return m.reply('❌ මෙය Inbox එකේ පමණක් වැඩ කරයි.');
    if (command.group && !m.isGroup) return m.reply('❌ මෙය Group එකක පමණක් වැඩ කරයි.');

    if (m.isGroup && (command.admin || command.botAdmin)) {
        try {
            const meta = await sock.getGroupMeta(m.jid);
            const adminNums = new Set(
                (meta.participants || []).filter((p) => p.admin).flatMap((p) => [U.jidNum(p.id), U.jidNum(p.phoneNumber)])
            );
            if (command.admin && !isOwner && !adminNums.has(U.jidNum(m.sender))) {
                return m.reply('❌ Group Admin හට පමණි.');
            }
            if (command.botAdmin && !adminNums.has(U.jidNum(S.selfJid))) {
                return m.reply('❌ මුලින් Bot ට Admin දෙන්න.');
            }
        } catch (e) {
            return m.reply('⚠️ Group info ගන්න බෑ. ටිකකින් try කරන්න.');
        }
    }

    if (command.react) m.react(command.react).catch(() => {});

    const ctx = { S, args, text: args.join(' '), prefix, isOwner, cfg: S.cfg, config, command: name };
    try {
        await command.execute(sock, m, ctx);
    } catch (err) {
        console.error(chalk.red(`[CMD ERROR: ${name}]`), err);
        await m.reply('⚠️ Error: ' + err.message).catch(() => {});
    }
}

module.exports = { cmd, on, emit, commands, aliases, events, loadPlugins, dispatch, serialize };
