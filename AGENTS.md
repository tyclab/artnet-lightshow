# Repository instructions

ArtNet Lightshow runs a Node/TypeScript lighting server, a Preact browser client
and an optional Python audio-analysis pipeline. Read README.md for operator
controls, protocols and deployment; keep it consistent with the implementation.

## Code and scope

- README files and agent instruction files are exempt from the comment limit
  by design. The limit applies to code and configuration files.
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

## Implementation constraints

- Node 22.18+ runs TypeScript directly. Use erasable syntax, explicit `.ts`
  imports and `import type`; `tsc` checks types without generating runtime files.
- Edit browser code in `public-src/`; esbuild generates `public/app.bundle.js`
  and chunks. Do not commit generated assets or installation data.
- Every startup must remain disarmed. Preserve blackout, flash limits,
  photosensitivity acknowledgement, output shutdown and preview/output parity.
- Keep access tokens and credentials out of logs, client state and tracked files.
- The analysis contract is `src/analysis/document.schema.json`. Regenerate
  `src/types/analysis.ts` with `npm run gen:analysis-types`; do not hand-edit it.
  In `src/analysis/version.py`, incompatible changes need a major schema bump,
  additive changes a minor bump; `MIN_COMPATIBLE` controls cache reanalysis.
  `src/analysis-cache.ts` reads it with a regex: keep the line as
  `MIN_COMPATIBLE = 'X.Y'` (version.py is two lines, too short for a comment).
- Python worker stdout is NDJSON. Keep library logs on stderr and preserve CLI
  descriptions consumed through `__doc__`. Never fetch model weights during a show.

## Validation

Run `npm run check` and `npm run build:client` for JavaScript/TypeScript changes.
For browser behavior, run `npm run test:e2e` with Playwright Chromium installed.
For Python changes, run `python -m unittest discover -s tests/python -v` using the
analysis environment; report missing dependencies, skipped models and failures.
Validate comment edits with parser/AST comparisons as well as relevant tests.
Do not update golden outputs merely to make a failing check pass.
