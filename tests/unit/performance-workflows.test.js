import test from 'node:test';
import assert from 'node:assert/strict';
import { generatePlaylist } from '../../src/server/playlist-generator.ts';
import { CATALOGUE } from '../../src/shared/effects/index.ts';
import { buildTable } from '../../src/server/sequencer.ts';
import { requiresAcknowledgement } from '../../src/shared/effects/registry.ts';
import { BpmCaptureSession } from '../../public-src/bpm-capture.js';
import { LiveAutomation } from '../../src/server/live-automation.ts';

test('starter generation is a valid editable playlist and excludes rapid effects by default', () => {
  const { sequence, skipped } = generatePlaylist({ template: 'universal' }, CATALOGUE, []);
  assert.ok(sequence.clips.length > 5);
  assert.ok(skipped.some((p) => p.reason === 'Rapid effect omitted'));
  const table = buildTable(sequence, (id) => CATALOGUE.find((p) => p.id === id)?.spec, 1);
  assert.ok(table.clips.every((c) => !requiresAcknowledgement(c.spec)));
  assert.ok(sequence.clips.every((c, i) => c.startBeat === i * 32 && c.lengthBeats === 32));
  assert.equal(generatePlaylist({ template: 'universal', includeRapid: true }, CATALOGUE, []).sequence.clips.length, 24);
});

test('all-library generator cannot place dedicated strobes into repeatable clips; empty remains empty', () => {
  const generated = generatePlaylist({ template: 'all', includeRapid: true, lengthBeats: 64 }, CATALOGUE, []);
  assert.ok(generated.skipped.some((p) => p.reason.includes('Self-paced')));
  assert.doesNotThrow(() => buildTable(generated.sequence, (id) => CATALOGUE.find((p) => p.id === id)?.spec, 1));
  assert.equal(generatePlaylist({ template: 'empty' }, CATALOGUE, []).sequence.clips.length, 0);
  assert.equal(generatePlaylist({ template: 'compatible' }, CATALOGUE, []).sequence.clips.length, 0);
  assert.throws(() => generatePlaylist({ template: 'all', lengthBeats: -1 }, CATALOGUE, []));
});

test('capture measures fresh consistent lock without treating duplicate, silent or half-time readings as confidence', () => {
  const stable = new BpmCaptureSession();
  for (let i = 0; i < 48; i++) stable.add({ listening: true, source: 'input', reading: { t: i / 4, bpm: 120 + i % 2 * .1, locked: true } }, i * 250);
  assert.equal(stable.result().ready, true);
  assert.ok(stable.result().confidence > .95);
  const duplicate = new BpmCaptureSession();
  for (let i = 0; i < 48; i++) duplicate.add({ listening: true, source: 'input', reading: { t: 0, bpm: 120, locked: true } }, i * 250);
  assert.equal(duplicate.result().ready, false);
  const mixed = new BpmCaptureSession();
  for (let i = 0; i < 48; i++) mixed.add({ listening: true, source: 'input', reading: { t: i / 4, bpm: i % 2 ? 60 : 120, locked: true } }, i * 250);
  assert.equal(mixed.result().ready, false);
  stable.add({ listening: true, source: 'loopback', reading: { t: 0, bpm: 180, locked: true } }, 12000);
  assert.equal(stable.result().ready, false);
  assert.equal(new BpmCaptureSession().result().bpm, null);
});

test('live automation follows seconds and musical beats independently, finishes targets and cancels manual axes', () => {
  const state = { bpm: 120, masterDimmer: 0, running: true, masterBlackout: false, armed: false, sequenceRunning: false };
  let now = 0;
  const live = new LiveAutomation(() => state, (patch) => Object.assign(state, patch), () => now);
  const target = { mode: 'target', period: 4, min: 20, max: 180, growing: true, target: 180 };
  live.start('tempo', target);
  live.start('brightness', { ...target, min: 0, max: 255, target: 255 });
  live.frame({ beatPos: 0, bpm: 120, epoch: 1, source: 'tap' });
  now = 2000; live.frame({ beatPos: 1, bpm: 120, epoch: 1, source: 'tap' });
  assert.equal(state.bpm, 150);
  assert.equal(state.masterDimmer, 64);
  live.frame({ beatPos: 50, bpm: 150, epoch: 2, source: 'live' });
  assert.equal(state.masterDimmer, 64, 'clock discontinuities cannot complete a fade');
  live.handEdit({ bpm: true, masterDimmer: false });
  assert.equal(live.status().tempo, null);
  now = 4000; live.frame({ beatPos: 53, bpm: 150, epoch: 2, source: 'live' });
  assert.equal(state.masterDimmer, 255);
  assert.equal(live.status().brightness, null);
  assert.equal(state.bpm, 150);
});

test('live automation cannot fight a sequence, survive disarm or revive after blackout', () => {
  const state = { bpm: 120, masterDimmer: 100, running: true, masterBlackout: false, armed: true, sequenceRunning: false };
  const live = new LiveAutomation(() => state, (patch) => Object.assign(state, patch));
  const cycle = { mode: 'sine', period: 4, min: 0, max: 255, growing: true };
  const reading = { beatPos: 0, bpm: 120, epoch: 0, source: 'tap' };
  live.start('brightness', cycle); state.armed = false; live.frame(reading);
  assert.equal(live.status().brightness, null);
  live.start('brightness', cycle); state.masterBlackout = true; live.frame(reading);
  assert.equal(live.status().brightness, null);
  assert.throws(() => live.start('brightness', cycle), { status: 409 });
  state.masterBlackout = false; state.sequenceRunning = true;
  assert.throws(() => live.start('brightness', cycle), { status: 409 });
  state.sequenceRunning = false; live.start('brightness', cycle);
  state.sequenceRunning = true; live.frame(reading);
  assert.equal(live.status().brightness, null);
  assert.equal(state.masterDimmer, 100);
});
