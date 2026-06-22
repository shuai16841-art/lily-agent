import { getDatabase } from "./db.js";
import { createGmailDraft, sendGmailDraft } from "./tools/gmail.js";

export function shouldRunInBackground(text) {
  return /(?:find|research|source|identify|build|create|collect|verify|调查|查找|寻找|搜集|找\s*\d+|买家|工厂)/i.test(
    text
  );
}

export async function createBackgroundTask({
  userId,
  chatId,
  objective,
  db = getDatabase()
}) {
  return db.createTask({
    userId,
    chatId,
    objective,
    steps: [
      { name: "Understand objective", status: "pending" },
      { name: "Research and verify sources", status: "pending" },
      { name: "Save structured results", status: "pending" },
      { name: "Generate final report", status: "pending" }
    ],
    metadata: {
      source: "telegram"
    }
  });
}

export async function approveEmailDraft(draftId, userId, {
  db = getDatabase(),
  sendDraft = sendGmailDraft
} = {}) {
  const draft = await db.getEmailDraft(draftId);
  if (!draft || String(draft.user_id) !== String(userId)) {
    throw new Error("Draft not found");
  }
  if (draft.status === "sent") {
    return draft;
  }
  if (!draft.provider_id) {
    throw new Error("The Gmail provider draft has not been created yet");
  }

  const result = await sendDraft({ draftId: draft.provider_id });
  await db.logAction({
    taskId: draft.task_id,
    tool: "gmail_send_draft",
    status: "completed",
    args: { draftId },
    result
  });
  return db.updateEmailDraft(draftId, {
    status: "sent",
    provider_id: result.id || draft.provider_id
  });
}

export async function createEmailApprovalDraft({
  userId,
  chatId,
  emailTask,
  db = getDatabase(),
  createDraft = createGmailDraft
}) {
  const providerDraft = await createDraft({
    to: emailTask.to,
    subject: emailTask.subject,
    body: emailTask.body
  });
  const draft = await db.createEmailDraft({
    userId,
    chatId,
    recipient: emailTask.to,
    subject: emailTask.subject,
    body: emailTask.body
  });
  await db.updateEmailDraft(draft.id, {
    provider_id: providerDraft.id
  });
  await db.logAction({
    tool: "gmail_create_draft",
    status: "completed",
    args: {
      to: emailTask.to,
      subject: emailTask.subject
    },
    result: {
      draftId: draft.id,
      providerId: providerDraft.id
    }
  });
  return db.getEmailDraft(draft.id);
}
