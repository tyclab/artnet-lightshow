// Run node scripts/make-icons.js to rebuild favicon.svg, the PNGs and the
// Windows icon from one design: the TycStation Krake on its favicon tile.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const PUBLIC = path.join(import.meta.dirname, '..', 'public');
const OUT = path.join(PUBLIC, 'icons');

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function png(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;   // bit depth
  header[9] = 6;   // RGBA
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// The favicon: a 64-unit tile, the Krake at translate(32 30) scale(0.23),
// stroked with the poles gradient (blue, violet, red) left to right.
const TILE = { size: 64, radius: 14, fill: [0x0e, 0x14, 0x20] };
const MARK = { x: 32, y: 30, scale: 0.23 };
const POLES = [[0, [0x5a, 0xa2, 0xff]], [0.48, [0x8b, 0x6c, 0xf0]], [1, [0xff, 0x4a, 0x3d]]];
const ARMS = [
  'M-40,22 C-70,24 -97,40 -105,64 C-111,83 -97,95 -85,87 C-76,81 -79,69 -88,69',
  'M-28,31 C-50,45 -69,64 -71,88 C-72,105 -59,114 -49,106 C-41,99 -45,88 -54,89',
  'M-15,36 C-26,60 -34,82 -30,103 C-27,118 -14,123 -8,113',
  'M-5,37 C-7,60 -10,79 -6,95',
];
const HEAD = 'M-53,-2 C-53,-42 -30,-66 0,-66 C30,-66 53,-42 53,-2 C53,20 30,35 0,35 C-30,35 -53,20 -53,-2 Z';
const HEAD_FILL = [0x0b, 0x10, 0x18];
const EYE = { fill: [0xb4, 0x8c, 0xf5], cx: 19, cy: -10, rx: 8, ry: 9.5 };
const MOUTH = 'M-9,12 C-4,17 4,17 9,12';
const STROKE = 13;
const MOUTH_STROKE = 9;

const hex = (colour) => `#${colour.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
const armsSvg = (indent) => ARMS.map((d) => `${indent}<path d="${d}"/>`).join('\n');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${TILE.size} ${TILE.size}" width="${TILE.size}" height="${TILE.size}" role="img" aria-label="TycStation">
  <title>TycStation — Krake mark</title>
  <defs>
    <linearGradient id="poles" x1="0" y1="0" x2="1" y2="0">
      ${POLES.map(([at, colour]) => `<stop offset="${Math.round(at * 100)}%" stop-color="${hex(colour)}"/>`).join('')}
    </linearGradient>
  </defs>
  <rect width="${TILE.size}" height="${TILE.size}" rx="${TILE.radius}" fill="${hex(TILE.fill)}"/>
  <g transform="translate(${MARK.x} ${MARK.y}) scale(${MARK.scale})" fill="none" stroke="url(#poles)" stroke-linecap="round" stroke-linejoin="round" stroke-width="${STROKE}">
    <g>
${armsSvg('      ')}
      <g transform="scale(-1,1)">
${armsSvg('        ')}
      </g>
    </g>
    <path d="${HEAD}" fill="${hex(HEAD_FILL)}"/>
    <g stroke="none" fill="${hex(EYE.fill)}"><ellipse cx="-${EYE.cx}" cy="${EYE.cy}" rx="${EYE.rx}" ry="${EYE.ry}"/><ellipse cx="${EYE.cx}" cy="${EYE.cy}" rx="${EYE.rx}" ry="${EYE.ry}"/></g>
    <path d="${MOUTH}" stroke-width="${MOUTH_STROKE}"/>
  </g>
</svg>
`;

const CELL = 8;   // mark units per grid cell, for looking up the segments near a point
const cellKey = (cx, cy) => (cx + 64) * 256 + (cy + 64);

/** A path of M and C commands, as a polyline with its bounding box and the
 *  segments bucketed by the cells a stroke of `width` can reach. */
function flatten(d, width, steps = 24) {
  const tokens = d.match(/[MCZ]|-?\d*\.?\d+/g);
  const points = [];
  let i = 0;
  while (i < tokens.length) {
    const cmd = tokens[i++];
    if (cmd === 'M') {
      points.push([Number(tokens[i++]), Number(tokens[i++])]);
    } else if (cmd === 'C') {
      const [x0, y0] = points[points.length - 1];
      const [x1, y1, x2, y2, x3, y3] = tokens.slice(i, i + 6).map(Number);
      i += 6;
      for (let s = 1; s <= steps; s++) {
        const t = s / steps, u = 1 - t;
        points.push([
          u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
          u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
        ]);
      }
    } else if (cmd === 'Z') {
      points.push(points[0]);
    }
  }
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  const half = width / 2;
  const cells = new Map();
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1], [bx, by] = points[i];
    for (let cy = Math.floor((Math.min(ay, by) - half) / CELL); cy <= Math.floor((Math.max(ay, by) + half) / CELL); cy++) {
      for (let cx = Math.floor((Math.min(ax, bx) - half) / CELL); cx <= Math.floor((Math.max(ax, bx) + half) / CELL); cx++) {
        const key = cellKey(cx, cy);
        if (!cells.has(key)) cells.set(key, []);
        cells.get(key).push(i);
      }
    }
  }
  return { points, cells, half, minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

/** Whether the point lies on the stroke: within half its width of the polyline. */
function near(x, y, { points, cells, half }) {
  const limit = half * half;
  const list = cells.get(cellKey(Math.floor(x / CELL), Math.floor(y / CELL)));
  if (!list) return false;
  for (const i of list) {
    const [ax, ay] = points[i - 1], [bx, by] = points[i];
    const dx = bx - ax, dy = by - ay;
    const len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len)) : 0;
    const ex = x - (ax + t * dx), ey = y - (ay + t * dy);
    if (ex * ex + ey * ey <= limit) return true;
  }
  return false;
}

function inside(x, y, { points }) {
  let hit = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i], [xj, yj] = points[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** The stroke, if the point is on it: the gradient runs across the path's own box. */
function stroked(x, y, shape) {
  if (!near(x, y, shape)) return null;
  const t = Math.max(0, Math.min(1, (x - shape.minX) / (shape.maxX - shape.minX)));
  let k = 1;
  while (k < POLES.length - 1 && POLES[k][0] < t) k++;
  const [t0, c0] = POLES[k - 1], [t1, c1] = POLES[k];
  const f = (t - t0) / (t1 - t0);
  return c0.map((v, n) => v + (c1[n] - v) * f);
}

const arms = ARMS.map((d) => flatten(d, STROKE));
const head = flatten(HEAD, STROKE);
const mouth = flatten(MOUTH, MOUTH_STROKE);

/** The colour at a point of the tile, 0..1 across; null outside its corners. */
function paint(x, y, { corners, inset }) {
  if (corners) {
    const r = TILE.radius / TILE.size;
    const qx = Math.abs(x - 0.5) - (0.5 - r);
    const qy = Math.abs(y - 0.5) - (0.5 - r);
    if (Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r > 0) return null;
  }
  // Mark coordinates: the tile's units, shrunk toward its centre when the
  // platform crops to a circle, then the mark's translate and scale undone.
  const tx = ((x - 0.5) / inset + 0.5) * TILE.size;
  const ty = ((y - 0.5) / inset + 0.5) * TILE.size;
  const mx = (tx - MARK.x) / MARK.scale;
  const my = (ty - MARK.y) / MARK.scale;
  let c = stroked(mx, my, mouth);
  if (c) return c;
  if (((Math.abs(mx) - EYE.cx) / EYE.rx) ** 2 + ((my - EYE.cy) / EYE.ry) ** 2 <= 1) return EYE.fill;
  c = stroked(mx, my, head);
  if (c) return c;
  if (inside(mx, my, head)) return HEAD_FILL;
  // The right arms are the left ones mirrored, gradient and all.
  for (const arm of arms) {
    c = stroked(mx, my, arm) || stroked(-mx, my, arm);
    if (c) return c;
  }
  return TILE.fill;
}

function draw(size, opts) {
  const rgba = Buffer.alloc(size * size * 4);
  const SS = 4;   // samples per pixel side, for smooth edges
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = paint((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size, opts);
          if (!c) continue;
          r += c[0]; g += c[1]; b += c[2]; a++;
        }
      }
      const i = (py * size + px) * 4;
      if (a) {
        rgba[i] = Math.round(r / a);
        rgba[i + 1] = Math.round(g / a);
        rgba[i + 2] = Math.round(b / a);
      }
      rgba[i + 3] = Math.round((a / (SS * SS)) * 255);
    }
  }
  return png(size, rgba);
}

/** An .ico of PNG images, which Windows reads from Vista on. */
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);             // an icon
  header.writeUInt16LE(images.length, 4);
  const entries = Buffer.alloc(16 * images.length);
  let offset = header.length + entries.length;
  images.forEach(({ size, data }, i) => {
    const at = i * 16;
    entries[at] = size >= 256 ? 0 : size;     // 0 means 256
    entries[at + 1] = size >= 256 ? 0 : size;
    entries.writeUInt16LE(1, at + 4);         // colour planes
    entries.writeUInt16LE(32, at + 6);        // bits per pixel
    entries.writeUInt32LE(data.length, at + 8);
    entries.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  return Buffer.concat([header, entries, ...images.map((image) => image.data)]);
}

const TILED = { corners: true, inset: 1 };
// A full-bleed square: the platform rounds or crops it, so the mark keeps
// to the inner 80 % where it may be cut to a circle.
const SQUARE = { corners: false, inset: 1 };
const MASKABLE = { corners: false, inset: 0.78 };

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(PUBLIC, 'favicon.svg'), svg);
console.log('wrote public/favicon.svg');
for (const [name, size, opts] of [
  ['icon-192.png', 192, TILED],
  ['icon-512.png', 512, TILED],
  ['icon-maskable-512.png', 512, MASKABLE],
  ['apple-touch-icon.png', 180, SQUARE],
]) {
  fs.writeFileSync(path.join(OUT, name), draw(size, opts));
  console.log(`wrote public/icons/${name}`);
}
fs.writeFileSync(path.join(PUBLIC, 'favicon.ico'),
  ico([16, 32, 48, 256].map((size) => ({ size, data: draw(size, TILED) }))));
console.log('wrote public/favicon.ico');
