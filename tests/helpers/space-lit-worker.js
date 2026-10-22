// The engine worker with the space-lit test kind registered first.
import './space-lit-kind.js';
await import('../../src/server/engine-worker.ts');
