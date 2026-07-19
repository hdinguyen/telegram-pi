export function createExtensionHooks({ telegramBot }) {
  if (!telegramBot) {
    throw new Error("telegramBot instance is required");
  }

  return {
    async fetchTelegramFile(fileId) {
      return telegramBot.telegram.getFile(fileId);
    },
  };
}
