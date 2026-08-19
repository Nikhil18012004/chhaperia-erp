/* ============================================================
   A very small PNG reader/writer — 8-bit RGBA, non-interlaced.

   Exists so the icon generators need no image library and no build
   step: zlib ships with Node, and that is the only hard part of PNG.
   Deliberately refuses anything it does not fully understand rather
   than guessing, because a silently wrong icon is worse than a
   missing one.
   ============================================================ */
"use strict";
const zlib = require("zlib");

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  const depth = buf[24], color = buf[25], interlace = buf[28];
  if (depth !== 8 || color !== 6 || interlace !== 0)
    throw new Error(`only 8-bit RGBA non-interlaced PNG is supported (depth=${depth} color=${color} interlace=${interlace})`);

  const idat = [];
  let p = 8;
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString("ascii", p + 4, p + 8);
    if (type === "IDAT") idat.push(buf.slice(p + 8, p + 8 + len));
    if (type === "IEND") break;
    p += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));

  const bpp = 4, stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  let rp = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[rp++];
    const line = raw.slice(rp, rp + stride); rp += stride;
    const cur = out.slice(y * stride, (y + 1) * stride);
    const prev = y ? out.slice((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev ? prev[i] : 0;
      const c = (prev && i >= bpp) ? prev[i - bpp] : 0;
      const x = line[i];
      let v;
      switch (ft) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: {
          const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error("bad PNG filter " + ft);
      }
      cur[i] = v & 0xff;
    }
  }
  return { w, h, data: out };
}

function crc32(b) {
  let c = ~0;
  for (let i = 0; i < b.length; i++) {
    c ^= b[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(w, h, rgba) {
  const stride = w * 4;
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;                      // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* Box filter: each destination pixel averages every source pixel it covers.
   Nearest-neighbour leaves the logo's fine strokes ragged at 48px, which is
   the size an mdpi launcher actually shows. */
function boxScale(src, dw, dh) {
  const dst = Buffer.alloc(dw * dh * 4);
  for (let dy = 0; dy < dh; dy++) {
    const sy0 = Math.floor(dy * src.h / dh), sy1 = Math.max(sy0 + 1, Math.floor((dy + 1) * src.h / dh));
    for (let dx = 0; dx < dw; dx++) {
      const sx0 = Math.floor(dx * src.w / dw), sx1 = Math.max(sx0 + 1, Math.floor((dx + 1) * src.w / dw));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const si = (sy * src.w + sx) * 4;
          r += src.data[si]; g += src.data[si + 1]; b += src.data[si + 2]; a += src.data[si + 3];
          n++;
        }
      }
      const di = (dy * dw + dx) * 4;
      dst[di] = Math.round(r / n); dst[di + 1] = Math.round(g / n);
      dst[di + 2] = Math.round(b / n); dst[di + 3] = Math.round(a / n);
    }
  }
  return dst;
}

module.exports = { decodePng, encodePng, boxScale };
