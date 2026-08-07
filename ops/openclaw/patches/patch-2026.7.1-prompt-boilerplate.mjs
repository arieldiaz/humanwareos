import fs from "node:fs";
import path from "node:path";

// Two per-turn prompt injections contradict the instance's layer-2 specs
// (docs/slack-style.md, docs/reply-shape.md) and win by proximity unless the
// specs spend words overriding them every turn:
//
//   1. The Slack plugin's inboundFormattingHints emits a response_format block
//      instructing Slack mrkdwn ("*single asterisks*", "no markdown headings").
//      This instance renders standard Markdown into Block Kit via
//      patch-2026.7.1-slack-rich-text.mjs, so the correct per-turn hint is the
//      opposite one. (Upstream's own messageToolHints in the same file already
//      say "write standard Markdown" — the inbound hint is the stale half.)
//
//   2. The core group-chat context tells the agent to "mostly lurk", reply
//      when it "can add clear value", avoid "document-style spacing", and
//      twice to "Be extremely selective". The instance's rules are stricter
//      on unprompted speech (registry-listed channels only, added value is
//      not a licence) and *require* document structure (## sections, closing
//      header) — and an explicit mention must always get a response.
//
// Plugin hooks cannot fix this: before_prompt_build can append or blindly
// replace the whole system prompt, but never sees the assembled text, so
// surgical removal is impossible (verified 2026-08-07 against 2026.7.1-1).
//
// Idempotent, fails closed if the bundle shape changed. Restart the gateway
// after applying.

const coreDist = "/opt/homebrew/lib/node_modules/openclaw/dist";
const slackDist = path.join(
  process.env.HOME ?? "",
  ".openclaw/npm/projects/openclaw-slack-b25c10c1bd__openclaw-generation__g-0c72fcf9148ba807/node_modules/@openclaw/slack/dist",
);

const findOne = (dir, pattern, label) => {
  const matches = fs.readdirSync(dir).filter((name) => pattern.test(name));
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${label} bundle in ${dir}, found ${matches.length}.`);
  }
  return path.join(dir, matches[0]);
};

const result = { core: "unchanged", slack: "unchanged" };

// 1. Core group-chat boilerplate (buildGroupChatContext, one of the hashed
//    get-reply-*.js bundles).
{
  const candidates = fs
    .readdirSync(coreDist)
    .filter((name) => /^get-reply-.*\.js$/.test(name))
    .map((name) => path.join(coreDist, name));

  const lurkBefore =
    '\tlines.push("Be a good group participant: mostly lurk and follow the conversation; reply only when directly addressed or you can add clear value. Emoji reactions are welcome when available.");';
  const lurkAfter =
    '\tlines.push("Reply when directly addressed. Whether to speak unprompted is governed by the operator\'s channel rules, not by your own judgment of added value. Emoji reactions are welcome when available.");';
  const humanPattern = /\tlines\.push\(`Write like a human\.\$\{tableGuidance\}[^`]*`\);/g;
  const humanAfter =
    "\tlines.push(`Follow the operator's reply-style rules for formatting and structure where they exist; otherwise write like a human with normal chat conventions.${tableGuidance}`);";
  const selectiveBefore =
    '\tlines.push("Be extremely selective: reply only when directly addressed or clearly helpful.");';
  const selectiveAfter =
    '\tlines.push("An explicit mention or direct address always gets a response.");';

  let patchedFiles = 0;
  let alreadyPatchedFiles = 0;
  for (const file of candidates) {
    let source = fs.readFileSync(file, "utf8");
    if (!source.includes("buildGroupChatContext")) continue;
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

    const selectiveCount = source.split(selectiveBefore).length - 1;
    if (selectiveCount !== 2) {
      throw new Error(`Expected two 'Be extremely selective' lines in ${file}, found ${selectiveCount}.`);
    }
    source = source.replaceAll(selectiveBefore, selectiveAfter);

    fs.writeFileSync(file, source);
    patchedFiles += 1;
  }

  if (patchedFiles === 0 && alreadyPatchedFiles === 0) {
    throw new Error("No get-reply bundle contains buildGroupChatContext; review the installed version.");
  }
  result.core = patchedFiles > 0 ? `patched (${patchedFiles} bundle)` : "already patched";
}

// 2. Slack plugin response_format hints (agentPrompt in shared-*.js).
{
  const file = findOne(slackDist, /^shared-.*\.js$/, "Slack shared");
  let source = fs.readFileSync(file, "utf8");

  const marker = "inboundFormattingHints: () => ({";
  const start = source.indexOf(marker);
  if (start === -1) throw new Error("inboundFormattingHints not found in Slack plugin; review the installed version.");
  const end = source.indexOf("}),", start);
  if (end === -1) throw new Error("inboundFormattingHints block end not found; review the installed version.");
  const block = source.slice(start, end + 3);

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

  if (block.includes('"slack_mrkdwn"')) {
    source = source.slice(0, start) + hintsAfter + source.slice(end + 3);
    fs.writeFileSync(file, source);
    result.slack = "patched";
  } else if (!block.includes('"markdown"')) {
    throw new Error("inboundFormattingHints block has an unexpected shape; review the installed version.");
  }
}

console.log(JSON.stringify(result));
