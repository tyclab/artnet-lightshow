import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { run } from '../cli.js';

const settings = { curtain: false, browserProfile: '/dedicated-profile', visualizerUrl: 'http://music.invalid/#/now-playing?player=one', controlsUrl: 'http://127.0.0.1:9090/bundles/party-visuals/api/state', nodecgConfig: '/must-never-be-read/secret.json' };
const input = () => Object.assign(new EventEmitter(), { paused: false, pause() { this.paused = true; } });

test('display-only loop applies on/off, keeps login usable, and stops on split Windows stdin without reading lightshow config', async () => {
  const stdin = input(), actions = [], logs = [];
  let reads = 0, closes = 0;
  const browser = { connected: true, action: async options => {
    actions.push(options);
    if (actions.length === 3) { stdin.emit('data', Buffer.from('sto')); stdin.emit('data', Buffer.from('p\r')); stdin.emit('data', Buffer.from('\n')); }
    return { ok: actions.length !== 2 };
  }, close: async () => { closes++; } };
  await run(settings, {
    stdin, log: line => logs.push(line),
    connectPage: async (profile, url) => { assert.equal(profile, settings.browserProfile); assert.equal(url, settings.visualizerUrl); return browser; },
    readControls: async () => { reads++; return { ok: reads !== 3, visible: reads === 1 }; },
  });
  assert.deepEqual(actions.map(value => value.visible), [true, false, false]);
  assert.ok(actions.every(value => value.mode === 'display' && Object.keys(value).length === 2));
  assert.ok(logs.includes('Waiting for Music Assistant login or player page'));
  assert.equal(closes, 1); assert.equal(stdin.listenerCount('data'), 0); assert.equal(stdin.paused, true);
});

test('supervisor exit ends the helper and restores the browser without stdin EOF', async () => {
  const stdin = input(); let closes = 0, frames = 0;
  const browser = { connected: true, action: async () => { frames++; return { ok: true }; }, close: async () => { closes++; } };
  await run({ ...settings, parentPid: 2_000_000_000 }, { stdin, log: () => {}, connectPage: async () => browser, readControls: async () => ({ ok: true, visible: true }) });
  assert.ok(frames >= 1); assert.equal(closes, 1); assert.equal(stdin.listenerCount('data'), 0);
});

test('a failed browser action closes the session and clean stop works while reconnecting', async () => {
  const stdin = input(); let closes = 0;
  await run(settings, {
    stdin, log: () => {}, readControls: async () => ({ ok: true, visible: true }),
    connectPage: async () => ({ connected: true, action: async () => { throw new Error('browser restarted'); }, close: async () => { closes++; stdin.emit('data', Buffer.from('stop\n')); } }),
  });
  assert.equal(closes, 1); assert.equal(stdin.paused, true);
});

test('stop after the UTF-8 BOM that Windows PowerShell writes to redirected stdin', async () => {
  const stdin = input(); let closes = 0;
  const browser = { connected: true, action: async () => { stdin.emit('data', Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from('stop\r\n')])); return { ok: true }; }, close: async () => { closes++; } };
  await run(settings, { stdin, log: () => {}, connectPage: async () => browser, readControls: async () => ({ ok: true, visible: true }) });
  assert.equal(closes, 1); assert.equal(stdin.paused, true);
});

test('output mode streams only a live visualizer and holds the displays awake while the lightshow reports armed', async () => {
  const stdin = input(), sources = [], holds = [];
  let actions = 0, armed = false, source = null, stops = 0;
  const pump = { nextCaptureAt: 0, retryAt: 0, step: async () => { sources.push(source()); }, stop: async () => {}, invalidate: async () => {} };
  const browser = { connected: true, close: async () => {}, action: async () => {
    actions++;
    if (actions === 4) armed = true;
    if (actions === 7) stdin.emit('data', Buffer.from('stop\n'));
    return { ok: true, live: actions < 4 || actions > 5 };
  } };
  await run({ ...settings, curtain: true }, {
    stdin, log: () => {}, connectPage: async () => browser, readControls: async () => ({ ok: true, visible: true }),
    connectCurtain: async (_settings, _capture, ready) => { source = ready; return { pump, armed: () => armed, stop: async () => { stops++; } }; },
    displayHold: { held: false, update: wanted => holds.push(wanted), stop: () => holds.push('stop') },
  });
  assert.deepEqual(sources.slice(0, 6).map(value => value.ok ? 'live' : value.reason), ['live', 'live', 'live', 'Visualizer idle', 'Visualizer idle', 'live']);
  assert.equal(sources[3].idle, true);
  assert.deepEqual(holds.slice(0, 4), [false, false, false, true]);
  assert.equal(holds.at(-1), 'stop', 'the hold ends with the helper');
  assert.equal(stops, 1);
});

test('multiple panels share captures while leases, target failures and browser reconnect remain independent', async () => {
  const { LeasePump, targetWithSource } = await import('../pump.js');
  const stdin = input(), requests = [], captures = [], attached = [], feeds = [];
  let tick = 0, connections = 0, invalidate, browser, rejected = false;
  await run({ ...settings, curtain: true, fixtureId: 53, width: 68, height: 42, fit: 'cover', fps: 60, panels: [{ fixtureId: 38, width: 20, height: 6 }, { fixtureId: 39, width: 20, height: 6 }] }, {
    stdin, log: () => {}, readControls: async () => ({ ok: true, visible: true }),
    displayHold: { update() {}, stop() {} },
    connectPage: async (_profile, _url, onClose) => {
      connections++; invalidate = onClose;
      browser = { connected: true, close: async () => {}, action: async action => {
        if (action.mode === 'display') {
          tick++;
          if (tick === 2) { browser.connected = false; invalidate(); }
          if (tick === 8) stdin.emit('data', Buffer.from('stop\n'));
          return { ok: true, live: true };
        }
        captures.push({ tick, width: action.width, height: action.height });
        return { ok: true, width: action.width, height: action.height, data: Array(action.width * action.height * 3).fill(tick) };
      } };
      return browser;
    },
    connectCurtain: async (target, capture, source) => {
      attached.push([target.fixtureId, target.width, target.height]);
      const transport = { connected: true, id: `socket-${target.fixtureId}`, request: async (event, payload) => {
        requests.push({ event, ...payload, tick });
        if (event === 'pixel-input:claim') return { ok: true, leaseId: `lease-${target.fixtureId}-${tick}`, format: 'rgb24', order: 'row-major', ttlMs: 2000, maxFps: 60 };
        if (event === 'pixel-input:frame' && target.fixtureId === 38 && tick >= 4 && !rejected) { rejected = true; return { ok: false, code: 'BUSY' }; }
        return { ok: true };
      } };
      const pump = new LeasePump({ ...target, transport, capture, target: () => targetWithSource(source, () => ({ ok: true, key: `grid-${target.fixtureId}` })) });
      const feed = { pump, armed: () => true, stop: () => pump.stop() }; feeds.push(feed); return feed;
    },
  });
  assert.deepEqual(attached, [[53, 68, 42], [38, 20, 6], [39, 20, 6]]);
  assert.equal(connections, 2);
  assert.ok(rejected);
  assert.ok(feeds.every(feed => feed.pump.stopped && feed.pump.lease === null));
  for (const id of [53, 38, 39]) {
    const claims = requests.filter(request => request.event === 'pixel-input:claim' && request.fixtureId === id);
    assert.ok(claims.length >= 2, `${id} reclaims after the browser reconnects`);
    assert.ok(requests.some(request => request.event === 'pixel-input:release' && request.fixtureId === id));
  }
  assert.ok(requests.some(request => request.event === 'pixel-input:frame' && request.fixtureId === 39 && request.tick > 4), 'the other panel continues while one target backs off');
  assert.ok(requests.some(request => request.event === 'pixel-input:frame' && request.fixtureId === 53 && request.tick > 4), 'curtain continues while one target backs off');
  assert.ok(captures.some(capture => capture.width === 20));
  assert.equal(new Set(captures.map(capture => `${capture.tick}:${capture.width}x${capture.height}`)).size, captures.length, 'one capture per size per iteration');
  const first = requests.filter(request => request.event === 'pixel-input:frame' && [38, 39].includes(request.fixtureId) && request.tick === 1);
  assert.equal(first.length, 2); assert.equal(first[0].data, first[1].data, 'panels share the same captured RGB buffer');
});


test('a slow panel lease claim gets a fresh capture instead of an older shared frame', async () => {
  const stdin = input(), frames = [], captures = [];
  let display = 0;
  const browser = { connected: true, close: async () => {}, action: async action => {
    if (action.mode === 'display') { if (++display === 2) stdin.emit('data', Buffer.from('stop\n')); return { ok: true, live: true }; }
    captures.push(performance.now());
    return { ok: true, width: 20, height: 6, data: Array(360).fill(captures.length) };
  } };
  await run({ ...settings, fps: 60, fit: 'cover', panels: [{ fixtureId: 38, width: 20, height: 6 }, { fixtureId: 39, width: 20, height: 6 }] }, {
    stdin, log: () => {}, connectPage: async () => browser, readControls: async () => ({ ok: true, visible: true }),
    displayHold: { update() {}, stop() {} },
    connectCurtain: async (target, capture) => ({ armed: () => false, stop: async () => {}, pump: {
      nextCaptureAt: 0, retryAt: 0, stop: async () => {}, invalidate: async () => {},
      step: async () => {
        if (display !== 1) return;
        if (target.fixtureId === 39) await new Promise(resolve => setTimeout(resolve, 50));
        frames.push((await capture()).data[0]);
      },
    } }),
  });
  assert.deepEqual(frames, [1, 2]);
  assert.equal(captures.length, 2);
});
