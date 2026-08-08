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
        and opens BarTender empty.
     3. In BarTender Designer, design the raw-material sticker and
        bind its fields to that csv, then save the template as
        data/bartender/<any name>.btw.
   Every press after that opens the template with the fresh rows.
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { DATA_DIR } = require("../db/connection");

function err(msg, status) { const e = new Error(msg); e.status = status || 400; return e; }

const BT_DIR = path.join(DATA_DIR, "bartender");
const CSV_PATH = path.join(BT_DIR, "stickers.csv");

/* Where bartend.exe lives. An explicit env var always wins; otherwise the
   Seagull install dirs are scanned two levels deep, so any edition/year
   ("BarTender Suite", "BarTender 2022", ...) is found without a hard-coded
   version list. */
function findBartender() {
  if (process.env.CHHAPERIA_BARTENDER_EXE && fs.existsSync(process.env.CHHAPERIA_BARTENDER_EXE))
    return process.env.CHHAPERIA_BARTENDER_EXE;
  const roots = [
    process.env["ProgramFiles"] && path.join(process.env["ProgramFiles"], "Seagull"),
    process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Seagull"),
    "C:\\Program Files\\Seagull", "C:\\Program Files (x86)\\Seagull",
  ].filter(Boolean);
  for (const root of [...new Set(roots)]) {
    let subdirs;
    try { subdirs = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const d of subdirs) {
      if (!d.isDirectory()) continue;
      const exe = path.join(root, d.name, "bartend.exe");
      if (fs.existsSync(exe)) return exe;
    }
  }
  return null;
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
  let launched = false;
  if (exe && !noLaunch) {
    try {
      const child = spawn(exe, template ? [template] : [], { detached: true, stdio: "ignore", windowsHide: false });
      child.unref();
      launched = true;
    } catch { /* reported below — the csv on disk is still the deliverable */ }
  }

  const message = !exe
    ? "BarTender is not installed on the ERP computer — the sticker data was saved to " + CSV_PATH + "."
    : noLaunch
      ? "Sticker data written to " + CSV_PATH + "; the launch is suppressed on this server."
      : !template
      ? "BarTender opened, but no label template exists yet. Design the sticker once, bind it to " + CSV_PATH + ", and save the .btw into " + BT_DIR + "."
      : launched
        ? "BarTender opened with " + path.basename(template) + " — edit the stickers there and print."
        : "BarTender was found but could not be started — open " + CSV_PATH + " manually.";

  return { ok: true, poId, csvPath: CSV_PATH, exeFound: !!exe, templateFound: !!template, launched, message };
}

module.exports = { stickers };
