/* ============================================================
   CHHAPERIA ERP — Label Studio templates through the server

   ⚠ WHY THIS IS ITS OWN FILE. The settings whitelist in erpService
   drops keys it does not know about SILENTLY — the save returns 200
   and the work is gone. http.js carries the same checks, but a
   failure anywhere before them aborts that run and they never
   execute; this file asks the one question on its own, in seconds,
   against a scratch database of its own.

     node backend/test/http-labels.js
   ============================================================ */
"use strict";
const os = require("os");

/* the same prefix as http.js: the database account is granted chh_http_* */
const SCRATCH = "chh_http_lbl_" + process.pid + "_" + Date.now();
process.env.CHHAPERIA_DB_NAME = SCRATCH;
process.env.CHHAPERIA_DATA_DIR = os.tmpdir();
process.env.PORT = "0";
process.env.CHHAPERIA_TDS_NOCONVERT = "1";

const { server, ready } = require("../src/server");
const { closeDb } = require("../src/db/connection");

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra ? "  — " + extra : "")); }
}
function section(t) { console.log("\n" + t); }
const J = (x) => JSON.stringify(x);

async function run() {
  await new Promise((resolve) => (server.listening ? resolve() : server.once("listening", resolve)));
  await ready;
  const base = "http://127.0.0.1:" + server.address().port + "/api";
  async function call(method, pathname, token, body) {
    const r = await fetch(base + pathname, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
      body: body == null ? undefined : JSON.stringify(body),
    });
    let d; const txt = await r.text();
    try { d = JSON.parse(txt); } catch { d = txt; }
    return { status: r.status, d };
  }
  const admin = (await call("POST", "/auth/login", null, { username: "admin", password: "admin@123" })).d;
  ok("admin logs in", !!(admin && admin.token));
  const A = admin.token;

  section("Label Studio templates round-trip (settings.labelDocs)");
  const doc = (objects, extra) => Object.assign({ id: "d_test1", name: "Round trip", w: 100, h: 60, objects }, extra || {});
  const put = async (objects, extra) => {
    const r = await call("PATCH", "/settings", A, { labelDocs: [doc(objects, extra)] });
    const list = (r.d && r.d.labelDocs) || [];
    return list[0] || null;
  };
  const obj = (src, extra) => Object.assign({ id: "o_a1", type: "text", x: 5, y: 5, w: 40, h: 8, text: "x", src }, extra || {});

  const d1 = await put([obj({ kind: "fixed" })]);
  ok("a label template comes back at all", !!d1 && d1.name === "Round trip", J(d1 && d1.name));
  const bound = await put([obj({ kind: "field", field: "product.name", def: "PVC Tape" })]);
  ok("an ERP binding survives the save", !!bound && bound.objects[0].src.kind === "field" && bound.objects[0].src.field === "product.name");

  /* Word-style character runs: "PVC Tape" with only "Tape" bold, red and
     set larger — everything a run can carry, in one round trip. */
  const rich = await put([obj({ kind: "fixed" }, { text: "PVC Tape",
    runs: [{ n: 4 }, { n: 4, b: true, i: false, u: true, k: true, v: "sup", c: "#B02A2A", h: "#ffff00", z: 6, f: "hindi" }] })]);
  const rr = rich && rich.objects[0].runs;
  ok("character runs survive the save", Array.isArray(rr) && rr.length === 2, J(rr));
  ok("…with every override intact",
    !!rr && rr[1].n === 4 && rr[1].b === true && rr[1].i === false && rr[1].u === true && rr[1].k === true
    && rr[1].v === "sup" && rr[1].c === "#b02a2a" && rr[1].h === "#ffff00" && rr[1].z === 6 && rr[1].f === "hindi", J(rr && rr[1]));
  const offRuns = await put([obj({ kind: "fixed" }, { text: "PVC Tape", runs: [{ n: 4, b: true }, { n: 3 }] })]);
  ok("runs that do not cover the text are dropped whole", offRuns.objects[0].runs === undefined, J(offRuns.objects[0].runs));
  const junkRuns = await put([obj({ kind: "fixed" }, { text: "PVC Tape",
    runs: [{ n: 8, b: "yes", c: "red", z: 999, f: "wingdings", v: "up", evil: 1 }] })]);
  const jr = junkRuns.objects[0].runs;
  ok("a run keeps only well-formed overrides", !!jr && jr.length === 1 && J(jr[0]) === J({ n: 8 }), J(jr));
  const serialRuns = await put([obj({ kind: "serial" }, { text: "12345678", runs: [{ n: 8, b: true }] })]);
  ok("a serial field cannot carry runs — its characters do not exist until print", serialRuns.objects[0].runs === undefined);
  const plain = await put([obj({ kind: "fixed" }, { text: "PVC Tape" })]);
  ok("a field with no runs comes back with none", plain.objects[0].runs === undefined);

  /* the Hindi face was silently swapped for Arial on save until the server
     learned it existed */
  const hindi = await put([obj({ kind: "fixed" }, { text: "सावधान", font: "hindi" })]);
  ok("the Hindi font survives the save", hindi.objects[0].font === "hindi", hindi.objects[0].font);
  const bogus = await put([obj({ kind: "fixed" }, { text: "x", font: "wingdings" })]);
  ok("a face the studio does not have falls back to Arial", bogus.objects[0].font === "arial", bogus.objects[0].font);
}

run()
  .catch((e) => { fail++; console.log("\n  ✗ UNCAUGHT: " + (e && e.stack ? e.stack : e)); })
  .finally(async () => {
    try { server.close(); } catch {}
    try { await closeDb(); } catch {}
    try {
      const mysql = require("../node_modules/mysql2/promise");
      const cfg = require("../src/db/connection").readConfig();
      const c = await mysql.createConnection({ host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password });
      await c.query("DROP DATABASE IF EXISTS `" + SCRATCH + "`");
      await c.end();
    } catch { /* untidy, not fatal */ }
    console.log("\n" + (fail === 0 ? "PASS" : "FAIL") + " — " + pass + " passed, " + fail + " failed\n");
    process.exit(fail === 0 ? 0 : 1);
  });
