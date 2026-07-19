import {
  createEventBus,
  DefaultResourceLoader,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { logger } from "../utils/logger.js";

/**
 * Directory where per-group session JSONL files are stored.
 * Override with the SESSION_DIR environment variable.
 */
export function getSessionDir() {
  return resolve(process.env.SESSION_DIR || "./data/sessions");
}

/**
 * Get agent configuration options
 */
export function getAgentOptions() {
  const cwd = process.cwd();
  const agentDir = getAgentDir();
  const sessionDir = getSessionDir();
  const eventBus = createEventBus();
  const visionExtensionPath = resolve(
    cwd,
    "extensions/vision-openrouter/index.js",
  );

  logger.debug("Agent configuration", {
    cwd,
    agentDir,
    sessionDir,
    visionExtensionPath,
  });

  // Create resource loader with custom prompt additions
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    eventBus,
    additionalExtensionPaths: [visionExtensionPath],
    // Append instructions to the default prompt
    appendSystemPromptOverride: (base) => [
      ...base,
      `
## Telegram Bot Context

You are a helpful assistant integrated with a Telegram bot. When responding:

- Keep responses concise and to the point (Telegram messages have a 4096 character limit)
- Use clear formatting with Markdown when appropriate (*bold*, _italic_, \`code\`)
- If a response would exceed the character limit, break it into logical chunks
- Be conversational and friendly, matching the informal nature of chat
- Consider the conversation history provided in the context
- When asked about specific topics, leverage available skills for accurate information
- When the current message includes an attached Telegram image ID, use the \`openrouter_vision\` tool for image description, OCR, extraction, or any question that depends on the image contents. Do not claim to inspect image pixels before the tool returns.

## Response Guidelines

1. **Brevity**: Aim for clear, direct answers. Users are on mobile devices.
2. **Structure**: Use bullet points, numbered lists, and short paragraphs.
3. **Code**: Use \`inline code\` for short snippets, \`\`\`language blocks\`\`\` for longer code.
4. **Links**: Provide relevant links when referencing external resources.
5. **Context Awareness**: Reference previous messages when relevant.
`,
    ],
    // Skills are auto-discovered from .pi/skills/ and loaded
    skillsOverride: (current) => {
      // Optionally filter or modify skills here
      // For now, use all discovered skills
      logger.debug(
        "Available skills:",
        current.skills.map((s) => s.name),
      );
      return current;
    },
  });

  return {
    loader,
    cwd,
    agentDir,
    sessionDir,
    eventBus,
    visionExtensionPath,
  };
}
