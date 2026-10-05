import fs from "node:fs";
import path from "node:path";

// Three still-present 2026.9.8 core bugs (see README):
//   1. A terminal event from the session's current writer is suppressed when
//      restartRecoveryRuns still names an older run, leaving the row `running`.
//   2. SESSION_WORK_START_CHANGED dead-letters at maxAttempts (8 quick tries)
//      instead of honoring the deadLetterMinAgeMs floor every other retry uses.
//   3. Raw Slack Events API bodies (including `token`) are persisted to
//      payload_json and printed by `channels dead-letters` unredacted.
// Idempotent; fails closed when the version or any bundle anchor changed.

const SUPPORTED_VERSION = "2026.9.8";
const distDir = process.env.OPENCLAW_CORE_DIST || path.join(process.env.OPENCLAW_PACKAGE_ROOT || "/opt/homebrew/lib/node_modules/openclaw", "dist");
const coreVersion = JSON.parse(fs.readFileSync(path.join(distDir, "..", "package.json"), "utf8")).version;
if (coreVersion !== SUPPORTED_VERSION) throw new Error(`Unsupported OpenClaw core version ${coreVersion}; review patch-2026.9.8-slack-response-reliability.mjs.`);

function patchBundles(pattern, marker, transform, label) {
  const candidates = fs.readdirSync(distDir).filter((name) => pattern.test(name)).map((name) => path.join(distDir, name)).filter((file) => fs.readFileSync(file, "utf8").includes(marker));
  if (candidates.length === 0) throw new Error(`No OpenClaw ${label} bundle found; the installed version changed and must be reviewed.`);
  let patched = 0;
  let alreadyPatched = 0;
  for (const file of candidates) {
    const source = fs.readFileSync(file, "utf8");
    if (source.includes(`humanware:${label}`)) {
      alreadyPatched += 1;
      continue;
    }
    const result = transform(source);
    if (result === null) throw new Error(`OpenClaw ${label} anchor missing in ${path.basename(file)}; the installed version changed and must be reviewed.`);
    fs.writeFileSync(file, result);
    patched += 1;
  }
  return { patched, alreadyPatched };
}

function replaceAll(source, pairs) {
  let updated = source;
  for (const [before, after] of pairs) {
    if (updated.split(before).length !== 2) return null;
    updated = updated.replace(before, () => after);
  }
  return updated;
}

const lifecycleBefore = `\tconst runs = params.entry?.restartRecoveryRuns;
\tconst matchesFence = Boolean(runId && lifecycleGeneration && runs?.some((run) => run.runId === runId && run.lifecycleGeneration === lifecycleGeneration));
\tconst remaining = matchesFence ? runs?.filter((run) => run.runId !== runId || lifecycleGeneration !== params.currentLifecycleGeneration && run.lifecycleGeneration !== lifecycleGeneration) : runs;`;
const lifecycleAfter = `\tconst runs = params.entry?.restartRecoveryRuns;
\t// humanware:terminal-current-writer-recovery
\tconst matchesCurrentWriter = Boolean(runId && lifecycleGeneration === params.currentLifecycleGeneration && params.entry?.activeWriterRunId === runId && params.entry?.lifecycleRunId === runId);
\tconst matchesFence = matchesCurrentWriter || Boolean(runId && lifecycleGeneration && runs?.some((run) => run.runId === runId && run.lifecycleGeneration === lifecycleGeneration));
\tconst remaining = matchesCurrentWriter ? [] : matchesFence ? runs?.filter((run) => run.runId !== runId || lifecycleGeneration !== params.currentLifecycleGeneration && run.lifecycleGeneration !== lifecycleGeneration) : runs;`;

const retryBefore = `\tif (attempt >= maxAttempts && errorCodes.has("SESSION_WORK_START_CHANGED")) return {`;
const retryAfter = `\t// humanware:session-conflict-age-gate
\tif (attempt >= maxAttempts && errorCodes.has("SESSION_WORK_START_CHANGED") && shouldDeadLetterRetryableIngressEvent(params.event, attempt, params.config, now)) return {`;

const secretKey = `/^(?:token|authorization|cookie|x-slack-signature)$/i`;
const queueMarker = `//#region src/channels/message/ingress-queue.ts`;
const queueHelper = `// humanware:redact-ingress-secrets
function redactIngressSecrets(value) {
\tif (Array.isArray(value)) return value.map(redactIngressSecrets);
\tif (!value || typeof value !== "object") return value;
\treturn Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, ${secretKey}.test(key) ? "[REDACTED]" : redactIngressSecrets(nested)]));
}
`;
const queueBefore = `\t\t\t\tpayloadJson: JSON.stringify(payload),`;
const queueAfter = `\t\t\t\tpayloadJson: JSON.stringify(redactIngressSecrets(payload)),`;

const redactJson = (expr) => `JSON.parse(JSON.stringify(${expr}, (key, value) => ${secretKey}.test(key) ? "[REDACTED]" : value))`;
const deadLetterBefore = `\tconst deadLetters = await queue.listFailed({ limit: parseLimit(options.limit) });`;
const deadLetterAfter = `\t// humanware:redact-dead-letter-secrets
\tconst deadLetters = (await queue.listFailed({ limit: parseLimit(options.limit) })).map((entry) => ({ ...entry, payload: ${redactJson("entry.payload ?? null")} }));`;
const resubmitBefore = `\t\tif (options.json) writeRuntimeJson(runtime, {
\t\t\tchannelId,
\t\t\taccountId,
\t\t\teventId,
\t\t\tresult
\t\t});`;
const resubmitAfter = `\t\tif (options.json) writeRuntimeJson(runtime, {
\t\t\tchannelId,
\t\t\taccountId,
\t\t\teventId,
\t\t\tresult: ${redactJson("result")}
\t\t});`;

const results = {
  lifecycle: patchBundles(/^main-session-recovery-lifecycle-.*\.mjs$/, "//#region src/agents/main-session-recovery/main-session-recovery-lifecycle.ts", (s) => replaceAll(s, [[lifecycleBefore, lifecycleAfter]]), "terminal-current-writer-recovery"),
  retry: patchBundles(/^ingress-drain-.*\.mjs$/, "//#region src/channels/message/ingress-retry-policy.ts", (s) => replaceAll(s, [[retryBefore, retryAfter]]), "session-conflict-age-gate"),
  queue: patchBundles(/^ingress-queue-.*\.mjs$/, queueMarker, (s) => replaceAll(s, [[queueBefore, queueAfter], [queueMarker, `${queueHelper}${queueMarker}`]]), "redact-ingress-secrets"),
  deadLetters: patchBundles(/^dead-letters-.*\.mjs$/, "//#region src/commands/channels/dead-letters.ts", (s) => replaceAll(s, [[deadLetterBefore, deadLetterAfter], [resubmitBefore, resubmitAfter]]), "redact-dead-letter-secrets"),
};

console.log(JSON.stringify(results));
