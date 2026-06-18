# lily-agent

Lily Agent is a small cloud execution agent for John. It lets you send a task from your phone, calls the OpenAI API, and returns structured JSON results.

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
- Vercel Serverless Function for deployment
- Wechaty worker for WeChat control
- Resend email sending

## Files

- `server.js` - local Express server with `POST /lily`
- `api/lily.js` - Vercel serverless endpoint
- `api/email.js` - Resend email sending endpoint
- `api/wecom.js` - WeCom callback verification and message receiving endpoint
- `api/telegram.js` - Telegram bot webhook endpoint
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

3. Edit `.env` and add your OpenAI API key:

```bash
OPENAI_API_KEY=sk-your-real-key
OPENAI_MODEL=gpt-4o-mini
PORT=3000
```

4. Start Lily:

```bash
npm run dev
```

5. Test locally:

```bash
curl -X POST http://localhost:3000/lily \
  -H "Content-Type: application/json" \
  -d "{\"task\":\"Find 10 California auto dealers who may import jump starters from China\"}"
```

## Deploy to Vercel

1. Open [Vercel](https://vercel.com/new).
2. Import the `lily-agent` GitHub repository.
3. Add environment variables:

```bash
OPENAI_API_KEY=sk-your-real-key
OPENAI_MODEL=gpt-4o-mini
```

4. Deploy.

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

Before responding, Lily classifies each Telegram message as `QUESTION`,
`COMMAND`, `TOOL_ACTION`, `CLARIFICATION`, or `CASUAL`. Intent classification
is separate from tool authorization: mentioning a tool never executes it by
itself. A tool runs only when the message is an explicit, complete
`TOOL_ACTION`; otherwise Lily answers conversationally or asks one focused
follow-up question.

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
