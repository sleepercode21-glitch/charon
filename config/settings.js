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

function csvStringsFromEnv(name, fallback) {
    if (!process.env[name]) return fallback;
    const values = process.env[name]
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
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
        model: process.env.GROQ_MODEL || 'llama-3.1-8b-instant',
        fallbackModels: csvStringsFromEnv('GROQ_FALLBACK_MODELS', []),
        apiKey: process.env.GROQ_API_KEY,
        temperature: numberFromEnv('LLM_TEMPERATURE', 0.1),
        maxOutputTokens: numberFromEnv('LLM_MAX_OUTPUT_TOKENS', 512),
        situationMaxOutputTokens: numberFromEnv('LLM_SITUATION_MAX_OUTPUT_TOKENS', 220),
        planMaxOutputTokens: numberFromEnv('LLM_PLAN_MAX_OUTPUT_TOKENS', 280),
        responseMaxOutputTokens: numberFromEnv('LLM_RESPONSE_MAX_OUTPUT_TOKENS', 300),
        maxInputTokens: numberFromEnv('LLM_MAX_INPUT_TOKENS', 5000),
        contextTokenBudget: numberFromEnv('LLM_CONTEXT_TOKEN_BUDGET', 3200),
        maxContextMessages: numberFromEnv('LLM_MAX_CONTEXT_MESSAGES', 28),
        maxContextPolls: numberFromEnv('LLM_MAX_CONTEXT_POLLS', 8),
        modelCooldownMs: numberFromEnv('LLM_MODEL_COOLDOWN_MS', 60000),
        tokensPerMinute: numberFromEnv('LLM_TOKENS_PER_MINUTE', 5200),
        requestsPerMinute: numberFromEnv('LLM_REQUESTS_PER_MINUTE', 25),
        rateSafetyMultiplier: numberFromEnv('LLM_RATE_SAFETY_MULTIPLIER', 1.35),
        minRequestIntervalMs: numberFromEnv('LLM_MIN_REQUEST_INTERVAL_MS', 1750),
        rateStartFull: process.env.LLM_RATE_START_FULL === 'true',
        maxRateRetries: numberFromEnv('LLM_MAX_RATE_RETRIES', 2),
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
