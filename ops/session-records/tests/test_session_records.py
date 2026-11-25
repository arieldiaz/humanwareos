import contextlib
from datetime import datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path
import sqlite3
import stat
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import session_records as R  # noqa: E402

THREAD = "agent:{}:slack:channel:c1:thread:100.1"
LOGICAL = "slack:C1:100.1"
CLI_BOUND = "11111111-1111-4111-8111-111111111111"
CLI_MARKED = "22222222-2222-4222-8222-222222222222"
CLI_DIRECT = "33333333-3333-4333-8333-333333333333"
CODEX_CLAIMED = "44444444-4444-4444-8444-444444444444"
CODEX_DIRECT = "55555555-5555-4555-8555-555555555555"
CURSOR_DIRECT = "66666666-6666-4666-8666-666666666666"
START = int(datetime(2026, 11, 20, 12, tzinfo=timezone.utc).timestamp() * 1000)
SCHEMA = """
CREATE TABLE session_nodes (session_key TEXT PRIMARY KEY, current_session_id TEXT NOT NULL, entry_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE session_windows (session_id TEXT PRIMARY KEY, session_key TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  started_at INTEGER, ended_at INTEGER, status TEXT, chat_type TEXT, channel TEXT, account_id TEXT, model_provider TEXT, model TEXT,
  agent_harness_id TEXT, parent_session_key TEXT, spawned_by TEXT, display_name TEXT);
CREATE TABLE transcript_events (session_id TEXT NOT NULL, seq INTEGER NOT NULL, event_json TEXT, created_at INTEGER NOT NULL, event_zstd BLOB,
  message_role TEXT, PRIMARY KEY (session_id, seq));
CREATE TABLE session_transcript_archives (session_id TEXT, generation TEXT, session_key TEXT, reason TEXT, encoding TEXT, archive_blob BLOB,
  archive_sha256 TEXT, archive_name TEXT UNIQUE, created_at INTEGER);
"""


def message(event_id, role, offset, content, **extra):
    return {"type": "message", "id": event_id, "timestamp": R.iso(START + offset), "message": dict({"role": role, "content": content}, **extra)}


def tree(root, skip=None):
    """Names, sizes and hashes of every file below root."""
    found = {}
    for path in sorted(Path(root).rglob("*")):
        if skip and (path == skip or skip in path.parents):
            continue
        if path.is_file():
            found[str(path.relative_to(root))] = hashlib.sha256(path.read_bytes()).hexdigest()
    return found


class Fixture:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.data = self.root / "data"
        self.state = self.root / "openclaw"
        self.claude = self.root / "claude"
        self.codex = self.root / "codex"
        self.cursor = self.root / "cursor"
        self.stores = R.Stores(self.data, self.state, self.claude, self.codex, self.cursor, env={"HOME": str(self.root)})
        self.build()

    def db(self, agent):
        return self.state / "agents" / agent / "agent" / "openclaw-agent.sqlite"

    def store(self, agent, windows, archives=()):
        path = self.db(agent)
        path.parent.mkdir(parents=True)
        connection = sqlite3.connect(path)
        connection.executescript(SCHEMA)
        for key, session_id, created, entry, events in windows:
            connection.execute("INSERT INTO session_windows (session_id, session_key, created_at, updated_at, status, channel, model, model_provider) "
                               "VALUES (?,?,?,?,?,?,?,?)", (session_id, key, created, created, "running", "slack", "model-a", "provider-a"))
            if entry is not None:
                connection.execute("INSERT INTO session_nodes VALUES (?,?,?,?)",
                                   (key, session_id, json.dumps(dict(entry, sessionId=session_id, updatedAt=created)), created))
            for seq, event in enumerate(events):
                connection.execute("INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?,?,?,?)",
                                   (session_id, seq, json.dumps(event), created + seq))
        for key, session_id, name, blob in archives:
            connection.execute("INSERT INTO session_transcript_archives VALUES (?,?,?,?,?,?,?,?,?)",
                               (session_id, "g1", key, "deleted", "identity", blob, hashlib.sha256(blob).hexdigest(), name, START))
        connection.commit()
        connection.close()

    def add_event(self, agent, session_id, seq, event):
        connection = sqlite3.connect(self.db(agent))
        connection.execute("INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?,?,?,?)",
                           (session_id, seq, json.dumps(event), START + seq))
        connection.commit()
        connection.close()

    def build(self):
        liv_events = [{"type": "session", "id": "liv-window", "timestamp": R.iso(START)},
                      message("e1", "user", 1000, "hello"),
                      message("e2", "assistant", 2000, [{"type": "text", "text": "hi"}, {"type": "toolCall", "id": "t1", "name": "exec", "arguments": {"command": "ls"}}], model="model-a"),
                      message("e3", "toolResult", 3000, [{"type": "text", "text": "file"}], toolCallId="t1", toolName="exec")]
        old_events = [message("o1", "user", -5000, "earlier window")]
        self.store("liv", [
            (THREAD.format("liv"), "liv-old", START - 10000, None, old_events),
            (THREAD.format("liv"), "liv-window", START, {"cliSessionIds": {"claude-cli": CLI_BOUND}}, liv_events),
        ], archives=[(THREAD.format("liv"), "liv-gone", "liv-gone.jsonl.deleted.zst",
                      (json.dumps(message("a1", "user", -9000, "archived")) + "\n").encode())])
        max_events = [message("m1", "assistant", 4000, [{"type": "text", "text": "max joined"}], model="model-b",
                              idempotencyKey=f"codex-app-server:{CODEX_CLAIMED}:turn:call")]
        self.store("max", [(THREAD.format("max"), "max-window", START + 3500, {}, max_events)])
        project = self.claude / "projects" / "-tmp-work"
        (project / "memory").mkdir(parents=True)
        (project / "memory" / "MEMORY.md").write_text("- note\n")
        (project / CLI_BOUND / "subagents").mkdir(parents=True)
        (project / CLI_BOUND / "subagents" / "agent-1.jsonl").write_text("{}\n")
        self.claude_line(project / f"{CLI_BOUND}.jsonl", "bound")
        self.claude_line(project / f"{CLI_MARKED}.jsonl", "Runtime: agent=max | session=agent:max:slack:channel:c1:thread:100.1 | host=x")
        self.claude_line(project / f"{CLI_DIRECT}.jsonl", "direct question")
        for cli_id, day in ((CODEX_CLAIMED, "20"), (CODEX_DIRECT, "21")):
            path = self.codex / "sessions" / "2026" / "11" / day / f"rollout-2026-11-{day}T10-00-00-{cli_id}.jsonl"
            path.parent.mkdir(parents=True)
            path.write_text("\n".join(json.dumps(line) for line in [
                {"timestamp": f"2026-11-{day}T10:00:00.000Z", "type": "session_meta", "payload": {"id": cli_id, "timestamp": f"2026-11-{day}T10:00:00.000Z"}},
                {"timestamp": f"2026-11-{day}T10:00:01.000Z", "type": "turn_context", "payload": {"model": "codex-model"}},
                {"timestamp": f"2026-11-{day}T10:00:02.000Z", "type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "q"}]}},
                {"timestamp": f"2026-11-{day}T10:00:03.000Z", "type": "response_item", "payload": {"type": "function_call", "name": "shell", "arguments": "{}", "call_id": "c1"}},
                {"timestamp": f"2026-11-{day}T10:00:04.000Z", "type": "response_item", "payload": {"type": "function_call_output", "call_id": "c1", "output": "ok"}},
            ]) + "\n")
        chat = self.cursor / "chats" / "workspace" / CURSOR_DIRECT
        chat.mkdir(parents=True)
        (chat / "meta.json").write_text(json.dumps({"schemaVersion": 1, "createdAtMs": START + 86400000}))
        connection = sqlite3.connect(chat / "store.db")
        connection.execute("CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)")
        connection.executemany("INSERT INTO blobs VALUES (?, ?)", [
            ("b1", json.dumps({"role": "user", "content": [{"type": "text", "text": "cursor q"}]}).encode()),
            ("b2", b"\x00binary"),
            ("b3", json.dumps({"role": "assistant", "content": "cursor a"}).encode())])
        connection.commit()
        connection.close()
        events = self.data / "evidence" / "sessions" / "events"
        events.mkdir(parents=True)
        (events / "2026-11-20.jsonl").write_text("\n".join(json.dumps(event) for event in [
            {"kind": "usage.cost", "id": "u1", "logicalSessionId": LOGICAL, "runId": "r1", "agent": "liv", "ts": "2026-11-20T12:00:02Z",
             "cost": {"usageId": "u1", "tokens": {"input": 10, "output": 5}}},
            {"kind": "usage.cost", "id": "u1", "logicalSessionId": LOGICAL, "runId": "r1", "agent": "liv", "ts": "2026-11-20T12:00:03Z",
             "cost": {"usageId": "u1", "tokens": {"input": 12, "output": 6}}},
            {"kind": "usage.cost", "id": "u2", "logicalSessionId": "slack:C9:1.1", "runId": "r9", "cost": {"usageId": "u2", "tokens": {"input": 1}}},
        ]) + "\n")
        summaries = self.data / "generated" / "sessions" / "summaries"
        summaries.mkdir(parents=True)
        (summaries / (hashlib.sha256(LOGICAL.encode()).hexdigest()[:24] + ".md")).write_text("# summary\n")

    def claude_line(self, path, text):
        records = [{"type": "user", "uuid": f"{path.stem}-u", "sessionId": path.stem, "timestamp": R.iso(START + 500),
                    "message": {"role": "user", "content": text}},
                   {"type": "assistant", "uuid": f"{path.stem}-a", "sessionId": path.stem, "timestamp": R.iso(START + 600),
                    "message": {"role": "assistant", "model": "claude-model", "content": [{"type": "tool_use", "id": "x", "name": "Read", "input": {}}]}}]
        path.write_text("".join(json.dumps(record) + "\n" for record in records))

    def folder(self, fid=None):
        return self.data / "evidence" / "sessions" / "2026" / "11" / (fid or R.folder_id(LOGICAL))


class SessionRecordsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.f = Fixture(self.temp.name)

    def write(self, query=THREAD.format("liv")):
        return R.command_write(self.f.stores, query)

    def verify(self, folder):
        with contextlib.redirect_stdout(io.StringIO()):
            return R.main(["--data-root", str(self.f.data), "--openclaw-state", str(self.f.state), "--claude-root", str(self.f.claude),
                           "--codex-home", str(self.f.codex), "--cursor-root", str(self.f.cursor), "verify", str(folder)])

    def test_write_creates_every_file_in_the_contract(self):
        result = self.write()
        folder = self.f.folder()
        self.assertEqual(result["folder"], str(folder))
        files = set(tree(folder))
        for name in ("session.json", "transcript.jsonl", "usage.json", "summary.md", "notes/manifest.json", "notes/-tmp-work/MEMORY.md",
                     "tools/openclaw-liv-liv-window.jsonl", "tools/openclaw-liv-liv-old.jsonl", "tools/openclaw-max-max-window.jsonl",
                     "tools/openclaw-liv-liv-gone.jsonl.deleted.zst", f"tools/claude-{CLI_BOUND}.jsonl",
                     f"tools/claude-{CLI_BOUND}/subagents/agent-1.jsonl", f"tools/claude-{CLI_MARKED}.jsonl", f"tools/codex-{CODEX_CLAIMED}.jsonl"):
            self.assertIn(name, files)
        self.assertNotIn(f"tools/claude-{CLI_DIRECT}.jsonl", files)
        self.assertFalse({"slack-thread.json", "close.json"} & files)
        record = json.loads((folder / "session.json").read_text())
        self.assertTrue(record["verified"])
        self.assertTrue(all(entry["verified"] for entry in record["sources"]))
        self.assertEqual(record["agents"], ["liv", "max"])
        self.assertEqual(record["thread"], {"channelId": "C1", "threadId": "100.1"})
        self.assertEqual(record["openclaw"]["sessionIds"], ["liv-gone", "liv-old", "liv-window", "max-window"])
        self.assertEqual(record["startedAt"], R.iso(START - 10000))
        raw = (folder / "tools/openclaw-liv-liv-window.jsonl").read_bytes()
        entry = next(e for e in record["sources"] if e["name"] == "tools/openclaw-liv-liv-window.jsonl")
        self.assertEqual(entry["sha256"], hashlib.sha256(raw).hexdigest())
        self.assertEqual((folder / f"tools/claude-{CLI_BOUND}.jsonl").read_bytes(),
                         (self.f.claude / "projects/-tmp-work" / f"{CLI_BOUND}.jsonl").read_bytes())
        lines = [json.loads(line) for line in (folder / "transcript.jsonl").read_text().splitlines()]
        self.assertEqual([line["id"] for line in lines], ["openclaw:liv:a1", "openclaw:liv:o1", "openclaw:liv:e1", "openclaw:liv:e2",
                                                          "openclaw:liv:e3", "openclaw:max:m1"])
        self.assertEqual(lines[3]["toolCalls"][0]["name"], "exec")
        self.assertEqual(lines[4]["toolResults"][0]["toolCallId"], "t1")
        usage = json.loads((folder / "usage.json").read_text())
        self.assertEqual((usage["reports"], usage["totals"]), (1, {"input": 12, "output": 6}))
        self.assertEqual(self.verify(folder), 0)

    def test_any_id_names_the_same_folder_and_a_second_run_changes_nothing(self):
        self.write()
        before = tree(self.f.data)
        for query in (THREAD.format("max"), LOGICAL, R.folder_id(LOGICAL), "liv-old"):
            result = self.write(query)
            self.assertEqual((result["sourceBytesCopied"], result["transcriptLinesAppended"], result["sessionJsonChanged"]), (0, 0, False))
        self.assertEqual(tree(self.f.data), before)
        self.assertEqual(len(list((self.f.data / "evidence/sessions/2026/11").iterdir())), 1)

    def test_a_changed_source_is_appended_or_kept_and_reverified(self):
        self.write()
        folder = self.f.folder()
        transcript = (folder / "transcript.jsonl").read_bytes()
        source = self.f.claude / "projects/-tmp-work" / f"{CLI_BOUND}.jsonl"
        with open(source, "a") as handle:
            handle.write(json.dumps({"type": "user", "uuid": "later", "message": {"role": "user", "content": "more"}}) + "\n")
        self.f.add_event("liv", "liv-window", 4, message("e4", "user", 9000, "next turn"))
        result = self.write()
        self.assertEqual(result["transcriptLinesAppended"], 1)
        self.assertTrue((folder / "transcript.jsonl").read_bytes().startswith(transcript))
        self.assertEqual((folder / f"tools/claude-{CLI_BOUND}.jsonl").read_bytes(), source.read_bytes())
        record = json.loads((folder / "session.json").read_text())
        self.assertTrue(record["verified"])
        old = source.read_bytes()
        source.write_text("rewritten\n")
        self.write()
        record = json.loads((folder / "session.json").read_text())
        entry = next(e for e in record["sources"] if e["name"] == f"tools/claude-{CLI_BOUND}.jsonl")
        kept = folder / entry["previous"][0]["name"]
        self.assertEqual(kept.read_bytes(), old)
        self.assertEqual((folder / f"tools/claude-{CLI_BOUND}.jsonl").read_text(), "rewritten\n")
        self.assertEqual(self.verify(folder), 0)

    def test_a_tampered_copy_or_projection_fails_verify(self):
        self.write()
        folder = self.f.folder()
        copy = folder / f"tools/codex-{CODEX_CLAIMED}.jsonl"
        original = copy.read_bytes()
        copy.write_bytes(original + b"x")
        self.assertEqual(self.verify(folder), 1)
        copy.write_bytes(original)
        self.assertEqual(self.verify(folder), 0)
        with open(folder / "transcript.jsonl", "a") as handle:
            handle.write("{}\n")
        self.assertEqual(self.verify(folder), 1)

    def test_backfill_gives_unclaimed_tool_sessions_their_own_folders(self):
        dry = R.command_backfill(self.f.stores, dry=True)
        self.assertEqual(dry["sessions"], {"openclaw": 1, "claude": 1, "codex": 1, "cursor": 1})
        self.assertEqual(dry["openclawByAgent"], {"liv": 1, "max": 1})
        self.assertFalse((self.f.data / "evidence/sessions/2026").exists())
        report = R.command_backfill(self.f.stores)
        self.assertEqual(report["errors"], [])
        month = self.f.data / "evidence/sessions/2026/11"
        self.assertEqual(sorted(path.name for path in month.iterdir()),
                         sorted([R.folder_id(LOGICAL), f"claude-{CLI_DIRECT}", f"codex-{CODEX_DIRECT}", f"cursor-{CURSOR_DIRECT}"]))
        direct = json.loads((month / f"claude-{CLI_DIRECT}" / "session.json").read_text())
        self.assertEqual((direct["origin"], direct["agents"], direct["transcript"]["lines"]), ("claude", [], 2))
        self.assertTrue((month / f"claude-{CLI_DIRECT}" / "notes/-tmp-work/MEMORY.md").exists())
        codex = [json.loads(line) for line in (month / f"codex-{CODEX_DIRECT}" / "transcript.jsonl").read_text().splitlines()]
        self.assertEqual([line["role"] for line in codex], ["user", "assistant", "toolResult"])
        cursor = month / f"cursor-{CURSOR_DIRECT}"
        self.assertEqual(len((cursor / "transcript.jsonl").read_text().splitlines()), 2)
        self.assertTrue((cursor / f"tools/cursor-{CURSOR_DIRECT}/store.db").exists())
        before = tree(self.f.data)
        again = R.command_backfill(self.f.stores)
        self.assertEqual((again["bytes"], again["transcriptLines"]), (0, 0))
        self.assertEqual(tree(self.f.data), before)

    def test_stores_are_read_only_and_nothing_is_written_outside_the_data_root(self):
        stores = [self.f.state, self.f.claude, self.f.codex, self.f.cursor]
        modes = {}
        for root in stores:
            for path in [root, *root.rglob("*")]:
                modes[path] = path.stat().st_mode
                path.chmod(0o555 if path.is_dir() else 0o444)
        self.addCleanup(lambda: [path.chmod(stat.S_IMODE(mode)) for path, mode in sorted(modes.items(), key=lambda item: -len(item[0].parts))])
        outside = tree(self.f.root, skip=self.f.data)
        listing = sorted(str(path) for path in self.f.root.rglob("*") if self.f.data not in path.parents and path != self.f.data)
        report = R.command_backfill(self.f.stores)
        self.assertEqual(report["errors"], [])
        self.assertEqual(tree(self.f.root, skip=self.f.data), outside)
        self.assertEqual(sorted(str(path) for path in self.f.root.rglob("*") if self.f.data not in path.parents and path != self.f.data), listing)
        self.assertEqual(self.verify(self.f.folder()), 0)

    def test_folder_guard_refuses_paths_outside_the_sessions_root(self):
        with self.assertRaises(ValueError):
            R._guard(self.f.stores, self.f.root / "elsewhere" / "x")


if __name__ == "__main__":
    unittest.main()
