import { Resend } from "resend";

function requireEnv(name) {
  const value = process.env[name];

  if (!value) {
    const error = new Error(`${name} is required`);
    error.statusCode = 500;
    throw error;
  }

  return value;
}

function assertEmailSecret(req) {
  const expected = requireEnv("EMAIL_SEND_SECRET");
  const actual = req.headers["x-lily-email-secret"];

  if (!actual || actual !== expected) {
    const error = new Error("Unauthorized email request");
    error.statusCode = 401;
    throw error;
  }
}

function validateEmailPayload({ to, subject, text, html }) {
  if (!to || typeof to !== "string") {
    const error = new Error("to is required");
    error.statusCode = 400;
    throw error;
  }

  if (!subject || typeof subject !== "string") {
    const error = new Error("subject is required");
    error.statusCode = 400;
    throw error;
  }

  if ((!text || typeof text !== "string") && (!html || typeof html !== "string")) {
    const error = new Error("text or html is required");
    error.statusCode = 400;
    throw error;
  }
}

export async function sendEmail(req) {
  assertEmailSecret(req);

  const { to, subject, text, html } = req.body || {};
  validateEmailPayload({ to, subject, text, html });

  const resend = new Resend(requireEnv("RESEND_API_KEY"));

  const { data, error } = await resend.emails.send({
    from: requireEnv("RESEND_FROM"),
    to: [to],
    subject,
    text,
    html
  });

  if (error) {
    const sendError = new Error(error.message || "Resend email failed");
    sendError.statusCode = 502;
    throw sendError;
  }

  return data;
}
