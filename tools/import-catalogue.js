#!/usr/bin/env node
/* ============================================================
   CHHAPERIA ERP — import the real product / BOM catalogue

     node tools/import-catalogue.js [--dry] [--keep-demo]

   The live database is NEVER committed: it holds real product data
   and password hashes, and it was deliberately untracked (see the
   note at the top of .gitignore). What IS committed is the
   catalogue, exported as two CSVs — and this is what puts it back.

     data/catalogue-items-*.csv   the item master
     data/catalogue-boms-*.csv    one BOM per finished good

   A clone therefore starts on the seeded DEMO catalogue, which is
   why a fresh install shows a couple of dozen tidy-sounding
   products rather than the plant's real ones.

   --dry        parse and report, write nothing
   --keep-demo  leave the demo catalogue in place and add to it.
                By default the demo items are replaced, and the demo
                movements / POs / SOs / work orders that reference
                them go too — a stock figure computed from movements
                whose items no longer exist is a lie, and a lie in
                the stock column is worse than an empty column.

   Never touched: users, settings (Label Studio designs live there),
   suppliers, customers, warehouses, HR, lab products, transporters.
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DRY = process.argv.includes("--dry");
const KEEP_DEMO = process.argv.includes("--keep-demo");

/* ---- the smallest correct CSV reader: quoted fields, doubled quotes ---- */
function parseCsv(txt) {
  txt = txt.replace(/^﻿/, "");
  const Q = '"';
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < txt.length; i++) {
    const c = txt[i];
    if (inQuotes) {
      if (c === Q) {
        if (txt[i + 1] === Q) { field += Q; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === Q) inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") {
      row.push(field); field = "";
      if (row.some((x) => x !== "")) rows.push(row);
      row = [];
    } else if (c !== "\r") field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    if (row.some((x) => x !== "")) rows.push(row);
  }
  return rows;
}

const newest = (prefix) => {
  const dir = path.join(ROOT, "data");
  const hits = fs.readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".csv"))
    .sort();
  if (!hits.length) throw new Error("no " + prefix + "*.csv in data/");
  return path.join(dir, hits[hits.length - 1]);
};

const num = (v, d = 0) => (v === "" || v == null || isNaN(+v) ? d : +v);

function readItems(file) {
  const rows = parseCsv(fs.readFileSync(file, "utf8"));
  const hdr = rows[0].map((h) => h.trim());
  const at = (r, k) => { const i = hdr.indexOf(k); return i < 0 ? "" : (r[i] || "").trim(); };
  return rows.slice(1).map((r) => {
    const item = {
      id: at(r, "id"), name: at(r, "name"), cat: at(r, "cat"),
      uom: at(r, "uom") || null,
      cost: num(at(r, "cost")), price: num(at(r, "price")),
      reorder: num(at(r, "reorder")), safety: num(at(r, "safety")),
      lead: num(at(r, "lead"), 7),
      abc: at(r, "abc") || null, hsn: at(r, "hsn") || null,
      supplierId: at(r, "supplierId") || null,
      group: at(r, "group") || null,
    };
    /* everything past the promoted columns rides in the doc, exactly as the
       repository stores it */
    for (const k of ["typeCode", "std", "flameC", "barcode"]) {
      const v = at(r, k); if (v) item[k] = v;
    }
    /* widths are a LIST on the item — a die can be slit several ways */
    const w = at(r, "widthMM");
    if (w) {
      const list = w.split(/[|;]/).map((x) => +x).filter((x) => x > 0);
      if (list.length) item.widthMM = list;
    }
    return item;
  }).filter((i) => i.id && i.name);
}

function readBoms(file) {
  const rows = parseCsv(fs.readFileSync(file, "utf8"));
  const hdr = rows[0].map((h) => h.trim());
  const at = (r, k) => { const i = hdr.indexOf(k); return i < 0 ? "" : (r[i] || "").trim(); };
  const out = [];
  for (const r of rows.slice(1)) {
    const itemId = at(r, "itemId");
    if (!itemId) continue;
    let lines = [];
    const raw = at(r, "lines");
    if (raw) {
      try { lines = JSON.parse(raw); }
      catch { out.push({ itemId, bad: true }); continue; }
    }
    out.push({ itemId, yield: num(at(r, "yield"), 1) || 1, lines });
  }
  return out;
}

async function main() {
  const itemsFile = newest("catalogue-items");
  const bomsFile = newest("catalogue-boms");
  const items = readItems(itemsFile);
  const boms = readBoms(bomsFile);
  const badBoms = boms.filter((b) => b.bad);
  const goodBoms = boms.filter((b) => !b.bad);

  console.log("  items file : " + path.relative(ROOT, itemsFile) + "  (" + items.length + " items)");
  console.log("  boms file  : " + path.relative(ROOT, bomsFile) + "  (" + goodBoms.length + " BOMs)");
  const byCat = {};
  items.forEach((i) => { byCat[i.cat || "(none)"] = (byCat[i.cat || "(none)"] || 0) + 1; });
  console.log("  categories : " + Object.entries(byCat).map(([k, v]) => k + " " + v).join(", "));
  if (badBoms.length)
    console.log("  ! " + badBoms.length + " BOM row(s) had unreadable lines and are skipped: " +
      badBoms.map((b) => b.itemId).join(", "));

  /* a BOM whose finished good is not in the item file would be an orphan */
  const ids = new Set(items.map((i) => i.id));
  const orphans = goodBoms.filter((b) => !ids.has(b.itemId));
  if (orphans.length)
    console.log("  ! " + orphans.length + " BOM(s) name an item not in the catalogue: " +
      orphans.slice(0, 5).map((b) => b.itemId).join(", "));

  if (DRY) { console.log("\n--dry: nothing written."); return; }

  const { withTx, closeDb } = require(path.join(ROOT, "backend/src/db/connection"));
  const repo = require(path.join(ROOT, "backend/src/db/repository"));

  let cleared = {};
  await withTx(async (x) => {
    /* every category the catalogue uses must exist, or the item's foreign
       key has nothing to point at */
    const have = new Set((await x.all("SELECT `id` FROM `categories`")).map((r) => r.id));
    for (const cat of Object.keys(byCat)) {
      if (cat === "(none)" || have.has(cat)) continue;
      await x.run("INSERT INTO `categories`(`id`,`name`,`kind`) VALUES(?,?,?)",
        [cat, cat, cat === "RM" ? "raw" : cat === "FG" ? "finished" : "other"]);
      console.log("  + category " + cat + " created");
    }

    if (!KEEP_DEMO) {
      /* the demo transactions reference demo items; clearing the catalogue
         without them would leave dangling movements and false stock */
      for (const t of ["movements", "work_orders", "sales_orders", "purchase_orders", "boms", "items"]) {
        const r = await x.run("DELETE FROM `" + t + "`");
        cleared[t] = r.affectedRows;
      }
    }

    for (const i of items) await repo.putItem(i, x);
    for (const b of goodBoms) {
      if (!ids.has(b.itemId)) continue;
      await repo.putBom(b.itemId, { yield: b.yield, lines: b.lines }, x);
    }
  });

  if (!KEEP_DEMO)
    console.log("\n  cleared    : " +
      Object.entries(cleared).map(([t, n]) => t + " " + n).join(", "));
  console.log("  wrote      : " + items.length + " items, " +
    goodBoms.filter((b) => ids.has(b.itemId)).length + " BOMs" +
    (KEEP_DEMO ? "  (demo catalogue kept)" : "  (demo catalogue replaced)"));

  await closeDb();
}

main().catch((e) => { console.error("\nImport failed: " + (e && e.message)); process.exit(1); });
