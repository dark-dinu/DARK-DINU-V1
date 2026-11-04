// .setting panel + reply-to-change + shortcut commands (.antidelete on, .mode private ...)
const { cmd, on } = require('../lib/handler');
const { SECTIONS, buildPanel, applyCodes, applyWord } = require('../lib/panel');

function rememberPanel(S, id) {
    if (!id) return;
    S.panelIds.push(id);
    while (S.panelIds.length > 30) S.panelIds.shift();
}

cmd({
    pattern: 'setting',
    alias: ['settings', 'config', 'panel', 'set'],
    desc: 'Open the control panel (reply with 1.1, 4.2 ...)',
    category: 'settings',
    owner: true,
    react: '🎛️'
}, async (sock, m, { S }) => {
    const sent = await sock.sendMessage(m.jid, { text: buildPanel(S) }, { quoted: m.raw });
    rememberPanel(S, sent?.key?.id);
});

// Owner replies to the panel with "1.1" / "4.2" / "10.6 🔥"
on({ on: 'message' }, async (sock, m, S) => {
    if (!m.isOwner || !m.quoted || !m.body) return;
    if (!S.panelIds.includes(m.quoted.id)) return;

    const r = await applyCodes(S, m.body);
    if (!r.found) return;

    m.react(r.errors.length && !r.changes.length ? '❌' : '✅').catch(() => {});
    const sent = await sock.sendMessage(
        m.jid,
        { text: buildPanel(S, [...r.changes, ...r.errors].join('\n')) },
        { quoted: m.raw }
    );
    rememberPanel(S, sent?.key?.id);
});

// One shortcut command per panel section
for (const sec of SECTIONS) {
    cmd({
        pattern: sec.command,
        alias: sec.aliases,
        desc: `${sec.name} (${sec.options.filter((o) => !o.custom).flatMap((o) => (o.words || [])[0] || []).join('/') || 'emoji'})`,
        category: 'settings',
        owner: true,
        react: '⚙️'
    }, async (sock, m, { S, text, prefix }) => {
        if (!text) {
            const cur = sec.show(S.cfg.get(sec.key));
            return m.reply(`⚙️ *${sec.name}:* ${cur}\n\nවෙනස් කරන්න: \`${prefix}${sec.command} <value>\`\nහෝ \`${prefix}setting\` panel එක use කරන්න.`);
        }
        const r = await applyWord(S, sec, text);
        return m.reply(r.msg);
    });
}

cmd({
    pattern: 'prefix',
    alias: ['setprefix'],
    desc: 'Change command prefix',
    category: 'settings',
    owner: true
}, async (sock, m, { S, text, prefix }) => {
    const p = text.trim();
    if (!p || p.length > 3 || /\s/.test(p)) return m.reply(`❌ භාවිතය: \`${prefix}prefix !\` (අකුරු 1-3ක් ඇතුළත)`);
    await S.cfg.set('prefix', p);
    return m.reply(`✅ Prefix ➜ \`${p}\``);
});
