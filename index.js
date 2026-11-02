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
app.use(express.static(path.join(__dirname, 'public')));

// ⚡ On-Demand Instant Pairing Route (කිසිම වෙලාවක "Socket සූදානම් වෙමින් පවතී" Error නොඑයි)
app.get('/pair', async (req, res) => {
    let phone = req.query.phone;
    if (!phone) return res.status(400).json({ error: 'දුරකථන අංකය ඇතුළත් කරන්න!' });

    phone = phone.replace(/[^0-9]/g, '');

    try {
        if (mongoose.connection.readyState !== 1) {
            await mongoose.connect(config.MONGODB_URI);
        }

        const { state, saveCreds } = await useMongoDBAuthState();
        const { version } = await fetchLatestBaileysVersion();

        // Pairing Code එක ලබාගැනීමට පමණක් සෑදෙන Direct Dedicated Socket එක
        const pairSock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            auth: state,
            printQRInTerminal: false,
            browser: Browsers.ubuntu('Chrome'),
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 0,
            keepAliveIntervalMs: 15000
        });

        pairSock.ev.on('creds.update', saveCreds);

        // Handshake එකට කුඩා කාලයක් ලබාදීම
        await delay(2000);

        if (!pairSock.authState.creds.registered) {
            const rawCode = await pairSock.requestPairingCode(phone);
            const formatted = rawCode?.match(/.{1,4}/g)?.join('-') || rawCode;
            console.log(chalk.black.bgCyan.bold(`\n [PAIRING] Code generated for ${phone}: ${formatted} \n`));

            // Code එක දුන් පසු Phone එකෙන් Link වුණු සැනින් Bot එක start වීම
            pairSock.ev.on('connection.update', async (update) => {
                const { connection } = update;
                if (connection === 'open') {
                    console.log(chalk.green.bold('[✓] DEVICE LINKED SUCCESSFULLY! Launching Main Engine...'));
                    await delay(3000);
                    startMainBot();
                }
            });

            return res.json({ code: formatted });
        } else {
            return res.json({ code: 'ALREADY_LINKED' });
        }

    } catch (err) {
        console.error(chalk.red('[PAIR ERROR]:'), err.message);
        return res.status(500).json({ error: 'Error: ' + err.message });
    }
});

// Render Port Listener
app.listen(port, () => {
    console.log(chalk.green.bold(`[SERVER] Dark Web UI active on port ${port}`));
});

// Main Bot Core Loop (Link වූ පසු ක්‍රියාත්මක වන කොටස)
async function startMainBot() {
    try {
        if (mongoose.connection.readyState !== 1) {
            await mongoose.connect(config.MONGODB_URI);
        }

        await settings.initSettings();
        loadPlugins();

        const { state, saveCreds } = await useMongoDBAuthState();
        const { version } = await fetchLatestBaileysVersion();

        // Device එක link වී නැත්නම් background එකෙන් main bot socket එක run නොකර තබයි (Crash වීම වළක්වයි)
        if (!state.creds.registered) {
            console.log(chalk.yellow('[NOTICE] Bot is not paired yet. Please generate Pairing Code from web interface.'));
            return;
        }

        const sock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            auth: state,
            printQRInTerminal: false,
            msgRetryCounterCache,
            browser: Browsers.ubuntu('Chrome'),
            syncFullHistory: false,
            markOnlineOnConnect: true,
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 25000,
            generateHighQualityLinkPreview: true
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                console.log(chalk.red(`[!] Main Socket Closed. Status: ${statusCode}. Reconnecting: ${shouldReconnect}`));

                if (shouldReconnect) {
                    await delay(3000);
                    startMainBot();
                } else {
                    console.log(chalk.red.bold('[!] Session Logged Out. Clearing DB session...'));
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

    } catch (err) {
        console.error(chalk.red('[BOT ERROR]:'), err.message);
    }
}

// Background auto-starter (කලින් pair කර ඇත්නම් පමණක් auto-start වේ)
startMainBot();
