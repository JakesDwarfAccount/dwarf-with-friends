// gl_atlas_fixtures.mjs -- procedural (no DF art, licensing §1.5) pixel-source builders
// shared by tools/harness/gl_atlas_test.mjs (WB-8, docs/superpowers/specs/
// 2026-07-07-WB-renderer-spec.md "GL atlas module"). Every builder returns the exact
// {width, height, data} shape dwf-gl-atlas.js's `fetchSheet`/`fetchDynamic` injection
// points expect -- data is a flat row-major RGBA Uint8ClampedArray, straight (non-
// premultiplied) alpha, matching what a real CanvasRenderingContext2D.getImageData() would
// hand back after decoding a real sheet PNG.

// Deterministic per-cell color so a test can verify "this atlas cell holds THIS source
// cell's pixels" without needing a real image: R=col (wrapped), G=row (wrapped), B=sheetId,
// A=alpha (default opaque unless overridden). Distinct per (col,row) within a 32x32 cell
// would defeat the point of a "gutter must equal the cell's OWN edge pixel" test, so within
// one cell every pixel is uniform -- edges/corners are then unambiguous to compare.
export function makeGridImage(cols, rows, sheetId, opts) {
  opts = opts || {};
  const cellSize = opts.cellSize || 32;
  const w = cols * cellSize, h = rows * cellSize;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const R = (c * 7 + 11) % 256;
      const G = (r * 13 + 5) % 256;
      const B = sheetId % 256;
      const A = opts.alpha != null ? opts.alpha : 255;
      for (let y = 0; y < cellSize; y++) {
        for (let x = 0; x < cellSize; x++) {
          const px = c * cellSize + x, py = r * cellSize + y;
          const di = (py * w + px) * 4;
          data[di] = R; data[di + 1] = G; data[di + 2] = B; data[di + 3] = A;
        }
      }
    }
  }
  return { width: w, height: h, data: data };
}

// A single cell whose pixels form a distinct, non-uniform pattern (a small ramp) so gutter
// duplication can be checked against the SOURCE's own true edge values (not just a flat
// fill, which would pass a broken "always copy zero" implementation too).
export function makeRampCell(cellSize, seed) {
  cellSize = cellSize || 32;
  const data = new Uint8ClampedArray(cellSize * cellSize * 4);
  for (let y = 0; y < cellSize; y++) {
    for (let x = 0; x < cellSize; x++) {
      const di = (y * cellSize + x) * 4;
      data[di] = (x * 8 + seed) % 256;
      data[di + 1] = (y * 8 + seed * 3) % 256;
      data[di + 2] = (x + y + seed) % 256;
      data[di + 3] = 255;
    }
  }
  return { width: cellSize, height: cellSize, data: data };
}

// Embeds `cell` (a {width,height,data} single-cell image) at (srcX,srcY) inside a larger
// `cols`x`rows` sheet, everything else zeroed -- used for the "frame sequence" fixtures where
// each frame must be individually distinguishable by content, not just position.
export function makeSheetWithCells(cols, rows, cellSize, placements) {
  cellSize = cellSize || 32;
  const w = cols * cellSize, h = rows * cellSize;
  const data = new Uint8ClampedArray(w * h * 4);
  for (const p of placements) {
    const srcX = p.col * cellSize, srcY = p.row * cellSize;
    for (let y = 0; y < cellSize; y++) {
      for (let x = 0; x < cellSize; x++) {
        const di = ((srcY + y) * w + (srcX + x)) * 4;
        const si = (y * cellSize + x) * 4;
        data[di] = p.cell.data[si];
        data[di + 1] = p.cell.data[si + 1];
        data[di + 2] = p.cell.data[si + 2];
        data[di + 3] = p.cell.data[si + 3];
      }
    }
  }
  return { width: w, height: h, data: data };
}

// A sheet sized so its dimensions are NOT a multiple of `cellSize` -- exercises the
// round-down + console-warning path (spec: "non-multiple-of-32 dims round down with a
// console warning").
export function makeRaggedImage(pxWidth, pxHeight) {
  return { width: pxWidth, height: pxHeight, data: new Uint8ClampedArray(pxWidth * pxHeight * 4) };
}

// A lightweight stand-in for an oversized sheet: correct width/height (so grid-dims division
// math is exercised) but a DUMMY (undersized) data buffer, valid ONLY because
// dwf-gl-atlas.js's allocator rejects an over-budget sheet BEFORE it ever reads a
// single source pixel (allocCells() fails first) -- lets an "atlas allocation failure" test
// run without actually materializing a 100+ MB typed array.
export function makeOversizedStub(cols, rows, cellSize) {
  cellSize = cellSize || 32;
  return { width: cols * cellSize, height: rows * cellSize, data: new Uint8ClampedArray(4) };
}
