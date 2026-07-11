const test = require('node:test');
const assert = require('node:assert/strict');

const { cancelActiveItem } = require('../agents/tools/cancellation');
const { deterministicBotReply } = require('../agents/workflows/schedulingGraph');

test('cancellation returns terminal DB accounting including skipped stale matches', async () => {
    const result = await cancelActiveItem({
        decision: {
            cancellation: {
                toolCalls: [
                    { name: 'cancelMeetings', arguments: { query: null, limit: null } },
                    { name: 'cancelReminders', arguments: { query: null, limit: null } },
                ],
            },
        },
        chat: { id: { _serialized: 'chat-1' } },
        messageStore: {
            async findActiveItems({ kind }) {
                if (kind === 'meeting') {
                    return [{
                        type: 'meeting',
                        item: { _id: '000000000000000000aaa111', title: 'System design' },
                    }];
                }
                return [{
                    type: 'reminder',
                    item: { _id: '000000000000000000bbb222', text: 'Check reminders' },
                }];
            },
            async markActiveItemsCancelled({ meetingIds, reminderIds }) {
                assert.equal(meetingIds.length, 1);
                assert.equal(reminderIds.length, 1);
                return {
                    meetings: 1,
                    reminders: 0,
                    requestedMeetings: 1,
                    requestedReminders: 1,
                    skippedMeetings: 0,
                    skippedReminders: 1,
                    terminalStatus: 'cancelled',
                    cancelledAt: new Date('2026-07-10T20:00:00.000Z'),
                };
            },
        },
    });

    assert.equal(result.status, 'cancelled');
    assert.equal(result.meetings, 1);
    assert.equal(result.reminders, 0);
    assert.equal(result.requestedReminders, 1);
    assert.equal(result.skippedReminders, 1);
    assert.equal(result.terminalStatus, 'cancelled');
});

test('cancel reply tells the user when some matched records were already inactive', () => {
    const reply = deterministicBotReply({
        input: { message: { body: '@bot cancel all meetings and reminders' } },
        plan: {},
        decision: { intent: 'cancel' },
        actionResult: {
            status: 'cancelled',
            type: 'cancellation',
            meetings: 1,
            reminders: 0,
            skippedMeetings: 0,
            skippedReminders: 1,
        },
    });

    assert.match(reply, /Cancelled 1 sessions and 0 reminders/);
    assert.match(reply, /already inactive/);
});
