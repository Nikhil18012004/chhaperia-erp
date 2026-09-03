/* ============================================================
   CHHAPERIA ERP — THE TDS BOOKLET
   The Technical Data Sheets catalogue every login can open, and
   that admin replaces from the browser.

   Where the bytes live: an uploaded booklet sits under the data
   directory (DATA_DIR/tds) — it is the plant's document, not the
   repo's.
   Until one is uploaded the bundled PDF in frontend/assets/docs is
   what everybody gets, so a fresh install is never without one.

   PDF or Word: a PDF is shown in the page. A Word document cannot
   be — browsers do not render .docx — so it is offered as a
   download and, where this server has Word installed (the plant
   laptop does), converted to a PDF that IS shown, with the Word
   file kept for download. A conversion that fails is reported,
   never hidden; the upload itself still stands.
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { DATA_DIR } = require("../db/connection");

const TDS_DIR = path.join(DATA_DIR, "tds");
const META = path.join(TDS_DIR, "tds.json");
const BUNDLED = path.join(__dirname, "..", "..", "..", "frontend", "assets", "docs", "tds-brochure.pdf");
const BUNDLED_NAME = "Chhaperia — Technical Data Sheets.pdf";
const CONVERTED = "tds.converted.pdf";
const MAX_BYTES = 40 * 1024 * 1024;

const MIME = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
};

function err(msg, status) { const e = new Error(msg); e.status = status || 400; return e; }

function readMeta() {
  try { return JSON.parse(fs.readFileSync(META, "utf8")); } catch { return null; }
}
function stat(p) { try { return fs.statSync(p); } catch { return null; } }

/** What is on the server right now — for the page head and the viewer. */
function describe() {
  const meta = readMeta();
  if (meta && meta.file && stat(path.join(TDS_DIR, meta.file))) {
    const converted = meta.pdf && stat(path.join(TDS_DIR, meta.pdf)) ? meta.pdf : null;
    return {
      present: true, source: "uploaded",
      name: meta.name, kind: meta.kind, size: meta.size,
      updatedAt: meta.updatedAt || null, updatedBy: meta.updatedBy || "",
      // a PDF is viewable as it is; a Word file only once it has been converted
      viewable: meta.kind === "pdf" || !!converted,
      converted: !!converted,
      convertError: meta.convertError || null,
    };
  }
  const st = stat(BUNDLED);
  return {
    present: !!st, source: "bundled",
    name: BUNDLED_NAME, kind: "pdf", size: st ? st.size : 0,
    updatedAt: st ? st.mtime.toISOString() : null, updatedBy: "",
    viewable: !!st, converted: false, convertError: null,
  };
}

/** The file to send: the shown copy by default, the original Word file on
    request (`original`), the bundled booklet when nothing was uploaded. */
function fileFor(opts) {
  opts = opts || {};
  const meta = readMeta();
  if (meta && meta.file && stat(path.join(TDS_DIR, meta.file))) {
    const converted = meta.pdf && stat(path.join(TDS_DIR, meta.pdf)) ? path.join(TDS_DIR, meta.pdf) : null;
    if (converted && !opts.original) {
      return { path: converted, mime: MIME.pdf, viewable: true,
        name: meta.name.replace(/\.(docx?|pdf)$/i, "") + ".pdf" };
    }
    return { path: path.join(TDS_DIR, meta.file), mime: MIME[meta.kind] || "application/octet-stream",
      viewable: meta.kind === "pdf", name: meta.name };
  }
  if (!stat(BUNDLED)) return null;
  return { path: BUNDLED, mime: MIME.pdf, viewable: true, name: BUNDLED_NAME };
}

/* the file really is what its name says — the first bytes decide */
function looksLike(kind, buf) {
  if (kind === "pdf") return buf.slice(0, 5).toString("latin1") === "%PDF-";
  if (kind === "docx") return buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04; // a zip
  if (kind === "doc") return buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0;  // OLE
  return false;
}

function clearDir() {
  fs.mkdirSync(TDS_DIR, { recursive: true });
  for (const f of fs.readdirSync(TDS_DIR)) {
    try { fs.rmSync(path.join(TDS_DIR, f), { force: true }); } catch { /* best effort */ }
  }
}

/** Replace the booklet. body: { name, data(base64) }. */
async function put(body, user) {
  const rawName = String((body || {}).name || "").trim();
  const safe = path.basename(rawName);
  const m = /\.(pdf|docx|doc)$/i.exec(safe);
  if (!m) throw err("The TDS must be a PDF or a Word document (.pdf, .docx or .doc).", 400);
  const kind = m[1].toLowerCase();
  if (!/^[A-Za-z0-9][A-Za-z0-9 _.,()&+-]{0,79}\.(pdf|docx|doc)$/i.test(safe)) {
    throw err("That file name has characters the document folder cannot take.", 400);
  }
  const data = (body || {}).data;
  if (typeof data !== "string" || !data) throw err("The file was empty.", 400);
  const buf = Buffer.from(data, "base64");
  if (!buf.length) throw err("The file was empty.", 400);
  if (buf.length > MAX_BYTES) throw err("That file is larger than 40 MB.", 413);
  if (!looksLike(kind, buf)) throw err("That file is not a " + kind.toUpperCase() + " inside — it was refused.", 400);

  clearDir();
  const file = "tds." + kind;
  fs.writeFileSync(path.join(TDS_DIR, file), buf);
  const meta = { name: safe, kind, file, size: buf.length,
    updatedAt: new Date().toISOString(), updatedBy: (user && user.username) || "" };
  if (kind !== "pdf") {
    const conv = convertToPdf(path.join(TDS_DIR, file), path.join(TDS_DIR, CONVERTED));
    if (conv.ok) meta.pdf = CONVERTED; else meta.convertError = conv.error;
  }
  fs.writeFileSync(META, JSON.stringify(meta, null, 2));
  return describe();
}

/** Back to the bundled booklet. */
function reset() {
  clearDir();
  return describe();
}

/* Word → PDF through Word itself (COM), which is what the plant laptop has.
   Skipped anywhere Word is not to be launched: not Windows, or the tests
   (CHHAPERIA_TDS_NOCONVERT=1). Bounded, so a stuck Word cannot hang a save. */
function convertToPdf(src, dst) {
  if (process.env.CHHAPERIA_TDS_NOCONVERT === "1") return { ok: false, error: "Conversion is switched off on this server." };
  if (process.platform !== "win32") return { ok: false, error: "Word is not available on this server to convert the document." };
  const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$w = New-Object -ComObject Word.Application",
    "$w.Visible = $false",
    "try {",
    "  $d = $w.Documents.Open(" + q(src) + ", $false, $true)",
    "  $d.ExportAsFixedFormat(" + q(dst) + ", 17)",
    "  $d.Close(0)",
    "} finally { $w.Quit() }",
  ].join("; ");
  try {
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { timeout: 120000, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    if (!stat(dst)) return { ok: false, error: "Word did not produce a PDF." };
    return { ok: true };
  } catch (e) {
    const msg = (e && e.stderr && e.stderr.toString().trim()) || (e && e.message) || "conversion failed";
    return { ok: false, error: msg.split(/\r?\n/)[0].slice(0, 300) };
  }
}

module.exports = { describe, fileFor, put, reset, TDS_DIR };
