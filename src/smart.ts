// Smart objects: open the file embedded in a smart-object layer as its own document, then put the
// edited result back, re-rendering every layer that uses it through its stored transform.

import type { LinkedFile, PlacedLayer } from 'ag-psd/dist/index';
import { createCanvas, ctx2d, docFromImage, joinParts, loadPsd, savePsd, scaled, walk, type Doc, type Layer } from './doc';
import { renderTiled } from './pixels';
import { flattenFullRes } from './render';

export type EmbeddedKind = 'psd' | 'png' | 'jpeg';

export interface SmartLink {
  file: LinkedFile & { data: Uint8Array };
  kind: EmbeddedKind;
  /** Set when the layer uses something we can't reproduce exactly when re-rendering. */
  warning?: string;
}

function sniff(d: Uint8Array): EmbeddedKind | null {
  if (d[0] === 0x38 && d[1] === 0x42 && d[2] === 0x50 && d[3] === 0x53) return 'psd'; // 8BPS
  if (d[0] === 0x89 && d[1] === 0x50 && d[2] === 0x4e && d[3] === 0x47) return 'png';
  if (d[0] === 0xff && d[1] === 0xd8 && d[2] === 0xff) return 'jpeg';
  return null;
}

/** What's inside a smart-object layer, or a sentence explaining why it can't be opened. */
export function smartLink(doc: Doc, layer: Layer): SmartLink | string {
  const pl = layer.raw.placedLayer;
  if (!pl || layer.kind !== 'smart') return 'This layer isn’t a smart object.';
  const file = doc.raw.linkedFiles?.find(f => f.id === pl.id);
  if (!file) return 'This smart object’s contents are missing from the file.';
  if (file.linkedFile || !file.data) {
    return `This smart object is linked to an outside file (${file.linkedFile?.name || file.name}) rather than stored in the template, so it can’t be opened here.`;
  }
  const kind = sniff(file.data);
  if (!kind) {
    return `This smart object contains ${file.name ? `“${file.name}”` : 'a file'}, a type that can’t be edited here (only PSD/PSB, PNG and JPEG).`;
  }
  const warning = isWarped(pl)
    ? 'This smart object is warped in the template. After you apply your edits it’s placed using its corner positions, without the warp.'
    : pl.filter ? 'This smart object has smart filters, which won’t be re-applied to your edits.' : undefined;
  return { file: file as SmartLink['file'], kind, warning };
}

/** Photoshop stores an unwarped smart object as a "custom" warp whose mesh is an even grid. */
function isWarped(pl: PlacedLayer): boolean {
  const w = pl.warp;
  if (!w || !w.style || w.style === 'none') return false;
  if (w.style !== 'custom') return !!(w.value || w.perspective || w.perspectiveOther);
  const mesh = w.customEnvelopeWarp;
  if (!mesh) return false;
  if (mesh.quiltSliceX?.length || mesh.quiltSliceY?.length) return true;
  const b = w.bounds;
  const left = b?.left.value ?? 0, top = b?.top.value ?? 0;
  const width = (b?.right.value ?? pl.width ?? 0) - left, height = (b?.bottom.value ?? pl.height ?? 0) - top;
  const cols = w.uOrder ?? 4, rows = w.vOrder ?? 4;
  const tol = Math.max(0.5, 1e-4 * Math.max(width, height));
  return mesh.meshPoints.some((p, k) => {
    const i = k % cols, j = Math.floor(k / cols);
    return Math.abs(p.x - (left + (i * width) / (cols - 1))) > tol || Math.abs(p.y - (top + (j * height) / (rows - 1))) > tol;
  });
}

export async function openSmartObject(link: SmartLink, progress: (msg: string) => void): Promise<Doc> {
  const { data, name } = link.file;
  let doc: Doc;
  if (link.kind === 'psd') {
    doc = await loadPsd([data as Uint8Array<ArrayBuffer>], name, progress);
  } else {
    const bmp = await createImageBitmap(new Blob([data as BlobPart]));
    doc = docFromImage(bmp, name);
    bmp.close();
  }
  doc.name = name || 'Smart object';
  return doc;
}

/** Encodes the edited contents in their original format, plus the flattened image for the parent. */
export async function encodeSmartObject(inner: Doc, kind: EmbeddedKind, progress: (msg: string) => void) {
  progress('Flattening smart object');
  await new Promise(r => setTimeout(r, 0));
  const flat = flattenFullRes(inner);
  if (!flat) throw new Error('the smart object is too large to flatten in the browser');
  let bytes: Uint8Array;
  if (kind === 'psd') {
    const t = Math.min(1, 160 / Math.max(flat.width, flat.height));
    const thumb = createCanvas(Math.round(flat.width * t), Math.round(flat.height * t));
    ctx2d(thumb).drawImage(flat, 0, 0, thumb.width, thumb.height);
    bytes = joinParts((await savePsd(inner, flat, thumb, progress)).parts);
  } else {
    let src = flat;
    if (kind === 'jpeg') {
      // JPEG has no transparency; flatten onto white like Photoshop does.
      src = createCanvas(flat.width, flat.height);
      const g = ctx2d(src);
      g.fillStyle = '#fff';
      g.fillRect(0, 0, src.width, src.height);
      g.drawImage(flat, 0, 0);
    }
    const blob = await new Promise<Blob | null>(r => src.toBlob(r, kind === 'png' ? 'image/png' : 'image/jpeg', 0.95));
    if (!blob) throw new Error('couldn’t encode the image');
    bytes = new Uint8Array(await blob.arrayBuffer());
  }
  return { bytes, flat };
}

// ---------------------------------------------------------------------------
// Drawing the contents through the layer's transform

type Pt = { x: number; y: number };

/** The four corners (top-left, top-right, bottom-right, bottom-left) in document coordinates. */
function corners(pl: PlacedLayer, dx: number, dy: number): Pt[] {
  const t = pl.nonAffineTransform?.length === 8 ? pl.nonAffineTransform : pl.transform;
  return [0, 2, 4, 6].map(i => ({ x: t[i] + dx, y: t[i + 1] + dy }));
}

/** Affine transform taking triangle s0,s1,s2 onto d0,d1,d2, as canvas setTransform arguments. */
function triangleTransform(s: Pt[], d: Pt[]): [number, number, number, number, number, number] {
  const sx1 = s[1].x - s[0].x, sy1 = s[1].y - s[0].y, sx2 = s[2].x - s[0].x, sy2 = s[2].y - s[0].y;
  const dx1 = d[1].x - d[0].x, dy1 = d[1].y - d[0].y, dx2 = d[2].x - d[0].x, dy2 = d[2].y - d[0].y;
  const det = sx1 * sy2 - sx2 * sy1;
  const a = (dx1 * sy2 - dx2 * sy1) / det;
  const c = (dx2 * sx1 - dx1 * sx2) / det;
  const b = (dy1 * sy2 - dy2 * sy1) / det;
  const dd = (dy2 * sx1 - dy1 * sx2) / det;
  return [a, b, c, dd, d[0].x - a * s[0].x - c * s[0].y, d[0].y - b * s[0].x - dd * s[0].y];
}

/** Maps the unit square onto the quad (projective), or null if the quad is a parallelogram. */
function homography(q: Pt[]): ((u: number, v: number) => Pt) | null {
  const [p0, p1, p2, p3] = q;
  const dx3 = p0.x - p1.x + p2.x - p3.x;
  const dy3 = p0.y - p1.y + p2.y - p3.y;
  const scale = Math.max(1, Math.hypot(p1.x - p0.x, p1.y - p0.y), Math.hypot(p3.x - p0.x, p3.y - p0.y));
  if (Math.abs(dx3) < 1e-6 * scale && Math.abs(dy3) < 1e-6 * scale) return null;
  const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, dy1 = p1.y - p2.y, dy2 = p3.y - p2.y;
  const den = dx1 * dy2 - dx2 * dy1;
  const g = (dx3 * dy2 - dx2 * dy3) / den;
  const h = (dx1 * dy3 - dx3 * dy1) / den;
  const a = p1.x - p0.x + g * p1.x, b = p3.x - p0.x + h * p3.x;
  const d = p1.y - p0.y + g * p1.y, e = p3.y - p0.y + h * p3.y;
  return (u, v) => {
    const w = g * u + h * v + 1;
    return { x: (a * u + b * v + p0.x) / w, y: (d * u + e * v + p0.y) / w };
  };
}

/** Draws `img` (iw × ih) so its corners land on the quad, in the context's current coordinates. */
function drawThroughQuad(g: CanvasRenderingContext2D, img: CanvasImageSource, iw: number, ih: number, q: Pt[]) {
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  const base = g.getTransform();
  const H = homography(q);
  if (!H) {
    g.transform(...triangleTransform([{ x: 0, y: 0 }, { x: iw, y: 0 }, { x: 0, y: ih }], [q[0], q[1], q[3]]));
    g.drawImage(img, 0, 0);
    g.setTransform(base);
    return;
  }
  // Perspective: split into small triangles, each drawn with its own affine transform.
  const N = 32;
  const grid: Pt[][] = [];
  for (let j = 0; j <= N; j++) grid.push(Array.from({ length: N + 1 }, (_, i) => H(i / N, j / N)));
  const src = (i: number, j: number): Pt => ({ x: (i / N) * iw, y: (j / N) * ih });
  // The part of the quad's coordinate space this canvas shows (our callers only translate and scale).
  const vis = {
    x0: -base.e / base.a, y0: -base.f / base.d,
    x1: (g.canvas.width - base.e) / base.a, y1: (g.canvas.height - base.f) / base.d,
  };
  const cw = iw / N, ch = ih / N;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const cell = [grid[j][i], grid[j][i + 1], grid[j + 1][i], grid[j + 1][i + 1]];
      if (Math.max(...cell.map(p => p.x)) < vis.x0 - 2 || Math.min(...cell.map(p => p.x)) > vis.x1 + 2 ||
        Math.max(...cell.map(p => p.y)) < vis.y0 - 2 || Math.min(...cell.map(p => p.y)) > vis.y1 + 2) continue;
      // Only this cell's pixels (plus a margin) are needed for its two triangles.
      const sx = Math.max(0, Math.floor(i * cw) - 2), sy = Math.max(0, Math.floor(j * ch) - 2);
      const sw = Math.min(iw, Math.ceil((i + 1) * cw) + 2) - sx, sh = Math.min(ih, Math.ceil((j + 1) * ch) + 2) - sy;
      for (const tri of [[[i, j], [i + 1, j], [i, j + 1]], [[i + 1, j], [i + 1, j + 1], [i, j + 1]]]) {
        const d = tri.map(([x, y]) => grid[y][x]);
        const s = tri.map(([x, y]) => src(x, y));
        // Grow each triangle slightly so neighbours overlap instead of leaving hairline seams.
        const cx = (d[0].x + d[1].x + d[2].x) / 3, cy = (d[0].y + d[1].y + d[2].y) / 3;
        g.save();
        g.beginPath();
        d.forEach((p, k) => {
          const len = Math.hypot(p.x - cx, p.y - cy) || 1;
          const x = p.x + ((p.x - cx) / len) * 0.6, y = p.y + ((p.y - cy) / len) * 0.6;
          if (k) g.lineTo(x, y); else g.moveTo(x, y);
        });
        g.closePath();
        g.clip();
        g.transform(...triangleTransform(s, d));
        g.drawImage(img, sx, sy, sw, sh, sx, sy, sw, sh);
        g.restore();
      }
    }
  }
  g.setTransform(base);
}

/**
 * Stores the edited contents in the parent and re-renders every smart-object layer that uses them.
 * Mutates `parent` (call after pushing an undo snapshot).
 */
export function applySmartObject(parent: Doc, id: string, bytes: Uint8Array, flat: HTMLCanvasElement) {
  parent.raw = {
    ...parent.raw,
    linkedFiles: parent.raw.linkedFiles?.map(f => (f.id === id ? { ...f, data: bytes } : f)),
  };
  const s = parent.scale;
  let count = 0;
  for (const [l] of walk(parent.layers)) {
    const pl = l.raw.placedLayer;
    if (!pl || pl.id !== id || l.kind !== 'smart') continue;
    const q = corners(pl, l.left - l.originLeft, l.top - l.originTop);
    const left = Math.floor(Math.min(...q.map(p => p.x)));
    const top = Math.floor(Math.min(...q.map(p => p.y)));
    const width = Math.ceil(Math.max(...q.map(p => p.x))) - left;
    const height = Math.ceil(Math.max(...q.map(p => p.y))) - top;
    const local = q.map(p => ({ x: p.x - left, y: p.y - top }));

    const preview = createCanvas(scaled(width, s), scaled(height, s));
    const pg = ctx2d(preview);
    pg.scale(s, s);
    drawThroughQuad(pg, flat, flat.width, flat.height, local);

    // The transform now describes the current position, which becomes the new reference point.
    const shift = (t: number[] | undefined) => t?.map((v, i) => v + (i % 2 ? l.top - l.originTop : l.left - l.originLeft));
    l.raw = { ...l.raw, placedLayer: { ...pl, transform: shift(pl.transform)!, nonAffineTransform: shift(pl.nonAffineTransform) } };
    l.left = l.originLeft = left;
    l.top = l.originTop = top;
    l.width = width;
    l.height = height;
    l.canvas = preview;
    l.source = { width, height, decode: () => renderTiled(width, height, g => drawThroughQuad(g, flat, flat.width, flat.height, local)) };
    l.ops = [];
    l.replaced = true;
    count++;
  }
  return count;
}
