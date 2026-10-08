// MV3 requires a synchronous listener and a returned fetch promise to keep the event page alive.
// Background fetches avoid page CORS restrictions.
'use strict';

const DEFAULT_SERVER = 'http://localhost:3000';

// Read settings per message because event pages can unload between messages.
async function settings() {
  const { server, token } = await browser.storage.local.get(['server', 'token']);
  return {
    server: (server || DEFAULT_SERVER).replace(/\/+$/, ''),
    token: token || '',
  };
}

async function post(msg) {
  const { server, token } = await settings();
  const url = msg.__disconnect ? `${server}/api/deezer/disconnect` : `${server}/api/deezer/state`;
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-Lightshow-Token'] = token;

  try {
    await fetch(url, {
      method: 'POST',
      headers,
      body: msg.__disconnect ? undefined : JSON.stringify(msg),
    });
  } catch (_) {
    // Server not running, wrong port, or wrong token — nothing useful to do
    // from here, and throwing would only produce console noise once a second.
  }
}

browser.runtime.onMessage.addListener((msg) => {
  if (!msg) return undefined;
  return post(msg);
});
