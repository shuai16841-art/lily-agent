import { getDatabase } from "./db.js";
import { createGmailDraft, sendGmailDraft } from "./tools/gmail.js";

export function estimateTaskDurationSeconds(objective) {
  const counts = [...objective.matchAll(/\b(\d{1,3})\b/g)].map((match) =>
    Number(match[1])
  );
  const requestedItems = counts.reduce((sum, count) => sum + count, 0);
  const researchSeconds = requestedItems > 0 ? requestedItems * 20 : 180;
  return Math.min(Math.max(120, researchSeconds + 60), 1800);
}

export function formatDuration(seconds) {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return `about ${minutes} minute${minutes === 1 ? "" : "s"}`;
}

export function formatTaskEta(task, currentTime = Date.now()) {
  if (task?.status === "completed") {
    return "complete";
  }
  if (["failed", "stopped"].includes(task?.status)) {
    return "not available";
  }

  const completionTime = Date.parse(task?.metadata?.estimated_completion_at || "");
  if (!Number.isFinite(completionTime)) {
    const seconds = Number(task?.metadata?.estimated_duration_seconds);
    return seconds > 0 ? formatDuration(seconds) : null;
  }

  const remainingSeconds = Math.max(60, Math.ceil((completionTime - currentTime) / 1000));
  return formatDuration(remainingSeconds);
}

export function formatProgressStatus(
  status,
  eta = null,
  progress = null,
  action = null
) {
  return [
    `Status: ${status}`,
    Number.isFinite(progress) ? `Progress: ${progress}%` : "",
    eta ? `ETA: ${eta}` : "",
    action ? `Current Action: ${action}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

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
  const estimatedDurationSeconds = estimateTaskDurationSeconds(objective);
  const estimatedCompletionAt = new Date(
    Date.now() + estimatedDurationSeconds * 1000
  ).toISOString();
  const receivedAt = new Date().toISOString();

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
      source: "telegram",
      execution_mode: "ASK",
      estimated_duration_seconds: estimatedDurationSeconds,
      estimated_completion_at: estimatedCompletionAt,
      current_activity: "Waiting for a worker",
      current_stage: "Received",
      checkpoint_iteration: 0,
      stage_history: [
        {
          stage: "Received",
          progress: 0,
          activity: "Waiting for a worker",
          created_at: receivedAt
        }
      ]
    }
  });
}

export async function approveEmailDraft(draftId, userId, {
  db = getDatabase(),
  createDraft = createGmailDraft,
  sendDraft = sendGmailDraft
} = {}) {
  const draft = await db.getEmailDraft(draftId);
  if (!draft || String(draft.user_id) !== String(userId)) {
    throw new Error("Draft not found");
  }
  if (draft.status === "sent") {
    return draft;
  }
  let providerId = draft.provider_id;
  if (!providerId) {
    const providerDraft = await createDraft({
      to: draft.recipient,
      subject: draft.subject,
      body: draft.body
    });
    providerId = providerDraft.id;
    await db.updateEmailDraft(draft.id, {
      provider_id: providerId
    });
  }
  const result = await sendDraft({ draftId: providerId });
  await db.logAction({
    taskId: draft.task_id,
    tool: "gmail_send_draft",
    status: "completed",
    args: { draftId },
    result
  });
  return db.updateEmailDraft(draftId, {
    status: "sent",
    provider_id: result.id || providerId
  });
}

export async function createEmailApprovalDraft({
  userId,
  chatId,
  emailTask,
  db = getDatabase()
}) {
  const draft = await db.createEmailDraft({
    userId,
    chatId,
    recipient: emailTask.to,
    subject: emailTask.subject,
    body: emailTask.body
  });
  await db.logAction({
    tool: "email_approval_requested",
    status: "completed",
    args: {
      to: emailTask.to,
      subject: emailTask.subject
    },
    result: {
      draftId: draft.id,
      approved: false
    }
  });
  return db.getEmailDraft(draft.id);
}
