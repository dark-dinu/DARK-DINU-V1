const mongoose = require('mongoose');
const { proto, initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');

const AuthSchema = new mongoose.Schema({
    _id: { type: String, required: true },
    data: { type: String, required: true }
}, { versionKey: false });

const Session = mongoose.models.Session || mongoose.model('Session', AuthSchema);

// ───────────── Batched background writer ─────────────
// Every Baileys key update used to fire its own Mongo query (hundreds when a
// group message is sent). Now they are queued and written in ONE bulkWrite.
const pending = new Map(); // id -> string (value) | null (delete)
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

    const ops = batch.map(([id, val]) =>
        val === null
            ? { deleteOne: { filter: { _id: id } } }
            : { updateOne: { filter: { _id: id }, update: { $set: { data: val } }, upsert: true } }
    );

    flushing = Session.bulkWrite(ops, { ordered: false })
        .catch((err) => {
            console.error('[AUTH FLUSH ERROR]:', err.message);
            // put back anything that has not been overwritten meanwhile, retry later
            for (const [id, val] of batch) if (!pending.has(id)) pending.set(id, val);
            scheduleFlush();
        })
        .finally(() => { flushing = null; });

    await flushing;
}

// Make sure nothing is lost when the host stops / restarts the process
for (const sig of ['SIGTERM', 'SIGINT']) {
    process.once(sig, async () => {
        try { await flushNow(); } catch (e) {}
        process.exit(0);
    });
}

const useMongoDBAuthState = async () => {
    // Make sure the previous socket's writes are in Mongo before we reload
    await flushNow().catch(() => {});

    // ⚡ RAM cache - the single source of truth while the bot runs
    const memory = new Map();
    let warmed = false;

    try {
        const existingDocs = await Session.find({}).lean();
        for (const doc of existingDocs) memory.set(doc._id, doc.data);
        warmed = true;
    } catch (err) {
        console.error('[AUTH WARMUP ERROR]:', err.message);
    }

    const writeData = (data, id) => {
        try {
            const val = JSON.stringify(data, BufferJSON.replacer);
            memory.set(id, val);       // instant
            pending.set(id, val);      // background batch
            scheduleFlush();
        } catch (e) {}
    };

    const readData = async (id) => {
        try {
            if (memory.has(id)) return JSON.parse(memory.get(id), BufferJSON.reviver);

            // IMPORTANT: once RAM is warmed, a missing key really doesn't exist.
            // The old code asked Atlas for every missing key (seconds of delay per
            // first message / new group member). Now it returns instantly.
            if (warmed) return null;

            const doc = await Session.findById(id).lean();
            if (!doc) return null;
            memory.set(id, doc.data);
            return JSON.parse(doc.data, BufferJSON.reviver);
        } catch {
            return null;
        }
    };

    const removeData = (id) => {
        memory.delete(id);
        pending.set(id, null);
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

module.exports = { useMongoDBAuthState, flushNow };
