import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

const patchPath = fileURLToPath(new URL("./patch-2026.9.1-prompt-annotation-race.mjs", import.meta.url));

function fixture(t) {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-prompt-annotation-"));
  t.after(() => fs.rmSync(dist, {recursive: true, force: true}));
  fs.mkdirSync(path.join(dist, "worker"));
  fs.writeFileSync(path.join(dist, "user-turn-transcript-fixture.js"), `function annotate(current, admittedMessage, fields) {\n\t\t\tif (!isDeepStrictEqual(current, admittedMessage)) throw new Error("native prompt annotation cannot replace an edited admission");\n\t\t\tconst metadata = admittedMessage["__openclaw"] ?? {};\n\t\t\tif (metadata.runTerminal !== void 0 || Object.entries(fields).some(([key, value]) => metadata[key] !== void 0 && metadata[key] !== value)) throw new Error("native prompt annotation conflicts with recorded provenance");\n\t\t\tconst next = {\n\t\t\t\t...admittedMessage,\n\t\t\t\t__openclaw: {\n\t\t\t\t\t...metadata,\n\t\t\t\t\t...fields\n\t\t\t\t}\n\t\t\t};\n\t\t\treturn next;\n}`);
  fs.writeFileSync(path.join(dist, "worker", "worker.mjs"), "function worker(){if(assertCurrent(),!isDeepStrictEqual(Zt,Pn))throw Error(`native prompt annotation cannot replace an edited admission`);let _n=Pn.__openclaw??{};if(_n.runTerminal!==void 0||Object.entries(Dn).some(([Ot,Zt])=>_n[Ot]!==void 0&&_n[Ot]!==Zt))throw Error(`native prompt annotation conflicts with recorded provenance`);let kn={...Pn,__openclaw:{..._n,...Dn}};return kn}");
  return dist;
}

function apply(dist) {
  execFileSync(process.execPath, [patchPath], {env: {...process.env, OPENCLAW_CORE_DIST: dist}, stdio: "pipe"});
}

test("annotation preserves compatible metadata added after admission", (t) => {
  const dist = fixture(t);
  apply(dist);
  const source = fs.readFileSync(path.join(dist, "user-turn-transcript-fixture.js"), "utf8");
  const annotate = Function("isDeepStrictEqual", `${source}; return annotate;`)((left, right) => JSON.stringify(left) === JSON.stringify(right));
  const admitted = {role: "user", content: "hello", __openclaw: {senderIsOwner: true}};
  const current = {role: "user", content: "hello", __openclaw: {senderIsOwner: true, intent: {kind: "request"}}};
  assert.deepEqual(annotate(current, admitted, {mirrorIdentity: "one"}), {role: "user", content: "hello", __openclaw: {senderIsOwner: true, intent: {kind: "request"}, mirrorIdentity: "one"}});
});

test("annotation still rejects message edits and conflicting metadata", (t) => {
  const dist = fixture(t);
  apply(dist);
  const source = fs.readFileSync(path.join(dist, "user-turn-transcript-fixture.js"), "utf8");
  const annotate = Function("isDeepStrictEqual", `${source}; return annotate;`)((left, right) => JSON.stringify(left) === JSON.stringify(right));
  assert.throws(() => annotate({role: "user", content: "edited"}, {role: "user", content: "hello"}, {mirrorIdentity: "one"}), /edited admission/);
  assert.throws(() => annotate({role: "user", content: "hello", __openclaw: {senderIsOwner: false}}, {role: "user", content: "hello", __openclaw: {senderIsOwner: true}}, {mirrorIdentity: "one"}), /conflicts/);
  assert.throws(() => annotate({role: "user", content: "hello"}, {role: "user", content: "hello", __openclaw: {senderIsOwner: true}}, {mirrorIdentity: "one"}), /conflicts/);
});

test("readable and worker bundles are patched idempotently", (t) => {
  const dist = fixture(t);
  apply(dist);
  const before = [path.join(dist, "user-turn-transcript-fixture.js"), path.join(dist, "worker", "worker.mjs")].map((file) => fs.readFileSync(file, "utf8"));
  assert.ok(before.every((source) => source.includes("humanware:additive-prompt-annotation-metadata")));
  apply(dist);
  const after = [path.join(dist, "user-turn-transcript-fixture.js"), path.join(dist, "worker", "worker.mjs")].map((file) => fs.readFileSync(file, "utf8"));
  assert.deepEqual(after, before);
});
