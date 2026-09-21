"""Project explicit lifecycle state into the Humanware OS thread menu."""

from __future__ import annotations

import urllib.parse


STATUS_LABELS = {"act": "On you", "working": "On agent", "scheduled": "Scheduled"}
REACTION_STATUSES = {
    "raised_hand": "act",
    "arrows_counterclockwise": "working",
    "calendar": "scheduled",
    "white_check_mark": "done",
}


def root_status(reactions: list[dict], owner_user_id: str | None = None) -> str | None:
    """Project the adapter-owned root tile, with the human owner's tile winning."""
    observed = []
    owner = []
    for reaction in reactions or []:
        status = REACTION_STATUSES.get(reaction.get("name"))
        if not status:
            continue
        observed.append(status)
        if owner_user_id and owner_user_id in (reaction.get("users") or []):
            owner.append(status)
    selected = owner or observed
    distinct = list(dict.fromkeys(selected))
    return distinct[0] if len(distinct) == 1 else None


def snapshot_from_slack_roots(roots: dict, audited_at: str | None = None, owner_user_id: str | None = None) -> dict:
    """Build the menu from the root tiles that render canonical lifecycle state."""
    threads = []
    for root in roots.values():
        status = root_status(root.get("reactions") or [], owner_user_id)
        if status not in STATUS_LABELS:
            continue
        threads.append({**root, "status": status})
    return {"audited_at": audited_at, "source": "slack-root-status", "threads": threads}


def session_status(session: dict) -> str | None:
    if not session.get("channelId") or not session.get("threadId"):
        return None
    workflow = session.get("workflow") or {}
    outbound = workflow.get("outbound") or session.get("outboundStatus")
    return outbound if outbound in STATUS_LABELS else None


def snapshot_from_sessions(data: dict) -> dict:
    threads = []
    for session in data.get("sessions") or []:
        status = session_status(session)
        if status:
            threads.append({
                "status": status,
                "root_text": session.get("title") or "Untitled thread",
                "channel_name": session.get("channel") or session.get("channelId") or "unknown",
                "channel_id": session.get("channelId"),
                "thread_ts": session.get("threadId"),
                "thread_url": session.get("slackUrl"),
                "last_activity_at": session.get("updatedAt"),
            })
    return {"audited_at": data.get("generatedAt"), "source": "session-ledger", "threads": threads}


def render_groups(snapshot: dict, team_id: str) -> dict:
    groups = {key: [] for key in STATUS_LABELS}
    for thread in snapshot.get("threads") or []:
        status = thread.get("status")
        if status not in groups:
            continue
        groups[status].append({
            "channel": thread.get("channel_name") or "unknown",
            "title": " ".join((thread.get("root_text") or "Untitled thread").split()),
            "url": thread.get("thread_url"),
            "appUrl": "slack://channel?" + urllib.parse.urlencode({
                "team": team_id,
                "id": thread.get("channel_id") or "",
                "message": thread.get("thread_ts") or "",
            }),
            "lastActivityAt": thread.get("last_activity_at"),
        })
    rendered = []
    for status, label in STATUS_LABELS.items():
        items = sorted(groups[status], key=lambda item: item.get("lastActivityAt") or "", reverse=True)
        if items:
            rendered.append({"status": status, "label": label, "threads": items})
    return {"ok": True, "sampledAt": snapshot.get("audited_at"), "groups": rendered}
