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

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let pairingSocket = null;

// Clean Temp Folder
const tempAuthFolder = path.join(__dirname, 'temp_session');

// ⚡ 100% Instant Pairing Route
app.get('/pair', async (req, res) => {
    let phone = req.query.phone;
    if (!phone) return res.status(400).json({ error: 'දුරකථන අංකය ඇතුළත් කරන්න!' });

    phone = phone.replace(/[^0-9]/g, '');

    try {
        if (fs.existsSync(tempAuthFolder)) {
            fs.rmSync(tempAuthFolder, { recursive: true, force: true });
        }

        const { state, saveCreds } = await useMultiFileAuthState(tempAuthFolder);
        const { version } = await fetchLatestBaileysVersion();

        if (pairingSocket) {
            try { pairingSocket.end(); } catch (e) {}
        }

        pairingSocket = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
            },
            printQRInTerminal: false,
            // Logging in හිරවීම වළක්වන official desktop fingerprint
            browser: ['Chrome (Linux)', 'Chrome', '124.0.6367.60'],
            markOnlineOnConnect: false,
            generateHighQualityLinkPreview: false,
            syncFullHistory: false,
            msgRetryCounterCache,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 0,
            keepAliveIntervalMs: 10000
        });

        pairingSocket.ev.on('creds.update', saveCreds);

        // Pairing Handshake Delay
        await delay(2000);

        const rawCode = await pairingSocket.requestPairingCode(phone);
        const formatted = rawCode?.match(/.{1,4}/g)?.join('-') || rawCode;
        console.log(chalk.black.bgCyan.bold(`\n [PAIR CODE] Generated: ${formatted} for ${phone} \n`));

        // Background Auto-Save after successful WhatsApp connection
        pairingSocket.ev.on('connection.update', async (update) => {
            const { connection } = update;

            if (connection === 'open') {
                console.log(chalk.green.bold('\n[✓] WHATSAPP LOGGED IN! Syncing to MongoDB Atlas...'));
                
                try {
                    if (mongoose.connection.readyState !== 1) {
                        await mongoose.connect(config.MONGODB_URI);
                    }
                    
                    const mongoAuth = await useMongoDBAuthState();
                    const files = fs.readdirSync(tempAuthFolder);

                    // Local temp files සියල්ල එකවර MongoDB එකට sync කිරීම
                    for (const file of files) {
                        if (file.endsWith('.json')) {
                            const content = JSON.parse(fs.readFileSync(path.join(tempAuthFolder, file)));
                            const keyName = file.replace('.json', '');
                            if (keyName === 'creds') {
                                await mongoAuth.saveCreds(content);
                            } else {
                                await mongoose.connection.collection('sessions').updateOne(
                                    { _id: keyName },
                                    { $set: { data: JSON.stringify(content) } },
                                    { upsert: true }
                                );
                            }
                        }
                    }

                    console.log(chalk.green.bold('[✓] MongoDB Sync Complete! Starting Dark Dinu V1...'));
                    
                    setTimeout(() => {
                        try { pairingSocket.end(); } catch (e) {}
                        fs.rmSync(tempAuthFolder, { recursive: true, force: true });
                        startBotServer();
                    }, 3000);

                } catch (saveErr) {
                    console.error('Mongo Save Error:', saveErr.message);
                }
            }
        });

        return res.json({ code: formatted });

    } catch (err) {
        console.error(chalk.red('[PAIR ERROR]:'), err);
        return res.status(500).json({ error: err.message || 'Pairing failed' });
    }
});

app.listen(port, () => {
    console.log(chalk.green.bold(`[SERVER] Live on Port ${port}`));
});

// Main Bot Permanent Worker
async function startBotServer() {
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
            browser: ['Chrome (Linux)', 'Chrome', '124.0.6367.60'],
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
                console.log(chalk.red(`[!] Disconnected. Status: ${statusCode}. Reconnecting: ${shouldReconnect}`));

                if (shouldReconnect) {
                    await delay(3000);
                    startBotServer();
                } else {
                    console.log(chalk.red.bold('[!] Logged Out. Clearing Session...'));
                    try {
                        await mongoose.connection.collection('sessions').deleteMany({});
                    } catch {}
                }
            } else if (connection === 'open') {
                console.log(chalk.green.bold('\n[✓] DARK DINU V1 IS RUNNING AT 100% MAXIMUM SPEED! ⚡\n'));
                const ownerJid = `${config.OWNER_NUMBER}@s.whatsapp.net`;
                await sock.sendMessage(ownerJid, { text: '⚡ *DARK DINU V1 CONNECTED SUCCESSFULLY* ⚡' }).catch(() => {});
            }
        });

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;
            const m = messages[0];
            if (!m.message) return;
            await dispatchCommand(sock, m, config, settings);
        });

    } catch (e) {
        console.error(chalk.red('[MAIN BOT ERROR]:'), e.message);
    }
}

// Check on boot
startBotServer();
