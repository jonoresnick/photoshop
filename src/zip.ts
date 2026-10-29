// Minimal uncompressed ("stored") zip writer, used to deliver a .psd where only .zip downloads are allowed.
// Uses ZIP64 records when the file is 4 GB or larger.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(parts: Uint8Array[]): number {
  let c = 0xffffffff;
  for (const data of parts) {
    for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

const U32_MAX = 0xffffffff;

/** Zips one file given as a list of byte ranges (so it never has to exist as one buffer). */
export function zipSingleFile(name: string, data: Uint8Array[]): Blob {
  const nameBytes = new TextEncoder().encode(name);
  const size = data.reduce((n, p) => n + p.length, 0);
  const zip64 = size >= U32_MAX;
  const crc = crc32(data);
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const version = zip64 ? 45 : 20;

  // ZIP64 extended information: uncompressed and compressed sizes (both equal for stored files).
  const extra = new DataView(new ArrayBuffer(zip64 ? 20 : 0));
  if (zip64) {
    extra.setUint16(0, 0x0001, true);
    extra.setUint16(2, 16, true);
    extra.setBigUint64(4, BigInt(size), true);
    extra.setBigUint64(12, BigInt(size), true);
  }
  const size32 = zip64 ? U32_MAX : size;

  const local = new DataView(new ArrayBuffer(30));
  local.setUint32(0, 0x04034b50, true);
  local.setUint16(4, version, true);
  local.setUint16(6, 0x0800, true); // UTF-8 names
  local.setUint16(8, 0, true); // stored
  local.setUint16(10, time, true);
  local.setUint16(12, date, true);
  local.setUint32(14, crc, true);
  local.setUint32(18, size32, true);
  local.setUint32(22, size32, true);
  local.setUint16(26, nameBytes.length, true);
  local.setUint16(28, extra.byteLength, true);

  const central = new DataView(new ArrayBuffer(46));
  central.setUint32(0, 0x02014b50, true);
  central.setUint16(4, version, true);
  central.setUint16(6, version, true);
  central.setUint16(8, 0x0800, true);
  central.setUint16(10, 0, true);
  central.setUint16(12, time, true);
  central.setUint16(14, date, true);
  central.setUint32(16, crc, true);
  central.setUint32(20, size32, true);
  central.setUint32(24, size32, true);
  central.setUint16(28, nameBytes.length, true);
  central.setUint16(30, extra.byteLength, true);
  central.setUint32(42, 0, true); // local header offset

  const centralOffset = 30 + nameBytes.length + extra.byteLength + size;
  const centralSize = 46 + nameBytes.length + extra.byteLength;
  const parts: BlobPart[] = [local, nameBytes, extra, ...(data as BlobPart[]), central, nameBytes, extra];

  if (centralOffset >= U32_MAX) {
    const eocd64 = new DataView(new ArrayBuffer(56));
    eocd64.setUint32(0, 0x06064b50, true);
    eocd64.setBigUint64(4, 44n, true);
    eocd64.setUint16(12, 45, true);
    eocd64.setUint16(14, 45, true);
    eocd64.setBigUint64(24, 1n, true);
    eocd64.setBigUint64(32, 1n, true);
    eocd64.setBigUint64(40, BigInt(centralSize), true);
    eocd64.setBigUint64(48, BigInt(centralOffset), true);
    const locator = new DataView(new ArrayBuffer(20));
    locator.setUint32(0, 0x07064b50, true);
    locator.setBigUint64(8, BigInt(centralOffset + centralSize), true);
    locator.setUint32(16, 1, true);
    parts.push(eocd64, locator);
  }

  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, 1, true);
  end.setUint16(10, 1, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, Math.min(centralOffset, U32_MAX), true);
  parts.push(end);

  return new Blob(parts, { type: 'application/zip' });
}
