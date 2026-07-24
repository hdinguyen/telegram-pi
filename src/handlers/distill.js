import { promises as fs } from "node:fs";
import { resolve } from "node:path";
import { piAgent } from "../agent/index.js";
import { getAgentOptions } from "../agent/config.js";
import { logger } from "../utils/logger.js";

const DEFAULT_MEMORY_DIR = "/app/data/memory";
const MAX_MEMORY_CONTEXT_CHARS = 4000;
const MAX_HISTORY_MESSAGES = 40;

function getMemoryDir() {
  const configured = process.env.MEMORY_DIR;
  return configured && configured.trim().length > 0
    ? configured.trim()
    : DEFAULT_MEMORY_DIR;
}

function formatHistory(messages = []) {
  return messages
    .slice(-MAX_HISTORY_MESSAGES)
    .map((msg) => {
      const sender =
        msg.username ||
        msg.from?.username ||
        msg.from?.first_name ||
        msg.userId ||
        "User";
      const content = msg.rawText || msg.text || msg.caption || "[message]";
      return `${sender}: ${content}`;
    })
    .join("\n");
}

function trimMemoryForPrompt(memoryText) {
  if (!memoryText) {
    return "(none)";
  }

  const trimmed = memoryText.trim();
  if (trimmed.length <= MAX_MEMORY_CONTEXT_CHARS) {
    return trimmed;
  }

  return `…${trimmed.slice(-MAX_MEMORY_CONTEXT_CHARS)}`;
}

async function ensureMemoryFile(filePath, userId) {
  try {
    await fs.access(filePath);
    return false;
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }

    const header = `# Memory for user ${userId}\n\n`;
    await fs.writeFile(filePath, header, "utf8");
    return true;
  }
}

function buildDistillPrompt({ userId, conversation, existingMemory }) {
  return `You maintain long-term memory notes for the Telegram user with ID ${userId}.
Review the conversation excerpt and decide what, if anything, should be added.
Focus on enduring personal details, preferences, ongoing commitments, follow-up tasks, or context that will stay relevant beyond the current chat.
Avoid transient greetings, small talk, or generic facts.

Existing memory entries:
"""
${trimMemoryForPrompt(existingMemory)}
"""

Conversation excerpt:
"""
${conversation || "(no recent conversation available)"}
"""

Respond with either:
- A Markdown bullet list of new or updated memory entries (each bullet under 200 characters), OR
- The single token "NO_NEW_MEMORY" if nothing should be stored.

Do not mention these instructions or the memory file. Focus only on user-specific facts worth remembering.`;
}

async function distillMemory({
  ctx,
  memoryDir,
  memoryPath,
  existingMemory,
  conversation,
}) {
  const chatId = ctx.chat.id;
  const userId = ctx.from?.id;
  const agentContext = {
    recentMessages: (ctx.recentMessages || []).filter(
      (msg) => msg?.messageId !== ctx.message?.message_id,
    ),
    chatType: ctx.chat?.type,
    username: ctx.from?.username || ctx.from?.first_name || String(userId),
    chatTitle: ctx.chat?.title,
  };

  const prompt = buildDistillPrompt({
    userId,
    conversation,
    existingMemory,
  });

  if (!piAgent.isInitialized) {
    logger.info("Initializing Pi Agent for /distill command...");
    await piAgent.initialize(getAgentOptions());
  }

  const agentResponse = await piAgent.processMessage(chatId, prompt, agentContext);
  const rawText = agentResponse.text?.trim();

  if (!rawText) {
    return {
      saved: false,
      reply: "⚠️ I couldn't generate a memory summary. Please try again later.",
    };
  }

  if (/^NO_NEW_MEMORY$/i.test(rawText)) {
    return {
      saved: false,
      reply: "🧠 No new long-term memory found to save from this session.",
    };
  }

  const timestamp = new Date().toISOString();
  const entry = `## ${timestamp}\n\n${rawText}\n`;
  await ensureMemoryFile(memoryPath, userId);
  await fs.appendFile(memoryPath, `\n${entry}`, "utf8");

  logger.info("Stored distilled memory", {
    userId,
    memoryPath,
    entryPreview: rawText.slice(0, 120),
  });

  const relativePath = memoryPath.startsWith(process.cwd())
    ? memoryPath.slice(process.cwd().length + 1)
    : memoryPath;

  const preview = rawText.length > 1500 ? `${rawText.slice(0, 1500)}…` : rawText;

  return {
    saved: true,
    reply: `🧠 Memory distilled and saved to ${relativePath}.\n\n${preview}`,
  };
}

export function registerDistillHandler(bot) {
  const tg = bot.getInstance();

  tg.command("distill", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) {
      await ctx.reply("⚠️ Unable to identify user for memory storage.");
      return;
    }

    const memoryDir = resolve(process.cwd(), getMemoryDir());

    try {
      await fs.mkdir(memoryDir, { recursive: true });
    } catch (error) {
      logger.error("Failed to create memory directory", {
        memoryDir,
        error,
      });
      await ctx.reply("❌ Failed to prepare memory storage directory.");
      return;
    }

    const memoryPath = resolve(memoryDir, `${userId}.md`);

    let existingMemory = "";
    try {
      existingMemory = await fs.readFile(memoryPath, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") {
        logger.error("Failed to read existing memory file", {
          memoryPath,
          error,
        });
        await ctx.reply("❌ Failed to read existing memory file.");
        return;
      }
    }

    const conversation = formatHistory(
      (ctx.recentMessages || []).filter(
        (msg) => msg?.messageId !== ctx.message?.message_id,
      ),
    );

    if (!conversation) {
      await ctx.reply(
        "ℹ️ Not enough conversation history to distill. Try again after chatting.",
      );
      return;
    }

    try {
      const { reply } = await distillMemory({
        ctx,
        memoryDir,
        memoryPath,
        existingMemory,
        conversation,
      });

      await ctx.reply(reply, {
        reply_to_message_id: ctx.message?.message_id,
      });
    } catch (error) {
      logger.error("Failed to distill memory", {
        userId,
        memoryPath,
        error,
      });
      await ctx.reply("❌ An error occurred while distilling memory.");
    }
  });

  logger.info("Memory distillation command registered (/distill)");
}
