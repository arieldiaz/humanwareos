"""Unstyled version footer, history, and diff markup. Contract: docs/versioning.md.

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


def _find(item: dict, version_id: str) -> int:
    ids = [v["id"] for v in item["versions"]]
    if version_id not in ids:
        raise ValueError(f"unknown version: {item['id']}/{version_id}")
    return ids.index(version_id)


def _label(name: str, version: dict) -> str:
    return f'<span><b class="foot-label">{name}:</b> {_time(version)}</span>'


def render_version_footer(item: dict, version_id: str) -> str:
    index = _find(item, version_id)
    version = item["versions"][index]
    current = version["id"] == item["current_version"]
    meta = [
        _label("Created at", item["versions"][0]),
        _label("Updated", version),
        f'<span>Version {index + 1} of {len(item["versions"])}</span>',
        f'<a data-footer-history href="{_esc(item["url"])}versions/">History →</a>',
    ]
    if not current:
        meta.append(f'<a href="{_esc(item["url"])}">Current version</a>')
    return (f'<div class="foot-provenance hw-version-footer" data-hw-item="{_esc(item["id"])}" '
            f'data-hw-version="{_esc(version["id"])}" data-hw-current="{"true" if current else "false"}">\n'
            f'<span class="foot-heading"><span data-footer-title>{_esc(version["title"])}</span> '
            f'<span data-footer-url>{_esc(version.get("url") or item["url"])}</span></span>\n'
            f'<span class="foot-meta">{" ".join(meta)}</span>\n</div>\n')


def render_version_history(item: dict) -> str:
    versions = item["versions"]
    count = len(versions)
    rows = []
    for index, version in enumerate(versions):
        current = ' aria-current="true"' if version["id"] == item["current_version"] else ""
        note = f'<p>{_esc(version["note"])}</p>' if version.get("note") else ""
        actions = " ".join(filter(None, [
            f'<a href="{_esc(version["url"])}">View</a>' if version.get("url") else "",
            f'<a href="{_esc(version["diff_url"])}">Diff from {_esc(versions[index - 1]["number"])}</a>'
            if version.get("diff_url") else "",
        ]))
        rows.append(f'<li class="version" data-hw-version="{_esc(version["id"])}"{current}>'
                    f'<aside class="version-node"><span>{_esc(version["number"])}</span> {_time(version)}</aside> '
                    f'<section><header class="version-header"><h2>{_esc(version["title"])}</h2>{note}</header>'
                    + (f'<p class="actions">{actions}</p>' if actions else "")
                    + '</section></li>\n')
    rows.reverse()
    noun = "version" if count == 1 else "versions"
    return (f'<section class="history-page hw-version-history" data-hw-item="{_esc(item["id"])}">\n'
            '<h1 class="page-title">Version history</h1>\n'
            f'<p class="intro"><a href="{_esc(item["url"])}">{_esc(item["title"])}</a> · {count} {noun}'
            f' · Created {_time(versions[0])} · Updated {_time(versions[-1])}</p>\n'
            f'<ol class="timeline" reversed>\n{"".join(rows)}</ol>\n</section>\n')


def _line_class(line: str) -> str:
    if line.startswith(("+++", "---")):
        return "file"
    if line.startswith("@@"):
        return "hunk"
    if line.startswith("+"):
        return "addition"
    if line.startswith("-"):
        return "deletion"
    if line.startswith(" ") or line == "":
        return "context"
    return "meta"


def render_version_diff(item: dict, version_id: str, diff: str) -> str:
    index = _find(item, version_id)
    if index == 0:
        raise ValueError(f"first version has no predecessor: {item['id']}/{version_id}")
    version = item["versions"][index]
    previous = item["versions"][index - 1]
    lines = diff[:-1].split("\n") if diff.endswith("\n") else diff.split("\n")
    classes = [_line_class(line) for line in lines]
    code = "\n".join(f'<code class="{c}">{_esc(line)}</code>' for c, line in zip(classes, lines))
    return (f'<section class="hw-version-diff" data-hw-item="{_esc(item["id"])}" data-hw-version="{_esc(version["id"])}">\n'
            f'<h1 class="page-title">{_esc(version["title"])}: {_link(previous.get("url"), _esc(previous["number"]))}'
            f' → {_link(version.get("url"), _esc(version["number"]))}</h1>\n'
            f'<p class="stats"><b>+{classes.count("addition")}</b> <i>−{classes.count("deletion")}</i>'
            f' · <a href="{_esc(item["url"])}versions/">History</a></p>\n'
            f'<pre tabindex="0">\n{code}\n</pre>\n</section>\n')


if __name__ == "__main__":
    import json
    import sys

    data = json.load(sys.stdin)
    if sys.argv[1] == "history":
        out = render_version_history(data)
    elif sys.argv[1] == "diff":
        out = render_version_diff(data, sys.argv[2], open(sys.argv[3]).read())
    else:
        out = render_version_footer(data, sys.argv[2])
    sys.stdout.write(out)
