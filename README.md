# charon

Charon is a LangGraph WhatsApp group assistant for the Tech Up group. It uses Groq for a planner node and a response-writer node around deterministic scheduling tools.

It stores messages and poll updates per WhatsApp group for context, but only replies when the bot is actually WhatsApp-tagged. It schedules sessions with Google Meet links.
It also sends meeting reminders 24 hours, 6 hours, 1 hour, 10 minutes, 2 minutes, and at the start time.
When no tool action is needed, it can still chat, answer questions, explain things, and help the group think through plans.

## Architecture

- `index.js` stores messages from every allowed group, ignores DMs, and only invokes Charon when the bot is tagged.
- The LangGraph workflow has three stages: planner, tools, response writer.
- The planner gets an operator brief: current time, requester, tagged message, recent messages, poll leaders, active schedules, reminders, ids, and status.
- The planner emits compact JSON for schedule/reminder/update/cancel/list/announce/answer/refuse.
- General chat and Q&A go through the `answer` path; unsafe or impossible requests go through `refuse`.
- Tool modules do the side effects: Meet creation, DB updates, reminders, cancellations, listing, and tagging.
- The response writer turns the plan and tool result into Charon's final WhatsApp reply.
- Slash commands bypass the LLM entirely, so scheduling still works when credits or rate limits are exhausted.

The agent loop is:

```text
WhatsApp message
  -> store message/poll context
  -> reply gate: only actual WhatsApp tags pass
  -> command parser if message starts with /help, /create, /list, /cancel
  -> LLM planner for natural language requests
  -> deterministic tool execution
  -> LLM response writer, unless command mode used fallback text
  -> WhatsApp reply
```

## Setup

```bash
npm install
cp config/.env.example .env
npm start
```

Set `GROQ_API_KEY` and `MONGODB_URI`.
The default Groq model is `llama-3.1-8b-instant`.
Set `WHATSAPP_REPLY_MODE=tag_only` so plain text mentions of Charon remain context-only.

By default, `WHATSAPP_GROUP_SCOPE=all`, so Charon works in every WhatsApp group it joins. Each group has its own context because memory, schedules, reminders, and tool state are keyed by WhatsApp `chatId`. DMs stay ignored.

To restrict Charon to one group:

```text
WHATSAPP_GROUP_SCOPE=restricted
WHATSAPP_GROUP_ID=your-group-id
# or
WHATSAPP_GROUP_NAME=Tech Up Test
```

Sessions default to 3 hours. For Google Meet links, the simplest setup is `GOOGLE_MEET_LINK`, a permanent Meet URL Charon can reuse. For fresh links, use Google OAuth: create a Google OAuth client of type `Desktop app`, then set `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`. `npm run google:auth` saves the reusable refresh token in MongoDB. Dynamic Meet spaces are created with `GOOGLE_MEET_ACCESS_TYPE=OPEN` and `GOOGLE_MEET_ENTRY_POINT_ACCESS=ALL`, so anyone with the link can join when Workspace policy allows it.

To get the OAuth refresh token, set `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`, then run:

```bash
npm run google:auth
```

## No-Credits Command Mode

When Groq credits/rate limits fail, tagged schedule commands still work without any LLM call:

```text
/help
/create schedule | Title | tomorrow 2pm EST
/list schedules
/cancel schedule <id>
```

`/create schedule` and `/list schedules` include a short id like `[a1b2c3]`. Use that id with `/cancel schedule a1b2c3`.

## Render Free Tier

This repo includes `render.yaml` for a Render free web service. Charon is still a long-running WhatsApp bot; the web server only exposes `/health` so Render has a port to bind.

Use these settings if you create it manually:

```text
Service type: Web Service
Plan: Free
Build command: npm ci
Start command: npm start
Health check path: /health
```

Add the private values from `real.env` or `.env` in Render's Environment tab. Do not commit those files. At minimum, set:

```text
MONGODB_URI
GROQ_API_KEY
WHATSAPP_GROUP_SCOPE=all
WHATSAPP_REPLY_MODE=tag_only
GOOGLE_MEET_LINK or Google OAuth/Meet variables
```

Free web services can sleep when idle, so this is fine for testing but imperfect for reminders and WhatsApp presence. For a production bot, use a paid Render worker, a cheap VPS, or keep the free web service warm with an external uptime ping.
