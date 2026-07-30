// Markdown -> Slack Block Kit rich_text converter (instance-owned).
//
// Why: Slack's plain `text` field renders mrkdwn, which has NO list primitive.
// OpenClaw's Slack formatter therefore flattens markdown lists into literal
// "• " lines, so wrapped lines run back to column 0 and nested items only get
// two leading spaces. Real hanging indents require Block Kit `rich_text` with
// `rich_text_list` elements, which are only available on the `blocks` field.
//
// This module converts markdown to blocks and returns null whenever the input
// gains nothing from blocks (plain prose) or exceeds Slack's block limits, so
// callers keep the upstream text path as the default.
//
// Slack reference points encoded here:
// - `header` is the only heading primitive and has exactly ONE size. There is
//   no h1/h2/h3 ladder. Hierarchy = header block (md h1/h2) vs bold rich_text
//   line (md h3+). Header text is plain_text: no bold/italic/links, but
//   :emoji: shortcodes do render.
// - rich_text text elements are raw, NOT mrkdwn: they must not be HTML-escaped,
//   and `:emoji:` inside them does not render, so emoji become their own
//   `emoji` elements.
// - `rich_text_list` carries one `indent` level per element, so each indent
//   depth becomes its own list element.

const MAX_BLOCKS = 45; // Slack hard limit is 50; leave headroom for interactive blocks.
const MAX_TOTAL_CHARS = 10000;
const HEADER_TEXT_MAX = 150;

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const DIVIDER_RE = /^\s{0,3}(?:\*\s*\*\s*\*[\s*]*|-\s*-\s*-[\s-]*|_\s*_\s*_[\s_]*)$/;
const BULLET_RE = /^(\s*)([-*+]|•)\s+(.*)$/;
const ORDERED_RE = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const QUOTE_RE = /^\s{0,3}>\s?(.*)$/;
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})\s*(\S*)\s*$/;

// Slack-native tokens we must hand through as structured elements.
const USER_MENTION_RE = /^<@([A-Z0-9]+)(?:\|[^>]*)?>/;
const CHANNEL_MENTION_RE = /^<#([A-Z0-9]+)(?:\|[^>]*)?>/;
const SPECIAL_MENTION_RE = /^<!(here|channel|everyone)(?:\|[^>]*)?>/;
const SLACK_LINK_RE = /^<((?:https?|mailto|tel|slack):[^>|]+)(?:\|([^>]*))?>/;
const MD_LINK_RE = /^\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/;
const BARE_URL_RE = /^(https?:\/\/[^\s<>()[\]]+[^\s<>()[\].,;:!?'"])/;
const EMOJI_RE = /^:([a-z0-9_+-]{1,64}):/i;

function unescapeSlackEntities(text) {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function pushText(elements, text, style) {
  if (!text) return;
  const element = { type: "text", text };
  if (style && Object.keys(style).length > 0) element.style = { ...style };
  const previous = elements[elements.length - 1];
  // Merge adjacent identical-style runs so the payload stays small.
  if (previous?.type === "text" && JSON.stringify(previous.style) === JSON.stringify(element.style)) {
    previous.text += text;
    return;
  }
  elements.push(element);
}

function matchDelimiter(source, index, delimiter) {
  if (!source.startsWith(delimiter, index)) return null;
  const contentStart = index + delimiter.length;
  const closeIndex = source.indexOf(delimiter, contentStart);
  if (closeIndex <= contentStart) return null;
  const content = source.slice(contentStart, closeIndex);
  if (/^\s|\s$/.test(content) && delimiter.length === 1) return null;
  return { content, next: closeIndex + delimiter.length };
}

/** Parse inline markdown (plus Slack-native tokens) into rich_text elements. */
function parseInline(markdown, style = {}) {
  const source = unescapeSlackEntities(markdown ?? "");
  const elements = [];
  let buffer = "";
  let index = 0;

  const flush = () => {
    pushText(elements, buffer, style);
    buffer = "";
  };

  while (index < source.length) {
    const rest = source.slice(index);
    const char = source[index];

    if (char === "`") {
      const fence = matchDelimiter(source, index, "``") ?? matchDelimiter(source, index, "`");
      if (fence) {
        flush();
        pushText(elements, fence.content, { ...style, code: true });
        index = fence.next;
        continue;
      }
    }

    if (char === "*" || char === "_" || char === "~") {
      const double = char.repeat(2);
      const strong = matchDelimiter(source, index, double);
      if (strong) {
        flush();
        const nested = char === "~" ? { ...style, strike: true } : { ...style, bold: true };
        elements.push(...parseInline(strong.content, nested));
        index = strong.next;
        continue;
      }
      const single = matchDelimiter(source, index, char);
      if (single) {
        flush();
        // Single `*` is bold in Slack mrkdwn and italic in markdown; agents in
        // this instance write markdown, but mrkdwn-shaped input reaches here
        // too (upstream pre-converts some paths). Bold is the safer read for
        // `*`, italic for `_`.
        const nested =
          char === "~" ? { ...style, strike: true } : char === "*" ? { ...style, bold: true } : { ...style, italic: true };
        elements.push(...parseInline(single.content, nested));
        index = single.next;
        continue;
      }
    }

    if (char === "<") {
      const user = USER_MENTION_RE.exec(rest);
      if (user) {
        flush();
        elements.push({ type: "user", user_id: user[1] });
        index += user[0].length;
        continue;
      }
      const channel = CHANNEL_MENTION_RE.exec(rest);
      if (channel) {
        flush();
        elements.push({ type: "channel", channel_id: channel[1] });
        index += channel[0].length;
        continue;
      }
      const special = SPECIAL_MENTION_RE.exec(rest);
      if (special) {
        flush();
        elements.push({ type: "broadcast", range: special[1] === "everyone" ? "channel" : special[1] });
        index += special[0].length;
        continue;
      }
      const slackLink = SLACK_LINK_RE.exec(rest);
      if (slackLink) {
        flush();
        const link = { type: "link", url: slackLink[1] };
        if (slackLink[2]) link.text = unescapeSlackEntities(slackLink[2]);
        if (Object.keys(style).length > 0) link.style = { ...style };
        elements.push(link);
        index += slackLink[0].length;
        continue;
      }
    }

    if (char === "[") {
      const mdLink = MD_LINK_RE.exec(rest);
      if (mdLink) {
        flush();
        const link = { type: "link", url: mdLink[2] };
        if (mdLink[1]) link.text = unescapeSlackEntities(mdLink[1]);
        if (Object.keys(style).length > 0) link.style = { ...style };
        elements.push(link);
        index += mdLink[0].length;
        continue;
      }
    }

    if (char === "h") {
      const bare = BARE_URL_RE.exec(rest);
      if (bare) {
        flush();
        const link = { type: "link", url: bare[1] };
        if (Object.keys(style).length > 0) link.style = { ...style };
        elements.push(link);
        index += bare[0].length;
        continue;
      }
    }

    if (char === ":") {
      const emoji = EMOJI_RE.exec(rest);
      if (emoji) {
        flush();
        elements.push({ type: "emoji", name: emoji[1].toLowerCase() });
        index += emoji[0].length;
        continue;
      }
    }

    buffer += char;
    index += 1;
  }

  flush();
  return elements;
}

function section(markdown, style) {
  return { type: "rich_text_section", elements: parseInline(markdown, style) };
}

/**
 * Convert markdown to Slack blocks.
 * Returns null when the caller should keep the upstream mrkdwn text path.
 */
export function markdownToSlackRichTextBlocks(markdown, options = {}) {
  const source = String(markdown ?? "").replace(/\r\n?/g, "\n").trim();
  if (!source) return null;
  if (source.length > MAX_TOTAL_CHARS) return null;

  const lines = source.split("\n");
  const blocks = [];
  let richElements = [];
  let paragraph = [];
  let quote = [];
  let sawStructure = false;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    richElements.push(section(paragraph.join("\n")));
    paragraph = [];
  };
  const flushQuote = () => {
    if (quote.length === 0) return;
    richElements.push({ type: "rich_text_quote", elements: parseInline(quote.join("\n")) });
    quote = [];
    sawStructure = true;
  };
  const flushRich = () => {
    flushParagraph();
    flushQuote();
    if (richElements.length === 0) return;
    blocks.push({ type: "rich_text", elements: richElements });
    richElements = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    const fence = FENCE_RE.exec(line);
    if (fence) {
      flushParagraph();
      flushQuote();
      const marker = fence[1];
      const body = [];
      index += 1;
      while (index < lines.length) {
        const candidate = FENCE_RE.exec(lines[index]);
        if (candidate && candidate[1].startsWith(marker[0])) break;
        body.push(lines[index]);
        index += 1;
      }
      richElements.push({
        type: "rich_text_preformatted",
        elements: [{ type: "text", text: unescapeSlackEntities(body.join("\n")) }],
      });
      sawStructure = true;
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      flushQuote();
      continue;
    }

    if (DIVIDER_RE.test(line)) {
      flushRich();
      blocks.push({ type: "divider" });
      sawStructure = true;
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      const level = heading[1].length;
      const text = heading[2].trim();
      if (level <= 2) {
        // `header` is the only real heading primitive and carries its own
        // vertical padding, which is where the extra section spacing comes from.
        flushRich();
        blocks.push({
          type: "header",
          text: { type: "plain_text", text: text.replace(/[*_~`]/g, "").slice(0, HEADER_TEXT_MAX), emoji: true },
        });
      } else {
        flushParagraph();
        flushQuote();
        richElements.push(section(text, { bold: true }));
      }
      sawStructure = true;
      continue;
    }

    const quoteMatch = QUOTE_RE.exec(line);
    if (quoteMatch) {
      flushParagraph();
      quote.push(quoteMatch[1]);
      continue;
    }
    flushQuote();

    const bullet = BULLET_RE.exec(line);
    const ordered = bullet ? null : ORDERED_RE.exec(line);
    if (bullet || ordered) {
      flushParagraph();
      const match = bullet ?? ordered;
      const indent = Math.min(Math.floor(match[1].replace(/\t/g, "  ").length / 2), 7);
      const style = bullet ? "bullet" : "ordered";
      const items = [section(match[3])];

      // Group consecutive items at the same depth and style into one list
      // element; a depth or style change starts a new one (Slack models indent
      // per list element, not per item).
      let lookahead = index + 1;
      while (lookahead < lines.length) {
        const nextBullet = BULLET_RE.exec(lines[lookahead]);
        const nextOrdered = nextBullet ? null : ORDERED_RE.exec(lines[lookahead]);
        const next = nextBullet ?? nextOrdered;
        if (!next) break;
        const nextIndent = Math.min(Math.floor(next[1].replace(/\t/g, "  ").length / 2), 7);
        const nextStyle = nextBullet ? "bullet" : "ordered";
        if (nextIndent !== indent || nextStyle !== style) break;
        items.push(section(next[3]));
        lookahead += 1;
      }
      index = lookahead - 1;

      richElements.push({ type: "rich_text_list", style, indent, elements: items });
      sawStructure = true;
      continue;
    }

    paragraph.push(line);
  }

  flushRich();

  if (blocks.length === 0) return null;
  if (blocks.length > MAX_BLOCKS) return null;
  // Plain prose gains nothing from blocks; keep upstream behavior untouched.
  if (!sawStructure && options.requireStructure !== false) return null;
  return blocks;
}

export default markdownToSlackRichTextBlocks;
