import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { agentPrompt, createBridge, extractAgentResult, extractReply, isMainModule, keyedQueue, postReply, renderCampfireReply, sessionKey, validateWebhook } from "./bridge.mjs";

const payload = {
  user: { id: 7, name: "Ariel" },
  room: { id: 11, name: "Lobby", path: "/rooms/11/2-AbCd123/messages" },
  message: { id: 23, body: { html: "<p>Hello</p>", plain: "Hello" }, path: "/rooms/11/@23" },
};

test("recognizes execution through a runtime symlink as the main module", () => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "campfire-main-"));
  const linked = join(directory, "bridge.mjs");
  symlinkSync(new URL("./bridge.mjs", import.meta.url), linked);
  assert.equal(isMainModule(new URL("./bridge.mjs", import.meta.url).href, linked), true);
});

test("validates Campfire payloads and stable room sessions", () => {
  assert.deepEqual(validateWebhook(payload), payload);
  assert.equal(sessionKey("max", 11), "campfire:room:11");
  assert.match(agentPrompt(payload), /Sender: Ariel/);
  assert.throws(() => validateWebhook({ ...payload, room: { ...payload.room, path: "https://evil.test/" } }), /reply path/);
});

test("extracts OpenClaw JSON replies", () => {
  assert.equal(extractReply({ result: { payloads: [{ text: "  Hello back  " }] } }), "Hello back");
  assert.throws(() => extractReply({ result: {} }), /no text reply/);
});

test("extracts provenance and renders structured Campfire HTML with a signature", () => {
  const result = extractAgentResult({ result: { payloads: [{ text: "## TLDR\n\nDone.\n\n- One\n- Two" }], meta: { agentMeta: { model: "gpt-5.6-sol", provider: "openai", agentHarnessId: "codex" }, requestShaping: { thinking: "low" } } } });
  assert.equal(renderCampfireReply(result), "<h2>TLDR</h2>\n<p>Done.</p>\n<ul><li>One</li><li>Two</li></ul>\n<p>🟢 Sol · ⌘ Codex · 💭 Low</p>");
});

test("serializes tasks by key", async () => {
  const enqueue = keyedQueue();
  const seen = [];
  await Promise.all([
    enqueue("room", async () => { await new Promise((resolve) => setTimeout(resolve, 15)); seen.push(1); }),
    enqueue("room", async () => { seen.push(2); }),
  ]);
  assert.deepEqual(seen, [1, 2]);
});

test("posts rich-text replies only to the configured origin", async () => {
  let request;
  await postReply({
    baseUrl: "https://cf.example.com",
    roomPath: payload.room.path,
    text: "Reply",
    fetchImpl: async (url, options) => { request = { url: String(url), options }; return { ok: true, status: 201 }; },
  });
  assert.equal(request.url, "https://cf.example.com/rooms/11/2-AbCd123/messages");
  assert.equal(request.options.body, "Reply");
  assert.equal(request.options.headers["content-type"], "text/html; charset=utf-8");
});

test("acknowledges webhooks before asynchronous delivery", async () => {
  let delivered;
  const server = createBridge({
    baseUrl: "https://cf.example.com",
    invoke: async ({ agent }) => `${agent} reply`,
    deliver: async (value) => { delivered = value; },
    logger: { info() {}, warn() {}, error() {} },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/campfire/max`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
  });
  assert.equal(response.status, 202);
  for (let attempt = 0; attempt < 20 && !delivered; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(delivered.text, "<p>max reply</p>");
  await new Promise((resolve) => server.close(resolve));
});
