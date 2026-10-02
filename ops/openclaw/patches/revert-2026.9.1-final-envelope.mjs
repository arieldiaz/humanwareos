import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {resolveCodexPluginDist} from './codex-plugin-root.mjs';

// One-time reversal of the retired final-envelope boundary edits. Each entry is
// the stock text and the exact text that patch wrote in its place.
const RUNTIME = 'globalThis[Symbol.for("humanware.final-envelope.v1")]';
export const BOUNDARIES = {
  cursor: ['function runCliAgent(paramsInput) {',
    `// humanware:final-envelope-cursor\nfunction runCliAgent(paramsInput) {\n const runtime = ${RUNTIME};\n if (!runtime && /:slack:channel:/i.test(paramsInput.sessionKey ?? "")) throw new Error("Lifecycle final owner is unavailable");\n return runtime ? runtime.run(paramsInput, runCliAgentUncontracted, "cursor") : runCliAgentUncontracted(paramsInput);\n}\nfunction runCliAgentUncontracted(paramsInput) {`],
  codex: ['async function runAgentHarnessAttempt(params) {\n\treturn runSelectedAgentHarnessAttempt(params);\n}',
    `// humanware:final-envelope-codex\nasync function runAgentHarnessAttempt(params) {\n const runtime = ${RUNTIME};\n if (!runtime && /:slack:channel:/i.test(params.sessionKey ?? "")) throw new Error("Lifecycle final owner is unavailable");\n return runtime ? runtime.run(params, runSelectedAgentHarnessAttempt, "codex") : runSelectedAgentHarnessAttempt(params);\n}`],
  schema: ['\t\tcodexModelCallDiagnostics.setRequestPayloadBytes(utf8JsonByteLength(turnStartParams));',
    `\t\t// humanware:final-envelope-schema\n\t\tconst finalSchema = ${RUNTIME}?.schema(runtimeParams);\n\t\tif (finalSchema) turnStartParams.outputSchema = finalSchema;\n\t\tcodexModelCallDiagnostics.setRequestPayloadBytes(utf8JsonByteLength(turnStartParams));`],
};

export function revertBoundary(source, kind) {
  const [stock, edited] = BOUNDARIES[kind];
  if (source.split(edited).length === 2) return source.replace(edited, stock);
  if (source.includes(`humanware:final-envelope-${kind}`) || !source.includes(stock)) throw new Error(`${kind} boundary is neither stock nor the retired edit`);
  return source;
}

export function revertFinalBoundaries(core, codex) {
  const edits = [];
  for (const [dir, pattern, kind] of [[core, /^cli-runner-.*\.js$/, 'cursor'], [core, /^selection-.*\.js$/, 'codex'], [codex, /^run-attempt-.*\.js$/, 'schema']]) {
    const files = fs.readdirSync(dir).filter(name => pattern.test(name)).map(name => path.join(dir, name))
      .filter(file => fs.readFileSync(file, 'utf8').includes(BOUNDARIES[kind][0].split('\n')[0].trim()));
    if (!files.length) throw new Error(`No ${kind} boundary; review installed runtime`);
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      edits.push({file, source, next: revertBoundary(source, kind)});
    }
  }
  for (const edit of edits) if (edit.source !== edit.next) fs.writeFileSync(edit.file, edit.next);
  return {reverted: edits.filter(e => e.source !== e.next).length, checked: edits.length};
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const core = process.env.OPENCLAW_CORE_DIST || path.join(process.env.OPENCLAW_PACKAGE_ROOT || '/opt/homebrew/lib/node_modules/openclaw', 'dist');
  console.log(JSON.stringify(revertFinalBoundaries(core, resolveCodexPluginDist())));
}
