import assert from "node:assert/strict";
import { test } from "node:test";
import { markdownToSlackRichTextBlocks } from "./markdown-to-rich-text.mjs";

test("plain prose keeps the upstream text path", () => {
  assert.equal(markdownToSlackRichTextBlocks("Just a sentence with **bold** in it."), null);
  assert.equal(markdownToSlackRichTextBlocks(""), null);
  assert.equal(markdownToSlackRichTextBlocks(null), null);
});

test("bullets become a rich_text_list with real indent levels", () => {
  const blocks = markdownToSlackRichTextBlocks("- first\n- second\n  - nested\n- third");
  assert.equal(blocks.length, 1);
  const lists = blocks[0].elements;
  assert.deepEqual(
    lists.map((element) => [element.type, element.style, element.indent, element.elements.length]),
    [
      ["rich_text_list", "bullet", 0, 2],
      ["rich_text_list", "bullet", 1, 1],
      ["rich_text_list", "bullet", 0, 1],
    ],
  );
});

test("ordered lists are ordered, not bullets", () => {
  const [block] = markdownToSlackRichTextBlocks("1. one\n2. two");
  assert.equal(block.elements[0].style, "ordered");
  assert.equal(block.elements[0].elements.length, 2);
});

test("h1/h2 become header blocks, h3+ become bold sections", () => {
  const blocks = markdownToSlackRichTextBlocks("## Top\n\n- item\n\n### Sub\n\n- other");
  // h3 stays inside the surrounding rich_text block; only h1/h2 break it.
  assert.deepEqual(blocks.map((block) => block.type), ["header", "rich_text"]);
  assert.equal(blocks[0].text.text, "Top");
  assert.equal(blocks[0].text.emoji, true);
  const [list, subheading] = blocks[1].elements;
  assert.equal(list.type, "rich_text_list");
  assert.equal(subheading.type, "rich_text_section");
  assert.equal(subheading.elements[0].style.bold, true);
  assert.equal(subheading.elements[0].text, "Sub");
});

test("inline styles, links and emoji become structured elements", () => {
  const [block] = markdownToSlackRichTextBlocks("- **bold** and `code` and [label](https://x.com) :butterfly:");
  const elements = block.elements[0].elements[0].elements;
  assert.equal(elements[0].text, "bold");
  assert.equal(elements[0].style.bold, true);
  assert.ok(elements.some((element) => element.style?.code && element.text === "code"));
  const link = elements.find((element) => element.type === "link");
  assert.equal(link.url, "https://x.com");
  assert.equal(link.text, "label");
  assert.ok(elements.some((element) => element.type === "emoji" && element.name === "butterfly"));
});

test("slack-native tokens survive as structured elements", () => {
  const [block] = markdownToSlackRichTextBlocks("- ping <@U0BG50JV77D> in <#C0BKFAFGJ72|general> &amp; done");
  const elements = block.elements[0].elements[0].elements;
  assert.ok(elements.some((element) => element.type === "user" && element.user_id === "U0BG50JV77D"));
  assert.ok(elements.some((element) => element.type === "channel" && element.channel_id === "C0BKFAFGJ72"));
  // rich_text is raw text: mrkdwn HTML escapes must be undone.
  assert.ok(elements.some((element) => element.type === "text" && element.text.includes("& done")));
});

test("code fences and quotes keep their own primitives", () => {
  const blocks = markdownToSlackRichTextBlocks("> quoted\n\n```js\nconst a = 1;\n```");
  const types = blocks[0].elements.map((element) => element.type);
  assert.deepEqual(types, ["rich_text_quote", "rich_text_preformatted"]);
  assert.equal(blocks[0].elements[1].elements[0].text, "const a = 1;");
});

test("dividers split rich_text blocks", () => {
  const blocks = markdownToSlackRichTextBlocks("- a\n\n---\n\n- b");
  assert.deepEqual(blocks.map((block) => block.type), ["rich_text", "divider", "rich_text"]);
});

test("oversized input falls back to the text path", () => {
  const huge = Array.from({ length: 400 }, (_, index) => `- item ${index} ${"x".repeat(40)}`).join("\n");
  assert.equal(markdownToSlackRichTextBlocks(huge), null);
});

test("too many blocks falls back to the text path", () => {
  const many = Array.from({ length: 60 }, (_, index) => `## Heading ${index}`).join("\n\n");
  assert.equal(markdownToSlackRichTextBlocks(many), null);
});
