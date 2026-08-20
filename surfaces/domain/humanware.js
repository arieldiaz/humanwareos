(() => {
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"]/g, (character) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[character]));
  fetch('/surface.json', {cache: 'no-store'})
    .then((response) => {
      if (!response.ok) throw new Error(`surface manifest ${response.status}`);
      return response.json();
    })
    .then((surface) => {
      document.title = `${surface.id || 'System'} · Humanware OS`;
      document.getElementById('origin').textContent = surface.privateOrigin || surface.publicOrigin || 'Configured domain surface';
      document.getElementById('modules').innerHTML = (surface.routes || []).map((route) => `<a class="card" href="${escapeHtml(route.mount)}"><div class="title">${escapeHtml(route.label || route.id)}</div><div class="meta">${escapeHtml(route.visibility)} · ${escapeHtml(route.source)}</div></a>`).join('');
    })
    .catch((error) => {
      document.getElementById('origin').textContent = `Surface unavailable: ${error.message}`;
    });
})();
