const test = require('node:test');
const assert = require('node:assert/strict');

const {
    plannerStagePayload,
    plannerStageSystemPrompt,
} = require('../agents/workflows/schedulingGraph');
const {
    PLANNER_DRAFT_PROMPT,
    PLANNER_REPAIR_PROMPT,
    PLANNER_FINAL_PROMPT,
    PLANNER_STAGE_PROMPTS,
} = require('../models/prompts/plannerPrompts');

test('uses three dedicated planner prompts instead of one extended prompt', () => {
    assert.equal(PLANNER_STAGE_PROMPTS.length, 3);
    assert.equal(plannerStageSystemPrompt(1, 3), PLANNER_DRAFT_PROMPT);
    assert.equal(plannerStageSystemPrompt(2, 3), PLANNER_REPAIR_PROMPT);
    assert.equal(plannerStageSystemPrompt(3, 3), PLANNER_FINAL_PROMPT);
    assert.notEqual(PLANNER_DRAFT_PROMPT, PLANNER_REPAIR_PROMPT);
    assert.notEqual(PLANNER_REPAIR_PROMPT, PLANNER_FINAL_PROMPT);
    assert.match(PLANNER_DRAFT_PROMPT, /stage 1: DRAFT/);
    assert.match(PLANNER_REPAIR_PROMPT, /stage 2: CRITIC AND REPAIR/);
    assert.match(PLANNER_FINAL_PROMPT, /stage 3: FINALIZER/);
});

test('uses stage-specific planner payload shapes', () => {
    const base = JSON.stringify({
        msg: 'schedule the poll winner',
        clock: { timestampMs: 1 },
        quoted: { pollName: 'System design' },
    });
    const draft = '{"intent":"schedule","title":"System design","date":""}';
    const repair = '{"intent":"schedule","title":"Youtube System design","date":"2026-07-11T18:00:00Z"}';

    assert.equal(plannerStagePayload(base, [], 1, 3), base);

    const criticPayload = JSON.parse(plannerStagePayload(base, [draft], 2, 3));
    assert.equal(criticPayload.stage, 'critic_repair');
    assert.equal(criticPayload.draftOutput.parsed.intent, 'schedule');
    assert.ok(!Object.hasOwn(criticPayload, 'repairOutput'));

    const finalPayload = JSON.parse(plannerStagePayload(base, [draft, repair], 3, 3));
    assert.equal(finalPayload.stage, 'finalizer');
    assert.equal(finalPayload.draftOutput.parsed.title, 'System design');
    assert.equal(finalPayload.repairOutput.parsed.title, 'Youtube System design');
});
