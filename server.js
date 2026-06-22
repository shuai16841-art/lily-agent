import "dotenv/config";
import express from "express";
import { getDatabase } from "./lib/db.js";
import { runLilyTask, sendJson } from "./lib/lily.js";
import { startQueueWorker } from "./lib/queue.js";

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json({ limit: "1mb" }));

await getDatabase().initialize();
if (process.env.LILY_DISABLE_WORKER !== "true") {
  startQueueWorker();
}

app.get("/", (req, res) => {
  res.json({
    name: "lily-agent",
    status: "ok",
    usage: "POST /lily with JSON body: { \"task\": \"...\" }"
  });
});

app.post("/lily", async (req, res) => {
  try {
    const result = await runLilyTask(req.body?.task);

    if (result?.action === "EMAIL_SENT") {
      return sendJson(res, 200, result);
    }

    sendJson(res, 200, {
      ok: true,
      result
    });
  } catch (error) {
    sendJson(res, error.statusCode || 500, {
      ok: false,
      error: error.message || "Unexpected server error"
    });
  }
});

app.listen(port, () => {
  console.log(`Lily agent is listening on http://localhost:${port}`);
});
