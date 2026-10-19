// Read the presented canvas; an idle WebGL drawing buffer may already have been discarded.
export async function stageImage(page) {
  const png = await page.locator('.stage3d-canvas').screenshot();
  return page.evaluate((base64) => new Promise((resolve, reject) => {
    const image = new window.Image();
    image.onerror = reject;
    image.onload = () => {
      const canvas = window.document.createElement('canvas');
      canvas.width = image.width; canvas.height = image.height;
      const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let r = 0, g = 0, b = 0, lit = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        r += pixels[i]; g += pixels[i + 1]; b += pixels[i + 2];
        if (Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) > 100) lit++;
      }
      const n = pixels.length / 4;
      resolve({ r: r / n, g: g / n, b: b / n, lum: (0.2126 * r + 0.7152 * g + 0.0722 * b) / n, litShare: lit / n });
    };
    image.src = 'data:image/png;base64,' + base64;
  }), png.toString('base64'));
}
