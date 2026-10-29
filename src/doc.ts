// Everything comes from ag-psd's dist/ build (its browser entry) so there's a single copy of its module state.
import {
  getCompositeImageData, getLayerImageData, getLayerMaskImageData, getLayerRealMaskImageData, initializeCanvas,
} from 'ag-psd/dist/index';
import type { BlendMode, Layer as PsdLayer, LayerRawData, LayerRawDataChannel, PixelData, Psd } from 'ag-psd/dist/index';
import { writeDataRLE } from 'ag-psd/dist/helpers';
import { createWriter, getRLEChannelBound, getWriterBufferNoCopy, writePsd } from 'ag-psd/dist/psdWriter';
import { blankComposite, readPsdChunks, Splicer } from './bigfile';
import {
  applyOp, blankPixels, canvasToPixels, crop, drawPixelsScaled, maskToAlpha, opaqueBounds, toRGBA8, type Op, type Pixels,
} from './pixels';

// Decoded layers can be bigger than the browser allows for ImageData; fall back to a plain array then.
initializeCanvas(
  (w, h) => createCanvas(w, h),
  (w, h) => {
    try {
      return new ImageData(w, h);
    } catch {
      return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) } as unknown as ImageData;
    }
  },
);

export type LayerKind = 'pixel' | 'group' | 'text' | 'smart' | 'shape' | 'adjustment';

export interface LayerMask {
  /** Preview alpha (at doc.scale): alpha = mask value, or its inverse when defaultColor is 255. */
  alpha: HTMLCanvasElement;
  /** Full-resolution bounds, in document coordinates. */
  left: number;
  top: number;
  width: number;
  height: number;
  defaultColor: number;
  disabled: boolean;
}

/** Where a layer's full-resolution pixels come from. Never mutated. */
export interface Source {
  width: number;
  height: number;
  decode(): Pixels;
}

export interface Layer {
  id: number;
  name: string;
  kind: LayerKind;
  hidden: boolean;
  /** 0..1 */
  opacity: number;
  blendMode: BlendMode;
  clipping: boolean;
  /** Full-resolution bounds, in document coordinates. */
  left: number;
  top: number;
  width: number;
  height: number;
  /**
   * Preview pixels at doc.scale (identical to the real pixels when scale is 1). Treated as immutable:
   * edits swap in a fresh copy so undo snapshots stay intact.
   */
  canvas: HTMLCanvasElement | null;
  source: Source | null;
  /** Edits since load, replayed on the full-resolution pixels when saving. Replaced, never mutated. */
  ops: Op[];
  children?: Layer[];
  opened: boolean;
  mask?: LayerMask;
  /** True once pixels were edited, so text/smart-object/vector data is dropped on save. */
  rasterized: boolean;
  /** Position at load time, used to shift text/smart-object transforms on save. */
  originLeft: number;
  originTop: number;
  /** The layer as read from the PSD (including its still-compressed pixel data), minus children. */
  raw: PsdLayer;
}

export interface Doc {
  name: string;
  width: number;
  height: number;
  /** Preview resolution relative to the real document (1 = full resolution). */
  scale: number;
  /** Bottom-most layer first, same order as ag-psd. */
  layers: Layer[];
  raw: Omit<Psd, 'children' | 'canvas' | 'imageData'>;
}

let nextId = 1;
export const newId = () => nextId++;

export function createCanvas(width: number, height: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, width);
  c.height = Math.max(1, height);
  return c;
}

export function ctx2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
  return c.getContext('2d')!;
}

export function cloneCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = createCanvas(src.width, src.height);
  ctx2d(c).drawImage(src, 0, 0);
  return c;
}

/** Size of a full-resolution extent in preview pixels. */
export const scaled = (v: number, scale: number) => Math.max(1, Math.round(v * scale));

// Limits for the on-screen preview. Documents beyond them are shown downscaled; edits are still
// applied at full resolution when saving.
const MAX_PREVIEW_PIXELS = 16_777_216; // 4096 × 4096
const MAX_PREVIEW_SIDE = 16_384;
const PREVIEW_MEMORY_BUDGET = 1.5e9; // bytes of preview pixels across all layers

function chooseScale(width: number, height: number, layerArea: number): number {
  const s = Math.min(
    1,
    Math.sqrt(MAX_PREVIEW_PIXELS / (width * height)),
    MAX_PREVIEW_SIDE / Math.max(width, height),
    Math.sqrt(PREVIEW_MEMORY_BUDGET / (4 * Math.max(1, layerArea))),
  );
  return s >= 0.999 ? 1 : s;
}

function kindOf(l: PsdLayer): LayerKind {
  if (l.children) return 'group';
  if (l.text) return 'text';
  if (l.placedLayer) return 'smart';
  if (l.adjustment) return 'adjustment';
  if (l.vectorFill || l.vectorMask) return 'shape';
  return 'pixel';
}

function previewOf(p: Pixels, scale: number): HTMLCanvasElement {
  const c = createCanvas(scaled(p.width, scale), scaled(p.height, scale));
  drawPixelsScaled(p, ctx2d(c), scale);
  return c;
}

export function makeLayer(name: string, source: Source | null, left = 0, top = 0): Layer {
  return {
    id: newId(), name, kind: 'pixel', hidden: false, opacity: 1, blendMode: 'normal', clipping: false,
    left, top, width: source?.width ?? 0, height: source?.height ?? 0, canvas: null, source, ops: [],
    opened: true, rasterized: false, originLeft: left, originTop: top, raw: {},
  };
}

export function makeGroup(name: string, children: Layer[] = []): Layer {
  return { ...makeLayer(name, null), kind: 'group', blendMode: 'pass through', children };
}

/** A layer whose pixels come from a canvas (images, placed files, flattened results). */
export function layerFromCanvas(name: string, c: HTMLCanvasElement, scale: number, left = 0, top = 0): Layer {
  const layer = makeLayer(name, { width: c.width, height: c.height, decode: () => canvasToPixels(c) }, left, top);
  layer.canvas = scale === 1 ? c : previewOf(canvasToPixels(c), scale);
  return layer;
}

function area(l: PsdLayer): number {
  const w = Math.max(0, (l.right ?? 0) - (l.left ?? 0));
  const h = Math.max(0, (l.bottom ?? 0) - (l.top ?? 0));
  const m = l.mask ? Math.max(0, (l.mask.right ?? 0) - (l.mask.left ?? 0)) * Math.max(0, (l.mask.bottom ?? 0) - (l.mask.top ?? 0)) : 0;
  return w * h + m + (l.children ?? []).reduce((s, c) => s + area(c), 0);
}

const yieldToUI = () => new Promise(r => setTimeout(r, 0));

export async function loadPsd(chunks: Uint8Array<ArrayBuffer>[], name: string, onProgress: (msg: string) => void = () => {}): Promise<Doc> {
  // Keep layer pixels compressed (as views into the file's bytes); decode one layer at a time below.
  const psd = readPsdChunks(chunks, { useRawData: true, skipThumbnail: true });
  const { children, canvas, imageData, ...raw } = psd;
  void canvas; void imageData;
  const total = (children ?? []).reduce((s, l) => s + area(l), 0) || psd.width * psd.height;
  const scale = chooseScale(psd.width, psd.height, total);

  const leaves: [PsdLayer, Layer][] = [];
  const convert = (l: PsdLayer): Layer => {
    const { children: kids, canvas: _c, imageData: _i, ...lraw } = l;
    void _c; void _i;
    const left = l.left ?? 0;
    const top = l.top ?? 0;
    const width = Math.max(0, (l.right ?? left) - left);
    const height = Math.max(0, (l.bottom ?? top) - top);
    const hasPixels = !kids && width > 0 && height > 0 && !!l.rawData;
    const layer: Layer = {
      id: newId(),
      name: l.name ?? 'Layer',
      kind: kindOf(l),
      hidden: !!l.hidden,
      opacity: l.opacity ?? 1,
      blendMode: l.blendMode ?? (kids ? 'pass through' : 'normal'),
      clipping: !!l.clipping,
      left, top,
      width: hasPixels ? width : 0,
      height: hasPixels ? height : 0,
      canvas: null,
      source: hasPixels ? { width, height, decode: () => toRGBA8(getLayerImageData(l) as PixelData) } : null,
      ops: [],
      children: kids?.map(convert),
      opened: l.opened ?? false,
      rasterized: false,
      originLeft: left,
      originTop: top,
      raw: lraw,
    };
    if (!kids) leaves.push([l, layer]);
    return layer;
  };
  let layers = (children ?? []).map(convert);

  for (let i = 0; i < leaves.length; i++) {
    const [l, layer] = leaves[i];
    onProgress(`Preparing layer ${i + 1} of ${leaves.length}: ${layer.name}`);
    await yieldToUI();
    if (layer.source) layer.canvas = previewOf(layer.source.decode(), scale);
    const m = l.mask;
    const mw = Math.max(0, (m?.right ?? 0) - (m?.left ?? 0));
    const mh = Math.max(0, (m?.bottom ?? 0) - (m?.top ?? 0));
    if (m && mw && mh) {
      const maskPixels = getLayerMaskImageData(l);
      if (maskPixels) {
        const defaultColor = m.defaultColor ?? 0;
        layer.mask = {
          alpha: previewOf(maskToAlpha(toRGBA8(maskPixels), defaultColor >= 128), scale),
          left: m.left ?? 0, top: m.top ?? 0, width: mw, height: mh, defaultColor, disabled: !!m.disabled,
        };
      }
    }
  }

  if (!layers.length && psd.rawCompositeData) {
    // Flat file with no layer data: the composite becomes the background.
    onProgress('Preparing image');
    await yieldToUI();
    const source = { width: psd.width, height: psd.height, decode: () => toRGBA8(getCompositeImageData(psd)!) };
    const bg = makeLayer('Background', source);
    bg.canvas = previewOf(source.decode(), scale);
    layers = [bg];
  }
  return { name, width: psd.width, height: psd.height, scale, layers, raw };
}

export function docFromImage(img: CanvasImageSource & { width: number; height: number }, name: string): Doc {
  const c = createCanvas(img.width, img.height);
  ctx2d(c).drawImage(img, 0, 0);
  const base = name.replace(/\.[^.]+$/, '');
  return {
    name: base + '.psd', width: c.width, height: c.height, scale: 1,
    layers: [layerFromCanvas('Background', c, 1)], raw: { width: c.width, height: c.height },
  };
}

export function newDoc(width: number, height: number, fill: string | null): Doc {
  const scale = chooseScale(width, height, width * height);
  const layer = makeLayer(fill ? 'Background' : 'Layer 1', null);
  if (fill) {
    layer.width = width;
    layer.height = height;
    layer.source = {
      width, height,
      decode: () => {
        const p = blankPixels(width, height);
        const n = parseInt(fill.slice(1), 16);
        new Uint32Array(p.data.buffer).fill(0xff000000 | ((n & 255) << 16) | (n & 0xff00) | ((n >> 16) & 255));
        return p;
      },
    };
    layer.canvas = createCanvas(scaled(width, scale), scaled(height, scale));
    const g = ctx2d(layer.canvas);
    g.fillStyle = fill;
    g.fillRect(0, 0, layer.canvas.width, layer.canvas.height);
  }
  return { name: 'Untitled.psd', width, height, scale, layers: [layer], raw: { width, height } };
}

// ---------------------------------------------------------------------------
// Saving

function shiftTransform(t: number[] | undefined, dx: number, dy: number, pairs: boolean): number[] | undefined {
  if (!t) return t;
  if (pairs) return t.map((v, i) => v + (i % 2 === 0 ? dx : dy));
  // Affine [xx, xy, yx, yy, tx, ty]
  const out = t.slice();
  out[4] += dx;
  out[5] += dy;
  return out;
}

/** The layer's real pixels: decoded from the file, with all edits re-applied at full resolution. */
function fullResPixels(l: Layer, scale: number): Pixels | null {
  if (scale === 1 && l.canvas && (l.ops.length || !l.source)) return canvasToPixels(l.canvas);
  let p = l.source ? l.source.decode() : null;
  for (const op of l.ops) {
    if (!p && op.type !== 'expand') continue;
    p = applyOp(p ?? blankPixels(0, 0), op);
  }
  return p;
}

function encodeChannel(p: Pixels, offset: number, large: boolean): Uint8Array {
  const buf = new Uint8Array(getRLEChannelBound(p.width, p.height, large));
  return writeDataRLE(buf, p, [offset], large).slice();
}

const COLOR_CHANNELS: [number, number][] = [[-1, 3], [0, 0], [1, 1], [2, 2]];

/**
 * Pre-encodes an edited layer (RLE, 8-bit RGB) so only one layer is ever decoded at a time. If the document
 * is written in another format, ag-psd converts this data as it writes, again one layer at a time.
 */
function encodeLayer(l: Layer, out: PsdLayer, scale: number, large: boolean) {
  const full = fullResPixels(l, scale);
  const bounds = full && opaqueBounds(full);
  const channels: LayerRawDataChannel[] = [];
  if (full && bounds) {
    const p = crop(full, bounds.x, bounds.y, bounds.w, bounds.h);
    for (const [id, offset] of COLOR_CHANNELS) channels.push({ id, compression: 1, data: encodeChannel(p, offset, large) });
    out.left = l.left + bounds.x;
    out.top = l.top + bounds.y;
    out.right = out.left + bounds.w;
    out.bottom = out.top + bounds.h;
  } else {
    out.left = out.right = l.left;
    out.top = out.bottom = l.top;
  }
  // Masks aren't edited; carry them over, re-encoded unless they're already 8-bit.
  const srcRaw = l.raw.rawData;
  for (const [id, field, decode] of [[-2, 'mask', getLayerMaskImageData], [-3, 'realMask', getLayerRealMaskImageData]] as const) {
    if (!out[field] || !srcRaw) continue;
    const ch = srcRaw.channels.find(c => c.id === id);
    if (!ch) continue;
    if (srcRaw.bitsPerChannel === 8 && srcRaw.large === large) channels.push(ch);
    else {
      const m = decode({ ...l.raw });
      if (m) channels.push({ id, compression: 1, data: encodeChannel(toRGBA8(m), 0, large) });
    }
  }
  if (channels.length) out.rawData = { colorMode: 3, bitsPerChannel: 8, large, channels } satisfies LayerRawData;
  else delete out.rawData;
}

interface SaveContext { scale: number; large: boolean; progress: (msg: string) => void }

async function toPsdLayer(l: Layer, ctx: SaveContext): Promise<PsdLayer> {
  const out: PsdLayer = {
    ...l.raw,
    name: l.name,
    hidden: l.hidden,
    opacity: l.opacity,
    blendMode: l.blendMode,
    clipping: l.clipping,
  };
  delete out.canvas;
  delete out.imageData;
  if (l.children) {
    const kids: PsdLayer[] = [];
    for (const c of l.children) kids.push(await toPsdLayer(c, ctx));
    out.children = kids;
    out.opened = l.opened;
    return out;
  }
  const dx = l.left - l.originLeft;
  const dy = l.top - l.originTop;
  if (l.rasterized || ((dx || dy) && (out.vectorMask || out.vectorFill))) {
    delete out.text;
    delete out.placedLayer;
    delete out.vectorFill;
    delete out.vectorStroke;
    delete out.vectorMask;
    delete out.vectorOrigination;
  } else if (dx || dy) {
    if (out.text) out.text = { ...out.text, transform: shiftTransform(out.text.transform, dx, dy, false) };
    if (out.placedLayer) out.placedLayer = { ...out.placedLayer, transform: shiftTransform(out.placedLayer.transform, dx, dy, true)! };
  }
  if (l.mask && out.mask) {
    out.mask = {
      ...out.mask,
      left: l.mask.left, top: l.mask.top, right: l.mask.left + l.mask.width, bottom: l.mask.top + l.mask.height,
      disabled: l.mask.disabled,
    };
  }
  if (out.realMask && (dx || dy)) {
    const r = out.realMask;
    out.realMask = { ...r, left: (r.left ?? 0) + dx, top: (r.top ?? 0) + dy, right: (r.right ?? 0) + dx, bottom: (r.bottom ?? 0) + dy };
  }

  const untouched = l.ops.length === 0 && !!l.raw.rawData;
  if (untouched) {
    // Write the original compressed pixels back as they were.
    out.left = l.left;
    out.top = l.top;
    out.right = l.left + l.width;
    out.bottom = l.top + l.height;
  } else {
    ctx.progress(`Saving layer “${l.name}”`);
    await yieldToUI();
    encodeLayer(l, out, ctx.scale, ctx.large);
  }
  return out;
}

/** Encodes the document. `composite` is the flattened image at full resolution when available. */
export async function savePsd(doc: Doc, composite: HTMLCanvasElement | null, thumbnail: HTMLCanvasElement,
  progress: (msg: string) => void): Promise<{ parts: Uint8Array[]; size: number; psb: boolean }> {
  const colorMode = doc.raw.colorMode ?? 3;
  const bits = doc.raw.bitsPerChannel ?? 8;
  // Keep the original color mode and bit depth when the writer supports it, so untouched layers pass through.
  const writable: Record<number, number[]> = { 1: [8, 16, 32], 3: [8, 16, 32], 4: [8, 16] };
  const keepFormat = writable[colorMode]?.includes(bits) ?? false;
  // Keep the source's format (PSD or PSB) so its layers can be copied as-is; PSD can't exceed 30,000 px.
  const large = !!doc.raw.rawCompositeDataInfo?.large || doc.width > 30000 || doc.height > 30000;
  const ctx: SaveContext = { scale: doc.scale, large, progress };

  const children: PsdLayer[] = [];
  for (const l of doc.layers) children.push(await toPsdLayer(l, ctx));

  const imageResources = { ...doc.raw.imageResources, thumbnail };
  delete imageResources.thumbnailRaw;
  if (!composite) {
    // No full-resolution composite: tell Photoshop to rebuild it from the layers.
    imageResources.versionInfo = {
      writerName: 'Adobe Photoshop', readerName: 'Adobe Photoshop CS6', fileVersion: 1,
      ...imageResources.versionInfo, hasRealMergedData: false,
    };
  }
  const writeColorMode = keepFormat ? colorMode : 3;
  const writeBits = keepFormat ? bits : 8;

  // Large channel data is swapped for placeholders so ag-psd's output (one buffer) stays small; the real
  // bytes are spliced back in afterwards. Only for layers ag-psd copies verbatim, i.e. already in the
  // output format; it re-encodes the others itself.
  const splicer = new Splicer();
  const swapIn = (layers: PsdLayer[]) => {
    for (const l of layers) {
      if (l.children) swapIn(l.children);
      const r = l.rawData;
      if (!r || r.large !== large || r.colorMode !== writeColorMode || r.bitsPerChannel !== writeBits) continue;
      l.rawData = { ...r, channels: r.channels.map(c => (splicer.wants(c.data) ? { ...c, data: splicer.placeholder(c.data) } : c)) };
    }
  };
  swapIn(children);

  // Without a real composite, ag-psd writes the document as 1×1 and a blank full-size composite is
  // spliced in, so it never has to allocate one the size of the document.
  const fake = !composite;
  const psd: Psd = {
    ...doc.raw,
    width: fake ? 1 : doc.width,
    height: fake ? 1 : doc.height,
    colorMode: writeColorMode,
    bitsPerChannel: writeBits,
    children,
    canvas: composite ?? undefined,
    imageResources,
  };
  delete psd.palette;
  delete psd.rawCompositeData;
  delete psd.rawCompositeDataInfo;

  progress('Writing file');
  await yieldToUI();
  const writer = createWriter(16 * 1024 * 1024 + (fake ? 0 : 4 * getRLEChannelBound(doc.width, doc.height, large)));
  writePsd(writer, psd, { psb: large });
  const channels = writeColorMode === 1 ? 1 : writeColorMode === 4 ? 4 : 3;
  const parts = splicer.splice(getWriterBufferNoCopy(writer), large, fake ? {
    width: doc.width, height: doc.height, part: blankComposite(doc.width, doc.height, channels, writeBits / 8, large),
  } : undefined);
  return { parts, size: parts.reduce((n, p) => n + p.length, 0), psb: large };
}

// ---------------------------------------------------------------------------
// Tree helpers

/** Depth-first walk, bottom to top. */
export function* walk(layers: Layer[], parent: Layer | null = null): Generator<[Layer, Layer | null]> {
  for (const l of layers) {
    yield [l, parent];
    if (l.children) yield* walk(l.children, l);
  }
}

export function findLayer(doc: Doc, id: number): { layer: Layer; siblings: Layer[]; index: number; parent: Layer | null } | null {
  const search = (list: Layer[], parent: Layer | null): ReturnType<typeof findLayer> => {
    for (let i = 0; i < list.length; i++) {
      const l = list[i];
      if (l.id === id) return { layer: l, siblings: list, index: i, parent };
      if (l.children) {
        const r = search(l.children, l);
        if (r) return r;
      }
    }
    return null;
  };
  return search(doc.layers, null);
}

export function cloneLayers(layers: Layer[]): Layer[] {
  return layers.map(l => ({ ...l, mask: l.mask && { ...l.mask }, children: l.children && cloneLayers(l.children) }));
}

/** Copy with fresh ids (for Duplicate Layer). Pixels, sources and edits are immutable, so they're shared. */
export function duplicateLayer(l: Layer): Layer {
  return {
    ...l,
    id: newId(),
    raw: { ...l.raw, id: undefined },
    mask: l.mask && { ...l.mask },
    children: l.children?.map(duplicateLayer),
  };
}
