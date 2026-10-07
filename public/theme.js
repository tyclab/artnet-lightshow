// Apply the stored theme before first paint.
(() => {
  let theme = null;
  try { theme = localStorage.getItem('lightshow.theme'); } catch { /* private mode */ }
  if (theme === 'dark' || theme === 'light' || theme === 'red') document.documentElement.setAttribute('data-theme', theme);
})();
