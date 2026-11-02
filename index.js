const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
dns.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);

const express = require('express');
const path = require('path');
const {
    default: makeWASocket,
    DisconnectReason,
    fetchLatestBaileysVersion,
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
const logger = pino({ level: 'silent' });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ───────────── State ─────────────
let sock = null;
let sockId = 0;        // used to ignore events from old sockets
let connected = false;
let pairBusy = false;

async function connectDB() {
    if (mongoose.connection.readyState !== 1) {
        await mongoose.connect(config.MONGODB_URI);
    }
}

function stopSock() {
    sockId++;
    connected = false;
    if (sock) {
        try { sock.end(undefined); } catch (e) {}
        sock = null;
    }
}

async function wipeSession() {
    await connectDB();
    await mongoose.connection.collection('sessions').deleteMany({});
}

// ───────────── Core connection ─────────────
// Single function used for BOTH pairing and normal running.
// After pairing WhatsApp forces a disconnect (code 515 "restartRequired").
// We must reconnect with the same auth state - the old code never did this.
async function startSock({ allowUnregistered = false } = {}) {
    await connectDB();

    const { state, saveCreds } = await useMongoDBAuthState();

    if (!state.creds.registered && !allowUnregistered) {
        console.log(chalk.yellow('[INFO] No linked session. Waiting for pairing from the web page...'));
        return null;
    }

    stopSock();
    const id = sockId;

    const { version } = await fetchLatestBaileysVersion();

    const s = makeWASocket({
        version,
        logger,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger)
        },
        printQRInTerminal: false,
        browser: Browsers.ubuntu('Chrome'),
        syncFullHistory: false,
        markOnlineOnConnect: true,
        msgRetryCounterCache,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 25000
    });
    sock = s;

    s.ev.on('creds.update', saveCreds);

    s.ev.on('connection.update', async (update) => {
        if (id !== sockId) return; // stale socket

        const { connection, lastDisconnect } = update;

        if (connection === 'open') {
            connected = true;
            console.log(chalk.green.bold('\n[✓] DARK DINU V1 IS ONLINE ⚡\n'));
            const ownerJid = `${config.OWNER_NUMBER}@s.whatsapp.net`;
            await s.sendMessage(ownerJid, {
                text: `⚡ *DARK DINU V1 IS ONLINE* ⚡\n\n` +
                      `🛡️ *Status:* Connected Successfully\n` +
                      `🛢️ *Database:* MongoDB Atlas\n` +
                      `👑 *Developer:* 94719845166`
            }).catch(() => {});
        }

        if (connection === 'close') {
            connected = false;
            const code = lastDisconnect?.error?.output?.statusCode;
            console.log(chalk.red(`[!] Connection closed (code: ${code})`));

            if (code === DisconnectReason.loggedOut) {
                console.log(chalk.red('[!] Logged out. Clearing session.'));
                await wipeSession().catch(() => {});
                stopSock();
                return;
            }

            // Not linked yet (user never entered the code) -> don't loop
            if (!state.creds.registered) return;

            // 515 = restart required right after pairing -> reconnect fast
            await delay(code === DisconnectReason.restartRequired ? 500 : 3000);
            if (id !== sockId) return;
            startSock().catch((e) => console.error('[RECONNECT ERROR]:', e.message));
        }
    });

    s.ev.on('messages.upsert', async ({ messages, type }) => {
        if (id !== sockId) return;
        if (type !== 'notify') return;
        const m = messages[0];
        if (!m || !m.message) return;
        try {
            await dispatchCommand(s, m, config, settings);
        } catch (e) {
            console.error('[CMD ERROR]:', e.message);
        }
    });

    return { sock: s, state };
}

// ───────────── Web API ─────────────
app.get('/status', (req, res) => {
    res.json({ connected });
});

app.get('/pair', async (req, res) => {
    const phone = String(req.query.phone || '').replace(/[^0-9]/g, '');

    if (phone.length < 8 || phone.length > 15) {
        return res.status(400).json({ error: 'Please enter a valid number with country code.' });
    }
    if (connected) {
        return res.status(409).json({ error: 'This bot is already linked and online.' });
    }
    if (pairBusy) {
        return res.status(429).json({ error: 'A request is already in progress. Please wait.' });
    }

    pairBusy = true;
    try {
        stopSock();
        await wipeSession();

        const result = await startSock({ allowUnregistered: true });
        if (!result) throw new Error('Could not start connection.');

        // give the socket time to open its websocket
        await delay(3000);

        const raw = await result.sock.requestPairingCode(phone);
        const formatted = raw?.match(/.{1,4}/g)?.join('-') || raw;
        console.log(chalk.cyan(`[PAIRING] Code for ${phone}: ${formatted}`));

        return res.json({ code: formatted });
    } catch (err) {
        console.error(chalk.red('[PAIR ERROR]:'), err);
        stopSock();
        return res.status(500).json({ error: err.message || 'Pairing failed. Try again.' });
    } finally {
        pairBusy = false;
    }
});

// ───────────── Boot ─────────────
(async () => {
    // Web server first so Render never kills the app
    app.listen(port, () => console.log(chalk.green(`[SERVER] Live on port ${port}`)));

    // Keep retrying until MongoDB connects
    while (true) {
        try {
            await mongoose.connect(config.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
            console.log(chalk.green('[DB] MongoDB connected'));
            break;
        } catch (err) {
            console.error(chalk.red('[DB ERROR]:'), err.message, '- retrying in 8s');
            if (/ENOTFOUND|querySrv/i.test(err.message)) {
                console.error(chalk.yellow('[HINT] Check MONGODB_URI (cluster hostname) and Atlas Network Access = 0.0.0.0/0'));
            }
            await delay(8000);
        }
    }

    try {
        await settings.initSettings();
        loadPlugins();
        await startSock();
    } catch (err) {
        console.error(chalk.red('[BOOT ERROR]:'), err.message);
    }
})();
