const { settings } = require('../config/settings');
const { formatForChat } = require('../utils/time');
const { logger } = require('../utils/logger');

function reminderLabel(leadMinutes) {
    if (leadMinutes === 0) return 'now';
    if (leadMinutes >= 60 && leadMinutes % 60 === 0) {
        const hours = leadMinutes / 60;
        return `${hours} hour${hours === 1 ? '' : 's'}`;
    }
    return `${leadMinutes} minute${leadMinutes === 1 ? '' : 's'}`;
}

function reminderText({ meeting, leadMinutes }) {
    const when = formatForChat(new Date(meeting.start), meeting.timezone || settings.timezone);
    const title = meeting.title || 'Tech Up meetup';
    const link = meeting.meetLink ? ` Join: ${meeting.meetLink}` : '';
    if (leadMinutes === 0) {
        return `The hour has arrived: ${title} starts now (${when}).${link}`;
    }
    return `A quiet knock: ${title} starts in ${reminderLabel(leadMinutes)} (${when}).${link}`;
}

function standaloneReminderText(reminder) {
    const when = formatForChat(new Date(reminder.dueAt), reminder.timezone || settings.timezone);
    return `The bell rings: ${reminder.text} (${when}).`;
}

function standaloneLeadText({ reminder, leadMinutes }) {
    if (leadMinutes === 0) return standaloneReminderText(reminder);
    const when = formatForChat(new Date(reminder.dueAt), reminder.timezone || settings.timezone);
    return `A quiet knock: ${reminder.text} is in ${reminderLabel(leadMinutes)} (${when}).`;
}

function participantId(participant) {
    return participant?.id?._serialized || participant?.id || '';
}

function allMentions(chat) {
    if (!chat?.isGroup) return [];
    return [...new Set((chat.participants || [])
        .map(participantId)
        .filter(Boolean))];
}

function mentionHandle(id) {
    const user = String(id || '').split('@')[0];
    return user ? `@${user}` : '';
}

async function mentionTargets(client, ids) {
    return Promise.all(ids.map(async (id) => {
        try {
            if (typeof client.getContactById === 'function') {
                return await client.getContactById(id);
            }
        } catch (error) {
            logger.warn(`Could not resolve mention contact ${id}.`, error);
        }
        return id;
    }));
}

async function sendReminderMessage(client, chat, text) {
    const mentionIds = allMentions(chat);
    if (mentionIds.length === 0) return chat.sendMessage(text);

    const handles = mentionIds.map(mentionHandle).filter(Boolean).join(' ');
    const mentions = await mentionTargets(client, mentionIds);
    return chat.sendMessage(`${handles}\n${text}`, { mentions });
}

function createReminderWorker({ client, messageStore }) {
    let timer = null;
    let running = false;

    async function tick() {
        if (running || !settings.reminders.enabled) return;
        running = true;

        try {
            const reminders = await messageStore.pendingReminders({
                now: new Date(),
                leadMinutes: settings.reminders.leadMinutes,
                dueGraceMs: settings.reminders.dueGraceMs,
            });

            for (const reminder of reminders) {
                const { meeting, key, leadMinutes } = reminder;
                try {
                    const chat = await client.getChatById(meeting.chatId);
                    const sentMessage = await sendReminderMessage(client, chat, reminderText({ meeting, leadMinutes }));
                    await messageStore.markReminderSent({
                        meetingId: meeting._id,
                        key,
                        leadMinutes,
                        sentAt: new Date(),
                        messageId: sentMessage?.id?._serialized || '',
                    });
                    logger.info(`Sent ${key} reminder for ${meeting.title || meeting._id}.`);
                } catch (error) {
                    logger.error(`Failed to send reminder ${key} for meeting ${meeting._id}`, error);
                }
            }

            const standaloneReminders = await messageStore.pendingStandaloneReminderEvents({
                now: new Date(),
                leadMinutes: settings.reminders.leadMinutes,
                dueGraceMs: settings.reminders.dueGraceMs,
            });

            for (const event of standaloneReminders) {
                const { reminder, key, leadMinutes } = event;
                try {
                    const chat = await client.getChatById(reminder.chatId);
                    const sentMessage = await sendReminderMessage(client, chat, standaloneLeadText({ reminder, leadMinutes }));
                    await messageStore.markStandaloneReminderSent({
                        reminderId: reminder._id,
                        key,
                        leadMinutes,
                        sentAt: new Date(),
                        messageId: sentMessage?.id?._serialized || '',
                    });
                    logger.info(`Sent ${key} standalone reminder ${reminder._id}.`);
                } catch (error) {
                    logger.error(`Failed to send standalone reminder ${event.reminder._id}`, error);
                }
            }
        } finally {
            running = false;
        }
    }

    function start() {
        if (timer || !settings.reminders.enabled) return;
        timer = setInterval(tick, settings.reminders.checkIntervalMs);
        tick();
        logger.info('Reminder worker started.');
    }

    function stop() {
        if (!timer) return;
        clearInterval(timer);
        timer = null;
        logger.info('Reminder worker stopped.');
    }

    return { start, stop, tick };
}

module.exports = { createReminderWorker, sendReminderMessage };
