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

function pollLeaders(poll) {
    const counts = pollVoteCounts(poll);
    if (!counts.length) return [];
    const highest = counts[0].count;
    return counts.filter((vote) => vote.count === highest);
}

function compactPoll(poll, options = {}) {
    if (!poll) return null;

    const maxNameChars = options.maxNameChars || 110;
    const maxOptionChars = options.maxOptionChars || 80;
    const maxVotes = options.maxVotes || 8;
    const leader = pollLeader(poll);
    const leaders = pollLeaders(poll);
    const counts = new Map(pollVoteCounts(poll).map((vote) => [vote.option, vote.count]));

    return {
        name: truncateText(poll.pollName, maxNameChars),
        updatedAt: poll.updatedAt,
        opts: (poll.options || []).map((option) => ({
            name: truncateText(option.name, maxOptionChars),
            n: counts.get(option.name) || 0,
        })),
        leader: leader ? { opt: truncateText(leader.option, maxOptionChars), n: leader.count } : null,
        leaders: leaders.map((vote) => ({
            opt: truncateText(vote.option, maxOptionChars),
            n: vote.count,
        })),
        tied: leaders.length > 1,
        ballots: (poll.votes || []).length,
        votes: pollVoteCounts(poll).slice(0, maxVotes).map((vote) => ({
            opt: truncateText(vote.option, maxOptionChars),
            n: vote.count,
        })),
    };
}

function compactMeeting(meeting) {
    return {
        id: shortId(meeting._id),
        title: truncateText(meeting.title, 80),
        desc: truncateText(meeting.description, 80),
        start: meeting.start,
        end: meeting.end,
        tz: meeting.timezone,
        status: meeting.status,
        link: Boolean(meeting.meetLink),
        createdAt: meeting.createdAt,
        updatedAt: meeting.updatedAt,
    };
}

function compactReminder(reminder) {
    return {
        id: shortId(reminder._id),
        text: truncateText(reminder.text, 80),
        dueAt: reminder.dueAt,
        tz: reminder.timezone,
        by: truncateText(reminder.createdBy, 40),
        status: reminder.status,
        createdAt: reminder.createdAt,
        updatedAt: reminder.updatedAt,
    };
}

function latestMessage(messages, predicate) {
    return messages
        .filter(predicate)
        .sort((left, right) => new Date(right.timestamp || 0) - new Date(left.timestamp || 0))[0]
        || null;
}

function earliestBy(items, field) {
    return [...items].sort((left, right) => new Date(left[field] || 0) - new Date(right[field] || 0))[0] || null;
}

function latestBy(items, field) {
    return [...items].sort((left, right) => new Date(right[field] || 0) - new Date(left[field] || 0))[0] || null;
}

function compactSignals(context, sourceMessages, meetings, reminders, polls) {
    const nextMeeting = earliestBy(
        meetings.filter((meeting) => ['draft', 'scheduled'].includes(meeting.status)),
        'start',
    );
    const nextReminder = earliestBy(
        reminders.filter((reminder) => reminder.status === 'pending'),
        'dueAt',
    );
    const latestHuman = latestMessage(sourceMessages, (message) => !message.isFromMe);
    const latestBot = latestMessage(sourceMessages, (message) => message.isFromMe);
    const latestPoll = latestBy(polls, 'updatedAt');
    const derivedMeetingCount = meetings.filter((meeting) => ['draft', 'scheduled'].includes(meeting.status)).length;
    const derivedReminderCount = reminders.filter((reminder) => reminder.status === 'pending').length;

    return {
        activeCounts: context.activeCounts || {
            meetings: derivedMeetingCount,
            reminders: derivedReminderCount,
            total: derivedMeetingCount + derivedReminderCount,
        },
        nextMeeting: nextMeeting ? compactMeeting(nextMeeting) : null,
        nextReminder: nextReminder ? compactReminder(nextReminder) : null,
        latestHuman: latestHuman ? {
            t: latestHuman.timestamp,
            from: truncateText(latestHuman.senderName || latestHuman.senderId, 48),
            msg: truncateText(latestHuman.body, 180),
        } : null,
        latestBot: latestBot ? {
            t: latestBot.timestamp,
            msg: truncateText(latestBot.body, 180),
        } : null,
        latestPoll: latestPoll ? compactPoll(latestPoll, {
            maxNameChars: 90,
            maxOptionChars: 60,
            maxVotes: 5,
        }) : null,
    };
}

function compactContext(context, options = {}) {
    const maxTokens = options.maxTokens || 1200;
    const maxMessages = options.maxMessages || 10;
    const minMessages = options.minMessages || 3;
    const maxTextChars = options.maxTextChars || 140;
    let pollLimit = Math.min(options.maxPolls ?? 3, (context.polls || []).length);
    let meetingLimit = Math.min(options.maxMeetings ?? 3, (context.meetings || []).length);
    let reminderLimit = Math.min(options.maxReminders ?? 3, (context.reminders || []).length);
    const includeBotMessages = options.includeBotMessages ?? true;
    const sourceMessages = includeBotMessages
        ? (context.messages || [])
        : (context.messages || []).filter((message) => !message.isFromMe);
    const pollsByMessageId = new Map((context.polls || [])
        .filter((poll) => poll.pollMessageId)
        .map((poll) => [String(poll.pollMessageId), poll]));

    let messageLimit = Math.min(maxMessages, sourceMessages.length);
    let textLimit = maxTextChars;
    let compacted = null;

    const build = () => {
        const messages = sourceMessages.slice(-messageLimit).map((message) => {
            const poll = pollsByMessageId.get(String(message.messageId || ''));
            const compactedMessage = {
                t: message.timestamp,
                from: truncateText(message.senderName || message.senderId, 48),
                msg: truncateText(message.body, textLimit),
                kind: message.type,
                me: Boolean(message.isFromMe),
            };

            if (poll || message.pollName || message.pollOptions?.length) {
                compactedMessage.poll = compactPoll(poll || {
                    pollName: message.pollName || message.body,
                    options: message.pollOptions || [],
                    votes: [],
                    updatedAt: message.updatedAt,
                }, {
                    maxNameChars: 90,
                    maxOptionChars: 60,
                    maxVotes: 5,
                });
            }

            return compactedMessage;
        });

        const polls = (context.polls || [])
            .slice(0, pollLimit)
            .map((poll) => compactPoll(poll));

        const meetings = (context.meetings || []).slice(0, meetingLimit).map(compactMeeting);
        const reminders = (context.reminders || []).slice(0, reminderLimit).map(compactReminder);

        return {
            signals: compactSignals(context, sourceMessages, context.meetings || [], context.reminders || [], context.polls || []),
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

        if (meetingLimit > 3 || reminderLimit > 3) {
            meetingLimit = Math.max(3, Math.floor(meetingLimit * 0.7));
            reminderLimit = Math.max(3, Math.floor(reminderLimit * 0.7));
            continue;
        }

        if (pollLimit > 1) {
            pollLimit -= 1;
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
