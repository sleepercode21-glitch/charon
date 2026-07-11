const { settings } = require('../../config/settings');
const { extractTimezone, formatForChat, normalizeTimezone, parseDate } = require('../../utils/time');

function explicitlyImmediate(text) {
    return /\b(now|right now|asap|immediately|in 0\s*(m|min|minute|h|hour)s?)\b/i.test(String(text || ''));
}

async function createStandaloneReminder({ decision, timeResolution, chat, triggerMessage, messageStore }) {
    if (timeResolution?.status === 'needs_clarification') {
        return {
            status: 'failed',
            need: 'reminder_time',
            clarification: timeResolution.clarification || 'I need the exact reminder time and timezone.',
            reason: timeResolution.reason || 'Time resolver requested clarification.',
        };
    }

    const reminder = decision.reminder || {};
    const resolvedAt = timeResolution?.status === 'resolved' ? timeResolution.start : null;
    const resolvedTimezone = timeResolution?.status === 'resolved' ? timeResolution.timezone : null;
    const sourceText = [resolvedAt, reminder.dueAt].filter(Boolean).join(' ');
    const timezone = normalizeTimezone(resolvedTimezone || reminder.timezone, extractTimezone(sourceText, settings.timezone));
    const dueAt = parseDate(resolvedAt, new Date(), timezone) || parseDate(reminder.dueAt, new Date(), timezone);

    if (!dueAt) {
        return {
            status: 'failed',
            need: 'reminder_time',
            reason: 'No resolvable reminder time.',
        };
    }

    const triggerText = [
        triggerMessage.body,
        triggerMessage.caption,
        triggerMessage._data?.body,
        triggerMessage._data?.caption,
    ].filter(Boolean).join(' ');
    const nowMs = Date.now();
    if (dueAt.getTime() < nowMs - 1000) {
        return {
            status: 'failed',
            need: 'reminder_time',
            clarification: 'That reminder time is in the past. Send me a future date and time.',
            reason: 'past_time',
        };
    }

    if (dueAt.getTime() <= nowMs + 30 * 1000 && !explicitlyImmediate(triggerText)) {
        return {
            status: 'failed',
            need: 'reminder_time',
            clarification: 'I found no future time for that reminder. What day and time should I use?',
            reason: 'Refused to schedule an implicit immediate reminder.',
        };
    }

    const text = reminder.text || reminder.title || 'Reminder';
    const reminderDoc = await messageStore.createStandaloneReminder({
        chatId: chat.id?._serialized || chat.id,
        chatName: chat.name || '',
        text,
        dueAt,
        timezone,
        createdBy: triggerMessage.author || triggerMessage.from || '',
        sourceMessageIds: [triggerMessage.id?._serialized || triggerMessage.id || ''],
        status: 'pending',
    });

    return {
        status: 'scheduled',
        type: 'reminder',
        id: String(reminderDoc._id || '').slice(-6),
        text,
        when: formatForChat(dueAt, timezone),
    };
}

module.exports = { createStandaloneReminder };
