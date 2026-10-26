# Effects v2, Phase A: the operator's effects in real 3D and classic 2D — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the effects the operator asked for (Light DJ's scatter strobe and its pseudo-3D rotation and wave effects; Hue Dynamics' neural analyser and its beat features) as v2 generators that sample the real room in metres, each with a classic 2D version, beside today's effects.

**Architecture:** A shared `UnitSpace` gives every output unit a position in metres from the Stage room's bindings, with the 2D plan as fallback. It reaches the renderer worker and the browser preview through one shared builder. Five new effect kinds (`v2.sweep`, `v2.shell`, `v2.orbit`, `v2.scatter`, `v2.neural`) share one set of modifiers (space, trigger, envelope, colour, background) and register like every other kind, so pads, cues, sequences, voices and the existing safety path play them unchanged. Nothing existing is removed in Phase A.

**Tech Stack:** Node 24+ running TypeScript directly (erasable syntax, explicit `.ts` imports), zod, `node --test`, Playwright, Preact client built with esbuild.

**Spec:** `docs/effects-v2.md` (fork main `f3f1a28`): sections "Target", "Next level", "3D space", "Steps" 0, 3, 4 and 5. Phase A covers steps 0, 3 and 4 plus the part of step 5 that builds the operator's list. Steps 1, 2 and 6 to 10 are Phase B, planned after the gate at the end of this plan.

## Global Constraints

- Every startup remains disarmed. Nothing in this plan arms outputs, and no task or verification arms them (`POST /api/outputs/arm` is never called outside an isolated e2e server).
- Preserve blackout, flash limits, photosensitivity acknowledgement, output shutdown and preview/output parity (AGENTS.md).
- Take the essence of Hue Dynamics and Light DJ, never their ids, row tables, frame clock or numeric quirks. New ids live under `v2.`; names describe behaviour ("Scatter Strobe", "Groove Wave"), never the apps.
- Never collapse an effect family into one fixed look: every generator exposes its parameters, and presets are parameter sets.
- Every v2 preset exists in two first-class forms: `room` (metric 3D) and `plan` (classic 2D plot). The 2D form is a look of its own, not a fallback.
- Rooms stay private: no room data, installation patch or fixture names from an installation are committed. Tests use synthetic rigs and rooms.
- Comment-only lines ≤ 20 % of nonblank lines per code file (AGENTS.md).
- `npm run check`, `npm run build:client` and the golden tests stay green after every task; browser behaviour is checked with `npm run test:e2e`.
- Units: positions in metres in the room frame (x = width, y = height above the floor, z = depth), speeds in metres per beat, rotations in turns per bar (4 beats), angles in degrees.

## Review Focus

- A rig with no Stage room imported: every v2 kind must render from the plan fallback with no exception, and `room` and `plan` forms must both light something.
- A room that binds only some units: unbound units take the plan fallback and appear in the disagreement report; no unit is skipped or doubled.
- A tempo change mid-effect (120 → 174 BPM): phase continues without a jump larger than one step, in both the renderer and the preview.
- Scatter Strobe before the photosensitivity acknowledgement: it must not flash (the kind declares `rapidFlash: true`), and after acknowledgement a Hue lamp never flashes faster than its hardware cap.
- A unit count of a few thousand (a pixel curtain plus strips): one render stays inside the existing render budget test.

---

### Task 1: Golden frames with a numeric frame diff

**Files:**
- Create: `tests/fixtures/rigs/synthetic-room.json` (a synthetic room: 6 pars at known heights, 2 Hue lamps, one pathed 30-cell strip, one vertical 12 × 8 grid, two anchors `speakerLeft`/`speakerRight`, listeners `desk` and `couch`)
- Create: `scripts/golden-frames.js`
- Create: `tests/unit/golden-frame-diff.test.js`
- Modify: `scripts/golden-party-looks.js` (export its rig builders for reuse; no behaviour change)

**Interfaces:**
- Produces: `frameDiff(a: number[][], b: number[][]): { maxChannel: number; units: number }` in `scripts/golden-frames.js` (largest absolute channel difference across all units and frames; units = count of units with any difference); `renderGolden(ids: string[], rig: 'flat' | 'placed' | 'synthetic', beats: number[]): Record<string, number[][]>`.

- [ ] **Step 1: Write the failing test** — `frameDiff` of identical frames is `{ maxChannel: 0, units: 0 }`; changing one channel of one unit by 3 gives `{ maxChannel: 3, units: 1 }`; `renderGolden(['solid'], 'synthetic', [0, 1.25])` returns one entry with as many rows as the synthetic rig has units and is identical on a second call.
- [ ] **Step 2: Run** `node --test tests/unit/golden-frame-diff.test.js` — expected FAIL (module missing).
- [ ] **Step 3: Implement** `scripts/golden-frames.js` on top of the renderer setup in `scripts/golden-party-looks.js` (BPM 120, fixed seed, disarmed renderer, frames read from the universe store).
- [ ] **Step 4: Run** the test — expected PASS; `npm run check` green.
- [ ] **Step 5: Commit** `test(golden): per-unit frames and a numeric frame diff`.

### Task 2: Optional anchors and listeners in the room schema

**Files:**
- Modify: `src/shared/room-scene.ts` (`roomSceneSchema`)
- Test: `tests/unit/room-scene.test.js` (create if absent)

**Interfaces:**
- Produces: `RoomScene.anchors?: { id: string; label?: string; position: Vec3 }[]` (≤ 32) and `RoomScene.listeners?: { id: string; label?: string; position: Vec3; facingDeg: number }[]` (≤ 8), both inside `bounds`, ids unique across `anchors`, `listeners`, `rooms`, `objects` and `bindings`. `version` stays `1`.

- [ ] **Step 1: Write the failing tests** — a version-1 room without the new fields still parses unchanged; a room with anchor `speakerLeft` at (1, 0.9, -0.4) and listener `desk` at (1, 1.15, 0.8) facing 90 parses; an anchor outside `bounds` fails with "Position is outside the room bounds"; a duplicate id between an anchor and a binding fails with "Duplicate id".
- [ ] **Step 2: Run** `node --test tests/unit/room-scene.test.js` — expected FAIL.
- [ ] **Step 3: Implement** both optional arrays in the schema and reuse the existing bounds and id checks.
- [ ] **Step 4: Run** the tests and `npm run check` — expected PASS.
- [ ] **Step 5: Commit** `feat(room): optional anchors and listeners`.

### Task 3: The unit space

**Files:**
- Create: `src/shared/space.ts`
- Test: `tests/unit/space.test.js`

**Interfaces:**
- Consumes: `Rig` (`src/shared/rig.ts`), `RoomScene` (Task 2).
- Produces:
  - `interface Vec3 { x: number; y: number; z: number }`; `interface Listener extends Vec3 { facingDeg: number }`
  - `interface UnitSpace { revision: string; n: number; x: Float32Array; y: Float32Array; z: Float32Array; size: Float32Array; bound: Uint8Array; bounds: { width: number; depth: number; height: number }; anchors: Readonly<Record<string, Vec3>>; listeners: Readonly<Record<string, Listener>> }` — indexed like `rig.units`; `size` is the emitter radius in metres; `bound` is 1 for a unit placed by a binding, 0 for the plan fallback.
  - `buildUnitSpace(rig: Rig, room: RoomScene | null): UnitSpace`
  - `interface SpaceReport { unbound: number[]; shared: number[]; far: { unit: number; metres: number }[] }`; `spaceReport(rig: Rig, room: RoomScene | null, space: UnitSpace): SpaceReport` (`far` = bound units more than 1 m from their plan fallback)
  - `interface RoomSpace { x: Float32Array; y: Float32Array; z: Float32Array; size: Float32Array; bounds: UnitSpace['bounds']; listener: Listener; anchors: Readonly<Record<string, Vec3>> }`; `roomSpaceOf(list: readonly number[], space: UnitSpace, listenerId?: string | null): RoomSpace` (gathers `space` into effect-room order; lamp rooms average their cells)

- [ ] **Step 1: Write the failing tests** with the synthetic rig and room from Task 1:
  - a point binding at (1, 2, 0.5) places its unit there with `bound = 1`;
  - a 2-cell strip binding with path (0,1,0)→(2,1,0) places its cells at x = 0.5 and x = 1.5;
  - a weighted-mean binding gives every source unit the binding's position;
  - an unbound par at plot (25, 50) with `position.height` 50 in bounds 4 × 4 × 2.6 lands at (−1, 1.3, 0) with `bound = 0` (x = (plot.x/100 − 0.5)·width, z = (plot.y/100 − 0.5)·depth, y = height/100·boundsHeight);
  - `size` is 0.15 for a Hue lamp, half the cell pitch for strip and grid cells, 0.1 for a par;
  - with no room, every unit uses the fallback and `spaceReport` lists every unit as unbound;
  - with no listener in the room, `roomSpaceOf(..., null).listener` is the room centre at 1.2 m with `facingDeg` 0;
  - `revision` changes when a binding moves and stays the same for an identical rebuild.
- [ ] **Step 2: Run** `node --test tests/unit/space.test.js` — expected FAIL.
- [ ] **Step 3: Implement** `src/shared/space.ts`. Move the binding resolution in `public-src/stage3d/world.js:126-179` here and make `world.js` import it, so the Stage and the engine share one resolver.
- [ ] **Step 4: Run** the tests, `npm run check` and `npm run build:client` — expected PASS; the Stage e2e specs still pass.
- [ ] **Step 5: Commit** `feat(space): unit positions in metres from the room, plan fallback and report`.

### Task 4: The space reaches the renderer, the effect room and the preview

**Files:**
- Modify: `src/shared/room.ts` (`Room` gains `space?: RoomSpace`)
- Modify: `src/shared/effects/layer.ts` (`effectRoom(layout: Layout, space?: UnitSpace | null): Room`, memoised by `layout.units` and `space.revision`; both call sites pass the renderer's space)
- Modify: `src/server/engine-messages.ts` (`ToWorker` gains `{ type: 'space'; space: UnitSpace | null }`), `src/server/engine-worker.ts` (`case 'space'`), `src/server/renderer.ts` (`Renderer.setSpace(space: UnitSpace | null): void`)
- Modify: the server code that posts `'profiles'` to the worker: rebuild the space with `buildUnitSpace` when the rig signature or the room revision changes and post `'space'`
- Modify: `src/shared/preview.ts` (`PreviewOptions.space?: UnitSpace | null`, passed into `effectRoom`); the client builds it from the room it already loads
- Add route: `GET /api/stage/room/report` returning `spaceReport` (read-only)
- Test: `tests/unit/preview-parity.test.js` (extend), `tests/unit/space-plumbing.test.js`

**Interfaces:**
- Consumes: Task 3.
- Produces: every effect kind's `render(params, state, room, frame, out)` can read `room.space` (room order) and `room.lamps?.space` (lamp order); absent space means plan-only.

- [ ] **Step 1: Write the failing tests** — after `setSpace` on a renderer with the synthetic rig, a probe kind sees `room.space.x.length === room.n`; the preview and the renderer give identical frames for `solid` with and without a space; `GET /api/stage/room/report` lists every unit as unbound when no room is imported.
- [ ] **Step 2: Run** the two test files — expected FAIL.
- [ ] **Step 3: Implement** the plumbing listed above.
- [ ] **Step 4: Run** the tests, `npm run check`, `npm run build:client` and the existing golden tests — expected PASS with a zero frame diff for every existing id.
- [ ] **Step 5: Commit** `feat(space): renderer, effect room and preview share the unit space`.

### Task 5: Shared v2 modifiers

**Files:**
- Create: `src/shared/effects/v2/common.ts`
- Test: `tests/unit/effects-v2-common.test.js`

**Interfaces:**
- Consumes: `Trigger`, `Curve` and `Band` (`src/shared/effects/types.ts`), the envelope evaluation in `src/shared/effects/envelope.ts`, `AudioFrame`.
- Produces:
  - `v2CommonSchema`: zod object with `space: 'room' | 'plan'` (default `'room'`), `trigger: Trigger` (default `{ mode: 'timeline', band: 'full', beatInterval: 1, threshold: 0.15, reactiveDepth: 1 }`), `envelope: { curve: Curve; attack: number; hold: number; release: number }` in beats (default linear 0 / 0.25 / 0.5), `colour: 'along' | 'time' | 'solid'` (default `'along'`), `background: number` 0..1 (default 0)
  - `type V2Common = z.output<typeof v2CommonSchema>`
  - `positionsOf(room: Room, space: 'room' | 'plan'): { x: ArrayLike<number>; y: ArrayLike<number>; z: ArrayLike<number>; size: ArrayLike<number>; bounds: { width: number; depth: number; height: number } }` — `plan` maps the plot to a unit box (x and z from the plot, y from height, bounds 1 × 1 × 1, size 0.02)
  - `triggerLevel(common: V2Common, frame: EffectFrame): number` — 1 for `timeline`; beat-accent pulses on each `beatInterval` with the envelope; `volumeGate` follows the band level above `threshold`; scaled by `reactiveDepth`
  - `soft(distance: number, width: number, size: number): number` — a smooth crest of `width` widened by the emitter `size` (field averaged over the emitter)
  - `paint(common, frame, position01: number, level: number, out: EffectSlot)` — colour from the palette by `colour` mode, level with `background` floor

- [ ] **Step 1: Write the failing tests** — `soft(0, 0.3, 0)` is 1 and `soft(0.6, 0.3, 0)` < 0.01; `soft(0.3, 0.1, 0.3)` > `soft(0.3, 0.1, 0)`; `triggerLevel` with `beatAccent` and interval 1 is ≥ 0.99 at beat 2.0 and ≤ 0.05 at beat 2.75 for the default envelope; `volumeGate` with threshold 0.15 is 0 for band level 0.1 and ~0.53 for 0.6; `positionsOf(room, 'plan')` ignores `room.space`.
- [ ] **Step 2: Run** — expected FAIL.
- [ ] **Step 3: Implement** `common.ts`.
- [ ] **Step 4: Run** — expected PASS; `npm run check` green.
- [ ] **Step 5: Commit** `feat(effects-v2): shared space, trigger, envelope and colour modifiers`.

### Task 6: Light DJ's pseudo-3D in real 3D: Sweep and Shell

**Files:**
- Create: `src/shared/effects/v2/sweep.ts`, `src/shared/effects/v2/shell.ts`
- Modify: `src/shared/effects/index.ts` (import both before the catalogue)
- Test: `tests/unit/effects-v2-sweep-shell.test.js`

**Interfaces:**
- Consumes: Task 5.
- Produces: kinds registered with `app: 'own'`, `level: 'cell'`:
  - `v2.sweep` params = common + `azimuthDeg` (0), `elevationDeg` (0; 90 = floor to ceiling), `profile: 'crest' | 'line' | 'comet' | 'gradient' | 'stripe'` ('crest'), `width` m (0.6; plan units in `plan` space), `speed` m/beat (1.5), `motion: 'loop' | 'bounce' | 'random'` ('loop'), `turnPerLap` deg (0)
  - `v2.shell` params = common + `origin: 'listener' | 'centre' | 'anchor' | 'random'` ('anchor'), `anchor` id ('speakerLeft'; falls back to centre when missing), `alsoAnchor` id or null ('speakerRight'), `profile: 'ring' | 'fill' | 'ramp'` ('ring'), `direction: 'out' | 'in'` ('out'), `width` m (0.5), `speed` m/beat (2), `twistDeg` per metre (0; non-zero gives a vortex)

- [ ] **Step 1: Write the failing tests** on the synthetic room:
  - Sweep at elevation 90, width 0.3, speed 1.3 m/beat: at beat 0 a unit at y 0 is ≥ 0.99 and a unit at y 2.6 ≤ 0.01; at beat 1 a unit at y 1.3 is ≥ 0.9;
  - the same preset in `plan` space lights by plot rows, not height, and ignores the room;
  - Shell from `speakerLeft` with speed 2: at 0.5 beat after a beat-accent trigger, units 1 m from the anchor are ≥ 0.9 and units 3 m away ≤ 0.05; with `alsoAnchor` both speakers ring;
  - a twisted shell (`twistDeg` 90) lights a spiral: two units at the same distance but 90° apart around the origin peak a quarter wavelength apart;
  - without a room both kinds fall back to the plan with no exception;
  - a tempo change from 120 to 174 BPM at beat 8 moves the Sweep crest by less than one `width` between consecutive frames, in the renderer and the preview alike.
- [ ] **Step 2: Run** — expected FAIL.
- [ ] **Step 3: Implement** both kinds on `positionsOf`, `soft`, `triggerLevel` and `paint`.
- [ ] **Step 4: Run** — expected PASS; frame diff of every existing id stays 0.
- [ ] **Step 5: Commit** `feat(effects-v2): Sweep and Shell, room and classic plan`.

### Task 7: Light DJ's rotation family in real 3D: Orbit

**Files:**
- Create: `src/shared/effects/v2/orbit.ts`
- Modify: `src/shared/effects/index.ts`
- Test: `tests/unit/effects-v2-orbit.test.js`

**Interfaces:**
- Produces: `v2.orbit` params = common + `axis: 'listener' | 'centre'` ('listener'), `profile: 'sectors' | 'gradient' | 'beacon'` ('beacon'), `sectors` (4), `beamDeg` (40), `turnsPerBar` (1), `heightTiltDeg` (0; tilts the beam with height so it climbs as it turns).

- [ ] **Step 1: Write the failing tests** — listener `desk` at the origin of the synthetic room: with `turnsPerBar` 1, a unit at azimuth 90° from the facing peaks at beat 1 and a unit at 270° at beat 3; `sectors` 4 alternates palette entries by quarter; the `plan` form rotates around the plot centre; a listener with `facingDeg` 90 shifts the peaks by one beat.
- [ ] **Step 2: Run** — expected FAIL.
- [ ] **Step 3: Implement** the kind.
- [ ] **Step 4: Run** — expected PASS.
- [ ] **Step 5: Commit** `feat(effects-v2): Orbit, rotation around the listener`.

### Task 8: Scatter and Scatter Strobe

**Files:**
- Create: `src/shared/effects/v2/scatter.ts`
- Modify: `src/shared/effects/index.ts`; `src/shared/effects/layer.ts` (the per-lamp flash permit covers `v2.scatter` whenever its spec is `rapidFlash`)
- Test: `tests/unit/effects-v2-scatter.test.js`

**Interfaces:**
- Produces: `v2.scatter` params = common + `density` (0.15 of units per step), `stepBeats` (0.25), `envelope` preset via common (`flash` = attack 0, hold 0.06, release 0.04 beats), `clusterM` (0 = single units; > 0 lights every unit within that radius of each pick, room space only), `bands` (none or a band list: a step fires only on a hit in those bands), `rapidFlash` from `rapidFlashWhen(params)` = stepBeats ≤ 0.25 and a flash envelope.

- [ ] **Step 1: Write the failing tests** — with seed fixed, density 0.25 over 1000 synthetic units lights 250 ± 25 units per step; the renderer and the preview pick the same units; `clusterM` 0.4 lights only units within 0.4 m of picked centres; before acknowledgement a `rapidFlash` Scatter Strobe outputs no flash (existing admission); a Hue unit is never re-flashed inside its hardware interval (existing hardware guard).
- [ ] **Step 2: Run** — expected FAIL.
- [ ] **Step 3: Implement** the kind with the repository's seeded hash (`src/shared/effects/hash.ts`).
- [ ] **Step 4: Run** — expected PASS; the strobe and flash-limit test files still pass.
- [ ] **Step 5: Commit** `feat(effects-v2): Scatter and Scatter Strobe`.

### Task 9: Hue Dynamics' neural analyser and beat features

**Files:**
- Create: `src/shared/effects/v2/neural.ts`
- Modify: `src/shared/effects/index.ts`
- Test: `tests/unit/effects-v2-neural.test.js`

**Interfaces:**
- Consumes: `AudioFrame` band powers and the running pitch/level reading the Disco Neural style already computes (`src/shared/effects/disco.ts`, function `neural`); expose that reading as an exported helper `neuralReading(heard: AudioFrame | null, state)` instead of duplicating it.
- Produces: `v2.neural` params = common + `layout: 'height' | 'distance' | 'zones'` ('height': bass low, mids at head height, highs at the ceiling; 'distance': bass at the speakers spreading out; 'zones': front/back/sides by band), `idle` 0..1 (0.08, the wash level with no music), `smoothing` (0.35), `pitchColour` (true: hue follows the reading's pitch).
- Beat features use `common.trigger` on every v2 kind; presets in Task 10 name them.

- [ ] **Step 1: Write the failing tests** — with an audio frame bass 1, mid 0, high 0 and layout `height`, units below 0.9 m are ≥ 0.8 and units above 1.8 m ≤ 0.1; with high 1 only, the reverse; with no audio the level is `idle`; with layout `distance`, bass lights units within 1 m of either speaker anchor first; the `plan` form maps bands to plot rows.
- [ ] **Step 2: Run** — expected FAIL.
- [ ] **Step 3: Implement** the kind and the exported helper; Disco keeps its behaviour (its tests pass unchanged).
- [ ] **Step 4: Run** — expected PASS.
- [ ] **Step 5: Commit** `feat(effects-v2): Neural, music in space`.

### Task 10: Presets, catalogue group and the Effects view

**Files:**
- Create: `src/shared/effects/v2/presets.ts`
- Modify: `src/shared/effects/catalogue.ts` (append `V2_PRESETS` as family `spatial`, group name "Spatial"), the Effects view component that lists groups, `README.md` (one section), `docs/effects-v2.md` ("Status" line: Phase A built)
- Test: `tests/unit/effects-v2-presets.test.js`, `tests/e2e/effects-v2.spec.js`

**Interfaces:**
- Produces: `V2_PRESETS: CataloguePreset[]` with ids and parameter sets, each in two rows: `v2.<name>` (room) and `v2.<name>.2d` (plan):
  - Scatter Strobe, Scatter Fade, Scatter Grow, Popcorn (`v2.scatter` with band hits)
  - Groove Wave, Big Room Wave, Ascent (elevation 90), Double Wave, Swagger (`v2.sweep`)
  - Impact, Vortex, Speaker Shockwave (`v2.shell`)
  - Rotation, Swirl, Beacon (`v2.orbit`)
  - Neural, Neural Distance (`v2.neural`)
  - Beat Accent Wash, Volume Gate Wash, Frequency Burst (common trigger modes on `v2.sweep`/`v2.scatter`)

- [ ] **Step 1: Write the failing tests** — every preset validates with `validateSpec`; every room row has a `.2d` twin whose spec differs only in `space`; no v2 id collides with an existing id or alias; the Effects view shows a "Spatial" group listing these names in both forms (e2e, disarmed, with Preview look pressed before reading colours).
- [ ] **Step 2: Run** — expected FAIL.
- [ ] **Step 3: Implement** the presets, the group and the docs.
- [ ] **Step 4: Run** `npm run check`, `npm run build:client`, `npm run test:e2e` — expected PASS.
- [ ] **Step 5: Commit** `feat(effects-v2): Spatial presets in room and classic 2D`.

### Task 11: Goldens, performance and release (never armed)

**Files:**
- Create: `tests/fixtures/golden/v2-spatial.json`; `tests/unit/v2-golden.test.js`
- Modify: the render budget test (add a synthetic rig of 3,000 units with a 60 × 40 grid and two pathed strips)

- [ ] **Step 1:** Record golden frames for every v2 preset on the synthetic room with `scripts/golden-frames.js`; the test compares with `frameDiff` and fails on any `maxChannel` > 0.
- [ ] **Step 2:** Run the render budget test with each v2 preset as base — expected within the existing budget.
- [ ] **Step 3:** Open one pull request per task group (Tasks 1–4, 5–9, 10–11) on `tyclab/lightshow`, merge each when all CI jobs pass. Commits use the repository's noreply identity.
- [ ] **Step 4:** Deploy: bump the commit and image tag in tycpve `ansible/roles/docker_vm/files/voice/lightshow/docker-compose.yml` by MR, merge when green, play `deploy:lightshow` (it leaves outputs disarmed). Do not arm. Verify on the live Stage, disarmed, with Preview look pressed, that the Spatial group plays.
- [ ] **Step 5:** Upload anchors (`speakerLeft`, `speakerRight`) and listeners (`desk`, `couch`) into the private Stage room only through the room's own `PUT /api/stage/room` with `If-Match`, values from the operator's house model; never commit them.

## Gate: the operator's review

Phase A ends here. The operator plays the Spatial presets on the Stage and on the rig, arming the rig themselves. Phase B (steps 1, 2 and 6 to 10 of `docs/effects-v2.md`: dedupe, one flash limiter, the strobe overlay, aliases and the saved-effect migration, defaults and choreography, retiring the old engines, palettes) and the Particles showpieces (light orbs, 3D fireworks and rain) are planned after that review, with the operator's decisions on which old effects stay.

## Follow-up build — 2026-10-26

The operator approved implementation after reviewing the physical rig. This
supersedes Task 10's requirement to show both coordinate variants as separate
menu entries. Start from the freshly fetched main branch (`28905af`).

- [x] Show one entry per named effect in the catalogue, pad and sequence choices.
  Retain all existing ids, aliases and authored specs for saved shows. Preserve
  the selected mapping when opening a playing effect or an existing favourite.
- [x] Offer **Across layout** / **Through room** inside the effect only when its
  current settings use spatial coordinates. Wash, Breathe, path/random stepping
  and all-lamp strobing need no mapping switch. Explain the visible difference;
  keep the Stage camera's 2D/3D switch independent.
- [x] Put common colour, timing and shape controls first; move detailed geometry
  and modulation into Advanced. Built-in mapping changes should be playable
  without saving a new preset; preserve other draft edits when changing mapping.
- [x] Detect Hue entertainment conflicts across the whole bridge before starting
  a session. Name the occupied area, leave another app's stream alone, retry when
  released, and report failed enabled bridges in health. Test independent bridges,
  unknown identity, cancellation and recovery.
- [x] Run check, client build and the browser suite; document actual results.
  `npm run check`: 3697 unit and 4 performance tests pass. Browser suite (WebGL via
  SwiftShader): 251 pass, 1 skipped by design (touch sizing runs on the tablet project).

### Deferred physical-rig observations

Keep these in this plan, not in an issue tracker. No firmware or wiring experiment
is part of this build.

- **Curtain blip:** videos show an isolated colour flash just ahead of the wave,
  approximately one camera frame. A later sender capture was clean but was not
  simultaneous with the video, so it does not exclude the sender. WLED output
  timing and signal integrity remain hypotheses, not a confirmed root cause.
  Firmware already includes the older ESP32 RMT priority fix. A future investigation
  needs a simultaneous capture and a controlled output/wiring comparison.
- **Wave onset:** the shallow rising wave moves rapidly across vertical rows;
  coarse couch zones and palette brightness changes can make the onset look
  stepped. Tune against the real rig in a separate operator session; do not change
  saved looks or claim a hardware fix from preview smoothness.
- **Pale colour step:** the current palette's cyan-to-magenta RGB blend passes
  through pale lavender. This is not an explicit white flash. Palette tuning is
  separate from the isolated curtain blip.
