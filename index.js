const dns = require('dns');
try {
    dns.setDefaultResultOrder('ipv4first');
    if (process.env.CUSTOM_DNS !== '0') dns.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);
} catch (e) {}

const express = require('express');
const path = require('path');
const https = require('https');
const http = require('http');
const baileys = require('@whiskeysockets/baileys');
const {
    default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore, Browsers
} = baileys;
const pino = require('pino');
const mongoose = require('mongoose');
const chalk = require('chalk');
const NodeCache = require('node-cache');

const config = require('./config');
const { useMongoDBAuthState, getAllRegisteredSessions, deleteSession, isSessionLinked } = require('./database/mongo');
const settings = require('./database/settings');
const store = require('./lib/store');
const U = require('./lib/utils');
const { loadPlugins, dispatch, emit } = require('./lib/handler');

const app = express();
const port = process.env.PORT || 8000;
const logger = pino({ level: 'silent' });
const delay = U.sleep;

const msgRetryCounterCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });
const userDevicesCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });
const groupCache = new NodeCache({ stdTTL: 600, checkperiod: 120, useClones: false });

// Never let the process die
process.on('unhandledRejection', (e) => console.error('[UNHANDLED REJECTION]:', e?.message || e));
process.on('uncaughtException', (e) => console.error('[UNCAUGHT EXCEPTION]:', e?.message || e));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ───────────── Session registry ─────────────
const sessions = new Map();   // sid -> S (lives across reconnects)
const pairingBusy = new Set();

const isRegistered = (creds) => !!(creds && (creds.registered || creds.me));
const mask = (id) => (id.length > 6 ? id.slice(0, 4) + '****' + id.slice(-2) : id);
const backoff = (n) => Math.min(30000, 2000 * 2 ** Math.min(n, 4));

function makeSession(sid) {
    const S = {
        id: sid,
        number: sid === 'legacy' ? '' : sid,
        config,
        cfg: settings.forSession(sid),
        sock: null, state: null,
        gen: 0,
        connected: false,
        pairing: false,
        starting: false,
        replaced: false,
        banned: false,
        attempts: 0,
        pingFails: 0,
        lastChange: Date.now(),
        selfJid: null,
        timers: [],
        reconnectTimer: null,
        pairTimer: null,
        waiters: [],
        qrReady: false,
        panelIds: [],
        activeChats: new Map(),
        callNotified: new Map(),
        recent: new Set()
    };
    S.restart = () => restartSession(sid);
    return S;
}

async function connectDB() {
    if (mongoose.connection.readyState !== 1) {
        await mongoose.connect(config.MONGODB_URI, { serverSelectionTimeoutMS: 15000, family: 4 });
    }
}

function teardown(S) {
    S.gen++;                       // invalidates every handler of the old socket
    S.connected = false;
    S.qrReady = false;
    for (const t of S.timers) clearInterval(t);
    S.timers = [];
    if (S.reconnectTimer) { clearTimeout(S.reconnectTimer); S.reconnectTimer = null; }
    for (const w of S.waiters.splice(0)) w.reject(new Error('Socket closed'));
    const s = S.sock;
    S.sock = null;
    if (s) {
        try { s.ev.removeAllListeners('connection.update'); } catch (e) {}
        try { s.end(undefined); } catch (e) {}
    }
}

async function removeSession(sid) {
    const S = sessions.get(sid);
    if (S) {
        teardown(S);
        if (S.pairTimer) clearTimeout(S.pairTimer);
        sessions.delete(sid);
    }
    store.clear(sid);
    await deleteSession(sid).catch(() => {});
}

function scheduleReconnect(S, ms) {
    if (S.reconnectTimer) clearTimeout(S.reconnectTimer);
    S.reconnectTimer = setTimeout(async () => {
        S.reconnectTimer = null;
        if (S.connected || S.starting || S.replaced || S.banned) return;
        try {
            const r = await startSession(S.id);
            if (!r) return;
        } catch (e) {
            S.attempts++;
            console.error(chalk.yellow(`[RECONNECT ${S.id}] failed (${e.message}) – retry #${S.attempts}`));
            scheduleReconnect(S, backoff(S.attempts));
        }
    }, ms);
}

async function restartSession(sid) {
    const S = sessions.get(sid);
    if (!S) return;
    S.replaced = false;
    S.attempts = 0;
    teardown(S);
    scheduleReconnect(S, 800);
}

// ───────────── Socket launcher ─────────────
async function startSession(sid, { allowUnregistered = false } = {}) {
    await connectDB();
    await settings.load(sid);

    let S = sessions.get(sid);
    if (!S) { S = makeSession(sid); sessions.set(sid, S); }
    if (S.starting) return S;
    S.starting = true;

    try {
        const { state, saveCreds } = await useMongoDBAuthState(sid);
        if (!isRegistered(state.creds) && !allowUnregistered) {
            sessions.delete(sid);
            return null;
        }

        teardown(S);
        const gen = S.gen;
        S.state = state;
        S.lastChange = Date.now();
        if (state.creds.me?.id) { S.number = U.jidNum(state.creds.me.id); S.selfJid = U.normJid(state.creds.me.id); }

        let version;
        try {
            const latest = await Promise.race([
                fetchLatestBaileysVersion(),
                new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))
            ]);
            version = latest.version;
        } catch (e) {}

        const sock = makeWASocket({
            ...(version ? { version } : {}),
            logger,
            auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
            printQRInTerminal: false,
            browser: Browsers.ubuntu('Chrome'),
            syncFullHistory: false,
            shouldSyncHistoryMessage: () => false,
            // NOTE: status@broadcast must NOT be ignored (status seen / react / save need it)
            shouldIgnoreJid: (jid) => !!jid && jid !== 'status@broadcast' && (jid.endsWith('@broadcast') || jid.endsWith('@newsletter')),
            cachedGroupMetadata: async (jid) => groupCache.get(jid),
            getMessage: async (key) => store.find(sid, key.id)?.message,
            markOnlineOnConnect: S.cfg.get('online') === 'on',
            generateHighQualityLinkPreview: false,
            msgRetryCounterCache,
            userDevicesCache,
            emitOwnEvents: false,
            qrTimeout: 120000,
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 15000,
            defaultQueryTimeoutMs: 60000,
            retryRequestDelayMs: 250
        });
        S.sock = sock;

        sock.getGroupMeta = async (jid) => {
            let meta = groupCache.get(jid);
            if (!meta) { meta = await sock.groupMetadata(jid); groupCache.set(jid, meta); }
            return meta;
        };

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            if (S.gen !== gen) return;
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                S.qrReady = true;
                for (const w of S.waiters.splice(0)) w.resolve();
            }

            if (connection === 'open') {
                S.connected = true;
                S.attempts = 0;
                S.pingFails = 0;
                S.pairing = false;
                S.lastChange = Date.now();
                S.selfJid = U.normJid(sock.user.id);
                S.number = U.jidNum(sock.user.id);
                console.log(chalk.green.bold(`\n[✓] BOT ONLINE: ${S.number} ⚡\n`));

                setTimeout(() => {
                    if (S.gen !== gen) return;
                    sock.groupFetchAllParticipating()
                        .then((all) => { for (const j in all) groupCache.set(j, all[j]); })
                        .catch(() => {});
                }, 4000);

                // every 20s: always-online / fake presence tasks
                S.timers.push(setInterval(() => {
                    if (S.connected && S.gen === gen) emit('tick', S, null).catch(() => {});
                }, 20000));

                // every 60s: real ping – if the socket is half-dead, reconnect immediately
                S.timers.push(setInterval(async () => {
                    if (!S.connected || S.gen !== gen) return;
                    try {
                        await sock.query({ tag: 'iq', attrs: { to: '@s.whatsapp.net', type: 'get', xmlns: 'w:p' }, content: [{ tag: 'ping', attrs: {} }] }, 20000);
                        S.pingFails = 0;
                    } catch (e) {
                        S.pingFails++;
                        console.log(chalk.yellow(`[PING ${S.number}] failed (${S.pingFails})`));
                        if (S.pingFails >= 2) restartSession(sid);
                    }
                }, 60000));

                emit('tick', S, null).catch(() => {});

                if (!S.cfg.get('welcomeSent')) {
                    await S.cfg.set('welcomeSent', true);
                    sock.sendMessage(S.selfJid, {
                        text: `⚡ *${config.BOT_NAME} IS ONLINE* ⚡\n\n📱 *Account:* +${S.number}\n🛡️ *Status:* Connected 24/7\n\n` +
                              `💡 *${S.cfg.get('prefix')}menu* – commands\n💡 *${S.cfg.get('prefix')}setting* – control panel\n\n${config.FOOTER}`
                    }).catch(() => {});
                }
            }

            if (connection === 'close') {
                S.connected = false;
                S.lastChange = Date.now();
                for (const t of S.timers) clearInterval(t);
                S.timers = [];
                for (const w of S.waiters.splice(0)) w.reject(new Error('Connection closed before ready'));

                const code = lastDisconnect?.error?.output?.statusCode;
                console.log(chalk.red(`[!] Session ${mask(sid)} closed (code: ${code})`));

                if (code === DisconnectReason.loggedOut) {
                    console.log(chalk.red(`[!] ${mask(sid)} logged out – cleaning data.`));
                    await removeSession(sid);
                    return;
                }
                if (code === DisconnectReason.connectionReplaced) {
                    S.replaced = true;
                    console.log(chalk.red(`[!] ${mask(sid)} was opened somewhere else (another server using the same DB?). Not reconnecting. Use .restart or redeploy to resume.`));
                    return;
                }
                if (code === DisconnectReason.forbidden) {
                    S.banned = true;
                    console.log(chalk.red(`[!] ${mask(sid)} forbidden (403). Stopped.`));
                    return;
                }
                if (!isRegistered(state.creds)) return;   // still pairing

                S.attempts++;
                scheduleReconnect(S, code === DisconnectReason.restartRequired ? 800 : backoff(S.attempts));
            }
        });

        sock.ev.on('messages.upsert', ({ messages, type }) => {
            if (S.gen !== gen) return;
            for (const raw of messages) {
                if (!raw || !raw.message || !raw.key) continue;
                if (type !== 'notify') {
                    // 'append' = history / offline sync: only process very fresh messages
                    const ts = Number(raw.messageTimestamp?.toNumber ? raw.messageTimestamp.toNumber() : raw.messageTimestamp) || 0;
                    if (Date.now() / 1000 - ts > 20) continue;
                }
                const uid = `${raw.key.remoteJid}|${raw.key.id}`;
                if (S.recent.has(uid)) continue;
                S.recent.add(uid);
                if (S.recent.size > 800) S.recent.delete(S.recent.values().next().value);

                dispatch(S, raw).catch((e) => console.error(`[DISPATCH ${mask(sid)}]:`, e.message));
            }
        });

        sock.ev.on('call', (calls) => {
            if (S.gen !== gen) return;
            for (const c of calls) emit('call', S, c).catch(() => {});
        });

        sock.ev.on('groups.update', (u) => { for (const g of u) if (g.id) groupCache.del(g.id); });
        sock.ev.on('group-participants.update', (u) => { if (u?.id) groupCache.del(u.id); });

        return S;
    } finally {
        S.starting = false;
    }
}

// ───────────── Watchdog: any dead session gets revived ─────────────
setInterval(() => {
    for (const S of sessions.values()) {
        if (S.connected || S.pairing || S.starting || S.replaced || S.banned || S.reconnectTimer) continue;
        if (!isRegistered(S.state?.creds)) continue;
        if (Date.now() - S.lastChange < 90000) continue;
        console.log(chalk.yellow(`[WATCHDOG] reviving ${mask(S.id)}`));
        S.lastChange = Date.now();
        scheduleReconnect(S, 500);
    }
}, 45000);

// ───────────── Web API ─────────────
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'active', uptime: Math.floor(process.uptime()), bots: sessions.size });
});
app.get('/ping', (req, res) => res.send('pong'));

// /status            -> counts only (numbers are NOT exposed)
// /status?phone=947… -> { connected } for that number (used by the link page)
app.get('/status', (req, res) => {
    const phone = String(req.query.phone || '').replace(/\D/g, '');
    if (phone) {
        const S = sessions.get(phone);
        return res.json({ connected: !!(S && S.connected) });
    }
    let active = 0;
    for (const S of sessions.values()) if (S.connected) active++;
    res.json({ total: sessions.size, active });
});

function waitReady(S, ms) {
    return new Promise((resolve, reject) => {
        if (S.qrReady) return resolve();
        const t = setTimeout(() => reject(new Error('WhatsApp connection timeout')), ms);
        S.waiters.push({
            resolve: () => { clearTimeout(t); resolve(); },
            reject: (e) => { clearTimeout(t); reject(e); }
        });
    });
}

app.get('/pair', async (req, res) => {
    const phone = String(req.query.phone || '').replace(/\D/g, '');
    if (phone.length < 8 || phone.length > 15) {
        return res.status(400).json({ error: 'Country code එක්ක නිවැරදි number එකක් දෙන්න.' });
    }
    if (mongoose.connection.readyState !== 1) return res.status(503).json({ error: 'Database එක connect වෙලා නෑ. තත්පර 10කින් try කරන්න.' });
    if (pairingBusy.has(phone)) return res.status(429).json({ error: 'Pairing දැනටමත් පියවරේ. තත්පර 10ක් ඉන්න.' });

    const existing = sessions.get(phone);
    if (existing && existing.connected) {
        return res.status(409).json({ error: 'මේ number එක දැනටමත් link වෙලා, bot active.' });
    }
    if (!existing && sessions.size >= config.MAX_SESSIONS) {
        return res.status(403).json({ error: `Bot limit (${config.MAX_SESSIONS}) අවසන්.` });
    }

    pairingBusy.add(phone);
    try {
        // already linked but offline -> never wipe it, just bring it back
        if (await isSessionLinked(phone)) {
            startSession(phone).catch(() => {});
            return res.status(409).json({
                error: 'මේ number එක කලින් link කරලා. Bot start වෙනවා. WhatsApp එකෙන් Linked Devices අයින් කරලා නම් තත්පර 30කින් ආයෙ try කරන්න.'
            });
        }

        await removeSession(phone);

        let code = null, lastErr = null;
        for (let attempt = 1; attempt <= 3 && !code; attempt++) {
            try {
                const S = await startSession(phone, { allowUnregistered: true });
                if (!S) throw new Error('Could not start connection.');
                S.pairing = true;
                await waitReady(S, 25000);            // handshake finished -> safe to ask for a code
                code = await S.sock.requestPairingCode(phone);
                S.pairTimer = setTimeout(async () => {  // never linked within 4 min -> free resources
                    const cur = sessions.get(phone);
                    if (cur && !isRegistered(cur.state?.creds)) await removeSession(phone);
                }, 4 * 60 * 1000);
            } catch (e) {
                lastErr = e;
                console.error(chalk.yellow(`[PAIR RETRY ${mask(phone)}] attempt ${attempt}: ${e.message}`));
                await removeSession(phone);
                await delay(2000);
            }
        }
        if (!code) throw lastErr || new Error('Pairing failed.');

        const formatted = code.match(/.{1,4}/g)?.join('-') || code;
        console.log(chalk.cyan(`[PAIRING] code for ${mask(phone)}: ${formatted}`));
        return res.json({ code: formatted, phone });
    } catch (err) {
        console.error(chalk.red(`[PAIR ERROR ${mask(phone)}]:`), err.message);
        await removeSession(phone);
        return res.status(500).json({ error: (err.message || 'Pairing failed') + ' – ආයෙ try කරන්න.' });
    } finally {
        pairingBusy.delete(phone);
    }
});

// ───────────── Keep-alive (stops Render/Koyeb/Railway free plans sleeping) ─────────────
function startKeepAlive() {
    const url = config.APP_URL;
    if (!url) {
        console.log(chalk.yellow('[KEEPALIVE] APP_URL / RENDER_EXTERNAL_URL not set. Use UptimeRobot / cron-job.org to ping /health every 5 min.'));
        return;
    }
    const client = url.startsWith('https') ? https : http;
    setInterval(() => client.get(`${url.replace(/\/$/, '')}/health`, (r) => r.resume()).on('error', () => {}), 4 * 60 * 1000);
    console.log(chalk.green(`[KEEPALIVE] self-ping every 4 min -> ${url}`));
}

// ───────────── Boot ─────────────
(async () => {
    app.listen(port, () => {
        console.log(chalk.green(`[SERVER] DARK-DINU hub live on port ${port}`));
        startKeepAlive();
    });

    while (true) {
        try {
            await connectDB();
            console.log(chalk.green('[DB] MongoDB connected'));
            break;
        } catch (err) {
            console.error(chalk.red('[DB ERROR]:'), err.message, '- retry in 8s');
            await delay(8000);
        }
    }

    loadPlugins();

    try {
        const saved = await getAllRegisteredSessions();
        console.log(chalk.cyan(`[BOOT] ${saved.length} registered session(s) found. Starting...`));
        for (const sid of saved.slice(0, config.MAX_SESSIONS)) {
            startSession(sid).catch((e) => {
                console.error(`[BOOT ${mask(sid)}]:`, e.message);
                const S = sessions.get(sid);
                if (S) scheduleReconnect(S, 5000);
            });
            await delay(1500);
        }
    } catch (err) {
        console.error(chalk.red('[BOOT ERROR]:'), err.message);
    }
})();
