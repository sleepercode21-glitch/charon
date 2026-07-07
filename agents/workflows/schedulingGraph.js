const { Annotation, END, START, StateGraph } = require('@langchain/langgraph');
const { HumanMessage, SystemMessage } = require('@langchain/core/messages');
const { settings } = require('../../config/settings');
const { createLlmModel } = require('../../models/llmWrapper');
const { CHARON_SYSTEM_PROMPT } = require('../../models/prompts/charonSystemPrompt');
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

const COMMAND_TIME_FORMAT = 'MM/DD/YY HH:MM Area/City';
const COMMAND_SCHEDULE_USAGE = `/create schedule | Title | ${COMMAND_TIME_FORMAT}`;
const COMMAND_REMINDER_USAGE = `/create reminder | Text | ${COMMAND_TIME_FORMAT}`;
const COMMAND_SCHEDULE_EXAMPLE = '/create schedule | Banking system design | 07/09/26 20:00 America/Chicago';
const COMMAND_REMINDER_EXAMPLE = '/create reminder | Submit slides | 07/09/26 18:30 Asia/Kolkata';
const COMMAND_HELP = [
    'Charon command mode, sir:',
    '',
    'Create',
    COMMAND_SCHEDULE_USAGE,
    COMMAND_REMINDER_USAGE,
    '',
    'Examples',
    COMMAND_SCHEDULE_EXAMPLE,
    COMMAND_REMINDER_EXAMPLE,
    '',
    'List',
    '/list schedules',
    '/list reminders',
    '/list all',
    '',
    'Cancel',
    '/cancel schedule <id>',
    '/cancel reminder <id>',
    '/cancel all',
    '',
    'Help',
    '/help',
    '',
    'Time must be concrete:',
    COMMAND_TIME_FORMAT,
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
    const match = text.match(/^(\d{2})\/(\d{2})\/(\d{2}|\d{4})\s+([01]\d|2[0-3]):([0-5]\d)\s+([A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+)+|UTC)$/);
    if (!match) return null;

    const [, month, day, year, hour, minute, timezoneText] = match;
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

function parseCommandPlan(rawText) {
    const body = cleanCommandText(rawText);
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
                reply: `Use /create schedule or /create reminder, sir.\n\n${COMMAND_HELP}`,
                source: 'command',
            };
        }

        const createKind = /^reminder/i.test(createMatch[1]) ? 'reminder' : 'schedule';
        const parts = createMatch[2].split('|').map((part) => part.trim()).filter(Boolean);
        const title = parts[0] || '';
        const whenInput = parts.length >= 4 ? `${parts[1]} ${parts[2]} ${parts[3]}` : parts[1] || '';
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

    if (command === 'list') {
        const listMatch = tail.match(/^(schedules?|meetings?|sessions?|reminders?|all)\b/i);
        if (!listMatch) {
            return {
                intent: 'answer',
                reply: `Use /list schedules, /list reminders, or /list all, sir.\n\n${COMMAND_HELP}`,
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
                reply: `Use /cancel schedule <id>, /cancel reminder <id>, or /cancel all, sir.\n\n${COMMAND_HELP}`,
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
                reply: `Give me the id, sir.\nUse /list schedules or /list reminders first.`,
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
    if (['meeting', 'meetings', 'meet', 'schedule', 'schedules', 'session', 'sessions'].includes(raw)) return 'meeting';
    if (['reminder', 'reminders'].includes(raw)) return 'reminder';
    if (['all', 'both', 'everything', ''].includes(raw)) {
        const body = String(text || '').toLowerCase();
        const hasReminder = /\breminders?\b/.test(body);
        const hasMeeting = /\b(meetings?|meets?|sessions?)\b/.test(body);
        if (hasReminder && !hasMeeting) return 'reminder';
        if (hasMeeting && !hasReminder) return 'meeting';
        return null;
    }
    return null;
}

function compactForPlanner(context, message) {
    return compactContext(withoutCurrentMessage(context, message), {
        maxTokens: settings.llm.contextTokenBudget,
        maxMessages: settings.llm.maxContextMessages,
        minMessages: 4,
        maxTextChars: 140,
        maxPolls: 3,
        maxMeetings: 5,
        maxReminders: 5,
        includeBotMessages: false,
    });
}

function plannerPayload({ input, context }) {
    const message = input.message;
    const compact = compactForPlanner(context, message);
    const body = messageText(message);

    return JSON.stringify({
        now: currentDateContext(input.timezone),
        defaultTz: input.timezone,
        requester: input.storedMessage?.senderName || message.author || message.from || 'unknown',
        msg: body,
        ctx: JSON.parse(compact.json),
        budget: {
            ctxTokens: compact.estimatedTokens,
            omittedOlderMessages: compact.omitted?.olderMessages || 0,
        },
    });
}

function hasTimeRequest(plan) {
    return Boolean(plan.date || plan.time);
}

function whenText(plan) {
    if (!plan.date && !plan.time) return '';
    return [plan.date, plan.time, plan.timezone].filter(Boolean).join(' ').trim();
}

function timeResolutionForPlan(plan, body) {
    const intent = normalizedIntent(plan.intent);
    const when = whenText(plan);
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
        intent: state.decision.intent,
        plan: state.plan,
        result: state.actionResult,
        time: state.timeResolution,
    });
}

function sanitizeReply(reply) {
    return String(reply || '')
        .replace(/@\d{5,}(?:@\S+)?/g, 'sir')
        .replace(/\b\d{5,}@(c\.us|lid|s\.whatsapp\.net)\b/g, 'sir')
        .replace(/\bsir\s+sir\b/gi, 'sir')
        .replace(/\s+([,.;!?])/g, '$1')
        .replace(/([,.;!?])([^\s])/g, '$1 $2')
        .replace(/\s+/g, ' ')
        .trim();
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

    if (result.status === 'scheduled' && result.type === 'reminder') {
        return `Noted, sir. I'll remind the group: ${result.text} (${result.when}).`;
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
    if (result.status === 'failed' && result.reason) return `I could not finish that, sir: ${result.reason}`;

    return 'Done, sir.';
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
        const repairedPlan = repairAnswerPlan(plan, body);
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

    async function planNode(state) {
        const body = messageText(state.input.message);
        const commandPlan = parseCommandPlan(body);
        if (commandPlan) {
            const context = await messageStore.recentContext(chatId(state.input.chat));
            logJson('Command plan', commandPlan);
            return stateFromPlan({ state, context, rawPlan: commandPlan });
        }

        if (!model) model = createLlmModel();

        const id = chatId(state.input.chat);
        const context = await messageStore.recentContext(id);
        const payload = plannerPayload({ input: state.input, context });
        const estimated = estimateTokens(CHARON_SYSTEM_PROMPT) + estimateTokens(payload);
        try {
            const response = await model.invoke([
                new SystemMessage(CHARON_SYSTEM_PROMPT),
                new HumanMessage(payload),
            ], { json: true, maxOutputTokens: settings.llm.planMaxOutputTokens });

            logModelUsage('Plan', response, estimated);
            logJson('Plan raw', response.content);

            const parsed = safeJson(response.content) || {
                intent: 'answer',
                reply: 'I could not read that cleanly. Say it once more plainly.',
            };

            return stateFromPlan({ state, context, rawPlan: parsed });
        } catch (error) {
            logger.warn('Planner LLM failed; command mode remains available.', error);
            return stateFromPlan({
                state,
                context,
                rawPlan: {
                    intent: 'answer',
                    reply: `LLM credits or service are unavailable, sir.\n${COMMAND_HELP}`,
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
        if (String(state.plan?.source || '').startsWith('command')) {
            const reply = sanitizeReply(fallbackReply(state));
            logJson('Final command reply', reply);
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
            const reply = sanitizeReply(String(parsed?.reply || '').trim() || fallbackReply(state));
            logJson('Final reply', reply);
            return { reply, nextStep: 'end' };
        } catch (error) {
            logger.warn('Response writer failed; using fallback reply.', error);
            return { reply: sanitizeReply(fallbackReply(state)), nextStep: 'end' };
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
        return { reply: 'Something jammed in the machinery, sir. Try that once more.' };
    }
}

module.exports = { createSchedulingGraph, invokeSchedulingGraph };
