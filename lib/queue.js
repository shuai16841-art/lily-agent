import { runAutonomousTask } from "./agent.js";
import { getDatabase } from "./db.js";
import { sendTelegramLongText } from "./telegram-client.js";

let workerTimer;
let workerBusy = false;

export function formatTaskReport(task, entities = []) {
  const result = task?.result || {};
  const buyers = entities.filter((item) => item.kind === "buyer");
  const factories = entities.filter((item) => item.kind === "factory");
  const lines = [
    `Task completed: ${result.summary || task.objective}`,
    "",
    `Task ID: ${task.id}`
  ];

  if (buyers.length) {
    lines.push("", `Buyers (${buyers.length}):`);
    buyers.forEach((item, index) => {
      lines.push(
        `${index + 1}. ${item.company || "Unknown company"}`,
        `Website: ${item.website || "Not publicly listed"}`,
        `Contact: ${item.contact || "Not publicly listed"}`,
        `Email: ${item.email || "Not publicly listed"}`,
        `Phone: ${item.phone || "Not publicly listed"}`
      );
    });
  }

  if (factories.length) {
    lines.push("", `Factories (${factories.length}):`);
    factories.forEach((item, index) => {
      lines.push(
        `${index + 1}. ${item.company || "Unknown company"}`,
        `Website: ${item.website || "Not publicly listed"}`,
        `Contact: ${item.contact || "Not publicly listed"}`,
        `Email: ${item.email || "Not publicly listed"}`,
        `Phone: ${item.phone || "Not publicly listed"}`
      );
    });
  }

  if (Array.isArray(result.notes) && result.notes.length) {
    lines.push("", "Notes:", ...result.notes.map((note) => `- ${note}`));
  }
  return lines.join("\n");
}

export async function processNextTask({
  db = getDatabase(),
  runner = runAutonomousTask,
  notify = sendTelegramLongText,
  llmClient,
  fetchImpl
} = {}) {
  if (workerBusy) {
    return null;
  }
  workerBusy = true;
  let activeTask;

  try {
    const task = await db.claimNextTask();
    if (!task) {
      return null;
    }
    activeTask = task;

    const steps = [
      { name: "Understand objective", status: "completed" },
      { name: "Research and verify sources", status: "running" },
      { name: "Save structured results", status: "pending" },
      { name: "Generate final report", status: "pending" }
    ];
    await db.updateTask(task.id, { steps, progress: 10 });

    const result = await runner(task, {
      db,
      llmClient,
      fetchImpl,
      onProgress: async ({ progress, message }) => {
        await db.updateTask(task.id, { progress });
        if (progress === 45 || progress === 80) {
          await notify(task.chat_id, `Task ${task.id.slice(0, 8)}: ${message}`);
        }
      }
    });

    const current = await db.getTask(task.id);
    if (current?.status === "stopped" || result?.stopped) {
      await db.updateTask(task.id, {
        status: "stopped",
        progress: current?.progress || 0,
        result
      });
      await notify(task.chat_id, `Task ${task.id.slice(0, 8)} stopped.`);
      return db.getTask(task.id);
    }

    steps[1].status = "completed";
    steps[2].status = "completed";
    steps[3].status = "completed";
    const completed = await db.updateTask(task.id, {
      status: "completed",
      progress: 100,
      steps,
      result
    });
    const entities = await db.listEntities(task.id);
    await notify(task.chat_id, formatTaskReport(completed, entities));
    return completed;
  } catch (error) {
    if (activeTask) {
      await db.updateTask(activeTask.id, {
        status: "failed",
        error: error.message
      });
      await notify(activeTask.chat_id, `Task failed: ${error.message}`);
    }
    throw error;
  } finally {
    workerBusy = false;
  }
}

export function startQueueWorker(options = {}) {
  if (workerTimer) {
    return workerTimer;
  }
  const interval = Number(process.env.LILY_WORKER_INTERVAL_MS || 3000);
  const tick = async () => {
    try {
      await processNextTask(options);
    } catch (error) {
      console.error("Lily worker error", error);
    }
  };
  workerTimer = setInterval(tick, interval);
  workerTimer.unref?.();
  void tick();
  return workerTimer;
}

export function stopQueueWorker() {
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
  }
}
