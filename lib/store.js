// Tiny per-session message cache (used by anti-delete and Baileys getMessage retry)
const config = require('../config');
const stores = new Map();

function bucket(sid) {
    let b = stores.get(sid);
    if (!b) { b = new Map(); stores.set(sid, b); }
    return b;
}

function put(sid, raw) {
    if (!raw?.key?.id || !raw.message) return;
    const b = bucket(sid);
    b.set(raw.key.id, {
        key: raw.key,
        message: raw.message,
        messageTimestamp: raw.messageTimestamp,
        pushName: raw.pushName
    });
    while (b.size > config.CACHE_MESSAGES) b.delete(b.keys().next().value);
}

const find = (sid, id) => stores.get(sid)?.get(id);
const remove = (sid, id) => stores.get(sid)?.delete(id);
const clear = (sid) => stores.delete(sid);

module.exports = { put, find, remove, clear };
