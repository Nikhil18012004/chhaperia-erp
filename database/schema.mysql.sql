-- ============================================================
--  CHHAPERIA ERP — DATABASE SCHEMA (MySQL 8.4 LTS)
--
--  Translated from database/schema.sql (SQLite). Same tables,
--  same columns, same meaning. Owned by the DATABASE layer; the
--  backend talks to it only through repository.js (DAO).
--
--  WHAT CHANGED IN THE CROSSING, AND WHY
--
--  · EVERY IDENTIFIER IS BACKQUOTED. `lines` and `lead` are both
--    RESERVED WORDS in MySQL 8 (LOAD DATA … LINES, and the LEAD()
--    window function). Unquoted, boms.lines and items.lead are a
--    syntax error. Quoting all of them means no future column can
--    collide with a keyword MySQL adds later.
--
--  · TEXT PRIMARY KEY -> VARCHAR(100). MySQL cannot index a TEXT
--    column without a prefix length. Every id in this system is a
--    short code — IT-001, TR-001, GRN/26-27/0001, EMP-0001:2026-08-18
--    — so 100 characters is generous. utf8mb4 makes that 400 bytes,
--    well inside InnoDB's 3072-byte key limit. Foreign keys must
--    declare the SAME type as the key they point at, so the
--    referencing columns are VARCHAR(100) too.
--
--  · CREATE INDEX IF NOT EXISTS does not exist in MySQL. Indexes
--    are declared INSIDE the CREATE TABLE instead, which makes them
--    idempotent for free: CREATE TABLE IF NOT EXISTS either builds
--    the table with its indexes or does nothing at all. Re-running
--    this file on a live database is a no-op, which is what boot
--    depends on.
--
--  · doc/lines/alternates -> JSON, not TEXT. These columns always
--    held JSON; SQLite simply had nowhere to say so. MySQL validates
--    on write, so a malformed document is now rejected at the door
--    rather than discovered by JSON.parse three screens later.
--
--  · COLLATE utf8mb4_0900_as_cs — accent-sensitive, CASE-SENSITIVE.
--    This is deliberate and load-bearing. SQLite compares text as
--    BINARY, so 'IT-001' and 'it-001' were two different items and
--    'Admin' and 'admin' were two different logins. MySQL's default
--    (utf8mb4_0900_ai_ci) is case-INSENSITIVE, which would silently
--    merge them: two ids that used to coexist would collide on the
--    primary key, and a login would start matching the wrong case.
--    _as_cs keeps the old behaviour exactly.
--
--  · Dates stay strings. Every date in this system is written and
--    read as an ISO string (YYYY-MM-DD, or a full timestamp on
--    punches). Converting them to DATE/DATETIME here would be a
--    second migration hiding inside this one, with its own timezone
--    questions. They are VARCHAR, they sort correctly because ISO
--    sorts lexicographically, and they can be promoted later on
--    their own terms.
--
--  · REAL -> DOUBLE, INTEGER -> INT, and the 0/1 flags -> TINYINT(1).
-- ============================================================

-- Single-row org / company profile (stored as a JSON document)
CREATE TABLE IF NOT EXISTS `org` (
  `id`   INT          NOT NULL,
  `doc`  JSON         NOT NULL,        -- name, address, contacts[], …
  PRIMARY KEY (`id`),
  CONSTRAINT `chk_org_single` CHECK (`id` = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- App/UI settings (single row, JSON document)
CREATE TABLE IF NOT EXISTS `settings` (
  `id`   INT          NOT NULL,
  `doc`  JSON         NOT NULL,        -- theme, accent, autoAccent…
  PRIMARY KEY (`id`),
  CONSTRAINT `chk_settings_single` CHECK (`id` = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- Meta (seed timestamp, schema version)
CREATE TABLE IF NOT EXISTS `meta` (
  `k`    VARCHAR(100) NOT NULL,
  `v`    TEXT,
  PRIMARY KEY (`k`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE IF NOT EXISTS `warehouses` (
  `id`   VARCHAR(100) NOT NULL,
  `name` TEXT         NOT NULL,
  `type` VARCHAR(64),
  `city` VARCHAR(128),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE IF NOT EXISTS `categories` (
  `id`   VARCHAR(100) NOT NULL,
  `name` TEXT         NOT NULL,
  `kind` VARCHAR(64),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE IF NOT EXISTS `suppliers` (
  `id`   VARCHAR(100) NOT NULL,
  `doc`  JSON         NOT NULL,        -- full supplier record
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE IF NOT EXISTS `customers` (
  `id`   VARCHAR(100) NOT NULL,
  `doc`  JSON         NOT NULL,        -- full customer record
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- Transport agencies / dispatch providers (logistics vendor master).
CREATE TABLE IF NOT EXISTS `transporters` (
  `id`   VARCHAR(100) NOT NULL,        -- TR-001
  `doc`  JSON         NOT NULL,        -- name,contact,phone,…,vehicleTypes[],routes,…
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- Item master — common columns promoted, the rest kept in doc.
-- NOTE `lead` is quoted: LEAD() is a reserved window function in MySQL 8.
CREATE TABLE IF NOT EXISTS `items` (
  `id`          VARCHAR(100) NOT NULL,
  `name`        TEXT         NOT NULL,
  `cat`         VARCHAR(100),
  `uom`         VARCHAR(32),
  `cost`        DOUBLE       DEFAULT 0,
  `price`       DOUBLE       DEFAULT 0,
  `reorder`     DOUBLE       DEFAULT 0,
  `safety`      DOUBLE       DEFAULT 0,
  `lead`        INT          DEFAULT 7,
  `abc`         VARCHAR(8),
  `hsn`         VARCHAR(32),
  `supplier_id` VARCHAR(100),
  `grp`         VARCHAR(128),
  `doc`         JSON         NOT NULL, -- widthMM[], typeCode, std, flameC, barcode…
  PRIMARY KEY (`id`),
  KEY `idx_items_cat` (`cat`),
  KEY `idx_items_supplier` (`supplier_id`),
  CONSTRAINT `fk_items_cat` FOREIGN KEY (`cat`) REFERENCES `categories` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- Bill of materials — one row per finished good, lines as JSON.
-- NOTE `lines` is quoted: LINES is reserved (LOAD DATA … LINES).
CREATE TABLE IF NOT EXISTS `boms` (
  `item_id`    VARCHAR(100) NOT NULL,
  `yield`      DOUBLE       DEFAULT 1,
  -- Two shapes are accepted (see frontend/js/bomcalc.js):
  --   legacy tuples  [[rawId, perKgOfFG], …]
  --   rich objects   [{id,rm,rmType,rmThk,rmGsm,qty,unit,pickupPct,ranged,options}, …]
  `lines`      JSON         NOT NULL,
  -- [{label, lines}] — alternate approved recipes for the same product,
  -- or NULL when there is only one.
  `alternates` JSON         NULL,
  PRIMARY KEY (`item_id`),
  CONSTRAINT `fk_boms_item` FOREIGN KEY (`item_id`) REFERENCES `items` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- Stock ledger — every movement (the source of truth for the engine)
CREATE TABLE IF NOT EXISTS `movements` (
  `id`          VARCHAR(100) NOT NULL,
  `date`        VARCHAR(32)  NOT NULL,
  `item_id`     VARCHAR(100) NOT NULL,
  `wh`          VARCHAR(100),
  `type`        VARCHAR(32)  NOT NULL,  -- OPEN|GRN|ISSUE|PROD|SALE|ADJ|RET|SCRAP
  `qty`         DOUBLE       NOT NULL,
  `rate`        DOUBLE       DEFAULT 0,
  `ref`         VARCHAR(191),
  `note`        TEXT,
  `by_who`      VARCHAR(128),
  `supplier_id` VARCHAR(100),
  PRIMARY KEY (`id`),
  KEY `idx_mv_item` (`item_id`),
  KEY `idx_mv_date` (`date`),
  KEY `idx_mv_type` (`type`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE IF NOT EXISTS `work_orders` (
  `id`       VARCHAR(100) NOT NULL,
  `date`     VARCHAR(32),
  `item_id`  VARCHAR(100),
  `qty`      DOUBLE,
  `status`   VARCHAR(64),
  `due`      VARCHAR(32),
  `line`     VARCHAR(64),
  `progress` INT,
  `priority` VARCHAR(32),
  `doc`      JSON,                      -- any extra fields
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE IF NOT EXISTS `sales_orders` (
  `id`          VARCHAR(100) NOT NULL,
  `date`        VARCHAR(32),
  `customer_id` VARCHAR(100),
  `status`      VARCHAR(64),
  `promised`    VARCHAR(32),
  `priority`    VARCHAR(32),
  `value`       DOUBLE,
  `lines`       JSON         NOT NULL,  -- order lines
  `doc`         JSON,                   -- dispatchedOn, etc.
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE IF NOT EXISTS `purchase_orders` (
  `id`          VARCHAR(100) NOT NULL,
  `date`        VARCHAR(32),
  `supplier_id` VARCHAR(100),
  `status`      VARCHAR(64),
  `eta`         VARCHAR(32),
  `value`       DOUBLE,
  `lines`       JSON         NOT NULL,  -- order lines
  `doc`         JSON,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- ============================================================
--  CRM — sales pipeline leads / enquiries
-- ============================================================
CREATE TABLE IF NOT EXISTS `leads` (
  `id`             VARCHAR(100) NOT NULL,
  `company`        TEXT         NOT NULL,
  `contact`        VARCHAR(191),
  `stage`          VARCHAR(64),          -- New|Contacted|Sample|Quoted|Won|Lost
  `value`          DOUBLE       DEFAULT 0,
  `owner`          VARCHAR(128),
  `created`        VARCHAR(40),
  `next_follow_up` VARCHAR(32),
  `customer_id`    VARCHAR(100),
  `doc`            JSON         NOT NULL, -- phone,email,city,…,activities[]
  PRIMARY KEY (`id`),
  KEY `idx_leads_stage` (`stage`),
  KEY `idx_leads_follow` (`next_follow_up`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- ============================================================
--  APPOINTMENTS — the only DIARY entries the calendar stores.
--  Everything else it shows is a date already living on its own
--  record, derived and never stored twice.
-- ============================================================
CREATE TABLE IF NOT EXISTS `appointments` (
  `id`   VARCHAR(100) NOT NULL,          -- AP-0001
  `date` VARCHAR(32),                    -- ISO yyyy-mm-dd
  `doc`  JSON         NOT NULL,          -- title,kind,time,…,done,created
  PRIMARY KEY (`id`),
  KEY `idx_appt_date` (`date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- ============================================================
--  COMPLAINTS — a customer's problem tied to the batch it came from.
--  Before this a complaint was a phone call somebody remembered. The
--  batch (work order) is promoted so "who else received this batch"
--  is one indexed query, and the sales-order lines carry the same
--  batch number, so the spread across customers is derived, never
--  stored twice.
-- ============================================================
CREATE TABLE IF NOT EXISTS `complaints` (
  `id`          VARCHAR(100) NOT NULL,   -- CMP-0001
  `customer_id` VARCHAR(100),
  `batch`       VARCHAR(100),            -- WO-0288 — the run being complained about
  `status`      VARCHAR(32),             -- Open | Investigating | Resolved | Rejected
  `raised`      VARCHAR(32),             -- ISO yyyy-mm-dd
  `doc`         JSON         NOT NULL,   -- salesOrderId,itemId,claim,raisedBy,via,resolution,…
  PRIMARY KEY (`id`),
  KEY `idx_cmp_customer` (`customer_id`),
  KEY `idx_cmp_batch` (`batch`),
  KEY `idx_cmp_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- ============================================================
--  QUOTATIONS — what was offered, to whom, and what it became.
--  A quote used to be a number typed onto a lead. The document
--  itself lives here now: its lines, its money (worked out by the
--  server from gst.js, never by the client), every earlier
--  revision, and the sales order it turned into. Customer, lead,
--  status and the two dates are promoted so "open quotes for this
--  customer" and "what expires this week" are indexed queries.
-- ============================================================
CREATE TABLE IF NOT EXISTS `quotations` (
  `id`          VARCHAR(100) NOT NULL,   -- QTN-0001
  `customer_id` VARCHAR(100),
  `lead_id`     VARCHAR(100),            -- LD-0012 — the enquiry it answers, if any
  `item_id`     VARCHAR(100),            -- the ONE product the price is for
  `status`      VARCHAR(32),             -- Open | Won | Lost
  `date`        VARCHAR(32),             -- ISO yyyy-mm-dd, the day the first price went out
  `doc`         JSON         NOT NULL,   -- uom,qty,price,value,rounds,history[],finalPrice,counterPrice,lostReason,…
  PRIMARY KEY (`id`),
  KEY `idx_qtn_customer` (`customer_id`),
  KEY `idx_qtn_lead` (`lead_id`),
  KEY `idx_qtn_item` (`item_id`),
  KEY `idx_qtn_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- ============================================================
--  USERS — authentication & role-based access control.
--  Passwords are scrypt 'saltHex:hashHex' — never plaintext.
--  `username` is UNIQUE under a CASE-SENSITIVE collation, exactly
--  as it was under SQLite's BINARY comparison.
-- ============================================================
CREATE TABLE IF NOT EXISTS `users` (
  `id`         VARCHAR(100) NOT NULL,
  `username`   VARCHAR(100) NOT NULL,
  `name`       VARCHAR(191),
  `role`       VARCHAR(32)  NOT NULL,    -- admin | office | supervisor
  `area`       VARCHAR(64),              -- coating|slitting|fiberglass
  `pass`       VARCHAR(255) NOT NULL,    -- scrypt 'saltHex:hashHex'
  `active`     TINYINT(1)   DEFAULT 1,
  `created`    VARCHAR(40),
  `last_login` VARCHAR(40),
  `doc`        JSON,                     -- phone, notes, etc.
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_users_username` (`username`),
  KEY `idx_users_role` (`role`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- ============================================================
--  HUMAN RESOURCES — workers, biometric attendance, leave, payroll
-- ============================================================
CREATE TABLE IF NOT EXISTS `hr_workers` (
  `id`          VARCHAR(100) NOT NULL,   -- EMP-0001
  `name`        TEXT         NOT NULL,
  `dept`        VARCHAR(64),
  `designation` VARCHAR(128),
  `pay_type`    VARCHAR(32)  DEFAULT 'monthly',
  `daily_rate`  DOUBLE       DEFAULT 0,
  `monthly_ctc` DOUBLE       DEFAULT 0,
  `device_uid`  VARCHAR(100),
  `active`      TINYINT(1)   DEFAULT 1,
  `joined`      VARCHAR(32),
  `doc`         JSON         NOT NULL,   -- phone,…,bank{},leaveBalances{},photo…
  PRIMARY KEY (`id`),
  KEY `idx_hrw_dept` (`dept`),
  KEY `idx_hrw_device` (`device_uid`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- Raw biometric punches (source of truth for attendance). Append-only.
CREATE TABLE IF NOT EXISTS `hr_punches` (
  `id`         VARCHAR(100) NOT NULL,
  `worker_id`  VARCHAR(100),             -- nullable if the device id is unknown
  `device_uid` VARCHAR(100),
  `ts`         VARCHAR(40)  NOT NULL,    -- ISO timestamp
  `direction`  VARCHAR(16),              -- in | out | auto
  `device_id`  VARCHAR(100),
  `source`     VARCHAR(32)  DEFAULT 'device',
  PRIMARY KEY (`id`),
  KEY `idx_hrp_worker` (`worker_id`),
  KEY `idx_hrp_ts` (`ts`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- Daily muster — one derived row per worker per day.
CREATE TABLE IF NOT EXISTS `hr_attendance` (
  `id`        VARCHAR(100) NOT NULL,     -- <worker_id>:<date>
  `worker_id` VARCHAR(100) NOT NULL,
  `date`      VARCHAR(32)  NOT NULL,
  `status`    VARCHAR(8),                -- P | A | HD | WO | L
  `in_time`   VARCHAR(16),
  `out_time`  VARCHAR(16),
  `hours`     DOUBLE       DEFAULT 0,
  `ot_hours`  DOUBLE       DEFAULT 0,
  `note`      TEXT,
  `source`    VARCHAR(32)  DEFAULT 'device',
  PRIMARY KEY (`id`),
  KEY `idx_hra_worker` (`worker_id`),
  KEY `idx_hra_date` (`date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- Configurable leave types (admin-defined: quota + accrual rule).
CREATE TABLE IF NOT EXISTS `hr_leave_types` (
  `id`      VARCHAR(100) NOT NULL,       -- EL | CL | SL | any custom code
  `name`    TEXT         NOT NULL,
  `quota`   DOUBLE       DEFAULT 0,
  `accrual` VARCHAR(32)  DEFAULT 'fixed',
  `paid`    TINYINT(1)   DEFAULT 1,
  `color`   VARCHAR(32),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- Leave applications / ledger.
CREATE TABLE IF NOT EXISTS `hr_leaves` (
  `id`         VARCHAR(100) NOT NULL,    -- LV-0001
  `worker_id`  VARCHAR(100) NOT NULL,
  `type`       VARCHAR(100) NOT NULL,    -- hr_leave_types.id
  `from_date`  VARCHAR(32)  NOT NULL,
  `to_date`    VARCHAR(32)  NOT NULL,
  `days`       DOUBLE       DEFAULT 0,
  `status`     VARCHAR(32)  DEFAULT 'Pending',
  `reason`     TEXT,
  `applied_on` VARCHAR(40),
  `decided_by` VARCHAR(128),
  PRIMARY KEY (`id`),
  KEY `idx_hrl_worker` (`worker_id`),
  KEY `idx_hrl_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- Monthly payroll runs + their payslips (per-worker computed lines).
CREATE TABLE IF NOT EXISTS `hr_payruns` (
  `id`           VARCHAR(100) NOT NULL,  -- PR-2026-07
  `period`       VARCHAR(16)  NOT NULL,  -- YYYY-MM
  `status`       VARCHAR(32)  DEFAULT 'Draft',
  `generated_at` VARCHAR(40),
  `doc`          JSON,                   -- totals snapshot + config used
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE IF NOT EXISTS `hr_payslips` (
  `id`        VARCHAR(100) NOT NULL,     -- <payrun_id>:<worker_id>
  `payrun_id` VARCHAR(100) NOT NULL,
  `worker_id` VARCHAR(100) NOT NULL,
  `doc`       JSON         NOT NULL,     -- daysPresent,otHours,gross,…,net
  PRIMARY KEY (`id`),
  KEY `idx_hrps_run` (`payrun_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- ============================================================
--  LAB REPORTS — QC test certificates for finished goods.
--  `spec` inside lab_products.doc is BACKEND-ONLY and never sent
--  to the data-entry form; grading happens on the server.
-- ============================================================
CREATE TABLE IF NOT EXISTS `lab_products` (
  `id`  VARCHAR(100) NOT NULL,           -- LP-001
  `doc` JSON         NOT NULL,           -- name,code,…,flags{},refMode,spec{},active
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE IF NOT EXISTS `lab_reports` (
  `id`  VARCHAR(100) NOT NULL,           -- LR-0001
  `doc` JSON         NOT NULL,           -- productId,…,values{},results{},result
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- ============================================================
--  GOODS RECEIPT NOTES — one numbered document per receipt event.
--  Lines are FROZEN at receipt; deleting the PO cancels the note
--  instead of erasing it — a numbered document must never vanish.
-- ============================================================
CREATE TABLE IF NOT EXISTS `grns` (
  `id`  VARCHAR(100) NOT NULL,           -- GRN/26-27/0001
  `doc` JSON         NOT NULL,           -- date,poId,…,status,lines[]
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- ============================================================
--  INCOMING-MATERIAL TEST REPORTS ("GRN testing")
--  Graded on the server against the material's hidden qcSpec, so
--  the person measuring can read neither the limits nor the verdict.
-- ============================================================
CREATE TABLE IF NOT EXISTS `grn_tests` (
  `id`      VARCHAR(100) NOT NULL,       -- GT-0001
  `grn_id`  VARCHAR(100) NOT NULL,       -- GRN/26-27/0001
  `item_id` VARCHAR(100) NOT NULL,
  `doc`     JSON         NOT NULL,       -- poId,…,values{},results{},result
  PRIMARY KEY (`id`),
  KEY `idx_grn_tests_grn` (`grn_id`),
  KEY `idx_grn_tests_item` (`item_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- The approval queue: what the lab incharge proposed for the catalogue (a new
-- item with its test parameters and recipe, or a recipe on its own) and what
-- the admin ruled. Applied through the same code path as a direct entry.
CREATE TABLE IF NOT EXISTS `approvals` (
  `id`  VARCHAR(100) NOT NULL,           -- AP-0001
  `doc` JSON         NOT NULL,           -- kind,payload{},summary,status,by,at,decidedBy,decidedAt,note,result
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
