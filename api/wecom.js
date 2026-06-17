import crypto from "node:crypto";

function sendJson(res, statusCode, body) {
  res.status(statusCode);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  return res.end(JSON.stringify(body));
}

function getQueryValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function createSignature(token, timestamp, nonce, encryptedText) {
  return crypto
    .createHash("sha1")
    .update([token, timestamp, nonce, encryptedText].sort().join(""))
    .digest("hex");
}

function decryptEchoStr(encryptedEchoStr, encodingAesKey, corpId) {
  if (encodingAesKey.length !== 43) {
    throw new Error("WECOM_ENCODING_AES_KEY must be exactly 43 characters.");
  }

  const aesKey = Buffer.from(`${encodingAesKey}=`, "base64");
  if (aesKey.length !== 32) {
    throw new Error("WECOM_ENCODING_AES_KEY is not a valid WeCom AES key.");
  }

  const decipher = crypto.createDecipheriv("aes-256-cbc", aesKey, aesKey.subarray(0, 16));
  decipher.setAutoPadding(false);

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedEchoStr, "base64")),
    decipher.final()
  ]);

  const padLength = decrypted[decrypted.length - 1];
  if (padLength < 1 || padLength > 32) {
    throw new Error("WeCom returned invalid PKCS#7 padding.");
  }

  const unpadded = decrypted.subarray(0, decrypted.length - padLength);
  if (unpadded.length < 20) {
    throw new Error("The decrypted WeCom payload is too short.");
  }

  const messageLength = unpadded.readUInt32BE(16);
  const messageStart = 20;
  const messageEnd = messageStart + messageLength;
  if (messageEnd > unpadded.length) {
    throw new Error("The decrypted WeCom payload has an invalid message length.");
  }

  const echoStr = unpadded.subarray(messageStart, messageEnd).toString("utf8");
  const receiverId = unpadded.subarray(messageEnd).toString("utf8");

  if (receiverId !== corpId) {
    throw new Error("The decrypted receiver ID does not match WECOM_CORP_ID.");
  }

  return echoStr;
}

function handleVerification(req, res) {
  const token = process.env.WECOM_TOKEN;
  const encodingAesKey = process.env.WECOM_ENCODING_AES_KEY;
  const corpId = process.env.WECOM_CORP_ID;

  if (!token || !encodingAesKey || !corpId) {
    return sendJson(res, 500, {
      ok: false,
      error:
        "WeCom verification is not configured. Set WECOM_TOKEN, WECOM_ENCODING_AES_KEY, and WECOM_CORP_ID in Vercel."
    });
  }

  const msgSignature = getQueryValue(req.query?.msg_signature);
  const timestamp = getQueryValue(req.query?.timestamp);
  const nonce = getQueryValue(req.query?.nonce);
  const encryptedEchoStr = getQueryValue(req.query?.echostr);

  if (!msgSignature || !timestamp || !nonce || !encryptedEchoStr) {
    return sendJson(res, 400, {
      ok: false,
      error: "Missing required query parameters: msg_signature, timestamp, nonce, and echostr."
    });
  }

  const expectedSignature = createSignature(token, timestamp, nonce, encryptedEchoStr);
  const provided = Buffer.from(msgSignature, "utf8");
  const expected = Buffer.from(expectedSignature, "utf8");

  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    return sendJson(res, 401, {
      ok: false,
      error: "Invalid WeCom message signature."
    });
  }

  try {
    const decryptedEchoStr = decryptEchoStr(encryptedEchoStr, encodingAesKey, corpId);
    res.status(200);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.end(decryptedEchoStr);
  } catch (error) {
    return sendJson(res, 400, {
      ok: false,
      error: `Unable to decrypt echostr: ${error.message}`
    });
  }
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return handleVerification(req, res);
  }

  if (req.method === "POST") {
    const missingVariables = [
      "WECOM_TOKEN",
      "WECOM_ENCODING_AES_KEY",
      "WECOM_CORP_ID",
      "WECOM_AGENT_ID",
      "WECOM_SECRET"
    ].filter((name) => !process.env[name]);

    if (missingVariables.length > 0) {
      return sendJson(res, 500, {
        ok: false,
        error: `WeCom message receiving is not configured. Missing: ${missingVariables.join(", ")}.`
      });
    }

    // TODO: Verify the POST signature, parse the encrypted XML body, decrypt it,
    // use WECOM_AGENT_ID/WECOM_SECRET as needed to call WeCom APIs, route the
    // user's message to Lily, and return an encrypted WeCom XML reply.
    return sendJson(res, 501, {
      ok: false,
      error: "WeCom message receiving is not implemented yet. URL verification is available via GET."
    });
  }

  res.setHeader("Allow", "GET, POST");
  return sendJson(res, 405, {
    ok: false,
    error: "Method not allowed. Use GET or POST /api/wecom."
  });
}
