export interface AdjustmentDef {
  id: string;
  title: string;
  params: { key: string; label: string; min: number; max: number; value: number }[];
  apply(d: Uint8ClampedArray, p: Record<string, number>): void;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}

function hueToRgb(p: number, q: number, t: number) {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hueToRgb(p, q, h + 1 / 3) * 255, hueToRgb(p, q, h) * 255, hueToRgb(p, q, h - 1 / 3) * 255];
}

export const ADJUSTMENTS: AdjustmentDef[] = [
  {
    id: 'brightness',
    title: 'Brightness / Contrast',
    params: [
      { key: 'brightness', label: 'Brightness', min: -150, max: 150, value: 0 },
      { key: 'contrast', label: 'Contrast', min: -100, max: 100, value: 0 },
    ],
    apply(d, { brightness, contrast }) {
      const c = contrast * 2.55;
      const f = (259 * (c + 255)) / (255 * (259 - c));
      for (let i = 0; i < d.length; i += 4) {
        d[i] = f * (d[i] - 128) + 128 + brightness;
        d[i + 1] = f * (d[i + 1] - 128) + 128 + brightness;
        d[i + 2] = f * (d[i + 2] - 128) + 128 + brightness;
      }
    },
  },
  {
    id: 'hsl',
    title: 'Hue / Saturation',
    params: [
      { key: 'hue', label: 'Hue', min: -180, max: 180, value: 0 },
      { key: 'saturation', label: 'Saturation', min: -100, max: 100, value: 0 },
      { key: 'lightness', label: 'Lightness', min: -100, max: 100, value: 0 },
    ],
    apply(d, { hue, saturation, lightness }) {
      const dh = hue / 360;
      const sf = 1 + saturation / 100;
      const lf = lightness / 100;
      for (let i = 0; i < d.length; i += 4) {
        if (!d[i + 3]) continue;
        let [h, s, l] = rgbToHsl(d[i], d[i + 1], d[i + 2]);
        h = (h + dh + 1) % 1;
        s = Math.min(1, s * sf);
        l = lf < 0 ? l * (1 + lf) : l + (1 - l) * lf;
        const [r, g, b] = hslToRgb(h, s, l);
        d[i] = r; d[i + 1] = g; d[i + 2] = b;
      }
    },
  },
  {
    id: 'levels',
    title: 'Levels',
    params: [
      { key: 'black', label: 'Input black', min: 0, max: 253, value: 0 },
      { key: 'gamma', label: 'Gamma ×100', min: 10, max: 999, value: 100 },
      { key: 'white', label: 'Input white', min: 2, max: 255, value: 255 },
    ],
    apply(d, { black, gamma, white }) {
      const lut = new Uint8ClampedArray(256);
      const range = Math.max(1, white - black);
      const g = 1 / (gamma / 100);
      for (let v = 0; v < 256; v++) lut[v] = 255 * Math.pow(Math.min(1, Math.max(0, (v - black) / range)), g);
      for (let i = 0; i < d.length; i += 4) {
        d[i] = lut[d[i]]; d[i + 1] = lut[d[i + 1]]; d[i + 2] = lut[d[i + 2]];
      }
    },
  },
  {
    id: 'invert',
    title: 'Invert',
    params: [],
    apply(d) {
      for (let i = 0; i < d.length; i += 4) {
        d[i] = 255 - d[i]; d[i + 1] = 255 - d[i + 1]; d[i + 2] = 255 - d[i + 2];
      }
    },
  },
  {
    id: 'desaturate',
    title: 'Desaturate',
    params: [],
    apply(d) {
      for (let i = 0; i < d.length; i += 4) {
        const y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        d[i] = d[i + 1] = d[i + 2] = y;
      }
    },
  },
];
