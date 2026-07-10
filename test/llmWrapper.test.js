const test = require('node:test');
const assert = require('node:assert/strict');

const { settings } = require('../config/settings');
const { estimateRequestCapacity, minimumRequestIntervalFor } = require('../models/llmWrapper');

test('deliberately overestimates Compound capacity above provider-reported cost', () => {
    const originalMultiplier = settings.llm.plannerTokenEstimateMultiplier;
    const originalMinimum = settings.llm.plannerMinRequestTokens;
    settings.llm.plannerTokenEstimateMultiplier = 2.5;
    settings.llm.plannerMinRequestTokens = 6500;

    try {
        assert.equal(estimateRequestCapacity({
            model: settings.llm.plannerModel,
            inputTokens: 1939,
            outputTokens: 400,
        }), 6500);
        assert.ok(6500 > 5440);
    } finally {
        settings.llm.plannerTokenEstimateMultiplier = originalMultiplier;
        settings.llm.plannerMinRequestTokens = originalMinimum;
    }
});

test('does not inflate response-model capacity estimates', () => {
    assert.equal(estimateRequestCapacity({
        model: settings.llm.responseModel,
        inputTokens: 1200,
        outputTokens: 320,
    }), 1520);
});

test('spaces Compound calls for the effective three-request budget', () => {
    assert.equal(minimumRequestIntervalFor(settings.llm.plannerModel), 20000);
    assert.equal(minimumRequestIntervalFor(settings.llm.responseModel), settings.llm.minRequestIntervalMs);
});
