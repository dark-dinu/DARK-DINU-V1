const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const { downloadContentFromMessage } = require('@whiskeysockets/baileys');

// Memory Registers
const commands = new Map();
const aliases = new Map();
const events = new Map();

/**
 * Command Registration Wrapper
 * @param {Object} info - Command metadata
 * @param {Function} func - The execution function
 */
function cmd(info, func) {
    if (!info.pattern) {
        throw new Error('Command must have a pattern identifier.');
    }

    const commandData = {
        pattern: info.pattern.toLowerCase(),
        alias: Array.isArray(info.alias) ? info.alias.map(a => a.toLowerCase()) : [],
        desc: info.desc || 'No description provided',
        category: info.category || 'misc',
        fromMe: info.fromMe || false,
        onlyGroup: info.onlyGroup || false,
        onlyAdmin: info.onlyAdmin || false,
        botAdmin: info.botAdmin || false,
        onlyPm: info.onlyPm || false,
        react: info.react || null,
        filename: info.filename || '',
        execute: func
    };

    commands.set(commandData.pattern, commandData);

    if (commandData.alias.length > 0) {
        commandData.alias.forEach(al => {
            aliases.set(al, commandData.pattern);
        });
    }

    return commandData;
}

/**
 * Event Listener Registration (Anti-delete, Welcome, Anti-link, etc.)
 */
function on(info, func) {
    const eventType = info.on || 'message';
    if (!events.has(eventType)) {
        events.set(eventType, []);
    }
    events.get(eventType).push({ ...info, execute: func });
}

/**
 * Automatic Plugin Loader
 */
function loadPlugins() {
    commands.clear();
    aliases.clear();
    events.clear();

    const pluginDir = path.join(__dirname, '../plugins');
    if (!fs.existsSync(pluginDir)) {
        fs.mkdirSync(pluginDir, { recursive: true });
    }

    const files = fs.readdirSync(pluginDir).filter(f => f.endsWith('.js'));

    for (const file of files) {
        try {
            const pluginPath = path.join(pluginDir, file);
            delete require.cache[require.resolve(pluginPath)];
            require(pluginPath);
        } catch (error) {
            console.error(chalk.red(`[PLUGIN ERROR] Failed loading ${file}:`), error.message);
        }
    }

    console.log(chalk.cyan(`[HANDLER] Loaded ${commands.size} core commands & ${aliases.size} aliases successfully.`));
}

/**
 * Safe Stream Media Downloader Helper
 */
async function downloadMedia(message, type) {
    try {
        const stream = await downloadContentFromMessage(message, type);
        let buffer = Buffer.from([]);
        for await (const chunk of stream) {
            buffer = Buffer.concat([buffer, chunk]);
        }
        return buffer;
    } catch (e) {
        console.error('Download media error:', e.message);
        return null;
    }
}

/**
 * Message Serializer & Normalizer (100% Comprehensive WhatsApp Packet Parser)
 */
function serializeMessage(m, sock) {
    if (!m) return m;

    m.jid = m.key.remoteJid;
    m.isGroup = m.jid.endsWith('@g.us');
    m.sender = m.isGroup 
        ? (m.key.participantAlt || m.key.participant || m.participant) 
        : (m.key.fromMe ? sock.user.id.split(':')[0] + '@s.whatsapp.net' : m.jid);
    m.fromMe = m.key.fromMe;

    const messageContent = m.message;
    if (!messageContent) return m;

    // ViewOnce & Ephemeral Auto-Unwrap
    const realMsg = messageContent.ephemeralMessage?.message ||
                    messageContent.viewOnceMessage?.message ||
                    messageContent.viewOnceMessageV2?.message ||
                    messageContent.viewOnceMessageV2Extension?.message ||
                    messageContent.documentWithCaptionMessage?.message ||
                    messageContent;

    m.type = Object.keys(realMsg)[0];
    m.msg = realMsg[m.type];

    // Extraction of plain or media caption body text
    m.body = realMsg.conversation ||
             realMsg.extendedTextMessage?.text ||
             realMsg.imageMessage?.caption ||
             realMsg.videoMessage?.caption ||
             realMsg.documentMessage?.caption ||
             realMsg.templateButtonReplyMessage?.selectedId ||
             realMsg.buttonsResponseMessage?.selectedButtonId ||
             realMsg.listResponseMessage?.singleSelectReply?.selectedRowId ||
             '';

    // Mentions Parser
    const contextInfo = realMsg.extendedTextMessage?.contextInfo || m.msg?.contextInfo;
    m.mentionedJid = contextInfo?.mentionedJid || [];

    // Quoted Message Full Parser
    if (contextInfo?.quotedMessage) {
        const q = contextInfo.quotedMessage;
        const qReal = q.ephemeralMessage?.message ||
                      q.viewOnceMessage?.message ||
                      q.viewOnceMessageV2?.message ||
                      q;
        const qType = Object.keys(qReal)[0];
        const qMsg = qReal[qType];

        m.quoted = {
            message: qReal,
            type: qType,
            msg: qMsg,
            sender: contextInfo.participant,
            id: contextInfo.stanzaId,
            fromMe: contextInfo.participant === (sock.user.id.split(':')[0] + '@s.whatsapp.net'),
            text: qReal.conversation || 
                  qReal.extendedTextMessage?.text || 
                  qMsg?.caption || '',
            isMedia: ['imageMessage', 'videoMessage', 'audioMessage', 'stickerMessage', 'documentMessage'].includes(qType),
            download: () => downloadMedia(qMsg, qType.replace('Message', ''))
        };
    } else {
        m.quoted = null;
    }

    // Direct Media Download Method on current message
    m.download = () => {
        if (!m.type) return null;
        return downloadMedia(m.msg, m.type.replace('Message', ''));
    };

    // Fast Shortcut Helpers
    m.reply = (text, options = {}) => sock.sendMessage(m.jid, { text, ...options }, { quoted: m });
    m.react = (emoji) => sock.sendMessage(m.jid, { react: { text: emoji, key: m.key } });

    return m;
}

/**
 * Command Dispatcher Engine (Full Access Matrix)
 */
async function dispatchCommand(sock, rawM, config, settings) {
    const m = serializeMessage(rawM, sock);
    if (!m || !m.body) return;

    // Trigger registered event listeners
    const msgEvents = events.get('message') || [];
    for (const event of msgEvents) {
        try {
            await event.execute(sock, m, config, settings);
        } catch (e) {
            console.error('[EVENT ERROR]:', e.message);
        }
    }

    const prefix = settings.get('prefix') || config.DEFAULT_PREFIX || '.';
    if (!m.body.startsWith(prefix)) return;

    const args = m.body.slice(prefix.length).trim().split(/ +/);
    const trigger = args.shift().toLowerCase();

    const commandName = commands.has(trigger) ? trigger : aliases.get(trigger);
    const command = commands.get(commandName);

    if (!command) return;

    // Bot & User Number Identifiers
    const cleanOwner = config.OWNER_NUMBER.replace(/[^0-9]/g, '');
    const cleanSender = (m.sender || '').replace(/[^0-9]/g, '');
    const botJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
    const isOwner = cleanSender.includes(cleanOwner) || m.fromMe;

    const mode = settings.get('mode') || config.WORK_TYPE || 'public';

    // Work-type restrictions
    if (mode === 'private' && !isOwner) return;

    // Command Owner Only check
    if (command.fromMe && !isOwner) {
        return m.reply('❌ මෙම විධානය භාවිතා කළ හැක්කේ Bot Owner හට පමණි.');
    }

    // Direct Message (PM) Only check
    if (command.onlyPm && m.isGroup) {
        return m.reply('❌ මෙම විධානය ක්‍රියාත්මක කළ හැක්කේ Inbox (Private Chat) තුළ පමණි.');
    }

    // Group Chat Checks & Admin Matrix
    if (m.isGroup) {
        if (command.onlyAdmin || command.botAdmin) {
            try {
                const groupMetadata = await sock.groupMetadata(m.jid);
                const participants = groupMetadata.participants || [];
                
                const userAdmin = participants.find(p => p.id === m.sender)?.admin;
                const isUserAdmin = userAdmin === 'admin' || userAdmin === 'superadmin';

                const botAdmin = participants.find(p => p.id === botJid)?.admin;
                const isBotAdmin = botAdmin === 'admin' || botAdmin === 'superadmin';

                // User Admin Check
                if (command.onlyAdmin && !isUserAdmin && !isOwner) {
                    return m.reply('❌ මෙම විධානය භාවිතා කිරීමට ඔබට Group Admin බලතල තිබිය යුතුය.');
                }

                // Bot Admin Check
                if (command.botAdmin && !isBotAdmin) {
                    return m.reply('❌ මෙම විධානය ක්‍රියාත්මක කිරීමට ප්‍රථමයෙන් Bot හට Group Admin බලතල ලබා දෙන්න.');
                }
            } catch (err) {
                return m.reply('⚠️ Group Metadata ලබා ගැනීමට නොහැකි විය.');
            }
        }
    } else if (command.onlyGroup) {
        return m.reply('❌ මෙම විධානය ක්‍රියාත්මක කළ හැක්කේ Groups තුළ පමණි.');
    }

    // Auto Command Reaction
    if (command.react) {
        await m.react(command.react).catch(() => {});
    }

    // Parameter Package for Easy Plugin Execution
    const text = args.join(' ');
    const params = {
        args,
        text,
        isOwner,
        botJid,
        prefix
    };

    try {
        await command.execute(sock, m, params, config, settings);
    } catch (err) {
        console.error(chalk.red(`[RUNTIME ERROR: ${commandName}]`), err);
        await m.reply('⚠️ Error executing command: ' + err.message);
    }
}

module.exports = {
    cmd,
    on,
    commands,
    aliases,
    events,
    loadPlugins,
    serializeMessage,
    downloadMedia,
    dispatchCommand
};
