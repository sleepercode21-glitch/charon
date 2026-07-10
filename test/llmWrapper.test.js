const test = require('node:test');
const assert = require('node:assert/strict');

const { settings } = require('../config/settings');
const { estimateRequestCapacity, minimumRequestIntervalFor, rotateKeys } = require('../models/llmWrapper');

test('applies planner-only capacity padding', () => {
    const originalMultiplier = settings.llm.plannerTokenEstimateMultiplier;
    const originalMinimum = settings.llm.plannerMinRequestTokens;
    settings.llm.plannerTokenEstimateMultiplier = 1.2;
    settings.llm.plannerMinRequestTokens = 0;

    try {
        assert.equal(estimateRequestCapacity({
            model: settings.llm.plannerModel,
            inputTokens: 1600,
            outputTokens: 400,
            purpose: 'planner',
        }), 2400);
    } finally {
        settings.llm.plannerTokenEstimateMultiplier = originalMultiplier;
        settings.llm.plannerMinRequestTokens = originalMinimum;
    }
});

test('does not inflate response capacity even when response uses the same model id', () => {
    assert.equal(estimateRequestCapacity({
        model: settings.llm.responseModel,
        inputTokens: 1200,
        outputTokens: 320,
        purpose: 'response',
    }), 1520);
});

test('spaces calls by purpose instead of model string', () => {
    assert.equal(minimumRequestIntervalFor(settings.llm.plannerModel, 'planner'), settings.llm.plannerMinRequestIntervalMs);
    assert.equal(minimumRequestIntervalFor(settings.llm.responseModel, 'response'), settings.llm.minRequestIntervalMs);
});

test('rotates planner key preference by stage', () => {
    const keys = ['key-1', 'key-2', 'key-3'];
    assert.deepEqual(rotateKeys(keys, 0), ['key-1', 'key-2', 'key-3']);
    assert.deepEqual(rotateKeys(keys, 1), ['key-2', 'key-3', 'key-1']);
    assert.deepEqual(rotateKeys(keys, 2), ['key-3', 'key-1', 'key-2']);
    assert.deepEqual(rotateKeys(keys, 3), ['key-1', 'key-2', 'key-3']);
});
