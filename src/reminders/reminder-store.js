import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { logger } from "../utils/logger.js";

const DEFAULT_DB_PATH = resolve(
  process.env.REMINDERS_DB_PATH || "./data/reminders.db",
);

function safeJsonParse(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch (error) {
    logger.warn("Failed to parse reminder metadata JSON", error);
    return null;
  }
}

function serializeMeta(meta) {
  if (!meta) return null;
  try {
    return JSON.stringify(meta);
  } catch (error) {
    logger.warn("Failed to serialize reminder metadata", error);
    return null;
  }
}

function toBoolean(value) {
  return Boolean(Number(value));
}

export class ReminderStore {
  constructor(dbPath = DEFAULT_DB_PATH) {
    this.dbPath = dbPath;
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new Database(this.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this._createSchema();
    this._prepareStatements();
    logger.info(`🗄️ Reminder database ready at ${this.dbPath}`);
  }

  _createSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reminders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        created_by TEXT,
        title TEXT,
        message TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('cron','once')),
        cron_expression TEXT,
        run_at TEXT,
        timezone TEXT DEFAULT 'local',
        ack_timeout_seconds INTEGER NOT NULL DEFAULT 600,
        repeat_until_ack INTEGER NOT NULL DEFAULT 1,
        max_retries INTEGER NOT NULL DEFAULT -1,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_triggered_at TEXT,
        meta TEXT
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reminder_occurrences (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        reminder_id INTEGER NOT NULL,
        scheduled_for TEXT NOT NULL,
        sent_at TEXT,
        message_id INTEGER,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','acknowledged','cancelled','error')),
        retry_count INTEGER NOT NULL DEFAULT 0,
        last_retry_at TEXT,
        next_retry_at TEXT,
        followup_job_name TEXT,
        acknowledged_at TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (reminder_id) REFERENCES reminders(id) ON DELETE CASCADE
      );
    `);

    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_reminders_chat_active ON reminders(chat_id, active);",
    );
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_reminders_active ON reminders(active);",
    );
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_occurrences_reminder_status ON reminder_occurrences(reminder_id, status);",
    );
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_occurrences_followup ON reminder_occurrences(status, next_retry_at);",
    );
  }

  _prepareStatements() {
    this.statements = {
      insertReminder: this.db.prepare(`
        INSERT INTO reminders (
          chat_id, created_by, title, message, type, cron_expression, run_at,
          timezone, ack_timeout_seconds, repeat_until_ack, max_retries, active,
          created_at, updated_at, meta
        ) VALUES (
          @chatId, @createdBy, @title, @message, @type, @cronExpression, @runAt,
          @timezone, @ackTimeoutSeconds, @repeatUntilAck, @maxRetries, 1,
          @createdAt, @updatedAt, @meta
        )
      `),
      getReminderById: this.db.prepare(
        "SELECT * FROM reminders WHERE id = ?",
      ),
      listRemindersByChat: this.db.prepare(
        "SELECT * FROM reminders WHERE chat_id = ? AND active = 1 ORDER BY created_at",
      ),
      listActiveReminders: this.db.prepare(
        "SELECT * FROM reminders WHERE active = 1 ORDER BY created_at",
      ),
      deactivateReminder: this.db.prepare(
        "UPDATE reminders SET active = 0, updated_at = @updatedAt WHERE id = @id",
      ),
      hardDeleteReminder: this.db.prepare(
        "DELETE FROM reminders WHERE id = ?",
      ),
      touchReminder: this.db.prepare(
        "UPDATE reminders SET last_triggered_at = @time, updated_at = @time WHERE id = @id",
      ),
      insertOccurrence: this.db.prepare(`
        INSERT INTO reminder_occurrences (
          reminder_id, scheduled_for, sent_at, message_id, status,
          retry_count, last_retry_at, next_retry_at, followup_job_name,
          acknowledged_at, error, created_at, updated_at
        ) VALUES (
          @reminderId, @scheduledFor, @sentAt, @messageId, @status,
          @retryCount, @lastRetryAt, @nextRetryAt, @followupJobName,
          @acknowledgedAt, @error, @createdAt, @updatedAt
        )
      `),
      getOccurrenceById: this.db.prepare(
        "SELECT * FROM reminder_occurrences WHERE id = ?",
      ),
      updateOccurrenceAfterSend: this.db.prepare(`
        UPDATE reminder_occurrences
        SET sent_at = COALESCE(@sentAt, sent_at),
            message_id = COALESCE(@messageId, message_id),
            retry_count = @retryCount,
            last_retry_at = @lastRetryAt,
            updated_at = @updatedAt,
            error = NULL
        WHERE id = @occurrenceId
      `),
      setOccurrenceFollowup: this.db.prepare(`
        UPDATE reminder_occurrences
        SET next_retry_at = @nextRetryAt,
            followup_job_name = @followupJobName,
            updated_at = @updatedAt
        WHERE id = @occurrenceId
      `),
      clearOccurrenceFollowup: this.db.prepare(`
        UPDATE reminder_occurrences
        SET next_retry_at = NULL,
            followup_job_name = NULL,
            updated_at = @updatedAt
        WHERE id = @occurrenceId
      `),
      markOccurrenceAcknowledged: this.db.prepare(`
        UPDATE reminder_occurrences
        SET status = 'acknowledged',
            acknowledged_at = @acknowledgedAt,
            next_retry_at = NULL,
            followup_job_name = NULL,
            updated_at = @acknowledgedAt
        WHERE id = @occurrenceId AND status = 'pending'
      `),
      updateOccurrenceStatus: this.db.prepare(`
        UPDATE reminder_occurrences
        SET status = @status,
            error = @error,
            updated_at = @updatedAt
        WHERE id = @occurrenceId
      `),
      listPendingFollowups: this.db.prepare(`
        SELECT * FROM reminder_occurrences
        WHERE status = 'pending' AND next_retry_at IS NOT NULL
        ORDER BY next_retry_at ASC
      `),
      listPendingOccurrencesByReminder: this.db.prepare(`
        SELECT * FROM reminder_occurrences
        WHERE reminder_id = ? AND status = 'pending'
      `),
      cancelOccurrencesByReminder: this.db.prepare(`
        UPDATE reminder_occurrences
        SET status = 'cancelled',
            next_retry_at = NULL,
            followup_job_name = NULL,
            updated_at = @updatedAt
        WHERE reminder_id = @reminderId AND status = 'pending'
      `),
    };
  }

  _mapReminder(row) {
    if (!row) return null;
    return {
      id: row.id,
      chat_id: row.chat_id,
      created_by: row.created_by,
      title: row.title,
      message: row.message,
      type: row.type,
      cron_expression: row.cron_expression,
      run_at: row.run_at,
      timezone: row.timezone,
      ack_timeout_seconds: row.ack_timeout_seconds,
      repeat_until_ack: toBoolean(row.repeat_until_ack),
      max_retries: row.max_retries,
      active: toBoolean(row.active),
      created_at: row.created_at,
      updated_at: row.updated_at,
      last_triggered_at: row.last_triggered_at,
      meta: safeJsonParse(row.meta),
    };
  }

  _mapOccurrence(row) {
    if (!row) return null;
    return {
      id: row.id,
      reminder_id: row.reminder_id,
      scheduled_for: row.scheduled_for,
      sent_at: row.sent_at,
      message_id: row.message_id,
      status: row.status,
      retry_count: row.retry_count,
      last_retry_at: row.last_retry_at,
      next_retry_at: row.next_retry_at,
      followup_job_name: row.followup_job_name,
      acknowledged_at: row.acknowledged_at,
      error: row.error,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  createReminder({
    chatId,
    createdBy,
    title = null,
    message,
    type,
    cronExpression = null,
    runAt = null,
    timezone = "local",
    ackTimeoutSeconds = 600,
    repeatUntilAck = true,
    maxRetries = -1,
    meta = null,
  }) {
    const now = new Date().toISOString();
    const result = this.statements.insertReminder.run({
      chatId: String(chatId),
      createdBy: createdBy ?? null,
      title,
      message,
      type,
      cronExpression,
      runAt,
      timezone,
      ackTimeoutSeconds,
      repeatUntilAck: repeatUntilAck ? 1 : 0,
      maxRetries,
      createdAt: now,
      updatedAt: now,
      meta: serializeMeta(meta),
    });

    return this.getReminderById(result.lastInsertRowid);
  }

  getReminderById(id) {
    const row = this.statements.getReminderById.get(id);
    return this._mapReminder(row);
  }

  listRemindersByChat(chatId) {
    const rows = this.statements.listRemindersByChat.all(String(chatId));
    return rows.map((row) => this._mapReminder(row));
  }

  listActiveReminders() {
    const rows = this.statements.listActiveReminders.all();
    return rows.map((row) => this._mapReminder(row));
  }

  deactivateReminder(id) {
    const updatedAt = new Date().toISOString();
    const result = this.statements.deactivateReminder.run({
      id,
      updatedAt,
    });
    return result.changes > 0;
  }

  hardDeleteReminder(id) {
    const result = this.statements.hardDeleteReminder.run(id);
    return result.changes > 0;
  }

  touchReminder(reminderId, timeIso = new Date().toISOString()) {
    this.statements.touchReminder.run({ id: reminderId, time: timeIso });
  }

  createOccurrence({
    reminderId,
    scheduledFor,
    sentAt = null,
    messageId = null,
    status = "pending",
    retryCount = 0,
    lastRetryAt = null,
    nextRetryAt = null,
    followupJobName = null,
    acknowledgedAt = null,
    error = null,
  }) {
    const now = new Date().toISOString();
    const result = this.statements.insertOccurrence.run({
      reminderId,
      scheduledFor,
      sentAt,
      messageId,
      status,
      retryCount,
      lastRetryAt,
      nextRetryAt,
      followupJobName,
      acknowledgedAt,
      error,
      createdAt: now,
      updatedAt: now,
    });
    return this.getOccurrenceById(result.lastInsertRowid);
  }

  getOccurrenceById(id) {
    const row = this.statements.getOccurrenceById.get(id);
    return this._mapOccurrence(row);
  }

  updateOccurrenceAfterSend(occurrenceId, {
    messageId = null,
    sentAt = null,
    retryCount,
    lastRetryAt,
  }) {
    const updatedAt = new Date().toISOString();
    this.statements.updateOccurrenceAfterSend.run({
      occurrenceId,
      messageId,
      sentAt,
      retryCount,
      lastRetryAt,
      updatedAt,
    });
    return this.getOccurrenceById(occurrenceId);
  }

  setOccurrenceFollowup(occurrenceId, { nextRetryAt, followupJobName }) {
    const updatedAt = new Date().toISOString();
    this.statements.setOccurrenceFollowup.run({
      occurrenceId,
      nextRetryAt,
      followupJobName,
      updatedAt,
    });
    return this.getOccurrenceById(occurrenceId);
  }

  clearOccurrenceFollowup(occurrenceId) {
    const updatedAt = new Date().toISOString();
    this.statements.clearOccurrenceFollowup.run({ occurrenceId, updatedAt });
    return this.getOccurrenceById(occurrenceId);
  }

  markOccurrenceAcknowledged(occurrenceId) {
    const acknowledgedAt = new Date().toISOString();
    const result = this.statements.markOccurrenceAcknowledged.run({
      occurrenceId,
      acknowledgedAt,
    });
    return {
      changed: result.changes > 0,
      occurrence: this.getOccurrenceById(occurrenceId),
    };
  }

  updateOccurrenceStatus(occurrenceId, status, error = null) {
    const updatedAt = new Date().toISOString();
    this.statements.updateOccurrenceStatus.run({
      occurrenceId,
      status,
      error,
      updatedAt,
    });
    return this.getOccurrenceById(occurrenceId);
  }

  listPendingFollowups() {
    const rows = this.statements.listPendingFollowups.all();
    return rows.map((row) => this._mapOccurrence(row));
  }

  listPendingOccurrencesByReminder(reminderId) {
    const rows = this.statements.listPendingOccurrencesByReminder.all(
      reminderId,
    );
    return rows.map((row) => this._mapOccurrence(row));
  }

  cancelPendingOccurrencesByReminder(reminderId) {
    const updatedAt = new Date().toISOString();
    this.statements.cancelOccurrencesByReminder.run({
      reminderId,
      updatedAt,
    });
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

export const reminderStore = new ReminderStore();
