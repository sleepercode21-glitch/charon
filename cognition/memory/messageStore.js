function serializedId(value) {
    return value?._serialized || value || '';
}

function serializedIds(values) {
    return (values || [])
        .map((value) => serializedId(value))
        .map((value) => String(value || '').trim())
        .filter(Boolean);
}

function pollOptionsFromMessage(message) {
    const options = message.pollOptions
        || message._data?.pollOptions
        || message._data?.pollSelectableOptions
        || [];

    return options.map((option) => {
        if (typeof option === 'string') return { name: option };
        return {
            name: option.name || option.localId || String(option),
            localId: option.localId,
        };
    });
}

function selectedOptionNames(options) {
    return options.map((option) => {
        if (typeof option === 'string') return option;
        return option.name || option.localId || String(option);
    });
}

function escapeRegex(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function targetFilter(fields, target) {
    if (!target) return {};
    const regex = new RegExp(escapeRegex(target), 'i');
    return { $or: fields.map((field) => ({ [field]: regex })) };
}

function shortIdCandidate(value) {
    const match = String(value || '').trim().match(/[a-f0-9]{4,24}/i);
    return match ? match[0].toLowerCase() : '';
}

function looksLikeShortId(value) {
    return Boolean(shortIdCandidate(value));
}

function idMatches(item, target) {
    const needle = shortIdCandidate(target);
    const id = String(item?._id || '').toLowerCase();
    return Boolean(needle && id && (id === needle || id.startsWith(needle) || id.endsWith(needle)));
}

function createMessageStore({ mongoose }) {
    const WhatsAppMessage = mongoose.models.WhatsAppMessage || mongoose.model('WhatsAppMessage', new mongoose.Schema({
        messageId: { type: String, unique: true, index: true },
        chatId: { type: String, index: true },
        chatName: String,
        senderId: { type: String, index: true },
        senderName: String,
        body: String,
        type: String,
        timestamp: Date,
        mentionedIds: [String],
        isFromMe: Boolean,
        pollName: String,
        pollOptions: [{ name: String, localId: String }],
    }, { timestamps: true }));

    const Poll = mongoose.models.Poll || mongoose.model('Poll', new mongoose.Schema({
        pollMessageId: { type: String, unique: true, index: true },
        chatId: { type: String, index: true },
        chatName: String,
        pollName: String,
        options: [{ name: String, localId: String }],
        votes: [{
            voterId: String,
            selectedOptions: [String],
            updatedAt: Date,
        }],
    }, { timestamps: true }));

    const Meeting = mongoose.models.Meeting || mongoose.model('Meeting', new mongoose.Schema({
        chatId: { type: String, index: true },
        chatName: String,
        title: String,
        description: String,
        start: Date,
        end: Date,
        timezone: String,
        attendees: [String],
        sourceMessageIds: [String],
        meetLink: String,
        meetSpaceName: String,
        meetingCode: String,
        status: { type: String, enum: ['draft', 'scheduled', 'failed', 'completed', 'cancelled'], default: 'draft' },
        failureReason: String,
        remindersSent: [{
            key: String,
            leadMinutes: Number,
            sentAt: Date,
            messageId: String,
        }],
    }, { timestamps: true }));

    const StandaloneReminder = mongoose.models.StandaloneReminder || mongoose.model('StandaloneReminder', new mongoose.Schema({
        chatId: { type: String, index: true },
        chatName: String,
        text: String,
        dueAt: { type: Date, index: true },
        timezone: String,
        createdBy: String,
        sourceMessageIds: [String],
        status: { type: String, enum: ['pending', 'sent', 'cancelled', 'failed', 'completed'], default: 'pending', index: true },
        sentAt: Date,
        sentMessageId: String,
        failureReason: String,
        remindersSent: [{
            key: String,
            leadMinutes: Number,
            sentAt: Date,
            messageId: String,
        }],
    }, { timestamps: true }));

    async function upsertWhatsAppMessage({ message, chat, senderName }) {
        const messageId = serializedId(message.id);
        const chatId = serializedId(chat.id);
        const senderId = message.author || message.from;

        const doc = await WhatsAppMessage.findOneAndUpdate(
            { messageId },
            {
                messageId,
                chatId,
                chatName: chat.name || '',
                senderId,
                senderName,
                body: message.body || message.pollName || '',
                type: message.type,
                timestamp: new Date((message.timestamp || Date.now() / 1000) * 1000),
                mentionedIds: serializedIds(message.mentionedIds),
                isFromMe: Boolean(message.fromMe),
                pollName: message.pollName || '',
                pollOptions: pollOptionsFromMessage(message),
            },
            { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
        );

        if (message.type === 'poll_creation' || message.pollName) {
            await Poll.findOneAndUpdate(
                { pollMessageId: messageId },
                {
                    pollMessageId: messageId,
                    chatId,
                    chatName: chat.name || '',
                    pollName: message.pollName || message.body || 'Poll',
                    options: pollOptionsFromMessage(message),
                },
                { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
            );
        }

        return doc;
    }

    async function recordPollVote({ chat, parentMessage, voterId, selectedOptions }) {
        const pollMessageId = serializedId(parentMessage.id);
        const chatId = serializedId(chat.id);
        const names = selectedOptionNames(selectedOptions);

        await Poll.findOneAndUpdate(
            { pollMessageId },
            {
                $set: {
                    pollMessageId,
                    chatId,
                    chatName: chat.name || '',
                    pollName: parentMessage.pollName || parentMessage.body || 'Poll',
                    options: pollOptionsFromMessage(parentMessage),
                },
                $pull: { votes: { voterId } },
            },
            { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
        );

        return Poll.findOneAndUpdate(
            { pollMessageId },
            {
                $push: {
                    votes: {
                        voterId,
                        selectedOptions: names,
                        updatedAt: new Date(),
                    },
                },
            },
            { returnDocument: 'after' },
        );
    }

    async function replacePollVotes({ chat, parentMessage, votes }) {
        const pollMessageId = serializedId(parentMessage.id);
        const chatId = serializedId(chat.id);
        const normalizedVotes = (votes || []).map((vote) => ({
            voterId: vote.voter,
            selectedOptions: selectedOptionNames(vote.selectedOptions || []),
            updatedAt: vote.interractedAtTs ? new Date(vote.interractedAtTs * 1000) : new Date(),
        }));

        return Poll.findOneAndUpdate(
            { pollMessageId },
            {
                pollMessageId,
                chatId,
                chatName: chat.name || '',
                pollName: parentMessage.pollName || parentMessage.body || 'Poll',
                options: pollOptionsFromMessage(parentMessage),
                votes: normalizedVotes,
            },
            { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
        );
    }

    async function recentPolls(chatId, limit = 5) {
        return Poll.find({ chatId }).sort({ createdAt: -1, updatedAt: -1 }).limit(limit).lean();
    }

    async function findPollByMessageId({ chatId, pollMessageId }) {
        if (!pollMessageId) return null;
        return Poll.findOne({ chatId, pollMessageId }).lean();
    }

    async function recentContext(chatId, limit = 80) {
        const [messages, polls, meetings, reminders] = await Promise.all([
            WhatsAppMessage.find({ chatId }).sort({ timestamp: -1 }).limit(limit).lean(),
            Poll.find({ chatId }).sort({ createdAt: -1, updatedAt: -1 }).limit(10).lean(),
            Meeting.find({ chatId }).sort({ createdAt: -1 }).limit(12).lean(),
            StandaloneReminder.find({ chatId }).sort({ createdAt: -1 }).limit(12).lean(),
        ]);

        return {
            messages: messages.reverse(),
            polls,
            meetings,
            reminders,
        };
    }

    async function hasOpenClarification({ chatId, senderId, maxAgeMs = 15 * 60 * 1000 }) {
        const since = new Date(Date.now() - maxAgeMs);
        const clarification = await WhatsAppMessage.findOne({
            chatId,
            isFromMe: true,
            timestamp: { $gte: since },
            body: /\b(exact time|timezone|time zone|confirm|one more detail|which time)\b/i,
        }).sort({ timestamp: -1 }).lean();

        if (!clarification) return false;

        const newerBotReply = await WhatsAppMessage.exists({
            chatId,
            isFromMe: true,
            timestamp: { $gt: clarification.timestamp },
            body: { $not: /\b(exact time|timezone|time zone|confirm|one more detail|which time)\b/i },
        });

        if (newerBotReply) return false;

        const senderMessage = await WhatsAppMessage.exists({
            chatId,
            senderId,
            isFromMe: false,
            timestamp: { $gt: clarification.timestamp },
        });

        return Boolean(senderMessage);
    }

    async function createMeeting(meeting) {
        return Meeting.create(meeting);
    }

    async function findDuplicateMeeting({ chatId, title, start, windowMs = 60 * 1000 }) {
        if (!chatId || !start) return null;
        const when = new Date(start);
        if (Number.isNaN(when.getTime())) return null;

        const timeWindow = {
            chatId,
            status: { $in: ['draft', 'scheduled'] },
            start: {
                $gte: new Date(when.getTime() - windowMs),
                $lte: new Date(when.getTime() + windowMs),
            },
        };

        if (!title) {
            return Meeting.findOne(timeWindow).sort({ createdAt: -1 }).lean();
        }

        const exactTitle = await Meeting.findOne({
            ...timeWindow,
            title: new RegExp(`^${escapeRegex(title)}$`, 'i'),
        }).sort({ createdAt: -1 }).lean();

        if (exactTitle) return exactTitle;

        return Meeting.findOne({
            chatId,
            status: { $in: ['draft', 'scheduled'] },
            start: {
                $gte: new Date(when.getTime() - windowMs),
                $lte: new Date(when.getTime() + windowMs),
            },
        }).sort({ createdAt: -1 }).lean();
    }

    async function pendingReminders({ now, leadMinutes, dueGraceMs }) {
        const largestLeadMs = Math.max(...leadMinutes) * 60 * 1000;
        const meetings = await Meeting.find({
            status: { $in: ['draft', 'scheduled'] },
            start: {
                $gte: new Date(now.getTime() - dueGraceMs),
                $lte: new Date(now.getTime() + largestLeadMs),
            },
        }).lean();

        const due = [];
        for (const meeting of meetings) {
            const sentKeys = new Set((meeting.remindersSent || []).map((reminder) => reminder.key));
            const meetingDue = [];
            for (const lead of leadMinutes) {
                const key = lead === 0 ? 'started' : `before_${lead}m`;
                if (sentKeys.has(key)) continue;

                const dueAt = new Date(new Date(meeting.start).getTime() - lead * 60 * 1000);
                if (lead > 0 && meeting.createdAt && dueAt < new Date(meeting.createdAt)) continue;
                const isDue = dueAt <= now && dueAt >= new Date(now.getTime() - dueGraceMs);
                if (isDue) {
                    meetingDue.push({ meeting, key, leadMinutes: lead, dueAt });
                }
            }
            meetingDue.sort((left, right) => left.leadMinutes - right.leadMinutes);
            if (meetingDue[0]) due.push(meetingDue[0]);
        }

        return due;
    }

    async function markReminderSent({ meetingId, key, leadMinutes, sentAt, messageId }) {
        return Meeting.updateOne(
            { _id: meetingId, 'remindersSent.key': { $ne: key } },
            {
                $push: {
                    remindersSent: {
                        key,
                        leadMinutes,
                        sentAt,
                        messageId,
                    },
                },
            },
        );
    }

    async function createStandaloneReminder(reminder) {
        return StandaloneReminder.create(reminder);
    }

    async function pendingStandaloneReminderEvents({ now, leadMinutes, dueGraceMs }) {
        const largestLeadMs = Math.max(...leadMinutes) * 60 * 1000;
        const reminders = await StandaloneReminder.find({
            status: 'pending',
            dueAt: {
                $gte: new Date(now.getTime() - dueGraceMs),
                $lte: new Date(now.getTime() + largestLeadMs),
            },
        }).lean();

        const due = [];
        for (const reminder of reminders) {
            const sentKeys = new Set((reminder.remindersSent || []).map((item) => item.key));
            const reminderDue = [];
            for (const lead of leadMinutes) {
                const key = lead === 0 ? 'started' : `before_${lead}m`;
                if (sentKeys.has(key)) continue;

                const dueAt = new Date(new Date(reminder.dueAt).getTime() - lead * 60 * 1000);
                if (lead > 0 && reminder.createdAt && dueAt < new Date(reminder.createdAt)) continue;
                const isDue = dueAt <= now && dueAt >= new Date(now.getTime() - dueGraceMs);
                if (isDue) {
                    reminderDue.push({ reminder, key, leadMinutes: lead, dueAt });
                }
            }
            reminderDue.sort((left, right) => left.leadMinutes - right.leadMinutes);
            if (reminderDue[0]) due.push(reminderDue[0]);
        }

        return due;
    }

    async function markStandaloneReminderSent({ reminderId, key, leadMinutes, sentAt, messageId }) {
        const update = {
            $push: {
                remindersSent: {
                    key,
                    leadMinutes,
                    sentAt,
                    messageId,
                },
            },
        };

        if (key === 'started') {
            update.$set = {
                status: 'sent',
                sentAt,
                sentMessageId: messageId,
            };
        }

        return StandaloneReminder.updateOne(
            { _id: reminderId, status: 'pending', 'remindersSent.key': { $ne: key } },
            update,
        );
    }

    async function markActiveItemDone({ chatId, target }) {
        const now = new Date();
        const reminderFilter = {
            chatId,
            status: 'pending',
            ...targetFilter(['text'], target),
        };
        const meetingFilter = {
            chatId,
            status: { $in: ['draft', 'scheduled'] },
            start: { $gte: new Date(now.getTime() - 2 * 60 * 60 * 1000) },
            ...targetFilter(['title', 'description'], target),
        };

        const [reminder, meeting] = await Promise.all([
            StandaloneReminder.findOne(reminderFilter).sort({ dueAt: 1, createdAt: -1 }),
            Meeting.findOne(meetingFilter).sort({ start: 1, createdAt: -1 }),
        ]);

        if (!reminder && !meeting) return { completed: false };

        const reminderCreated = reminder?.createdAt ? new Date(reminder.createdAt).getTime() : 0;
        const meetingCreated = meeting?.createdAt ? new Date(meeting.createdAt).getTime() : 0;
        const completeReminder = reminder && (!meeting || reminderCreated >= meetingCreated);

        if (completeReminder) {
            await StandaloneReminder.updateOne(
                { _id: reminder._id },
                { $set: { status: 'completed' } },
            );
            return { completed: true, type: 'reminder', label: `reminder "${reminder.text}"` };
        }

        await Meeting.updateOne(
            { _id: meeting._id },
            { $set: { status: 'completed' } },
        );
        return { completed: true, type: 'meeting', label: `meeting "${meeting.title}"` };
    }

    async function findActiveItem({ chatId, target }) {
        const now = new Date();
        const baseReminderFilter = {
            chatId,
            status: 'pending',
        };
        const baseMeetingFilter = {
            chatId,
            status: { $in: ['draft', 'scheduled'] },
            start: { $gte: new Date(now.getTime() - 2 * 60 * 60 * 1000) },
        };
        const reminderFilter = {
            ...baseReminderFilter,
            ...targetFilter(['text'], target),
        };
        const meetingFilter = {
            ...baseMeetingFilter,
            ...targetFilter(['title', 'description'], target),
        };

        let [reminder, meeting] = await Promise.all([
            StandaloneReminder.findOne(reminderFilter).sort({ dueAt: 1, createdAt: -1 }),
            Meeting.findOne(meetingFilter).sort({ start: 1, createdAt: -1 }),
        ]);

        if (!reminder && !meeting && looksLikeShortId(target)) {
            const [reminders, meetings] = await Promise.all([
                StandaloneReminder.find(baseReminderFilter).sort({ dueAt: 1, createdAt: -1 }).limit(20),
                Meeting.find(baseMeetingFilter).sort({ start: 1, createdAt: -1 }).limit(20),
            ]);
            reminder = reminders.find((item) => idMatches(item, target)) || null;
            meeting = meetings.find((item) => idMatches(item, target)) || null;
        }

        if (!reminder && !meeting) return null;

        const reminderCreated = reminder?.createdAt ? new Date(reminder.createdAt).getTime() : 0;
        const meetingCreated = meeting?.createdAt ? new Date(meeting.createdAt).getTime() : 0;
        if (reminder && (!meeting || reminderCreated >= meetingCreated)) {
            return {
                type: 'reminder',
                item: reminder,
                label: `reminder "${reminder.text}"`,
            };
        }

        return {
            type: 'meeting',
            item: meeting,
            label: `meeting "${meeting.title}"`,
        };
    }

    async function rescheduleLatestCancelledMeeting({ chatId, target, updates }) {
        const meeting = await Meeting.findOne({
            chatId,
            status: 'cancelled',
            ...targetFilter(['title', 'description'], target),
        }).sort({ updatedAt: -1, createdAt: -1 });

        if (!meeting) return { updated: false, reason: 'no_matching_cancelled_meeting' };

        const set = {
            status: 'scheduled',
            remindersSent: [],
        };
        if (updates.title) set.title = updates.title;
        if (updates.description) set.description = updates.description;
        if (updates.start) set.start = updates.start;
        if (updates.end) set.end = updates.end;
        if (updates.timezone) set.timezone = updates.timezone;

        const item = await Meeting.findOneAndUpdate(
            { _id: meeting._id, status: 'cancelled' },
            { $set: set },
            { returnDocument: 'after' },
        );

        return {
            updated: Boolean(item),
            type: 'meeting',
            item,
            previousItem: meeting,
            label: item ? `meeting "${item.title}"` : `meeting "${meeting.title}"`,
        };
    }

    async function findActiveItems({ chatId, kind, target, limit }) {
        const now = new Date();
        const includeMeetings = !kind || kind === 'meeting';
        const includeReminders = !kind || kind === 'reminder';
        const perKindLimit = Number.isInteger(limit) && limit > 0 ? limit : 0;

        const reminderQuery = StandaloneReminder.find({
            chatId,
            status: 'pending',
            ...targetFilter(['text'], target),
        }).sort({ dueAt: 1, createdAt: -1 });
        const meetingQuery = Meeting.find({
            chatId,
            status: { $in: ['draft', 'scheduled'] },
            start: { $gte: new Date(now.getTime() - 2 * 60 * 60 * 1000) },
            ...targetFilter(['title', 'description'], target),
        }).sort({ start: 1, createdAt: -1 });

        if (perKindLimit) {
            reminderQuery.limit(perKindLimit);
            meetingQuery.limit(perKindLimit);
        }

        let [reminders, meetings] = await Promise.all([
            includeReminders ? reminderQuery : [],
            includeMeetings ? meetingQuery : [],
        ]);

        if (target && looksLikeShortId(target) && reminders.length + meetings.length === 0) {
            const [idReminders, idMeetings] = await Promise.all([
                includeReminders
                    ? StandaloneReminder.find({
                        chatId,
                        status: 'pending',
                    }).sort({ dueAt: 1, createdAt: -1 }).limit(20)
                    : [],
                includeMeetings
                    ? Meeting.find({
                        chatId,
                        status: { $in: ['draft', 'scheduled'] },
                        start: { $gte: new Date(now.getTime() - 2 * 60 * 60 * 1000) },
                    }).sort({ start: 1, createdAt: -1 }).limit(20)
                    : [],
            ]);

            reminders = idReminders.filter((item) => idMatches(item, target));
            meetings = idMeetings.filter((item) => idMatches(item, target));
        }

        return [
            ...meetings.map((meeting) => ({
                type: 'meeting',
                item: meeting,
                label: `meeting "${meeting.title}"`,
            })),
            ...reminders.map((reminder) => ({
                type: 'reminder',
                item: reminder,
                label: `reminder "${reminder.text}"`,
            })),
        ];
    }

    async function markActiveItemsCancelled({ meetingIds = [], reminderIds = [], failureReason }) {
        const update = {
            status: 'cancelled',
            ...(failureReason ? { failureReason } : {}),
        };

        const [meetings, reminders] = await Promise.all([
            meetingIds.length
                ? Meeting.updateMany(
                    { _id: { $in: meetingIds }, status: { $in: ['draft', 'scheduled'] } },
                    { $set: update },
                )
                : { modifiedCount: 0 },
            reminderIds.length
                ? StandaloneReminder.updateMany(
                    { _id: { $in: reminderIds }, status: 'pending' },
                    { $set: update },
                )
                : { modifiedCount: 0 },
        ]);

        return {
            cancelled: meetings.modifiedCount + reminders.modifiedCount,
            meetings: meetings.modifiedCount,
            reminders: reminders.modifiedCount,
        };
    }

    async function updateActiveItem({ chatId, target, updates }) {
        const active = await findActiveItem({ chatId, target });
        if (!active) return { updated: false };

        if (active.type === 'reminder') {
            const set = {};
            if (updates.text) set.text = updates.text;
            if (updates.dueAt) set.dueAt = updates.dueAt;
            if (updates.timezone) set.timezone = updates.timezone;
            if (updates.dueAt || updates.timezone) set.remindersSent = [];

            if (Object.keys(set).length === 0) {
                return { updated: false, reason: 'No reminder fields changed.' };
            }

            const item = await StandaloneReminder.findOneAndUpdate(
                { _id: active.item._id, status: 'pending' },
                { $set: set },
                { returnDocument: 'after' },
            );

            return {
                updated: Boolean(item),
                type: 'reminder',
                item,
                previousItem: active.item,
                label: item ? `reminder "${item.text}"` : active.label,
            };
        }

        const set = {};
        if (updates.title) set.title = updates.title;
        if (updates.description) set.description = updates.description;
        if (updates.start) set.start = updates.start;
        if (updates.end) set.end = updates.end;
        if (updates.timezone) set.timezone = updates.timezone;
        if (updates.start || updates.end || updates.timezone) set.remindersSent = [];

        if (Object.keys(set).length === 0) {
            return { updated: false, reason: 'No meeting fields changed.' };
        }

        const item = await Meeting.findOneAndUpdate(
            { _id: active.item._id, status: { $in: ['draft', 'scheduled'] } },
            { $set: set },
            { returnDocument: 'after' },
        );

        return {
            updated: Boolean(item),
            type: 'meeting',
            item,
            previousItem: active.item,
            label: item ? `meeting "${item.title}"` : active.label,
        };
    }

    return {
        upsertWhatsAppMessage,
        recordPollVote,
        replacePollVotes,
        recentPolls,
        findPollByMessageId,
        recentContext,
        hasOpenClarification,
        createMeeting,
        findDuplicateMeeting,
        createStandaloneReminder,
        pendingReminders,
        markReminderSent,
        pendingStandaloneReminderEvents,
        markStandaloneReminderSent,
        markActiveItemDone,
        findActiveItem,
        findActiveItems,
        markActiveItemsCancelled,
        rescheduleLatestCancelledMeeting,
        updateActiveItem,
        models: { WhatsAppMessage, Poll, Meeting, StandaloneReminder },
    };
}

module.exports = { createMessageStore };
