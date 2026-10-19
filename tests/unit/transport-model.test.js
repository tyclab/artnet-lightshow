import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseDriver, driverOf, playlistRowRequests, startShow, transportButtons, transportState } from '../../public-src/transport-model.js';
import { resolveRoute, VIEWS, viewShortcut } from '../../public-src/views.js';

test('legacy bookmarks retain their instrument', () => {
  for (const [hash, expected] of [['#manual', 'effects'], ['#timeline', 'auto/timeline'], ['#matrix', 'perform/matrix'], ['#rig/outputs', 'rig/outputs']]) {
    assert.equal(resolveRoute(hash).canonical, expected);
  }
  assert.equal(resolveRoute('#unknown'), null);
  assert.equal(resolveRoute(''), null);
});

test('digit shortcuts follow the ten views, the tenth on 0, and leave typing alone', () => {
  assert.deepEqual(VIEWS.map((v) => v.id), ['show', 'effects', 'perform', 'stage', 'auto', 'sequence', 'rig', 'sources', 'settings', 'preflight']);
  for (let i = 1; i <= 10; i++) {
    const key = String(i % 10);
    assert.equal(viewShortcut({ key }).id, VIEWS[i - 1].id);
    for (const patch of [{ repeat: true }, { ctrlKey: true }, { shiftKey: true }, { defaultPrevented: true }, { target: { tagName: 'INPUT' } }, { target: { isContentEditable: true } }]) {
      assert.equal(viewShortcut({ key, ...patch }), null);
    }
  }
});

test('the look transport is a pressed play/freeze pair, with no second stop', () => {
  assert.equal(driverOf({ running: false }), 'look');
  const frozen = transportButtons('look', { running: false });
  assert.deepEqual(frozen.map((b) => [b.id, b.label, b.enabled, b.pressed]),
    [['play', 'Play look', true, false], ['pause', 'Freeze look', true, true]]);
  assert.deepEqual(frozen[0].request, { set: { running: true } });
  assert.deepEqual(frozen[1].request, { set: { running: false } });
  assert.deepEqual(transportButtons('look', { running: true }).map((b) => [b.id, b.pressed]), [['play', true], ['pause', false]]);
});

test('the sequence transport presses the button of the state it is in', () => {
  const loaded = { loaded: { id: 'set' }, lanes: [] };
  const ids = (s) => transportButtons('sequence', s).filter((b) => b.pressed).map((b) => b.id);
  assert.deepEqual(ids({ sequence: { ...loaded, playing: true } }), ['play']);
  assert.deepEqual(ids({ sequence: { ...loaded, playing: true, paused: true } }), ['pause']);
  assert.deepEqual(ids({ sequence: { ...loaded, stopped: 'hold' } }), ['stop']);
  assert.deepEqual(ids({ sequence: { ...loaded, stopped: 'black' } }), ['stop']);
  assert.deepEqual(ids({ sequence: loaded }), []);
  assert.deepEqual(transportButtons('sequence', { sequence: { ...loaded, playing: true } }).slice(0, 3).map((b) => b.id), ['play', 'pause', 'stop']);
});

test('the transport names the state the look or sequence is in', () => {
  assert.equal(transportState('look', { running: true }), 'Look · playing');
  assert.equal(transportState('look', { running: false }), 'Look · frozen — holding the last picture; pads still play');
  const seq = (flags) => transportState('sequence', { sequence: { loaded: { id: 'set', name: 'Set one' }, ...flags } });
  assert.equal(seq({ playing: true }), 'Sequence · playing');
  assert.equal(seq({ playing: true, paused: true }), 'Sequence · paused — clips keep looping');
  assert.equal(seq({ stopped: 'hold' }), 'Sequence · stopped — holding the last picture');
  assert.equal(seq({ stopped: 'black' }), 'Sequence · stopped — black');
  assert.equal(seq({ ended: true }), 'Sequence · ended');
  assert.equal(seq({}), 'Sequence · loaded');
  assert.equal(transportState('sequence', { sequence: { loaded: null } }), null);
  assert.equal(transportState('auto', {}), null);
});

test('sequence selection preserves the generated show underneath it', () => {
  assert.deepEqual(chooseDriver('sequence:set', { showOn: true }), [{ path: '/api/sequence', method: 'PUT', body: { id: 'set' } }]);
  assert.equal(driverOf({ sequence: { loaded: { id: 'set' } }, showOn: true }), 'sequence');
});

test('returning to the look releases both sequence and automatic control', () => {
  assert.deepEqual(chooseDriver('look', { sequence: { loaded: { id: 'set' } }, showOn: true }), [
    { path: '/api/sequence', method: 'DELETE' }, { path: '/api/auto/stop', method: 'POST' },
  ]);
  assert.deepEqual(chooseDriver('auto', { sequence: { loaded: { id: 'set' } } }), [{ path: '/api/sequence', method: 'DELETE' }]);
});

test('show playback honours the server-selected source and ready analysis', () => {
  for (const source of ['spotify', 'deezer', 'nowplaying', 'prolink']) {
    assert.deepEqual(startShow({ autoSource: 'auto', activeSource: source }), {
      path: `/api/auto/analyze-${source}`, method: 'POST', body: { start: true },
    });
  }
  assert.equal(startShow({ autoSource: 'hybrid', activeSource: 'prolink' }).path, '/api/auto/analyze-spotify');
  assert.equal(startShow({ autoSource: 'spotify', autoShow: { status: 'ready' } }).path, '/api/auto/start');
  assert.equal(startShow({ autoSource: 'live' }).path, '/api/auto/start');
});

test('busy shows expose cancellation and cannot start twice', () => {
  const buttons = transportButtons('auto', { autoShow: { status: 'analyzing', startPending: true } });
  assert.equal(buttons.find((b) => b.id === 'play').enabled, false);
  assert.deepEqual(buttons.find((b) => b.id === 'cancel').request, { path: '/api/auto/cancel', method: 'POST' });
});

test('sequence looping keeps its saved bounds', () => {
  const buttons = transportButtons('sequence', { sequence: { loaded: { id: 'set' }, playing: true, loop: { on: true, startBeat: 4, endBeat: 12 } } });
  assert.equal(buttons.find((b) => b.id === 'play').pressed, true);
  assert.deepEqual(buttons.find((b) => b.id === 'loop').request.body, { on: false, startBeat: 4, endBeat: 12 });
  assert.ok(transportButtons('sequence', {}).every((b) => !b.enabled));
});

test('previous sequence navigation calls the existing previous endpoint', () => {
  const previous = transportButtons('sequence', { sequence: { loaded: { id: 'set' } } }).find((b) => b.id === 'prev');
  assert.equal(previous.enabled, true);
  assert.deepEqual(previous.request, { path: '/api/sequence/prev', method: 'POST' });
});

test('an inactive playlist row jumps before starting playback', () => {
  assert.deepEqual(playlistRowRequests('row/2', false), [
    { path: '/api/sequence/jump/row%2F2', method: 'POST' }, { path: '/api/sequence/play', method: 'POST' },
  ]);
});

test('an actively playing playlist row stops playback', () => {
  assert.deepEqual(playlistRowRequests('row2', true), [{ path: '/api/sequence/stop', method: 'POST' }]);
});
