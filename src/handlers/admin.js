import { allowedUserStore, AllowedUserStore } from "../db/database.js";
import { logger } from "../utils/logger.js";

/**
 * Admins are read from the ADMIN env var (comma-separated usernames).
 * Only admins may run /allow and /deny.
 */
function getAdmins() {
  return (process.env.ADMIN || "")
    .split(",")
    .map((u) => AllowedUserStore.normalize(u))
    .filter(Boolean);
}

function isAdmin(username) {
  const name = AllowedUserStore.normalize(username);
  if (!name) return false;
  return getAdmins().includes(name);
}

/**
 * Pull the first argument from a command message, e.g. "/allow @bob" -> "bob".
 */
function parseTarget(text) {
  const parts = String(text || "").trim().split(/\s+/);
  return parts.length > 1 ? parts[1] : "";
}

/**
 * Register access-control commands (/allow, /deny, /allowlist) on the
 * underlying Telegraf instance. These let an admin manage the database
 * allowlist at runtime without a restart.
 */
export function registerAdminCommands(bot) {
  const tg = bot.getInstance();

  tg.command("allow", async (ctx) => {
    const requester = ctx.from?.username;
    if (!isAdmin(requester)) {
      logger.info("🚫 Non-admin tried /allow", { from: requester });
      return ctx.reply("Only an admin can use this command.", {
        reply_to_message_id: ctx.message.message_id,
      });
    }

    const target = parseTarget(ctx.message.text);
    if (!target) {
      return ctx.reply("Usage: /allow <username>", {
        reply_to_message_id: ctx.message.message_id,
      });
    }

    const name = AllowedUserStore.normalize(target);
    const changed = allowedUserStore.add(name, requester);
    logger.info("✅ /allow", { admin: requester, target: name, changed });

    return ctx.reply(
      changed
        ? `Allowed @${name}.`
        : `@${name} is already allowed.`,
      { reply_to_message_id: ctx.message.message_id },
    );
  });

  tg.command("deny", async (ctx) => {
    const requester = ctx.from?.username;
    if (!isAdmin(requester)) {
      logger.info("🚫 Non-admin tried /deny", { from: requester });
      return ctx.reply("Only an admin can use this command.", {
        reply_to_message_id: ctx.message.message_id,
      });
    }

    const target = parseTarget(ctx.message.text);
    if (!target) {
      return ctx.reply("Usage: /deny <username>", {
        reply_to_message_id: ctx.message.message_id,
      });
    }

    const name = AllowedUserStore.normalize(target);
    const changed = allowedUserStore.deny(name);
    logger.info("🛑 /deny", { admin: requester, target: name, changed });

    return ctx.reply(
      changed
        ? `Denied @${name}.`
        : `@${name} was not on the allowlist.`,
      { reply_to_message_id: ctx.message.message_id },
    );
  });

  tg.command("allowlist", async (ctx) => {
    const requester = ctx.from?.username;
    if (!isAdmin(requester)) {
      return ctx.reply("Only an admin can use this command.", {
        reply_to_message_id: ctx.message.message_id,
      });
    }

    const users = allowedUserStore.list();
    return ctx.reply(
      users.length
        ? `Allowed users (${users.length}):\n` +
            users.map((u) => `• @${u}`).join("\n")
        : "The allowlist is empty.",
      { reply_to_message_id: ctx.message.message_id },
    );
  });

  logger.info("Access-control commands registered (/allow, /deny, /allowlist)");
}
