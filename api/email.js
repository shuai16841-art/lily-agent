import { sendEmail } from "../lib/email.js";
import { sendJson } from "../lib/lily.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return sendJson(res, 405, {
      ok: false,
      error: "Method not allowed. Use POST /api/email."
    });
  }

  try {
    const result = await sendEmail(req);
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
