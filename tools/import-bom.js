/* ============================================================
   CHHAPERIA ERP — real product / BOM importer
   Loads "PRODUCT, TYPE WITH BOM FINAL.xlsx" into the live DB:
     • 105 finished goods (code, thickness, GSM, series, TDS spec)
     • the raw-material master, one item per material+grade so a
       "ranged" BOM line can resolve to actual stock at issue time
     • 105 BOMs with rich lines (qty per batch + pickup %)
     • the lab-products master, with backend-only {min,max} specs

   Usage:
     node tools/import-bom.js [path-to.xlsx] [--dry] [--keep-demo]

   --dry        parse + report, write nothing
   --keep-demo  keep the seeded demo catalogue (default: replace it,
                which also clears the demo movements/POs/SOs/WOs that
                reference those items, so stock figures stay honest)
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const BOM = require("../frontend/js/bomcalc.js");

const ARGS = process.argv.slice(2);
const DRY = ARGS.includes("--dry");
const KEEP_DEMO = ARGS.includes("--keep-demo");
const XLSX = ARGS.find((a) => !a.startsWith("--")) ||
  path.join(__dirname, "..", "..", "PRODUCT, TYPE WITH BOM FINAL.xlsx");

/* ============================================================
   1. XLSX READER  (a .xlsx is a zip of XML — no dependency needed)
   ============================================================ */
function unzipTo(src, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  const zip = path.join(dest, "_book.zip");
  fs.copyFileSync(src, zip);
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${dest.replace(/'/g, "''")}' -Force`],
    { stdio: "pipe" });
  return dest;
}
const unesc = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (m, d) => String.fromCharCode(+d)).replace(/&amp;/g, "&");
const tText = (frag) => (frag.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || [])
  .map((t) => unesc(t.replace(/<t[^>]*>/, "").replace(/<\/t>/, ""))).join("");

function readSheet(dir) {
  const ssPath = path.join(dir, "xl", "sharedStrings.xml");
  const SS = fs.existsSync(ssPath)
    ? (fs.readFileSync(ssPath, "utf8").match(/<si>[\s\S]*?<\/si>/g) || []).map(tText) : [];
  const wsDir = path.join(dir, "xl", "worksheets");
  const file = fs.readdirSync(wsDir).filter((f) => /^sheet\d+\.xml$/.test(f))
    .sort((a, b) => +a.match(/\d+/)[0] - +b.match(/\d+/)[0])[0];
  const xml = fs.readFileSync(path.join(wsDir, file), "utf8");
  const colIdx = (ref) => {
    let n = 0; for (const ch of ref.match(/^([A-Z]+)/)[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  };
  const rows = [];
  const rowRe = /<row[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    const cells = [];
    const cRe = /<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm;
    while ((cm = cRe.exec(rm[2]))) {
      const attrs = cm[1], inner = cm[2] || "";
      const ref = (attrs.match(/r="([A-Z]+\d+)"/) || [])[1];
      if (!ref) continue;
      const t = (attrs.match(/t="([^"]*)"/) || [])[1];
      let v = null;
      if (t === "inlineStr") v = tText(inner);
      else {
        const vm = inner.match(/<v>([\s\S]*?)<\/v>/);
        if (vm) v = t === "s" ? (SS[+vm[1]] ?? "") : unesc(vm[1]);
      }
      if (v !== null && String(v).trim() !== "") cells[colIdx(ref)] = String(v).trim();
    }
    rows[+rm[1] - 1] = cells;
  }
  return rows;
}

/* ============================================================
   2. SHEET -> PRODUCTS
   Column layout is fixed by the sheet's two header rows (3 & 4).
   A new product starts wherever CODE/TYPE is filled; rows below
   it with only a RAW MATERIAL are extra BOM lines for it.
   ============================================================ */
const C = { series: 0, product: 1, code: 2, fgThk: 3, layers: 4, rm: 5, rmType: 6, rmThk: 7,
  rmGsm: 8, qty: 9, unit: 10, sFgThk: 11, sFgGsm: 12, sTensile: 13, sElong: 14, sSwSpeed: 15,
  sSwTest: 16, sSwHeight: 17, sSurfRes: 18, sVolRes: 19, sBdv: 20 };

function parseProducts(rows) {
  const out = [];
  let series = "", product = "", cur = null;
  const g = (r, c) => (rows[r] && rows[r][c]) ? String(rows[r][c]).trim() : "";
  for (let r = 4; r < rows.length; r++) {
    if (!rows[r] || !rows[r].length) continue;
    if (g(r, C.series)) series = g(r, C.series);
    if (g(r, C.product)) product = g(r, C.product);
    const code = g(r, C.code), rmName = g(r, C.rm);
    if (code) {
      cur = { row: r + 1, series, product, code, fgThk: g(r, C.fgThk), layersText: g(r, C.layers),
        // Spec keys MUST match labService.PARAMS exactly, or evaluate() finds
        // no spec for the param and every report grades as "Pending" forever.
        lines: [], spec: {
          thickness: g(r, C.sFgThk),          // FG thickness (mm)
          massPerArea: g(r, C.sFgGsm),        // FG GSM (g/m²)
          tensile: g(r, C.sTensile),
          elongation: g(r, C.sElong),
          swellSpeed: g(r, C.sSwSpeed),       // mm / 1 min
          swellHeight3: g(r, C.sSwTest),      // "SWELLING TEST"   = mm / 3 min
          swellHeight10: g(r, C.sSwHeight),   // "SWELLING HEIGHT" = mm / 10 min
          surfaceResistance: g(r, C.sSurfRes),
          volumeResistance: g(r, C.sVolRes),
          bdv: g(r, C.sBdv),
        } };
      out.push(cur);
    }
    if (rmName && cur) {
      cur.lines.push({ row: r + 1, rm: rmName, rmType: g(r, C.rmType), rmThk: g(r, C.rmThk),
        rmGsm: g(r, C.rmGsm), qty: g(r, C.qty), unit: g(r, C.unit) });
    }
  }
  return out;
}

/* ============================================================
   3. SPEC PARSING  ("0.08 ± 0.015" -> {min,max})
   Whatever cannot be read unambiguously is recorded with
   `unparsed` and NO min/max, so grading reports Pending rather
   than inventing a threshold.
   ============================================================ */
const SUP = { "⁰": 0, "¹": 1, "²": 2, "³": 3, "⁴": 4, "⁵": 5, "⁶": 6, "⁷": 7, "⁸": 8, "⁹": 9 };
function parseSpec(raw) {
  if (BOM.isBlank(raw)) return null;
  let s = String(raw).replace(/\s+/g, " ").trim();
  // "≥ 50/cm", "≥ 440 N/25mm", "≥185 V/µm", "> 20 MPa" — a trailing unit, not a
  // choice. Strip it before the ambiguity test or every slash reads as a range.
  // Deliberately anchored to the END so "MD ≥70 / TD ≥15" (two directional
  // limits, handled below) survives intact.
  s = s.replace(/\s*\/\s*\d*\s*[A-Za-zµ²³]+\.?\s*$/i, "").trim();   // "/cm", "/25mm", "/µm"
  s = s.replace(/\s+[A-Za-zµΩ%][A-Za-zµΩ%.·]*\s*$/i, "").trim();    // " N", " MPa", " KΩ.cm"
  // 1 × 10⁶  /  1 x 10^6
  const sci = s.match(/(\d+(?:\.\d+)?)\s*[×x]\s*10\s*[\^]?\s*([⁰¹²³⁴⁵⁶⁷⁸⁹]+|\d+)/i);
  if (sci) {
    const exp = /^[⁰¹²³⁴⁵⁶⁷⁸⁹]+$/.test(sci[2])
      ? +[...sci[2]].map((ch) => SUP[ch]).join("") : +sci[2];
    const val = parseFloat(sci[1]) * Math.pow(10, exp);
    s = s.replace(sci[0], String(val));
  }
  const n = (x) => parseFloat(String(x).replace(/,/g, ""));
  // "MD ≥70 / TD ≥15" — two DIRECTIONAL limits (machine vs transverse/cross
  // direction), not two competing options. Split so both can actually grade.
  const DIR = /^(MD|TD|CD|LONG(?:ITUDINAL)?|TRANS(?:VERSE)?)\b/i;
  const parts = s.split(/\s*\/\s*/).map((x) => x.trim()).filter(Boolean);
  if (parts.length > 1 && parts.every((x) => DIR.test(x))) {
    const dir = {};
    parts.forEach((x) => {
      const m = x.match(/^(MD|TD|CD|LONG(?:ITUDINAL)?|TRANS(?:VERSE)?)\s*(.+)$/i);
      if (!m) return;
      const sub = parseSpec(m[2]);
      if (sub && !sub.unparsed) dir[m[1].toUpperCase()] = sub;
    });
    return Object.keys(dir).length ? { directional: dir } : { unparsed: String(raw) };
  }
  // two thresholds ("≥ 12 & 16", "<1500 / <1000") -> ambiguous on purpose
  if (/&/.test(s) || (s.match(/[<>≤≥]/g) || []).length > 1) return { unparsed: String(raw) };
  let m;
  if ((m = s.match(/^([\d.]+)\s*±\s*([\d.]+)$/))) return { min: n(m[1]) - n(m[2]), max: n(m[1]) + n(m[2]), nominal: n(m[1]), tol: n(m[2]) };
  // one-sided tolerance: "0.15 + 0.03" means 0.15 up to 0.18, never below
  if ((m = s.match(/^([\d.]+)\s*\+\s*([\d.]+)$/))) return { min: n(m[1]), max: n(m[1]) + n(m[2]), nominal: n(m[1]) };
  if ((m = s.match(/^[≥>]=?\s*([\d.]+)$/))) return { min: n(m[1]) };
  if ((m = s.match(/^[≤<]=?\s*([\d.]+)$/))) return { max: n(m[1]) };
  if ((m = s.match(/^([\d.]+)\s*[-–]\s*([\d.]+)$/))) return { min: n(m[1]), max: n(m[2]) };
  // plain value, incl. Excel's scientific notation for small thicknesses
  if ((m = s.match(/^(\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)$/))) return { nominal: parseFloat(m[1]) };
  return { unparsed: String(raw) };
}

/* ============================================================
   4. IDENTITY  (stable, readable ids)
   ============================================================ */
const slug = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-");
const fgId = (code) => "FG-" + slug(code);
function rmId(name, type) {
  const base = "RM-" + slug(name);
  return type && !BOM.isBlank(type) ? base + "-" + slug(type) : base;
}
/* "CLOFT 912/ CLOFT 913" or "MOMENTIVE 595 NT or Q2 7406" -> the discrete grades */
function splitGrades(v) {
  if (BOM.isBlank(v)) return [];
  return String(v).split(/\s*\/\s*|\s+\bor\b\s+/i).map((x) => x.trim()).filter(Boolean);
}

/* ============================================================
   5. BUILD THE CATALOGUE
   ============================================================ */
/* Some codes repeat. Two different reasons, handled differently:
     • same code, DIFFERENT thickness  (CH-PET x6, CH-PFT x6, CH-PTFE x3)
       -> genuinely separate products; disambiguate the id by micron.
     • same code, SAME thickness       (CHN-12 WS, CHN-20 WS, CHSCWWBT-18)
       -> one product with ALTERNATE approved recipes (a different fabric
          supplier, and the knock-on qty changes). Kept as bom.alternates
          so neither recipe is silently overwritten. */
function assignIds(products) {
  const byCode = new Map();
  products.forEach((p) => {
    if (!byCode.has(p.code)) byCode.set(p.code, []);
    byCode.get(p.code).push(p);
  });
  products.forEach((p) => {
    const micron = (v) => (v == null ? null : Math.round(v * 1000));
    const mine = micron(BOM.numLoose(p.fgThk));
    const distinct = new Set(byCode.get(p.code)
      .map((x) => micron(BOM.numLoose(x.fgThk))).filter((v) => v != null));
    p._id = (distinct.size > 1 && mine != null) ? fgId(p.code + "-" + mine) : fgId(p.code);
  });
}
/* Label an alternate by whatever actually distinguishes it — the fabric grade. */
function altLabel(p, i) {
  const fab = p.lines.find((l) => BOM.normUnit(l.unit) === "MTR" && !BOM.isBlank(l.rmGsm));
  if (fab && !BOM.isBlank(fab.rmType)) return String(fab.rmType).replace(/\s+/g, " ").trim();
  if (fab && !BOM.isBlank(fab.rmGsm)) return fab.rm + " " + fab.rmGsm + " gsm";
  return "Variant " + (i + 1);
}

function build(products) {
  const items = new Map();      // id -> item
  const boms = new Map();       // fgId -> {yield, lines, alternates?}
  const labProducts = [];
  const warn = [];
  assignIds(products);

  const addRm = (name, grade, line) => {
    const id = rmId(name, grade);
    const isFab = BOM.normUnit(line.unit) === "MTR" && !BOM.isBlank(line.rmGsm);
    if (!items.has(id)) {
      // NB: putItem() promotes the known columns and JSON-encodes whatever is
      // LEFT OVER into `doc`. So extra fields go at the top level here —
      // passing a literal `doc:{…}` would store it double-nested as {"doc":{…}}
      // and hide every spec field from the UI.
      items.set(id, {
        id, name: (name + (grade && !BOM.isBlank(grade) ? " " + grade : "")).replace(/\s+/g, " ").trim(),
        cat: "RM", uom: BOM.normUnit(line.unit) || "KG", cost: 0, price: 0,
        reorder: 0, safety: 0, lead: 7, group: isFab ? "FABRIC" : "CHEMICAL",
        material: name, grade: (BOM.isBlank(grade) ? null : grade),
        thicknessMM: BOM.numLoose(line.rmThk), gsm: BOM.numLoose(line.rmGsm),
        fabric: isFab, source: "PRODUCT, TYPE WITH BOM FINAL.xlsx",
      });
    }
    return id;
  };

  const buildLines = (p) => p.lines.map((l) => {
    const grades = splitGrades(l.rmType);
    const rangedType = grades.length > 1;
    const options = rangedType ? grades.map((gr) => addRm(l.rm, gr, l)) : [];
    const single = rangedType ? null : addRm(l.rm, grades[0] || null, l);
    const qty = BOM.num(l.qty);
    if (qty == null) warn.push(`${p.code} row ${l.row}: qty "${l.qty}" unreadable — set to 0`);
    return {
      id: single, options,
      rm: l.rm, rmType: BOM.isBlank(l.rmType) ? null : l.rmType,
      rmThk: BOM.isBlank(l.rmThk) ? null : l.rmThk,
      rmGsm: BOM.isBlank(l.rmGsm) ? null : l.rmGsm,
      qty: qty == null ? 0 : qty, unit: BOM.normUnit(l.unit) || "KG",
      pickupPct: BOM.defaultPickup(l.rm),
      ranged: rangedType || BOM.isRanged(l.rmThk) || BOM.isRanged(l.rmGsm),
    };
  });

  // one entry per resolved id; >1 block in a group == alternate recipes
  const groups = new Map();
  products.forEach((p) => {
    if (!groups.has(p._id)) groups.set(p._id, []);
    groups.get(p._id).push(p);
  });

  groups.forEach((blocks, id) => {
    const p = blocks[0];

    const spec = {};
    Object.entries(p.spec).forEach(([k, v]) => {
      const parsed = parseSpec(v);
      if (parsed) {
        spec[k] = parsed;
        if (parsed.unparsed) warn.push(`${p.code}: spec ${k}="${v}" is ambiguous — left ungraded`);
      }
    });

    const fgGsm = BOM.numLoose(p.spec.massPerArea);
    const fgThk = BOM.numLoose(p.fgThk);

    const variants = blocks.map((b, i) => ({ label: altLabel(b, i), row: b.row, lines: buildLines(b) }));
    const lines = variants[0].lines;
    if (variants.length > 1) {
      warn.push(`${p.code}: ${variants.length} alternate recipes kept (${variants.map((v) => v.label).join(" | ")})`);
    }

    const rolled = BOM.compute({ lines }, { fgGsm });
    // Conversion products (mica/PET/PFT slitting) are 1:1 with their substrate:
    // no coating is applied, so a zero pickup GSM is correct, not a defect.
    const hasCoating = lines.some((l) => !(BOM.normUnit(l.unit) === "MTR" && l.rmGsm));
    if (hasCoating && fgGsm != null && rolled.pickupGsm != null && rolled.pickupGsm <= 0) {
      warn.push(`${p.code}: fabric GSM (${rolled.fabricGsm}) >= FG GSM (${fgGsm}) — pickup GSM ${rolled.pickupGsm}, total production not computable`);
    }

    items.set(id, {
      id, name: p.product || p.code, cat: "FG", uom: "KG",
      cost: 0, price: 0, reorder: 0, safety: 0, lead: 7, group: p.series || null,
      // top level on purpose — putItem() JSON-encodes the leftovers into `doc`
      typeCode: p.code, series: p.series || null, productName: p.product || null,
      thicknessMM: fgThk, gsm: fgGsm,
      layersText: BOM.isBlank(p.layersText) ? null : p.layersText.replace(/\s+/g, " "),
      layerCount: rolled.layers || null, conversion: !hasCoating,
      batch: { widthMM: BOM.BATCH.widthMM, lengthM: BOM.BATCH.lengthM, sqm: rolled.batchSqm },
      spec, sourceRow: p.row, source: "PRODUCT, TYPE WITH BOM FINAL.xlsx",
    });

    const bom = { yield: 1, lines };
    if (variants.length > 1) bom.alternates = variants;
    boms.set(id, bom);

    labProducts.push({
      id: "LP-" + id.replace(/^FG-/, ""), code: p.code, name: p.product || p.code,
      series: p.series || null, thickness: fgThk, gsm: fgGsm,
      itemId: id, refMode: "batch", active: true, spec, notes: null,
      flags: {
        mica: /MICA/i.test(p.series || "") || /MICA/i.test(p.product || ""),
        waterBlocking: /WATER BLOCK/i.test(p.series || "") || /WATER BLOCK/i.test(p.product || ""),
        semiConductive: /SEMI\s*CONDUCTIVE/i.test(p.product || ""),
      },
    });
  });

  return { items: [...items.values()], boms, labProducts, warn };
}

/* ============================================================
   6. MAIN
   ============================================================ */
function main() {
  if (!fs.existsSync(XLSX)) { console.error("Data file not found:\n  " + XLSX); process.exit(1); }
  console.log("Reading  : " + XLSX);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chh-bom-"));
  let products;
  try { products = parseProducts(readSheet(unzipTo(XLSX, tmp))); }
  finally { fs.rmSync(tmp, { recursive: true, force: true }); }

  const { items, boms, labProducts, warn } = build(products);
  const fgs = items.filter((i) => i.cat === "FG"), rms = items.filter((i) => i.cat === "RM");
  const lineCount = [...boms.values()].reduce((s, b) => s + b.lines.length, 0);
  const ranged = [...boms.values()].reduce((s, b) => s + b.lines.filter((l) => l.ranged).length, 0);

  console.log(`\nParsed   : ${products.length} products, ${lineCount} BOM lines`);
  console.log(`Catalogue: ${fgs.length} finished goods, ${rms.length} raw materials`
    + ` (${rms.filter((r) => r.group === "FABRIC").length} fabric, ${rms.filter((r) => r.group === "CHEMICAL").length} chemical)`);
  console.log(`Ranged   : ${ranged} BOM lines need a store dropdown at issue`);
  console.log(`Lab      : ${labProducts.length} products, `
    + `${labProducts.reduce((s, p) => s + Object.keys(p.spec).filter((k) => !p.spec[k].unparsed).length, 0)} graded spec values`);

  if (warn.length) {
    console.log(`\nWarnings (${warn.length}):`);
    warn.slice(0, 20).forEach((w) => console.log("  ! " + w));
    if (warn.length > 20) console.log(`  … and ${warn.length - 20} more`);
  }

  if (DRY) { console.log("\n--dry: nothing written."); return; }

  const repo = require("../backend/src/db/repository");
  const { getDb } = require("../backend/src/db/connection");
  const db = getDb();

  const tx = db.transaction(() => {
    if (!KEEP_DEMO) {
      // Demo transactions reference demo items — clearing the catalogue
      // without them would leave dangling movements and false stock.
      for (const t of ["movements", "work_orders", "sales_orders", "purchase_orders", "boms", "items"]) {
        db.prepare(`DELETE FROM ${t}`).run();
      }
      db.prepare("DELETE FROM lab_products").run();
    }
    items.forEach((i) => repo.putItem(i));
    boms.forEach((b, id) => repo.putBom(id, b));
    labProducts.forEach((p) => repo.putLabProduct(p));
  });
  tx();

  console.log(`\nWrote    : ${items.length} items, ${boms.size} BOMs, ${labProducts.length} lab products`
    + (KEEP_DEMO ? " (demo data kept)" : " (demo catalogue replaced)"));
}

main();
