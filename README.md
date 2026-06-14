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

## Files

- `server.js` - local Express server with `POST /lily`
- `api/lily.js` - Vercel serverless endpoint
- `lib/lily.js` - shared Lily/OpenAI logic
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

### Option A: Deploy from GitHub

1. Create a GitHub repository named `lily-agent`.
2. Push this project to the repository.
3. Open [Vercel](https://vercel.com/new).
4. Import the `lily-agent` GitHub repository.
5. Add this environment variable in Vercel:

```bash
OPENAI_API_KEY=sk-your-real-key
OPENAI_MODEL=gpt-4o-mini
```

6. Deploy.

After deployment, your production endpoint will be:

```text
https://your-vercel-project.vercel.app/lily
```

The `vercel.json` file also supports:

```text
https://your-vercel-project.vercel.app/api/lily
```

### Option B: Deploy with Vercel CLI

```bash
npm install -g vercel
vercel
vercel env add OPENAI_API_KEY
vercel --prod
```

## Phone Test

### iPhone Shortcuts

1. Open the Shortcuts app.
2. Create a new shortcut named `Ask Lily`.
3. Add `Text` and write your task.
4. Add `Get Contents of URL`.
5. Set URL to:

```text
https://your-vercel-project.vercel.app/lily
```

6. Method: `POST`.
7. Headers:

```text
Content-Type: application/json
```

8. Request Body: JSON:

```json
{
  "task": "Find 10 California auto dealers who may import jump starters from China"
}
```

9. Add `Show Result`.

### Android

Use an app such as HTTP Request Shortcuts, MacroDroid, Tasker, or a browser-based API tester.

POST to:

```text
https://your-vercel-project.vercel.app/lily
```

Body:

```json
{
  "task": "Find 10 California auto dealers who may import jump starters from China"
}
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

## Next: Telegram or WeChat

### Telegram

The easiest next step is Telegram:

1. Create a bot with `@BotFather`.
2. Store `TELEGRAM_BOT_TOKEN` in Vercel.
3. Add a webhook endpoint, for example `POST /api/telegram`.
4. When a Telegram message arrives, forward the message text to `runLilyTask()`.
5. Send Lily's JSON summary back to the Telegram chat.

### WeChat

WeChat is possible, but usually takes more setup:

1. Register a WeChat Official Account or use WeCom.
2. Configure server verification with WeChat's token/signature flow.
3. Add a webhook endpoint, for example `POST /api/wechat`.
4. Parse inbound messages and pass the text to `runLilyTask()`.
5. Return a WeChat-compatible XML or JSON response depending on the selected WeChat platform.

For version 2, Telegram is faster. WeChat is better once the workflow is stable and you want daily use inside China's messaging ecosystem.
