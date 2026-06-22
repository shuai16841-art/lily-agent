import { getLlmClient, getLlmModel } from "./llm.js";

const DEFAULT_EMAIL_SUBJECT = "Message from Lily";
const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const EMAIL_TERMS = ["email", "e-mail", "\u90ae\u4ef6"];
const QUESTION_PATTERNS = [
  /[?？]\s*$/,
  /^(?:what|why|how|when|where|who|which|can|could|would|should|is|are|do|does|did)\b/i,
  /(?:\u5417|\u4e48|\u5462|\u4e3a\u4ec0\u4e48|\u600e\u4e48|\u5982\u4f55|\u80fd\u4e0d\u80fd|\u53ef\u4e0d\u53ef\u4ee5)(?:[?？])?\s*$/
];
const CLARIFICATION_PATTERNS = [
  /\b(?:actually|I mean|what I meant|to clarify|correction)\b/i,
  /(?:\u6211\u7684\u610f\u601d\u662f|\u6211\u662f\u8bf4|\u66f4\u6b63\u4e00\u4e0b|\u6211\u521a\u624d\u7684\u610f\u601d|\u4e0d\u662f\u8fd9\u4e2a\u610f\u601d)/
];
const CASUAL_PATTERNS = [
  /^(?:hi|hello|hey|thanks|thank you|good morning|good afternoon|good evening)[!. ]*$/i,
  /^(?:\u4f60\u597d|\u55e8|\u8c22\u8c22|\u65e9\u4e0a\u597d|\u4e0b\u5348\u597d|\u665a\u4e0a\u597d)[\uff01!,.，。 ]*$/
];
const EMAIL_SEND_PATTERNS = [
  /\b(?:please\s+)?send\s+(?:an?\s+)?(?:email|e-mail)\b/i,
  /\b(?:please\s+)?email\s+(?:to\s+)?[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
  /(?:请|麻烦|帮我|帮忙)?(?:发|发送)(?:一封|个)?邮件/i
];
const EMAIL_CAPABILITY_PATTERNS = [
  /\b(?:can|could|are you able to|do you know how to)\b[\s\S]*(?:send|email)[\s\S]*(?:email|e-mail)?\??$/i,
  /(?:你)?(?:能|可以|会)[\s\S]*(?:发|发送)[\s\S]*邮件(?:吗|么)?(?:？|\?)?$/i
];
const EMAIL_NEGATION_PATTERNS = [
  /\b(?:do not|don't|did not|didn't|not asking you to|never)\b[\s\S]*(?:send|email)/i,
  /(?:没让你|没有让你|不是让你|不需要你|不要|别)(?:去)?(?:发|发送)?邮件/i,
  /(?:我现在是在问你|我只是在问)[\s\S]*(?:没|不|别)[\s\S]*发邮件/i
];

export const lilySystemPrompt = `You are Lily, John's execution assistant. First understand intent, then decide whether to answer, ask a question, or execute. Never execute external actions unless the user clearly asks you to do so.

You help with:
- finding US B2B customers
- finding China factories
- writing outreach emails
- creating CSV lead lists
- sourcing products from China
- organizing business tasks

Be conversational for questions and casual messages. Be concise and useful on mobile.
For commands, return practical, business-ready results. When asked for leads, use:
- company_name
- website
- reason_good_lead
- suggested_outreach_email

External tools are gated by application code. Never claim an email or other external action was completed unless the application confirms it.
Do not claim that you visited live websites unless tools or supplied context prove it. If current web verification is unavailable, say the leads are starting hypotheses and should be verified before outreach.`;

export function createOpenAIClient() {
  return getLlmClient();
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
  const normalized = task.trim();
  const emailMatch = normalized.match(EMAIL_PATTERN);
  const to = emailMatch?.[0] || null;
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
        `(?:\u8bf4|\u6b63\u6587\u662f|\u5185\u5bb9\u662f|body is|message is|saying|that says)\\s*[:\\uFF1A]?\\s*(.+)$`,
        "i"
      )
    );
    body = sayMatch?.[1]?.trim() || null;
  }

  const explicitSubject = getLineValue(normalized, ["subject", "\u4e3b\u9898"]);
  const subject = explicitSubject || DEFAULT_EMAIL_SUBJECT;

  return {
    to,
    subject,
    body
  };
}

function containsEmailTerm(task) {
  const lowerTask = task.toLowerCase();
  return EMAIL_TERMS.some((term) => lowerTask.includes(term));
}

function buildEmailClarification(missing) {
  const labels = {
    recipient: "\u6536\u4ef6\u4eba\u90ae\u7bb1",
    subject: "\u4e3b\u9898",
    body: "\u6b63\u6587"
  };

  return `\u53d1\u9001\u524d\u8fd8\u9700\u8981${missing.map((field) => labels[field]).join("\u3001")}\u3002\u8bf7\u628a\u8fd9\u4e9b\u4fe1\u606f\u4e00\u6b21\u544a\u8bc9\u6211\uff0c\u53ef\u4ee5\u5417\uff1f`;
}

export function classifyTaskIntent(task) {
  const normalized = task.trim();

  if (
    containsEmailTerm(normalized) &&
    EMAIL_NEGATION_PATTERNS.some((pattern) => pattern.test(normalized))
  ) {
    return {
      intent: "CLARIFICATION",
      action: "ANSWER",
      message: "\u62b1\u6b49\uff0c\u6211\u521a\u624d\u7406\u89e3\u9519\u4e86\u3002\u4f60\u73b0\u5728\u53ea\u662f\u5728\u95ee\u6211\uff0c\u6211\u4e0d\u4f1a\u53d1\u9001\u90ae\u4ef6\u3002"
    };
  }

  if (
    containsEmailTerm(normalized) &&
    EMAIL_CAPABILITY_PATTERNS.some((pattern) => pattern.test(normalized))
  ) {
    return {
      intent: "QUESTION",
      action: "ANSWER",
      message:
        "\u53ef\u4ee5\u3002\u6211\u80fd\u5e2e\u4f60\u53d1\u90ae\u4ef6\uff0c\u4f46\u53ea\u6709\u5728\u4f60\u660e\u786e\u8981\u6c42\u53d1\u9001\uff0c\u5e76\u63d0\u4f9b\u6536\u4ef6\u4eba\u90ae\u7bb1\u548c\u6b63\u6587\u540e\uff0c\u6211\u624d\u4f1a\u6267\u884c\u3002"
    };
  }

  if (
    containsEmailTerm(normalized) &&
    EMAIL_SEND_PATTERNS.some((pattern) => pattern.test(normalized))
  ) {
    const emailTask = parseEmailTask(normalized);
    const missing = [];

    if (!emailTask.to) {
      missing.push("recipient");
    }
    if (!emailTask.body) {
      missing.push("body");
    }

    if (missing.length > 0) {
      return {
        intent: "TOOL_ACTION",
        action: "ASK_CLARIFICATION",
        tool: "EMAIL_SEND",
        missing,
        message: buildEmailClarification(missing)
      };
    }

    return {
      intent: "TOOL_ACTION",
      action: "EXECUTE",
      tool: "EMAIL_SEND",
      emailTask
    };
  }

  if (CLARIFICATION_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { intent: "CLARIFICATION", action: "RESPOND" };
  }

  if (QUESTION_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { intent: "QUESTION", action: "RESPOND" };
  }

  if (CASUAL_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { intent: "CASUAL", action: "RESPOND" };
  }

  return { intent: "COMMAND", action: "RESPOND" };
}

export async function runLilyTask(
  task,
  client,
  { classification: providedClassification } = {}
) {
  if (!task || typeof task !== "string" || task.trim().length === 0) {
    const error = new Error("task is required and must be a non-empty string");
    error.statusCode = 400;
    throw error;
  }

  const classification = providedClassification || classifyTaskIntent(task);

  if (classification.action === "ANSWER" || classification.action === "ASK_CLARIFICATION") {
    return {
      ok: true,
      intent: classification.intent,
      action:
        classification.action === "ASK_CLARIFICATION"
          ? "EMAIL_CLARIFICATION"
          : "CONVERSATIONAL_RESPONSE",
      message: classification.message,
      missing: classification.missing || []
    };
  }

  if (
    classification.intent === "TOOL_ACTION" &&
    classification.action === "EXECUTE" &&
    classification.tool === "EMAIL_SEND"
  ) {
    return {
      ok: true,
      intent: "TOOL_ACTION",
      action: "EMAIL_APPROVAL_REQUIRED",
      message: "Email sending requires a draft and John's explicit approval.",
      emailTask: classification.emailTask
    };
  }

  const openai = client || createOpenAIClient();
  const response = await openai.chat.completions.create({
    model: getLlmModel(),
    temperature: 0.4,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: lilySystemPrompt
      },
      {
        role: "user",
        content: `Classified intent: ${classification.intent}
User message: ${task.trim()}

Return JSON only, using this shape:
{
  "intent": "${classification.intent}",
  "response": "natural conversational answer when appropriate, otherwise an empty string",
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
}

For QUESTION, CLARIFICATION, or CASUAL, put the complete human answer in "response".
For COMMAND, use "summary", "leads", and "notes" when relevant.
Do not execute or claim to execute external tools.`
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
