import { Telegraf } from "telegraf";

/**
 * Registers an extension hook so tools can resolve telegram file metadata.
 * @param {import("@earendil-works/pi-coding-agent").AgentSession} session
 * @param {Telegraf} telegraf
 */
export function registerTelegramHooks(session, telegraf) {
  if (!telegraf) {
    throw new Error("registerTelegramHooks requires a Telegraf instance");
  }

  if (session.extensions.has("session_fetch_telegram_file")) {
    return;
  }

  session.extensions.register(
    "session_fetch_telegram_file",
    async (fileId) => {
      if (!fileId) {
        throw new Error("telegram fileId is required");
      }
      const file = await telegraf.telegram.getFile(fileId);
      return file;
    },
  );
}
