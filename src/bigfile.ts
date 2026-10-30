// Support for files larger than the browser's 2 GB limit on a single ArrayBuffer.
//
// Reading: the file is loaded as several ≤1 GB chunks and ag-psd reads through a DataView-like
// wrapper over them (its reader is patched at build time to use `bytes()`; see vite.config.ts).
//
// Writing: ag-psd writes a compact file in which large channel data is replaced by small
// placeholders, and the real bytes are spliced back in as separate Blob parts, so the output
// never has to exist as one buffer.

import type { Psd, ReadOptions } from 'ag-psd/dist/index';
import { largeAdditionalInfoKeys } from 'ag-psd/dist/helpers';
import { readPsd as readPsdFromReader } from 'ag-psd/dist/psdReader';

const CHUNK = 1 << 30;

export class ChunkedView {
  readonly byteOffset = 0;
  readonly byteLength: number;
  private views: DataView[];

  constructor(private chunks: Uint8Array<ArrayBuffer>[]) {
    this.byteLength = chunks.reduce((s, c) => s + c.length, 0);
    this.views = chunks.map(c => new DataView(c.buffer, c.byteOffset, c.byteLength));
  }

  /** Bytes [start, start+length). A view when they sit in one chunk, otherwise a copy. */
  bytes(start: number, length: number, optional = false): Uint8Array | undefined {
    const i = Math.floor(start / CHUNK);
    const off = start - i * CHUNK;
    if (off + length <= CHUNK || i === this.chunks.length - 1) return this.chunks[i].subarray(off, off + length);
    if (length > CHUNK && optional) return undefined;
    const out = new Uint8Array(length);
    let pos = 0;
    for (let c = i, o = off; pos < length; c++, o = 0) {
      const part = this.chunks[c].subarray(o, o + length - pos);
      out.set(part, pos);
      pos += part.length;
    }
    return out;
  }

  /** A DataView positioned for an n-byte read at `offset`, plus the local offset. */
  private at(offset: number, n: number): [DataView, number] {
    const i = Math.floor(offset / CHUNK);
    const local = offset - i * CHUNK;
    if (local + n <= this.views[i].byteLength) return [this.views[i], local];
    const b = this.bytes(offset, n)!;
    return [new DataView(b.buffer, b.byteOffset, n), 0];
  }

  getUint8(o: number) { const [v, l] = this.at(o, 1); return v.getUint8(l); }
  getInt8(o: number) { const [v, l] = this.at(o, 1); return v.getInt8(l); }
  getUint16(o: number, le?: boolean) { const [v, l] = this.at(o, 2); return v.getUint16(l, le); }
  getInt16(o: number, le?: boolean) { const [v, l] = this.at(o, 2); return v.getInt16(l, le); }
  getUint32(o: number, le?: boolean) { const [v, l] = this.at(o, 4); return v.getUint32(l, le); }
  getInt32(o: number, le?: boolean) { const [v, l] = this.at(o, 4); return v.getInt32(l, le); }
  getFloat32(o: number, le?: boolean) { const [v, l] = this.at(o, 4); return v.getFloat32(l, le); }
  getFloat64(o: number, le?: boolean) { const [v, l] = this.at(o, 8); return v.getFloat64(l, le); }
}

export async function readFileChunks(file: File, onProgress: (fraction: number) => void): Promise<Uint8Array<ArrayBuffer>[]> {
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  for (let off = 0; off < file.size; off += CHUNK) {
    try {
      chunks.push(new Uint8Array(await file.slice(off, off + CHUNK).arrayBuffer()));
    } catch {
      throw new Error(`the browser ran out of memory after reading ${(off / 1e9).toFixed(1)} of ${(file.size / 1e9).toFixed(1)} GB. ` +
        'Close other tabs and apps, or use a computer with more RAM');
    }
    onProgress(Math.min(1, (off + CHUNK) / file.size));
  }
  return chunks;
}

export function readPsdChunks(chunks: Uint8Array<ArrayBuffer>[], options: ReadOptions): Psd {
  const view = chunks.length === 1 ? new DataView(chunks[0].buffer, chunks[0].byteOffset, chunks[0].byteLength) : new ChunkedView(chunks);
  const reader = { view, offset: 0, strict: false, debug: false, large: false, globalAlpha: false, log: console.log };
  return readPsdFromReader(reader as unknown as Parameters<typeof readPsdFromReader>[0], options);
}

// ---------------------------------------------------------------------------
// Writing

const MAGIC = [0x50, 0x48, 0x4c, 0x44]; // "PHLD"
/** Channels smaller than this are written directly. */
const SPLICE_MIN = 64 * 1024;

export class Splicer {
  private real: Uint8Array[] = [];

  /**
   * Returns placeholder bytes standing in for `data`. Its length matches `data` modulo 4, so swapping
   * the real bytes back in changes section lengths by multiples of 4 and never changes any padding.
   */
  placeholder(data: Uint8Array): Uint8Array {
    const ph = new Uint8Array(8 + ((data.length - 8) % 4 + 4) % 4);
    ph.set(MAGIC);
    new DataView(ph.buffer).setUint32(4, this.real.length);
    this.real.push(data);
    return ph;
  }

  wants(data: Uint8Array | undefined): data is Uint8Array {
    return !!data && data.length >= SPLICE_MIN;
  }

  /** Swaps the real channel data back into ag-psd's compact output. */
  splice(compact: Uint8Array<ArrayBuffer>, psb: boolean, composite?: { width: number; height: number; part: Uint8Array }): Uint8Array[] {
    const buf = compact.slice();
    const v = new DataView(buf.buffer);
    const lenSize = psb ? 8 : 4;
    const readLen = (o: number) => (psb ? v.getUint32(o) * 0x100000000 + v.getUint32(o + 4) : v.getUint32(o));
    const addLen = (o: number, delta: number) => {
      const n = readLen(o) + delta;
      if (psb) {
        v.setUint32(o, Math.floor(n / 0x100000000));
        v.setUint32(o + 4, n >>> 0);
      } else {
        if (n > 0xffffffff) throw new Error('File too large for PSD format');
        v.setUint32(o, n);
      }
    };

    const holes: { start: number; end: number; data: Uint8Array }[] = [];
    let delta = 0;
    const isPlaceholder = (o: number, len: number) =>
      len >= 8 && len <= 11 && MAGIC.every((b, i) => buf[o + i] === b);
    const u64 = (o: number) => v.getUint32(o) * 0x100000000 + v.getUint32(o + 4);
    const setU64 = (o: number, n: number) => {
      v.setUint32(o, Math.floor(n / 0x100000000));
      v.setUint32(o + 4, n >>> 0);
    };

    /** Embedded smart-object files ('lnk2' entries). Returns the change in the block's length. */
    const scanLinkedFiles = (start: number, end: number): number => {
      let d = 0;
      let e = start;
      while (e + 8 < end) {
        const size = u64(e);
        const b = e + 8;
        const type = String.fromCharCode(buf[b], buf[b + 1], buf[b + 2], buf[b + 3]);
        let p = b + 8; // type, version
        p += 1 + buf[p]; // id (pascal string)
        p += 4 + 2 * v.getUint32(p); // name (unicode string)
        p += 8; // file type, creator
        const dataSizeOff = p;
        const dataSize = u64(p);
        if (type === 'liFD' && dataSize >= 8 && dataSize <= 11) {
          // The data follows an optional descriptor; find the placeholder itself.
          for (let q = dataSizeOff + 9; q + dataSize <= b + size; q++) {
            if (!isPlaceholder(q, dataSize)) continue;
            const data = this.real[v.getUint32(q + 4)];
            const change = data.length - dataSize;
            setU64(dataSizeOff, data.length);
            setU64(e, size + change);
            holes.push({ start: q, end: q + dataSize, data });
            d += change;
            break;
          }
        }
        e = b + size + ((4 - (size % 4)) % 4);
      }
      return d;
    };

    /** Parses layer records + channel data starting at `o` (just after a layer info length field). */
    const scanLayerInfo = (o: number): number => {
      const count = Math.abs(v.getInt16(o));
      o += 2;
      const channelLens: number[][] = [];
      for (let i = 0; i < count; i++) {
        o += 16;
        const n = v.getUint16(o);
        o += 2;
        const lens: number[] = [];
        for (let c = 0; c < n; c++) {
          o += 2;
          lens.push(o);
          o += lenSize;
        }
        channelLens.push(lens);
        o += 12; // blend signature, blend key, opacity, clipping, flags, filler
        o += 4 + v.getUint32(o); // extra data
      }
      let d = 0;
      for (const lens of channelLens) {
        for (const lenOff of lens) {
          const len = readLen(lenOff);
          const dataStart = o + 2;
          if (isPlaceholder(dataStart, len - 2)) {
            const data = this.real[v.getUint32(dataStart + 4)];
            const change = data.length - (len - 2);
            addLen(lenOff, change);
            holes.push({ start: dataStart, end: o + len, data });
            d += change;
          }
          o += len;
        }
      }
      return d;
    };

    let o = 26;
    o += 4 + v.getUint32(o); // color mode data
    o += 4 + v.getUint32(o); // image resources
    const lmLenOff = o;
    const lmEnd = o + lenSize + readLen(o);
    o += lenSize;
    const liLenOff = o;
    const liLen = readLen(o);
    o += lenSize;
    if (liLen > 0) {
      delta += scanLayerInfo(o);
      addLen(liLenOff, delta);
    }
    o += liLen;
    o += 4 + v.getUint32(o); // global layer mask info
    // 16/32-bit documents keep their layers in an additional-info block instead. Walk the blocks the
    // way ag-psd's reader does: length padded to even, then any stray zero bytes skipped.
    while (o < lmEnd) {
      while (o < lmEnd && buf[o] === 0) o++;
      if (o + 12 > lmEnd) break;
      const sig = String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]);
      const key = String.fromCharCode(buf[o + 4], buf[o + 5], buf[o + 6], buf[o + 7]);
      const big = sig === '8B64' || (psb && largeAdditionalInfoKeys.includes(key));
      const blockLenOff = o + 8;
      const blockLen = big ? readLen(blockLenOff) : v.getUint32(blockLenOff);
      const body = blockLenOff + (big ? 8 : 4);
      const isLayers = key === 'Lr16' || key === 'Lr32' || key === 'Layr';
      if (isLayers || key === 'lnk2' || key === 'lnk3' || key === 'lnkD') {
        const d = isLayers ? scanLayerInfo(body) : scanLinkedFiles(body, body + blockLen);
        if (big) addLen(blockLenOff, d); else v.setUint32(blockLenOff, blockLen + d);
        delta += d;
      }
      o = body + blockLen + (blockLen % 2);
    }
    addLen(lmLenOff, delta);

    // Stitch the pieces together.
    const parts: Uint8Array[] = [];
    let pos = 0;
    holes.sort((a, b) => a.start - b.start);
    for (const h of holes) {
      parts.push(buf.subarray(pos, h.start), h.data);
      pos = h.end;
    }
    if (composite) {
      // ag-psd wrote the document as 1×1; restore the real size and use the provided composite.
      v.setUint32(14, composite.height);
      v.setUint32(18, composite.width);
      const lmPadded = lmEnd + ((lmEnd - lmLenOff - lenSize) % 2);
      parts.push(buf.subarray(pos, lmPadded), composite.part);
    } else {
      parts.push(buf.subarray(pos));
    }
    return parts;
  }
}

/** An all-zero, RLE-compressed composite image (Photoshop rebuilds the real one from the layers). */
export function blankComposite(width: number, height: number, channels: number, bytesPerSample: number, psb: boolean): Uint8Array {
  const rowBytes = width * bytesPerSample;
  const row: number[] = [];
  for (let left = rowBytes; left > 0; left -= 128) {
    const n = Math.min(128, left);
    if (n === 1) row.push(0, 0);
    else row.push(257 - n, 0);
  }
  const countSize = psb ? 4 : 2;
  const rows = channels * height;
  const out = new Uint8Array(2 + rows * countSize + rows * row.length);
  const v = new DataView(out.buffer);
  v.setUint16(0, 1); // RLE
  for (let r = 0; r < rows; r++) {
    if (psb) v.setUint32(2 + r * 4, row.length);
    else v.setUint16(2 + r * 2, row.length);
  }
  const rowData = new Uint8Array(row);
  for (let r = 0, o = 2 + rows * countSize; r < rows; r++, o += row.length) out.set(rowData, o);
  return out;
}
