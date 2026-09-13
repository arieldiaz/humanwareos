import fs from "node:fs";
import path from "node:path";
import {resolveCodexPluginDist} from "./codex-plugin-root.mjs";

const distDir = resolveCodexPluginDist();
const marker = "humanware:codex-process-inspection-budget";
const candidates = fs.readdirSync(distDir).filter((name) => /^transport-stdio-.*\.js$/.test(name)).map((name) => path.join(distDir, name));
let patched = 0;
let alreadyPatched = 0;
for (const file of candidates) {
  const source = fs.readFileSync(file, "utf8");
  if (source.includes(marker)) {
    alreadyPatched += 1;
    continue;
  }
  if (!["const MAX_PROCESS_CONTAINMENT_MS$1 = 2e3;", "const MAX_PROCESS_CONTAINMENT_MS = 2e3;", "readCodexAppServerProcessSnapshot(void 0, [registration.parent.pid, registration.child.pid])", "readCodexAppServerProcessSnapshot(void 0, [child.pid])", "readCodexAppServerProcessCommand(spawned, Date.now() + 2e3)"].every((anchor) => source.includes(anchor))) continue;
  let updated = source.replace("const MAX_PROCESS_CONTAINMENT_MS$1 = 2e3;", `// ${marker}\nconst MAX_PROCESS_CONTAINMENT_MS$1 = 1e4;`).replace("const MAX_PROCESS_CONTAINMENT_MS = 2e3;", "const MAX_PROCESS_CONTAINMENT_MS = 1e4;");
  updated = updated.replace("readCodexAppServerProcessSnapshot(void 0, [registration.parent.pid, registration.child.pid])", "readCodexAppServerProcessSnapshot(deadline, [registration.parent.pid, registration.child.pid])");
  updated = updated.replace("readCodexAppServerProcessSnapshot(void 0, [child.pid])", "readCodexAppServerProcessSnapshot(Date.now() + MAX_PROCESS_CONTAINMENT_MS$1, [child.pid])");
  updated = updated.replace("readCodexAppServerProcessCommand(spawned, Date.now() + 2e3)", "readCodexAppServerProcessCommand(spawned, Date.now() + MAX_PROCESS_CONTAINMENT_MS$1)");
  if (updated === source || !updated.includes(marker) || updated.includes("readCodexAppServerProcessSnapshot(void 0, [registration.parent.pid, registration.child.pid])") || updated.includes("readCodexAppServerProcessSnapshot(void 0, [child.pid])") || updated.includes("readCodexAppServerProcessCommand(spawned, Date.now() + 2e3)")) continue;
  fs.writeFileSync(file, updated);
  patched += 1;
}
if (candidates.length === 0 || patched + alreadyPatched !== candidates.length) throw new Error("Not every OpenClaw Codex transport bundle matched; the installed version changed and must be reviewed.");
console.log(JSON.stringify({patched, alreadyPatched, candidates: candidates.length}));
