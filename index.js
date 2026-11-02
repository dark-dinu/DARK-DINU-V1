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

let pairSock = null;

// Pairing Code Route (Anti-Hanging Engine)
app.get('/pair', async (req, res) => {
    let phone = req.query.phone;
    if (!phone) return res.status(400).json({ error: 'Number required' });
    phone = phone.replace(/[^0-9]/g, '');

    const tempDir = path.join(__dirname, 'auth_temp');
    if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }

    try {
        const { state, saveCreds } = await useMultiFileAuthState(tempDir);
        const { version } = await fetchLatestBaileysVersion();

        if (pairSock) {
            try { pairSock.end(); } catch (e) {}
        }

        pairSock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
            },
            printQRInTerminal: false,
            // Logging in හිරවීම වළක්වන desktop identity
            browser: Browsers.macOS('Chrome'),
            syncFullHistory: false,
            markOnlineOnConnect: true,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 0,
            keepAliveIntervalMs: 10000
        });

        pairSock.ev.on('creds.update', saveCreds);

        // Code එක ඉක්මනින් request කිරීම
        await delay(2000);
        const code = await pairSock.requestPairingCode(phone);
        const formatted = code?.match(/.{1,4}/g)?.join('-') || code;

        // WhatsApp එකෙන් Link වූ සැනින් Session එක Mongo වලට save කර Bot එක start වීම
        pairSock.ev.on('connection.update', async (up) => {
            const { connection } = up;

            if (connection === 'open') {
                console.log(chalk.green.bold('[✓] DEVICE LINKED SUCCESSFULLY!'));
                
                try {
                    if (mongoose.connection.readyState !== 1) {
                        await mongoose.connect(config.MONGODB_URI);
                    }

                    const mongoAuth = await useMongoDBAuthState();
                    const credsPath = path.join(tempDir, 'creds.json');
                    
                    if (fs.existsSync(credsPath)) {
                        const credsData = JSON.parse(fs.readFileSync(credsPath));
                        await mongoAuth.saveCreds(credsData);
                        console.log(chalk.green.bold('[✓] Session stored in MongoDB!'));
                    }

                    setTimeout(() => {
                        try { pairSock.end(); } catch (e) {}
                        fs.rmSync(tempDir, { recursive: true, force: true });
                        startMainBot();
                    }, 2000);

                } catch (dbErr) {
                    console.error('Mongo Save Failed:', dbErr.message);
                }
            }
        });

        return res.json({ code: formatted });

    } catch (err) {
        console.error('Pair Error:', err);
        return res.status(500).json({ error: err.message });
    }
});

app.listen(port, () => console.log(chalk.green(`[SERVER] Live on Port ${port}`)));

// Main Production Bot Loop
async function startMainBot() {
    try {
        if (mongoose.connection.readyState !== 1) {
            await mongoose.connect(config.MONGODB_URI);
        }

        await settings.initSettings();
        loadPlugins();

        const { state, saveCreds } = await useMongoDBAuthState();
        const { version } = await fetchLatestBaileysVersion();

        if (!state.creds || !state.creds.registered) {
            console.log(chalk.yellow('[INFO] Bot awaiting web pairing...'));
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
            browser: Browsers.macOS('Chrome'),
            syncFullHistory: false,
            markOnlineOnConnect: true,
            msgRetryCounterCache,
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 25000
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (up) => {
            const { connection, lastDisconnect } = up;

            if (connection === 'close') {
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                console.log(chalk.red(`[!] Disconnected. Reconnecting: ${shouldReconnect}`));
                if (shouldReconnect) {
                    setTimeout(startMainBot, 3000);
                }
            } else if (connection === 'open') {
                console.log(chalk.green.bold('\n[✓] DARK DINU V1 IS LIVE AND COMMANDS ARE ACTIVE! ⚡\n'));
                const ownerJid = `${config.OWNER_NUMBER}@s.whatsapp.net`;
                await sock.sendMessage(ownerJid, { 
                    text: `⚡ *DARK DINU V1 IS ONLINE* ⚡\n\n` +
                          `🛡️ *Status:* Connected Successfully\n` +
                          `⚙️ *Prefix:* ${settings.get('prefix') || '.'}\n` +
                          `👑 *Developer:* 94719845166`
                }).catch(() => {});
            }
        });

        // Single Point Zero-Lag Command Dispatcher
        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;
            const m = messages[0];
            if (!m.message) return;
            await dispatchCommand(sock, m, config, settings);
        });

    } catch (e) {
        console.error('Bot Boot Error:', e);
    }
}

// Auto Boot if session exists
startMainBot();
