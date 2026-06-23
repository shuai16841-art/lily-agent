import { runScheduledWorkerCycle } from "../lib/queue.js";
import { sendJson } from "../lib/lily.js";
import { logger } from "../lib/logger.js";

export const config = {
  maxDuration: 300
};

export function isAuthorizedWorkerRequest(req, env = process.env) {
  const actual = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const acceptedSecrets = [env.CRON_SECRET, env.LILY_WORKER_SECRET].filter(Boolean);
  return acceptedSecrets.length > 0 && acceptedSecrets.includes(actual);
}

export default async function handler(req, res) {
  if (req.method !== "POST" && req.method !== "GET") {
    res.setHeader("Allow", "GET, POST");
    return sendJson(res, 405, {
      ok: false,
      error: "Method not allowed."
    });
  }

  if (!isAuthorizedWorkerRequest(req)) {
    return sendJson(res, 401, {
      ok: false,
      error: "Unauthorized worker request."
    });
  }

  try {
    const cycle = await runScheduledWorkerCycle();
    return sendJson(res, 200, {
      ok: true,
      ...cycle
    });
  } catch (error) {
    logger.error("[Scheduled worker] Failed", error);
    return sendJson(res, 500, {
      ok: false,
      error: error.message || "Worker failed"
    });
  }
}
