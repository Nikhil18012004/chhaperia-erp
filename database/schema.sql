-- ============================================================
--  CHHAPERIA ERP — DATABASE SCHEMA (SQLite)
--  Normalised master tables + JSON columns for naturally
--  document-shaped fields (order lines, bom lines, widths…).
--  Owned by the DATABASE layer; the backend talks to it only
--  through repository.js (DAO).
-- ============================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Single-row org / company profile (stored as JSON document)
CREATE TABLE IF NOT EXISTS org (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  doc       TEXT NOT NULL              -- JSON: name, address, contacts[], …
);

-- App/UI settings (single row, JSON document)
CREATE TABLE IF NOT EXISTS settings (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  doc       TEXT NOT NULL              -- JSON: theme, accent, autoAccent…
);

-- Meta (seed timestamp, schema version)
CREATE TABLE IF NOT EXISTS meta (
  k         TEXT PRIMARY KEY,
  v         TEXT
);

CREATE TABLE IF NOT EXISTS warehouses (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  type      TEXT,
  city      TEXT
);

CREATE TABLE IF NOT EXISTS categories (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  kind      TEXT
);

CREATE TABLE IF NOT EXISTS suppliers (
  id        TEXT PRIMARY KEY,
  doc       TEXT NOT NULL              -- JSON: full supplier record
);

CREATE TABLE IF NOT EXISTS customers (
  id        TEXT PRIMARY KEY,
  doc       TEXT NOT NULL              -- JSON: full customer record
);

-- Item master — common columns promoted, the rest kept in doc
CREATE TABLE IF NOT EXISTS items (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  cat         TEXT,
  uom         TEXT,
  cost        REAL DEFAULT 0,
  price       REAL DEFAULT 0,
  reorder     REAL DEFAULT 0,
  safety      REAL DEFAULT 0,
  lead        INTEGER DEFAULT 7,
  abc         TEXT,
  hsn         TEXT,
  supplier_id TEXT,
  grp         TEXT,
  doc         TEXT NOT NULL,           -- JSON: widthMM[], typeCode, std, flameC, barcode…
  FOREIGN KEY (cat) REFERENCES categories(id)
);
CREATE INDEX IF NOT EXISTS idx_items_cat ON items(cat);
CREATE INDEX IF NOT EXISTS idx_items_supplier ON items(supplier_id);

-- Bill of materials — one row per finished good, lines as JSON
CREATE TABLE IF NOT EXISTS boms (
  item_id   TEXT PRIMARY KEY,
  yield     REAL DEFAULT 1,
  lines     TEXT NOT NULL,            -- JSON: [[rawId, perKg], …]
  FOREIGN KEY (item_id) REFERENCES items(id)
);

-- Stock ledger — every movement (the source of truth for the engine)
CREATE TABLE IF NOT EXISTS movements (
  id          TEXT PRIMARY KEY,
  date        TEXT NOT NULL,
  item_id     TEXT NOT NULL,
  wh          TEXT,
  type        TEXT NOT NULL,          -- OPEN|GRN|ISSUE|PROD|SALE|ADJ|RET|SCRAP
  qty         REAL NOT NULL,
  rate        REAL DEFAULT 0,
  ref         TEXT,
  note        TEXT,
  by_who      TEXT,
  supplier_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_mv_item ON movements(item_id);
CREATE INDEX IF NOT EXISTS idx_mv_date ON movements(date);
CREATE INDEX IF NOT EXISTS idx_mv_type ON movements(type);

CREATE TABLE IF NOT EXISTS work_orders (
  id        TEXT PRIMARY KEY,
  date      TEXT,
  item_id   TEXT,
  qty       REAL,
  status    TEXT,
  due       TEXT,
  line      TEXT,
  progress  INTEGER,
  priority  TEXT,
  doc       TEXT                       -- JSON: any extra fields
);

CREATE TABLE IF NOT EXISTS sales_orders (
  id          TEXT PRIMARY KEY,
  date        TEXT,
  customer_id TEXT,
  status      TEXT,
  promised    TEXT,
  priority    TEXT,
  value       REAL,
  lines       TEXT NOT NULL,           -- JSON: order lines
  doc         TEXT                     -- JSON: dispatchedOn, etc.
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id          TEXT PRIMARY KEY,
  date        TEXT,
  supplier_id TEXT,
  status      TEXT,
  eta         TEXT,
  value       REAL,
  lines       TEXT NOT NULL,           -- JSON: order lines
  doc         TEXT
);
