import { runAutonomousTask } from "./agent.js";
import { getDatabase } from "./db.js";
import { sendTelegramLongText } from "./telegram-client.js";
import {
  formatDuration,
  formatProgressStatus,
  formatTaskEta
} from "./task-service.js";

let workerTimer;
let workerBusy = false;

const STAGES = {
  RECEIVED: "Received",
  RESEARCHING: "Researching...",
  VERIFYING: "Verifying leads...",
  EXTENDING: "Extending execution...",
  COMPILING: "Compiling final report...",
  COMPLETED: "Completed"
};
const STAGE_ORDER = [
  STAGES.RECEIVED,
  STAGES.RESEARCHING,
  STAGES.VERIFYING,
  STAGES.EXTENDING,
  STAGES.COMPILING,
  STAGES.COMPLETED
];

function stageForProgress(progress) {
  if (progress >= 75) {
    return STAGES.COMPILING;
  }
  if (progress >= 45) {
    return STAGES.VERIFYING;
  }
  return STAGES.RESEARCHING;
}

async function saveStage(
  db,
  taskId,
  {
    stage,
    progress,
    activity,
    checkpointIteration,
    extraMetadata = {}
  }
) {
  const current = await db.getTask(taskId);
  const metadata = current?.metadata || {};
  const stageHistory = Array.isArray(metadata.stage_history)
    ? [...metadata.stage_history]
    : [];
  const previousStage = metadata.current_stage;
  const previousStageIndex = STAGE_ORDER.indexOf(previousStage);
  const requestedStageIndex = STAGE_ORDER.indexOf(stage);
  const effectiveStage =
    previousStageIndex > requestedStageIndex ? previousStage : stage;
  const effectiveProgress = Math.max(
    Number(current?.progress || 0),
    Number(progress || 0)
  );
  const effectiveActivity =
    effectiveStage === stage ? activity : metadata.current_activity;
  const stageChanged = previousStage !== effectiveStage;

  if (stageChanged) {
    stageHistory.push({
      stage: effectiveStage,
      progress: effectiveProgress,
      activity: effectiveActivity,
      created_at: new Date().toISOString()
    });
  }

  const task = await db.updateTask(taskId, {
    progress: effectiveProgress,
    metadata: {
      ...metadata,
      ...extraMetadata,
      current_stage: effectiveStage,
      current_activity: effectiveActivity,
      checkpoint_iteration:
        checkpointIteration ?? metadata.checkpoint_iteration ?? 0,
      stage_history: stageHistory,
      last_checkpoint_at: new Date().toISOString()
    }
  });
  return { task, stageChanged };
}

async function sendProgressStatus(notify, task, stage = null) {
  const currentStage = stage || task.metadata?.current_stage || STAGES.RECEIVED;
  await notify(
    task.chat_id,
    formatProgressStatus(
      currentStage,
      formatTaskEta(task),
      Number(task.progress || 0),
      task.metadata?.current_activity
    )
  );
}

export async function heartbeatRunningTasks({
  db = getDatabase(),
  notify = sendTelegramLongText,
  heartbeatAfterSeconds = Number(process.env.LILY_STATUS_INTERVAL_MS || 45000) / 1000,
  currentTime = Date.now()
} = {}) {
  const tasks = await db.listRunningTasks();
  const heartbeats = [];

  for (const task of tasks) {
    const metadata = task.metadata || {};
    const lastSent = Date.parse(
      metadata.last_status_sent_at ||
        metadata.last_checkpoint_at ||
        task.updated_at ||
        task.created_at
    );
    const elapsedSeconds = Number.isFinite(lastSent)
      ? (currentTime - lastSent) / 1000
      : Infinity;
    if (elapsedSeconds < heartbeatAfterSeconds) {
      continue;
    }

    const estimatedDurationSeconds = Number(
      metadata.estimated_duration_seconds || 300
    );
    const startedAt = Date.parse(metadata.started_at || task.updated_at);
    const totalElapsedSeconds = Number.isFinite(startedAt)
      ? Math.max(0, (currentTime - startedAt) / 1000)
      : 0;
    const estimatedProgress = Math.min(
      85,
      Math.max(
        Number(task.progress || 0),
        Math.floor((totalElapsedSeconds / estimatedDurationSeconds) * 85)
      )
    );
    const stage = stageForProgress(estimatedProgress);
    const updated = await saveStage(db, task.id, {
      stage,
      progress: estimatedProgress,
      activity:
        metadata.current_activity ||
        (stage === STAGES.VERIFYING
          ? "Verifying collected leads"
          : stage === STAGES.COMPILING
            ? "Compiling the final report"
            : "Researching the objective"),
      checkpointIteration: Number(metadata.checkpoint_iteration || 0),
      extraMetadata: {
        last_status_sent_at: new Date(currentTime).toISOString(),
        last_cron_heartbeat_at: new Date(currentTime).toISOString()
      }
    });
    await sendProgressStatus(notify, updated.task, stage);
    heartbeats.push(updated.task.id);
  }

  return heartbeats;
}

export async function runScheduledWorkerCycle(options = {}) {
  const db = options.db || getDatabase();
  const recovered = await db.recoverInterruptedTasks(
    options.recoverStaleAfterSeconds ??
      Number(process.env.LILY_TASK_STALE_AFTER_SECONDS || 90)
  );
  const heartbeats = await heartbeatRunningTasks({
    ...options,
    db
  });
  const task = await processNextTask({
    ...options,
    db,
    skipRecovery: true
  });
  return {
    recoveredTaskIds: recovered.map((item) => item.id),
    heartbeatTaskIds: heartbeats,
    processedTaskId: task?.id || null
  };
}

export function formatTaskReport(task, entities = []) {
  const result = task?.result || {};
  const buyers = entities.filter((item) => item.kind === "buyer");
  const factories = entities.filter((item) => item.kind === "factory");
  const lines = [`Task completed: ${result.summary || task.objective}`];

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
  if (result.raw_result) {
    lines.push("", "Result:", String(result.raw_result).trim());
  }
  return lines.join("\n");
}

export async function processNextTask({
  db = getDatabase(),
  runner = runAutonomousTask,
  notify = sendTelegramLongText,
  llmClient,
  fetchImpl,
  statusIntervalMs = Number(process.env.LILY_STATUS_INTERVAL_MS || 45000),
  allowFastStatusInterval = false,
  skipRecovery = false,
  recoverStaleAfterSeconds = Number(
    process.env.LILY_TASK_STALE_AFTER_SECONDS || 90
  ),
  taskId
} = {}) {
  if (workerBusy) {
    return null;
  }
  workerBusy = true;
  let activeTask;
  let heartbeatTimer;

  try {
    if (!skipRecovery) {
      await db.recoverInterruptedTasks(recoverStaleAfterSeconds);
    }
    const task = taskId
      ? await db.claimTask(taskId)
      : await db.claimNextTask();
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
    const estimatedDurationSeconds =
      Number(task.metadata?.estimated_duration_seconds) || 300;
    const remainingDurationSeconds = Math.max(
      60,
      Math.ceil(
        estimatedDurationSeconds * (1 - Math.min(Number(task.progress || 0), 90) / 100)
      )
    );
    const runningMetadata = {
      ...(task.metadata || {}),
      estimated_duration_seconds: estimatedDurationSeconds,
      estimated_completion_at: new Date(
        Date.now() + remainingDurationSeconds * 1000
      ).toISOString(),
      resume_pending: false,
      started_at: task.metadata?.started_at || new Date().toISOString(),
      resumed_at: task.metadata?.resume_pending
        ? new Date().toISOString()
        : task.metadata?.resumed_at
    };
    const started = await saveStage(db, task.id, {
      stage: STAGES.RESEARCHING,
      progress: Math.max(10, Number(task.progress || 0)),
      activity: task.metadata?.resume_pending
        ? `Resuming from ${task.metadata?.current_stage || STAGES.RESEARCHING}`
        : "Researching the objective",
      checkpointIteration: Number(task.metadata?.checkpoint_iteration || 0),
      extraMetadata: runningMetadata
    });
    await db.updateTask(task.id, { steps });
    await sendProgressStatus(notify, started.task, STAGES.RESEARCHING);
    await db.updateTask(task.id, {
      metadata: {
        ...(started.task.metadata || {}),
        last_status_sent_at: new Date().toISOString()
      }
    });

    const heartbeatDelay = allowFastStatusInterval
      ? statusIntervalMs
      : Math.max(30000, Math.min(statusIntervalMs, 60000));
    heartbeatTimer = setInterval(() => {
      void (async () => {
        try {
          const current = await db.getTask(task.id);
          if (current?.status !== "running") {
            return;
          }
          await sendProgressStatus(notify, current);
          await db.updateTask(task.id, {
            metadata: {
              ...(current.metadata || {}),
              last_status_sent_at: new Date().toISOString()
            }
          });
        } catch (error) {
          console.error(`Task ${task.id} heartbeat failed`, error);
        }
      })();
    }, heartbeatDelay);
    heartbeatTimer.unref?.();

    const result = await runner(task, {
      db,
      llmClient,
      fetchImpl,
      onProgress: async ({
        progress,
        message,
        checkpointIteration,
        latestResult,
        stage: requestedStage
      }) => {
        const stage = requestedStage || stageForProgress(progress);
        const currentTask = await db.getTask(task.id);
        const estimatedDuration = Number(
          currentTask?.metadata?.estimated_duration_seconds ||
            estimatedDurationSeconds
        );
        const remainingSeconds = Math.max(
          60,
          Math.ceil(
            estimatedDuration *
              (1 - Math.min(Number(progress || 0), 95) / 100)
          )
        );
        const updated = await saveStage(db, task.id, {
          stage,
          progress,
          activity: message,
          checkpointIteration,
          extraMetadata: {
            current_step: message,
            progress_percentage: Number(progress || 0),
            eta_seconds: remainingSeconds,
            estimated_completion_at: new Date(
              Date.now() + remainingSeconds * 1000
            ).toISOString(),
            ...(latestResult !== undefined
              ? { latest_result: latestResult }
              : {})
          }
        });
        if (updated.stageChanged) {
          await sendProgressStatus(notify, updated.task, stage);
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
      await notify(task.chat_id, "Task stopped.");
      return db.getTask(task.id);
    }

    const verifying = await saveStage(db, task.id, {
      stage: STAGES.VERIFYING,
      progress: Math.max(75, Number(current?.progress || 0)),
      activity: "Verifying collected results",
      checkpointIteration: Number(current?.metadata?.checkpoint_iteration || 0)
    });
    if (verifying.stageChanged) {
      await sendProgressStatus(notify, verifying.task, STAGES.VERIFYING);
    }

    const compiling = await saveStage(db, task.id, {
      stage: STAGES.COMPILING,
      progress: Math.max(90, Number(verifying.task?.progress || 0)),
      activity: "Compiling the final report",
      checkpointIteration: Number(
        verifying.task?.metadata?.checkpoint_iteration || 0
      )
    });
    if (compiling.stageChanged) {
      await sendProgressStatus(notify, compiling.task, STAGES.COMPILING);
    }

    steps[1].status = "completed";
    steps[2].status = "completed";
    steps[3].status = "completed";
    const completed = await db.updateTask(task.id, {
      status: "completed",
      progress: 100,
      steps,
      result,
      metadata: {
        ...(compiling.task?.metadata || runningMetadata),
        current_stage: STAGES.COMPLETED,
        current_activity: "Completed",
        completed_at: new Date().toISOString(),
        stage_history: [
          ...(compiling.task?.metadata?.stage_history || []),
          {
            stage: STAGES.COMPLETED,
            progress: 100,
            activity: "Completed",
            created_at: new Date().toISOString()
          }
        ]
      }
    });
    const entities = await db.listEntities(task.id);
    await sendProgressStatus(notify, completed, STAGES.COMPLETED);
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
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
    }
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
      await (options.db || getDatabase()).recoverInterruptedTasks(
        Number(process.env.LILY_TASK_STALE_AFTER_SECONDS || 90)
      );
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
