const path = require('path');

function numberFromEnv(name, fallback) {
    const value = Number(process.env[name]);
    return Number.isFinite(value) ? value : fallback;
}

function csvNumbersFromEnv(name, fallback) {
    if (!process.env[name]) return fallback;
    const values = process.env[name]
        .split(',')
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isFinite(value) && value >= 0);
    return values.length > 0 ? values : fallback;
}

const settings = {
    appName: 'charon',
    mongodbUri: process.env.MONGODB_URI,
    dataDir: process.env.DATA_DIR || path.join(process.cwd(), 'data'),
    timezone: process.env.TZ || process.env.BOT_TIMEZONE || 'America/Phoenix',
    whatsapp: {
        groupId: process.env.WHATSAPP_GROUP_ID || '',
        groupName: process.env.WHATSAPP_GROUP_NAME || '',
        groupScope: (process.env.WHATSAPP_GROUP_SCOPE || 'all').toLowerCase(),
        historyLimit: numberFromEnv('WHATSAPP_HISTORY_LIMIT', 200),
        replyMode: process.env.WHATSAPP_REPLY_MODE || 'tag_only',
    },
    llm: {
        provider: 'groq',
        plannerModel: process.env.GROQ_PLANNER_MODEL || 'groq/compound',
        responseModel: process.env.GROQ_RESPONSE_MODEL || 'qwen/qwen3-32b',
        plannerApiKey: process.env.GROQ_PLANNER_API_KEY || process.env.GROQ_API_KEY,
        responseApiKey: process.env.GROQ_RESPONSE_API_KEY || process.env.GROQ_API_KEY,
        temperature: numberFromEnv('LLM_TEMPERATURE', 0.1),
        maxOutputTokens: numberFromEnv('LLM_MAX_OUTPUT_TOKENS', 384),
        maxCallInputTokens: numberFromEnv('LLM_MAX_CALL_INPUT_TOKENS', 24000),
        plannerMaxInputTokens: numberFromEnv('LLM_PLANNER_MAX_INPUT_TOKENS', 2400),
        plannerRetryInputTokens: numberFromEnv('LLM_PLANNER_RETRY_INPUT_TOKENS', 1900),
        planMaxOutputTokens: numberFromEnv('LLM_PLAN_MAX_OUTPUT_TOKENS', 4096),
        responseMaxOutputTokens: numberFromEnv('LLM_RESPONSE_MAX_OUTPUT_TOKENS', 1024),
        maxSequenceActions: Math.max(0, Math.floor(numberFromEnv('LLM_MAX_SEQUENCE_ACTIONS', 0))),
        sequenceResponseMaxSteps: Math.max(0, Math.floor(numberFromEnv('LLM_SEQUENCE_RESPONSE_MAX_STEPS', 12))),
        maxInputTokens: numberFromEnv('LLM_MAX_INPUT_TOKENS', 10000),
        contextTokenBudget: numberFromEnv('LLM_CONTEXT_TOKEN_BUDGET', 6000),
        responseContextTokenBudget: numberFromEnv('LLM_RESPONSE_CONTEXT_TOKEN_BUDGET', 1200),
        maxContextMessages: numberFromEnv('LLM_MAX_CONTEXT_MESSAGES', 30),
        maxContextPolls: numberFromEnv('LLM_MAX_CONTEXT_POLLS', 8),
        tokensPerMinute: numberFromEnv('LLM_TOKENS_PER_MINUTE', 5200),
        requestsPerMinute: numberFromEnv('LLM_REQUESTS_PER_MINUTE', 25),
        plannerTokensPerMinute: numberFromEnv('LLM_PLANNER_TOKENS_PER_MINUTE', 60000),
        plannerRequestsPerMinute: numberFromEnv('LLM_PLANNER_REQUESTS_PER_MINUTE', 25),
        rateSafetyMultiplier: numberFromEnv('LLM_RATE_SAFETY_MULTIPLIER', 1.35),
        minRequestIntervalMs: numberFromEnv('LLM_MIN_REQUEST_INTERVAL_MS', 1750),
        rateStartFull: process.env.LLM_RATE_START_FULL === 'true',
    },
    sessions: {
        defaultDurationMinutes: Math.max(numberFromEnv('DEFAULT_MEETING_DURATION_MINUTES', 180), 180),
    },
    meet: {
        oauthClientId: process.env.GOOGLE_OAUTH_CLIENT_ID || '',
        oauthClientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || '',
        oauthRefreshToken: process.env.GOOGLE_OAUTH_REFRESH_TOKEN || '',
        staticLink: process.env.GOOGLE_MEET_LINK || '',
        accessType: process.env.GOOGLE_MEET_ACCESS_TYPE || 'OPEN',
        entryPointAccess: process.env.GOOGLE_MEET_ENTRY_POINT_ACCESS || 'ALL',
    },
    reminders: {
        enabled: process.env.REMINDERS_ENABLED !== 'false',
        checkIntervalMs: numberFromEnv('REMINDER_CHECK_INTERVAL_MS', 60000),
        dueGraceMs: numberFromEnv('REMINDER_DUE_GRACE_MS', 10 * 60 * 1000),
        leadMinutes: csvNumbersFromEnv('REMINDER_LEAD_MINUTES', [24 * 60, 6 * 60, 60, 10, 2, 0]),
    },
};

module.exports = { settings };
