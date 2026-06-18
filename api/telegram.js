import { runLilyTask, sendJson } from "../lib/lily.js";

const TELEGRAM_MESSAGE_LIMIT = 4096;

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isJsonLikeText(value) {
  const text = cleanText(value).replace(/^```(?:json)?\s*/i, "");
  return text.startsWith("{") || text.startsWith("[");
}

function formatNotes(notes) {
  if (!Array.isArray(notes) || notes.length === 0) {
    return "";
  }

  const items = notes
    .map(cleanText)
    .filter(Boolean)
    .map((note) => `- ${note}`);

  return items.length > 0 ? `Notes / next steps:\n${items.join("\n")}` : "";
}

function formatLead(lead, index, includeEmail = true) {
  const name = cleanText(lead?.company_name) || `Lead ${index + 1}`;
  const lines = [`${index + 1}. ${name}`];
  const website = cleanText(lead?.website);
  const reason = cleanText(lead?.reason_good_lead);
  const email = cleanText(lead?.suggested_outreach_email);

  if (website) {
    lines.push(website);
  }
  if (reason) {
    lines.push(`Why it fits: ${reason}`);
  }
  if (includeEmail && email) {
    lines.push("", "Outreach email:", email);
  }

  return lines.join("\n");
}

export function formatLilyResult(result) {
  if (result?.action === "EMAIL_SENT") {
    const lines = ["Task completed: Email sent", `To: ${result.to}`];
    if (result.subject) {
      lines.push(`Subject: ${result.subject}`);
    }
    return lines.join("\n");
  }

  if (typeof result === "string") {
    return result.trim();
  }

  if (!result || typeof result !== "object") {
    return "Task completed.";
  }

  const summary = cleanText(result.summary);
  const task = cleanText(result.task);
  const rawResult = cleanText(result.raw_result);
  const notes = formatNotes(result.notes);
  const leads = Array.isArray(result.leads) ? result.leads.filter(Boolean) : [];
  const emails = leads
    .map((lead) => cleanText(lead?.suggested_outreach_email))
    .filter(Boolean);
  const sections = [];

  if (summary) {
    sections.push(`Task completed: ${summary}`);
  } else if (task) {
    sections.push(`Task completed: ${task}`);
  } else {
    sections.push("Task completed.");
  }

  if (leads.length === 1 && emails.length === 1) {
    const lead = leads[0];
    const name = cleanText(lead.company_name);
    const website = cleanText(lead.website);
    const reason = cleanText(lead.reason_good_lead);
    const context = [];

    if (name) {
      context.push(`For: ${name}`);
    }
    if (website) {
      context.push(website);
    }
    if (reason) {
      context.push(`Why it fits: ${reason}`);
    }
    if (context.length > 0) {
      sections.push(context.join("\n"));
    }

    sections.push(`Final outreach email:\n\n${emails[0]}`);
  } else if (leads.length > 0) {
    sections.push(
      `Leads (${leads.length}):\n\n${leads
        .map((lead, index) => formatLead(lead, index))
        .join("\n\n")}`
    );
  } else if (rawResult && !isJsonLikeText(rawResult)) {
    sections.push(rawResult);
  }

  if (notes) {
    sections.push(notes);
  }

  return sections.filter(Boolean).join("\n\n");
}

function splitTelegramMessage(text, limit = TELEGRAM_MESSAGE_LIMIT) {
  const chunks = [];
  let remaining = text;

  while (remaining.length > limit) {
    let splitAt = remaining.lastIndexOf("\n", limit);
    if (splitAt < Math.floor(limit * 0.5)) {
      splitAt = remaining.lastIndexOf(" ", limit);
    }
    if (splitAt < Math.floor(limit * 0.5)) {
      splitAt = limit;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

async function sendTelegramMessage(token, chatId, text, fetchImpl = fetch) {
  const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      chat_id: chatId,
      text
    })
  });

  const responseBody = await response.json().catch(() => null);
  if (!response.ok || responseBody?.ok === false) {
    const description = responseBody?.description || `HTTP ${response.status}`;
    throw new Error(`Telegram sendMessage failed: ${description}`);
  }

  return responseBody;
}

export async function processTelegramUpdate(
  update,
  {
    token = process.env.TELEGRAM_BOT_TOKEN,
    runTask = runLilyTask,
    fetchImpl = fetch
  } = {}
) {
  const message = update?.message || update?.edited_message;
  const chatId = message?.chat?.id;
  const text = message?.text;

  if (!chatId || typeof text !== "string" || text.trim().length === 0) {
    return {
      ok: true,
      ignored: true,
      reason: "Update does not contain a text message."
    };
  }

  if (!token) {
    const error = new Error("TELEGRAM_BOT_TOKEN is required");
    error.statusCode = 500;
    throw error;
  }

  try {
    const result = await runTask(text.trim());
    const chunks = splitTelegramMessage(formatLilyResult(result));

    for (const chunk of chunks) {
      await sendTelegramMessage(token, chatId, chunk, fetchImpl);
    }

    return {
      ok: true,
      chatId,
      messagesSent: chunks.length
    };
  } catch (error) {
    const errorText = `Lily could not complete that request: ${error.message || "Unexpected error"}`;

    try {
      await sendTelegramMessage(token, chatId, errorText.slice(0, TELEGRAM_MESSAGE_LIMIT), fetchImpl);
    } catch (sendError) {
      error.message = `${error.message || "Lily task failed"}; ${sendError.message}`;
    }

    throw error;
  }
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    res.status(200);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.end("Telegram webhook is running");
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return sendJson(res, 405, {
      ok: false,
      error: "Method not allowed. Use GET or POST /api/telegram."
    });
  }

  try {
    const result = await processTelegramUpdate(req.body);
    return sendJson(res, 200, result);
  } catch (error) {
    return sendJson(res, error.statusCode || 500, {
      ok: false,
      error: error.message || "Unexpected server error"
    });
  }
}
