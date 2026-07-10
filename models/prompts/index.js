const {
    PLANNER_DRAFT_PROMPT,
} = require('./plannerDraftPrompt');
const {
    PLANNER_REPAIR_PROMPT,
} = require('./plannerRepairPrompt');
const {
    PLANNER_FINAL_PROMPT,
} = require('./plannerFinalPrompt');
const { CHARON_RESPONSE_PROMPT } = require('./responsePrompt');

const PLANNER_STAGE_PROMPTS = [
    PLANNER_DRAFT_PROMPT,
    PLANNER_REPAIR_PROMPT,
    PLANNER_FINAL_PROMPT,
];

const CHARON_PROMPTS = {
    plannerDraft: PLANNER_DRAFT_PROMPT,
    plannerRepair: PLANNER_REPAIR_PROMPT,
    plannerFinal: PLANNER_FINAL_PROMPT,
    response: CHARON_RESPONSE_PROMPT,
};

module.exports = {
    CHARON_PROMPTS,
    PLANNER_DRAFT_PROMPT,
    PLANNER_REPAIR_PROMPT,
    PLANNER_FINAL_PROMPT,
    PLANNER_STAGE_PROMPTS,
    CHARON_RESPONSE_PROMPT,
};
