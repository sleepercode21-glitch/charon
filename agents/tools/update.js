const { settings } = require('../../config/settings');
const { extractTimezone, formatForChat, normalizeTimezone, parseDate } = require('../../utils/time');

function wantsTimeChange(update) {
    return Boolean(update?.start || update?.end || update?.dueAt || update?.timezone);
}

function canReviveCancelledMeeting(update, target) {
    const text = [target, update?.text, update?.description, update?.title].filter(Boolean).join(' ');
    return /\b(last|cancelled|canceled|previous|it|that|meet|meeting|session)\b/i.test(text)
        || /\breschedule\b/i.test(text);
}

function resolvedDate(timeResolution, fallback, timezone) {
    const resolved = timeResolution?.status === 'resolved' ? timeResolution.start : null;
    return parseDate(resolved, new Date(), timezone) || parseDate(fallback, new Date(), timezone);
}

function resolvedEndDate(timeResolution, fallback, timezone) {
    const resolved = timeResolution?.status === 'resolved' ? timeResolution.end : null;
    return parseDate(resolved, new Date(), timezone) || parseDate(fallback, new Date(), timezone);
}

async function updateActiveItem({ decision, timeResolution, chat, messageStore }) {
    const update = decision.update || {};
    const target = update.target || '';
    const chatId = chat.id?._serialized || chat.id;
    let active = await messageStore.findActiveItem({ chatId, target });

    if (!active) {
        if (canReviveCancelledMeeting(update, target) && wantsTimeChange(update)) {
            const sourceText = [
                timeResolution?.status === 'resolved' ? timeResolution.start : null,
                update.start,
                update.dueAt,
            ].filter(Boolean).join(' ');
            const timezone = normalizeTimezone(
                timeResolution?.timezone || update.timezone,
                extractTimezone(sourceText, settings.timezone),
            );
            const start = resolvedDate(timeResolution, update.start || update.dueAt, timezone);

            if (!start) {
                return {
                    status: 'failed',
                    type: 'update',
                    need: 'new_meeting_time',
                };
            }

            const result = await messageStore.rescheduleLatestCancelledMeeting({
                chatId,
                target: '',
                updates: {
                    title: update.title || null,
                    description: update.description || null,
                    start,
                    end: new Date(start.getTime() + settings.sessions.defaultDurationMinutes * 60 * 1000),
                    timezone,
                },
            });

            if (result.updated) {
                return {
                    status: 'updated',
                    id: String(result.item?._id || '').slice(-6),
                    type: 'meeting',
                    label: result.label,
                    when: formatForChat(start, timezone),
                };
            }
        }

        return {
            status: 'failed',
            type: 'update',
            target,
            reason: target ? 'no_matching_active_item' : 'no_active_item',
        };
    }

    const requestedTimeChange = wantsTimeChange(update);
    if (requestedTimeChange && timeResolution?.status === 'needs_clarification') {
        return {
            status: 'failed',
            type: 'update',
            need: 'new_time',
            clarification: timeResolution.clarification || 'I need the exact new date, time, and timezone.',
            reason: timeResolution.reason,
        };
    }

    if (active.type === 'reminder') {
        const sourceText = [
            timeResolution?.status === 'resolved' ? timeResolution.start : null,
            update.dueAt,
            update.start,
        ].filter(Boolean).join(' ');
        const timezone = normalizeTimezone(
            timeResolution?.timezone || update.timezone || active.item.timezone,
            extractTimezone(sourceText, settings.timezone),
        );
        const dueAt = requestedTimeChange
            ? resolvedDate(timeResolution, update.dueAt || update.start, timezone)
            : null;
        const text = update.text || update.title || null;

        if (requestedTimeChange && !dueAt) {
            return {
                status: 'failed',
                type: 'update',
                need: 'new_reminder_time',
            };
        }

        const result = await messageStore.updateActiveItem({
            chatId,
            target,
            updates: {
                text,
                dueAt,
                timezone: requestedTimeChange ? timezone : null,
            },
        });

        if (!result.updated) {
            return {
                status: 'failed',
                type: 'update',
                reason: result.reason || 'update_failed',
            };
        }

        return {
            status: 'updated',
            id: String(result.item?._id || '').slice(-6),
            type: 'reminder',
            label: result.label,
            when: dueAt ? formatForChat(dueAt, timezone) : '',
        };
    }

    const sourceText = [
        timeResolution?.status === 'resolved' ? timeResolution.start : null,
        update.start,
        update.dueAt,
    ].filter(Boolean).join(' ');
    const timezone = normalizeTimezone(
        timeResolution?.timezone || update.timezone || active.item.timezone,
        extractTimezone(sourceText, settings.timezone),
    );
    const start = requestedTimeChange
        ? resolvedDate(timeResolution, update.start || update.dueAt, timezone)
        : null;
    const explicitEnd = requestedTimeChange
        ? resolvedEndDate(timeResolution, update.end, timezone)
        : null;

    if (requestedTimeChange && !start) {
        return {
            status: 'failed',
            type: 'update',
            need: 'new_meeting_time',
        };
    }

    const previousStart = new Date(active.item.start);
    const previousEnd = new Date(active.item.end);
    const previousDurationMs = Number.isFinite(previousEnd.getTime() - previousStart.getTime())
        ? previousEnd.getTime() - previousStart.getTime()
        : settings.sessions.defaultDurationMinutes * 60 * 1000;
    const end = explicitEnd || (start ? new Date(start.getTime() + previousDurationMs) : null);
    const title = update.title || null;
    const description = update.description || null;

    const result = await messageStore.updateActiveItem({
        chatId,
        target,
        updates: {
            title,
            description,
            start,
            end,
            timezone: requestedTimeChange ? timezone : null,
        },
    });

    if (!result.updated) {
        return {
            status: 'failed',
            type: 'update',
            reason: result.reason || 'update_failed',
        };
    }

    return {
        status: 'updated',
        id: String(result.item?._id || '').slice(-6),
        type: 'meeting',
        label: result.label,
        when: start ? formatForChat(start, timezone) : '',
    };
}

module.exports = { updateActiveItem };
