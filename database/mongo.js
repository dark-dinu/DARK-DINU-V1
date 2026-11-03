const mongoose = require('mongoose');
const { proto, initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');

const AuthSchema = new mongoose.Schema({
    _id: { type: String, required: true },
    data: { type: String, required: true }
}, { versionKey: false });

const Session = mongoose.models.Session || mongoose.model('Session', AuthSchema);

const useMongoDBAuthState = async () => {
    // ⚡ Ultra-fast RAM Memory Cache
    const memory = new Map();

    // 1. Warm-up Phase: Start වෙද්දීම Session keys සියල්ල RAM එකට load කර ගැනීම
    try {
        const existingDocs = await Session.find({}).lean();
        for (const doc of existingDocs) {
            memory.set(doc._id, doc.data);
        }
    } catch (err) {
        console.error('[AUTH WARMUP ERROR]:', err.message);
    }

    // 2. Non-blocking Async Database Writer
    const writeData = async (data, id) => {
        try {
            const val = JSON.stringify(data, BufferJSON.replacer);
            // පළමුව ක්ෂණිකව Memory එක update කරයි (Instant Response)
            memory.set(id, val);

            // Database එකට background එකෙන් asynchronous update වේ
            Session.findByIdAndUpdate(id, { data: val }, { upsert: true }).catch(() => {});
        } catch (e) {}
    };

    // 3. 100% In-Memory Direct Reader (Mongo queries නැත)
    const readData = async (id) => {
        try {
            if (memory.has(id)) {
                return JSON.parse(memory.get(id), BufferJSON.reviver);
            }
            const doc = await Session.findById(id).lean();
            if (!doc) return null;
            memory.set(id, doc.data);
            return JSON.parse(doc.data, BufferJSON.reviver);
        } catch {
            return null;
        }
    };

    const removeData = async (id) => {
        try {
            memory.delete(id);
            Session.findByIdAndDelete(id).catch(() => {});
        } catch {}
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
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const val = data[category][id];
                            const name = `${category}-${id}`;
                            tasks.push(val ? writeData(val, name) : removeData(name));
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => writeData(creds, 'creds')
    };
};

module.exports = { useMongoDBAuthState };
