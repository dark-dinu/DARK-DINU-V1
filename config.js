require('dotenv').config();

module.exports = {
    BOT_NAME: 'DARK DINU V1',
    OWNER_NAME: 'Heshan',
    OWNER_NUMBER: '94719845166',
    DEV_LID: '15947733680169@lid',
    MONGODB_URI: process.env.MONGODB_URI || 'mongodb+srv://diniduheshan40_db_user:Heshan2007@cluster0.5gazebm.mongodb.net/?appName=Cluster0',
    DEFAULT_PREFIX: '.',
    WORK_TYPE: process.env.WORK_TYPE || 'public' // 'public' or 'private'
};
