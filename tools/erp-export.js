#!/usr/bin/env node
/* ============================================================
   CHHAPERIA ERP — export this machine's data for another machine

     node tools/erp-export.js [--out <dir>]

   Writes one file per table into data/exchange/ (gitignored).
   Hand that folder to the other install and run erp-import.js
   there; it ends up with exactly what this machine holds.

   WHY ROW-FOR-ROW AND NOT GET /api/state

   getState() builds a convenience document for the UI. It does
   not carry hr_punches at all, and it reshapes what it does
   carry. A copy taken table by table cannot lose a column
   nobody remembered to map.

   WHAT IT DELIBERATELY LEAVES OUT

     users   password hashes. Accounts are per-install; sharing
             them would hand over everyone's login as well.
     meta    seededAt / schema version. Bookkeeping about THIS
             install, meaningless on another one.

   Output is deterministic — rows ordered by primary key, object
   keys sorted — so re-exporting unchanged data produces a
   byte-identical file and a diff shows only what really moved.
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const { db, closeDb, readConfig } = require(path.join(ROOT, "backend/src/db/connection"));

const NEVER_EXPORT = new Set(["users", "meta"]);

/* FK-safe order: a table never appears before something it points at.
   Import replays this forwards and deletes backwards. */
const ORDER = [
  "org", "settings",
  "warehouses", "categories", "suppliers", "customers", "transporters",
  "items", "boms",
  "movements", "work_orders", "sales_orders", "purchase_orders",
  "leads", "appointments",
  "hr_workers", "hr_punches", "hr_attendance",
  "hr_leave_types", "hr_leaves", "hr_payruns", "hr_payslips",
  "lab_products", "lab_reports", "grns", "grn_tests",
];

function argVal(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/* stable key order, so an unchanged row serialises to an unchanged line */
function line(row, cols) {
  const o = {};
  for (const c of cols) if (row[c] !== undefined) o[c] = row[c];
  return JSON.stringify(o);
}

async function main() {
  const outDir = path.resolve(ROOT, argVal("--out", path.join("data", "exchange")));
  const cfg = readConfig();
  const d = await db();

  console.log("  from : mysql://" + cfg.host + ":" + cfg.port + "/" + cfg.database);
  console.log("  to   : " + path.relative(ROOT, outDir) + path.sep + "\n");

  const present = new Set((await d.all(
    "SELECT TABLE_NAME AS n FROM information_schema.TABLES " +
    "WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'", [cfg.database])).map((r) => r.n));

  /* a table added to the schema but not to ORDER would be silently skipped —
     that is exactly the class of bug this tool exists to avoid */
  const unlisted = [...present].filter((t) => !ORDER.includes(t) && !NEVER_EXPORT.has(t));
  if (unlisted.length) {
    console.error("These tables exist but are not in ORDER, so they would be missed:\n  " +
      unlisted.join(", ") + "\nAdd them to ORDER in tools/erp-export.js (and erp-import.js) first.");
    process.exit(1);
  }

  const colRows = await d.all(
    "SELECT TABLE_NAME AS t, COLUMN_NAME AS c, DATA_TYPE AS ty FROM information_schema.COLUMNS " +
    "WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION", [cfg.database]);
  const cols = new Map();
  for (const r of colRows) {
    if (!cols.has(r.t)) cols.set(r.t, []);
    cols.get(r.t).push({ name: r.c, type: r.ty });
  }

  const pkRows = await d.all(
    "SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.KEY_COLUMN_USAGE " +
    "WHERE TABLE_SCHEMA = ? AND CONSTRAINT_NAME = 'PRIMARY' ORDER BY TABLE_NAME, ORDINAL_POSITION",
    [cfg.database]);
  const pks = new Map();
  for (const r of pkRows) {
    if (!pks.has(r.t)) pks.set(r.t, []);
    pks.get(r.t).push(r.c);
  }

  fs.mkdirSync(outDir, { recursive: true });
  /* clear stale table files from an older export, or a table emptied since
     then would keep its old rows and reappear on import */
  for (const f of fs.readdirSync(outDir))
    if (f.endsWith(".jsonl") || f === "_manifest.json") fs.unlinkSync(path.join(outDir, f));

  const manifest = { format: 1, exportedAt: new Date().toISOString(), tables: {} };
  let total = 0;

  for (const table of ORDER) {
    if (!present.has(table)) { console.log("  – " + table + ": no such table here, skipped"); continue; }

    const colDefs = cols.get(table) || [];
    const names = colDefs.map((c) => c.name);
    const pk = pks.get(table) || [];
    const order = pk.length ? pk.map((c) => "`" + c + "`").join(",") : names.map((c) => "`" + c + "`").join(",");

    const rows = await d.all("SELECT * FROM `" + table + "` ORDER BY " + order);

    /* mysql2 hands back Buffers for binary columns; JSON would mangle them
       into {"type":"Buffer"} and the round trip would be a lie */
    for (const r of rows) {
      for (const c of names) {
        if (Buffer.isBuffer(r[c])) {
          console.error("`" + table + "`.`" + c + "` is binary. This tool only handles " +
            "text, numbers and JSON. Add explicit encoding before using it on this schema.");
          process.exit(1);
        }
      }
    }

    const body = rows.map((r) => line(r, names)).join("\n");
    fs.writeFileSync(path.join(outDir, table + ".jsonl"), body ? body + "\n" : "", "utf8");
    manifest.tables[table] = { rows: rows.length, columns: names };
    total += rows.length;
    console.log("  " + (rows.length ? "✓" : "·") + " " + table.padEnd(18) + " " + rows.length);
  }

  fs.writeFileSync(path.join(outDir, "_manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n", "utf8");

  console.log("\n  " + total + " rows in " + Object.keys(manifest.tables).length + " tables.");
  console.log("  Left out on purpose: users (password hashes), meta (install bookkeeping).");
  console.log("\n  Send the whole " + path.basename(outDir) + " folder across, then on the");
  console.log("  other machine:  node tools/erp-import.js --yes");

  await closeDb();
}

main().catch((e) => { console.error("\nExport failed: " + (e && e.message)); process.exit(1); });
