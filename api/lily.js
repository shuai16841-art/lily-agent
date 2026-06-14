import { runLilyTask, sendJson } from "../lib/lily.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return sendJson(res, 405, {
      ok: false,
      error: "Method not allowed. Use POST /api/lily."
    });
  }

  try {
    const result = await runLilyTask(req.body?.task);
    return sendJson(res, 200, {
      ok: true,
      result
    });
  } catch (error) {
    return sendJson(res, error.statusCode || 500, {
      ok: false,
      error: error.message || "Unexpected server error"
    });
  }
}
