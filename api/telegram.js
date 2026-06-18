import { runLilyTask, sendJson } from "../lib/lily.js";

const TELEGRAM_MESSAGE_LIMIT = 4096;

function formatLilyResult(result) {
  if (result?.action === "EMAIL_SENT") {
    return `Email sent to ${result.to}${result.subject ? `\nSubject: ${result.subject}` : ""}`;
  }

  if (typeof result === "string") {
    return result;
  }

  return JSON.stringify(result, null, 2);
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
