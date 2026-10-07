import {renderVersionFooter} from '/versioning/versioning.mjs';

// The one OS footer. Its provenance block is the framework versioning renderer's
// (docs/versioning.md): pass a pre-rendered block, or page facts to render one.
export function mountOSFooter({title, url = location.href, created, updated, historyUrl, provenance} = {}) {
  if (document.querySelector('body > .os-shell-footer')) return;
  const fallback = new Intl.DateTimeFormat('en-US', {month: 'short', day: 'numeric', year: 'numeric'}).format(new Date(document.lastModified));
  const date = (value) => ({date_label: value || fallback});
  const footer = document.createElement('footer');
  footer.className = 'os-shell-footer';
  footer.innerHTML = provenance || renderVersionFooter({
    id: 'page', title: title || document.title.split('·')[0].split('—')[0].trim(), url, history_url: historyUrl || '#',
    created: date(created), updated: date(updated || created), current_version: 'page-current',
    versions: [{id: 'page-current', number: 1, title: 'current', date_label: fallback}],
  }, 'page-current');
  if (!provenance && !historyUrl) footer.querySelector('[data-footer-history]').remove();
  document.body.append(footer);
}
