const { google } = require('googleapis');
const { settings } = require('../config/settings');
const { getGoogleOauthRefreshToken } = require('./oauthTokenStore');

const MEET_CREATE_SPACE_URL = 'https://meet.googleapis.com/v2/spaces';
const MEET_SPACE_SCOPE = 'https://www.googleapis.com/auth/meetings.space.created';

function meetErrorReason(error) {
    return error?.response?.data?.error?.message
        || error?.errors?.[0]?.message
        || error?.message
        || 'Google Meet request failed.';
}

async function createMeetAuth() {
    const refreshToken = await getGoogleOauthRefreshToken();
    if (settings.meet.oauthClientId && settings.meet.oauthClientSecret && refreshToken) {
        const auth = new google.auth.OAuth2(settings.meet.oauthClientId, settings.meet.oauthClientSecret);
        auth.setCredentials({ refresh_token: refreshToken });
        return auth;
    }

    return null;
}

async function createGoogleMeetSpace() {
    if (settings.meet.staticLink) {
        return {
            created: true,
            meetLink: settings.meet.staticLink,
            meetingCode: '',
            spaceName: 'static',
            reason: '',
        };
    }

    const auth = await createMeetAuth();
    if (!auth) {
        return {
            created: false,
            reason: 'Set GOOGLE_MEET_LINK, or configure Google OAuth client id/secret/refresh token.',
        };
    }

    try {
        const response = await auth.request({
            method: 'POST',
            url: MEET_CREATE_SPACE_URL,
            data: {
                config: {
                    accessType: settings.meet.accessType,
                    entryPointAccess: settings.meet.entryPointAccess,
                },
            },
        });

        return {
            created: Boolean(response.data?.meetingUri),
            meetLink: response.data?.meetingUri || '',
            meetingCode: response.data?.meetingCode || '',
            spaceName: response.data?.name || '',
            reason: response.data?.meetingUri ? '' : 'Google Meet did not return a meeting URI.',
        };
    } catch (error) {
        return {
            created: false,
            reason: friendlyMeetErrorReason(error),
        };
    }
}

function friendlyMeetErrorReason(error) {
    const reason = meetErrorReason(error);
    if (/invalid_grant/i.test(reason) && settings.meet.oauthClientId) {
        return 'Google OAuth refresh token was rejected. Run npm run google:auth again so Charon can save a fresh token.';
    }

    return reason;
}

module.exports = { createGoogleMeetSpace };
