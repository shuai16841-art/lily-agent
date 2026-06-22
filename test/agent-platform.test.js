import assert from "node:assert/strict";
import test from "node:test";
import { createClient } from "@libsql/client";

import { LilyDatabase } from "../lib/db.js";
import { processNextTask } from "../lib/queue.js";
import { shouldRunInBackground } from "../lib/task-service.js";
import { processTelegramUpdate } from "../api/telegram.js";

async function memoryDb() {
  const db = new LilyDatabase(createClient({ url: ":memory:" }));
  await db.initialize();
  return db;
}

test("SQLite task queue stores tasks, entities, and final result", async () => {
  const db = await memoryDb();
  const task = await db.createTask({
    userId: "john",
    chatId: "42",
    objective: "Find 5 buyers and 5 factories"
  });
  const notifications = [];

  await processNextTask({
    db,
    notify: async (chatId, text) => notifications.push({ chatId, text }),
    runner: async (claimed, { db: taskDb }) => {
      await taskDb.saveEntities(claimed.id, "buyer", [
        { company: "Buyer One", website: "https://buyer.example" }
      ]);
      await taskDb.saveEntities(claimed.id, "factory", [
        { company: "Factory One", website: "https://factory.example" }
      ]);
      return {
        summary: "Research complete.",
        buyers: [],
        factories: [],
        notes: []
      };
    }
  });

  const completed = await db.getTask(task.id);
  const entities = await db.listEntities(task.id);
  assert.equal(completed.status, "completed");
  assert.equal(completed.progress, 100);
  assert.equal(entities.length, 2);
  assert.match(notifications.at(-1).text, /Task completed/);
});

test("research commands are recognized as background work", () => {
  assert.equal(
    shouldRunInBackground("Find 20 buyers and 10 factories"),
    true
  );
  assert.equal(shouldRunInBackground("How are you?"), false);
});

test("Telegram creates a background task and acknowledges immediately", async () => {
  const db = await memoryDb();
  const sent = [];
  const result = await processTelegramUpdate(
    {
      update_id: 7001,
      message: {
        from: { id: 100 },
        chat: { id: 100 },
        text: "Find 20 buyers and 10 factories"
      }
    },
    {
      db,
      token: "test-token",
      fetchImpl: async (url, request) => {
        sent.push(JSON.parse(request.body).text);
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true })
        };
      }
    }
  );

  assert.equal(result.ok, true);
  assert.ok(result.taskId);
  assert.match(sent[0], /background task/);
  assert.equal((await db.getTask(result.taskId)).status, "queued");
});

test("Telegram /status and /stop manage the latest task", async () => {
  const db = await memoryDb();
  const task = await db.createTask({
    userId: "100",
    chatId: "100",
    objective: "Find buyers"
  });
  const replies = [];
  const fetchImpl = async (url, request) => {
    replies.push(JSON.parse(request.body).text);
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true })
    };
  };

  await processTelegramUpdate(
    {
      update_id: 7002,
      message: { from: { id: 100 }, chat: { id: 100 }, text: "/status" }
    },
    { db, token: "test-token", fetchImpl }
  );
  await processTelegramUpdate(
    {
      update_id: 7003,
      message: { from: { id: 100 }, chat: { id: 100 }, text: `/stop ${task.id.slice(0, 8)}` }
    },
    { db, token: "test-token", fetchImpl }
  );

  assert.match(replies[0], /queued/);
  assert.match(replies[1], /stopped/);
  assert.equal((await db.getTask(task.id)).status, "stopped");
});

test("Telegram /help, /tasks, /report, and /approve are available", async () => {
  const db = await memoryDb();
  const task = await db.createTask({
    userId: "100",
    chatId: "100",
    objective: "Build a report"
  });
  await db.updateTask(task.id, {
    status: "completed",
    progress: 100,
    result: { summary: "Report ready.", notes: [] }
  });
  const replies = [];
  const fetchImpl = async (url, request) => {
    replies.push(JSON.parse(request.body).text);
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true })
    };
  };
  let updateId = 7100;
  for (const text of ["/help", "/tasks", "/report"]) {
    await processTelegramUpdate(
      {
        update_id: updateId++,
        message: { from: { id: 100 }, chat: { id: 100 }, text }
      },
      { db, token: "test-token", fetchImpl }
    );
  }
  await processTelegramUpdate(
    {
      update_id: updateId,
      message: { from: { id: 100 }, chat: { id: 100 }, text: "/approve draft-1" }
    },
    {
      db,
      token: "test-token",
      fetchImpl,
      approveDraft: async () => ({
        recipient: "buyer@example.com",
        subject: "Hello"
      })
    }
  );

  assert.match(replies[0], /\/status/);
  assert.match(replies[1], /completed/);
  assert.match(replies[2], /Report ready/);
  assert.match(replies[3], /Email sent/);
});

test("Telegram remember command stores user instructions", async () => {
  const db = await memoryDb();
  const replies = [];
  await processTelegramUpdate(
    {
      update_id: 7200,
      message: {
        from: { id: 100 },
        chat: { id: 100 },
        text: "remember: always verify company websites"
      }
    },
    {
      db,
      token: "test-token",
      fetchImpl: async (url, request) => {
        replies.push(JSON.parse(request.body).text);
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true })
        };
      }
    }
  );

  const memories = await db.getMemories("100");
  assert.equal(memories.length, 1);
  assert.equal(memories[0].value, "always verify company websites");
  assert.match(replies[0], /saved/);
});

test("explicit email command creates a draft and does not send", async () => {
  const db = await memoryDb();
  const replies = [];
  let draftCount = 0;
  const result = await processTelegramUpdate(
    {
      update_id: 7004,
      message: {
        from: { id: 100 },
        chat: { id: 100 },
        text: "Send an email to buyer@example.com saying hello"
      }
    },
    {
      db,
      token: "test-token",
      createDraft: async ({ userId, chatId, emailTask, db: taskDb }) => {
        draftCount += 1;
        return taskDb.createEmailDraft({
          userId,
          chatId,
          recipient: emailTask.to,
          subject: emailTask.subject,
          body: emailTask.body
        });
      },
      fetchImpl: async (url, request) => {
        replies.push(JSON.parse(request.body).text);
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true })
        };
      }
    }
  );

  assert.equal(result.ok, true);
  assert.equal(draftCount, 1);
  assert.match(replies[0], /Nothing has been sent/);
  assert.match(replies[0], /\/approve/);
});
