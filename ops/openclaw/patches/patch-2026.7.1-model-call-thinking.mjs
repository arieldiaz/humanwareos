import fs from "node:fs";
import path from "node:path";

const dist = "/opt/homebrew/lib/node_modules/openclaw/dist";
const files = fs.readdirSync(dist);
const attempt = files.find((name) => /^attempt\.model-diagnostic-events-.*\.js$/.test(name));
const selection = files.find((name) => {
  if (!/^selection-.*\.js$/.test(name)) return false;
  return fs.readFileSync(path.join(dist, name), "utf8").includes("transport: effectiveAgentTransport,");
});
if (!attempt || !selection) throw new Error("OpenClaw model-call bundles not found.");

function patch(name, replacements) {
  const target = path.join(dist, name);
  let source = fs.readFileSync(target, "utf8");
  if (source.includes("thinkingProvenancePatched: true")) return "alreadyPatched";
  for (const [from, to] of replacements) {
    if (!source.includes(from)) throw new Error(`OpenClaw bundle shape changed in ${name}.`);
    source = source.replace(from, to);
  }
  source += "\n//# thinkingProvenancePatched: true\n";
  fs.writeFileSync(target, source);
  return "patched";
}

const attemptStatus = patch(attempt, [
  ["\t\t...ctx.transport && { transport: ctx.transport },", "\t\t...ctx.transport && { transport: ctx.transport },\n\t\t...ctx.thinkLevel && { thinkLevel: ctx.thinkLevel },"],
  ["\t\t...eventBase.transport ? { transport: eventBase.transport } : {},", "\t\t...eventBase.transport ? { transport: eventBase.transport } : {},\n\t\t...eventBase.thinkLevel ? { thinkLevel: eventBase.thinkLevel } : {},"],
]);

const selectionStatus = patch(selection, [[
  "\t\t\t\ttransport: effectiveAgentTransport,",
  "\t\t\t\ttransport: effectiveAgentTransport,\n\t\t\t\tthinkLevel: params.thinkLevel,",
]]);

console.log(JSON.stringify({ attempt: attemptStatus, selection: selectionStatus }));
