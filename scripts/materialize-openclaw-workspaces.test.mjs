import test from "node:test";
import assert from "node:assert/strict";
import {existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {applyWorkspaceContext, restoreWorkspaceContext} from "./materialize-openclaw-workspaces.mjs";

test("materializes managed links, archives starter files, and restores transactionally", () => {
  const root = mkdtempSync(join(tmpdir(), "openclaw-workspaces-"));
  try {
    const runtime = join(root, "runtime", "current");
    const data = join(root, "data");
    const workspace = join(data, "workspaces", "agents", "max");
    const backup = join(data, "backups", "cutover");
    mkdirSync(join(runtime, "config"), {recursive: true});
    mkdirSync(join(runtime, "instructions", "openclaw", "max"), {recursive: true});
    mkdirSync(join(data, "memory", "current"), {recursive: true});
    mkdirSync(join(data, "strategy"), {recursive: true});
    mkdirSync(workspace, {recursive: true});
    for (const filename of ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md"]) writeFileSync(join(runtime, "instructions", "openclaw", "max", filename), filename);
    writeFileSync(join(runtime, "config", "instance.json"), JSON.stringify({paths: {dataRoot: data}}));
    writeFileSync(join(data, "memory", "current", "index.md"), "memory");
    writeFileSync(join(data, "strategy", "current.md"), "strategy");
    writeFileSync(join(workspace, "IDENTITY.md"), "starter identity");
    writeFileSync(join(workspace, "BOOTSTRAP.md"), "starter bootstrap");
    const config = join(root, "config.json");
    writeFileSync(config, JSON.stringify({agents: {list: [{id: "max", workspace}]}}));

    applyWorkspaceContext({runtimeDir: runtime, configPath: config, backupDir: backup});
    assert.equal(lstatSync(join(workspace, "IDENTITY.md")).isSymbolicLink(), true);
    assert.equal(readlinkSync(join(workspace, "MEMORY.md")), join(data, "memory", "current", "index.md"));
    assert.equal(existsSync(join(workspace, "BOOTSTRAP.md")), false);
    assert.equal(readFileSync(join(backup, "saved", "max", "IDENTITY.md"), "utf8"), "starter identity");

    assert.equal(restoreWorkspaceContext(backup), true);
    assert.equal(readFileSync(join(workspace, "IDENTITY.md"), "utf8"), "starter identity");
    assert.equal(readFileSync(join(workspace, "BOOTSTRAP.md"), "utf8"), "starter bootstrap");
    assert.equal(existsSync(join(workspace, "MEMORY.md")), false);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});
