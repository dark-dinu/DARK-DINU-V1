const express = require('express');
const path = require('path');
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
const NodeCache = require('node-cache');

const config = require('./config');
const { useMongoDBAuthState } = require('./database/mongo');
const settings = require('./database/settings');
const { commands, loadPlugins, dispatchCommand } = require('./lib/handler');

const app = express();
const port = process.env.PORT || 8000;
const msgRetryCounterCache = new NodeCache();

app.use(express.json());
// Public folder එක serve කිරීම
app.use(express.static(path.join(__dirname, 'public')));

let mainSock = null;

// On-Demand Ultra Fast Pairing Code Route
app.get('/pair', async (req, res) => {
    const phone = req.query.phone;
    if (!phone) return res.status(400).json({ error: 'Phone number required' });

    const cleanNumber = phone.replace(/[^0-9]/g, '');

    try {
        const { state, saveCreds } = await useMongoDBAuthState();
        const { version } = await fetchLatestBaileysVersion();

        const pairSocket = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            auth: state,
            printQRInTerminal: false,
            browser: Browsers.macOS('Desktop')
        });

        pairSocket.ev.on('creds.update', saveCreds);

        await delay(2000); // Handshake stabilization

        if (!pairSocket.authState.creds.registered) {
            const rawCode = await pairSocket.requestPairingCode(cleanNumber);
            const code = rawCode?.match(/.{1,4}/g)?.join('-') || rawCode;
            
            // Background listener: Link වූ පසු Main Bot Socket එක restart කර ගැනීමට
            pairSocket.ev.on('connection.update', async (up) => {
                if (up.connection === 'open') {
                    console.log(chalk.green.bold('[✓] Pairing Completed! Starting Main Bot Service...'));
                    if (!mainSock) startBotEngine();
                }
            });

            return res.json({ code });
        } else {
            return res.json({ code: 'ALREADY_PAIRED' });
        }
    } catch (err) {
        console.error(chalk.red('[PAIR ERROR]:'), err.message);
        return res.status(500).json({ error: 'Pairing failed. Wait 5s and try again.' });
    }
});

// Render Port එක open කිරීම
app.listen(port, () => {
    console.log(chalk.green.bold(`[SERVER] Web Interface running at port ${port}`));
});

// Main Bot Execution Loop
async function startBotEngine() {
    try {
        console.log(chalk.cyan('[DATABASE]') + ' Connecting to MongoDB Atlas...');
        await mongoose.connect(config.MONGODB_URI);
        console.log(chalk.green.bold('[DATABASE] Atlas Connection Established! ⚡'));

        await settings.initSettings();
        loadPlugins();

        const { state, saveCreds } = await useMongoDBAuthState();
        const { version } = await fetchLatestBaileysVersion();

        if (!state.creds.registered) {
            console.log(chalk.yellow('[NOTICE] Bot is not paired yet. Waiting for Pairing from Web Interface...'));
            return;
        }

        const sock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            auth: state,
            printQRInTerminal: false,
            msgRetryCounterCache,
            browser: Browsers.macOS('Desktop'),
            syncFullHistory: false,
            markOnlineOnConnect: true,
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 25000
        });

        mainSock = sock;
        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                console.log(chalk.red(`[!] Connection Closed. Reconnecting: ${shouldReconnect}`));
                if (shouldReconnect) {
                    await delay(3000);
                    startBotEngine();
                }
            } else if (connection === 'open') {
                console.log(chalk.green.bold('\n[✓] DARK DINU V1 IS LIVE AND RUNNING AT MAXIMUM SPEED! ⚡'));
            }
        });

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;
            const m = messages[0];
            if (!m.message) return;
            await dispatchCommand(sock, m, config, settings);
        });

    } catch (err) {
        console.error(chalk.red('[BOOT ERROR]:'), err.message);
        await delay(5000);
        startBotEngine();
    }
}

// Start bot if already paired
startBotEngine();
