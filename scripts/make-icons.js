// Run node scripts/make-icons.js to rebuild the SVG, PNG and Windows icons from one design.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const OUT = path.join(import.meta.dirname, '..', 'public', 'icons');

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

const BG = [15, 23, 42];
const SHAPES = [
  { colour: [34, 211, 238], points: [[24, 49], [38, 49], [28, 78], [13, 78]] },
  { colour: [167, 139, 250], points: [[44, 49], [56, 49], [59, 78], [41, 78]] },
  { colour: [251, 191, 36], points: [[62, 49], [76, 49], [87, 78], [72, 78]] },
  { colour: [248, 250, 252], points: [[22, 22], [78, 22], [78, 32], [55, 32], [55, 47], [45, 47], [45, 32], [22, 32]] },
];

function inside(x, y, points) {
  let hit = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i], [xj, yj] = points[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

const hex = (colour) => `#${colour.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" rx="22" fill="${hex(BG)}"/>
${SHAPES.map(({ colour, points }) => `  <polygon points="${points.map((p) => p.join(',')).join(' ')}" fill="${hex(colour)}"/>`).join('\n')}
</svg>
`;

/** The colour at a point of the picture, 0..1 across; null where it is transparent. */
function paint(x, y, { maskable }) {
  const cx = x - 0.5;
  const cy = y - 0.5;
  if (!maskable) {
    const half = 0.5;
    const r = 0.22;
    const qx = Math.abs(cx) - (half - r);
    const qy = Math.abs(cy) - (half - r);
    const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
    if (outside > 0) return null;
  }
  // Maskable platforms crop to a circle: keep the mark inside their 80% safe area.
  const scale = maskable ? 0.78 : 1;
  const px = (cx / scale + 0.5) * 100;
  const py = (cy / scale + 0.5) * 100;
  for (const { colour, points } of SHAPES) if (inside(px, py, points)) return colour;
  return BG;
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

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, '..', 'icon.svg'), svg);
console.log('wrote public/icon.svg');
for (const [name, size, opts] of [
  ['icon-192.png', 192, { maskable: false }],
  ['icon-512.png', 512, { maskable: false }],
  ['icon-maskable-512.png', 512, { maskable: true }],
  ['apple-touch-icon.png', 180, { maskable: true }],
]) {
  fs.writeFileSync(path.join(OUT, name), draw(size, opts));
  console.log(`wrote public/icons/${name}`);
}
fs.writeFileSync(path.join(OUT, '..', 'favicon.ico'),
  ico([16, 32, 48, 256].map((size) => ({ size, data: draw(size, { maskable: false }) }))));
console.log('wrote public/favicon.ico');
