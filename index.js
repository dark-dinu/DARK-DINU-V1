const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const express = require('express');
const path = require('path');
const fs = require('fs');
const { 
    default: makeWASocket, 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    Browsers
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const mongoose = require('mongoose');
const chalk = require('chalk');
const NodeCache = require('node-cache');

const config = require('./config');
const { useMongoDBAuthState } = require('./database/mongo');
const settings = require('./database/settings');
const { loadPlugins, dispatchCommand } = require('./lib/handler');

const app = express();
const port = process.env.PORT || 8000;
const msgRetryCounterCache = new NodeCache();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const SESSION_DIR = path.join(__dirname, 'dark_session');
let activeSock = null;

// Pairing Code Handler
app.get('/pair', async (req, res) => {
    let phone = req.query.phone;
    if (!phone) return res.status(400).json({ error: 'දුරකථන අංකය ඇතුළත් කරන්න!' });
    phone = phone.replace(/[^0-9]/g, '');

    try {
        if (fs.existsSync(SESSION_DIR)) {
            fs.rmSync(SESSION_DIR, { recursive: true, force: true });
        }

        const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
        const { version } = await fetchLatestBaileysVersion();

        if (activeSock) {
            try { activeSock.end(); } catch (e) {}
        }

        activeSock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
            },
            printQRInTerminal: false,
            browser: Browsers.windows('Desktop'),
            syncFullHistory: false,
            markOnlineOnConnect: false,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 0
        });

        activeSock.ev.on('creds.update', saveCreds);

        await delay(2000);

        const rawCode = await activeSock.requestPairingCode(phone);
        const formatted = rawCode?.match(/.{1,4}/g)?.join('-') || rawCode;
        console.log(chalk.cyan(`[PAIRING] Code generated: ${formatted}`));

        // Phone එකෙන් Confirm කළ සැනින් Run වන Listener එක
        activeSock.ev.on('connection.update', async (update) => {
            const { connection } = update;

            if (connection === 'open') {
                console.log(chalk.green.bold('[✓] DEVICE LINKED! Saving Session to MongoDB Atlas...'));

                try {
                    if (mongoose.connection.readyState !== 1) {
                        await mongoose.connect(config.MONGODB_URI);
                    }

                    const credsFile = path.join(SESSION_DIR, 'creds.json');
                    if (fs.existsSync(credsFile)) {
                        const credsData = JSON.parse(fs.readFileSync(credsFile, 'utf-8'));
                        
                        await mongoose.connection.collection('sessions').updateOne(
                            { _id: 'creds' },
                            { $set: { data: JSON.stringify(credsData) } },
                            { upsert: true }
                        );
                        console.log(chalk.green.bold('[✓] Session Synced with MongoDB! Launching Dark Dinu Engine...'));
                    }

                    setTimeout(() => {
                        try { activeSock.end(); } catch (e) {}
                        launchMainEngine();
                    }, 2000);

                } catch (mongoErr) {
                    console.error('Mongo Save Failed:', mongoErr.message);
                }
            }
        });

        return res.json({ code: formatted });

    } catch (err) {
        console.error(chalk.red('[PAIR ERROR]:'), err);
        return res.status(500).json({ error: err.message || 'Pairing error' });
    }
});

app.listen(port, () => console.log(chalk.green(`[SERVER] Live on Port ${port}`)));

// Main Production Bot Loop (Link වූ පසු ක්‍රියාත්මක වන කොටස)
async function launchMainEngine() {
    try {
        if (mongoose.connection.readyState !== 1) {
            await mongoose.connect(config.MONGODB_URI);
        }

        await settings.initSettings();
        loadPlugins();

        const { state, saveCreds } = await useMongoDBAuthState();
        const { version } = await fetchLatestBaileysVersion();

        if (!state.creds || !state.creds.registered) {
            console.log(chalk.yellow('[INFO] Bot waiting for web pairing...'));
            return;
        }

        const sock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
            },
            printQRInTerminal: false,
            browser: Browsers.windows('Desktop'),
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
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                console.log(chalk.red(`[!] Disconnected. Reconnecting: ${shouldReconnect}`));
                if (shouldReconnect) {
                    setTimeout(launchMainEngine, 3000);
                }
            } else if (connection === 'open') {
                console.log(chalk.green.bold('\n[✓] DARK DINU V1 IS RUNNING AT 100% MAXIMUM SPEED! ⚡\n'));
                const ownerJid = `${config.OWNER_NUMBER}@s.whatsapp.net`;
                await sock.sendMessage(ownerJid, { 
                    text: `⚡ *DARK DINU V1 IS ONLINE* ⚡\n\n` +
                          `🛡️ *Status:* Connected Successfully\n` +
                          `🛢️ *Database:* MongoDB Atlas\n` +
                          `👑 *Developer:* 94719845166`
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
        console.error(chalk.red('[ENGINE ERROR]:'), err.message);
    }
}

launchMainEngine();
