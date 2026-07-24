import { bot } from "../bot.js";
import { reminderStore } from "./reminder-store.js";
import { logger } from "../utils/logger.js";

const DEFAULT_ACK_TIMEOUT_SECONDS = 600; // 10 minutes

export class ReminderService {
  constructor() {
    this.scheduler = null;
  }

  registerScheduler(scheduler) {
    logger.info("Reminder scheduler registered", {
      scheduler: scheduler?.constructor?.name,
    });
    this.scheduler = scheduler;
  }

  async initialize() {
    // No-op for now; schema is initialized by ReminderStore constructor
    return this;
  }

  _ensureScheduler() {
    if (!this.scheduler) {
      throw new Error("Reminder scheduler not registered");
    }
  }

  createReminder({
    chatId,
    createdBy,
    title,
    message,
    isRecurring = false,
    cronExpression,
    runAt,
    ackTimeoutSeconds = DEFAULT_ACK_TIMEOUT_SECONDS,
    repeatUntilAck = true,
    maxRetries = -1,
    timezone = "local",
    meta,
  }) {
    const type = isRecurring ? "cron" : "once";

    if (!message) {
      throw new Error("Reminder message is required");
    }

    if (type === "cron" && !cronExpression) {
      throw new Error("cronExpression is required for recurring reminders");
    }

    if (type === "once" && !runAt) {
      throw new Error("runAt is required for one-time reminders");
    }

    const reminder = reminderStore.createReminder({
      chatId,
      createdBy,
      title,
      message,
      type,
      cronExpression,
      runAt,
      timezone,
      ackTimeoutSeconds,
      repeatUntilAck,
      maxRetries,
      meta,
    });

    this._ensureScheduler();
    this.scheduler.scheduleReminder(reminder).catch((error) => {
      logger.error("Failed to schedule reminder", { reminderId: reminder.id, error });
    });

    logger.info("Created reminder", {
      reminderId: reminder.id,
      chatId,
      type,
      cronExpression,
      runAt,
    });

    return reminder;
  }

  async deleteReminder(reminderId, { hardDelete = false } = {}) {
    const reminder = reminderStore.getReminderById(reminderId);
    if (!reminder) {
      return false;
    }

    this._ensureScheduler();
    await this.scheduler.unscheduleReminder(reminderId);

    if (hardDelete) {
      reminderStore.hardDeleteReminder(reminderId);
    } else {
      reminderStore.deactivateReminder(reminderId);
    }

    reminderStore.cancelPendingOccurrencesByReminder(reminderId);

    logger.info("Deleted reminder", { reminderId, hardDelete });
    return true;
  }

  listReminders(chatId) {
    return reminderStore.listRemindersByChat(chatId);
  }

  async triggerReminder(reminderId) {
    const reminder = reminderStore.getReminderById(reminderId);
    if (!reminder || !reminder.active) {
      logger.info("Reminder inactive or missing; not sending", { reminderId });
      return;
    }

    const occurrence = reminderStore.createOccurrence({
      reminderId,
      scheduledFor: new Date().toISOString(),
    });

    try {
      const inlineKeyboard = [[
        {
          text: "✅ Taken",
          callback_data: `reminder:ack:${occurrence.id}`,
        },
      ]];

      const message = await bot.getInstance().telegram.sendMessage(
        reminder.chat_id,
        reminder.message,
        {
          reply_markup: {
            inline_keyboard: inlineKeyboard,
          },
        },
      );

      reminderStore.updateOccurrenceAfterSend(occurrence.id, {
        messageId: message.message_id,
        sentAt: new Date().toISOString(),
        retryCount: occurrence.retry_count,
        lastRetryAt: null,
      });

      reminderStore.touchReminder(reminderId);

      const ackTimeoutSeconds = reminder.ack_timeout_seconds ?? DEFAULT_ACK_TIMEOUT_SECONDS;
      if (ackTimeoutSeconds > 0 && reminder.repeat_until_ack) {
        this._ensureScheduler();
        this.scheduler
          .scheduleFollowup(occurrence.id, ackTimeoutSeconds * 1000)
          .catch((error) => {
            logger.error("Failed to schedule follow-up", {
              occurrenceId: occurrence.id,
              error,
            });
          });
      }

      logger.info("Sent reminder", {
        reminderId,
        occurrenceId: occurrence.id,
        messageId: message.message_id,
      });
    } catch (error) {
      logger.error("Failed to send reminder", { reminderId, error });
      reminderStore.updateOccurrenceStatus(occurrence.id, "error", error.message);
    }
  }

  async triggerFollowup(occurrenceId) {
    const occurrence = reminderStore.getOccurrenceById(occurrenceId);
    if (!occurrence || occurrence.status !== "pending") {
      logger.info("Follow-up cancelled; occurrence not pending", {
        occurrenceId,
        status: occurrence?.status,
      });
      return;
    }

    const reminder = reminderStore.getReminderById(occurrence.reminder_id);
    if (!reminder || !reminder.active) {
      logger.info("Follow-up cancelled; reminder inactive", {
        occurrenceId,
        reminderId: reminder?.id,
      });
      reminderStore.updateOccurrenceStatus(occurrenceId, "cancelled");
      return;
    }

    try {
      const inlineKeyboard = [[
        {
          text: "✅ Taken",
          callback_data: `reminder:ack:${occurrence.id}`,
        },
      ]];

      const message = await bot.getInstance().telegram.sendMessage(
        reminder.chat_id,
        reminder.message,
        {
          reply_markup: {
            inline_keyboard: inlineKeyboard,
          },
        },
      );

      const retryCount = occurrence.retry_count + 1;
      reminderStore.updateOccurrenceAfterSend(occurrenceId, {
        messageId: message.message_id,
        sentAt: new Date().toISOString(),
        retryCount,
        lastRetryAt: new Date().toISOString(),
      });

      const ackTimeoutSeconds = reminder.ack_timeout_seconds ?? DEFAULT_ACK_TIMEOUT_SECONDS;
      const shouldRepeat = reminder.repeat_until_ack && (reminder.max_retries < 0 || retryCount <= reminder.max_retries);

      if (shouldRepeat && ackTimeoutSeconds > 0) {
        this._ensureScheduler();
        this.scheduler
          .scheduleFollowup(occurrenceId, ackTimeoutSeconds * 1000)
          .catch((error) => {
            logger.error("Failed to re-schedule follow-up", {
              occurrenceId,
              error,
            });
          });
      } else {
        this.scheduler?.cancelFollowup(occurrenceId, { clearStore: true });
      }

      logger.info("Sent follow-up reminder", {
        reminderId: reminder.id,
        occurrenceId,
        messageId: message.message_id,
        retryCount,
      });
    } catch (error) {
      logger.error("Failed to send follow-up reminder", {
        occurrenceId,
        error,
      });
      reminderStore.updateOccurrenceStatus(occurrenceId, "error", error.message);
    }
  }

  acknowledgeOccurrence(occurrenceId) {
    const { changed, occurrence } = reminderStore.markOccurrenceAcknowledged(
      occurrenceId,
    );
    if (!changed) {
      return { changed: false };
    }

    this._ensureScheduler();
    this.scheduler.cancelFollowup(occurrenceId, { clearStore: true });

    logger.info("Reminder marked as taken", {
      occurrenceId,
      reminderId: occurrence?.reminder_id,
    });

    return { changed: true, occurrence };
  }
}

export const reminderService = new ReminderService();
