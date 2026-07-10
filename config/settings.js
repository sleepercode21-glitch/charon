const path = require('path');

const DEFAULT_GROQ_MODEL = 'llama-3.1-8b-instant';
const DEPRECATED_GROQ_MODELS = new Set([
    'groq/compound',
    'qwen/qwen3-32b',
]);

const DEPRECATED_COMPOUND_ENV_VALUES = {
    LLM_MAX_CALL_INPUT_TOKENS: [10000, 24000],
    LLM_PLANNER_MAX_INPUT_TOKENS: [2000],
    LLM_PLANNER_RETRY_INPUT_TOKENS: [1900],
    LLM_PLANNER_TOKEN_ESTIMATE_MULTIPLIER: [2.5],
    LLM_PLANNER_MIN_REQUEST_TOKENS: [6500],
    LLM_PLANNER_MIN_REQUEST_INTERVAL_MS: [20000],
    LLM_RESPONSE_MAX_OUTPUT_TOKENS: [220, 1024],
    LLM_CONTEXT_TOKEN_BUDGET: [6000],
    LLM_MAX_CONTEXT_MESSAGES: [30],
    LLM_TOKENS_PER_MINUTE: [5200],
    LLM_REQUESTS_PER_MINUTE: [25],
    LLM_PLANNER_TOKENS_PER_MINUTE: [30000],
    LLM_PLANNER_REQUESTS_PER_MINUTE: [3],
    LLM_RATE_SAFETY_MULTIPLIER: [1.35],
    LLM_MIN_REQUEST_INTERVAL_MS: [1750],
};

function isDeprecatedGroqModel(model) {
    return DEPRECATED_GROQ_MODELS.has(String(model || '').trim());
}

function groqModelFromEnv(name, fallback = DEFAULT_GROQ_MODEL) {
    const value = String(process.env[name] || '').trim();
    if (!value || isDeprecatedGroqModel(value)) return fallback;
    return value;
}

const staleCompoundModelEnv = isDeprecatedGroqModel(process.env.GROQ_PLANNER_MODEL)
    || isDeprecatedGroqModel(process.env.GROQ_RESPONSE_MODEL);

function numberFromEnv(name, fallback, options = {}) {
    const value = Number(process.env[name]);
    if (options.ignoreDeprecatedCompoundValue && Number.isFinite(value)) {
        const deprecatedValues = DEPRECATED_COMPOUND_ENV_VALUES[name] || [];
        if (deprecatedValues.includes(value)) return fallback;
    }
    return Number.isFinite(value) ? value : fallback;
}

function llamaNumberFromEnv(name, fallback) {
    return numberFromEnv(name, fallback, {
        ignoreDeprecatedCompoundValue: staleCompoundModelEnv,
    });
}

function splitSecretList(value) {
    return String(value || '')
        .split(/[,\s]+/)
        .map((item) => item.trim())
        .filter(Boolean);
}

function indexedSecretListFromEnv(prefix, limit = 12) {
    const values = [];
    for (let index = 1; index <= limit; index += 1) {
        values.push(...splitSecretList(process.env[`${prefix}_${index}`]));
    }
    return values;
}

function uniqueSecrets(values) {
    return [...new Set(values.filter(Boolean))];
}

function firstConfiguredSecretList(...lists) {
    for (const list of lists) {
        const values = uniqueSecrets(list);
        if (values.length > 0) return values;
    }
    return [];
}

function firstConfiguredSecret(...lists) {
    const values = firstConfiguredSecretList(...lists);
    return values.length > 0 ? [values[0]] : [];
}

function csvNumbersFromEnv(name, fallback) {
    if (!process.env[name]) return fallback;
    const values = process.env[name]
        .split(',')
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isFinite(value) && value >= 0);
    return values.length > 0 ? values : fallback;
}

const plannerApiKeys = firstConfiguredSecretList(
    indexedSecretListFromEnv('GROQ_PLANNER_API_KEY', 3),
    splitSecretList(process.env.GROQ_PLANNER_API_KEY),
    splitSecretList(process.env.GROQ_API_KEY),
    indexedSecretListFromEnv('GROQ_API_KEY', 3),
);
const responseApiKeys = firstConfiguredSecret(
    splitSecretList(process.env.GROQ_RESPONSE_API_KEY),
    indexedSecretListFromEnv('GROQ_RESPONSE_API_KEY', 1),
    splitSecretList(process.env.GROQ_API_KEY),
    indexedSecretListFromEnv('GROQ_API_KEY', 1),
);

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
        plannerModel: groqModelFromEnv('GROQ_PLANNER_MODEL'),
        responseModel: groqModelFromEnv('GROQ_RESPONSE_MODEL'),
        plannerApiKey: plannerApiKeys[0] || '',
        responseApiKey: responseApiKeys[0] || '',
        plannerApiKeys,
        responseApiKeys,
        temperature: numberFromEnv('LLM_TEMPERATURE', 0.1),
        maxOutputTokens: numberFromEnv('LLM_MAX_OUTPUT_TOKENS', 384),
        maxCallInputTokens: llamaNumberFromEnv('LLM_MAX_CALL_INPUT_TOKENS', 60000),
        plannerMaxInputTokens: llamaNumberFromEnv('LLM_PLANNER_MAX_INPUT_TOKENS', 3500),
        plannerRetryInputTokens: llamaNumberFromEnv('LLM_PLANNER_RETRY_INPUT_TOKENS', 2500),
        plannerTokenEstimateMultiplier: llamaNumberFromEnv('LLM_PLANNER_TOKEN_ESTIMATE_MULTIPLIER', 1.2),
        plannerMinRequestTokens: llamaNumberFromEnv('LLM_PLANNER_MIN_REQUEST_TOKENS', 0),
        plannerMinRequestIntervalMs: llamaNumberFromEnv('LLM_PLANNER_MIN_REQUEST_INTERVAL_MS', 500),
        plannerRateLimitCooldownMs: numberFromEnv('LLM_PLANNER_RATE_LIMIT_COOLDOWN_MS', 60000),
        planMaxOutputTokens: numberFromEnv('LLM_PLAN_MAX_OUTPUT_TOKENS', 800),
        plannerStages: Math.max(1, Math.floor(numberFromEnv('LLM_PLANNER_STAGES', 3))),
        responseMaxOutputTokens: llamaNumberFromEnv('LLM_RESPONSE_MAX_OUTPUT_TOKENS', 384),
        maxSequenceActions: Math.max(0, Math.floor(numberFromEnv('LLM_MAX_SEQUENCE_ACTIONS', 0))),
        sequenceResponseMaxSteps: Math.max(0, Math.floor(numberFromEnv('LLM_SEQUENCE_RESPONSE_MAX_STEPS', 12))),
        maxInputTokens: numberFromEnv('LLM_MAX_INPUT_TOKENS', 10000),
        contextTokenBudget: llamaNumberFromEnv('LLM_CONTEXT_TOKEN_BUDGET', 3000),
        responseContextTokenBudget: numberFromEnv('LLM_RESPONSE_CONTEXT_TOKEN_BUDGET', 1200),
        maxContextMessages: llamaNumberFromEnv('LLM_MAX_CONTEXT_MESSAGES', 20),
        maxContextPolls: numberFromEnv('LLM_MAX_CONTEXT_POLLS', 8),
        tokensPerMinute: llamaNumberFromEnv('LLM_TOKENS_PER_MINUTE', 200000),
        requestsPerMinute: llamaNumberFromEnv('LLM_REQUESTS_PER_MINUTE', 120),
        plannerTokensPerMinute: llamaNumberFromEnv('LLM_PLANNER_TOKENS_PER_MINUTE', 200000),
        plannerRequestsPerMinute: llamaNumberFromEnv('LLM_PLANNER_REQUESTS_PER_MINUTE', 120),
        rateSafetyMultiplier: llamaNumberFromEnv('LLM_RATE_SAFETY_MULTIPLIER', 1.15),
        minRequestIntervalMs: llamaNumberFromEnv('LLM_MIN_REQUEST_INTERVAL_MS', 500),
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
