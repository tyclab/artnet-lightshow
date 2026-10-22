# Effects v2

This is a plan to fold the effect engines into a few spatial generators that
sample one metric room. None of it is implemented yet; the [README](../README.md)
describes current behaviour. Paths and line numbers refer to `4d4837f`. The plan
was drawn up for a 41-fixture rig with a metre-accurate room model, but no part
of it depends on that rig.

## Where the effects stand

About 257 ids can be chosen as a base look: 41 base patterns plus the 216
catalogue rows (`src/shared/effects/catalogue.ts:292`). Eighteen of those rows
are the legacy Party Looks.

| Group | Count | Source |
|-------|-------|--------|
| Base patterns | 41 | `src/server/presets.ts:55-100`, bodies in `src/shared/patterns.ts` |
| Party Looks (`own.party`, legacy rows) | 18 | `catalogue.ts:235-256`, bodies `patterns.ts:885-1131` |
| Entertainment presets (`ldj.*`) | 162: 140 rows and 22 bitmap presets | `src/shared/effects/ldj-ids.ts`, `ldj-bitmap.ts:10-14` |
| Party presets (`hd.*`) | 16 over 10 families | `catalogue.ts:174-226`, `src/shared/effects/hd.ts:16-17` |
| Disco presets | 11 over one family | `src/shared/effects/disco.ts:174-217` |
| Energy effects | 7, including `palette-strobe` | `src/shared/effects/energy.ts`, `catalogue.ts:258-275` |
| Gentle Party looks | 2 | `catalogue.ts:277-290` |
| Strobe functions | 9 | `presets.ts:18-28`, `src/shared/strobe-fx.ts:84-95` |
| Built-in palettes | 54 | `src/server/palette-catalogue.ts` |
| Default pads | 16 | `src/server/pads.ts:123-140` |

The automatic paths are the look picker (`src/show/look.ts:42-59, 284-339`) and
the director's pools (`src/show/director.ts:1247-1300`). They choose only from
base patterns. No catalogue row is referenced from `src/show/`,
`src/auto-show.ts` or `src/server/conductor.ts`. The other 216 ids play only when
picked by hand or from a pad, cue, sequence or MIDI.

### Duplicates

1. `solid`, `fade`, `hit` and `strobe` have identical bodies
   (`patterns.ts:149-167`). They differ only by the brightness envelope in
   `src/shared/layer.ts:94-101` and the renderer's hardware strobe.
2. `ldj.PartyStrobe` and `ldj.MatrixPulse` are the same mode
   (`src/shared/effects/ldj-matrix.ts:30-31`).
3. `ramp-scatter` and `decay-scatter` draw the strobe programs `ramp-up-rnd` and
   `ramp-down-rnd` (`patterns.ts:706-717`, `strobe-fx.ts:86-90`). `flash-burst`
   approximates the `break` program.
4. Nine Party Looks re-implement `hd.*` families with fixed parameters
   (`patterns.ts:887-1024` against `hd.ts:258-301`), and the catalogue links
   them (`catalogue.ts:236-244`). The twins already disagree: the Looks sweep the
   floor plan, while `hd.*` sweeps the width–height plane (`patterns.ts:925, 948,
   969` against `hd.ts:275, 283, 290`).
5. The other nine Party Looks (anchor-fill, halves, flip, room-wave,
   ring-strobe, ring-backlit, fireworks, flashes, swirl) re-implement
   Entertainment rows (`patterns.ts:1026-1131` against `ldj-channel.ts`,
   `ldj-iteration.ts`, `ldj-rotation.ts`). `src/shared/room.ts:125, 254-294`
   copies the original's integer truncation so they match.
6. One shape under several names. MatrixFirework, SceneMakerFirework and
   Cauldron share one envelope (`ldj-matrix.ts:43-44`, `ldj-channel.ts:181-217`).
   The Visualizer spikes reuse the four matrix modes (`ldj-visualizer.ts:35-45`).
   `burst` is `impact` without sparks (`patterns.ts:342-353, 436-457`).
7. Parameter sets spelled out as ids:
   - chase, chase-rev, ping-pong, pairs, runner and stack-up are one stepper
     with a direction, window and trail (`patterns.ts:182-265`);
   - the 57 iteration rows are six builders times flags
     (`ldj-iteration.ts:39-80, 170-190, 224-271`);
   - the 22 bitmap presets are shape × width × fill × background;
   - about a dozen random-unit effects across the three libraries are one
     scatter with a density and an envelope.
8. Each of the five genre scores exists twice: once as a genre strobe
   (`ldj-iteration.ts:121-125, 224-225`) and once as a Scene Maker macro
   (`catalogue.ts:92-98`).

The 32 Entertainment table rows that are not effects (excluded, internal and
command entries; see [feature coverage](feature-coverage.md)) still sit in the
runtime table (`ldj-ids.ts:33-68`).

### Strobe, flash limits and clocks

Strobe is implemented eight times:

- the drawn programs (`src/shared/strobe-fx.ts`);
- the strobe kind and its `palette` function (`src/shared/effects/strobe.ts`);
- the held strobe voice (`src/server/strobe.ts`);
- the energy white and colour strobes and `palette-strobe` (`energy.ts`);
- the legacy look's hold strobe (`src/shared/look-math.ts:60-86`);
- the hardware channel and its software fallback
  (`src/shared/hardware-strobe.ts`);
- Disco's automatic strobe (`disco.ts`);
- about twenty strobe-shaped patterns and rows (`flash-*`, `ring-strobe`, the
  `ldj` strobe rows).

Flash limits are enforced in four places:

- the large-area limit of three flashes a second under `safety.flashLimit`
  (`src/server/flash-limit.ts`, bedd786);
- the per-lamp bright-rise interval for `hd.*` under `safety.hdFlashIntervalMs`
  (`src/shared/effects/flash-guard.ts`, 0c3c8e6);
- one permit per lamp shared by every voice (the same file, 108ac34);
- the device rate caps, 20 Hz for RGB by default and 5 Hz for Hue
  (`src/shared/hardware-guard.ts`, 287c10d and f6e939a).

There are four clocks:

- base patterns step at `beatDivision` (`layer.ts:108-123`);
- `hd.*` counts beats at 960 PPQ (`hd.ts:19`);
- `ldj.*` runs its own 22 fps frame clock (`src/shared/effects/ldj-engine.ts:13`),
  with True Strobe on wall time (`ldj-iteration.ts:226`);
- Disco counts wall-clock milliseconds (`disco.ts:1-5`).

### Geometry

- Effects sample the plan: plot x/y plus floor-to-ceiling z, all in 0..1
  (`StagePlan`, `src/shared/rig.ts:25-30`).
- A multi-cell fixture without `geometry.points` gets generated positions. A
  grid is laid flat in plot x/y, so a vertical panel's rows become plan depth,
  not height (`rig.ts:144-169`).
- `bars`, `fire`, `rain` and `core` read height from plan y
  (`patterns.ts:459-531, 683-705, 743-754`). They are correct only for that flat
  layout.
- `room.ts:96-154` scales each axis to its own span. Along, rank, halves,
  channels, wave distance and ring all ignore height (`room.ts:172-248,
  280-288`).
- Only the `hd.*` projection uses height (`room.ts:296-301`).
  `hd.radialPulse` measures 3D distance; the `hd.*` sweeps project onto width
  and height and ignore depth (`hd.ts:120-126, 263-277`).
- The Stage room (`src/shared/room-scene.ts`) holds metres, unit bindings,
  strip paths and weighted sources, but it is preview-only by design
  ([Rooms in Stage](stage-room.md)).
- The browser already resolves bindings to output units
  (`public-src/stage3d/world.js:126-179`). The engine does not.
- No effect, director or renderer has a listener position or facing.
- `geometry.points` with a per-unit `height` (#55: 807aed5, ff699df) is the first
  per-cell height input on the engine side.

## What the ports show

The `hd.*` port is ten families on one parameter set: curve,
attack/hold/release, direction, order, trail, probability, spatial angle,
origin and radius (`hd.ts:68-87`). Its presets are those parameters plus a
palette. The `ldj.*` port has nine families, and its rows are builder and flag
combinations (`ldj-iteration.ts`, `ldj-bitmap.ts`). Neither port has a listener.
Both use height only where noted above.

v2 keeps the structure of `hd.*`: a few kernels, shared modifiers, and presets
as parameter sets. It does not copy either app's ids, row tables, frame clock
or numeric quirks into the engine. Old ids survive as aliases of the nearest v2
preset.

## Target

There will be nine field generators and one strobe overlay. Each generator
combines a space selector, motion, an envelope, a colour mapping, modulation
and a background. Every one of these parameters is shared by all generators.

| Generator | Space | Absorbs |
|-----------|-------|---------|
| Wash | none: every unit at once | solid, fade, hit, color-cycle, breathe; `hd.simpleAdsr` presets, `hd.breathingFade`; ldj Glow, Drip, Trance, BeatPulse1/4, QuickFlash, CrossFade, America, MatrixSolid, TriPulse; energy glow, blinder, kill, UV wash |
| Sweep | a plane by azimuth and elevation (90° runs floor to ceiling). Profile is crest, line, comet, gradient or stripe; motion is loop, bounce, random or a turn per lap | wave, ribbon, gradient, comet, room-wave, spatial-wash, bounce-scan, streak, volume-gate (as gate modulation); `hd.spatialWash`, `volumeGateWash`, `bouncingScan`, `streak`; ldj GrooveWave, BigRoomWave, Ascent, DoubleWave, Swagger; the 22 bitmap presets |
| Shell | distance from an origin: the listener, room centre, an anchor or a random unit. A ring, fill or ramp, outward or inward | radial-pulse, burst, impact (sparks as a parameter), flash-fill, ramp, fireworks; `hd.radialPulse`; ldj Impact, Vortex, SceneMakerFirework, MatrixFirework, Cauldron, the Studio fireworks |
| Orbit | azimuth around a vertical axis through the listener. Sectors, gradient or beacon | swirl; ldj Swirl, Rotation, Beacon |
| Step | an order: orbit azimuth, an axis, the unit's own strip path, height or random. Takes a window, trail, direction, envelope (flash, fade, grow, flare), a background (off or a palette slot), stages (1, 3 or 5) and a score | chase, chase-rev, ping-pong, runner, pairs, stack-up, position-chase, flash-chase, flash-alternate, ring-strobe, ring-backlit; about 45 ldj iteration rows |
| Zones | a partition: left/right, front/back, floor/ceiling, near/far from the listener, technology or object role. Alternates, fills or rotates | split, sections, halves, flip, anchor-fill; ldj Split, Flip, FrontBack, RotatingHalfs, TwoCorners, FillCycle, DoubleFill, DoubleDrip |
| Scatter | random units with a density, an envelope (flash, ramp up, ramp down, swell), a cluster radius in metres and optional band triggers | twinkle, sparkle, random-flash, starlight, confetti, flashes, flash-scatter, ramp-scatter, decay-scatter; `hd.twinkle`, `hd.frequencyBurst`; ldj matrix modes, Popcorn; Disco Spectrum and Peak |
| Level | fill by height, by listener distance or along a path, driven by a band level or section progress | rise, meter, bars, fire, rain, core, stems, drums, ensemble; Disco Neural |
| Noise | a 3D noise field drifting through the room | plasma; ldj Perlin, NorthernLights; Fire and Ice |
| Strobe overlay | not a look: a deck voice over any base. Selection is all, step, scatter or zone; rate is a beat fraction or Hz under the device cap; shape is flash, ramp, random or burst; colour is palette or white | the eight strobe implementations; the `flash-*` strobe looks; ldj TrueStrobe, PaletteTrueStrobe |

About forty named presets sit on top of the generators as parameter sets. The
catalogue already resolves aliases (`catalogue.ts:23, 150`), so every retired
id stays playable as an alias. Saved cues, pads, sequences, the MIDI map
(`src/server/midi-map.ts:140-170`) and the Home Assistant palette selection all
refer to ids.

Macro (Scene Maker), bundle (pad pattern) and sequence remain the show layer.
The Entertainment Visualizer and Studio become a base and accent voice pair and
a pad launch mode instead of kinds.

## 3D space

1. **Unit positions in metres.** A shared map from `(fixtureId, unit)` to room
   coordinates, built from the room's bindings:
   - point bindings place their unit;
   - strip bindings spread their cells along `path`;
   - weighted-mean bindings give each source unit the lamp's position.

   The resolver in `public-src/stage3d/world.js:126-179` moves into
   `src/shared/`, so the renderer and the preview use one copy.
2. **Fallback for unbound units.** A plan-to-room transform stored as data in
   the room model. A unit without a binding keeps a position derived from its
   plot position and height.
3. **Listener and anchors.** A new room version adds an optional listening
   position with a facing, plus named anchor points. Without them, the listener
   falls back to the room centre and facing-dependent options are unavailable.
4. **Field primitives on one metric scale**, instead of one span per axis:
   - distance to a plane given by azimuth and elevation;
   - distance from a point;
   - azimuth around a vertical axis through the listener;
   - height above the floor;
   - position along the unit's own strip path;
   - neighbours within r metres, through a spatial hash;
   - 3D noise.

   A speed means the same thing in every direction.
5. **Cache.** The space is rebuilt only when the room revision
   (`GET /api/stage/room`) or `rigSignature` (`src/shared/rig.ts:204`) changes.
6. **Preview parity.** `src/shared/preview.ts` builds the same space from the
   room the browser already holds. `tests/unit/preview-parity.test.js` extends
   to it.
7. **Disagreement report.** For each unit: plan position against room
   position, plus unbound units and units shared between bindings. It is
   read-only, and it gates any effect that samples the room.

The generators keep a `plan` mode that samples today's 2D plan. Rooms stay
private: `config/stage-room.json` is not part of a public checkout, and nothing
in this plan commits room data or an installation's patch.

## Steps

Each step is its own pull request. Every step keeps `npm run check`,
`npm run build:client` and the golden tests green. AGENTS.md's safety
invariants hold throughout: disarmed startup, blackout, the flash limits, the
photosensitivity acknowledgement, output shutdown and preview/output parity.

| # | Step | Look risk | Verification |
|---|------|-----------|--------------|
| 0 | Golden harness: extend `scripts/golden-party-looks.js` (18 looks and 8 effects on synthetic pars) to every catalogue id, base pattern and strobe function, at fixed BPM, seed and beats. Add a committed synthetic rig with pars, Hue channels, pathed strips and a vertical grid. Add an optional local run against an installation's own config, never committed | none | deterministic hashes in CI |
| 1 | Byte-identical dedupe: one body for solid/fade/hit/strobe; `ldj.PartyStrobe` becomes an alias of `ldj.MatrixPulse`; `ramp-scatter`, `decay-scatter` and `flash-burst` call the strobe programs; the 32 non-effect rows leave the runtime catalogue | none while golden output is equal | golden diff is zero |
| 2 | One strobe overlay kind and one flash limiter in the output path. Energy strobes, `palette-strobe` and the hold strobe become overlay presets | timing; safety-relevant | golden; a rise-count probe shows no lamp exceeds today's admitted rate (5 Hz Hue cap, every fourth flash at full speed; 20 Hz RGB default; `hd.*` per-lamp interval; three large-area flashes a second when enabled); preview while disarmed |
| 3 | Space plumbing, unused by effects: binding resolver in `src/shared/`, plan fallback, listener and anchors in the room schema, preview parity, disagreement report | none | unit tests; the report on a real room through a read-only GET |
| 4 | v2 generators as new ids beside the old ones, each with a `plan` mode | none (additive) | golden for the new ids; Stage preview while disarmed |
| 5 | Re-express old ids as v2 presets in `plan` mode. Ids within tolerance become aliases; the rest are listed | none for aliases; listed ids need an operator decision | golden diff report per id |
| 6 | 3D defaults: the look picker, director pools and default pads move to height, listener and orbit presets | look change | Stage preview while disarmed, then the operator on the rig |
| 7 | Retire the `hd.*`, `ldj.*` and legacy engines and their clocks onto the conductor's beat clock; about forty named presets remain | look change for any id that is not aliased | golden for aliases, preview for the rest |
| 8 | Palettes: 54 built-ins to a curated set plus a hue-pair generator, in step with the Home Assistant palette selection | depends on the Home Assistant integration | catalogue check against the integration; palette golden |

## Open operator decisions

- Whether step 6 may change what the auto show and the default pads look like.
- Which ids that fail step 5's tolerance are kept as approximations and which
  are dropped at step 7.
- Whether step 8 may remove palettes, given that Home Assistant selects
  palettes by id.
- Whether the nine Party Looks merge into their `hd.*` twins. The twins already
  sweep different planes.
- Whether Disco folds into Scatter, Level and the strobe overlay, and whether
  the Entertainment Visualizer and Studio fold into voice pairs and a launch
  mode.
- Whether the room becomes authoritative for effect sampling. Today it is
  preview-only by design; until this is decided, generators default to `plan`
  mode and a room is sampled only when it is chosen explicitly.
- One listening position or several, and whether facing is part of the room or
  of the show.
