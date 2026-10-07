// Scale each card's live preview to its frame.
(() => {
  const size = 1280;
  const resize = shot => {
    const frame = shot.querySelector('iframe');
    if (frame) frame.style.transform = `scale(${shot.clientWidth / size})`;
  };
  const observer = new ResizeObserver(entries => entries.forEach(entry => resize(entry.target)));
  document.querySelectorAll('.shot').forEach(shot => {
    resize(shot);
    observer.observe(shot);
  });
})();
