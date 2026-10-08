const limit = 4_194_304;

export function decodeBmp(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 54 || bytes.toString('ascii', 0, 2) !== 'BM') throw new Error('Invalid BMP header');
  const header = bytes.readUInt32LE(14), offset = bytes.readUInt32LE(10);
  const width = bytes.readInt32LE(18), signedHeight = bytes.readInt32LE(22), height = Math.abs(signedHeight);
  if (header < 40 || offset < 14 + header || width < 1 || height < 1 || width * height > limit) throw new Error('Invalid BMP dimensions');
  if (bytes.readUInt16LE(26) !== 1 || bytes.readUInt16LE(28) !== 24 || bytes.readUInt32LE(30) !== 0) throw new Error('Expected uncompressed 24-bit BMP');
  const stride = Math.ceil(width * 3 / 4) * 4;
  if (offset + stride * height > bytes.length) throw new Error('Truncated BMP pixels');
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    const row = offset + (signedHeight > 0 ? height - 1 - y : y) * stride;
    for (let x = 0; x < width; x++) {
      const src = row + x * 3, dst = (y * width + x) * 3;
      data[dst] = bytes[src + 2]; data[dst + 1] = bytes[src + 1]; data[dst + 2] = bytes[src];
    }
  }
  return { width, height, data };
}

export function cropRect(width, height, targetWidth, targetHeight, fit = 'cover') {
  if (![width, height, targetWidth, targetHeight].every(x => Number.isFinite(x) && x > 0)) throw new Error('Invalid resize dimensions');
  if (!['cover', 'contain'].includes(fit)) throw new Error('Unknown image fit');
  const scale = (fit === 'cover' ? Math.max : Math.min)(targetWidth / width, targetHeight / height);
  const w = targetWidth / scale, h = targetHeight / scale;
  return { x: (width - w) / 2, y: (height - h) / 2, width: w, height: h };
}

export function resizeArea(image, width, height, fit = 'cover') {
  if (![width, height].every(x => Number.isInteger(x) && x > 0) || width * height > 4096) throw new Error('Pixel grid must contain 1..4096 cells');
  if (image.data.length !== image.width * image.height * 3) throw new Error('Invalid RGB image');
  const crop = cropRect(image.width, image.height, width, height, fit);
  const dx = crop.width / width, dy = crop.height / height, area = dx * dy;
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const left = crop.x + x * dx, right = left + dx, top = crop.y + y * dy, bottom = top + dy;
    const sums = [0, 0, 0];
    for (let sy = Math.max(0, Math.floor(top)); sy < Math.min(image.height, Math.ceil(bottom)); sy++) {
      const wy = Math.max(0, Math.min(bottom, sy + 1) - Math.max(top, sy));
      for (let sx = Math.max(0, Math.floor(left)); sx < Math.min(image.width, Math.ceil(right)); sx++) {
        const weight = wy * Math.max(0, Math.min(right, sx + 1) - Math.max(left, sx));
        const offset = (sy * image.width + sx) * 3;
        for (let c = 0; c < 3; c++) sums[c] += image.data[offset + c] * weight;
      }
    }
    for (let c = 0; c < 3; c++) data[(y * width + x) * 3 + c] = Math.round(sums[c] / area);
  }
  return { width, height, data };
}

export function ppm(image) {
  return Buffer.concat([Buffer.from(`P6\n${image.width} ${image.height}\n255\n`), image.data]);
}
