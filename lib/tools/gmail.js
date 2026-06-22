function requireGmailToken() {
  if (!process.env.GMAIL_ACCESS_TOKEN) {
    throw new Error("GMAIL_ACCESS_TOKEN is required for Gmail tools");
  }
  return process.env.GMAIL_ACCESS_TOKEN;
}

function base64Url(value) {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function rawEmail({ to, subject, body }) {
  return base64Url(
    [
      `To: ${to}`,
      `Subject: ${subject}`,
      "Content-Type: text/plain; charset=UTF-8",
      "",
      body
    ].join("\r\n")
  );
}

export async function createGmailDraft({ to, subject, body }, fetchImpl = fetch) {
  const response = await fetchImpl("https://gmail.googleapis.com/gmail/v1/users/me/drafts", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireGmailToken()}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      message: {
        raw: rawEmail({ to, subject, body })
      }
    })
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error?.message || `Gmail draft failed: HTTP ${response.status}`);
  }
  return payload;
}

export async function sendGmailDraft({ draftId }, fetchImpl = fetch) {
  const response = await fetchImpl(
    "https://gmail.googleapis.com/gmail/v1/users/me/drafts/send",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${requireGmailToken()}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ id: draftId })
    }
  );
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error?.message || `Gmail send failed: HTTP ${response.status}`);
  }
  return payload;
}

export const gmailDraftDefinition = {
  type: "function",
  function: {
    name: "gmail_create_draft",
    description:
      "Create a Gmail draft. This does not contact the recipient and still requires John to approve sending.",
    parameters: {
      type: "object",
      properties: {
        to: { type: "string" },
        subject: { type: "string" },
        body: { type: "string" }
      },
      required: ["to", "subject", "body"]
    }
  }
};
