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

const msgRetryCounterCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });
const userDevicesCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });
const groupCache = new NodeCache({ stdTTL: 600, checkperiod: 120, useClones: false });
const logger = pino({ level: 'silent' });

// Crash වීම වළක්වන්න
process.on('unhandledRejection', (e) => console.error('[UNHANDLED REJECTION]:', e?.message || e));
process.on('uncaughtException', (e) => console.error('[UNCAUGHT EXCEPTION]:', e?.message || e));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ───────────── Multi-Session Registry ─────────────
const sessions = new Map();
const pairingInProgress = new Set();

// FIX: pairing එකෙන් පස්සේ creds.registered true නොවෙන්න පුළුවන්, creds.me තියෙනවා නම් link වෙලා
const isRegistered = (creds) => !!(creds && (creds.registered || creds.me));

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

    if (!isRegistered(state.creds) && !allowUnregistered) {
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

    const socketConfig = {
        logger,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger)
        },
        printQRInTerminal: false,
        // FIX: pairing code සඳහා Chrome browser signature අවශ්‍යයි
        browser: Browsers.ubuntu('Chrome'),
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false,
        shouldIgnoreJid: (jid) => !!jid && (jid.endsWith('@broadcast') || jid.endsWith('@newsletter')),
        cachedGroupMetadata: async (jid) => groupCache.get(jid),
        markOnlineOnConnect: true,
        generateHighQualityLinkPreview: false,
        msgRetryCounterCache,
        userDevicesCache,
        emitOwnEvents: false,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 15000,
        defaultQueryTimeoutMs: 60000
    };
    // FIX: version undefined නම් default version overwrite වෙනවා -> connect වෙන්නේ නෑ
    if (version) socketConfig.version = version;

    const s = makeWASocket(socketConfig);

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

            const alertKey = `initialSent_${sessionId}`;
            const alreadySent = settings.get(alertKey);
            if (!alreadySent) {
                const ownerJid = `${config.OWNER_NUMBER}@s.whatsapp.net`;
                await s.sendMessage(ownerJid, {
                    text: `⚡ *DARK DINU V1 IS ONLINE* ⚡\n\n` +
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
                stopSession(sessionId);
                await deleteSession(sessionId).catch(() => {});
                return;
            }

            // FIX: pairing සාර්ථක වුණාම WhatsApp 515 (restartRequired) දෙනවා.
            // creds.me තියෙනවා නම් reconnect කරන්න ඕන.
            if (!isRegistered(state.creds)) return;

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

// Pairing Code Route (retry සමඟ)
app.get('/pair', async (req, res) => {
    const phone = String(req.query.phone || '').replace(/[^0-9]/g, '');

    if (phone.length < 8 || phone.length > 15) {
        return res.status(400).json({ error: 'Please enter a valid number with country code.' });
    }
    if (mongoose.connection.readyState !== 1) {
        return res.status(503).json({ error: 'Database is not connected.' });
    }

    if (pairingInProgress.has(phone)) {
        return res.status(429).json({ error: 'Pairing already in progress. Please wait 10 seconds.' });
    }

    pairingInProgress.add(phone);
    try {
        stopSession(phone);
        await deleteSession(phone).catch(() => {});

        let code = null;
        let lastErr = null;

        for (let attempt = 1; attempt <= 3 && !code; attempt++) {
            try {
                const result = await startSession(phone, { allowUnregistered: true });
                if (!result || !result.sock) throw new Error('Could not initiate connection.');

                // WebSocket handshake සූදානම් වීමට රැඳී සිටීම
                await delay(4000);

                if (isRegistered(result.sock.authState.creds)) {
                    return res.status(409).json({ error: 'This phone number is already registered.' });
                }

                code = await result.sock.requestPairingCode(phone);
            } catch (e) {
                lastErr = e;
                console.error(chalk.yellow(`[PAIR RETRY ${phone}] attempt ${attempt}: ${e.message}`));
                stopSession(phone);
                await delay(2000);
            }
        }

        if (!code) throw lastErr || new Error('Pairing failed.');

        const formatted = code.match(/.{1,4}/g)?.join('-') || code;
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

        const savedSessions = await getAllRegisteredSessions();
        console.log(chalk.cyan(`[BOOT] Found ${savedSessions.length} registered WhatsApp session(s). Starting...`));

        for (const sessionId of savedSessions) {
            startSession(sessionId).catch((err) => {
                console.error(`[BOOT ERROR ${sessionId}]:`, err.message);
            });
            await delay(1500);
        }
    } catch (err) {
        console.error(chalk.red('[BOOT ERROR]:'), err.message);
    }
})();
