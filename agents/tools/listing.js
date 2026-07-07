const { formatForChat } = require('../../utils/time');
const { settings } = require('../../config/settings');

function shortId(value) {
    return String(value || '').slice(-6);
}

async function listActiveItems({ chat, kind, messageStore }) {
    const chatId = chat.id?._serialized || chat.id;
    const items = await messageStore.findActiveItems({
        chatId,
        kind,
        limit: 5,
    });

    if (!items.length) {
        return {
            status: 'empty',
            type: kind || 'active_items',
            kind,
        };
    }

    const lines = items.slice(0, 5).map((active) => {
        if (active.type === 'meeting') {
            const timezone = active.item.timezone || settings.timezone;
            return `[${shortId(active.item._id)}] ${active.item.title || 'Meeting'} - ${formatForChat(new Date(active.item.start), timezone)}`;
        }
        const timezone = active.item.timezone || settings.timezone;
        return `[${shortId(active.item._id)}] ${active.item.text || 'Reminder'} - ${formatForChat(new Date(active.item.dueAt), timezone)}`;
    });

    return {
        status: 'listed',
        type: kind || 'active_items',
        kind,
        lines,
    };
}

module.exports = { listActiveItems };
