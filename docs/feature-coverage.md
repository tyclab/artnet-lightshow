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

## Show workflows

The source show workflows map onto these controls:

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
of unique physical-lamp identity. Stage can draw one marker per physical lamp
that averages its contributing channels by segment length; the engine still
renders per channel. Physical-lamp topology in the engine needs a separate
migration and device acceptance; it must preserve the deployed patch and output
mapping.

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
