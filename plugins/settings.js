const { cmd } = require('../lib/handler');
const fs = require('fs');
const path = require('path');

// ⚡ Startup Memory Cache for Logo.png (Instant Response)
let cachedLogo = null;
const possiblePaths = [
    path.join(__dirname, '../Logo.png'),
    path.join(__dirname, '../logo.png'),
    path.join(__dirname, '../assets/Logo.png'),
    path.join(__dirname, '../assets/logo.png')
];

for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
        try {
            cachedLogo = fs.readFileSync(p);
            break;
        } catch (e) {}
    }
}

cmd({
    pattern: 'setting',
    alias: ['settings', 'set', 'config'],
    desc: 'Manage bot status, mode, prefix & features',
    category: 'owner',
    fromMe: true,
    react: '⚙️'
}, async (sock, m, { args, text }, config, settings) => {
    const input = text ? text.trim() : '';
    const type = args[0]?.toLowerCase();
    const val = args[1]?.toLowerCase();

    // ──────── 1. අංක මඟින් (Quick Toggle Menu) ────────
    // 1.1 Toggle Auto Status Read
    if (input === '1.1') {
        const current = settings.get('auto_status_read');
        const next = !current;
        await settings.set('auto_status_read', next);
        return m.reply(`*Auto Status Seen:* \`${next ? 'ENABLED [ON] ✅' : 'DISABLED [OFF] ❌'}\``);
    }

    // 1.2 Toggle Auto Status React
    if (input === '1.2') {
        const current = settings.get('auto_status_react');
        const next = !current;
        await settings.set('auto_status_react', next);
        return m.reply(`*Auto Status React:* \`${next ? 'ENABLED [ON] ✅' : 'DISABLED [OFF] ❌'}\``);
    }

    // 1.3 Change React Emoji Guide
    if (input === '1.3') {
        const current = settings.get('status_react_emoji') || '❤️';
        return m.reply(`*Status React Emoji Setup*\n\n▸ *Current Emoji:* ${current}\n▸ *To Change:* Type \`.streact <emoji>\`\n*Example:* \`.streact 🔥\``);
    }

    // 1.4 Toggle Work Mode (Public / Private)
    if (input === '1.4') {
        const current = settings.get('mode') || config.WORK_TYPE || 'public';
        const next = current === 'public' ? 'private' : 'public';
        await settings.set('mode', next);
        return m.reply(`*Bot Work Mode:* \`${next.toUpperCase()} 🔒\``);
    }

    // ──────── 2. Direct Commands (.set / .setting prefix/mode) ────────
    if (type === 'prefix' && args[1]) {
        const newPrefix = args[1].trim();
        await settings.set('prefix', newPrefix);
        return m.reply(`✅ *Prefix updated to:* \`${newPrefix}\``);
    }

    if (type === 'mode' && (val === 'public' || val === 'private')) {
        await settings.set('mode', val);
        return m.reply(`✅ *Bot mode changed to:* \`${val.toUpperCase()}\``);
    }

    // ──────── 3. Settings Dashboard Menu ────────
    const stRead = settings.get('auto_status_read') ? 'ON 🟢' : 'OFF 🔴';
    const stReact = settings.get('auto_status_react') ? 'ON 🟢' : 'OFF 🔴';
    const stEmoji = settings.get('status_react_emoji') || '❤️';
    const currentMode = (settings.get('mode') || config.WORK_TYPE || 'public').toUpperCase();
    const currentPrefix = settings.get('prefix') || config.DEFAULT_PREFIX || '.';

    const menu = `*╭━━〔 DARK DINU SETTINGS ⚙️ 〕━━╮*
┃
┃ *[1.1]* Auto Status Read ➔ \`${stRead}\`
┃ *[1.2]* Auto Status React ➔ \`${stReact}\`
┃ *[1.3]* Status React Emoji ➔ \`${stEmoji}\`
┃ *[1.4]* Work Mode ➔ \`${currentMode}\`
┃ *[1.5]* Current Prefix ➔ \`${currentPrefix}\`
┃
*╰━━━━━━━━━━━━━━━━━━━━╯*

*To change a setting, reply or type:*
▸ \`.setting 1.1\` _(Toggle Status Seen)_
▸ \`.setting 1.2\` _(Toggle Status React)_
▸ \`.setting 1.4\` _(Toggle Public / Private)_
▸ \`.streact <emoji>\` _(Change Emoji)_
▸ \`.setting prefix <symbol>\` _(e.g: .setting prefix !)_
▸ \`.setting mode <public/private>\`

> *◉ ᴅᴇᴠ ʜᴇꜱʜᴀɴ ᴏꜰᴄ ◉*`;

    // Send Image with Caption
    if (cachedLogo) {
        await sock.sendMessage(m.jid, {
            image: cachedLogo,
            caption: menu
        }, { quoted: m });
    } else {
        await sock.sendMessage(m.jid, { text: menu }, { quoted: m });
    }
});
