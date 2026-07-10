const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const settingsPath = path.join(__dirname, '..', 'config', 'settings.js');

function loadKeySelection(env) {
    const script = `
        const { settings } = require(${JSON.stringify(settingsPath)});
        process.stdout.write(JSON.stringify({
            planner: settings.llm.plannerApiKey,
            response: settings.llm.responseApiKey,
            plannerKeys: settings.llm.plannerApiKeys,
            responseKeys: settings.llm.responseApiKeys,
        }));
    `;
    const output = execFileSync(process.execPath, ['-e', script], {
        env: {
            PATH: process.env.PATH,
            ...env,
        },
        encoding: 'utf8',
    });
    return JSON.parse(output);
}

function loadLlmSettings(env) {
    const script = `
        const { settings } = require(${JSON.stringify(settingsPath)});
        process.stdout.write(JSON.stringify(settings.llm));
    `;
    const output = execFileSync(process.execPath, ['-e', script], {
        env: {
            PATH: process.env.PATH,
            ...env,
        },
        encoding: 'utf8',
    });
    return JSON.parse(output);
}

test('uses the shared Groq key as a backward-compatible fallback', () => {
    assert.deepEqual(loadKeySelection({
        GROQ_API_KEY: 'shared-test-key',
    }), {
        planner: 'shared-test-key',
        response: 'shared-test-key',
        plannerKeys: ['shared-test-key'],
        responseKeys: ['shared-test-key'],
    });
});

test('uses independent planner and response Groq keys when configured', () => {
    assert.deepEqual(loadKeySelection({
        GROQ_API_KEY: 'shared-test-key',
        GROQ_PLANNER_API_KEY: 'planner-test-key',
        GROQ_RESPONSE_API_KEY: 'response-test-key',
    }), {
        planner: 'planner-test-key',
        response: 'response-test-key',
        plannerKeys: ['planner-test-key'],
        responseKeys: ['response-test-key'],
    });
});

test('uses three planner keys and one response key when pools are configured', () => {
    assert.deepEqual(loadKeySelection({
        GROQ_API_KEY: 'shared-test-key',
        GROQ_PLANNER_API_KEY: 'planner-single-key',
        GROQ_RESPONSE_API_KEY: 'response-single-key',
        GROQ_PLANNER_API_KEY_1: 'planner-pool-1',
        GROQ_PLANNER_API_KEY_2: 'planner-pool-2',
        GROQ_PLANNER_API_KEY_3: 'planner-pool-3',
        GROQ_PLANNER_API_KEY_4: 'planner-pool-4',
        GROQ_RESPONSE_API_KEY_1: 'response-pool-1',
        GROQ_RESPONSE_API_KEY_2: 'response-pool-2',
    }), {
        planner: 'planner-pool-1',
        response: 'response-single-key',
        plannerKeys: ['planner-pool-1', 'planner-pool-2', 'planner-pool-3'],
        responseKeys: ['response-single-key'],
    });
});

test('coerces stale Compound/Qwen env overrides to Llama instant defaults', () => {
    const llm = loadLlmSettings({
        GROQ_PLANNER_MODEL: 'groq/compound',
        GROQ_RESPONSE_MODEL: 'qwen/qwen3-32b',
        LLM_MAX_CALL_INPUT_TOKENS: '24000',
        LLM_PLANNER_MAX_INPUT_TOKENS: '2000',
        LLM_PLANNER_RETRY_INPUT_TOKENS: '1900',
        LLM_PLANNER_TOKEN_ESTIMATE_MULTIPLIER: '2.5',
        LLM_PLANNER_MIN_REQUEST_TOKENS: '6500',
        LLM_PLANNER_MIN_REQUEST_INTERVAL_MS: '20000',
        LLM_RESPONSE_MAX_OUTPUT_TOKENS: '1024',
        LLM_CONTEXT_TOKEN_BUDGET: '6000',
        LLM_MAX_CONTEXT_MESSAGES: '30',
        LLM_TOKENS_PER_MINUTE: '5200',
        LLM_REQUESTS_PER_MINUTE: '25',
        LLM_PLANNER_TOKENS_PER_MINUTE: '30000',
        LLM_PLANNER_REQUESTS_PER_MINUTE: '3',
        LLM_RATE_SAFETY_MULTIPLIER: '1.35',
        LLM_MIN_REQUEST_INTERVAL_MS: '1750',
    });

    assert.equal(llm.plannerModel, 'llama-3.1-8b-instant');
    assert.equal(llm.responseModel, 'llama-3.1-8b-instant');
    assert.equal(llm.maxCallInputTokens, 60000);
    assert.equal(llm.plannerMaxInputTokens, 5000);
    assert.equal(llm.plannerRetryInputTokens, 3200);
    assert.equal(llm.plannerTokenEstimateMultiplier, 1.35);
    assert.equal(llm.plannerMinRequestTokens, 0);
    assert.equal(llm.plannerMinRequestIntervalMs, 500);
    assert.equal(llm.plannerStages, 3);
    assert.equal(llm.responseMaxOutputTokens, 384);
    assert.equal(llm.contextTokenBudget, 4500);
    assert.equal(llm.maxContextMessages, 24);
    assert.equal(llm.tokensPerMinute, 30000);
    assert.equal(llm.requestsPerMinute, 30);
    assert.equal(llm.plannerTokensPerMinute, 30000);
    assert.equal(llm.plannerRequestsPerMinute, 30);
    assert.equal(llm.rateSafetyMultiplier, 1.15);
    assert.equal(llm.minRequestIntervalMs, 500);
});
