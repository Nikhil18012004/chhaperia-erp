/* ============================================================
   CHHAPERIA ERP — DATABASE LAYER · connection (MySQL 8.4)

   Owns the physical connection pool. Nothing above the database
   layer should require 'mysql2' directly.

   WHAT REPLACING SQLITE CHANGED, AND WHAT IT DEMANDS

   SQLite was a file and a synchronous handle: db.prepare(...).get()
   returned a row, right then, on the calling stack. MySQL is a
   server on a socket, so every statement is a promise and every
   caller of one is async. That is not a detail of this file — it
   is the reason repository.js, the services and the routes are all
   async now.

   THE ONE THING THAT CAN GO WRONG QUIETLY

   A pool hands out a DIFFERENT connection per query. A transaction
   lives on ONE connection. So `BEGIN` on a pooled connection and
   then a query taken from the pool are not in the same transaction
   — the write escapes it, commits on its own, and no error is ever
   raised. better-sqlite3's db.transaction() could not have this
   bug; here it is the default outcome unless prevented.

   It is prevented by never exposing a bare query function. Every
   repository call takes an EXECUTOR — `x` — and inside withTx()
   that executor is bound to the transaction's own connection.
   Code that forgets to thread it through does not silently escape
   the transaction; it uses the pool executor, which is the same
   mistake but at least the only shape it can take, and the
   repository passes `x` down every path that writes.
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");

const ROOT = path.join(__dirname, "..", "..", "..");
const SCHEMA_FILE = path.join(ROOT, "database", "schema.mysql.sql");

/* The application's own data DIRECTORY on disk. Nothing to do with the
   database any more — the rows live in MySQL — but BarTender's hand-off CSVs
   are still files, and this is where they go. It stayed in this module
   because that is where everything already imports it from. */
const DATA_DIR = process.env.CHHAPERIA_DATA_DIR || path.join(ROOT, "data");
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch { /* best effort */ }

/* ---- configuration: environment only, never a literal ----
   A connection string wins if one is given (managed providers hand
   you one); otherwise the parts. There is no default password and
   there is no default that reaches a remote host: an unconfigured
   install talks to localhost or it does not start. */
function readConfig() {
  const url = process.env.CHHAPERIA_DB_URL || process.env.DATABASE_URL || "";
  if (url) {
    let u;
    try { u = new URL(url); } catch {
      throw new Error("CHHAPERIA_DB_URL is not a valid URL");
    }
    return {
      host: decodeURIComponent(u.hostname || "127.0.0.1"),
      port: +(u.port || 3306),
      user: decodeURIComponent(u.username || ""),
      password: decodeURIComponent(u.password || ""),
      database: decodeURIComponent((u.pathname || "").replace(/^\//, "")) || "chhaperia_erp",
      /* Managed MySQL is remote by definition, so TLS is assumed on
         unless the URL explicitly says otherwise. */
      ssl: u.searchParams.get("ssl") !== "false",
    };
  }
  return {
    host: process.env.CHHAPERIA_DB_HOST || "127.0.0.1",
    port: +(process.env.CHHAPERIA_DB_PORT || 3306),
    user: process.env.CHHAPERIA_DB_USER || "",
    password: process.env.CHHAPERIA_DB_PASSWORD || "",
    database: process.env.CHHAPERIA_DB_NAME || "chhaperia_erp",
    ssl: /^(1|true|yes|required)$/i.test(process.env.CHHAPERIA_DB_SSL || ""),
  };
}

/* TLS material, when asked for. rejectUnauthorized stays TRUE: an
   encrypted channel to a server you have not authenticated is a
   channel to whoever answered, which for a database holding the
   company's ledger is not a trade worth making. A private CA is
   supplied by path rather than pasted into an env var. */
function sslOptions(cfg) {
  if (!cfg.ssl) return undefined;
  const caPath = process.env.CHHAPERIA_DB_SSL_CA || "";
  const opts = { minVersion: "TLSv1.2", rejectUnauthorized: true };
  if (caPath) {
    if (!fs.existsSync(caPath))
      throw new Error("CHHAPERIA_DB_SSL_CA points at no file: " + caPath);
    opts.ca = fs.readFileSync(caPath, "utf8");
  }
  return opts;
}

let pool = null;
let ready = null;

/* ---- refuse to run misconfigured in production ----
   The SQLite build could always fall back to a file it created
   itself. A database server cannot be conjured, and a production
   process that starts without credentials only fails later, under
   load, in front of somebody. It fails here instead. */
function assertConfig(cfg) {
  const prod = process.env.NODE_ENV === "production";
  if (!cfg.user)
    throw new Error("CHHAPERIA_DB_USER is not set — the database needs an account to connect as.");
  if (prod && !cfg.password)
    throw new Error("Refusing to start in production with an empty database password. Set CHHAPERIA_DB_PASSWORD.");
  if (prod && !cfg.ssl && !/^(127\.0\.0\.1|localhost|::1)$/i.test(cfg.host))
    throw new Error(
      "Refusing to start in production with an unencrypted connection to a remote database (" +
      cfg.host + "). Set CHHAPERIA_DB_SSL=true, or point at localhost.");
}

function poolOptions(cfg) {
  return {
    host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password,
    database: cfg.database,
    ssl: sslOptions(cfg),
    waitForConnections: true,
    connectionLimit: +(process.env.CHHAPERIA_DB_POOL || 10),
    maxIdle: +(process.env.CHHAPERIA_DB_POOL || 10),
    idleTimeout: 60000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
    /* ⚠ multipleStatements STAYS OFF. With it on, a single injected
       semicolon turns any one query into two, which is the whole
       difference between a bad parameter and a compromised database.
       Every statement in this codebase is parameterised, and the
       schema is applied one statement at a time precisely so this
       never has to be turned on. */
    multipleStatements: false,
    /* The repository binds most statements by NAME (:id, :doc) and the rest
       positionally (?). mysql2 rewrites the named form to positional before
       it ever reaches the server, so both are parameterised the same way —
       no value is ever pasted into SQL text. */
    namedPlaceholders: true,
    /* The schema stores every date as an ISO string; this keeps any
       DATE/DATETIME that appears later from arriving as a JS Date
       and quietly changing shape on the way to the client. */
    dateStrings: true,
    /* ⚠ NOT utf8mb4_0900_as_cs here. The MySQL handshake carries the
       collation as a single byte, and 0900_as_cs is number 278 — the driver
       cannot even SAY it at connect time (it throws ERR_OUT_OF_RANGE trying).
       So the handshake is plain utf8mb4 and the session collation is set by
       the first statement on every fresh connection, just below. Column
       comparisons never depended on this — each column carries its own
       collation — it only aligns string literals with them. */
    charset: "utf8mb4",
    timezone: "Z",
  };
}

/* Applying the schema: split on statement boundaries and send them
   one at a time, because multipleStatements is off and staying off.
   Line comments go first so a `--` never swallows a delimiter.

   The comment pattern must not be anchored with `$`: a CRLF checkout
   (git's core.autocrlf on Windows) leaves a \r that `.` will not cross
   and `$` will not sit before, so an anchored match fails and EVERY
   comment survives — comment prose then splits on its own semicolons
   and no statement parses. Unanchored, `.` stops at the \r by itself. */
function splitStatements(sql) {
  return sql
    .split(/\r?\n/)
    .map((l) => l.replace(/--.*/, ""))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

/* ---- lightweight migrations -------------------------------
   schema.mysql.sql is CREATE TABLE IF NOT EXISTS, which will not add
   a column to a table that already exists. Anything that changes an
   EXISTING table is applied here, idempotently, on every boot — the
   same contract the SQLite build had, asking INFORMATION_SCHEMA the
   question PRAGMA table_info used to answer. */
async function migrate(conn, database) {
  const hasCol = async (table, col) => {
    const [rows] = await conn.query(
      "SELECT 1 FROM information_schema.COLUMNS " +
      "WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1",
      [database, table, col]);
    return rows.length > 0;
  };
  const tableExists = async (table) => {
    const [rows] = await conn.query(
      "SELECT 1 FROM information_schema.TABLES " +
      "WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? LIMIT 1", [database, table]);
    return rows.length > 0;
  };

  // alternate approved recipes for one product (different fabric supplier)
  if (await tableExists("boms") && !(await hasCol("boms", "alternates")))
    await conn.query("ALTER TABLE `boms` ADD COLUMN `alternates` JSON NULL");

  /* The chatbot is gone. Dropping its table out of the schema file does
     not remove it from a database that already exists, so it is dropped
     here — but ONLY if it is empty. A database that still holds trained
     Q&A rows keeps them: they are the only copy, and deleting them is
     not this migration's decision to make. */
  if (await tableExists("chatbot_knowledge")) {
    const [[{ c }]] = await conn.query("SELECT COUNT(*) AS c FROM `chatbot_knowledge`");
    if (!c) await conn.query("DROP TABLE `chatbot_knowledge`");
    else console.warn("[migrate] chatbot_knowledge still holds " + c +
      " trained row(s) — left in place. Drop it by hand once they are not wanted.");
  }
}

/* ---- the database may still be waking up ----
   On a development machine MySQL and the app are often started by the same
   script, and MySQL needs a few seconds — longer after an unclean shutdown,
   when InnoDB replays its log before listening. Failing the whole app over
   a race the next second would have won is wrong, so the first connection
   waits for the PORT to answer, up to 30 seconds. Only "nobody listening
   yet" is waited out; a real error (wrong host, auth) still fails fast. */
async function waitForServer(cfg) {
  const net = require("net");
  const deadline = Date.now() + 30000;
  let lastCode = "";
  for (;;) {
    try {
      await new Promise((resolve, reject) => {
        const sock = net.connect({ host: cfg.host, port: cfg.port });
        sock.once("connect", () => { sock.destroy(); resolve(); });
        sock.once("error", reject);
      });
      return;
    } catch (e) {
      lastCode = (e && e.code) || String(e);
      if (lastCode !== "ECONNREFUSED" && lastCode !== "ETIMEDOUT" && lastCode !== "EHOSTUNREACH")
        throw e;
      if (Date.now() > deadline)
        throw new Error("MySQL did not answer on " + cfg.host + ":" + cfg.port +
          " within 30s (" + lastCode + "). Is the database running?");
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

/* ---- one-time start-up ---- */
async function init() {
  if (ready) return ready;
  ready = (async () => {
    const cfg = readConfig();
    assertConfig(cfg);
    await waitForServer(cfg);

    /* The database itself may not exist yet on a fresh machine. This
       connects WITHOUT selecting one to create it. A least-privilege
       production account will not be allowed to, and should not be —
       so being refused here is not an error, it just means somebody
       has already made the database properly. */
    try {
      const boot = await mysql.createConnection({
        host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password,
        ssl: sslOptions(cfg), multipleStatements: false,
      });
      try {
        await boot.query(
          "CREATE DATABASE IF NOT EXISTS `" + cfg.database.replace(/`/g, "``") + "` " +
          "CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs");
      } finally { await boot.end(); }
    } catch (e) {
      /* 1044/1045 = no rights to create it. Anything else is a real
         connection problem and is worth failing on now. */
      if (!/1044|1045|Access denied/i.test(String(e && e.message)))
        throw wrap(e, cfg);
    }

    pool = mysql.createPool(poolOptions(cfg));

    /* Runs FIRST on each raw connection the pool opens: commands on one
       connection execute in the order they were queued, so this SET is
       ahead of whatever query that connection was created to serve. */
    pool.pool.on("connection", (raw) => {
      raw.query("SET collation_connection = utf8mb4_0900_as_cs");
    });

    const conn = await pool.getConnection();
    try {
      const sql = fs.readFileSync(SCHEMA_FILE, "utf8");
      for (const stmt of splitStatements(sql)) await conn.query(stmt);
      await migrate(conn, cfg.database);
    } finally { conn.release(); }

    return pool;
  })().catch((e) => { ready = null; pool = null; throw e; });
  return ready;
}

function wrap(e, cfg) {
  const where = cfg ? ` (${cfg.host}:${cfg.port})` : "";
  const err = new Error("Database initialisation failed" + where + ": " + (e && e.message));
  err.status = 500;
  return err;
}

/* ---- the executor ----
   `x.all/one/run` is the only way SQL reaches the server. Bound to
   the pool for ordinary work, and to a single connection inside a
   transaction — same shape either way, so repository functions do
   not care which one they were handed. */
function executor(target) {
  return {
    async all(sql, params) { const [rows] = await target.execute(sql, params || []); return rows; },
    async one(sql, params) {
      const [rows] = await target.execute(sql, params || []);
      return rows.length ? rows[0] : undefined;
    },
    /* better-sqlite3 had .pluck(): the first column of the first row, which
       is what a lookup for one scalar wants. This is that. */
    async val(sql, params) {
      const [rows] = await target.execute(sql, params || []);
      if (!rows.length) return undefined;
      const r = rows[0];
      const k = Object.keys(r)[0];
      return k === undefined ? undefined : r[k];
    },
    async run(sql, params) {
      const [res] = await target.execute(sql, params || []);
      return { affectedRows: res.affectedRows, insertId: res.insertId };
    },
  };
}

/* The pool-backed executor, for everything not inside a transaction. */
async function db() {
  const p = await init();
  return executor(p);
}

/* ---- transactions ----
   Hands the callback an executor pinned to ONE connection. Commit on
   return, roll back on throw, release either way. The callback must
   pass the executor it is given to every repository call it makes;
   see the warning at the top of this file for what happens if it
   does not. */
async function withTx(fn) {
  const p = await init();
  const conn = await p.getConnection();
  try {
    await conn.beginTransaction();
    let out;
    try {
      out = await fn(executor(conn));
    } catch (e) {
      await conn.rollback();
      throw e;
    }
    await conn.commit();
    return out;
  } finally {
    conn.release();
  }
}

async function closeDb() {
  if (pool) { const p = pool; pool = null; ready = null; await p.end(); }
}

/* Health: a round trip that proves the socket and the credentials,
   not merely that a pool object was constructed. */
async function ping() {
  const x = await db();
  await x.one("SELECT 1 AS ok");
  return true;
}

module.exports = { init, db, withTx, closeDb, ping, readConfig, DATA_DIR };
