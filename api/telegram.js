import { classifyTaskIntent, runLilyTask, sendJson } from "../lib/lily.js";
import { getDatabase } from "../lib/db.js";
import { formatTaskReport } from "../lib/queue.js";
import {
  approveEmailDraft,
  createBackgroundTask,
  createEmailApprovalDraft,
  shouldRunInBackground
} from "../lib/task-service.js";

const TELEGRAM_MESSAGE_LIMIT = 4096;
const MAX_PROCESSED_UPDATES = 500;
const processedTelegramUpdates =
  globalThis.__lilyProcessedTelegramUpdates || new Map();
globalThis.__lilyProcessedTelegramUpdates = processedTelegramUpdates;

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
  if (
    result?.action === "CONVERSATIONAL_RESPONSE" ||
    result?.action === "EMAIL_CLARIFICATION"
  ) {
    return cleanText(result.message) || "Please provide the missing email details.";
  }

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
  const response = cleanText(result.response);
  const task = cleanText(result.task);
  const rawResult = cleanText(result.raw_result);
  const notes = formatNotes(result.notes);
  const leads = Array.isArray(result.leads) ? result.leads.filter(Boolean) : [];
  const emails = leads
    .map((lead) => cleanText(lead?.suggested_outreach_email))
    .filter(Boolean);
  const sections = [];

  if (response) {
    sections.push(response);
  }

  if (!response && summary) {
    sections.push(`Task completed: ${summary}`);
  } else if (!response && task) {
    sections.push(`Task completed: ${task}`);
  } else if (!response) {
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

function shortId(id) {
  return id?.slice(0, 8) || "";
}

async function handleTelegramCommand(text, { userId, chatId, db, approveDraft }) {
  const [command, argument] = text.trim().split(/\s+/, 2);

  if (command === "/help") {
    return [
      "Lily commands:",
      "/status [task-id] - show task progress",
      "/tasks - list recent tasks",
      "/stop [task-id] - stop a queued/running task",
      "/report [task-id] - show the latest completed report",
      "/approve <draft-id> - approve and send an email draft",
      "/help - show this message"
    ].join("\n");
  }

  if (command === "/tasks") {
    const tasks = await db.listTasks(userId);
    if (!tasks.length) {
      return "No tasks yet.";
    }
    return tasks
      .map((task) => `${shortId(task.id)} · ${task.status} · ${task.progress}%\n${task.objective}`)
      .join("\n\n");
  }

  if (command === "/status") {
    const task = argument
      ? await db.getTaskByPrefix(argument, userId)
      : await db.getLatestTask(userId);
    if (!task || String(task.user_id) !== String(userId)) {
      return "Task not found.";
    }
    return [
      `Task ${shortId(task.id)}: ${task.status}`,
      `Progress: ${task.progress}%`,
      task.objective,
      task.error ? `Error: ${task.error}` : ""
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (command === "/stop") {
    const task = argument
      ? await db.getTaskByPrefix(argument, userId)
      : await db.getLatestTask(userId);
    if (!task || String(task.user_id) !== String(userId)) {
      return "Task not found.";
    }
    const stopped = await db.stopTask(task.id, userId);
    return stopped ? `Task ${shortId(task.id)} stopped.` : "That task is not running.";
  }

  if (command === "/report") {
    const task = argument
      ? await db.getTaskByPrefix(argument, userId)
      : await db.getLatestTask(userId);
    if (!task || String(task.user_id) !== String(userId)) {
      return "Task not found.";
    }
    if (task.status !== "completed") {
      return `Task ${shortId(task.id)} is ${task.status} (${task.progress}%).`;
    }
    return formatTaskReport(task, await db.listEntities(task.id));
  }

  if (command === "/approve") {
    if (!argument) {
      return "Usage: /approve <draft-id>";
    }
    const draft = await approveDraft(argument, userId, { db });
    return [
      "Task completed: Email sent",
      `To: ${draft.recipient}`,
      `Subject: ${draft.subject}`
    ].join("\n");
  }

  return null;
}

async function processTelegramUpdateOnce(
  update,
  {
    token = process.env.TELEGRAM_BOT_TOKEN,
    runTask = runLilyTask,
    fetchImpl = fetch,
    db = getDatabase(),
    createTask = createBackgroundTask,
    createDraft = createEmailApprovalDraft,
    approveDraft = approveEmailDraft
  } = {}
) {
  const message = update?.message || update?.edited_message;
  const chatId = message?.chat?.id;
  const userId = message?.from?.id || chatId;
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
    if (text.trim().startsWith("/")) {
      const reply = await handleTelegramCommand(text, {
        userId,
        chatId,
        db,
        approveDraft
      });
      await sendTelegramMessage(token, chatId, reply || "Unknown command. Use /help.", fetchImpl);
      return {
        ok: true,
        chatId,
        command: text.trim().split(/\s+/, 1)[0],
        messagesSent: 1
      };
    }

    const memoryMatch = text.trim().match(/^(?:remember|记住)[:：]?\s*(.+)$/i);
    if (memoryMatch) {
      await db.saveMemory({
        userId,
        category: "instruction",
        key: `telegram-${Date.now()}`,
        value: memoryMatch[1].trim()
      });
      await sendTelegramMessage(token, chatId, "Got it. I saved that instruction.", fetchImpl);
      return {
        ok: true,
        chatId,
        memorySaved: true,
        messagesSent: 1
      };
    }

    const classification = classifyTaskIntent(text.trim());

    if (
      classification.intent === "TOOL_ACTION" &&
      classification.action === "EXECUTE" &&
      classification.tool === "EMAIL_SEND"
    ) {
      const draft = await createDraft({
        userId,
        chatId,
        emailTask: classification.emailTask,
        db
      });
      await sendTelegramMessage(
        token,
        chatId,
        [
          "Email draft ready. Nothing has been sent.",
          `To: ${draft.recipient}`,
          `Subject: ${draft.subject}`,
          "",
          `Approve with: /approve ${draft.id}`
        ].join("\n"),
        fetchImpl
      );
      return {
        ok: true,
        chatId,
        intent: classification.intent,
        draftId: draft.id,
        messagesSent: 1
      };
    }

    if (
      classification.intent === "COMMAND" &&
      shouldRunInBackground(text.trim())
    ) {
      const task = await createTask({
        userId,
        chatId,
        objective: text.trim(),
        db
      });
      await sendTelegramMessage(
        token,
        chatId,
        [
          "Got it. I created a background task and will send the final report when it is finished.",
          `Task ID: ${task.id}`,
          "Use /status, /tasks, or /stop to manage it."
        ].join("\n"),
        fetchImpl
      );
      return {
        ok: true,
        chatId,
        intent: classification.intent,
        taskId: task.id,
        messagesSent: 1
      };
    }

    const result = await runTask(text.trim(), undefined, { classification });
    const chunks = splitTelegramMessage(formatLilyResult(result));

    for (const chunk of chunks) {
      await sendTelegramMessage(token, chatId, chunk, fetchImpl);
    }

    return {
      ok: true,
      chatId,
      intent: classification.intent,
      messagesSent: chunks.length
    };
  } catch (error) {
    const errorText = `Lily could not complete that request: ${error.message || "Unexpected error"}`;

    try {
      await sendTelegramMessage(token, chatId, errorText.slice(0, TELEGRAM_MESSAGE_LIMIT), fetchImpl);
    } catch (sendError) {
      error.message = `${error.message || "Lily task failed"}; ${sendError.message}`;
      throw error;
    }

    return {
      ok: false,
      handled: true,
      chatId,
      error: error.message || "Unexpected error",
      messagesSent: 1
    };
  }
}

function rememberTelegramUpdate(updateId, job, updateCache) {
  updateCache.set(updateId, job);

  while (updateCache.size > MAX_PROCESSED_UPDATES) {
    const oldestUpdateId = updateCache.keys().next().value;
    updateCache.delete(oldestUpdateId);
  }
}

export async function processTelegramUpdate(
  update,
  options = {}
) {
  const updateId = update?.update_id;
  const updateCache = options.updateCache || processedTelegramUpdates;
  const db = options.db || getDatabase();

  if (updateId === undefined || updateId === null) {
    return processTelegramUpdateOnce(update, { ...options, db });
  }

  if (!options.updateCache) {
    const firstDelivery = await db.markUpdateProcessed(updateId);
    if (!firstDelivery) {
      return {
        ok: true,
        ignored: true,
        duplicate: true,
        updateId
      };
    }
    return processTelegramUpdateOnce(update, { ...options, db });
  }

  const existingJob = updateCache.get(updateId);
  if (existingJob) {
    await existingJob;
    return {
      ok: true,
      ignored: true,
      duplicate: true,
      updateId
    };
  }

  const job = processTelegramUpdateOnce(update, options);
  rememberTelegramUpdate(updateId, job, updateCache);

  try {
    return await job;
  } catch (error) {
    updateCache.delete(updateId);
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
