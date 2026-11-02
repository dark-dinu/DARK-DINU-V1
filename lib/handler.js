const fs = require('fs');
const path = require('path');
const chalk = require('chalk');

// Memory Registers
const commands = new Map();
const aliases = new Map();
const events = new Map();

/**
 * Command Registration Wrapper
 * @param {Object} info - Command metadata (pattern, alias, desc, category, fromMe, etc.)
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
        react: info.react || null,
        filename: info.filename || '',
        execute: func
    };

    commands.set(commandData.pattern, commandData);

    // Aliases Register කිරීම
    if (commandData.alias.length > 0) {
        commandData.alias.forEach(al => {
            aliases.set(al, commandData.pattern);
        });
    }

    return commandData;
}

/**
 * Event Listener Registration (Anti-delete, Welcome, etc.)
 * @param {Object} info - Event trigger info
 * @param {Function} func - Event execution function
 */
function on(info, func) {
    const eventType = info.on || 'message';
    if (!events.has(eventType)) {
        events.set(eventType, []);
    }
    events.get(eventType).push({ ...info, execute: func });
}

/**
 * Single-Directory Automatic Plugin Loader
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
 * Message Serializer & Normalizer
 * Baileys incoming raw message structure එක සරල කර format කිරීම
 */
function serializeMessage(m, sock) {
    if (!m) return m;

    m.jid = m.key.remoteJid;
    m.isGroup = m.jid.endsWith('@g.us');
    m.sender = m.isGroup ? (m.key.participant || m.participant) : m.jid;
    m.fromMe = m.key.fromMe;

    const messageContent = m.message;
    if (!messageContent) return m;

    m.type = Object.keys(messageContent)[0];
    m.msg = (m.type === 'viewOnceMessage') 
        ? messageContent[m.type].message[Object.keys(messageContent[m.type].message)[0]]
        : messageContent[m.type];

    // Text Extract කිරීම
    m.body = messageContent.conversation ||
             messageContent.extendedTextMessage?.text ||
             messageContent.imageMessage?.caption ||
             messageContent.videoMessage?.caption ||
             (m.type === 'templateButtonReplyMessage' && messageContent.templateButtonReplyMessage.selectedId) ||
             (m.type === 'buttonsResponseMessage' && messageContent.buttonsResponseMessage.selectedButtonId) ||
             '';

    // Quoted message helper
    const contextInfo = messageContent.extendedTextMessage?.contextInfo;
    m.quoted = contextInfo?.quotedMessage ? {
        message: contextInfo.quotedMessage,
        sender: contextInfo.participant,
        id: contextInfo.stanzaId,
        isMedia: !!(
            contextInfo.quotedMessage.imageMessage || 
            contextInfo.quotedMessage.videoMessage || 
            contextInfo.quotedMessage.audioMessage || 
            contextInfo.quotedMessage.documentMessage
        )
    } : null;

    // Instant Reply Helper Shortcut
    m.reply = (text, options = {}) => sock.sendMessage(m.jid, { text, ...options }, { quoted: m });

    // React Helper Shortcut
    m.react = (emoji) => sock.sendMessage(m.jid, { react: { text: emoji, key: m.key } });

    return m;
}

/**
 * Command Dispatcher Engine
 */
async function dispatchCommand(sock, rawM, config, settings) {
    const m = serializeMessage(rawM, sock);
    if (!m || !m.body) return;

    const prefix = settings.get('prefix') || config.DEFAULT_PREFIX;
    if (!m.body.startsWith(prefix)) return;

    const args = m.body.slice(prefix.length).trim().split(/ +/);
    const trigger = args.shift().toLowerCase();

    // Check directly or through alias
    const commandName = commands.has(trigger) ? trigger : aliases.get(trigger);
    const command = commands.get(commandName);

    if (!command) return;

    const isOwner = m.sender.includes(config.OWNER_NUMBER) || m.fromMe;
    const mode = settings.get('mode') || 'public';

    // Permission checks
    if (mode === 'private' && !isOwner) return;
    if (command.fromMe && !isOwner) {
        return m.reply('❌ This command is restricted to the bot owner.');
    }

    if (command.onlyGroup && !m.isGroup) {
        return m.reply('❌ This command can only be used in groups.');
    }

    // Reaction එකක් සකසා ඇත්නම් react කිරීම
    if (command.react) {
        await m.react(command.react).catch(() => {});
    }

    // Execute plugin
    try {
        await command.execute(sock, m, args, config, settings);
    } catch (err) {
        console.error(chalk.red(`[RUNTIME ERROR: ${commandName}]`), err);
        await m.reply('⚠️ Command execution error: ' + err.message);
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
    dispatchCommand
};
