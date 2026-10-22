(async () => {
  const grid = document.querySelector('#artifact-projects');
  if (!grid) return;
  const filter = document.querySelector('#artifact-filter');
  const summary = document.querySelector('#artifact-count');
  // Opening a project clears its New tag in this browser only.
  const SEEN_KEY = 'humanware:artifacts:seen';
  const readSeen = () => { try { return JSON.parse(localStorage.getItem(SEEN_KEY) || '{}'); } catch { return {}; } };
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const latestDate = (project) => (project.artifacts || []).flatMap((artifact) => artifact.versions || []).map((version) => version.date || '').sort().pop() || '';
  const hue = (text) => [...text].reduce((sum, character) => (sum * 31 + character.charCodeAt(0)) % 360, 7);

  // Optional instance map of project id to icon path; projects without one get a monogram.
  const fetchJson = (path) => fetch(path, {cache: 'no-store'}).then((response) => {
    if (!response.ok) throw new Error(`${path} returned ${response.status}`);
    return response.json();
  });
  let projects;
  let icons = {};
  try {
    [projects, icons] = await Promise.all([
      fetchJson('/artifacts/registry.json').then((registry) => registry.projects || []),
      fetchJson('/artifacts/icons.json').catch(() => ({}))
    ]);
  } catch (error) {
    grid.textContent = `Artifact registry unavailable: ${error.message}`;
    return;
  }
  projects = projects
    .map((project) => ({...project, latest: latestDate(project)}))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, {sensitivity: 'base'}));

  const card = (project, seen) => {
    const link = document.createElement('a');
    link.className = 'card project-card';
    link.href = `/artifacts/${project.id}/`;
    link.addEventListener('click', () => {
      localStorage.setItem(SEEN_KEY, JSON.stringify({...readSeen(), [project.id]: project.latest}));
    });
    const icon = document.createElement('span');
    icon.className = 'project-icon';
    if (icons[project.id]) {
      const image = document.createElement('img');
      image.src = icons[project.id];
      image.alt = '';
      icon.append(image);
    } else {
      icon.style.setProperty('--hue', hue(project.id));
      icon.textContent = [...project.name][0]?.toUpperCase() || '?';
    }
    const body = document.createElement('span');
    body.className = 'body';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = project.name;
    const count = document.createElement('span');
    count.className = 'count';
    const total = project.artifacts?.length || 0;
    count.textContent = `${total} artifact${total === 1 ? '' : 's'}${project.latest === today ? ' · today' : ''}`;
    body.append(name, count);
    link.append(icon, body);
    if (project.latest === today && seen[project.id] !== project.latest) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = 'New';
      link.append(tag);
    }
    return link;
  };

  const render = () => {
    const seen = readSeen();
    const query = (filter?.value || '').trim().toLowerCase();
    const visible = projects.filter((project) => project.name.toLowerCase().includes(query));
    grid.replaceChildren(...visible.map((project) => card(project, seen)));
    if (summary) {
      const fresh = projects.filter((project) => project.latest === today && seen[project.id] !== project.latest).length;
      const artifacts = projects.reduce((sum, project) => sum + (project.artifacts?.length || 0), 0);
      summary.textContent = `${projects.length} projects · ${artifacts} artifacts${fresh ? ` · ${fresh} new` : ''}`;
    }
  };
  filter?.addEventListener('input', render);
  // Back/forward restores this page from cache; re-render so opened projects lose their tag.
  window.addEventListener('pageshow', (event) => { if (event.persisted) render(); });
  render();
})();
