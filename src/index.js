import "dotenv/config";
import { bot } from "./bot.js";
import { piAgent } from "./agent/index.js";
import { logger } from "./utils/logger.js";
import { reminderScheduler } from "./reminders/reminder-scheduler.js";
import { reminderService } from "./reminders/reminder-service.js";
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

    // Initialize reminder subsystem
    await reminderService.initialize();

    // Start bot first so Telegram API is ready before reminders fire
    await bot.start();

    // Start reminder scheduler after bot is ready
    await reminderScheduler.start();

    logger.info("Bot and reminder scheduler started successfully");
    logger.info(`Environment: ${process.env.NODE_ENV}`);
    logger.info(`Log level: ${process.env.LOG_LEVEL}`);
  } catch (error) {
    logger.error("Failed to start bot:", error);
    process.exit(1);
  }
}

// Handle graceful shutdown
async function shutdown(signal) {
  logger.info(`${signal} received, shutting down gracefully...`);
  try {
    await bot.stop();
  } catch (error) {
    logger.error("Error stopping bot", error);
  }

  try {
    await reminderScheduler.stop();
  } catch (error) {
    logger.error("Error stopping reminder scheduler", error);
  }

  try {
    await piAgent.dispose();
  } catch (error) {
    logger.error("Error disposing agent", error);
  }

  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Start the application
main();
