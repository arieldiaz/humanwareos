import fs from "node:fs";
import path from "node:path";

const packageRoot = process.env.OPENCLAW_PACKAGE_ROOT || "/opt/homebrew/lib/node_modules/openclaw";
const distDir = process.env.OPENCLAW_CORE_DIST || path.join(packageRoot, "dist");

function patchBundles(pattern, transform, label) {
  const candidates = fs.readdirSync(distDir).filter((name) => pattern.test(name)).map((name) => path.join(distDir, name));
  let patched = 0;
  let alreadyPatched = 0;
  for (const file of candidates) {
    const source = fs.readFileSync(file, "utf8");
    const result = transform(source);
    if (result === source) {
      if (source.includes(`humanware:${label}`)) alreadyPatched += 1;
      continue;
    }
    fs.writeFileSync(file, result);
    patched += 1;
  }
  if (patched === 0 && alreadyPatched === 0) throw new Error(`No matching OpenClaw ${label} bundle found; the installed version changed and must be reviewed.`);
  return { patched, alreadyPatched, candidates: candidates.length };
}

const lifecycleBefore = `\tconst runs = params.entry?.restartRecoveryRuns;
\tconst matchesFence = Boolean(runId && lifecycleGeneration && runs?.some((run) => run.runId === runId && run.lifecycleGeneration === lifecycleGeneration));
\tconst remaining = matchesFence ? runs?.filter((run) => run.runId !== runId || lifecycleGeneration !== params.currentLifecycleGeneration && run.lifecycleGeneration !== lifecycleGeneration) : runs;`;
const lifecycleAfter = `\tconst runs = params.entry?.restartRecoveryRuns;
\t// humanware:terminal-current-writer-recovery
\tconst matchesCurrentWriter = Boolean(runId && lifecycleGeneration === params.currentLifecycleGeneration && params.entry?.activeWriterRunId === runId && params.entry?.lifecycleRunId === runId);
\tconst matchesFence = matchesCurrentWriter || Boolean(runId && lifecycleGeneration && runs?.some((run) => run.runId === runId && run.lifecycleGeneration === lifecycleGeneration));
\tconst remaining = matchesCurrentWriter ? [] : matchesFence ? runs?.filter((run) => run.runId !== runId || lifecycleGeneration !== params.currentLifecycleGeneration && run.lifecycleGeneration !== lifecycleGeneration) : runs;`;

const retryBefore = `\tif (attempt >= maxAttempts && isSessionStartConflictFailure(params.err)) return {
\t\tkind: "fail",
\t\treason: "session-start-conflict-retry-limit",
\t\tmessage,
\t\tattempt
\t};`;
const retryAfter = `\t// humanware:session-conflict-age-gate
\tif (attempt >= maxAttempts && isSessionStartConflictFailure(params.err) && shouldDeadLetterRetryableIngressEvent(params.event, attempt, params.config, now)) return {
\t\tkind: "fail",
\t\treason: "session-start-conflict-retry-limit",
\t\tmessage,
\t\tattempt
\t};`;

const queueBefore = `\t\t\t\tpayload_json: JSON.stringify(payload),`;
const queueAfter = `\t\t\t\t// humanware:redact-ingress-secrets
\t\t\t\tpayload_json: JSON.stringify(redactIngressSecrets(payload)),`;
const queueHelperAnchor = `//#region src/channels/message/ingress-queue.ts`;
const queueHelper = `// humanware:redact-ingress-secrets
function redactIngressSecrets(value) {
\tif (Array.isArray(value)) return value.map(redactIngressSecrets);
\tif (!value || typeof value !== "object") return value;
\treturn Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, /^(?:token|authorization|cookie|x-slack-signature)$/i.test(key) ? "[REDACTED]" : redactIngressSecrets(nested)]));
}
`;

const deadLetterBefore = `\tconst deadLetters = await queue.listFailed({ limit: parseLimit(options.limit) });`;
const deadLetterAfter = `\t// humanware:redact-dead-letter-secrets
\tconst deadLetters = (await queue.listFailed({ limit: parseLimit(options.limit) })).map((entry) => ({ ...entry, payload: JSON.parse(JSON.stringify(entry.payload ?? null, (key, value) => /^(?:token|authorization|cookie|x-slack-signature)$/i.test(key) ? "[REDACTED]" : value)) }));`;
const deadLetterLegacy = `\t// humanware:redact-dead-letter-secrets
\tconst deadLetters = (await queue.listFailed({ limit: parseLimit(options.limit) })).map((entry) => ({ ...entry, payload: redactDeadLetterSecrets(entry.payload) }));`;
const deadLetterResubmitBefore = `\t\tif (options.json) writeRuntimeJson(runtime, {
\t\t\tchannelId,
\t\t\taccountId,
\t\t\teventId,
\t\t\tresult
\t\t});`;
const deadLetterResubmitAfter = `\t\t// humanware:redact-dead-letter-resubmit-secrets
\t\tif (options.json) writeRuntimeJson(runtime, {
\t\t\tchannelId,
\t\t\taccountId,
\t\t\teventId,
\t\t\tresult: JSON.parse(JSON.stringify(result, (key, value) => /^(?:token|authorization|cookie|x-slack-signature)$/i.test(key) ? "[REDACTED]" : value))
\t\t});`;

const results = {
  lifecycle: patchBundles(/^main-session-recovery-lifecycle-.*\.js$/, (source) => source.includes("humanware:terminal-current-writer-recovery") ? source : source.replace(lifecycleBefore, lifecycleAfter), "terminal-current-writer-recovery"),
  retry: patchBundles(/^ingress-retry-policy-.*\.js$/, (source) => source.includes("humanware:session-conflict-age-gate") ? source : source.replace(retryBefore, retryAfter), "session-conflict-age-gate"),
  queue: patchBundles(/^ingress-queue-.*\.js$/, (source) => {
    if (source.includes("humanware:redact-ingress-secrets")) return source;
    const withHelper = source.replace(queueHelperAnchor, `${queueHelper}${queueHelperAnchor}`);
    return withHelper.replace(queueBefore, queueAfter);
  }, "redact-ingress-secrets"),
  deadLetters: patchBundles(/^dead-letters-.*\.js$/, (source) => {
    let updated = source;
    if (!updated.includes(deadLetterAfter)) {
      updated = updated.includes(deadLetterLegacy) ? updated.replace(deadLetterLegacy, deadLetterAfter) : updated.replace(deadLetterBefore, deadLetterAfter);
    }
    if (!updated.includes("humanware:redact-dead-letter-resubmit-secrets")) updated = updated.replace(deadLetterResubmitBefore, deadLetterResubmitAfter);
    return updated;
  }, "redact-dead-letter-secrets"),
};

console.log(JSON.stringify(results));
