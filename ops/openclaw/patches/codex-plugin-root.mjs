import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function resolveCodexPluginDist(env = process.env) {
  if (env.OPENCLAW_CODEX_DIST && env.OPENCLAW_CODEX_PLUGIN_ROOT && path.resolve(env.OPENCLAW_CODEX_DIST) !== path.resolve(env.OPENCLAW_CODEX_PLUGIN_ROOT, "dist")) throw new Error("Conflicting Codex plugin root and dist overrides");
  if (env.OPENCLAW_CODEX_DIST) return env.OPENCLAW_CODEX_DIST;
  if (env.OPENCLAW_CODEX_PLUGIN_ROOT) {
    const version = JSON.parse(fs.readFileSync(path.join(env.OPENCLAW_CODEX_PLUGIN_ROOT, "package.json"), "utf8")).version;
    if (version !== "2026.9.1") throw new Error(`Unsupported Codex plugin version ${version}`);
    return path.join(env.OPENCLAW_CODEX_PLUGIN_ROOT, "dist");
  }
  const packageRoot = env.OPENCLAW_PACKAGE_ROOT || "/opt/homebrew/lib/node_modules/openclaw";
  const version = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")).version;
  if (version !== "2026.9.1") throw new Error(`Unsupported OpenClaw version ${version}; select a reviewed Codex plugin explicitly`);
  const projectsRoot = env.OPENCLAW_NPM_PROJECTS_DIR || path.join(env.OPENCLAW_STATE_DIR || path.join(env.HOME || os.homedir(), ".openclaw"), "npm", "projects");
  const roots = fs.readdirSync(projectsRoot)
    .filter((name) => name.startsWith("openclaw-codex-"))
    .map((name) => path.join(projectsRoot, name, "node_modules", "@openclaw", "codex"))
    .filter((root) => fs.existsSync(path.join(root, "package.json")))
    .filter((root) => JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version === version);
  if (roots.length !== 1) throw new Error(`Expected exactly one Codex ${version} plugin root, found ${roots.length}; set OPENCLAW_CODEX_PLUGIN_ROOT to the configured plugin`);
  return path.join(roots[0], "dist");
}
