// The egress view is the only history value allowed to leave the host. It is built by allowlist.

export const EGRESS_MODES = Object.freeze(["metadata", "full"]);
export const UNIT_CHARS = 2000;

const FIELD_CHARS = 300;
const DESCRIPTION_CHARS = 1500;
const EXCERPT_CHARS = 1200;
const LIST_ITEMS = 25;

// Metadata mode: no conversation text, tool output, or Slack root excerpt is eligible.
const ALLOWED = Object.freeze({
  session: ["agent", "surface", "channel", "date", "label", "tools", "files"],
  pr: ["number", "title", "description", "state", "created", "merged", "files"],
  decision: ["date", "summary"],
});

// Raw Slack channel, user, and message/thread identifiers never leave the host.
const SLACK_ID = /\b[CDGUW](?=[A-Z0-9]*\d)[A-Z0-9]{8,12}\b/g;
const SLACK_TS = /\bp?\d{10}\.?\d{6}\b/g;

export function scrub(value, limit = FIELD_CHARS) {
  const text = String(value).replace(SLACK_ID, "[id]").replace(SLACK_TS, "[ts]").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

export function egressView(doc, {mode = "metadata"} = {}) {
  if (!EGRESS_MODES.includes(mode)) throw new Error(`invalid egress mode ${mode}`);
  const allowed = ALLOWED[doc?.kind];
  if (!allowed) throw new Error(`no egress view for kind ${doc?.kind}`);
  const view = {kind: doc.kind};
  for (const key of allowed) {
    const value = doc.meta?.[key];
    if (value == null || value === "") continue;
    view[key] = Array.isArray(value) ? value.slice(0, LIST_ITEMS).map((item) => scrub(item)) : scrub(value, key === "description" ? DESCRIPTION_CHARS : FIELD_CHARS);
  }
  if (mode === "full" && doc.localText) view.excerpt = scrub(doc.localText, EXCERPT_CHARS);
  return Object.freeze(view);
}

export function unitText(view) {
  const text = Object.entries(view).map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value}`).join("\n");
  return text.length > UNIT_CHARS ? `${text.slice(0, UNIT_CHARS - 1)}…` : text;
}
