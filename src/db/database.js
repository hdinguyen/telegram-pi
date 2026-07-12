import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { logger } from "../utils/logger.js";

/**
 * Default location for the SQLite database file.
 * Override with the DATABASE_PATH environment variable.
 */
export function getDatabasePath() {
  return resolve(process.env.DATABASE_PATH || "./data/sessions.db");
}

/**
 * GroupSessionStore maps a Telegram group (chat_id) to a persisted Pi agent
 * session file. This lets the bot resume the correct conversation context for
 * each group after a restart instead of sharing one global session.
 *
 * Schema (table `group_sessions`):
 *   chat_id      TEXT PRIMARY KEY  - Telegram chat/group id (as string)
 *   session_file TEXT NOT NULL     - Absolute path to the JSONL session file
 *   session_id   TEXT              - Pi session id (for diagnostics)
 *   chat_title   TEXT              - Group title (for diagnostics)
 *   chat_type    TEXT              - private | group | supergroup | channel
 *   created_at   TEXT              - ISO timestamp of first creation
 *   updated_at   TEXT              - ISO timestamp of last activity
 */
export class GroupSessionStore {
  constructor(dbPath = getDatabasePath()) {
    this.dbPath = dbPath;
    this.db = null;
  }

  /** Open the database and ensure the schema exists. */
  init() {
    if (this.db) return;

    // Ensure the parent directory exists (e.g. ./data)
    mkdirSync(dirname(this.dbPath), { recursive: true });

    this.db = new DatabaseSync(this.dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS group_sessions (
        chat_id      TEXT PRIMARY KEY,
        session_file TEXT NOT NULL,
        session_id   TEXT,
        chat_title   TEXT,
        chat_type    TEXT,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      );
    `);

    logger.info(`📚 Session database ready at ${this.dbPath}`);
  }

  /**
   * Look up the persisted session mapping for a group.
   * @param {string|number} chatId
   * @returns {{chat_id:string, session_file:string, session_id:string, chat_title:string, chat_type:string, created_at:string, updated_at:string}|undefined}
   */
  get(chatId) {
    this.init();
    return this.db
      .prepare("SELECT * FROM group_sessions WHERE chat_id = ?")
      .get(String(chatId));
  }

  /**
   * Insert or update the session mapping for a group.
   * @param {string|number} chatId
   * @param {string} sessionFile - Absolute path to the JSONL session file
   * @param {Object} meta - { sessionId, chatTitle, chatType }
   */
  upsert(chatId, sessionFile, meta = {}) {
    this.init();
    const now = new Date().toISOString();
    const id = String(chatId);

    this.db
      .prepare(
        `INSERT INTO group_sessions
           (chat_id, session_file, session_id, chat_title, chat_type, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET
           session_file = excluded.session_file,
           session_id   = excluded.session_id,
           chat_title   = excluded.chat_title,
           chat_type    = excluded.chat_type,
           updated_at   = excluded.updated_at`,
      )
      .run(
        id,
        sessionFile,
        meta.sessionId ?? null,
        meta.chatTitle ?? null,
        meta.chatType ?? null,
        now,
        now,
      );
  }

  /** Bump the updated_at timestamp for a group (records recent activity). */
  touch(chatId) {
    this.init();
    this.db
      .prepare("UPDATE group_sessions SET updated_at = ? WHERE chat_id = ?")
      .run(new Date().toISOString(), String(chatId));
  }

  /** Total number of tracked group sessions. */
  count() {
    this.init();
    return this.db.prepare("SELECT COUNT(*) AS n FROM group_sessions").get().n;
  }

  /** Close the database connection. */
  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

/**
 * AllowedUserStore manages the database-backed allowlist of Telegram usernames
 * permitted to trigger the bot. This lets the allowlist be modified at runtime
 * (no code change or restart) instead of relying solely on the AVAILABLE env var.
 *
 * Usernames are stored lowercased and without a leading "@".
 *
 * Deny is a SOFT delete: the row is kept and `revoked_at` is set, so history is
 * preserved and a later /allow simply clears `revoked_at` again.
 *
 * Schema (table `allowed_users`):
 *   username   TEXT PRIMARY KEY  - Telegram username (lowercased, no "@")
 *   added_by   TEXT              - Username that added this entry (for audit)
 *   created_at TEXT NOT NULL     - ISO timestamp of insertion
 *   revoked_at TEXT              - ISO timestamp of soft delete (NULL = active)
 */
export class AllowedUserStore {
  constructor(dbPath = getDatabasePath()) {
    this.dbPath = dbPath;
    this.db = null;
  }

  /** Normalize a username: strip a leading "@" and lowercase. */
  static normalize(username) {
    return String(username || "")
      .trim()
      .replace(/^@/, "")
      .toLowerCase();
  }

  /** Open the database and ensure the schema exists. */
  init() {
    if (this.db) return;

    // Ensure the parent directory exists (e.g. ./data)
    mkdirSync(dirname(this.dbPath), { recursive: true });

    this.db = new DatabaseSync(this.dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS allowed_users (
        username   TEXT PRIMARY KEY,
        added_by   TEXT,
        created_at TEXT NOT NULL,
        revoked_at TEXT
      );
    `);

    logger.info(`✅ Allowlist database ready at ${this.dbPath}`);
  }

  /**
   * Add a username to the allowlist (or re-activate a previously denied one).
   * @param {string} username
   * @param {string} [addedBy] - Username that performed the action (audit)
   * @returns {boolean} true if the user is active afterwards and changed state
   */
  add(username, addedBy = null) {
    this.init();
    const name = AllowedUserStore.normalize(username);
    if (!name) return false;

    const result = this.db
      .prepare(
        `INSERT INTO allowed_users (username, added_by, created_at, revoked_at)
         VALUES (?, ?, ?, NULL)
         ON CONFLICT(username) DO UPDATE SET
           added_by   = excluded.added_by,
           revoked_at = NULL
         WHERE allowed_users.revoked_at IS NOT NULL`,
      )
      .run(
        name,
        addedBy ? AllowedUserStore.normalize(addedBy) : null,
        new Date().toISOString(),
      );

    return result.changes > 0;
  }

  /**
   * Soft-delete (deny) a username: keep the row but mark it revoked.
   * @param {string} username
   * @returns {boolean} true if an active user was denied
   */
  deny(username) {
    this.init();
    const name = AllowedUserStore.normalize(username);
    if (!name) return false;

    const result = this.db
      .prepare(
        `UPDATE allowed_users SET revoked_at = ?
         WHERE username = ? AND revoked_at IS NULL`,
      )
      .run(new Date().toISOString(), name);

    return result.changes > 0;
  }

  /**
   * Check whether a username is currently allowed (active, not revoked).
   * @param {string} username
   * @returns {boolean}
   */
  has(username) {
    this.init();
    const name = AllowedUserStore.normalize(username);
    if (!name) return false;

    return !!this.db
      .prepare(
        "SELECT 1 FROM allowed_users WHERE username = ? AND revoked_at IS NULL",
      )
      .get(name);
  }

  /**
   * List allowed usernames.
   * @param {boolean} [includeRevoked=false] - Include soft-deleted users
   * @returns {string[]}
   */
  list(includeRevoked = false) {
    this.init();
    const sql = includeRevoked
      ? "SELECT username FROM allowed_users ORDER BY username"
      : "SELECT username FROM allowed_users WHERE revoked_at IS NULL ORDER BY username";
    return this.db
      .prepare(sql)
      .all()
      .map((row) => row.username);
  }

  /** Number of currently active (non-revoked) allowed users. */
  count() {
    this.init();
    return this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM allowed_users WHERE revoked_at IS NULL",
      )
      .get().n;
  }

  /** Close the database connection. */
  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

// Singleton stores shared across the application.
export const sessionStore = new GroupSessionStore();
export const allowedUserStore = new AllowedUserStore();
