const { cmd } = require('../lib/handler');

cmd({
    pattern: 'ping',
    alias: ['speed', 'p'],
    desc: 'Check accurate real-time latency',
    category: 'general',
    react: '⚡'
}, async (sock, m) => {
    const start = Date.now();

    // 1. Initial message යවා Network round-trip ආරම්භය සලකුණු කිරීම
    const sentMsg = await sock.sendMessage(m.jid, { text: '⚡ *Pinging...*' }, { quoted: m });

    // 2. සත්‍ය WebSocket Handshake latency එක ගණනය කිරීම
    const realSpeed = Date.now() - start;

    // 3. චාම් Dark Minimalist layout එකකින් පණිවිඩය Edit කිරීම
    const latencyText = `⚡ *DARK DINU SPEED*\n\n` +
                        `▸ *Response:* \`${realSpeed}ms\`\n` +
                        `▸ *Status:* \`Ultra Stable\`\n\n` +
                        `> *Engine 2026*`;

    await sock.sendMessage(m.jid, {
        text: latencyText,
        edit: sentMsg.key
    });
});
