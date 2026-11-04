// ─────────────────────────────────────────────────────────────
//  SETTINGS PANEL – edit this file to add / rename / reorder options.
//  Reply "1.1", "4.2", "10.6 🔥" ... to the panel message and the setting changes.
//  Option code = <section n>.<option position>   (the 2nd option of section 4 = 4.2)
// ─────────────────────────────────────────────────────────────
const config = require('../config');

const onOff = (v) => (v ? '🟢 ON' : '🔴 OFF');
const EMOJI_RE = /\p{Extended_Pictographic}/u;

const SECTIONS = [
    {
        n: 1, icon: '🗑️', title: '𝐀𝐍𝐓𝐈 - 𝐃𝐄𝐋𝐄𝐓𝐄', name: 'Anti-Delete', key: 'antiDelete', label: 'Status', show: onOff,
        command: 'antidelete', aliases: ['antidel', 'ad'],
        options: [
            { v: true, text: '🟢 Anti-Delete ON', words: ['on', 'true', 'enable'] },
            { v: false, text: '🔴 Anti-Delete OFF', words: ['off', 'false', 'disable'] }
        ]
    },
    {
        n: 2, icon: '👁️‍🗨️', title: '𝐀𝐍𝐓𝐈 - 𝐕𝐈𝐄𝐖 𝐎𝐍𝐂𝐄', name: 'Anti-ViewOnce', key: 'antiViewOnce', label: 'Status', show: onOff,
        command: 'antiviewonce', aliases: ['antiview', 'antivv', 'avo'],
        options: [
            { v: true, text: '🟢 Anti-ViewOnce ON', words: ['on', 'true', 'enable'] },
            { v: false, text: '🔴 Anti-ViewOnce OFF', words: ['off', 'false', 'disable'] }
        ]
    },
    {
        n: 3, icon: '🎯', title: '𝐒𝐄𝐍𝐃 𝐃𝐄𝐒𝐓𝐈𝐍𝐀𝐓𝐈𝐎𝐍', name: 'Send Destination', key: 'sendTo', label: 'Target', code: true,
        show: (v) => (v === 'chat' ? '💬 CURRENT CHAT' : '📥 INBOX (DM ONLY)'),
        command: 'sendto', aliases: ['dest', 'destination'],
        options: [
            { v: 'inbox', text: '📥 Send to Owner Inbox (Secret DM)', words: ['inbox', 'dm', 'pm', 'owner'] },
            { v: 'chat', text: '💬 Send to Current Chat (Same Group)', words: ['chat', 'group', 'same', 'here'] }
        ]
    },
    {
        n: 4, icon: '🌐', title: '𝐁𝐎𝐓 𝐖𝐎𝐑𝐊 𝐓𝐘𝐏𝐄', name: 'Work Type', key: 'mode', label: 'Current', code: true,
        show: (v) => ({ public: 'PUBLIC', private: 'PRIVATE', group: 'GROUPS ONLY', inbox: 'INBOX ONLY' }[v] || 'PUBLIC'),
        command: 'mode', aliases: ['worktype', 'botmode'],
        options: [
            { v: 'public', text: '🌐 Public Mode (Everyone)', words: ['public', 'everyone'] },
            { v: 'private', text: '🔒 Private Mode (Owner Only)', words: ['private', 'owner'] },
            { v: 'group', text: '👥 Group Chats Only', words: ['group', 'groups'] },
            { v: 'inbox', text: '💬 Inbox Chats Only', words: ['inbox', 'pm', 'dm'] }
        ]
    },
    {
        n: 5, icon: '📵', title: '𝐀𝐍𝐓𝐈 - 𝐂𝐀𝐋𝐋', name: 'Anti-Call', key: 'antiCall', label: 'Status', show: onOff,
        command: 'anticall', aliases: ['rejectcall'],
        options: [
            { v: true, text: '🟢 Auto-Reject Calls ON', words: ['on', 'true', 'enable'] },
            { v: false, text: '🔴 Auto-Reject Calls OFF', words: ['off', 'false', 'disable'] }
        ]
    },
    {
        n: 6, icon: '👁️', title: '𝐒𝐓𝐀𝐓𝐔𝐒 𝐒𝐄𝐄𝐍', name: 'Status Auto-Seen', key: 'statusSeen', label: 'Status', show: onOff,
        command: 'statusseen', aliases: ['autoseen', 'seen'],
        options: [
            { v: true, text: '🟢 Status Auto-Seen ON', words: ['on', 'true', 'enable'] },
            { v: false, text: '🔴 Status Auto-Seen OFF', words: ['off', 'false', 'disable'] }
        ]
    },
    {
        n: 7, icon: '💖', title: '𝐒𝐓𝐀𝐓𝐔𝐒 𝐑𝐄𝐀𝐂𝐓', name: 'Status Auto-React', key: 'statusReact', label: 'Status', show: onOff,
        command: 'statusreact', aliases: ['autoreact'],
        options: [
            { v: true, text: '🟢 Status Auto-React ON', words: ['on', 'true', 'enable'] },
            { v: false, text: '🔴 Status Auto-React OFF', words: ['off', 'false', 'disable'] }
        ]
    },
    {
        n: 8, icon: '🎭', title: '𝐅𝐀𝐊𝐄 𝐏𝐑𝐄𝐒𝐄𝐍𝐂𝐄', name: 'Fake Presence', key: 'presence', label: 'Current', code: true,
        show: (v) => (v === 'typing' ? '✍️ TYPING' : v === 'recording' ? '🎙️ RECORDING' : '🔴 OFF'),
        command: 'presence', aliases: ['fakepresence', 'alwaystyping'],
        options: [
            { v: 'typing', text: '✍️ Always Typing ON', words: ['typing', 'type', 'composing', 'on'] },
            { v: 'recording', text: '🎙️ Always Recording ON', words: ['recording', 'record', 'rec'] },
            { v: 'off', text: '🛑 Presence OFF', words: ['off', 'none', 'stop'] }
        ]
    },
    {
        n: 9, icon: '🚫', title: '𝐀𝐍𝐓𝐈 - 𝐒𝐄𝐍𝐃 𝐄𝐑𝐀𝐒𝐄𝐑', name: 'Anti-Send Eraser', key: 'antiSend', label: 'Current', code: true,
        show: (v) => ({ all: 'ALL MESSAGES', mine: 'MY MESSAGES', others: "OTHERS' MESSAGES" }[v] || 'OFF'),
        command: 'antisend', aliases: ['eraser'],
        options: [
            { v: 'all', text: '💥 Delete All Messages', words: ['all'] },
            { v: 'mine', text: '👤 Delete My Messages Only', words: ['mine', 'my', 'me'] },
            { v: 'others', text: "👥 Delete Others' Messages", words: ['others', 'other'] },
            { v: 'off', text: '🛑 Anti-Send OFF', words: ['off', 'none', 'stop'] }
        ]
    },
    {
        n: 10, icon: '💖', title: '𝐒𝐓𝐀𝐓𝐔𝐒 𝐑𝐄𝐀𝐂𝐓 𝐄𝐌𝐎𝐉𝐈', name: 'Status React Emoji', key: 'statusEmoji', label: 'Current', code: true,
        show: (v) => `[ ${v} ]`,
        command: 'statusemoji', aliases: ['streact', 'setemoji'],
        options: [
            { v: '💖', text: '💖 Pink Heart' },
            { v: '✨', text: '✨ Sparkles' },
            { v: '🔥', text: '🔥 Fire' },
            { v: '⚡', text: '⚡ Lightning' },
            { v: '🥀', text: '🥀 Rose' },
            { custom: true, text: '➕ Custom (Reply `10.6 <emoji>`)' }
        ]
    },
    {
        n: 11, icon: '🟢', title: '𝐀𝐋𝐖𝐀𝐘𝐒 𝐎𝐍𝐋𝐈𝐍𝐄 / 𝐎𝐅𝐅𝐋𝐈𝐍𝐄', name: 'Online Status', key: 'online', label: 'Current', code: true,
        show: (v) => (v === 'on' ? '🟢 ALWAYS ONLINE' : v === 'offline' ? '⚫ ALWAYS OFFLINE' : '⚪ DEFAULT'),
        command: 'online', aliases: ['alwaysonline'],
        options: [
            { v: 'on', text: '🟢 Always Online', words: ['on', 'online', 'true'] },
            { v: 'offline', text: '⚫ Always Offline (Hidden)', words: ['offline', 'hide', 'hidden'] },
            { v: 'default', text: '⚪ Default (WhatsApp normal)', words: ['off', 'default', 'auto', 'normal'] }
        ]
    },
    {
        n: 12, icon: '📥', title: '𝐒𝐓𝐀𝐓𝐔𝐒 𝐒𝐀𝐕𝐄 (𝐨𝐧𝐢/𝐞𝐰𝐚𝐧𝐧𝐚)', name: 'Status Save', key: 'statusSave', label: 'Status', show: onOff,
        command: 'statussave', aliases: ['autosave'],
        options: [
            { v: true, text: '🟢 Status Save ON', words: ['on', 'true', 'enable'] },
            { v: false, text: '🔴 Status Save OFF', words: ['off', 'false', 'disable'] }
        ]
    }
];

function buildPanel(S, note = '') {
    const out = [];
    if (note) out.push(note, '');
    out.push(
        '╔═════════════════════════════╗',
        '   🎛️ 𝐃 𝐀 𝐑 𝐊 - 𝐃 𝐈 𝐍 𝐔  𝐂 𝐎 𝐍 𝐅 𝐈 𝐆',
        '╚═════════════════════════════╝',
        '',
        '📱 *Session ID:* `+' + S.number + '`',
        '⚡ *Core Engine:* `' + config.ENGINE + '`',
        ''
    );
    for (const sec of SECTIONS) {
        const shown = sec.show(S.cfg.get(sec.key));
        out.push(
            `╭───〔 ${sec.n}. ${sec.icon} ${sec.title} 〕`,
            `├ 📌 *${sec.label}:* ${sec.code ? '`' + shown + '`' : shown}`,
            '│'
        );
        sec.options.forEach((o, i) => out.push(`│ [ ${sec.n}.${i + 1} ] ${o.text}`));
        out.push('╰─────────────────────────────', '');
    }
    out.push(
        '> 💡 *වෙනස් කිරීමට අවශ්‍ය අංකය මෙම පණිවිඩයට Reply කරන්න.*',
        '> *(උදාහරණ: 1.1 හෝ 3.1 හෝ 4.2)*',
        '',
        config.FOOTER
    );
    return out.join('\n');
}

async function applyOption(S, sec, opt, extra) {
    let value = opt.v;
    if (opt.custom) {
        if (!extra || !EMOJI_RE.test(extra) || extra.length > 12) {
            return { ok: false, msg: `❌ ${sec.n}.${sec.options.indexOf(opt) + 1} — emoji එකක් දාන්න (e.g. ${sec.n}.${sec.options.indexOf(opt) + 1} 🔥)` };
        }
        value = extra;
    }
    await S.cfg.set(sec.key, value);
    if (sec.key === 'online' || sec.key === 'presence') {
        require('./handler').emit('tick', S, null).catch(() => {});
    }
    return { ok: true, msg: `✅ ${sec.name} ➜ ${sec.show(value)}` };
}

// Reply text like "1.1", "1.2 4.3", "10.6 🔥"
async function applyCodes(S, text) {
    const toks = String(text).trim().split(/[\s,;]+/).filter(Boolean);
    const changes = [], errors = [];
    let found = false;
    for (let i = 0; i < toks.length; i++) {
        const mm = /^(\d{1,2})\.(\d{1,2})$/.exec(toks[i]);
        if (!mm) continue;
        found = true;
        const sec = SECTIONS.find((s) => s.n === Number(mm[1]));
        const opt = sec && sec.options[Number(mm[2]) - 1];
        if (!opt) { errors.push(`❌ ${toks[i]} — වැරදි අංකයක්`); continue; }
        let extra;
        if (opt.custom) { extra = toks[i + 1]; i++; }
        const r = await applyOption(S, sec, opt, extra);
        (r.ok ? changes : errors).push(r.msg);
    }
    return { found, changes, errors };
}

// Command style: ".antidelete on", ".mode private", ".streact 🔥"
async function applyWord(S, sec, arg) {
    const a = String(arg).trim().toLowerCase();
    const opt = sec.options.find((o) => !o.custom && (o.words || []).includes(a)) ||
        sec.options.find((o) => !o.custom && typeof o.v === 'string' && o.v === a);
    if (opt) return applyOption(S, sec, opt);
    const custom = sec.options.find((o) => o.custom);
    if (custom) return applyOption(S, sec, custom, String(arg).trim());
    const valid = sec.options.flatMap((o) => o.words || []).filter((w, i, arr) => arr.indexOf(w) === i);
    return { ok: false, msg: `❌ වැරදි අගයක්. භාවිතා කරන්න: ${valid.join(' / ')}` };
}

module.exports = { SECTIONS, buildPanel, applyCodes, applyWord };
