import {spawn} from "node:child_process";
import {fileURLToPath} from "node:url";
import {loadSlackThreadSnapshot} from "./close-report.mjs";
import {slackRouteKey} from "./slack-route.mjs";

// The writer ships beside this plugin in the framework tree. It owns every file in a session folder;
// the gateway hands it data, and the Slack token never leaves this process.
const SCRIPT = fileURLToPath(new URL("../../../session-records/session_records.py", import.meta.url));

// Its own process group, so a gateway restart never kills a write half-way. Resolves with stdout.
export function runSessionRecords(dataRoot, args, {input = "", python = "python3", start = spawn} = {}) {
  return new Promise((resolve, reject) => {
    const child = start(python, [SCRIPT, "--data-root", dataRoot, ...args], {detached: true, stdio: ["pipe", "pipe", "pipe"]});
    let out = "", err = "";
    child.stdout.on("data", chunk => { out += chunk; });
    child.stderr.on("data", chunk => { err = (err + chunk).slice(-4000); });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve(out)
      : reject(new Error(`session_records ${args[0]} exited ${code}: ${err.trim().split("\n").at(-1) ?? ""}`)));
    child.stdin.end(input);
  });
}

// The folder a run end captures: the Slack thread when the session is one, else the session itself.
export const sessionRecordId = sessionKey => slackRouteKey({sessionKey}) ?? sessionKey;

// One write in flight per session; any run that ends meanwhile owes exactly one more write afterwards.
export function createSessionCapture(write, onError) {
  const owed = new Map();
  const run = session => {
    owed.set(session, false);
    Promise.resolve().then(() => write(session)).catch(error => onError(session, error))
      .finally(() => owed.get(session) ? run(session) : owed.delete(session));
  };
  return session => { if (owed.has(session)) owed.set(session, true); else run(session); };
}

const FILE_FIELDS = ["id", "name", "title", "mimetype", "filetype", "size", "created", "user", "mode", "is_external", "permalink", "url_private"];

// Every message in the thread up to `latest`, page by page; attached files are listed, not downloaded.
export async function exportSlackThread({channel, threadId, latest, token, call}) {
  const messages = await loadSlackThreadSnapshot({channel, threadId, latest, token, call});
  const files = messages.flatMap(message => (message.files ?? []).map(file =>
    ({messageTs: message.ts, ...Object.fromEntries(FILE_FIELDS.filter(field => file[field] != null).map(field => [field, file[field]]))})));
  return {schemaVersion: 1, channel, threadId, latest, exportedAt: new Date().toISOString(), messageCount: messages.length, messages, files};
}
