import { registerVisionBridge } from "../vision-bridge.js";

/**
 * Backward-compatible wrapper for older code paths.
 * New integrations should call PiAgent.registerTelegramBridge(telegraf).
 */
export function registerTelegramHooks({ eventBus }, telegraf) {
  return registerVisionBridge({ eventBus, telegraf });
}
