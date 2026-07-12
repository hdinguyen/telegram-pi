import { mentionHandler } from "./mention.js";
import { registerAdminCommands } from "./admin.js";
import { logger } from "../utils/logger.js";

/**
 * Register all bot handlers
 */
export function registerHandlers(bot) {
  logger.info("Registering bot handlers...");

  // Register access-control commands (/allow, /deny, /allowlist).
  // Commands are registered before the catch-all mention handler so they
  // take precedence over generic text handling.
  registerAdminCommands(bot);

  // Register mention handler
  bot.onMention(mentionHandler);

  logger.info("All handlers registered");
}
