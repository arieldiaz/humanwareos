"""Unstyled version footer and history markup. Contract: docs/versioning.md.

Must stay byte-identical with versioning.mjs; see fixtures/.
"""
from html import escape as _escape


def _esc(value) -> str:
    return _escape(str(value), quote=True)


def _time(version: dict) -> str:
    attr = f' datetime="{_esc(version["date"])}"' if version.get("date") else ""
    return f'<time{attr}>{_esc(version["date_label"])}</time>'


def _link(href, text: str) -> str:
    return f'<a href="{_esc(href)}">{text}</a>' if href else text


def render_version_footer(item: dict, version_id: str) -> str:
    ids = [v["id"] for v in item["versions"]]
    if version_id not in ids:
        raise ValueError(f"unknown version: {item['id']}/{version_id}")
    index = ids.index(version_id)
    version = item["versions"][index]
    current = version["id"] == item["current_version"]
    parts = [
        f"Version {index + 1} of {len(ids)}",
        _time(version),
        f'<a href="{_esc(item["url"])}versions/">Version history</a>',
    ]
    if not current:
        parts.append(f'<a href="{_esc(item["url"])}">Current version</a>')
    return (f'<footer class="hw-version-footer" data-hw-item="{_esc(item["id"])}" '
            f'data-hw-version="{_esc(version["id"])}" data-hw-current="{"true" if current else "false"}">\n'
            f'<p>{" · ".join(parts)}</p>\n</footer>\n')


def render_version_history(item: dict) -> str:
    rows = []
    for version in reversed(item["versions"]):
        current = ' aria-current="true"' if version["id"] == item["current_version"] else ""
        note = f' — {_esc(version["note"])}' if version.get("note") else ""
        rows.append(f'<li data-hw-version="{_esc(version["id"])}"{current}>'
                    f'{_link(version.get("url"), _esc(version["number"]))} {_time(version)} '
                    f'{_esc(version["title"])}{note}</li>\n')
    return (f'<section class="hw-version-history" data-hw-item="{_esc(item["id"])}">\n'
            f'<h2>Version history: <a href="{_esc(item["url"])}">{_esc(item["title"])}</a></h2>\n'
            f'<ol reversed>\n{"".join(rows)}</ol>\n</section>\n')


if __name__ == "__main__":
    import json
    import sys

    data = json.load(sys.stdin)
    out = render_version_history(data) if sys.argv[1] == "history" else render_version_footer(data, sys.argv[2])
    sys.stdout.write(out)
