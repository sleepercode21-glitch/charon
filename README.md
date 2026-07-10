# Charon

Charon is a WhatsApp group assistant for scheduling, reminders, meeting coordination, and lightweight chat. It watches group context, stays quiet until it is tagged, then uses a Groq-powered LangGraph workflow plus deterministic tools to do the work.

The bot is designed for group coordination:

- It ignores direct messages.
- It stores messages and poll context from allowed groups.
- It replies only when tagged or mentioned, when `WHATSAPP_REPLY_MODE=tag_only`.
- It works across all joined groups by default, with separate context per group.
- It creates Google Meet links without creating Google Calendar events.
- It sends text reminders before meetings and reminders.
- It has two modes: LLM mode for natural requests, and command mode for explicit bot commands.

## What Charon Can Do

- Schedule sessions from natural language, polls, or recent group context.
- Create Google Meet links using either a static Meet URL or the Google Meet API.
- Send reminders at configurable offsets, defaulting to 24 hours, 6 hours, 1 hour, 10 minutes, 2 minutes, and start time.
- List active schedules and reminders.
- Cancel, update, or mark schedules/reminders as done.
- Tag every group participant for announcements and reminders.
- Chat casually when tagged, while still staying focused on coordination work.
- Fall back to command mode when the LLM provider is down.

Charon is not meant to silently answer every group message. All group messages are saved as context, but the bot should only speak when someone explicitly calls it.

## How The Agent Works

```text
WhatsApp group message
  -> store message/poll in MongoDB
  -> ignore DMs
  -> check allowed group scope
  -> check reply gate
  -> if slash command: run command handler without LLM
  -> otherwise: run LangGraph planner
  -> execute selected tool
  -> run response writer
  -> sanitize raw WhatsApp ids from reply
  -> send WhatsApp reply
```

The LangGraph workflow lives in `agents/workflows/schedulingGraph.js`.

The workflow has three main jobs:

- Planner: decides whether the tagged message is chat, scheduling, reminder, update, cancel, list, completion, or announcement.
- Context builder: loads recent conversation and polls, prioritizes active meetings/reminders by event time, and adds exact counts plus "next" and "latest" reference signals.
- Tools: perform side effects such as creating Meet links, writing schedules, cancelling items, and listing active state.
- Response writer: turns the tool result into a short, human WhatsApp reply.

Slash commands bypass the LLM entirely. This keeps the bot useful when the Groq free tier is rate-limited.

The LLM never gets raw MongoDB access. It receives a compact, group-scoped snapshot containing
recent messages, poll leaders and ties, active item summaries, exact active counts, and the nearest
meeting/reminder. Create, update, cancel, complete, list, and announce actions still run through
deterministic application tools after the planner selects an exact action.

## Project Structure

```text
charon/
  index.js                         WhatsApp client, reply gate, health server
  agents/
    charonAgent.js                 Agent entry point
    workflows/schedulingGraph.js   LangGraph planner -> tools -> responder flow
    tools/                         Deterministic side-effect tools
  cognition/memory/messageStore.js MongoDB persistence for group context and state
  config/settings.js               Environment-driven runtime config
  execution/reminderWorker.js      Background reminder sender
  models/
    llmWrapper.js                  Groq model wrapper and rate guard
    prompts/                       Planner and response prompts
  providers/
    googleMeet.js                  Google Meet link creation
    oauthTokenStore.js             OAuth token persistence
    remoteAuthMongoStore.js        WhatsApp RemoteAuth Mongo/GridFS storage
  scripts/googleOAuth.js           One-time Google OAuth helper
  utils/                           Time, JSON, logging, token budget helpers
  Dockerfile                       Coolify/VPS deployment image
  render.yaml                      Optional Render deployment config
```

## Requirements

- Node.js 20 or newer.
- MongoDB, either Atlas or a reachable MongoDB server.
- A Groq API key.
- A WhatsApp account that can link WhatsApp Web.
- Optional: Google OAuth credentials for dynamic Meet links.
- Optional: a permanent Google Meet URL if you do not want dynamic Meet links.

## Local Setup

Install dependencies:

```bash
npm install
```

Create your environment file:

```bash
cp config/.env.example .env
```

Fill at least:

```text
MONGODB_URI=
GROQ_API_KEY=
GROQ_RESPONSE_API_KEY=
WHATSAPP_REPLY_MODE=tag_only
WHATSAPP_GROUP_SCOPE=all
```

Start Charon:

```bash
npm start
```

On first run, WhatsApp Web may show a QR code in the terminal. Scan it once from WhatsApp Linked Devices. After RemoteAuth is saved in MongoDB, future restarts should reuse the session.

Run a syntax check:

```bash
npm run check
```

## Environment Variables

Use `config/.env.example` as the template. Never commit `.env` or `real.env`.

### Required

```text
MONGODB_URI=...
GROQ_API_KEY=...
GROQ_RESPONSE_API_KEY=...
```

`MONGODB_URI` stores WhatsApp auth, message context, schedules, reminders, OAuth tokens, and tool state.

`GROQ_API_KEY` remains the backward-compatible shared key and powers the Compound planner by default.
Set `GROQ_PLANNER_API_KEY` to override the planner credential, and set `GROQ_RESPONSE_API_KEY` to
give the response writer its own independent Groq quota. Purpose-specific keys take precedence over
the shared key.

### WhatsApp

```text
WHATSAPP_GROUP_SCOPE=all
WHATSAPP_GROUP_ID=
WHATSAPP_GROUP_NAME=
WHATSAPP_REPLY_MODE=tag_only
WHATSAPP_HISTORY_LIMIT=200
BOT_TIMEZONE=America/Phoenix
```

`WHATSAPP_GROUP_SCOPE=all` lets Charon work in every group it joins. Each group gets separate context and schedules because state is keyed by WhatsApp chat id.

To restrict it to one group:

```text
WHATSAPP_GROUP_SCOPE=restricted
WHATSAPP_GROUP_ID=your-group-id
```

or:

```text
WHATSAPP_GROUP_SCOPE=restricted
WHATSAPP_GROUP_NAME=Test
```

Keep `WHATSAPP_REPLY_MODE=tag_only` if you want Charon to observe all messages but only speak when explicitly tagged.

### LLM

```text
GROQ_PLANNER_MODEL=groq/compound
GROQ_RESPONSE_MODEL=qwen/qwen3-32b
GROQ_PLANNER_API_KEY=
GROQ_RESPONSE_API_KEY=
LLM_MAX_OUTPUT_TOKENS=384
LLM_MAX_CALL_INPUT_TOKENS=24000
LLM_PLANNER_MAX_INPUT_TOKENS=2000
LLM_PLANNER_RETRY_INPUT_TOKENS=1900
LLM_PLANNER_TOKEN_ESTIMATE_MULTIPLIER=2.5
LLM_PLANNER_MIN_REQUEST_TOKENS=6500
LLM_PLANNER_MIN_REQUEST_INTERVAL_MS=20000
LLM_PLANNER_RATE_LIMIT_COOLDOWN_MS=60000
LLM_PLAN_MAX_OUTPUT_TOKENS=800
LLM_RESPONSE_MAX_OUTPUT_TOKENS=1024
LLM_MAX_SEQUENCE_ACTIONS=0
LLM_SEQUENCE_RESPONSE_MAX_STEPS=12
LLM_MAX_INPUT_TOKENS=10000
LLM_CONTEXT_TOKEN_BUDGET=6000
LLM_RESPONSE_CONTEXT_TOKEN_BUDGET=1200
LLM_MAX_CONTEXT_MESSAGES=30
LLM_MAX_CONTEXT_POLLS=8
LLM_TOKENS_PER_MINUTE=5200
LLM_REQUESTS_PER_MINUTE=25
LLM_PLANNER_TOKENS_PER_MINUTE=30000
LLM_PLANNER_REQUESTS_PER_MINUTE=3
LLM_RATE_SAFETY_MULTIPLIER=1.35
LLM_MIN_REQUEST_INTERVAL_MS=1750
```

Natural-language mode uses at most two LLM calls. `groq/compound` receives the tagged message, quote, bot clock, pending clarification, recent messages, polls, and active database summaries, then returns one action or an ordered finite sequence. `LLM_MAX_SEQUENCE_ACTIONS=0` removes the application-level step cap; setting it above zero restores a deployment-specific limit. The actual sequence must still fit in the planner model's finite JSON output.

Charon preflights the whole sequence, executes steps in order, and can pass nested results such as an earlier Meet link, public id, or listed item into later steps. After local tools run, `qwen/qwen3-32b` normally writes one truthful response. Sequences longer than `LLM_SEQUENCE_RESPONSE_MAX_STEPS` use the deterministic response writer, avoiding another oversized model call. Command mode uses no LLM calls.

`LLM_PLANNER_MAX_INPUT_TOKENS` caps the complete Compound request estimate, including the system
prompt—not just conversation history. If Compound returns HTTP 413, Charon automatically retries once
using `LLM_PLANNER_RETRY_INPUT_TOKENS` and a leaner context containing fewer messages, polls, and active
item details. The current request, clock, pending clarification, exact active counts, and reference
signals are retained.

Compound may reserve substantially more underlying-model capacity than the visible prompt estimate.
`LLM_PLANNER_TOKEN_ESTIMATE_MULTIPLIER` deliberately inflates local accounting, while
`LLM_PLANNER_MIN_REQUEST_TOKENS` establishes a conservative floor. The defaults reserve at least
6,500 tokens before the normal safety multiplier and use the 30K TPM ceiling reported by the
underlying Scout model. Planner calls are spaced by at least 20 seconds. If Groq still returns 429
because another process or project consumed the shared organization quota, Charon marks its local
bucket empty, waits one full 60-second provider window, and retries once. This deliberately trades
latency for fewer repeated 429 failures.

### Google Meet

Simplest mode:

```text
GOOGLE_MEET_LINK=https://meet.google.com/...
```

This reuses one permanent Meet link.

Dynamic Meet mode:

```text
GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=
GOOGLE_OAUTH_REFRESH_TOKEN=
GOOGLE_MEET_ACCESS_TYPE=OPEN
GOOGLE_MEET_ENTRY_POINT_ACCESS=ALL
```

Dynamic mode uses the Google Meet API to create a fresh Meet space. It does not create a Calendar event.

If `GOOGLE_OAUTH_REFRESH_TOKEN` is empty, run:

```bash
npm run google:auth
```

The OAuth helper opens a Google consent URL and stores the refresh token in MongoDB when `MONGODB_URI` is available. If MongoDB is not available, it prints the token so you can put it in `.env`.

For dynamic Meet links, enable the Google Meet API in the same Google Cloud project as the OAuth client.

### Reminders

```text
DEFAULT_MEETING_DURATION_MINUTES=180
REMINDERS_ENABLED=true
REMINDER_LEAD_MINUTES=1440,360,60,10,2,0
REMINDER_CHECK_INTERVAL_MS=60000
```

Meeting duration is forced to at least 180 minutes so generated Meet spaces stay useful for longer sessions.

`REMINDER_LEAD_MINUTES` controls when messages are sent. The default means:

- 24 hours before.
- 6 hours before.
- 1 hour before.
- 10 minutes before.
- 2 minutes before.
- At start time.

### Puppeteer And Docker

```text
PORT=3000
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
PUPPETEER_HEADLESS=true
PUPPETEER_PROTOCOL_TIMEOUT_MS=120000
PUPPETEER_EXTRA_ARGS=
PUPPETEER_SKIP_DOWNLOAD=true
PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
```

On macOS local development, remove `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium` unless Chromium exists there. The Docker image installs Chromium at that path.

## Google Meet OAuth

Use OAuth when you want fresh Meet links instead of one static link.

1. Go to Google Cloud Console.
2. Enable the Google Meet API.
3. Create an OAuth client of type `Desktop app`.
4. Put the client id and secret in `.env`.
5. Run:

```bash
npm run google:auth
```

6. Open the printed URL, approve access, and return to the terminal.

The helper stores the refresh token in MongoDB. After that, the deployed bot can create Meet links without repeating OAuth.

If Google says the Meet API is disabled, enable it and wait a few minutes before retrying.

## WhatsApp Session Storage

Charon uses `whatsapp-web.js` with `RemoteAuth`. The session zip is stored in MongoDB/GridFS by `providers/remoteAuthMongoStore.js`.

This matters for deployment:

- The container filesystem can be temporary.
- The WhatsApp session should survive redeploys.
- You should only run one Charon instance for the same WhatsApp account.

If the bot repeatedly asks for QR after deploy, confirm:

- `MONGODB_URI` is correct in the deployment environment.
- The MongoDB user can read/write.
- The latest image contains the RemoteAuth store fix.
- Only one running container is using the same session.

## Commands

Commands are useful when the LLM provider is unavailable. They use concrete dates only so Charon does not have to guess.

```text
help
new schedule: Title, YYYY-MM-DD HH:MM Area/City
new reminder: Text, YYYY-MM-DD HH:MM Area/City
show schedules
show reminders
show all
move schedule <id>: YYYY-MM-DD HH:MM Area/City
move reminder <id>: YYYY-MM-DD HH:MM Area/City
rename schedule <id>: New title
rename reminder <id>: New reminder text
done schedule <id>
done reminder <id>
cancel schedule <id>
cancel reminder <id>
cancel all
```

Examples:

```text
new schedule: Banking system design, 2026-07-09 20:00 America/Chicago
new reminder: Submit slides, 2026-07-09 18:30 Asia/Kolkata
move schedule a1b2c3: 2026-07-10 21:00 America/New_York
rename reminder d4e5f6: Submit final slides
```

Command mode intentionally uses concrete dates only. Do not use fuzzy dates like `next Thursday`, `tomorrow`, or `2pm EST` in commands. Use `YYYY-MM-DD`, 24-hour time, and an IANA timezone such as `America/Chicago`, `America/New_York`, `America/Phoenix`, `Europe/London`, or `Asia/Kolkata`.

This also works for compatibility:

```text
/create schedule | Banking system design | 07/09/26 20:00 America/Chicago
/create reminder | Submit slides | 07/09/26 18:30 Asia/Kolkata
```

List active items:

```text
show schedules
show reminders
show all
```

Cancel by id:

```text
cancel schedule a1b2c3
cancel reminder d4e5f6
```

The id appears in list replies as a short bracketed value, like `[a1b2c3]`.

## Natural Language Examples

Tag Charon in the group:

```text
@Charon schedule the system design session tomorrow at 9am NY time
@Charon remind us about interview prep in 30 minutes
@Charon move the last meeting to Friday 6pm CST
@Charon cancel all reminders
@Charon list active meetings
@Charon tag everyone
@Charon tell me a quick joke
```

Multi-action requests can combine or repeat any available operation:

```text
@Charon cancel the old architecture session, schedule the replacement Friday at 6pm Arizona time, then announce its Meet link
@Charon create reminders for the draft review tomorrow at 9am, the final review Friday at 2pm, and submission Friday at 5pm Arizona time
@Charon list the next meeting, announce its Meet link, then mark the reminder with id a1b2c3 done
```

Sequences are finite and run in order. Charon validates required dates, times, timezones, and
clarifications before step one, stops later steps when a step fails, and reports only actions whose
tool results prove they ran.

Charon should ignore untagged messages but keep them as context. This lets it use earlier poll results or scheduling discussion when someone finally tags it.

## Deployment With Coolify On Oracle Free VM

This repo is set up for Docker deployment.

Recommended Coolify settings:

```text
Build Pack: Dockerfile
Base Directory: /
Dockerfile Location: /Dockerfile
Ports Exposes: 3000
Health path: /health
```

Add environment variables in Coolify. Do not rely on a committed `.env` in the image. Seeing `injected env (0) from .env` in logs is normal if Coolify injects env vars directly.

Important runtime env vars for Coolify:

```text
PORT=3000
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
PUPPETEER_HEADLESS=true
PUPPETEER_PROTOCOL_TIMEOUT_MS=120000
PUPPETEER_SKIP_DOWNLOAD=true
PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
```

If Coolify exposes Docker options, add:

```text
--shm-size=1g
```

Chromium is heavy on small free VMs. Add swap on the VM:

```bash
sudo fallocate -l 4G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
free -h
```

To make swap persist after reboot:

```bash
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

If Docker commands fail with permission errors:

```bash
sudo usermod -aG docker ubuntu
newgrp docker
```

or run Docker commands with `sudo`.

Useful cleanup commands on a small VM:

```bash
sudo docker system df
sudo docker builder prune
sudo docker image prune
```

Use the prune commands carefully if other applications are deployed on the same server.

## Docker Notes

The Dockerfile uses `node:20-bullseye-slim` and installs Debian Chromium. This is safer on Oracle ARM VMs than using an image built only for another CPU architecture.

To test the image locally:

```bash
docker build -t charon .
docker run --rm -p 3000:3000 --env-file .env --shm-size=1g charon
```

To debug inside a built image:

```bash
docker run --rm -it --shm-size=1g --entrypoint bash charon
which chromium
chromium --version
```

## PM2 Option

For a normal VPS without Coolify:

```bash
npm install
npm run start:pm2
npm run logs:pm2
```

Useful scripts:

```bash
npm run restart:pm2
npm run stop:pm2
npm run delete:pm2
```

## Troubleshooting

### `dotenv injected env (0) from .env`

This is expected in many Docker/Coolify deployments. Coolify injects variables into the process environment instead of mounting a `.env` file. The important part is whether `process.env` contains the variables.

### `MONGODB_URI is missing`

Set `MONGODB_URI` in the deployment environment. The bot needs MongoDB for WhatsApp RemoteAuth and scheduling state.

### `RemoteAuth-charon.zip ENOENT`

This happens when WhatsApp RemoteAuth tries to read a session zip before it exists or when the local auth directory is missing. Use the latest code and ensure MongoDB is reachable. On first startup, scan the QR and let RemoteAuth save.

### Browser fails to launch

Common symptoms:

```text
Failed to launch the browser process
Trace/breakpoint trap
TROUBLESHOOTING: https://pptr.dev/troubleshooting
```

Checklist:

- `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium`
- `PUPPETEER_HEADLESS=true`
- Docker option `--shm-size=1g`
- Swap exists on the VM
- The Dockerfile installed `chromium`
- The image architecture matches the VM architecture

DBus warnings such as `Failed to connect to the bus` are usually harmless in containers. `DevTools listening on ws://...` usually means Chromium launched.

### Browser path does not exist

If logs say:

```text
Tried to find the browser at the configured path
```

then the env path is wrong for that environment. In this Docker image, use:

```text
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
```

On macOS local development, remove that variable or point it at your local Chrome/Chromium binary.

### Google Meet API disabled

Enable the Google Meet API in the Google Cloud project connected to your OAuth client. Wait a few minutes, then retry.

### Groq credits or rate limits are unavailable

Natural language planning may fail, but command mode still works:

```text
new schedule: Title, YYYY-MM-DD HH:MM Area/City
new reminder: Text, YYYY-MM-DD HH:MM Area/City
show schedules
show reminders
move schedule <id>: YYYY-MM-DD HH:MM Area/City
cancel schedule <id>
cancel reminder <id>
```

### Bot replies with raw WhatsApp ids

The response prompt and sanitizer both try to prevent this. If it happens, check `models/prompts/responsePrompt.js` and `sanitizeReply` in `agents/workflows/schedulingGraph.js`.

## Security

- Never commit `.env`, `real.env`, OAuth tokens, service account keys, or private keys.
- Rotate any key that was pasted into logs, screenshots, commits, or chat.
- Keep MongoDB network access locked down as much as your deployment allows.
- Use one active Charon container per WhatsApp account.
- Review WhatsApp Linked Devices if the bot behaves strangely.

## Development Commands

```bash
npm start
npm run dev
npm run check
npm run google:auth
npm run start:pm2
npm run logs:pm2
```

## Behavior Rules

Current intended behavior:

- Observe all group messages in allowed groups.
- Ignore direct messages.
- Reply only when tagged.
- Do not answer when someone is clearly talking to another person.
- Use recent context when tagged.
- Prefer tool action for schedules, reminders, updates, cancellations, listings, and announcements.
- Use command mode without LLM when slash commands are used.
- Keep replies short enough for WhatsApp.
- Do not expose raw WhatsApp ids in normal replies.

That combination gives Charon the useful part of a group assistant without turning it into an always-talking bot.
