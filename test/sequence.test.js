const test = require('node:test');
const assert = require('node:assert/strict');

const {
    executePlanSequence,
    normalizePlanActions,
    resolvePlanReferences,
} = require('../agents/workflows/schedulingGraph');

test('normalizes and bounds ordered action plans', () => {
    const actions = normalizePlanActions({
        actions: [
            { intent: 'cancel', kind: 'meeting', target: 'old session' },
            { intent: 'schedule', title: 'New session' },
            { intent: 'announce', text: 'Join {{previous.meetLink}}' },
        ],
    }, 2);

    assert.equal(actions.length, 2);
    assert.equal(actions[0].intent, 'cancel');
    assert.equal(actions[1].intent, 'schedule');
});

test('has no application-level sequence cap when the configured limit is zero', () => {
    const requested = Array.from({ length: 50 }, (_, index) => ({
        intent: 'announce',
        text: `Announcement ${index + 1}`,
    }));
    const actions = normalizePlanActions({ actions: requested }, 0);

    assert.equal(actions.length, 50);
    assert.equal(actions[49].text, 'Announcement 50');
});

test('resolves previous and numbered step result references', () => {
    const plan = resolvePlanReferences({
        intent: 'announce',
        text: 'Join {{previous.meetLink}} for {{steps.1.title}} [{{steps.1.id}}]',
    }, [{
        result: {
            id: 'a1b2c3',
            title: 'Queues',
            meetLink: 'https://meet.google.com/abc-defg-hij',
        },
    }]);

    assert.equal(
        plan.text,
        'Join https://meet.google.com/abc-defg-hij for Queues [a1b2c3]',
    );
});

test('resolves nested result arrays for cross-tool composition', () => {
    const plan = resolvePlanReferences({
        intent: 'cancel',
        kind: 'meeting',
        target: '{{steps.1.items.0.id}}',
        text: '{{previous.lines.0}}',
    }, [{
        result: {
            lines: ['[a1b2c3] Queues - tomorrow'],
            items: [{ id: 'a1b2c3', type: 'meeting' }],
        },
    }]);

    assert.equal(plan.target, 'a1b2c3');
    assert.equal(plan.text, '[a1b2c3] Queues - tomorrow');
});

test('executes steps in order and passes earlier results into later plans', async () => {
    const seen = [];
    const actions = normalizePlanActions({
        actions: [
            {
                intent: 'schedule',
                title: 'Queues',
                date: '2026-07-10T18:00:00.000Z',
                timezone: 'America/Phoenix',
            },
            {
                intent: 'announce',
                text: 'Join {{previous.meetLink}}',
            },
        ],
    });

    const execution = await executePlanSequence({
        actions,
        body: 'Schedule Queues and announce the link',
        runAction: async (decision, _time, plan) => {
            seen.push({ intent: decision.intent, text: plan.text });
            if (decision.intent === 'schedule') {
                return {
                    status: 'scheduled',
                    type: 'meeting',
                    id: 'a1b2c3',
                    title: 'Queues',
                    when: 'Fri, Jul 10, 11:00 AM MST',
                    meetLink: 'https://meet.google.com/abc-defg-hij',
                };
            }
            return { status: 'announced', type: 'announcement' };
        },
    });

    assert.equal(execution.actionResult.status, 'sequence_completed');
    assert.deepEqual(seen, [
        { intent: 'schedule', text: '' },
        { intent: 'announce', text: 'Join https://meet.google.com/abc-defg-hij' },
    ]);
});

test('stops the sequence at a failed step', async () => {
    const called = [];
    const actions = normalizePlanActions({
        actions: [
            { intent: 'cancel', kind: 'meeting', target: 'old session' },
            {
                intent: 'schedule',
                title: 'Replacement session',
                date: '2026-07-10T18:00:00.000Z',
                timezone: 'America/Phoenix',
            },
            { intent: 'announce', text: 'Replacement ready' },
        ],
    });

    const execution = await executePlanSequence({
        actions,
        body: 'Cancel, replace, and announce',
        runAction: async (decision) => {
            called.push(decision.intent);
            if (decision.intent === 'schedule') {
                return { status: 'failed', type: 'meeting', reason: 'missing_time' };
            }
            return { status: 'cancelled', meetings: 1, reminders: 0 };
        },
    });

    assert.deepEqual(called, ['cancel', 'schedule']);
    assert.equal(execution.actionResult.status, 'sequence_partial');
    assert.equal(execution.actionResult.stoppedAt, 2);
    assert.equal(execution.actionResult.executed, 2);
});

test('preflights every step before allowing earlier side effects', async () => {
    const called = [];
    const actions = normalizePlanActions({
        actions: [
            { intent: 'cancel', kind: 'meeting', target: 'old session' },
            { intent: 'schedule', title: 'Replacement without a time' },
        ],
    });

    const execution = await executePlanSequence({
        actions,
        body: 'Cancel the old session and schedule a replacement',
        runAction: async (decision) => {
            called.push(decision.intent);
            return { status: 'cancelled', meetings: 1, reminders: 0 };
        },
    });

    assert.deepEqual(called, []);
    assert.equal(execution.actionResult.status, 'sequence_partial');
    assert.equal(execution.actionResult.executed, 0);
    assert.equal(execution.actionResult.stoppedAt, 2);
    assert.equal(execution.actionResult.steps[0].executed, false);
    assert.match(execution.actionResult.steps[0].result.clarification, /date, time, and timezone/i);
});

test('executes a long finite workflow without truncating steps', async () => {
    const actions = normalizePlanActions({
        actions: Array.from({ length: 30 }, (_, index) => ({
            intent: 'announce',
            text: index === 0
                ? 'Step 1'
                : `Step ${index + 1} after {{previous.text}}`,
        })),
    }, 0);
    const seen = [];

    const execution = await executePlanSequence({
        actions,
        body: 'Run all announcements in order',
        runAction: async (_decision, _time, plan) => {
            seen.push(plan.text);
            return {
                status: 'announced',
                type: 'announcement',
                text: plan.text,
            };
        },
    });

    assert.equal(execution.actionResult.status, 'sequence_completed');
    assert.equal(execution.actionResult.executed, 30);
    assert.equal(seen.length, 30);
    assert.equal(seen[1], 'Step 2 after Step 1');
    assert.match(seen[29], /^Step 30 after Step 29/);
});
