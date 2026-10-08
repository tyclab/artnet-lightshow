import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeBmp, cropRect, resizeArea, ppm } from '../bmp.js';

function bitmap(width, rows, topDown = false) {
  const height = rows.length, stride = Math.ceil(width * 3 / 4) * 4;
  const data = Buffer.alloc(54 + stride * height, 0xAA);
  data.write('BM'); data.writeUInt32LE(data.length, 2); data.writeUInt32LE(54, 10);
  data.writeUInt32LE(40, 14); data.writeInt32LE(width, 18); data.writeInt32LE(topDown ? -height : height, 22);
  data.writeUInt16LE(1, 26); data.writeUInt16LE(24, 28); data.writeUInt32LE(0, 30);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = 54 + (topDown ? y : height - y - 1) * stride + x * 3;
    const [r, g, b] = rows[y][x]; data[offset] = b; data[offset + 1] = g; data[offset + 2] = r;
  }
  return data;
}
const red = [255, 0, 0], green = [0, 255, 0], blue = [0, 0, 255], white = [255, 255, 255];

test('24-bit BMP preserves RGB and top-left order for either row direction with padding', () => {
  const rows = [[red, green, blue], [white, [10, 20, 30], [40, 50, 60]]];
  for (const topDown of [false, true]) {
    const image = decodeBmp(bitmap(3, rows, topDown));
    assert.deepEqual(image, { width: 3, height: 2, data: Buffer.from(rows.flat(2)) });
  }
});
test('BMP rejects malformed dimensions, unsupported alpha/compression and truncated payloads', () => {
  const valid = bitmap(1, [[red]]);
  for (const [offset, value, bytes] of [[18, -1, 4], [22, 0, 4], [28, 32, 2], [30, 1, 4], [10, 3, 4]]) {
    const broken = Buffer.from(valid);
    if (bytes === 2) broken.writeUInt16LE(value, offset); else broken.writeInt32LE(value, offset);
    assert.throws(() => decodeBmp(broken));
  }
  assert.throws(() => decodeBmp(valid.subarray(0, valid.length - 1)));
  assert.throws(() => decodeBmp(Buffer.alloc(10)));
});
test('center-cover crop preserves aspect and spatial orientation', () => {
  assert.deepEqual(cropRect(4, 2, 2, 2), { x: 1, y: 0, width: 2, height: 2 });
  const source = { width: 4, height: 2, data: Buffer.from([blue, red, green, blue, red, blue, white, red].flat()) };
  assert.deepEqual([...resizeArea(source, 2, 2).data], [red, green, blue, white].flat());
  const curtain = cropRect(1920, 1080, 68, 42);
  assert.ok(Math.abs(curtain.width / curtain.height - 68 / 42) < 1e-12);
  assert.equal(curtain.y, 0);
  assert.ok(curtain.x > 0);
});
test('area sampling averages all covered pixels and contain makes black letterbox', () => {
  const source = { width: 2, height: 2, data: Buffer.from([red, green, blue, white].flat()) };
  assert.deepEqual([...resizeArea(source, 1, 1).data], [128, 128, 128]);
  const strip = { width: 2, height: 1, data: Buffer.from([red, green].flat()) };
  assert.deepEqual([...resizeArea(strip, 2, 4, 'contain').data], [0,0,0,0,0,0,128,0,0,0,128,0,128,0,0,0,128,0,0,0,0,0,0,0]);
  assert.equal(ppm(source).subarray(0, 11).toString(), 'P6\n2 2\n255\n');
});
test('logical 68 by 42 output contains exactly 8568 RGB bytes without wiring remapping', () => {
  const source = { width: 68, height: 42, data: Buffer.alloc(68 * 42 * 3) };
  source.data.set(red, 0); source.data.set(green, (68 - 1) * 3); source.data.set(blue, (68 * 41) * 3);
  assert.deepEqual(resizeArea(source, 68, 42), source);
  assert.throws(() => resizeArea(source, 4097, 1));
});
