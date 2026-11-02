const { cmd } = require('../lib/handler');
const settings = require('../database/settings');
const config = require('../config');

cmd({
    pattern: 'set',
    desc: 'Control bot configuration',
    category: 'owner'
}, async (sock, m, args) => {
    const sender = m.key.participant || m.key.remoteJid;
    const isOwner = sender.includes(config.OWNER_NUMBER);

    if (!isOwner) {
        return sock.sendMessage(m.key.remoteJid, { text: '❌ Owner Only Command!' }, { quoted: m });
    }

    const type = args[0]?.toLowerCase();
    const val = args[1]?.toLowerCase();

    if (type === 'prefix' && val) {
        await settings.set('prefix', val);
        return sock.sendMessage(m.key.remoteJid, { text: `✅ Prefix updated to: *${val}*` }, { quoted: m });
    }

    if (type === 'mode' && (val === 'public' || val === 'private')) {
        await settings.set('mode', val);
        return sock.sendMessage(m.key.remoteJid, { text: `✅ Bot mode changed to: *${val}*` }, { quoted: m });
    }

    const help = 
`*DARK DINU SETTINGS CONTROL*
• .set prefix <symbol> (e.g .set prefix !)
• .set mode <public/private>`;
    await sock.sendMessage(m.key.remoteJid, { text: help }, { quoted: m });
});
