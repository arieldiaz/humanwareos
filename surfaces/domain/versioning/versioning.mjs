// Unstyled version footer and history markup. Contract: docs/versioning.md.
// Must stay byte-identical with versioning.py; see fixtures/.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' };
const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]);

function time(version) {
  const attr = version.date ? ` datetime="${esc(version.date)}"` : '';
  return `<time${attr}>${esc(version.date_label)}</time>`;
}

function link(href, text) {
  return href ? `<a href="${esc(href)}">${text}</a>` : text;
}

export function renderVersionFooter(item, versionId) {
  const index = item.versions.findIndex((v) => v.id === versionId);
  if (index < 0) throw new Error(`unknown version: ${item.id}/${versionId}`);
  const version = item.versions[index];
  const current = version.id === item.current_version;
  const parts = [
    `Version ${index + 1} of ${item.versions.length}`,
    time(version),
    `<a href="${esc(item.url)}versions/">Version history</a>`,
  ];
  if (!current) parts.push(`<a href="${esc(item.url)}">Current version</a>`);
  return `<footer class="hw-version-footer" data-hw-item="${esc(item.id)}" data-hw-version="${esc(version.id)}" data-hw-current="${current}">\n`
    + `<p>${parts.join(' · ')}</p>\n</footer>\n`;
}

export function renderVersionHistory(item) {
  const rows = [...item.versions].reverse().map((version) => {
    const current = version.id === item.current_version ? ' aria-current="true"' : '';
    const note = version.note ? ` — ${esc(version.note)}` : '';
    return `<li data-hw-version="${esc(version.id)}"${current}>${link(version.url, esc(version.number))} ${time(version)} ${esc(version.title)}${note}</li>\n`;
  });
  return `<section class="hw-version-history" data-hw-item="${esc(item.id)}">\n`
    + `<h2>Version history: <a href="${esc(item.url)}">${esc(item.title)}</a></h2>\n`
    + `<ol reversed>\n${rows.join('')}</ol>\n</section>\n`;
}
