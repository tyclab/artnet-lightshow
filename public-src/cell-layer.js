import { useLayoutEffect, useRef } from 'preact/hooks';
import { cellCentres, paintCells } from './stage-cells.js';

/** A bar's cells, in rig unit order, and where each sits on a surface of the layer's size. */
export function cellsOf(layer, rig) {
  if (layer.rig !== rig || layer.placedFor !== layer.size) {
    const units = [];
    rig.ranges.forEach(({ start, count }, i) => { if (rig.cellMaps[i]) for (let c = 0; c < count; c++) units.push(start + c); });
    layer.rig = rig;
    layer.placedFor = layer.size;
    layer.units = units;
    layer.centres = cellCentres(units.map((u) => rig.points[u]), layer.size);
  }
  return layer;
}

/** The cell canvas, sized to the surface in device pixels; repaints as it resizes. */
export function useCellLayer(canvas, present, paint) {
  const layer = useRef(null);
  useLayoutEffect(() => {
    const element = canvas.current;
    if (!present || !element || typeof ResizeObserver !== 'function') return undefined;
    const ctx = element.getContext('2d');
    // A browser without canvas filters draws the cells without their bloom.
    const glow = typeof ctx.filter === 'string' ? document.createElement('canvas').getContext('2d') : null;
    const current = { ctx, glow, size: null };
    layer.current = current;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (!width || !height) return;
      const device = entry.devicePixelContentBoxSize && entry.devicePixelContentBoxSize[0];
      const w = device ? device.inlineSize : Math.round(width * (window.devicePixelRatio || 1));
      const h = device ? device.blockSize : Math.round(height * (window.devicePixelRatio || 1));
      for (const target of glow ? [element, glow.canvas] : [element]) {
        if (target.width !== w) target.width = w;
        if (target.height !== h) target.height = h;
      }
      current.size = { width, height, scale: w / width };
      paint();
    });
    try { observer.observe(element, { box: 'device-pixel-content-box' }); } catch { observer.observe(element); }
    return () => { observer.disconnect(); layer.current = null; };
  }, [present]);
  return layer;
}

/** Paint `lit`, a colour per cell in the layer's unit order; an unchanged picture is not painted again. */
export function paintLayer(cells, lit) {
  if (cells.painted && cells.paintedAt === cells.centres && lit.every((colour, i) => colour === cells.painted[i])) return;
  paintCells(cells.ctx, cells.glow, cells.size, cells.centres, lit);
  cells.painted = lit;
  cells.paintedAt = cells.centres;
}
