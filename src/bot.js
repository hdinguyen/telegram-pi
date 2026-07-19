import { createBot } from "./core/telegram.js";
import { registerHandlers } from "./handlers/index.js";
import { piAgent } from "./agent/index.js";
import { getAgentOptions } from "./agent/config.js";
import { logger } from "./utils/logger.js";

/**
 * Initialize and configure the Telegram bot
 */
class TeleBot {
  constructor() {
    this.bot = null;
    this.isRunning = false;
  }

  async start() {
    if (this.isRunning) {
      logger.warn("Bot is already running");
      return;
    }

    try {
      // Create bot instance
      this.bot = createBot({
        historySize: 50, // Track last 50 messages
      });

      // Initialize Pi agent once bot is ready
      await piAgent.initialize(getAgentOptions());

      // Register the bot-side bridge used by vision extensions to resolve
      // Telegram file metadata when the agent calls openrouter_vision.
      const telegraf = this.bot.getInstance();
      piAgent.registerTelegramBridge(telegraf);

      // Add middleware to attach recent messages to context
      this._setupContextEnhancement();

      // Register handlers on the TelegramBot wrapper so handler modules can
      // access wrapper helpers such as onMention() and getInstance().
      registerHandlers(this.bot);

      // Start polling
      await this.bot.startPolling();
      this.isRunning = true;

      logger.info("Bot polling started successfully");
    } catch (error) {
      logger.error("Failed to start bot:", error);
      throw error;
    }
  }

  /**
   * Setup middleware to enhance context with recent messages and bot info
   */
  _setupContextEnhancement() {
    const telegrafBot = this.bot.getInstance();

    telegrafBot.use((ctx, next) => {
      // Attach recent messages to context for handlers
      ctx.recentMessages = this.bot.getRecentMessages(50, ctx.chat?.id);
      // Attach bot info for mention handlers
      ctx.botUsername = this.bot.botUsername;
      return next();
    });
  }

  async stop() {
    if (!this.isRunning) {
      logger.warn("Bot is not running");
      return;
    }

    try {
      await this.bot.stopPolling();
      this.isRunning = false;
      logger.info("Bot stopped successfully");
    } catch (error) {
      logger.error("Error stopping bot:", error);
    }
  }

  /**
   * Get bot instance (for advanced usage)
   */
  getBot() {
    return this.bot;
  }
}

// Export singleton instance
export const bot = new TeleBot();
