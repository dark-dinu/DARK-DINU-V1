const mongoose = require('mongoose');
const { proto, initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');

const AuthSchema = new mongoose.Schema({
    _id: { type: String, required: true },
    data: { type: String, required: true }
}, { versionKey: false });

const Session = mongoose.models.Session || mongoose.model('Session', AuthSchema);

const useMongoDBAuthState = async () => {
    const memory = new Map();

    const writeData = async (data, id) => {
        try {
            const val = JSON.stringify(data, BufferJSON.replacer);
            memory.set(id, val);
            await Session.findByIdAndUpdate(id, { data: val }, { upsert: true });
        } catch (e) {}
    };

    const readData = async (id) => {
        try {
            if (memory.has(id)) return JSON.parse(memory.get(id), BufferJSON.reviver);
            const doc = await Session.findById(id);
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
            await Session.findByIdAndDelete(id);
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
