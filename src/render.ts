import type { BlendMode } from 'ag-psd';
import { createCanvas, ctx2d, scaled, type Doc, type Layer } from './doc';

const BLEND: Partial<Record<BlendMode, GlobalCompositeOperation>> = {
  'normal': 'source-over',
  'pass through': 'source-over',
  'dissolve': 'source-over',
  'darken': 'darken',
  'multiply': 'multiply',
  'color burn': 'color-burn',
  'linear burn': 'multiply',
  'darker color': 'darken',
  'lighten': 'lighten',
  'screen': 'screen',
  'color dodge': 'color-dodge',
  'linear dodge': 'lighter',
  'lighter color': 'lighten',
  'overlay': 'overlay',
  'soft light': 'soft-light',
  'hard light': 'hard-light',
  'vivid light': 'hard-light',
  'linear light': 'hard-light',
  'pin light': 'hard-light',
  'difference': 'difference',
  'exclusion': 'exclusion',
  'hue': 'hue',
  'saturation': 'saturation',
  'color': 'color',
  'luminosity': 'luminosity',
};

/** Blend modes the canvas can render exactly; others are approximated. */
export const EXACT_BLEND_MODES: BlendMode[] = [
  'normal', 'darken', 'multiply', 'color burn', 'lighten', 'screen', 'color dodge', 'linear dodge',
  'overlay', 'soft light', 'hard light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity',
];

const compositeOp = (m: BlendMode): GlobalCompositeOperation => BLEND[m] ?? 'source-over';

/** Pool of document-sized scratch canvases, reused across renders. */
class ScratchPool {
  private free: HTMLCanvasElement[] = [];
  private w = 0;
  private h = 0;

  acquire(w: number, h: number): CanvasRenderingContext2D {
    if (w !== this.w || h !== this.h) {
      this.free = [];
      this.w = w;
      this.h = h;
    }
    const c = this.free.pop() ?? createCanvas(w, h);
    const g = ctx2d(c);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, w, h);
    return g;
  }

  release(g: CanvasRenderingContext2D) {
    if (g.canvas.width === this.w && g.canvas.height === this.h) this.free.push(g.canvas);
  }
}

const pool = new ScratchPool();

/** Preview-space size and scale of the document being rendered. */
interface View { w: number; h: number; s: number }

function applyMask(g: CanvasRenderingContext2D, layer: Layer, v: View) {
  const m = layer.mask;
  if (!m || m.disabled) return;
  // defaultColor 0: outside the mask is hidden, so keep only what the mask reveals.
  // defaultColor 255: outside is visible, so cut away what the (inverted) mask hides.
  g.globalAlpha = 1;
  g.globalCompositeOperation = m.defaultColor >= 128 ? 'destination-out' : 'destination-in';
  g.drawImage(m.alpha, Math.round(m.left * v.s), Math.round(m.top * v.s));
  g.globalCompositeOperation = 'source-over';
}

function hasMask(l: Layer) {
  return !!l.mask && !l.mask.disabled;
}

/** Draws one layer (or group) onto `target`, using the layer's opacity and blend mode. */
function drawLayer(target: CanvasRenderingContext2D, layer: Layer, v: View) {
  if (layer.hidden) return;
  if (layer.children) {
    if (layer.blendMode === 'pass through' && layer.opacity >= 1 && !hasMask(layer)) {
      renderStack(target, layer.children, v);
      return;
    }
    const g = pool.acquire(v.w, v.h);
    renderStack(g, layer.children, v);
    applyMask(g, layer, v);
    blit(target, g.canvas, 0, 0, layer.opacity, layer.blendMode);
    pool.release(g);
    return;
  }
  if (!layer.canvas) return;
  if (hasMask(layer)) {
    const g = pool.acquire(v.w, v.h);
    g.drawImage(layer.canvas, Math.round(layer.left * v.s), Math.round(layer.top * v.s));
    applyMask(g, layer, v);
    blit(target, g.canvas, 0, 0, layer.opacity, layer.blendMode);
    pool.release(g);
  } else {
    blit(target, layer.canvas, Math.round(layer.left * v.s), Math.round(layer.top * v.s), layer.opacity, layer.blendMode);
  }
}

function blit(target: CanvasRenderingContext2D, src: HTMLCanvasElement, x: number, y: number, opacity: number, mode: BlendMode) {
  target.globalAlpha = opacity;
  target.globalCompositeOperation = compositeOp(mode);
  target.drawImage(src, x, y);
  target.globalAlpha = 1;
  target.globalCompositeOperation = 'source-over';
}

/** Composites a bottom-to-top layer list, handling clipping masks. */
function renderStack(target: CanvasRenderingContext2D, layers: Layer[], v: View) {
  let i = 0;
  while (i < layers.length) {
    const base = layers[i];
    let j = i + 1;
    while (j < layers.length && layers[j].clipping) j++;
    const clipped = layers.slice(i + 1, j);
    i = j;
    if (base.hidden) continue;
    if (!clipped.some(c => !c.hidden)) {
      drawLayer(target, base, v);
      continue;
    }
    // Clipping group: draw the base at full strength, paint clipped layers on top,
    // trim to the base's alpha, then composite with the base's opacity/blend.
    const group = pool.acquire(v.w, v.h);
    const shape = pool.acquire(v.w, v.h);
    drawLayer(shape, { ...base, opacity: 1, blendMode: 'normal' }, v);
    group.drawImage(shape.canvas, 0, 0);
    for (const c of clipped) drawLayer(group, { ...c, clipping: false }, v);
    group.globalCompositeOperation = 'destination-in';
    group.drawImage(shape.canvas, 0, 0);
    group.globalCompositeOperation = 'source-over';
    blit(target, group.canvas, 0, 0, base.opacity, base.blendMode === 'pass through' ? 'normal' : base.blendMode);
    pool.release(shape);
    pool.release(group);
  }
}

export const previewSize = (doc: Doc) => ({ w: scaled(doc.width, doc.scale), h: scaled(doc.height, doc.scale) });

/** Composites the document's preview (at doc.scale) onto `target`. */
export function renderDoc(target: CanvasRenderingContext2D, doc: Doc) {
  const v = { ...previewSize(doc), s: doc.scale };
  target.setTransform(1, 0, 0, 1, 0, 0);
  target.globalAlpha = 1;
  target.globalCompositeOperation = 'source-over';
  target.clearRect(0, 0, v.w, v.h);
  renderStack(target, doc.layers, v);
}

/** The flattened preview (full resolution when doc.scale is 1). */
export function flatten(doc: Doc): HTMLCanvasElement {
  const { w, h } = previewSize(doc);
  const c = createCanvas(w, h);
  renderDoc(ctx2d(c), doc);
  return c;
}
