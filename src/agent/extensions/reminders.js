import { Type } from "typebox";
import { reminderService } from "../../reminders/reminder-service.js";
import { reminderScheduler } from "../../reminders/reminder-scheduler.js";
import { logger } from "../../utils/logger.js";

const ChatIdSchema = Type.Union([
  Type.String({ description: "Telegram chat identifier" }),
  Type.Number({ description: "Telegram chat identifier" }),
]);

function normalizeChatId(raw) {
  if (typeof raw === "number") return raw;
  if (typeof raw === "string" && /^-?\d+$/.test(raw)) {
    return Number(raw);
  }
  return raw;
}

export default function reminderExtension(pi) {
  // Ensure the reminder scheduler is initialized so the reminderService has a registered scheduler.
  if (!reminderService.scheduler) {
    logger.debug("Reminder scheduler not initialized; starting now for extension context");
    reminderScheduler.start().catch((error) => {
      logger.error("Failed to start reminder scheduler from reminders extension", error);
    });
  }

  pi.registerTool({
    name: "reminder_list",
    label: "List reminders",
    description:
      "List active reminders for the provided Telegram chat identifier.",
    parameters: Type.Object({
      chatId: ChatIdSchema,
    }),
    async execute(_toolCallId, params) {
      const chatId = normalizeChatId(params.chatId);
      const reminders = reminderService.listReminders(chatId);

      if (!Array.isArray(reminders) || reminders.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No active reminders for this chat.",
            },
          ],
        };
      }

      const lines = reminders.map((reminder) => {
        const schedule =
          reminder.type === "cron"
            ? `[cron ${reminder.cron_expression}]`
            : reminder.type === "once" && reminder.run_at
              ? `[once ${reminder.run_at}]`
              : "";
        return `#${reminder.id} ${schedule} ${reminder.message}`.trim();
      });

      return {
        content: [
          {
            type: "text",
            text: lines.join("\n"),
          },
        ],
      };
    },
  });

  pi.registerTool({
    name: "reminder_create",
    label: "Create reminder",
    description:
      "Create a reminder. Provide chatId, message, and schedule parameters (daily, once, or cron).",
    parameters: Type.Object({
      chatId: ChatIdSchema,
      message: Type.String({ minLength: 1 }),
      schedule: Type.Union([
        Type.Object({
          type: Type.Literal("daily"),
          time: Type.String({
            pattern: "^([01]?\\d|2[0-3]):([0-5]\\d)$",
            description: "HH:MM in 24-hour format",
          }),
        }),
        Type.Object({
          type: Type.Literal("once"),
          runAt: Type.String({
            description: "ISO-8601 date/time string",
          }),
        }),
        Type.Object({
          type: Type.Literal("cron"),
          cronExpression: Type.String({
            description: "Cron expression",
          }),
        }),
      ]),
      ackTimeoutSeconds: Type.Optional(
        Type.Number({ minimum: 0, maximum: 24 * 60 * 60 }),
      ),
      repeatUntilAck: Type.Optional(Type.Boolean()),
      maxRetries: Type.Optional(Type.Integer({ minimum: -1 })),
      timezone: Type.Optional(Type.String()),
      title: Type.Optional(Type.String()),
      createdBy: Type.Optional(Type.String()),
      meta: Type.Optional(Type.Any()),
    }),
    async execute(_toolCallId, params) {
      try {
        const chatId = normalizeChatId(params.chatId);
        const base = {
          chatId,
          message: params.message,
          ackTimeoutSeconds: params.ackTimeoutSeconds,
          repeatUntilAck: params.repeatUntilAck,
          maxRetries: params.maxRetries,
          timezone: params.timezone,
          title: params.title,
          createdBy: params.createdBy,
          meta: params.meta,
        };

        let reminder;
        if (params.schedule.type === "daily") {
          const [hour, minute] = params.schedule.time.split(":");
          reminder = reminderService.createReminder({
            ...base,
            isRecurring: true,
            cronExpression: `${minute} ${hour} * * *`,
            meta: {
              ...(params.meta || {}),
              schedule: {
                type: "daily",
                time: params.schedule.time,
              },
            },
          });
        } else if (params.schedule.type === "once") {
          reminder = reminderService.createReminder({
            ...base,
            isRecurring: false,
            runAt: params.schedule.runAt,
            meta: {
              ...(params.meta || {}),
              schedule: {
                type: "once",
                runAt: params.schedule.runAt,
              },
            },
          });
        } else {
          reminder = reminderService.createReminder({
            ...base,
            isRecurring: true,
            cronExpression: params.schedule.cronExpression,
            meta: params.meta,
          });
        }

        return {
          content: [
            {
              type: "text",
              text: `Reminder created with id ${reminder.id}`,
            },
          ],
          details: reminder,
        };
      } catch (error) {
        logger.error("reminder_create tool failed", error);
        return {
          content: [
            {
              type: "text",
              text: `Failed to create reminder: ${error instanceof Error ? error.message : error}`,
            },
          ],
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: "reminder_delete",
    label: "Delete reminder",
    description: "Deactivate or remove a reminder by id.",
    parameters: Type.Object({
      reminderId: Type.Integer({ minimum: 1 }),
      hardDelete: Type.Optional(Type.Boolean()),
    }),
    async execute(_toolCallId, params) {
      try {
        const deleted = await reminderService.deleteReminder(
          params.reminderId,
          { hardDelete: params.hardDelete ?? false },
        );

        if (!deleted) {
          return {
            content: [
              {
                type: "text",
                text: `Reminder ${params.reminderId} not found.`,
              },
            ],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: "text",
              text: `Reminder ${params.reminderId} deleted.`,
            },
          ],
        };
      } catch (error) {
        logger.error("reminder_delete tool failed", error);
        return {
          content: [
            {
              type: "text",
              text: `Failed to delete reminder: ${error instanceof Error ? error.message : error}`,
            },
          ],
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: "reminder_acknowledge",
    label: "Acknowledge reminder occurrence",
    description: "Mark a reminder occurrence as taken to stop follow-ups.",
    parameters: Type.Object({
      occurrenceId: Type.Integer({ minimum: 1 }),
    }),
    execute(_toolCallId, params) {
      const result = reminderService.acknowledgeOccurrence(params.occurrenceId);
      if (!result.changed) {
        return {
          content: [
            {
              type: "text",
              text: "Occurrence already acknowledged or not found.",
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Occurrence ${params.occurrenceId} marked as taken.`,
          },
        ],
        details: result.occurrence,
      };
    },
  });
}
