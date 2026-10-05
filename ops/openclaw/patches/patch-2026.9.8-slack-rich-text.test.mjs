import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const patchPath = fileURLToPath(new URL("./patch-2026.9.8-slack-rich-text.mjs", import.meta.url));

test("wires rich_text blocks into the single-chunk send idempotently", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-slack-rich-text-"));
  try {
    const bundles = path.join(root, "dist", ".setup");
    fs.mkdirSync(bundles, { recursive: true });
    const sendFile = path.join(bundles, "send-fixture.mjs");
    fs.writeFileSync(sendFile, `async function sendMessageSlack(to, message, opts) {
	for (const [partIndex, chunk] of chunksToPost.entries()) {
		if (partIndex === 0 && !opts.mediaUrl) await dispatchOnce();
		await postPart({
			text: chunk,
			replyBroadcast: carriesPrimaryMessageOptions ? opts.replyBroadcast : void 0,
			metadata,
		});
	}
}
`);
    const env = { ...process.env, OPENCLAW_SLACK_DIST: path.join(root, "dist") };
    const first = JSON.parse(execFileSync(process.execPath, [patchPath], { env, encoding: "utf8" }));
    assert.equal(first.send, "patched");
    const patched = fs.readFileSync(sendFile, "utf8");
    assert.match(patched, /^import \{ markdownToSlackRichTextBlocks \} from "\.\/openclaw-instance-rich-text\.js";/);
    assert.match(patched, /blocks: autoRichTextBlocks/);
    assert.ok(fs.existsSync(path.join(bundles, "openclaw-instance-rich-text.js")));
    const second = JSON.parse(execFileSync(process.execPath, [patchPath], { env, encoding: "utf8" }));
    assert.equal(second.send, "alreadyPatched");
    assert.equal(fs.readFileSync(sendFile, "utf8"), patched);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
