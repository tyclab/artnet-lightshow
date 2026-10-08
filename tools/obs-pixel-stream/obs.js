import { createHash } from 'node:crypto';
import { decodeBmp, resizeArea } from './bmp.js';

export async function connectObs(config, onClose = () => {}) {
  const ws = new globalThis.WebSocket(`ws://127.0.0.1:${config.port}`);
  const pending = new Map();
  let sequence = 0, ready = false;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error('OBS authentication timed out')); ws.close(); }, 3000);
    const fail = () => { clearTimeout(timer); reject(new Error('OBS connection unavailable')); };
    ws.addEventListener('error', fail);
    ws.addEventListener('close', () => {
      ready = false; fail();
      for (const p of pending.values()) p.reject(new Error('OBS disconnected'));
      pending.clear(); onClose();
    });
    ws.addEventListener('message', ({ data }) => {
      let message;
      try { message = JSON.parse(data); } catch { fail(); ws.close(); return; }
      if (message.op === 0) {
        const auth = message.d?.authentication;
        if (!auth || typeof auth.salt !== 'string' || typeof auth.challenge !== 'string') { fail(); ws.close(); return; }
        const sha = x => createHash('sha256').update(x).digest('base64');
        ws.send(JSON.stringify({ op: 1, d: { rpcVersion: 1, authentication: sha(sha(config.password + auth.salt) + auth.challenge), eventSubscriptions: 0 } }));
      } else if (message.op === 2) { clearTimeout(timer); ready = true; resolve(); }
      else if (message.op === 7) {
        const p = pending.get(message.d?.requestId);
        if (!p) return;
        pending.delete(message.d.requestId);
        if (message.d.requestStatus?.result) p.resolve(message.d.responseData);
        else p.reject(new Error('OBS request rejected'));
      }
    });
  });
  return {
    get connected() { return ready && ws.readyState === 1; },
    close() { ws.close(); },
    call(requestType, requestData = {}) {
      if (!ready || ws.readyState !== 1) return Promise.reject(new Error('OBS disconnected'));
      return new Promise((resolve, reject) => {
        const requestId = String(++sequence);
        const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('OBS request timed out')); }, 750);
        pending.set(requestId, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
        ws.send(JSON.stringify({ op: 6, d: { requestId, requestType, requestData } }));
      });
    },
  };
}

export async function sceneCapture(obs, options) {
  const { scenes } = await obs.call('GetSceneList');
  if (!scenes?.some(s => s.sceneName === options.scene)) throw new Error('The selected OBS scene does not exist');
  const video = await obs.call('GetVideoSettings');
  if (![video.baseWidth, video.baseHeight].every(x => Number.isInteger(x) && x > 0 && x <= 16384)) throw new Error('Invalid OBS canvas dimensions');
  const scale = 4 * Math.max(options.width / video.baseWidth, options.height / video.baseHeight);
  const imageWidth = Math.ceil(video.baseWidth * scale), imageHeight = Math.ceil(video.baseHeight * scale);
  if (imageWidth > 4096 || imageHeight > 4096 || imageWidth * imageHeight > 4_194_304) throw new Error('OBS canvas aspect ratio exceeds capture limit');
  return async () => {
    const screenshot = await obs.call('GetSourceScreenshot', { sourceName: options.scene, imageFormat: 'bmp', imageWidth, imageHeight });
    if (typeof screenshot.imageData !== 'string' || !screenshot.imageData.startsWith('data:image/bmp;base64,') || screenshot.imageData.length > 18_000_000) throw new Error('Invalid OBS BMP response');
    const bitmap = decodeBmp(Buffer.from(screenshot.imageData.slice(22), 'base64'));
    if (bitmap.width !== imageWidth || bitmap.height !== imageHeight) throw new Error('Unexpected OBS capture size');
    return resizeArea(bitmap, options.width, options.height, options.fit);
  };
}
