const { on } = require('../lib/handler');
const { frame, numberOf } = require('../lib/utils');

// Small in-memory cache of recent messages (max 400)
const cache = new Map();
const MAX_CACHE = 400;

on({ on: 'message' }, async (sock, m, args, config, settings) => {
    const proto = m.content?.protocolMessage;

    // 1) A message was deleted -> look it up and report to the owner
    if (proto && (proto.type === 0 || proto.type === 'REVOKE') && proto.key?.id) {
        if (settings.get('antiDelete') !== 'on') return;

        const saved = cache.get(proto.key.id);
        if (!saved || saved.key.fromMe) return;

        const owner = `${config.OWNER_NUMBER}@s.whatsapp.net`;
        const where = saved.key.remoteJid.endsWith('@g.us') ? 'Group chat' : 'Private chat';
        const who = numberOf(saved.key.participant || saved.key.remoteJid);

        await sock.sendMessage(owner, {
            text: frame('ANTI DELETE 🗑️', [
                `👤 *From*  : @${who}`,
                `💬 *Where* : ${where}`,
                `🕒 *Time*  : ${new Date().toLocaleString()}`
            ]),
            mentions: [(saved.key.participant || saved.key.remoteJid)]
        }).catch(() => {});

        await sock.sendMessage(owner, { forward: saved }, {}).catch(() => {});
        cache.delete(proto.key.id);
        return;
    }

    // 2) Normal message -> remember it
    if (!m.message || proto || !m.key.id) return;
    if (m.jid === 'status@broadcast') return;

    cache.set(m.key.id, { key: m.key, message: m.message, messageTimestamp: m.messageTimestamp, pushName: m.pushName });
    if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
});
