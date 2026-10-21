import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { messageOf } from './errors.ts';
import { ffmpegCommand } from './tools.ts';

const KNOWN_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.mp4', '.aac', '.alac', '.aiff', '.aif', '.wma', '.opus']);

async function toWav(inputPath: string, outputPath: string): Promise<string> {
  const ffmpeg = await ffmpegCommand();
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, [
      '-y', '-hide_banner', '-loglevel', 'error', '-i', inputPath,
      '-vn', '-ar', '44100', '-ac', '2', '-f', 'wav',
      outputPath,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    let stderr = '';
    proc.stderr.on('data', (d) => { if (stderr.length < 4096) stderr += d; });
    proc.on('error', (err) => reject(new Error(`ffmpeg not found: ${messageOf(err)}`)));
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg failed (exit ${code}): ${stderr.trim()}`));
      resolve(outputPath);
    });
  });
}

async function audioToTempWav(data: Uint8Array, fileName: string): Promise<string> {
  const ext = path.extname(fileName || '').toLowerCase();
  const id = randomUUID();
  const original = path.join(os.tmpdir(), `lightshow-audio-${id}${KNOWN_EXTENSIONS.has(ext) ? ext : ''}`);
  const wav = path.join(os.tmpdir(), `lightshow-audio-${id}-decoded.wav`);
  await fsp.writeFile(original, data);
  try {
    return await toWav(original, wav);
  } catch (err) {
    await fsp.unlink(wav).catch(() => {});
    throw err;
  } finally {
    await fsp.unlink(original).catch(() => {});
  }
}

const HEAD_BYTES = 64 * 1024;

function readAt(fd: number, position: number, length = HEAD_BYTES): Buffer {
  const buf = Buffer.alloc(length);
  return buf.subarray(0, fs.readSync(fd, buf, 0, length, position));
}

function wavSeconds(head: Buffer, fileBytes: number): number | null {
  let byteRate = 0;
  for (let at = 12; at + 8 <= head.length;) {
    const id = head.toString('ascii', at, at + 4);
    const size = head.readUInt32LE(at + 4);
    if (id === 'fmt ' && at + 20 <= head.length) byteRate = head.readUInt32LE(at + 16);
    // The bytes on disk, not the declared size: a WAV written to a pipe never gets its size filled in.
    if (id === 'data') return byteRate > 0 ? (fileBytes - at - 8) / byteRate : null;
    at += 8 + size + (size & 1);
  }
  return null;
}

function id3Bytes(head: Buffer): number {
  if (head.length < 10 || head.toString('latin1', 0, 3) !== 'ID3') return 0;
  const size = ((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f);
  return 10 + size + (head[5] & 0x10 ? 10 : 0);
}

function flacSeconds(head: Buffer): number | null {
  // STREAMINFO is always the first block: 20-bit rate, then a 36-bit sample count (0 = unknown).
  if (head.length < 26 || (head[4] & 0x7f) !== 0) return null;
  const rate = (head[18] << 12) | (head[19] << 4) | (head[20] >> 4);
  const samples = (head[21] & 0x0f) * 2 ** 32 + head.readUInt32BE(22);
  return rate > 0 && samples > 0 ? samples / rate : null;
}

interface MpegFrame { bytes: number; samples: number; rate: number; kbps: number; v1: boolean; mono: boolean; layer: number }

// kbit/s by bitrate index 1-14: MPEG-1 layers I-III, then MPEG-2/2.5 layer I and layers II-III.
const KBPS = [
  [32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  [32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  [32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
];

function mpegFrame(buf: Buffer, at: number): MpegFrame | null {
  if (at + 4 > buf.length || buf[at] !== 0xff || (buf[at + 1] & 0xe0) !== 0xe0) return null;
  const version = (buf[at + 1] >> 3) & 3;
  const layer = 4 - ((buf[at + 1] >> 1) & 3);
  const index = buf[at + 2] >> 4;
  const rateIndex = (buf[at + 2] >> 2) & 3;
  if (version === 1 || layer === 4 || index === 0 || index === 15 || rateIndex === 3) return null;
  const v1 = version === 3;
  const rate = [44100, 48000, 32000][rateIndex] / (v1 ? 1 : version === 2 ? 2 : 4);
  const kbps = KBPS[v1 ? layer - 1 : Math.min(layer, 2) + 2][index - 1];
  const samples = layer === 1 ? 384 : layer === 3 && !v1 ? 576 : 1152;
  const padding = (buf[at + 2] >> 1) & 1;
  const bytes = layer === 1
    ? (Math.floor(12000 * kbps / rate) + padding) * 4
    : Math.floor(125 * samples * kbps / rate) + padding;
  return { bytes, samples, rate, kbps, v1, mono: buf[at + 3] >> 6 === 3, layer };
}

function mp3Seconds(body: Buffer, bodyAt: number, fileBytes: number): number | null {
  for (let at = 0; at + 4 <= body.length; at++) {
    const frame = mpegFrame(body, at);
    if (!frame) continue;
    // A real stream's next frame follows at the length this one declares: random bytes rarely do.
    const next = mpegFrame(body, at + frame.bytes);
    if (!next || next.v1 !== frame.v1 || next.layer !== frame.layer || next.rate !== frame.rate) continue;
    // VBR files count their frames in a Xing/Info or VBRI header in the first frame.
    const xing = at + 4 + (frame.v1 ? (frame.mono ? 17 : 32) : (frame.mono ? 9 : 17));
    const tag = body.toString('latin1', xing, xing + 4);
    let frames = 0;
    if ((tag === 'Xing' || tag === 'Info') && xing + 12 <= body.length && body.readUInt32BE(xing + 4) & 1) {
      frames = body.readUInt32BE(xing + 8);
    } else if (body.toString('latin1', at + 36, at + 40) === 'VBRI' && at + 54 <= body.length) {
      frames = body.readUInt32BE(at + 50);
    }
    if (frames > 0) return frames * frame.samples / frame.rate;
    return (fileBytes - bodyAt - at) * 8 / (frame.kbps * 1000);
  }
  return null;
}

// Seconds of audio in a WAV, FLAC or MP3, from its headers; null for anything else, which would need a decoder.
function audioDurationSec(file: unknown): number | null {
  if (typeof file !== 'string') return null;
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const fileBytes = fs.fstatSync(fd).size;
    const head = readAt(fd, 0);
    let seconds: number | null;
    if (head.length >= 12 && head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WAVE') {
      seconds = wavSeconds(head, fileBytes);
    } else {
      const bodyAt = id3Bytes(head);
      const body = bodyAt ? readAt(fd, bodyAt) : head;
      seconds = body.toString('latin1', 0, 4) === 'fLaC' ? flacSeconds(body) : mp3Seconds(body, bodyAt, fileBytes);
    }
    return seconds !== null && Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  } catch (_) {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

export { toWav, audioToTempWav, audioDurationSec };
