"""Model calls of one Claude Code session, read from the CLI's own log.

The log is `<root>/projects/<directory>/<session>.jsonl` plus the session's
`<session>/subagents/*.jsonl` files in the same directory. Only the fields a
price needs are read: call time, model and token counts. Message content is
never returned.
"""
from __future__ import annotations

from datetime import datetime
import json
from pathlib import Path
import re

SESSION_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
COUNTS = (("input", "input_tokens"), ("output", "output_tokens"),
          ("cacheRead", "cache_read_input_tokens"), ("cacheWrite", "cache_creation_input_tokens"))


def moment(value):
    """An ISO-8601 string with a UTC offset as an aware datetime, else None."""
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else None


def _count(value):
    return value if type(value) is int and value >= 0 else None


def _tokens(usage):
    """Token classes of one call, or None when a count or the cache write breakdown is not usable."""
    if not isinstance(usage, dict):
        return None
    tokens = {key: _count(usage.get(source)) for key, source in COUNTS}
    split = usage.get("cache_creation")
    short, long = (_count(split.get(key)) for key in ("ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens")) if isinstance(split, dict) else (None, None)
    if None in tokens.values() or None in (short, long) or short + long != tokens["cacheWrite"]:
        return None
    return dict(tokens, cacheWrite=short, cacheWrite1h=long)


def read_calls(claude_root, session_id):
    """The session's model calls as (time, model, tokens), in file order.

    A call streams over several lines sharing a message id; the last line holds its
    final usage. `<synthetic>` lines are not calls. `tokens` is None for a call whose
    counts are unusable, so the caller can leave the turn that contains it unpriced.
    A missing log or session id is no calls; unparseable lines are skipped.
    """
    if not claude_root or not isinstance(session_id, str) or not SESSION_ID.fullmatch(session_id):
        return []
    main = next(iter(sorted(Path(claude_root).glob(f"projects/*/{session_id}.jsonl"))), None)
    if main is None:
        return []
    calls = {}
    for path in [main, *sorted((main.parent / session_id / "subagents").glob("*.jsonl"))]:
        try:
            lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            continue
        for number, line in enumerate(lines):
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            message = row.get("message") if isinstance(row, dict) and row.get("type") == "assistant" else None
            when = moment(row.get("timestamp")) if message is not None else None
            if not isinstance(message, dict) or when is None or message.get("model") == "<synthetic>":
                continue
            ident = message.get("id") if isinstance(message.get("id"), str) and message["id"] else (str(path), number)  # No id: it cannot be matched, so it stands alone.
            model = message.get("model")
            usable = isinstance(model, str) and model and not isinstance(ident, tuple)
            calls[ident] = (when, model if isinstance(model, str) else "", _tokens(message.get("usage")) if usable else None)
    return list(calls.values())
