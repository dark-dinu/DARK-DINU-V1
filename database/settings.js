// Per-session settings (every linked number has its own panel settings)
const mongoose = require('mongoose');
const config = require('../config');
const DEFAULTS = require('../data/defaults');

const SettingModel = mongoose.models.BotSetting || mongoose.model('BotSetting', new mongoose.Schema({
    key: { type: String, required: true, unique: true },
    value: { type: mongoose.Schema.Types.Mixed, required: true }
}));

const cache = new Map(); // sid -> settings object
const baseDefaults = () => ({ ...DEFAULTS, prefix: config.DEFAULT_PREFIX || '.', mode: config.WORK_TYPE || 'public' });

async function load(sid) {
    if (cache.has(sid)) return cache.get(sid);
    let saved = {};
    try {
        const doc = await SettingModel.findOne({ key: `cfg:${sid}` }).lean();
        if (doc && doc.value) saved = doc.value;
    } catch (e) {
        console.error(`[SETTINGS LOAD ${sid}]:`, e.message);
    }
    const obj = { ...baseDefaults(), ...saved };
    cache.set(sid, obj);
    return obj;
}

async function persist(sid) {
    try {
        await SettingModel.findOneAndUpdate({ key: `cfg:${sid}` }, { value: cache.get(sid) }, { upsert: true });
    } catch (e) {
        console.error(`[SETTINGS SAVE ${sid}]:`, e.message);
    }
}

function forSession(sid) {
    return {
        get: (k) => (cache.get(sid) || baseDefaults())[k],
        set: async (k, v) => {
            if (!cache.has(sid)) cache.set(sid, baseDefaults());
            cache.get(sid)[k] = v;
            await persist(sid);
        },
        all: () => ({ ...(cache.get(sid) || baseDefaults()) })
    };
}

async function remove(sid) {
    cache.delete(sid);
    await SettingModel.deleteOne({ key: `cfg:${sid}` }).catch(() => {});
}

module.exports = { load, forSession, remove };
