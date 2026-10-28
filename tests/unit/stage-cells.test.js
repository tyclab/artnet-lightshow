// The stage plot's bar cells on one canvas, and the once-a-frame paint queue
// the DMX feed drives.

import test from 'node:test';
import assert from 'node:assert/strict';
import { cellCentres, paintCells } from '../../public-src/stage-cells.js';
import { placeAt } from '../../public-src/stage-geometry.js';
import { createFrameQueue } from '../../public-src/frame-paint.js';

/** A 2D context that records what is drawn, in order. */
function recorder(width = 2000, height = 1200) {
  const calls = [];
  const ctx = { canvas: { width, height }, fillStyle: '#000', filter: 'none' };
  for (const name of ['setTransform', 'clearRect', 'beginPath', 'roundRect', 'fill', 'drawImage']) {
    ctx[name] = (...args) => calls.push([name, ...args, ...(name === 'fill' ? [ctx.fillStyle] : name === 'drawImage' ? [ctx.filter] : [])]);
  }
  return { ctx, calls };
}

// placeAt's calc(), solved for a surface of the given size: what the browser placed a cell element at.
const cssCentre = (size, point) => {
  const solve = (expr, span) => {
    const [, inset, sub, k] = /calc\((\d+)px \+ \(100% - (\d+)px\) \* ([-\d.e]+)\)/.exec(expr);
    return Number(inset) + (span - Number(sub)) * Number(k);
  };
  const at = placeAt(point);
  return { x: solve(at.left, size.width), y: solve(at.top, size.height) };
};

test('cell centres are where a positioned cell element would sit on the surface', () => {
  const size = { width: 1000, height: 600 };
  const points = [{ x: 0, y: 0 }, { x: 100, y: 100 }, { x: 37.5, y: 61.25 }];
  const centres = cellCentres(points, size);
  points.forEach((point, i) => {
    const want = cssCentre(size, point);
    assert.ok(Math.abs(centres[i * 2] - want.x) < 1e-3 && Math.abs(centres[i * 2 + 1] - want.y) < 1e-3, `cell ${i}`);
  });
});

test('cells paint as one path per colour: a glow pass, then the 7 px cells over it', () => {
  const size = { width: 1000, height: 600, scale: 2 };
  const centres = cellCentres([{ x: 10, y: 10 }, { x: 20, y: 10 }, { x: 30, y: 10 }, { x: 40, y: 10 }], size);
  const colours = ['rgb(255,0,0)', 'rgb(0,0,255)', 'rgb(255,0,0)'];
  const target = recorder(), glow = recorder();
  paintCells(target.ctx, glow.ctx, size, centres, colours);

  const fills = (calls) => calls.filter((c) => c[0] === 'fill').map((c) => c.at(-1));
  assert.deepEqual(fills(glow.calls), ['rgb(255,0,0)', 'rgb(0,0,255)', '#222'], 'a missing colour draws unlit, as an unlit cell element did');
  assert.deepEqual(fills(target.calls), ['rgb(255,0,0)', 'rgb(0,0,255)', '#222']);
  const rects = (calls) => calls.filter((c) => c[0] === 'roundRect');
  // box-shadow 0 0 6px -1px: the glow is the cell one pixel smaller all round, blurred by a 6 px radius (σ 3 px).
  const [x0, y0] = [centres[0], centres[1]];
  assert.deepEqual(rects(glow.calls)[0].slice(1), [x0 - 2.5, y0 - 2.5, 5, 5, 1]);
  assert.deepEqual(rects(target.calls)[0].slice(1), [x0 - 3.5, y0 - 3.5, 7, 7, 2]);
  assert.equal(rects(target.calls).length, 4);
  const draw = target.calls.find((c) => c[0] === 'drawImage');
  assert.equal(draw[1], glow.ctx.canvas);
  assert.equal(draw.at(-1), 'blur(6px)', 'σ 3 CSS px at device scale 2');
  assert.ok(target.calls.indexOf(draw) < target.calls.findIndex((c) => c[0] === 'roundRect'), 'glow under the cells');
  assert.equal(target.ctx.filter, 'none');
  assert.deepEqual(target.calls.find((c) => c[0] === 'setTransform').slice(1), [1, 0, 0, 1, 0, 0]);
  assert.deepEqual(target.calls.filter((c) => c[0] === 'setTransform').at(-1).slice(1), [2, 0, 0, 2, 0, 0]);
});

test('without a glow layer the cells still paint', () => {
  const size = { width: 400, height: 300, scale: 1 };
  const target = recorder();
  paintCells(target.ctx, null, size, cellCentres([{ x: 50, y: 50 }], size), ['rgb(1,2,3)']);
  assert.deepEqual(target.calls.filter((c) => c[0] === 'fill').map((c) => c.at(-1)), ['rgb(1,2,3)']);
  assert.equal(target.calls.filter((c) => c[0] === 'drawImage').length, 0);
});

test('paint jobs asked for any number of times run once in the next frame', () => {
  const requested = [];
  const cancelled = [];
  const queue = createFrameQueue((fn) => { requested.push(fn); return requested.length; }, (handle) => cancelled.push(handle));
  const ran = [];
  const a = () => ran.push('a'), b = () => ran.push('b');
  for (let i = 0; i < 44; i++) { queue.schedule(a); queue.schedule(b); }
  assert.equal(requested.length, 1, 'one animation frame however many DMX frames arrived');
  requested[0](16);
  assert.deepEqual(ran, ['a', 'b']);
  queue.schedule(a);
  assert.equal(requested.length, 2);
  queue.cancel(a);
  assert.deepEqual(cancelled, [2], 'nothing left to paint: the frame is given back');
  requested[1](32);
  assert.deepEqual(ran, ['a', 'b']);
});
