/** Serialized into the dedicated page. GPU fences avoid blocking its render loop on readback. */
export async function gpuCapture(options, source, view, valid = () => true) {
  const dispose = (slot) => {
    slot.disposed = true;
    for (const item of slot.pending) slot.gl.deleteSync(item.sync);
    slot.pending.length = 0;
    slot.gl.getExtension('WEBGL_lose_context')?.loseContext();
  };
  const clear = () => {
    for (const slot of view?.__tyclabGpuCaptures?.values() || []) dispose(slot);
    if (view) delete view.__tyclabGpuCaptures;
  };
  if (options.mode === 'cleanup') { clear(); return null; }
  const { width, height, fit } = options;
  if (!options.visible) { clear(); return { ok: true, width, height, data: new Array(width * height * 3).fill(0) }; }
  if (typeof globalThis.WebGL2RenderingContext !== 'function') return null;
  const cache = view.__tyclabGpuCaptures ??= new Map(), key = `${width}x${height}:${fit}`;
  let slot = cache.get(key);
  if (slot && (slot.source !== source || slot.sourceWidth !== source.width || slot.sourceHeight !== source.height || slot.gl.isContextLost())) {
    dispose(slot); cache.delete(key); slot = null;
  }
  if (!slot) {
    if (cache.size >= 4) { for (const entry of cache.values()) dispose(entry); cache.clear(); }
    const canvas = globalThis.document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false });
    if (!gl) return null;
    try {
      const shader = (type, text) => {
        const result = gl.createShader(type); gl.shaderSource(result, text); gl.compileShader(result);
        if (!gl.getShaderParameter(result, gl.COMPILE_STATUS)) throw new Error('Capture shader unavailable');
        return result;
      };
      const vertex = shader(gl.VERTEX_SHADER, '#version 300 es\nin vec2 position;in vec2 uv;out vec2 tex;void main(){tex=uv;gl_Position=vec4(position,0.,1.);}');
      const fragment = shader(gl.FRAGMENT_SHADER, '#version 300 es\nprecision mediump float;uniform sampler2D image;in vec2 tex;out vec4 colour;void main(){colour=texture(image,tex);}');
      const program = gl.createProgram(); gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Capture program unavailable');
      gl.deleteShader(vertex); gl.deleteShader(fragment); gl.useProgram(program);
      const vertices = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vertices);
      for (const [name, offset] of [['position', 0], ['uv', 8]]) {
        const at = gl.getAttribLocation(program, name); gl.enableVertexAttribArray(at); gl.vertexAttribPointer(at, 2, gl.FLOAT, false, 16, offset);
      }
      const texture = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, texture);
      for (const [parameter, value] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, parameter, value);
      const buffers = Array.from({ length: 3 }, () => {
        const buffer = gl.createBuffer(); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
        gl.bufferData(gl.PIXEL_PACK_BUFFER, width * height * 4, gl.STREAM_READ); return buffer;
      });
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      slot = { gl, vertices, buffers, rgba: new Uint8Array(width * height * 4), pending: [], nextCaptureAt: 0, disposed: false, request: null,
        source, sourceWidth: source.width, sourceHeight: source.height };
      cache.set(key, slot);
    } catch { gl.getExtension('WEBGL_lose_context')?.loseContext(); return null; }
  }
  if (slot.request) return slot.request;
  const current = () => !slot.disposed && !slot.gl.isContextLost() && source.isConnected && source.width === slot.sourceWidth && source.height === slot.sourceHeight && view.querySelector('.visualizer-layer__canvas') === source && valid();
  slot.request = (async () => {
    const { gl, vertices, rgba } = slot, started = performance.now();
    const period = 1000 / Math.max(1, Math.min(60, options.fps || 44));
    let selected = null;
    try {
      while (!selected) {
        const now = performance.now();
        if (!current() || now - started > 250) return { ok: false };
        // Consume signalled buffers only; discard older completed pictures instead of queuing sends.
        for (const item of [...slot.pending]) {
          const status = gl.clientWaitSync(item.sync, 0, 0);
          if (status === gl.WAIT_FAILED) throw new Error('Capture fence failed');
          if (status === gl.TIMEOUT_EXPIRED) continue;
          slot.pending.splice(slot.pending.indexOf(item), 1); gl.deleteSync(item.sync);
          if (now - item.at < 250) {
            if (selected) slot.buffers.push(selected.buffer);
            selected = item;
          } else slot.buffers.push(item.buffer);
        }
        if (slot.buffers.length && now >= slot.nextCaptureAt) {
          const buffer = slot.buffers.pop(), scale = (fit === 'contain' ? Math.min : Math.max)(width / source.width, height / source.height);
          const x = source.width * scale / width, y = source.height * scale / height;
          gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
          gl.bindBuffer(gl.ARRAY_BUFFER, vertices);
          gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-x, -y, 0, 1, x, -y, 1, 1, -x, y, 0, 0, x, y, 1, 0]), gl.STREAM_DRAW);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
          gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer); gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, 0);
          const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0); gl.flush(); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
          if (!sync) throw new Error('Capture fence unavailable');
          slot.pending.push({ buffer, sync, at: now });
          slot.nextCaptureAt = now + period;
        }
        if (!selected) await new Promise((resolve) => {
          const timer = globalThis.setTimeout(() => { globalThis.cancelAnimationFrame(frame); resolve(); }, 50);
          const frame = globalThis.requestAnimationFrame(() => { globalThis.clearTimeout(timer); resolve(); });
        });
      }
      if (!current()) return { ok: false };
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, selected.buffer); gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, rgba); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      const data = new Array(width * height * 3);
      for (let row = 0; row < height; row++) for (let column = 0; column < width; column++) {
        const from = ((height - 1 - row) * width + column) * 4, to = (row * width + column) * 3;
        data[to] = rgba[from]; data[to + 1] = rgba[from + 1]; data[to + 2] = rgba[from + 2];
      }
      return { ok: true, width, height, data };
    } catch { dispose(slot); cache.delete(key); return { ok: false }; }
    finally { if (selected && !slot.disposed) slot.buffers.push(selected.buffer); }
  })();
  try { return await slot.request; } finally { slot.request = null; }
}
