const { formatForChat } = require('../../utils/time');
const { settings } = require('../../config/settings');

function shortId(value) {
    return String(value || '').slice(-6);
}

async function listActiveItems({ chat, kind, target, messageStore }) {
    const chatId = chat.id?._serialized || chat.id;
    const items = await messageStore.findActiveItems({
        chatId,
        kind,
        target,
        limit: target ? 1 : 5,
    });

    if (!items.length) {
        return {
            status: 'empty',
            type: kind || 'active_items',
            kind,
        };
    }

    const showLinks = Boolean(target);
    const listedItems = items.slice(0, 5).map((active) => {
        if (active.type === 'meeting') {
            const timezone = active.item.timezone || settings.timezone;
            const base = `[${shortId(active.item._id)}] ${active.item.title || 'Meeting'} - ${formatForChat(new Date(active.item.start), timezone)}`;
            return {
                id: shortId(active.item._id),
                type: 'meeting',
                title: active.item.title || 'Meeting',
                when: formatForChat(new Date(active.item.start), timezone),
                timezone,
                meetLink: showLinks ? active.item.meetLink || '' : '',
                line: showLinks && active.item.meetLink ? `${base}\nMeet: ${active.item.meetLink}` : base,
            };
        }
        const timezone = active.item.timezone || settings.timezone;
        return {
            id: shortId(active.item._id),
            type: 'reminder',
            text: active.item.text || 'Reminder',
            when: formatForChat(new Date(active.item.dueAt), timezone),
            timezone,
            line: `[${shortId(active.item._id)}] ${active.item.text || 'Reminder'} - ${formatForChat(new Date(active.item.dueAt), timezone)}`,
        };
    });

    return {
        status: 'listed',
        type: kind || 'active_items',
        kind,
        target,
        lines: listedItems.map((item) => item.line),
        items: listedItems.map(({ line, ...item }) => item),
    };
}

module.exports = { listActiveItems };
