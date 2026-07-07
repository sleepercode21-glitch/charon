const crypto = require('crypto');
const http = require('http');
const dotenv = require('dotenv');
const { google } = require('googleapis');
const mongoose = require('mongoose');

dotenv.config();

const { settings } = require('../config/settings');
const { saveGoogleOauthRefreshToken } = require('../providers/oauthTokenStore');

const MEET_SCOPE = 'https://www.googleapis.com/auth/meetings.space.created';
const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;

if (!(clientId && clientSecret)) {
    console.error('Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in .env first.');
    process.exit(1);
}

let oauth2;
let expectedState;

function finish(server, code = 0) {
    server.close(() => process.exit(code));
    setTimeout(() => process.exit(code), 1000).unref();
}

async function saveRefreshToken(refreshToken) {
    if (!settings.mongodbUri) {
        console.log('\nMONGODB_URI is missing. Add this to .env manually:\n');
        console.log(`GOOGLE_OAUTH_REFRESH_TOKEN=${refreshToken}\n`);
        return;
    }

    const shouldDisconnect = mongoose.connection.readyState === 0;
    if (shouldDisconnect) await mongoose.connect(settings.mongodbUri);

    await saveGoogleOauthRefreshToken({
        refreshToken,
        clientId,
        scope: MEET_SCOPE,
    });

    if (shouldDisconnect) await mongoose.disconnect();
    console.log('\nSaved Google OAuth refresh token in MongoDB.');
}

async function handleCallback(req, res, server) {
    const callbackUrl = new URL(req.url, oauth2.redirectUri);

    if (callbackUrl.pathname !== '/') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found.');
        return;
    }

    if (callbackUrl.searchParams.get('state') !== expectedState) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('OAuth state mismatch.');
        finish(server, 1);
        return;
    }

    const googleError = callbackUrl.searchParams.get('error');
    if (googleError) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end(`Google rejected the request: ${googleError}`);
        console.error(`Google rejected the request: ${googleError}`);
        finish(server, 1);
        return;
    }

    const code = callbackUrl.searchParams.get('code');
    if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Missing OAuth code.');
        return;
    }

    try {
        const { tokens } = await oauth2.getToken(code);

        if (!tokens.refresh_token) {
            console.error('No refresh token returned. Revoke app access in your Google Account, then run this again.');
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('No refresh token returned. Check the terminal.');
            finish(server, 1);
            return;
        }

        try {
            await saveRefreshToken(tokens.refresh_token);
        } catch (saveError) {
            console.error(`Could not save token in MongoDB: ${saveError.message || saveError}`);
            console.log('\nAdd this to .env manually:\n');
            console.log(`GOOGLE_OAUTH_REFRESH_TOKEN=${tokens.refresh_token}\n`);
        }

        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Charon saved the token. You can close this tab.');
        finish(server, 0);
    } catch (error) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('OAuth failed. Check the terminal.');
        console.error(error.message || error);
        finish(server, 1);
    }
}

const server = http.createServer((req, res) => {
    handleCallback(req, res, server).catch((error) => {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('OAuth failed. Check the terminal.');
        console.error(error.message || error);
        finish(server, 1);
    });
});

server.setTimeout(10 * 60 * 1000, () => {
    console.error('OAuth timed out. If the browser showed redirect_uri_mismatch, create a Desktop app OAuth client and put that id/secret in .env.');
    finish(server, 1);
});

server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    const redirectUri = `http://127.0.0.1:${port}`;
    expectedState = crypto.randomBytes(16).toString('hex');
    oauth2 = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

    const authUrl = oauth2.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: [MEET_SCOPE],
        state: expectedState,
    });

    console.log('\nUse a Google OAuth client type: Desktop app');
    console.log(`Local callback: ${redirectUri}`);
    console.log('\nOpen this URL, approve Google Meet access, then come back here:\n');
    console.log(authUrl);
});
