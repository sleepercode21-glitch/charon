const { Client, RemoteAuth } = require('whatsapp-web.js');
const dotenv = require('dotenv');
const fs = require('fs');
const http = require('http');
const qrcode = require('qrcode-terminal');
const mongoose = require('mongoose');

dotenv.config();

const { settings } = require('./config/settings');
const { createCharonAgent } = require('./agents/charonAgent');
const { createMessageStore } = require('./cognition/memory/messageStore');
const { createReminderWorker } = require('./execution/reminderWorker');
const { RemoteAuthMongoStore } = require('./providers/remoteAuthMongoStore');
const { logger } = require('./utils/logger');

let botContactId = null;
let botContactIds = new Set();
let agent = null;
let messageStore = null;
let reminderWorker = null;
let whatsappClient = null;
let readyHandled = false;
let healthServer = null;
let shuttingDown = false;
const handledReplyMessageIds = new Set();

function getChatId(chat) {
    return chat?.id?._serialized || chat?.id || '';
}

function serializedId(value) {
    if (!value) return '';
    if (typeof value === 'string') return value;
    return value._serialized || value.user || String(value);
}

function idVariants(id) {
    const value = serializedId(id);
    if (!value) return [];

    const user = value.split('@')[0];
    return [
        value,
        user,
        `${user}@c.us`,
        `${user}@s.whatsapp.net`,
        `${user}@lid`,
    ];
}

async function buildBotContactIds(client) {
    const ids = new Set();
    [
        client.info?.wid,
        client.info?.me,
        client.info?.wid?._serialized,
        client.info?.me?._serialized,
    ].flatMap(idVariants).filter(Boolean).forEach((id) => ids.add(id));

    try {
        if (typeof client.getContactLidAndPhone === 'function' && botContactId) {
            const mappings = await client.getContactLidAndPhone([botContactId]);
            for (const mapping of mappings || []) {
                [...idVariants(mapping.lid), ...idVariants(mapping.pn)].filter(Boolean).forEach((id) => ids.add(id));
            }
        }
    } catch (error) {
        logger.warn('Could not load bot LID/phone mention mapping.', error);
    }

    return ids;
}

function allowedGroupMatches(chat) {
    if (!chat?.isGroup) return false;
    if (settings.whatsapp.groupScope !== 'restricted') return true;

    const chatId = getChatId(chat);
    if (settings.whatsapp.groupId) {
        return chatId === settings.whatsapp.groupId;
    }

    if (settings.whatsapp.groupName) {
        return (chat.name || '').toLowerCase() === settings.whatsapp.groupName.toLowerCase();
    }

    logger.warn('WHATSAPP_GROUP_SCOPE is restricted, but WHATSAPP_GROUP_ID or WHATSAPP_GROUP_NAME is not set; ignoring group messages.');
    return false;
}

function isPrivateChat(chat) {
    return chat && chat.isGroup === false;
}

async function contactName(message) {
    try {
        const contact = await message.getContact();
        return contact.pushname || contact.name || contact.shortName || contact.number || message.author || message.from;
    } catch (error) {
        return message.author || message.from || 'unknown';
    }
}

function wasBotAddressed(message) {
    const mentionedIds = (message.mentionedIds || []).flatMap(idVariants);
    return mentionedIds.some((id) => botContactIds.has(id));
}

function shouldHandleMessage(message) {
    if (settings.whatsapp.replyMode !== 'tag_only') return false;
    return wasBotAddressed(message);
}

function messageText(message) {
    return [...new Set([
        message.body,
        message.pollName,
        message.caption,
        message._data?.body,
        message._data?.pollName,
        message._data?.caption,
    ].filter(Boolean).map((value) => String(value).trim()))].join(' ');
}

function optionName(option) {
    if (typeof option === 'string') return option;
    return option?.name || option?.localId || String(option || '');
}

function selectedOptionNamesFromVotes(votes = []) {
    return votes.flatMap((vote) => (vote.selectedOptions || [])
        .map(optionName)
        .filter(Boolean));
}

function pollOptionsFromRuntimeMessage(message) {
    return (
        message.pollOptions
        || message._data?.pollOptions
        || message._data?.pollSelectableOptions
        || []
    ).map(optionName).filter(Boolean);
}

function pollOptionsSummary({ message, votes = [], storedPoll = null }) {
    const optionNames = [
        ...pollOptionsFromRuntimeMessage(message),
        ...(storedPoll?.options || []).map(optionName),
        ...selectedOptionNamesFromVotes(votes),
        ...((storedPoll?.votes || []).flatMap((vote) => vote.selectedOptions || [])),
    ]
        .filter(Boolean);

    const uniqueOptions = [...new Set(optionNames)];
    const counts = new Map(uniqueOptions.map((option) => [option, 0]));

    const voteRows = votes?.length ? votes : (storedPoll?.votes || []);
    for (const vote of voteRows) {
        for (const selected of vote.selectedOptions || []) {
            const name = optionName(selected);
            if (!name) continue;
            counts.set(name, (counts.get(name) || 0) + 1);
        }
    }

    return uniqueOptions.map((name) => ({
        name,
        votes: counts.get(name) || 0,
    }));
}

async function quotedContext(message, chat) {
    if (!message.hasQuotedMsg || typeof message.getQuotedMessage !== 'function') return null;

    try {
        const quoted = await message.getQuotedMessage();
        if (!quoted) return null;

        await storeMessage(quoted, chat);

        let votes = [];
        if ((quoted.type === 'poll_creation' || quoted.pollName) && typeof quoted.getPollVotes === 'function') {
            votes = await quoted.getPollVotes();
            await messageStore.replacePollVotes({ chat, parentMessage: quoted, votes });
        }

        const storedPoll = await messageStore.findPollByMessageId({
            chatId: getChatId(chat),
            pollMessageId: getMessageId(quoted),
        });

        const context = {
            id: getMessageId(quoted),
            type: quoted.type || '',
            body: messageText(quoted),
            pollName: quoted.pollName || quoted._data?.pollName || storedPoll?.pollName || '',
            pollOptions: pollOptionsSummary({ message: quoted, votes, storedPoll }),
            storedPoll: storedPoll ? {
                pollName: storedPoll.pollName || '',
                options: (storedPoll.options || []).map((option) => option.name).filter(Boolean),
                votes: (storedPoll.votes || []).map((vote) => ({
                    selectedOptions: vote.selectedOptions || [],
                    updatedAt: vote.updatedAt,
                })),
            } : null,
            timestamp: quoted.timestamp ? new Date(quoted.timestamp * 1000).toISOString() : '',
        };
        logger.info(`Quoted context: ${JSON.stringify(context)}`);
        return context;
    } catch (error) {
        logger.warn('Could not load quoted message context.', error);
        return null;
    }
}

function getMessageId(message) {
    return serializedId(message.id);
}

function startHealthServer() {
    if (!process.env.PORT || healthServer) return;

    healthServer = http.createServer((request, response) => {
        if (request.url === '/health') {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({
                ok: true,
                whatsappReady: readyHandled,
                bot: botContactId || null,
            }));
            return;
        }

        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('charon is running\n');
    });

    healthServer.listen(Number(process.env.PORT), '0.0.0.0', () => {
        logger.info(`Health server listening on ${process.env.PORT}.`);
    });
}

function puppeteerExecutablePath() {
    const configuredPath = process.env.PUPPETEER_EXECUTABLE_PATH;
    const fallbackPaths = [
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/google-chrome',
    ];

    if (configuredPath && fs.existsSync(configuredPath)) return configuredPath;

    if (configuredPath) {
        logger.warn(`Ignoring PUPPETEER_EXECUTABLE_PATH because it does not exist: ${configuredPath}`);
        delete process.env.PUPPETEER_EXECUTABLE_PATH;
    }

    const fallbackPath = fallbackPaths.find((candidate) => fs.existsSync(candidate));
    if (fallbackPath) return fallbackPath;

    logger.warn('No Chromium executable found in known paths; letting Puppeteer resolve the browser.');
    return undefined;
}

function puppeteerHeadlessMode() {
    const value = (process.env.PUPPETEER_HEADLESS || 'new').trim().toLowerCase();
    if (value === 'false') return false;
    if (value === 'true') return true;
    return 'new';
}

function extraPuppeteerArgs() {
    if (!process.env.PUPPETEER_EXTRA_ARGS) return [];
    return process.env.PUPPETEER_EXTRA_ARGS
        .split(/\s+/)
        .map((arg) => arg.trim())
        .filter(Boolean);
}

function puppeteerArgs() {
    return [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-background-networking',
        '--disable-background-timer-throttling',
        '--disable-breakpad',
        '--disable-client-side-phishing-detection',
        '--disable-component-update',
        '--disable-crash-reporter',
        '--disable-crashpad',
        '--disable-dev-tools',
        '--disable-extensions',
        '--disable-features=Translate,BackForwardCache,AcceptCHFrame,MediaRouter,OptimizationHints,VizDisplayCompositor',
        '--disable-gpu',
        '--disable-hang-monitor',
        '--disable-in-process-stack-traces',
        '--disable-logging',
        '--disable-software-rasterizer',
        '--disk-cache-dir=/tmp/chromium-cache',
        '--metrics-recording-only',
        '--mute-audio',
        '--no-first-run',
        '--no-default-browser-check',
        '--noerrdialogs',
        '--password-store=basic',
        '--user-data-dir=/tmp/chrome-user-data',
        '--use-mock-keychain',
        '--window-size=1280,720',
        ...extraPuppeteerArgs(),
    ];
}

async function storeMessage(message, chat) {
    if (!messageStore) return null;

    const senderName = await contactName(message);
    return messageStore.upsertWhatsAppMessage({
        message,
        chat,
        senderName,
    });
}

async function refreshRecentPollVotes(chat) {
    if (!messageStore || !whatsappClient) return;

    const polls = await messageStore.recentPolls(getChatId(chat), 5);
    for (const poll of polls) {
        try {
            const parentMessage = await whatsappClient.getMessageById(poll.pollMessageId);
            if (!parentMessage || typeof parentMessage.getPollVotes !== 'function') continue;

            const votes = await parentMessage.getPollVotes();
            await messageStore.replacePollVotes({ chat, parentMessage, votes });
            logger.info(`Refreshed ${votes.length} vote rows for poll ${poll.pollName || poll.pollMessageId}.`);
        } catch (error) {
            logger.warn(`Could not refresh poll votes for ${poll.pollName || poll.pollMessageId}.`, error);
        }
    }
}

async function hydrateGroupHistory(client) {
    const chats = await client.getChats();
    const targetChats = chats.filter(allowedGroupMatches);

    if (targetChats.length === 0) {
        logger.warn('No allowed WhatsApp groups found. Check WHATSAPP_GROUP_SCOPE/WHATSAPP_GROUP_ID/WHATSAPP_GROUP_NAME.');
        return;
    }

    for (const chat of targetChats) {
        if (typeof chat.fetchMessages !== 'function') continue;

        const messages = await chat.fetchMessages({ limit: settings.whatsapp.historyLimit });
        logger.info(`Hydrating ${messages.length} messages from ${chat.name || getChatId(chat)}`);

        for (const message of messages) {
            await storeMessage(message, chat);
        }
    }
}

async function handleIncomingMessage(message) {
    const chat = await message.getChat();
    if (isPrivateChat(chat)) {
        logger.info(`Ignoring private chat message from ${getChatId(chat) || message.from || 'unknown sender'}.`);
        return;
    }

    if (!allowedGroupMatches(chat)) {
        logger.info(`Ignoring message outside allowed groups: ${chat.name || getChatId(chat)}`);
        return;
    }

    const storedMessage = await storeMessage(message, chat);
    const messageId = getMessageId(message);

    if (message.fromMe) return;

    const shouldHandle = shouldHandleMessage(message);
    if (!shouldHandle) {
        logger.info(`Stored unaddressed ${message.type || 'message'} in ${chat.name || getChatId(chat)}.`);
        return;
    }

    if (handledReplyMessageIds.has(messageId)) {
        logger.info(`Already handled addressed message ${messageId}.`);
        return;
    }

    handledReplyMessageIds.add(messageId);
    logger.info(`Handling addressed ${message.type || 'message'} in ${chat.name || getChatId(chat)}: ${messageText(message) || '[no text]'}`);
    const quoted = await quotedContext(message, chat);
    await refreshRecentPollVotes(chat);

    try {
        const result = await agent.handleMessage({
            message,
            chat,
            storedMessage,
            quoted,
            botContactId,
            client: whatsappClient,
        });

        if (result?.reply) {
            await message.reply(result.reply);
        } else {
            await message.reply('I missed the instruction, sir. Say it once more plainly.');
        }
    } catch (error) {
        logger.error('Agent failed to handle message', error);
        await message.reply('Something jammed in the machinery, sir. Try that once more.');
    }
}

async function handleVoteUpdate(vote) {
    if (!messageStore || !vote?.parentMessage) return;

    const chat = await vote.parentMessage.getChat();
    if (isPrivateChat(chat)) return;
    if (!allowedGroupMatches(chat)) return;

    await messageStore.recordPollVote({
        chat,
        parentMessage: vote.parentMessage,
        voterId: vote.voter,
        selectedOptions: vote.selectedOptions || [],
    });
}

async function main() {
    startHealthServer();
    logger.info(`LLM config: planner=${settings.llm.plannerModel}, response=${settings.llm.responseModel}, plannerBudget=${settings.llm.plannerMaxInputTokens}/${settings.llm.plannerRetryInputTokens}, plannerRate=${settings.llm.plannerTokensPerMinute}tpm/${settings.llm.plannerRequestsPerMinute}rpm, responseRate=${settings.llm.tokensPerMinute}tpm/${settings.llm.requestsPerMinute}rpm.`);

    if (!settings.mongodbUri) {
        throw new Error('MONGODB_URI is required.');
    }

    await mongoose.connect(settings.mongodbUri);

    messageStore = createMessageStore({ mongoose });
    agent = createCharonAgent({ messageStore });

    const remoteAuthDataPath = process.env.WWEBJS_AUTH_DATA_PATH || './.wwebjs_auth/';
    await fs.promises.mkdir(remoteAuthDataPath, { recursive: true });
    const store = new RemoteAuthMongoStore({ mongoose, dataPath: remoteAuthDataPath });
    const client = new Client({
        authStrategy: new RemoteAuth({
            clientId: 'charon',
            dataPath: remoteAuthDataPath,
            store,
            backupSyncIntervalMs: 300000,
        }),
        puppeteer: {
            headless: puppeteerHeadlessMode(),
            executablePath: puppeteerExecutablePath(),
            dumpio: process.env.PUPPETEER_DUMPIO === 'true',
            protocolTimeout: Number(process.env.PUPPETEER_PROTOCOL_TIMEOUT_MS || 120000),
            args: puppeteerArgs(),
        },
    });
    whatsappClient = client;

    client.on('qr', (qr) => qrcode.generate(qr, { small: true }));
    client.on('remote_session_saved', () => logger.info('Remote session saved.'));

    client.on('ready', async () => {
        if (readyHandled) {
            logger.info('Ignoring duplicate WhatsApp ready event.');
            return;
        }

        readyHandled = true;
        botContactId = client.info?.wid?._serialized || null;
        botContactIds = await buildBotContactIds(client);
        logger.info(`Charon is ready as ${botContactId || 'unknown bot id'}. Mention ids: ${[...botContactIds].join(', ')}`);
        await hydrateGroupHistory(client);
        reminderWorker = createReminderWorker({ client, messageStore });
        reminderWorker.start();
    });

    client.on('message_create', handleIncomingMessage);
    client.on('vote_update', handleVoteUpdate);

    client.on('auth_failure', (message) => logger.error('WhatsApp auth failure', message));
    client.on('disconnected', (reason) => logger.warn(`WhatsApp disconnected: ${reason}`));

    async function shutdown(signal) {
        if (shuttingDown) return;
        shuttingDown = true;

        logger.info('Shutting down Charon.');
        reminderWorker?.stop();
        healthServer?.close();
        await client.destroy().catch((error) => logger.warn('WhatsApp shutdown failed.', error));
        await mongoose.disconnect().catch((error) => logger.warn('Mongo shutdown failed.', error));
        process.exit(0);
    }

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    client.initialize();
}

if (require.main === module) {
    main().catch((error) => {
        logger.error('Failed to start Charon', error);
        process.exit(1);
    });
}

module.exports = { main };
