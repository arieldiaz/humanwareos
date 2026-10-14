import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const patchPath = fileURLToPath(new URL("./patch-2026.9.8-slack-rich-text.mjs", import.meta.url));

// A runnable miniature of sendMessageSlackQueued carrying every anchor the patch rewrites.
const FIXTURE = `export const posts = [];
export async function sendMessageSlack() {}
const resolveSlackTextChunks = ({ text }) => (text ? [text] : []);
const createSlackSendResult = (messageId, channelId, kind, threadTs) => ({ messageId, channelId, kind, threadTs });
const createSlackSendReceiptFromResults = (results) => results;
let nextTs = 1;
async function postSlackMessageBestEffort(params) {
	posts.push(params);
	return { identity: params.identity, response: { ts: \`ts-\${nextTs++}\`, thread_ts: params.threadTs } };
}
export async function sendMessageSlackQueued({ trimmedMessage, opts, blocks, recipient }) {
	const channelId = "C1";
	const deliveredResults = [];
	const reportDelivery = async (result) => { deliveredResults.push(result); return result; };
	const dispatchOnce = async () => {};
	const textChunkLimit = 4000;
	let lastMessageId = "";
	let deliveredChannelId = channelId;
	let canonicalDeliveredThreadTs;
	let sendIdentity;
	const postPart = async (part) => {
		const posted = await postSlackMessageBestEffort({
			client: void 0,
			channelId,
			threadTs: opts.threadTs,
			identity: sendIdentity,
			...part
		});
		const { response } = posted;
		lastMessageId = response.ts;
		canonicalDeliveredThreadTs ??= response.thread_ts;
		return await reportDelivery(createSlackSendResult(response.ts, deliveredChannelId, part.blocks ? "card" : "text", response.thread_ts ?? opts.threadTs), part.blocks);
	};
	const resolvedChunks = resolveSlackTextChunks({
		cfg: void 0,
		accountId: "a",
		text: trimmedMessage,
		textLimit: textChunkLimit,
	});
	let chunksToPost;
	if (opts.mediaUrl) {
		chunksToPost = resolvedChunks.slice(1);
	} else chunksToPost = resolvedChunks.length ? resolvedChunks : [""];
	for (const [partIndex, chunk] of chunksToPost.entries()) {
		const carriesPrimaryMessageOptions = partIndex === 0 && !opts.mediaUrl;
		const metadata = void 0;
		if (partIndex === 0 && !opts.mediaUrl) await dispatchOnce();
		await postPart({
			text: chunk,
			replyBroadcast: carriesPrimaryMessageOptions ? opts.replyBroadcast : void 0,
			metadata,
			...opts.textIsSlackPlainText ? { mrkdwn: false } : {}
		});
	}
	const deliveredThreadTs = canonicalDeliveredThreadTs ?? opts.threadTs;
	return {
		messageId: lastMessageId,
		channelId: deliveredChannelId,
		threadTs: deliveredThreadTs,
		receipt: createSlackSendReceiptFromResults(deliveredResults, deliveredThreadTs)
	};
}
`;

function stage() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-slack-rich-text-"));
  const bundles = path.join(root, "dist", ".setup");
  fs.mkdirSync(bundles, { recursive: true });
  const sendFile = path.join(bundles, "send-fixture.mjs");
  fs.writeFileSync(sendFile, FIXTURE);
  const env = { ...process.env, OPENCLAW_SLACK_DIST: path.join(root, "dist") };
  const apply = () => JSON.parse(execFileSync(process.execPath, [patchPath], { env, encoding: "utf8" }));
  return { root, bundles, sendFile, apply };
}

test("wires rich_text blocks and the channel-root split into the send idempotently", () => {
  const { root, bundles, sendFile, apply } = stage();
  try {
    const first = apply();
    assert.equal(first.send, "patched");
    assert.equal(first.root, "patched");
    const patched = fs.readFileSync(sendFile, "utf8");
    assert.match(patched, /import \{ markdownToSlackRichTextBlocks \} from "\.\/openclaw-instance-rich-text\.js";/);
    assert.match(patched, /import \{ splitSlackChannelRoot \} from "\.\/openclaw-instance-rich-text\.js";/);
    assert.match(patched, /blocks: autoRichTextBlocks/);
    assert.ok(fs.existsSync(path.join(bundles, "openclaw-instance-rich-text.js")));
    const second = apply();
    assert.equal(second.send, "alreadyPatched");
    assert.equal(second.root, "alreadyPatched");
    assert.equal(fs.readFileSync(sendFile, "utf8"), patched);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a multi-line channel post lands as a one-line root plus a threaded body", async () => {
  const { root, sendFile, apply } = stage();
  try {
    apply();
    const { sendMessageSlackQueued, posts } = await import(pathToFileURL(sendFile).href);
    const message = "## Fix: thread shape\n\nDetails:\n- one\n- two";
    const result = await sendMessageSlackQueued({ trimmedMessage: message, opts: {}, blocks: void 0, recipient: { kind: "channel", id: "C1" } });
    assert.equal(posts.length, 2);
    assert.equal(posts[0].text, "## Fix: thread shape");
    assert.equal(posts[0].threadTs, undefined);
    assert.equal(posts[0].blocks, undefined);
    assert.equal(posts[1].text, "Details:\n- one\n- two");
    assert.equal(posts[1].threadTs, "ts-1");
    assert.ok(posts[1].blocks?.length, "the body keeps rich_text blocks");
    assert.equal(result.messageId, "ts-1");
    assert.equal(result.threadTs, "ts-1");

    posts.length = 0;
    await sendMessageSlackQueued({ trimmedMessage: message, opts: { threadTs: "ts-root" }, blocks: void 0, recipient: { kind: "channel", id: "C1" } });
    assert.equal(posts.length, 1, "threaded sends are untouched");
    assert.equal(posts[0].threadTs, "ts-root");
    assert.ok(posts[0].blocks?.length);

    posts.length = 0;
    await sendMessageSlackQueued({ trimmedMessage: message, opts: {}, blocks: void 0, recipient: { kind: "user", id: "U1" } });
    assert.equal(posts.length, 1, "DMs are untouched");

    posts.length = 0;
    const single = await sendMessageSlackQueued({ trimmedMessage: "Fix: one line", opts: {}, blocks: void 0, recipient: { kind: "channel", id: "C1" } });
    assert.equal(posts.length, 1);
    assert.equal(posts[0].threadTs, undefined);
    assert.equal(single.messageId, posts[0] && "ts-5");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
