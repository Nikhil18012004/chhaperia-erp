#!/usr/bin/env node
/* Launcher icons for the Android app, at the five densities Android asks for.
   Reuses the renderer in make-icons.js rather than keeping a second copy of
   the PNG codec — run that first if the source ever changes. */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "frontend", "assets", "icon-maskable-512.png");
const AND = path.join(ROOT, "android", "app", "src", "main", "res");

/* mdpi 48, hdpi 72, xhdpi 96, xxhdpi 144, xxxhdpi 192 */
const DENSITIES = [["mdpi", 48], ["hdpi", 72], ["xhdpi", 96], ["xxhdpi", 144], ["xxxhdpi", 192]];

if (!fs.existsSync(SRC)) {
  console.error("Missing " + SRC + " — run `node tools/make-icons.js` first.");
  process.exit(1);
}

const { decodePng, encodePng, boxScale } = require("./pnglib");
const src = decodePng(fs.readFileSync(SRC));
for (const [d, size] of DENSITIES) {
  const dir = path.join(AND, "mipmap-" + d);
  fs.mkdirSync(dir, { recursive: true });
  const png = encodePng(size, size, boxScale(src, size, size));
  fs.writeFileSync(path.join(dir, "ic_launcher.png"), png);
  console.log(`  mipmap-${d.padEnd(8)} ic_launcher.png  ${size}×${size}  ${(png.length / 1024).toFixed(1)} KB`);
}
console.log("done");
