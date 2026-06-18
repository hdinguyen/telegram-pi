import { mentionHandler } from "./mention.js";
import { logger } from "../utils/logger.js";

/**
 * Register all bot handlers
 */
export function registerHandlers(bot) {
  logger.info("Registering bot handlers...");

  // Register mention handler
  bot.onMention(mentionHandler);

  logger.info("All handlers registered");
}
