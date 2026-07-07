const { settings } = require('../config/settings');
const { logger } = require('../utils/logger');

const modelCooldowns = new Map();
const GROQ_CHAT_COMPLETIONS_URL = 'https://api.groq.com/openai/v1/chat/completions';

function uniqueModels(models) {
    return [...new Set(models.filter(Boolean))];
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

function createGroqChatModel(model) {
    return {
        async invoke(messages, options = {}) {
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
                    max_completion_tokens: options.maxOutputTokens || settings.llm.maxOutputTokens,
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
                throw new Error(`[${response.status} ${response.statusText}] ${body}`);
            }

            return {
                content: parsed?.choices?.[0]?.message?.content || '',
                usage_metadata: parsed?.usage ? {
                    input_tokens: parsed.usage.prompt_tokens,
                    output_tokens: parsed.usage.completion_tokens,
                    total_tokens: parsed.usage.total_tokens,
                } : undefined,
            };
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

            for (let index = 0; index < candidates.length; index += 1) {
                const model = candidates[index];
                if (!instances.has(model)) {
                    instances.set(model, createGroqChatModel(model));
                }

                try {
                    return await instances.get(model).invoke(messages, options);
                } catch (error) {
                    lastError = error;
                    if (!isRetryableLlmError(error)) throw error;

                    const delayMs = coolDownModel(model, error);
                    const hasNext = index < candidates.length - 1;
                    logger.warn(`${settings.llm.provider} model ${model} unavailable (${summarizeLlmError(error)}). Cooling down for ${Math.ceil(delayMs / 1000)}s${hasNext ? '; trying fallback.' : '.'}`);
                    if (!hasNext) break;
                }
            }

            throw lastError;
        },
    };
}

module.exports = { createLlmModel };
