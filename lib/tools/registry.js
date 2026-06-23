import { webSearch, webSearchDefinition } from "./web-search.js";

const defaultAgentToolDefinitions = [webSearchDefinition];

export function taskRequestsGoogleSheets(objective = "") {
  return /(?:google\s*sheets?|spreadsheet|write|save|append|export).{0,30}(?:google\s*sheets?|spreadsheet)|(?:google\s*sheets?|spreadsheet).{0,30}(?:write|save|append|export)|谷歌表格|試算表|电子表格/i.test(
    objective
  );
}

export function getAgentToolDefinitions(objective = "") {
  return defaultAgentToolDefinitions;
}

export const agentToolDefinitions = defaultAgentToolDefinitions;

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
    } else {
      throw new Error(`Tool ${name} is not available in research mode`);
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
