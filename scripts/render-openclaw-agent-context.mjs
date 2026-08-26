#!/usr/bin/env node

import {mkdirSync, readFileSync, realpathSync, writeFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {join} from "node:path";

function fail(message) {
  throw new Error(`openclaw-context: ${message}`);
}

function parseFrontmatter(text) {
  const match = String(text).match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return {};
  return Object.fromEntries(match[1].split("\n").flatMap((line) => {
    const entry = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    return entry ? [[entry[1].toLowerCase(), entry[2].trim()]] : [];
  }));
}

function section(title, body) {
  return `## ${title}\n\n${String(body).trim()}\n`;
}

export function renderAgentContext({agentId, frameworkRules, instanceRules, agentTemplate, agentOverlay, runtimeCurrent, dataRoot}) {
  if (!/^[a-z][a-z0-9-]*$/.test(agentId)) fail(`unsafe agent id ${agentId}`);
  const templateMeta = parseFrontmatter(agentTemplate);
  const overlayMeta = parseFrontmatter(agentOverlay);
  const name = overlayMeta.name || templateMeta.name || agentId;
  const displayName = name.slice(0, 1).toUpperCase() + name.slice(1);
  const theme = overlayMeta.theme || overlayMeta.vibe || templateMeta.description || "Humanware OS agent";
  const emoji = overlayMeta.emoji || "";
  const docs = join(runtimeCurrent, "instructions", "docs");

  return {
    "AGENTS.md": `# Humanware OS assembled instructions\n\nGenerated from the active immutable runtime. Do not edit this projection; change the owning framework or instance source and rebuild.\n\n${section("Framework rules", frameworkRules)}\n${section("Private instance context", instanceRules)}`,
    "SOUL.md": `# Humanware OS assembled identity — ${displayName}\n\nGenerated from the active immutable runtime. Before every Slack reply, read ${join(docs, "reply-shape.md")}, ${join(docs, "status-framework.md")}, ${join(docs, "slack-style.md")}, and their instance overlays when present. Before non-trivial work, load ${join(dataRoot, "current", "strategy", "current.md")} and the smallest relevant projection from ${join(dataRoot, "current", "memory")} in the active privacy scope.\n\n${section("Framework identity", agentTemplate)}\n${section("Private identity overlay", agentOverlay || "No private identity overlay.")}`,
    "IDENTITY.md": `# IDENTITY.md — runtime projection\n\n- Name: ${displayName}\n- Theme: ${theme}\n${emoji ? `- Emoji: ${emoji}\n` : ""}\nThis identity is rendered from the active immutable Humanware OS runtime.\n`,
    "USER.md": `# USER.md — runtime projection\n\nOwner, time zone, and private instance facts are in the assembled AGENTS.md. Current personal facts belong to ${join(dataRoot, "current", "memory")}; load only the smallest relevant projection in the active privacy scope.\n`,
    "MEMORY.md": `# MEMORY.md — data-plane bridge\n\nCurrent memory lives at ${join(dataRoot, "current", "memory")}. Before answering about prior work, decisions, dates, people, preferences, or todos, use an approved exact-read tool to load the smallest relevant projection. Automatic semantic indexing is not required. This generated bridge contains no copied memory facts.\n`,
    "STRATEGY.md": `# STRATEGY.md — data-plane bridge\n\nCurrent strategy lives at ${join(dataRoot, "current", "strategy", "current.md")}. Load that canonical projection before non-trivial work when the execution profile's data scope permits it. This generated bridge contains no copied strategy facts.\n`,
  };
}

export function renderRuntimeContexts(runtimeDir) {
  const instance = JSON.parse(readFileSync(join(runtimeDir, "config", "instance.json"), "utf8"));
  const frameworkRules = readFileSync(join(runtimeDir, "instructions", "AGENTS.md"), "utf8");
  const instanceRules = readFileSync(join(runtimeDir, "instructions", "AGENTS-instance.md"), "utf8");
  const runtimeCurrent = join(instance.paths.runtimeRoot, "current");
  for (const agentId of instance.agents) {
    if (!/^[a-z][a-z0-9-]*$/.test(agentId)) fail(`unsafe agent id ${agentId}`);
    const agentTemplate = readFileSync(join(runtimeDir, "instructions", "agents", `${agentId}.md`), "utf8");
    let agentOverlay = "";
    try {
      agentOverlay = readFileSync(join(runtimeDir, "instructions", "agent-overlays", `${agentId}.md`), "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const destination = join(runtimeDir, "instructions", "openclaw", agentId);
    mkdirSync(destination, {recursive: true});
    const rendered = renderAgentContext({agentId, frameworkRules, instanceRules, agentTemplate, agentOverlay, runtimeCurrent, dataRoot: instance.paths.dataRoot});
    for (const [filename, content] of Object.entries(rendered)) writeFileSync(join(destination, filename), content, {mode: 0o600});
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const [runtimeDir] = process.argv.slice(2);
  if (!runtimeDir) {
    console.error("Usage: render-openclaw-agent-context.mjs RUNTIME_DIR");
    process.exit(2);
  }
  try {
    renderRuntimeContexts(runtimeDir);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
