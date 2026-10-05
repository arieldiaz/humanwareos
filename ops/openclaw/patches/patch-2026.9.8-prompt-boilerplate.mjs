import fs from "node:fs";
import path from "node:path";
import {SUPPORTED_VERSION, resolveSlackPluginDist} from "./slack-plugin-root.mjs";

// Two per-turn prompt injections contradict the instance's layer-2 specs
// (docs/slack-style.md, docs/reply-shape.md) and win by proximity unless the
// specs spend words overriding them every turn:
//
//   1. The core group-chat context (buildGroupChatContext) tells the agent to
//      "mostly lurk" and reply when it "can add clear value", and to avoid
//      "document-style spacing". Unprompted speech is governed by the
//      operator's channel rules, an explicit mention always gets a response,
//      and reply structure is owned by docs/reply-shape.md.
//
//   2. The Slack plugin's inboundFormattingHints says OpenClaw converts
//      Markdown to mrkdwn and steers tabular data to presentation table
//      blocks. This instance renders Markdown into Block Kit rich_text via
//      patch-2026.9.8-slack-rich-text.mjs and wants small tables as fenced
//      text, so the hint states the house render chain instead.
//
// Plugin hooks cannot fix this: before_prompt_build never sees the assembled
// text, so surgical removal is impossible.
//
// Idempotent, fails closed if the bundle shape changed. Restart the gateway
// after applying.

const coreDist = process.env.OPENCLAW_CORE_DIST ?? "/opt/homebrew/lib/node_modules/openclaw/dist";
const coreVersion = JSON.parse(fs.readFileSync(path.join(coreDist, "..", "package.json"), "utf8")).version;
if (coreVersion !== SUPPORTED_VERSION) throw new Error(`Unsupported OpenClaw core version ${coreVersion}; review the patch.`);
const slackBundles = path.join(resolveSlackPluginDist(), ".setup");

const result = { core: "unchanged", slack: "unchanged" };

// 1. Core group-chat boilerplate (buildGroupChatContext in get-reply-*.mjs).
{
  const candidates = fs
    .readdirSync(coreDist)
    .filter((name) => /^get-reply-.*\.mjs$/.test(name))
    .map((name) => path.join(coreDist, name));

  const lurkBefore =
    '\tlines.push("Be a good group participant: mostly lurk and follow the conversation; reply only when directly addressed or you can add clear value. Emoji reactions are welcome when available.");';
  const lurkAfter =
    '\tlines.push("Reply when directly addressed. Whether to speak unprompted is governed by the operator\'s channel rules, not by your own judgment of added value. An explicit mention always gets a response. Emoji reactions are welcome when available.");';
  const humanPattern = /\tlines\.push\(`Write like a human\.\$\{tableGuidance\}[^`]*`\);/g;
  const humanAfter =
    "\tlines.push(`Follow the operator's reply-style rules for formatting and structure where they exist; otherwise write like a human with normal chat conventions.${tableGuidance}`);";

  let patchedFiles = 0;
  let alreadyPatchedFiles = 0;
  for (const file of candidates) {
    let source = fs.readFileSync(file, "utf8");
    if (!source.includes("function buildGroupChatContext")) continue;
    if (source.includes(lurkAfter)) {
      alreadyPatchedFiles += 1;
      continue;
    }
    if (!source.includes(lurkBefore)) {
      throw new Error(`Group-chat lurk line not found in ${file}; review the installed version.`);
    }
    source = source.replace(lurkBefore, lurkAfter);
    const humanMatches = source.match(humanPattern) ?? [];
    if (humanMatches.length !== 1) {
      throw new Error(`Expected one 'Write like a human' line in ${file}, found ${humanMatches.length}.`);
    }
    source = source.replace(humanPattern, humanAfter);
    fs.writeFileSync(file, source);
    patchedFiles += 1;
  }
  if (patchedFiles === 0 && alreadyPatchedFiles === 0) {
    throw new Error("No get-reply bundle contains buildGroupChatContext; review the installed version.");
  }
  result.core = patchedFiles > 0 ? `patched (${patchedFiles} bundle)` : "already patched";
}

// 2. Slack plugin response_format hints (shared-*.mjs).
{
  const matches = fs.readdirSync(slackBundles).filter((name) => /^shared-.*\.mjs$/.test(name));
  if (matches.length !== 1) throw new Error(`Expected exactly one Slack shared bundle in ${slackBundles}, found ${matches.length}.`);
  const file = path.join(slackBundles, matches[0]);
  let source = fs.readFileSync(file, "utf8");

  const marker = "inboundFormattingHints: () => ({";
  const start = source.indexOf(marker);
  if (start === -1) throw new Error("inboundFormattingHints not found in Slack plugin; review the installed version.");
  const end = source.indexOf("}),", start);
  if (end === -1) throw new Error("inboundFormattingHints block end not found; review the installed version.");
  const block = source.slice(start, end + 3);

  const houseRule = "the gateway renders it for Slack.";
  const hintsAfter = [
    "inboundFormattingHints: () => ({",
    '\t\t\t\ttext_markup: "markdown",',
    "\t\t\t\trules: [",
    '\t\t\t\t\t"Write standard Markdown (**bold**, ## headings, - lists, [label](url)); the gateway renders it for Slack.",',
    '\t\t\t\t\t"Never hand-write Slack mrkdwn (*bold*, <url|label>).",',
    '\t\t\t\t\t"No pipe tables; tabular data goes in a fenced code block."',
    "\t\t\t\t]",
    "\t\t\t}),",
  ].join("\n");

  if (block.includes(houseRule)) {
    // already patched
  } else if (block.includes('"Write replies in standard Markdown; OpenClaw converts them to Slack mrkdwn."')) {
    source = source.slice(0, start) + hintsAfter + source.slice(end + 3);
    fs.writeFileSync(file, source);
    result.slack = "patched";
  } else {
    throw new Error("inboundFormattingHints block has an unexpected shape; review the installed version.");
  }
}

console.log(JSON.stringify(result));
