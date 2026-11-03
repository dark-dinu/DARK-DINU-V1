const mongoose = require('mongoose');
const { proto, initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');

const AuthSchema = new mongoose.Schema({
    _id: { type: String, required: true },
    sessionId: { type: String, required: true, index: true },
    data: { type: String, required: true }
}, { versionKey: false });

const Session = mongoose.models.Session || mongoose.model('Session', AuthSchema);

// ───────────── Batched Background Writer (Per-Session Safe) ─────────────
const pending = new Map(); // id -> { sessionId, val }
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
                      update: { $set: { data: item.val, sessionId: item.sessionId } },
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

// Graceful host shutdown
for (const sig of ['SIGTERM', 'SIGINT']) {
    process.once(sig, async () => {
        try { await flushNow(); } catch (e) {}
        process.exit(0);
    });
}

/**
 * Multi-Session Isolated Auth State
 * @param {string} sessionId - Phone number or unique session key
 */
const useMongoDBAuthState = async (sessionId = 'default') => {
    await flushNow().catch(() => {});

    // In-memory RAM cache for this specific session
    const memory = new Map();
    let warmed = false;

    try {
        const existingDocs = await Session.find({ sessionId }).lean();
        for (const doc of existingDocs) {
            // Strip session prefix for clean in-memory key access
            const localId = doc._id.replace(`${sessionId}_`, '');
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
            const globalId = `${sessionId}_${id}`;
            pending.set(globalId, { sessionId, val });
            scheduleFlush();
        } catch (e) {}
    };

    const readData = async (id) => {
        try {
            if (memory.has(id)) return JSON.parse(memory.get(id), BufferJSON.reviver);
            if (warmed) return null;

            const globalId = `${sessionId}_${id}`;
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
        const globalId = `${sessionId}_${id}`;
        pending.set(globalId, { sessionId, val: null });
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
 * Get all active registered session IDs from MongoDB
 */
async function getAllRegisteredSessions() {
    try {
        const credDocs = await Session.find({ _id: { $regex: /_creds$/ } }).lean();
        const sessionIds = [];
        for (const doc of credDocs) {
            try {
                const creds = JSON.parse(doc.data, BufferJSON.reviver);
                if (creds && creds.registered) {
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
 * Delete a specific session
 */
async function deleteSession(sessionId) {
    await flushNow().catch(() => {});
    await Session.deleteMany({ sessionId });
}

module.exports = {
    useMongoDBAuthState,
    getAllRegisteredSessions,
    deleteSession,
    flushNow
};
