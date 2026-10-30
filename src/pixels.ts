// Full-resolution pixel work on plain RGBA arrays. Canvases are only ever used in small tiles,
// so this works for layers far larger than the browser's maximum canvas size.

import type { PixelData } from 'ag-psd';
import { ADJUSTMENTS } from './adjust';

export interface Pixels {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export const TILE = 2048;

export function blankPixels(width: number, height: number): Pixels {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

/** Converts 8/16/32-bit RGBA pixel data (as decoded by ag-psd) to 8-bit. */
export function toRGBA8(p: PixelData): Pixels {
  const { width, height, data } = p;
  if (data instanceof Uint8ClampedArray) return { width, height, data };
  if (data instanceof Uint8Array) return { width, height, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length) };
  const out = new Uint8ClampedArray(data.length);
  if (data instanceof Uint16Array) {
    for (let i = 0; i < data.length; i++) out[i] = data[i] >> 8;
  } else {
    // 32-bit documents store linear light; convert color to sRGB-ish gamma, keep alpha linear.
    for (let i = 0; i < data.length; i += 4) {
      out[i] = 255 * Math.pow(Math.min(1, Math.max(0, data[i])), 1 / 2.2);
      out[i + 1] = 255 * Math.pow(Math.min(1, Math.max(0, data[i + 1])), 1 / 2.2);
      out[i + 2] = 255 * Math.pow(Math.min(1, Math.max(0, data[i + 2])), 1 / 2.2);
      out[i + 3] = 255 * data[i + 3];
    }
  }
  return { width, height, data: out };
}

function readRegion(p: Pixels, x: number, y: number, w: number, h: number): ImageData {
  const img = new ImageData(w, h);
  for (let row = 0; row < h; row++) {
    const src = ((y + row) * p.width + x) * 4;
    img.data.set(p.data.subarray(src, src + w * 4), row * w * 4);
  }
  return img;
}

function writeRegion(p: Pixels, img: ImageData, x: number, y: number) {
  const w = img.width;
  for (let row = 0; row < img.height; row++) {
    p.data.set(img.data.subarray(row * w * 4, (row + 1) * w * 4), ((y + row) * p.width + x) * 4);
  }
}

function tileCanvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c.getContext('2d', { willReadFrequently: true })!;
}

function* tiles(width: number, height: number) {
  for (let y = 0; y < height; y += TILE) {
    for (let x = 0; x < width; x += TILE) yield { x, y, w: Math.min(TILE, width - x), h: Math.min(TILE, height - y) };
  }
}

/** Draws full-resolution pixels into a (possibly downscaled) preview canvas. */
export function drawPixelsScaled(p: Pixels, target: CanvasRenderingContext2D, scale: number) {
  target.imageSmoothingEnabled = true;
  target.imageSmoothingQuality = 'high';
  for (const t of tiles(p.width, p.height)) {
    if (scale === 1) {
      target.putImageData(readRegion(p, t.x, t.y, t.w, t.h), t.x, t.y);
      continue;
    }
    const g = tileCanvas(t.w, t.h);
    g.putImageData(readRegion(p, t.x, t.y, t.w, t.h), 0, 0);
    target.drawImage(g.canvas, t.x * scale, t.y * scale, t.w * scale, t.h * scale);
  }
}

/**
 * Renders full-resolution pixels tile by tile: `draw` is called with a tile-sized context whose origin is
 * already translated so it can draw in the image's own coordinates.
 */
export function renderTiled(width: number, height: number, draw: (g: CanvasRenderingContext2D) => void): Pixels {
  const p = blankPixels(width, height);
  for (const t of tiles(width, height)) {
    const g = tileCanvas(t.w, t.h);
    g.translate(-t.x, -t.y);
    draw(g);
    writeRegion(p, g.getImageData(0, 0, t.w, t.h), t.x, t.y);
  }
  return p;
}

export function canvasToPixels(c: HTMLCanvasElement): Pixels {
  const g = c.getContext('2d')!;
  const p = blankPixels(c.width, c.height);
  for (const t of tiles(c.width, c.height)) writeRegion(p, g.getImageData(t.x, t.y, t.w, t.h), t.x, t.y);
  return p;
}

/** Grayscale mask pixels → alpha, inverted when the area outside the mask is visible. */
export function maskToAlpha(p: Pixels, invert: boolean): Pixels {
  const d = p.data;
  const out = new Uint8ClampedArray(d.length);
  for (let i = 0; i < d.length; i += 4) out[i + 3] = invert ? 255 - d[i] : d[i];
  return { width: p.width, height: p.height, data: out };
}

/** Bounding box of non-transparent pixels, or null if the layer is empty. */
export function opaqueBounds(p: Pixels): { x: number; y: number; w: number; h: number } | null {
  const { width, height, data } = p;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    let row = y * width * 4 + 3;
    for (let x = 0; x < width; x++, row += 4) {
      if (data[row]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        maxY = y;
      }
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

export function crop(p: Pixels, x: number, y: number, w: number, h: number): Pixels {
  if (x === 0 && y === 0 && w === p.width && h === p.height) return p;
  const out = blankPixels(w, h);
  for (let row = 0; row < h; row++) {
    const src = ((y + row) * p.width + x) * 4;
    out.data.set(p.data.subarray(src, src + w * 4), row * w * 4);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Edit operations. Coordinates are layer-local, in full-resolution pixels.

export type Op =
  /** Grow the layer: old pixels land at (dx, dy) inside a width×height buffer. */
  | { type: 'expand'; dx: number; dy: number; width: number; height: number }
  | { type: 'stroke'; dabs: number[]; size: number; hardness: number; color: string; opacity: number; erase: boolean }
  | { type: 'fill'; x: number; y: number; tolerance: number; color: string; opacity: number }
  | { type: 'adjust'; id: string; values: Record<string, number> }
  | { type: 'flip'; horizontal: boolean };

const tipCache = new Map<string, HTMLCanvasElement>();

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** A round brush tip of the given diameter. */
export function brushTip(size: number, hardness: number, color: string): HTMLCanvasElement {
  const key = `${size}|${hardness}|${color}`;
  const hit = tipCache.get(key);
  if (hit) return hit;
  if (tipCache.size > 16) tipCache.clear();
  const d = Math.max(1, size);
  const dim = Math.ceil(d) + 2;
  const c = document.createElement('canvas');
  c.width = c.height = dim;
  const g = c.getContext('2d')!;
  const r = d / 2;
  const cx = dim / 2;
  if (hardness >= 0.99 || d <= 2) {
    g.fillStyle = color;
    g.beginPath();
    g.arc(cx, cx, r, 0, Math.PI * 2);
    g.fill();
  } else {
    const [rr, gg, bb] = hexToRgb(color);
    const grad = g.createRadialGradient(cx, cx, 0, cx, cx, r);
    grad.addColorStop(0, `rgba(${rr},${gg},${bb},1)`);
    grad.addColorStop(Math.max(0, hardness), `rgba(${rr},${gg},${bb},1)`);
    grad.addColorStop(1, `rgba(${rr},${gg},${bb},0)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, dim, dim);
  }
  tipCache.set(key, c);
  return c;
}

function applyStroke(p: Pixels, op: Extract<Op, { type: 'stroke' }>) {
  const tip = brushTip(op.size, op.hardness, op.color);
  const half = tip.width / 2;
  for (const t of tiles(p.width, p.height)) {
    const hits: number[] = [];
    for (let i = 0; i < op.dabs.length; i += 2) {
      const x = op.dabs[i], y = op.dabs[i + 1];
      if (x + half >= t.x && x - half <= t.x + t.w && y + half >= t.y && y - half <= t.y + t.h) hits.push(x, y);
    }
    if (!hits.length) continue;
    const buffer = tileCanvas(t.w, t.h);
    for (let i = 0; i < hits.length; i += 2) buffer.drawImage(tip, hits[i] - t.x - half, hits[i + 1] - t.y - half);
    const g = tileCanvas(t.w, t.h);
    g.putImageData(readRegion(p, t.x, t.y, t.w, t.h), 0, 0);
    g.globalAlpha = op.opacity;
    g.globalCompositeOperation = op.erase ? 'destination-out' : 'source-over';
    g.drawImage(buffer.canvas, 0, 0);
    writeRegion(p, g.getImageData(0, 0, t.w, t.h), t.x, t.y);
  }
}

/** Contiguous flood fill (scanline), blending `color` over matching pixels. */
export function floodFill(p: Pixels, sx: number, sy: number, tolerance: number, color: string, opacity: number) {
  const { width: w, height: h, data: d } = p;
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return;
  const si = (sy * w + sx) * 4;
  const r0 = d[si], g0 = d[si + 1], b0 = d[si + 2], a0 = d[si + 3];
  const match = (idx: number) => {
    const i = idx * 4;
    return Math.abs(d[i] - r0) <= tolerance && Math.abs(d[i + 1] - g0) <= tolerance &&
      Math.abs(d[i + 2] - b0) <= tolerance && Math.abs(d[i + 3] - a0) <= tolerance;
  };
  const filled = new Uint8Array(w * h);
  let stack = new Int32Array(1024);
  let sp = 0;
  const push = (idx: number) => {
    if (sp === stack.length) {
      const next = new Int32Array(stack.length * 2);
      next.set(stack);
      stack = next;
    }
    stack[sp++] = idx;
  };
  push(sy * w + sx);
  while (sp) {
    const idx = stack[--sp];
    if (filled[idx] || !match(idx)) continue;
    const y = (idx / w) | 0;
    const rowStart = y * w;
    let x0 = idx - rowStart;
    let x1 = x0;
    while (x0 > 0 && !filled[rowStart + x0 - 1] && match(rowStart + x0 - 1)) x0--;
    while (x1 < w - 1 && !filled[rowStart + x1 + 1] && match(rowStart + x1 + 1)) x1++;
    for (let x = x0; x <= x1; x++) {
      filled[rowStart + x] = 1;
      if (y > 0 && !filled[rowStart - w + x]) push(rowStart - w + x);
      if (y < h - 1 && !filled[rowStart + w + x]) push(rowStart + w + x);
    }
  }
  const [fr, fg, fb] = hexToRgb(color);
  const op = opacity;
  for (let idx = 0; idx < filled.length; idx++) {
    if (!filled[idx]) continue;
    const i = idx * 4;
    const a = d[i + 3] / 255;
    const outA = op + a * (1 - op);
    d[i] = (fr * op + d[i] * a * (1 - op)) / outA;
    d[i + 1] = (fg * op + d[i + 1] * a * (1 - op)) / outA;
    d[i + 2] = (fb * op + d[i + 2] * a * (1 - op)) / outA;
    d[i + 3] = outA * 255;
  }
}

function flip(p: Pixels, horizontal: boolean) {
  const { width: w, height: h } = p;
  const d = new Uint32Array(p.data.buffer, p.data.byteOffset, w * h);
  if (horizontal) {
    for (let y = 0; y < h; y++) d.subarray(y * w, (y + 1) * w).reverse();
  } else {
    const tmp = new Uint32Array(w);
    for (let y = 0; y < h >> 1; y++) {
      const a = d.subarray(y * w, (y + 1) * w);
      const b = d.subarray((h - 1 - y) * w, (h - y) * w);
      tmp.set(a);
      a.set(b);
      b.set(tmp);
    }
  }
}

export function applyOp(p: Pixels, op: Op): Pixels {
  switch (op.type) {
    case 'expand': {
      const out = blankPixels(op.width, op.height);
      for (let row = 0; row < p.height; row++) {
        out.data.set(p.data.subarray(row * p.width * 4, (row + 1) * p.width * 4), ((op.dy + row) * op.width + op.dx) * 4);
      }
      return out;
    }
    case 'stroke':
      applyStroke(p, op);
      return p;
    case 'fill':
      floodFill(p, op.x, op.y, op.tolerance, op.color, op.opacity);
      return p;
    case 'adjust':
      ADJUSTMENTS.find(a => a.id === op.id)!.apply(p.data, op.values);
      return p;
    case 'flip':
      flip(p, op.horizontal);
      return p;
  }
}
