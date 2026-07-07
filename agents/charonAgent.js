const { settings } = require('../config/settings');
const { createSchedulingGraph, invokeSchedulingGraph } = require('./workflows/schedulingGraph');

class CharonAgent {
    constructor({ messageStore }) {
        this.graph = createSchedulingGraph({ messageStore });
    }

    async handleMessage({ message, chat, storedMessage, botContactId }) {
        const result = await invokeSchedulingGraph(this.graph, {
            message,
            chat,
            storedMessage,
            botContactId,
            timezone: settings.timezone,
        });

        return { reply: result.reply || '' };
    }
}

function createCharonAgent({ messageStore }) {
    return new CharonAgent({ messageStore });
}

module.exports = { CharonAgent, createCharonAgent };
