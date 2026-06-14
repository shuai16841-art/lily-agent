# Lily Email Sending

Lily can send email through Resend using:

```text
POST /api/email
```

## Required Vercel Environment Variables

```bash
RESEND_API_KEY=re_your-resend-api-key
RESEND_FROM=Lily Agent <onboarding@resend.dev>
EMAIL_SEND_SECRET=choose-a-long-random-secret
```

Use `RESEND_FROM` with a verified Resend sender or domain. For production, verify your own domain in Resend and use an address such as:

```text
Lily Agent <lily@yourdomain.com>
```

## Send Email

```bash
curl -X POST https://lily-agent-rouge.vercel.app/api/email \
  -H "Content-Type: application/json" \
  -H "x-lily-email-secret: your-secret" \
  -d "{
    \"to\":\"shuai16841@gmail.com\",
    \"subject\":\"Lily test email\",
    \"text\":\"Hello from Lily.\"
  }"
```

## Why `EMAIL_SEND_SECRET`

Without a secret, anyone who finds the URL could use your endpoint to send email from your Resend account.
