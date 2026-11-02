const mongoose = require('mongoose');
const { proto, initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');

const AuthSchema = new mongoose.Schema({
    _id: { type: String, required: true },
    data: { type: String, required: true }
}, { versionKey: false });

const Session = mongoose.model('Session', AuthSchema);

const useMongoDBAuthState = async () => {
    const memoryStore = new Map();

    const writeData = async (data, id) => {
        const serialized = JSON.stringify(data, BufferJSON.replacer);
        memoryStore.set(id, serialized);
        await Session.findByIdAndUpdate(id, { data: serialized }, { upsert: true });
    };

    const readData = async (id) => {
        try {
            if (memoryStore.has(id)) {
                return JSON.parse(memoryStore.get(id), BufferJSON.reviver);
            }
            const doc = await Session.findById(id);
            if (!doc) return null;
            memoryStore.set(id, doc.data);
            return JSON.parse(doc.data, BufferJSON.reviver);
        } catch {
            return null;
        }
    };

    const removeData = async (id) => {
        memoryStore.delete(id);
        await Session.findByIdAndDelete(id).catch(() => {});
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
