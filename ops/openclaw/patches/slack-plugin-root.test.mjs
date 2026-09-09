import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {resolveSlackPluginDist} from "./slack-plugin-root.mjs";

function fixture(t, version) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "slack-plugin-roots-"));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({version}));
  const projects = path.join(root, "projects");
  fs.mkdirSync(projects);
  const add = (name, pluginVersion) => {
    const plugin = path.join(projects, `openclaw-slack-${name}`, "node_modules", "@openclaw", "slack");
    fs.mkdirSync(path.join(plugin, "dist"), {recursive: true});
    fs.writeFileSync(path.join(plugin, "package.json"), JSON.stringify({version: pluginVersion}));
    return plugin;
  };
  return {add, env: {OPENCLAW_PACKAGE_ROOT: root, OPENCLAW_NPM_PROJECTS_DIR: projects}};
}

for (const version of ["2026.7.1-1", "2026.9.1"]) test(`resolves Slack for ${version} with old and new installs present`, (t) => {
  const {add, env} = fixture(t, version);
  const old = add("old-generation", "2026.7.1");
  const current = add("new-generation", "2026.9.1");
  assert.equal(resolveSlackPluginDist(env), path.join(version === "2026.9.1" ? current : old, "dist"));
});

test("ambiguous and absent plugin versions fail without choosing a directory by age", (t) => {
  const {add, env} = fixture(t, "2026.9.1");
  add("old", "2026.7.1");
  assert.throws(() => resolveSlackPluginDist(env), /found 0/);
  const a = add("a", "2026.9.1");
  add("b", "2026.9.1");
  assert.throws(() => resolveSlackPluginDist(env), /found 2/);
  assert.equal(resolveSlackPluginDist({...env, OPENCLAW_SLACK_PLUGIN_ROOT: a}), path.join(a, "dist"));
  assert.throws(() => resolveSlackPluginDist({...env, OPENCLAW_SLACK_PLUGIN_ROOT: a, OPENCLAW_SLACK_DIST: "/other/dist"}), /Conflicting/);
});


test("explicit plugin roots remain version scoped", (t) => {
  const {add, env} = fixture(t, "2026.9.1");
  const unsupported = add("future", "2026.10.1");
  assert.throws(() => resolveSlackPluginDist({...env, OPENCLAW_SLACK_PLUGIN_ROOT: unsupported}), /Unsupported Slack plugin version/);
});
