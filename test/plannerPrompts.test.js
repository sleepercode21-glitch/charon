const test = require('node:test');
const assert = require('node:assert/strict');

const {
    plannerStagePayload,
    plannerStageSystemPrompt,
} = require('../agents/workflows/schedulingGraph');
const {
    CHARON_PROMPTS,
    CHARON_RESPONSE_PROMPT,
    PLANNER_DRAFT_PROMPT,
    PLANNER_REPAIR_PROMPT,
    PLANNER_FINAL_PROMPT,
    PLANNER_STAGE_PROMPTS,
} = require('../models/prompts');
const path = require('node:path');
const fs = require('node:fs');

test('registers exactly four production prompts', () => {
    assert.deepEqual(Object.keys(CHARON_PROMPTS), [
        'plannerDraft',
        'plannerRepair',
        'plannerFinal',
        'response',
    ]);
    assert.equal(CHARON_PROMPTS.plannerDraft, PLANNER_DRAFT_PROMPT);
    assert.equal(CHARON_PROMPTS.plannerRepair, PLANNER_REPAIR_PROMPT);
    assert.equal(CHARON_PROMPTS.plannerFinal, PLANNER_FINAL_PROMPT);
    assert.equal(CHARON_PROMPTS.response, CHARON_RESPONSE_PROMPT);
});

test('keeps production prompts within expanded context budget', () => {
    for (const [name, prompt] of Object.entries(CHARON_PROMPTS)) {
        const estimatedTokens = Math.ceil(prompt.length / 4);
        assert.ok(
            estimatedTokens >= 400 && estimatedTokens <= 1200,
            `${name} prompt estimated ${estimatedTokens} tokens`,
        );
    }
});

test('stores the four production prompts in four physical prompt files', () => {
    const promptDir = path.join(__dirname, '..', 'models', 'prompts');
    const promptFiles = fs.readdirSync(promptDir)
        .filter((file) => /^(plannerDraftPrompt|plannerRepairPrompt|plannerFinalPrompt|responsePrompt)\.js$/.test(file))
        .sort();

    assert.deepEqual(promptFiles, [
        'plannerDraftPrompt.js',
        'plannerFinalPrompt.js',
        'plannerRepairPrompt.js',
        'responsePrompt.js',
    ]);
});

test('uses three dedicated planner prompts instead of one extended prompt', () => {
    assert.equal(PLANNER_STAGE_PROMPTS.length, 3);
    assert.equal(plannerStageSystemPrompt(1, 3), PLANNER_DRAFT_PROMPT);
    assert.equal(plannerStageSystemPrompt(2, 3), PLANNER_REPAIR_PROMPT);
    assert.equal(plannerStageSystemPrompt(3, 3), PLANNER_FINAL_PROMPT);
    assert.notEqual(PLANNER_DRAFT_PROMPT, PLANNER_REPAIR_PROMPT);
    assert.notEqual(PLANNER_REPAIR_PROMPT, PLANNER_FINAL_PROMPT);
    assert.match(PLANNER_DRAFT_PROMPT, /stage 1: INTENT AND CONTEXT/);
    assert.match(PLANNER_REPAIR_PROMPT, /stage 2: PLAN BUILDER/);
    assert.match(PLANNER_FINAL_PROMPT, /stage 3: FINALIZER/);
});

test('planner prompts describe action capabilities and finite workflows', () => {
    assert.match(PLANNER_DRAFT_PROMPT, /Available actions:/);
    assert.match(PLANNER_REPAIR_PROMPT, /finite actionable steps/);
    assert.match(PLANNER_DRAFT_PROMPT, /speech act/i);
    assert.match(PLANNER_REPAIR_PROMPT, /Status\/existence\/query speech acts become list/i);
    assert.match(PLANNER_FINAL_PROMPT, /Verify speech act before keywords/i);
    assert.match(PLANNER_DRAFT_PROMPT, /Nouns do not determine intent/i);
    assert.match(PLANNER_REPAIR_PROMPT, /Mere nouns are not commands/i);
    assert.match(PLANNER_FINAL_PROMPT, /kind filters/i);
    assert.match(PLANNER_REPAIR_PROMPT, /move\/reschedule\/change time/);
    assert.match(PLANNER_FINAL_PROMPT, /Verify kind scoping/);
    assert.match(PLANNER_FINAL_PROMPT, /Verify update semantics/);
});

test('uses stage-specific planner payload shapes', () => {
    const base = JSON.stringify({
        msg: 'schedule the poll winner',
        clock: { timestampMs: 1 },
        quoted: { pollName: 'System design' },
        roomContext: {
            signals: { latestPoll: { leader: { opt: 'Youtube', n: 2 } } },
            polls: [{ name: 'System design', leader: { opt: 'Youtube', n: 2 } }],
            msgs: [{ body: 'Poll is ready' }],
            meetings: [{ id: 'abc123', title: 'Old session' }],
            reminders: [{ id: 'def456', text: 'Prep' }],
        },
    });
    const intentContext = JSON.stringify({
        stage: 'intent_context',
        primaryIntent: 'schedule',
        actionsNeeded: ['schedule'],
        references: [{ phrase: 'poll winner', type: 'poll', evidence: 'Youtube leads' }],
    });
    const draftPlan = '{"intent":"schedule","title":"Youtube System design","date":"2026-07-11T18:00:00Z"}';

    assert.equal(plannerStagePayload(base, [], 1, 3), base);

    const builderPayload = JSON.parse(plannerStagePayload(base, [intentContext], 2, 3));
    assert.equal(builderPayload.stage, 'plan_builder');
    assert.equal(builderPayload.intentContext.primaryIntent, 'schedule');
    assert.equal(builderPayload.referenceContext.polls[0].name, 'System design');
    assert.ok(!Object.hasOwn(builderPayload, 'draftPlan'));

    const finalPayload = JSON.parse(plannerStagePayload(base, [intentContext, draftPlan], 3, 3));
    assert.equal(finalPayload.stage, 'finalizer');
    assert.equal(finalPayload.intentContext.references[0].phrase, 'poll winner');
    assert.equal(finalPayload.draftPlan.parsed.title, 'Youtube System design');
});
