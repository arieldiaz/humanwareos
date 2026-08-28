import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Slack's plain `text` field renders mrkdwn, which has no list primitive, so
// the upstream Slack formatter flattens markdown lists into literal "• " lines:
// wrapped lines snap back to column 0 and nested items get two leading spaces
// instead of a real indent level. Hanging indents (and true ordered lists,
// quotes, code blocks, and heading blocks) only exist in Block Kit `rich_text`
// on the `blocks` field.
//
// This patch installs an instance-owned markdown -> rich_text converter into
// the Slack plugin and wires it into the two paths that deliver visible text:
//
//   1. readSlackReplyBlocks (replies-*.js) — agent reply payloads. Explicit
//      caller-provided blocks always win; auto blocks only fill the gap.
//   2. sendMessageSlack (send-*.js) — the message tool, which is how every
//      visible reply in this instance is delivered.
//
// Both keep the mrkdwn text as Slack's notification/fallback text, and the
// converter returns null (no behavior change) for plain prose, oversized
// messages, media sends, and anything that would exceed Slack's block limits.
//
// Idempotent, fails closed if the bundle shape changed. Restart the gateway
// after applying.

const pluginRoot = path.join(
  process.env.HOME ?? "",
  ".openclaw/npm/projects/openclaw-slack-b25c10c1bd__openclaw-generation__g-0c72fcf9148ba807/node_modules/@openclaw/slack/dist",
);
const moduleSource = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "slack-rich-text/markdown-to-rich-text.mjs",
);
const MODULE_NAME = "openclaw-instance-rich-text.js";

if (!fs.existsSync(pluginRoot)) {
  throw new Error(`Slack plugin dist not found at ${pluginRoot}; the install layout changed and must be reviewed.`);
}
if (!fs.existsSync(moduleSource)) {
  throw new Error(`Converter module missing at ${moduleSource}.`);
}

const findOne = (pattern, label) => {
  const matches = fs.readdirSync(pluginRoot).filter((name) => pattern.test(name));
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${label} bundle in ${pluginRoot}, found ${matches.length}.`);
  }
  return path.join(pluginRoot, matches[0]);
};

// 1. Install the converter next to the bundles it is imported from.
fs.copyFileSync(moduleSource, path.join(pluginRoot, MODULE_NAME));

const result = { module: MODULE_NAME, replies: "unchanged", send: "unchanged" };

// 2. Reply payload path.
const repliesFile = findOne(/^replies-.*\.js$/, "Slack replies");
{
  const before = `function readSlackReplyBlocks(payload) {
	return resolveSlackReplyBlocks(payload);
}`;
  const after = `function readSlackReplyBlocks(payload) {
	const explicitSlackBlocks = resolveSlackReplyBlocks(payload);
	if (explicitSlackBlocks?.length) return explicitSlackBlocks;
	return markdownToSlackRichTextBlocks(payload?.text) ?? explicitSlackBlocks;
}`;
  const importLine = `import { markdownToSlackRichTextBlocks } from "./${MODULE_NAME}";\n`;
  let source = fs.readFileSync(repliesFile, "utf8");
  if (source.includes("markdownToSlackRichTextBlocks")) {
    result.replies = "alreadyPatched";
  } else {
    if (!source.includes(before)) {
      throw new Error(`readSlackReplyBlocks shape changed in ${repliesFile}; review before patching.`);
    }
    source = importLine + source.replace(before, after);
    fs.writeFileSync(repliesFile, source);
    result.replies = "patched";
  }
}

// 3. Message-tool send path. Only single-chunk, media-free sends get blocks:
// multi-chunk splits would need per-chunk conversion, and media sends carry
// their text as a file caption.
const sendFile = findOne(/^send-.*\.js$/, "Slack send");
{
  const before = `		const posted = await postSlackMessageBestEffort({
			client,
			channelId,
			text: chunk,
			threadTs: opts.threadTs,`;
  const after = `		const autoRichTextBlocks = chunksToPost.length === 1 && !opts.mediaUrl ? markdownToSlackRichTextBlocks(trimmedMessage) : void 0;
		const posted = await postSlackMessageBestEffort({
			client,
			channelId,
			text: chunk,
			...autoRichTextBlocks?.length ? { blocks: autoRichTextBlocks } : {},
			threadTs: opts.threadTs,`;
  const importLine = `import { markdownToSlackRichTextBlocks } from "./${MODULE_NAME}";\n`;
  let source = fs.readFileSync(sendFile, "utf8");
  if (source.includes("markdownToSlackRichTextBlocks")) {
    result.send = "alreadyPatched";
  } else {
    if (!source.includes(before)) {
      throw new Error(`sendMessageSlack chunk post shape changed in ${sendFile}; review before patching.`);
    }
    source = importLine + source.replace(before, after);
    fs.writeFileSync(sendFile, source);
    result.send = "patched";
  }
}

console.log(JSON.stringify(result));
