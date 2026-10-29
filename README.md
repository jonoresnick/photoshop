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

## Limitations

This is a minimal editor, so some Photoshop features are preserved in the file but not shown in the preview:

- **Layer effects** (drop shadow, stroke, …) and **adjustment layers** are kept when you save, but aren't rendered on screen. Layers that have them are tagged `fx` / `ADJ` in the layers panel.
- **Text, smart object and shape layers** are shown as their rendered pixels. Moving them keeps them editable in Photoshop; painting, adjusting or flipping them rasterizes them (turns them into normal pixel layers).
- A few rarer blend modes (vivid/linear/pin light, hard mix, subtract, divide, darker/lighter color, dissolve) are approximated in the preview (tagged `≈`). The blend mode itself is saved correctly.
- Files are saved as 8-bit RGB. 16/32-bit and CMYK documents are converted when opened.
- No selections, text tool, or free transform (scale/rotate) yet.
