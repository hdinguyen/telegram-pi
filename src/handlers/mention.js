import { logger } from "../utils/logger.js";
import { piAgent } from "../agent/index.js";
import { getAgentOptions } from "../agent/config.js";
import { replyWithMarkdown } from "../utils/telegram-format.js";

/**
 * Extract query text by removing bot mentions
 * @param {string} text - Original message text
 * @param {string} botUsername - Bot username to remove
 * @returns {string} - Cleaned query text
 */
/**
 * Show a persistent "typing…" chat action until stopped.
 * Telegram clears the typing indicator after ~5s, so we refresh it.
 * @param {object} ctx - Telegraf context
 * @returns {Function} stop function to clear the indicator
 */
function startTyping(ctx) {
  const send = () => {
    ctx.sendChatAction("typing").catch((err) => {
      logger.debug("Failed to send typing action:", err?.message || err);
    });
  };

  send();
  const interval = setInterval(send, 4000);

  return () => clearInterval(interval);
}

function extractQueryFromMention(text, botUsername) {
  // Remove @botname mentions (case-insensitive)
  let query = text.replace(new RegExp(`@${botUsername}`, "gi"), "").trim();

  // Remove any other common mention patterns
  query = query.replace(/@\w+/g, "").trim();

  return query;
}

/**
 * Handle messages where the bot is mentioned
 * Process the message through the AI agent
 */
export async function mentionHandler(msg, ctx, mentions) {
  const chatId = msg.chat.id;
  const text = msg.text || "";
  const username = msg.from.username || msg.from.first_name || "User";
  const chatType = msg.chat.type;
  const chatTitle = msg.chat.title || "Direct Chat";

  logger.info("🚀 MENTION HANDLER TRIGGERED - Processing with AI", {
    chatId,
    chatType,
    chatTitle,
    from: username,
    text: text.substring(0, 100),
    mentionsCount: mentions?.length || 0,
    mentions: mentions?.map((m) => m.fragment) || [],
  });

  // Get recent messages for context
  const recentMessages = ctx.recentMessages || [];

  // Get bot username from context
  const botUsername = ctx.botUsername;

  // Extract the actual query by removing bot mentions
  const query = extractQueryFromMention(text, botUsername);

  logger.info("📝 Extracted query from mention", {
    original: text.substring(0, 100),
    extracted: query.substring(0, 100),
    botUsername,
  });

  // Show "typing…" in Telegram from now until we send the reply.
  const stopTyping = startTyping(ctx);

  let response;
  try {
    // Initialize agent if needed
    if (!piAgent.isInitialized) {
      try {
        logger.info("⚙️ Initializing Pi Agent on first use...");
        await piAgent.initialize(getAgentOptions());
      } catch (error) {
        logger.error("Failed to initialize agent:", error);
        await ctx.reply(
          "❌ Sorry, I'm having trouble starting up. Please try again later.",
          { reply_to_message_id: msg.message_id },
        );
        return;
      }
    }

    // Process the query with the agent
    try {
      const agentResponse = await piAgent.processMessage(chatId, query, {
        recentMessages,
        chatType,
        username,
        chatTitle,
      });

      response = agentResponse.text;

      // Log tool usage if any
      if (agentResponse.tools && agentResponse.tools.length > 0) {
        logger.debug(
          "🔧 Agent used tools:",
          agentResponse.tools.map((t) => t.tool),
        );
      }
    } catch (error) {
      logger.error("Error processing message with agent:", error);
      response =
        "❌ Sorry, I encountered an error processing your request. Please try again.";
    }
  } finally {
    // Always clear the typing indicator, even on error/early return.
    stopTyping();
  }

  // Render the agent's Markdown as Telegram HTML so it displays as
  // formatted text instead of raw markup characters. Falls back to
  // plain text automatically if Telegram rejects the formatting.
  await replyWithMarkdown(
    ctx,
    response,
    { reply_to_message_id: msg.message_id },
    logger,
  );

  logger.info(`✅ Responded to mention in ${chatTitle} (${chatId})`);
}
