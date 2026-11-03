const mongoose = require('mongoose');
const { proto, initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');

const AuthSchema = new mongoose.Schema({
    _id: { type: String, required: true },
    sessionId: { type: String, index: true },
    data: { type: String, required: true }
}, { versionKey: false });

const Session = mongoose.models.Session || mongoose.model('Session', AuthSchema);

// ───────────── Batched Background Writer ─────────────
const pending = new Map();
let flushTimer = null;
let flushing = null;

function scheduleFlush() {
    if (pending.size >= 300) return void flushNow();
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
        flushTimer = null;
        flushNow();
    }, 1000);
}

async function flushNow() {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (flushing) await flushing;
    if (!pending.size) return;

    const batch = Array.from(pending.entries());
    pending.clear();

    const ops = batch.map(([id, item]) =>
        item.val === null
            ? { deleteOne: { filter: { _id: id } } }
            : {
                  updateOne: {
                      filter: { _id: id },
                      update: { 
                          $set: { 
                              data: item.val, 
                              ...(item.sessionId ? { sessionId: item.sessionId } : {}) 
                          } 
                      },
                      upsert: true
                  }
              }
    );

    flushing = Session.bulkWrite(ops, { ordered: false })
        .catch((err) => {
            console.error('[AUTH FLUSH ERROR]:', err.message);
            for (const [id, item] of batch) {
                if (!pending.has(id)) pending.set(id, item);
            }
            scheduleFlush();
        })
        .finally(() => { flushing = null; });

    await flushing;
}

for (const sig of ['SIGTERM', 'SIGINT']) {
    process.once(sig, async () => {
        try { await flushNow(); } catch (e) {}
        process.exit(0);
    });
}

/**
 * Universal Multi-Session + Legacy Auth State Engine
 */
const useMongoDBAuthState = async (sessionId = 'default') => {
    await flushNow().catch(() => {});

    const memory = new Map();
    let warmed = false;
    const isLegacy = (sessionId === 'legacy');

    try {
        const query = isLegacy 
            ? { $or: [{ sessionId: 'legacy' }, { sessionId: { $exists: false } }] } 
            : { sessionId };

        const existingDocs = await Session.find(query).lean();
        for (const doc of existingDocs) {
            const localId = isLegacy ? doc._id : doc._id.replace(`${sessionId}_`, '');
            memory.set(localId, doc.data);
        }
        warmed = true;
    } catch (err) {
        console.error(`[AUTH WARMUP ERROR - ${sessionId}]:`, err.message);
    }

    const writeData = (data, id) => {
        try {
            const val = JSON.stringify(data, BufferJSON.replacer);
            memory.set(id, val);
            const globalId = isLegacy ? id : `${sessionId}_${id}`;
            pending.set(globalId, { sessionId: isLegacy ? 'legacy' : sessionId, val });
            scheduleFlush();
        } catch (e) {}
    };

    const readData = async (id) => {
        try {
            if (memory.has(id)) return JSON.parse(memory.get(id), BufferJSON.reviver);
            if (warmed) return null;

            const globalId = isLegacy ? id : `${sessionId}_${id}`;
            const doc = await Session.findById(globalId).lean();
            if (!doc) return null;
            memory.set(id, doc.data);
            return JSON.parse(doc.data, BufferJSON.reviver);
        } catch {
            return null;
        }
    };

    const removeData = (id) => {
        memory.delete(id);
        const globalId = isLegacy ? id : `${sessionId}_${id}`;
        pending.set(globalId, { sessionId: isLegacy ? 'legacy' : sessionId, val: null });
        scheduleFlush();
    };

    const creds = (await readData('creds')) || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(
                        ids.map(async (id) => {
                            let value = await readData(`${type}-${id}`);
                            if (type === 'app-state-sync-key' && value) {
                                value = proto.Message.AppStateSyncKeyData.fromObject(value);
                            }
                            data[id] = value;
                        })
                    );
                    return data;
                },
                set: async (data) => {
                    for (const category in data) {
                        for (const id in data[category]) {
                            const val = data[category][id];
                            const name = `${category}-${id}`;
                            if (val) writeData(val, name);
                            else removeData(name);
                        }
                    }
                }
            }
        },
        saveCreds: async () => writeData(creds, 'creds')
    };
};

/**
 * Scan All Active Registered Sessions
 */
async function getAllRegisteredSessions() {
    try {
        const sessionIds = [];

        // Check for legacy single-session
        const legacyCredDoc = await Session.findById('creds').lean();
        if (legacyCredDoc) {
            try {
                const creds = JSON.parse(legacyCredDoc.data, BufferJSON.reviver);
                if (creds && creds.registered) {
                    sessionIds.push('legacy');
                }
            } catch (e) {}
        }

        // Check for multi-tenant sessions
        const multiCredDocs = await Session.find({ _id: { $regex: /_creds$/ } }).lean();
        for (const doc of multiCredDocs) {
            try {
                const creds = JSON.parse(doc.data, BufferJSON.reviver);
                if (creds && creds.registered && doc.sessionId) {
                    sessionIds.push(doc.sessionId);
                }
            } catch (e) {}
        }

        return [...new Set(sessionIds)];
    } catch (e) {
        return [];
    }
}

/**
 * Delete session cleanly
 */
async function deleteSession(sessionId) {
    await flushNow().catch(() => {});
    if (sessionId === 'legacy') {
        await Session.deleteMany({ $or: [{ sessionId: 'legacy' }, { sessionId: { $exists: false } }] });
    } else {
        await Session.deleteMany({ sessionId });
    }
}

module.exports = {
    useMongoDBAuthState,
    getAllRegisteredSessions,
    deleteSession,
    flushNow
};
