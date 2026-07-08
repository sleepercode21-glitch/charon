const { settings } = require('../config/settings');
const { logger } = require('../utils/logger');

const GROQ_CHAT_COMPLETIONS_URL = 'https://api.groq.com/openai/v1/chat/completions';
const RATE_WINDOW_MS = 60 * 1000;

let availableTokens = settings.llm.rateStartFull ? Math.max(settings.llm.tokensPerMinute || 0, 0) : 0;
let availableRequests = settings.llm.rateStartFull ? Math.max(settings.llm.requestsPerMinute || 0, 0) : 0;
let lastRateRefillAt = Date.now();
let lastLlmRequestAt = 0;
let limiterQueue = Promise.resolve();

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

function reconcileRejectedRequest({ reservedTokens, model }) {
    const tokenLimit = Math.max(settings.llm.tokensPerMinute || 0, 0);
    if (tokenLimit <= 0 || !reservedTokens) return;
    refillRateBuckets();
    availableTokens = Math.min(tokenLimit, availableTokens + reservedTokens);
    logger.info(`LLM rate guard released ${reservedTokens} reserved tokens for failed ${model} request.`);
}

function createGroqChatModel(model) {
    return {
        async invoke(messages, options = {}) {
            const maxOutputTokens = options.maxOutputTokens || settings.llm.maxOutputTokens;
            const estimatedRequestTokens = estimateMessagesTokens(messages) + maxOutputTokens;
            const reservation = await reserveLlmCapacity({ estimatedTokens: estimatedRequestTokens, model });
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

            let parsed = null;
            for (let attempt = 0; attempt < 2; attempt += 1) {
                const response = await fetch(GROQ_CHAT_COMPLETIONS_URL, {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${settings.llm.apiKey}`,
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

                if (response.ok) break;

                const delayMs = retryDelayFromGroq({ response, parsed });
                if ((response.status === 429 || response.status === 503) && attempt === 0 && delayMs > 0 && delayMs <= 65_000) {
                    logger.warn(`Groq asked Charon to wait ${Math.ceil(delayMs / 1000)}s for ${model}; retrying once.`);
                    await sleep(delayMs + 250);
                    continue;
                }

                reconcileRejectedRequest({
                    reservedTokens: reservation?.reservedTokens || 0,
                    model,
                });
                const error = new Error(`[${response.status} ${response.statusText}] ${body}`);
                if (delayMs > 0) error.retryAfterMs = delayMs;
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

    const model = settings.llm.model;
    const instance = createGroqChatModel(model);

    return {
        async invoke(messages, options) {
            return instance.invoke(messages, options);
        },
    };
}

module.exports = { createLlmModel };
