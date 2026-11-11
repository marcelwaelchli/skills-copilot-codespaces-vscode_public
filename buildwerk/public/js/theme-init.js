// Runs before first paint so the page never flashes in the wrong theme.
(function () {
  var stored = null;
  try {
    stored = localStorage.getItem('bw:theme');
  } catch (error) {
    // storage unavailable: fall back to the system preference
  }
  var dark = stored ? stored === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
})();
