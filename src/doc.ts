import { readPsd, writePsd } from 'ag-psd';
import type { BlendMode, Layer as PsdLayer, LayerMaskData, Psd } from 'ag-psd';

export type LayerKind = 'pixel' | 'group' | 'text' | 'smart' | 'shape' | 'adjustment';

export interface LayerMask {
  /** Original grayscale mask, written back to the PSD unchanged. */
  source: HTMLCanvasElement;
  /** Alpha version used for compositing: alpha = mask value, or its inverse when defaultColor is 255. */
  alpha: HTMLCanvasElement;
  left: number;
  top: number;
  defaultColor: number;
  disabled: boolean;
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
  left: number;
  top: number;
  /** Treated as immutable: pixel edits replace it with a fresh copy so undo snapshots stay intact. */
  canvas: HTMLCanvasElement | null;
  children?: Layer[];
  opened: boolean;
  mask?: LayerMask;
  /** True once pixels were edited, so text/smart-object/vector data is dropped on save. */
  rasterized: boolean;
  /** Position at load time, used to shift text/smart-object transforms on save. */
  originLeft: number;
  originTop: number;
  /** The layer as read from the PSD, minus pixels and children. Never mutated. */
  raw: PsdLayer;
}

export interface Doc {
  name: string;
  width: number;
  height: number;
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

function maskToAlpha(source: HTMLCanvasElement, invert: boolean): HTMLCanvasElement {
  const out = createCanvas(source.width, source.height);
  const img = ctx2d(source).getImageData(0, 0, source.width, source.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = d[i];
    d[i] = d[i + 1] = d[i + 2] = 0;
    d[i + 3] = invert ? 255 - v : v;
  }
  ctx2d(out).putImageData(img, 0, 0);
  return out;
}

function kindOf(l: PsdLayer): LayerKind {
  if (l.children) return 'group';
  if (l.text) return 'text';
  if (l.placedLayer) return 'smart';
  if (l.adjustment) return 'adjustment';
  if (l.vectorFill || l.vectorMask) return 'shape';
  return 'pixel';
}

export function makeLayer(name: string, canvas: HTMLCanvasElement | null, left = 0, top = 0): Layer {
  return {
    id: newId(), name, kind: 'pixel', hidden: false, opacity: 1, blendMode: 'normal', clipping: false,
    left, top, canvas, opened: true, rasterized: false, originLeft: left, originTop: top, raw: {},
  };
}

export function makeGroup(name: string, children: Layer[] = []): Layer {
  return { ...makeLayer(name, null), kind: 'group', blendMode: 'pass through', children };
}

function fromPsdLayer(l: PsdLayer): Layer {
  const { canvas, children, imageData, rawData, ...raw } = l;
  void imageData; void rawData;
  const left = l.left ?? 0;
  const top = l.top ?? 0;
  const layer: Layer = {
    id: newId(),
    name: l.name ?? 'Layer',
    kind: kindOf(l),
    hidden: !!l.hidden,
    opacity: l.opacity ?? 1,
    blendMode: l.blendMode ?? (children ? 'pass through' : 'normal'),
    clipping: !!l.clipping,
    left, top,
    canvas: canvas && canvas.width > 0 && canvas.height > 0 ? canvas : null,
    children: children?.map(fromPsdLayer),
    opened: l.opened ?? false,
    rasterized: false,
    originLeft: left,
    originTop: top,
    raw,
  };
  const m = l.mask;
  if (m?.canvas && m.canvas.width > 0 && m.canvas.height > 0) {
    const defaultColor = m.defaultColor ?? 0;
    layer.mask = {
      source: m.canvas,
      alpha: maskToAlpha(m.canvas, defaultColor >= 128),
      left: m.left ?? 0,
      top: m.top ?? 0,
      defaultColor,
      disabled: !!m.disabled,
    };
  }
  return layer;
}

export function loadPsd(buffer: ArrayBuffer, name: string): Doc {
  const psd = readPsd(buffer, { skipThumbnail: true });
  const { children, canvas, imageData, ...raw } = psd;
  void imageData;
  let layers = (children ?? []).map(fromPsdLayer);
  if (!layers.length && canvas) {
    // Flat PSD with no layer data: use the composite as the background.
    layers = [makeLayer('Background', canvas)];
  }
  return { name, width: psd.width, height: psd.height, layers, raw };
}

export function docFromImage(img: CanvasImageSource & { width: number; height: number }, name: string): Doc {
  const c = createCanvas(img.width, img.height);
  ctx2d(c).drawImage(img, 0, 0);
  const base = name.replace(/\.[^.]+$/, '');
  return { name: base + '.psd', width: c.width, height: c.height, layers: [makeLayer('Background', c)], raw: { width: c.width, height: c.height } };
}

export function newDoc(width: number, height: number, fill: string | null): Doc {
  const c = createCanvas(width, height);
  if (fill) {
    const g = ctx2d(c);
    g.fillStyle = fill;
    g.fillRect(0, 0, width, height);
  }
  return { name: 'Untitled.psd', width, height, layers: [makeLayer(fill ? 'Background' : 'Layer 1', c)], raw: { width, height } };
}

function shiftTransform(t: number[] | undefined, dx: number, dy: number, pairs: boolean): number[] | undefined {
  if (!t) return t;
  if (pairs) return t.map((v, i) => v + (i % 2 === 0 ? dx : dy));
  // Affine [xx, xy, yx, yy, tx, ty]
  const out = t.slice();
  out[4] += dx;
  out[5] += dy;
  return out;
}

function toPsdLayer(l: Layer): PsdLayer {
  const out: PsdLayer = {
    ...l.raw,
    name: l.name,
    hidden: l.hidden,
    opacity: l.opacity,
    blendMode: l.blendMode,
    clipping: l.clipping,
  };
  if (l.children) {
    out.children = l.children.map(toPsdLayer);
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
    delete out.realMask;
  } else if (dx || dy) {
    if (out.text) out.text = { ...out.text, transform: shiftTransform(out.text.transform, dx, dy, false) };
    if (out.placedLayer) out.placedLayer = { ...out.placedLayer, transform: shiftTransform(out.placedLayer.transform, dx, dy, true)! };
    delete out.realMask;
  }
  out.left = l.left;
  out.top = l.top;
  if (l.canvas) {
    out.canvas = l.canvas;
    out.right = l.left + l.canvas.width;
    out.bottom = l.top + l.canvas.height;
  } else {
    out.right = l.left;
    out.bottom = l.top;
  }
  if (l.mask) {
    const m: LayerMaskData = {
      ...l.raw.mask,
      canvas: l.mask.source,
      imageData: undefined,
      left: l.mask.left,
      top: l.mask.top,
      right: l.mask.left + l.mask.source.width,
      bottom: l.mask.top + l.mask.source.height,
      disabled: l.mask.disabled,
    };
    out.mask = m;
  }
  return out;
}

export function savePsd(doc: Doc, composite: HTMLCanvasElement): ArrayBuffer {
  const psd: Psd = {
    ...doc.raw,
    width: doc.width,
    height: doc.height,
    // Canvases are always 8-bit RGB in the browser, so that's what we write.
    colorMode: 3,
    bitsPerChannel: 8,
    children: doc.layers.map(toPsdLayer),
    canvas: composite,
  };
  delete psd.palette;
  delete psd.rawCompositeData;
  delete psd.rawCompositeDataInfo;
  return writePsd(psd, { generateThumbnail: true, trimImageData: true });
}

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

/** Deep copy including pixels, with fresh ids (for Duplicate Layer). */
export function duplicateLayer(l: Layer): Layer {
  return {
    ...l,
    id: newId(),
    raw: { ...l.raw, id: undefined },
    canvas: l.canvas && cloneCanvas(l.canvas),
    mask: l.mask && { ...l.mask },
    children: l.children?.map(duplicateLayer),
  };
}
