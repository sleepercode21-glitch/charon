function estimateTokens(value) {
    const text = typeof value === 'string' ? value : JSON.stringify(value || '');
    return Math.ceil(text.length / 4);
}

function truncateText(value, maxChars) {
    const text = String(value || '');
    if (text.length <= maxChars) return text;
    return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

function shortId(value) {
    return String(value || '').slice(-6);
}

function pollVoteCounts(poll) {
    const counts = new Map();
    for (const vote of poll.votes || []) {
        for (const option of vote.selectedOptions || []) {
            counts.set(option, (counts.get(option) || 0) + 1);
        }
    }

    return [...counts.entries()]
        .sort((left, right) => right[1] - left[1])
        .map(([option, count]) => ({ option, count }));
}

function pollLeader(poll) {
    return pollVoteCounts(poll)[0] || null;
}

function compactContext(context, options = {}) {
    const maxTokens = options.maxTokens || 1200;
    const maxMessages = options.maxMessages || 10;
    const minMessages = options.minMessages || 3;
    const maxTextChars = options.maxTextChars || 140;
    const maxPolls = options.maxPolls ?? 3;
    const maxMeetings = options.maxMeetings ?? 3;
    const maxReminders = options.maxReminders ?? 3;
    const includeBotMessages = options.includeBotMessages ?? true;
    const sourceMessages = includeBotMessages
        ? (context.messages || [])
        : (context.messages || []).filter((message) => !message.isFromMe);

    let messageLimit = Math.min(maxMessages, sourceMessages.length);
    let textLimit = maxTextChars;
    let compacted = null;

    const build = () => {
        const messages = sourceMessages.slice(-messageLimit).map((message) => ({
            t: message.timestamp,
            from: truncateText(message.senderName || message.senderId, 48),
            msg: truncateText(message.body, textLimit),
            kind: message.type,
            me: Boolean(message.isFromMe),
        }));

        const polls = (context.polls || []).slice(0, maxPolls).map((poll) => {
            const leader = pollLeader(poll);
            return {
            name: truncateText(poll.pollName, 90),
            opts: (poll.options || []).map((option) => truncateText(option.name, 60)),
            leader: leader ? { opt: truncateText(leader.option, 60), n: leader.count } : null,
            votes: pollVoteCounts(poll).slice(0, 5).map((vote) => ({
                opt: truncateText(vote.option, 60),
                n: vote.count,
            })),
            };
        });

        const meetings = (context.meetings || []).slice(0, maxMeetings).map((meeting) => ({
            id: shortId(meeting._id),
            title: truncateText(meeting.title, 80),
            desc: truncateText(meeting.description, 80),
            start: meeting.start,
            end: meeting.end,
            tz: meeting.timezone,
            status: meeting.status,
            link: Boolean(meeting.meetLink),
            updatedAt: meeting.updatedAt,
        }));

        const reminders = (context.reminders || []).slice(0, maxReminders).map((reminder) => ({
            id: shortId(reminder._id),
            text: truncateText(reminder.text, 80),
            dueAt: reminder.dueAt,
            tz: reminder.timezone,
            by: truncateText(reminder.createdBy, 40),
            status: reminder.status,
            updatedAt: reminder.updatedAt,
        }));

        return {
            msgs: messages,
            polls,
            meetings,
            reminders,
            omittedMsgs: Math.max(0, sourceMessages.length - messageLimit),
        };
    };

    while (true) {
        compacted = build();
        const tokens = estimateTokens(compacted);
        if (tokens <= maxTokens) break;

        if (messageLimit > minMessages) {
            messageLimit = Math.max(minMessages, messageLimit - 3);
            continue;
        }

        if (textLimit > 80) {
            textLimit = Math.max(80, Math.floor(textLimit * 0.65));
            continue;
        }

        break;
    }

    const json = JSON.stringify(compacted);
    return {
        json,
        estimatedTokens: estimateTokens(json),
        omitted: { olderMessages: compacted.omittedMsgs || 0 },
    };
}

module.exports = { compactContext, estimateTokens };
