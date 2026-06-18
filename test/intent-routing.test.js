import assert from "node:assert/strict";
import test from "node:test";

import { classifyTaskIntent, lilySystemPrompt, runLilyTask } from "../lib/lily.js";
import { formatLilyResult, processTelegramUpdate } from "../api/telegram.js";

test("email capability question answers without sending", async () => {
  let sendCount = 0;
  const result = await runLilyTask(
    "\u4f60\u80fd\u7528\u6211\u7684\u90ae\u7bb1\u7ed9\u6211\u53d1\u90ae\u4ef6\u5417\uff1f",
    null,
    {
      sendEmailImpl: async () => {
        sendCount += 1;
      }
    }
  );

  assert.equal(result.intent, "QUESTION");
  assert.equal(result.action, "CONVERSATIONAL_RESPONSE");
  assert.match(result.message, /\u53ef\u4ee5/);
  assert.equal(sendCount, 0);
});

test("email correction apologizes without sending", async () => {
  let sendCount = 0;
  const result = await runLilyTask(
    "\u6211\u73b0\u5728\u662f\u5728\u95ee\u4f60\uff0c\u6ca1\u8ba9\u4f60\u53d1\u90ae\u4ef6",
    null,
    {
      sendEmailImpl: async () => {
        sendCount += 1;
      }
    }
  );

  assert.equal(result.intent, "CLARIFICATION");
  assert.equal(result.action, "CONVERSATIONAL_RESPONSE");
  assert.match(result.message, /\u62b1\u6b49/);
  assert.equal(sendCount, 0);
});

test("incomplete email command asks one clarifying question", async () => {
  let sendCount = 0;
  const result = await runLilyTask("\u53d1\u90ae\u4ef6\u7ed9\u6211", null, {
    sendEmailImpl: async () => {
      sendCount += 1;
    }
  });

  assert.equal(result.action, "EMAIL_CLARIFICATION");
  assert.equal(result.intent, "TOOL_ACTION");
  assert.deepEqual(result.missing, ["recipient", "subject", "body"]);
  assert.match(result.message, /\u6536\u4ef6\u4eba\u90ae\u7bb1/);
  assert.match(result.message, /\u4e3b\u9898/);
  assert.match(result.message, /\u6b63\u6587/);
  assert.equal((result.message.match(/\uff1f|\?/g) || []).length <= 1, true);
  assert.equal(sendCount, 0);
});

test("complete explicit email command executes EMAIL_SEND", async () => {
  const sent = [];
  const result = await runLilyTask(
    "Send an email to abc@example.com saying hello",
    null,
    {
      sendEmailImpl: async (request) => {
        sent.push(request.body);
        return { id: "email-123" };
      }
    }
  );

  assert.equal(result.action, "EMAIL_SENT");
  assert.equal(result.intent, "TOOL_ACTION");
  assert.deepEqual(sent, [
    {
      to: "abc@example.com",
      subject: "hello",
      text: "hello"
    }
  ]);
});

test("non-send email wording is a command without tool execution", () => {
  assert.deepEqual(classifyTaskIntent("Write an outreach email for a repair shop"), {
    intent: "COMMAND",
    action: "RESPOND"
  });
});

test("classifier covers all five Telegram intent categories", () => {
  assert.equal(classifyTaskIntent("What can you help me with?").intent, "QUESTION");
  assert.equal(classifyTaskIntent("Find five auto repair leads").intent, "COMMAND");
  assert.equal(
    classifyTaskIntent("Send an email to abc@example.com saying hello").intent,
    "TOOL_ACTION"
  );
  assert.equal(classifyTaskIntent("Actually, I meant repair shops").intent, "CLARIFICATION");
  assert.equal(classifyTaskIntent("Hello").intent, "CASUAL");
});

test("complete email details inside a capability question do not execute", async () => {
  let sendCount = 0;
  const result = await runLilyTask(
    "Can you send an email to abc@example.com saying hello?",
    null,
    {
      sendEmailImpl: async () => {
        sendCount += 1;
      }
    }
  );

  assert.equal(result.intent, "QUESTION");
  assert.equal(result.action, "CONVERSATIONAL_RESPONSE");
  assert.equal(sendCount, 0);
});

test("general questions use the conversational response field", async () => {
  const messages = [];
  const client = {
    chat: {
      completions: {
        create: async (request) => {
          messages.push(...request.messages);
          return {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    intent: "QUESTION",
                    response: "I can help with sourcing, leads, outreach, and email drafting.",
                    task: "What can you help me with?",
                    summary: "",
                    leads: [],
                    notes: []
                  })
                }
              }
            ]
          };
        }
      }
    }
  };

  const result = await runLilyTask("What can you help me with?", client);
  assert.equal(result.intent, "QUESTION");
  assert.match(result.response, /sourcing/);
  assert.equal(
    messages[0].content.startsWith(
      "You are Lily, John's execution assistant. First understand intent"
    ),
    true
  );
});

test("system prompt contains the external-action safety instruction", () => {
  assert.match(
    lilySystemPrompt,
    /Never execute external actions unless the user clearly asks you to do so\./
  );
});

test("Telegram formats clarification as human-readable text", () => {
  const text = formatLilyResult({
    action: "EMAIL_CLARIFICATION",
    message: "\u8bf7\u63d0\u4f9b\u6536\u4ef6\u4eba\u90ae\u7bb1\u3001\u4e3b\u9898\u548c\u6b63\u6587\u3002"
  });

  assert.equal(text, "\u8bf7\u63d0\u4f9b\u6536\u4ef6\u4eba\u90ae\u7bb1\u3001\u4e3b\u9898\u548c\u6b63\u6587\u3002");
  assert.equal(text.includes('"action"'), false);
});

test("Telegram formats conversational model answers without task boilerplate", () => {
  const text = formatLilyResult({
    intent: "QUESTION",
    response: "Yes. I can help you draft an email, and I will only send it when you explicitly ask."
  });

  assert.equal(
    text,
    "Yes. I can help you draft an email, and I will only send it when you explicitly ask."
  );
});

test("duplicate Telegram update_id is processed only once", async () => {
  const updateCache = new Map();
  const sent = [];
  let taskCount = 0;
  const update = {
    update_id: 987654,
    message: {
      chat: { id: 42 },
      text: "Find two leads"
    }
  };
  const options = {
    token: "test-token",
    updateCache,
    runTask: async () => {
      taskCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { summary: "Done", leads: [] };
    },
    fetchImpl: async (url, request) => {
      sent.push({ url, body: JSON.parse(request.body) });
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true })
      };
    }
  };

  const [first, duplicate] = await Promise.all([
    processTelegramUpdate(update, options),
    processTelegramUpdate(update, options)
  ]);

  assert.equal(first.ok, true);
  assert.equal(first.intent, "COMMAND");
  assert.equal(duplicate.duplicate, true);
  assert.equal(taskCount, 1);
  assert.equal(sent.length, 1);
});
