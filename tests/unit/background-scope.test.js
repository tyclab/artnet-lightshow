// The Background card's fixture scope (src/shared/background.ts backgroundScope):
// Whole rig, Wash fixtures (the single-light ones) or Selected fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRenderer, withInputDefaults } from '../../src/server/renderer.ts';
import { createUniverseStore } from '../../src/server/universes.ts';
import { validateSpec } from '../../src/shared/effects/registry.ts';
import { HD_DEFAULTS } from '../../src/shared/effects/hd.ts';
import { bundleSpec } from '../../src/shared/effects/bundle.ts';
import { DEFAULT_BACKGROUND, backgroundScope, backgroundSchema } from '../../src/shared/background.ts';
import { createPreviewSampler } from '../../src/shared/preview.ts';
import { buildRig } from '../../src/shared/rig.ts';
import { COLOR_PRESETS } from '../../src/server/presets.ts';
import { state } from '../../src/server/state.ts';
import { applyPatch } from '../../src/server/patch.ts';
import { stopEngine } from '../../src/server/engine.ts';
import { captureLook, recallLook } from '../../src/server/cues.ts';
import { LookStore, currentLook, putBack } from '../../src/server/look-store.ts';
import { validate, patchSchema } from '../../src/server/validation.ts';

test.after(() => stopEngine());

const EMITTERS = ['red', 'green', 'blue', 'white', 'amber', 'uv'];
const lamp = { id: 'scope-lamp', channelCount: 6, channelMap: Object.fromEntries(EMITTERS.map((c, i) => [c, i])) };
const bar = { id: 'scope-bar', channelCount: 24, channelMap: {},
  cells: Array.from({ length: 4 }, (_, cell) => ({ channelMap: Object.fromEntries(EMITTERS.map((c, i) => [c, cell * 6 + i])) })) };
const profiles = { [lamp.id]: lamp, [bar.id]: bar };
const fixture = (id, profileId, address, x) => ({ id, address, universe: 0, profileId, maxBrightness: 255, override: null,
  position: { x, y: 50 }, group: null, geometry: null, hue: false });
// Four single lamps (ids 0-3, six bytes each) and one four-cell bar (id 4, bytes 24-47).
const fixtures = [fixture(0, lamp.id, 1, 0), fixture(1, lamp.id, 7, 25), fixture(2, lamp.id, 13, 50), fixture(3, lamp.id, 19, 75),
  fixture(4, bar.id, 25, 100)];
const BYTES = 48;
const bytesOf = (id) => (id < 4 ? [id * 6, id * 6 + 6] : [24, 48]);
const colour = { r: 160, g: 120, b: 80, w: 100, a: 90, uv: 60 };
const fixed = { ...DEFAULT_BACKGROUND, mode: 'fixed', colour, level: .3 };
const off = { ...DEFAULT_BACKGROUND, mode: 'off' };
const look = { running: true, pattern: 'solid', colorA: 0, colorB: 5, colorC: 4, colorD: 8, split: null, pixelMap: 'stage',
  masterDimmer: 255, beatDivision: 1, fixtures, universes: [0], flashLimit: false, safety: { acknowledged: true, hdFlashIntervalMs: 0 } };

function engine(patch = {}) {
  const renderer = createRenderer({ profileOf: (f) => profiles[f.profileId], profilesRevision: () => 0, now: 0 });
  const store = createUniverseStore();
  return { renderer, draw(now, change = {}) {
    renderer.frame(withInputDefaults({ ...look, ...patch, ...change }), { beatPos: now / 500, bpm: 120, epoch: 0 }, now, store);
    return [...store.getBuffer(0).slice(0, BYTES)];
  } };
}
const part = (bytes, id) => bytes.slice(...bytesOf(id));
const lit = (bytes) => bytes.some((byte) => byte > 0);
const dark = (bytes) => bytes.every((byte) => byte === 0);

const hdGap = validateSpec({ kind: 'hd.twinkle', brightness: 1,
  params: { ...HD_DEFAULTS['hd.twinkle'].params, probability: 0, trigger: { ...HD_DEFAULTS['hd.twinkle'].params.trigger, mode: 'timeline' } } });

// Each fixture shows either the whole-rig rendering of the setting or the untouched (Follow, 100 %) one.
function assertScoped(patch, background, inScope, times = [0, 120, 500, 900]) {
  const scoped = engine({ ...patch, background }), whole = engine({ ...patch, background: { ...background, fixtures: undefined, selected: undefined } });
  const untouched = engine(patch);
  for (const now of times) {
    const a = scoped.draw(now), b = whole.draw(now), c = untouched.draw(now);
    for (const f of fixtures) assert.deepEqual(part(a, f.id), part(inScope.includes(f.id) ? b : c, f.id), `fixture ${f.id} at ${now} ms`);
  }
}

test('the scope mask: whole rig is null, wash is the single-light fixtures, selected follows the ids', () => {
  const rig = buildRig(fixtures, (f) => profiles[f.profileId]);
  const ids = (i) => fixtures[i].id;
  assert.equal(backgroundScope(DEFAULT_BACKGROUND, rig.cellMaps, ids), null);
  assert.equal(backgroundScope({ ...fixed, fixtures: 'rig', selected: [1] }, rig.cellMaps, ids), null);
  assert.deepEqual([...backgroundScope({ ...fixed, fixtures: 'wash' }, rig.cellMaps, ids)], [1, 1, 1, 1, 0]);
  assert.deepEqual([...backgroundScope({ ...fixed, fixtures: 'selected', selected: [4, 1, 99] }, rig.cellMaps, ids)], [0, 1, 0, 0, 1]);
  assert.deepEqual([...backgroundScope({ ...fixed, fixtures: 'selected' }, rig.cellMaps, ids)], [0, 0, 0, 0, 0]);
});

test('Wash fixtures: Fixed fills the single lamps and leaves the bar as the effect draws it', () => {
  const background = { ...fixed, fixtures: 'wash' };
  const e = engine({ effect: hdGap, background });
  const wire = e.draw(500);
  for (const id of [0, 1, 2, 3]) assert.ok(lit(part(wire, id)), `negative control: lamp ${id} takes the wash`);
  assert.ok(dark(part(wire, 4)), 'the bar is outside the scope: its gaps stay as the effect leaves them');
  assertScoped({ effect: hdGap }, background, [0, 1, 2, 3]);
  assertScoped({ pattern: 'chase', paletteOverride: [colour] }, background, [0, 1, 2, 3]);
});

test('Selected fixtures: only the picked fixtures take the setting; an empty pick takes none', () => {
  assertScoped({ effect: hdGap }, { ...fixed, fixtures: 'selected', selected: [1, 4] }, [1, 4]);
  assertScoped({ pattern: 'chase', paletteOverride: [colour] }, { ...off, fixtures: 'selected', selected: [0, 3] }, [0, 3]);
  assertScoped({ pattern: 'chase', paletteOverride: [colour] }, { ...fixed, fixtures: 'selected', selected: [] }, []);
  assertScoped({ pattern: 'chase', paletteOverride: [colour] }, { ...fixed, fixtures: 'wash', selected: [4] }, [0, 1, 2, 3]);
});

test('Off with a scope removes the bed only on the fixtures it reaches', () => {
  const e = engine({ pattern: 'fade', background: { ...off, fixtures: 'wash' } }), follow = engine({ pattern: 'fade' });
  const wire = e.draw(0), reference = follow.draw(0);
  assert.ok(lit(part(reference, 4)) && lit(part(reference, 0)), 'negative control: fade rests on its floor everywhere');
  for (const id of [0, 1, 2, 3]) assert.ok(dark(part(wire, id)), `Off removes lamp ${id}'s floor`);
  assert.deepEqual(part(wire, 4), part(reference, 4), 'the bar keeps the floor');
});

test('a scope keeps the whole-rig output when it names every fixture, and changes nothing with defaults', () => {
  for (const patch of [{ effect: hdGap }, { pattern: 'chase', paletteOverride: [colour] }]) {
    const all = engine({ ...patch, background: { ...fixed, fixtures: 'selected', selected: [0, 1, 2, 3, 4] } }), whole = engine({ ...patch, background: fixed });
    const rig = engine({ ...patch, background: { ...DEFAULT_BACKGROUND, fixtures: 'wash' } }), none = engine(patch);
    for (const now of [0, 300, 700]) {
      assert.deepEqual(all.draw(now), whole.draw(now));
      assert.deepEqual(rig.draw(now), none.draw(now), 'Follow at 100 % is untouched whatever the scope');
    }
  }
});

test('overrides, a fixture blackout, Kill and the master blackout still win inside the scope', () => {
  const background = { ...fixed, fixtures: 'wash' };
  const pinned = fixtures.map((f) => (f.id === 1 ? { ...f, override: { enabled: true, r: 10, g: 20, b: 30, w: 40, a: 50, uv: 0, dim: 255 } }
    : f.id === 2 ? { ...f, override: { enabled: false, blackout: true, r: 0, g: 0, b: 0, w: 0 } } : f));
  const e = engine({ effect: hdGap, background, fixtures: pinned });
  const wire = e.draw(500);
  assert.ok(lit(part(wire, 0)), 'negative control: an unpinned lamp in scope takes the wash');
  assert.deepEqual(part(wire, 1).slice(0, 5), [10, 20, 30, 40, 50], 'the override replaces the background');
  assert.ok(dark(part(wire, 2)), 'a fixture blackout stays black');
  const kill = { id: 'kill', spec: validateSpec({ kind: 'energy.kill' }), targets: null, tier: 'voice', launchSeq: 1,
    startedAtMs: 0, untilMs: null, anchorBeat: 0, seed: [1, 2, 3, 4] };
  assert.ok(dark(engine({ effect: hdGap, background }).draw(500, { voices: [kill] })), 'Kill owns black above the scoped wash');
  assert.ok(dark(engine({ effect: hdGap, background }).draw(500, { masterBlackout: true })), 'Blackout owns the final output');
});

test('voices and sequence clips take the scope per fixture', () => {
  const table = { revision: 0, lanes: [{ id: 'l', kind: 'shared', name: 'l', mute: false, solo: false }],
    clips: [{ id: 'gap', laneId: 'l', fixtureIds: null, startBeat: 0, lengthBeats: 4, loopBeats: 4, spec: hdGap, seed: [1, 2, 3, 4], mute: false }] };
  const pad = { id: 'pad', spec: validateSpec(bundleSpec({ patternId: 'p', lengthBeats: 4, table }, false), { internal: true }),
    targets: null, tier: 'voice', launchSeq: 1, startedAtMs: 0, untilMs: null, anchorBeat: 0, seed: [1, 2, 3, 4] };
  const voiced = engine({ background: { ...fixed, fixtures: 'selected', selected: [2] } }).draw(500, { voices: [pad] });
  assert.ok(lit(part(voiced, 2)), 'the selected lamp fills the pad gap');
  for (const id of [0, 1, 3, 4]) assert.ok(dark(part(voiced, id)), `fixture ${id} keeps the pad's own black`);

  const e = engine({ background: { ...fixed, fixtures: 'wash' } });
  e.renderer.setSequence({ revision: 1, lanes: table.lanes, clips: table.clips });
  const sequenceTransport = { startBeat: 0, generation: 0, loop: null };
  const clipped = e.draw(0, { sequenceRevision: 1, sequenceTransport });
  for (const id of [0, 1, 2, 3]) assert.ok(lit(part(clipped, id)), `the clip's gap fills lamp ${id}`);
  assert.ok(dark(part(clipped, 4)), 'the bar keeps the clip gap black');
});

test('the rehearsal preview applies the same scope as the renderer', () => {
  const rig = buildRig(fixtures, (f) => profiles[f.profileId]);
  for (const background of [{ ...fixed, fixtures: 'wash' }, { ...fixed, fixtures: 'selected', selected: [0, 4] }, { ...off, fixtures: 'wash' }]) {
    for (const [pattern, effect] of [['chase', null], ['gap-test', hdGap], ['fade', null]]) {
      const e = engine({ pattern, effect, background, paletteOverride: null });
      const preview = createPreviewSampler([{ timeMs: 0, action: 'patch', data: { ...look, pattern, paletteOverride: null } }], null,
        { background, profiles, resolveEffect: () => effect, safety: look.safety });
      for (let tick = 0; tick < 12; tick++) {
        const now = tick * 1000 / 44;
        const wire = e.draw(now), shown = preview(now, fixtures, COLOR_PRESETS, rig).flatMap((c) => ['r', 'g', 'b', 'w', 'a', 'uv'].map((k) => c[k] ?? 0));
        wire.forEach((value, index) => assert.ok(Math.abs(value - shown[index]) <= 1,
          `${pattern}/${background.mode}/${background.fixtures} byte ${index} at ${now}: ${value}/${shown[index]}`));
      }
    }
  }
});

test('the scope persists through the restart record and cue recall with Restore saved background', (t) => {
  const scoped = { ...fixed, fixtures: 'selected', selected: [3, 1] };
  applyPatch({ pattern: 'solid', background: scoped });
  const cue = captureLook();
  assert.deepEqual(state.background, scoped);
  applyPatch({ background: { ...off, fixtures: 'wash', selected: [3, 1] } });
  recallLook(cue);
  assert.equal(state.background.fixtures, 'wash', 'an ordinary recall keeps the operator background, scope included');
  recallLook(cue, true);
  assert.deepEqual(state.background, scoped);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'background-scope-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'look.json');
  new LookStore(file).save(currentLook(null));
  applyPatch({ background: DEFAULT_BACKGROUND });
  assert.equal(putBack(new LookStore(file).load()), true);
  assert.deepEqual(state.background, scoped);
  applyPatch({ background: DEFAULT_BACKGROUND });
});

test('a background saved before scopes existed reads as the whole rig; invalid scopes are refused', () => {
  assert.deepEqual(backgroundSchema.parse(DEFAULT_BACKGROUND), DEFAULT_BACKGROUND);
  assert.equal(backgroundSchema.parse(fixed).fixtures, undefined);
  applyPatch({ background: fixed });
  for (const background of [{ ...fixed, fixtures: 'all' }, { ...fixed, fixtures: 'selected', selected: [1, 1] },
    { ...fixed, selected: [-1] }, { ...fixed, selected: [1.5] }, { ...fixed, selected: '1' }, { ...fixed, scope: 'wash' }]) {
    assert.throws(() => validate(patchSchema, { background }, 'set'), JSON.stringify(background));
  }
  assert.deepEqual(state.background, fixed);
  applyPatch({ background: DEFAULT_BACKGROUND });
});

test('the stored setting leaves out the whole rig and an unused pick, so a build without scopes still reads it', () => {
  const base = { version: 1, mode: 'fixed', level: .3, colour };
  applyPatch({ background: { ...base, fixtures: 'rig', selected: [1, 2] } });
  assert.deepEqual(state.background, base, 'whole rig: the record has exactly the fields it had before scopes');
  assert.deepEqual(captureLook().background, base);
  applyPatch({ background: { ...base, fixtures: 'wash', selected: [1, 2] } });
  assert.deepEqual(state.background, { ...base, fixtures: 'wash' });
  applyPatch({ background: { ...base, fixtures: 'selected', selected: [2, 1] } });
  assert.deepEqual(state.background, { ...base, fixtures: 'selected', selected: [2, 1] });
  applyPatch({ background: DEFAULT_BACKGROUND });
});
