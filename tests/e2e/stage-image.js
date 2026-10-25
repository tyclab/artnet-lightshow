// Read the presented canvas; an idle WebGL drawing buffer may already have been discarded.
// Only whole pixels inside the canvas: at a fractional offset an element screenshot rounds
// outward and takes in a row of the frame's border.
// `remember` keeps this frame's luminance in the page under that name; `against` adds `changed`, the
// number of pixels whose luminance differs by more than 2 from the frame kept under that name. The
// Stage redraws only when a light changes, so two frames of a still scene are identical: `changed`
// is 0 until something moves.
export async function stageImage(page, { remember = null, against = null } = {}) {
  const canvas = page.locator('.stage3d-canvas');
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();
  const x = Math.ceil(box.x), y = Math.ceil(box.y);
  const clip = { x, y, width: Math.floor(box.x + box.width) - x, height: Math.floor(box.y + box.height) - y };
  const png = await page.screenshot({ clip });
  return page.evaluate(([base64, remember, against]) => new Promise((resolve, reject) => {
    const image = new window.Image();
    image.onerror = reject;
    image.onload = () => {
      const canvas = window.document.createElement('canvas');
      canvas.width = image.width; canvas.height = image.height;
      const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const n = pixels.length / 4;
      const lums = new Float32Array(n);
      let r = 0, g = 0, b = 0, lit = 0;
      for (let i = 0; i < n; i++) {
        const at = i * 4;
        r += pixels[at]; g += pixels[at + 1]; b += pixels[at + 2];
        lums[i] = 0.2126 * pixels[at] + 0.7152 * pixels[at + 1] + 0.0722 * pixels[at + 2];
        if (Math.max(pixels[at], pixels[at + 1], pixels[at + 2]) > 100) lit++;
      }
      const frames = window.__stageFrames || (window.__stageFrames = {});
      if (remember) frames[remember] = lums;
      let changed = null;
      const reference = against ? frames[against] : null;
      if (reference && reference.length === n) {
        changed = 0;
        for (let i = 0; i < n; i++) if (Math.abs(lums[i] - reference[i]) > 2) changed++;
      }
      resolve({ r: r / n, g: g / n, b: b / n, lum: (0.2126 * r + 0.7152 * g + 0.0722 * b) / n, litShare: lit / n, changed });
    };
    image.src = 'data:image/png;base64,' + base64;
  }), [png.toString('base64'), remember, against]);
}

/**
 * Sample the Stage back to back until a frame differs from the one kept under `against` in at least
 * `pixels` pixels, or `timeout` passes; returns the largest change seen. A sweep's crest lights a lamp
 * only as it passes and a lap takes a few beats, so a fixed handful of samples can miss it entirely.
 */
export async function stageMotion(page, against, { pixels = 200, timeout = 10_000 } = {}) {
  const end = Date.now() + timeout;
  let best = 0;
  while (Date.now() < end) {
    const { changed } = await stageImage(page, { against });
    best = Math.max(best, changed ?? 0);
    if (best >= pixels) break;
  }
  return best;
}
