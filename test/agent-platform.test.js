import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createClient } from "@libsql/client";

import { LilyDatabase, resolveDatabaseConfig } from "../lib/db.js";
import {
  heartbeatRunningTasks,
  processNextTask,
  runScheduledWorkerCycle
} from "../lib/queue.js";
import {
  createBackgroundTask,
  estimateTaskDurationSeconds,
  formatProgressStatus,
  formatTaskEta,
  shouldRunInBackground
} from "../lib/task-service.js";
import { processTelegramUpdate } from "../api/telegram.js";
import {
  triggerBackgroundWorker
} from "../lib/worker-trigger.js";
import { isAuthorizedWorkerRequest } from "../api/worker.js";
import {
  getAgentToolDefinitions,
  taskRequestsGoogleSheets
} from "../lib/tools/registry.js";
import { appendGoogleSheetRows } from "../lib/tools/sheets.js";

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
  const scheduled = [];
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
      scheduleWorker: (details) => {
        scheduled.push(details);
        return true;
      },
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
  assert.equal(result.workerScheduled, true);
  assert.deepEqual(scheduled, [{ taskId: result.taskId }]);
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

test("scheduled heartbeat checks Turso-style running tasks and sends Telegram status", async () => {
  const db = await memoryDb();
  const task = await db.createTask({
    userId: "john",
    chatId: "42",
    objective: "Find buyers",
    metadata: {
      estimated_duration_seconds: 300,
      started_at: "2026-01-01T00:00:00.000Z",
      current_stage: "Researching...",
      current_activity: "Searching buyer directories",
      last_status_sent_at: "2026-01-01T00:00:00.000Z",
      stage_history: []
    }
  });
  await db.client.execute({
    sql: "UPDATE tasks SET status = 'running', progress = 20 WHERE id = ?",
    args: [task.id]
  });
  const notifications = [];
  const heartbeatTaskIds = await heartbeatRunningTasks({
    db,
    currentTime: Date.parse("2026-01-01T00:01:00.000Z"),
    heartbeatAfterSeconds: 45,
    notify: async (chatId, text) => notifications.push({ chatId, text })
  });

  assert.deepEqual(heartbeatTaskIds, [task.id]);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].text, /\[Task ID:/);
  assert.match(notifications[0].text, /Status: Researching\.\.\./);
  const updated = await db.getTask(task.id);
  assert.equal(
    updated.metadata.last_cron_heartbeat_at,
    "2026-01-01T00:01:00.000Z"
  );
});

test("scheduled worker cycle claims queued work and completes it", async () => {
  const db = await memoryDb();
  const task = await db.createTask({
    userId: "john",
    chatId: "42",
    objective: "Find buyers"
  });

  const cycle = await runScheduledWorkerCycle({
    db,
    notify: async () => {},
    runner: async () => ({
      summary: "Completed by scheduled worker.",
      buyers: [],
      factories: [],
      notes: []
    })
  });

  assert.equal(cycle.processedTaskId, task.id);
  assert.equal((await db.getTask(task.id)).status, "completed");
});

test("worker claims the exact Telegram task instead of an older queued task", async () => {
  const db = await memoryDb();
  const olderTask = await db.createTask({
    userId: "john",
    chatId: "42",
    objective: "Older queued task"
  });
  const requestedTask = await db.createTask({
    userId: "john",
    chatId: "42",
    objective: "Find 2 California auto repair shops that may buy jump starters."
  });

  const cycle = await runScheduledWorkerCycle({
    db,
    taskId: requestedTask.id,
    notify: async () => {},
    runner: async () => ({
      summary: "Requested task completed.",
      buyers: [],
      factories: [],
      notes: []
    })
  });

  assert.equal(cycle.processedTaskId, requestedTask.id);
  assert.equal((await db.getTask(requestedTask.id)).status, "completed");
  assert.equal((await db.getTask(olderTask.id)).status, "queued");
});

test("end-to-end research task calls live search and returns verified buyers", async () => {
  const originalTavilyKey = process.env.TAVILY_API_KEY;
  process.env.TAVILY_API_KEY = "test-tavily-key";
  const db = await memoryDb();
  const task = await createBackgroundTask({
    userId: "john",
    chatId: "42",
    objective:
      "Find 2 California auto repair shops that may buy jump starters.",
    db
  });
  const notifications = [];
  const searchRequests = [];
  let modelCall = 0;
  const llmClient = {
    chat: {
      completions: {
        create: async () => {
          modelCall += 1;
          if (modelCall === 1) {
            return {
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "search-1",
                        type: "function",
                        function: {
                          name: "web_search",
                          arguments: JSON.stringify({
                            query:
                              "California auto repair shops jump starter buyer contact",
                            max_results: 5
                          })
                        }
                      }
                    ]
                  }
                }
              ]
            };
          }
          return {
            choices: [
              {
                message: {
                  role: "assistant",
                  content: JSON.stringify({
                    summary: "Found two verified California repair shops.",
                    buyers: [
                      {
                        company: "Golden State Auto Repair",
                        website: "https://goldenstate.example",
                        contact: "Service Manager",
                        email: "service@goldenstate.example",
                        phone: "+1-555-0101",
                        evidence_url: "https://goldenstate.example/contact"
                      },
                      {
                        company: "Bay Area Car Care",
                        website: "https://bayareacarcare.example",
                        contact: "Owner",
                        email: "owner@bayareacarcare.example",
                        phone: "+1-555-0102",
                        evidence_url: "https://bayareacarcare.example/contact"
                      }
                    ],
                    factories: [],
                    notes: ["Verify purchasing interest before outreach."]
                  })
                }
              }
            ]
          };
        }
      }
    }
  };

  try {
    const cycle = await runScheduledWorkerCycle({
      db,
      taskId: task.id,
      llmClient,
      fetchImpl: async (url, options) => {
        searchRequests.push({
          url,
          body: JSON.parse(options.body)
        });
        return {
          ok: true,
          status: 200,
          json: async () => ({
            results: [
              {
                title: "Golden State Auto Repair",
                url: "https://goldenstate.example/contact",
                content: "California repair shop contact page.",
                score: 0.95
              },
              {
                title: "Bay Area Car Care",
                url: "https://bayareacarcare.example/contact",
                content: "Bay Area automotive repair contact page.",
                score: 0.92
              }
            ]
          })
        };
      },
      notify: async (chatId, text) => notifications.push(text)
    });

    assert.equal(cycle.processedTaskId, task.id);
    assert.equal(searchRequests.length, 1);
    assert.equal(searchRequests[0].url, "https://api.tavily.com/search");
    assert.match(searchRequests[0].body.query, /California auto repair shops/);
    const completed = await db.getTask(task.id);
    const buyers = await db.listEntities(task.id);
    assert.equal(completed.status, "completed");
    assert.equal(completed.progress, 100);
    assert.equal(buyers.length, 2);
    assert.deepEqual(
      completed.metadata.stage_history.map((item) => item.stage),
      [
        "Received",
        "Researching...",
        "Verifying leads...",
        "Compiling final report...",
        "Completed"
      ]
    );
    assert.ok(notifications.some((text) => /Status: Researching/.test(text)));
    assert.ok(notifications.some((text) => /Status: Verifying/.test(text)));
    assert.ok(notifications.some((text) => /Status: Completed/.test(text)));
    assert.ok(
      notifications.some((text) => /Golden State Auto Repair/.test(text))
    );
    const actions = await db.client.execute(
      "SELECT tool, status FROM actions ORDER BY created_at ASC"
    );
    assert.deepEqual(
      actions.rows.map((row) => [row.tool, row.status]),
      [
        ["web_search", "started"],
        ["web_search", "completed"]
      ]
    );
  } finally {
    if (originalTavilyKey === undefined) {
      delete process.env.TAVILY_API_KEY;
    } else {
      process.env.TAVILY_API_KEY = originalTavilyKey;
    }
  }
});

test("normal research tasks do not expose Google Sheets", () => {
  const objective =
    "Find 2 California auto repair shops that may buy jump starters.";
  assert.equal(taskRequestsGoogleSheets(objective), false);
  assert.equal(
    getAgentToolDefinitions(objective).some(
      (tool) => tool.function.name === "google_sheets_append"
    ),
    false
  );
});

test("Google Sheets is exposed only when explicitly requested", () => {
  const objective =
    "Find 2 California auto repair shops and save the results to Google Sheets.";
  assert.equal(taskRequestsGoogleSheets(objective), true);
  assert.equal(
    getAgentToolDefinitions(objective).some(
      (tool) => tool.function.name === "google_sheets_append"
    ),
    true
  );
});

test("missing Google Sheets credentials never fail a requested write", async () => {
  const originalToken = process.env.GOOGLE_ACCESS_TOKEN;
  const originalSpreadsheet = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  delete process.env.GOOGLE_ACCESS_TOKEN;
  delete process.env.GOOGLE_SHEETS_SPREADSHEET_ID;

  try {
    const result = await appendGoogleSheetRows({
      rows: [["Company", "Website"], ["Example", "https://example.com"]]
    });
    assert.equal(result.skipped, true);
    assert.match(result.reason, /Results will still be returned directly/);
  } finally {
    if (originalToken !== undefined) {
      process.env.GOOGLE_ACCESS_TOKEN = originalToken;
    }
    if (originalSpreadsheet !== undefined) {
      process.env.GOOGLE_SHEETS_SPREADSHEET_ID = originalSpreadsheet;
    }
  }
});

test("normal Telegram research completes without Google Sheets credentials", async () => {
  const originalTavilyKey = process.env.TAVILY_API_KEY;
  const originalGoogleToken = process.env.GOOGLE_ACCESS_TOKEN;
  process.env.TAVILY_API_KEY = "test-tavily-key";
  delete process.env.GOOGLE_ACCESS_TOKEN;
  const db = await memoryDb();
  const task = await createBackgroundTask({
    userId: "john",
    chatId: "42",
    objective:
      "Find 2 California auto repair shops that may buy jump starters.",
    db
  });
  let modelCall = 0;
  const seenTools = [];
  const llmClient = {
    chat: {
      completions: {
        create: async (request) => {
          seenTools.push(request.tools.map((tool) => tool.function.name));
          modelCall += 1;
          if (modelCall === 1) {
            return {
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "search-no-sheets",
                        type: "function",
                        function: {
                          name: "web_search",
                          arguments: JSON.stringify({
                            query: "California auto repair shops",
                            max_results: 2
                          })
                        }
                      }
                    ]
                  }
                }
              ]
            };
          }
          return {
            choices: [
              {
                message: {
                  role: "assistant",
                  content: JSON.stringify({
                    summary: "Found two repair shops.",
                    buyers: [
                      {
                        company: "Repair Shop One",
                        website: "https://one.example",
                        evidence_url: "https://one.example/contact"
                      },
                      {
                        company: "Repair Shop Two",
                        website: "https://two.example",
                        evidence_url: "https://two.example/contact"
                      }
                    ],
                    factories: [],
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
  const notifications = [];

  try {
    await runScheduledWorkerCycle({
      db,
      taskId: task.id,
      llmClient,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          results: [
            {
              title: "Repair Shop One",
              url: "https://one.example/contact",
              content: "California auto repair shop.",
              score: 0.9
            },
            {
              title: "Repair Shop Two",
              url: "https://two.example/contact",
              content: "California auto repair shop.",
              score: 0.89
            }
          ]
        })
      }),
      notify: async (chatId, text) => notifications.push(text)
    });

    assert.equal((await db.getTask(task.id)).status, "completed");
    assert.equal((await db.listEntities(task.id)).length, 2);
    assert.ok(
      seenTools.every(
        (tools) => !tools.includes("google_sheets_append")
      )
    );
    assert.ok(notifications.some((text) => /Repair Shop One/.test(text)));
  } finally {
    if (originalTavilyKey === undefined) {
      delete process.env.TAVILY_API_KEY;
    } else {
      process.env.TAVILY_API_KEY = originalTavilyKey;
    }
    if (originalGoogleToken === undefined) {
      delete process.env.GOOGLE_ACCESS_TOKEN;
    } else {
      process.env.GOOGLE_ACCESS_TOKEN = originalGoogleToken;
    }
  }
});

test("worker endpoint accepts CRON_SECRET and legacy worker secret", () => {
  assert.equal(
    isAuthorizedWorkerRequest(
      { headers: { authorization: "Bearer cron-value" } },
      { CRON_SECRET: "cron-value", LILY_WORKER_SECRET: "worker-value" }
    ),
    true
  );
  assert.equal(
    isAuthorizedWorkerRequest(
      { headers: { authorization: "Bearer worker-value" } },
      { CRON_SECRET: "cron-value", LILY_WORKER_SECRET: "worker-value" }
    ),
    true
  );
  assert.equal(
    isAuthorizedWorkerRequest(
      { headers: { authorization: "Bearer wrong" } },
      { CRON_SECRET: "cron-value" }
    ),
    false
  );
});

test("Vercel production config supports a long worker without an unsupported Hobby cron", () => {
  const config = JSON.parse(fs.readFileSync("vercel.json", "utf8"));
  assert.equal(config.crons, undefined);
  assert.equal(config.functions["api/telegram.js"].maxDuration, 300);
  assert.equal(config.functions["api/worker.js"].maxDuration, 300);
});

test("Telegram runs the exact queued task after responding", async () => {
  const backgroundJobs = [];
  const calls = [];
  const scheduled = triggerBackgroundWorker({
    taskId: "task-123",
    runWorker: async (options) => {
      calls.push(options);
    },
    waitUntilImpl: (job) => backgroundJobs.push(job)
  });

  assert.equal(scheduled, true);
  assert.equal(backgroundJobs.length, 1);
  await backgroundJobs[0];
  assert.deepEqual(calls, [{ taskId: "task-123" }]);
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
