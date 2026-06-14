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

## Files

- `server.js` - local Express server with `POST /lily`
- `api/lily.js` - Vercel serverless endpoint
- `lib/lily.js` - shared Lily/OpenAI logic
- `public/index.html` - mobile web control panel
- `wechaty-bot.js` - WeChat listener that forwards messages to Lily
- `docs/WECHAT.md` - complete WeChat deployment guide
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
