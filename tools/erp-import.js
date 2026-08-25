#!/usr/bin/env node
/* ============================================================
   CHHAPERIA ERP — load another machine's export into this one

     node tools/erp-import.js [--from <dir>] [--dry] [--yes]

   Reads what erp-export.js wrote and makes this database match
   it. Not a merge: the tables in the export are REPLACED. Two
   installs editing at once cannot both be right about the stock
   ledger, and a half-merged ledger is worse than a stale one.

   Before writing anything it exports what is here now into
   backups/, using the very same format — so undoing an import
   is just importing the backup.

   Never touched: users (this machine keeps its own logins) and
   meta. Anything the export did not carry is left alone.

   --dry   show what would change, write nothing
   --yes   required to actually write
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const { db, withTx, closeDb, readConfig } = require(path.join(ROOT, "backend/src/db/connection"));

const DRY = process.argv.includes("--dry");
const YES = process.argv.includes("--yes");

const ORDER = [
  "org", "settings",
  "warehouses", "categories", "suppliers", "customers", "transporters",
  "items", "boms",
  "movements", "work_orders", "sales_orders", "purchase_orders",
  "leads", "appointments", "complaints", "quotations",
  "hr_workers", "hr_punches", "hr_attendance",
  "hr_leave_types", "hr_leaves", "hr_payruns", "hr_payslips",
  "lab_products", "lab_reports", "grns", "grn_tests",
];

function argVal(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return null;
  const txt = fs.readFileSync(file, "utf8");
  const out = [];
  txt.split("\n").forEach((ln, i) => {
    if (!ln.trim()) return;
    try { out.push(JSON.parse(ln)); }
    catch (e) { throw new Error(path.basename(file) + " line " + (i + 1) + " is not valid JSON: " + e.message); }
  });
  return out;
}

async function main() {
  const fromDir = path.resolve(ROOT, argVal("--from", path.join("data", "exchange")));
  const manFile = path.join(fromDir, "_manifest.json");
  if (!fs.existsSync(manFile)) {
    console.error("No _manifest.json in " + fromDir +
      "\nPoint --from at the folder erp-export.js produced on the other machine.");
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(manFile, "utf8"));
  if (manifest.format !== 1) {
    console.error("Export format " + manifest.format + " — this tool understands format 1.");
    process.exit(1);
  }

  const cfg = readConfig();
  const d = await db();

  console.log("  from : " + path.relative(ROOT, fromDir) + path.sep +
    "  (exported " + manifest.exportedAt + ")");
  console.log("  into : mysql://" + cfg.host + ":" + cfg.port + "/" + cfg.database + "\n");

  const present = new Set((await d.all(
    "SELECT TABLE_NAME AS n FROM information_schema.TABLES " +
    "WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'", [cfg.database])).map((r) => r.n));

  const colRows = await d.all(
    "SELECT TABLE_NAME AS t, COLUMN_NAME AS c, DATA_TYPE AS ty FROM information_schema.COLUMNS " +
    "WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION", [cfg.database]);
  const cols = new Map();
  for (const r of colRows) {
    if (!cols.has(r.t)) cols.set(r.t, new Map());
    cols.get(r.t).set(r.c, r.ty);
  }

  /* read and check everything BEFORE touching the database, so a malformed
     file stops the run while the data here is still intact */
  const incoming = new Map();
  const notes = [];
  for (const table of ORDER) {
    if (!manifest.tables[table]) continue;
    if (!present.has(table)) { notes.push(table + ": in the export but not in this schema — skipped"); continue; }
    const rows = readJsonl(path.join(fromDir, table + ".jsonl"));
    if (rows === null) { notes.push(table + ": listed in the manifest but its file is missing — skipped"); continue; }
    if (rows.length !== manifest.tables[table].rows)
      throw new Error(table + ".jsonl holds " + rows.length + " rows but the manifest says " +
        manifest.tables[table].rows + ". The folder is incomplete or was edited.");
    incoming.set(table, rows);

    const here = cols.get(table);
    const missing = (manifest.tables[table].columns || []).filter((c) => !here.has(c));
    if (missing.length)
      notes.push(table + ": column(s) " + missing.join(", ") +
        " exist on the other machine but not here — not imported");
  }

  console.log("  table                 here  ->  incoming");
  let deltas = 0;
  for (const table of ORDER) {
    if (!incoming.has(table)) continue;
    const now = await d.val("SELECT COUNT(*) FROM `" + table + "`");
    const next = incoming.get(table).length;
    const mark = Number(now) === next ? " " : "*";
    if (Number(now) !== next) deltas++;
    console.log("  " + mark + " " + table.padEnd(20) + String(now).padStart(5) + "  ->  " + next);
  }
  if (notes.length) {
    console.log("\n  worth knowing:");
    for (const n of notes) console.log("   · " + n);
  }
  console.log("\n  " + deltas + " table(s) change row count. Row contents may differ in others too.");

  if (DRY) { console.log("\n--dry: nothing written."); await closeDb(); return; }
  if (!YES) {
    console.log("\n  This REPLACES the tables listed above on this machine.");
    console.log("  Re-run with --yes once you are happy with the plan.");
    await closeDb();
    return;
  }

  /* a backup in the import format, so undoing is a plain re-import */
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = path.join(ROOT, "backups", "erp-before-import-" + stamp);
  console.log("\n  backing up what is here now -> " + path.relative(ROOT, backup));
  execFileSync(process.execPath, [path.join(__dirname, "erp-export.js"), "--out", backup],
    { stdio: "ignore" });
  console.log("  backup written. Undo with:  node tools/erp-import.js --from \"" +
    path.relative(ROOT, backup) + "\" --yes\n");

  await withTx(async (x) => {
    /* delete children before parents, insert parents before children —
       foreign key checks stay ON, so a broken export is refused rather
       than half-applied */
    for (const table of [...ORDER].reverse())
      if (incoming.has(table)) await x.run("DELETE FROM `" + table + "`");

    for (const table of ORDER) {
      const rows = incoming.get(table);
      if (!rows || !rows.length) continue;
      const here = cols.get(table);
      const names = (manifest.tables[table].columns || []).filter((c) => here.has(c));
      const sql = "INSERT INTO `" + table + "` (" + names.map((c) => "`" + c + "`").join(",") +
        ") VALUES (" + names.map(() => "?").join(",") + ")";
      for (const r of rows) {
        const vals = names.map((c) => {
          const v = r[c] === undefined ? null : r[c];
          /* JSON columns arrive as real objects from JSONL and must go back
             as text; everything else travels as-is */
          if (here.get(c) === "json" && v !== null && typeof v !== "string") return JSON.stringify(v);
          return v;
        });
        await x.run(sql, vals);
      }
    }
  });

  console.log("  verifying…");
  let bad = 0;
  for (const [table, rows] of incoming) {
    const n = Number(await d.val("SELECT COUNT(*) FROM `" + table + "`"));
    if (n !== rows.length) { console.log("  ✗ " + table + ": expected " + rows.length + ", found " + n); bad++; }
  }
  console.log(bad ? "  " + bad + " table(s) DISAGREE — check the backup." : "  every table matches.");
  console.log("\n  Done. Restart the ERP server so it serves the new data.");

  await closeDb();
}

main().catch((e) => { console.error("\nImport failed: " + (e && e.message)); process.exit(1); });
