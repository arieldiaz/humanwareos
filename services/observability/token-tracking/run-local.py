#!/usr/bin/env python3
"""Run a prompt through a local ollama model and METER it into the dashboard.

codexbar only meters Claude + Codex, so local (ollama) usage is invisible to the
cost feed. This runs a generation against the local ollama server, captures the
real token counts it reports (prompt_eval_count + eval_count), and appends them
to $HUMANWARE_DATA_ROOT/generated/reports/stats/local-usage.jsonl — which build-dashboard.py folds into the "Local"
column. Use it to smoke-test that local usage shows up in stats, and as the
metering path for real local work.

Usage: run-local.py [--model llama3.3:70b] "your prompt here"
"""

import json
import os
import sys
import urllib.request
from datetime import datetime, timezone

OLLAMA = "http://localhost:11434/api/generate"
# Same file build-dashboard.py reads (LOCAL_USAGE).
LOG = os.path.join(os.environ.get("HUMANWARE_DATA_ROOT", ""),
                   "generated", "reports", "stats", "local-usage.jsonl")


def main():
    if not os.environ.get("HUMANWARE_DATA_ROOT"):
        raise SystemExit("HUMANWARE_DATA_ROOT is required")
    args = sys.argv[1:]
    model = "llama3.3:70b"
    if args and args[0] == "--model":
        model = args[1]
        args = args[2:]
    prompt = " ".join(args) or "In one sentence, what is a token in an LLM?"

    req = urllib.request.Request(
        OLLAMA,
        data=json.dumps({"model": model, "prompt": prompt, "stream": False}).encode(),
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=300) as resp:
        r = json.load(resp)

    prompt_tok = r.get("prompt_eval_count", 0)
    out_tok = r.get("eval_count", 0)
    now = datetime.now(timezone.utc)
    rec = {
        "ts": now.isoformat(),
        "date": now.astimezone().strftime("%Y-%m-%d"),
        "model": model,
        "promptTokens": prompt_tok,
        "outputTokens": out_tok,
        "totalTokens": prompt_tok + out_tok,
        "prompt": prompt[:120],
    }
    os.makedirs(os.path.dirname(LOG), exist_ok=True)
    with open(LOG, "a") as f:
        f.write(json.dumps(rec) + "\n")

    print(f"model={model} prompt={prompt_tok} output={out_tok} total={rec['totalTokens']}")
    print(f"response: {r.get('response','').strip()[:200]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
