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

test('uses the shared Groq key as a backward-compatible fallback', () => {
    assert.deepEqual(loadKeySelection({
        GROQ_API_KEY: 'shared-test-key',
    }), {
        planner: 'shared-test-key',
        response: 'shared-test-key',
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
    });
});
