import { Type } from "typebox";

const OPENROUTER_BASE = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL =
  process.env.OPENROUTER_VISION_MODEL || "openai/gpt-4o-mini";
const REQUEST_TIMEOUT_MS = 15_000;

const VISION_EVENTS = {
  FETCH_IMAGE_PAYLOADS: "telebot:vision:fetch_image_payloads",
  FETCH_TELEGRAM_FILE: "telebot:vision:fetch_telegram_file",
};

function requestFromBot(
  pi,
  eventName,
  payload,
  timeoutMs = REQUEST_TIMEOUT_MS,
) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `${eventName} timed out; Telegram vision bridge may not be registered`,
        ),
      );
    }, timeoutMs);

    pi.events.emit(eventName, {
      ...payload,
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
  });
}

async function getTelegramFilePath(pi, telegramFileId) {
  const fileInfo = await requestFromBot(pi, VISION_EVENTS.FETCH_TELEGRAM_FILE, {
    fileId: telegramFileId,
  });

  if (!fileInfo?.file_path) {
    throw new Error("Unable to resolve Telegram file path");
  }
  return fileInfo.file_path;
}

function inferMimeType(filePath, contentType) {
  const normalizedContentType = contentType?.split(";")[0]?.trim();
  if (normalizedContentType?.startsWith("image/")) {
    return normalizedContentType;
  }

  const lower = filePath.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  return "image/jpeg";
}

async function downloadTelegramFile(filePath, signal) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is required for vision tool");
  }

  const url = `https://api.telegram.org/file/bot${token}/${filePath}`;
  const res = await fetch(url, { signal });
  if (!res.ok) {
    throw new Error(
      `Telegram download failed: ${res.status} ${res.statusText}`,
    );
  }

  const mimeType = inferMimeType(filePath, res.headers.get("content-type"));
  const arrayBuffer = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  return {
    mimeType,
    base64: buffer.toString("base64"),
    size: buffer.length,
  };
}

async function callOpenRouter({ apiKey, model, prompt, image, signal }) {
  const response = await fetch(OPENROUTER_BASE, {
    method: "POST",
    signal,
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
              type: "image_url",
              image_url: {
                url: `data:${image.mimeType};base64,${image.base64}`,
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
  const content = data?.choices?.[0]?.message?.content;
  const text = Array.isArray(content)
    ? content
        .map((part) => part?.text || "")
        .filter(Boolean)
        .join("\n")
    : content;

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
      prompt: Type.String({
        description:
          "Question, OCR request, or extraction task to apply to the image.",
      }),
      imageId: Type.String({
        description:
          "Identifier of the Telegram image payload from <attached_images>.",
      }),
      model: Type.Optional(
        Type.String({
          description: `OpenRouter vision model ID (defaults to ${DEFAULT_MODEL}).`,
        }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
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
      const model = params.model || DEFAULT_MODEL;

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

      try {
        const payloads = await requestFromBot(
          pi,
          VISION_EVENTS.FETCH_IMAGE_PAYLOADS,
          {
            ids: [imageId],
          },
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
        if (!payload.telegramFileId) {
          throw new Error("Image payload is missing Telegram file id");
        }

        const filePath = await getTelegramFilePath(pi, payload.telegramFileId);
        const image = await downloadTelegramFile(filePath, signal);
        const result = await callOpenRouter({
          apiKey,
          model,
          prompt,
          image,
          signal,
        });

        return {
          content: [{ type: "text", text: result.text }],
          details: {
            model,
            bytes: image.size,
            mimeType: image.mimeType,
            imageId,
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
