import { getImagePayloads } from "../vision-store.js";

/**
 * Registers internal extension hooks for sharing Telegram image metadata
 * with project extensions (e.g. OpenRouter vision tool).
 */
export function registerImageHooks(session) {
  // Provide a hook the extension can call to read stored payloads
  session.extensions.register("session_fetch_image_payloads", async (ids) => {
    if (!Array.isArray(ids)) {
      return [];
    }
    return getImagePayloads(ids, { consume: false });
  });
}
