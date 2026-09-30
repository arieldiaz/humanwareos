import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {resolveSlackRuntimeModule} from '../plugins/run-signature/index.js';
import {resolveCodexPluginDist} from './codex-plugin-root.mjs';

// Host-boundary adapters pass the complete harness result and native schema.
// The plugin is the sole owner of validation, repair, and decision state.
export function patchFinalBoundary(source, kind) {
  const marker = `humanware:final-envelope-${kind}`;
  if (source.includes(marker)) return source;
  const runtime = 'globalThis[Symbol.for("humanware.final-envelope.v1")]';
  if (kind === 'cursor') {
    const anchor = 'function runCliAgent(paramsInput) {';
    if (!source.includes(anchor)) throw new Error('CLI final boundary changed');
    return source.replace(anchor, `// ${marker}\nfunction runCliAgent(paramsInput) {\n const runtime = ${runtime};\n if (!runtime && /:slack:channel:/i.test(paramsInput.sessionKey ?? "")) throw new Error("Lifecycle final owner is unavailable");\n return runtime ? runtime.run(paramsInput, runCliAgentUncontracted, "cursor") : runCliAgentUncontracted(paramsInput);\n}\nfunction runCliAgentUncontracted(paramsInput) {`);
  }
  if (kind === 'codex') {
    const anchor = 'async function runAgentHarnessAttempt(params) {\n\treturn runSelectedAgentHarnessAttempt(params);\n}';
    if (!source.includes(anchor)) throw new Error('Harness final boundary changed');
    return source.replace(anchor, `// ${marker}\nasync function runAgentHarnessAttempt(params) {\n const runtime = ${runtime};\n if (!runtime && /:slack:channel:/i.test(params.sessionKey ?? "")) throw new Error("Lifecycle final owner is unavailable");\n return runtime ? runtime.run(params, runSelectedAgentHarnessAttempt, "codex") : runSelectedAgentHarnessAttempt(params);\n}`);
  }
  if (kind === 'schema') {
    const anchor = '\t\tcodexModelCallDiagnostics.setRequestPayloadBytes(utf8JsonByteLength(turnStartParams));';
    if (!source.includes(anchor)) throw new Error('Codex turn/start boundary changed');
    return source.replace(anchor, `\t\t// ${marker}\n\t\tconst finalSchema = ${runtime}?.schema(runtimeParams);\n\t\tif (finalSchema) turnStartParams.outputSchema = finalSchema;\n${anchor}`);
  }
  throw new Error(`Unknown final boundary ${kind}`);
}
export function patchSlackCloseBoundary(source) {
  const anchor = '\tconst { senderId, allowFromLower } = authorization;';
  const after = `${anchor}
	// humanware:owner-close-before-admission
	const closeOwner = globalThis[Symbol.for("humanware.final-envelope.v1")];
	if (!closeOwner?.slackClose) throw new Error("Host closure owner is unavailable");
	if (await closeOwner.slackClose({message, accountId: account.accountId})) return null;`;
  if (source.includes(after)) return source;
  if (source.split(anchor).length !== 2) throw new Error('Slack authenticated raw-message boundary changed');
  return source.replace(anchor, after);
}

export function applyFinalBoundaries(core, codex) {
  const edits = [];
  for (const [dir, pattern, kind] of [[core, /^cli-runner-.*\.js$/, 'cursor'], [core, /^selection-.*\.js$/, 'codex'], [codex, /^run-attempt-.*\.js$/, 'schema']]) {
    const candidates = fs.readdirSync(dir).filter(name => pattern.test(name));
    const matching = candidates.filter(name => {
      const text = fs.readFileSync(path.join(dir, name), 'utf8');
      return text.includes(kind === 'cursor' ? 'function runCliAgent(' : kind === 'codex' ? 'async function runAgentHarnessAttempt(' : 'codexModelCallDiagnostics.setRequestPayloadBytes');
    });
    if (!matching.length) throw new Error(`No ${kind} final boundary; review installed runtime`);
    for (const name of matching) {
      const file = path.join(dir, name), source = fs.readFileSync(file, 'utf8');
      edits.push({file, source, next: patchFinalBoundary(source, kind)});
    }
  }
  for (const edit of edits) if (edit.source !== edit.next) fs.writeFileSync(edit.file, edit.next);
  return {patched: edits.filter(e => e.source !== e.next).length, checked: edits.length};
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const core = process.env.OPENCLAW_CORE_DIST || path.join(process.env.OPENCLAW_PACKAGE_ROOT || '/opt/homebrew/lib/node_modules/openclaw', 'dist');
  const slack = process.env.OPENCLAW_SLACK_PIPELINE || resolveSlackRuntimeModule('pipeline');
  const source = fs.readFileSync(slack, 'utf8');
  const next = patchSlackCloseBoundary(source);
  const result = applyFinalBoundaries(core, resolveCodexPluginDist());
  if (source !== next) fs.writeFileSync(slack, next);
  console.log(JSON.stringify({...result, slack: source === next ? 'checked' : 'patched'}));
}
