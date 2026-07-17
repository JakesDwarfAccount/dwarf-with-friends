// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
// SPDX-License-Identifier: AGPL-3.0-only
//
// host/pnglite.mjs -- W11: minimal PNG decode/encode on node:zlib. ZERO npm deps,
// no vendored third-party code -- written for this repo so the install-time sprite
// bake (host/bake_sprites.mjs) can read the host's own DF art and write composites.
//
// Decode: 8-bit color types 0 (gray), 2 (RGB), 3 (palette; also bit depths 1/2/4),
// 4 (gray+alpha), 6 (RGBA), tRNS honored, no interlace. Everything DF's vanilla
// art uses, verified against the real install. Encode: RGBA8, filter 0.
//
// The pixel model everywhere is { width, height, data } with data = Uint8Array
// of RGBA bytes, row-major, no padding -- the same layout the browser's ImageData
// uses, so tests can assert on raw bytes.

import zlib from "node:zlib";

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// --- CRC32 (PNG chunk checksums; own table -- zlib.crc32 needs node >= 20.15) ---
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(...bufs) {
  let c = 0xffffffff;
  for (const buf of bufs) {
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// --- decode -----------------------------------------------------------------

export function decodePng(buf, label = "png") {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) {
    throw new Error(`${label}: not a PNG (bad signature)`);
  }
  let pos = 8;
  let ihdr = null;
  let palette = null;   // Buffer of RGB triples
  let trns = null;      // Buffer (palette alpha, or gray/rgb transparent color)
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("latin1", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len; // len + type + data + crc (crc not verified on read)
    if (type === "IHDR") {
      ihdr = {
        width: data.readUInt32BE(0), height: data.readUInt32BE(4),
        bitDepth: data[8], colorType: data[9],
        compression: data[10], filter: data[11], interlace: data[12],
      };
    } else if (type === "PLTE") palette = Buffer.from(data);
    else if (type === "tRNS") trns = Buffer.from(data);
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
  }
  if (!ihdr) throw new Error(`${label}: missing IHDR`);
  const { width, height, bitDepth, colorType, interlace } = ihdr;
  if (interlace !== 0) throw new Error(`${label}: interlaced PNG not supported`);
  const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const channels = CHANNELS[colorType];
  if (channels === undefined) throw new Error(`${label}: unknown color type ${colorType}`);
  const subByte = bitDepth < 8;
  if (subByte && colorType !== 3 && colorType !== 0) {
    throw new Error(`${label}: bit depth ${bitDepth} only supported for palette/gray`);
  }
  if (bitDepth !== 8 && !subByte) {
    throw new Error(`${label}: bit depth ${bitDepth} not supported`);
  }

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bitsPerPixel = channels * bitDepth;
  const rowBytes = Math.ceil((width * bitsPerPixel) / 8);
  const bpp = Math.max(1, bitsPerPixel >> 3); // filter left-neighbor distance
  if (raw.length < (rowBytes + 1) * height) {
    throw new Error(`${label}: truncated pixel data`);
  }

  // unfilter in place into `lines` (one Buffer per row)
  const lines = [];
  let off = 0;
  let prev = Buffer.alloc(rowBytes);
  for (let y = 0; y < height; y++) {
    const ft = raw[off];
    const line = Buffer.from(raw.subarray(off + 1, off + 1 + rowBytes));
    off += 1 + rowBytes;
    switch (ft) {
      case 0: break;
      case 1: // Sub
        for (let i = bpp; i < rowBytes; i++) line[i] = (line[i] + line[i - bpp]) & 0xff;
        break;
      case 2: // Up
        for (let i = 0; i < rowBytes; i++) line[i] = (line[i] + prev[i]) & 0xff;
        break;
      case 3: // Average
        for (let i = 0; i < rowBytes; i++) {
          const a = i >= bpp ? line[i - bpp] : 0;
          line[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xff;
        }
        break;
      case 4: // Paeth
        for (let i = 0; i < rowBytes; i++) {
          const a = i >= bpp ? line[i - bpp] : 0;
          const b = prev[i];
          const c = i >= bpp ? prev[i - bpp] : 0;
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          const pr = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
          line[i] = (line[i] + pr) & 0xff;
        }
        break;
      default: throw new Error(`${label}: bad filter type ${ft} on row ${y}`);
    }
    lines.push(line);
    prev = line;
  }

  // expand to RGBA
  const out = new Uint8Array(width * height * 4);
  const readSamples = (line) => { // sub-byte sample reader (palette/gray 1/2/4)
    const samples = new Uint8Array(width);
    const per = 8 / bitDepth;
    const mask = (1 << bitDepth) - 1;
    for (let x = 0; x < width; x++) {
      const b = line[Math.floor(x / per)];
      const shift = 8 - bitDepth * ((x % per) + 1);
      samples[x] = (b >> shift) & mask;
    }
    return samples;
  };
  for (let y = 0; y < height; y++) {
    const line = lines[y];
    let o = y * width * 4;
    if (colorType === 6) {
      out.set(line.subarray(0, width * 4), o);
    } else if (colorType === 2) {
      for (let x = 0; x < width; x++, o += 4) {
        const i = x * 3;
        out[o] = line[i]; out[o + 1] = line[i + 1]; out[o + 2] = line[i + 2];
        out[o + 3] = (trns && trns.length >= 6 &&
                      line[i] === trns[1] && line[i + 1] === trns[3] && line[i + 2] === trns[5])
          ? 0 : 255;
      }
    } else if (colorType === 4) {
      for (let x = 0; x < width; x++, o += 4) {
        const i = x * 2;
        out[o] = out[o + 1] = out[o + 2] = line[i];
        out[o + 3] = line[i + 1];
      }
    } else if (colorType === 3) {
      if (!palette) throw new Error(`${label}: palette PNG missing PLTE`);
      const samples = subByte ? readSamples(line) : line;
      for (let x = 0; x < width; x++, o += 4) {
        const s = samples[x] * 3;
        out[o] = palette[s]; out[o + 1] = palette[s + 1]; out[o + 2] = palette[s + 2];
        out[o + 3] = (trns && samples[x] < trns.length) ? trns[samples[x]] : 255;
      }
    } else { // 0: grayscale
      const samples = subByte ? readSamples(line) : line;
      const scale = subByte ? 255 / ((1 << bitDepth) - 1) : 1;
      for (let x = 0; x < width; x++, o += 4) {
        const v = Math.round(samples[x] * scale);
        out[o] = out[o + 1] = out[o + 2] = v;
        out[o + 3] = (trns && trns.length >= 2 && samples[x] === trns[1]) ? 0 : 255;
      }
    }
  }
  return { width, height, data: out };
}

// --- encode -----------------------------------------------------------------

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(head.subarray(4), data), 0);
  return Buffer.concat([head, data, crc]);
}

export function encodePng({ width, height, data }) {
  if (data.length !== width * height * 4) {
    throw new Error(`encodePng: data length ${data.length} != ${width}x${height}x4`);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  const rowBytes = width * 4;
  const raw = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    // filter byte 0 already zero; copy row
    raw.set(data.subarray(y * rowBytes, (y + 1) * rowBytes), y * (rowBytes + 1) + 1);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([SIG, chunk("IHDR", ihdr), chunk("IDAT", idat),
                        chunk("IEND", Buffer.alloc(0))]);
}
