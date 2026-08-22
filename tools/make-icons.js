#!/usr/bin/env node
/* ============================================================
   CHHAPERIA ERP — app icon generator

     node tools/make-icons.js

   Builds the PWA / Android launcher icons from frontend/assets/mark.png.
   Pure Node — zlib is the only thing it needs, so there is no image
   library to install and no build step to keep working.

   WHY THE SOURCE IS RE-RENDERED RATHER THAN JUST RESIZED

   A launcher icon is not a favicon. Android masks it to whatever shape
   the phone's launcher uses (circle, squircle, rounded square), and
   anything outside the middle 80% can be cut off. So the mark is drawn
   onto an opaque square with a generous margin — the "safe zone" — and
   the whole square is what gets masked. A transparent PNG handed
   straight to Android comes out with a black box behind it on some
   launchers and a clipped logo on others.

   Only 8-bit RGBA, non-interlaced PNGs are read. Both source images in
   this repo are exactly that; anything else fails loudly rather than
   producing a subtly wrong icon.
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "frontend", "assets", "mark.png");
const OUT = path.join(ROOT, "frontend", "assets");

/* the app's own dark ground, so the icon sits in the same world as the UI */
const BG = [15, 20, 26, 255];

const { decodePng, encodePng } = require("./pnglib");

/* ---------- draw ----------
   Box-filter downscale: every destination pixel averages the source pixels
   it covers. Nearest-neighbour would leave the logo's fine strokes ragged
   at 192px, which is the size most launchers actually show. Alpha is
   composited onto the background as it goes, so the result is opaque. */
function render(src, size, inset) {
  const dst = Buffer.alloc(size * size * 4);
  const box = Math.round(size * inset);                 // drawn area, centred
  const scale = Math.min(box / src.w, box / src.h);     // keep the aspect ratio
  const dw = Math.max(1, Math.round(src.w * scale));
  const dh = Math.max(1, Math.round(src.h * scale));
  const dx0 = Math.round((size - dw) / 2);
  const dy0 = Math.round((size - dh) / 2);

  for (let i = 0; i < size * size; i++) {
    dst[i * 4] = BG[0]; dst[i * 4 + 1] = BG[1]; dst[i * 4 + 2] = BG[2]; dst[i * 4 + 3] = BG[3];
  }
  for (let dy = 0; dy < dh; dy++) {
    const sy0 = Math.floor(dy * src.h / dh), sy1 = Math.max(sy0 + 1, Math.floor((dy + 1) * src.h / dh));
    for (let dx = 0; dx < dw; dx++) {
      const sx0 = Math.floor(dx * src.w / dw), sx1 = Math.max(sx0 + 1, Math.floor((dx + 1) * src.w / dw));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const si = (sy * src.w + sx) * 4;
          const sa = src.data[si + 3] / 255;
          r += src.data[si] * sa; g += src.data[si + 1] * sa; b += src.data[si + 2] * sa;
          a += sa; n++;
        }
      }
      if (!n) continue;
      const A = a / n;
      const R = a ? r / a : 0, G = a ? g / a : 0, B = a ? b / a : 0;
      const di = ((dy0 + dy) * size + (dx0 + dx)) * 4;
      dst[di]     = Math.round(R * A + BG[0] * (1 - A));
      dst[di + 1] = Math.round(G * A + BG[1] * (1 - A));
      dst[di + 2] = Math.round(B * A + BG[2] * (1 - A));
      dst[di + 3] = 255;
    }
  }
  return dst;
}

const src = decodePng(fs.readFileSync(SRC));
console.log(`source ${path.basename(SRC)} ${src.w}×${src.h}`);

/* `inset` is how much of the square the logo is allowed to fill.
   0.66 for maskable (Android may crop to the middle 80%, and a circle
   crops the corners hardest), 0.82 for the plain icon where nothing is
   cropped and a tight margin just wastes pixels. */
const JOBS = [
  ["icon-192.png", 192, 0.82],
  ["icon-512.png", 512, 0.82],
  ["icon-maskable-192.png", 192, 0.66],
  ["icon-maskable-512.png", 512, 0.66],
];
for (const [name, size, inset] of JOBS) {
  const png = encodePng(size, size, render(src, size, inset));
  fs.writeFileSync(path.join(OUT, name), png);
  console.log(`  wrote ${name.padEnd(24)} ${size}×${size}  ${(png.length / 1024).toFixed(1)} KB`);
}
console.log("done");
