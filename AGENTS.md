# Repository instructions

TycStation Lightshow runs a Node/TypeScript lighting server, a Preact browser client
and an optional Python audio-analysis pipeline. Read README.md for operator
controls, protocols and deployment; keep it consistent with the implementation.

## Code and scope

- README files and agent instruction files are exempt from the comment limit
  by design. The limit applies to code and configuration files.
- Outside the limit (operator, 2026-10-08): vendored third-party code and
  third-party build output (kept byte-identical to upstream), Hugo site
  functional files, translation files, example/template configs whose comments
  document the schema, files under ten code lines, and approved runtime text
  such as MCP tool docstrings. Output of our own generators is inside it: fix
  the generator.
- Keep comment-only lines at or below 20% of nonblank lines in each code or
  configuration file. Count Python documentation strings; identify real comments
  with the language parser so embedded scripts and data remain intact.
- An operator must explicitly approve each exception with its path, reason and
  scope. No code-file exceptions are granted by this file. Preserve required
  legal notices, compiler/tool directives and runtime descriptions while seeking
  approval; never remove them to satisfy a metric.
- Retain concise explanations of units, invariants and failure handling. Remove
  repeated narration, obsolete scaffolding and unused code only with evidence
  that behavior and callers are preserved. Do not invent or remove features based
  on assumptions about demand.
- Keep repository guidance here, without duplicate CLAUDE.md or GEMINI.md files.
  Explain significant process changes with the README's Mermaid diagrams.
- Fetch/prune and inspect incoming branches before editing. Preserve concurrent
  work and use a separate branch for changes that overlap another agent's work.
- LightD31/artnet-lightshow is not a target (ruling 2026-10-26): no upstream pull
  requests and no upstream-first changes. Review what lands there by content only;
  fork copies carry other SHAs, so `git cherry` misleads. The README's Upstream
  integration section names the last reviewed commit.
- `gh pr create` and `gh pr merge` always take `--repo tyclab/lightshow`: this is a
  fork, and gh otherwise targets the parent ("No commits between main and <branch>"
  is the tell). Check that `gh pr view --json url` names tyclab before sharing it.
- The server stays the show orchestrator. Screens are a video pipeline combined by
  clock or DMX-in, never engine features. LedFx is retired; do not re-add it.
  Resolume Arena is parked: adopting it needs sACN/Art-Net input under voices and
  safety.
- Production on tycstation runs the commit pinned in tycpve
  `ansible/roles/docker_vm/files/voice/lightshow/docker-compose.yml` (`build.context`
  commit and `image:` tag change together; a Dockerfile-only change takes a
  `<sha>-N` tag), shipped by that repository's manual `deploy:lightshow` job, which
  leaves outputs disarmed. Other sessions move the pin: read it first. A token
  change reaches the server only at the next deploy.

## Implementation constraints

- Node 24+ runs TypeScript directly. Use erasable syntax, explicit `.ts`
  imports and `import type`; `tsc` checks types without generating runtime files.
- Edit browser code in `public-src/`; esbuild generates `public/app.bundle.js`
  and chunks. Do not commit generated assets or installation data.
- Every startup must remain disarmed. Preserve blackout, flash limits,
  photosensitivity acknowledgement, output shutdown and preview/output parity.
- Releasing a Hue Entertainment session leaves each lamp in its last streamed
  colour. Whatever disarms outside the party flow must restore or switch the
  lamps off afterwards.
- Hue application keys are revoked only at account.meethue.com; bridges refuse a
  local DELETE since API 1.31. Check which integration a key backs first.
- Keep access tokens and credentials out of logs, client state and tracked files.
- The analysis contract is `src/analysis/document.schema.json`. Regenerate
  `src/types/analysis.ts` with `npm run gen:analysis-types`; do not hand-edit it.
  In `src/analysis/version.py`, incompatible changes need a major schema bump,
  additive changes a minor bump; `MIN_COMPATIBLE` controls cache reanalysis.
  `src/analysis-cache.ts` reads it with a regex: keep the line as
  `MIN_COMPATIBLE = 'X.Y'`.
- Python worker stdout is NDJSON. Keep library logs on stderr and preserve CLI
  descriptions consumed through `__doc__`. Never fetch model weights during a show.

## Validation

Run `npm run check` and `npm run build:client` for JavaScript/TypeScript changes.
For browser behavior, run `npm run test:e2e` with Playwright Chromium installed.
For Python changes, run `python -m unittest discover -s tests/python -v` using the
analysis environment; report missing dependencies, skipped models and failures.
Validate comment edits with parser/AST comparisons as well as relevant tests.
Do not update golden outputs merely to make a failing check pass.

- Without WebGL (Playwright's headless shell from Nix has none) Stage falls back
  and every motion test reads zero. Run e2e with a config whose desktop project
  sets `channel: 'chromium'` and `launchOptions.args` `--use-gl=angle
  --use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist`, after
  `npm i --no-save @playwright/test@<version of the installed browsers>`. Stage
  motion is `stageMotion` in `tests/e2e/stage-image.js`; a stopped clock
  (`running: false`) is its zero control.
- On Nix, `npm run check` fails the MIDI tests with libasound `ERR_DLOPEN_FAILED`
  unless `LD_LIBRARY_PATH` holds
  `$(nix build --no-link --print-out-paths nixpkgs#alsa-lib)/lib`.
- `npm audit fix --omit=dev` prunes dev dependencies; run `npm install` after it.
- A flaky test is a race until proven otherwise. Reproduce it on `main`
  deterministically (`page.clock.install()` with `pauseAt` between action and
  reload, `page.routeWebSocket` delaying server frames, `kill -STOP` with the code's
  own accounting) and `git blame` the cause before touching assertions; repeated
  runs prove nothing. Tests that mock timers inject `now`. Timings inflate under
  the parallel suite and on a saturated host: measure rates on an idle one.
