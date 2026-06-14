import "dotenv/config";
import qrcodeTerminal from "qrcode-terminal";
import { WechatyBuilder } from "wechaty";

const lilyApiUrl = process.env.LILY_API_URL || "http://localhost:3000/lily";
const allowedContacts = (process.env.WECHAT_ALLOWED_CONTACTS || "")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);

function isAllowedContact(contact) {
  if (allowedContacts.length === 0) {
    return true;
  }

  const name = contact.name();
  const alias = typeof contact.alias === "function" ? contact.alias() : "";

  return allowedContacts.includes(name) || allowedContacts.includes(alias);
}

function formatLilyReply(payload) {
  const result = payload.result || payload;
  const leads = Array.isArray(result.leads) ? result.leads : [];

  if (leads.length === 0) {
    return JSON.stringify(result, null, 2).slice(0, 3500);
  }

  const lines = [];

  if (result.summary) {
    lines.push(result.summary, "");
  }

  leads.forEach((lead, index) => {
    lines.push(`${index + 1}. ${lead.company_name || "Lead"}`);

    if (lead.website) {
      lines.push(`Website: ${lead.website}`);
    }

    if (lead.reason_good_lead) {
      lines.push(`Reason: ${lead.reason_good_lead}`);
    }

    if (lead.suggested_outreach_email) {
      lines.push(`Email: ${lead.suggested_outreach_email}`);
    }

    lines.push("");
  });

  if (Array.isArray(result.notes) && result.notes.length > 0) {
    lines.push("Notes:", ...result.notes.map((note) => `- ${note}`));
  }

  return lines.join("\n").trim().slice(0, 3500);
}

async function askLily(task) {
  const response = await fetch(lilyApiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ task })
  });

  const data = await response.json();

  if (!response.ok || data.ok === false) {
    throw new Error(data.error || "Lily API request failed");
  }

  return formatLilyReply(data);
}

const bot = WechatyBuilder.build({
  name: process.env.WECHATY_NAME || "lily-agent-wechat",
  puppet: process.env.WECHATY_PUPPET || "wechaty-puppet-service",
  puppetOptions: process.env.WECHATY_PUPPET_SERVICE_TOKEN
    ? {
        token: process.env.WECHATY_PUPPET_SERVICE_TOKEN
      }
    : undefined
});

bot
  .on("scan", (qrcode, status) => {
    console.log(`Scan QR Code to login: ${status}`);
    qrcodeTerminal.generate(qrcode, { small: true });
  })
  .on("login", (user) => {
    console.log(`Lily WeChat bot logged in as ${user.name()}`);
  })
  .on("logout", (user) => {
    console.log(`Lily WeChat bot logged out: ${user.name()}`);
  })
  .on("message", async (message) => {
    try {
      if (message.self()) {
        return;
      }

      const text = message.text().trim();
      const contact = message.talker();

      if (!text) {
        return;
      }

      if (!isAllowedContact(contact)) {
        console.log(`Ignored message from unauthorized contact: ${contact.name()}`);
        return;
      }

      await message.say("Lily received it. Working...");
      const reply = await askLily(text);
      await message.say(reply);
    } catch (error) {
      console.error(error);
      await message.say(`Lily error: ${error.message || "Unknown error"}`);
    }
  });

bot.start().catch((error) => {
  console.error("Failed to start Lily WeChat bot", error);
  process.exit(1);
});
