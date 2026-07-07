const { settings } = require('../../config/settings');
const { extractTimezone, formatForChat, normalizeTimezone, parseDate } = require('../../utils/time');

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
