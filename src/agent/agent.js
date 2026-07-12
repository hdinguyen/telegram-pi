import {
  createAgentSession,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync } from "node:fs";
import { logger } from "../utils/logger.js";
import { sessionStore } from "../db/database.js";

/**
 * Pi Agent wrapper for Telegram bot integration.
 *
 * Sessions are isolated per Telegram group (chat_id):
 *   - First message from a group  -> a new SessionManager is created and its
 *     session file path is recorded in SQLite (group_sessions table).
 *   - Subsequent messages         -> the in-memory session is reused.
 *   - After a restart             -> the session file path is looked up in
 *     SQLite and the conversation is resumed via SessionManager.open().
 *
 * This replaces the previous design where one global session was shared by
 * every chat, which leaked context across unrelated groups.
 */
export class PiAgent {
  constructor() {
    this.loader = null;
    this.cwd = null;
    this.sessionDir = null;
    this.store = sessionStore;
    this.isInitialized = false;

    // chatId (string) -> { session, sessionManager }
    this.sessions = new Map();
  }

  /**
   * Initialize shared resources (resource loader, session dir, database).
   * The actual per-group agent sessions are created lazily on demand.
   * @param {Object} options - Configuration options from getAgentOptions()
   */
  async initialize(options) {
    if (this.isInitialized) {
      logger.warn("Agent already initialized");
      return;
    }

    try {
      const { loader, cwd, sessionDir } = options;
      this.loader = loader;
      this.cwd = cwd;
      this.sessionDir = sessionDir;

      // Ensure the directory that holds per-group session files exists.
      if (!existsSync(this.sessionDir)) {
        mkdirSync(this.sessionDir, { recursive: true });
      }

      // Open / create the SQLite database for group -> session mappings.
      this.store.init();

      // Reload to discover skills and load prompts (shared by all sessions).
      await this.loader.reload();

      const { skills, diagnostics } = this.loader.getSkills();
      logger.info(
        "Loaded skills:",
        skills.map((s) => s.name),
      );
      if (diagnostics.length > 0) {
        logger.warn("Skill diagnostics:", diagnostics);
      }

      this.isInitialized = true;
      logger.info(
        `✅ Pi Agent initialized (per-group sessions, ${this.store.count()} known group(s))`,
      );
    } catch (error) {
      logger.error("Failed to initialize Pi Agent:", error);
      throw error;
    }
  }

  /**
   * Get (or lazily create / resume) the agent session for a group.
   * @param {string|number} chatId - Telegram chat/group id
   * @param {Object} meta - { chatTitle, chatType } used for new sessions
   * @returns {Promise<{session: object, sessionManager: object}>}
   * @private
   */
  async _getOrCreateSession(chatId, meta = {}) {
    const key = String(chatId);

    // 1. Reuse an already-live session for this group.
    const cached = this.sessions.get(key);
    if (cached) {
      return cached;
    }

    // 2. Look up a persisted session mapping in SQLite.
    const record = this.store.get(key);
    let sessionManager;
    let resumed = false;

    if (record && record.session_file && existsSync(record.session_file)) {
      // Resume the existing conversation for this group.
      sessionManager = SessionManager.open(
        record.session_file,
        this.sessionDir,
      );
      resumed = true;
      logger.info(
        `🔄 Resuming session for chat ${key} from ${record.session_file}`,
      );
    } else {
      // Brand new group (or the file went missing) -> start fresh.
      sessionManager = SessionManager.create(this.cwd, this.sessionDir);
      logger.info(
        `🆕 Creating new session for chat ${key} at ${sessionManager.getSessionFile()}`,
      );
    }

    // 3. Build an agent session bound to this group's SessionManager.
    const { session } = await createAgentSession({
      resourceLoader: this.loader,
      sessionManager,
    });

    // 4. Persist / refresh the group -> session-file mapping.
    this.store.upsert(key, sessionManager.getSessionFile(), {
      sessionId: sessionManager.getSessionId(),
      chatTitle: meta.chatTitle,
      chatType: meta.chatType,
    });

    const entry = { session, sessionManager };
    this.sessions.set(key, entry);

    logger.debug(
      `Session ready for chat ${key} (${resumed ? "resumed" : "new"}), ` +
        `${this.sessions.size} live session(s)`,
    );

    return entry;
  }

  /**
   * Process a user message through the agent for a specific group.
   * @param {string|number} chatId - Telegram chat/group id (session key)
   * @param {string} query - User's message/query
   * @param {Object} context - Additional context (chat history, user info, etc.)
   * @returns {Promise<{text: string, tools: Array}>} - Agent response
   */
  async processMessage(chatId, query, context = {}) {
    if (!this.isInitialized) {
      throw new Error("Agent not initialized. Call initialize() first.");
    }

    const { session, sessionManager } = await this._getOrCreateSession(chatId, {
      chatTitle: context.chatTitle,
      chatType: context.chatType,
    });

    try {
      logger.debug("Processing message with context", {
        chatId: String(chatId),
        query: query.substring(0, 100),
        contextKeys: Object.keys(context),
      });

      const enhancedPrompt = this._buildPromptWithContext(query, context);

      let responseText = "";
      const toolsUsed = [];

      const unsubscribe = session.subscribe((event) => {
        if (
          event.type === "message_update" &&
          event.assistantMessageEvent.type === "text_delta"
        ) {
          responseText += event.assistantMessageEvent.delta;
        } else if (
          event.type === "message_update" &&
          event.assistantMessageEvent.type === "tool_use"
        ) {
          toolsUsed.push({
            tool: event.assistantMessageEvent.name,
            id: event.assistantMessageEvent.id,
          });
        }
      });

      await session.prompt(enhancedPrompt);

      unsubscribe();

      // Record recent activity for this group.
      this.store.touch(chatId);

      logger.debug("Agent response received", {
        chatId: String(chatId),
        sessionFile: sessionManager.getSessionFile(),
        responseLength: responseText.length,
        toolsCount: toolsUsed.length,
      });

      return {
        text: responseText.trim(),
        tools: toolsUsed,
      };
    } catch (error) {
      logger.error(`Error processing message for chat ${chatId}:`, error);
      throw error;
    }
  }

  /**
   * Build a prompt that includes conversation context
   * @private
   */
  _buildPromptWithContext(query, context) {
    const parts = [];

    if (context.chatType || context.chatTitle) {
      parts.push(
        `[Chat: ${context.chatTitle || "Direct Message"} (${context.chatType || "private"})]`,
      );
    }

    if (context.username) {
      parts.push(`[From: ${context.username}]`);
    }

    if (context.recentMessages && context.recentMessages.length > 0) {
      parts.push("\n<conversation_history>");
      const recent = context.recentMessages.slice(-10);
      for (const msg of recent) {
        const sender = msg.from?.username || msg.from?.first_name || "User";
        const text = msg.text || "[media]";
        parts.push(`${sender}: ${text}`);
      }
      parts.push("</conversation_history>\n");
    }

    parts.push(`\nUser query: ${query}`);

    return parts.join("\n");
  }

  /**
   * Reload skills/resources without restarting the process.
   * Existing live sessions must be reloaded so their system prompts are rebuilt
   * with the newly discovered skill list. If no sessions are live yet, reload
   * only the shared resource loader; future sessions will use the new skills.
   * @returns {Promise<{skills: string[], diagnostics: Array, reloadedSessions: number}>}
   */
  async reloadSkills() {
    if (!this.isInitialized) {
      throw new Error("Agent not initialized. Call initialize() first.");
    }

    let reloadedSessions = 0;

    if (this.sessions.size === 0) {
      await this.loader.reload();
    } else {
      for (const [chatId, entry] of this.sessions) {
        logger.info(`Reloading agent resources for chat ${chatId}`);
        await entry.session.reload();
        reloadedSessions += 1;
      }
    }

    const { skills, diagnostics } = this.loader.getSkills();
    const skillNames = skills.map((s) => s.name);

    logger.info("Reloaded skills:", skillNames);
    if (diagnostics.length > 0) {
      logger.warn("Skill reload diagnostics:", diagnostics);
    }

    return {
      skills: skillNames,
      diagnostics,
      reloadedSessions,
    };
  }

  /**
   * Dispose a single group's live session (keeps the persisted file on disk).
   * @param {string|number} chatId
   */
  disposeSession(chatId) {
    const key = String(chatId);
    const entry = this.sessions.get(key);
    if (entry) {
      entry.session.dispose();
      this.sessions.delete(key);
      logger.info(`Disposed live session for chat ${key}`);
    }
  }

  /**
   * Dispose all live sessions and close the database.
   */
  dispose() {
    for (const [key, entry] of this.sessions) {
      try {
        entry.session.dispose();
      } catch (error) {
        logger.warn(`Error disposing session ${key}:`, error);
      }
    }
    this.sessions.clear();
    this.store.close();
    this.isInitialized = false;
    logger.info("All agent sessions disposed");
  }

  /**
   * Get agent status information
   */
  getStatus() {
    return {
      initialized: this.isInitialized,
      liveSessions: this.sessions.size,
      knownGroups: this.isInitialized ? this.store.count() : 0,
      sessionDir: this.sessionDir,
      skills:
        this.loader?.getSkills().skills.map((s) => ({
          name: s.name,
          description: s.description,
        })) || [],
    };
  }
}
