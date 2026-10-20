// The outputs' arming switch (src/server/armed.ts): disarmed, nothing leaves
// the machine. The transmitter ends its streams on the way there and drops
// every frame after; the Hue sessions close and reopen; the applier never
// arms at start; the routes, the live state, the health report and the
// pre-show check carry it.

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { createTransmitter } from '../../src/server/transmit.ts';
import { isArmed } from '../../src/server/armed.ts';
import * as output from '../../src/server/output.ts';
import * as hue from '../../src/server/hue.ts';
import { createApplier } from '../../src/server/apply.ts';
import { settings } from '../../src/server/settings.ts';
import { state, getLiveState, placeAddresslessFixtures } from '../../src/server/state.ts';
import { assess, health } from '../../src/server/health.ts';
import { attachRoutes } from '../../src/server/routes.ts';
import { showStore } from '../../src/server/show-store.ts';
import { checkOutputsArmed } from '../../src/server/preflight.ts';
import { domainOf } from '../../src/server/protocol.ts';
import { HUE_COLOR_PROFILE_ID } from '../../src/server/profiles.ts';
import { buffer } from '../../src/server/log.ts';

showStore.scheduleSave = () => {};   // never the real show file

// ── The transmitter ─────────────────────────────────────────────────────────

/** Every packet, in order, with whether it was dark. */
function fakeWires() {
  const sent = [];
  const dark = (bytes) => !Array.from(bytes).some((v) => v !== 0);
  return {
    sent,
    wires: {
      artnet: (target, frame) => { sent.push({ wire: 'artnet', universe: target.universe, hosts: target.hosts, dark: dark(frame) }); return true; },
      artnetSync: (target) => { sent.push({ wire: 'artnet-sync', host: target.host }); return true; },
      sacn: (target, frame) => { sent.push({ wire: 'sacn', universe: target.universe, terminate: target.terminate, dark: dark(frame) }); return true; },
      sacnDiscovery: (packet) => { sent.push({ wire: 'sacn-discovery', universes: packet.universes }); return true; },
      ddp: (target, data) => { sent.push({ wire: 'ddp', host: target.host, dark: dark(data) }); return true; },
    },
  };
}

// One WLED on universe 3, ten RGB pixels. The same array every config, as
// the transmitter keys its universe set by it.
const DDP = [{ host: '10.0.0.50', port: 4048, rgbw: false, parts: [{ universe: 3, from: 0, bytes: 30 }], runs: [{ at: 0, count: 10 }] }];

const outputs = (armed, extra = {}) => ({
  artnet: { enabled: true, host: '10.0.0.9', port: 6454, sync: false, routes: null },
  sacn: { enabled: true, host: '', priority: 100, sourceName: 'x', universeOffset: 1, cid: '', interface: '' },
  delayMs: 0,
  ddp: DDP,
  armed,
  ...extra,
});

const LIT = Buffer.alloc(512);
LIT[0] = 200;
LIT[20] = 90;

/** One frame: the par universe, the WLED's universe, and the frame's end. */
function frame(tx, config) {
  tx.send(0, LIT, config);
  tx.send(3, LIT, config);
  tx.endFrame(config);
}

const wires = (sent, name) => sent.filter((p) => p.wire === name);

test('disarming stops transmitted frames and closes streams', () => {
  const { sent, wires: fake } = fakeWires();
  const tx = createTransmitter({ wires: fake });

  // Started disarmed: nothing has gone out, so there is nothing to end.
  frame(tx, outputs(false));
  frame(tx, outputs(false));
  assert.deepEqual(sent, [], 'a server that starts disarmed sends nothing, not even a black frame');

  frame(tx, outputs(true));
  assert.deepEqual(wires(sent, 'artnet'), [{ wire: 'artnet', universe: 0, hosts: ['10.0.0.9'], dark: false }]);
  assert.deepEqual(wires(sent, 'sacn'), [{ wire: 'sacn', universe: 1, terminate: false, dark: false }]);
  assert.deepEqual(wires(sent, 'ddp'), [{ wire: 'ddp', host: '10.0.0.50', dark: false }]);
  assert.deepEqual(wires(sent, 'sacn-discovery'), [{ wire: 'sacn-discovery', universes: [1] }]);
  sent.length = 0;

  // The transition: one black frame per universe, the sACN terminate, one
  // dark frame per WLED — in the order the wires are listed — and that is all.
  frame(tx, outputs(false));
  assert.deepEqual(sent, [
    { wire: 'artnet', universe: 0, hosts: ['10.0.0.9'], dark: true },
    { wire: 'sacn', universe: 1, terminate: true, dark: true },
    { wire: 'ddp', host: '10.0.0.50', dark: true },
  ]);
  sent.length = 0;

  frame(tx, outputs(false));
  tx.send(0, LIT, outputs(false), { immediate: true, terminate: true });
  tx.endFrame(outputs(false));
  assert.deepEqual(sent, [], 'disarmed: every frame is dropped, a blackout included');

  // Armed again: the streams pick up, and sACN announces its universes at once.
  frame(tx, outputs(true));
  assert.deepEqual(sent.map((p) => [p.wire, p.dark ?? null]), [
    ['artnet', false], ['sacn', false], ['ddp', false], ['sacn-discovery', null],
  ]);
});

test('transmit: with ArtSync on, the black frame that ends Art-Net is shown by a sync', () => {
  const { sent, wires: fake } = fakeWires();
  const tx = createTransmitter({ wires: fake });
  const synced = (armed) => outputs(armed, { artnet: { enabled: true, host: '10.0.0.9', port: 6454, sync: true, routes: null }, sacn: { ...outputs(true).sacn, enabled: false } });
  frame(tx, synced(true));
  assert.deepEqual(sent.map((p) => p.wire), ['artnet', 'ddp', 'artnet-sync']);
  sent.length = 0;
  frame(tx, synced(false));
  assert.deepEqual(sent, [
    { wire: 'artnet', universe: 0, hosts: ['10.0.0.9'], dark: true },
    { wire: 'artnet-sync', host: '10.0.0.9' },
    { wire: 'ddp', host: '10.0.0.50', dark: true },
  ]);
});

test('transmit: a config that says nothing about arming is armed, as before', () => {
  const { sent, wires: fake } = fakeWires();
  const tx = createTransmitter({ wires: fake });
  const config = outputs(true);
  delete config.armed;
  frame(tx, config);
  assert.deepEqual(sent.map((p) => p.wire), ['artnet', 'sacn', 'ddp', 'sacn-discovery']);
});

// ── Hue ─────────────────────────────────────────────────────────────────────
// A session is opened by the first frame sent to it, so "reopens on arm" is
// the first frame after arming being sent at all. The bridge here does not
// exist: what is watched is whether the session was asked to connect.

const AREA = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

test('Hue sessions close on disarm and reopen on arm', async () => {
  const saved = { fixtures: state.fixtures, next: state.nextFixtureId, hue: output.getHueConfig() };
  state.fixtures = [{
    id: 500, label: 'Lamp', address: 1, universe: 0, profileId: HUE_COLOR_PROFILE_ID, maxBrightness: 255, override: null,
    output: { protocol: 'hue', bridge: 'b1', channel: 0 },
  }];
  placeAddresslessFixtures();
  output.configureHue({
    latencyMs: 0,
    bridges: [{ id: 'b1', label: 'Lounge', enabled: true, host: 'bridge.invalid', username: 'user', clientKey: 'aabb', applicationId: 'app-id', entertainmentId: AREA }],
  });
  const status = () => hue.getSession('b1').getStatus().status;
  const settled = async () => {
    const deadline = Date.now() + 8000;
    while (status() === 'connecting' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  };
  try {
    output.setArmed(false);
    assert.equal(output.sendHue(), false);
    assert.equal(status(), 'idle', 'disarmed: the bridge is not contacted');

    output.setArmed(true);
    output.sendHue();
    assert.equal(status(), 'connecting', 'armed: the first frame opens the session');
    await settled();
    assert.equal(status(), 'failed', 'no such bridge');

    output.setArmed(false);
    await new Promise((r) => setImmediate(r));
    assert.equal(status(), 'idle', 'disarmed: the session is closed');
    output.sendHue();
    assert.equal(status(), 'idle', 'and stays closed');

    output.setArmed(true);
    output.sendHue();
    assert.equal(status(), 'connecting', 'armed again: reopened from the first frame');
    await settled();
  } finally {
    output.setArmed(false);
    await hue.stopAll();
    hue._reset();
    output.configureHue(saved.hue);
    state.fixtures = saved.fixtures;
    state.nextFixtureId = saved.next;
  }
});

// ── The applier and the routes ──────────────────────────────────────────────

/** The subsystems the applier pushes into, as far as arming needs them. */
const subsystems = (applied) => ({
  midi: { close() {}, connect() { return true; }, setControlFeedback() {} },
  spotify: { localCallbackUrl: '', setLoopbackPort() {}, configure() {} },
  smtc: { start() {}, stop() {} },
  deezer: { init: async () => {} },
  applyPatch: (patch) => applied.push(patch),
  broadcast() {},
});

/** The settings store on the defaults, its file write stubbed, put back after. */
function withSettings(fn) {
  const saved = { values: settings.all(), artnet: { ...state.artnet }, hue: output.getHueConfig() };
  settings.save = () => {};
  settings.useDefaults();
  return Promise.resolve().then(fn).finally(() => {
    output.setArmed(false);
    settings._values = saved.values;
    delete settings.save;
    Object.assign(state.artnet, saved.artnet);
    output.configureHue(saved.hue);
  });
}

/** What the outputs logged since `mark`: the arming lines, with their fields. */
const armingLines = (mark) => buffer.since(mark).filter((e) => e.component === 'outputs').map((e) => ({ msg: e.msg, ...e.data }));

test('startup ignores stored arming and subsequent saves toggle output', (t) => withSettings(() => {
  settings._values.outputs.armed = true;
  const log = t.mock.method(console, 'log', () => {});
  const applied = [];
  const applier = createApplier(subsystems(applied));
  const mark = buffer.last;
  try {
    applier.applyAll();
    assert.equal(isArmed(), false);
    assert.equal(settings.get('outputs.armed'), false, 'the stored value is put back to off');
    const boot = armingLines(mark);
    assert.equal(boot.length, 1, JSON.stringify(boot));
    assert.match(boot[0].msg, /^disarmed at start/);
    assert.deepEqual([boot[0].armed, boot[0].via], [false, 'boot']);
    assert.deepEqual(applied, [], 'nothing to stop: the look the supervisor restores is left as it is');

    applier.applyChanged(settings.update({ outputs: { armed: true } }));
    assert.equal(isArmed(), true);
    assert.deepEqual(applied, [], 'arming plays nothing by itself');

    state.heldEnergy = 'blinder';
    applier.applyChanged(settings.update({ outputs: { armed: false } }));
    assert.equal(isArmed(), false);
    assert.deepEqual(applied, [{ running: false, energyOverride: null }], 'disarming stops the patterns and clears the effect');
    assert.equal(state.heldEnergy, null);
  } finally {
    log.mock.restore();
  }
}));

test('the routes arm, disarm and toggle; the state and the health report carry it', (t) => withSettings(async () => {
  const applied = [];
  const app = express();
  app.use(express.json());
  attachRoutes(app, { integrations: { broadcast() {} }, applier: createApplier(subsystems(applied)) });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => new Promise((r) => server.close(r)));
  const call = (method, path) => fetch(`http://127.0.0.1:${server.address().port}${path}`, { method })
    .then(async (res) => ({ status: res.status, body: await res.json() }));

  assert.equal((await call('GET', '/api/state')).body.armed, false);
  assert.deepEqual((await call('POST', '/api/outputs/arm')).body, { ok: true, armed: true });
  assert.equal(isArmed(), true);
  assert.equal(settings.get('outputs.armed'), true, 'stored');
  assert.equal((await call('GET', '/api/state')).body.armed, true);
  assert.equal((await call('GET', '/api/health')).body.outputs.armed, true);

  assert.deepEqual((await call('POST', '/api/outputs/disarm')).body, { ok: true, armed: false });
  assert.deepEqual(applied, [{ running: false, energyOverride: null }]);
  const quiet = (await call('GET', '/api/health')).body;
  assert.equal(quiet.outputs.armed, false);
  assert.ok(quiet.problems.some((p) => p.level === 'info' && /outputs are disarmed/.test(p.what)), 'said among the problems, as information');

  assert.deepEqual((await call('POST', '/api/outputs/toggle')).body, { ok: true, armed: true });
  assert.deepEqual((await call('POST', '/api/outputs/toggle')).body, { ok: true, armed: false });
  assert.deepEqual((await call('POST', '/api/outputs/disarm')).body, { ok: true, armed: false }, 'already off: nothing to do');
  assert.equal(applied.length, 2, 'stopped once per disarming, not per request');
}));

test('each arm and disarm is logged once, with where it came from and never a token', (t) => withSettings(async () => {
  const app = express();
  app.use(express.json());
  const applier = createApplier(subsystems([]));
  attachRoutes(app, { integrations: { broadcast() {} }, applier });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => new Promise((r) => server.close(r)));
  const call = (method, path, headers = {}, body) => fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method, headers: { 'X-Lightshow-Token': 'header-secret', authorization: 'Bearer auth-secret', ...headers, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).then((res) => res.json());
  const mark = buffer.last;

  await call('POST', '/api/outputs/arm?token=query-secret', { 'user-agent': 'HomeAssistant/2026.10.1 aiohttp/3.12', 'x-forwarded-for': '10.27.2.140' });
  await call('POST', '/api/outputs/arm', { 'user-agent': 'HomeAssistant/2026.10.1 aiohttp/3.12' });
  await call('POST', '/api/outputs/disarm', { 'user-agent': 'node', 'x-lightshow-client': 'companion/2.1.0' });
  await call('PUT', '/api/settings', { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0)' }, { outputs: { armed: true } });
  await call('POST', '/api/outputs/toggle', { 'user-agent': 'curl/8.9' });
  applier.applyChanged(settings.update({ outputs: { armed: true } }), { via: 'schedule', reason: 'a test' });
  applier.applyChanged(settings.update({ outputs: { armed: false } }));

  const lines = armingLines(mark);
  assert.deepEqual(lines.map((l) => [l.armed, l.via, l.route ?? null]), [
    [true, 'rest', 'POST /api/outputs/arm'],
    [false, 'companion', 'POST /api/outputs/disarm'],
    [true, 'rest', 'PUT /api/settings'],
    [false, 'rest', 'POST /api/outputs/toggle'],
    [true, 'schedule', null],
    [false, 'unknown', null],
  ], 'one line per transition: the second arm changed nothing');
  assert.match(lines[0].msg, /^armed/);
  assert.match(lines[1].msg, /^disarmed/);
  assert.equal(lines[0].remote, '127.0.0.1');
  assert.equal(lines[0].userAgent, 'HomeAssistant/2026.10.1 aiohttp/3.12');
  assert.equal(lines[0].forwardedFor, '10.27.2.140');
  assert.equal(lines[1].client, 'companion/2.1.0');
  assert.equal(lines[2].userAgent, 'Mozilla/5.0 (Windows NT 10.0)');
  assert.equal(lines[4].reason, 'a test');
  assert.doesNotMatch(JSON.stringify(lines), /secret/, 'no token, query string or auth header');
}));

// ── The state, the health report and the pre-show check ─────────────────────

test('the live state carries whether the outputs are armed, with the rig', () => {
  assert.equal(typeof getLiveState().armed, 'boolean');
  assert.equal(getLiveState().armed, isArmed());
  assert.equal(domainOf('armed'), 'rig');
});

test('health: disarmed outputs are said, as information, and never a fault', () => {
  const fine = {
    engine: { running: true, fellBack: false, frames: 1000, lateFrames: 3 },
    eventLoop: { p50Ms: 10, p99Ms: 20, maxMs: 30 },
    rssMb: 300,
    errors: { count: 0, last: null },
    supervisor: { supervised: true, restarts: 0, lastExit: null, recovering: false },
    auto: { status: 'ready', error: null },
  };
  const quiet = assess({ ...fine, armed: false });
  assert.equal(quiet.status, 'ok');
  assert.deepEqual(quiet.problems.map((p) => p.level), ['info']);
  assert.match(quiet.problems[0].what, /outputs are disarmed/);
  assert.deepEqual(assess({ ...fine, armed: true }).problems, []);
  assert.deepEqual(assess(fine).problems, [], 'nothing said when nothing is known');
  assert.equal(health().outputs.armed, isArmed());
});

test('the pre-show check warns about disarmed outputs rather than failing', () => {
  const off = checkOutputsArmed(false);
  assert.deepEqual([off.id, off.status], ['armed', 'warn']);
  assert.ok(off.detail);
  assert.ok(off.fix);
  assert.equal(checkOutputsArmed(true).status, 'ok');
  assert.equal(checkOutputsArmed(false, { standalone: true }).status, 'info');
});
