(async () => {
  const grid = document.querySelector('#artifact-projects');
  if (!grid) return;
  try {
    const response = await fetch('/artifacts/registry.json', {cache: 'no-store'});
    if (!response.ok) throw new Error(`registry returned ${response.status}`);
    const registry = await response.json();
    for (const project of registry.projects || []) {
      const card = document.createElement('a');
      card.className = 'card';
      card.href = `/artifacts/${project.id}/`;
      const type = document.createElement('span');
      type.className = 'type';
      type.textContent = 'Project';
      const title = document.createElement('h2');
      title.textContent = project.name;
      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = `${project.artifacts?.length || 0} artifacts`;
      card.append(type, title, count);
      grid.append(card);
    }
  } catch (error) {
    grid.textContent = `Artifact registry unavailable: ${error.message}`;
  }
})();
