# Implementation contracts

Read for this topic; paths below are relative to the repository root unless stated otherwise.

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
