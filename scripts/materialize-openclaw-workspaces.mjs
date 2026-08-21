#!/usr/bin/env node

import {existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {fileURLToPath} from "node:url";
import {basename, dirname, join} from "node:path";

const CONTEXT_FILES = ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md", "STRATEGY.md"];

function fail(message) {
  throw new Error(`openclaw-workspaces: ${message}`);
}

function safeAgentId(value) {
  const id = String(value ?? "").trim();
  if (!/^[a-z][a-z0-9-]*$/.test(id)) fail(`unsafe agent id ${id || "<empty>"}`);
  return id;
}

function pathExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function contentHash(content) {
  return createHash("sha256").update(content).digest("hex");
}

function projectionMatches(path, expectedHash) {
  if (!pathExists(path)) return false;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) return false;
  return contentHash(readFileSync(path)) === expectedHash;
}

function removeExpectedProjection(path, expectedHash) {
  if (!pathExists(path)) return;
  if (!projectionMatches(path, expectedHash)) fail(`refusing to remove modified projection ${path}`);
  rmSync(path);
}

function rollback(actions) {
  for (const action of [...actions].reverse()) {
    if (action.kind === "directory") {
      try {
        rmSync(action.path, {recursive: false});
      } catch (error) {
        if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error;
      }
      continue;
    }
    if (action.expectedHash) removeExpectedProjection(action.path, action.expectedHash);
    if (action.backup && pathExists(action.backup)) renameSync(action.backup, action.path);
  }
}

function installProjection(path, source, backup, actions) {
  const content = readFileSync(source);
  const expectedHash = contentHash(content);
  if (projectionMatches(path, expectedHash)) {
    actions.push({kind: "projection", path, source, expectedHash, unchanged: true});
    return;
  }
  let saved;
  if (pathExists(path)) {
    mkdirSync(dirname(backup), {recursive: true});
    renameSync(path, backup);
    saved = backup;
  }
  const temporary = join(dirname(path), `.${basename(path)}.humanware-${process.pid}`);
  writeFileSync(temporary, content, {mode: 0o600});
  renameSync(temporary, path);
  actions.push({kind: "projection", path, source, expectedHash, backup: saved});
}

export function applyWorkspaceContext({runtimeDir, configPath, backupDir}) {
  if (existsSync(join(backupDir, "manifest.json"))) fail(`backup manifest already exists at ${backupDir}`);
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const instance = JSON.parse(readFileSync(join(runtimeDir, "config", "instance.json"), "utf8"));
  const agents = config?.agents?.list;
  if (!Array.isArray(agents) || agents.length === 0) fail("config agents.list must be non-empty");
  const actions = [];

  for (const agent of agents) {
    const id = safeAgentId(agent.id);
    const workspace = String(agent.workspace ?? "");
    if (!workspace.startsWith("/")) fail(`workspace for ${id} must be absolute`);
    for (const filename of CONTEXT_FILES) {
      const target = join(runtimeDir, "instructions", "openclaw", id, filename);
      if (!existsSync(target)) fail(`missing rendered context ${target}`);
    }
    if (!existsSync(join(instance.paths.dataRoot, "memory", "current", "index.md"))) fail("current memory index is missing");
    if (!existsSync(join(instance.paths.dataRoot, "strategy", "current.md"))) fail("current strategy is missing");
  }

  try {
    for (const agent of agents) {
      const id = safeAgentId(agent.id);
      const workspace = String(agent.workspace);
      if (!pathExists(workspace)) {
        mkdirSync(workspace, {recursive: true});
        actions.push({kind: "directory", path: workspace});
      }
      for (const filename of CONTEXT_FILES) {
        installProjection(join(workspace, filename), join(runtimeDir, "instructions", "openclaw", id, filename), join(backupDir, "saved", id, filename), actions);
      }
      const bootstrap = join(workspace, "BOOTSTRAP.md");
      if (pathExists(bootstrap)) {
        const backup = join(backupDir, "saved", id, "BOOTSTRAP.md");
        mkdirSync(dirname(backup), {recursive: true});
        renameSync(bootstrap, backup);
        actions.push({kind: "file", path: bootstrap, backup});
      }
    }
    mkdirSync(backupDir, {recursive: true});
    writeFileSync(join(backupDir, "manifest.json"), `${JSON.stringify({schemaVersion: 1, runtimeDir, actions}, null, 2)}\n`, {mode: 0o600});
  } catch (error) {
    rollback(actions);
    throw error;
  }
  return actions;
}

export function restoreWorkspaceContext(backupDir) {
  const manifestPath = join(backupDir, "manifest.json");
  if (!existsSync(manifestPath)) return false;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  rollback(manifest.actions.filter((action) => !action.unchanged));
  return true;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const [mode, first, second] = process.argv.slice(2);
  try {
    if (mode === "apply" && first && second) applyWorkspaceContext({runtimeDir: first, configPath: second, backupDir: process.env.HUMANWARE_WORKSPACE_BACKUP_DIR || fail("HUMANWARE_WORKSPACE_BACKUP_DIR is required")});
    else if (mode === "restore" && first) restoreWorkspaceContext(first);
    else fail("usage: materialize-openclaw-workspaces.mjs apply RUNTIME_DIR CONFIG_PATH | restore BACKUP_DIR");
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
