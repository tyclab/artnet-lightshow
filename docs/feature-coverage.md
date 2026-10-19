# Feature coverage and remaining workflows

This application combines two effect scopes: Party & Disco (the `hd.*` kinds)
and Entertainment (the `ldj.*` kinds). The October 8, 2026 audit compared the
catalogue and the reachable workflows against `ec558e5`, whose runtime
behaviour matched the deployed `2b539dc` release. Later fixes must be validated
separately.

## What the catalogue establishes

The inventory accounts for all 172 Entertainment effect ordinals: 132 ordinary
effects, eight macros, five commands, eight internal entries and 19 excluded
entries. The ordinary effects and macros plus 22 bitmap patterns yield 162
playable Entertainment presets. Party & Disco contributes 16 named Party
presets, ten Party families and 11 Disco presets.

These are inventory counts, not a percentage of feature parity or evidence
that every runtime branch has been replayed. Engine regressions cover
the implemented contracts; browser tests separately cover reachable controls.
Physical optical timing and device limits need hardware acceptance.

## Show workflows

The show workflows map onto these controls:

| Workflow | Where |
|----------|-------|
| Per-show audio response and pads | Sequence → Edit → Show audio and pads; the show's `performance` |
| Named pad-layout library | Perform → Pads → Pad layouts: save, rename, recapture, delete, remap fixture slots |
| Clip groups and clip names | Sequence → Edit: clip name field; group, ungroup and move selected clips |
| Undo/redo | Sequence → Edit: shared history of whole sequence edits |
| Recoverable workspace | `config/sequence-workspace.json`; restart reopens the document stopped, a pending take in Review |
| Guided BPM capture | Perform and Sequence → Edit: 12-second capture from live input with lock and consistency checks |
| Starter/generated playlists | Sequence: Starter playlists and generator, previewed before it replaces the editor document |
| Immediate command rows | Sequence → Edit: Run now on each command row |
| Random initial palette | Sequence options: a random palette on each start |
| Standalone tempo/brightness automation | Perform: live automation on the running look, ended by a fader, stop, blackout, disarm or a sequence |
| Live Visualizer colours | Perform: colour controls shown while a Visualizer is the base |

Fire and Ice are the fork's gentle Party looks: slow, strobe-free Spatial Wash
and Breathing Fade presets with full-channel palettes.

## Deliberate scope and behaviour differences

The design excludes home ambiences, experiences/DLC, sound effects,
sensor/switch programming, whole-home backup imports, proprietary cloud/account
services, non-entertainment device modes and platform-specific app lifecycle.
Nanoleaf/LIFX-specific and dormant video/voxel features are also outside that
scope. Supporting a fixture protocol does not add such modes.

The consolidated engine has its own ownership, safety and transport contract.
Stop can retain a frozen picture; Unload returns ownership to the base look.
Independent voices replace controller mutual exclusion. Sequence `goto`
targets a beat rather than switching to another saved playlist. Random palette
overrides have explicit semantics. These are documented decisions.

## Physical identity and Stage

A Hue Entertainment channel can represent more than one physical lamp, and a
gradient lamp can span channels. A channel-shaped fixture is therefore not proof
of unique physical-lamp identity. Stage can draw one marker per physical lamp
that averages its contributing units by segment length. Newly patched physical
lamps use ordered `output.channels[]`; the array index is the fixture unit.
Legacy channel fixtures retain their mapping during migration. Discovery returns
both physical `lamps` and authoritative `channels` with segment membership, so
room exporters can join devices without guessing from labels. Physical ordering
and shared-channel behaviour still need device acceptance.

The [private room model](stage-room.md) supplies walls, furniture and explicit
preview bindings. It does not repair engine topology or relocate spatial
effects. Unresolved lights remain unplaced, and estimated coordinates stay
labelled as estimates. Never commit private floor plans, device identifiers or
credentials to this public repository.

## Fork policy

Tyclab maintains its own application and tested deployment revisions while
retaining attribution and the upstream remote. Review and adopt upstream changes
selectively. Rebase is not required to operate independently, and rewriting
published deployment history is unnecessary.

The earlier review of upstream `cac3618a` found two adoption blockers: legacy
Hue fixtures could be dropped during migration, and drawn strobes could bypass
the device flash cap. The consolidation merged in fork PR #27 addresses both
with migration and renderer regression coverage. These historical findings are
not outstanding blockers; physical device acceptance remains separate from the
automated checks.
