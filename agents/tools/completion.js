async function markDone({ decision, chat, messageStore }) {
    const target = decision.completion?.target || '';
    const result = await messageStore.markActiveItemDone({
        chatId: chat.id?._serialized || chat.id,
        target,
    });

    if (!result.completed) {
        return {
            status: 'failed',
            type: 'completion',
            target,
            reason: target ? 'no_matching_active_item' : 'no_active_item',
        };
    }

    return {
        status: 'completed',
        id: result.id || '',
        type: result.type,
        label: result.label,
    };
}

module.exports = { markDone };
