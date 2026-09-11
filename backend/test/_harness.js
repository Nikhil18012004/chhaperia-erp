/* ============================================================
   CHHAPERIA ERP — shared harness for the audit suites
   (http-audit-routes.js, http-audit-rules.js)

   Same isolation as http.js: a scratch MySQL database named for the
   run, the real server booted on an ephemeral port, dropped at the
   end. Every assertion is also kept as a record, so a run can write
   a machine-readable result file (AUDIT_OUT=<path>) for the report.
   ============================================================ */
"use strict";
const os = require("os");
const fs = require("fs");
const path = require("path");

module.exports = function harness(prefix) {
  /* the DB user may only create chh_http_% / chh_smoke_% databases */
  const SCRATCH = "chh_http_" + prefix + "_" + process.pid + "_" + Date.now();
  process.env.CHHAPERIA_DB_NAME = SCRATCH;
  process.env.CHHAPERIA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "chh-" + prefix + "-"));
  process.env.PORT = "0";
  process.env.CHHAPERIA_TDS_NOCONVERT = "1";

  const { server, ready, app } = require("../src/server");
  const { closeDb } = require("../src/db/connection");

  let pass = 0, fail = 0, cur = "";
  const results = [];
  function section(t) { cur = t; console.log("\n" + t); }
  function ok(name, cond, extra) {
    const good = !!cond;
    if (good) { pass++; console.log("  ✓ " + name); }
    else { fail++; console.log("  ✗ " + name + (extra !== undefined ? "  — " + extra : "")); }
    results.push({ section: cur, name, ok: good, detail: good ? undefined : (extra === undefined ? "" : String(extra)).slice(0, 600) });
    return good;
  }
  /* a fact worth recording that is neither a pass nor a fail */
  function note(name, detail) {
    console.log("  • " + name + (detail !== undefined ? "  — " + detail : ""));
    results.push({ section: cur, name, ok: null, detail: detail === undefined ? "" : String(detail).slice(0, 600) });
  }

  let base = "";
  async function start() {
    await new Promise((resolve) => (server.listening ? resolve() : server.once("listening", resolve)));
    await ready;
    base = "http://127.0.0.1:" + server.address().port;
    return base;
  }
  /* body === undefined → no body; opts.raw sends a string as-is */
  async function call(method, pathname, token, body, opts) {
    opts = opts || {};
    const headers = Object.assign({ "Content-Type": "application/json" },
      token ? { Authorization: "Bearer " + token } : {}, opts.headers || {});
    const r = await fetch(base + (opts.noApi ? "" : "/api") + pathname, {
      method, headers,
      body: opts.raw != null ? opts.raw : (body === undefined ? undefined : JSON.stringify(body)),
    });
    const txt = await r.text();
    let d; try { d = JSON.parse(txt); } catch { d = txt; }
    return { status: r.status, d, headers: r.headers, text: txt };
  }
  async function login(u, p) {
    const r = await call("POST", "/auth/login", null, { username: u, password: p || u + "@123" });
    return r.d && r.d.token;
  }
  const J = (x) => { try { return JSON.stringify(x); } catch { return String(x); } };

  async function finish(err) {
    if (err) { fail++; console.log("\n  ✗ UNCAUGHT: " + (err && err.stack ? err.stack : err));
      results.push({ section: cur, name: "UNCAUGHT", ok: false, detail: String(err && err.stack || err).slice(0, 1200) }); }
    try { server.close(); } catch {}
    try { await closeDb(); } catch {}
    try {
      const mysql = require("../node_modules/mysql2/promise");
      const cfg = require("../src/db/connection").readConfig();
      const c = await mysql.createConnection({ host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password });
      await c.query("DROP DATABASE IF EXISTS `" + SCRATCH + "`");
      await c.end();
    } catch { /* untidy, not fatal */ }
    try { fs.rmSync(process.env.CHHAPERIA_DATA_DIR, { recursive: true, force: true }); } catch {}
    if (process.env.AUDIT_OUT) {
      try { fs.writeFileSync(process.env.AUDIT_OUT, JSON.stringify({ suite: prefix, pass, fail, results }, null, 1)); } catch {}
    }
    console.log("\n" + (fail === 0 ? "PASS" : "FAIL") + " — " + pass + " passed, " + fail + " failed\n");
    process.exit(fail === 0 ? 0 : 1);
  }

  return { SCRATCH, app, server, start, call, login, ok, note, section, finish, J,
    get base() { return base; }, get pass() { return pass; }, get fail() { return fail; } };
};
