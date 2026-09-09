import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// A version match is required; directory age cannot prove which plugin is active.
export function resolveSlackPluginDist(env = process.env) {
  if (env.OPENCLAW_SLACK_DIST && env.OPENCLAW_SLACK_PLUGIN_ROOT && path.resolve(env.OPENCLAW_SLACK_DIST) !== path.resolve(env.OPENCLAW_SLACK_PLUGIN_ROOT, "dist")) throw new Error("Conflicting Slack plugin root and dist overrides");
  if (env.OPENCLAW_SLACK_DIST) return env.OPENCLAW_SLACK_DIST;
  if (env.OPENCLAW_SLACK_PLUGIN_ROOT) {
    const version = JSON.parse(fs.readFileSync(path.join(env.OPENCLAW_SLACK_PLUGIN_ROOT, "package.json"), "utf8")).version;
    if (!["2026.7.1", "2026.9.1"].includes(version)) throw new Error(`Unsupported Slack plugin version ${version}`);
    return path.join(env.OPENCLAW_SLACK_PLUGIN_ROOT, "dist");
  }
  const packageRoot = env.OPENCLAW_PACKAGE_ROOT || "/opt/homebrew/lib/node_modules/openclaw";
  const version = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")).version;
  const slackVersion = /^2026\.7\.1(?:-|$)/.test(version) ? "2026.7.1" : version === "2026.9.1" ? version : undefined;
  if (!slackVersion) throw new Error(`Unsupported OpenClaw version ${version}; select a reviewed Slack plugin explicitly`);
  const projectsRoot = env.OPENCLAW_NPM_PROJECTS_DIR || path.join(env.OPENCLAW_STATE_DIR || path.join(env.HOME || os.homedir(), ".openclaw"), "npm", "projects");
  const roots = fs.readdirSync(projectsRoot)
    .filter((name) => name.startsWith("openclaw-slack-"))
    .map((name) => path.join(projectsRoot, name, "node_modules", "@openclaw", "slack"))
    .filter((root) => fs.existsSync(path.join(root, "package.json")))
    .filter((root) => JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version === slackVersion);
  if (roots.length !== 1) throw new Error(`Expected exactly one Slack ${slackVersion} plugin root, found ${roots.length}; set OPENCLAW_SLACK_PLUGIN_ROOT to the configured plugin`);
  return path.join(roots[0], "dist");
}
