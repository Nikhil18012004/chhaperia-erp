/* ============================================================
   CHHAPERIA ERP — test scratch space

   A test run needs somewhere to put a database and somewhere to
   put files. Both used to be borrowed from the machine: a schema
   created on the configured MySQL server, and os.tmpdir() for the
   files — the system temp folder, shared with every other program
   on the box. Two things went wrong with that. Files this project
   wrote landed among other projects' files, and when a run died
   before its `finally` (a crash, a Ctrl-C, a killed CI job) the
   scratch DATABASE stayed on the server for good; the backlog has
   carried "chh_smoke_… left behind" for weeks.

   So both live here instead:
     • the files under  <repo>/data/_scratch/<run>/   (gitignored)
     • the database named chh_<kind>_<pid>_<epoch-ms>

   and every run sweeps the leavings of dead ones — but ONLY names
   matching that exact pattern, and only when the timestamp inside
   the name is old enough that no live run could own it. A sweeper
   that guesses is worse than the mess it tidies.
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const SCRATCH_ROOT = path.join(ROOT, "data", "_scratch");
const NAME_RE = /^chh_(smoke|http)_\d+_(\d{13})$/;
const STALE_MS = 2 * 60 * 60 * 1000;   // two hours: longer than any run

/* Claim a run's database name and directory. MUST be called before the
   connection module is required — that is what the env vars are for. */
function claim(kind) {
  const name = "chh_" + kind + "_" + process.pid + "_" + Date.now();
  const dir = path.join(SCRATCH_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  process.env.CHHAPERIA_DB_NAME = name;
  process.env.CHHAPERIA_DATA_DIR = dir;
  return { name, dir };
}

function isStale(name, now) {
  const m = NAME_RE.exec(name);
  return !!m && now - Number(m[2]) > STALE_MS;
}

/* Drop this run's database and directory, and sweep any left by runs that
   died. Never throws: an untidy machine must not fail a green test run. */
async function release(run) {
  const now = Date.now();

  try {
    const mysql = require("../node_modules/mysql2/promise");
    const cfg = require("../src/db/connection").readConfig();
    const c = await mysql.createConnection({
      host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password,
    });
    try {
      const doomed = [run && run.name].filter(Boolean);
      const [rows] = await c.query(
        "SELECT SCHEMA_NAME AS s FROM information_schema.SCHEMATA " +
        "WHERE SCHEMA_NAME LIKE 'chh\\_smoke\\_%' OR SCHEMA_NAME LIKE 'chh\\_http\\_%'");
      for (const r of rows) {
        const s = String(r.s);
        if (!doomed.includes(s) && isStale(s, now)) doomed.push(s);
      }
      for (const s of doomed) {
        /* belt and braces: the name is matched again right before it is
           used, so nothing that is not a scratch schema can be dropped. */
        if (!NAME_RE.test(s)) continue;
        await c.query("DROP DATABASE IF EXISTS `" + s + "`");
        if (s !== (run && run.name)) console.log("  · swept stale scratch database " + s);
      }
    } finally { await c.end(); }
  } catch { /* untidy, not fatal */ }

  try { if (run && run.dir) fs.rmSync(run.dir, { recursive: true, force: true }); } catch {}
  try {
    for (const entry of fs.readdirSync(SCRATCH_ROOT)) {
      if (isStale(entry, now)) fs.rmSync(path.join(SCRATCH_ROOT, entry), { recursive: true, force: true });
    }
    fs.rmdirSync(SCRATCH_ROOT);   // only succeeds when nothing is left in it
  } catch { /* other runs are still using it, or it is already gone */ }
}

module.exports = { claim, release, SCRATCH_ROOT };
