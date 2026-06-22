import { processNextTask } from "../lib/queue.js";
import { sendJson } from "../lib/lily.js";

export const config = {
  maxDuration: 300
};

export default async function handler(req, res) {
  if (req.method !== "POST" && req.method !== "GET") {
    res.setHeader("Allow", "GET, POST");
    return sendJson(res, 405, {
      ok: false,
      error: "Method not allowed."
    });
  }

  const expected = process.env.LILY_WORKER_SECRET || process.env.CRON_SECRET;
  const actual = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!expected || actual !== expected) {
    return sendJson(res, 401, {
      ok: false,
      error: "Unauthorized worker request."
    });
  }

  try {
    const task = await processNextTask();
    return sendJson(res, 200, {
      ok: true,
      processed: Boolean(task),
      task
    });
  } catch (error) {
    return sendJson(res, 500, {
      ok: false,
      error: error.message || "Worker failed"
    });
  }
}
