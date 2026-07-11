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

-- Transport agencies / dispatch providers (logistics vendor master).
CREATE TABLE IF NOT EXISTS transporters (
  id        TEXT PRIMARY KEY,          -- TR-001
  doc       TEXT NOT NULL              -- JSON: name,contact,phone,email,city,state,
                                       --       gstin,pan,vehicleTypes[],routes,rateBasis,
                                       --       baseRate,onTime,rating,owner,terms,active,notes
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

-- ============================================================
--  CRM — sales pipeline leads / enquiries
--  Each lead carries its follow-up activities as a JSON array
--  (same document pattern used by order lines), so the whole
--  CRM stays simple and loads/saves with the rest of the state.
-- ============================================================
CREATE TABLE IF NOT EXISTS leads (
  id             TEXT PRIMARY KEY,
  company        TEXT NOT NULL,
  contact        TEXT,
  stage          TEXT,                 -- New|Contacted|Quoted|Won|Lost
  value          REAL DEFAULT 0,       -- estimated deal value (₹)
  owner          TEXT,
  created        TEXT,
  next_follow_up TEXT,                 -- date of next planned follow-up
  customer_id    TEXT,                 -- set when converted/linked to a customer
  doc            TEXT NOT NULL         -- JSON: phone,email,city,product,source,
                                       --       expectedClose,quotedValue,quoteDate,
                                       --       lostReason,notes,activities[]
);
CREATE INDEX IF NOT EXISTS idx_leads_stage ON leads(stage);
CREATE INDEX IF NOT EXISTS idx_leads_follow ON leads(next_follow_up);

-- ============================================================
--  USERS — authentication & role-based access control (RBAC)
--  roles: admin (full + user mgmt) | office (full app, no user
--  mgmt) | supervisor (production only, money-free).
--  'area' scopes a supervisor to a production area:
--  coating | slitting | fiberglass.
--  Passwords are stored as scrypt 'saltHex:hashHex' — never plaintext.
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  username   TEXT UNIQUE NOT NULL,
  name       TEXT,
  role       TEXT NOT NULL,            -- admin | office | supervisor
  area       TEXT,                     -- supervisor scope: coating|slitting|fiberglass
  pass       TEXT NOT NULL,            -- scrypt 'saltHex:hashHex'
  active     INTEGER DEFAULT 1,
  created    TEXT,
  last_login TEXT,
  doc        TEXT                      -- JSON: phone, notes, etc.
);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

-- ============================================================
--  HUMAN RESOURCES — workers/labour master, biometric attendance,
--  leave and payroll. Kept fully configurable (daily-wage base with
--  admin-set overtime multiplier + toggleable PF/ESI/PT deductions;
--  leave types defined by the admin). The biometric device pushes
--  raw punches to /api/hr/punch 24/7; the service derives the daily
--  muster (first-in/last-out, hours, overtime) from them.
-- ============================================================

-- Worker / labour master. Common columns promoted; rest in doc JSON.
CREATE TABLE IF NOT EXISTS hr_workers (
  id          TEXT PRIMARY KEY,        -- EMP-0001
  name        TEXT NOT NULL,
  dept        TEXT,                    -- coating | slitting | fiberglass | packing | admin …
  designation TEXT,
  pay_type    TEXT DEFAULT 'daily',    -- daily | monthly
  daily_rate  REAL DEFAULT 0,          -- ₹ / day (daily-wage base)
  monthly_ctc REAL DEFAULT 0,          -- ₹ / month (monthly-salaried)
  device_uid  TEXT,                    -- biometric device user id (maps punches → worker)
  active      INTEGER DEFAULT 1,
  joined      TEXT,
  doc         TEXT NOT NULL            -- JSON: phone,email,dob,gender,pfNo,esiNo,uan,
                                       --       bank{acc,ifsc,name},address,shift,
                                       --       allowances,leaveBalances{},photo…
);
CREATE INDEX IF NOT EXISTS idx_hrw_dept ON hr_workers(dept);
CREATE INDEX IF NOT EXISTS idx_hrw_device ON hr_workers(device_uid);

-- Raw biometric punches (source of truth for attendance). Append-only.
CREATE TABLE IF NOT EXISTS hr_punches (
  id          TEXT PRIMARY KEY,
  worker_id   TEXT,                    -- resolved from device_uid (nullable if unknown)
  device_uid  TEXT,                    -- raw id as sent by the device
  ts          TEXT NOT NULL,           -- ISO timestamp of the punch
  direction   TEXT,                    -- in | out | auto
  device_id   TEXT,                    -- device serial / location
  source      TEXT DEFAULT 'device'    -- device | manual | sim
);
CREATE INDEX IF NOT EXISTS idx_hrp_worker ON hr_punches(worker_id);
CREATE INDEX IF NOT EXISTS idx_hrp_ts ON hr_punches(ts);

-- Daily muster — one derived row per worker per day.
CREATE TABLE IF NOT EXISTS hr_attendance (
  id         TEXT PRIMARY KEY,         -- <worker_id>:<date>
  worker_id  TEXT NOT NULL,
  date       TEXT NOT NULL,            -- YYYY-MM-DD
  status     TEXT,                     -- P | A | HD | WO | L (present/absent/half/weekoff/leave)
  in_time    TEXT,                     -- HH:MM (first punch)
  out_time   TEXT,                     -- HH:MM (last punch)
  hours      REAL DEFAULT 0,
  ot_hours   REAL DEFAULT 0,
  note       TEXT,
  source     TEXT DEFAULT 'device'     -- device | manual
);
CREATE INDEX IF NOT EXISTS idx_hra_worker ON hr_attendance(worker_id);
CREATE INDEX IF NOT EXISTS idx_hra_date ON hr_attendance(date);

-- Configurable leave types (admin-defined: quota + accrual rule).
CREATE TABLE IF NOT EXISTS hr_leave_types (
  id       TEXT PRIMARY KEY,           -- EL | CL | SL | any custom code
  name     TEXT NOT NULL,
  quota    REAL DEFAULT 0,             -- annual entitlement (days)
  accrual  TEXT DEFAULT 'fixed',       -- fixed (credited yearly) | earned (1/20 worked) | none
  paid     INTEGER DEFAULT 1,
  color    TEXT
);

-- Leave applications / ledger.
CREATE TABLE IF NOT EXISTS hr_leaves (
  id         TEXT PRIMARY KEY,         -- LV-0001
  worker_id  TEXT NOT NULL,
  type       TEXT NOT NULL,            -- hr_leave_types.id
  from_date  TEXT NOT NULL,
  to_date    TEXT NOT NULL,
  days       REAL DEFAULT 0,
  status     TEXT DEFAULT 'Pending',   -- Pending | Approved | Rejected
  reason     TEXT,
  applied_on TEXT,
  decided_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_hrl_worker ON hr_leaves(worker_id);
CREATE INDEX IF NOT EXISTS idx_hrl_status ON hr_leaves(status);

-- Monthly payroll runs + their payslips (per-worker computed lines).
CREATE TABLE IF NOT EXISTS hr_payruns (
  id           TEXT PRIMARY KEY,       -- PR-2026-07
  period       TEXT NOT NULL,          -- YYYY-MM
  status       TEXT DEFAULT 'Draft',   -- Draft | Finalized
  generated_at TEXT,
  doc          TEXT                    -- JSON: totals snapshot + config used
);
CREATE TABLE IF NOT EXISTS hr_payslips (
  id         TEXT PRIMARY KEY,         -- <payrun_id>:<worker_id>
  payrun_id  TEXT NOT NULL,
  worker_id  TEXT NOT NULL,
  doc        TEXT NOT NULL             -- JSON: daysPresent,otHours,gross,deductions{},advances,net…
);
CREATE INDEX IF NOT EXISTS idx_hrps_run ON hr_payslips(payrun_id);

-- ============================================================
--  LAB REPORTS — QC test certificates for finished goods.
--  Own product master (decoupled from `items`, replaced when the
--  real product data file arrives). Each product carries material
--  TYPE flags (mica / waterBlocking / semiConductive) that decide
--  which test parameters apply, a per-product reference mode
--  (batch vs lot/WO number), and a BACKEND-ONLY `spec` map
--  {param:{min,max}} used to grade a report Pass/Fail. Specs are
--  never sent to the data-entry form.
-- ============================================================
CREATE TABLE IF NOT EXISTS lab_products (
  id        TEXT PRIMARY KEY,          -- LP-001
  doc       TEXT NOT NULL              -- JSON: name,code,thickness,series,flags{mica,
                                       --       waterBlocking,semiConductive},refMode,
                                       --       spec{param:{min,max}},active,notes
);

-- One row per submitted lab test report. Pass/Fail is computed on
-- the server against the product's hidden spec and stored here.
CREATE TABLE IF NOT EXISTS lab_reports (
  id        TEXT PRIMARY KEY,          -- LR-0001
  doc       TEXT NOT NULL              -- JSON: productId,productCode,productName,thickness,
                                       --       refMode,refNo,reportDate,flags{},values{param:n},
                                       --       results{param:pass|fail|na|—},result,assignee,
                                       --       testedBy,remarks,createdAt
);

