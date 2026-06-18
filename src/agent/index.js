import { PiAgent } from "./agent.js";

/**
 * Singleton Pi Agent instance for the Telegram bot
 * 
 * Usage:
 * ```js
 * import { piAgent } from './agent/index.js';
 * import { getAgentOptions } from './agent/config.js';
 * 
 * // Initialize once
 * await piAgent.initialize(getAgentOptions());
 * 
 * // Use in handlers
 * const response = await piAgent.processMessage(userQuery, {
 *   recentMessages,
 *   chatType,
 *   username,
 *   chatTitle
 * });
 * ```
 */
export const piAgent = new PiAgent();

// Export for direct class usage if needed
export { PiAgent } from "./agent.js";
export { getAgentOptions } from "./config.js";
