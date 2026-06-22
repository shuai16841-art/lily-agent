import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createClient } from "@libsql/client";

let sharedDatabase;

function now() {
  return new Date().toISOString();
}

function json(value, fallback = null) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function normalizeRow(row) {
  if (!row) {
    return null;
  }

  return {
    ...row,
    steps: json(row.steps, []),
    result: json(row.result, null),
    metadata: json(row.metadata, {}),
    args: json(row.args, null),
    action_result: json(row.action_result, null)
  };
}

export function resolveDatabaseConfig(env = process.env) {
  if (env.TURSO_DATABASE_URL && env.TURSO_AUTH_TOKEN) {
    return {
      client: {
        url: env.TURSO_DATABASE_URL,
        authToken: env.TURSO_AUTH_TOKEN
      },
      storageMode: "turso",
      persistent: true
    };
  }

  if (env.VERCEL || env.AWS_LAMBDA_FUNCTION_NAME) {
    const missing = [
      !env.TURSO_DATABASE_URL ? "TURSO_DATABASE_URL" : null,
      !env.TURSO_AUTH_TOKEN ? "TURSO_AUTH_TOKEN" : null
    ].filter(Boolean);
    return {
      client: { url: ":memory:" },
      storageMode: "memory",
      persistent: false,
      warning:
        `Turso is not fully configured (${missing.join(", ")} missing). ` +
        "Using temporary in-memory storage for this serverless instance."
    };
  }

  const dbPath = path.resolve(env.LILY_DB_PATH || "data/lily.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  return {
    client: {
      url: `file:${dbPath.replaceAll("\\", "/")}`
    },
    storageMode: "local-sqlite",
    persistent: true
  };
}

export class LilyDatabase {
  constructor(client, options = {}) {
    const config = client ? null : resolveDatabaseConfig();
    this.client = client || createClient(config.client);
    this.storageMode = options.storageMode || config?.storageMode || "custom";
    this.persistent = options.persistent ?? config?.persistent ?? true;
    this.warning = options.warning || config?.warning || null;
    this.initialized = false;
  }

  isPersistent() {
    return this.persistent;
  }

  getStorageStatus() {
    return {
      mode: this.storageMode,
      persistent: this.persistent,
      warning: this.warning
    };
  }

  async initialize() {
    if (this.initialized) {
      return;
    }

    await this.client.batch(
      [
        `CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          user_id TEXT,
          chat_id TEXT,
          objective TEXT NOT NULL,
          status TEXT NOT NULL,
          progress INTEGER NOT NULL DEFAULT 0,
          steps TEXT NOT NULL DEFAULT '[]',
          result TEXT,
          error TEXT,
          metadata TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )`,
        `CREATE TABLE IF NOT EXISTS entities (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          company TEXT,
          website TEXT,
          contact TEXT,
          email TEXT,
          phone TEXT,
          follow_up_status TEXT NOT NULL DEFAULT 'not_started',
          data TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL
        )`,
        `CREATE TABLE IF NOT EXISTS memories (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          category TEXT NOT NULL,
          memory_key TEXT NOT NULL,
          value TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(user_id, category, memory_key)
        )`,
        `CREATE TABLE IF NOT EXISTS email_drafts (
          id TEXT PRIMARY KEY,
          task_id TEXT,
          user_id TEXT,
          chat_id TEXT,
          recipient TEXT NOT NULL,
          subject TEXT NOT NULL,
          body TEXT NOT NULL,
          status TEXT NOT NULL,
          provider_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )`,
        `CREATE TABLE IF NOT EXISTS actions (
          id TEXT PRIMARY KEY,
          task_id TEXT,
          tool TEXT NOT NULL,
          status TEXT NOT NULL,
          args TEXT,
          action_result TEXT,
          error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )`,
        `CREATE TABLE IF NOT EXISTS processed_updates (
          update_id TEXT PRIMARY KEY,
          created_at TEXT NOT NULL
        )`
      ],
      "write"
    );
    try {
      await this.client.execute(
        "ALTER TABLE entities ADD COLUMN follow_up_status TEXT NOT NULL DEFAULT 'not_started'"
      );
    } catch (error) {
      if (!/duplicate column|already exists/i.test(error.message)) {
        throw error;
      }
    }
    this.initialized = true;
  }

  async createTask({ userId, chatId, objective, steps = [], metadata = {} }) {
    await this.initialize();
    const id = crypto.randomUUID();
    const timestamp = now();
    await this.client.execute({
      sql: `INSERT INTO tasks
        (id, user_id, chat_id, objective, status, progress, steps, metadata, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?)`,
      args: [
        id,
        String(userId || ""),
        String(chatId || ""),
        objective,
        JSON.stringify(steps),
        JSON.stringify(metadata),
        timestamp,
        timestamp
      ]
    });
    return this.getTask(id);
  }

  async getTask(id) {
    await this.initialize();
    const result = await this.client.execute({
      sql: "SELECT * FROM tasks WHERE id = ?",
      args: [id]
    });
    return normalizeRow(result.rows[0]);
  }

  async getTaskByPrefix(idOrPrefix, userId) {
    await this.initialize();
    const result = await this.client.execute({
      sql: `SELECT * FROM tasks
        WHERE id LIKE ? AND user_id = ?
        ORDER BY created_at DESC LIMIT 1`,
      args: [`${idOrPrefix}%`, String(userId || "")]
    });
    return normalizeRow(result.rows[0]);
  }

  async getLatestTask(userId) {
    await this.initialize();
    const result = await this.client.execute({
      sql: "SELECT * FROM tasks WHERE user_id = ? ORDER BY created_at DESC LIMIT 1",
      args: [String(userId || "")]
    });
    return normalizeRow(result.rows[0]);
  }

  async listTasks(userId, limit = 10) {
    await this.initialize();
    const result = await this.client.execute({
      sql: "SELECT * FROM tasks WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
      args: [String(userId || ""), limit]
    });
    return result.rows.map(normalizeRow);
  }

  async claimNextTask() {
    await this.initialize();
    const queued = await this.client.execute(
      "SELECT id FROM tasks WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1"
    );
    const id = queued.rows[0]?.id;
    if (!id) {
      return null;
    }

    const timestamp = now();
    const claimed = await this.client.execute({
      sql: `UPDATE tasks SET status = 'running',
        progress = CASE WHEN progress < 5 THEN 5 ELSE progress END,
        updated_at = ?
        WHERE id = ? AND status = 'queued'`,
      args: [timestamp, id]
    });
    return claimed.rowsAffected === 1 ? this.getTask(id) : null;
  }

  async recoverInterruptedTasks(staleAfterSeconds = 90) {
    await this.initialize();
    const cutoff = new Date(Date.now() - staleAfterSeconds * 1000).toISOString();
    const result = await this.client.execute({
      sql: `SELECT * FROM tasks
        WHERE status = 'running' AND updated_at < ?
        ORDER BY updated_at ASC`,
      args: [cutoff]
    });
    const recovered = [];

    for (const row of result.rows) {
      const task = normalizeRow(row);
      const stage = task.metadata?.current_stage || "Researching...";
      const recoveryCount = Number(task.metadata?.recovery_count || 0) + 1;
      const updated = await this.updateTask(task.id, {
        status: "queued",
        metadata: {
          ...(task.metadata || {}),
          current_activity: `Resuming from ${stage}`,
          interrupted_at: task.updated_at,
          resume_pending: true,
          recovery_count: recoveryCount
        }
      });
      recovered.push(updated);
    }

    return recovered;
  }

  async updateTask(id, patch) {
    await this.initialize();
    const fields = [];
    const args = [];
    for (const [key, value] of Object.entries(patch)) {
      if (!["status", "progress", "steps", "result", "error", "metadata"].includes(key)) {
        continue;
      }
      fields.push(`${key} = ?`);
      args.push(["steps", "result", "metadata"].includes(key) ? JSON.stringify(value) : value);
    }
    fields.push("updated_at = ?");
    args.push(now(), id);
    await this.client.execute({
      sql: `UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`,
      args
    });
    return this.getTask(id);
  }

  async stopTask(id, userId) {
    await this.initialize();
    const result = await this.client.execute({
      sql: `UPDATE tasks SET status = 'stopped', updated_at = ?
        WHERE id = ? AND user_id = ? AND status IN ('queued', 'running')`,
      args: [now(), id, String(userId || "")]
    });
    return result.rowsAffected === 1;
  }

  async saveEntities(taskId, kind, entities) {
    await this.initialize();
    if (!Array.isArray(entities) || entities.length === 0) {
      return;
    }
    const timestamp = now();
    await this.client.batch(
      entities.map((entity) => ({
        sql: `INSERT INTO entities
          (id, task_id, kind, company, website, contact, email, phone, data, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          crypto.randomUUID(),
          taskId,
          kind,
          entity.company || entity.company_name || "",
          entity.website || "",
          entity.contact || "",
          entity.email || "",
          entity.phone || "",
          JSON.stringify(entity),
          timestamp
        ]
      })),
      "write"
    );
  }

  async listEntities(taskId) {
    await this.initialize();
    const result = await this.client.execute({
      sql: "SELECT * FROM entities WHERE task_id = ? ORDER BY created_at ASC",
      args: [taskId]
    });
    return result.rows.map((row) => ({
      ...row,
      data: json(row.data, {})
    }));
  }

  async updateEntityFollowUp(id, status) {
    await this.initialize();
    await this.client.execute({
      sql: "UPDATE entities SET follow_up_status = ? WHERE id = ?",
      args: [status, id]
    });
  }

  async saveMemory({ userId, category, key, value }) {
    await this.initialize();
    const timestamp = now();
    await this.client.execute({
      sql: `INSERT INTO memories
        (id, user_id, category, memory_key, value, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, category, memory_key)
        DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      args: [
        crypto.randomUUID(),
        String(userId || ""),
        category,
        key,
        JSON.stringify(value),
        timestamp,
        timestamp
      ]
    });
  }

  async getMemories(userId, limit = 20) {
    await this.initialize();
    const result = await this.client.execute({
      sql: "SELECT * FROM memories WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?",
      args: [String(userId || ""), limit]
    });
    return result.rows.map((row) => ({
      ...row,
      value: json(row.value, row.value)
    }));
  }

  async createEmailDraft({ taskId, userId, chatId, recipient, subject, body }) {
    await this.initialize();
    const id = crypto.randomUUID();
    const timestamp = now();
    await this.client.execute({
      sql: `INSERT INTO email_drafts
        (id, task_id, user_id, chat_id, recipient, subject, body, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending_approval', ?, ?)`,
      args: [
        id,
        taskId || null,
        String(userId || ""),
        String(chatId || ""),
        recipient,
        subject,
        body,
        timestamp,
        timestamp
      ]
    });
    return this.getEmailDraft(id);
  }

  async getEmailDraft(id) {
    await this.initialize();
    const result = await this.client.execute({
      sql: "SELECT * FROM email_drafts WHERE id = ?",
      args: [id]
    });
    return result.rows[0] || null;
  }

  async updateEmailDraft(id, patch) {
    await this.initialize();
    const fields = [];
    const args = [];
    for (const [key, value] of Object.entries(patch)) {
      if (!["status", "provider_id"].includes(key)) {
        continue;
      }
      fields.push(`${key} = ?`);
      args.push(value);
    }
    fields.push("updated_at = ?");
    args.push(now(), id);
    await this.client.execute({
      sql: `UPDATE email_drafts SET ${fields.join(", ")} WHERE id = ?`,
      args
    });
    return this.getEmailDraft(id);
  }

  async logAction({ taskId, tool, status, args, result, error }) {
    await this.initialize();
    const timestamp = now();
    await this.client.execute({
      sql: `INSERT INTO actions
        (id, task_id, tool, status, args, action_result, error, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        crypto.randomUUID(),
        taskId || null,
        tool,
        status,
        JSON.stringify(args || null),
        JSON.stringify(result || null),
        error || null,
        timestamp,
        timestamp
      ]
    });
  }

  async markUpdateProcessed(updateId) {
    await this.initialize();
    try {
      await this.client.execute({
        sql: "INSERT INTO processed_updates (update_id, created_at) VALUES (?, ?)",
        args: [String(updateId), now()]
      });
      return true;
    } catch (error) {
      if (/unique|constraint/i.test(error.message)) {
        return false;
      }
      throw error;
    }
  }
}

export function getDatabase() {
  if (!sharedDatabase) {
    sharedDatabase = new LilyDatabase();
    if (sharedDatabase.warning) {
      console.warn(`[Lily database] ${sharedDatabase.warning}`);
    }
  }
  return sharedDatabase;
}
