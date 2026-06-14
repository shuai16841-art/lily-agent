import OpenAI from "openai";

const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

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

export async function runLilyTask(task, client = createOpenAIClient()) {
  if (!task || typeof task !== "string" || task.trim().length === 0) {
    const error = new Error("task is required and must be a non-empty string");
    error.statusCode = 400;
    throw error;
  }

  const response = await client.chat.completions.create({
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
