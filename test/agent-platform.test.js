import assert from "node:assert/strict";
import test from "node:test";
import { createClient } from "@libsql/client";

import { LilyDatabase, resolveDatabaseConfig } from "../lib/db.js";
import { processNextTask } from "../lib/queue.js";
import {
  estimateTaskDurationSeconds,
  formatProgressStatus,
  formatTaskEta,
  shouldRunInBackground
} from "../lib/task-service.js";
import { processTelegramUpdate } from "../api/telegram.js";

async function memoryDb() {
  const db = new LilyDatabase(createClient({ url: ":memory:" }));
  await db.initialize();
  return db;
}

async function ephemeralServerlessDb() {
  const db = new LilyDatabase(createClient({ url: ":memory:" }), {
    storageMode: "memory",
    persistent: false,
    warning: "Turso is not configured."
  });
  await db.initialize();
  return db;
}

test("missing Turso variables use a safe serverless memory fallback", () => {
  const config = resolveDatabaseConfig({
    VERCEL: "1"
  });

  assert.deepEqual(config.client, { url: ":memory:" });
  assert.equal(config.storageMode, "memory");
  assert.equal(config.persistent, false);
  assert.match(config.warning, /Turso is not fully configured/);
});

test("partially configured Turso also uses the safe serverless fallback", () => {
  const missingToken = resolveDatabaseConfig({
    VERCEL: "1",
    TURSO_DATABASE_URL: "libsql://example.turso.io"
  });
  const missingUrl = resolveDatabaseConfig({
    VERCEL: "1",
    TURSO_AUTH_TOKEN: "token"
  });

  assert.equal(missingToken.persistent, false);
  assert.match(missingToken.warning, /TURSO_AUTH_TOKEN missing/);
  assert.equal(missingUrl.persistent, false);
  assert.match(missingUrl.warning, /TURSO_DATABASE_URL missing/);
});

test("/status and /tasks return setup guidance without a production database", async () => {
  const db = await ephemeralServerlessDb();
  const replies = [];
  const fetchImpl = async (url, request) => {
    replies.push(JSON.parse(request.body).text);
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true })
    };
  };

  for (const [index, text] of ["/status", "/tasks"].entries()) {
    const result = await processTelegramUpdate(
      {
        update_id: 6000 + index,
        message: {
          from: { id: 100 },
          chat: { id: 100 },
          text
        }
      },
      {
        db,
        token: "test-token",
        fetchImpl
      }
    );
    assert.equal(result.ok, true);
  }

  assert.equal(replies.length, 2);
  assert.match(replies[0], /TURSO_DATABASE_URL/);
  assert.match(replies[1], /TURSO_AUTH_TOKEN/);
});

test("normal Telegram replies still work with the serverless memory fallback", async () => {
  const db = await ephemeralServerlessDb();
  const replies = [];
  const result = await processTelegramUpdate(
    {
      update_id: 6100,
      message: {
        from: { id: 100 },
        chat: { id: 100 },
        text: "Hello"
      }
    },
    {
      db,
      token: "test-token",
      runTask: async () => ({
        intent: "CASUAL",
        response: "Hello John."
      }),
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
  assert.deepEqual(replies, ["Hello John."]);
});

test("background requests explain that Turso is required instead of crashing", async () => {
  const db = await ephemeralServerlessDb();
  const replies = [];
  const result = await processTelegramUpdate(
    {
      update_id: 6200,
      message: {
        from: { id: 100 },
        chat: { id: 100 },
        text: "Find 5 buyers and 5 factories"
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

  assert.equal(result.ok, true);
  assert.equal(result.databaseConfigured, false);
  assert.match(replies[0], /Turso/);
});

test("database deduplication errors are logged and do not abort Telegram", async () => {
  const replies = [];
  const logged = [];
  const originalError = console.error;
  console.error = (...args) => logged.push(args.map(String).join(" "));

  try {
    const result = await processTelegramUpdate(
      {
        update_id: 6300,
        message: {
          from: { id: 100 },
          chat: { id: 100 },
          text: "Hello"
        }
      },
      {
        db: {
          markUpdateProcessed: async () => {
            throw new Error("database offline");
          }
        },
        token: "test-token",
        runTask: async () => ({
          intent: "CASUAL",
          response: "Hello John."
        }),
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
    assert.deepEqual(replies, ["Hello John."]);
    assert.match(logged.join("\n"), /database offline/);
  } finally {
    console.error = originalError;
  }
});

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

test("task estimates scale with requested research volume", () => {
  const small = estimateTaskDurationSeconds("Find 5 buyers and 5 factories");
  const large = estimateTaskDurationSeconds("Find 20 buyers and 10 factories");
  assert.equal(small, 260);
  assert.equal(large, 660);
  assert.match(
    formatTaskEta({
      status: "queued",
      metadata: {
        estimated_duration_seconds: small
      }
    }),
    /about 5 minutes/
  );
});

test("progress status uses the required Task ID format", () => {
  assert.equal(
    formatProgressStatus("12345678-abcd", "Researching...", "about 4 minutes", 25),
    [
      "[Task ID: 12345678]",
      "Status: Researching...",
      "Progress: 25%",
      "ETA: about 4 minutes"
    ].join("\n")
  );
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
  assert.match(sent[0], /\[Task ID: [a-f0-9]{8}\]/);
  assert.match(sent[0], /Status: Received/);
  assert.match(sent[0], /Progress: 0%/);
  assert.match(sent[0], /ETA: about 11 minutes/);
  const storedTask = await db.getTask(result.taskId);
  assert.equal(storedTask.status, "queued");
  assert.equal(storedTask.metadata.estimated_duration_seconds, 660);
  assert.equal(storedTask.metadata.current_activity, "Waiting for a worker");
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
  assert.match(replies[0], /\[Task ID: [a-f0-9]{8}\]/);
  assert.match(replies[0], /Status: queued/);
  assert.match(replies[0], /Progress: 0%/);
  assert.match(replies[1], /stopped/);
  assert.equal((await db.getTask(task.id)).status, "stopped");
});

test("worker sends start ETA and milestone progress updates", async () => {
  const db = await memoryDb();
  const task = await db.createTask({
    userId: "john",
    chatId: "42",
    objective: "Find 5 buyers",
    metadata: {
      estimated_duration_seconds: 240,
      current_activity: "Waiting for a worker"
    }
  });
  const notifications = [];

  await processNextTask({
    db,
    notify: async (chatId, text) => notifications.push(text),
    statusIntervalMs: 10,
    allowFastStatusInterval: true,
    runner: async (claimed, { onProgress }) => {
      await onProgress({ progress: 30, message: "Searching buyer directories" });
      await new Promise((resolve) => setTimeout(resolve, 25));
      await onProgress({ progress: 55, message: "Verifying company contacts" });
      await onProgress({ progress: 80, message: "Preparing the report" });
      return {
        summary: "Done.",
        buyers: [],
        factories: [],
        notes: []
      };
    }
  });

  assert.match(notifications[0], /Status: Researching\.\.\./);
  assert.ok(
    notifications.filter((message) => /Status: Researching\.\.\./.test(message))
      .length >= 2
  );
  assert.ok(
    notifications.some((message) => /Status: Verifying leads\.\.\./.test(message))
  );
  assert.ok(
    notifications.some((message) =>
      /Status: Compiling final report\.\.\./.test(message)
    )
  );
  assert.ok(
    notifications.some((message) => /Status: Completed/.test(message))
  );
  const completed = await db.getTask(task.id);
  assert.equal(completed.metadata.current_activity, "Completed");
  assert.equal(completed.progress, 100);
  assert.deepEqual(
    completed.metadata.stage_history.map((item) => item.stage),
    [
      "Researching...",
      "Verifying leads...",
      "Compiling final report...",
      "Completed"
    ]
  );
});

test("interrupted running tasks resume from the persisted checkpoint", async () => {
  const db = await memoryDb();
  const task = await db.createTask({
    userId: "john",
    chatId: "42",
    objective: "Find buyers",
    metadata: {
      current_stage: "Verifying leads...",
      current_activity: "Checking contact details",
      checkpoint_iteration: 4,
      stage_history: [
        {
          stage: "Received",
          progress: 0,
          activity: "Waiting",
          created_at: "2026-01-01T00:00:00.000Z"
        },
        {
          stage: "Verifying leads...",
          progress: 55,
          activity: "Checking contact details",
          created_at: "2026-01-01T00:01:00.000Z"
        }
      ]
    }
  });
  await db.client.execute({
    sql: `UPDATE tasks SET status = 'running', progress = 55, updated_at = ?
      WHERE id = ?`,
    args: ["2026-01-01T00:02:00.000Z", task.id]
  });
  await db.saveEntities(task.id, "buyer", [
    { company: "Saved Buyer", website: "https://saved.example" }
  ]);
  let resumedTask;

  await processNextTask({
    db,
    recoverStaleAfterSeconds: 1,
    notify: async () => {},
    runner: async (claimed) => {
      resumedTask = claimed;
      return {
        summary: "Resumed and completed.",
        buyers: [],
        factories: [],
        notes: []
      };
    }
  });

  assert.equal(resumedTask.metadata.resume_pending, true);
  assert.equal(resumedTask.metadata.checkpoint_iteration, 4);
  assert.equal(resumedTask.progress, 55);
  const completed = await db.getTask(task.id);
  assert.equal(completed.status, "completed");
  assert.equal(completed.metadata.recovery_count, 1);
  assert.ok(completed.metadata.resumed_at);
  assert.equal((await db.listEntities(task.id)).length, 1);
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
