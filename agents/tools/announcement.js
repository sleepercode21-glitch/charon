const { sendReminderMessage } = require('../../execution/reminderWorker');

async function announceToGroup({ client, chat, text }) {
    const message = String(text || '').trim() || 'Attention, sir.';
    await sendReminderMessage(client, chat, message);
    return {
        status: 'announced',
        type: 'announcement',
    };
}

module.exports = { announceToGroup };
