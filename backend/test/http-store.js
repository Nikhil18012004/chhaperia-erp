/* ============================================================
   CHHAPERIA ERP — the read-only store feed (GET /api/store)

   The floor and the lab see the WHOLE store — every material,
   store and movement — but never a cost, a price or a value, and
   they can change none of it. This checks the feed against a
   scratch database: who may read it, what is in it, and that no
   money leaks into it.

     node backend/test/http-store.js
   ============================================================ */
"use strict";
const os = require("os");

const SCRATCH = "chh_http_store_" + process.pid + "_" + Date.now();
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
const MONEY = /^(cost|price|value|avgCost|rate|amount|total|margin|landed|mrp)$/i;
const moneyKeys = (rows) => {
  const seen = new Set();
  (rows || []).forEach((r) => Object.keys(r || {}).forEach((k) => { if (MONEY.test(k)) seen.add(k); }));
  return [...seen];
};

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
  const login = async (u, p) => (await call("POST", "/auth/login", null, { username: u, password: p })).d.token;
  const A = await login("admin", "admin@123");
  const S = await login("coating1", "coating1@123");
  const L = await login("lab", "lab@123");
  ok("admin, a supervisor and the lab incharge log in", !!(A && S && L));

  section("Who may read the store");
  ok("no token → 401", (await call("GET", "/store")).status === 401);
  const sup = await call("GET", "/store", S);
  ok("a supervisor reads it (200)", sup.status === 200 && sup.d.role === "supervisor", sup.status);
  const lab = await call("GET", "/store", L);
  ok("the lab incharge reads it (200)", lab.status === 200 && lab.d.role === "lab", lab.status);
  ok("so does the admin", (await call("GET", "/store", A)).status === 200);

  section("What is in it — the whole store");
  const full = (await call("GET", "/state", A)).d;
  const active = (full.items || []).filter((i) => i.active !== false);
  ok("every active material is there, not the area's slice", sup.d.items.length === active.length, sup.d.items.length + " vs " + active.length);
  ok("every warehouse is there", sup.d.warehouses.length === (full.warehouses || []).length);
  ok("every movement is there", sup.d.movements.length === (full.movements || []).length, sup.d.movements.length + " vs " + (full.movements || []).length);
  const it = sup.d.items.find((i) => Object.keys(i.stock || {}).length) || sup.d.items[0];
  ok("a material carries its on-hand and where it sits", !!it && typeof it.onHand === "number" && typeof it.stock === "object", J(it));
  const sumWh = it ? Object.values(it.stock).reduce((s, q) => s + q, 0) : 0;
  ok("…and the stores add up to the on-hand (within rounding)", !!it && Math.abs(sumWh - it.onHand) < 0.05 * Math.max(1, Object.keys(it.stock).length), sumWh + " vs " + (it && it.onHand));
  const mv = sup.d.movements[0];
  ok("a movement is date, type, material, quantity, store, reference, who",
    !!mv && ["id", "date", "type", "itemId", "qty", "wh", "ref", "by"].every((k) => k in mv), J(mv));

  section("No money, anywhere in it");
  ok("no money field on any material", moneyKeys(sup.d.items).length === 0, J(moneyKeys(sup.d.items)));
  ok("no money field on any movement", moneyKeys(sup.d.movements).length === 0, J(moneyKeys(sup.d.movements)));
  ok("no money field on any warehouse", moneyKeys(sup.d.warehouses).length === 0);
  ok("the payload names no customer or supplier", !("customers" in sup.d) && !("suppliers" in sup.d) && !("salesorders" in sup.d) && !("purchaseorders" in sup.d));

  section("Still view only");
  ok("a supervisor still cannot post a movement (403)",
    (await call("POST", "/movements", S, { itemId: it && it.id, type: "ADJ", qty: 1, wh: (sup.d.warehouses[0] || {}).id })).status === 403);
  ok("…nor create a material (403)", (await call("POST", "/items", S, { id: "RM-X", name: "x", cat: "RM" })).status === 403);
  ok("the lab incharge cannot post a movement either (403)",
    (await call("POST", "/movements", L, { itemId: it && it.id, type: "ADJ", qty: 1 })).status === 403);
  const board = (await call("GET", "/state", S)).d;
  ok("the supervisor's board payload is unchanged — no store movements or items in it",
    !("movements" in board) && !("items" in board), Object.keys(board).join(","));
  ok("…and still money-free", !/"(price|cost|value|avgCost)"\s*:/.test(JSON.stringify(board)));
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
