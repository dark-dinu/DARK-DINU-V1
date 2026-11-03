const { cmd } = require('../lib/handler');
const fs = require('fs');
const path = require('path');

// ⚡ Logo Memory Cache
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

// ───────────── 1. Status Dashboard & Controls ─────────────
cmd({
    pattern: 'statusset',
    alias: ['stset', 'autostatus'],
    desc: 'Manage auto status read and react settings',
    category: 'owner',
    fromMe: true,
    react: '⚙️'
}, async (sock, m, { args, text }, config, settings) => {
    const input = text ? text.trim() : '';

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

    // Dashboard Menu
    const stRead = settings.get('auto_status_read') ? 'ON 🟢' : 'OFF 🔴';
    const stReact = settings.get('auto_status_react') ? 'ON 🟢' : 'OFF 🔴';
    const stEmoji = settings.get('status_react_emoji') || '❤️';

    const menu = `*╭━━〔 STATUS CONTROLLER ⚙️ 〕━━╮*
┃
┃ *[1.1]* Auto Status Read ➔ \`${stRead}\`
┃ *[1.2]* Auto Status React ➔ \`${stReact}\`
┃ *[1.3]* Status React Emoji ➔ \`${stEmoji}\`
┃
*╰━━━━━━━━━━━━━━━━━━━━╯*

*To change setting, reply or type:*
▸ \`.statusset 1.1\` _(Toggle Status Seen)_
▸ \`.statusset 1.2\` _(Toggle Status React)_
▸ \`.streact <emoji>\` _(Set Custom Emoji)_

> *◉ ᴅᴇᴠ ʜᴇꜱʜᴀɴ ᴏꜰᴄ ◉*`;

    if (cachedLogo) {
        await sock.sendMessage(m.jid, { image: cachedLogo, caption: menu }, { quoted: m });
    } else {
        await sock.sendMessage(m.jid, { text: menu }, { quoted: m });
    }
});

// ───────────── 2. Direct Emoji Changer Command ─────────────
cmd({
    pattern: 'streact',
    alias: ['setemoji', 'statusemoji'],
    desc: 'Set custom reaction emoji for status',
    category: 'owner',
    fromMe: true,
    react: '❤️'
}, async (sock, m, { text }, config, settings) => {
    if (!text) {
        const current = settings.get('status_react_emoji') || '❤️';
        return m.reply(`*Please provide an emoji!*\n\n*Current Emoji:* ${current}\n*Example:* \`.streact ⚡\``);
    }

    const emoji = text.trim();
    await settings.set('status_react_emoji', emoji);

    return m.reply(`✅ *Status React Emoji Successfully Updated!*\n\n▸ *New Emoji:* ${emoji}`);
});
