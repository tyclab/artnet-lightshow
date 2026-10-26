# AGENTS.md — Lightshow

Node/TypeScript lighting server, Preact client and optional Python analysis.
README owns operator controls, protocols and setup; keep it aligned with code.

- Keep this public repo free of private addresses, deployment identities,
  personal/employer details and source-application names. Secrets never enter
  logs, browser state or tracked files.
- Every startup remains disarmed. Preserve blackout, flash limits, photosensitivity
  acknowledgement, output shutdown and preview/output parity. Never fetch model
  weights during a show. Do not arm physical outputs without authorization.
- Fetch and inspect incoming work before editing; preserve concurrent branches
  and use an isolated worktree when changes overlap.
- Target this fork explicitly with `gh ... --repo tyclab/lightshow`; verify the
  PR URL before sharing it. Do not open upstream PRs. Preserve configured merge
  defaults and hooks; use the repo-local identity or GitHub noreply email.
- Node 24+ runs TypeScript directly: erasable syntax, explicit .ts imports and
  import type. Browser sources are in public-src/; do not commit generated bundles
  or installation data. Generated schema types are regenerated, never hand-edited.
- Keep the server as the show orchestrator, with displays as separate clients.
  Scope changes preserve the output safety contract.

Keep code/config comments at or below 20% of nonblank lines; preserve licenses,
tool directives and runtime descriptions. Only the operator may grant a documented,
file-specific exception. See the shared [maintenance policy](https://github.com/tyclab/flakelab/blob/main/docs/agents/maintenance.md)
for exclusions and counting rules. Remove code only with evidence that behavior and
callers are preserved; keep README commands and diagrams aligned with code.

## Read before the task

- TypeScript, Python, analysis schema, Hue or output behavior:
  [implementation contracts](docs/agents/implementation.md).
- Tests, browser motion, Nix or dependency work:
  [validation and traps](docs/agents/validation.md).
- Display capture or a dark visualizer: [visualizer troubleshooting](docs/agents/visualizer.md).
- Deployment, external ports or integration changes:
  [deployment and show safety](docs/agents/deployment.md).

Keep repository-wide instructions here; put task-specific guidance in `docs/agents/`
and link it from this file. README owns human setup and architecture; plans hold open work only.
