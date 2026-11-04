const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
const config = require('../config');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// '9477xxxx:12@s.whatsapp.net' -> '9477xxxx'
const jidNum = (jid) => String(jid || '').split('@')[0].split(':')[0];
// '9477xxxx:12@s.whatsapp.net' -> '9477xxxx@s.whatsapp.net'
const normJid = (jid) => {
    if (!jid) return jid;
    const [u, d] = String(jid).split('@');
    return u.split(':')[0] + '@' + d;
};

// ───────────── message unwrapping ─────────────
const WRAPPERS = [
    'ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2',
    'viewOnceMessageV2Extension', 'documentWithCaptionMessage'
];
const SKIP_KEYS = new Set(['messageContextInfo', 'senderKeyDistributionMessage', 'messageSecret']);

function unwrap(message) {
    let content = message;
    let viewOnce = false;
    for (let i = 0; i < 6 && content; i++) {
        let hit = false;
        for (const w of WRAPPERS) {
            if (content[w] && content[w].message) {
                if (w.startsWith('viewOnce')) viewOnce = true;
                content = content[w].message;
                hit = true;
                break;
            }
        }
        if (!hit && content.editedMessage && content.editedMessage.message) {
            content = content.editedMessage.message;
            hit = true;
        }
        if (!hit) break;
    }
    return { content, viewOnce };
}

// NOTE: senderKeyDistributionMessage is usually the FIRST key in group messages,
// so we must skip it (the old handler didn't -> group commands never worked).
function contentType(content) {
    if (!content) return null;
    return Object.keys(content).find(
        (k) => !SKIP_KEYS.has(k) && (k === 'conversation' || k.includes('Message'))
    ) || null;
}

function bodyOf(content) {
    if (!content) return '';
    return content.conversation ||
        content.extendedTextMessage?.text ||
        content.imageMessage?.caption ||
        content.videoMessage?.caption ||
        content.documentMessage?.caption ||
        content.buttonsResponseMessage?.selectedButtonId ||
        content.templateButtonReplyMessage?.selectedId ||
        content.listResponseMessage?.singleSelectReply?.selectedRowId ||
        '';
}

const MEDIA = {
    imageMessage: 'image', videoMessage: 'video', audioMessage: 'audio',
    stickerMessage: 'sticker', documentMessage: 'document', ptvMessage: 'video'
};

async function downloadBuffer(msg, kind) {
    try {
        const stream = await downloadContentFromMessage(msg, kind);
        const chunks = [];
        for await (const c of stream) chunks.push(c);
        const buf = Buffer.concat(chunks);
        return buf.length ? buf : null;
    } catch (e) {
        console.error('[DOWNLOAD ERROR]:', e.message);
        return null;
    }
}

// Build the right sendMessage payload for a media buffer
function mediaPayload(kind, buffer, msg = {}, caption = '', mentions) {
    const extra = mentions && mentions.length ? { mentions } : {};
    switch (kind) {
        case 'image': return { image: buffer, caption, ...extra };
        case 'video': return { video: buffer, caption, mimetype: msg.mimetype || 'video/mp4', ...extra };
        case 'audio': return { audio: buffer, mimetype: msg.mimetype || 'audio/mp4', ptt: !!msg.ptt };
        case 'sticker': return { sticker: buffer };
        case 'document': return {
            document: buffer, mimetype: msg.mimetype || 'application/octet-stream',
            fileName: msg.fileName || 'file', caption, ...extra
        };
        default: return { text: caption || 'Unsupported media' };
    }
}

// ───────────── keyword matching (status save) ─────────────
const collapse = (s) => s.replace(/(.)\1+/gu, '$1');
function norm(s) {
    return collapse(
        String(s || '').toLowerCase().normalize('NFC')
            .replace(/[\u200b-\u200f\u202a-\u202e\ufeff]/g, '')
            .replace(/\s+/g, ' ').trim()
    );
}
const tokens = (s) => norm(s).split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean);

function makeMatcher(list) {
    const prepared = list.map(norm).filter(Boolean);
    const singles = new Set(prepared.filter((k) => !k.includes(' ')));
    const phrases = prepared.filter((k) => k.includes(' '));
    return (text) => {
        if (!text || text.length > 80) return false;
        if (tokens(text).some((t) => singles.has(t))) return true;
        const t = norm(text);
        return phrases.some((p) => t.includes(p));
    };
}

// ───────────── misc helpers ─────────────
function getTargets(m, args = []) {
    const list = [...(m.mentionedJid || [])];
    if (!list.length && m.quoted?.sender) list.push(m.quoted.sender);
    for (const a of args) {
        const d = String(a).replace(/\D/g, '');
        if (d.length >= 8 && d.length <= 15) list.push(d + '@s.whatsapp.net');
    }
    return [...new Set(list)];
}

function formatUptime(seconds) {
    seconds = Number(seconds);
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const mi = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${d ? d + 'd ' : ''}${h ? h + 'h ' : ''}${mi ? mi + 'm ' : ''}${s}s`;
}

const nowText = () => new Date().toLocaleString('en-GB', { timeZone: config.TIMEZONE });

// Where should alerts (anti-delete / view-once / save) go?
const destJid = (S, m) => (S.cfg.get('sendTo') === 'chat' && m ? m.jid : S.selfJid);

async function chatName(S, jid) {
    if (!jid.endsWith('@g.us')) return 'Inbox';
    try {
        const meta = await S.sock.getGroupMeta(jid);
        return meta?.subject || 'Group';
    } catch (e) { return 'Group'; }
}

module.exports = {
    sleep, jidNum, normJid, unwrap, contentType, bodyOf, MEDIA,
    downloadBuffer, mediaPayload, makeMatcher, getTargets,
    formatUptime, nowText, destJid, chatName
};
