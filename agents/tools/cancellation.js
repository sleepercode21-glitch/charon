const { logger } = require('../../utils/logger');

const TOOL_TO_KIND = {
    cancelMeetings: 'meeting',
    cancelReminders: 'reminder',
};

function normalizeQuery(value) {
    if (!value) return null;

    const query = String(value).trim();
    if (!query) return null;

    const genericQueries = new Set([
        'all',
        'everything',
        'all active',
        'all sessions',
        'all session',
        'all meetings',
        'all meeting',
        'all events',
        'all event',
        'all reminders',
        'all reminder',
        'sessions and reminders',
        'session and reminders',
        'meetings and reminders',
        'meeting and reminders',
        'all sessions and reminders',
        'all meetings and reminders',
        'all events and reminders',
    ]);

    return genericQueries.has(query.toLowerCase()) ? null : query;
}

function normalizeToolCalls(decision) {
    const toolCalls = decision.cancellation?.toolCalls;
    if (!Array.isArray(toolCalls)) {
        return inferredToolCalls(decision);
    }

    const normalized = toolCalls
        .map((call) => ({
            name: call?.name,
            query: normalizeQuery(call?.arguments?.query),
            limit: Number.isInteger(call?.arguments?.limit) && call.arguments.limit > 0
                ? call.arguments.limit
                : null,
        }))
        .filter((call) => TOOL_TO_KIND[call.name]);

    return normalized.length ? normalized : inferredToolCalls(decision);
}

function inferredToolCalls(decision) {
    const text = [
        decision.cancellation?.target,
        decision.cancellation?.query,
        decision.reason,
    ].filter(Boolean).join(' ').toLowerCase();

    if (text.includes('reminder') && !text.includes('meeting') && !text.includes('session')) {
        return [{ name: 'cancelReminders', query: null, limit: null }];
    }

    if ((text.includes('meeting') || text.includes('session')) && !text.includes('reminder')) {
        return [{ name: 'cancelMeetings', query: null, limit: null }];
    }

    return [
        { name: 'cancelMeetings', query: null, limit: null },
        { name: 'cancelReminders', query: null, limit: null },
    ];
}

function uniqueItems(items) {
    const seen = new Set();
    const unique = [];

    for (const item of items) {
        const key = `${item.type}:${item.item._id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(item);
    }

    return unique;
}

function looksLikeId(value) {
    return /[a-f0-9]{4,24}/i.test(String(value || '').trim());
}

function idMatches(item, query) {
    const match = String(query || '').trim().match(/[a-f0-9]{4,24}/i);
    const needle = match ? match[0].toLowerCase() : '';
    const id = String(item?.item?._id || '').toLowerCase();
    return Boolean(needle && id && (id === needle || id.startsWith(needle) || id.endsWith(needle)));
}

function cancelledItemSummary(active) {
    const item = active.item || {};
    return {
        id: String(item._id || '').slice(-6),
        type: active.type,
        label: active.type === 'meeting'
            ? item.title || 'Meeting'
            : item.text || 'Reminder',
    };
}

async function cancelMeetings({ chatId, query, limit, messageStore }) {
    return messageStore.findActiveItems({
        chatId,
        kind: 'meeting',
        target: query,
        limit,
    });
}

async function cancelReminders({ chatId, query, limit, messageStore }) {
    return messageStore.findActiveItems({
        chatId,
        kind: 'reminder',
        target: query,
        limit,
    });
}

async function runCancellationToolCall({ call, chatId, messageStore }) {
    const args = {
        chatId,
        query: call.query,
        limit: call.limit,
        messageStore,
    };

    let items = [];
    if (call.name === 'cancelMeetings') items = await cancelMeetings(args);
    if (call.name === 'cancelReminders') items = await cancelReminders(args);

    if (items.length === 0 && looksLikeId(call.query)) {
        const kind = TOOL_TO_KIND[call.name];
        const allActive = await messageStore.findActiveItems({
            chatId,
            kind,
            target: null,
            limit: null,
        });
        return allActive.filter((item) => idMatches(item, call.query));
    }

    return items;
}

async function cancelActiveItem({ decision, chat, messageStore }) {
    const chatId = chat.id?._serialized || chat.id;
    const toolCalls = normalizeToolCalls(decision);

    if (toolCalls.length === 0) {
        return {
            status: 'failed',
            type: 'cancellation',
            reason: 'no_valid_tool_calls',
        };
    }

    const batches = await Promise.all(toolCalls.map((call) => runCancellationToolCall({
        call,
        chatId,
        messageStore,
    })));
    const items = uniqueItems(batches.flat());
    logger.info(`Cancellation calls=${JSON.stringify(toolCalls)} matched=${items.length}.`);

    if (items.length === 0) {
        return {
            status: 'nothing_to_cancel',
            type: 'cancellation',
            meetings: 0,
            reminders: 0,
        };
    }

    const meetingIds = items
        .filter((active) => active.type === 'meeting')
        .map((active) => active.item._id);
    const reminderIds = items
        .filter((active) => active.type === 'reminder')
        .map((active) => active.item._id);

    const result = await messageStore.markActiveItemsCancelled({
        meetingIds,
        reminderIds,
    });

    return {
        status: 'cancelled',
        type: 'cancellation',
        meetings: result.meetings,
        reminders: result.reminders,
        requestedMeetings: result.requestedMeetings || meetingIds.length,
        requestedReminders: result.requestedReminders || reminderIds.length,
        skippedMeetings: result.skippedMeetings || 0,
        skippedReminders: result.skippedReminders || 0,
        terminalStatus: result.terminalStatus || 'cancelled',
        cancelledAt: result.cancelledAt || null,
        items: items.map(cancelledItemSummary),
    };
}

module.exports = { cancelActiveItem };
