import OpenAI from "openai";
import { sendEmail } from "./email.js";

const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const DEFAULT_SELF_RECIPIENT = "shuai16841@gmail.com";
const DEFAULT_EMAIL_SUBJECT = "Message from Lily";
const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const EMAIL_TRIGGERS = [
  "send email",
  "email",
  "\u53d1\u90ae\u4ef6",
  "\u7ed9\u6211\u53d1\u90ae\u4ef6"
];
const SELF_RECIPIENT_TERMS = [
  "\u7ed9\u6211\u81ea\u5df1\u53d1\u90ae\u4ef6",
  "\u7ed9\u6211\u53d1\u90ae\u4ef6",
  "\u53d1\u90ae\u4ef6\u7ed9\u6211\u81ea\u5df1",
  "\u53d1\u90ae\u4ef6\u7ed9\u6211",
  "email me",
  "to me"
];

export const lilySystemPrompt = `You are Lily, an execution agent for John.
You help with:
- finding US B2B customers
- finding China factories
- writing outreach emails
- creating CSV lead lists
- sourcing products from China
- organizing business tasks

Return practical, business-ready results. When asked for leads, return concise JSON with:
- company_name
- website
- reason_good_lead
- suggested_outreach_email

Do not claim that you visited live websites unless tools or supplied context prove it. If current web verification is unavailable, say the leads are starting hypotheses and should be verified before outreach.`;

export function createOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required");
  }

  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
  });
}

function getLineValue(task, labels) {
  for (const label of labels) {
    const pattern = new RegExp(`(?:^|\\n)\\s*${label}\\s*[:\\uFF1A]\\s*(.+)`, "i");
    const match = task.match(pattern);

    if (match?.[1]?.trim()) {
      return match[1].trim();
    }
  }

  return null;
}

export function parseEmailTask(task) {
  const lowerTask = task.toLowerCase();

  if (!EMAIL_TRIGGERS.some((trigger) => lowerTask.includes(trigger.toLowerCase()))) {
    return null;
  }

  const normalized = task.trim();
  const emailMatch = normalized.match(EMAIL_PATTERN);
  const lowerNormalized = normalized.toLowerCase();
  const isSelfRecipient = SELF_RECIPIENT_TERMS.some((term) =>
    lowerNormalized.includes(term.toLowerCase())
  );
  const to = isSelfRecipient ? DEFAULT_SELF_RECIPIENT : emailMatch?.[0] || null;
  const subject = getLineValue(normalized, ["subject", "\u4e3b\u9898"]) || DEFAULT_EMAIL_SUBJECT;
  let body = getLineValue(normalized, [
    "body",
    "text",
    "message",
    "\u6b63\u6587",
    "\u5185\u5bb9"
  ]);

  if (!body) {
    const sayMatch = normalized.match(
      new RegExp(
        `(?:\u8bf4|\u6b63\u6587\u662f|\u5185\u5bb9\u662f|body is|message is)\\s*[:\\uFF1A]?\\s*(.+)$`,
        "i"
      )
    );
    body = sayMatch?.[1]?.trim() || normalized;
  }

  return {
    to,
    subject,
    body
  };
}

async function executeEmailSend(task) {
  const emailTask = parseEmailTask(task);

  if (!emailTask) {
    return null;
  }

  if (!emailTask.to) {
    const error = new Error("Recipient email is required for EMAIL_SEND");
    error.statusCode = 400;
    throw error;
  }

  const result = await sendEmail({
    headers: {
      "x-lily-email-secret": process.env.EMAIL_SEND_SECRET
    },
    body: {
      to: emailTask.to,
      subject: emailTask.subject,
      text: emailTask.body
    }
  });

  return {
    ok: true,
    action: "EMAIL_SENT",
    to: emailTask.to,
    subject: emailTask.subject,
    messageId: result?.id || result?.messageId || null
  };
}

export async function runLilyTask(task, client) {
  if (!task || typeof task !== "string" || task.trim().length === 0) {
    const error = new Error("task is required and must be a non-empty string");
    error.statusCode = 400;
    throw error;
  }

  const emailResult = await executeEmailSend(task);

  if (emailResult) {
    return emailResult;
  }

  const openai = client || createOpenAIClient();
  const response = await openai.chat.completions.create({
    model: DEFAULT_MODEL,
    temperature: 0.4,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: lilySystemPrompt
      },
      {
        role: "user",
        content: `Task: ${task.trim()}

Return JSON only, using this shape:
{
  "task": "original task",
  "summary": "short summary",
  "leads": [
    {
      "company_name": "...",
      "website": "...",
      "reason_good_lead": "...",
      "suggested_outreach_email": "..."
    }
  ],
  "notes": ["..."]
}`
      }
    ]
  });

  const content = response.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("OpenAI returned an empty response");
  }

  try {
    return JSON.parse(content);
  } catch (error) {
    return {
      task,
      summary: "Lily completed the task, but the model returned non-JSON text.",
      raw_result: content,
      notes: ["Check the prompt or model if strict JSON is required."]
    };
  }
}

export function sendJson(res, statusCode, body) {
  res.status(statusCode).json(body);
}
