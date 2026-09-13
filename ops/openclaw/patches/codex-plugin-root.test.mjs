import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {resolveCodexPluginDist} from "./codex-plugin-root.mjs";

function fixture(t, version = "2026.9.1") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-plugin-roots-"));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({version}));
  const projects = path.join(root, "projects");
  fs.mkdirSync(projects);
  const add = (name, pluginVersion) => {
    const plugin = path.join(projects, `openclaw-codex-${name}`, "node_modules", "@openclaw", "codex");
    fs.mkdirSync(path.join(plugin, "dist"), {recursive: true});
    fs.writeFileSync(path.join(plugin, "package.json"), JSON.stringify({version: pluginVersion}));
    return plugin;
  };
  return {add, env: {OPENCLAW_PACKAGE_ROOT: root, OPENCLAW_NPM_PROJECTS_DIR: projects}};
}

test("resolves the exact configured Codex generation", (t) => {
  const {add, env} = fixture(t);
  add("old-generation", "2026.7.1");
  const current = add("new-generation", "2026.9.1");
  assert.equal(resolveCodexPluginDist(env), path.join(current, "dist"));
});

test("ambiguous and absent plugin versions fail closed", (t) => {
  const {add, env} = fixture(t);
  add("old", "2026.7.1");
  assert.throws(() => resolveCodexPluginDist(env), /found 0/);
  const first = add("first", "2026.9.1");
  add("second", "2026.9.1");
  assert.throws(() => resolveCodexPluginDist(env), /found 2/);
  assert.equal(resolveCodexPluginDist({...env, OPENCLAW_CODEX_PLUGIN_ROOT: first}), path.join(first, "dist"));
  assert.throws(() => resolveCodexPluginDist({...env, OPENCLAW_CODEX_PLUGIN_ROOT: first, OPENCLAW_CODEX_DIST: "/other/dist"}), /Conflicting/);
});

test("explicit roots and package discovery remain version scoped", (t) => {
  const {add, env} = fixture(t, "2026.10.0");
  const future = add("future", "2026.10.0");
  assert.throws(() => resolveCodexPluginDist(env), /Unsupported OpenClaw version/);
  assert.throws(() => resolveCodexPluginDist({...env, OPENCLAW_CODEX_PLUGIN_ROOT: future}), /Unsupported Codex plugin version/);
});
