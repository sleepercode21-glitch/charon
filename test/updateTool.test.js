const test = require('node:test');
const assert = require('node:assert/strict');

const { updateActiveItem } = require('../agents/tools/update');

test('resolves "last meeting" to the newest active meeting before updating', async () => {
    const calls = [];
    const result = await updateActiveItem({
        decision: {
            update: {
                kind: 'meeting',
                target: 'the last meeting',
                start: '2026-07-11T23:00:00.000Z',
                timezone: 'America/Chicago',
            },
        },
        timeResolution: {
            status: 'resolved',
            start: '2026-07-11T23:00:00.000Z',
            timezone: 'America/Chicago',
        },
        chat: { id: { _serialized: 'chat-1' } },
        messageStore: {
            async findActiveItem() {
                return null;
            },
            async findActiveItems() {
                return [
                    {
                        type: 'meeting',
                        item: {
                            _id: '000000000000000000old111',
                            title: 'Older meeting',
                            start: '2026-07-12T18:00:00.000Z',
                            end: '2026-07-12T19:00:00.000Z',
                            timezone: 'America/Phoenix',
                            createdAt: '2026-07-01T00:00:00.000Z',
                        },
                        label: 'meeting "Older meeting"',
                    },
                    {
                        type: 'meeting',
                        item: {
                            _id: '000000000000000000new222',
                            title: 'Newest meeting',
                            start: '2026-07-13T18:00:00.000Z',
                            end: '2026-07-13T19:00:00.000Z',
                            timezone: 'America/Phoenix',
                            createdAt: '2026-07-10T00:00:00.000Z',
                        },
                        label: 'meeting "Newest meeting"',
                    },
                ];
            },
            async updateActiveItem({ target, updates }) {
                calls.push({ target, updates });
                return {
                    updated: true,
                    item: {
                        _id: '000000000000000000new222',
                    },
                    label: 'meeting "Newest meeting"',
                };
            },
        },
    });

    assert.equal(calls[0].target, 'new222');
    assert.equal(calls[0].updates.timezone, 'America/Chicago');
    assert.equal(result.status, 'updated');
    assert.equal(result.type, 'meeting');
});

test('refuses to move an active meeting into the past', async () => {
    const originalNow = Date.now;
    Date.now = () => new Date('2026-07-10T20:00:00.000Z').getTime();

    try {
        let wrote = false;
        const result = await updateActiveItem({
            decision: {
                update: {
                    kind: 'meeting',
                    target: 'the last meeting',
                    start: '2026-07-10T19:00:00.000Z',
                    timezone: 'UTC',
                },
            },
            timeResolution: {
                status: 'resolved',
                start: '2026-07-10T19:00:00.000Z',
                timezone: 'UTC',
            },
            chat: { id: { _serialized: 'chat-1' } },
            messageStore: {
                async findActiveItem() {
                    return {
                        type: 'meeting',
                        item: {
                            _id: '000000000000000000new222',
                            title: 'Newest meeting',
                            start: '2026-07-13T18:00:00.000Z',
                            end: '2026-07-13T19:00:00.000Z',
                            timezone: 'UTC',
                        },
                        label: 'meeting "Newest meeting"',
                    };
                },
                async updateActiveItem() {
                    wrote = true;
                    return { updated: true };
                },
            },
        });

        assert.equal(result.status, 'failed');
        assert.equal(result.reason, 'past_time');
        assert.equal(wrote, false);
    } finally {
        Date.now = originalNow;
    }
});
