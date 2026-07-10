const { settings } = require('../../config/settings');
const { extractTimezone, formatForChat, normalizeTimezone, parseDate } = require('../../utils/time');

function wantsTimeChange(update) {
    return Boolean(update?.start || update?.end || update?.dueAt || update?.timezone);
}

function relativeTargetKind(update, target) {
    const text = [target, update?.target, update?.kind, update?.text, update?.description, update?.title]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
    const relative = /\b(last|latest|previous|next|nearest|recent|this|that|it)\b/.test(text);
    if (!relative) return '';
    if (/\b(reminder|ping|nudge)\b/.test(text)) return 'reminder';
    if (/\b(meeting|meet|session|schedule)\b/.test(text)) return 'meeting';
    return update?.kind === 'meeting' || update?.kind === 'reminder' ? update.kind : '';
}

function chooseRelativeActiveItem(items, target) {
    const text = String(target || '').toLowerCase();
    if (/\b(last|latest|previous|recent|that|it|this)\b/.test(text)) {
        return [...items].sort((left, right) => (
            new Date(right.item?.createdAt || right.item?.updatedAt || 0)
            - new Date(left.item?.createdAt || left.item?.updatedAt || 0)
        ))[0] || null;
    }
    return items[0] || null;
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
    let resolvedTarget = target;
    let active = await messageStore.findActiveItem({ chatId, target });
    if (!active) {
        const relativeKind = relativeTargetKind(update, target);
        if (relativeKind) {
            const matches = await messageStore.findActiveItems({
                chatId,
                kind: relativeKind,
                target: '',
                limit: 5,
            });
            active = chooseRelativeActiveItem(matches, target);
            if (active?.item?._id) resolvedTarget = String(active.item._id).slice(-6);
        }
    }

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
            target: resolvedTarget,
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
        target: resolvedTarget,
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
