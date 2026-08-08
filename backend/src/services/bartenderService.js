/* ============================================================
   CHHAPERIA ERP — BACKEND · BarTender bridge
   The browser cannot start a desktop program, but this server
   runs on the same Windows machine BarTender is installed on.
   So the frontend posts the sticker rows here; we write them to
   ONE FIXED csv path the .btw label template is bound to, then
   start BarTender on that template. The operator edits and
   prints inside BarTender — the app the label printer already
   speaks to.

   First-time setup (once, by a human):
     1. Install BarTender on the machine that runs this server.
     2. Press the button once — it creates data/bartender/stickers.csv
        (and opens BarTender empty when the exe is found).
     3. In BarTender Designer, design the raw-material sticker and
        bind its fields to that csv, then save the template as
        data/bartender/<any name>.btw.
   Every press after that opens the template with the fresh rows —
   by exe when one is found, else through the .btw file association,
   which reaches BarTender wherever it is installed.
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");
const { spawn, execFileSync } = require("child_process");
const { DATA_DIR } = require("../db/connection");

function err(msg, status) { const e = new Error(msg); e.status = status || 400; return e; }

const BT_DIR = path.join(DATA_DIR, "bartender");
const CSV_PATH = path.join(BT_DIR, "stickers.csv");

function isFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }

/* Depth-first hunt for bartend.exe under one root. Depth 3 matters:
   BarTender 2019+ installs to Seagull\BarTender <year>\BarTender Suite\
   bartend.exe — THREE levels — and the old two-level scan walked straight
   past a healthy install and told the user the app wasn't there. */
function scanDown(dir, depth) {
  const exe = path.join(dir, "bartend.exe");
  if (isFile(exe)) return exe;
  if (depth <= 0) return null;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const hit = scanDown(path.join(dir, e.name), depth - 1);
    if (hit) return hit;
  }
  return null;
}

/* The App Paths registry key is where an installer canonically records its
   exe. Checked in both the 64- and 32-bit views; quietly absent is fine. */
function regAppPath() {
  for (const view of ["/reg:64", "/reg:32"]) {
    try {
      const out = execFileSync("reg.exe",
        ["query", "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\bartend.exe", "/ve", view],
        { timeout: 3000, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      const m = /REG_SZ\s+(.+\.exe)/i.exec(out);
      if (m && isFile(m[1].trim())) return m[1].trim();
    } catch { /* key absent in this view */ }
  }
  return null;
}

function onPath() {
  try {
    const out = execFileSync("where.exe", ["bartend.exe"],
      { timeout: 3000, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const first = out.split(/\r?\n/).find((l) => l.trim());
    if (first && isFile(first.trim())) return first.trim();
  } catch { /* not on PATH */ }
  return null;
}

/* Where bartend.exe lives. An explicit CHHAPERIA_BARTENDER_EXE always wins;
   then the Seagull / BarTender folders under both Program Files roots are
   scanned three levels deep, then the registry and PATH are asked. A hit is
   cached for the process lifetime (installs don't move mid-run); a miss is
   re-checked on every press so installing BarTender needs no server restart.
   CHHAPERIA_BARTENDER_SCAN adds ';'-separated extra roots — a non-standard
   install drive, and the way the tests exercise the deep scan. */
let _exeCache = null;
function findBartender() {
  const envExe = process.env.CHHAPERIA_BARTENDER_EXE;
  if (envExe && isFile(envExe)) return envExe;
  if (_exeCache && isFile(_exeCache)) return _exeCache;
  const roots = [];
  (process.env.CHHAPERIA_BARTENDER_SCAN || "").split(";").filter(Boolean).forEach((p) => roots.push(p));
  const pfRoots = [...new Set([process.env["ProgramFiles"], process.env["ProgramFiles(x86)"],
    "C:\\Program Files", "C:\\Program Files (x86)"].filter(Boolean))];
  for (const pf of pfRoots) {
    roots.push(path.join(pf, "Seagull"));
    let entries;
    try { entries = fs.readdirSync(pf, { withFileTypes: true }); } catch { continue; }
    // editions that skip the Seagull folder and sit directly under Program Files
    entries.forEach((e) => { if (e.isDirectory() && /bartender/i.test(e.name)) roots.push(path.join(pf, e.name)); });
  }
  let hit = null;
  for (const root of [...new Set(roots)]) { hit = scanDown(root, 3); if (hit) break; }
  if (!hit) hit = regAppPath() || onPath();
  if (hit) _exeCache = hit;
  return hit;
}

/* The operator's designed label template — the first .btw in data/bartender. */
function findTemplate() {
  let files;
  try { files = fs.readdirSync(BT_DIR); } catch { return null; }
  const btw = files.filter((f) => f.toLowerCase().endsWith(".btw")).sort()[0];
  return btw ? path.join(BT_DIR, btw) : null;
}

/* Write the rows, then hand off to BarTender. Never throws on a missing
   install — the caller needs to know exactly which part worked, so the
   answer always reports each step. */
function stickers({ poId, csv }) {
  if (typeof poId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/.test(poId))
    throw err("A purchase order id is required.");
  if (typeof csv !== "string" || !csv.trim()) throw err("No sticker rows were sent.");
  if (csv.length > 512 * 1024) throw err("Sticker data too large.", 413);

  fs.mkdirSync(BT_DIR, { recursive: true });
  fs.writeFileSync(CSV_PATH, csv, "utf8");

  const exe = findBartender();
  const template = findTemplate();
  // the test suite must never pop the BarTender window open mid-run
  const noLaunch = process.env.CHHAPERIA_BARTENDER_NOLAUNCH === "1";
  let launched = false, via = null;
  if (!noLaunch) {
    if (exe) {
      try {
        const child = spawn(exe, template ? [template] : [], { detached: true, stdio: "ignore", windowsHide: false });
        child.unref();
        launched = true; via = "exe";
      } catch { /* fall through to the association route below */ }
    }
    /* No exe found (or it refused to start) but a designed template exists:
       hand the .btw to Windows itself. The file association reaches BarTender
       wherever it is installed — no path-guessing at all. */
    if (!launched && template) {
      try {
        const child = spawn("explorer.exe", [template], { detached: true, stdio: "ignore" });
        child.unref();
        launched = true; via = "association";
      } catch { /* reported below — the csv on disk is still the deliverable */ }
    }
  }

  const message = noLaunch
    ? "Sticker data written to " + CSV_PATH + "; the launch is suppressed on this server."
    : launched && via === "exe"
      ? (template
        ? "BarTender opened with " + path.basename(template) + " — edit the stickers there and print."
        : "BarTender opened, but no label template exists yet. Design the sticker once, bind it to " + CSV_PATH + ", and save the .btw into " + BT_DIR + ".")
    : launched
      ? path.basename(template) + " was handed to Windows to open in BarTender with the fresh sticker rows."
    : !exe && !template
      ? "bartend.exe was not found on this computer (Program Files was scanned three levels deep; the registry and PATH were asked) and no .btw template exists yet. "
        + "If BarTender IS installed here: open it once, design the sticker bound to " + CSV_PATH + ", and save the label as a .btw into " + BT_DIR
        + " — from then on this button opens it automatically. A non-standard install can be pinned with CHHAPERIA_BARTENDER_EXE=<full path to bartend.exe>. "
        + "The sticker data was saved to " + CSV_PATH + "."
      : "BarTender could not be started — open " + CSV_PATH + " manually.";

  return { ok: true, poId, csvPath: CSV_PATH, exeFound: !!exe, exePath: exe || null,
    templateFound: !!template, launched, via, message };
}

module.exports = { stickers };
