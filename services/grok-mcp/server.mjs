import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { toNodeHandler, hostHeaderValidation, originValidation } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { GrokBridge, validateConfig } from "./bridge.mjs";

const RUNTIME_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DEFAULT_CONFIG = resolve(RUNTIME_ROOT, "config/services/grok-mcp.json");
const MAX_REQUEST_BYTES = 1_048_576;
const IDENTIFIER = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const CONVERSATION = z.string().min(1).max(512);
const TIMESTAMP = z.string().max(64).refine((value) => !Number.isNaN(Date.parse(value)), "must be an ISO-8601 timestamp").optional();

function result(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

function tool(handler) {
  return async (input) => {
    try {
      return result(await handler(input));
    } catch (error) {
      const message = error instanceof Error ? error.message : "bridge operation failed";
      return { isError: true, content: [{ type: "text", text: message }] };
    }
  };
}

export function buildMcpServer(bridge) {
  const server = new McpServer(
    { name: "humanware-grok-bridge", version: "0.1.0" },
    { instructions: "Use only the smallest context needed. Writes are append-only or staged, idempotent by operationId, and never edit current memory or publish artifacts." },
  );

  server.registerTool(
    "get_context",
    {
      description: "Read the configured Tier 2 Humanware strategy and current-context projections. Request only the sections needed for the task.",
      inputSchema: z.object({ sections: z.array(z.string().min(1).max(64)).max(8).optional() }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    tool((input) => bridge.getContext(input)),
  );

  server.registerTool(
    "record_turn",
    {
      description: "Append one substantive Grok exchange to raw Humanware evidence. Call after a durable decision or meaningful work result, not pleasantries. Reuse operationId on retry.",
      inputSchema: z.object({
        operationId: IDENTIFIER,
        conversationId: CONVERSATION,
        userText: z.string().min(1).max(100_000),
        assistantText: z.string().min(1).max(100_000),
        occurredAt: TIMESTAMP,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    tool((input) => bridge.recordTurn(input)),
  );

  server.registerTool(
    "save_work",
    {
      description: "Save a durable draft or result in the Grok integration workspace. This does not promote it to memory or publish it.",
      inputSchema: z.object({
        operationId: IDENTIFIER,
        conversationId: CONVERSATION,
        title: z.string().min(1).max(200),
        content: z.string().min(1).max(250_000),
        createdAt: TIMESTAMP,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    tool((input) => bridge.saveWork(input)),
  );

  server.registerTool(
    "propose_memory",
    {
      description: "Append a memory proposal as evidence for later human/agent curation. This never edits the current memory projection.",
      inputSchema: z.object({
        operationId: IDENTIFIER,
        conversationId: CONVERSATION,
        subject: z.string().min(1).max(300),
        facts: z.array(z.string().min(1).max(10_000)).min(1).max(20),
        sources: z.array(z.string().min(1).max(2_000)).max(20).optional(),
        observedAt: TIMESTAMP,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    tool((input) => bridge.proposeMemory(input)),
  );

  server.registerTool(
    "stage_artifact",
    {
      description: "Stage a safe text artifact candidate for Humanware review. This does not promote or publish the artifact.",
      inputSchema: z.object({
        operationId: IDENTIFIER,
        conversationId: CONVERSATION,
        project: z.string().min(1).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
        title: z.string().min(1).max(200),
        content: z.string().min(1).max(500_000),
        createdAt: TIMESTAMP,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    tool((input) => bridge.stageArtifact(input)),
  );
  return server;
}

function secureEqual(actual, expected) {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function bearer(req, token) {
  const header = Array.isArray(req.headers.authorization) ? req.headers.authorization[0] : req.headers.authorization;
  return typeof header === "string" && header.startsWith("Bearer ") && secureEqual(header.slice(7), token);
}

function json(res, status, body, headers = {}) {
  const content = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(content.length),
    ...headers,
  });
  res.end(content);
}

export function createBridgeHttpServer({ config, dataRoot, token }) {
  validateConfig(config);
  if (!dataRoot || !resolve(dataRoot).startsWith("/")) throw new Error("HUMANWARE_DATA_ROOT must be absolute");
  if (!token || token.length < 32) throw new Error("GROK_MCP_TOKEN must contain at least 32 characters");
  const bridge = new GrokBridge({ config, dataRoot });
  const handler = createMcpHandler(() => buildMcpServer(bridge));
  const nodeHandler = toNodeHandler(handler, { maxRequestBodySize: MAX_REQUEST_BYTES });
  const publicHost = new URL(config.publicOrigin).hostname;
  const validateHost = hostHeaderValidation([publicHost, "localhost", "127.0.0.1", "[::1]"]);
  const validateOrigin = originValidation([publicHost, "localhost", "127.0.0.1", "[::1]"]);

  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path === "/health" && req.method === "GET") {
      try {
        json(res, 200, await bridge.health());
      } catch {
        json(res, 503, { status: "unavailable" });
      }
      return;
    }
    if (path !== config.mountPath) {
      json(res, 404, { error: "not found" });
      return;
    }
    if (!validateHost(req, res) || !validateOrigin(req, res)) return;
    if (!bearer(req, token)) {
      json(res, 401, { error: "unauthorized" }, { "WWW-Authenticate": 'Bearer realm="humanware-grok-mcp"' });
      return;
    }
    try {
      await nodeHandler(req, res);
    } catch (error) {
      console.error(`grok-mcp request failed: ${error instanceof Error ? error.message : "unknown error"}`);
      if (!res.headersSent) json(res, 500, { error: "request failed" });
      else res.end();
    }
  });
  server.on("close", () => void handler.close());
  return server;
}

export async function loadRuntime() {
  const configPath = process.env.GROK_MCP_CONFIG_PATH || DEFAULT_CONFIG;
  const config = validateConfig(JSON.parse(await readFile(configPath, "utf8")));
  const dataRoot = process.env.HUMANWARE_DATA_ROOT;
  const token = process.env.GROK_MCP_TOKEN;
  return { config, dataRoot, token };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const runtime = await loadRuntime();
  const [host, rawPort] = runtime.config.listen.split(":");
  const server = createBridgeHttpServer(runtime);
  server.listen(Number(rawPort), host, () => console.error(`grok-mcp listening on ${runtime.config.listen}`));
}
