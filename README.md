# Mini Photoshop

A small, browser-based image editor that opens and saves real Photoshop (`.psd`) files.
Everything runs locally in your browser — files are never uploaded anywhere.

Built with TypeScript, Vite and [ag-psd](https://github.com/Agamnentzar/ag-psd) for PSD reading/writing.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
```

`npm run build` produces a static site in `dist/` that can be hosted anywhere (GitHub Pages, Netlify, …).

## What it does

**Files**
- Open `.psd` / `.psb` files (drag & drop or File → Open), or PNG/JPG/WebP as a new document
- Save back to PSD with layers intact. In Chrome/Edge, **Save** writes straight back to the file you opened; elsewhere it downloads a copy
- Export a flattened PNG
- Place an image (or another PSD, flattened) as a new layer — or just drop it onto the canvas

**Layers**
- Full layer tree with groups, visibility, thumbnails and layer masks
- Rename (double-click), reorder (drag & drop, or the arrow buttons), duplicate, delete, group
- Opacity, blend modes, clipping masks, enable/disable layer mask
- Flip horizontal/vertical, flatten image

**Tools**
| Tool | Key | Notes |
|---|---|---|
| Move | `V` | Drag the selected layer/group; arrow keys nudge (Shift = 10px); Ctrl-click or "Auto-select" picks the layer under the cursor |
| Brush | `B` | Size, hardness, opacity |
| Eraser | `E` | Same options as the brush |
| Paint bucket | `G` | Tolerance, opacity; fills contiguous area of the selected layer |
| Eyedropper | `I` | Samples the composite image |
| Hand | `H` | Or hold `Space` with any tool; scroll to pan, Ctrl/⌘ + scroll or pinch to zoom |

`[` / `]` change the brush size.

**Adjustments** (Image menu, applied to the selected layer): Brightness/Contrast, Hue/Saturation, Levels, Invert, Desaturate.

**Undo / redo**: Ctrl+Z / Ctrl+Shift+Z (40 steps).

## Large files (multi-gigabyte PSD / PSB)

Big templates are supported, including PSB files larger than 2 GB:

- **Layers stay compressed in memory.** The file is loaded in 1 GB pieces (browsers can't hold more than 2 GB in a single buffer), and each layer is decoded only once to build its preview.
- **You edit a preview.** Documents over about 16 megapixels are shown at reduced resolution (the status bar says e.g. "previewing at 39%"). Every brush stroke, fill, adjustment, flip and move is recorded and re-applied **at full resolution** when you save, one layer at a time.
- **Untouched layers are copied byte-for-byte** from the original file, so they keep their exact pixels, bit depth and color mode.
- **PSB files are saved as PSB** (Photoshop's large document format), and PSD as PSD; documents wider or taller than 30,000 px are always PSB.

What you need: RAM of roughly the file size plus ~2 GB while open, and about twice the file size while saving. Chrome or Edge work best, in a **normal (not private/incognito) window**: private windows can't hold a download over 2 GB.

For large documents, **Export PNG** produces an image at preview resolution, and **Flatten Image** is unavailable.

## Limitations

This is a minimal editor, so some Photoshop features are preserved in the file but not shown in the preview:

- **Layer effects** (drop shadow, stroke, …) and **adjustment layers** are kept when you save, but aren't rendered on screen. Layers that have them are tagged `fx` / `ADJ` in the layers panel.
- **Text, smart object and shape layers** are shown as their rendered pixels. Moving them keeps them editable in Photoshop; painting, adjusting or flipping them rasterizes them (turns them into normal pixel layers).
- A few rarer blend modes (vivid/linear/pin light, hard mix, subtract, divide, darker/lighter color, dissolve) are approximated in the preview (tagged `≈`). The blend mode itself is saved correctly.
- Documents keep their color mode and bit depth (RGB, Grayscale, CMYK; 8/16-bit). Layers you edit are edited in 8-bit RGB and converted back when saving.
- When the document is previewed at reduced resolution, the saved file's flattened composite is left blank and Photoshop rebuilds it from the layers when it opens the file.
- No selections, text tool, or free transform (scale/rotate) yet.
