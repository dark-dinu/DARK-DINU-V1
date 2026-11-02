// DNS Issue Fix for Render / Node.js
const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4']);

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

// ⚡ On-Demand Instant Pairing Route
app.get('/pair', async (req, res) => {
    let phone = req.query.phone;
    if (!phone) return res.status(400).json({ error: 'දුරකථන අංකය ඇතුළත් කරන්න!' });

    phone = phone.replace(/[^0-9]/g, '');

    try {
        if (mongoose.connection.readyState !== 1) {
            await mongoose.connect(config.MONGODB_URI, {
                serverSelectionTimeoutMS: 5000,
                family: 4 // IPv4 Force කර DNS error වළක්වයි
            });
        }

        const { state, saveCreds } = await useMongoDBAuthState();
        const { version } = await fetchLatestBaileysVersion();

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

        await delay(2000);

        if (!pairSock.authState.creds.registered) {
            const rawCode = await pairSock.requestPairingCode(phone);
            const formatted = rawCode?.match(/.{1,4}/g)?.join('-') || rawCode;
            console.log(chalk.black.bgCyan.bold(`\n [PAIRING] Code generated for ${phone}: ${formatted} \n`));

            pairSock.ev.on('connection.update', async (update) => {
                const { connection } = update;
                if (connection === 'open') {
                    console.log(chalk.green.bold('[✓] DEVICE LINKED! Launching bot...'));
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
        return res.status(500).json({ error: 'DB Connection Error: ' + err.message });
    }
});

app.listen(port, () => {
    console.log(chalk.green.bold(`[SERVER] Dark Web UI active on port ${port}`));
});

async function startMainBot() {
    try {
        if (mongoose.connection.readyState !== 1) {
            await mongoose.connect(config.MONGODB_URI, { family: 4 });
        }

        await settings.initSettings();
        loadPlugins();

        const { state, saveCreds } = await useMongoDBAuthState();
        const { version } = await fetchLatestBaileysVersion();

        if (!state.creds.registered) return;

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
            keepAliveIntervalMs: 25000
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                if (shouldReconnect) {
                    await delay(3000);
                    startMainBot();
                }
            } else if (connection === 'open') {
                console.log(chalk.green.bold('\n[✓] DARK DINU V1 IS RUNNING AT 100% MAXIMUM SPEED! ⚡\n'));
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

startMainBot();
