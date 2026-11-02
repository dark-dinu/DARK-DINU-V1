const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const express = require('express');
const { 
    default: makeWASocket, 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    Browsers,
    delay,
    makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const mongoose = require('mongoose');
const chalk = require('chalk');
const NodeCache = require('node-cache');

const config = require('./config');
const { useMongoDBAuthState } = require('./database/mongo');
const settings = require('./database/settings');
const { commands, loadPlugins, dispatchCommand } = require('./lib/handler');

const app = express();
const port = process.env.PORT || 8000;
const msgRetryCounterCache = new NodeCache();

app.get('/', (req, res) => {
    res.send('⚡ DARK DINU V1 IS RUNNING AT 100% MAXIMUM SPEED ⚡');
});

app.listen(port, () => {
    console.log(chalk.green.bold(`[SERVER] Port ${port} Active.`));
});

// Session ID එක Decode කර MongoDB එකට Inject කිරීම
async function loadSessionFromID() {
    if (!config.SESSION_ID) {
        console.log(chalk.red.bold('[ERROR] SESSION_ID එකක් දීලා නෑ! Environment variable එකට SESSION_ID දාන්න.'));
        return false;
    }

    try {
        if (mongoose.connection.readyState !== 1) {
            await mongoose.connect(config.MONGODB_URI);
        }

        const rawSession = config.SESSION_ID.replace('DARK-DINU;;;', '').trim();
        const decoded = Buffer.from(rawSession, 'base64').toString('utf-8');
        const creds = JSON.parse(decoded);

        const mongoAuth = await useMongoDBAuthState();
        await mongoAuth.saveCreds(creds);
        console.log(chalk.green.bold('[✓] Session Loaded Successfully from SESSION_ID!'));
        return true;
    } catch (e) {
        console.error(chalk.red('[SESSION LOAD ERROR]:'), e.message);
        return false;
    }
}

async function startDarkDinu() {
    try {
        console.log(chalk.cyan('[DATABASE]') + ' Connecting to MongoDB...');
        if (mongoose.connection.readyState !== 1) {
            await mongoose.connect(config.MONGODB_URI);
        }
        console.log(chalk.green.bold('[DATABASE] Connected! ⚡'));

        await settings.initSettings();
        loadPlugins();

        const { state, saveCreds } = await useMongoDBAuthState();
        
        // Creds නැත්නම් SESSION_ID එකෙන් load කිරීම
        if (!state.creds || !state.creds.registered) {
            const loaded = await loadSessionFromID();
            if (!loaded) return;
        }

        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
            },
            printQRInTerminal: false,
            browser: Browsers.ubuntu('Chrome'),
            syncFullHistory: false,
            markOnlineOnConnect: true,
            msgRetryCounterCache,
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 25000
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                console.log(chalk.red(`[!] Disconnected (${statusCode}). Reconnecting: ${shouldReconnect}`));

                if (shouldReconnect) {
                    await delay(3000);
                    startDarkDinu();
                } else {
                    console.log(chalk.red.bold('[!] Session Logged Out! Please get a new SESSION_ID.'));
                }
            } else if (connection === 'open') {
                console.log(chalk.green.bold('\n[✓] DARK DINU V1 IS RUNNING AT 100% MAXIMUM SPEED! ⚡\n'));
                const ownerJid = `${config.OWNER_NUMBER}@s.whatsapp.net`;
                await sock.sendMessage(ownerJid, { 
                    text: `⚡ *DARK DINU V1 IS ONLINE* ⚡\n\n` +
                          `🛡️ *Status:* Connected (Permanent Engine)\n` +
                          `🛢️ *Database:* MongoDB Atlas\n` +
                          `🚀 *Speed:* Zero Lag`
                }).catch(() => {});
            }
        });

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;
            const m = messages[0];
            if (!m.message) return;
            await dispatchCommand(sock, m, config, settings);
        });

    } catch (err) {
        console.error(chalk.red('[FATAL ERROR]:'), err.message);
        await delay(5000);
        startDarkDinu();
    }
}

startDarkDinu();
