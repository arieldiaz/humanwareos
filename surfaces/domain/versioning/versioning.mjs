// Unstyled version footer, history, and diff markup. Contract: docs/versioning.md.
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

function find(item, versionId) {
  const index = item.versions.findIndex((v) => v.id === versionId);
  if (index < 0) throw new Error(`unknown version: ${item.id}/${versionId}`);
  return index;
}

const label = (name, version) => `<span><b class="foot-label">${name}:</b> ${time(version)}</span>`;

export function renderVersionFooter(item, versionId) {
  const index = find(item, versionId);
  const version = item.versions[index];
  const current = version.id === item.current_version;
  const meta = [
    label('Created at', item.versions[0]),
    label('Updated', version),
    `<span>Version ${index + 1} of ${item.versions.length}</span>`,
    `<a data-footer-history href="${esc(item.url)}versions/">History →</a>`,
  ];
  if (!current) meta.push(`<a href="${esc(item.url)}">Current version</a>`);
  return `<div class="foot-provenance hw-version-footer" data-hw-item="${esc(item.id)}" data-hw-version="${esc(version.id)}" data-hw-current="${current}">\n`
    + `<span class="foot-heading"><span data-footer-title>${esc(version.title)}</span> <span data-footer-url>${esc(version.url || item.url)}</span></span>\n`
    + `<span class="foot-meta">${meta.join(' ')}</span>\n</div>\n`;
}

export function renderVersionHistory(item) {
  const count = item.versions.length;
  const rows = item.versions.map((version, index) => {
    const current = version.id === item.current_version ? ' aria-current="true"' : '';
    const note = version.note ? `<p>${esc(version.note)}</p>` : '';
    const actions = [
      version.url ? `<a href="${esc(version.url)}">View</a>` : '',
      version.diff_url ? `<a href="${esc(version.diff_url)}">Diff from ${esc(item.versions[index - 1].number)}</a>` : '',
    ].filter(Boolean).join(' ');
    return `<li class="version" data-hw-version="${esc(version.id)}"${current}>`
      + `<aside class="version-node"><span>${esc(version.number)}</span> ${time(version)}</aside> `
      + `<section><header class="version-header"><h2>${esc(version.title)}</h2>${note}</header>`
      + (actions ? `<p class="actions">${actions}</p>` : '')
      + '</section></li>\n';
  }).reverse();
  return `<section class="history-page hw-version-history" data-hw-item="${esc(item.id)}">\n`
    + '<h1 class="page-title">Version history</h1>\n'
    + `<p class="intro"><a href="${esc(item.url)}">${esc(item.title)}</a> · ${count} ${count === 1 ? 'version' : 'versions'}`
    + ` · Created ${time(item.versions[0])} · Updated ${time(item.versions[count - 1])}</p>\n`
    + `<ol class="timeline" reversed>\n${rows.join('')}</ol>\n</section>\n`;
}

function lineClass(line) {
  if (line.startsWith('+++') || line.startsWith('---')) return 'file';
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+')) return 'addition';
  if (line.startsWith('-')) return 'deletion';
  if (line.startsWith(' ') || line === '') return 'context';
  return 'meta';
}

export function renderVersionDiff(item, versionId, diff) {
  const index = find(item, versionId);
  if (index === 0) throw new Error(`first version has no predecessor: ${item.id}/${versionId}`);
  const version = item.versions[index];
  const previous = item.versions[index - 1];
  const lines = diff.replace(/\n$/, '').split('\n');
  const classes = lines.map(lineClass);
  const added = classes.filter((c) => c === 'addition').length;
  const removed = classes.filter((c) => c === 'deletion').length;
  const code = lines.map((line, i) => `<code class="${classes[i]}">${esc(line)}</code>`).join('\n');
  return `<section class="hw-version-diff" data-hw-item="${esc(item.id)}" data-hw-version="${esc(version.id)}">\n`
    + `<h1 class="page-title">${esc(version.title)}: ${link(previous.url, esc(previous.number))} → ${link(version.url, esc(version.number))}</h1>\n`
    + `<p class="stats"><b>+${added}</b> <i>−${removed}</i> · <a href="${esc(item.url)}versions/">History</a></p>\n`
    + `<pre tabindex="0">\n${code}\n</pre>\n</section>\n`;
}
