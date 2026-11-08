import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {resolveSlackPluginDist} from "./slack-plugin-root.mjs";

// Slack's plain `text` field renders mrkdwn, which has no list primitive, and
// upstream 2026.11.2 still converts authored Markdown only to mrkdwn text or
// mrkdwn section blocks: lists become literal "• " lines whose wrapped lines
// snap back to column 0, and headings have no block. Hanging indents, true
// ordered lists, quotes, code blocks, and heading blocks only exist in Block
// Kit `rich_text`/`header` on the `blocks` field.
//
// This patch installs an instance-owned markdown -> rich_text converter into
// the Slack plugin and wires it into the text chunk post of sendMessageSlack
// (send-*.mjs). In 2026.11.2 both agent reply payloads (deliverReplies) and the
// message tool reach that post for text without explicit blocks; explicit
// caller-provided blocks take the upstream blocks branch and are untouched.
//
// The mrkdwn chunk stays Slack's notification/fallback text, and the converter
// returns null (no behavior change) for plain prose, oversized messages, media,
// multi-chunk, plain-text or pre-rendered mrkdwn sends, and anything over
// Slack's block limits.
//
// It also makes a channel root one line: a multi-line text send with no
// thread posts its first line as the root and the rest as the first reply in
// that thread, so the shape holds whichever harness or tool posted it. Media,
// block, DM and threaded sends are untouched.
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

const result = { module: MODULE_NAME, send: "unchanged", root: "unchanged" };

// 2. Text chunk rendering. Only single-message, media-free Markdown sends get
// blocks; explicit caller-provided blocks return through the stock branch.
{
  const before = `		} else chunksToPost = resolvedChunks.length ? resolvedChunks : [""];
		messages = chunksToPost.map((text) => opts.textIsSlackPlainText ? {
			text,
			mrkdwn: false
		} : { text });`;
  const after = `		} else chunksToPost = rootSplit ? [rootSplit.title, ...resolvedChunks] : resolvedChunks.length ? resolvedChunks : [""];
		messages = chunksToPost.map((text, partIndex) => {
			const autoRichTextBlocks = chunksToPost.length === (rootSplit ? 2 : 1) && partIndex === chunksToPost.length - 1 && !opts.mediaUrl && !opts.textIsSlackPlainText && !opts.textIsSlackMrkdwn ? markdownToSlackRichTextBlocks(rootSplit ? rootSplit.body : trimmedMessage) : void 0;
			return opts.textIsSlackPlainText ? { text, mrkdwn: false } : {
				text,
				...autoRichTextBlocks?.length ? { blocks: autoRichTextBlocks } : {}
			};
		});`;
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

// 3. Channel root split. The title line posts at the root; the body posts in
// its thread and keeps the single-chunk rich_text conversion.
{
  const steps = [
    {
      before: `	let lastMessageId = "";`,
      after: `	let lastMessageId = "";
	let rootTs;`,
    },
    {
      before: `			threadTs: opts.threadTs,
			identity: sendIdentity,`,
      after: `			threadTs: opts.threadTs ?? rootTs,
			identity: sendIdentity,`,
    },
    {
      before: `			text: trimmedMessage,
			chunkLimit: textChunkLimit,`,
      after: `			text: rootSplit ? rootSplit.body : trimmedMessage,
			chunkLimit: textChunkLimit,`,
    },
    {
      before: `	let messages;`,
      after: `	let messages;
	let rootSplit;`,
    },
    {
      before: `		const resolvedChunks = resolveSlackTextChunks({`,
      after: `		rootSplit = !opts.threadTs && !opts.mediaUrl && !blocks && recipient.kind === "channel" ? splitSlackChannelRoot(trimmedMessage) : null;
		const resolvedChunks = resolveSlackTextChunks({`,
    },
    {
      before: `		if (pendingBlockFallback && partDelivery.meta?.slackQuestionActionIds.length) questionDelivery = partDelivery;`,
      after: `		if (rootSplit && partIndex === 0) rootTs = partDelivery.messageId;
		if (pendingBlockFallback && partDelivery.meta?.slackQuestionActionIds.length) questionDelivery = partDelivery;`,
    },
    {
      before: `	return {
		messageId: lastMessageId,
		channelId: deliveredChannelId,
		threadTs: deliveredThreadTs,
		...questionDelivery?.meta ? { meta: {
			...questionDelivery.meta,
			slackQuestionMessageId: questionDelivery.messageId
		} } : {},
		receipt: createSlackSendReceiptFromResults(deliveredResults, deliveredThreadTs)
	};`,
      after: `	return {
		messageId: rootTs ?? lastMessageId,
		channelId: deliveredChannelId,
		threadTs: deliveredThreadTs,
		...questionDelivery?.meta ? { meta: {
			...questionDelivery.meta,
			slackQuestionMessageId: questionDelivery.messageId
		} } : {},
		receipt: createSlackSendReceiptFromResults(deliveredResults, deliveredThreadTs)
	};`,
    },
  ];
  const importLine = `import { splitSlackChannelRoot } from "./${MODULE_NAME}";\n`;
  let source = fs.readFileSync(sendFile, "utf8");
  if (source.includes("splitSlackChannelRoot")) {
    result.root = "alreadyPatched";
  } else {
    for (const { before } of steps) {
      if (source.split(before).length !== 2) {
        throw new Error(`sendMessageSlack root shape changed in ${sendFile}; review before patching.`);
      }
    }
    for (const { before, after } of steps) source = source.replace(before, after);
    source = importLine + source;
    fs.writeFileSync(sendFile, source);
    result.root = "patched";
  }
}

console.log(JSON.stringify(result));
