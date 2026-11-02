const express = require('express');
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

let sockInstance = null;
let isConnected = false;

app.use(express.json());

// ⚡ Dark Cyber Neon Web Pairing Interface (Render URL එකෙන් Open වන Box එක)
app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>DARK DINU V1 | PAIRING ENGINE</title>
        <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700;900&family=Rajdhani:wght@600;700&display=swap" rel="stylesheet">
        <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body {
                background: #050508;
                color: #ffffff;
                font-family: 'Rajdhani', sans-serif;
                min-height: 100vh;
                display: flex;
                align-items: center;
                justify-content: center;
                background-image: 
                    radial-gradient(circle at 50% 50%, rgba(255, 0, 55, 0.08) 0%, transparent 60%),
                    linear-gradient(rgba(255, 0, 55, 0.03) 1px, transparent 1px),
                    linear-gradient(90deg, rgba(255, 0, 55, 0.03) 1px, transparent 1px);
                background-size: 100% 100%, 30px 30px, 30px 30px;
                padding: 20px;
            }
            .cyber-card {
                background: rgba(10, 10, 15, 0.85);
                backdrop-filter: blur(15px);
                border: 1px solid rgba(255, 0, 60, 0.3);
                border-radius: 12px;
                padding: 40px 30px;
                width: 100%;
                max-width: 440px;
                box-shadow: 0 0 30px rgba(255, 0, 55, 0.15), inset 0 0 15px rgba(255, 0, 55, 0.05);
                position: relative;
                overflow: hidden;
            }
            .cyber-card::before {
                content: '';
                position: absolute;
                top: 0; left: 0; width: 100%; height: 3px;
                background: linear-gradient(90deg, transparent, #ff003c, #ff416c, transparent);
            }
            h1 {
                font-family: 'Orbitron', sans-serif;
                font-size: 24px;
                color: #fff;
                letter-spacing: 2px;
                text-align: center;
                text-shadow: 0 0 10px rgba(255, 0, 60, 0.7);
                margin-bottom: 5px;
            }
            .subtitle {
                text-align: center;
                color: #8b8b9e;
                font-size: 13px;
                letter-spacing: 1px;
                margin-bottom: 25px;
            }
            .status-badge {
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 8px;
                margin-bottom: 25px;
                font-size: 14px;
                color: ${isConnected ? '#00ff88' : '#ff003c'};
                font-weight: 700;
                letter-spacing: 1px;
            }
            .dot {
                width: 10px; height: 10px;
                border-radius: 50%;
                background: ${isConnected ? '#00ff88' : '#ff003c'};
                box-shadow: 0 0 10px ${isConnected ? '#00ff88' : '#ff003c'};
            }
            .input-group {
                margin-bottom: 20px;
            }
            label {
                display: block;
                font-size: 12px;
                color: #ff003c;
                margin-bottom: 8px;
                letter-spacing: 1px;
                text-transform: uppercase;
                font-weight: 700;
            }
            input {
                width: 100%;
                padding: 14px 16px;
                background: rgba(20, 20, 30, 0.7);
                border: 1px solid rgba(255, 0, 60, 0.3);
                border-radius: 6px;
                color: #fff;
                font-size: 16px;
                font-family: 'Orbitron', monospace;
                letter-spacing: 1px;
                outline: none;
                transition: 0.3s;
            }
            input:focus {
                border-color: #ff003c;
                box-shadow: 0 0 15px rgba(255, 0, 60, 0.4);
            }
            button {
                width: 100%;
                padding: 15px;
                background: linear-gradient(135deg, #ff003c, #990024);
                border: none;
                border-radius: 6px;
                color: #fff;
                font-family: 'Orbitron', sans-serif;
                font-size: 14px;
                font-weight: 700;
                letter-spacing: 2px;
                cursor: pointer;
                transition: 0.3s;
                box-shadow: 0 0 20px rgba(255, 0, 60, 0.4);
            }
            button:hover {
                background: linear-gradient(135deg, #ff1a53, #b3002d);
                box-shadow: 0 0 30px rgba(255, 0, 60, 0.7);
            }
            #codeBox {
                display: none;
                margin-top: 25px;
                background: rgba(0, 0, 0, 0.6);
                border: 1px dashed #ff003c;
                border-radius: 6px;
                padding: 15px;
                text-align: center;
            }
            .code-text {
                font-family: 'Orbitron', monospace;
                font-size: 28px;
                color: #00ffcc;
                letter-spacing: 5px;
                text-shadow: 0 0 15px rgba(0, 255, 204, 0.6);
                margin: 10px 0;
            }
            .instructions {
                font-size: 12px;
                color: #8b8b9e;
                line-height: 1.5;
            }
        </style>
    </head>
    <body>
        <div class="cyber-card">
            <h1>DARK DINU V1</h1>
            <div class="subtitle">MULTI-DEVICE ENGINE 2026</div>
            
            <div class="status-badge">
                <div class="dot"></div>
                <span>${isConnected ? 'STATUS: CONNECTED & ONLINE' : 'STATUS: WAITING FOR PAIRING'}</span>
            </div>

            <div class="input-group">
                <label>WhatsApp Number (With Country Code)</label>
                <input type="text" id="phone" placeholder="94719845166" value="${config.OWNER_NUMBER}">
            </div>

            <button onclick="requestPairing()">GENERATE PAIRING CODE</button>

            <div id="codeBox">
                <div style="font-size: 11px; color: #ff003c; letter-spacing: 1px;">PAIRING CODE:</div>
                <div class="code-text" id="codeDisplay">----</div>
                <div class="instructions">Open WhatsApp ➜ Linked Devices ➜ Link with phone number instead</div>
            </div>
        </div>

        <script>
            async function requestPairing() {
                const phone = document.getElementById('phone').value.trim();
                const codeBox = document.getElementById('codeBox');
                const codeDisplay = document.getElementById('codeDisplay');
                
                if (!phone) return alert('Please enter phone number');
                codeBox.style.display = 'block';
                codeDisplay.innerText = 'GENERATING...';

                try {
                    const res = await fetch('/pair?phone=' + encodeURIComponent(phone));
                    const data = await res.json();
                    if (data.code) {
                        codeDisplay.innerText = data.code;
                    } else {
                        codeDisplay.innerText = data.error || 'FAILED';
                    }
                } catch (e) {
                    codeDisplay.innerText = 'ERROR';
                }
            }
        </script>
    </body>
    </html>
    `);
});

// Pairing Code Endpoint (Browser එකෙන් request කළ විට code එක ලබාදෙයි)
app.get('/pair', async (req, res) => {
    const phone = req.query.phone;
    if (!phone) return res.status(400).json({ error: 'Phone number required' });
    if (!sockInstance) return res.status(500).json({ error: 'Bot socket initializing, try again in 5s' });

    try {
        const cleanNumber = phone.replace(/[^0-9]/g, '');
        const code = await sockInstance.requestPairingCode(cleanNumber);
        const formatted = code?.match(/.{1,4}/g)?.join('-') || code;
        return res.json({ code: formatted });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// Render Web Service Port Listener
app.listen(port, () => {
    console.log(chalk.green.bold(`[SERVER] Dark Web Interface Live on port ${port}`));
});

// Main Bot Core Engine
async function startDarkEngine() {
    try {
        console.log(chalk.cyan('[DATABASE]') + ' Connecting to MongoDB Atlas...');
        await mongoose.connect(config.MONGODB_URI);
        console.log(chalk.green.bold('[DATABASE] Atlas Connection Established! ⚡'));

        await settings.initSettings();
        loadPlugins();

        const { state, saveCreds } = await useMongoDBAuthState();
        const { version } = await fetchLatestBaileysVersion();

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
            keepAliveIntervalMs: 25000,
            generateHighQualityLinkPreview: true
        });

        sockInstance = sock;

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === 'close') {
                isConnected = false;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                console.log(chalk.red(`[!] Connection Closed. Reconnecting: ${shouldReconnect}`));
                if (shouldReconnect) {
                    await delay(3000);
                    startDarkEngine();
                }
            } else if (connection === 'open') {
                isConnected = true;
                console.log(chalk.green.bold('\n[✓] DARK DINU V1 CONNECTED SUCCESSFULLY! ⚡'));
            }
        });

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;
            const m = messages[0];
            if (!m.message) return;
            await dispatchCommand(sock, m, config, settings);
        });

    } catch (err) {
        console.error(chalk.red('[CRITICAL BOOTSTRAP ERROR]:'), err);
        await delay(5000);
        startDarkEngine();
    }
}

startDarkEngine();
