import { Type } from "typebox";

const OPENROUTER_BASE = "https://openrouter.ai/api/v1/chat/completions";

async function getTelegramFilePath(session, telegramFileId) {
  const fileInfo = await session.extensions.run(
    "session_fetch_telegram_file",
    telegramFileId,
  );
  if (!fileInfo?.file_path) {
    throw new Error("Unable to resolve Telegram file path");
  }
  return fileInfo.file_path;
}

async function downloadTelegramFile(filePath) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is required for vision tool");
  }

  const url = `https://api.telegram.org/file/bot${token}/${filePath}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Telegram download failed: ${res.status} ${res.statusText}`);
  }

  const mimeType = res.headers.get("content-type") || "application/octet-stream";
  const arrayBuffer = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  return {
    mimeType,
    base64: buffer.toString("base64"),
    size: buffer.length,
  };
}

async function callOpenRouter({ apiKey, model, prompt, image }) {
  const response = await fetch(OPENROUTER_BASE, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            {
              type: "input_image",
              image: {
                b64_json: image.base64,
                mime_type: image.mimeType,
              },
            },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `OpenRouter request failed: ${response.status} ${response.statusText} ${errorText}`,
    );
  }

  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) {
    throw new Error("OpenRouter response missing content");
  }

  return { text, raw: data };
}

export default function visionOpenRouterExtension(pi) {

  pi.registerTool({
    name: "openrouter_vision",
    label: "OpenRouter Vision",
    description:
      "Analyze a Telegram image via an OpenRouter multimodal model. Provide a prompt and the image ID registered by the bot.",
    parameters: Type.Object({
      prompt: Type.String({ description: "Question or task to apply to the image." }),
      imageId: Type.String({ description: "Identifier of the Telegram image payload." }),
      model: Type.Optional(
        Type.String({ description: "OpenRouter model ID (defaults to openai/gpt-4o-mini)." }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const apiKey = process.env.OPENROUTER_API_KEY;
      if (!apiKey) {
        return {
          content: [
            {
              type: "text",
              text: "⚠️ OPENROUTER_API_KEY is not configured.",
            },
          ],
        };
      }

      const { prompt, imageId } = params;
      const model = params.model || "openai/gpt-4o-mini";

      if (!prompt?.trim()) {
        return {
          content: [
            {
              type: "text",
              text: "⚠️ Vision tool requires a prompt/question.",
            },
          ],
        };
      }

      const session = ctx.session;
      const payloads = await session.extensions.run(
        "session_fetch_image_payloads",
        [imageId],
      );
      if (!payloads || payloads.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "⚠️ Image payload unavailable or expired.",
            },
          ],
        };
      }

      const payload = payloads[0];

      try {
        const filePath = await getTelegramFilePath(ctx.session, payload.telegramFileId);
        const image = await downloadTelegramFile(filePath);
        const result = await callOpenRouter({ apiKey, model, prompt, image });
        return {
          content: [{ type: "text", text: result.text }],
          details: {
            model,
            bytes: image.size,
          },
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `❌ Image analysis failed: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    },
  });
}
