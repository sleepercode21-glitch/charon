const test = require('node:test');
const assert = require('node:assert/strict');

const { createStandaloneReminder } = require('../agents/tools/reminder');

test('refuses to create reminders in the past before writing to the DB', async () => {
    const originalNow = Date.now;
    Date.now = () => new Date('2026-07-10T20:00:00.000Z').getTime();

    try {
        let created = false;
        const result = await createStandaloneReminder({
            decision: {
                reminder: {
                    text: 'Check the old thing',
                    dueAt: '2026-07-10T19:00:00.000Z',
                    timezone: 'UTC',
                },
            },
            timeResolution: {
                status: 'resolved',
                start: '2026-07-10T19:00:00.000Z',
                timezone: 'UTC',
            },
            chat: { id: { _serialized: 'chat-1' }, name: 'Test chat' },
            triggerMessage: { body: 'remind me yesterday', id: 'msg-1' },
            messageStore: {
                async createStandaloneReminder() {
                    created = true;
                    return {};
                },
            },
        });

        assert.equal(result.status, 'failed');
        assert.equal(result.reason, 'past_time');
        assert.equal(created, false);
    } finally {
        Date.now = originalNow;
    }
});
