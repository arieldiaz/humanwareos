import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {resolveSlackPluginDist} from "./slack-plugin-root.mjs";

// Slack's plain `text` field renders mrkdwn, which has no list primitive, and
// upstream 2026.9.8 still converts authored Markdown only to mrkdwn text or
// mrkdwn section blocks: lists become literal "• " lines whose wrapped lines
// snap back to column 0, and headings have no block. Hanging indents, true
// ordered lists, quotes, code blocks, and heading blocks only exist in Block
// Kit `rich_text`/`header` on the `blocks` field.
//
// This patch installs an instance-owned markdown -> rich_text converter into
// the Slack plugin and wires it into the text chunk post of sendMessageSlack
// (send-*.mjs). In 2026.9.8 both agent reply payloads (deliverReplies) and the
// message tool reach that post for text without explicit blocks; explicit
// caller-provided blocks take the upstream blocks branch and are untouched.
//
// The mrkdwn chunk stays Slack's notification/fallback text, and the converter
// returns null (no behavior change) for plain prose, oversized messages, media,
// multi-chunk, plain-text or pre-rendered mrkdwn sends, and anything over
// Slack's block limits.
//
// Idempotent, fails closed if the bundle shape changed. Restart the gateway
// after applying.

const pluginRoot = path.join(resolveSlackPluginDist(), ".setup");
const moduleSource = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "slack-rich-text/markdown-to-rich-text.mjs",
);
const MODULE_NAME = "openclaw-instance-rich-text.js";

if (!fs.existsSync(pluginRoot)) {
  throw new Error(`Slack plugin bundles not found at ${pluginRoot}; the install layout changed and must be reviewed.`);
}
if (!fs.existsSync(moduleSource)) {
  throw new Error(`Converter module missing at ${moduleSource}.`);
}

const matches = fs.readdirSync(pluginRoot)
  .filter((name) => /^send-.*\.mjs$/.test(name))
  .filter((name) => fs.readFileSync(path.join(pluginRoot, name), "utf8").includes("async function sendMessageSlack("));
if (matches.length !== 1) {
  throw new Error(`Expected exactly one Slack send bundle in ${pluginRoot}, found ${matches.length}.`);
}
const sendFile = path.join(pluginRoot, matches[0]);

// 1. Install the converter next to the bundle it is imported from.
fs.copyFileSync(moduleSource, path.join(pluginRoot, MODULE_NAME));

const result = { module: MODULE_NAME, send: "unchanged" };

// 2. Text chunk post. Only single-chunk, media-free Markdown sends get blocks:
// multi-chunk splits would need per-chunk conversion, and media sends carry
// their text as a file caption.
{
  const before = `		if (partIndex === 0 && !opts.mediaUrl) await dispatchOnce();
		await postPart({
			text: chunk,
			replyBroadcast: carriesPrimaryMessageOptions ? opts.replyBroadcast : void 0,
			metadata,`;
  const after = `		if (partIndex === 0 && !opts.mediaUrl) await dispatchOnce();
		const autoRichTextBlocks = chunksToPost.length === 1 && !opts.mediaUrl && !opts.textIsSlackPlainText && !opts.textIsSlackMrkdwn ? markdownToSlackRichTextBlocks(trimmedMessage) : void 0;
		await postPart({
			text: chunk,
			...autoRichTextBlocks?.length ? { blocks: autoRichTextBlocks } : {},
			replyBroadcast: carriesPrimaryMessageOptions ? opts.replyBroadcast : void 0,
			metadata,`;
  const importLine = `import { markdownToSlackRichTextBlocks } from "./${MODULE_NAME}";\n`;
  let source = fs.readFileSync(sendFile, "utf8");
  if (source.includes("markdownToSlackRichTextBlocks")) {
    result.send = "alreadyPatched";
  } else {
    if (source.split(before).length !== 2) {
      throw new Error(`sendMessageSlack chunk post shape changed in ${sendFile}; review before patching.`);
    }
    source = importLine + source.replace(before, after);
    fs.writeFileSync(sendFile, source);
    result.send = "patched";
  }
}

console.log(JSON.stringify(result));
