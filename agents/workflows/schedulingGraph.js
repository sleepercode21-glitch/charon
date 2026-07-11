const { Annotation, END, START, StateGraph } = require('@langchain/langgraph');
const { HumanMessage, SystemMessage } = require('@langchain/core/messages');
const { settings } = require('../../config/settings');
const { createLlmModel } = require('../../models/llmWrapper');
const { PLANNER_STAGE_PROMPTS } = require('../../models/prompts');
const { CHARON_RESPONSE_PROMPT } = require('../../models/prompts/responsePrompt');
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
    return [...new Set([
        message?.body,
        message?.pollName,
        message?.caption,
        message?._data?.body,
        message?._data?.pollName,
        message?._data?.caption,
    ].filter(Boolean).map((value) => String(value).trim()))].join(' ').trim();
}

function currentDateContext(timezone) {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    }).formatToParts(now).reduce((values, part) => {
        if (part.type !== 'literal') values[part.type] = part.value;
        return values;
    }, {});
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

    return {
        backendTimezone: timezone,
        backendLocal: local,
        backendLocalIso: `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`,
        utc: now.toISOString(),
        timestampMs: now.getTime(),
        relativeTimeRule: `Resolve "in N minutes/hours" by adding N to timestampMs, then return the resulting UTC instant with trailing Z.`,
    };
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
    const cleaned = String(value || '')
        .replace(/@\d+(?:@\S+)?/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    return collapseRepeatedCommandText(cleaned);
}

function collapseRepeatedCommandText(value) {
    const words = String(value || '').trim().split(/\s+/).filter(Boolean);
    if (words.length < 2 || words.length % 2 !== 0) return String(value || '').trim();

    const half = words.length / 2;
    const left = words.slice(0, half).join(' ').toLowerCase();
    const right = words.slice(half).join(' ').toLowerCase();
    return left === right ? words.slice(0, half).join(' ') : String(value || '').trim();
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
    const allKindMatch = text.match(/^all(?:\s+(schedules?|meetings?|sessions?|reminders?))?(?:\s+and\s+(schedules?|meetings?|sessions?|reminders?))?$/i);
    if (allowAll && allKindMatch) {
        const firstKind = allKindMatch[1] ? normalizedKind(allKindMatch[1], allKindMatch[1]) : '';
        const secondKind = allKindMatch[2] ? normalizedKind(allKindMatch[2], allKindMatch[2]) : '';
        return {
            rawKind: 'all',
            kind: firstKind && (!secondKind || firstKind === secondKind) ? firstKind : '',
            target: '',
        };
    }

    const match = text.match(/^(schedule(?:s)?|meeting(?:s)?|session(?:s)?|reminder(?:s)?|all)\b\s*([\s\S]*)$/i);
    if (!match) return null;

    const rawKind = match[1].toLowerCase();
    if (rawKind === 'all' && !allowAll) return null;
    if (allowAll && rawKind === 'all') {
        const target = match[2].trim();
        const targetKind = normalizedKind(target, target);
        return {
            rawKind,
            kind: targetKind === 'meeting' || targetKind === 'reminder' ? targetKind : '',
            target: '',
        };
    }

    return {
        rawKind,
        kind: rawKind === 'all' ? '' : normalizedKind(rawKind, rawKind),
        target: match[2].trim(),
    };
}

function parseManualCommandPlan(body) {
    const text = String(body || '').trim();
    const lower = text.toLowerCase();

    if (lower === 'help' || lower === 'commands' || lower === 'command mode' || /\bhelp\b.*\bcommands?\b|\bcommands?\b.*\bhelp\b/.test(lower)) {
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
        askedAt: ask.timestamp || ask.createdAt || '',
        about: trimText(priorUser?.body || '', 180),
        aboutAt: priorUser?.timestamp || priorUser?.createdAt || '',
        requester: trimText(priorUser?.senderName || priorUser?.senderId || '', 48),
    };
}

function compactForPlanner(context, message, { maxTokens, lean = false } = {}) {
    return compactContext(withoutCurrentMessage(context, message), {
        maxTokens: Math.max(250, Math.min(maxTokens || settings.llm.contextTokenBudget, settings.llm.contextTokenBudget)),
        maxMessages: lean ? Math.min(settings.llm.maxContextMessages, 8) : settings.llm.maxContextMessages,
        minMessages: lean ? 2 : 4,
        maxTextChars: lean ? 120 : 180,
        maxPolls: lean ? 0 : settings.llm.maxContextPolls,
        maxMeetings: lean ? 0 : 12,
        maxReminders: lean ? 0 : 12,
        leanSignals: lean,
        includeBotMessages: true,
    });
}

function compactQuotedContext(quoted, lean = false) {
    if (!quoted) return null;
    return {
        id: quoted.id || '',
        type: quoted.type || '',
        body: trimText(quoted.body || '', lean ? 180 : 420),
        pollName: trimText(quoted.pollName || '', 140),
        pollOptions: (quoted.pollOptions || []).slice(0, lean ? 6 : 12).map((option) => ({
            name: trimText(option?.name || option, 100),
            votes: Number(option?.votes || 0),
        })),
        timestamp: quoted.timestamp || '',
    };
}

function normalizeNaturalTimeText(value) {
    return String(value || '')
        .replace(/\b([01]?\d|2[0-3])\s+om\b/ig, '$1 pm')
        .replace(/\s+/g, ' ')
        .trim();
}

function dateFromTimestamp(value) {
    if (!value) return null;
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
    if (typeof value === 'number' && Number.isFinite(value)) {
        const millis = value < 1e12 ? value * 1000 : value;
        const date = new Date(millis);
        return Number.isNaN(date.getTime()) ? null : date;
    }
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function exactRelativeTimeEvidence(value, fallbackTimezone, referenceDate = new Date()) {
    const text = normalizeNaturalTimeText(value);
    const match = text.match(/\b(?:in|after)\s+(\d+)\s*(m|mins?|minutes?|h|hrs?|hours?|d|days?)\b/i)
        || text.match(/\b(\d+)\s*(m|mins?|minutes?|h|hrs?|hours?|d|days?)\s+from\s+now\b/i);
    if (!match) return null;

    const amount = Number(match[1]);
    if (!Number.isFinite(amount) || amount < 0) return null;
    const unit = match[2].toLowerCase();
    const multiplier = /^m/.test(unit) ? 60 * 1000
        : /^h/.test(unit) ? 60 * 60 * 1000
            : 24 * 60 * 60 * 1000;
    const reference = dateFromTimestamp(referenceDate) || new Date();
    const date = new Date(reference.getTime() + amount * multiplier);
    return {
        date: date.toISOString(),
        timezone: normalizeTimezone(extractTimezone(text, fallbackTimezone), fallbackTimezone),
        sourceText: text,
        source: 'relative_duration',
    };
}

function hasNaturalTimeSignal(value) {
    const text = normalizeNaturalTimeText(value);
    return /\b(in\s+\d+\s*(?:mins?|minutes?|hours?|hrs?|days?)|today|tomorrow|tonight|morning|afternoon|evening|noon|midnight|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|\d{1,2}(?::\d{2})?\s*(?:am|pm)|\d{1,2}\s*(?:am|pm)|\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2})\b/i.test(text);
}

function naturalTimeEvidence(value, fallbackTimezone, referenceDate = new Date()) {
    const text = normalizeNaturalTimeText(value);
    if (!hasNaturalTimeSignal(text)) return null;
    const exactRelative = exactRelativeTimeEvidence(text, fallbackTimezone, referenceDate);
    if (exactRelative) return exactRelative;
    const timezone = extractTimezone(text, fallbackTimezone);
    const parsed = parseDate(text, dateFromTimestamp(referenceDate) || new Date(), timezone);
    if (!parsed) return null;
    return {
        date: parsed.toISOString(),
        timezone: normalizeTimezone(timezone, fallbackTimezone),
        sourceText: text,
    };
}

function pollOptionsWithVotes(input, context) {
    const options = [];
    const addOption = (name, votes = 0) => {
        const text = String(name || '').trim();
        if (!text) return;
        options.push({
            name: text,
            votes: Number(votes || 0),
        });
    };

    for (const option of input?.quoted?.pollOptions || []) {
        addOption(option?.name || option, option?.votes);
    }

    for (const option of input?.quoted?.storedPoll?.options || []) {
        addOption(option, 0);
    }

    const quotedId = String(input?.quoted?.id || '');
    const contextPolls = Array.isArray(context?.polls) ? context.polls : [];
    const matchingPoll = contextPolls.find((poll) => quotedId && String(poll.pollMessageId || '') === quotedId)
        || contextPolls[0];
    if (matchingPoll) {
        const counts = new Map();
        for (const vote of matchingPoll.votes || []) {
            for (const selected of vote.selectedOptions || []) {
                counts.set(selected, (counts.get(selected) || 0) + 1);
            }
        }
        for (const option of matchingPoll.options || []) {
            addOption(option, counts.get(option) || 0);
        }
    }

    const byName = new Map();
    for (const option of options) {
        const key = option.name.toLowerCase();
        const existing = byName.get(key);
        if (!existing || option.votes > existing.votes) byName.set(key, option);
    }
    return [...byName.values()];
}

function bestPollScheduleEvidence(input, context) {
    const timezone = input?.timezone || settings.timezone;
    const pollName = String(input?.quoted?.pollName || input?.quoted?.body || '').trim();
    const voted = pollOptionsWithVotes(input, context)
        .filter((option) => option.votes > 0)
        .sort((left, right) => right.votes - left.votes);
    if (!voted.length) return null;

    const timed = voted
        .map((option) => ({
            ...option,
            time: naturalTimeEvidence(option.name, timezone),
        }))
        .filter((option) => option.time);
    const highestTimedVotes = timed[0]?.votes || 0;
    const timeLeaders = timed.filter((option) => option.votes === highestTimedVotes);
    const timeOption = timeLeaders.length === 1 ? timeLeaders[0] : null;

    const topics = voted.filter((option) => !naturalTimeEvidence(option.name, timezone));
    const highestTopicVotes = topics[0]?.votes || 0;
    const topicLeaders = topics.filter((option) => option.votes === highestTopicVotes);
    const topicOption = topicLeaders.length === 1 ? topicLeaders[0] : null;

    if (!timeOption && !topicOption) return null;
    return {
        date: timeOption?.time.date || '',
        timezone: timeOption?.time.timezone || timezone,
        timeText: timeOption?.name || '',
        topic: topicOption?.name || '',
        pollName,
    };
}

function isGenericScheduleTitle(value, evidence = {}) {
    const title = String(value || '').trim().toLowerCase();
    if (!title) return true;
    if (/^(session|meeting|meet|call|schedule|tech up meetup)$/i.test(title)) return true;
    if (/^(system design|sydtem design)\s+(session|meeting|meet|call)$/i.test(title)) return Boolean(evidence.topic);
    if (evidence.pollName && title === evidence.pollName.toLowerCase()) return true;
    return false;
}

function pollEvidenceTitle(evidence, fallback = '') {
    const pieces = [];
    if (evidence.topic) pieces.push(evidence.topic);
    if (evidence.pollName && !pieces.some((piece) => piece.toLowerCase() === evidence.pollName.toLowerCase())) {
        pieces.push(evidence.pollName);
    }
    const title = pieces.join(' ').replace(/\s+/g, ' ').trim();
    if (title) return /\b(session|meeting|meet|call)\b/i.test(title) ? title : `${title} session`;
    return fallback || 'Session';
}

function repairActionWithEvidence(action, state, context) {
    const plan = normalizedPlan(action, action?.source || 'llm');
    const intent = normalizedIntent(plan.intent);
    if (!['schedule', 'reminder', 'update'].includes(intent)) return plan;

    const body = messageText(state.input.message);
    const fallbackTimezone = state.input.timezone || settings.timezone;
    const referenceDate = new Date();
    const directTime = naturalTimeEvidence(body, fallbackTimezone, referenceDate);
    const pollEvidence = intent === 'schedule' ? bestPollScheduleEvidence(state.input, context) : null;
    const repaired = { ...plan };

    if (directTime) {
        repaired.date = directTime.date;
        repaired.time = '';
        repaired.timezone = directTime.timezone;
        if (repaired.ask && ['schedule', 'reminder'].includes(intent)) repaired.ask = '';
    } else if (pollEvidence?.date && (!repaired.date || repaired.ask)) {
        repaired.date = pollEvidence.date;
        repaired.time = '';
        repaired.timezone = pollEvidence.timezone;
        repaired.ask = '';
    }

    if (intent === 'schedule' && pollEvidence && isGenericScheduleTitle(repaired.title, pollEvidence)) {
        repaired.title = pollEvidenceTitle(pollEvidence, repaired.title);
        if (!repaired.text || isGenericScheduleTitle(repaired.text, pollEvidence)) repaired.text = repaired.title;
    }

    return repaired;
}

function repairPlanWithEvidence(rawPlan, state, context) {
    if (!rawPlan || typeof rawPlan !== 'object') return rawPlan;
    if (Array.isArray(rawPlan.actions)) {
        return {
            ...rawPlan,
            actions: rawPlan.actions.map((action) => repairActionWithEvidence(action, state, context)),
        };
    }
    return repairActionWithEvidence(rawPlan, state, context);
}

function plannerPayload({
    input,
    context,
    inputTokenBudget = settings.llm.plannerMaxInputTokens,
    lean = false,
}) {
    const base = {
        clock: currentDateContext(input.timezone),
        defaultTz: input.timezone || settings.timezone,
        room: {
            chatId: chatId(input.chat),
            chatName: input.chat?.name || '',
        },
        requester: input.storedMessage?.senderName
            || input.message?.author
            || input.message?.from
            || 'unknown',
        msg: messageText(input.message),
        quoted: compactQuotedContext(input.quoted, lean),
        pending: pendingClarification(context, input.message),
    };
    const fixedTokens = estimateTokens(PLANNER_STAGE_PROMPTS[0]) + estimateTokens(base);
    const contextBudget = Math.max(250, inputTokenBudget - fixedTokens - 80);
    const compact = compactForPlanner(context, input.message, {
        maxTokens: contextBudget,
        lean,
    });
    const payload = JSON.stringify({
        ...base,
        roomContext: JSON.parse(compact.json),
    });
    return {
        payload,
        estimatedTokens: estimateTokens(PLANNER_STAGE_PROMPTS[0]) + estimateTokens(payload),
        contextTokens: compact.estimatedTokens,
        inputTokenBudget,
    };
}

function plannerStageSystemPrompt(stage, totalStages) {
    if (totalStages <= 1 || stage === 1) return PLANNER_STAGE_PROMPTS[0];
    if (stage === totalStages) return PLANNER_STAGE_PROMPTS[2];
    return PLANNER_STAGE_PROMPTS[1];
}

function plannerActionSnapshot(action) {
    if (!action || typeof action !== 'object') return null;
    return {
        intent: String(action.intent || ''),
        title: String(action.title || ''),
        text: String(action.text || ''),
        target: String(action.target || ''),
        date: String(action.date || ''),
        time: String(action.time || ''),
        timezone: String(action.timezone || ''),
        kind: String(action.kind || ''),
        attendees: Array.isArray(action.attendees) ? action.attendees.filter(Boolean).slice(0, 8) : [],
        reply: String(action.reply || ''),
        ask: String(action.ask || ''),
    };
}

function plannerIntentContextSnapshot(value) {
    if (!value || typeof value !== 'object') return null;
    if (value.stage !== 'intent_context' && !value.primaryIntent && !Array.isArray(value.actionsNeeded)) return null;
    return {
        stage: 'intent_context',
        primaryIntent: String(value.primaryIntent || ''),
        actionsNeeded: Array.isArray(value.actionsNeeded)
            ? value.actionsNeeded.map((item) => String(item || '')).filter(Boolean).slice(0, 20)
            : [],
        references: Array.isArray(value.references)
            ? value.references.slice(0, 20).map((reference) => ({
                phrase: String(reference?.phrase || ''),
                type: String(reference?.type || ''),
                evidence: trimText(reference?.evidence || '', 180),
            }))
            : [],
        missing: Array.isArray(value.missing)
            ? value.missing.map((item) => String(item || '')).filter(Boolean).slice(0, 10)
            : [],
        timeFacts: Array.isArray(value.timeFacts)
            ? value.timeFacts.slice(0, 12).map((fact) => ({
                text: String(fact?.text || ''),
                resolvedUtc: String(fact?.resolvedUtc || ''),
                timezone: String(fact?.timezone || ''),
                source: String(fact?.source || ''),
            }))
            : [],
        notes: trimText(value.notes || '', 240),
    };
}

function plannerOutputSnapshot(output) {
    const parsed = safeJson(output);
    const candidate = parsed?.plan || parsed?.final || parsed;
    if (!candidate || typeof candidate !== 'object') return null;
    const intentContext = plannerIntentContextSnapshot(candidate);
    if (intentContext) return intentContext;
    if (Array.isArray(candidate.actions)) {
        return {
            actions: candidate.actions
                .map(plannerActionSnapshot)
                .filter(Boolean),
        };
    }
    return plannerActionSnapshot(candidate);
}

function executablePlannerSnapshot(output) {
    const snapshot = plannerOutputSnapshot(output);
    if (!snapshot || snapshot.stage === 'intent_context') return null;
    if (Array.isArray(snapshot.actions)) return snapshot.actions.length ? snapshot : null;
    return snapshot.intent ? snapshot : null;
}

function plannerReferenceContext(originalPayload) {
    const roomContext = originalPayload?.roomContext || {};
    const signals = roomContext.signals || {};
    return {
        clock: originalPayload?.clock || null,
        msg: originalPayload?.msg || '',
        quoted: originalPayload?.quoted || null,
        pending: originalPayload?.pending || null,
        signals,
        polls: (roomContext.polls || []).slice(0, 6),
        recentMessages: (roomContext.msgs || []).slice(-12),
        activeMeetings: (roomContext.meetings || []).slice(0, 12),
        activeReminders: (roomContext.reminders || []).slice(0, 12),
    };
}

function plannerStagePayload(basePayload, previousOutputs = [], stage = 1, totalStages = 1) {
    if (stage <= 1 || previousOutputs.length === 0) return basePayload;
    const originalPayload = JSON.parse(basePayload);
    const prior = previousOutputs.map((output, index) => ({
        stage: index + 1,
        raw: String(output || '').slice(0, 1200),
        parsed: plannerOutputSnapshot(output),
    }));
    if (stage === totalStages) {
        return JSON.stringify({
            stage: 'finalizer',
            job: 'Validate and finalize the executable plan from original evidence, intent context, and draft plan.',
            originalPayload,
            referenceContext: plannerReferenceContext(originalPayload),
            intentContext: prior[0]?.parsed || null,
            draftPlan: prior[prior.length - 1] || null,
            allPreviousOutputs: prior,
        });
    }

    return JSON.stringify({
        stage: 'plan_builder',
        job: 'Build executable ACTION JSON from original evidence plus stage 1 intent/context analysis.',
        originalPayload,
        referenceContext: plannerReferenceContext(originalPayload),
        intentContext: prior[0]?.parsed || null,
        previousPlannerOutputs: prior,
    });
}

async function invokePlannerChain({
    plannerModels,
    input,
    context,
    inputTokenBudget,
    lean,
}) {
    const built = plannerPayload({
        input,
        context,
        inputTokenBudget,
        lean,
    });
    const totalStages = Math.max(1, Math.floor(settings.llm.plannerStages || 1));
    const outputs = [];
    let response = null;
    let finalEstimatedTokens = built.estimatedTokens;

    for (let stage = 1; stage <= totalStages; stage += 1) {
        if (!plannerModels[stage - 1]) {
            plannerModels[stage - 1] = createLlmModel(settings.llm.plannerModel, 'planner', {
                keyOffset: stage - 1,
            });
        }
        const systemPrompt = plannerStageSystemPrompt(stage, totalStages);
        const payload = plannerStagePayload(built.payload, outputs, stage, totalStages);
        finalEstimatedTokens = estimateTokens(systemPrompt) + estimateTokens(payload);
        logger.info(`Planner stage ${stage}/${totalStages} keySlot=${stage} estimated=${finalEstimatedTokens}.`);
        try {
            response = await plannerModels[stage - 1].invoke([
                new SystemMessage(systemPrompt),
                new HumanMessage(payload),
            ], { json: true, maxOutputTokens: settings.llm.planMaxOutputTokens });
            logModelUsage(`Planner stage ${stage}/${totalStages}`, response, finalEstimatedTokens);
            logJson(`Planner stage ${stage}/${totalStages} raw`, response.content);
            outputs.push(response.content);
        } catch (error) {
            const previousOutput = outputs[outputs.length - 1];
            if (stage > 1 && executablePlannerSnapshot(previousOutput)) {
                logger.warn(`Planner stage ${stage}/${totalStages} failed; using prior stage output.`, error);
                response = { content: previousOutput };
                break;
            }
            throw error;
        }
    }

    return {
        built,
        response,
        finalEstimatedTokens,
        outputs,
    };
}

function hasTimeRequest(plan) {
    return Boolean(plan.date || plan.time);
}

function whenText(plan) {
    if (!plan.date && !plan.time) return '';
    const date = String(plan.date || '').trim();
    if (date.includes('T') && Number.isFinite(Date.parse(date))) {
        const timePart = date.split('T')[1] || '';
        const hasZone = timePart.includes('Z') || timePart.includes('+') || timePart.slice(1).includes('-');
        return hasZone ? date : `${date}Z`;
    }
    return [plan.date, plan.time, plan.timezone].filter(Boolean).join(' ').trim();
}

function timeResolutionForPlan(plan, body, { allowBodyFallback = true } = {}) {
    const intent = normalizedIntent(plan.intent);
    let when = whenText(plan);
    if (!when && ACTION_INTENTS.has(intent) && allowBodyFallback) {
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
            kind,
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

function normalizedPlan(rawPlan, inheritedSource = 'llm') {
    return {
        intent: normalizedIntent(rawPlan?.intent),
        title: String(rawPlan?.title || ''),
        text: String(rawPlan?.text || ''),
        target: String(rawPlan?.target || ''),
        date: String(rawPlan?.date || ''),
        time: String(rawPlan?.time || ''),
        timezone: String(rawPlan?.timezone || ''),
        kind: String(rawPlan?.kind || ''),
        attendees: Array.isArray(rawPlan?.attendees) ? rawPlan.attendees : [],
        reply: String(rawPlan?.reply || ''),
        ask: String(rawPlan?.ask || ''),
        source: String(rawPlan?.source || inheritedSource),
    };
}

function normalizePlanActions(rawPlan, maxActions = settings.llm.maxSequenceActions) {
    const inheritedSource = String(rawPlan?.source || 'llm');
    const candidates = Array.isArray(rawPlan?.actions) && rawPlan.actions.length
        ? rawPlan.actions
        : [rawPlan];

    const validActions = candidates.filter((action) => action && typeof action === 'object');
    const limit = Number.isInteger(maxActions) && maxActions > 0
        ? maxActions
        : validActions.length;

    return validActions
        .slice(0, limit)
        .map((action) => normalizedPlan(action, inheritedSource));
}

function resultReference(steps, expression) {
    const parts = String(expression || '').split('.');
    let value = null;
    let path = [];

    if (parts[0] === 'previous') {
        value = steps[steps.length - 1]?.result;
        path = parts.slice(1);
    } else if (parts[0] === 'steps' && /^\d+$/.test(parts[1] || '')) {
        value = steps[Number(parts[1]) - 1]?.result;
        path = parts.slice(2);
    }

    for (const key of path) {
        if (value === undefined || value === null) break;
        value = value[key];
    }

    if (value === undefined || value === null) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
}

function resolvePlanReferences(plan, steps) {
    const resolve = (value) => {
        if (typeof value === 'string') {
            return value.replace(/\{\{\s*((?:previous|steps\.\d+)(?:\.[A-Za-z0-9_]+)+)\s*\}\}/g, (_match, expression) => (
                resultReference(steps, expression)
            ));
        }
        if (Array.isArray(value)) return value.map(resolve);
        if (value && typeof value === 'object') {
            return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item)]));
        }
        return value;
    };

    return resolve(plan);
}

function sequencePreflightFailure(plan, time) {
    const intent = normalizedIntent(plan.intent);
    const hasRequestedTimeChange = Boolean(plan.date || plan.time || plan.timezone);
    let need = '';
    let clarification = String(plan.ask || '');

    if (intent === 'schedule' && time.status !== 'resolved') {
        need = 'meeting_time';
        clarification ||= 'What date, time, and timezone should I use for the meeting?';
    } else if (intent === 'reminder' && time.status !== 'resolved') {
        need = 'reminder_time';
        clarification ||= 'When should I remind the group?';
    } else if (intent === 'update' && hasRequestedTimeChange && time.status !== 'resolved') {
        need = 'new_time';
        clarification ||= 'What exact new date, time, and timezone should I use?';
    } else if (plan.ask) {
        need = 'clarification';
    }

    if (!need) return null;
    return {
        status: 'failed',
        type: intent,
        need,
        clarification,
        reason: 'sequence_preflight_failed',
    };
}

async function executePlanSequence({ actions, body, runAction }) {
    const steps = [];
    let failedAt = null;

    for (const [index, plan] of actions.entries()) {
        const time = timeResolutionForPlan(plan, body, { allowBodyFallback: false });
        const failure = sequencePreflightFailure(plan, time);
        if (!failure) continue;

        return {
            actionResult: {
                status: 'sequence_partial',
                type: 'sequence',
                total: actions.length,
                executed: 0,
                stoppedAt: index + 1,
                steps: [{
                    index: index + 1,
                    intent: normalizedIntent(plan.intent),
                    plan,
                    time,
                    result: failure,
                    executed: false,
                }],
            },
            timeResolution: {
                status: 'sequence',
                steps: [time],
            },
        };
    }

    for (const [index, rawAction] of actions.entries()) {
        const plan = resolvePlanReferences(rawAction, steps);
        const decision = planToDecision(plan, body);
        const time = timeResolutionForPlan(plan, body, { allowBodyFallback: false });
        let result;

        try {
            result = await runAction(decision, time, plan);
        } catch (error) {
            logger.error(`Sequence step ${index + 1} failed`, error);
            result = {
                status: 'failed',
                type: decision.intent,
                reason: 'step_execution_failed',
            };
        }

        steps.push({
            index: index + 1,
            intent: decision.intent,
            plan,
            time,
            result,
            executed: true,
        });
        if (result?.status === 'failed') {
            failedAt = index + 1;
            break;
        }
    }

    return {
        actionResult: {
            status: failedAt ? 'sequence_partial' : 'sequence_completed',
            type: 'sequence',
            total: actions.length,
            executed: steps.length,
            stoppedAt: failedAt,
            steps,
        },
        timeResolution: {
            status: 'sequence',
            steps: steps.map((step) => step.time),
        },
    };
}

function routeAfterPlan(state) {
    return state.decision.intent === 'sequence' || ACTION_INTENTS.has(state.decision.intent)
        ? 'tools'
        : 'respond';
}

function responsePayload(state) {
    const compact = compactContext(withoutCurrentMessage(state.context || {}, state.input.message), {
        maxTokens: settings.llm.responseContextTokenBudget,
        maxMessages: Math.min(settings.llm.maxContextMessages, 12),
        minMessages: 3,
        maxTextChars: 160,
        maxPolls: 2,
        maxMeetings: 3,
        maxReminders: 3,
        includeBotMessages: true,
    });

    return JSON.stringify({
        clock: currentDateContext(state.input.timezone),
        originalUserInput: messageText(state.input.message),
        msg: messageText(state.input.message),
        quoted: state.input.quoted || null,
        conversation: JSON.parse(compact.json),
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

function meaningfulSequenceStep(step) {
    const status = step?.result?.status;
    return status
        && !['empty', 'nothing_to_cancel'].includes(status)
        && status !== 'failed';
}

function sequenceClarificationStep(steps = []) {
    return steps.find((step) => (
        step?.result?.clarification
        || step?.time?.clarification
        || step?.plan?.ask
        || ['meeting_time', 'reminder_time', 'new_time', 'new_meeting_time', 'new_reminder_time'].includes(step?.result?.need)
    ));
}

function stateForSequenceStep(state, step) {
    return {
        ...state,
        plan: step?.plan || {},
        decision: { intent: step?.intent },
        timeResolution: step?.time || {},
        actionResult: step?.result || {},
    };
}

function deterministicBotReply(state) {
    const result = state.actionResult || {};
    const plan = state.plan || {};

    if (result.type === 'sequence') {
        const steps = result.steps || [];
        const clarification = sequenceClarificationStep(steps);
        const successes = steps.filter(meaningfulSequenceStep);

        if (clarification && successes.length === 0) {
            return deterministicBotReply(stateForSequenceStep(state, clarification));
        }

        const preferred = [...successes].reverse().find((step) => (
            ['updated', 'scheduled', 'existing'].includes(step?.result?.status)
        )) || successes[successes.length - 1];

        if (preferred) {
            const reply = deterministicBotReply(stateForSequenceStep(state, preferred));
            if (result.status === 'sequence_partial' && clarification) {
                const ask = deterministicBotReply(stateForSequenceStep(state, clarification))
                    .replace(/\b,?\s*sir\b/gi, '')
                    .trim();
                return `${reply}\n${ask}`;
            }
            return reply;
        }

        if (clarification) return deterministicBotReply(stateForSequenceStep(state, clarification));
        return 'Done.';
    }

    if (state.decision.intent === 'refuse') {
        return 'I handle scheduling and reminders, sir.';
    }

    if (state.decision.intent === 'answer') {
        return plan.reply || 'I am here, sir.';
    }

    if (result.clarification || state.timeResolution?.clarification) {
        return `${result.clarification || state.timeResolution.clarification}`;
    }

    if (result.status === 'scheduled' && result.type === 'meeting') {
        return `Booked ${result.title}${result.id ? ` [${result.id}]` : ''} for ${result.when}.${result.meetLink ? ` Meet: ${result.meetLink}` : ''}`;
    }

    if (result.status === 'existing' && result.type === 'meeting') {
        return `That meeting is already booked: ${result.title}${result.id ? ` [${result.id}]` : ''} at ${result.when}.${result.meetLink ? ` Meet: ${result.meetLink}` : ''}`;
    }

    if (result.status === 'scheduled' && result.type === 'reminder') {
        return `Reminder set for ${result.when}: ${result.text}${result.id ? ` [${result.id}]` : ''}.`;
    }

    if (result.status === 'cancelled') {
        const skipped = (result.skippedMeetings || 0) + (result.skippedReminders || 0);
        const detail = skipped > 0
            ? ` ${skipped} matched item${skipped === 1 ? ' was' : 's were'} already inactive or could not be changed.`
            : '';
        return `Cancelled ${result.meetings || 0} sessions and ${result.reminders || 0} reminders, sir.${detail}`;
    }

    if (result.status === 'updated') return `Updated ${result.label || 'it'}${result.when ? ` to ${result.when}` : ''}.`;
    if (result.status === 'completed') return `Marked ${result.label || 'it'} done.`;
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
        if (result.reason === 'past_time') return 'That time is in the past, sir. Send me a future date and time.';
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

function commandModePlan(reason = 'LLM mode is unavailable.') {
    return {
        intent: 'answer',
        reply: `${reason}\n\n${COMMAND_HELP}`,
        source: 'command_mode',
    };
}

function shouldUseDeterministicReply(state) {
    const sequenceSteps = state.actionResult?.type === 'sequence'
        ? state.actionResult.steps?.length || 0
        : 0;
    const deterministicSequenceThreshold = settings.llm.sequenceResponseMaxSteps;
    return ACTION_INTENTS.has(state.decision?.intent)
        || state.decision?.intent === 'sequence'
        || String(state.plan?.source || '').startsWith('command')
        || (deterministicSequenceThreshold > 0 && sequenceSteps > deterministicSequenceThreshold);
}

function createSchedulingGraph({ messageStore }) {
    let responseModel = null;
    const plannerModels = [];

    function stateFromPlan({ state, context, rawPlan }) {
        const body = messageText(state.input.message);
        const requestedActionCount = Array.isArray(rawPlan?.actions) ? rawPlan.actions.length : 1;
        const hasConfiguredLimit = settings.llm.maxSequenceActions > 0;
        const planInput = hasConfiguredLimit && requestedActionCount > settings.llm.maxSequenceActions
            ? {
                intent: 'answer',
                reply: `That request needs ${requestedActionCount} actions. I can safely run up to ${settings.llm.maxSequenceActions} at once, so split it into smaller batches.`,
                source: 'sequence_limit',
            }
            : rawPlan;
        const repairedPlanInput = repairPlanWithEvidence(planInput, state, context);
        const actions = normalizePlanActions(repairedPlanInput);
        const isSequence = actions.length > 1
            || (Array.isArray(repairedPlanInput?.actions) && repairedPlanInput.actions.length > 0);
        const plan = isSequence
            ? {
                intent: 'sequence',
                actions,
                source: String(repairedPlanInput?.source || actions[0]?.source || 'llm'),
            }
            : actions[0] || normalizedPlan(commandModePlan('No valid action was planned.'));
        const decision = isSequence
            ? {
                intent: 'sequence',
                actions: actions.map((action) => planToDecision(action, body)),
                shouldReply: true,
            }
            : planToDecision(plan, body);
        const timeResolution = isSequence
            ? {
                status: 'sequence',
                steps: actions.map((action) => timeResolutionForPlan(action, body, {
                    allowBodyFallback: false,
                })),
            }
            : timeResolutionForPlan(plan, body);

        logJson('Plan parsed', { plan, decision, timeResolution });

        return {
            context,
            plan,
            decision,
            timeResolution,
            nextStep: routeAfterPlan({ decision }),
        };
    }

    async function planNode(state) {
        const body = messageText(state.input.message);
        const context = Object.keys(state.context || {}).length > 0
            ? state.context
            : await messageStore.recentContext(chatId(state.input.chat));
        const commandPlan = parseCommandPlan(body);
        if (commandPlan) {
            logJson('Command plan', commandPlan);
            return stateFromPlan({ state, context, rawPlan: commandPlan });
        }
        try {
            const budgets = [...new Set([
                settings.llm.plannerMaxInputTokens,
                settings.llm.plannerRetryInputTokens,
            ].filter((value) => Number.isFinite(value) && value > 0))];
            let lastError = null;

            for (const [attempt, inputTokenBudget] of budgets.entries()) {
                const lean = attempt > 0 || inputTokenBudget <= 2200;
                const preview = plannerPayload({
                    input: state.input,
                    context,
                    inputTokenBudget,
                    lean,
                });
                logger.info(`Planner payload attempt=${attempt + 1} estimated=${preview.estimatedTokens} context=${preview.contextTokens} budget=${inputTokenBudget}.`);

                try {
                    const { response } = await invokePlannerChain({
                        plannerModels,
                        input: state.input,
                        context,
                        inputTokenBudget,
                        lean,
                    });
                    const parsed = safeJson(response.content);
                    if (!parsed) throw new Error('invalid_plan_json');
                    const finalPlan = parsed.plan || parsed.final || parsed;
                    return stateFromPlan({ state, context, rawPlan: finalPlan });
                } catch (error) {
                    lastError = error;
                    const canRetrySmaller = error?.status === 413 && attempt < budgets.length - 1;
                    if (!canRetrySmaller) throw error;
                    logger.warn(`Planner model rejected payload at estimated=${preview.estimatedTokens}; retrying with lean context.`);
                }
            }

            throw lastError || new Error('planner_failed');
        } catch (error) {
            logger.warn('Planner decision failed; command mode remains available.', error);
            return stateFromPlan({
                state,
                context,
                rawPlan: commandModePlan('LLM mode is unavailable, sir. Use command mode:'),
            });
        }
    }

    async function toolsNode(state) {
        const input = state.input;
        const body = messageText(input.message);

        async function runAction(decision, timeResolution) {
            let actionResult = {};
            if (decision.intent === 'schedule') {
                actionResult = await scheduleMeeting({
                    decision,
                    timeResolution,
                    context: state.context,
                    chat: input.chat,
                    triggerMessage: input.message,
                    messageStore,
                });
            } else if (decision.intent === 'reminder') {
                actionResult = await createStandaloneReminder({
                    decision,
                    timeResolution,
                    chat: input.chat,
                    triggerMessage: input.message,
                    messageStore,
                });
            } else if (decision.intent === 'update') {
                actionResult = await updateActiveItem({
                    decision,
                    timeResolution,
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
            } else if (decision.intent === 'answer' || decision.intent === 'refuse') {
                actionResult = {
                    status: decision.intent === 'answer' ? 'answered' : 'refused',
                    type: decision.intent,
                    reply: decision.response || '',
                };
            }

            return actionResult;
        }

        if (state.decision.intent !== 'sequence') {
            const actionResult = await runAction(state.decision, state.timeResolution);
            logJson('Action result', actionResult);
            return { actionResult, nextStep: 'respond' };
        }

        const { actionResult, timeResolution } = await executePlanSequence({
            actions: state.plan.actions,
            body,
            runAction,
        });

        logJson('Sequence result', actionResult);
        return { actionResult, timeResolution, nextStep: 'respond' };
    }

    async function respondNode(state) {
        if (shouldUseDeterministicReply(state)) {
            const reply = safeReplyForState(state, deterministicBotReply(state));
            logJson('Final deterministic reply', reply);
            return { reply, nextStep: 'end' };
        }

        if (!responseModel) responseModel = createLlmModel(settings.llm.responseModel, 'response');

        const payload = responsePayload(state);
        const estimated = estimateTokens(CHARON_RESPONSE_PROMPT) + estimateTokens(payload);
        try {
            const response = await responseModel.invoke([
                new SystemMessage(CHARON_RESPONSE_PROMPT),
                new HumanMessage(payload),
            ], { json: true, maxOutputTokens: settings.llm.responseMaxOutputTokens });

            logModelUsage('Response', response, estimated);
            logJson('Response raw', response.content);

            const parsed = safeJson(response.content);
            const reply = String(parsed?.reply || '').trim();
            if (!reply) throw new Error('invalid_response_json');
            const safeReply = safeReplyForState(state, reply);
            logJson('Final reply', safeReply);
            return { reply: safeReply, nextStep: 'end' };
        } catch (error) {
            logger.warn('Response writer failed; using the deterministic result reply.', error);
            const reply = safeReplyForState(state, deterministicBotReply(state));
            return { reply, nextStep: 'end' };
        }
    }

    return new StateGraph(CharonState)
        .addNode('planner', planNode)
        .addNode('tool_runner', toolsNode)
        .addNode('responder', respondNode)
        .addEdge(START, 'planner')
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
        return { reply: commandModePlan('Something failed, sir. Use command mode:').reply };
    }
}

module.exports = {
    createSchedulingGraph,
    deterministicBotReply,
    invokeSchedulingGraph,
    executePlanSequence,
    normalizePlanActions,
    plannerPayload,
    plannerStagePayload,
    plannerStageSystemPrompt,
    repairPlanWithEvidence,
    resolvePlanReferences,
};
