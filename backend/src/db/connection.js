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

function getDb() {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(DB_FILE);
  db.pragma("journal_mode = WAL");
  const schema = fs.readFileSync(SCHEMA_FILE, "utf8");
  db.exec(schema);
  return db;
}

function closeDb() {
  if (db) { db.close(); db = null; }
}

module.exports = { getDb, closeDb, DB_FILE, DATA_DIR };
