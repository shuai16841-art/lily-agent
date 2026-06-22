import { waitUntil } from "@vercel/functions";
import { runScheduledWorkerCycle } from "./queue.js";

export function triggerBackgroundWorker({
  taskId,
  runWorker = runScheduledWorkerCycle,
  waitUntilImpl = waitUntil
} = {}) {
  const workerJob = Promise.resolve()
    .then(() => runWorker({ taskId }))
    .catch((error) => {
      console.error("[Worker trigger] Background execution failed:", error);
    });

  waitUntilImpl(workerJob);
  return true;
}
