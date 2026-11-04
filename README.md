# 🤖 DARK-DINU MD  (v2 – fixed & rebuilt)

24/7 multi-device WhatsApp bot. One server = many linked numbers (default limit 200, `MAX_SESSIONS`).

## 🚀 Deploy
1. Upload this folder to GitHub → Render / Koyeb / Railway / VPS (Node 18+).
2. Environment variables (see `.env.example`):
   - `MONGODB_URI`  ← **required** (create a NEW DB password – the old one was public)
   - `APP_URL` (Render sets `RENDER_EXTERNAL_URL` itself)
3. Start command: `npm install && npm start`
4. Open `https://YOUR-APP/` → enter number → pairing code → WhatsApp ▸ Linked devices ▸ *Link with phone number*.
5. Free hosting sleeps: also add `https://YOUR-APP/health` to **UptimeRobot / cron-job.org (every 5 min)**.

## 🗂️ Files you can edit easily
| File | What |
|---|---|
| `config.js` | bot name, owner card, limits |
| `data/defaults.js` | default settings for new numbers |
| `data/status-keywords.js` | oni / ewanna / denna / දෙන්න … words |
| `lib/panel.js` | the `.setting` panel (texts, order, options) |
| `plugins/*.js` | one feature per file (add a new file = new command) |

## 🎛️ Control panel
Send `.setting` → reply to that message with `1.1`, `4.2`, `10.6 🔥` … (several at once: `1.1 2.1 4.1`).
Every option also has a command: `.antidelete on`, `.mode private`, `.online on`, `.offline`, `.presence typing`, `.streact 🔥` …

## 📜 Main commands
`.menu` `.alive` `.ping` `.system` `.owner` `.setting` `.vv` `.save` `.getdp` `.setdp` `.removedp` `.prefix` `.restart` `.jid` `.block` `.unblock` `.setbio` `.bc`

## Add a command (example)
```js
// plugins/hello.js
const { cmd } = require('../lib/handler');
cmd({ pattern: 'hello', desc: 'Say hi', category: 'general' }, async (sock, m, ctx) => {
    await m.reply('Hi ' + (m.pushName || '') + ' 👋');
});
```
