import fs from "node:fs";
import path from "node:path";

import { SUPPORTED_VERSION } from "./slack-plugin-root.mjs";

// Stock 2026.9.8 requires delegated external-plugin edits to name the exact
// current conversation, but the shared message tool still accepts the older
// `channel` field. A model can therefore identify the current Slack channel
// and root message correctly while the host sees no canonical target and
// rejects the edit. Infer only the already-attested current Slack target when
// the edit's message id is exactly the trusted current thread root. The stock
// provider, account, and conversation gate runs afterward, and Slack still
// enforces that the selected bot authored the message.

const coreDist = process.env.OPENCLAW_CORE_DIST ?? "/opt/homebrew/lib/node_modules/openclaw/dist";
const coreVersion = JSON.parse(fs.readFileSync(path.join(coreDist, "..", "package.json"), "utf8")).version;
if (coreVersion !== SUPPORTED_VERSION) throw new Error(`Unsupported OpenClaw core version ${coreVersion}; review the patch.`);

const before = `\tconst target = typeof params.ctx.params.target === "string" ? params.ctx.params.target.trim() : "";
\tif (!target) return params.ctx;`;
const inserted = `\tconst inferredCurrentRootTarget = (() => {
\t\tif (String(params.ctx.channel ?? "").trim().toLowerCase() !== "slack" || params.ctx.action !== "edit") return;
\t\tif ([params.ctx.params.target, params.ctx.params.to, params.ctx.params.channelId].some((value) => typeof value === "string" && Boolean(value.trim()))) return;
\t\tconst messageId = String(params.ctx.params.messageId ?? "").trim();
\t\tconst currentThreadTs = String(params.ctx.toolContext?.currentThreadTs ?? "").trim();
\t\tconst currentProvider = String(params.ctx.toolContext?.currentChannelProvider ?? "").trim().toLowerCase();
\t\tconst accountId = String(params.ctx.accountId ?? "").trim().toLowerCase();
\t\tconst requesterAccountId = String(params.ctx.requesterAccountId ?? "").trim().toLowerCase();
\t\tif (!messageId || messageId !== currentThreadTs || currentProvider !== "slack" || !accountId || accountId !== requesterAccountId) return;
\t\treturn [params.ctx.toolContext?.currentMessagingTarget, params.ctx.toolContext?.currentChannelId]
\t\t\t.find((value) => typeof value === "string" && Boolean(value.trim()))?.trim();
\t})();
\tif (inferredCurrentRootTarget) return {
\t\t...params.ctx,
\t\tparams: {...params.ctx.params, target: inferredCurrentRootTarget, to: inferredCurrentRootTarget}
\t};
${before}`;

let patched = 0;
let alreadyPatched = 0;
for (const name of fs.readdirSync(coreDist).filter((candidate) => candidate.endsWith(".mjs"))) {
  const file = path.join(coreDist, name);
  let source = fs.readFileSync(file, "utf8");
  if (!source.includes("function attachExternalCurrentTargetSibling")) continue;
  if (source.includes("const inferredCurrentRootTarget = (() =>")) {
    alreadyPatched += 1;
    continue;
  }
  const matches = source.split(before).length - 1;
  if (matches !== 1) throw new Error(`Expected one current-target anchor in ${file}, found ${matches}.`);
  source = source.replace(before, inserted);
  fs.writeFileSync(file, source);
  patched += 1;
}

if (patched === 0 && alreadyPatched === 0) throw new Error("No OpenClaw bundle contains attachExternalCurrentTargetSibling; review the installed version.");
console.log(JSON.stringify({ patched, alreadyPatched }));
