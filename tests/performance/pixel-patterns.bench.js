import test from 'node:test';
import assert from 'node:assert';
import { panel, PULSE } from '../helpers/pixel-patterns.js';

test('panel effects fit the established matrix render budget', () => {
  // Relative CPU-work regression, including each pattern's first call.
  const cost = (id) => {
    let total = 0;
    for (let round = 0; round < 5; round++) {
      const started = performance.now();
      for (let k = 0; k < 6; k++) panel(id, 64, 32, { stepPos: k * 0.1, pulse: PULSE });
      total += (performance.now() - started) / 6 / 5;
    }
    return total;
  };
  const plasma = cost('plasma');
  for (const id of ['bars', 'fire', 'rain']) {
    const took = cost(id);
    assert.ok(took < plasma * 2.5 + 0.5, `${id}: ${took.toFixed(2)} ms a frame, plasma ${plasma.toFixed(2)} ms`);
  }
});

