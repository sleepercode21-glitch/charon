const { settings } = require('../config/settings');
const { logger } = require('../utils/logger');
const crypto = require('crypto');

const GROQ_CHAT_COMPLETIONS_URL = 'https://api.groq.com/openai/v1/chat/completions';
const RATE_WINDOW_MS = 60 * 1000;

const rateStates = new Map();

function estimateTokens(value) {
    const text = typeof value === 'string' ? value : JSON.stringify(value || '');
    return Math.ceil(text.length / 4);
}

function estimateMessagesTokens(messages) {
    return messages.reduce((total, message) => total + estimateTokens(langchainContent(message)), 0);
}

function isPlannerPurpose(purpose) {
    return purpose === 'planner';
}

function keyRefFor(apiKey, index = 0) {
    return apiKey
        ? crypto.createHash('sha256').update(apiKey).digest('hex').slice(0, 12)
        : `missing-${index}`;
}

function rateKeyFor(model, purpose = 'response', keyRef = 'default') {
    return `${purpose}:${model}:${keyRef}`;
}

function estimateRequestCapacity({ model, inputTokens, outputTokens, purpose = 'response' }) {
    const rawEstimate = inputTokens + outputTokens;
    if (!isPlannerPurpose(purpose)) return rawEstimate;

    const multiplier = Math.max(settings.llm.plannerTokenEstimateMultiplier || 1, 1);
    const minimum = Math.max(settings.llm.plannerMinRequestTokens || 0, 0);
    return Math.max(Math.ceil(rawEstimate * multiplier), minimum);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function langchainRole(message) {
    const type = message?._getType?.();
    if (type === 'system') return 'system';
    if (type === 'ai') return 'assistant';
    return 'user';
}

function langchainContent(message) {
    const content = message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .map((part) => (typeof part === 'string' ? part : part?.text || ''))
            .join('\n')
            .trim();
    }
    return String(content || '');
}

function rateLimitsFor(model, purpose = 'response') {
    const planner = isPlannerPurpose(purpose);
    return {
        tokenLimit: Math.max(planner
            ? settings.llm.plannerTokensPerMinute
            : settings.llm.tokensPerMinute || 0, 0),
        requestLimit: Math.max(planner
            ? settings.llm.plannerRequestsPerMinute
            : settings.llm.requestsPerMinute || 0, 0),
    };
}

function minimumRequestIntervalFor(model, purpose = 'response') {
    if (isPlannerPurpose(purpose)) {
        return Math.max(settings.llm.plannerMinRequestIntervalMs || 0, 0);
    }
    return Math.max(settings.llm.minRequestIntervalMs || 0, 0);
}

function rateStateFor(model, purpose = 'response', keyRef = 'default') {
    const key = rateKeyFor(model, purpose, keyRef);
    if (!rateStates.has(key)) {
        const limits = rateLimitsFor(model, purpose);
        rateStates.set(key, {
            availableTokens: settings.llm.rateStartFull ? limits.tokenLimit : 0,
            availableRequests: settings.llm.rateStartFull ? limits.requestLimit : 0,
            lastRateRefillAt: Date.now(),
            lastLlmRequestAt: 0,
        });
    }
    return rateStates.get(key);
}

function refillRateBuckets(model, purpose = 'response', keyRef = 'default') {
    const state = rateStateFor(model, purpose, keyRef);
    const { tokenLimit, requestLimit } = rateLimitsFor(model, purpose);
    const now = Date.now();
    const elapsed = Math.max(0, now - state.lastRateRefillAt);
    state.lastRateRefillAt = now;

    if (tokenLimit > 0) {
        state.availableTokens = Math.min(tokenLimit, state.availableTokens + (elapsed * tokenLimit / RATE_WINDOW_MS));
    }

    if (requestLimit > 0) {
        state.availableRequests = Math.min(requestLimit, state.availableRequests + (elapsed * requestLimit / RATE_WINDOW_MS));
    }

    return state;
}

async function reserveLlmCapacity({
    estimatedTokens,
    model,
    purpose = 'response',
    keyRef = 'default',
}) {
    const { tokenLimit, requestLimit } = rateLimitsFor(model, purpose);
    const state = rateStateFor(model, purpose, keyRef);
    const minIntervalMs = minimumRequestIntervalFor(model, purpose);
    if (tokenLimit <= 0 && requestLimit <= 0 && minIntervalMs <= 0) {
        return { reservedTokens: 0 };
    }

    const safety = Math.max(Number(settings.llm.rateSafetyMultiplier || 1), 1);
    const safeEstimate = Math.ceil(Math.max(estimatedTokens, 1) * safety);
    const tokenCost = tokenLimit > 0 ? Math.min(safeEstimate, tokenLimit) : 0;
    const requestCost = requestLimit > 0 ? 1 : 0;

    while (true) {
        refillRateBuckets(model, purpose, keyRef);
        const tokenReady = tokenLimit <= 0 || state.availableTokens >= tokenCost;
        const requestReady = requestLimit <= 0 || state.availableRequests >= requestCost;
        const intervalWait = minIntervalMs > 0
            ? Math.max(0, state.lastLlmRequestAt + minIntervalMs - Date.now())
            : 0;
        const intervalReady = intervalWait <= 0;

        if (tokenReady && requestReady && intervalReady) {
            if (tokenLimit > 0) state.availableTokens -= tokenCost;
            if (requestLimit > 0) state.availableRequests -= requestCost;
            state.lastLlmRequestAt = Date.now();
            return { reservedTokens: tokenCost };
        }

        const tokenWait = tokenLimit > 0 && !tokenReady
            ? ((tokenCost - state.availableTokens) / tokenLimit) * RATE_WINDOW_MS
            : 0;
        const requestWait = requestLimit > 0 && !requestReady
            ? ((requestCost - state.availableRequests) / requestLimit) * RATE_WINDOW_MS
            : 0;
        const waitMs = Math.ceil(Math.max(tokenWait, requestWait, intervalWait, 250));

        logger.warn(`LLM rate guard async wait ${Math.ceil(waitMs / 1000)}s for ${model}; estimated=${estimatedTokens}, reserved=${tokenCost} tokens.`);
        await sleep(waitMs);
    }
}

function reconcileActualUsage({
    actualTokens,
    reservedTokens,
    model,
    purpose = 'response',
    keyRef = 'default',
}) {
    const { tokenLimit } = rateLimitsFor(model, purpose);
    if (tokenLimit <= 0 || !Number.isFinite(actualTokens) || actualTokens <= reservedTokens) return;

    const extra = actualTokens - reservedTokens;
    const state = refillRateBuckets(model, purpose, keyRef);
    state.availableTokens = Math.max(0, state.availableTokens - extra);
    logger.info(`LLM rate guard reconciled ${extra} extra tokens for ${model}; actual=${actualTokens}, reserved=${reservedTokens}.`);
}

function retryDelayFromGroq({ response, parsed }) {
    const retryAfter = Number(response.headers.get('retry-after'));
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
        return Math.ceil(retryAfter * 1000);
    }

    const message = String(parsed?.error?.message || '');
    const match = message.match(/try again in\s+([0-9.]+)\s*(ms|s|m)/i);
    if (!match) return 0;

    const amount = Number(match[1]);
    if (!Number.isFinite(amount) || amount <= 0) return 0;
    const unit = match[2].toLowerCase();
    if (unit === 'm') return Math.ceil(amount * 60 * 1000);
    if (unit === 's') return Math.ceil(amount * 1000);
    return Math.ceil(amount);
}

function reconcileRejectedRequest({
    reservedTokens,
    model,
    purpose = 'response',
    keyRef = 'default',
}) {
    const { tokenLimit } = rateLimitsFor(model, purpose);
    if (tokenLimit <= 0 || !reservedTokens) return;
    const state = refillRateBuckets(model, purpose, keyRef);
    state.availableTokens = Math.min(tokenLimit, state.availableTokens + reservedTokens);
    logger.info(`LLM rate guard released ${reservedTokens} reserved tokens for failed ${model} request.`);
}

function markProviderRateLimited(model, purpose = 'response', keyRef = 'default') {
    const state = rateStateFor(model, purpose, keyRef);
    const now = Date.now();
    state.availableTokens = 0;
    state.availableRequests = 0;
    state.lastRateRefillAt = now;
    state.lastLlmRequestAt = now;
    logger.warn(`LLM rate guard synchronized ${model} to an empty provider window.`);
}

async function invokeGroqWithKey({
    model,
    apiKey,
    keyRef,
    keyIndex,
    hasFallbackKey,
    purpose,
    requestBody,
    estimatedRequestTokens,
}) {
    const reservation = await reserveLlmCapacity({
        estimatedTokens: estimatedRequestTokens,
        model,
        purpose,
        keyRef,
    });

    let parsed = null;
    let plannerCooldownUsed = false;
    let shortRetries = 0;
    for (let attempt = 0; attempt < 4; attempt += 1) {
        const response = await fetch(GROQ_CHAT_COMPLETIONS_URL, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: requestBody,
        });

        const body = await response.text();
        try {
            parsed = JSON.parse(body);
        } catch (_error) {
            parsed = null;
        }

        if (response.ok) {
            const result = {
                content: parsed?.choices?.[0]?.message?.content || '',
                usage_metadata: parsed?.usage ? {
                    input_tokens: parsed.usage.prompt_tokens,
                    output_tokens: parsed.usage.completion_tokens,
                    total_tokens: parsed.usage.total_tokens,
                } : undefined,
            };

            reconcileActualUsage({
                actualTokens: result.usage_metadata?.total_tokens,
                reservedTokens: reservation?.reservedTokens || 0,
                model,
                purpose,
                keyRef,
            });

            return result;
        }

        const delayMs = retryDelayFromGroq({ response, parsed });
        const retryableProviderLimit = response.status === 429 || response.status === 503;
        const authOrProviderFailure = retryableProviderLimit || response.status === 401 || response.status === 403;
        if (hasFallbackKey && authOrProviderFailure) {
            if (retryableProviderLimit) markProviderRateLimited(model, purpose, keyRef);
            else {
                reconcileRejectedRequest({
                    reservedTokens: reservation?.reservedTokens || 0,
                    model,
                    purpose,
                    keyRef,
                });
            }
            const error = new Error(`[${response.status} ${response.statusText}] Groq ${purpose} key ${keyIndex + 1} failed`);
            error.status = response.status;
            error.code = parsed?.error?.code || '';
            if (delayMs > 0) error.retryAfterMs = delayMs;
            throw error;
        }

        const plannerRateLimit = isPlannerPurpose(purpose) && response.status === 429;
        if (plannerRateLimit && !plannerCooldownUsed) {
            plannerCooldownUsed = true;
            markProviderRateLimited(model, purpose, keyRef);
            const cooldownMs = Math.min(Math.max(
                delayMs,
                settings.llm.plannerRateLimitCooldownMs || RATE_WINDOW_MS,
            ), RATE_WINDOW_MS);
            logger.warn(`Planner provider window is saturated; cooling down ${Math.ceil(cooldownMs / 1000)}s before one retry.`);
            await sleep(cooldownMs);
            continue;
        }

        if (!plannerRateLimit
            && retryableProviderLimit
            && shortRetries < 2
            && delayMs > 0
            && delayMs <= 65_000) {
            shortRetries += 1;
            logger.warn(`Groq asked Charon to wait ${Math.ceil(delayMs / 1000)}s for ${model}; retrying (${shortRetries}/2).`);
            await sleep(delayMs + 250);
            continue;
        }

        if (!plannerRateLimit) {
            reconcileRejectedRequest({
                reservedTokens: reservation?.reservedTokens || 0,
                model,
                purpose,
                keyRef,
            });
        }
        const error = new Error(`[${response.status} ${response.statusText}] ${body}`);
        error.status = response.status;
        error.code = parsed?.error?.code || '';
        if (delayMs > 0) error.retryAfterMs = delayMs;
        throw error;
    }

    const error = new Error(`Groq ${purpose} request failed after retries.`);
    error.status = 503;
    throw error;
}

function createGroqChatModel(model, apiKeys, purpose = 'response') {
    const keys = (Array.isArray(apiKeys) ? apiKeys : [apiKeys]).filter(Boolean);
    return {
        async invoke(messages, options = {}) {
            const maxOutputTokens = options.maxOutputTokens || settings.llm.maxOutputTokens;
            const estimatedInputTokens = estimateMessagesTokens(messages);
            const maxCallInputTokens = Math.max(settings.llm.maxCallInputTokens || 0, 0);
            if (maxCallInputTokens > 0 && estimatedInputTokens > maxCallInputTokens) {
                throw new Error(`llm_call_input_too_large estimated=${estimatedInputTokens} limit=${maxCallInputTokens}`);
            }
            const estimatedRequestTokens = estimateRequestCapacity({
                model,
                inputTokens: estimatedInputTokens,
                outputTokens: maxOutputTokens,
                purpose,
            });
            if (estimatedRequestTokens > estimatedInputTokens + maxOutputTokens) {
                logger.info(`Planner capacity estimate raw=${estimatedInputTokens + maxOutputTokens} guarded=${estimatedRequestTokens}.`);
            }
            const requestBody = JSON.stringify({
                model,
                messages: messages.map((message) => ({
                    role: langchainRole(message),
                    content: langchainContent(message),
                })),
                temperature: settings.llm.temperature,
                max_completion_tokens: maxOutputTokens,
                ...(options.json ? { response_format: { type: 'json_object' } } : {}),
            });

            let lastError = null;
            for (const [keyIndex, apiKey] of keys.entries()) {
                try {
                    return await invokeGroqWithKey({
                        model,
                        apiKey,
                        keyRef: keyRefFor(apiKey, keyIndex),
                        keyIndex,
                        hasFallbackKey: keyIndex < keys.length - 1,
                        purpose,
                        requestBody,
                        estimatedRequestTokens,
                    });
                } catch (error) {
                    lastError = error;
                    const canTryNext = keyIndex < keys.length - 1
                        && [429, 503, 401, 403].includes(Number(error.status));
                    if (!canTryNext) throw error;
                    logger.warn(`Groq ${purpose} key ${keyIndex + 1} failed with ${error.status || 'error'}; trying fallback key ${keyIndex + 2}.`);
                }
            }
            throw lastError || new Error(`No Groq ${purpose} API keys are configured.`);
        },
    };
}

function rotateKeys(apiKeys, startIndex = 0) {
    const keys = (Array.isArray(apiKeys) ? apiKeys : [apiKeys]).filter(Boolean);
    if (keys.length <= 1) return keys;
    const offset = ((Math.floor(Number(startIndex) || 0) % keys.length) + keys.length) % keys.length;
    return [...keys.slice(offset), ...keys.slice(0, offset)];
}

function createLlmModel(modelOverride = null, purpose = 'response', options = {}) {
    const model = modelOverride || settings.llm.responseModel;
    const configuredApiKeys = purpose === 'planner'
        ? settings.llm.plannerApiKeys
        : settings.llm.responseApiKeys;
    const apiKeys = rotateKeys(configuredApiKeys, options.keyOffset || 0);
    if (!apiKeys?.length) {
        const variable = purpose === 'planner'
            ? 'GROQ_PLANNER_API_KEY_1 through GROQ_PLANNER_API_KEY_3'
            : 'GROQ_RESPONSE_API_KEY';
        throw new Error(`${variable} is required for the Groq ${purpose} model.`);
    }

    const instance = createGroqChatModel(model, apiKeys, purpose);

    return {
        async invoke(messages, options) {
            return instance.invoke(messages, options);
        },
    };
}

module.exports = {
    createLlmModel,
    estimateRequestCapacity,
    minimumRequestIntervalFor,
    rotateKeys,
};
