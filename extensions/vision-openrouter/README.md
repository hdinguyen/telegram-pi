# OpenRouter Vision Extension

Registers the `openrouter_vision` tool for `pi-coding-agent`.

Flow:

1. Telegram photo metadata is stored by the bot in `src/agent/vision-store.js`.
2. The agent prompt receives an `<attached_images>` block with the image ID.
3. When image contents are needed, the LLM calls `openrouter_vision` with that image ID.
4. The extension requests image metadata/file paths from the bot over the shared Pi event bus.
5. The extension downloads the Telegram file and sends it to OpenRouter `/api/v1/chat/completions` as an `image_url` data URL.

Required environment variables:

- `TELEGRAM_BOT_TOKEN`
- `OPENROUTER_API_KEY`

Optional:

- `OPENROUTER_VISION_MODEL` (default: `openai/gpt-4o-mini`)
