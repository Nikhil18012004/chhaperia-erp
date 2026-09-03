/* ============================================================
   CHHAPERIA ERP — project-scoped configuration

   WHY THIS FILE EXISTS

   Every setting this application has arrives through the
   environment, and the environment is the one thing on a machine
   that is NOT per-project. A shell profile, a systemd drop-in or
   a Windows "user variable" set for some other program is visible
   here too, so a stray DATABASE_URL belonging to a different app
   used to be enough to point this ERP's schema loader at that
   app's database. Nothing about this codebase noticed: the
   credentials were valid, the connection opened, and CREATE TABLE
   ran wherever it landed.

   So configuration for THIS project lives in THIS project: a
   `.env` beside the repository root, read here, before any module
   has looked at process.env. What the operating system already
   set still wins — a deploy that exports CHHAPERIA_DB_PASSWORD is
   not overruled by a file someone forgot to delete — the file only
   fills in what is missing.

   Load it FIRST. `require("./env")` is the first line of the
   server and the first line of the database connection module, so
   anything reaching either of them (tools, tests, the CLI seeder)
   gets the same configuration the server would have read.
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const ENV_FILE = process.env.CHHAPERIA_ENV_FILE || path.join(ROOT, ".env");

/* A minimal KEY=VALUE reader. No dependency: this runs before anything
   is installed on a fresh machine, and a config parser is not worth a
   supply chain. Understood: blank lines, `#` comments, `export KEY=…`,
   and single- or double-quoted values (quotes stripped, \n honoured
   inside double quotes only). Anything else is taken literally. */
function parse(text) {
  const out = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).replace(/^export\s+/, "").trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let val = line.slice(eq + 1).trim();
    if (val.length > 1 && val[0] === '"' && val.endsWith('"'))
      val = val.slice(1, -1).replace(/\\n/g, "\n");
    else if (val.length > 1 && val[0] === "'" && val.endsWith("'"))
      val = val.slice(1, -1);
    out[key] = val;
  }
  return out;
}

let loadedFrom = null;
function load() {
  if (loadedFrom !== null) return loadedFrom;
  loadedFrom = "";
  let text = null;
  try { text = fs.readFileSync(ENV_FILE, "utf8"); } catch { return loadedFrom; }
  const vars = parse(text);
  let applied = 0;
  for (const [k, v] of Object.entries(vars)) {
    if (process.env[k] === undefined) { process.env[k] = v; applied++; }
  }
  loadedFrom = ENV_FILE;
  console.log("[env] read " + applied + " setting(s) from " + ENV_FILE +
    " (anything already in the environment was left alone)");
  return loadedFrom;
}

load();

/* The application's own data DIRECTORY on disk — every file this project
   writes goes under it, and it defaults INSIDE the project. Overriding it
   is deliberate (the container image points it at a mounted volume); what
   it must never become is a shared location like the system temp folder,
   where this project's CSVs would sit among other programs' files. */
const DATA_DIR = process.env.CHHAPERIA_DATA_DIR || path.join(ROOT, "data");
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch { /* best effort */ }

module.exports = { ROOT, DATA_DIR, ENV_FILE, loadedFrom: () => loadedFrom };
