/**
 * Convert standard Markdown (as produced by LLMs) into the limited HTML
 * subset that the Telegram Bot API supports with parse_mode: "HTML".
 *
 * Telegram HTML only supports a fixed set of tags:
 *   <b> <strong>, <i> <em>, <u> <ins>, <s> <strike> <del>,
 *   <span class="tg-spoiler"> / <tg-spoiler>, <a href>, <code>,
 *   <pre>, <blockquote>. It does NOT support headings or lists, so
 *   those are approximated (headings -> bold, list items -> bullets).
 *
 * Only "&", "<" and ">" must be escaped in HTML mode, which makes this
 * far more robust for arbitrary LLM output than MarkdownV2 (which requires
 * escaping a large set of punctuation and frequently errors out).
 *
 * Ref: https://core.telegram.org/bots/api#html-style
 */

const PLACEHOLDER = "\u0000";

/** Escape the three HTML-significant characters. */
function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Convert a Markdown string to Telegram-compatible HTML.
 * @param {string} input
 * @returns {string}
 */
export function markdownToTelegramHtml(input) {
  if (!input) return "";

  const codeStore = [];
  let text = input.replace(/\r\n/g, "\n");

  // 1. Pull out fenced code blocks first so their contents are never
  //    treated as markdown. Store the (later-escaped) HTML.
  text = text.replace(/```([\w+-]*)\n?([\s\S]*?)```/g, (_m, lang, body) => {
    const code = escapeHtml(body.replace(/\n$/, ""));
    const langAttr = lang ? ` class="language-${lang}"` : "";
    const html = `<pre><code${langAttr}>${code}</code></pre>`;
    codeStore.push(html);
    return `${PLACEHOLDER}${codeStore.length - 1}${PLACEHOLDER}`;
  });

  // 2. Pull out inline code spans.
  text = text.replace(/`([^`\n]+)`/g, (_m, body) => {
    const html = `<code>${escapeHtml(body)}</code>`;
    codeStore.push(html);
    return `${PLACEHOLDER}${codeStore.length - 1}${PLACEHOLDER}`;
  });

  // 3. Escape the remaining text exactly once.
  text = escapeHtml(text);

  // 4. Line-based transforms (headings, blockquotes, list bullets).
  text = text
    .split("\n")
    .map((line) => {
      // Headings -> bold line
      const heading = line.match(/^\s{0,3}#{1,6}\s+(.*)$/);
      if (heading) return `<b>${heading[1].trim()}</b>`;

      // Horizontal rule
      if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) return "––––––––––";

      // Blockquote ('>' has already been escaped to '&gt;' in step 3)
      const quote = line.match(/^\s{0,3}&gt;\s?(.*)$/);
      if (quote) return `<blockquote>${quote[1]}</blockquote>`;

      // Unordered list item -> bullet
      const ul = line.match(/^(\s*)[-*+]\s+(.*)$/);
      if (ul) return `${ul[1]}• ${ul[2]}`;

      return line;
    })
    .join("\n");

  // 5. Inline spans. Order matters: links and bold (double markers)
  //    before italics (single markers).
  text = text
    // [text](url)
    .replace(
      /\[([^\]]+)\]\(([^)\s]+)\)/g,
      (_m, label, url) => `<a href="${url}">${label}</a>`,
    )
    // **bold** / __bold__
    .replace(/\*\*([^\n]+?)\*\*/g, "<b>$1</b>")
    .replace(/__([^\n]+?)__/g, "<b>$1</b>")
    // ~~strikethrough~~
    .replace(/~~([^\n]+?)~~/g, "<s>$1</s>")
    // *italic* (single asterisk, not part of **)
    .replace(/(^|[^*])\*(?!\s)([^*\n]+?)\*(?!\*)/g, "$1<i>$2</i>")
    // _italic_ (single underscore around a word)
    .replace(/(^|[^\w_])_(?!\s)([^_\n]+?)_(?!\w)/g, "$1<i>$2</i>");

  // 6. Restore code placeholders.
  text = text.replace(
    new RegExp(`${PLACEHOLDER}(\\d+)${PLACEHOLDER}`, "g"),
    (_m, i) => codeStore[Number(i)],
  );

  return text.trim();
}

/**
 * Reply to a Telegram message rendering Markdown as HTML, with an
 * automatic fallback to plain text if Telegram rejects the formatting
 * (e.g. an unexpected tag/entity in the converted output).
 *
 * @param {object} ctx - Telegraf context
 * @param {string} markdown - The agent's markdown text
 * @param {object} [extra] - Extra Telegram sendMessage options
 * @param {object} [log] - Optional logger with a `.warn` method
 */
export async function replyWithMarkdown(ctx, markdown, extra = {}, log) {
  const html = markdownToTelegramHtml(markdown);
  try {
    return await ctx.reply(html, { parse_mode: "HTML", ...extra });
  } catch (err) {
    log?.warn?.(
      "HTML reply rejected by Telegram, falling back to plain text:",
      err?.message || err,
    );
    // Fallback: send the original markdown as plain text (no parse_mode).
    return ctx.reply(markdown, extra);
  }
}
