import { createChatCompletion } from "./llm.js";
import {
  executeAgentTool,
  getAgentToolDefinitions
} from "./tools/registry.js";
import { generateReportFile } from "./tools/reports.js";

const AGENT_SYSTEM_PROMPT = `You are Lily, John's autonomous execution assistant.

First understand the objective, then use tools to gather evidence and complete the work.
Never invent companies, contacts, emails, phone numbers, sources, or completed actions.
Use web_search for current research. Store only results supported by sources.
Return normal task results directly for the Telegram reply.
Google Sheets is optional. Never use Google Sheets unless John explicitly asks
to save, write, append, or export results to Google Sheets or a spreadsheet.
If Google Sheets is requested but unavailable, continue the task and return the
results directly instead of failing.
You may create drafts and generate reports.
Never send an email or contact a customer. Email sending requires John's explicit approval outside this agent loop.

Your final response MUST be one valid JSON object only. Do not add markdown
fences, introductions, explanations, or trailing text outside the JSON object.
Return concise, useful final JSON with:
{
  "summary": "...",
  "buyers": [{"company":"","website":"","contact":"","email":"","phone":"","evidence_url":""}],
  "factories": [{"company":"","website":"","contact":"","email":"","phone":"","evidence_url":""}],
  "notes": ["..."],
  "report_markdown": "..."
}`;

const AGENT_RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "lily_research_result",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        summary: { type: "string" },
        buyers: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              company: { type: "string" },
              website: { type: "string" },
              contact: { type: "string" },
              email: { type: "string" },
              phone: { type: "string" },
              evidence_url: { type: "string" }
            },
            required: [
              "company",
              "website",
              "contact",
              "email",
              "phone",
              "evidence_url"
            ]
          }
        },
        factories: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              company: { type: "string" },
              website: { type: "string" },
              contact: { type: "string" },
              email: { type: "string" },
              phone: { type: "string" },
              evidence_url: { type: "string" }
            },
            required: [
              "company",
              "website",
              "contact",
              "email",
              "phone",
              "evidence_url"
            ]
          }
        },
        notes: {
          type: "array",
          items: { type: "string" }
        },
        report_markdown: { type: "string" }
      },
      required: [
        "summary",
        "buyers",
        "factories",
        "notes",
        "report_markdown"
      ]
    }
  }
};

function parseJson(value) {
  if (!value) {
    return null;
  }
  const normalized = value.replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  return JSON.parse(normalized);
}

function extractBalancedJsonObject(value) {
  const text = String(value || "");
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const character = text[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === "\"") {
          inString = false;
        }
        continue;
      }
      if (character === "\"") {
        inString = true;
      } else if (character === "{") {
        depth += 1;
      } else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          return text.slice(start, index + 1);
        }
      }
    }
  }
  return null;
}

function plainTextResult(value, objective) {
  const text = String(value || "").trim();
  const firstLine = text.split(/\r?\n/).find((line) => line.trim())?.trim();
  return {
    summary: firstLine || `Completed: ${objective}`,
    buyers: [],
    factories: [],
    notes: [
      "The model returned plain text instead of structured JSON; the result is shown below."
    ],
    raw_result: text,
    output_format: "plain_text_fallback"
  };
}

export function parseAgentResult(value, objective = "Task") {
  const text = String(value || "").trim();
  if (!text) {
    return plainTextResult("", objective);
  }

  const candidates = [
    text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim(),
    extractBalancedJsonObject(text)
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // Try the next extraction strategy before falling back to plain text.
    }
  }

  return plainTextResult(text, objective);
}

export async function runAutonomousTask(task, {
  db,
  llmClient,
  fetchImpl = fetch,
  onProgress = async () => {},
  maxIterations = Number(process.env.LILY_AGENT_MAX_ITERATIONS || 10)
}) {
  const memories = await db.getMemories(task.user_id);
  const savedEntities = await db.listEntities(task.id);
  const checkpointIteration = Number(task.metadata?.checkpoint_iteration || 0);
  const toolDefinitions = getAgentToolDefinitions(task.objective);
  const messages = [
    {
      role: "system",
      content: AGENT_SYSTEM_PROMPT
    },
    {
      role: "user",
      content: `Objective: ${task.objective}

Known user memory:
${JSON.stringify(memories.map((item) => ({
  category: item.category,
  key: item.memory_key,
  value: item.value
})))}

Resume checkpoint:
${JSON.stringify({
  stage: task.metadata?.current_stage || "Received",
  iteration: checkpointIteration,
  activity: task.metadata?.current_activity || "",
  previously_saved_entities: savedEntities.map((item) => ({
    kind: item.kind,
    company: item.company,
    website: item.website,
    email: item.email,
    phone: item.phone
  }))
})}

Continue from the saved checkpoint. Do not repeat companies already present in
previously_saved_entities unless you are adding missing verified contact data.
Work step by step. Use live tools where needed, then return the final JSON only.`
    }
  ];

  for (
    let iteration = checkpointIteration + 1;
    iteration <= maxIterations;
    iteration += 1
  ) {
    const current = await db.getTask(task.id);
    if (current?.status === "stopped") {
      return {
        stopped: true,
        summary: "Task stopped by John."
      };
    }

    await onProgress({
      progress: Math.min(10 + iteration * 7, 85),
      message: `Agent iteration ${iteration}: researching and verifying.`,
      checkpointIteration: iteration
    });

    const response = await createChatCompletion(
      {
        temperature: 0.2,
        messages,
        tools: toolDefinitions,
        tool_choice: "auto",
        response_format: AGENT_RESPONSE_FORMAT
      },
      llmClient
    );
    const assistant = response.choices?.[0]?.message;
    if (!assistant) {
      throw new Error("OpenAI returned an empty agent response");
    }
    messages.push(assistant);

    if (assistant.tool_calls?.length) {
      for (const call of assistant.tool_calls) {
        const args = parseJson(call.function.arguments || "{}");
        const result = await executeAgentTool(call.function.name, args, {
          db,
          taskId: task.id,
          userId: task.user_id,
          chatId: task.chat_id,
          fetchImpl
        });
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(result)
        });
        if (call.function.name === "web_search") {
          await onProgress({
            progress: Math.min(55 + iteration * 3, 72),
            message: `Verifying live search results for: ${args.query}`,
            checkpointIteration: iteration
          });
        }
      }
      continue;
    }

    const result = parseAgentResult(assistant.content, task.objective);
    if (Array.isArray(result.buyers)) {
      await db.saveEntities(task.id, "buyer", result.buyers);
    }
    if (Array.isArray(result.factories)) {
      await db.saveEntities(task.id, "factory", result.factories);
    }
    if (result.report_markdown) {
      result.report_file = await generateReportFile({
        task_id: task.id,
        title: result.summary || task.objective,
        markdown: result.report_markdown
      });
    }
    return result;
  }

  throw new Error(`Agent exceeded ${maxIterations} iterations`);
}

export { AGENT_RESPONSE_FORMAT, AGENT_SYSTEM_PROMPT };
