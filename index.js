const express = require('express');
const path = require('path');
const { 
    default: makeWASocket, 
    DisconnectReason, 
    useMultiFileAuthState,
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

let sock = null;
let isPairingInProgress = false;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Pairing Code Route (100% Reliable Ubuntu/Chrome Handshake)
app.get('/pair', async (req, res) => {
    let phone = req.query.phone;
    if (!phone) return res.status(400).json({ error: 'දුරකථන අංකය අවශ්‍යයි!' });

    phone = phone.replace(/[^0-9]/g, '');

    try {
        if (!sock) {
            return res.status(503).json({ error: 'Socket එක සූදානම් වෙමින් පවතී. තත්පර 5කින් නැවත උත්සාහ කරන්න.' });
        }

        if (sock.authState.creds.registered) {
            return res.json({ code: 'ALREADY_LINKED' });
        }

        isPairingInProgress = true;
        
        // WhatsApp handshake එකට කුඩා විරාමයක් ලබාදීම
        await delay(1500);

        const code = await sock.requestPairingCode(phone);
        const formatted = code?.match(/.{1,4}/g)?.join('-') || code;

        console.log(chalk.black.bgCyan.bold(`\n [PAIRING] Code generated for ${phone}: ${formatted} \n`));
        return res.json({ code: formatted });

    } catch (err) {
        console.error(chalk.red('[PAIR ERROR]:'), err.message);
        isPairingInProgress = false;
        return res.status(500).json({ error: 'Code එක ලබාගැනීමට නොහැකි විය. Page එක Refresh කර නැවත උත්සාහ කරන්න.' });
    }
});

app.listen(port, () => {
    console.log(chalk.green.bold(`[SERVER] Web Interface running on port ${port}`));
});

// Main Bot Core Engine
async function startDarkEngine() {
    try {
        if (mongoose.connection.readyState !== 1) {
            console.log(chalk.cyan('[DATABASE]') + ' Connecting to MongoDB Atlas...');
            await mongoose.connect(config.MONGODB_URI);
            console.log(chalk.green.bold('[DATABASE] Atlas Connection Established! ⚡'));
        }

        await settings.initSettings();
        loadPlugins();

        const { state, saveCreds } = await useMongoDBAuthState();
        const { version } = await fetchLatestBaileysVersion();

        console.log(chalk.yellow(`[SYSTEM] Starting Baileys socket with WA Web v${version.join('.')}`));

        sock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            auth: state,
            printQRInTerminal: false,
            msgRetryCounterCache,
            // Render Server වලට වඩාත්ම ගැළපෙන Browser fingerprint එක
            browser: Browsers.ubuntu('Chrome'),
            syncFullHistory: false,
            markOnlineOnConnect: true,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 0,
            keepAliveIntervalMs: 25000,
            generateHighQualityLinkPreview: true
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

                console.log(chalk.red(`[!] Connection Closed (Status: ${statusCode}). Reconnecting: ${shouldReconnect}`));

                if (statusCode === DisconnectReason.loggedOut) {
                    console.log(chalk.red.bold('[!] Session Logged Out. Clearing old session from DB...'));
                    try {
                        await mongoose.connection.collection('sessions').deleteMany({});
                    } catch {}
                }

                // Pair වෙන අතරතුර connection එක drop වුණොත් තත්පර 3ක් ඉඳලා reconnect වීම
                await delay(3000);
                startDarkEngine();

            } else if (connection === 'open') {
                isPairingInProgress = false;
                console.log(chalk.green.bold('\n═══════════════════════════════════════════'));
                console.log(chalk.green.bold(' [✓] DARK DINU V1 CONNECTED SUCCESSFULLY! ⚡'));
                console.log(chalk.green.bold('═══════════════════════════════════════════\n'));

                const ownerJid = `${config.OWNER_NUMBER}@s.whatsapp.net`;
                await sock.sendMessage(ownerJid, { 
                    text: `⚡ *DARK DINU V1 IS ONLINE* ⚡\n\n` +
                          `🛡️ *Status:* Connected Successfully\n` +
                          `🛢️ *Database:* MongoDB Atlas\n` +
                          `🚀 *Engine:* 2026 Production Ready`
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
        console.error(chalk.red('[BOOT ERROR]:'), err.message);
        await delay(5000);
        startDarkEngine();
    }
}

startDarkEngine();
