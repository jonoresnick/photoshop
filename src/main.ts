import type { BlendMode } from 'ag-psd';
import { ADJUSTMENTS } from './adjust';
import {
  cloneCanvas, cloneLayers, createCanvas, ctx2d, docFromImage, duplicateLayer, findLayer, layerFromCanvas, loadPsd,
  makeGroup, makeLayer, newDoc, savePsd, scaled, walk, type Doc, type Layer,
} from './doc';
import { readFileChunks } from './bigfile';
import { brushTip, floodFill, type Op } from './pixels';
import { EXACT_BLEND_MODES, flatten, previewSize, renderDoc } from './render';
import { zipSingleFile } from './zip';

type Tool = 'move' | 'brush' | 'eraser' | 'bucket' | 'eyedropper' | 'hand';

// Minimal File System Access API typings (Chromium only).
interface FileHandle {
  name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(data: Blob | BufferSource): Promise<void>; close(): Promise<void> }>;
}
type PickerWindow = Window & {
  showOpenFilePicker?: (o?: object) => Promise<FileHandle[]>;
  showSaveFilePicker?: (o?: object) => Promise<FileHandle>;
};
const pickerWin = window as PickerWindow;
const canUsePickers = !!pickerWin.showOpenFilePicker && window.self === window.top;

// When hosted as a claude.ai artifact, downloads go through the viewer's `downloads` capability,
// which only accepts certain extensions, so PSDs are delivered inside a .zip there.
interface HostDownloads { save(r: { filename: string; data: Blob }): Promise<unknown> }
type HostWindow = Window & { claude?: { use(name: 'downloads'): Promise<HostDownloads | null> } };
const hostDownloads: Promise<HostDownloads | null> = (window as HostWindow).claude?.use('downloads').catch(() => null) ?? Promise.resolve(null);

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

const viewport = $('#viewport');
const stage = $('#stage');
const view = $<HTMLCanvasElement>('#view');
const viewCtx = ctx2d(view);
const layerList = $('#layer-list');
const blendSelect = $<HTMLSelectElement>('#blend');
const opacityNum = $<HTMLInputElement>('#layer-opacity');
const opacityRange = $<HTMLInputElement>('#layer-opacity-range');
const colorInput = $<HTMLInputElement>('#color');
const brushCursor = $('#brush-cursor');

// ---------------------------------------------------------------------------
// State

let doc: Doc | null = null;
let fileHandle: FileHandle | null = null;
let selectedId: number | null = null;
let tool: Tool = 'brush';
let dirty = false;
const brush = { size: 24, hardness: 0.8, opacity: 1, tolerance: 32 };
let zoom = 1;
let panX = 0;
let panY = 0;
let spaceDown = false;

interface Snapshot { layers: Layer[]; selectedId: number | null; width: number; height: number }
const undoStack: Snapshot[] = [];
const redoStack: Snapshot[] = [];
const HISTORY_LIMIT = 40;

const snapshot = (): Snapshot => ({ layers: cloneLayers(doc!.layers), selectedId, width: doc!.width, height: doc!.height });

function pushHistory() {
  if (!doc) return;
  undoStack.push(snapshot());
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  redoStack.length = 0;
  setDirty(true);
}

function restore(s: Snapshot) {
  doc!.layers = s.layers;
  doc!.width = s.width;
  doc!.height = s.height;
  selectedId = s.selectedId;
  setDirty(true);
  refreshAll();
}

function undo() {
  const s = undoStack.pop();
  if (!s || !doc) return;
  redoStack.push(snapshot());
  restore(s);
}

function redo() {
  const s = redoStack.pop();
  if (!s || !doc) return;
  undoStack.push(snapshot());
  restore(s);
}

function setDirty(v: boolean) {
  dirty = v;
  updateTitle();
}

// ---------------------------------------------------------------------------
// Status / busy

let msgTimer = 0;
function status(msg: string, error = false) {
  const el = $('#status-msg');
  el.textContent = msg;
  el.classList.toggle('error', error);
  clearTimeout(msgTimer);
  msgTimer = window.setTimeout(() => (el.textContent = ''), error ? 8000 : 4000);
}

const busyText = (text: string) => ($('#busy-text').textContent = text);

async function busy<T>(text: string, fn: () => T | Promise<T>): Promise<T> {
  busyText(text);
  $('#busy').hidden = false;
  // Let the overlay paint before blocking work starts.
  await new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
  try {
    return await fn();
  } finally {
    $('#busy').hidden = true;
  }
}

function updateTitle() {
  const t = doc ? `${doc.name}${dirty ? ' •' : ''}` : '';
  $('#doc-title').textContent = t;
  document.title = doc ? `${t} — Mini Photoshop` : 'Mini Photoshop';
}

// ---------------------------------------------------------------------------
// Rendering

let renderQueued = false;
let pendingStroke: (() => void) | null = null;

function requestRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    pendingStroke?.();
    pendingStroke = null;
    if (doc) renderDoc(viewCtx, doc);
  });
}

function applyView() {
  if (!doc) return;
  stage.style.transform = `translate(${Math.round(panX)}px, ${Math.round(panY)}px)`;
  view.style.width = `${doc.width * zoom}px`;
  view.style.height = `${doc.height * zoom}px`;
  view.classList.toggle('pixelated', zoom >= 2);
  $('#status-zoom').textContent = `${Math.round(zoom * 1000) / 10}%`;
  updateBrushCursorSize();
}

function fitView() {
  if (!doc) return;
  const r = viewport.getBoundingClientRect();
  zoom = Math.min((r.width - 48) / doc.width, (r.height - 48) / doc.height, 1);
  zoom = Math.max(zoom, 0.01);
  panX = (r.width - doc.width * zoom) / 2;
  panY = (r.height - doc.height * zoom) / 2;
  applyView();
}

function zoomAt(factor: number, cx?: number, cy?: number) {
  if (!doc) return;
  const r = viewport.getBoundingClientRect();
  cx ??= r.width / 2;
  cy ??= r.height / 2;
  const next = Math.min(64, Math.max(0.01, zoom * factor));
  panX = cx - (cx - panX) * (next / zoom);
  panY = cy - (cy - panY) * (next / zoom);
  zoom = next;
  applyView();
}

function setZoom(z: number) {
  zoomAt(z / zoom);
}

function toDoc(e: { clientX: number; clientY: number }) {
  const r = viewport.getBoundingClientRect();
  return { x: (e.clientX - r.left - panX) / zoom, y: (e.clientY - r.top - panY) / zoom };
}

// ---------------------------------------------------------------------------
// Document lifecycle

function setDoc(d: Doc, handle: FileHandle | null = null) {
  doc = d;
  fileHandle = handle;
  const { w, h } = previewSize(d);
  view.width = w;
  view.height = h;
  undoStack.length = 0;
  redoStack.length = 0;
  const top = d.layers[d.layers.length - 1];
  selectedId = top?.id ?? null;
  $('#empty').hidden = true;
  $('#status-size').textContent = `${d.width} × ${d.height}px` + (d.scale < 1 ? ` · previewing at ${Math.round(d.scale * 100)}%` : '');
  $('#status-size').title = d.scale < 1
    ? 'This document is too big to show at full resolution, so you see a smaller preview. Edits are applied at full resolution when you save.'
    : '';
  document.querySelectorAll<HTMLButtonElement>('[data-needs-doc]').forEach(b => (b.disabled = false));
  setDirty(false);
  fitView();
  refreshAll();
}

const isPsd = (name: string) => /\.(psd|psb)$/i.test(name);

async function openFile(file: File, handle: FileHandle | null = null) {
  if (dirty && !(await askConfirm(`Discard unsaved changes to ${doc!.name}?`, 'Discard'))) return;
  try {
    if (isPsd(file.name)) {
      const d = await busy(`Opening ${file.name}…`, async () => {
        const chunks = await readFileChunks(file, f => busyText(`Reading ${file.name}… ${Math.round(f * 100)}%`));
        return loadPsd(chunks, file.name, busyText);
      });
      setDoc(d, handle);
      const unsupported = countUnsupported(d);
      status(`Opened ${file.name}` + (unsupported ? ` · ${unsupported}` : ''));
    } else {
      const bmp = await createImageBitmap(file);
      setDoc(docFromImage(bmp, file.name));
      bmp.close();
      status(`Opened ${file.name}`);
    }
  } catch (err) {
    console.error(err);
    status(`Could not open ${file.name}: ${(err as Error).message}`, true);
  }
}

function countUnsupported(d: Doc): string {
  let fx = 0;
  let adj = 0;
  for (const [l] of walk(d.layers)) {
    if (l.raw.effects && !l.hidden) fx++;
    if (l.kind === 'adjustment') adj++;
  }
  const parts = [];
  if (fx) parts.push(`${fx} layer${fx > 1 ? 's' : ''} with effects (kept, not previewed)`);
  if (adj) parts.push(`${adj} adjustment layer${adj > 1 ? 's' : ''} (kept, not previewed)`);
  return parts.join(', ');
}

async function cmdOpen() {
  if (canUsePickers) {
    try {
      const [h] = await pickerWin.showOpenFilePicker!({
        types: [
          { description: 'Photoshop', accept: { 'image/vnd.adobe.photoshop': ['.psd', '.psb'] } },
          { description: 'Images', accept: { 'image/*': ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'] } },
        ],
      });
      await openFile(await h.getFile(), isPsd(h.name) ? h : null);
    } catch (err) {
      if ((err as Error).name !== 'AbortError') status((err as Error).message, true);
    }
    return;
  }
  $<HTMLInputElement>('#file-open').click();
}

const MAX_COMPOSITE_PIXELS = 64_000_000;

async function encodePsd(): Promise<{ parts: Uint8Array[]; name: string }> {
  const d = doc!;
  return busy('Saving…', async () => {
    const preview = flatten(d);
    // The flattened image is only exact when we're working at full resolution; otherwise Photoshop rebuilds it.
    const composite = d.scale === 1 && d.width * d.height <= MAX_COMPOSITE_PIXELS ? preview : null;
    const t = Math.min(1, 160 / Math.max(preview.width, preview.height));
    const thumb = createCanvas(Math.round(preview.width * t), Math.round(preview.height * t));
    ctx2d(thumb).drawImage(preview, 0, 0, thumb.width, thumb.height);
    const { parts, psb } = await savePsd(d, composite, thumb, busyText);
    return { parts, name: d.name.replace(/\.[^.]+$/, '') + (psb ? '.psb' : '.psd') };
  });
}

const psdName = () => doc!.name.replace(/\.[^.]+$/, '') + (/\.psb$/i.test(doc!.name) ? '.psb' : '.psd');

async function cmdSave(): Promise<void> {
  if (!doc) return;
  if (!fileHandle) return cmdSaveAs();
  try {
    const { parts } = await encodePsd();
    const w = await busy('Writing file…', () => fileHandle!.createWritable());
    // Stream the pieces to disk; a multi-gigabyte file never has to exist in memory as one Blob.
    for (const part of parts) await w.write(part as BufferSource);
    await w.close();
    setDirty(false);
    status(`Saved ${fileHandle.name}`);
  } catch (err) {
    console.error(err);
    status(`Save failed: ${(err as Error).message}`, true);
  }
}

async function cmdSaveAs(): Promise<void> {
  if (!doc) return;
  try {
    const host = await hostDownloads;
    if (!host && canUsePickers && pickerWin.showSaveFilePicker) {
      let handle: FileHandle;
      try {
        handle = await pickerWin.showSaveFilePicker({
          suggestedName: psdName(),
          types: [{ description: 'Photoshop', accept: { 'image/vnd.adobe.photoshop': ['.psd', '.psb'] } }],
        });
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        throw err;
      }
      fileHandle = handle;
      doc.name = handle.name;
      return cmdSave();
    }
    const { parts, name } = await encodePsd();
    if (host) {
      const zipName = name.replace(/\.ps[db]$/i, '.zip');
      const zip = await busy('Packing zip…', () => zipSingleFile(name, parts));
      if (!(await blobUsable(zip))) return;
      if (await download(zip, zipName)) {
        setDirty(false);
        status(`Saved ${zipName} — unzip it to get ${name}`);
      }
      return;
    }
    const blob = new Blob(parts as BlobPart[], { type: 'image/vnd.adobe.photoshop' });
    if (!(await blobUsable(blob))) return;
    await download(blob, name);
    setDirty(false);
    status(`Downloaded ${name}`);
  } catch (err) {
    console.error(err);
    status(`Save failed: ${(err as Error).message}`, true);
  }
}

function cmdExport() {
  if (!doc) return;
  const name = doc.name.replace(/\.[^.]+$/, '') + '.png';
  const flat = flatten(doc);
  const note = doc.scale < 1 ? ` at ${flat.width} × ${flat.height}px (preview size — the document is too large to flatten at full resolution)` : '';
  flat.toBlob(async b => {
    if (!b) return status('Export failed', true);
    if (await download(b, name)) status(`Exported ${name}${note}`);
  }, 'image/png');
}

/**
 * Browsers keep Blobs in memory in private/incognito windows and can't hold one over ~2 GB there
 * (normal windows spill them to disk). Check up front instead of letting the download silently fail.
 */
async function blobUsable(blob: Blob): Promise<boolean> {
  if (blob.size < 1.9e9) return true;
  try {
    await blob.slice(blob.size - 1).arrayBuffer();
    return true;
  } catch {
    status(`The browser couldn’t hold the ${(blob.size / 1e9).toFixed(1)} GB file for download. ` +
      'Private/incognito windows can’t save files over 2 GB; use a normal window and try again.', true);
    return false;
  }
}

/** Resolves false if the viewer declined the save. */
async function download(blob: Blob, name: string): Promise<boolean> {
  const host = await hostDownloads;
  if (host) {
    try {
      await host.save({ filename: name, data: blob });
      return true;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'declined') status('Save cancelled');
      else status(`Couldn’t save ${name}: ${(err as Error).message ?? code}`, true);
      return false;
    }
  }
  // A multi-gigabyte download can take minutes to stream out of the blob, and revoking its URL
  // cancels it, so keep the URL until the next download (or ten minutes).
  if (lastDownloadUrl) URL.revokeObjectURL(lastDownloadUrl);
  const url = (lastDownloadUrl = URL.createObjectURL(blob));
  setTimeout(() => {
    URL.revokeObjectURL(url);
    if (lastDownloadUrl === url) lastDownloadUrl = null;
  }, 10 * 60_000);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  return true;
}

let lastDownloadUrl: string | null = null;

const confirmDialog = $<HTMLDialogElement>('#confirm-dialog');
function askConfirm(message: string, okLabel: string): Promise<boolean> {
  $('#confirm-text').textContent = message;
  $('#confirm-ok').textContent = okLabel;
  confirmDialog.returnValue = '';
  confirmDialog.showModal();
  return new Promise(resolve => (confirmDialog.onclose = () => resolve(confirmDialog.returnValue === 'ok')));
}

async function placeFile(file: File) {
  if (!doc) return openFile(file);
  try {
    let src: HTMLCanvasElement;
    if (isPsd(file.name)) {
      src = await busy(`Reading ${file.name}…`, async () => flatten(await loadPsd(await readFileChunks(file, () => {}), file.name, busyText)));
    } else {
      const bmp = await createImageBitmap(file);
      src = createCanvas(bmp.width, bmp.height);
      ctx2d(src).drawImage(bmp, 0, 0);
      bmp.close();
    }
    const layer = layerFromCanvas(file.name.replace(/\.[^.]+$/, ''), src, doc.scale,
      Math.round((doc.width - src.width) / 2), Math.round((doc.height - src.height) / 2));
    pushHistory();
    insertAboveSelected(layer);
    status(`Placed ${file.name}`);
  } catch (err) {
    console.error(err);
    status(`Could not place ${file.name}: ${(err as Error).message}`, true);
  }
}

// ---------------------------------------------------------------------------
// Layer operations

const selected = () => (doc && selectedId != null ? findLayer(doc, selectedId) : null);

function insertAboveSelected(layer: Layer) {
  const sel = selected();
  if (sel?.layer.children && sel.layer.opened) sel.layer.children.push(layer);
  else if (sel) sel.siblings.splice(sel.index + 1, 0, layer);
  else doc!.layers.push(layer);
  selectedId = layer.id;
  refreshAll();
}

function layerCount() {
  let n = 0;
  for (const [l] of walk(doc!.layers)) if (!l.children) n++;
  return n;
}

function cmdNewLayer() {
  if (!doc) return;
  pushHistory();
  insertAboveSelected(makeLayer(`Layer ${layerCount() + 1}`, null));
}

function cmdNewGroup() {
  if (!doc) return;
  pushHistory();
  const sel = selected();
  const group = makeGroup('Group');
  group.opened = true;
  if (sel) {
    // Wrap the selected layer in the new group, like Ctrl+G in Photoshop.
    sel.siblings.splice(sel.index, 1, group);
    group.children!.push(sel.layer);
  } else {
    doc.layers.push(group);
  }
  selectedId = group.id;
  refreshAll();
}

function cmdDuplicate() {
  const sel = selected();
  if (!sel) return;
  pushHistory();
  const copy = duplicateLayer(sel.layer);
  copy.name = `${sel.layer.name} copy`;
  sel.siblings.splice(sel.index + 1, 0, copy);
  selectedId = copy.id;
  refreshAll();
}

function cmdDelete() {
  const sel = selected();
  if (!sel) return;
  pushHistory();
  sel.siblings.splice(sel.index, 1);
  const next = sel.siblings[Math.min(sel.index, sel.siblings.length - 1)] ?? sel.parent;
  selectedId = next?.id ?? doc!.layers[doc!.layers.length - 1]?.id ?? null;
  refreshAll();
}

function cmdMove(dir: 1 | -1) {
  const sel = selected();
  if (!sel) return;
  const j = sel.index + dir;
  if (j < 0 || j >= sel.siblings.length) return;
  pushHistory();
  [sel.siblings[sel.index], sel.siblings[j]] = [sel.siblings[j], sel.siblings[sel.index]];
  refreshAll();
}

function cmdFlatten() {
  if (!doc) return;
  if (doc.scale < 1) return status('Flatten isn’t available for documents this large', true);
  pushHistory();
  const flat = createCanvas(doc.width, doc.height);
  const g = ctx2d(flat);
  g.fillStyle = '#fff';
  g.fillRect(0, 0, doc.width, doc.height);
  g.drawImage(flatten(doc), 0, 0);
  const layer = layerFromCanvas('Background', flat, 1);
  doc.layers = [layer];
  selectedId = layer.id;
  refreshAll();
}

function cmdToggleClip() {
  const sel = selected();
  if (!sel) return;
  pushHistory();
  sel.layer.clipping = !sel.layer.clipping;
  refreshAll();
}

function cmdToggleMask() {
  const sel = selected();
  if (!sel?.layer.mask) return status('Selected layer has no mask');
  pushHistory();
  sel.layer.mask.disabled = !sel.layer.mask.disabled;
  refreshAll();
}

/** Layers (non-groups) that would be affected by a move of `l`. */
function leafLayers(l: Layer): Layer[] {
  return l.children ? [...walk(l.children)].map(([x]) => x) : [l];
}

/** Appends an edit to be replayed on the full-resolution pixels when saving. */
function recordOp(layer: Layer, op: Op) {
  layer.ops = [...layer.ops, op];
}

/**
 * Prepares a layer for pixel editing: rasterizes text/smart/shape layers and swaps in a fresh copy of
 * the preview canvas (so undo snapshots keep the old one). With `expand`, the layer also grows to cover
 * the whole document so you can paint anywhere. Returns where the old preview sits in the new one.
 */
function beginPixelEdit(layer: Layer, expand: boolean): { base: HTMLCanvasElement | null; dx: number; dy: number } | null {
  if (layer.children) {
    status('Select a pixel layer — groups can’t be painted on', true);
    return null;
  }
  if (layer.kind === 'adjustment') {
    status('Adjustment layers have no pixels to edit', true);
    return null;
  }
  if (layer.kind !== 'pixel') {
    status(`Rasterized ${layer.kind} layer “${layer.name}”`);
    layer.kind = 'pixel';
    layer.rasterized = true;
  }
  const s = doc!.scale;
  const base = layer.canvas;
  let left = layer.left;
  let top = layer.top;
  let right = left + layer.width;
  let bottom = top + layer.height;
  if (!base || !layer.width || !layer.height) {
    left = 0; top = 0; right = doc!.width; bottom = doc!.height;
  } else if (expand) {
    left = Math.min(left, 0);
    top = Math.min(top, 0);
    right = Math.max(right, doc!.width);
    bottom = Math.max(bottom, doc!.height);
  }
  const width = right - left;
  const height = bottom - top;
  if (width !== layer.width || height !== layer.height) {
    recordOp(layer, { type: 'expand', dx: layer.left - left, dy: layer.top - top, width, height });
  }
  const c = createCanvas(scaled(width, s), scaled(height, s));
  const dx = Math.round(layer.left * s) - Math.round(left * s);
  const dy = Math.round(layer.top * s) - Math.round(top * s);
  if (base) ctx2d(c).drawImage(base, dx, dy);
  layer.canvas = c;
  layer.left = left;
  layer.top = top;
  layer.width = width;
  layer.height = height;
  return { base, dx, dy };
}

function transformLayer(flipX: boolean) {
  const sel = selected();
  if (!sel) return;
  const targets = leafLayers(sel.layer).filter(l => l.canvas);
  if (!targets.length) return;
  // Flip around the bounding box of everything being flipped.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const l of targets) {
    minX = Math.min(minX, l.left); minY = Math.min(minY, l.top);
    maxX = Math.max(maxX, l.left + l.width); maxY = Math.max(maxY, l.top + l.height);
  }
  pushHistory();
  for (const l of targets) {
    const src = l.canvas!;
    if (!beginPixelEdit(l, false)) continue;
    const g = ctx2d(l.canvas!);
    g.clearRect(0, 0, src.width, src.height);
    g.save();
    if (flipX) { g.translate(src.width, 0); g.scale(-1, 1); } else { g.translate(0, src.height); g.scale(1, -1); }
    g.drawImage(src, 0, 0);
    g.restore();
    recordOp(l, { type: 'flip', horizontal: flipX });
    if (flipX) l.left = minX + maxX - (l.left + l.width);
    else l.top = minY + maxY - (l.top + l.height);
  }
  refreshAll();
}

// ---------------------------------------------------------------------------
// Adjustments

const adjustDialog = $<HTMLDialogElement>('#adjust-dialog');

function cmdAdjust(id: string) {
  const def = ADJUSTMENTS.find(a => a.id === id)!;
  const sel = selected();
  if (!sel) return;
  if (!sel.layer.canvas || sel.layer.children) return status('Select a pixel layer to adjust', true);
  const layer = sel.layer;
  pushHistory();
  if (!beginPixelEdit(layer, false)) return void undoStack.pop();
  const target = layer.canvas!;
  const source = ctx2d(cloneCanvas(target)).getImageData(0, 0, target.width, target.height);
  const values: Record<string, number> = {};
  for (const p of def.params) values[p.key] = p.value;

  const apply = () => {
    const img = new ImageData(new Uint8ClampedArray(source.data), source.width, source.height);
    def.apply(img.data, values);
    ctx2d(target).putImageData(img, 0, 0);
    requestRender();
  };

  const commit = () => {
    apply();
    recordOp(layer, { type: 'adjust', id, values: { ...values } });
    refreshLayers();
  };
  if (!def.params.length) return commit();

  $('#adjust-title').textContent = def.title;
  const params = $('#adjust-params');
  params.innerHTML = '';
  let timer = 0;
  for (const p of def.params) {
    const row = document.createElement('label');
    row.innerHTML = `<span>${p.label}</span><input type="range" min="${p.min}" max="${p.max}" value="${p.value}" /><input type="number" min="${p.min}" max="${p.max}" value="${p.value}" />`;
    const [range, num] = row.querySelectorAll('input');
    const set = (v: number) => {
      values[p.key] = v;
      range.value = num.value = String(v);
      clearTimeout(timer);
      timer = window.setTimeout(apply, 16);
    };
    range.oninput = () => set(+range.value);
    num.oninput = () => set(Math.min(p.max, Math.max(p.min, +num.value || 0)));
    params.appendChild(row);
  }
  adjustDialog.onclose = () => {
    clearTimeout(timer);
    if (adjustDialog.returnValue === 'ok') {
      commit();
    } else {
      // Cancel: drop the snapshot we pushed and put things back.
      const s = undoStack.pop();
      if (s) restore(s);
    }
  };
  adjustDialog.returnValue = '';
  adjustDialog.showModal();
}

// ---------------------------------------------------------------------------
// Painting

interface Stroke {
  layer: Layer;
  base: HTMLCanvasElement | null;
  dx: number;
  dy: number;
  /** Preview-resolution stroke, composited over `base` with the brush opacity. */
  buffer: HTMLCanvasElement;
  last: { x: number; y: number };
  carry: number;
  /** Full-resolution dab positions, layer-local, recorded for replay on save. */
  op: Extract<Op, { type: 'stroke' }>;
}

let stroke: Stroke | null = null;

function startStroke(p: { x: number; y: number }, erase: boolean) {
  const sel = selected();
  if (!sel) return status('Create or select a layer first', true);
  if (sel.layer.hidden) return status('The selected layer is hidden', true);
  pushHistory();
  const prep = beginPixelEdit(sel.layer, true);
  if (!prep) return void undoStack.pop();
  const c = sel.layer.canvas!;
  const op: Stroke['op'] = {
    type: 'stroke', dabs: [], size: brush.size, hardness: brush.hardness, color: colorInput.value, opacity: brush.opacity, erase,
  };
  stroke = { layer: sel.layer, ...prep, buffer: createCanvas(c.width, c.height), last: p, carry: 0, op };
  dab(p.x, p.y);
  composeStroke();
}

/** Stamps the brush at full-resolution document coordinates (x, y). */
function dab(x: number, y: number) {
  const st = stroke!;
  const s = doc!.scale;
  const t = brushTip(st.op.size * s, st.op.hardness, st.op.color);
  const px = x * s - Math.round(st.layer.left * s);
  const py = y * s - Math.round(st.layer.top * s);
  ctx2d(st.buffer).drawImage(t, px - t.width / 2, py - t.height / 2);
  st.op.dabs.push(x - st.layer.left, y - st.layer.top);
}

function continueStroke(p: { x: number; y: number }) {
  const s = stroke!;
  const spacing = Math.max(0.5, s.op.size * 0.1);
  const dist = Math.hypot(p.x - s.last.x, p.y - s.last.y);
  let t = spacing - s.carry;
  while (t <= dist) {
    const k = t / dist;
    dab(s.last.x + (p.x - s.last.x) * k, s.last.y + (p.y - s.last.y) * k);
    t += spacing;
  }
  s.carry = dist - (t - spacing);
  s.last = p;
  composeStroke();
}

function composeStroke() {
  pendingStroke = () => {
    const s = stroke;
    if (!s) return;
    const g = ctx2d(s.layer.canvas!);
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
    g.clearRect(0, 0, g.canvas.width, g.canvas.height);
    if (s.base) g.drawImage(s.base, s.dx, s.dy);
    g.globalAlpha = s.op.opacity;
    g.globalCompositeOperation = s.op.erase ? 'destination-out' : 'source-over';
    g.drawImage(s.buffer, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
  };
  requestRender();
}

function endStroke() {
  if (!stroke) return;
  pendingStroke?.();
  pendingStroke = null;
  recordOp(stroke.layer, stroke.op);
  stroke = null;
  refreshLayers();
}

function bucketFill(p: { x: number; y: number }) {
  const sel = selected();
  if (!sel) return;
  const px = Math.floor(p.x);
  const py = Math.floor(p.y);
  if (px < 0 || py < 0 || px >= doc!.width || py >= doc!.height) return;
  pushHistory();
  if (!beginPixelEdit(sel.layer, true)) return void undoStack.pop();
  const layer = sel.layer;
  const s = doc!.scale;
  const c = layer.canvas!;
  const g = ctx2d(c);
  const img = g.getImageData(0, 0, c.width, c.height);
  const sx = Math.min(c.width - 1, Math.floor(p.x * s) - Math.round(layer.left * s));
  const sy = Math.min(c.height - 1, Math.floor(p.y * s) - Math.round(layer.top * s));
  floodFill(img, sx, sy, brush.tolerance, colorInput.value, brush.opacity);
  g.putImageData(img, 0, 0);
  recordOp(layer, {
    type: 'fill', x: px - layer.left, y: py - layer.top, tolerance: brush.tolerance, color: colorInput.value, opacity: brush.opacity,
  });
  refreshAll();
}

function pickColor(p: { x: number; y: number }) {
  if (!doc) return;
  if (p.x < 0 || p.y < 0 || p.x >= doc.width || p.y >= doc.height) return;
  const x = Math.min(view.width - 1, Math.floor(p.x * doc.scale));
  const y = Math.min(view.height - 1, Math.floor(p.y * doc.scale));
  const [r, g, b, a] = viewCtx.getImageData(x, y, 1, 1).data;
  if (!a) return status('Transparent pixel');
  colorInput.value = '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
  status(`Picked ${colorInput.value}`);
}

/** Topmost visible leaf layer with an opaque pixel at p (for auto-select). */
function layerAt(p: { x: number; y: number }): Layer | null {
  const hits: Layer[] = [];
  const visit = (list: Layer[]) => {
    for (const l of list) {
      if (l.hidden) continue;
      if (l.children) { visit(l.children); continue; }
      if (!l.canvas) continue;
      const x = Math.floor(p.x * doc!.scale) - Math.round(l.left * doc!.scale);
      const y = Math.floor(p.y * doc!.scale) - Math.round(l.top * doc!.scale);
      if (x < 0 || y < 0 || x >= l.canvas.width || y >= l.canvas.height) continue;
      if (ctx2d(l.canvas).getImageData(x, y, 1, 1).data[3] > 10) hits.push(l);
    }
  };
  visit(doc!.layers);
  return hits[hits.length - 1] ?? null;
}

// ---------------------------------------------------------------------------
// Pointer input on the canvas

type Drag =
  | { kind: 'pan'; sx: number; sy: number; px: number; py: number }
  | { kind: 'move'; sx: number; sy: number; items: { l: Layer; left: number; top: number; ml: number; mt: number }[]; moved: boolean }
  | { kind: 'paint' };
let drag: Drag | null = null;

viewport.addEventListener('pointerdown', e => {
  if (!doc || (e.target as HTMLElement).closest('.empty')) return;
  if (e.button !== 0 && e.button !== 1) return;
  viewport.setPointerCapture(e.pointerId);
  const p = toDoc(e);
  if (e.button === 1 || spaceDown || tool === 'hand') {
    drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, px: panX, py: panY };
    updateCursor();
    return;
  }
  switch (tool) {
    case 'move': {
      if ($<HTMLInputElement>('#opt-autoselect').checked || e.ctrlKey || e.metaKey) {
        const hit = layerAt(p);
        if (hit) { selectedId = hit.id; refreshLayers(); }
      }
      const sel = selected();
      if (!sel) return;
      const items = leafLayers(sel.layer).map(l => ({ l, left: l.left, top: l.top, ml: l.mask?.left ?? 0, mt: l.mask?.top ?? 0 }));
      drag = { kind: 'move', sx: p.x, sy: p.y, items, moved: false };
      break;
    }
    case 'brush':
    case 'eraser':
      startStroke(p, tool === 'eraser');
      if (stroke) drag = { kind: 'paint' };
      break;
    case 'bucket':
      bucketFill(p);
      break;
    case 'eyedropper':
      pickColor(p);
      break;
  }
});

viewport.addEventListener('pointermove', e => {
  if (!doc) return;
  const p = toDoc(e);
  $('#status-pos').textContent = `${Math.floor(p.x)}, ${Math.floor(p.y)}`;
  positionBrushCursor(e);
  if (!drag) return;
  if (drag.kind === 'pan') {
    panX = drag.px + e.clientX - drag.sx;
    panY = drag.py + e.clientY - drag.sy;
    applyView();
  } else if (drag.kind === 'move') {
    const dx = Math.round(p.x - drag.sx);
    const dy = Math.round(p.y - drag.sy);
    if (!drag.moved && (dx || dy)) {
      pushHistory();
      drag.moved = true;
    }
    for (const it of drag.items) {
      it.l.left = it.left + dx;
      it.l.top = it.top + dy;
      if (it.l.mask) { it.l.mask.left = it.ml + dx; it.l.mask.top = it.mt + dy; }
    }
    requestRender();
  } else if (drag.kind === 'paint' && stroke) {
    const events = e.getCoalescedEvents?.() ?? [e];
    for (const ev of events.length ? events : [e]) continueStroke(toDoc(ev));
  }
});

const endDrag = () => {
  if (drag?.kind === 'paint') endStroke();
  if (drag?.kind === 'move' && drag.moved) refreshLayers();
  drag = null;
  updateCursor();
};
viewport.addEventListener('pointerup', endDrag);
viewport.addEventListener('pointercancel', endDrag);
viewport.addEventListener('pointerleave', () => (brushCursor.style.display = 'none'));
viewport.addEventListener('pointerenter', () => updateCursor());

viewport.addEventListener('wheel', e => {
  if (!doc) return;
  e.preventDefault();
  if (e.ctrlKey || e.metaKey || e.altKey) {
    const r = viewport.getBoundingClientRect();
    const k = e.ctrlKey && !e.altKey ? 0.01 : 0.002; // pinch gestures arrive as ctrl+wheel with small deltas
    zoomAt(Math.exp(-e.deltaY * k), e.clientX - r.left, e.clientY - r.top);
  } else {
    panX -= e.deltaX;
    panY -= e.deltaY;
    applyView();
  }
}, { passive: false });

function updateCursor() {
  const paintTool = tool === 'brush' || tool === 'eraser';
  let c = 'default';
  if (drag?.kind === 'pan') c = 'grabbing';
  else if (spaceDown || tool === 'hand') c = 'grab';
  else if (tool === 'move') c = 'move';
  else if (paintTool) c = 'none';
  else c = 'crosshair';
  viewport.dataset.cursor = c;
  brushCursor.style.display = c === 'none' && doc ? 'block' : 'none';
}

function updateBrushCursorSize() {
  const d = Math.max(4, brush.size * zoom);
  brushCursor.style.width = brushCursor.style.height = `${d}px`;
}

function positionBrushCursor(e: PointerEvent) {
  const r = viewport.getBoundingClientRect();
  brushCursor.style.left = `${e.clientX - r.left}px`;
  brushCursor.style.top = `${e.clientY - r.top}px`;
}

// ---------------------------------------------------------------------------
// Layers panel

const ICON_EYE = '<svg viewBox="0 0 24 24"><path d="M12 5C6 5 2 12 2 12s4 7 10 7 10-7 10-7-4-7-10-7zm0 11a4 4 0 1 1 0-8 4 4 0 0 1 0 8z"/></svg>';
const ICON_CARET = '<svg viewBox="0 0 24 24"><path d="M8 4l10 8-10 8z"/></svg>';
const ICON_FOLDER = '<svg viewBox="0 0 24 24"><path d="M3 5a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';

const ALL_BLEND_MODES: BlendMode[] = [
  'normal', 'dissolve', 'darken', 'multiply', 'color burn', 'linear burn', 'darker color', 'lighten', 'screen',
  'color dodge', 'linear dodge', 'lighter color', 'overlay', 'soft light', 'hard light', 'vivid light',
  'linear light', 'pin light', 'hard mix', 'difference', 'exclusion', 'subtract', 'divide', 'hue', 'saturation',
  'color', 'luminosity',
];

/** Draws a preview canvas covering the given full-resolution bounds into a layer thumbnail. */
function drawThumb(c: HTMLCanvasElement, src: HTMLCanvasElement | null, left: number, top: number, width: number, height: number) {
  const size = 34;
  const dpr = window.devicePixelRatio || 1;
  c.width = c.height = size * dpr;
  if (!src || !doc) return null;
  const g = ctx2d(c);
  const s = (size * dpr) / Math.max(doc.width, doc.height);
  const ox = (size * dpr - doc.width * s) / 2;
  const oy = (size * dpr - doc.height * s) / 2;
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, ox + left * s, oy + top * s, width * s, height * s);
  return g;
}

/** Mask thumbnail: white where the layer shows, black where it's hidden. */
function drawMaskThumb(c: HTMLCanvasElement, m: NonNullable<Layer['mask']>) {
  const g = drawThumb(c, m.alpha, m.left, m.top, m.width, m.height);
  if (!g) return;
  // The alpha canvas marks revealed pixels, or hidden ones when the mask's default is "reveal".
  const reveal = m.defaultColor < 128;
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = reveal ? '#fff' : '#000';
  g.fillRect(0, 0, c.width, c.height);
  g.globalCompositeOperation = 'destination-over';
  g.fillStyle = reveal ? '#000' : '#fff';
  g.fillRect(0, 0, c.width, c.height);
}

function badge(text: string, title: string) {
  const b = document.createElement('span');
  b.className = 'badge';
  b.textContent = text;
  b.title = title;
  return b;
}

let dragLayerId: number | null = null;

function refreshLayers() {
  layerList.innerHTML = '';
  if (!doc) return;
  const frag = document.createDocumentFragment();
  const addRows = (list: Layer[], depth: number) => {
    for (let i = list.length - 1; i >= 0; i--) {
      const l = list[i];
      frag.appendChild(layerRow(l, depth));
      if (l.children && l.opened) addRows(l.children, depth + 1);
    }
  };
  addRows(doc.layers, 0);
  layerList.appendChild(frag);
  refreshLayerProps();
}

function layerRow(l: Layer, depth: number): HTMLElement {
  const row = document.createElement('div');
  row.className = 'layer-row';
  row.classList.toggle('selected', l.id === selectedId);
  row.classList.toggle('hidden-layer', l.hidden);
  row.classList.toggle('clipped', l.clipping);
  row.style.setProperty('--depth', String(depth));
  row.dataset.id = String(l.id);
  row.draggable = true;

  const eye = document.createElement('button');
  eye.className = 'eye' + (l.hidden ? ' off' : '');
  eye.innerHTML = ICON_EYE;
  eye.title = l.hidden ? 'Show layer' : 'Hide layer';
  eye.onclick = e => {
    e.stopPropagation();
    pushHistory();
    l.hidden = !l.hidden;
    refreshAll();
  };
  row.appendChild(eye);

  if (l.children) {
    const caret = document.createElement('button');
    caret.className = 'caret' + (l.opened ? ' open' : '');
    caret.innerHTML = ICON_CARET;
    caret.onclick = e => {
      e.stopPropagation();
      l.opened = !l.opened;
      refreshLayers();
    };
    row.appendChild(caret);
    const folder = document.createElement('div');
    folder.className = 'thumb folder';
    folder.innerHTML = ICON_FOLDER;
    row.appendChild(folder);
  } else {
    const thumb = document.createElement('canvas');
    thumb.className = 'thumb';
    drawThumb(thumb, l.canvas, l.left, l.top, l.width, l.height);
    row.appendChild(thumb);
  }
  if (l.mask) {
    const m = document.createElement('canvas');
    m.className = 'thumb mask' + (l.mask.disabled ? ' disabled' : '');
    m.title = l.mask.disabled ? 'Layer mask (disabled)' : 'Layer mask';
    drawMaskThumb(m, l.mask);
    row.appendChild(m);
  }

  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = l.name;
  name.title = l.name;
  name.ondblclick = e => {
    e.stopPropagation();
    renameLayer(l, name);
  };
  row.appendChild(name);

  const badges = document.createElement('span');
  badges.className = 'badges';
  if (l.kind === 'text') badges.appendChild(badge('T', 'Text layer (shown as rendered; editing pixels rasterizes it)'));
  if (l.kind === 'smart') badges.appendChild(badge('SO', 'Smart object (editing pixels rasterizes it)'));
  if (l.kind === 'shape') badges.appendChild(badge('◆', 'Shape / vector layer'));
  if (l.kind === 'adjustment') badges.appendChild(badge('ADJ', 'Adjustment layer — kept in the file but not previewed'));
  if (l.raw.effects) badges.appendChild(badge('fx', 'Layer effects — kept in the file but not previewed'));
  if (!l.children && !EXACT_BLEND_MODES.includes(l.blendMode) && l.blendMode !== 'normal')
    badges.appendChild(badge('≈', `“${l.blendMode}” blend mode is approximated in the preview`));
  row.appendChild(badges);

  row.onclick = () => {
    selectedId = l.id;
    refreshLayers();
  };

  row.ondragstart = e => {
    dragLayerId = l.id;
    e.dataTransfer!.effectAllowed = 'move';
    e.dataTransfer!.setData('text/plain', String(l.id));
  };
  row.ondragend = () => {
    dragLayerId = null;
    clearDropMarks();
  };
  row.ondragover = e => {
    if (dragLayerId == null || dragLayerId === l.id) return;
    e.preventDefault();
    clearDropMarks();
    row.classList.add(`drop-${dropZone(e, row, l)}`);
  };
  row.ondragleave = () => row.classList.remove('drop-above', 'drop-below', 'drop-into');
  row.ondrop = e => {
    e.preventDefault();
    if (dragLayerId == null) return;
    moveLayerTo(dragLayerId, l.id, dropZone(e, row, l));
    dragLayerId = null;
  };
  return row;
}

function dropZone(e: DragEvent, row: HTMLElement, target: Layer): 'above' | 'below' | 'into' {
  const r = row.getBoundingClientRect();
  const f = (e.clientY - r.top) / r.height;
  if (target.children && f > 0.25 && f < 0.75) return 'into';
  return f < 0.5 ? 'above' : 'below';
}

function clearDropMarks() {
  layerList.querySelectorAll('.drop-above, .drop-below, .drop-into').forEach(el => el.classList.remove('drop-above', 'drop-below', 'drop-into'));
}

function moveLayerTo(id: number, targetId: number, zone: 'above' | 'below' | 'into') {
  const src = findLayer(doc!, id);
  if (!src) return;
  // Can't drop a group into itself.
  for (const [l] of walk([src.layer])) if (l.id === targetId) return;
  pushHistory();
  src.siblings.splice(src.index, 1);
  const dst = findLayer(doc!, targetId)!;
  if (zone === 'into') {
    dst.layer.children!.push(src.layer);
    dst.layer.opened = true;
  } else {
    // The list shows the top of the stack first, so "above" means a higher index.
    dst.siblings.splice(zone === 'above' ? dst.index + 1 : dst.index, 0, src.layer);
  }
  selectedId = id;
  refreshAll();
}

function renameLayer(l: Layer, el: HTMLElement) {
  const input = document.createElement('input');
  input.value = l.name;
  el.textContent = '';
  el.appendChild(input);
  input.focus();
  input.select();
  let done = false;
  const commit = (save: boolean) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (save && v && v !== l.name) {
      pushHistory();
      l.name = v;
    }
    refreshLayers();
  };
  input.onkeydown = e => {
    e.stopPropagation();
    if (e.key === 'Enter') commit(true);
    if (e.key === 'Escape') commit(false);
  };
  input.onblur = () => commit(true);
  input.onclick = e => e.stopPropagation();
}

function refreshLayerProps() {
  const sel = selected();
  const l = sel?.layer;
  blendSelect.innerHTML = '';
  const modes = l?.children ? (['pass through', ...ALL_BLEND_MODES] as BlendMode[]) : ALL_BLEND_MODES;
  for (const m of modes) {
    const o = document.createElement('option');
    o.value = m;
    o.textContent = m.replace(/\b\w/g, c => c.toUpperCase());
    blendSelect.appendChild(o);
  }
  blendSelect.value = l?.blendMode ?? 'normal';
  blendSelect.disabled = opacityNum.disabled = opacityRange.disabled = !l;
  const op = Math.round((l?.opacity ?? 1) * 100);
  opacityNum.value = opacityRange.value = String(op);
}

blendSelect.onchange = () => {
  const l = selected()?.layer;
  if (!l) return;
  pushHistory();
  l.blendMode = blendSelect.value as BlendMode;
  refreshAll();
};

// One undo step per slider drag rather than per input event.
let opacityEditing = false;
function setLayerOpacity(v: number) {
  const l = selected()?.layer;
  if (!l) return;
  if (!opacityEditing) {
    pushHistory();
    opacityEditing = true;
  }
  l.opacity = Math.min(100, Math.max(0, v)) / 100;
  opacityNum.value = opacityRange.value = String(Math.round(l.opacity * 100));
  requestRender();
}
opacityRange.oninput = () => setLayerOpacity(+opacityRange.value);
opacityNum.oninput = () => setLayerOpacity(+opacityNum.value || 0);
opacityRange.onchange = opacityNum.onchange = () => (opacityEditing = false);

function refreshAll() {
  refreshLayers();
  requestRender();
}

// ---------------------------------------------------------------------------
// Tools & options

function setTool(t: Tool) {
  tool = t;
  document.querySelectorAll<HTMLElement>('[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
  document.querySelectorAll<HTMLElement>('.opt').forEach(o => o.classList.toggle('show', o.dataset.for!.split(' ').includes(t)));
  updateCursor();
}

document.querySelectorAll<HTMLElement>('[data-tool]').forEach(b => (b.onclick = () => setTool(b.dataset.tool as Tool)));

const sizeRange = $<HTMLInputElement>('#opt-size');
const sizeNum = $<HTMLInputElement>('#opt-size-num');
function setBrushSize(v: number) {
  brush.size = Math.min(500, Math.max(1, Math.round(v)));
  sizeRange.value = sizeNum.value = String(brush.size);
  updateBrushCursorSize();
}
sizeRange.oninput = () => setBrushSize(+sizeRange.value);
sizeNum.oninput = () => setBrushSize(+sizeNum.value || 1);

function bindPercent(id: string, key: 'hardness' | 'opacity') {
  const input = $<HTMLInputElement>(`#${id}`);
  const out = $(`#${id}-out`);
  input.oninput = () => {
    brush[key] = +input.value / 100;
    out.textContent = `${input.value}%`;
  };
}
bindPercent('opt-hardness', 'hardness');
bindPercent('opt-opacity', 'opacity');
const tolInput = $<HTMLInputElement>('#opt-tolerance');
tolInput.oninput = () => {
  brush.tolerance = +tolInput.value;
  $('#opt-tolerance-out').textContent = tolInput.value;
};

// ---------------------------------------------------------------------------
// Menus & commands

const commands: Record<string, () => void> = {
  open: cmdOpen,
  new: () => {
    const dlg = $<HTMLDialogElement>('#new-dialog');
    dlg.returnValue = '';
    dlg.onclose = async () => {
      if (dlg.returnValue !== 'ok') return;
      if (dirty && !(await askConfirm(`Discard unsaved changes to ${doc!.name}?`, 'Discard'))) return;
      const w = Math.min(30000, Math.max(1, +$<HTMLInputElement>('#new-w').value || 1));
      const h = Math.min(30000, Math.max(1, +$<HTMLInputElement>('#new-h').value || 1));
      setDoc(newDoc(w, h, $<HTMLSelectElement>('#new-bg').value || null));
    };
    dlg.showModal();
  },
  place: () => $<HTMLInputElement>('#file-place').click(),
  save: cmdSave,
  saveAs: cmdSaveAs,
  export: cmdExport,
  undo,
  redo,
  flatten: cmdFlatten,
  newLayer: cmdNewLayer,
  newGroup: cmdNewGroup,
  duplicate: cmdDuplicate,
  delete: cmdDelete,
  moveUp: () => cmdMove(1),
  moveDown: () => cmdMove(-1),
  flipH: () => transformLayer(true),
  flipV: () => transformLayer(false),
  toggleClip: cmdToggleClip,
  toggleMask: cmdToggleMask,
  zoomIn: () => zoomAt(1.25),
  zoomOut: () => zoomAt(0.8),
  fit: fitView,
  actual: () => setZoom(1),
};
for (const a of ADJUSTMENTS) commands[`adjust:${a.id}`] = () => cmdAdjust(a.id);

function run(cmd: string) {
  closeMenus();
  if (!doc && !['open', 'new'].includes(cmd)) return;
  commands[cmd]?.();
}

document.addEventListener('click', e => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-cmd]');
  if (btn && !(btn as HTMLButtonElement).disabled) run(btn.dataset.cmd!);
});

function closeMenus() {
  document.querySelectorAll('.menu.open').forEach(m => m.classList.remove('open'));
}
document.querySelectorAll<HTMLElement>('.menu').forEach(menu => {
  const title = menu.querySelector<HTMLElement>('.menu-title')!;
  title.onclick = e => {
    e.stopPropagation();
    const open = menu.classList.contains('open');
    closeMenus();
    if (!open) menu.classList.add('open');
  };
  title.onmouseenter = () => {
    if (document.querySelector('.menu.open') && !menu.classList.contains('open')) {
      closeMenus();
      menu.classList.add('open');
    }
  };
});
document.addEventListener('pointerdown', e => {
  if (!(e.target as HTMLElement).closest('.menu')) closeMenus();
});

// ---------------------------------------------------------------------------
// Keyboard

window.addEventListener('keydown', e => {
  const t = e.target as HTMLElement;
  if (t instanceof HTMLInputElement && t.type !== 'range' && t.type !== 'checkbox' && t.type !== 'color') return;
  if (t.closest('dialog[open]')) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  const combo = `${mod ? 'mod+' : ''}${e.altKey ? 'alt+' : ''}${e.shiftKey ? 'shift+' : ''}${k}`;
  const map: Record<string, string> = {
    'mod+o': 'open', 'mod+alt+n': 'new', 'mod+s': 'save', 'mod+shift+s': 'saveAs', 'mod+shift+e': 'export',
    'mod+z': 'undo', 'mod+shift+z': 'redo', 'mod+y': 'redo',
    'mod+alt+shift+n': 'newLayer', 'mod+g': 'newGroup', 'mod+j': 'duplicate', 'mod+alt+g': 'toggleClip',
    'mod+u': 'adjust:hsl', 'mod+l': 'adjust:levels', 'mod+i': 'adjust:invert', 'mod+shift+u': 'adjust:desaturate',
    'mod+=': 'zoomIn', 'mod++': 'zoomIn', 'mod+shift++': 'zoomIn', 'mod+-': 'zoomOut', 'mod+0': 'fit', 'mod+1': 'actual',
  };
  if (map[combo]) {
    e.preventDefault();
    run(map[combo]);
    return;
  }
  if (mod || e.altKey) return;
  const tools: Record<string, Tool> = { v: 'move', b: 'brush', e: 'eraser', g: 'bucket', i: 'eyedropper', h: 'hand' };
  if (tools[k]) return setTool(tools[k]);
  if (k === '[') setBrushSize(brush.size > 10 ? brush.size * 0.85 : brush.size - 1);
  if (k === ']') setBrushSize(brush.size >= 10 ? brush.size * 1.15 : brush.size + 1);
  if (k === ' ' && !spaceDown) {
    e.preventDefault();
    spaceDown = true;
    updateCursor();
  }
  if (tool === 'move' && doc && k.startsWith('arrow')) {
    e.preventDefault();
    const sel = selected();
    if (!sel) return;
    const step = e.shiftKey ? 10 : 1;
    const dx = k === 'arrowleft' ? -step : k === 'arrowright' ? step : 0;
    const dy = k === 'arrowup' ? -step : k === 'arrowdown' ? step : 0;
    pushHistory();
    for (const l of leafLayers(sel.layer)) {
      l.left += dx; l.top += dy;
      if (l.mask) { l.mask.left += dx; l.mask.top += dy; }
    }
    requestRender();
  }
});
window.addEventListener('keyup', e => {
  if (e.key === ' ') {
    spaceDown = false;
    updateCursor();
  }
});

// ---------------------------------------------------------------------------
// Files: inputs, drag & drop, unload guard

$<HTMLInputElement>('#file-open').onchange = e => {
  const input = e.target as HTMLInputElement;
  const f = input.files?.[0];
  input.value = '';
  if (f) openFile(f);
};
$<HTMLInputElement>('#file-place').onchange = e => {
  const input = e.target as HTMLInputElement;
  const f = input.files?.[0];
  input.value = '';
  if (f) placeFile(f);
};

viewport.addEventListener('dragover', e => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  e.preventDefault();
  viewport.classList.add('dragover');
});
viewport.addEventListener('dragleave', e => {
  if (!viewport.contains(e.relatedTarget as Node)) viewport.classList.remove('dragover');
});
viewport.addEventListener('drop', async e => {
  viewport.classList.remove('dragover');
  const item = [...(e.dataTransfer?.items ?? [])].find(i => i.kind === 'file');
  if (!item) return;
  e.preventDefault();
  const file = item.getAsFile();
  if (!file) return;
  // A PSD (or any file when nothing is open) opens as a document; an image dropped on an open document becomes a layer.
  if (doc && !isPsd(file.name)) return placeFile(file);
  let handle: FileHandle | null = null;
  const getHandle = (item as DataTransferItem & { getAsFileSystemHandle?: () => Promise<FileHandle | null> }).getAsFileSystemHandle;
  if (canUsePickers && getHandle && isPsd(file.name)) {
    try { handle = await getHandle.call(item); } catch { /* fall back to download on save */ }
  }
  openFile(file, handle);
});

window.addEventListener('beforeunload', e => {
  if (dirty) e.preventDefault();
});
window.addEventListener('resize', () => {
  if (doc) applyView();
});

// ---------------------------------------------------------------------------

document.querySelectorAll<HTMLButtonElement>('[data-needs-doc]').forEach(b => (b.disabled = true));
setTool('brush');
refreshLayerProps();
updateTitle();
