const test = require('node:test');
const assert = require('node:assert/strict');

const { scheduleMeeting } = require('../agents/tools/scheduler');

test('refuses to schedule meetings in the past before creating DB/provider side effects', async () => {
    const originalNow = Date.now;
    Date.now = () => new Date('2026-07-10T20:00:00.000Z').getTime();

    try {
        let duplicateChecked = false;
        let created = false;
        const result = await scheduleMeeting({
            decision: {
                meeting: {
                    title: 'Past design review',
                    start: '2026-07-10T19:00:00.000Z',
                    timezone: 'UTC',
                },
            },
            timeResolution: {
                status: 'resolved',
                start: '2026-07-10T19:00:00.000Z',
                timezone: 'UTC',
            },
            context: {},
            chat: { id: { _serialized: 'chat-1' }, name: 'Test chat' },
            triggerMessage: { body: 'schedule a meeting yesterday', id: 'msg-1' },
            messageStore: {
                async findDuplicateMeeting() {
                    duplicateChecked = true;
                    return null;
                },
                async createMeeting() {
                    created = true;
                    return {};
                },
            },
        });

        assert.equal(result.status, 'failed');
        assert.equal(result.reason, 'past_time');
        assert.equal(duplicateChecked, false);
        assert.equal(created, false);
    } finally {
        Date.now = originalNow;
    }
});
