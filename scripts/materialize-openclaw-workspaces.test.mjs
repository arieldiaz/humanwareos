import test from "node:test";
import assert from "node:assert/strict";
import {existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {applyWorkspaceContext, restoreWorkspaceContext} from "./materialize-openclaw-workspaces.mjs";

test("materializes regular managed projections, archives starter files, and restores transactionally", () => {
  const root = mkdtempSync(join(tmpdir(), "openclaw-workspaces-"));
  try {
    const runtime = join(root, "runtime", "current");
    const data = join(root, "data");
    const workspace = join(data, "working", "agents", "max");
    const backup = join(data, "operations", "backups", "cutover");
    mkdirSync(join(runtime, "config"), {recursive: true});
    mkdirSync(join(runtime, "instructions", "openclaw", "max"), {recursive: true});
    mkdirSync(join(data, "current", "memory"), {recursive: true});
    mkdirSync(workspace, {recursive: true});
    for (const filename of ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md", "STRATEGY.md"]) writeFileSync(join(runtime, "instructions", "openclaw", "max", filename), filename);
    writeFileSync(join(runtime, "config", "instance.json"), JSON.stringify({paths: {dataRoot: data}}));
    writeFileSync(join(data, "current", "memory", "index.md"), "memory");
    writeFileSync(join(data, "current", "strategy.md"), "strategy");
    writeFileSync(join(workspace, "IDENTITY.md"), "starter identity");
    symlinkSync(join(data, "memory", "current", "index.md"), join(workspace, "MEMORY.md"));
    writeFileSync(join(workspace, "BOOTSTRAP.md"), "starter bootstrap");
    const config = join(root, "config.json");
    writeFileSync(config, JSON.stringify({agents: {list: [{id: "max", workspace}]}}));

    applyWorkspaceContext({runtimeDir: runtime, configPath: config, backupDir: backup});
    assert.equal(lstatSync(join(workspace, "IDENTITY.md")).isSymbolicLink(), false);
    assert.equal(lstatSync(join(workspace, "MEMORY.md")).isSymbolicLink(), false);
    assert.equal(readFileSync(join(workspace, "IDENTITY.md"), "utf8"), "IDENTITY.md");
    assert.equal(readFileSync(join(workspace, "MEMORY.md"), "utf8"), "MEMORY.md");
    assert.equal(existsSync(join(workspace, "BOOTSTRAP.md")), false);
    assert.equal(readFileSync(join(backup, "saved", "max", "IDENTITY.md"), "utf8"), "starter identity");

    assert.equal(restoreWorkspaceContext(backup), true);
    assert.equal(readFileSync(join(workspace, "IDENTITY.md"), "utf8"), "starter identity");
    assert.equal(readFileSync(join(workspace, "BOOTSTRAP.md"), "utf8"), "starter bootstrap");
    assert.equal(lstatSync(join(workspace, "MEMORY.md")).isSymbolicLink(), true);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});
