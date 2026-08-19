import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const patchPath = fileURLToPath(new URL("./patch-2026.7.1-2-acp-bound-source-delivery.mjs", import.meta.url));

const unpatchedFixture = `function resolveAcpTurnText(params) {
\tif (params.sourceReplyDeliveryMode !== "message_tool_only") return params.promptText;
\treturn params.promptText;
}
async function tryDispatchAcpReply(params) {
\tconst canonicalSessionKey = acpResolution.sessionKey;
\tconst acpAgentId = resolveAgentIdFromSessionKey(canonicalSessionKey);
\tconst delivery = createAcpDispatchDeliveryCoordinator({
\t\tsuppressUserDelivery: params.suppressUserDelivery,
\t});
\treturn acpManager.runTurn({
\t\t\ttext: resolveAcpTurnText({
\t\t\t\tpromptText: turnPromptText,
\t\t\t\tsourceReplyDeliveryMode: params.sourceReplyDeliveryMode
\t\t\t}),
\t});
}`;

const legacyFixture = unpatchedFixture
  .replace(
    `\tconst canonicalSessionKey = acpResolution.sessionKey;\n\tconst acpAgentId = resolveAgentIdFromSessionKey(canonicalSessionKey);`,
    `\tconst canonicalSessionKey = acpResolution.sessionKey;\n\tconst acpAgentId = resolveAgentIdFromSessionKey(canonicalSessionKey);\n\tconst arielosBoundChannelTurn = params.sourceReplyDeliveryMode === "message_tool_only" && params.ctx.InboundEventKind === "user_request" && await hasBoundConversationForSession({\n\t\tcfg: params.cfg,\n\t\tsessionKey: canonicalSessionKey,\n\t\tchannelRaw: params.ctx.OriginatingChannel ?? params.ctx.Surface ?? params.ctx.Provider,\n\t\taccountIdRaw: params.ctx.AccountId\n\t});\n\tconst arielosAcpSourceReplyDeliveryMode = arielosBoundChannelTurn ? "automatic" : params.sourceReplyDeliveryMode;`,
  )
  .replace(
    "\t\tsuppressUserDelivery: params.suppressUserDelivery,",
    "\t\tsuppressUserDelivery: arielosBoundChannelTurn ? false : params.suppressUserDelivery,",
  )
  .replace(
    "\t\t\t\tsourceReplyDeliveryMode: params.sourceReplyDeliveryMode",
    "\t\t\t\tsourceReplyDeliveryMode: arielosAcpSourceReplyDeliveryMode",
  );

function runPatch(source) {
  const distDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-acp-bound-patch-"));
  const bundle = path.join(distDir, "dispatch-acp-fixture.js");
  fs.writeFileSync(bundle, source);
  execFileSync(process.execPath, [patchPath], {
    env: { ...process.env, OPENCLAW_DIST_DIR: distDir },
    stdio: "pipe",
  });
  return fs.readFileSync(bundle, "utf8");
}

test("static ACP binding session keys bypass message-tool-only suppression", () => {
  const patched = runPatch(unpatchedFixture);
  assert.match(patched, /const arielosStaticBindingPrefix = `agent:\$\{acpAgentId\}:acp:binding:\$\{arielosBoundChannel\}:\$\{arielosBoundAccountId\}:`;/);
  assert.match(patched, /canonicalSessionKey\.startsWith\(arielosStaticBindingPrefix\) \|\| await hasBoundConversationForSession/);
  assert.match(patched, /suppressUserDelivery: arielosBoundChannelTurn \? false : params\.suppressUserDelivery/);
  assert.match(patched, /sourceReplyDeliveryMode: arielosAcpSourceReplyDeliveryMode/);
  assert.match(patched, /arielosProjectedFinal: arielosBoundChannelTurn/);
  assert.match(patched, /Source channel delivery is automatic for this bound ACP turn/);
  assert.match(patched, /Do not call message\(action=send\) or any CLI delivery fallback/);
  assert.match(patched, /Do not include progress narration, delivery tests, or internal work notes/);
});

test("patch is idempotent", () => {
  const once = runPatch(unpatchedFixture);
  const twice = runPatch(once);
  assert.equal(twice, once);
});

test("database-only legacy patch upgrades to static binding recognition", () => {
  const patched = runPatch(legacyFixture);
  assert.match(patched, /arielosStaticBindingPrefix/);
  assert.doesNotMatch(patched, /accountIdRaw: params\.ctx\.AccountId/);
  assert.match(patched, /arielosProjectedFinalGuidance/);
});

test("current static-binding patch upgrades with the projected-final contract", () => {
  const staticOnly = runPatch(unpatchedFixture)
    .replace(/\tif \(params\.arielosProjectedFinal\) \{[\s\S]*?\n\t\}\n\tif \(params\.sourceReplyDeliveryMode/, "\tif (params.sourceReplyDeliveryMode")
    .replace(",\n\t\t\t\tarielosProjectedFinal: arielosBoundChannelTurn", "");
  const upgraded = runPatch(staticOnly);
  assert.match(upgraded, /arielosProjectedFinalGuidance/);
  assert.match(upgraded, /arielosProjectedFinal: arielosBoundChannelTurn/);
});
