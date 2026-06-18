import "dotenv/config";
import { bot } from "./bot.js";
import { piAgent } from "./agent/index.js";
import { logger } from "./utils/logger.js";
/**
 * Main application entry point
 */
async function main() {
  try {
    logger.info("Starting Telegram Bot...");

    // Validate required environment variables
    if (!process.env.TELEGRAM_BOT_TOKEN) {
      throw new Error("TELEGRAM_BOT_TOKEN is required");
    }

    // Start bot
    await bot.start();

    logger.info("Bot started successfully");
    logger.info(`Environment: ${process.env.NODE_ENV}`);
    logger.info(`Log level: ${process.env.LOG_LEVEL}`);
  } catch (error) {
    logger.error("Failed to start bot:", error);
    process.exit(1);
  }
}

// Handle graceful shutdown
function shutdown(signal) {
  logger.info(`${signal} received, shutting down gracefully...`);
  bot.stop();
  piAgent.dispose();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Start the application
main();
