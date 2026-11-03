const { cmd } = require('../lib/handler');
const { frame, getTargets, sleep } = require('../lib/utils');

cmd({
    pattern: 'owner',
    alias: ['creator', 'dev'],
    desc: 'Get the owner contact card',
    category: 'main',
    react: '👑'
}, async (sock, m, args, config) => {
    const vcard =
        'BEGIN:VCARD\nVERSION:3.0\n' +
        `FN:${config.BOT_NAME} Owner\n` +
        `ORG:${config.BOT_NAME};\n` +
        `TEL;type=CELL;type=VOICE;waid=${config.OWNER_NUMBER}:+${config.OWNER_NUMBER}\n` +
        'END:VCARD';
    await sock.sendMessage(
        m.jid,
        { contacts: { displayName: `${config.BOT_NAME} Owner`, contacts: [{ vcard }] } },
        { quoted: m }
    );
});

cmd({
    pattern: 'restart',
    alias: ['reboot'],
    desc: 'Restart the bot',
    category: 'owner',
    fromMe: true,
    react: '🔄'
}, async (sock, m) => {
    await m.reply('🔄 *Restarting... I will be back in a few seconds.*');
    setTimeout(() => process.exit(0), 1500);
});

cmd({
    pattern: 'block',
    desc: 'Block a user (reply / mention / number)',
    category: 'owner',
    fromMe: true
}, async (sock, m, args) => {
    let targets = getTargets(m, args);
    if (!targets.length && !m.isGroup) targets = [m.jid];
    if (!targets.length) return m.reply('❌ *Reply to, mention or type the number of the user.*');
    for (const t of targets) await sock.updateBlockStatus(t, 'block');
    await m.reply(`🚫 *Blocked ${targets.length} user(s).*`);
});

cmd({
    pattern: 'unblock',
    desc: 'Unblock a user (reply / mention / number)',
    category: 'owner',
    fromMe: true
}, async (sock, m, args) => {
    let targets = getTargets(m, args);
    if (!targets.length && !m.isGroup) targets = [m.jid];
    if (!targets.length) return m.reply('❌ *Reply to, mention or type the number of the user.*');
    for (const t of targets) await sock.updateBlockStatus(t, 'unblock');
    await m.reply(`✅ *Unblocked ${targets.length} user(s).*`);
});

cmd({
    pattern: 'setbio',
    alias: ['setstatus'],
    desc: 'Change the bot WhatsApp bio',
    category: 'owner',
    fromMe: true
}, async (sock, m, args) => {
    const bio = args.join(' ');
    if (!bio) return m.reply('❌ *Give the new bio text.*');
    await sock.updateProfileStatus(bio);
    await m.reply('✅ *Bio updated.*');
});

cmd({
    pattern: 'bc',
    alias: ['broadcast'],
    desc: 'Broadcast a message to all groups',
    category: 'owner',
    fromMe: true,
    react: '📢'
}, async (sock, m, args) => {
    const text = args.join(' ');
    if (!text) return m.reply('❌ *Give the message to broadcast.*');

    const groups = Object.keys(await sock.groupFetchAllParticipating());
    await m.reply(`📢 *Sending to ${groups.length} groups...*`);

    let ok = 0;
    for (const g of groups) {
        try {
            await sock.sendMessage(g, { text: frame('BROADCAST', [text]) });
            ok++;
        } catch (e) { /* skip failed group */ }
        await sleep(1500);
    }
    await m.reply(`✅ *Broadcast finished:* ${ok}/${groups.length} groups.`);
});
