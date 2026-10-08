# Port coverage and remaining workflows

This application combines the lighting workflows of Hue Dynamics 2.1.13 and
Light DJ 5.2.4. It is not a complete replacement for both source applications.
The October 8, 2026 source audit compared their supplied decompiled definitions
and reachable workflows against `ec558e5`, whose runtime behaviour matched the
deployed `2b539dc` release. Later fixes must be validated separately.

## What the catalogue establishes

The inventory accounts for all 172 Light DJ effect enum values: 132 ordinary
effects, eight macros, five commands, eight internal entries and 19 excluded
entries. The ordinary effects and macros plus 22 bitmap patterns yield 162
playable Light DJ presets. Hue Dynamics contributes all 16 named Party presets,
ten Party families and 11 Disco presets.

These are inventory counts, not a percentage of application parity or evidence
that every original runtime branch has been replayed. Engine regressions cover
the implemented contracts; browser tests separately cover reachable controls.
Physical optical timing and device limits need hardware acceptance.

## Remaining application workflows

The broader source workflows below have not been implemented. They were not
part of the earlier effect-engine release, but are required before claiming
complete Party/show application parity:

| Workflow | Current limit |
|----------|---------------|
| Per-show master settings and pad layouts | Audio master settings and pads are global; loading a sequence does not recall a show-owned bundle |
| Named pad-layout library | No save/open/rename/delete library or portable lane/content remapping |
| Clip groups and custom clip names | No grouped move/edit or custom per-row names |
| Undo/redo | No sequence edit history |
| Recoverable workspace | Explicit shelf saves persist; a discard warning does not recover unsaved work after a crash |
| Guided BPM capture | Live tempo detection exists; no source-style capture/progress/confidence workflow saved into a show |
| Starter/generated playlists | No source-compatible library-to-playlist generator or source starter-playlist templates |
| Immediate command rows | Sequence commands execute during playback; there is no standalone command-row performance surface |
| Random initial palette | No new random initial palette on every sequence start |
| Standalone tempo/brightness automation | Automation belongs to a sequence |

Complete direct live Visualizer colour controls also need completion before the
included workflow scope can be called finished. API support alone does not
establish an accessible browser workflow.

## Deliberate scope and behaviour differences

The original design excluded home ambiences, experiences/DLC, sound effects,
sensor/switch programming, whole-home backup imports, proprietary cloud/account
services, non-entertainment device modes and platform-specific app lifecycle.
Nanoleaf/LIFX-specific and dormant video/voxel features are also outside that
scope. Supporting a fixture protocol does not recreate those application modes.

The consolidated engine has its own ownership, safety and transport contract.
Stop can retain a frozen picture; Unload returns ownership to the base look.
Independent voices replace source-controller mutual exclusion. Sequence `goto`
targets a beat rather than switching to another saved playlist. Random palette
overrides have explicit application semantics. These are documented adaptations,
not exact source behaviour.

## Physical identity and Stage

A Hue Entertainment channel can represent more than one physical lamp, and a
gradient lamp can span channels. A channel-shaped fixture is therefore not proof
of unique physical-lamp identity. That topology needs a separate migration and
device acceptance; it must preserve the deployed patch and output mapping.

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

The reviewed upstream revision `cac3618a` contains the `2b539dc` release but also
changes fixture migration and output rendering. Its generic Hue migration drops
fixtures without `channels[]`, and an isolated renderer probe found drawn
strobes bypassing the device flash cap. Those blockers need fixes and regression
coverage before that upstream state can be adopted. No rebase or upstream merge
was performed as part of this workflow audit.
