import { Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import { logger } from "../utils/logger.js";
import { allowedUserStore } from "../db/database.js";

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

function formatFileSize(bytes) {
  const sizeInBytes = Number(bytes);
  if (!Number.isFinite(sizeInBytes) || sizeInBytes <= 0) {
    return "";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = sizeInBytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  const precision = unitIndex === 0 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toFixed(precision)} ${units[unitIndex]}`;
}

function describeReactionType(reactionType) {
  if (!reactionType) {
    return "unknown";
  }

  if (reactionType.type === "emoji" && "emoji" in reactionType) {
    return reactionType.emoji;
  }

  if (
    reactionType.type === "custom_emoji" &&
    "custom_emoji_id" in reactionType
  ) {
    return `custom:${reactionType.custom_emoji_id}`;
  }

  return reactionType.type || "unknown";
}

function summarizeMessageContent(message) {
  let text = message.text || message.caption || "";
  let mediaType = "text";
  let location = null;

  if (message.photo?.length) {
    mediaType = "photo";
    const caption = text ? ` caption: ${text}` : "";
    text = `[Photo${caption}]`;
  } else if (message.document) {
    mediaType = "document";
    const doc = message.document;
    const size = formatFileSize(doc.file_size);
    const name = doc.file_name || "document";
    const details = [name, size].filter(Boolean).join(" • ");
    text = `[Document: ${details}]`;
  } else if (message.video) {
    mediaType = "video";
    const video = message.video;
    const duration = video.duration ? `${video.duration}s` : null;
    const size = formatFileSize(video.file_size);
    const details = [duration, size].filter(Boolean).join(" • ");
    text = `[Video${details ? `: ${details}` : ""}]`;
  } else if (message.animation) {
    mediaType = "animation";
    const animation = message.animation;
    const duration = animation.duration ? `${animation.duration}s` : null;
    const size = formatFileSize(animation.file_size);
    const details = [duration, size].filter(Boolean).join(" • ");
    text = `[Animation${details ? `: ${details}` : ""}]`;
  } else if (message.audio) {
    mediaType = "audio";
    const audio = message.audio;
    const duration = audio.duration ? `${audio.duration}s` : null;
    const performer = audio.performer || null;
    const title = audio.title || null;
    const size = formatFileSize(audio.file_size);
    const details = [performer, title, duration, size]
      .filter(Boolean)
      .join(" • ");
    text = `[Audio${details ? `: ${details}` : ""}]`;
  } else if (message.voice) {
    mediaType = "voice";
    const voice = message.voice;
    const duration = voice.duration ? `${voice.duration}s` : null;
    const size = formatFileSize(voice.file_size);
    const details = [duration, size].filter(Boolean).join(" • ");
    text = `[Voice${details ? `: ${details}` : ""}]`;
  } else if (message.video_note) {
    mediaType = "video_note";
    const note = message.video_note;
    const duration = note.duration ? `${note.duration}s` : null;
    const length = note.length ? `${note.length}px` : null;
    const size = formatFileSize(note.file_size);
    const details = [duration, length, size].filter(Boolean).join(" • ");
    text = `[Video Note${details ? `: ${details}` : ""}]`;
  } else if (message.sticker) {
    mediaType = "sticker";
    const sticker = message.sticker;
    const emoji = sticker.emoji ? ` ${sticker.emoji}` : "";
    const setName = sticker.set_name ? ` from ${sticker.set_name}` : "";
    text = `[Sticker${emoji}${setName}]`;
  } else if (message.location) {
    mediaType = "location";
    const loc = message.location;
    location = {
      latitude: loc.latitude,
      longitude: loc.longitude,
      horizontalAccuracy: loc.horizontal_accuracy,
      livePeriod: loc.live_period,
      heading: loc.heading,
      proximityAlertRadius: loc.proximity_alert_radius,
    };

    if (message.venue) {
      location.venue = {
        title: message.venue.title,
        address: message.venue.address,
        foursquareId: message.venue.foursquare_id,
        foursquareType: message.venue.foursquare_type,
        googlePlaceId: message.venue.google_place_id,
        googlePlaceType: message.venue.google_place_type,
      };
    }

    const lat = formatCoordinate(location.latitude);
    const lon = formatCoordinate(location.longitude);
    const venueParts = [];
    if (location.venue?.title) {
      venueParts.push(location.venue.title);
    }
    if (location.venue?.address) {
      venueParts.push(location.venue.address);
    }
    const venueSuffix = venueParts.length ? ` • ${venueParts.join(" — ")}` : "";
    text = `[Location: ${lat}, ${lon}]${venueSuffix}`;
  } else if (message.contact) {
    mediaType = "contact";
    const contact = message.contact;
    const name = [contact.first_name, contact.last_name]
      .filter(Boolean)
      .join(" ");
    const phone = contact.phone_number;
    const details = [name || "Contact", phone].filter(Boolean).join(" • ");
    text = `[Contact: ${details}]`;
  } else if (message.poll) {
    mediaType = "poll";
    const poll = message.poll;
    const optionSummary = poll.options
      ?.slice(0, 3)
      .map((opt) => `${opt.text} (${opt.voter_count})`)
      .join(", ");
    text = `[Poll: ${poll.question}${
      optionSummary ? ` — ${optionSummary}` : ""
    }]`;
  } else if (message.dice) {
    mediaType = "dice";
    const dice = message.dice;
    text = `[Dice: ${dice.emoji} ${dice.value}]`;
  } else if (message.game) {
    mediaType = "game";
    const game = message.game;
    text = `[Game: ${game.title || "Untitled"}]`;
  }

  return {
    text,
    mediaType,
    location,
  };
}

/**
 * Message history storage
 * Maintains last N messages for context
 */
class MessageHistory {
  constructor(maxSize = 50) {
    this.maxSize = maxSize;
    this.messages = [];
  }

  /**
   * Add message to history
   */
  add(message, summary = summarizeMessageContent(message)) {
    const { text: summaryText, mediaType, location } = summary;

    this.messages.push({
      messageId: message.message_id,
      chatId: message.chat.id,
      userId: message.from?.id,
      username: message.from?.username,
      text: summaryText,
      rawText: message.text || "",
      caption: message.caption,
      mediaType,
      location,
      date: message.date,
      type: message.chat.type,
      entities: message.entities || [],
      captionEntities: message.caption_entities || [],
      timestamp: Date.now(),
    });

    // Keep only last N messages
    if (this.messages.length > this.maxSize) {
      this.messages.shift();
    }
  }

  /**
   * Get recent messages
   * @param {number} count - Number of messages to retrieve
   * @param {number} chatId - Optional chat ID filter
   */
  getRecent(count = 50, chatId = null) {
    let filtered = this.messages;

    if (chatId) {
      filtered = this.messages.filter((msg) => msg.chatId === chatId);
    }

    return filtered.slice(-count);
  }
}

/**
 * Telegram Bot wrapper using Telegraf
 */
class TelegramBot {
  constructor(token, options = {}) {
    if (!token) {
      throw new Error("Telegram bot token is required");
    }

    this.bot = new Telegraf(token);
    this.messageHistory = new MessageHistory(options.historySize || 50);
    this.botUsername = null;
    this.isRunning = false;

    // Configure bot
    this._setupMiddleware();
  }

  /**
   * Setup middleware to track all messages
   */
  _setupMiddleware() {
    // Log all updates
    this.bot.use((ctx, next) => {
      logger.debug(`Update received: ${ctx.updateType}`, {
        chatId: ctx.chat?.id,
        chatType: ctx.chat?.type,
        from: ctx.from?.username,
        hasText: !!ctx.message?.text,
      });
      return next();
    });

    const recordMessage = (msg) => {
      const summary = summarizeMessageContent(msg);
      this.messageHistory.add(msg, summary);

      const previewText = summary.text || msg.text || msg.caption || "";
      const hasEntities =
        !!(msg.entities && msg.entities.length > 0) ||
        !!(msg.caption_entities && msg.caption_entities.length > 0);

      // Enhanced logging for group messages
      if (msg.chat.type === "group" || msg.chat.type === "supergroup") {
        logger.info("📩 Group message received", {
          chatId: msg.chat.id,
          chatTitle: msg.chat.title,
          chatType: msg.chat.type,
          from: msg.from.username || msg.from.first_name,
          text: previewText.substring(0, 100),
          hasEntities:
            !!(msg.entities && msg.entities.length > 0) ||
            !!(msg.caption_entities && msg.caption_entities.length > 0),
          entities:
            msg.entities?.map((e) => e.type) ||
            msg.caption_entities?.map((e) => e.type) ||
            [],
        });

        const entitySource = msg.entities || msg.caption_entities || [];
        const mentions = entitySource.filter(
          (e) => e.type === "mention" || e.type === "text_mention",
        );
        if (mentions.length > 0) {
          logger.info("👤 Mentions detected in group", {
            chatId: msg.chat.id,
            mentionCount: mentions.length,
            mentions: mentions.map((m) => ({
              type: m.type,
              text: previewText.substring(m.offset, m.offset + m.length),
            })),
          });
        }

        if (msg.new_chat_members?.length) {
          logger.info("👋 New members joined", {
            chatId: msg.chat.id,
            memberCount: msg.new_chat_members.length,
            members: msg.new_chat_members.map((member) => ({
              id: member.id,
              username: member.username,
            })),
          });
        }
      } else if (previewText) {
        logger.debug(
          `Message stored in history: ${previewText.substring(0, 50)}...`,
        );
      }
    };

    // Track all incoming messages with detailed logging for groups
    const trackedMessageFilters = [
      "text",
      "photo",
      "document",
      "animation",
      "video",
      "audio",
      "voice",
      "video_note",
      "sticker",
      "location",
      "venue",
      "contact",
      "dice",
      "poll",
      "game",
    ];

    for (const filter of trackedMessageFilters) {
      this.bot.on(message(filter), (ctx, next) => {
        if (ctx.message) {
          recordMessage(ctx.message);
        }
        return next();
      });
    }

    this.bot.on("message_reaction", (ctx, next) => {
      const reactionUpdate = ctx.update.message_reaction;

      if (reactionUpdate) {
        const reactionSummary = {
          chatId: reactionUpdate.chat.id,
          chatType: reactionUpdate.chat.type,
          messageId: reactionUpdate.message_id,
          fromUser: ctx.from?.username || ctx.from?.first_name,
          added: ctx.reactions?.added?.toArray?.()?.map(describeReactionType),
          removed: ctx.reactions?.removed?.toArray?.()?.map(describeReactionType),
        };

        logger.info("❤️ Reaction updated", reactionSummary);
      }

      return next();
    });

    this.bot.on("message_reaction_count", (ctx, next) => {
      const countUpdate = ctx.update.message_reaction_count;

      if (countUpdate) {
        const counts = countUpdate.reactions?.map((reaction) => ({
          type: describeReactionType(reaction.type),
          total: reaction.total_count,
        }));

        logger.info("🔢 Reaction count updated", {
          chatId: countUpdate.chat.id,
          chatType: countUpdate.chat.type,
          messageId: countUpdate.message_id,
          counts,
        });
      }

      return next();
    });

    // Handle errors
    this.bot.catch((err, ctx) => {
      logger.error("Bot error:", err);
      logger.error("Error context:", {
        updateType: ctx.updateType,
        chatId: ctx.chat?.id,
      });
    });
  }

  /**
   * Register handler for when bot is mentioned
   * @param {Function} handler - Handler function
   */
  onMention(handler) {
    logger.info("Registering mention handler");

    const mentionMiddleware = async (ctx, next) => {
      try {
        const rawText = ctx.message.text || ctx.message.caption || "";
        const entitySource =
          ctx.message.entities || ctx.message.caption_entities || [];
        const mentions = entitySource
          .filter(
            (entity) =>
              entity.type === "mention" || entity.type === "text_mention",
          )
          .map((entity) => ({
            ...entity,
            fragment:
              typeof entity.offset === "number" &&
              typeof entity.length === "number"
                ? rawText.substring(
                    entity.offset,
                    entity.offset + entity.length,
                  )
                : "",
          }));
        const chatType = ctx.chat.type;
        const isPrivateChat = chatType === "private";

        const isBotCommand =
          entitySource.some(
            (e) => e.type === "bot_command" && e.offset === 0,
          ) || rawText.startsWith("/");
        if (isBotCommand) {
          logger.debug("⏭️  Skipping bot command in agent handler", {
            chatId: ctx.chat.id,
            text: rawText.substring(0, 50),
          });
          return next();
        }

        const envUsernames = (process.env.AVAILABLE || "")
          .split(",")
          .map((u) => u.trim().toLowerCase())
          .filter(Boolean);
        const dbUsernames = allowedUserStore
          .list()
          .map((u) => u.trim().toLowerCase())
          .filter(Boolean);
        const allowedUsernames = [
          ...new Set([...envUsernames, ...dbUsernames]),
        ];
        const senderUsername = (ctx.from?.username || "").toLowerCase();

        if (allowedUsernames.length) {
          const botTargeted =
            isPrivateChat || this._isBotMentioned(mentions, rawText, chatType);

          if (botTargeted && !allowedUsernames.includes(senderUsername)) {
            logger.info("🚫 Blocked non-allowlisted user", {
              chatId: ctx.chat.id,
              chatType,
              from: senderUsername || ctx.from?.first_name,
              allowedUsernames,
            });

            await ctx.reply(
              `I'm still on private test, only serving ${allowedUsernames.join(", ")}, sorry for the inconvenience`,
              { reply_to_message_id: ctx.message.message_id },
            );
            return next();
          }
        }

        if (isPrivateChat) {
          logger.info(
            "💬 Direct message received - responding without mention",
            {
              chatId: ctx.chat.id,
              from: ctx.from.username || ctx.from.first_name,
              text: rawText.substring(0, 100),
            },
          );

          await handler(ctx.message, ctx, mentions);
          return next();
        }

        if (chatType === "group" || chatType === "supergroup") {
          logger.debug("🔍 Checking for bot mentions in group message", {
            chatId: ctx.chat.id,
            chatTitle: ctx.chat.title,
            botUsername: this.botUsername,
            messageText: rawText.substring(0, 100),
            mentionEntities: mentions.map((m) => m.fragment),
          });
        }

        if (this._isBotMentioned(mentions, rawText, chatType)) {
          logger.info("🤖 BOT WAS MENTIONED!", {
            chatId: ctx.chat.id,
            chatType: ctx.chat.type,
            chatTitle: ctx.chat.title,
            from: ctx.from.username || ctx.from.first_name,
            text: rawText.substring(0, 100),
            mentions: mentions.map((m) => m.fragment),
          });

          await handler(ctx.message, ctx, mentions);
        } else if (chatType === "group" || chatType === "supergroup") {
          logger.debug("❌ No bot mention detected in group message");
        }
      } catch (error) {
        logger.error("Error in mention handler:", error);
      }
      return next();
    };

    this.bot.on(message("text"), mentionMiddleware);
    this.bot.on(message("photo"), mentionMiddleware);
    this.bot.on(message("location"), mentionMiddleware);
  }

  /**
   * Determine whether the bot is mentioned in a message.
   * @param {Array} mentions - Mention entities from ctx.entities()
   * @param {string} text - Message text
   * @param {string} chatType - Telegram chat type
   * @returns {boolean}
   */
  _isBotMentioned(mentions, rawText, chatType) {
    // Check if bot is mentioned via entity
    const botMentioned = mentions.some((entity) => {
      const mentionText = entity.fragment;
      const isBotMention = mentionText.includes(this.botUsername);

      if (chatType === "group" || chatType === "supergroup") {
        logger.debug("🔎 Checking mention entity", {
          fragment: mentionText,
          botUsername: this.botUsername,
          matches: isBotMention,
        });
      }

      return isBotMention;
    });

    // Also check direct bot mentions in text (case-insensitive)
    const directMention =
      this.botUsername &&
      (rawText.toLowerCase().includes(`@${this.botUsername.toLowerCase()}`) ||
        rawText.toLowerCase().includes(this.botUsername.toLowerCase()));

    return botMentioned || directMention;
  }

  /**
   * Get recent messages from history
   * @param {number} count - Number of messages to retrieve
   * @param {number} chatId - Optional chat ID filter
   */
  getRecentMessages(count = 50, chatId = null) {
    return this.messageHistory.getRecent(count, chatId);
  }

  /**
   * Start bot polling
   */
  async startPolling() {
    if (this.isRunning) {
      logger.warn("Bot is already running");
      return;
    }

    try {
      // Get bot info
      const botInfo = await this.bot.telegram.getMe();
      this.botUsername = botInfo.username;

      logger.info("Bot info:", {
        id: botInfo.id,
        username: botInfo.username,
        firstName: botInfo.first_name,
      });

      // Launch bot.
      // NOTE: bot.launch() resolves only when the bot STOPS, so we must NOT
      // await it here — otherwise execution blocks and no further code runs.
      this.bot.launch().catch((error) => {
        logger.error("Bot polling crashed:", error);
      });
      this.isRunning = true;

      logger.info("Bot started polling for updates");
    } catch (error) {
      logger.error("Failed to start bot polling:", error);
      throw error;
    }
  }

  /**
   * Stop bot polling
   */
  async stopPolling() {
    if (!this.isRunning) {
      logger.warn("Bot is not running");
      return;
    }

    try {
      await this.bot.stop();
      this.isRunning = false;
      logger.info("Bot stopped polling");
    } catch (error) {
      logger.error("Error stopping bot:", error);
      throw error;
    }
  }

  /**
   * Get bot instance (for advanced usage)
   */
  getInstance() {
    return this.bot;
  }
}

/**
 * Create and configure bot instance
 * @param {object} options - Bot configuration options
 * @returns {TelegramBot} Bot instance
 */
export function createBot(options = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN environment variable is required");
  }

  const bot = new TelegramBot(token, {
    historySize: options.historySize || 50,
    ...options,
  });

  logger.info("Telegraf bot instance created");

  return bot;
}

// Export classes for testing/advanced usage
export { TelegramBot, MessageHistory };
