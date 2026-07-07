const mongoose = require('mongoose');
const { settings } = require('../config/settings');

const GOOGLE_REFRESH_TOKEN_KEY = 'google.oauth.refreshToken';

function appSecretModel() {
    return mongoose.models.AppSecret || mongoose.model('AppSecret', new mongoose.Schema({
        key: { type: String, unique: true, index: true },
        value: String,
        meta: mongoose.Schema.Types.Mixed,
    }, { timestamps: true }));
}

function mongoReady() {
    return mongoose.connection.readyState === 1;
}

async function getGoogleOauthRefreshToken() {
    if (settings.meet.oauthRefreshToken) return settings.meet.oauthRefreshToken;
    if (!mongoReady()) return '';

    const secret = await appSecretModel().findOne({ key: GOOGLE_REFRESH_TOKEN_KEY }).lean();
    return secret?.value || '';
}

async function saveGoogleOauthRefreshToken({ refreshToken, clientId, scope }) {
    if (!refreshToken) throw new Error('Missing Google OAuth refresh token.');

    return appSecretModel().findOneAndUpdate(
        { key: GOOGLE_REFRESH_TOKEN_KEY },
        {
            key: GOOGLE_REFRESH_TOKEN_KEY,
            value: refreshToken,
            meta: {
                clientId,
                scope,
                savedAt: new Date(),
            },
        },
        { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
    );
}

module.exports = {
    getGoogleOauthRefreshToken,
    saveGoogleOauthRefreshToken,
};
