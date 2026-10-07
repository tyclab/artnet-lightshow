// Inject into the page context to read dzPlayer; relay snapshots through the background page.
(function () {
  'use strict';

  const el = document.createElement('script');
  el.src = browser.runtime.getURL('inject.js');
  el.onload = () => el.remove();
  (document.head || document.documentElement).appendChild(el);

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__lsBridge !== 'deezer') return;
    browser.runtime.sendMessage(e.data.payload).catch(() => {});
  });

  // Drop Deezer as a source when the tab is closed or navigated away.
  window.addEventListener('pagehide', () => {
    browser.runtime.sendMessage({ __disconnect: true }).catch(() => {});
  });
})();
