#!/usr/bin/env node
/* ============================================================
   CHHAPERIA ERP — one-time data migration, SQLite -> MySQL 8.4

     node tools/migrate-sqlite-to-mysql.js [--dry-run] [--force]

   Reads data/chhaperia.db (or CHHAPERIA_SQLITE_FILE) row by row
   and writes it into the MySQL database the backend is configured
   for. Table by table, in an order the foreign keys allow.

   WHY IT COPIES TABLES AND NOT DOCUMENTS

   It would be shorter to call getState() on the old build and
   saveState() on the new one. It would also quietly drop anything
   the document mapping does not carry — hr_punches, for one, which
   getState() never returns. A row-for-row copy cannot lose a column
   nobody remembered.

   WHAT IT REFUSES TO DO

   · It will not run against a MySQL database that already holds
     rows, unless --force says so. Running a migration twice is how
     a ledger ends up with every movement in it twice.
   · It does not switch off foreign key checks. If a bill of
     materials points at an item that is not there, that is a real
     fault in the data and this stops and shows it, rather than
     importing something the database would have refused.

   JSON columns are validated on the way through: SQLite kept them
   as TEXT and never checked, so anything malformed is reported
   with its table, id and column instead of failing later as a
   parse error in a screen nobody was looking at.
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const Database = require(path.join(ROOT, "backend", "node_modules", "better-sqlite3"));
const mysql = require(path.join(ROOT, "backend", "node_modules", "mysql2", "promise"));
const { readConfig } = require(path.join(ROOT, "backend", "src", "db", "connection"));

const DRY = process.argv.includes("--dry-run");
const FORCE = process.argv.includes("--force");
const SQLITE_FILE = process.env.CHHAPERIA_SQLITE_FILE ||
  path.join(ROOT, "data", "chhaperia.db");

/* FK-safe order: a table never appears before something it points at. */
const ORDER = [
  "org", "settings", "meta",
  "warehouses", "categories", "suppliers", "customers", "transporters",
  "items", "boms",
  "movements", "work_orders", "sales_orders", "purchase_orders",
  "leads", "appointments", "users",
  "hr_workers", "hr_punches", "hr_attendance",
  "hr_leave_types", "hr_leaves", "hr_payruns", "hr_payslips",
  "lab_products", "lab_reports", "grns", "grn_tests",
];

const q = (id) => "`" + String(id).replace(/`/g, "``") + "`";

async function main() {
  if (!fs.existsSync(SQLITE_FILE)) {
    console.error("No SQLite database at " + SQLITE_FILE);
    process.exit(1);
  }
  const cfg = readConfig();
  console.log("  from : " + SQLITE_FILE);
  console.log("  to   : mysql://" + cfg.host + ":" + cfg.port + "/" + cfg.database);
  console.log(DRY ? "  mode : DRY RUN — nothing will be written\n" : "");

  const src = new Database(SQLITE_FILE, { readonly: true });
  const conn = await mysql.createConnection({
    host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password,
    database: cfg.database, multipleStatements: false, dateStrings: true,
  });

  try {
    /* what the destination actually looks like — types come from the server,
       so this cannot drift from schema.mysql.sql */
    const [cols] = await conn.query(
      "SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS " +
      "WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION", [cfg.database]);
    if (!cols.length) {
      console.error("The MySQL database has no tables. Start the backend once so the " +
        "schema is applied, then run this again.");
      process.exit(1);
    }
    const target = new Map();
    for (const c of cols) {
      if (!target.has(c.TABLE_NAME)) target.set(c.TABLE_NAME, new Map());
      target.get(c.TABLE_NAME).set(c.COLUMN_NAME, c.DATA_TYPE);
    }

    /* refuse to double-import */
    if (!FORCE && !DRY) {
      const busy = [];
      for (const t of ORDER) {
        if (!target.has(t)) continue;
        const [[{ n }]] = await conn.query("SELECT COUNT(*) AS n FROM " + q(t));
        if (n > 0) busy.push(t + "(" + n + ")");
      }
      if (busy.length) {
        console.error("MySQL already holds rows in: " + busy.join(", ") +
          "\nRunning this twice would duplicate them. Empty those tables first, " +
          "or pass --force if you are certain.");
        process.exit(1);
      }
    }

    const sqliteTables = new Set(src.prepare(
      "SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));

    let grandRead = 0, grandWrote = 0;
    const problems = [];

    for (const table of ORDER) {
      if (!sqliteTables.has(table)) { console.log(`  – ${table}: not in the SQLite file, skipped`); continue; }
      if (!target.has(table)) { console.log(`  – ${table}: no such table in MySQL, skipped`); continue; }

      const tcols = target.get(table);
      const rows = src.prepare("SELECT * FROM " + q(table)).all();
      grandRead += rows.length;
      if (!rows.length) { console.log(`  · ${table}: empty`); continue; }

      /* only columns that exist at BOTH ends travel */
      const names = Object.keys(rows[0]).filter((c) => tcols.has(c));
      const dropped = Object.keys(rows[0]).filter((c) => !tcols.has(c));
      if (dropped.length)
        problems.push(`${table}: column(s) ${dropped.join(", ")} exist in SQLite but not in MySQL — not copied`);

      const sql = "INSERT INTO " + q(table) + " (" + names.map(q).join(",") + ") VALUES (" +
        names.map(() => "?").join(",") + ")";

      let wrote = 0;
      if (!DRY) await conn.beginTransaction();
      try {
        for (const r of rows) {
          const vals = names.map((c) => {
            const v = r[c];
            if (tcols.get(c) !== "json") return v;
            if (v == null) return null;
            /* SQLite never checked these. Check now, and say which row if not. */
            try { JSON.parse(v); return v; }
            catch {
              problems.push(`${table}.${c} on id=${r.id != null ? r.id : "?"} was not valid JSON — stored as null`);
              return null;
            }
          });
          if (!DRY) await conn.execute(sql, vals);
          wrote++;
        }
        if (!DRY) await conn.commit();
      } catch (e) {
        if (!DRY) await conn.rollback();
        console.error(`\n  ✗ ${table}: ${e.message}`);
        console.error("    Nothing from this table was written. Earlier tables are already in.");
        throw e;
      }
      grandWrote += wrote;
      console.log(`  ✓ ${table}: ${wrote} row${wrote === 1 ? "" : "s"}`);
    }

    /* prove it, rather than assume it */
    if (!DRY) {
      console.log("\n  verifying row counts…");
      let bad = 0;
      for (const table of ORDER) {
        if (!sqliteTables.has(table) || !target.has(table)) continue;
        const a = src.prepare("SELECT COUNT(*) AS n FROM " + q(table)).get().n;
        const [[{ n: b }]] = await conn.query("SELECT COUNT(*) AS n FROM " + q(table));
        if (a !== Number(b)) { console.log(`  ✗ ${table}: sqlite ${a} vs mysql ${b}`); bad++; }
      }
      console.log(bad ? `  ${bad} table(s) DISAGREE` : "  every table matches");
    }

    console.log(`\n  read ${grandRead} rows, wrote ${grandWrote}${DRY ? " (dry run)" : ""}`);
    if (problems.length) {
      console.log("\n  things worth knowing:");
      for (const p of problems) console.log("   · " + p);
    }
  } finally {
    src.close();
    await conn.end();
  }
}

main().catch((e) => { console.error("\nMigration failed: " + (e && e.message)); process.exit(1); });
