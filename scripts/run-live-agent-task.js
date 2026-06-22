import "dotenv/config";
import { getDatabase } from "../lib/db.js";
import { processNextTask } from "../lib/queue.js";

if (!process.env.OPENAI_API_KEY || !process.env.TAVILY_API_KEY) {
  throw new Error("OPENAI_API_KEY and TAVILY_API_KEY are required for the live agent test");
}

const db = getDatabase();
await db.initialize();
const task = await db.createTask({
  userId: "john-live-test",
  chatId: process.env.LILY_TEST_CHAT_ID || "",
  objective:
    "Find 5 real California B2B buyers for jump starters and 5 real Chinese factories. Verify public website and contact details, save results into the database, and produce a final report."
});

console.log(`Queued live task ${task.id}`);
await processNextTask({
  db,
  notify: async (chatId, text) => {
    console.log(text);
  }
});

const completed = await db.getTask(task.id);
if (completed.status !== "completed") {
  throw new Error(completed.error || `Live task ended with status ${completed.status}`);
}
console.log(`Live agent test completed: ${task.id}`);
