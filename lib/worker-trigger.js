import { waitUntil } from "@vercel/functions";

function firstHeaderValue(value) {
  return String(value || "").split(",")[0].trim();
}

export function resolveWorkerUrl(req) {
  const protocol =
    firstHeaderValue(req?.headers?.["x-forwarded-proto"]) || "https";
  const host =
    firstHeaderValue(req?.headers?.["x-forwarded-host"]) ||
    firstHeaderValue(req?.headers?.host);
  return host ? `${protocol}://${host}/api/worker` : null;
}

export function triggerBackgroundWorker({
  req,
  secret = process.env.LILY_WORKER_SECRET,
  fetchImpl = fetch,
  waitUntilImpl = waitUntil
} = {}) {
  const workerUrl = resolveWorkerUrl(req);
  if (!secret) {
    console.error(
      "[Worker trigger] LILY_WORKER_SECRET is missing; the task remains queued."
    );
    return false;
  }
  if (!workerUrl) {
    console.error(
      "[Worker trigger] Could not determine the deployment host; the task remains queued."
    );
    return false;
  }

  const workerRequest = fetchImpl(workerUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ source: "telegram" })
  })
    .then(async (response) => {
      if (response.ok) {
        return;
      }
      const body = await response.text().catch(() => "");
      throw new Error(
        `Worker returned HTTP ${response.status}${body ? `: ${body}` : ""}`
      );
    })
    .catch((error) => {
      console.error("[Worker trigger] Background worker request failed:", error);
    });

  waitUntilImpl(workerRequest);
  return true;
}
