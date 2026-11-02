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
    delay
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const mongoose = require('mongoose');
const chalk = require('chalk');

const config = require('./config');
const { useMongoDBAuthState } = require('./database/mongo');
const settings = require('./database/settings');
const { commands, loadPlugins, dispatchCommand } = require('./lib/handler');

const app = express();
const port = process.env.PORT || 8000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let activePairSocket = null;

// Instant 1-Second Pairing Code Engine (Zero Mongo Delay)
app.get('/pair', async (req, res) => {
    let phone = req.query.phone;
    if (!phone) return res.status(400).json({ error: 'දුරකථන අංකය ඇතුළත් කරන්න!' });

    phone = phone.replace(/[^0-9]/g, '');

    try {
        const tempAuthFolder = path.join(__dirname, 'temp_session');
        if (fs.existsSync(tempAuthFolder)) {
            fs.rmSync(tempAuthFolder, { recursive: true, force: true });
        }

        const { state, saveCreds } = await useMultiFileAuthState(tempAuthFolder);
        const { version } = await fetchLatestBaileysVersion();

        if (activePairSocket) {
            try { activePairSocket.end(); } catch (e) {}
        }

        activePairSocket = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            auth: state,
            printQRInTerminal: false,
            browser: ['Ubuntu', 'Chrome', '20.0.04'],
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 0
        });

        activePairSocket.ev.on('creds.update', saveCreds);

        await delay(1500);

        const rawCode = await activePairSocket.requestPairingCode(phone);
        const formatted = rawCode?.match(/.{1,4}/g)?.join('-') || rawCode;
        console.log(chalk.black.bgCyan.bold(`\n [PAIRING] Code generated for ${phone}: ${formatted} \n`));

        // WhatsApp එකෙන් Link වුණු සැනින් Session එක Mongo වලට save කර Bot එක start කිරීම
        activePairSocket.ev.on('connection.update', async (update) => {
            const { connection } = update;
            if (connection === 'open') {
                console.log(chalk.green.bold('[✓] DEVICE LINKED! Transferring Session to MongoDB...'));
                
                try {
                    await connectMongoWithRetry();
                    const mongoAuth = await useMongoDBAuthState();
                    
                    // Temp creds MongoDB එකට push කිරීම
                    const credsData = JSON.parse(fs.readFileSync(path.join(tempAuthFolder, 'creds.json')));
                    await mongoAuth.saveCreds(credsData);

                    fs.rmSync(tempAuthFolder, { recursive: true, force: true });
                    console.log(chalk.green.bold('[✓] MongoDB Session Synced! Launching Bot Engine...'));
                    
                    setTimeout(() => startMainBot(), 2000);
                } catch (err) {
                    console.error('Session transfer failed:', err);
                }
            }
        });

        return res.json({ code: formatted });

    } catch (err) {
        console.error(chalk.red('[PAIR ERROR]:'), err);
        return res.status(500).json({ error: 'Pairing failed: ' + (err.message || 'Unknown error') });
    }
});

app.listen(port, () => {
    console.log(chalk.green.bold(`[SERVER] Dark Web UI active on port ${port}`));
});

// Safe MongoDB Connection
async function connectMongoWithRetry() {
    if (mongoose.connection.readyState === 1) return;
    return mongoose.connect(config.MONGODB_URI, {
        serverSelectionTimeoutMS: 8000
    });
}

// Main Production Bot Loop
async function startMainBot() {
    try {
        await connectMongoWithRetry();
        await settings.initSettings();
        loadPlugins();

        const { state, saveCreds } = await useMongoDBAuthState();
        const { version } = await fetchLatestBaileysVersion();

        if (!state.creds || !state.creds.registered) {
            console.log(chalk.yellow('[NOTICE] Bot is waiting to be paired from web UI...'));
            return;
        }

        const sock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            auth: state,
            printQRInTerminal: false,
            browser: ['Ubuntu', 'Chrome', '20.0.04'],
            syncFullHistory: false,
            markOnlineOnConnect: true,
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 25000
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                console.log(chalk.red(`[!] Socket Disconnected. Status: ${statusCode}. Reconnecting: ${shouldReconnect}`));

                if (shouldReconnect) {
                    await delay(3000);
                    startMainBot();
                } else {
                    console.log(chalk.red.bold('[!] Session Logged Out.'));
                    try {
                        await mongoose.connection.collection('sessions').deleteMany({});
                    } catch {}
                }
            } else if (connection === 'open') {
                console.log(chalk.green.bold('\n[✓] DARK DINU V1 IS RUNNING AT 100% MAXIMUM SPEED! ⚡\n'));
                const ownerJid = `${config.OWNER_NUMBER}@s.whatsapp.net`;
                await sock.sendMessage(ownerJid, { text: '⚡ *DARK DINU V1 IS ONLINE & CONNECTED* ⚡' }).catch(() => {});
            }
        });

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;
            const m = messages[0];
            if (!m.message) return;
            await dispatchCommand(sock, m, config, settings);
        });

    } catch (err) {
        console.error(chalk.red('[MAIN BOT ERROR]:'), err.message);
    }
}

startMainBot();
