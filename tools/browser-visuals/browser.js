import fs from 'node:fs/promises';
import path from 'node:path';

export function matchesTarget(actual, expected) {
  try {
    const a = new URL(actual), b = new URL(expected);
    const ar = new URL(a.hash.slice(1), 'http://route.invalid'), br = new URL(b.hash.slice(1), 'http://route.invalid');
    return !a.username && !a.password && a.origin === b.origin && a.pathname === b.pathname && !a.search && ar.pathname === '/now-playing' && ar.pathname === br.pathname && ar.searchParams.get('player') === br.searchParams.get('player') && ar.searchParams.get('frameless') === br.searchParams.get('frameless') && [...ar.searchParams.keys()].every(key => ['player', 'frameless'].includes(key));
  } catch { return false; }
}

export async function discoverPage(profile, expected, { readFile = fs.readFile, fetcher = fetch } = {}) {
  const lines = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/);
  const port = Number(lines[0]), browserPath = lines[1];
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(browserPath)) throw new Error('Invalid dedicated browser endpoint');
  const base = `http://127.0.0.1:${port}`;
  const read = async route => {
    const response = await fetcher(base + route, { redirect: 'error', signal: AbortSignal.timeout(1000) });
    if (!response.ok) throw new Error('Dedicated browser unavailable');
    const text = await response.text();
    if (text.length > 1_048_576) throw new Error('Invalid browser response');
    return JSON.parse(text);
  };
  const version = await read('/json/version');
  const verified = endpoint(version.webSocketDebuggerUrl, port);
  if (verified.pathname !== browserPath) throw new Error('Browser profile endpoint changed');
  const targets = await read('/json/list');
  if (!Array.isArray(targets)) throw new Error('Invalid browser target list');
  const matching = targets.filter(target => target.type === 'page' && matchesTarget(target.url, expected));
  if (matching.length !== 1) throw new Error('Waiting for one matching Music Assistant page');
  const target = endpoint(matching[0].webSocketDebuggerUrl, port);
  if (!/^\/devtools\/page\/[a-zA-Z0-9-]+$/.test(target.pathname)) throw new Error('Invalid page endpoint');
  target.hostname = '127.0.0.1';
  return target.href;
}

function endpoint(value, port) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid browser endpoint'); }
  if (url.protocol !== 'ws:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || Number(url.port) !== port || url.username || url.password || url.search || url.hash) throw new Error('Browser endpoint must remain on its dedicated loopback port');
  return url;
}

export async function connectPage(profile, expected, onClose = () => {}, discover = discoverPage) {
  const ws = new globalThis.WebSocket(await discover(profile, expected));
  const pending = new Map();
  let sequence = 0, ready = false;
  ws.addEventListener('message', ({ data }) => {
    let message;
    try { message = JSON.parse(data); } catch { ws.close(); return; }
    const p = pending.get(message.id);
    if (p) {
      pending.delete(message.id);
      if (message.error) p.reject(new Error('Browser request rejected')); else p.resolve(message.result);
    }
    if (message.method === 'Page.frameNavigated' && !message.params?.frame?.parentId) onClose();
  });
  ws.addEventListener('close', () => {
    ready = false;
    for (const p of pending.values()) p.reject(new Error('Browser disconnected'));
    pending.clear(); onClose();
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error('Browser connection timed out')); ws.close(); }, 1500);
    const fail = () => { clearTimeout(timer); reject(new Error('Browser connection unavailable')); };
    ws.addEventListener('open', () => { clearTimeout(timer); ready = true; resolve(); }, { once: true });
    ws.addEventListener('error', fail); ws.addEventListener('close', fail, { once: true });
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    if (!ready || ws.readyState !== 1) { reject(new Error('Browser disconnected')); return; }
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Browser request timed out')); }, 1000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const action = async options => {
    const expression = `(${pageAction.toString()})(${JSON.stringify({ ...options, expected })}, ${matchesTarget.toString()})`;
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, timeout: 750 });
    if (result?.exceptionDetails || !result?.result?.value) throw new Error('Music Assistant canvas unavailable');
    return result.result.value;
  };
  try { await call('Page.enable'); } catch { ws.close(); throw new Error('Browser page unavailable'); }
  return {
    get connected() { return ready && ws.readyState === 1; },
    action,
    async close() { try { if (ready) await action({ mode: 'cleanup' }); } catch {} ws.close(); },
  };
}

export async function captureCanvas(browser, settings, visible = true) {
  const result = await browser.action({ mode: 'capture', width: settings.width, height: settings.height, fit: settings.fit, visible });
  if (!result.ok || result.width !== settings.width || result.height !== settings.height || !Array.isArray(result.data) || result.data.length !== settings.width * settings.height * 3 || !result.data.every(value => Number.isInteger(value) && value >= 0 && value <= 255)) throw new Error('Music Assistant canvas unavailable');
  return { width: result.width, height: result.height, data: Buffer.from(result.data) };
}

export function pageAction(options, matches) {
  const doc = globalThis.document, styleId = 'party-visuals-browser-style';
  if (!matches(globalThis.location.href, options.expected)) return { ok: false };
  const view = doc.querySelector('.now-playing-view');
  if (options.mode === 'cleanup') {
    doc.getElementById(styleId)?.remove(); view?.removeAttribute('data-party-display');
    return { ok: true };
  }
  if (!view) return { ok: false };
  if (!doc.getElementById(styleId)) {
    const style = doc.createElement('style'); style.id = styleId;
    style.textContent = `.now-playing-view { isolation:isolate; }
      .now-playing-view .now-playing-artwork,.now-playing-view .now-playing-info,.now-playing-view .now-playing-timeline,.now-playing-view .visualizer-layer__scrim,.now-playing-view .visualizer-layer__tint { display:none!important; }
      .now-playing-view .visualizer-layer__canvas { filter:none!important; transform:none!important; }
      .now-playing-view .visualizer-layer__stack { opacity:1!important; }
      .now-playing-view[data-party-display="off"]::after { content:""; position:absolute; inset:0; background:#000; z-index:10; pointer-events:none; }`;
    doc.head.append(style);
  }
  view.setAttribute('data-party-display', options.visible === false ? 'off' : 'on');
  if (options.mode !== 'capture') return { ok: true };
  const canvas = view.querySelector('.visualizer-layer__canvas');
  if (!canvas || !canvas.width || !canvas.height || doc.visibilityState !== 'visible') return { ok: false };
  return new Promise(resolve => {
    let done = false;
    const timer = globalThis.setTimeout(() => { done = true; resolve({ ok: false }); }, 250);
    globalThis.requestAnimationFrame(() => {
      if (done) return;
      globalThis.clearTimeout(timer);
      try {
        const layer = canvas.closest('.visualizer-layer');
        if (!canvas.isConnected || !matches(globalThis.location.href, options.expected) || (options.visible && layer && Number(globalThis.getComputedStyle(layer).opacity) <= 0.001)) { resolve({ ok: false }); return; }
        const { width, height } = options, out = doc.createElement('canvas'); out.width = width; out.height = height;
        const ctx = out.getContext('2d', { willReadFrequently: true });
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, width, height);
        if (options.visible) {
          const scale = (options.fit === 'contain' ? Math.min : Math.max)(width / canvas.width, height / canvas.height);
          const w = canvas.width * scale, h = canvas.height * scale;
          ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(canvas, (width - w) / 2, (height - h) / 2, w, h);
        }
        const rgba = ctx.getImageData(0, 0, width, height).data, data = new Array(width * height * 3);
        for (let src = 0, dst = 0; src < rgba.length; src += 4) { data[dst++] = rgba[src]; data[dst++] = rgba[src + 1]; data[dst++] = rgba[src + 2]; }
        resolve({ ok: true, width, height, data });
      } catch { resolve({ ok: false }); }
    });
  });
}

export function ppm(image) {
  return Buffer.concat([Buffer.from(`P6\n${image.width} ${image.height}\n255\n`), image.data]);
}
