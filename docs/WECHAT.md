# Lily WeChat Control

This adds a Wechaty worker that listens to WeChat messages, forwards text tasks to Lily's `/api/lily` endpoint, and replies with Lily's result.

## What Runs Where

- Vercel: runs the existing Lily web app and `/api/lily`.
- Wechaty worker: runs all day on Railway, Render, Fly.io, or a VPS.
- WeChat: sends messages to the Wechaty account.

Do not run Wechaty on Vercel. Wechaty needs a long-running process, while Vercel functions are short-lived.

## Files

- `wechaty-bot.js` - WeChat listener and Lily API forwarder.
- `Dockerfile` - deployable worker container.
- `.env.example` - includes Wechaty worker variables.

## Environment Variables

```bash
LILY_API_URL=https://lily-agent-rouge.vercel.app/api/lily
WECHATY_NAME=lily-agent-wechat
WECHATY_PUPPET=wechaty-puppet-service
WECHATY_PUPPET_SERVICE_TOKEN=your-wechaty-puppet-service-token
WECHAT_ALLOWED_CONTACTS=John,Shuai
```

`WECHAT_ALLOWED_CONTACTS` is optional. If empty, the bot replies to anyone who can message the bot account.

## Local Test

```bash
npm install
cp .env.example .env
npm run wechat
```

Scan the QR code shown in the terminal with WeChat.

Then send a text message to the bot account:

```text
Find 10 California auto dealers who may import jump starters from China
```

Lily will call:

```text
https://lily-agent-rouge.vercel.app/api/lily
```

and reply in WeChat.

## Railway Deployment

1. Open Railway.
2. Create a new project from GitHub.
3. Select `shuai16841-art/lily-agent`.
4. Use Dockerfile deployment.
5. Add environment variables:

```bash
LILY_API_URL=https://lily-agent-rouge.vercel.app/api/lily
WECHATY_NAME=lily-agent-wechat
WECHATY_PUPPET=wechaty-puppet-service
WECHATY_PUPPET_SERVICE_TOKEN=your-wechaty-puppet-service-token
WECHAT_ALLOWED_CONTACTS=John,Shuai
```

6. Deploy.
7. Open the Railway logs.
8. Scan the login QR code with WeChat.

## Render Deployment

1. Create a new Web Service or Background Worker.
2. Connect the GitHub repo `shuai16841-art/lily-agent`.
3. Runtime: Docker.
4. Add the same environment variables.
5. Deploy.
6. Open logs and scan the QR code.

## Important Notes

- A personal WeChat account may have login limitations. If WeChat blocks web login or QR login, use a supported Wechaty puppet service token.
- For stable business use in China, WeCom or a WeChat Official Account can be more reliable than a personal WeChat bot.
- Keep the worker running 24/7. If the worker stops, WeChat control stops.
- Keep `WECHATY_PUPPET_SERVICE_TOKEN` private.

## Supported Tasks

You can send messages like:

```text
Find US B2B customers for portable jump starters
Find China factories for 12V jump starters
Write a short outreach email for auto dealers
Create a CSV lead list for 20 California auto accessory distributors
```

The worker sends the text to Lily and replies with the result.
