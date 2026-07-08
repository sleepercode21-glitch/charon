const { Annotation, END, START, StateGraph } = require('@langchain/langgraph');
const { HumanMessage, SystemMessage } = require('@langchain/core/messages');
const { settings } = require('../../config/settings');
const { createLlmModel } = require('../../models/llmWrapper');
const { CHARON_SYSTEM_PROMPT } = require('../../models/prompts/charonSystemPrompt');
const { CHARON_RESPONSE_PROMPT } = require('../../models/prompts/responsePrompt');
const { CHARON_SITUATION_PROMPT } = require('../../models/prompts/situationPrompt');
const { extractJson } = require('../../utils/json');
const { logger } = require('../../utils/logger');
const { compactContext, estimateTokens } = require('../../utils/tokenBudget');
const { extractTimezone, normalizeTimezone, parseDate } = require('../../utils/time');
const { announceToGroup } = require('../tools/announcement');
const { cancelActiveItem } = require('../tools/cancellation');
const { markDone } = require('../tools/completion');
const { listActiveItems } = require('../tools/listing');
const { createStandaloneReminder } = require('../tools/reminder');
const { scheduleMeeting } = require('../tools/scheduler');
const { updateActiveItem } = require('../tools/update');

const ACTION_INTENTS = new Set(['schedule', 'reminder', 'update', 'cancel', 'complete', 'list', 'announce']);
const KNOWN_INTENTS = new Set([...ACTION_INTENTS, 'answer', 'refuse']);
const DB_TOOL_NAMES = new Set(['list_active_items', 'get_active_item']);
const MAX_DB_TOOL_STEPS = 3;
const TOOLBELT = [
    {
        intent: 'schedule',
        does: 'Create or reuse a Google Meet session, store it, and let reminder worker notify before it starts.',
        needs: ['title/topic', 'date', 'time', 'timezone'],
        outputs: ['schedule id', 'when', 'Meet link'],
    },
    {
        intent: 'reminder',
        does: 'Create a standalone text reminder for the group.',
        needs: ['reminder text', 'date', 'time', 'timezone'],
        outputs: ['reminder id', 'when'],
    },
    {
        intent: 'update',
        does: 'Change an active meeting or reminder.',
        needs: ['target id/title/reference', 'new title/text/date/time/timezone'],
        outputs: ['updated item'],
    },
    {
        intent: 'cancel',
        does: 'Cancel active meetings and/or reminders.',
        needs: ['target id/title/reference or kind all'],
        outputs: ['cancelled counts'],
    },
    {
        intent: 'complete',
        does: 'Mark an active meeting or reminder done.',
        needs: ['target id/title/reference'],
        outputs: ['completed item'],
    },
    {
        intent: 'list',
        does: 'List active meetings/reminders, counts, ids, times, and links.',
        needs: ['kind or target when known'],
        outputs: ['active item summaries'],
    },
    {
        intent: 'announce',
        does: 'Tag everyone in the group with a message.',
        needs: ['announcement text'],
        outputs: ['announcement sent'],
    },
    {
        intent: 'answer',
        does: 'Chat, explain, joke, summarize, brainstorm, answer technical questions, or describe Charon.',
        needs: ['useful reply substance'],
        outputs: ['reply'],
    },
];

const COMMAND_TIME_FORMAT = 'YYYY-MM-DD HH:MM Area/City';
const COMMAND_SCHEDULE_USAGE = `new schedule: Title, ${COMMAND_TIME_FORMAT}`;
const COMMAND_REMINDER_USAGE = `new reminder: Text, ${COMMAND_TIME_FORMAT}`;
const COMMAND_SCHEDULE_EXAMPLE = 'new schedule: Banking system design, 2026-07-09 20:00 America/Chicago';
const COMMAND_REMINDER_EXAMPLE = 'new reminder: Submit slides, 2026-07-09 18:30 Asia/Kolkata';
const COMMAND_HELP = [
    'Charon command mode, sir',
    '',
    'Create',
    COMMAND_SCHEDULE_USAGE,
    COMMAND_REMINDER_USAGE,
    '',
    'Examples',
    COMMAND_SCHEDULE_EXAMPLE,
    COMMAND_REMINDER_EXAMPLE,
    '',
    'Show',
    'show schedules',
    'show reminders',
    'show all',
    '',
    'Update',
    `move schedule <id>: ${COMMAND_TIME_FORMAT}`,
    `move reminder <id>: ${COMMAND_TIME_FORMAT}`,
    'rename schedule <id>: New title',
    'rename reminder <id>: New reminder text',
    '',
    'Finish or cancel',
    'done schedule <id>',
    'done reminder <id>',
    'cancel schedule <id>',
    'cancel reminder <id>',
    'cancel all',
    '',
    'Help',
    'help',
    '',
    'Concrete time only',
    COMMAND_TIME_FORMAT,
    'Also accepted: MM-DD-YY HH:MM Area/City',
].join('\n');

const CharonState = Annotation.Root({
    input: Annotation({ reducer: (_left, right) => right, default: () => ({}) }),
    context: Annotation({ reducer: (_left, right) => right, default: () => ({}) }),
    situation: Annotation({ reducer: (_left, right) => right, default: () => ({}) }),
    plan: Annotation({ reducer: (_left, right) => right, default: () => ({}) }),
    decision: Annotation({ reducer: (_left, right) => right, default: () => ({}) }),
    timeResolution: Annotation({ reducer: (_left, right) => right, default: () => ({}) }),
    actionResult: Annotation({ reducer: (_left, right) => right, default: () => ({}) }),
    reply: Annotation({ reducer: (_left, right) => right, default: () => '' }),
    nextStep: Annotation({ reducer: (_left, right) => right, default: () => 'respond' }),
});

function chatId(chat) {
    return chat?.id?._serialized || chat?.id || '';
}

function messageText(message) {
    return [
        message?.body,
        message?.pollName,
        message?.caption,
        message?._data?.body,
        message?._data?.pollName,
        message?._data?.caption,
    ].filter(Boolean).join(' ').trim();
}

function currentDateContext(timezone) {
    const now = new Date();
    const local = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        weekday: 'short',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZoneName: 'short',
    }).format(now);

    return `${local}|${now.toISOString()}`;
}

function withoutCurrentMessage(context, message) {
    const messageId = message?.id?._serialized || message?.id || '';
    if (!messageId || !Array.isArray(context.messages)) return context;

    return {
        ...context,
        messages: context.messages.filter((item) => item.messageId !== messageId),
    };
}

function safeJson(text) {
    try {
        return extractJson(text) || null;
    } catch (error) {
        logger.warn('LLM returned invalid JSON.', error);
        return null;
    }
}

function logModelUsage(label, response, estimatedInputTokens) {
    const usage = response.usage_metadata || response.usageMetadata;
    const actual = usage ? ` actual=${JSON.stringify(usage)}` : '';
    logger.info(`${label} token estimate input=${estimatedInputTokens}.${actual}`);
}

function logJson(label, value) {
    try {
        logger.info(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
    } catch (_error) {
        logger.info(`${label}: [unserializable]`);
    }
}

function cleanCommandText(value) {
    return String(value || '')
        .replace(/@\d+(?:@\S+)?/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function commandCreateUsageReply(kind = 'schedule') {
    if (kind === 'reminder') {
        return `Use: ${COMMAND_REMINDER_USAGE}\nExample: ${COMMAND_REMINDER_EXAMPLE}`;
    }

    return `Use: ${COMMAND_SCHEDULE_USAGE}\nExample: ${COMMAND_SCHEDULE_EXAMPLE}`;
}

function parseConcreteCommandWhen(value) {
    const text = String(value || '').trim();
    const match = text.match(/^(?:(\d{4})-(\d{2})-(\d{2})|(\d{2})[/-](\d{2})[/-](\d{2}|\d{4}))\s+([01]\d|2[0-3]):([0-5]\d)\s+([A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+)+|UTC)$/);
    if (!match) return null;

    const isoYear = match[1];
    const isoMonth = match[2];
    const isoDay = match[3];
    const shortMonth = match[4];
    const shortDay = match[5];
    const shortYear = match[6];
    const hour = match[7];
    const minute = match[8];
    const timezoneText = match[9];
    const month = isoMonth || shortMonth;
    const day = isoDay || shortDay;
    const year = isoYear || shortYear;
    const fullYear = year.length === 2 ? 2000 + Number(year) : Number(year);
    const date = new Date(Date.UTC(fullYear, Number(month) - 1, Number(day), Number(hour), Number(minute)));
    const isValidDate = date.getUTCFullYear() === fullYear
        && date.getUTCMonth() === Number(month) - 1
        && date.getUTCDate() === Number(day);
    const timezone = normalizeTimezone(timezoneText, null);

    if (!isValidDate || !timezone) return null;

    return {
        date: `${month}/${day}/${year}`,
        time: `${hour}:${minute}`,
        timezone,
    };
}

function parseCreatePayload(value) {
    const text = String(value || '').trim();
    if (!text) return { title: '', whenInput: '' };

    if (text.includes('|')) {
        const parts = text.split('|').map((part) => part.trim()).filter(Boolean);
        return {
            title: parts[0] || '',
            whenInput: parts.length >= 4 ? `${parts[1]} ${parts[2]} ${parts[3]}` : parts[1] || '',
        };
    }

    const commaParts = text.split(',').map((part) => part.trim()).filter(Boolean);
    if (commaParts.length >= 2) {
        return {
            title: commaParts.slice(0, -1).join(', '),
            whenInput: commaParts[commaParts.length - 1],
        };
    }

    const whenMatch = text.match(/^(.*?)\s+((?:\d{4}-\d{2}-\d{2}|\d{2}[/-]\d{2}[/-](?:\d{2}|\d{4}))\s+[0-2]\d:[0-5]\d\s+\S+)$/);
    return {
        title: whenMatch ? whenMatch[1].trim() : '',
        whenInput: whenMatch ? whenMatch[2].trim() : '',
    };
}

function planForCreate(createKind, payload) {
    const { title, whenInput } = parseCreatePayload(payload);
    const parsedWhen = parseConcreteCommandWhen(whenInput);

    if (!title || !parsedWhen) {
        return {
            intent: 'answer',
            reply: commandCreateUsageReply(createKind),
            source: 'command',
        };
    }

    if (createKind === 'reminder') {
        return {
            intent: 'reminder',
            text: title,
            date: parsedWhen.date,
            time: parsedWhen.time,
            timezone: parsedWhen.timezone,
            source: 'command',
            ask: '',
        };
    }

    return {
        intent: 'schedule',
        title,
        text: title,
        date: parsedWhen.date,
        time: parsedWhen.time,
        timezone: parsedWhen.timezone,
        source: 'command',
        ask: '',
    };
}

function parseKindAndTarget(value, { allowAll = false } = {}) {
    const text = String(value || '').trim();
    const match = text.match(/^(schedule(?:s)?|meeting(?:s)?|session(?:s)?|reminder(?:s)?|all)\b\s*([\s\S]*)$/i);
    if (!match) return null;

    const rawKind = match[1].toLowerCase();
    if (rawKind === 'all' && !allowAll) return null;

    return {
        rawKind,
        kind: rawKind === 'all' ? '' : normalizedKind(rawKind, rawKind),
        target: match[2].trim(),
    };
}

function parseManualCommandPlan(body) {
    const text = String(body || '').trim();
    const lower = text.toLowerCase();

    if (lower === 'help' || lower === 'commands' || lower === 'command mode') {
        return {
            intent: 'answer',
            reply: COMMAND_HELP,
            source: 'command',
        };
    }

    const createMatch = text.match(/^(?:new|create|add)\s+(schedule|meeting|session|reminder)\s*:\s*([\s\S]+)$/i);
    if (createMatch) {
        const createKind = /^reminder$/i.test(createMatch[1]) ? 'reminder' : 'schedule';
        return planForCreate(createKind, createMatch[2]);
    }

    const listMatch = text.match(/^(?:show|list)\s+(schedules?|meetings?|sessions?|reminders?|all)\s*$/i);
    if (listMatch) {
        const rawKind = listMatch[1].toLowerCase();
        return {
            intent: 'list',
            kind: rawKind === 'all' ? '' : normalizedKind(rawKind, rawKind),
            target: '',
            source: 'command',
        };
    }

    const cancelMatch = text.match(/^(?:cancel|delete|remove)\s+([\s\S]+)$/i);
    if (cancelMatch) {
        const parsed = parseKindAndTarget(cancelMatch[1], { allowAll: true });
        if (!parsed) {
            return {
                intent: 'answer',
                reply: `Use cancel schedule <id>, cancel reminder <id>, or cancel all, sir.\n\n${COMMAND_HELP}`,
                source: 'command',
            };
        }

        if (!parsed.target && parsed.rawKind !== 'all') {
            return {
                intent: 'answer',
                reply: `Give me the id, sir.\nUse show schedules or show reminders first.`,
                source: 'command',
            };
        }

        return {
            intent: 'cancel',
            kind: parsed.kind,
            target: parsed.target,
            source: 'command',
            reply: '',
        };
    }

    const doneMatch = text.match(/^(?:done|complete|finish)\s+([\s\S]+)$/i);
    if (doneMatch) {
        const parsed = parseKindAndTarget(doneMatch[1]);
        if (!parsed?.target) {
            return {
                intent: 'answer',
                reply: `Use done schedule <id> or done reminder <id>, sir.\n\n${COMMAND_HELP}`,
                source: 'command',
            };
        }

        return {
            intent: 'complete',
            kind: parsed.kind,
            target: parsed.target,
            source: 'command',
        };
    }

    const moveMatch = text.match(/^(?:move|reschedule|change time)\s+(.+?)\s*:\s*([\s\S]+)$/i);
    if (moveMatch) {
        const parsed = parseKindAndTarget(moveMatch[1]);
        const parsedWhen = parseConcreteCommandWhen(moveMatch[2]);
        if (!parsed?.target || !parsedWhen) {
            return {
                intent: 'answer',
                reply: `Use move schedule <id>: ${COMMAND_TIME_FORMAT}\nExample: move schedule a1b2c3: 2026-07-09 20:00 America/Chicago`,
                source: 'command',
            };
        }

        return {
            intent: 'update',
            kind: parsed.kind,
            target: parsed.target,
            date: parsedWhen.date,
            time: parsedWhen.time,
            timezone: parsedWhen.timezone,
            source: 'command',
        };
    }

    const renameMatch = text.match(/^(?:rename|retitle|change title)\s+(.+?)\s*:\s*([\s\S]+)$/i);
    if (renameMatch) {
        const parsed = parseKindAndTarget(renameMatch[1]);
        const title = renameMatch[2].trim();
        if (!parsed?.target || !title) {
            return {
                intent: 'answer',
                reply: 'Use rename schedule <id>: New title or rename reminder <id>: New reminder text, sir.',
                source: 'command',
            };
        }

        return {
            intent: 'update',
            kind: parsed.kind,
            target: parsed.target,
            title,
            text: title,
            source: 'command',
        };
    }

    return null;
}

function parseCommandPlan(rawText) {
    const body = cleanCommandText(rawText);
    const manualPlan = parseManualCommandPlan(body);
    if (manualPlan) return manualPlan;

    const match = body.match(/(?:^|\s)\/(\w+)\b\s*([\s\S]*)$/);
    if (!match) return null;

    const command = match[1].toLowerCase();
    const tail = String(match[2] || '').trim();
    if (command === 'help') {
        return {
            intent: 'answer',
            reply: COMMAND_HELP,
            source: 'command',
        };
    }

    if (command === 'create') {
        const createMatch = tail.match(/^(schedule(?:s)?|reminder(?:s)?)\b\s*([\s\S]*)$/i);
        if (!createMatch) {
            return {
                intent: 'answer',
                reply: `Use new schedule: ... or new reminder: ..., sir.\n\n${COMMAND_HELP}`,
                source: 'command',
            };
        }

        const createKind = /^reminder/i.test(createMatch[1]) ? 'reminder' : 'schedule';
        return planForCreate(createKind, createMatch[2]);
    }

    if (command === 'list') {
        const listMatch = tail.match(/^(schedules?|meetings?|sessions?|reminders?|all)\b/i);
        if (!listMatch) {
            return {
                intent: 'answer',
                reply: `Use show schedules, show reminders, or show all, sir.\n\n${COMMAND_HELP}`,
                source: 'command',
            };
        }

        const listKindText = listMatch[1].toLowerCase();
        return {
            intent: 'list',
            kind: listKindText === 'all'
                ? ''
                : normalizedKind(listKindText, listKindText),
            target: tail,
            source: 'command',
        };
    }

    if (command === 'cancel') {
        const cancelMatch = tail.match(/^(schedule(?:s)?|meeting(?:s)?|session(?:s)?|reminder(?:s)?|all)\b\s*([\s\S]*)$/i);
        if (!cancelMatch) {
            return {
                intent: 'answer',
                reply: `Use cancel schedule <id>, cancel reminder <id>, or cancel all, sir.\n\n${COMMAND_HELP}`,
                source: 'command',
            };
        }

        const cancelKindText = cancelMatch[1].toLowerCase();
        const target = cancelMatch[2].trim();
        const kind = cancelKindText === 'all'
            ? ''
            : normalizedKind(cancelKindText, cancelKindText);

        if (!target && cancelKindText !== 'all') {
            return {
                intent: 'answer',
                reply: `Give me the id, sir.\nUse show schedules or show reminders first.`,
                source: 'command',
            };
        }

        return {
            intent: 'cancel',
            kind,
            target,
            source: 'command',
            reply: '',
        };
    }

    return {
        intent: 'answer',
        reply: `Unknown command, sir.\n${COMMAND_HELP}`,
        source: 'command',
    };
}

function uniqueEmails(values = []) {
    return [...new Set(values
        .map((value) => String(value?.email || value || '').trim())
        .filter((value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)))];
}

function normalizedIntent(value) {
    const intent = String(value || '').toLowerCase();
    return KNOWN_INTENTS.has(intent) ? intent : 'answer';
}

function normalizedSituationIntent(value) {
    const intent = String(value || '').toLowerCase();
    return KNOWN_INTENTS.has(intent) ? intent : '';
}

function normalizedKind(value, text = '') {
    const raw = String(value || '').toLowerCase();
    const body = String(text || '').toLowerCase();
    const hasReminder = /\breminders?\b/.test(body);
    const hasMeeting = /\b(meetings?|meeings?|meets?|sessions?)\b/.test(body);

    if (raw.includes('|') && raw.includes('meeting') && raw.includes('reminder')) {
        if (hasReminder && !hasMeeting) return 'reminder';
        if (hasMeeting && !hasReminder) return 'meeting';
        return null;
    }
    if (['meeting', 'meetings', 'meeing', 'meeings', 'meet', 'meets', 'schedule', 'schedules', 'session', 'sessions'].includes(raw)) return 'meeting';
    if (['reminder', 'reminders'].includes(raw)) return 'reminder';
    if (['all', 'both', 'everything', ''].includes(raw)) {
        if (hasReminder && !hasMeeting) return 'reminder';
        if (hasMeeting && !hasReminder) return 'meeting';
        return null;
    }
    return null;
}

function cleanHint(value, max = 220) {
    return trimText(value, max);
}

function comparableWords(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/@\d+(?:@\S+)?/g, ' ')
        .replace(/[^a-z0-9]+/g, ' ')
        .split(/\s+/)
        .filter((word) => word.length > 2);
}

function wordOverlapScore(left, right) {
    const leftWords = new Set(comparableWords(left));
    const rightWords = new Set(comparableWords(right));
    if (leftWords.size === 0 || rightWords.size === 0) return 1;

    let overlap = 0;
    for (const word of leftWords) {
        if (rightWords.has(word)) overlap += 1;
    }

    return overlap / Math.min(leftWords.size, rightWords.size);
}

function situationDetachedFromCurrentMessage(situation, body) {
    const ask = String(situation?.currentAsk || '').trim();
    const current = String(body || '').trim();
    if (!ask || !current) return false;

    const normalizedAsk = comparableWords(ask).join(' ');
    const normalizedCurrent = comparableWords(current).join(' ');
    if (!normalizedAsk || !normalizedCurrent) return false;
    if (normalizedAsk.includes(normalizedCurrent) || normalizedCurrent.includes(normalizedAsk)) return false;

    return wordOverlapScore(normalizedAsk, normalizedCurrent) < 0.35;
}

function fillPlanFromSituation(plan, situation) {
    const next = { ...plan };
    const intent = normalizedSituationIntent(situation?.primaryIntent);
    const kindHint = normalizedKind(situation?.kindHint, situation?.kindHint) || String(situation?.kindHint || '');
    const existingKind = normalizedKind(next.kind, next.kind);

    if (!next.title && situation?.titleHint) next.title = cleanHint(situation.titleHint, 120);
    if (!next.text && situation?.textHint) next.text = cleanHint(situation.textHint, 220);
    if (!next.target && situation?.targetHint) next.target = cleanHint(situation.targetHint, 120);
    if (!next.date && situation?.dateHint) next.date = cleanHint(situation.dateHint, 80);
    if (!next.time && situation?.timeHint) next.time = cleanHint(situation.timeHint, 80);
    if (!next.timezone && situation?.timezoneHint) next.timezone = cleanHint(situation.timezoneHint, 80);
    if (existingKind) next.kind = existingKind;
    if (!existingKind && kindHint) next.kind = kindHint;

    if (intent === 'reminder' && !next.text) {
        next.text = cleanHint(situation?.titleHint || situation?.currentAsk || next.title || 'Reminder', 220);
    }

    if (intent === 'schedule' && !next.title) {
        next.title = cleanHint(situation?.textHint || situation?.currentAsk || 'Tech Up session', 120);
    }

    return next;
}

function alignPlanWithSituation(plan, situation) {
    const situationIntent = normalizedSituationIntent(situation?.primaryIntent);
    const confidence = Number(situation?.confidence || 0);
    if (!situationIntent || confidence < 0.72) return plan;

    const plannerIntent = normalizedIntent(plan.intent);
    if (plannerIntent === situationIntent) {
        return fillPlanFromSituation(plan, situation);
    }

    if (['cancel', 'update', 'complete', 'list', 'announce'].includes(plannerIntent)) {
        return plan;
    }

    const canSituationOverride = (
        ['answer', 'refuse'].includes(plannerIntent) && ACTION_INTENTS.has(situationIntent)
    ) || (
        ['schedule', 'reminder'].includes(plannerIntent)
        && ['schedule', 'reminder', 'cancel', 'update', 'complete', 'list'].includes(situationIntent)
    );

    if (!canSituationOverride) return plan;

    return fillPlanFromSituation({
        ...plan,
        intent: situationIntent,
        source: `${plan.source || 'llm'}+situation`,
    }, situation);
}

function normalizedToolKind(value) {
    const kind = normalizedKind(value, value);
    return kind || '';
}

function shortId(value) {
    return String(value || '').slice(-6);
}

function trimText(value, max = 180) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

function inferPendingKind(text) {
    const value = String(text || '').toLowerCase();
    if (/\breminders?\b/.test(value)) return 'reminder';
    if (/\b(meetings?|meets?|sessions?|schedules?)\b/.test(value)) return 'meeting';
    if (/\b(cancel|delete|clear|remove)\b/.test(value)) return 'cancel';
    if (/\b(move|reschedule|update|change)\b/.test(value)) return 'update';
    return '';
}

function pendingClarification(context, message) {
    const messages = withoutCurrentMessage(context, message).messages || [];
    const askIndex = [...messages].reverse().findIndex((item) => {
        if (!item.isFromMe) return false;
        const body = String(item.body || '').toLowerCase();
        return body.includes('?')
            || /\b(need|provide|confirm|which|what|when|date|time|timezone|time zone|id|title)\b/.test(body);
    });

    if (askIndex < 0) return null;

    const actualIndex = messages.length - 1 - askIndex;
    const ask = messages[actualIndex];
    const newerBotAnswer = messages.slice(actualIndex + 1).some((item) => item.isFromMe);
    if (newerBotAnswer) return null;

    const priorUser = [...messages.slice(0, actualIndex)].reverse().find((item) => !item.isFromMe);
    const combined = `${priorUser?.body || ''} ${ask.body || ''}`;

    return {
        kind: inferPendingKind(combined),
        asked: trimText(ask.body, 150),
        about: trimText(priorUser?.body || '', 180),
    };
}

function dbItemSummary(active) {
    const item = active.item || {};
    if (active.type === 'meeting') {
        return {
            id: shortId(item._id),
            kind: 'meeting',
            title: item.title || 'Meeting',
            when: item.start ? new Date(item.start).toISOString() : '',
            timezone: item.timezone || settings.timezone,
            meetLink: item.meetLink || '',
            status: item.status || '',
        };
    }

    return {
        id: shortId(item._id),
        kind: 'reminder',
        text: item.text || 'Reminder',
        when: item.dueAt ? new Date(item.dueAt).toISOString() : '',
        timezone: item.timezone || settings.timezone,
        status: item.status || '',
    };
}

function compactForPlanner(context, message) {
    return compactContext(withoutCurrentMessage(context, message), {
        maxTokens: settings.llm.contextTokenBudget,
        maxMessages: settings.llm.maxContextMessages,
        minMessages: 4,
        maxTextChars: 180,
        maxPolls: settings.llm.maxContextPolls,
        maxMeetings: 8,
        maxReminders: 8,
        includeBotMessages: true,
    });
}

function plannerPayload({ input, context, situation = null }) {
    const message = input.message;
    const compact = compactForPlanner(context, message);
    const body = messageText(message);

    return JSON.stringify({
        now: currentDateContext(input.timezone),
        defaultTz: input.timezone,
        room: {
            chatId: chatId(input.chat),
            chatName: input.chat?.name || '',
            replyMode: settings.whatsapp.replyMode,
            groupScope: settings.whatsapp.groupScope,
        },
        message: {
            id: message?.id?._serialized || message?.id || '',
            type: message?.type || '',
            timestamp: message?.timestamp ? new Date(message.timestamp * 1000).toISOString() : '',
            author: message?.author || message?.from || '',
            fromMe: Boolean(message?.fromMe),
        },
        quoted: input.quoted || null,
        requester: input.storedMessage?.senderName || message.author || message.from || 'unknown',
        msg: body,
        pending: pendingClarification(context, message),
        situation,
        toolbelt: TOOLBELT,
        ctx: JSON.parse(compact.json),
        budget: {
            ctxTokens: compact.estimatedTokens,
            omittedOlderMessages: compact.omitted?.olderMessages || 0,
        },
    });
}

function situationPayload({ input, context }) {
    const base = JSON.parse(plannerPayload({ input, context }));
    delete base.situation;
    return JSON.stringify({
        ...base,
        objective: 'Read the current room state and classify what Charon should do next. Do not call tools.',
    });
}

function plannerLoopPayload({ input, context, dbResults, situation }) {
    const base = JSON.parse(plannerPayload({ input, context, situation }));
    return JSON.stringify({
        ...base,
        db: dbResults,
        tools: [
            {
                name: 'list_active_items',
                args: {
                    kind: 'meeting|reminder|all|',
                    target: 'optional id/title/search text',
                    limit: '1-5',
                },
            },
            {
                name: 'get_active_item',
                args: {
                    kind: 'meeting|reminder|all|',
                    target: 'required id/title/search text',
                },
            },
        ],
    });
}

async function runPlannerDbTool({ toolCall, chatId: id, messageStore }) {
    const tool = String(toolCall?.tool || '');
    const args = toolCall?.args || {};
    if (!DB_TOOL_NAMES.has(tool)) {
        return {
            tool,
            ok: false,
            error: 'unknown_db_tool',
        };
    }

    const kind = normalizedToolKind(args.kind);
    const target = String(args.target || '').trim();
    const requestedLimit = Number(args.limit);
    const limit = tool === 'get_active_item'
        ? 1
        : Number.isInteger(requestedLimit) && requestedLimit > 0
            ? Math.min(requestedLimit, 5)
            : 5;

    if (tool === 'get_active_item' && !target) {
        return {
            tool,
            ok: false,
            error: 'target_required',
        };
    }

    const items = await messageStore.findActiveItems({
        chatId: id,
        kind,
        target: target || null,
        limit,
    });

    return {
        tool,
        ok: true,
        args: {
            kind: kind || 'all',
            target,
            limit,
        },
        count: items.length,
        items: items.slice(0, limit).map(dbItemSummary),
    };
}

function dbToolKey(toolCall) {
    const tool = String(toolCall?.tool || '');
    const args = toolCall?.args || {};
    return JSON.stringify({
        tool,
        kind: normalizedToolKind(args.kind) || 'all',
        target: String(args.target || '').trim().toLowerCase(),
        limit: tool === 'get_active_item' ? 1 : Math.min(Number(args.limit) || 5, 5),
    });
}

function planFromRepeatedDbTool(dbResults) {
    const result = [...dbResults].reverse().find((item) => item?.ok && item.items?.[0]);
    const item = result?.items?.[0];
    if (!item) {
        return {
            intent: 'answer',
            reply: 'I already checked that database path, sir. Send me the schedule or reminder id and I will act on it.',
        };
    }

    return {
        intent: 'list',
        kind: item.kind || result.args?.kind || 'all',
        target: item.id || result.args?.target || '',
        reply: '',
    };
}

function fallbackSituation(body) {
    return {
        primaryIntent: 'answer',
        confidence: 0.45,
        currentAsk: trimText(body, 220),
        focus: 'current_message',
        useQuoted: false,
        needsDb: false,
        titleHint: '',
        textHint: trimText(body, 220),
        targetHint: '',
        dateHint: '',
        timeHint: '',
        timezoneHint: '',
        kindHint: '',
        missing: '',
        ignore: '',
        why: 'Fallback situation after unreadable LLM output.',
    };
}

function normalizeSituation(raw, body) {
    const situation = raw && typeof raw === 'object' ? raw : {};
    const detached = situationDetachedFromCurrentMessage(situation, body);
    const intent = detached ? 'answer' : normalizedSituationIntent(situation.primaryIntent) || 'answer';
    const confidence = Math.max(0, Math.min(1, Number(situation.confidence || 0)));

    if (detached) {
        logger.warn(`Situation output looked stale; demoting it. current="${trimText(body, 90)}" situationAsk="${trimText(situation.currentAsk, 90)}"`);
    }

    return {
        primaryIntent: intent,
        confidence: detached ? Math.min(confidence, 0.35) : confidence,
        currentAsk: cleanHint(detached ? body : situation.currentAsk || body, 240),
        focus: cleanHint(detached ? 'current_message' : situation.focus || 'current_message', 60),
        useQuoted: detached ? false : Boolean(situation.useQuoted),
        needsDb: detached ? false : Boolean(situation.needsDb),
        titleHint: cleanHint(detached ? '' : situation.titleHint || '', 140),
        textHint: cleanHint(detached ? '' : situation.textHint || '', 260),
        targetHint: cleanHint(detached ? '' : situation.targetHint || '', 160),
        dateHint: cleanHint(detached ? '' : situation.dateHint || '', 80),
        timeHint: cleanHint(detached ? '' : situation.timeHint || '', 80),
        timezoneHint: cleanHint(detached ? '' : situation.timezoneHint || '', 80),
        kindHint: cleanHint(detached ? '' : situation.kindHint || '', 40),
        missing: cleanHint(situation.missing || '', 140),
        ignore: cleanHint(detached ? 'stale situation output ignored' : situation.ignore || '', 180),
        why: cleanHint(detached ? 'Situation currentAsk did not match the actual current message.' : situation.why || '', 220),
    };
}

function hasTimeRequest(plan) {
    return Boolean(plan.date || plan.time);
}

function whenText(plan, fallbackText = '') {
    if (!plan.date && !plan.time) return '';
    return [plan.date, plan.time, plan.timezone].filter(Boolean).join(' ').trim();
}

function timeResolutionForPlan(plan, body) {
    const intent = normalizedIntent(plan.intent);
    let when = whenText(plan);
    if (!when && ACTION_INTENTS.has(intent)) {
        when = String(body || '');
    }
    const timezone = normalizeTimezone(plan.timezone, extractTimezone(`${when} ${body}`, settings.timezone));
    const parsed = when ? parseDate(when, new Date(), timezone) : null;

    if (parsed) {
        return {
            status: 'resolved',
            start: parsed.toISOString(),
            end: null,
            dueAt: intent === 'reminder' ? parsed.toISOString() : null,
            timezone,
            source: 'planner',
            confidence: 0.85,
            clarification: null,
            reason: '',
        };
    }

    if (intent === 'reminder') {
        return {
            status: 'needs_clarification',
            start: null,
            end: null,
            dueAt: null,
            timezone,
            source: 'none',
            confidence: 0.5,
            clarification: plan.ask || 'When should I remind the group?',
            reason: 'Missing reminder time.',
        };
    }

    if (intent === 'schedule' && plan.ask && !hasTimeRequest(plan)) {
        return {
            status: 'needs_clarification',
            start: null,
            end: null,
            dueAt: null,
            timezone,
            source: 'none',
            confidence: 0.5,
            clarification: plan.ask,
            reason: 'Planner requested schedule clarification.',
        };
    }

    if (intent === 'update' && plan.ask && !hasTimeRequest(plan)) {
        return {
            status: 'needs_clarification',
            start: null,
            end: null,
            dueAt: null,
            timezone,
            source: 'none',
            confidence: 0.5,
            clarification: plan.ask,
            reason: 'Planner requested update clarification.',
        };
    }

    return {
        status: 'not_needed',
        start: null,
        end: null,
        dueAt: null,
        timezone,
        source: 'none',
        confidence: 0.7,
        clarification: null,
        reason: '',
    };
}

function cancellationCalls(kind, target) {
    const query = target || null;
    if (kind === 'meeting') {
        return [{ name: 'cancelMeetings', arguments: { query, limit: null } }];
    }

    if (kind === 'reminder') {
        return [{ name: 'cancelReminders', arguments: { query, limit: null } }];
    }

    return [
        { name: 'cancelMeetings', arguments: { query, limit: null } },
        { name: 'cancelReminders', arguments: { query, limit: null } },
    ];
}

function planToDecision(plan, body) {
    const intent = normalizedIntent(plan.intent);
    const text = String(plan.text || plan.title || plan.target || '').trim();
    const target = String(plan.target || '').trim();
    const kind = normalizedKind(plan.kind, `${body} ${text} ${target}`);
    const when = whenText(plan);
    const timezone = plan.timezone || '';
    const decision = {
        intent,
        shouldReply: true,
        reason: String(plan.reason || ''),
    };

    if (intent === 'schedule') {
        decision.meeting = {
            title: plan.title || text || 'Tech Up meetup',
            description: plan.text || plan.title || '',
            start: when,
            end: '',
            timezone,
            attendees: uniqueEmails(plan.attendees || []),
            confidence: 0.85,
        };
    } else if (intent === 'reminder') {
        decision.reminder = {
            text: plan.text || plan.title || target || 'Reminder',
            dueAt: when,
            timezone,
            confidence: 0.85,
        };
    } else if (intent === 'update') {
        decision.update = {
            target: target || plan.title || 'last meeting',
            title: plan.title || '',
            description: plan.text || '',
            text: plan.text || '',
            start: when,
            dueAt: when,
            timezone,
            confidence: 0.85,
        };
    } else if (intent === 'cancel') {
        decision.cancellation = {
            toolCalls: cancellationCalls(kind, target),
            target,
            query: target,
            confidence: 0.85,
        };
    } else if (intent === 'complete') {
        decision.completion = {
            target: target || text,
            confidence: 0.85,
        };
    } else if (intent === 'list') {
        decision.list = {
            kind,
            target,
            confidence: 0.85,
        };
    } else if (intent === 'announce') {
        decision.announcement = {
            text: plan.text || 'Attention, please.',
            confidence: 0.85,
        };
    } else if (intent === 'answer' || intent === 'refuse') {
        decision.response = plan.reply || plan.text || '';
    }

    return decision;
}

function staleSchedulingOnlyAnswer(value) {
    const text = String(value || '').toLowerCase();
    return text.includes('not within my capabilities')
        || text.includes('only') && text.includes('scheduling') && text.includes('reminder')
        || text.includes('would you like to create') && (text.includes('schedule') || text.includes('reminder'));
}

function repairAnswerPlan(plan, body) {
    if (plan.intent !== 'answer') return plan;
    if (!staleSchedulingOnlyAnswer(`${plan.text}\n${plan.reply}\n${plan.ask}`)) return plan;

    return {
        ...plan,
        text: body,
        reply: `Answer the current message naturally: ${body}`,
        ask: '',
    };
}

function routeAfterPlan(state) {
    return ACTION_INTENTS.has(state.decision.intent) ? 'tools' : 'respond';
}

function responsePayload(state) {
    return JSON.stringify({
        msg: messageText(state.input.message),
        situation: state.situation,
        intent: state.decision.intent,
        plan: state.plan,
        result: state.actionResult,
        time: state.timeResolution,
    });
}

function sanitizeReply(reply) {
    const urls = [];
    const withPlaceholders = String(reply || '').replace(/https?:\/\/\S+/g, (url) => {
        const key = `__URL_${urls.length}__`;
        urls.push(url.replace(/[),.;!?]+$/, (suffix) => {
            urls.trailing = urls.trailing || {};
            urls.trailing[key] = suffix;
            return '';
        }));
        return key;
    });

    const cleaned = withPlaceholders
        .replace(/@\d{5,}(?:@\S+)?/g, 'sir')
        .replace(/\b\d{5,}@(c\.us|lid|s\.whatsapp\.net)\b/g, 'sir')
        .replace(/\bsir\s+sir\b/gi, 'sir')
        .split(/\r?\n/)
        .map((line) => line
            .replace(/[ \t]+([,.;!?])/g, '$1')
            .replace(/([,.;!?])([^\s])/g, '$1 $2')
            .replace(/[ \t]+/g, ' ')
            .trim())
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    return cleaned.replace(/__URL_(\d+)__/g, (match, index) => {
        const suffix = urls.trailing?.[match] || '';
        return `${urls[Number(index)] || match}${suffix}`;
    });
}

function inventedOperationalReply(state, reply) {
    if (state.actionResult?.status) return false;
    if (state.decision?.intent !== 'answer' && state.decision?.intent !== 'refuse') return false;

    const text = String(reply || '').toLowerCase();
    return /\b(booked|scheduled|cancelled|canceled|updated|rescheduled|reminder set|schedule id|meet link)\b/.test(text)
        || /\b(12345|abc123|your-meet-link)\b/.test(text)
        || /https?:\/\/meet\.google\.com\/(your|abc|example)/i.test(reply);
}

function safeReplyForState(state, reply) {
    const clean = sanitizeReply(reply);
    if (!inventedOperationalReply(state, clean)) return clean;

    const body = messageText(state.input.message);
    return sanitizeReply(`I should not fake that, sir. If you want action, tell me plainly what to schedule, list, cancel, or update. Current ask: ${trimText(body, 120)}`);
}

function fallbackReply(state) {
    const result = state.actionResult || {};
    const plan = state.plan || {};

    if (state.decision.intent === 'refuse') {
        return 'I handle scheduling and reminders, sir.';
    }

    if (state.decision.intent === 'answer') {
        return plan.reply || 'I am here, sir.';
    }

    if (result.clarification || state.timeResolution?.clarification) {
        return `${result.clarification || state.timeResolution.clarification}, sir.`;
    }

    if (result.status === 'scheduled' && result.type === 'meeting') {
        return `Booked, sir: ${result.title} [${result.id || 'new'}] at ${result.when}.${result.meetLink ? ` Meet: ${result.meetLink}` : ''}`;
    }

    if (result.status === 'existing' && result.type === 'meeting') {
        return `Already booked, sir: ${result.title} [${result.id || 'existing'}] at ${result.when}.${result.meetLink ? ` Meet: ${result.meetLink}` : ''}`;
    }

    if (result.status === 'scheduled' && result.type === 'reminder') {
        return `Reminder set, sir: ${result.text} [${result.id || 'new'}] at ${result.when}.`;
    }

    if (result.status === 'cancelled') {
        return `Cancelled ${result.meetings || 0} sessions and ${result.reminders || 0} reminders, sir.`;
    }

    if (result.status === 'updated') return `Updated ${result.label || 'it'}, sir${result.when ? `: ${result.when}` : ''}.`;
    if (result.status === 'completed') return `Marked ${result.label || 'it'} done, sir.`;
    if (result.status === 'listed') {
        const label = result.kind === 'reminder'
            ? 'Active reminders'
            : result.kind === 'meeting'
                ? 'Active schedules'
                : 'Active items';
        return `${label}, sir:\n${(result.lines || []).join('\n')}`;
    }
    if (result.status === 'empty') {
        const label = result.kind === 'reminder'
            ? 'reminders'
            : result.kind === 'meeting'
                ? 'schedules'
                : 'items';
        return `No active ${label} found, sir.`;
    }
    if (result.status === 'announced') return 'Tagged everyone, sir.';
    if (result.status === 'nothing_to_cancel') return 'Nothing active matched, sir.';
    if (result.status === 'failed') {
        if (result.need === 'meeting_time') return 'I need the meeting date, time, and timezone, sir.';
        if (result.need === 'reminder_time') return 'I need the reminder date, time, and timezone, sir.';
        if (result.need === 'new_time' || result.need === 'new_meeting_time' || result.need === 'new_reminder_time') {
            return 'I need the new date, time, and timezone, sir.';
        }
        if (result.reason === 'no_matching_active_item') {
            return 'I could not find that active item, sir. Use /list all and send me the id.';
        }
        if (result.reason === 'no_active_item') {
            return 'I do not see an active item to update, sir.';
        }
        return `I could not finish that, sir${result.reason ? `: ${result.reason}` : '.'}`;
    }

    return 'Done, sir.';
}

function shouldUseDeterministicReply(state) {
    return ACTION_INTENTS.has(state.decision?.intent)
        || String(state.plan?.source || '').startsWith('command');
}

function createSchedulingGraph({ messageStore }) {
    let model = null;

    function stateFromPlan({ state, context, rawPlan }) {
        const body = messageText(state.input.message);
        const plan = {
            intent: normalizedIntent(rawPlan.intent),
            title: String(rawPlan.title || ''),
            text: String(rawPlan.text || ''),
            target: String(rawPlan.target || ''),
            date: String(rawPlan.date || ''),
            time: String(rawPlan.time || ''),
            timezone: String(rawPlan.timezone || ''),
            kind: String(rawPlan.kind || ''),
            attendees: Array.isArray(rawPlan.attendees) ? rawPlan.attendees : [],
            reply: String(rawPlan.reply || ''),
            ask: String(rawPlan.ask || ''),
            source: String(rawPlan.source || 'llm'),
        };
        const situatedPlan = alignPlanWithSituation(plan, state.situation);
        const repairedPlan = repairAnswerPlan(situatedPlan, body);
        const decision = planToDecision(repairedPlan, body);
        const timeResolution = timeResolutionForPlan(repairedPlan, body);

        logJson('Plan parsed', { plan: repairedPlan, decision, timeResolution });

        return {
            context,
            plan: repairedPlan,
            decision,
            timeResolution,
            nextStep: routeAfterPlan({ decision }),
        };
    }

    async function situationNode(state) {
        const body = messageText(state.input.message);
        const context = Object.keys(state.context || {}).length > 0
            ? state.context
            : await messageStore.recentContext(chatId(state.input.chat));

        const commandPlan = parseCommandPlan(body);
        if (commandPlan) {
            const situation = normalizeSituation({
                primaryIntent: commandPlan.intent,
                confidence: 1,
                currentAsk: body,
                focus: 'current_message',
                useQuoted: false,
                needsDb: false,
                titleHint: commandPlan.title || '',
                textHint: commandPlan.text || commandPlan.reply || '',
                targetHint: commandPlan.target || '',
                dateHint: commandPlan.date || '',
                timeHint: commandPlan.time || '',
                timezoneHint: commandPlan.timezone || '',
                kindHint: commandPlan.kind || '',
                why: 'Slash command parsed deterministically.',
            }, body);
            logJson('Situation parsed', situation);
            return { context, situation, nextStep: 'planner' };
        }

        if (!model) model = createLlmModel();

        const payload = situationPayload({ input: state.input, context });
        const estimated = estimateTokens(CHARON_SITUATION_PROMPT) + estimateTokens(payload);
        try {
            const response = await model.invoke([
                new SystemMessage(CHARON_SITUATION_PROMPT),
                new HumanMessage(payload),
            ], { json: true, maxOutputTokens: settings.llm.situationMaxOutputTokens });

            logModelUsage('Situation', response, estimated);
            logJson('Situation raw', response.content);

            const situation = normalizeSituation(safeJson(response.content) || fallbackSituation(body), body);
            logJson('Situation parsed', situation);
            return { context, situation, nextStep: 'planner' };
        } catch (error) {
            logger.warn('Situation reader failed; planner will continue with raw context.', error);
            const situation = fallbackSituation(body);
            logJson('Situation fallback', situation);
            return { context, situation, nextStep: 'planner' };
        }
    }

    async function planNode(state) {
        const body = messageText(state.input.message);
        const commandPlan = parseCommandPlan(body);
        if (commandPlan) {
            const context = Object.keys(state.context || {}).length > 0
                ? state.context
                : await messageStore.recentContext(chatId(state.input.chat));
            logJson('Command plan', commandPlan);
            return stateFromPlan({ state, context, rawPlan: commandPlan });
        }

        if (!model) model = createLlmModel();

        const id = chatId(state.input.chat);
        const context = Object.keys(state.context || {}).length > 0
            ? state.context
            : await messageStore.recentContext(id);
        const dbResults = [];
        const seenDbToolCalls = new Set();
        try {
            for (let step = 0; step <= MAX_DB_TOOL_STEPS; step += 1) {
                const payload = plannerLoopPayload({
                    input: state.input,
                    context,
                    dbResults,
                    situation: state.situation,
                });
                const estimated = estimateTokens(CHARON_SYSTEM_PROMPT) + estimateTokens(payload);
                const response = await model.invoke([
                    new SystemMessage(CHARON_SYSTEM_PROMPT),
                    new HumanMessage(payload),
                ], { json: true, maxOutputTokens: settings.llm.planMaxOutputTokens });

                logModelUsage(`Plan step ${step + 1}`, response, estimated);
                logJson(`Plan raw ${step + 1}`, response.content);

                const parsed = safeJson(response.content) || {
                    intent: 'answer',
                    reply: 'I could not read that cleanly. Say it once more plainly.',
                };

                if (parsed.tool) {
                    const key = dbToolKey(parsed);
                    if (seenDbToolCalls.has(key)) {
                        logger.warn(`Planner repeated DB tool call; ending loop with existing DB result. key=${key}`);
                        return stateFromPlan({
                            state,
                            context,
                            rawPlan: planFromRepeatedDbTool(dbResults),
                        });
                    }
                    seenDbToolCalls.add(key);

                    if (step >= MAX_DB_TOOL_STEPS) {
                        return stateFromPlan({
                            state,
                            context,
                            rawPlan: {
                                intent: 'answer',
                                reply: 'I checked the database but could not settle on one safe item. Send me the schedule or reminder id.',
                            },
                        });
                    }

                    const toolResult = await runPlannerDbTool({
                        toolCall: parsed,
                        chatId: id,
                        messageStore,
                    });
                    dbResults.push(toolResult);
                    logJson('Planner DB tool result', toolResult);
                    continue;
                }

                const finalPlan = parsed.plan || parsed.final || parsed;
                return stateFromPlan({ state, context, rawPlan: finalPlan });
            }

            return stateFromPlan({
                state,
                context,
                rawPlan: {
                    intent: 'answer',
                    reply: 'I checked the database but could not settle on a safe action. Try with the schedule/reminder id.',
                },
            });
        } catch (error) {
            logger.warn('Planner LLM failed; command mode remains available.', error);
            return stateFromPlan({
                state,
                context,
                rawPlan: {
                    intent: 'answer',
                    reply: `LLM credits or service are unavailable, sir.\n\n${COMMAND_HELP}`,
                    source: 'command_fallback',
                },
            });
        }
    }

    async function toolsNode(state) {
        const input = state.input;
        const decision = state.decision;
        let actionResult = {};

        if (decision.intent === 'schedule') {
            actionResult = await scheduleMeeting({
                decision,
                timeResolution: state.timeResolution,
                context: state.context,
                chat: input.chat,
                triggerMessage: input.message,
                messageStore,
            });
        } else if (decision.intent === 'reminder') {
            actionResult = await createStandaloneReminder({
                decision,
                timeResolution: state.timeResolution,
                chat: input.chat,
                triggerMessage: input.message,
                messageStore,
            });
        } else if (decision.intent === 'update') {
            actionResult = await updateActiveItem({
                decision,
                timeResolution: state.timeResolution,
                chat: input.chat,
                messageStore,
            });
        } else if (decision.intent === 'cancel') {
            actionResult = await cancelActiveItem({
                decision,
                chat: input.chat,
                messageStore,
            });
        } else if (decision.intent === 'complete') {
            actionResult = await markDone({
                decision,
                chat: input.chat,
                messageStore,
            });
        } else if (decision.intent === 'list') {
            actionResult = await listActiveItems({
                chat: input.chat,
                kind: decision.list?.kind,
                target: decision.list?.target,
                messageStore,
            });
        } else if (decision.intent === 'announce') {
            actionResult = await announceToGroup({
                client: input.client,
                chat: input.chat,
                text: decision.announcement?.text,
            });
        }

        logJson('Action result', actionResult);
        return { actionResult, nextStep: 'respond' };
    }

    async function respondNode(state) {
        if (shouldUseDeterministicReply(state)) {
            const reply = safeReplyForState(state, fallbackReply(state));
            logJson('Final deterministic reply', reply);
            return { reply, nextStep: 'end' };
        }

        if (!model) model = createLlmModel();

        const payload = responsePayload(state);
        const estimated = estimateTokens(CHARON_RESPONSE_PROMPT) + estimateTokens(payload);
        try {
            const response = await model.invoke([
                new SystemMessage(CHARON_RESPONSE_PROMPT),
                new HumanMessage(payload),
            ], { json: true, maxOutputTokens: settings.llm.responseMaxOutputTokens });

            logModelUsage('Response', response, estimated);
            logJson('Response raw', response.content);

            const parsed = safeJson(response.content);
            const reply = safeReplyForState(state, String(parsed?.reply || '').trim() || fallbackReply(state));
            logJson('Final reply', reply);
            return { reply, nextStep: 'end' };
        } catch (error) {
            logger.warn('Response writer failed; using fallback reply.', error);
            return { reply: safeReplyForState(state, fallbackReply(state)), nextStep: 'end' };
        }
    }

    return new StateGraph(CharonState)
        .addNode('situation_reader', situationNode)
        .addNode('planner', planNode)
        .addNode('tool_runner', toolsNode)
        .addNode('responder', respondNode)
        .addEdge(START, 'situation_reader')
        .addEdge('situation_reader', 'planner')
        .addConditionalEdges('planner', routeAfterPlan, {
            tools: 'tool_runner',
            respond: 'responder',
        })
        .addEdge('tool_runner', 'responder')
        .addEdge('responder', END)
        .compile();
}

async function invokeSchedulingGraph(graph, input) {
    try {
        return await graph.invoke({ input });
    } catch (error) {
        logger.error('Scheduling graph failed', error);
        return { reply: 'Something jammed in the machinery, sir. Try that once more.' };
    }
}

module.exports = { createSchedulingGraph, invokeSchedulingGraph };
