const { settings } = require('../config/settings');
const { logger } = require('../utils/logger');

const modelCooldowns = new Map();
const GROQ_CHAT_COMPLETIONS_URL = 'https://api.groq.com/openai/v1/chat/completions';
const RATE_WINDOW_MS = 60 * 1000;

let availableTokens = settings.llm.rateStartFull ? Math.max(settings.llm.tokensPerMinute || 0, 0) : 0;
let availableRequests = settings.llm.rateStartFull ? Math.max(settings.llm.requestsPerMinute || 0, 0) : 0;
let lastRateRefillAt = Date.now();
let lastLlmRequestAt = 0;
let limiterQueue = Promise.resolve();

function uniqueModels(models) {
    return [...new Set(models.filter(Boolean))];
}

function estimateTokens(value) {
    const text = typeof value === 'string' ? value : JSON.stringify(value || '');
    return Math.ceil(text.length / 4);
}

function estimateMessagesTokens(messages) {
    return messages.reduce((total, message) => total + estimateTokens(langchainContent(message)), 0);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error) {
    return String(error?.message || error || '');
}

function isRetryableLlmError(error) {
    const message = errorMessage(error).toLowerCase();
    return message.includes('503')
        || message.includes('service unavailable')
        || message.includes('high demand')
        || message.includes('429')
        || message.includes('resource exhausted')
        || message.includes('rate limit')
        || message.includes('temporarily unavailable');
}

function retryDelayMs(error) {
    if (Number.isFinite(error?.retryAfterMs) && error.retryAfterMs > 0) {
        return error.retryAfterMs;
    }

    const message = errorMessage(error);
    const retryInfoMatch = message.match(/"retryDelay":"([\d.]+)s"/);
    const retryTextMatch = message.match(/retry in ([\d.]+)s/i);
    const seconds = Number(retryInfoMatch?.[1] || retryTextMatch?.[1]);

    if (Number.isFinite(seconds) && seconds > 0) {
        return Math.ceil(seconds * 1000);
    }

    return settings.llm.modelCooldownMs;
}

function summarizeLlmError(error) {
    const message = errorMessage(error);
    const status = message.match(/\[(\d{3}) [^\]]+\]/)?.[1];
    const quota = message.match(/Quota exceeded for metric: ([^,\n]+)/)?.[1];
    const demand = message.includes('high demand') ? 'high demand' : '';

    return [status ? `status ${status}` : null, quota, demand]
        .filter(Boolean)
        .join('; ') || message.split('\n')[0];
}

function coolDownModel(model, error) {
    const delayMs = retryDelayMs(error);
    const until = Date.now() + delayMs;
    modelCooldowns.set(model, until);
    return delayMs;
}

function activeModels(models) {
    const now = Date.now();
    const active = models.filter((model) => (modelCooldowns.get(model) || 0) <= now);
    return active.length > 0 ? active : models;
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

function refillRateBuckets() {
    const now = Date.now();
    const elapsed = Math.max(0, now - lastRateRefillAt);
    lastRateRefillAt = now;

    const tokenLimit = Math.max(settings.llm.tokensPerMinute || 0, 0);
    const requestLimit = Math.max(settings.llm.requestsPerMinute || 0, 0);

    if (tokenLimit > 0) {
        availableTokens = Math.min(tokenLimit, availableTokens + (elapsed * tokenLimit / RATE_WINDOW_MS));
    }

    if (requestLimit > 0) {
        availableRequests = Math.min(requestLimit, availableRequests + (elapsed * requestLimit / RATE_WINDOW_MS));
    }
}

async function reserveLlmCapacity({ estimatedTokens, model }) {
    const tokenLimit = Math.max(settings.llm.tokensPerMinute || 0, 0);
    const requestLimit = Math.max(settings.llm.requestsPerMinute || 0, 0);
    const minIntervalMs = Math.max(settings.llm.minRequestIntervalMs || 0, 0);
    if (tokenLimit <= 0 && requestLimit <= 0 && minIntervalMs <= 0) {
        return { reservedTokens: 0 };
    }

    const reserve = async () => {
        const safety = Math.max(Number(settings.llm.rateSafetyMultiplier || 1), 1);
        const safeEstimate = Math.ceil(Math.max(estimatedTokens, 1) * safety);
        const tokenCost = tokenLimit > 0 ? Math.min(safeEstimate, tokenLimit) : 0;
        const requestCost = requestLimit > 0 ? 1 : 0;

        while (true) {
            refillRateBuckets();
            const tokenReady = tokenLimit <= 0 || availableTokens >= tokenCost;
            const requestReady = requestLimit <= 0 || availableRequests >= requestCost;
            const intervalWait = minIntervalMs > 0
                ? Math.max(0, lastLlmRequestAt + minIntervalMs - Date.now())
                : 0;
            const intervalReady = intervalWait <= 0;

            if (tokenReady && requestReady && intervalReady) {
                if (tokenLimit > 0) availableTokens -= tokenCost;
                if (requestLimit > 0) availableRequests -= requestCost;
                lastLlmRequestAt = Date.now();
                return { reservedTokens: tokenCost };
            }

            const tokenWait = tokenLimit > 0 && !tokenReady
                ? ((tokenCost - availableTokens) / tokenLimit) * RATE_WINDOW_MS
                : 0;
            const requestWait = requestLimit > 0 && !requestReady
                ? ((requestCost - availableRequests) / requestLimit) * RATE_WINDOW_MS
                : 0;
            const waitMs = Math.ceil(Math.max(tokenWait, requestWait, intervalWait, 250));

            logger.warn(`LLM rate guard waiting ${Math.ceil(waitMs / 1000)}s for ${model}; estimated=${estimatedTokens}, reserved=${tokenCost} tokens.`);
            await sleep(waitMs);
        }
    };

    const queued = limiterQueue.then(reserve, reserve);
    limiterQueue = queued.catch(() => {});
    return queued;
}

function reconcileActualUsage({ actualTokens, reservedTokens, model }) {
    const tokenLimit = Math.max(settings.llm.tokensPerMinute || 0, 0);
    if (tokenLimit <= 0 || !Number.isFinite(actualTokens) || actualTokens <= reservedTokens) return;

    const extra = actualTokens - reservedTokens;
    availableTokens = Math.max(0, availableTokens - extra);
    logger.info(`LLM rate guard reconciled ${extra} extra tokens for ${model}; actual=${actualTokens}, reserved=${reservedTokens}.`);
}

function createGroqChatModel(model) {
    return {
        async invoke(messages, options = {}) {
            const maxOutputTokens = options.maxOutputTokens || settings.llm.maxOutputTokens;
            const estimatedRequestTokens = estimateMessagesTokens(messages) + maxOutputTokens;
            const reservation = await reserveLlmCapacity({ estimatedTokens: estimatedRequestTokens, model });

            const response = await fetch(GROQ_CHAT_COMPLETIONS_URL, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${settings.llm.apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model,
                    messages: messages.map((message) => ({
                        role: langchainRole(message),
                        content: langchainContent(message),
                    })),
                    temperature: settings.llm.temperature,
                    max_completion_tokens: maxOutputTokens,
                    ...(options.json ? { response_format: { type: 'json_object' } } : {}),
                }),
            });

            const body = await response.text();
            let parsed = null;
            try {
                parsed = JSON.parse(body);
            } catch (_error) {
                parsed = null;
            }

            if (!response.ok) {
                const error = new Error(`[${response.status} ${response.statusText}] ${body}`);
                const retryAfter = Number(response.headers.get('retry-after'));
                if (Number.isFinite(retryAfter) && retryAfter > 0) {
                    error.retryAfterMs = Math.ceil(retryAfter * 1000);
                }
                throw error;
            }

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
            });

            return result;
        },
    };
}

function createLlmModel() {
    if (!settings.llm.apiKey) {
        throw new Error('GROQ_API_KEY is required for Groq.');
    }

    const models = uniqueModels([
        settings.llm.model,
        ...(settings.llm.fallbackModels || []),
    ]);
    const instances = new Map();

    return {
        async invoke(messages, options) {
            let lastError = null;
            const candidates = activeModels(models);
            const maxRateRetries = Math.max(Math.floor(settings.llm.maxRateRetries || 0), 0);

            for (let index = 0; index < candidates.length; index += 1) {
                const model = candidates[index];
                if (!instances.has(model)) {
                    instances.set(model, createGroqChatModel(model));
                }

                for (let attempt = 0; attempt <= maxRateRetries; attempt += 1) {
                    try {
                        return await instances.get(model).invoke(messages, options);
                    } catch (error) {
                        lastError = error;
                        if (!isRetryableLlmError(error)) throw error;

                        const delayMs = coolDownModel(model, error);
                        const hasNext = index < candidates.length - 1;
                        const canRetrySame = !hasNext && attempt < maxRateRetries;
                        logger.warn(`${settings.llm.provider} model ${model} unavailable (${summarizeLlmError(error)}). Cooling down for ${Math.ceil(delayMs / 1000)}s${hasNext ? '; trying fallback.' : canRetrySame ? '; retrying after delay.' : '.'}`);

                        if (hasNext) break;
                        if (canRetrySame) {
                            await sleep(delayMs);
                            continue;
                        }
                        break;
                    }
                }
            }

            throw lastError;
        },
    };
}

module.exports = { createLlmModel };
