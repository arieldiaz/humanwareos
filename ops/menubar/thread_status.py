"""Project explicit lifecycle state into the Humanware OS thread menu."""

from __future__ import annotations

import urllib.parse


STATUS_LABELS = {"answer": "Clarify", "act": "Act", "working": "Working", "scheduled": "Scheduled"}


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
