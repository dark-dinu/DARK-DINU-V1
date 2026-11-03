const { cmd } = require('../lib/handler');

// WhatsApp message timestamp (Long | number, seconds) -> ms
function tsToMs(ts) {
    if (!ts) return Date.now();
    const sec = typeof ts === 'object' ? (ts.toNumber ? ts.toNumber() : ts.low) : Number(ts);
    return sec * 1000;
}

cmd({
    pattern: 'ping',
    alias: ['speed', 'p'],
    desc: 'Check real-time bot speed',
    category: 'general',
    react: '⚡'
}, async (sock, m) => {
    // Real latency: time between the message being sent and the bot handling it
    const speed = Math.max(0, Date.now() - tsToMs(m.messageTimestamp));

    const pingText = `*❬❬ DARK DINU SPEED🔥 ❭❭*\n\n` +
                     `▸ *Response:* \`${speed}ms\` ✔️\n` +
                     `▸ *Status:* \`Ultra Stable\`\n\n` +
                     `> *◉ ᴅᴇᴠ ʜᴇꜱʜᴀɴ ᴏꜰᴄ ◉*`;

    await sock.sendMessage(m.jid, { text: pingText }, { quoted: m });
});
