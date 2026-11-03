const { cmd } = require('../lib/handler');

cmd({
    pattern: 'ping',
    alias: ['speed', 'p'],
    desc: 'Check real-time bot speed',
    category: 'general',
    react: '⚡'
}, async (sock, m) => {
    // WhatsApp message timestamp එක සහ වත්මන් වේලාව අතර සැබෑ Latency එක
    const msgTimestamp = m.messageTimestamp ? Number(m.messageTimestamp) * 1000 : Date.now();
    const realSpeed = Math.max(1, Date.now() - msgTimestamp);

    const pingText = `*❬❬ DARK DINU SPEED🔥 ❭❭*\n\n` +
                     `▸ *Response:* \`${realSpeed}ms\` ✔️\n` +
                     `▸ *Status:* \`Ultra Stable\`\n\n` +
                     `> *◉ ᴅᴇᴠ ʜᴇꜱʜᴀɴ ᴏꜰᴄ ◉*`;

    await sock.sendMessage(m.jid, { text: pingText }, { quoted: m });
});
