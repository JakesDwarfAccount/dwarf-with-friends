// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
// SPDX-License-Identifier: AGPL-3.0-only
//
// Minimal decoder for vanilla's one legacy terrain bitmap (floors.bmp): uncompressed 24-bit

export function decodeBmp24(buf, label = "bmp") {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (buf.length < 54 || buf.toString("latin1", 0, 2) !== "BM") {
    throw new Error(`${label}: not a BMP`);
  }
  const pixelsAt = buf.readUInt32LE(10);
  const dibSize = buf.readUInt32LE(14);
  const width = buf.readInt32LE(18);
  const signedHeight = buf.readInt32LE(22);
  const planes = buf.readUInt16LE(26);
  const bits = buf.readUInt16LE(28);
  const compression = buf.readUInt32LE(30);
  if (dibSize < 40 || width <= 0 || signedHeight === 0 || planes !== 1 ||
      bits !== 24 || compression !== 0) {
    throw new Error(`${label}: expected uncompressed 24-bit Windows BMP`);
  }
  const height = Math.abs(signedHeight);
  const stride = (width * 3 + 3) & ~3;
  if (pixelsAt + stride * height > buf.length) throw new Error(`${label}: truncated pixels`);

  const data = new Uint8Array(width * height * 4);
  const topDown = signedHeight < 0;
  for (let y = 0; y < height; y++) {
    const sy = topDown ? y : height - 1 - y;
    let si = pixelsAt + sy * stride;
    let di = y * width * 4;
    for (let x = 0; x < width; x++, si += 3, di += 4) {
      data[di] = buf[si + 2];
      data[di + 1] = buf[si + 1];
      data[di + 2] = buf[si];
      data[di + 3] = 255;
    }
  }
  return { width, height, data };
}

export function colorKey(img, rgb = [255, 0, 255]) {
  const out = { width: img.width, height: img.height, data: new Uint8Array(img.data) };
  for (let i = 0; i < out.data.length; i += 4) {
    if (out.data[i] === rgb[0] && out.data[i + 1] === rgb[1] && out.data[i + 2] === rgb[2]) {
      out.data[i] = out.data[i + 1] = out.data[i + 2] = 0;
      out.data[i + 3] = 0;
    }
  }
  return out;
}
