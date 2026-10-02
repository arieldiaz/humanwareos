import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {resolveSlackRuntimeModule} from '../plugins/run-signature/index.js';
import {resolveCodexPluginDist} from './codex-plugin-root.mjs';

// The configured owner's `close this` is intercepted before mention gating and
// model admission. Without a loaded plugin the message falls through to stock
// handling; a plugin mismatch must never become a Slack ingress outage.
const OWNER = 'globalThis[Symbol.for("humanware.final-envelope.v1")]';

export function patchSlackCloseBoundary(source) {
  const anchor = '\tconst { senderId, allowFromLower } = authorization;';
  const failClosed = '\tif (!closeOwner?.slackClose) throw new Error("Host closure owner is unavailable");\n\tif (await closeOwner.slackClose(';
  const after = `${anchor}
	// humanware:owner-close-before-admission
	const closeOwner = ${OWNER};
	if (closeOwner?.slackClose && await closeOwner.slackClose({message, accountId: account.accountId})) return null;`;
  if (source.includes(after)) return source;
  if (source.includes(failClosed)) return source.replace(failClosed, '\tif (closeOwner?.slackClose && await closeOwner.slackClose(');
  if (source.split(anchor).length !== 2) throw new Error('Slack authenticated raw-message boundary changed');
  return source.replace(anchor, after);
}

// Retired JSON-final edits. Installed 2026.9.1 bundles still carry them, and
// the patch runner edits the installed package in place, so restore the stock
// text exactly. Delete this block once OpenClaw is reinstalled or upgraded.
const RETIRED = {
  cursor: {
    stock: 'function runCliAgent(paramsInput) {',
    edit: `// humanware:final-envelope-cursor\nfunction runCliAgent(paramsInput) {\n const runtime = ${OWNER};\n if (!runtime && /:slack:channel:/i.test(paramsInput.sessionKey ?? "")) throw new Error("Lifecycle final owner is unavailable");\n return runtime ? runtime.run(paramsInput, runCliAgentUncontracted, "cursor") : runCliAgentUncontracted(paramsInput);\n}\nfunction runCliAgentUncontracted(paramsInput) {`,
  },
  codex: {
    stock: 'async function runAgentHarnessAttempt(params) {\n\treturn runSelectedAgentHarnessAttempt(params);\n}',
    edit: `// humanware:final-envelope-codex\nasync function runAgentHarnessAttempt(params) {\n const runtime = ${OWNER};\n if (!runtime && /:slack:channel:/i.test(params.sessionKey ?? "")) throw new Error("Lifecycle final owner is unavailable");\n return runtime ? runtime.run(params, runSelectedAgentHarnessAttempt, "codex") : runSelectedAgentHarnessAttempt(params);\n}`,
  },
  schema: {
    stock: '\t\tcodexModelCallDiagnostics.setRequestPayloadBytes(utf8JsonByteLength(turnStartParams));',
    edit: `\t\t// humanware:final-envelope-schema\n\t\tconst finalSchema = ${OWNER}?.schema(runtimeParams);\n\t\tif (finalSchema) turnStartParams.outputSchema = finalSchema;\n\t\tcodexModelCallDiagnostics.setRequestPayloadBytes(utf8JsonByteLength(turnStartParams));`,
  },
};

export function retireFinalBoundary(source, kind) {
  const {stock, edit} = RETIRED[kind];
  const next = source.split(edit).join(stock);
  if (next.includes(`humanware:final-envelope-${kind}`)) throw new Error(`Unrecognized ${kind} final-envelope edit; review installed runtime`);
  return next;
}

export function retireFinalBoundaries(core, codex) {
  const edits = [];
  for (const [dir, pattern, kind] of [[core, /^cli-runner-.*\.js$/, 'cursor'], [core, /^selection-.*\.js$/, 'codex'], [codex, /^run-attempt-.*\.js$/, 'schema']]) {
    for (const name of fs.readdirSync(dir).filter(name => pattern.test(name))) {
      const file = path.join(dir, name), source = fs.readFileSync(file, 'utf8');
      edits.push({file, source, next: retireFinalBoundary(source, kind)});
    }
  }
  for (const edit of edits) if (edit.source !== edit.next) fs.writeFileSync(edit.file, edit.next);
  return {retired: edits.filter(e => e.source !== e.next).length, checked: edits.length};
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const core = process.env.OPENCLAW_CORE_DIST || path.join(process.env.OPENCLAW_PACKAGE_ROOT || '/opt/homebrew/lib/node_modules/openclaw', 'dist');
  const slack = process.env.OPENCLAW_SLACK_PIPELINE || resolveSlackRuntimeModule('pipeline');
  const source = fs.readFileSync(slack, 'utf8');
  const next = patchSlackCloseBoundary(source);
  const result = retireFinalBoundaries(core, resolveCodexPluginDist());
  if (source !== next) fs.writeFileSync(slack, next);
  console.log(JSON.stringify({...result, slack: source === next ? 'checked' : 'patched'}));
}
