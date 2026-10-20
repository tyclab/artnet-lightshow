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

// Seconds of audio in a WAV, from its header; null for anything else, which would need a decoder.
function wavDurationSec(file: unknown): number | null {
  if (typeof file !== 'string') return null;
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(4096);
    const read = fs.readSync(fd, head, 0, head.length, 0);
    if (read < 12 || head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') return null;
    let byteRate = 0;
    for (let at = 12; at + 8 <= read;) {
      const id = head.toString('ascii', at, at + 4);
      const size = head.readUInt32LE(at + 4);
      if (id === 'fmt ' && at + 20 <= read) byteRate = head.readUInt32LE(at + 16);
      // The bytes on disk, not the declared size: a WAV written to a pipe never gets its size filled in.
      if (id === 'data') return byteRate > 0 ? (fs.fstatSync(fd).size - at - 8) / byteRate : null;
      at += 8 + size + (size & 1);
    }
    return null;
  } catch (_) {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

export { toWav, audioToTempWav, wavDurationSec };
