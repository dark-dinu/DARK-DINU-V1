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
const { loadPlugins, dispatchCommand } = require('./lib/handler');

const app = express();
const port = process.env.PORT || 8000;
const msgRetryCounterCache = new NodeCache();

app.use(express.json());

// Public Folder එකෙන් index.html එක Root එකටම Serve කිරීම
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Single Direct Pairing Handler
app.get('/pair', async (req, res) => {
    let phone = req.query.phone;
    if (!phone) return res.status(400).json({ error: 'Number required' });
    phone = phone.replace(/[^0-9]/g, '');

    const tempDir = path.join(__dirname, 'temp_' + phone);
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });

    try {
        const { state, saveCreds } = await useMultiFileAuthState(tempDir);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
            },
            printQRInTerminal: false,
            browser: ['Ubuntu', 'Chrome', '20.0.04']
        });

        sock.ev.on('creds.update', saveCreds);

        await delay(2000);
        const code = await sock.requestPairingCode(phone);
        const formatted = code?.match(/.{1,4}/g)?.join('-') || code;

        // WhatsApp එකෙන් link වූ සැනින් Session එක Mongo වලට save කර Main Engine එකට මාරු වීම
        sock.ev.on('connection.update', async (up) => {
            if (up.connection === 'open') {
                try {
                    if (mongoose.connection.readyState !== 1) await mongoose.connect(config.MONGODB_URI);
                    const mongoAuth = await useMongoDBAuthState();
                    const credsData = JSON.parse(fs.readFileSync(path.join(tempDir, 'creds.json')));
                    await mongoAuth.saveCreds(credsData);
                    console.log(chalk.green.bold('[✓] Logged in & Mongo Saved!'));
                    try { sock.end(); } catch(e){}
                    fs.rmSync(tempDir, { recursive: true, force: true });
                    setTimeout(startMainBot, 2000);
                } catch(e) {
                    console.error('Mongo Save Error:', e);
                }
            }
        });

        return res.json({ code: formatted });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

app.listen(port, () => console.log(chalk.green(`[SERVER] Live on ${port}`)));

// Main Bot Engine
async function startMainBot() {
    try {
        if (mongoose.connection.readyState !== 1) await mongoose.connect(config.MONGODB_URI);
        await settings.initSettings();
        loadPlugins();

        const { state, saveCreds } = await useMongoDBAuthState();
        const { version } = await fetchLatestBaileysVersion();

        if (!state.creds || !state.creds.registered) {
            console.log(chalk.yellow('[INFO] Waiting for pairing from browser...'));
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
            browser: ['Ubuntu', 'Chrome', '20.0.04'],
            syncFullHistory: false,
            markOnlineOnConnect: true,
            msgRetryCounterCache
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (up) => {
            const { connection, lastDisconnect } = up;
            if (connection === 'close') {
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                if (shouldReconnect) setTimeout(startMainBot, 3000);
            } else if (connection === 'open') {
                console.log(chalk.green.bold('[✓] DARK DINU V1 IS RUNNING AT 100% SPEED! ⚡'));
                const ownerJid = `${config.OWNER_NUMBER}@s.whatsapp.net`;
                await sock.sendMessage(ownerJid, { text: '⚡ *DARK DINU V1 ONLINE* ⚡' }).catch(()=>{});
            }
        });

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;
            const m = messages[0];
            if (!m.message) return;
            await dispatchCommand(sock, m, config, settings);
        });

    } catch (e) {
        console.error('Bot Error:', e);
    }
}

startMainBot();
