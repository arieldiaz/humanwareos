import { createHash } from "node:crypto";
import { mkdir, open, readFile, stat } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export class OperationConflictError extends Error {}

export function validateConfig(config) {
  if (config?.schemaVersion !== 1 || config?.id !== "grok-mcp") {
    throw new Error("grok-mcp config must have schemaVersion 1 and id grok-mcp");
  }
  if (!/^127\.0\.0\.1:\d{1,5}$/.test(config.listen ?? "")) {
    throw new Error("grok-mcp listen must be a 127.0.0.1 host and port");
  }
  const origin = new URL(config.publicOrigin);
  if (origin.protocol !== "https:" || origin.pathname !== "/") {
    throw new Error("grok-mcp publicOrigin must be an HTTPS origin");
  }
  if (typeof config.mountPath !== "string" || !/^\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(config.mountPath)) {
    throw new Error("grok-mcp mountPath must be a single absolute URL slug");
  }
  if (!Array.isArray(config.contextFiles) || config.contextFiles.length === 0) {
    throw new Error("grok-mcp requires at least one context file");
  }
  const ids = new Set();
  for (const entry of config.contextFiles) {
    if (!SLUG.test(entry.id ?? "") || ids.has(entry.id)) {
      throw new Error(`invalid or duplicate context id: ${entry.id}`);
    }
    ids.add(entry.id);
    validateRelativePath(entry.path, `contextFiles.${entry.id}.path`);
    if (!Number.isInteger(entry.maxBytes) || entry.maxBytes < 1 || entry.maxBytes > 262_144) {
      throw new Error(`invalid maxBytes for context ${entry.id}`);
    }
  }
  for (const field of ["turnRoot", "workRoot", "memoryProposalRoot", "artifactStageRoot"]) {
    validateRelativePath(config[field], field);
  }
  return config;
}

function validateRelativePath(value, label) {
  if (typeof value !== "string" || !value || value.startsWith("/") || value.split(/[\\/]/).includes("..")) {
    throw new Error(`${label} must be a data-root-relative path without parent traversal`);
  }
}

export function resolveInside(root, relativePath) {
  const base = resolve(root);
  const target = resolve(base, relativePath);
  if (target !== base && !target.startsWith(`${base}${sep}`)) {
    throw new Error("configured path escaped the data root");
  }
  return target;
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function operationKey(tool, operationId) {
  if (!ID.test(operationId)) throw new Error("operationId has an invalid format");
  return digest(`${tool}\0${operationId}`).slice(0, 24);
}

function inputDigest(value) {
  return digest(JSON.stringify(value));
}

async function writeOnce(path, content, expectedDigest, existingDigest) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const file = await open(path, "wx", 0o600);
    try {
      await file.writeFile(content);
    } finally {
      await file.close();
    }
    return false;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const current = await readFile(path, "utf8");
    if (existingDigest(current) !== expectedDigest) {
      throw new OperationConflictError("operationId was already used with different input");
    }
    return true;
  }
}

function logicalPath(dataRoot, path) {
  return `data:${relative(resolve(dataRoot), path).split(sep).join("/")}`;
}

function jsonDigest(document) {
  try {
    return JSON.parse(document).inputDigest;
  } catch {
    return undefined;
  }
}

function frontmatterDigest(document) {
  return /^input-digest: ([a-f0-9]{64})$/m.exec(document)?.[1];
}

function htmlDigest(document) {
  return /^<!-- input-digest: ([a-f0-9]{64}) -->$/m.exec(document)?.[1];
}

function assertTimestamp(value, field) {
  if (value !== undefined && (typeof value !== "string" || value.length > 64 || Number.isNaN(Date.parse(value)))) {
    throw new Error(`${field} must be an ISO-8601 timestamp`);
  }
}

function now(value) {
  assertTimestamp(value, "timestamp");
  return value ?? new Date().toISOString();
}

function quote(value) {
  return JSON.stringify(value);
}

function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export class GrokBridge {
  constructor({ config, dataRoot }) {
    this.config = validateConfig(config);
    this.dataRoot = resolve(dataRoot);
  }

  async health() {
    for (const entry of this.config.contextFiles) {
      const info = await stat(resolveInside(this.dataRoot, entry.path));
      if (!info.isFile()) throw new Error(`context section is not a file: ${entry.id}`);
    }
    return { status: "ok" };
  }

  async getContext({ sections } = {}) {
    const available = new Map(this.config.contextFiles.map((entry) => [entry.id, entry]));
    const selected = sections?.length ? sections : [...available.keys()];
    const unknown = selected.filter((id) => !available.has(id));
    if (unknown.length) throw new Error(`unknown context sections: ${unknown.join(", ")}`);
    const context = [];
    for (const id of selected) {
      const entry = available.get(id);
      const path = resolveInside(this.dataRoot, entry.path);
      const info = await stat(path);
      if (!info.isFile()) throw new Error(`context section is not a file: ${id}`);
      const bytes = await readFile(path);
      const truncated = bytes.length > entry.maxBytes;
      context.push({
        id,
        label: entry.label,
        content: bytes.subarray(0, entry.maxBytes).toString("utf8"),
        truncated,
      });
    }
    return { context };
  }

  async recordTurn({ operationId, conversationId, userText, assistantText, occurredAt }) {
    const recordedAt = now(occurredAt);
    const input = { operationId, conversationId, userText, assistantText, occurredAt: occurredAt ?? null };
    const key = operationKey("record_turn", operationId);
    const expected = inputDigest(input);
    const path = resolveInside(this.dataRoot, `${this.config.turnRoot}/${key}.json`);
    const event = {
      schema: "humanware.grok-turn.v1",
      source: "grok-bot",
      operationId,
      conversationId,
      occurredAt: recordedAt,
      recordedAt: new Date().toISOString(),
      userText,
      assistantText,
      inputDigest: expected,
    };
    const replay = await writeOnce(path, `${JSON.stringify(event, null, 2)}\n`, expected, jsonDigest);
    return { recorded: true, replay, location: logicalPath(this.dataRoot, path) };
  }

  async saveWork({ operationId, conversationId, title, content, createdAt }) {
    if (/[\r\n]/.test(title)) throw new Error("title must be one line");
    const timestamp = now(createdAt);
    const input = { operationId, conversationId, title, content, createdAt: createdAt ?? null };
    const key = operationKey("save_work", operationId);
    const expected = inputDigest(input);
    const conversation = digest(conversationId).slice(0, 16);
    const path = resolveInside(this.dataRoot, `${this.config.workRoot}/${conversation}/work/${key}.md`);
    const document = `---\nsource: grok-bot\nconversation-id: ${quote(conversationId)}\noperation-id: ${quote(operationId)}\ninput-digest: ${expected}\ncreated-at: ${quote(timestamp)}\ntitle: ${quote(title)}\n---\n\n# ${title}\n\n${content.trim()}\n`;
    const replay = await writeOnce(path, document, expected, frontmatterDigest);
    return { saved: true, replay, location: logicalPath(this.dataRoot, path) };
  }

  async proposeMemory({ operationId, conversationId, subject, facts, sources = [], observedAt }) {
    if (/[\r\n]/.test(subject)) throw new Error("subject must be one line");
    const timestamp = now(observedAt);
    const input = { operationId, conversationId, subject, facts, sources, observedAt: observedAt ?? null };
    const key = operationKey("propose_memory", operationId);
    const expected = inputDigest(input);
    const path = resolveInside(this.dataRoot, `${this.config.memoryProposalRoot}/grok-proposal-${key}.json`);
    const event = {
      schema: "humanware.memory-proposal.v1",
      status: "proposed",
      source: { provider: "grok-bot", conversationId },
      operationId,
      observedAt: timestamp,
      recordedAt: new Date().toISOString(),
      subject,
      facts,
      sources,
      inputDigest: expected,
    };
    const replay = await writeOnce(path, `${JSON.stringify(event, null, 2)}\n`, expected, jsonDigest);
    return {
      proposed: true,
      currentMemoryChanged: false,
      replay,
      location: logicalPath(this.dataRoot, path),
    };
  }

  async stageArtifact({ operationId, conversationId, project, title, content, createdAt }) {
    if (!SLUG.test(project)) throw new Error("project must be a lowercase URL slug");
    if (/[\r\n]/.test(title)) throw new Error("title must be one line");
    const timestamp = now(createdAt);
    const input = { operationId, conversationId, project, title, content, createdAt: createdAt ?? null };
    const key = operationKey("stage_artifact", operationId);
    const expected = inputDigest(input);
    const root = resolveInside(this.dataRoot, `${this.config.artifactStageRoot}/${key}`);
    const manifest = resolveInside(root, "manifest.json");
    const index = resolveInside(root, "index.html");
    const manifestDocument = {
      schema: "humanware.grok-artifact-stage.v1",
      source: "grok-bot",
      conversationId,
      operationId,
      project,
      title,
      createdAt: timestamp,
      inputDigest: expected,
      promoted: false,
    };
    const manifestReplay = await writeOnce(manifest, `${JSON.stringify(manifestDocument, null, 2)}\n`, expected, jsonDigest);
    const safeTitle = escapeHtml(title);
    const safeContent = escapeHtml(content.trim());
    const document = `<!doctype html>\n<!-- input-digest: ${expected} -->\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">\n<meta name="artifact-title" content="${safeTitle}"><meta name="artifact-project" content="${escapeHtml(project)}"><meta name="artifact-created" content="${escapeHtml(timestamp.slice(0, 10))}"><meta name="artifact-updated" content="${escapeHtml(timestamp.slice(0, 10))}">\n<title>${safeTitle}</title><style>body{font:16px/1.55 system-ui;margin:0;background:#f7f7f5;color:#171715}.page{max-width:880px;margin:auto;padding:64px 28px}h1{font-size:clamp(2rem,5vw,4rem);line-height:1.05}pre{font:inherit;white-space:pre-wrap}</style></head>\n<body><main class="page"><h1>${safeTitle}</h1><pre>${safeContent}</pre></main><script src="/artifacts/artifact-shell.js"></script></body></html>\n`;
    const indexReplay = await writeOnce(index, document, expected, htmlDigest);
    return {
      staged: true,
      promoted: false,
      replay: manifestReplay && indexReplay,
      location: logicalPath(this.dataRoot, root),
      nextStep: "Review, then promote through the Humanware artifact service.",
    };
  }
}
