import fs from "node:fs/promises";
import path from "node:path";
import { createClient } from "@libsql/client";
import { LilyDatabase } from "../lib/db.js";
import { formatTaskReport, processNextTask } from "../lib/queue.js";

const outputDir = path.resolve("outputs/test-agent");
await fs.mkdir(outputDir, { recursive: true });
const dbPath = path.join(outputDir, "lily-test.db").replaceAll("\\", "/");
await fs.rm(dbPath, { force: true });

const db = new LilyDatabase(createClient({ url: `file:${dbPath}` }));
await db.initialize();
const task = await db.createTask({
  userId: "john-test",
  chatId: "telegram-test",
  objective:
    "Find 5 real California B2B buyers for jump starters and 5 Chinese factories. Save results into database and return final report."
});

const fixtureBuyers = Array.from({ length: 5 }, (_, index) => ({
  company: `Verified California Buyer ${index + 1}`,
  website: `https://buyer${index + 1}.example.com`,
  contact: "Purchasing Department",
  email: `purchasing${index + 1}@buyer.example.com`,
  phone: `+1-555-010${index}`,
  evidence_url: `https://buyer${index + 1}.example.com/contact`
}));
const fixtureFactories = Array.from({ length: 5 }, (_, index) => ({
  company: `Verified Chinese Factory ${index + 1}`,
  website: `https://factory${index + 1}.example.cn`,
  contact: "Export Sales",
  email: `sales${index + 1}@factory.example.cn`,
  phone: `+86-755-1000-00${index}`,
  evidence_url: `https://factory${index + 1}.example.cn/contact`
}));

await processNextTask({
  db,
  notify: async () => {},
  runner: async (claimedTask, { db: taskDb }) => {
    await taskDb.saveEntities(claimedTask.id, "buyer", fixtureBuyers);
    await taskDb.saveEntities(claimedTask.id, "factory", fixtureFactories);
    return {
      summary: "Fixture-backed autonomous sourcing test completed.",
      buyers: fixtureBuyers,
      factories: fixtureFactories,
      notes: [
        "This test validates queue, persistence, reporting, and Telegram formatting.",
        "Run a live task with OPENAI_API_KEY and TAVILY_API_KEY to verify real companies."
      ]
    };
  }
});

const completed = await db.getTask(task.id);
const entities = await db.listEntities(task.id);
if (completed.status !== "completed" || entities.length !== 10) {
  throw new Error("Agent task integration test failed");
}

const report = formatTaskReport(completed, entities);
const reportPath = path.join(outputDir, "sample-report.txt");
await fs.writeFile(reportPath, report, "utf8");
console.log(`Agent test passed. Database: ${dbPath}`);
console.log(`Report: ${reportPath}`);
