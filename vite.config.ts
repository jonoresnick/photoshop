import { defineConfig, type Plugin } from 'vite';

/**
 * ag-psd reads from one contiguous ArrayBuffer, but browsers cap a single ArrayBuffer at 2 GB.
 * These small patches let its reader work over a chunked view (see src/bigfile.ts) and accept
 * PSB sections over 4 GB. Each patch must apply exactly; the build fails if ag-psd changes.
 */
function patchAgPsdReader() {
  const patches: [string | RegExp, string, number][] = [
    [
      'result.set(new Uint8Array(reader.view.buffer, reader.view.byteOffset + start, len));',
      'result.set(reader.view.bytes ? reader.view.bytes(start, len) : new Uint8Array(reader.view.buffer, reader.view.byteOffset + start, len));',
      1,
    ],
    [
      'return new Uint8Array(reader.view.buffer, reader.view.byteOffset + start, length);',
      'return reader.view.bytes ? reader.view.bytes(start, length) : new Uint8Array(reader.view.buffer, reader.view.byteOffset + start, length);',
      1,
    ],
    [
      'const text = bytesToString(new Uint8Array(reader.view.buffer, reader.view.byteOffset + reader.offset, length));',
      'const text = bytesToString(reader.view.bytes ? reader.view.bytes(reader.offset, length) : new Uint8Array(reader.view.buffer, reader.view.byteOffset + reader.offset, length));',
      1,
    ],
    [
      'const rawCompositeData = new Uint8Array(reader.view.buffer, reader.view.byteOffset + rawOffset, reader.view.byteLength - rawOffset);',
      'const rawCompositeData = reader.view.bytes ? reader.view.bytes(rawOffset, reader.view.byteLength - rawOffset, true) : new Uint8Array(reader.view.buffer, reader.view.byteOffset + rawOffset, reader.view.byteLength - rawOffset);',
      1,
    ],
    [
      /if \(length !== 0\)\s*throw new Error\('Sizes larger than 4GB are not supported'\);\s*length = readUint32\(reader\);/g,
      'length = length * 0x100000000 + readUint32(reader);',
      2,
    ],
  ];
  const plugin = {
    name: 'patch-ag-psd-reader',
    transform(code: string, id: string) {
      if (!/ag-psd[\\/]dist[\\/]psdReader\.js$/.test(id)) return null;
      for (const [from, to, count] of patches) {
        const found = typeof from === 'string' ? code.split(from).length - 1 : (code.match(from) ?? []).length;
        if (found !== count) throw new Error(`patch-ag-psd-reader: expected ${count} match(es) for ${from}, found ${found}`);
        code = typeof from === 'string' ? code.split(from).join(to) : code.replace(from, to);
      }
      return { code, map: null };
    },
  };
  return plugin;
}

export default defineConfig({
  base: './',
  plugins: [patchAgPsdReader() as Plugin],
  optimizeDeps: { rolldownOptions: { plugins: [patchAgPsdReader()] } },
  build: { target: 'es2022', chunkSizeWarningLimit: 1000 },
});
