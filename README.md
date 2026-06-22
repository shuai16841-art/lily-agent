# lily-agent

Lily Agent is an execution assistant for John. Telegram messages can be answered
immediately or converted into durable background tasks that use OpenAI, live web
search, memory, structured storage, Gmail drafts, Google Sheets, and report
generation.

Lily's first job is B2B sourcing and lead generation, for example:

```json
{
  "task": "Find 10 California auto dealers who may import jump starters from China"
}
```

The API returns:

- company name
- website
- reason they are a good lead
- suggested outreach email

## Tech Stack

- Node.js
- Express for local development
- OpenAI API
- SQLite locally or Turso (SQLite-compatible) in production
- Durable task queue and background worker
- Tavily live web search
- Gmail and Google Sheets APIs
- Vercel Serverless Function for deployment
- Wechaty worker for WeChat control
- Resend email sending

## Files

- `server.js` - local Express server with `POST /lily`
- `api/lily.js` - Vercel serverless endpoint
- `api/email.js` - Resend email sending endpoint
- `api/wecom.js` - WeCom callback verification and message receiving endpoint
- `api/telegram.js` - Telegram bot webhook endpoint
- `api/worker.js` - authenticated one-task worker trigger
- `worker.js` - long-running background queue worker
- `lib/llm.js` - central OpenAI client
- `lib/agent.js` - autonomous tool-calling loop
- `lib/db.js` - tasks, memory, entities, drafts, actions, and deduplication
- `lib/queue.js` - durable queue processor and Telegram progress/final reports
- `lib/task-service.js` - task creation and email approval workflows
- `lib/tools/` - web search, Gmail, Sheets, and report tools
- `lib/lily.js` - shared Lily/OpenAI logic
- `lib/email.js` - shared Resend email logic
- `public/index.html` - mobile web control panel
- `wechaty-bot.js` - WeChat listener that forwards messages to Lily
- `docs/WECHAT.md` - complete WeChat deployment guide
- `docs/EMAIL.md` - email setup and test guide
- `.env.example` - environment variable template
- `vercel.json` - maps `/lily` to the Vercel API function

## Run Locally

1. Install dependencies:

```bash
npm install
```

2. Create your environment file:

```bash
cp .env.example .env
```

3. Edit `.env` and add the minimum local settings:

```bash
OPENAI_API_KEY=sk-your-real-key
OPENAI_MODEL=gpt-4o-mini
TAVILY_API_KEY=tvly-your-key
TELEGRAM_BOT_TOKEN=your-telegram-token
LILY_DB_PATH=./data/lily.db
PORT=3000
```

4. Start Lily. The local Express process also starts the queue worker:

```bash
npm run dev
```

Alternatively, run the API and worker as separate processes:

```bash
LILY_DISABLE_WORKER=true npm run dev
npm run worker
```

On Windows PowerShell:

```powershell
$env:LILY_DISABLE_WORKER="true"; npm run dev
npm run worker
```

5. Run validation:

```bash
npm test
npm run lint
npm run test:agent
```

`test:agent` creates an isolated SQLite database, queues the requested
5-buyer/5-factory sample objective, saves ten fixture-backed entities, and
writes a final report under `outputs/test-agent/`. For live companies, run the
same task through Telegram with valid OpenAI and Tavily keys.

To run the exact live sourcing task outside Telegram:

```bash
npm run test:agent:live
```

This requires `OPENAI_API_KEY` and `TAVILY_API_KEY` and may incur API charges.

## Deploy to Vercel

1. Open [Vercel](https://vercel.com/new).
2. Import the `lily-agent` GitHub repository.
3. Add environment variables:

```bash
OPENAI_API_KEY=sk-your-real-key
OPENAI_MODEL=gpt-4o-mini
TAVILY_API_KEY=tvly-your-key
TELEGRAM_BOT_TOKEN=your-telegram-token
TURSO_DATABASE_URL=libsql://your-database.turso.io
TURSO_AUTH_TOKEN=your-turso-token
LILY_WORKER_SECRET=choose-a-long-random-secret
CRON_SECRET=choose-a-long-random-secret
```

4. Deploy.

### Background deployment options

Vercel functions are not durable long-running processes and their local
filesystem is ephemeral. Do not use a local `LILY_DB_PATH` for production
background tasks on Vercel.

Recommended:

1. Keep the Telegram webhook on Vercel.
2. Configure Turso so Vercel and the worker share the same SQLite-compatible
   database.
3. Deploy `npm run worker` on Railway, Render, Fly.io, or a VPS using the same
   environment variables.

For shorter tasks, an authenticated scheduler can call:

```text
GET https://lily-agent-rouge.vercel.app/api/worker
Authorization: Bearer <LILY_WORKER_SECRET>
```

Each call processes one queued task. A long-running worker is more reliable.

Production web panel:

```text
https://lily-agent-rouge.vercel.app
```

Production API endpoint:

```text
https://lily-agent-rouge.vercel.app/api/lily
```

## WeCom Custom App

In the WeCom Admin Console, configure LILY's callback URL as:

```text
https://lily-agent-rouge.vercel.app/api/wecom
```

Add these environment variables to the Vercel project:

```bash
WECOM_TOKEN=your-callback-token
WECOM_ENCODING_AES_KEY=your-43-character-encoding-aes-key
WECOM_CORP_ID=your-corporation-id
WECOM_AGENT_ID=your-lily-agent-id
WECOM_SECRET=your-lily-app-secret
```

In the WeCom Admin Console callback settings, fill in the same `Token` and
`EncodingAESKey` values, then save the callback configuration. The GET endpoint
verifies WeCom's signature and returns the decrypted `echostr`. POST message
receiving is currently a placeholder for future user-message handling.

## Telegram Bot

Lily can receive tasks from [@john_lily_agent_bot](https://t.me/john_lily_agent_bot)
through this webhook:

```text
https://lily-agent-rouge.vercel.app/api/telegram
```

Add the bot token from BotFather to the Vercel project:

```bash
TELEGRAM_BOT_TOKEN=your-telegram-bot-token
```

After deploying, register the webhook:

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://lily-agent-rouge.vercel.app/api/telegram"
```

Confirm Telegram accepted it:

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getWebhookInfo"
```

Open the bot in Telegram, send a text command, and Lily will run it through the
same task logic used by `POST /api/lily`. Telegram replies are formatted as
mobile-friendly summaries, numbered lead lists, and copy-ready outreach emails
instead of raw JSON. Long results are split across multiple messages
automatically. Email tools run only for explicit send instructions with a
recipient address and message content; questions about email are answered
without sending. Telegram `update_id` values are cached to suppress duplicate
webhook processing.

If an explicit send command omits the subject, Lily uses `Message from Lily`.
Short message content is sent exactly as provided. If sending fails, Telegram
shows the underlying error once and the same `update_id` is not processed again.

Before responding, Lily classifies each Telegram message as `QUESTION`,
`COMMAND`, `TOOL_ACTION`, `CLARIFICATION`, or `CASUAL`. Intent classification
is separate from tool authorization: mentioning a tool never executes it by
itself. A tool runs only when the message is an explicit, complete
`TOOL_ACTION`; otherwise Lily answers conversationally or asks one focused
follow-up question.

### Telegram task commands

```text
/status [task-id]
/tasks
/stop [task-id]
/report [task-id]
/approve <draft-id>
/help
```

Research commands such as `Find 20 buyers and 10 factories` are acknowledged
immediately, stored as queued tasks, processed by the worker, and followed by a
final Telegram report. Use `remember: ...` or `记住：...` to store an instruction
in Lily's memory.

### Safety

- Autonomous tools can research, write database records, append approved data
  to Sheets, and generate files.
- Email requests create Gmail drafts first.
- No customer is contacted until John sends `/approve <draft-id>`.
- Every tool action is logged in the `actions` table.
- Telegram `update_id` values are stored to prevent duplicate processing.

## Phone Web Control

Open this URL on your phone:

```text
https://lily-agent-rouge.vercel.app
```

Type a task and tap `Submit`.

## WeChat Control

Wechaty support has been added as a separate long-running worker:

```bash
npm run wechat
```

Read the full deployment guide:

```text
docs/WECHAT.md
```

The worker listens to WeChat messages, sends the text to `/api/lily`, and replies with Lily's result. Run it on Railway, Render, Fly.io, or a VPS. Do not run the Wechaty worker on Vercel because Vercel functions are not long-running processes.

## Email Sending

Lily can send email through Resend:

```text
POST /api/email
```

Required Vercel environment variables:

```bash
RESEND_API_KEY=re_your-resend-api-key
RESEND_FROM=Lily Agent <onboarding@resend.dev>
EMAIL_SEND_SECRET=choose-a-long-random-secret
```

Read:

```text
docs/EMAIL.md
```

For autonomous Gmail drafts and approval-based sending, configure:

```bash
GMAIL_ACCESS_TOKEN=oauth-access-token-with-gmail.compose-and-gmail.send
```

For Google Sheets writes:

```bash
GOOGLE_ACCESS_TOKEN=oauth-access-token-with-sheets-scope
GOOGLE_SHEETS_SPREADSHEET_ID=your-spreadsheet-id
```

OAuth access tokens expire. In production, rotate the token or place a token
refreshing proxy in front of these tools.

## Database contents

Lily stores:

- user instructions in `memories`
- objectives, steps, status, progress, and results in `tasks`
- buyers and factories in `entities`
- email draft, approval, and send status in `email_drafts`
- follow-up state in `entities.follow_up_status`
- every tool attempt and result in `actions`
- processed Telegram updates in `processed_updates`

## Example Response

```json
{
  "ok": true,
  "result": {
    "task": "Find 10 California auto dealers who may import jump starters from China",
    "summary": "10 starter lead hypotheses for California auto dealers and accessory sellers.",
    "leads": [
      {
        "company_name": "Example Auto Group",
        "website": "https://example.com",
        "reason_good_lead": "Sells automotive accessories and may add portable emergency power products.",
        "suggested_outreach_email": "Subject: Portable jump starters for your accessory lineup\n\nHi, I noticed your dealership group offers vehicle accessories and service support. We help auto businesses source reliable portable jump starters from China with competitive pricing and packaging options. Would you be open to reviewing a few models for your parts or service department?\n\nBest,\nJohn"
      }
    ],
    "notes": [
      "Verify each company website and buyer contact before outreach."
    ]
  }
}
```
