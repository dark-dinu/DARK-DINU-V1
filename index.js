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
const {
    useMongoDBAuthState,
    getAllRegisteredSessions,
    deleteSession
} = require('./database/mongo');
const settings = require('./database/settings');
const { loadPlugins, dispatchCommand } = require('./lib/handler');

const app = express();
const port = process.env.PORT || 8000;

// High-speed Baileys internal caches
const msgRetryCounterCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });
const userDevicesCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });
const groupCache = new NodeCache({ stdTTL: 600, checkperiod: 120, useClones: false });
const logger = pino({ level: 'silent' });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ───────────── Multi-Session Registry ─────────────
const sessions = new Map(); // sessionId -> { sock, sockId, connected, activePulse }
const pairingInProgress = new Set();

async function connectDB() {
    if (mongoose.connection.readyState !== 1) {
        await mongoose.connect(config.MONGODB_URI, {
            serverSelectionTimeoutMS: 15000,
            family: 4
        });
    }
}

function stopSession(sessionId) {
    const session = sessions.get(sessionId);
    if (session) {
        session.sockId++;
        session.connected = false;
        if (session.activePulse) clearInterval(session.activePulse);
        try { session.sock.end(undefined); } catch (e) {}
        sessions.delete(sessionId);
    }
}

// ───────────── Core Multi-Socket Launcher ─────────────
async function startSession(sessionId, { allowUnregistered = false } = {}) {
    await connectDB();

    const { state, saveCreds } = await useMongoDBAuthState(sessionId);

    if (!state.creds.registered && !allowUnregistered) {
        return null;
    }

    stopSession(sessionId);

    let sessionObj = {
        sock: null,
        sockId: 1,
        connected: false,
        activePulse: null
    };
    sessions.set(sessionId, sessionObj);
    const id = sessionObj.sockId;

    let version;
    try {
        const latest = await Promise.race([
            fetchLatestBaileysVersion(),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))
        ]);
        version = latest.version;
    } catch (e) {}

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
        shouldSyncHistoryMessage: () => false,
        shouldIgnoreJid: (jid) => !!jid && (jid.endsWith('@broadcast') || jid.endsWith('@newsletter')),
        cachedGroupMetadata: async (jid) => groupCache.get(jid),
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

    sessionObj.sock = s;

    s.getGroupMeta = async (jid) => {
        let meta = groupCache.get(jid);
        if (!meta) {
            meta = await s.groupMetadata(jid);
            groupCache.set(jid, meta);
        }
        return meta;
    };

    s.ev.on('creds.update', saveCreds);

    s.ev.on('connection.update', async (update) => {
        if (sessionObj.sockId !== id) return;

        const { connection, lastDisconnect } = update;

        if (connection === 'open') {
            sessionObj.connected = true;
            console.log(chalk.green.bold(`\n[✓] BOT ONLINE: ${sessionId} ⚡\n`));

            s.groupFetchAllParticipating()
                .then((all) => { for (const jid in all) groupCache.set(jid, all[jid]); })
                .catch(() => {});

            if (sessionObj.activePulse) clearInterval(sessionObj.activePulse);
            sessionObj.activePulse = setInterval(async () => {
                if (sessionObj.connected && s && sessionObj.sockId === id) {
                    try { await s.sendPresenceUpdate('available'); } catch (e) {}
                }
            }, 25000);

            // Welcome Notification (Per Session)
            const alertKey = `initialSent_${sessionId}`;
            const alreadySent = settings.get(alertKey);
            if (!alreadySent) {
                const ownerJid = `${config.OWNER_NUMBER}@s.whatsapp.net`;
                await s.sendMessage(ownerJid, {
                    text: `⚡ *DARK DINU V1 LINKED* ⚡\n\n` +
                          `📱 *Account:* ${sessionId}\n` +
                          `🛡️ *Status:* Connected Successfully\n` +
                          `👑 *Developer:* 94719845166`
                }).catch(() => {});
                await settings.set(alertKey, true);
            }
        }

        if (connection === 'close') {
            sessionObj.connected = false;
            if (sessionObj.activePulse) {
                clearInterval(sessionObj.activePulse);
                sessionObj.activePulse = null;
            }

            const code = lastDisconnect?.error?.output?.statusCode;
            console.log(chalk.red(`[!] Session ${sessionId} closed (code: ${code})`));

            if (code === DisconnectReason.loggedOut) {
                console.log(chalk.red(`[!] Session ${sessionId} logged out. Cleaning data.`));
                await deleteSession(sessionId).catch(() => {});
                stopSession(sessionId);
                return;
            }

            if (!state.creds.registered) return;

            const reconnectDelay = code === DisconnectReason.restartRequired ? 1000 : 3500;
            await delay(reconnectDelay);
            if (sessionObj.sockId !== id) return;
            startSession(sessionId).catch((e) => console.error(`[RECONNECT ERROR ${sessionId}]:`, e.message));
        }
    });

    s.ev.on('messages.upsert', async ({ messages, type }) => {
        if (sessionObj.sockId !== id) return;
        if (type !== 'notify') return;

        for (const m of messages) {
            if (!m || !m.message) continue;
            if (m.key?.remoteJid === 'status@broadcast') continue;
            dispatchCommand(s, m, config, settings).catch((e) =>
                console.error(`[CMD ERROR ${sessionId}]:`, e.message)
            );
        }
    });

    return { sock: s, state };
}

// ───────────── Web Multi-Device API ─────────────

// Status of all active bots
app.get('/status', (req, res) => {
    const list = [];
    for (const [id, s] of sessions.entries()) {
        list.push({ phone: id, connected: s.connected });
    }
    res.json({
        total: sessions.size,
        active: list.filter(x => x.connected).length,
        devices: list
    });
});

app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'active',
        totalBots: sessions.size
    });
});

// Multi-device pairing endpoint (Any number can pair independently)
app.get('/pair', async (req, res) => {
    const phone = String(req.query.phone || '').replace(/[^0-9]/g, '');

    if (phone.length < 8 || phone.length > 15) {
        return res.status(400).json({ error: 'Please enter a valid number with country code.' });
    }
    if (mongoose.connection.readyState !== 1) {
        return res.status(503).json({ error: 'Database is not connected.' });
    }

    const existing = sessions.get(phone);
    if (existing && existing.connected) {
        return res.status(409).json({ error: 'This phone number is already linked and online.' });
    }
    if (pairingInProgress.has(phone)) {
        return res.status(429).json({ error: 'Pairing already in progress for this number. Please wait.' });
    }

    pairingInProgress.add(phone);
    try {
        stopSession(phone);
        await deleteSession(phone);

        const result = await startSession(phone, { allowUnregistered: true });
        if (!result) throw new Error('Could not initiate connection.');

        await delay(3000);

        const raw = await result.sock.requestPairingCode(phone);
        const formatted = raw?.match(/.{1,4}/g)?.join('-') || raw;
        console.log(chalk.cyan(`[PAIRING] New session code for ${phone}: ${formatted}`));

        return res.json({ code: formatted, phone });
    } catch (err) {
        console.error(chalk.red(`[PAIR ERROR ${phone}]:`), err);
        stopSession(phone);
        return res.status(500).json({ error: err.message || 'Pairing failed. Try again.' });
    } finally {
        pairingInProgress.delete(phone);
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
    }, 3 * 60 * 1000);
}

// ───────────── Boot Sequence ─────────────
(async () => {
    app.listen(port, () => {
        console.log(chalk.green(`[SERVER] Multi-Device Hub Live on port ${port}`));
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

        // MongoDB එකේ සේව් වී ඇති සියලුම linked numbers එකවර ආරම්භ කිරීම
        const savedSessions = await getAllRegisteredSessions();
        console.log(chalk.cyan(`[BOOT] Found ${savedSessions.length} registered WhatsApp session(s). Starting...`));

        for (const sessionId of savedSessions) {
            startSession(sessionId).catch((err) => {
                console.error(`[BOOT ERROR ${sessionId}]:`, err.message);
            });
            await delay(1500); // Concurrency stagger
        }
    } catch (err) {
        console.error(chalk.red('[BOOT ERROR]:'), err.message);
    }
})();
