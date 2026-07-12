import { Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import { logger } from "../utils/logger.js";
import { allowedUserStore } from "../db/database.js";

/**
 * Message history storage
 * Maintains last N messages for context
 */
class MessageHistory {
  constructor(maxSize = 50) {
    this.maxSize = maxSize;
    this.messages = [];
  }

  /**
   * Add message to history
   */
  add(message) {
    this.messages.push({
      messageId: message.message_id,
      chatId: message.chat.id,
      userId: message.from?.id,
      username: message.from?.username,
      text: message.text || message.caption || "",
      date: message.date,
      type: message.chat.type,
      entities: message.entities || [],
      timestamp: Date.now(),
    });

    // Keep only last N messages
    if (this.messages.length > this.maxSize) {
      this.messages.shift();
    }
  }

  /**
   * Get recent messages
   * @param {number} count - Number of messages to retrieve
   * @param {number} chatId - Optional chat ID filter
   */
  getRecent(count = 50, chatId = null) {
    let filtered = this.messages;

    if (chatId) {
      filtered = this.messages.filter((msg) => msg.chatId === chatId);
    }

    return filtered.slice(-count);
  }
}

/**
 * Telegram Bot wrapper using Telegraf
 */
class TelegramBot {
  constructor(token, options = {}) {
    if (!token) {
      throw new Error("Telegram bot token is required");
    }

    this.bot = new Telegraf(token);
    this.messageHistory = new MessageHistory(options.historySize || 50);
    this.botUsername = null;
    this.isRunning = false;

    // Configure bot
    this._setupMiddleware();
  }

  /**
   * Setup middleware to track all messages
   */
  _setupMiddleware() {
    // Log all updates
    this.bot.use((ctx, next) => {
      logger.debug(`Update received: ${ctx.updateType}`, {
        chatId: ctx.chat?.id,
        chatType: ctx.chat?.type,
        from: ctx.from?.username,
        hasText: !!ctx.message?.text,
      });
      return next();
    });

    // Track all incoming messages with detailed logging for groups
    this.bot.on(message("text"), (ctx, next) => {
      const msg = ctx.message;
      this.messageHistory.add(msg);

      // Enhanced logging for group messages
      if (msg.chat.type === "group" || msg.chat.type === "supergroup") {
        logger.info("📩 Group message received", {
          chatId: msg.chat.id,
          chatTitle: msg.chat.title,
          chatType: msg.chat.type,
          from: msg.from.username || msg.from.first_name,
          text: msg.text?.substring(0, 100),
          hasEntities: !!(msg.entities && msg.entities.length > 0),
          entities: msg.entities?.map((e) => e.type) || [],
        });

        // Log all mentions in the message
        if (msg.entities) {
          const mentions = msg.entities.filter(
            (e) => e.type === "mention" || e.type === "text_mention",
          );
          if (mentions.length > 0) {
            logger.info("👤 Mentions detected in group", {
              chatId: msg.chat.id,
              mentionCount: mentions.length,
              mentions: mentions.map((m) => ({
                type: m.type,
                text: msg.text.substring(m.offset, m.offset + m.length),
              })),
            });
          }
        }
      } else {
        logger.debug(
          `Message stored in history: ${msg.text?.substring(0, 50)}...`,
        );
      }

      return next();
    });

    // Handle errors
    this.bot.catch((err, ctx) => {
      logger.error("Bot error:", err);
      logger.error("Error context:", {
        updateType: ctx.updateType,
        chatId: ctx.chat?.id,
      });
    });
  }

  /**
   * Register handler for when bot is mentioned
   * @param {Function} handler - Handler function
   */
  onMention(handler) {
    logger.info("Registering mention handler");

    this.bot.on(message("text"), async (ctx, next) => {
      try {
        const mentions = ctx.entities("mention", "text_mention");
        const text = ctx.message.text || "";
        const chatType = ctx.chat.type;
        const isPrivateChat = chatType === "private";

        // Never let the agent process bot commands (messages like "/allow ...").
        // Registered commands (/allow, /deny, /allowlist) are intercepted by
        // their own handlers earlier in the middleware chain; this guard ensures
        // that even unregistered commands are ignored here instead of being sent
        // to the agent for a response.
        const isBotCommand =
          (ctx.message.entities || []).some(
            (e) => e.type === "bot_command" && e.offset === 0,
          ) || text.startsWith("/");
        if (isBotCommand) {
          logger.debug("⏭️  Skipping bot command in agent handler", {
            chatId: ctx.chat.id,
            text: text.substring(0, 50),
          });
          return next();
        }

        // Allowlist gating: the bot only serves users on the allowlist, which is
        // the UNION of two sources:
        //   1. the AVAILABLE env var (comma-separated bootstrap allowlist), and
        //   2. the database-backed allowlist managed at runtime via /allow & /deny.
        // A user is permitted if they appear in either source. Determine whether
        // this message is even directed at the bot (DM, or mention in a group)
        // before gating.
        const envUsernames = (process.env.AVAILABLE || "")
          .split(",")
          .map((u) => u.trim().toLowerCase())
          .filter(Boolean);
        const dbUsernames = allowedUserStore
          .list()
          .map((u) => u.trim().toLowerCase())
          .filter(Boolean);
        const allowedUsernames = [...new Set([...envUsernames, ...dbUsernames])];
        const senderUsername = (ctx.from?.username || "").toLowerCase();

        if (allowedUsernames.length) {
          const botTargeted =
            isPrivateChat || this._isBotMentioned(mentions, text, chatType);

          if (botTargeted && !allowedUsernames.includes(senderUsername)) {
            logger.info("🚫 Blocked non-allowlisted user", {
              chatId: ctx.chat.id,
              chatType,
              from: senderUsername || ctx.from?.first_name,
              allowedUsernames,
            });

            await ctx.reply(
              `I'm still on private test, only serving ${allowedUsernames.join(", ")}, sorry for the inconvenience`,
              { reply_to_message_id: ctx.message.message_id },
            );
            return next();
          }
        }

        // In direct (private) messages the bot always responds,
        // regardless of whether it was mentioned.
        if (isPrivateChat) {
          logger.info("💬 Direct message received - responding without mention", {
            chatId: ctx.chat.id,
            from: ctx.from.username || ctx.from.first_name,
            text: text.substring(0, 100),
          });

          await handler(ctx.message, ctx, mentions);
          return next();
        }

        // Log mention detection process for groups/supergroups
        if (chatType === "group" || chatType === "supergroup") {
          logger.debug("🔍 Checking for bot mentions in group message", {
            chatId: ctx.chat.id,
            chatTitle: ctx.chat.title,
            botUsername: this.botUsername,
            messageText: text.substring(0, 100),
            mentionEntities: mentions.map((m) => m.fragment),
          });
        }

        if (this._isBotMentioned(mentions, text, chatType)) {
          logger.info("🤖 BOT WAS MENTIONED!", {
            chatId: ctx.chat.id,
            chatType: ctx.chat.type,
            chatTitle: ctx.chat.title,
            from: ctx.from.username || ctx.from.first_name,
            text: text.substring(0, 100),
            mentions: mentions.map((m) => m.fragment),
          });

          await handler(ctx.message, ctx, mentions);
        } else if (chatType === "group" || chatType === "supergroup") {
          logger.debug("❌ No bot mention detected in group message");
        }
      } catch (error) {
        logger.error("Error in mention handler:", error);
      }
      return next();
    });
  }

  /**
   * Determine whether the bot is mentioned in a message.
   * @param {Array} mentions - Mention entities from ctx.entities()
   * @param {string} text - Message text
   * @param {string} chatType - Telegram chat type
   * @returns {boolean}
   */
  _isBotMentioned(mentions, text, chatType) {
    // Check if bot is mentioned via entity
    const botMentioned = mentions.some((entity) => {
      const mentionText = entity.fragment;
      const isBotMention = mentionText.includes(this.botUsername);

      if (chatType === "group" || chatType === "supergroup") {
        logger.debug("🔎 Checking mention entity", {
          fragment: mentionText,
          botUsername: this.botUsername,
          matches: isBotMention,
        });
      }

      return isBotMention;
    });

    // Also check direct bot mentions in text (case-insensitive)
    const directMention =
      this.botUsername &&
      (text.toLowerCase().includes(`@${this.botUsername.toLowerCase()}`) ||
        text.toLowerCase().includes(this.botUsername.toLowerCase()));

    return botMentioned || directMention;
  }

  /**
   * Get recent messages from history
   * @param {number} count - Number of messages to retrieve
   * @param {number} chatId - Optional chat ID filter
   */
  getRecentMessages(count = 50, chatId = null) {
    return this.messageHistory.getRecent(count, chatId);
  }

  /**
   * Start bot polling
   */
  async startPolling() {
    if (this.isRunning) {
      logger.warn("Bot is already running");
      return;
    }

    try {
      // Get bot info
      const botInfo = await this.bot.telegram.getMe();
      this.botUsername = botInfo.username;

      logger.info("Bot info:", {
        id: botInfo.id,
        username: botInfo.username,
        firstName: botInfo.first_name,
      });

      // Launch bot.
      // NOTE: bot.launch() resolves only when the bot STOPS, so we must NOT
      // await it here — otherwise execution blocks and no further code runs.
      this.bot.launch().catch((error) => {
        logger.error("Bot polling crashed:", error);
      });
      this.isRunning = true;

      logger.info("Bot started polling for updates");
    } catch (error) {
      logger.error("Failed to start bot polling:", error);
      throw error;
    }
  }

  /**
   * Stop bot polling
   */
  async stopPolling() {
    if (!this.isRunning) {
      logger.warn("Bot is not running");
      return;
    }

    try {
      await this.bot.stop();
      this.isRunning = false;
      logger.info("Bot stopped polling");
    } catch (error) {
      logger.error("Error stopping bot:", error);
      throw error;
    }
  }

  /**
   * Get bot instance (for advanced usage)
   */
  getInstance() {
    return this.bot;
  }
}

/**
 * Create and configure bot instance
 * @param {object} options - Bot configuration options
 * @returns {TelegramBot} Bot instance
 */
export function createBot(options = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN environment variable is required");
  }

  const bot = new TelegramBot(token, {
    historySize: options.historySize || 50,
    ...options,
  });

  logger.info("Telegraf bot instance created");

  return bot;
}

// Export classes for testing/advanced usage
export { TelegramBot, MessageHistory };
