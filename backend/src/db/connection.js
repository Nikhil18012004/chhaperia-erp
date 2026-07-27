/* ============================================================
   CHHAPERIA ERP — DATABASE LAYER · connection
   Owns the physical SQLite handle. Nothing above the database
   layer should require 'better-sqlite3' directly.
   ============================================================ */
"use strict";
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

const ROOT = path.join(__dirname, "..", "..", "..");
const DATA_DIR = process.env.CHHAPERIA_DATA_DIR || path.join(ROOT, "data");
const DB_FILE = process.env.CHHAPERIA_DB_FILE || path.join(DATA_DIR, "chhaperia.db");
const SCHEMA_FILE = path.join(ROOT, "database", "schema.sql");

let db = null;

/* ---- lightweight migrations -------------------------------
   schema.sql uses CREATE TABLE IF NOT EXISTS, which will not add a
   column to a database that already exists. Anything that changes an
   EXISTING table has to be applied here — idempotently, on every boot. */
function migrate(db) {
  const hasCol = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some((r) => r.name === c);
  // alternate approved recipes for one product (different fabric supplier)
  if (!hasCol("boms", "alternates")) db.exec("ALTER TABLE boms ADD COLUMN alternates TEXT");
}

function getDb() {
  if (db) return db;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    db = new Database(DB_FILE);
    db.pragma("journal_mode = WAL");
    const schema = fs.readFileSync(SCHEMA_FILE, "utf8");
    db.exec(schema);
    migrate(db);
  } catch (e) {
    db = null;
    const wrapped = new Error("Database initialisation failed: " + e.message);
    wrapped.status = 500;
    throw wrapped;
  }
  return db;
}

function closeDb() {
  if (db) { db.close(); db = null; }
}

module.exports = { getDb, closeDb, DB_FILE, DATA_DIR };
