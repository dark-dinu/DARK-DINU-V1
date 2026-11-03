const dns = require('dns');
try {
    dns.setDefaultResultOrder('ipv4first');
    dns.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);
} catch (e) {}

const express = require('express');
const path = require('path');
const https = require('https');
const http = require('http');
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

// High-speed Baileys internal caches
const msgRetryCounterCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });
const userDevicesCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });
const logger = pino({ level: 'silent' });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Self-ping & Uptime monitor route
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'active', connected });
});

// ───────────── State ─────────────
let sock = null;
let sockId = 0;
let connected = false;
let pairBusy = false;
let activePulse = null;

async function connectDB() {
    if (mongoose.connection.readyState !== 1) {
        await mongoose.connect(config.MONGODB_URI, {
            serverSelectionTimeoutMS: 15000,
            family: 4
        });
    }
}

function stopSock() {
    sockId++;
    connected = false;
    if (activePulse) {
        clearInterval(activePulse);
        activePulse = null;
    }
    if (sock) {
        try { sock.end(undefined); } catch (e) {}
        sock = null;
    }
}

async function wipeSession() {
    await connectDB();
    await mongoose.connection.collection('sessions').deleteMany({});
    await settings.set('initialConnectSent', false);
}

// ───────────── Core Connection Engine ─────────────
async function startSock({ allowUnregistered = false } = {}) {
    await connectDB();

    const { state, saveCreds } = await useMongoDBAuthState();

    if (!state.creds.registered && !allowUnregistered) {
        console.log(chalk.yellow('[INFO] No linked session. Waiting for pairing from web UI...'));
        return null;
    }

    stopSock();
    const id = sockId;

    const { version } = await fetchLatestBaileysVersion();

    // 24/7 Ultra Fast Stable Socket
    const s = makeWASocket({
        version,
        logger,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger)
        },
        printQRInTerminal: false,
        browser: Browsers.macOS('Desktop'),
        syncFullHistory: false,
        markOnlineOnConnect: true,
        generateHighQualityLinkPreview: false,
        msgRetryCounterCache,
        userDevicesCache,
        emitOwnEvents: false,
        fireInitQueries: false,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 15000,
        defaultQueryTimeoutMs: 60000
    });
    sock = s;

    s.ev.on('creds.update', saveCreds);

    s.ev.on('connection.update', async (update) => {
        if (id !== sockId) return;

        const { connection, lastDisconnect } = update;

        if (connection === 'open') {
            connected = true;
            console.log(chalk.green.bold('\n[✓] DARK DINU V1 IS ONLINE 24/7 ⚡\n'));

            // Anti-Idle Stream Pulse (විනාඩි ගණනක් මැසේජ් නොආවත් WebSocket connection එක dormant වීම වළක්වයි)
            if (activePulse) clearInterval(activePulse);
            activePulse = setInterval(async () => {
                if (connected && sock && id === sockId) {
                    try {
                        await sock.sendPresenceUpdate('available');
                    } catch (e) {}
                }
            }, 25000);

            // පළමු වතාවට Link වූ විට පමණක් Message එක යැවීම
            const alreadySent = settings.get('initialConnectSent');
            if (!alreadySent) {
                const ownerJid = `${config.OWNER_NUMBER}@s.whatsapp.net`;
                await s.sendMessage(ownerJid, {
                    text: `⚡ *DARK DINU V1 IS ONLINE 24/7* ⚡\n\n` +
                          `🛡️ *Status:* Connected Permanently\n` +
                          `🛢️ *Database:* MongoDB Atlas\n` +
                          `🚀 *Engine:* High Speed Active\n` +
                          `👑 *Developer:* 94719845166`
                }).catch(() => {});

                await settings.set('initialConnectSent', true);
            }
        }

        if (connection === 'close') {
            connected = false;
            if (activePulse) {
                clearInterval(activePulse);
                activePulse = null;
            }

            const code = lastDisconnect?.error?.output?.statusCode;
            console.log(chalk.red(`[!] Connection closed (code: ${code})`));

            if (code === DisconnectReason.loggedOut) {
                console.log(chalk.red('[!] Logged out. Clearing session.'));
                await wipeSession().catch(() => {});
                stopSock();
                return;
            }

            if (!state.creds.registered) return;

            const reconnectDelay = code === DisconnectReason.restartRequired ? 1000 : 3500;
            await delay(reconnectDelay);
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
    if (mongoose.connection.readyState !== 1) {
        return res.status(503).json({ error: 'Database is not connected.' });
    }
    if (connected) {
        return res.status(409).json({ error: 'This bot is already linked and online.' });
    }
    if (pairBusy) {
        return res.status(429).json({ error: 'Pairing in progress. Please wait.' });
    }

    pairBusy = true;
    try {
        stopSock();
        await wipeSession();

        const result = await startSock({ allowUnregistered: true });
        if (!result) throw new Error('Could not start connection.');

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

// ───────────── Render Auto Keep-Alive ─────────────
function startKeepAlive() {
    setInterval(() => {
        const renderUrl = process.env.RENDER_EXTERNAL_URL;
        if (renderUrl) {
            const client = renderUrl.startsWith('https') ? https : http;
            client.get(`${renderUrl}/health`, () => {}).on('error', () => {});
        }
    }, 3 * 60 * 1000); // විනාඩි 3කට වරක් self-ping
}

// ───────────── Boot Sequence ─────────────
(async () => {
    app.listen(port, () => {
        console.log(chalk.green(`[SERVER] Live on port ${port}`));
        startKeepAlive();
    });

    while (true) {
        try {
            await mongoose.connect(config.MONGODB_URI, {
                serverSelectionTimeoutMS: 15000,
                family: 4
            });
            console.log(chalk.green('[DB] MongoDB connected successfully'));
            break;
        } catch (err) {
            console.error(chalk.red('[DB ERROR]:'), err.message, '- retrying in 8s');
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
