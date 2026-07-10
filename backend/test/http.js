/* ============================================================
   CHHAPERIA ERP — HTTP-layer integration tests (no framework)
   Boots the real Express app against a THROWAWAY SQLite file on
   an ephemeral port and drives it over HTTP, so the routes, the
   auth/RBAC middleware, the role-scoped view service and the new
   granular Trade/CRM endpoints are all exercised end-to-end.

     node backend/test/http.js      (or: npm run test:http)
   ============================================================ */
"use strict";
const path = require("path");
const os = require("os");
const fs = require("fs");

// point the DB at a temp file + a test port BEFORE anything loads
const TMP = path.join(os.tmpdir(), "chh-http-" + process.pid + "-" + Date.now() + ".db");
process.env.CHHAPERIA_DB_FILE = TMP;
process.env.CHHAPERIA_DATA_DIR = os.tmpdir();
process.env.PORT = "0"; // ask the OS for a free port

const { server } = require("../src/server");
const { closeDb } = require("../src/db/connection");

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra ? "  — " + extra : "")); }
}
function section(t) { console.log("\n" + t); }

function waitListening() {
  return new Promise((resolve) => {
    if (server.listening) return resolve();
    server.once("listening", resolve);
  });
}

async function run() {
  await waitListening();
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
  const login = async (u, p) => (await call("POST", "/auth/login", null, { username: u, password: p })).d;

  section("Health + auth gate");
  ok("GET /health is public 200", (await call("GET", "/health")).status === 200);
  ok("GET /state without token is 401", (await call("GET", "/state")).status === 401);
  const badLogin = await call("POST", "/auth/login", null, { username: "admin", password: "wrong" });
  ok("bad password is 401", badLogin.status === 401);

  const admin = await login("admin", "admin@123");
  ok("admin login returns a token + user", !!(admin && admin.token && admin.user), JSON.stringify(admin).slice(0, 60));
  const A = admin.token;
  const office = await login("office", "office@123");
  const O = office.token;
  const coating = await login("coating1", "coating1@123");
  const C = coating.token;

  section("Role-based access control");
  ok("admin GET /state 200 with items[]", (await call("GET", "/state", A)).d.items.length > 0);
  ok("admin can list users", (await call("GET", "/auth/users", A)).status === 200);
  ok("office CANNOT list users (403)", (await call("GET", "/auth/users", O)).status === 403);
  ok("office CAN write items (granular)", [200, 201].includes((await call("POST", "/items", O, { id: "RM-HTTP", name: "HTTP RM", cat: "RM", cost: 5 })).status));
  ok("supervisor CANNOT create items (403)", (await call("POST", "/items", C, { id: "RM-X", name: "x", cat: "RM" })).status === 403);
  ok("supervisor CANNOT PUT full state (403)", (await call("PUT", "/state", C, {})).status === 403);
  ok("supervisor CANNOT reset (403)", (await call("POST", "/reset", C)).status === 403);

  section("Supervisor view is money-free + area-scoped (server-enforced)");
  const supState = (await call("GET", "/state", C)).d;
  ok("supervisor role/area echoed", supState.role === "supervisor" && supState.area === "coating");
  ok("supervisor view has NO customers", supState.customers === undefined);
  ok("supervisor view has NO suppliers", supState.suppliers === undefined);
  ok("supervisor view has NO sales orders", supState.salesorders === undefined);
  const supStr = JSON.stringify(supState);
  ok("no price/cost/value fields leak to supervisor", !/"(price|cost|value|avgCost)"\s*:/.test(supStr));
  ok("supervisor sees work orders for their area", Array.isArray(supState.workorders));

  section("Granular Trade endpoints");
  const st = (await call("GET", "/state", A)).d;
  const cust = st.customers[0].id, fg = st.items.find((i) => i.cat === "FG").id, sup = st.suppliers[0].id, rm = st.items.find((i) => i.cat !== "FG").id;
  const so = (await call("POST", "/sales-orders", A, { customerId: cust, lines: [{ itemId: fg, qty: 12, rate: 100 }] })).d;
  ok("create SO 201 with computed value", so.id && so.value === 1200, JSON.stringify(so).slice(0, 60));
  ok("update SO priority", (await call("PATCH", "/sales-orders/" + so.id, A, { priority: "Urgent" })).d.priority === "Urgent");
  const disp = await call("POST", "/sales-orders/" + so.id + "/dispatch", A, {});
  ok("dispatch SO posts a SALE movement", disp.d.posted === 1 && disp.d.so.status === "Dispatched");
  const afterDisp = (await call("GET", "/state", A)).d;
  const saleMv = afterDisp.movements.filter((m) => m.ref === so.id);
  ok("dispatch movement attributed to admin", saleMv.length === 1 && saleMv[0].by === "admin" && saleMv[0].qty === -12);
  await call("DELETE", "/sales-orders/" + so.id, A);
  const afterDel = (await call("GET", "/state", A)).d;
  ok("delete SO reverses its SALE movements", !afterDel.salesorders.find((s) => s.id === so.id) && afterDel.movements.filter((m) => m.ref === so.id).length === 0);

  const po = (await call("POST", "/purchase-orders", A, { supplierId: sup, eta: "2026-08-01", lines: [{ itemId: rm, qty: 100, rate: 20, recd: 0 }] })).d;
  ok("create PO 201", po.id && po.value === 2000);
  ok("delete PO 200", (await call("DELETE", "/purchase-orders/" + po.id, A)).status === 200);

  section("Granular BOM + CRM endpoints");
  const bom = await call("PUT", "/boms/" + fg, A, { yield: 90, lines: [[rm, 0.7]] });
  ok("save BOM (percent yield → fraction)", bom.d.yield === 0.9 && bom.d.lines[0][0] === rm);
  const lead = (await call("POST", "/leads", A, { company: "HTTP Test Co", value: 250000, product: fg })).d;
  ok("create lead 201", !!lead.id);
  ok("update lead stage", (await call("PATCH", "/leads/" + lead.id, A, { stage: "Quoted" })).d.stage === "Quoted");
  ok("delete lead 200", (await call("DELETE", "/leads/" + lead.id, A)).status === 200);

  section("Validation rejects bad input");
  ok("SO with empty lines → 400", (await call("POST", "/sales-orders", A, { customerId: cust, lines: [] })).status === 400);
  ok("delete unknown SO → 404", (await call("DELETE", "/sales-orders/SO-NOPE", A)).status === 404);
  ok("BOM for unknown product → 400", (await call("PUT", "/boms/NOPE-ID", A, { lines: [[rm, 1]] })).status === 400);
  ok("movement for unknown item → 400", (await call("POST", "/movements", A, { itemId: "GHOST", type: "GRN", qty: 1 })).status === 400);
  ok("item with unknown category → 400", (await call("POST", "/items", A, { id: "RM-BADCAT", name: "x", cat: "NOPE" })).status === 400);

  // restore the BOM change we made so a re-run against a persisted DB stays clean
  await call("DELETE", "/items/RM-HTTP", A);
}

run()
  .catch((e) => { fail++; console.log("\n  ✗ UNCAUGHT: " + (e && e.stack ? e.stack : e)); })
  .finally(() => {
    try { server.close(); } catch {}
    try { closeDb(); } catch {}
    try { fs.rmSync(TMP, { force: true }); fs.rmSync(TMP + "-wal", { force: true }); fs.rmSync(TMP + "-shm", { force: true }); } catch {}
    console.log("\n" + (fail === 0 ? "PASS" : "FAIL") + " — " + pass + " passed, " + fail + " failed\n");
    process.exit(fail === 0 ? 0 : 1);
  });
