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
