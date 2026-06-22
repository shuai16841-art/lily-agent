import { createGmailDraft, gmailDraftDefinition } from "./gmail.js";
import { generateReportFile, reportDefinition } from "./reports.js";
import { appendGoogleSheetRows, sheetsAppendDefinition } from "./sheets.js";
import { webSearch, webSearchDefinition } from "./web-search.js";

export const agentToolDefinitions = [
  webSearchDefinition,
  gmailDraftDefinition,
  sheetsAppendDefinition,
  reportDefinition
];

export async function executeAgentTool(name, args, context) {
  const { db, taskId } = context;
  await db.logAction({
    taskId,
    tool: name,
    status: "started",
    args
  });

  try {
    let result;
    if (name === "web_search") {
      result = await webSearch(args, context.fetchImpl);
    } else if (name === "gmail_create_draft") {
      result = await createGmailDraft(args, context.fetchImpl);
      await db.createEmailDraft({
        taskId,
        userId: context.userId,
        chatId: context.chatId,
        recipient: args.to,
        subject: args.subject,
        body: args.body
      });
    } else if (name === "google_sheets_append") {
      result = await appendGoogleSheetRows(args, context.fetchImpl);
    } else if (name === "generate_report") {
      result = await generateReportFile({
        ...args,
        task_id: args.task_id || taskId
      });
    } else {
      throw new Error(`Unknown tool: ${name}`);
    }

    await db.logAction({
      taskId,
      tool: name,
      status: "completed",
      args,
      result
    });
    return result;
  } catch (error) {
    await db.logAction({
      taskId,
      tool: name,
      status: "failed",
      args,
      error: error.message
    });
    throw error;
  }
}
