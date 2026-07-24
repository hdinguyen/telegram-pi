import { reminderService } from "../reminders/reminder-service.js";
import { logger } from "../utils/logger.js";

const PRIMARY_COMMAND = "remind";
const ALIAS_COMMAND = "reminder";

function buildHelpText(command = PRIMARY_COMMAND) {
  const lines = [
    `/${command} add daily <HH:MM> <message> - Create a daily reminder`,
    `/${command} add once <YYYY-MM-DD> <HH:MM> <message> - Schedule a one-time reminder`,
    `/${command} list - Show active reminders`,
    `/${command} delete <id> - Remove a reminder`,
    `/${command} help - Show this help message`,
    `/${command} ? - Quick shortcut for help`,
  ];

  const alias = command === PRIMARY_COMMAND ? ALIAS_COMMAND : PRIMARY_COMMAND;
  lines.push(`Alias command: /${alias}`);

  return lines.join("\n");
}

function parseDailyReminder(tokens) {
  if (tokens.length < 2) {
    throw new Error("Usage: /remind add daily <HH:MM> <message>");
  }

  const timeToken = tokens.shift();
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(timeToken);
  if (!match) {
    throw new Error("Time must be in HH:MM 24-hour format (e.g. 08:30)");
  }

  const [_, hour, minute] = match;
  const message = tokens.join(" ").trim();
  if (!message) {
    throw new Error("Reminder message is required");
  }

  const cronExpression = `${minute} ${hour} * * *`;
  const meta = {
    schedule: {
      type: "daily",
      time: `${hour}:${minute}`,
    },
  };

  return { cronExpression, message, meta };
}

function parseOnceReminder(tokens) {
  if (tokens.length < 3) {
    throw new Error("Usage: /remind add once <YYYY-MM-DD> <HH:MM> <message>");
  }

  const dateToken = tokens.shift();
  const timeToken = tokens.shift();
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateToken);
  if (!dateMatch) {
    throw new Error("Date must be YYYY-MM-DD (e.g. 2024-06-30)");
  }

  const timeMatch = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(timeToken);
  if (!timeMatch) {
    throw new Error("Time must be in HH:MM 24-hour format (e.g. 15:45)");
  }

  const message = tokens.join(" ").trim();
  if (!message) {
    throw new Error("Reminder message is required");
  }

  const [year, month, day] = dateMatch.slice(1).map(Number);
  const [hour, minute] = timeMatch.slice(1).map(Number);
  const runAt = new Date(year, month - 1, day, hour, minute, 0, 0);

  if (Number.isNaN(runAt.getTime())) {
    throw new Error("Invalid date/time provided");
  }

  if (runAt <= new Date()) {
    throw new Error("The reminder time must be in the future");
  }

  const meta = {
    schedule: {
      type: "once",
      runAt: runAt.toISOString(),
    },
  };

  return { runAt: runAt.toISOString(), message, meta };
}

function formatReminder(reminder) {
  const parts = [`#${reminder.id}`];
  const schedule = reminder.meta?.schedule;

  if (reminder.type === "cron") {
    if (schedule?.type === "daily" && schedule.time) {
      parts.push(`[Daily ${schedule.time}]`);
    } else {
      parts.push(`[Cron ${reminder.cron_expression}]`);
    }
  } else if (reminder.type === "once") {
    const runAtIso = schedule?.runAt || reminder.run_at;
    const runAt = runAtIso ? new Date(runAtIso) : null;
    if (runAt && !Number.isNaN(runAt.getTime())) {
      parts.push(`[Once ${runAt.toLocaleString()}]`);
    } else if (reminder.run_at) {
      parts.push(`[Once ${reminder.run_at}]`);
    } else {
      parts.push("[Once]");
    }
  }

  parts.push(reminder.message);

  return parts.join(" ");
}

async function handleAddReminder(ctx, tokens) {
  const mode = (tokens.shift() || "").toLowerCase();
  if (!mode) {
    throw new Error("Specify 'daily' or 'once' after /remind add");
  }

  const chatId = ctx.chat.id;
  const createdBy = ctx.from?.username || ctx.from?.id?.toString();
  const baseOptions = {
    chatId,
    createdBy,
    repeatUntilAck: true,
    ackTimeoutSeconds: 600,
    timezone: process.env.REMINDER_TIMEZONE || "local",
  };

  if (mode === "daily") {
    const { cronExpression, message, meta } = parseDailyReminder(tokens);
    const reminder = reminderService.createReminder({
      ...baseOptions,
      message,
      isRecurring: true,
      cronExpression,
      meta,
    });

    await ctx.reply(
      `✅ Daily reminder created (id ${reminder.id}) for ${meta.schedule.time}`,
    );
    return;
  }

  if (mode === "once") {
    const { runAt, message, meta } = parseOnceReminder(tokens);
    const reminder = reminderService.createReminder({
      ...baseOptions,
      message,
      isRecurring: false,
      runAt,
      meta,
    });

    await ctx.reply(
      `✅ One-time reminder created (id ${reminder.id}) for ${new Date(runAt).toLocaleString()}`,
    );
    return;
  }

  throw new Error("Unsupported mode. Use 'daily' or 'once'.");
}

async function handleListReminders(ctx) {
  const reminders = reminderService.listReminders(ctx.chat.id);
  if (!reminders.length) {
    await ctx.reply("You have no active reminders.");
    return;
  }

  const lines = reminders.map((reminder) => formatReminder(reminder));
  await ctx.reply(`📋 Active reminders:\n${lines.join("\n")}`);
}

async function handleDeleteReminder(ctx, tokens) {
  if (tokens.length === 0) {
    throw new Error("Usage: /remind delete <id>");
  }

  const id = Number.parseInt(tokens[0], 10);
  if (Number.isNaN(id)) {
    throw new Error("Reminder id must be a number");
  }

  const deleted = await reminderService.deleteReminder(id);
  if (!deleted) {
    await ctx.reply(`⚠️ Reminder ${id} not found.`);
    return;
  }

  await ctx.reply(`🗑️ Reminder ${id} deleted.`);
}

async function processRemindCommand(ctx, commandUsed = `/${PRIMARY_COMMAND}`) {
  const text = ctx.message.text || "";
  const commandPattern = new RegExp(`^\\/${PRIMARY_COMMAND}(?:@\\w+)?`, "i");
  const aliasPattern = new RegExp(`^\\/${ALIAS_COMMAND}(?:@\\w+)?`, "i");
  const withoutCommand = text.replace(commandPattern, "").replace(aliasPattern, "").trim();

  if (!withoutCommand) {
    await ctx.reply(`Usage:\n${buildHelpText(commandUsed.slice(1))}`);
    return;
  }

  const tokens = withoutCommand.split(/\s+/);
  let action = tokens.shift()?.toLowerCase();

  if (action === "?") {
    action = "help";
  }

  try {
    if (action === "add") {
      await handleAddReminder(ctx, tokens);
      return;
    }

    if (action === "list") {
      await handleListReminders(ctx);
      return;
    }

    if (action === "delete" || action === "remove") {
      await handleDeleteReminder(ctx, tokens);
      return;
    }

    if (action === "help") {
      await ctx.reply(`Usage:\n${buildHelpText(commandUsed.slice(1))}`);
      return;
    }

    await ctx.reply(`Unknown action. Usage:\n${buildHelpText(commandUsed.slice(1))}`);
  } catch (error) {
    logger.warn("Failed to process reminder command", {
      chatId: ctx.chat?.id,
      commandUsed,
      error: error?.message,
    });
    await ctx.reply(`❌ ${error.message}`);
  }
}

async function handleAcknowledge(ctx) {
  const data = ctx.callbackQuery.data;
  const match = /^reminder:ack:(\d+)$/.exec(data);
  if (!match) {
    return;
  }

  const occurrenceId = Number.parseInt(match[1], 10);
  const { changed, occurrence } = reminderService.acknowledgeOccurrence(
    occurrenceId,
  );

  if (!changed) {
    await ctx.answerCbQuery("Already marked as taken or expired.", {
      show_alert: false,
    });
    return;
  }

  try {
    await ctx.editMessageReplyMarkup(undefined);
  } catch (error) {
    logger.debug("Failed to clear inline keyboard", {
      occurrenceId,
      error: error?.message,
    });
  }

  await ctx.answerCbQuery("✅ Marked as taken!");

  if (occurrence?.reminder_id) {
    await ctx.reply(
      `✅ Reminder #${occurrence.reminder_id} marked as taken. Great job!`,
    );
  }
}

export function registerReminderHandlers(bot) {
  const tg = bot.getInstance();

  tg.command(PRIMARY_COMMAND, (ctx) => processRemindCommand(ctx, `/${PRIMARY_COMMAND}`));
  tg.command(ALIAS_COMMAND, (ctx) => processRemindCommand(ctx, `/${ALIAS_COMMAND}`));
  tg.action(/reminder:ack:\d+/, handleAcknowledge);

  logger.info("Reminder commands registered (/remind, /reminder)");
}
