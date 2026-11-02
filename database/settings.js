const mongoose = require('mongoose');
const config = require('../config');

const SettingsSchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true },
    value: { type: mongoose.Schema.Types.Mixed, required: true }
});

const SettingModel = mongoose.model('BotSetting', SettingsSchema);
const localCache = new Map();

module.exports = {
    initSettings: async () => {
        const all = await SettingModel.find({});
        for (const item of all) {
            localCache.set(item.key, item.value);
        }
        if (!localCache.has('prefix')) localCache.set('prefix', config.DEFAULT_PREFIX);
        if (!localCache.has('mode')) localCache.set('mode', config.WORK_TYPE);
        if (!localCache.has('antiDelete')) localCache.set('antiDelete', 'off');
    },
    get: (key) => localCache.get(key),
    set: async (key, value) => {
        localCache.set(key, value);
        await SettingModel.findOneAndUpdate({ key }, { value }, { upsert: true });
    }
};
