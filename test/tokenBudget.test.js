const test = require('node:test');
const assert = require('node:assert/strict');

const { compactContext } = require('../utils/tokenBudget');
const { plannerPayload } = require('../agents/workflows/schedulingGraph');

function fixtureContext() {
    return {
        activeCounts: {
            meetings: 2,
            reminders: 1,
            total: 3,
        },
        messages: [
            {
                timestamp: '2026-07-08T18:00:00.000Z',
                senderName: 'Mina',
                body: 'Let us use the poll result.',
                type: 'chat',
                isFromMe: false,
            },
            {
                timestamp: '2026-07-08T18:01:00.000Z',
                senderName: 'Charon',
                body: 'Which timezone should I use?',
                type: 'chat',
                isFromMe: true,
            },
        ],
        polls: [
            {
                pollName: 'Pick a topic',
                updatedAt: '2026-07-08T17:59:00.000Z',
                options: [{ name: 'Queues' }, { name: 'Caching' }],
                votes: [
                    { selectedOptions: ['Queues'] },
                    { selectedOptions: ['Caching'] },
                ],
            },
        ],
        meetings: [
            {
                _id: '000000000000000000abc123',
                title: 'Nearest active session',
                start: '2026-07-09T18:00:00.000Z',
                end: '2026-07-09T21:00:00.000Z',
                timezone: 'America/Phoenix',
                status: 'scheduled',
                meetLink: 'https://meet.google.com/real-link',
                createdAt: '2026-06-01T00:00:00.000Z',
                updatedAt: '2026-07-01T00:00:00.000Z',
            },
            {
                _id: '000000000000000000def456',
                title: 'Cancelled newer record',
                start: '2026-07-10T18:00:00.000Z',
                timezone: 'America/Phoenix',
                status: 'cancelled',
                createdAt: '2026-07-08T00:00:00.000Z',
                updatedAt: '2026-07-08T00:00:00.000Z',
            },
        ],
        reminders: [
            {
                _id: '000000000000000000fed321',
                text: 'Send the notes',
                dueAt: '2026-07-09T17:00:00.000Z',
                timezone: 'America/Phoenix',
                status: 'pending',
                createdAt: '2026-07-01T00:00:00.000Z',
                updatedAt: '2026-07-01T00:00:00.000Z',
            },
        ],
    };
}

test('compact context exposes authoritative reference signals and poll ties', () => {
    const compacted = compactContext(fixtureContext(), {
        maxTokens: 2000,
        maxMessages: 10,
        maxPolls: 3,
        maxMeetings: 10,
        maxReminders: 10,
    });
    const context = JSON.parse(compacted.json);

    assert.deepEqual(context.signals.activeCounts, {
        meetings: 2,
        reminders: 1,
        total: 3,
    });
    assert.equal(context.signals.nextMeeting.id, 'abc123');
    assert.equal(context.signals.nextReminder.id, 'fed321');
    assert.equal(context.signals.latestHuman.from, 'Mina');
    assert.equal(context.signals.latestBot.msg, 'Which timezone should I use?');
    assert.equal(context.signals.latestPoll.tied, true);
    assert.deepEqual(
        context.signals.latestPoll.leaders.map((leader) => leader.opt),
        ['Queues', 'Caching'],
    );
});

test('compact context sheds detail to remain within a practical token budget', () => {
    const context = fixtureContext();
    context.messages = Array.from({ length: 40 }, (_, index) => ({
        timestamp: `2026-07-08T18:${String(index).padStart(2, '0')}:00.000Z`,
        senderName: `Member ${index}`,
        body: `Message ${index} ${'context '.repeat(80)}`,
        type: 'chat',
        isFromMe: false,
    }));

    const compacted = compactContext(context, {
        maxTokens: 1200,
        maxMessages: 30,
        minMessages: 3,
        maxTextChars: 220,
        maxPolls: 3,
        maxMeetings: 10,
        maxReminders: 10,
    });

    assert.ok(compacted.estimatedTokens <= 1200);
    assert.ok(JSON.parse(compacted.json).msgs.length < 30);
});

test('planner payload trims room context against the total request budget', () => {
    const context = fixtureContext();
    context.messages = Array.from({ length: 80 }, (_, index) => ({
        messageId: `message-${index}`,
        timestamp: new Date(Date.UTC(2026, 6, 8, 18, index)).toISOString(),
        senderName: `Member ${index % 4}`,
        body: `Message ${index} ${'large room discussion '.repeat(50)}`,
        type: 'chat',
        isFromMe: false,
    }));
    const input = {
        timezone: 'America/Phoenix',
        chat: {
            id: { _serialized: 'test-group' },
            name: 'Test',
        },
        message: {
            id: { _serialized: 'current-message' },
            body: 'remind me in 10 minutes',
            _data: { body: 'remind me in 10 minutes' },
        },
        storedMessage: { senderName: 'Mina' },
    };

    const normal = plannerPayload({
        input,
        context,
        inputTokenBudget: 2000,
        lean: true,
    });
    const lean = plannerPayload({
        input,
        context,
        inputTokenBudget: 1900,
        lean: true,
    });

    assert.ok(normal.estimatedTokens <= 2000);
    assert.ok(lean.estimatedTokens <= 1900);
    assert.ok(lean.estimatedTokens < normal.estimatedTokens);
    assert.equal(JSON.parse(normal.payload).msg, 'remind me in 10 minutes');
});
