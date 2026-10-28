import { pxOf } from './stage-geometry.js';

// A bar cell as the stylesheet drew one per element: 7 px with 2 px corners, unlit
// #222, and a box-shadow of 0 0 6px -1px in its own colour. One canvas draws them
// all, so a rig of thousands of cells is a few paths a frame rather than thousands
// of styled elements to diff, restyle and composite.
const SIDE = 7;
const RADIUS = 2;
const UNLIT = '#222';
const GLOW_SPREAD = -1;
const GLOW_SIGMA = 3;

/** Each cell's centre in CSS pixels on a surface of `size`, as x, y pairs. */
export function cellCentres(points, size) {
  const out = new Float32Array(points.length * 2);
  points.forEach((point, i) => {
    const at = pxOf(size, point);
    out[i * 2] = at.x;
    out[i * 2 + 1] = at.y;
  });
  return out;
}

function batches(count, colours) {
  const byColour = new Map();
  for (let i = 0; i < count; i++) {
    const colour = colours[i] || UNLIT;
    const cells = byColour.get(colour);
    if (cells) cells.push(i);
    else byColour.set(colour, [i]);
  }
  return byColour;
}

function draw(ctx, byColour, centres, side, radius) {
  const half = side / 2;
  // Square corners in a browser without roundRect.
  const shape = typeof ctx.roundRect === 'function'
    ? (x, y) => ctx.roundRect(x, y, side, side, radius)
    : (x, y) => ctx.rect(x, y, side, side);
  for (const [colour, cells] of byColour) {
    ctx.fillStyle = colour;
    ctx.beginPath();
    for (const i of cells) shape(centres[i * 2] - half, centres[i * 2 + 1] - half);
    ctx.fill();
  }
}

/**
 * Clear `ctx` and paint every cell; `glow` is a context of the same backing size
 * for the bloom, blurred once onto `ctx` beneath all the cells, or null for none.
 * `size.scale` is backing pixels per CSS pixel.
 */
export function paintCells(ctx, glow, { scale = 1 }, centres, colours) {
  const byColour = batches(centres.length / 2, colours);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  if (glow) {
    glow.setTransform(1, 0, 0, 1, 0, 0);
    glow.clearRect(0, 0, glow.canvas.width, glow.canvas.height);
    glow.setTransform(scale, 0, 0, scale, 0, 0);
    draw(glow, byColour, centres, SIDE + 2 * GLOW_SPREAD, RADIUS + GLOW_SPREAD);
    ctx.filter = `blur(${GLOW_SIGMA * scale}px)`;
    ctx.drawImage(glow.canvas, 0, 0);
    ctx.filter = 'none';
  }
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  draw(ctx, byColour, centres, SIDE, RADIUS);
}
