import test from "node:test";
import assert from "node:assert/strict";
import {existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {applyWorkspaceContext, restoreWorkspaceContext} from "./materialize-openclaw-workspaces.mjs";

for (const keyed of [false, true]) test(`materializes and restores ${keyed ? "canonical entries" : "legacy list"} workspaces transactionally`, () => {
  const root = mkdtempSync(join(tmpdir(), "openclaw-workspaces-"));
  try {
    const runtime = join(root, "runtime", "current");
    const data = join(root, "data");
    const workspace = join(data, "working", "agents", "max");
    const backup = join(data, "operations", "backups", "cutover");
    mkdirSync(join(runtime, "config"), {recursive: true});
    mkdirSync(join(runtime, "instructions", "openclaw", "max"), {recursive: true});
    mkdirSync(join(runtime, "instructions", "skills", "act"), {recursive: true});
    mkdirSync(join(data, "current", "memory"), {recursive: true});
    mkdirSync(workspace, {recursive: true});
    for (const filename of ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md", "STRATEGY.md"]) writeFileSync(join(runtime, "instructions", "openclaw", "max", filename), filename);
    writeFileSync(join(runtime, "instructions", "skills", "act", "SKILL.md"), "canonical act");
    writeFileSync(join(runtime, "config", "instance.json"), JSON.stringify({paths: {dataRoot: data}}));
    writeFileSync(join(data, "current", "memory", "index.md"), "memory");
    mkdirSync(join(data, "current", "strategy"), {recursive: true});
    writeFileSync(join(data, "current", "strategy", "current.md"), "strategy");
    writeFileSync(join(workspace, "IDENTITY.md"), "starter identity");
    symlinkSync(join(data, "memory", "current", "index.md"), join(workspace, "MEMORY.md"));
    writeFileSync(join(workspace, "BOOTSTRAP.md"), "starter bootstrap");
    mkdirSync(join(workspace, "skills", "shadow-status"), {recursive: true});
    writeFileSync(join(workspace, "skills", "shadow-status", "SKILL.md"), "local behavior");
    const config = join(root, "config.json");
    writeFileSync(config, JSON.stringify({agents: keyed ? {entries: {max: {workspace}}} : {list: [{id: "max", workspace}]}}));

    applyWorkspaceContext({runtimeDir: runtime, configPath: config, backupDir: backup});
    assert.equal(lstatSync(join(workspace, "IDENTITY.md")).isSymbolicLink(), false);
    assert.equal(lstatSync(join(workspace, "MEMORY.md")).isSymbolicLink(), false);
    assert.equal(readFileSync(join(workspace, "IDENTITY.md"), "utf8"), "IDENTITY.md");
    assert.equal(readFileSync(join(workspace, "MEMORY.md"), "utf8"), "MEMORY.md");
    assert.equal(existsSync(join(workspace, "BOOTSTRAP.md")), false);
    assert.equal(readFileSync(join(workspace, "skills", "act", "SKILL.md"), "utf8"), "canonical act");
    assert.equal(existsSync(join(workspace, "skills", "shadow-status")), false);
    assert.equal(readFileSync(join(backup, "saved", "max", "IDENTITY.md"), "utf8"), "starter identity");
    assert.equal(readFileSync(join(backup, "saved", "max", "skills", "shadow-status", "SKILL.md"), "utf8"), "local behavior");

    assert.equal(restoreWorkspaceContext(backup), true);
    assert.equal(readFileSync(join(workspace, "IDENTITY.md"), "utf8"), "starter identity");
    assert.equal(readFileSync(join(workspace, "BOOTSTRAP.md"), "utf8"), "starter bootstrap");
    assert.equal(readFileSync(join(workspace, "skills", "shadow-status", "SKILL.md"), "utf8"), "local behavior");
    assert.equal(existsSync(join(workspace, "skills", "act")), false);
    assert.equal(lstatSync(join(workspace, "MEMORY.md")).isSymbolicLink(), true);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test("projects the same canonical skills into every agent workspace", () => {
  const root = mkdtempSync(join(tmpdir(), "openclaw-workspace-skills-"));
  try {
    const runtime = join(root, "runtime", "current");
    const data = join(root, "data");
    const backup = join(data, "operations", "backups", "cutover");
    mkdirSync(join(runtime, "config"), {recursive: true});
    mkdirSync(join(runtime, "instructions", "skills", "act"), {recursive: true});
    writeFileSync(join(runtime, "instructions", "skills", "act", "SKILL.md"), "canonical act");
    for (const agent of ["liv", "max"]) {
      mkdirSync(join(runtime, "instructions", "openclaw", agent), {recursive: true});
      for (const filename of ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md", "STRATEGY.md"]) writeFileSync(join(runtime, "instructions", "openclaw", agent, filename), filename);
      mkdirSync(join(data, "working", "agents", agent, "skills", `local-${agent}`), {recursive: true});
      writeFileSync(join(data, "working", "agents", agent, "skills", `local-${agent}`, "SKILL.md"), "shadow");
    }
    mkdirSync(join(data, "current", "memory"), {recursive: true});
    mkdirSync(join(data, "current", "strategy"), {recursive: true});
    writeFileSync(join(data, "current", "memory", "index.md"), "memory");
    writeFileSync(join(data, "current", "strategy", "current.md"), "strategy");
    writeFileSync(join(runtime, "config", "instance.json"), JSON.stringify({paths: {dataRoot: data}}));
    const config = join(root, "config.json");
    writeFileSync(config, JSON.stringify({agents: {entries: Object.fromEntries(["liv", "max"].map((agent) => [agent, {workspace: join(data, "working", "agents", agent)}]))}}));

    applyWorkspaceContext({runtimeDir: runtime, configPath: config, backupDir: backup});
    for (const agent of ["liv", "max"]) {
      const workspace = join(data, "working", "agents", agent);
      assert.equal(readFileSync(join(workspace, "skills", "act", "SKILL.md"), "utf8"), "canonical act");
      assert.equal(existsSync(join(workspace, "skills", `local-${agent}`)), false);
    }
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});
