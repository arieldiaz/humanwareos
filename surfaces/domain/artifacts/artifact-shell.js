// The artifact page frame: the generated breadcrumb, versions link, publish action, and footer. Contract: docs/versioning.md.
(async () => {
  const match = location.pathname.match(/^\/artifacts\/([^/]+)\/(\d+)\/(?:versions\/(\d+)\/)?$/);
  if (!match) return;
  const [, project, number, version] = match;
  const live = !version;
  const metadata = name => document.querySelector(`meta[name="${name}"]`)?.content?.trim();
  const artifactTitle = metadata('artifact-title') || document.title;
  const signature = [
    ['Creator', metadata('artifact-creator')],
    ['Model', metadata('artifact-model')],
    ['Harness', metadata('artifact-harness')],
    ['Thinking', metadata('artifact-thinking')],
  ].filter(([, value]) => value);
  if (!signature.length && metadata('artifact-runtime')) signature.push(['Runtime', metadata('artifact-runtime')]);
  [...document.querySelectorAll('.frame, .artifact-frame')].forEach((frame, index) => {
    const caption = frame.querySelector('.caption b, .artifact-frame-caption');
    if (!caption) return;
    caption.textContent = caption.textContent.replace(/^\d+\.\d+[A-Z]?\s*[·—-]\s*/, '');
    caption.prepend(`${number}.${index + 1} · `);
    frame.querySelectorAll('.label').forEach(label => {
      label.textContent = label.textContent.replace(/^\d+\.\d+[A-Z]?\s*[·—-]\s*/, '');
    });
  });
  const json = url => fetch(url, {cache: 'no-store'}).then(response => response.json()).catch(() => ({}));
  const crumbs = fetch(`${location.pathname.replace(/\/$/, '')}.crumbs.html`, {cache: 'no-store'})
    .then(response => response.ok ? response.text() : '')
    .catch(() => '');
  const [registry, site, trail] = await Promise.all([json('/artifacts/registry.json'), json('/artifacts/site.json'), crumbs]);
  const entry = registry.projects?.find(candidate => candidate.id === project || candidate.aliases?.includes(project));
  const versionCount = entry?.artifacts?.find(candidate => candidate.number === Number(number))?.versions?.length || 1;
  const base = `/artifacts/${project}/${number}/`;
  for (const href of ['/os-header.css', '/os-footer.css']) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    document.head.append(link);
  }
  const style = document.createElement('style');
  style.textContent = `body{padding-top:52px!important}`;
  document.head.append(style);
  const bar = document.createElement('header');
  bar.className = 'os-shell-header artifact-registry-bar';
  const currentLabel = `${number} · ${artifactTitle}`;
  const actions = (versionCount > 1 && live ? `<a class="os-header-public-link artifact-versions-link" href="${base}versions/">${versionCount} versions</a>` : '')
    + (live ? '<button class="os-header-action" type="button">Publish to www</button>' : '');
  bar.innerHTML = `${trail}<span class="artifact-actions">${actions}</span>`;
  document.body.prepend(bar);
  [...document.querySelectorAll('body > nav, body > header')].forEach(candidate => {
    if (candidate === bar) return;
    const text = candidate.textContent || '';
    if ((site.name && text.includes(site.name)) || /Design Artifacts|Design HQ/i.test(text)) candidate.style.display = 'none';
  });
  import('/os-footer.js').then(async ({mountOSFooter}) => {
    const provenance = await fetch(`${location.pathname.replace(/\/$/, '')}.footer.html`, {cache: 'no-store'})
      .then(response => response.ok ? response.text() : null)
      .catch(() => null);
    await mountOSFooter({
      title: currentLabel,
      created: metadata('artifact-created'),
      updated: metadata('artifact-updated'),
      historyUrl: false,
      provenance,
    });
    if (!signature.length) return;
    const footer = document.querySelector('body > .os-shell-footer');
    const dated = footer?.querySelector('.foot-meta');
    if (!dated) return;
    const line = document.createElement('span');
    line.className = 'foot-meta artifact-runtime-signature';
    signature.forEach(([label, value]) => {
      const item = document.createElement('span');
      const key = document.createElement('b');
      key.className = 'foot-label';
      key.textContent = `${label}:`;
      item.append(key, ` ${value}`);
      line.append(item);
    });
    dated.after(line);
  });
  const button = bar.querySelector('button');
  if (!button) return;
  import('/os-footer.js').then(async ({mountOSFooter}) => {
    const provenance = await fetch(`/artifacts/${project}/${artifact}.footer.html`, {cache: 'no-store'})
      .then(response => response.ok ? response.text() : null)
      .catch(() => null);
    await mountOSFooter({
      title: currentLabel,
      created: metadata('artifact-created'),
      updated: metadata('artifact-updated'),
      historyUrl: false,
      provenance,
    });
    if (!signature.length) return;
    const footer = document.querySelector('body > .os-shell-footer');
    const dated = footer?.querySelector('.foot-meta');
    if (!dated) return;
    const line = document.createElement('span');
    line.className = 'foot-meta artifact-runtime-signature';
    signature.forEach(([label, value]) => {
      const item = document.createElement('span');
      const key = document.createElement('b');
      key.className = 'foot-label';
      key.textContent = `${label}:`;
      item.append(key, ` ${value}`);
      line.append(item);
    });
    dated.after(line);
  });
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  button.addEventListener('click', async () => {
    if (!confirm('Publish this artifact\'s current version to the public site?')) return;
    button.disabled = true;
    button.textContent = 'Preflighting…';
    try {
      const response = await fetch('/artifact-publisher/publish', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({project, artifact: Number(number)})
      });
      const responseText = await response.text();
      let result;
      try {
        result = JSON.parse(responseText);
      } catch {
        throw new Error(response.ok ? 'Publisher returned an invalid response' : `Publisher unavailable (${response.status})`);
      }
      if (!response.ok) throw new Error(result.error || 'Publish failed');
      let status = result;
      while (status.state !== 'deployed') {
        if (status.state === 'error') throw new Error(status.error || 'Publish failed');
        button.textContent = status.label || 'Publishing…';
        await wait(2000);
        const poll = await fetch(`/artifact-publisher/status?id=${encodeURIComponent(result.id)}`, {cache: 'no-store'});
        status = await poll.json();
        if (!poll.ok) throw new Error(status.error || 'Status check failed');
      }
      const link = document.createElement('a');
      link.className = 'os-header-public-link';
      link.href = status.url;
      link.textContent = 'View on www ↗';
      button.replaceWith(link);
    } catch (error) {
      button.disabled = false;
      button.textContent = 'Publish to www';
      alert(error.message);
    }
  });
})();
