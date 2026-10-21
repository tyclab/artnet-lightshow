// Audio files that are only their headers, sized on disk like the real thing, for duration probes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function place(name, bytes, size = bytes.length) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'audio-headers-')), name);
  fs.writeFileSync(file, bytes);
  if (size > bytes.length) fs.truncateSync(file, size);
  return file;
}

export function flacFile(seconds, { rate = 44100, samples = Math.round(seconds * rate), name = 'a.flac' } = {}) {
  const head = Buffer.alloc(42);
  head.write('fLaC', 0, 'latin1');
  head[4] = 0x80;
  head.writeUIntBE(34, 5, 3);
  head.writeUInt32BE(((rate << 12) | (1 << 9) | (15 << 4) | Math.floor(samples / 2 ** 32)) >>> 0, 18);
  head.writeUInt32BE(samples % 2 ** 32, 22);
  return place(name, head, 42 + Math.round(seconds * 4000));
}

export function id3Tag(bodyBytes) {
  const tag = Buffer.alloc(10 + bodyBytes);
  tag.write('ID3', 0, 'latin1');
  tag[3] = 4;
  [21, 14, 7, 0].forEach((shift, i) => { tag[6 + i] = (bodyBytes >> shift) & 0x7f; });
  return tag;
}

// MPEG-1 layer III, 44.1 kHz stereo, 128 kbit/s: 417-byte frames of 1152 samples.
export const FRAME_BYTES = 417;

export function mp3Frame({ xingFrames = null } = {}) {
  const frame = Buffer.alloc(FRAME_BYTES);
  frame.set([0xff, 0xfb, 0x90, 0x00]);
  if (xingFrames !== null) {
    frame.write('Xing', 36, 'latin1');
    frame.writeUInt32BE(1, 40);
    frame.writeUInt32BE(xingFrames, 44);
  }
  return frame;
}

export function mp3File(seconds, { xing = false, tagBytes = 0, name = 'a.mp3' } = {}) {
  const tag = tagBytes ? id3Tag(tagBytes) : Buffer.alloc(0);
  const frames = Math.round(seconds * 44100 / 1152);
  const lead = Buffer.concat([tag, mp3Frame({ xingFrames: xing ? frames : null }), mp3Frame()]);
  return place(name, lead, tag.length + Math.round(seconds * 16000));
}
