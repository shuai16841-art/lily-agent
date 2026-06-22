export async function sendTelegramText(chatId, text, token = process.env.TELEGRAM_BOT_TOKEN) {
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is required");
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      chat_id: chatId,
      text
    })
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.description || `Telegram sendMessage failed: HTTP ${response.status}`);
  }
  return payload;
}

export async function sendTelegramLongText(
  chatId,
  text,
  token = process.env.TELEGRAM_BOT_TOKEN
) {
  const chunks = [];
  let remaining = text;
  while (remaining.length > 4096) {
    let splitAt = remaining.lastIndexOf("\n", 4096);
    if (splitAt < 2000) {
      splitAt = 4096;
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) {
    chunks.push(remaining);
  }
  for (const chunk of chunks) {
    await sendTelegramText(chatId, chunk, token);
  }
  return chunks.length;
}
