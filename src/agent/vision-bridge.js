import { getImagePayloads } from "./vision-store.js";

/**
 * Event names shared with extensions/vision-openrouter.
 * The pi event bus is fire-and-forget, so callers include resolve/reject
 * callbacks in the event payload for request/response behavior.
 */
export const VISION_EVENTS = {
  FETCH_IMAGE_PAYLOADS: "telebot:vision:fetch_image_payloads",
  FETCH_TELEGRAM_FILE: "telebot:vision:fetch_telegram_file",
};

function resolveRequest(request, value) {
  if (typeof request?.resolve === "function") {
    request.resolve(value);
  }
}

function rejectRequest(request, error) {
  if (typeof request?.reject === "function") {
    request.reject(error);
  }
}

/**
 * Register bot-side event handlers used by vision extensions.
 * @param {object} options
 * @param {import("@earendil-works/pi-coding-agent").EventBus} options.eventBus
 * @param {import("telegraf").Telegraf} options.telegraf
 * @returns {Array<Function>} unsubscribe callbacks
 */
export function registerVisionBridge({ eventBus, telegraf }) {
  if (!eventBus) {
    throw new Error("registerVisionBridge requires an eventBus");
  }
  if (!telegraf?.telegram) {
    throw new Error("registerVisionBridge requires a Telegraf instance");
  }

  const unsubscribePayloads = eventBus.on(
    VISION_EVENTS.FETCH_IMAGE_PAYLOADS,
    (request = {}) => {
      try {
        const ids = Array.isArray(request.ids) ? request.ids : [];
        const payloads = getImagePayloads(ids, { consume: false });
        resolveRequest(request, payloads);
      } catch (error) {
        rejectRequest(request, error);
      }
    },
  );

  const unsubscribeTelegramFile = eventBus.on(
    VISION_EVENTS.FETCH_TELEGRAM_FILE,
    async (request = {}) => {
      try {
        if (!request.fileId) {
          throw new Error("telegram fileId is required");
        }
        const file = await telegraf.telegram.getFile(request.fileId);
        resolveRequest(request, file);
      } catch (error) {
        rejectRequest(request, error);
      }
    },
  );

  return [unsubscribePayloads, unsubscribeTelegramFile];
}
