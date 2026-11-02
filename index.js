const { 
    default: makeWASocket, 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    Browsers,
    delay
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const mongoose = require('mongoose');
const chalk = require('chalk');
const readline = require('readline');
const NodeCache = require('node-cache');

const config = require('./config');
const { useMongoDBAuthState } = require('./database/mongo');
const settings = require('./database/settings');
const { commands, loadPlugins } = require('./lib/handler');

const msgRetryCounterCache = new NodeCache();
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (query) => new Promise((resolve) => rl.question(query, resolve));

function renderCyberBanner() {
    console.clear();
    console.log(chalk.red.bold(`
   ██████╗  █████╗ ██████╗ ██╗  ██╗    ██████╗ ██╗███╗   ██╗██╗   ██╗
   ██╔══██╗██╔══██╗██╔══██╗██║ ██╔╝    ██╔══██╗██║████╗  ██║██║   ██║
   ██║  ██║███████║██████╔╝█████╔╝     ██║  ██║██║██╔██╗ ██║██║   ██║
   ██║  ██║██╔══██║██╔══██╗██╔═██╗     ██║  ██║██║██║╚██╗██║██║   ██║
   ██████╔╝██║  ██║██║  ██║██║  ██╗    ██████╔╝██║██║ ╚████║╚██████╔╝
   ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝    ╚═════╝ ╚═╝╚═╝  ╚═══╝ ╚═════╝ 
             [ DARK DINU V1 - 2026 ZERO-BAN PRODUCTION ]
    `));
}

async function startEngine() {
    renderCyberBanner();

    console.log(chalk.cyan('[DATABASE]') + ' Connecting to MongoDB Atlas...');
    await mongoose.connect(config.MONGODB_URI);
    console.log(chalk.green.bold('[DATABASE] Atlas Connection Established! ⚡'));

    await settings.initSettings();
    loadPlugins();
    console.log(chalk.yellow(`[PLUGINS] Loaded ${commands.size} triggers.`));

    const { state, saveCreds } = await useMongoDBAuthState();
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(chalk.blue(`[SYSTEM] WhatsApp Web Version: v${version.join('.')} (Latest: ${isLatest})`));

    // 2026 Anti-Ban Authentic Socket Config
    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        auth: state,
        printQRInTerminal: false,
        msgRetryCounterCache,
        // Official Genuine Desktop Chrome Fingerprint
        browser: Browsers.macOS('Desktop'),
        syncFullHistory: false,
        markOnlineOnConnect: true,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 0,
        keepAliveIntervalMs: 25000,
        generateHighQualityLinkPreview: true
    });

    // Instant One-Shot Pairing Code Mechanism
    if (!sock.authState.creds.registered) {
        const phone = await question(chalk.magenta.bold('\n[?] Enter WhatsApp Number with country code (e.g 94719845166): '));
        const cleanNumber = phone.replace(/[^0-9]/g, '');

        console.log(chalk.yellow('[...] Authenticating with WhatsApp Server...'));
        await delay(3000); // Anti-ban rate-limit protection delay

        try {
            const rawCode = await sock.requestPairingCode(cleanNumber);
            const formattedCode = rawCode?.match(/.{1,4}/g)?.join('-') || rawCode;

            console.log(chalk.black.bgRed.bold('\n ╔══════════════════════════════════════╗ '));
            console.log(chalk.black.bgRed.bold(` ║  YOUR PAIRING CODE: ${chalk.white.bold(formattedCode)}        ║ `));
            console.log(chalk.black.bgRed.bold(' ╚══════════════════════════════════════╝ \n'));
            console.log(chalk.cyan('Enter this code on WhatsApp -> Linked Devices -> Link with phone number\n'));
        } catch (codeErr) {
            console.error(chalk.red('[!] Failed to generate pairing code:'), codeErr.message);
        }
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            console.log(chalk.red(`[!] Connection Closed. Status: ${statusCode}. Reconnecting: ${shouldReconnect}`));
            
            if (shouldReconnect) {
                await delay(2000);
                startEngine();
            } else {
                console.log(chalk.red.bold('[!] Logged Out. Clear MongoDB session collection and re-pair.'));
            }
        } else if (connection === 'open') {
            console.log(chalk.green.bold('\n[✓] DARK DINU V1 CONNECTED SUCCESSFULLY (CHROME AUTHENTIC)! ⚡'));
            
            // Connect වූ පසු Owner ට confirmation එකක් යැවීම
            const ownerJid = `${config.OWNER_NUMBER}@s.whatsapp.net`;
            await sock.sendMessage(ownerJid, { 
                text: `⚡ *DARK DINU V1 CONNECTED*\n\n` +
                      `🛡️ *Security:* Anti-Ban / Real Chrome Identity\n` +
                      `🛢️ *Database:* MongoDB Atlas\n` +
                      `🚀 *Speed:* Maximum Performance Ready`
            }).catch(() => {});
        }
    });

    // Zero-lag Message Event Dispatcher
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const m = messages[0];
        if (!m.message) return;

        const sender = m.key.participant || m.key.remoteJid;
        const fromMe = m.key.fromMe;
        const isOwner = sender.includes(config.OWNER_NUMBER) || fromMe;

        const mode = settings.get('mode');
        if (mode === 'private' && !isOwner) return;

        const body = m.message.conversation ||
                     m.message.extendedTextMessage?.text ||
                     m.message.imageMessage?.caption ||
                     '';

        const prefix = settings.get('prefix');
        if (!body.startsWith(prefix)) return;

        const args = body.slice(prefix.length).trim().split(/ +/);
        const trigger = args.shift().toLowerCase();

        const targetCmd = commands.get(trigger);
        if (targetCmd) {
            try {
                await targetCmd.execute(sock, m, args, config);
            } catch (err) {
                console.error(chalk.red(`[COMMAND ERROR: ${trigger}]`), err);
            }
        }
    });
}

startEngine().catch(err => console.error(chalk.red.bold('FATAL BOOTSTRAP:'), err));
