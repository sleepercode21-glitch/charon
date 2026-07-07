const { settings } = require('../../config/settings');
const { createGoogleMeetSpace } = require('../../providers/googleMeet');
const {
    extractTimezone,
    formatForChat,
    normalizeTimezone,
    parseDate,
} = require('../../utils/time');

function winnerFromPolls(polls) {
    for (const poll of polls || []) {
        const counts = new Map();
        for (const vote of poll.votes || []) {
            for (const option of vote.selectedOptions || []) {
                counts.set(option, (counts.get(option) || 0) + 1);
            }
        }

        if (counts.size === 0) continue;

        return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    }

    return null;
}

function emailAttendees(attendees = []) {
    return [...new Set(attendees
        .map((attendee) => {
            if (typeof attendee === 'string') return attendee.trim();
            return String(attendee?.email || '').trim();
        })
        .filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))];
}

function explicitlyImmediate(text) {
    return /\b(now|right now|asap|immediately|in 0\s*(m|min|minute|h|hour)s?)\b/i.test(String(text || ''));
}

function shortId(value) {
    return String(value || '').slice(-6);
}

async function scheduleMeeting({ decision, timeResolution, context, chat, triggerMessage, messageStore }) {
    if (timeResolution?.status === 'needs_clarification') {
        return {
            status: 'failed',
            need: 'meeting_time',
            clarification: timeResolution.clarification || 'I need the exact meeting time and timezone.',
            reason: timeResolution.reason || 'Time resolver requested clarification.',
        };
    }

    const pollWinner = winnerFromPolls(context?.polls);
    const meeting = decision.meeting || {};
    const resolvedStart = timeResolution?.status === 'resolved' ? timeResolution.start : null;
    const resolvedEnd = timeResolution?.status === 'resolved' ? timeResolution.end : null;
    const resolvedTimezone = timeResolution?.status === 'resolved' ? timeResolution.timezone : null;
    const sourceText = [resolvedStart, meeting.start].filter(Boolean).join(' ');

    const timezone = normalizeTimezone(resolvedTimezone || meeting.timezone, extractTimezone(sourceText, settings.timezone));
    const start = parseDate(resolvedStart, new Date(), timezone)
        || parseDate(meeting.start, new Date(), timezone)
        || parseDate(pollWinner, new Date(), timezone);

    if (!start) {
        return {
            status: 'failed',
            need: 'meeting_time',
            reason: 'No schedulable time found in decision or poll context.',
        };
    }

    const triggerText = [
        triggerMessage.body,
        triggerMessage.caption,
        triggerMessage._data?.body,
        triggerMessage._data?.caption,
    ].filter(Boolean).join(' ');
    if (start.getTime() <= Date.now() + 30 * 1000 && !explicitlyImmediate(triggerText)) {
        return {
            status: 'failed',
            need: 'meeting_time',
            clarification: 'I found no future time for that meet. What day and time should I use?',
            reason: 'Refused to schedule an implicit immediate meeting.',
        };
    }

    const explicitEnd = parseDate(resolvedEnd, new Date(), timezone) || parseDate(meeting.end, new Date(), timezone);
    const end = explicitEnd || new Date(start.getTime() + settings.sessions.defaultDurationMinutes * 60 * 1000);
    const title = meeting.title || 'Tech Up meetup';
    const attendees = emailAttendees(meeting.attendees || []);
    const descriptionLines = [
        meeting.description || 'Scheduled from the Tech Up WhatsApp group.',
        timeResolution?.source ? `Time source: ${timeResolution.source}` : null,
        pollWinner ? `Poll winner: ${pollWinner}` : null,
        `Triggered by WhatsApp message ${triggerMessage.id?._serialized || triggerMessage.id || ''}`,
    ].filter(Boolean);

    const meetResult = await createGoogleMeetSpace();

    const meetingDoc = await messageStore.createMeeting({
        chatId: chat.id?._serialized || chat.id,
        chatName: chat.name || '',
        title,
        description: descriptionLines.join('\n'),
        start,
        end,
        timezone,
        attendees,
        sourceMessageIds: [triggerMessage.id?._serialized || triggerMessage.id || ''],
        meetLink: meetResult.meetLink || '',
        meetSpaceName: meetResult.spaceName || '',
        meetingCode: meetResult.meetingCode || '',
        status: meetResult.created ? 'scheduled' : 'failed',
        failureReason: meetResult.reason,
    });

    if (!meetResult.created) {
        return {
            status: 'failed',
            type: 'meeting',
            title,
            when: formatForChat(start, timezone),
            reason: meetResult.reason,
        };
    }

    return {
        status: 'scheduled',
        type: 'meeting',
        id: shortId(meetingDoc._id),
        title,
        when: formatForChat(start, timezone),
        meetLink: meetResult.meetLink,
        meetingCode: meetResult.meetingCode || '',
        attendeeCount: attendees.length,
    };
}

module.exports = { scheduleMeeting };
