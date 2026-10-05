import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

const patchPath = fileURLToPath(new URL("./patch-2026.9.8-prompt-annotation-race.mjs", import.meta.url));

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-prompt-annotation-"));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({version: "2026.9.8"}));
  const dist = path.join(root, "dist");
  fs.mkdirSync(dist);
  fs.writeFileSync(path.join(dist, "selection-unrelated.mjs"), "export const unrelated = true;");
  fs.writeFileSync(path.join(dist, "selection-fixture.mjs"), `function annotate(current, admittedMessage, fields) {\n\t\t\tif (!isDeepStrictEqual(current, admittedMessage)) throw new Error("native prompt annotation cannot replace an edited admission");\n\t\t\tconst metadata = admittedMessage["__openclaw"] ?? {};\n\t\t\tif (metadata.runTerminal !== void 0 || Object.entries(fields).some(([key, value]) => metadata[key] !== void 0 && metadata[key] !== value)) throw new Error("native prompt annotation conflicts with recorded provenance");\n\t\t\tconst next = {\n\t\t\t\t...admittedMessage,\n\t\t\t\t__openclaw: {\n\t\t\t\t\t...metadata,\n\t\t\t\t\t...fields\n\t\t\t\t}\n\t\t\t};\n\t\t\treturn next;\n}`);
  return dist;
}

function apply(dist) {
  execFileSync(process.execPath, [patchPath], {env: {...process.env, OPENCLAW_CORE_DIST: dist}, stdio: "pipe"});
}

test("annotation preserves compatible metadata added after admission", (t) => {
  const dist = fixture(t);
  apply(dist);
  const source = fs.readFileSync(path.join(dist, "selection-fixture.mjs"), "utf8");
  const annotate = Function("isDeepStrictEqual", `${source}; return annotate;`)((left, right) => JSON.stringify(left) === JSON.stringify(right));
  const admitted = {role: "user", content: "hello", __openclaw: {senderIsOwner: true}};
  const current = {role: "user", content: "hello", __openclaw: {senderIsOwner: true, intent: {kind: "request"}}};
  assert.deepEqual(annotate(current, admitted, {mirrorIdentity: "one"}), {role: "user", content: "hello", __openclaw: {senderIsOwner: true, intent: {kind: "request"}, mirrorIdentity: "one"}});
});

test("annotation still rejects message edits and conflicting metadata", (t) => {
  const dist = fixture(t);
  apply(dist);
  const source = fs.readFileSync(path.join(dist, "selection-fixture.mjs"), "utf8");
  const annotate = Function("isDeepStrictEqual", `${source}; return annotate;`)((left, right) => JSON.stringify(left) === JSON.stringify(right));
  assert.throws(() => annotate({role: "user", content: "edited"}, {role: "user", content: "hello"}, {mirrorIdentity: "one"}), /edited admission/);
  assert.throws(() => annotate({role: "user", content: "hello", __openclaw: {senderIsOwner: false}}, {role: "user", content: "hello", __openclaw: {senderIsOwner: true}}, {mirrorIdentity: "one"}), /conflicts/);
  assert.throws(() => annotate({role: "user", content: "hello"}, {role: "user", content: "hello", __openclaw: {senderIsOwner: true}}, {mirrorIdentity: "one"}), /conflicts/);
});

test("readable bundle is patched idempotently", (t) => {
  const dist = fixture(t);
  apply(dist);
  const before = [path.join(dist, "selection-fixture.mjs")].map((file) => fs.readFileSync(file, "utf8"));
  assert.ok(before.every((source) => source.includes("humanware:additive-prompt-annotation-metadata")));
  apply(dist);
  const after = [path.join(dist, "selection-fixture.mjs")].map((file) => fs.readFileSync(file, "utf8"));
  assert.deepEqual(after, before);
});

test("refuses a different OpenClaw version", (t) => {
  const dist = fixture(t);
  fs.writeFileSync(path.join(dist, "..", "package.json"), JSON.stringify({version: "2026.9.1"}));
  assert.throws(() => apply(dist));
  assert.ok(!fs.readFileSync(path.join(dist, "selection-fixture.mjs"), "utf8").includes("humanware:"));
});
