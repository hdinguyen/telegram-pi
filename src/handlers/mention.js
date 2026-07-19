import { logger } from "../utils/logger.js";
import { piAgent } from "../agent/index.js";
import { getAgentOptions } from "../agent/config.js";
import {
  registerImagePayloads,
  clearImagePayloads,
} from "../agent/vision-store.js";
import { replyWithMarkdown } from "../utils/telegram-format.js";

function formatCoordinate(value, precision = 5) {
  if (typeof value === "number") {
    return value.toFixed(precision);
  }
  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric.toFixed(precision);
    }
    return value;
  }
  return "";
}

const TELEGRAM_MESSAGE_LIMIT = 4000;

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

function isMessageTooLongError(error) {
  const description =
    error?.description ||
    error?.response?.description ||
    error?.response?.error_code_description ||
    error?.message;

  return (
    typeof description === "string" &&
    description.toLowerCase().includes("message is too long")
  );
}

async function handleOutlineFallback({
  ctx,
  msg,
  chatId,
  originalResponse,
  agentContext,
}) {
  logger.warn("⚠️ Falling back to Outline upload due to long response", {
    chatId,
    responseLength: originalResponse?.length || 0,
  });

  const stopFallbackTyping = startTyping(ctx);

  try {
    const fallbackPrompt = `The previous assistant response exceeded Telegram's 4096 character limit and could not be delivered.
Upload the full response below to the Outline wiki using the appropriate outline skill.
After uploading, reply with a short Telegram-safe message (under 400 characters) that includes:
- A brief summary of the answer (1-2 sentences)
- The Outline URL where the user can read the full answer

Full response to upload:
"""
${originalResponse}
"""`;

    const fallbackAgentResponse = await piAgent.processMessage(
      chatId,
      fallbackPrompt,
      {
        ...agentContext,
        telegramFallback: true,
      },
    );

    let fallbackText = fallbackAgentResponse.text?.trim();

    if (fallbackAgentResponse.tools?.length) {
      logger.debug(
        "🔧 Fallback agent used tools:",
        fallbackAgentResponse.tools.map((t) => t.tool),
      );
    }

    if (!fallbackText) {
      fallbackText =
        "⚠️ The detailed answer was uploaded to Outline, but I couldn't retrieve the link. Please try again later.";
    }

    const urlMatch = fallbackText.match(/https?:\/\/\S+/);

    if (fallbackText.length > TELEGRAM_MESSAGE_LIMIT) {
      fallbackText = urlMatch
        ? `📄 The full answer was too long for Telegram. You can read it here: ${urlMatch[0]}`
        : "⚠️ The detailed answer was uploaded to Outline, but I couldn't share the link. Please try again later.";
    }

    await replyWithMarkdown(
      ctx,
      fallbackText,
      { reply_to_message_id: msg.message_id },
      logger,
    );

    logger.info("✅ Sent Outline fallback response", {
      chatId,
      fallbackLength: fallbackText.length,
      urlIncluded: Boolean(urlMatch),
    });
  } catch (error) {
    logger.error("Failed to complete Outline fallback:", error);
    await ctx.reply(
      "❌ The full answer was too long to send and I couldn't upload it to Outline. Please try again later.",
      { reply_to_message_id: msg.message_id },
    );
  } finally {
    stopFallbackTyping();
  }
}

/**
 * Handle messages where the bot is mentioned
 * Process the message through the AI agent
 */
export async function mentionHandler(msg, ctx, mentions) {
  const chatId = msg.chat.id;
  const text = msg.text || msg.caption || "";
  const location = msg.location;
  const username = msg.from.username || msg.from.first_name || "User";
  const chatType = msg.chat.type;
  const chatTitle = msg.chat.title || "Direct Chat";

  logger.info("🚀 MENTION HANDLER TRIGGERED - Processing with AI", {
    chatId,
    chatType,
    chatTitle,
    from: username,
    text: text.substring(0, 100),
    hasPhoto: !!(msg.photo && msg.photo.length),
    hasLocation: !!location,
    mentionsCount: mentions?.length || 0,
    mentions: mentions?.map((m) => m.fragment) || [],
  });

  // Get recent messages for context
  const recentMessages = ctx.recentMessages || [];

  // Get bot username from context
  const botUsername = ctx.botUsername;

  // Extract the actual query by removing bot mentions
  const baseQuery = extractQueryFromMention(text, botUsername);

  let locationSummary = null;
  if (location) {
    const lat = formatCoordinate(location.latitude);
    const lon = formatCoordinate(location.longitude);
    const venue = msg.venue;
    const venueParts = [];
    if (venue?.title) venueParts.push(venue.title);
    if (venue?.address) venueParts.push(venue.address);
    const venueSuffix = venueParts.length ? ` • ${venueParts.join(" — ")}` : "";
    locationSummary = {
      latitude: location.latitude,
      longitude: location.longitude,
      text: `[Location: ${lat}, ${lon}]${venueSuffix}`,
      horizontalAccuracy: location.horizontal_accuracy,
      livePeriod: location.live_period,
      heading: location.heading,
      proximityAlertRadius: location.proximity_alert_radius,
      venue: venue
        ? {
            title: venue.title,
            address: venue.address,
            foursquareId: venue.foursquare_id,
            foursquareType: venue.foursquare_type,
            googlePlaceId: venue.google_place_id,
            googlePlaceType: venue.google_place_type,
          }
        : undefined,
    };
  }

  if (locationSummary) {
    logger.info("📍 Location shared in message", {
      chatId,
      text: locationSummary.text,
      latitude: locationSummary.latitude,
      longitude: locationSummary.longitude,
      horizontalAccuracy: locationSummary.horizontalAccuracy,
      livePeriod: locationSummary.livePeriod,
      heading: locationSummary.heading,
      proximityAlertRadius: locationSummary.proximityAlertRadius,
      venue: locationSummary.venue,
    });
  }

  const querySegments = [];
  if (baseQuery) {
    querySegments.push(baseQuery);
  }

  if (locationSummary) {
    const locationLines = [`Location shared by user: ${locationSummary.text}`];

    if (typeof locationSummary.horizontalAccuracy === "number") {
      locationLines.push(
        `Horizontal accuracy: ${locationSummary.horizontalAccuracy} meters`,
      );
    }
    if (typeof locationSummary.livePeriod === "number") {
      locationLines.push(
        `Live location remaining: ${Math.round(locationSummary.livePeriod)} seconds`,
      );
    }
    if (typeof locationSummary.heading === "number") {
      locationLines.push(`Heading: ${locationSummary.heading}°`);
    }
    if (typeof locationSummary.proximityAlertRadius === "number") {
      locationLines.push(
        `Proximity alert radius: ${locationSummary.proximityAlertRadius} meters`,
      );
    }

    if (locationSummary.venue) {
      const venueLines = [];
      if (locationSummary.venue.title) {
        venueLines.push(`Title: ${locationSummary.venue.title}`);
      }
      if (locationSummary.venue.address) {
        venueLines.push(`Address: ${locationSummary.venue.address}`);
      }
      if (venueLines.length > 0) {
        locationLines.push(`Venue details:\n${venueLines.join("\n")}`);
      }
    }

    querySegments.push(locationLines.join("\n"));
  }

  const query = querySegments.join(querySegments.length > 1 ? "\n\n" : "");

  // Attach inline photo payloads if present
  let imageIds = [];
  if (msg.photo && msg.photo.length > 0) {
    const largestPhoto = msg.photo[msg.photo.length - 1];
    const imageId = `${msg.chat.id}:${msg.message_id}:${largestPhoto.file_unique_id}`;
    registerImagePayloads([
      {
        id: imageId,
        data: {
          telegramFileId: largestPhoto.file_id,
          width: largestPhoto.width,
          height: largestPhoto.height,
          caption: msg.caption || undefined,
          chatId: msg.chat.id,
          messageId: msg.message_id,
        },
      },
    ]);

    // Schedule a cleanup in case the agent never requests the image
    setTimeout(
      () => {
        clearImagePayloads([imageId]);
      },
      10 * 60 * 1000,
    );

    imageIds = [imageId];
  }

  logger.info("📝 Extracted query from mention", {
    original: text.substring(0, 100),
    extracted: query.substring(0, 100),
    botUsername,
  });

  // Show "typing…" in Telegram from now until we send the reply.
  const stopTyping = startTyping(ctx);

  const agentContext = {
    recentMessages,
    chatType,
    username,
    chatTitle,
    imageIds,
    location: locationSummary,
  };

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
      const agentResponse = await piAgent.processMessage(
        chatId,
        query,
        agentContext,
      );

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

  if (!response) {
    await ctx.reply("⚠️ I couldn't generate a response. Please try again.", {
      reply_to_message_id: msg.message_id,
    });
    return;
  }

  if (response.length > TELEGRAM_MESSAGE_LIMIT) {
    await handleOutlineFallback({
      ctx,
      msg,
      chatId,
      originalResponse: response,
      agentContext,
    });
    return;
  }

  try {
    // Render the agent's Markdown as Telegram HTML so it displays as
    // formatted text instead of raw markup characters. Falls back to
    // plain text automatically if Telegram rejects the formatting.
    await replyWithMarkdown(
      ctx,
      response,
      { reply_to_message_id: msg.message_id },
      logger,
    );
  } catch (error) {
    if (isMessageTooLongError(error)) {
      await handleOutlineFallback({
        ctx,
        msg,
        chatId,
        originalResponse: response,
        agentContext,
      });
      return;
    }

    logger.error("Failed to send Telegram reply:", error);
    await ctx.reply(
      "❌ Sorry, I couldn't send the response due to an unexpected error. Please try again later.",
      { reply_to_message_id: msg.message_id },
    );
    return;
  }

  logger.info(`✅ Responded to mention in ${chatTitle} (${chatId})`);
}
