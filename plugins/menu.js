const { cmd, commands } = require('../lib/handler');
const settings = require('../database/settings');

cmd({
    pattern: 'menu',
    alias: ['help', 'list'],
    desc: 'Displays all commands',
    category: 'general'
}, async (sock, m) => {
    const currentPrefix = settings.get('prefix');
    let menuText = 
`╔════ *DARK DINU COMMANDS* ════╗\n\n`;

    const registered = new Set();
    commands.forEach((c) => {
        if (!registered.has(c.pattern)) {
            registered.add(c.pattern);
            menuText += `➤ *${currentPrefix}${c.pattern}* - ${c.desc || ''}\n`;
        }
    });

    menuText += `\n╚════════════════════════════╝`;
    await sock.sendMessage(m.key.remoteJid, { text: menuText }, { quoted: m });
});
