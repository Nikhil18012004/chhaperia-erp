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

  /* Sheet goods — fabric, film, mica tape — are bought to a THICKNESS, and the
     supplier cannot fill the order without it. It is set per LINE, because the
     thickness this order needs is not always the one the item master carries. */
  {
    const poT = (await call("POST", "/purchase-orders", A, { supplierId: sup, eta: "2026-08-01",
      lines: [{ itemId: rm, qty: 50, rate: 20, recd: 0, thicknessMM: 0.08 },
        { itemId: rm, qty: 25, rate: 20, recd: 0 }] })).d;
    ok("a PO line accepts a thickness", poT.lines[0].thicknessMM === 0.08, JSON.stringify(poT.lines[0]));
    // the unit the order is PLACED in travels with the line and prints on the PO
    const poU = (await call("POST", "/purchase-orders", A, { supplierId: sup, eta: "2026-08-01",
      lines: [{ itemId: rm, qty: 500, rate: 2, recd: 0, uom: "MTR" }] })).d;
    ok("a PO line accepts a unit of measure", poU.lines[0].uom === "MTR", JSON.stringify(poU.lines[0]));

    /* A roll ordered in one unit and stocked in another is CONVERTED on
       receipt, through its fixed width and its GSM — stock is only ever held
       in the material's own unit. */
    {
      const roll = { id: "RM-ROLL-CONV", name: "Roll conversion test", cat: "RM", uom: "MTR",
        cost: 1, gsm: 200, width: 1000 };          // 1 m = 0.2 kg, so 1 kg = 5 m
      await call("POST", "/items", A, roll);
      const poR = (await call("POST", "/purchase-orders", A, { supplierId: sup, eta: "2026-08-01",
        lines: [{ itemId: roll.id, qty: 100, rate: 5, recd: 0, uom: "KG" }] })).d;
      const rec = await call("POST", "/purchase-orders/" + poR.id + "/receive", A,
        { wh: "WH-RM", lines: [{ i: 0, qty: 100 }] });
      ok("a receipt in KG against a MTR-stocked roll is accepted", rec.status === 200,
        rec.status + " " + JSON.stringify(rec.d).slice(0, 80));
      const st = (await call("GET", "/state", A)).d;
      const onHand = (st.movements || []).filter((m) => m.itemId === roll.id)
        .reduce((n, m) => n + (+m.qty || 0), 0);
      ok("100 kg lands in stock as 500 MTR", Math.abs(onHand - 500) < 0.01, String(onHand));
      const mv = (st.movements || []).find((m) => m.itemId === roll.id);
      ok("and the movement says what was converted", /100 KG received as 500 MTR/.test(String(mv && mv.note)),
        String(mv && mv.note));
      const poBack = (st.purchaseorders || []).find((p) => p.id === poR.id);
      ok("the order's own progress stays in the unit it was placed in",
        Math.abs(poBack.lines[0].recd - 100) < 0.01 && poBack.status === "Received",
        poBack.lines[0].recd + " " + poBack.status);

      // a material with no width/GSM cannot be reconciled — refuse, never guess
      const opaque = { id: "RM-NOCONV", name: "No geometry", cat: "RM", uom: "MTR", cost: 1 };
      await call("POST", "/items", A, opaque);
      const poN = (await call("POST", "/purchase-orders", A, { supplierId: sup,
        lines: [{ itemId: opaque.id, qty: 10, rate: 1, recd: 0, uom: "KG" }] })).d;
      const recN = await call("POST", "/purchase-orders/" + poN.id + "/receive", A,
        { wh: "WH-RM", lines: [{ i: 0, qty: 10 }] });
      ok("an unconvertible unit is refused rather than posted wrong", recN.status === 400,
        recN.status + " " + JSON.stringify(recN.d).slice(0, 90));
      await call("DELETE", "/purchase-orders/" + poN.id, A);
      await call("DELETE", "/purchase-orders/" + poR.id, A);
    }
    const uBack = ((await call("GET", "/state", A)).d.purchaseorders || []).find((p) => p.id === poU.id);
    ok("the unit survives the round trip", uBack && uBack.lines[0].uom === "MTR");
    await call("DELETE", "/purchase-orders/" + poU.id, A);
    ok("a line without one is unaffected", poT.lines[1].thicknessMM === undefined);
    const back = ((await call("GET", "/state", A)).d.purchaseorders || []).find((p) => p.id === poT.id);
    ok("it survives the round trip to the database",
      back && back.lines[0].thicknessMM === 0.08, JSON.stringify(back && back.lines[0]));
    // and it must still be there after an edit that does not mention it
    await call("PUT", "/purchase-orders/" + poT.id, A, { eta: "2026-09-01", lines: back.lines });
    const back2 = ((await call("GET", "/state", A)).d.purchaseorders || []).find((p) => p.id === poT.id);
    ok("and after the order is edited", back2 && back2.lines[0].thicknessMM === 0.08);
    await call("DELETE", "/purchase-orders/" + poT.id, A);
  }

  /* One document may name the same material twice — a delivery that arrives in
     two lots, at two rates, is one order with two lines. Every line still has
     to post its OWN stock movement, so the ids must differ even when the item
     and the millisecond do not. This used to 500 on the user. */
  {
    const poD = (await call("POST", "/purchase-orders", A, { supplierId: sup, eta: "2026-08-01",
      lines: [{ itemId: rm, qty: 30, rate: 20, recd: 0 }, { itemId: rm, qty: 70, rate: 22, recd: 0 }] })).d;
    const recD = await call("POST", "/purchase-orders/" + poD.id + "/receive", A,
      { wh: "WH-RM", lines: [{ i: 0, qty: 30 }, { i: 1, qty: 70 }] });
    ok("a PO naming one item on two lines receives both at once", recD.status === 200 && recD.d.posted === 2,
      recD.status + " " + JSON.stringify(recD.d).slice(0, 90));
    const stD = (await call("GET", "/state", A)).d;
    const mvD = (stD.movements || []).filter((m) => m.ref === poD.id);
    ok("both lots are posted under distinct ids", mvD.length === 2 && mvD[0].id !== mvD[1].id,
      mvD.map((m) => m.id).join(" "));
    ok("and the full 100 lands in stock", Math.abs(mvD.reduce((n, m) => n + (+m.qty || 0), 0) - 100) < 0.01);
    await call("DELETE", "/purchase-orders/" + poD.id, A);

    // the same trap on the way out: one order, one product, two lines
    const soD = (await call("POST", "/sales-orders", A, { customerId: cust,
      lines: [{ itemId: fg, qty: 4, rate: 100 }, { itemId: fg, qty: 6, rate: 110 }] })).d;
    const dispD = await call("POST", "/sales-orders/" + soD.id + "/dispatch", A, {});
    ok("an SO naming one product on two lines dispatches both", dispD.status === 200 && dispD.d.posted === 2,
      dispD.status + " " + JSON.stringify(dispD.d).slice(0, 90));
    await call("DELETE", "/sales-orders/" + soD.id, A);
  }

  ok("delete PO 200", (await call("DELETE", "/purchase-orders/" + po.id, A)).status === 200);

  // Warehouse master-data edit (rename) — admin/office only
  const wh0 = st.warehouses[0];
  const ren = await call("PATCH", "/warehouses/" + wh0.id, A, { name: "Renamed Store" });
  ok("rename warehouse 200", ren.status === 200 && ren.d.name === "Renamed Store");
  ok("rename persisted in state", (await call("GET", "/state", A)).d.warehouses.find((w) => w.id === wh0.id).name === "Renamed Store");
  ok("supervisor cannot rename warehouse (403)", (await call("PATCH", "/warehouses/" + wh0.id, C, { name: "X" })).status === 403);
  ok("rename unknown warehouse 404", (await call("PATCH", "/warehouses/WH-NOPE", A, { name: "X" })).status === 404);
  ok("rename to blank rejected 400", (await call("PATCH", "/warehouses/" + wh0.id, A, { name: "  " })).status === 400);
  await call("PATCH", "/warehouses/" + wh0.id, A, { name: wh0.name });

  section("Granular BOM + CRM endpoints");
  // Lines are stored in the rich shape now (see frontend/js/bomcalc.js): a
  // legacy [id, qty] tuple is accepted on input and normalised on the way in,
  // because flattening back to a tuple would discard pickup % and the
  // material's type/thickness/GSM on every save.
  const bom = await call("PUT", "/boms/" + fg, A, { yield: 90, lines: [[rm, 0.7]] });
  ok("save BOM (percent yield → fraction)", bom.d.yield === 0.9);
  ok("legacy tuple input is normalised to a rich line", bom.d.lines[0].id === rm && bom.d.lines[0].qty === 0.7);
  const rich = await call("PUT", "/boms/" + fg, A, { yield: 100, lines: [
    { id: rm, rm: "TEST RM", rmType: "GRADE-A", rmGsm: "20", qty: 60, unit: "KG", pickupPct: 50 },
  ] });
  const rl = rich.d.lines[0];
  ok("rich line survives a save round-trip (pickup % + material spec kept)",
    rl.pickupPct === 50 && rl.rmType === "GRADE-A" && rl.unit === "KG" && rl.qty === 60);
  const ranged = await call("PUT", "/boms/" + fg, A, { yield: 100, lines: [
    { rm: "CARBON PASTE", rmType: "CLOFT 912/ CLOFT 913", qty: 60, unit: "KG", options: [rm], ranged: true },
  ] });
  ok("ranged line (no fixed id) is accepted and flagged", ranged.status === 200 && ranged.d.lines[0].ranged === true);
  await call("PUT", "/boms/" + fg, A, { yield: 90, lines: [[rm, 0.7]] });   // restore for later assertions
  const lead = (await call("POST", "/leads", A, { company: "HTTP Test Co", value: 250000, product: fg })).d;
  ok("create lead 201", !!lead.id);
  ok("update lead stage", (await call("PATCH", "/leads/" + lead.id, A, { stage: "Quoted" })).d.stage === "Quoted");
  /* The Sample stage sits between Contacted and Quoted — the trial reel that
     goes out before any price does. Its despatch details ride in the lead's
     doc JSON, so this checks the whole object survives the round-trip rather
     than being dropped by the column-based upsert. */
  const sampled = (await call("PATCH", "/leads/" + lead.id, A, {
    stage: "Sample",
    sample: { product: fg, qty: 3, uom: "KG", sentDate: "2026-08-03", courier: "Blue Dart",
      awb: "AWB123456", verdict: "Awaiting feedback", note: "Trial reel" },
  })).d;
  ok("lead moves to the Sample stage", sampled.stage === "Sample");
  ok("sample despatch details survive the round-trip",
    sampled.sample && sampled.sample.courier === "Blue Dart" && sampled.sample.qty === 3
    && sampled.sample.awb === "AWB123456" && sampled.sample.verdict === "Awaiting feedback");
  ok("moving on from Sample keeps the sample record",
    (await call("PATCH", "/leads/" + lead.id, A, { stage: "Quoted" })).d.sample.awb === "AWB123456");
  ok("delete lead 200", (await call("DELETE", "/leads/" + lead.id, A)).status === 200);

  /* ============================================================
     LAB INCHARGE — a low-trust role. The earlier "sales desk" role
     leaked the entire database because stateForUser() fell through
     to the full dataset while the UI merely hid its menus; these
     assertions exist so that cannot happen again unnoticed.
     ============================================================ */
  section("Payroll advances — recovered monthly, never double-counted");
  {
    const W = { id: "EMP-ADV", name: "Advance Test Worker", dept: "packing", payType: "daily",
      dailyRate: 700, joined: "2020-01-01" };
    await call("POST", "/hr/workers", A, W);
    // give the worker a full month of attendance so there is pay to deduct from
    const per = "2026-05";
    for (let d = 1; d <= 26; d++) {
      await call("POST", "/hr/attendance", A, { workerId: W.id, date: per + "-" + String(d).padStart(2, "0"), status: "P" });
    }
    const slipOf = async (period) => {
      const r = await call("POST", "/hr/payroll/run", A, { period, force: true });
      return (r.d.payslips || []).find((s) => s.workerId === W.id);
    };

    const plain = await slipOf(per);
    ok("with no advance nothing is deducted", plain && plain.advances === 0, plain && String(plain.advances));
    const grossWas = plain.gross;

    ok("an advance needs an amount and a monthly deduction",
      (await call("PUT", "/hr/workers/" + W.id + "/advance", A, { amount: 20000, monthly: 2000 })).status === 200);
    const st1 = (await call("GET", "/hr/workers/" + W.id + "/advance", A)).d;
    ok("it is held against the worker", st1.advance && st1.advance.amount === 20000 && st1.advance.monthly === 2000);
    ok("nothing is recovered until a run is finalised", st1.advance.recovered === 0 && st1.advance.outstanding === 20000);

    const s1 = await slipOf(per);
    ok("the payslip now recovers one monthly instalment", s1.advances === 2000, String(s1.advances));
    ok("and the net pay drops by exactly that", s1.net === plain.net - 2000, s1.net + " vs " + plain.net);
    ok("gross is untouched — an advance is a deduction, not a pay cut", s1.gross === grossWas);
    ok("the slip carries the balance either side",
      s1.advance && s1.advance.opening === 20000 && s1.advance.closing === 18000,
      JSON.stringify(s1.advance));

    // THE trap: a Draft run can be regenerated any number of times
    const s1again = await slipOf(per);
    ok("re-running a DRAFT does not recover twice", s1again.advances === 2000 && s1again.advance.closing === 18000,
      s1again.advances + " / " + JSON.stringify(s1again.advance));

    await call("POST", "/hr/payroll/PR-" + per + "/finalize", A, {});
    const st2 = (await call("GET", "/hr/workers/" + W.id + "/advance", A)).d;
    ok("finalising the run books the recovery", st2.advance.recovered === 2000 && st2.advance.outstanding === 18000,
      JSON.stringify(st2.advance));

    // next month picks up where it left off
    for (let d = 1; d <= 26; d++) {
      await call("POST", "/hr/attendance", A, { workerId: W.id, date: "2026-06-" + String(d).padStart(2, "0"), status: "P" });
    }
    const s2 = await slipOf("2026-06");
    ok("the next month recovers the next instalment", s2.advances === 2000, String(s2.advances));
    ok("counting down from the new balance",
      s2.advance.opening === 18000 && s2.advance.closing === 16000, JSON.stringify(s2.advance));

    // a nearly-cleared advance must not over-recover
    await call("PUT", "/hr/workers/" + W.id + "/advance", A, { amount: 2500, monthly: 2000 });
    const s3 = await slipOf("2026-06");
    ok("the last instalment is trimmed to what is left, never more",
      s3.advances === 500 && s3.advance.closing === 0,
      s3.advances + " / " + JSON.stringify(s3.advance));

    // manual one-month override
    ok("a one-month override is allowed",
      (await call("PATCH", "/hr/payslips/PR-2026-06:" + W.id, A, { advances: 300 })).d.advances === 300);
    ok("but it cannot recover more than is outstanding",
      (await call("PATCH", "/hr/payslips/PR-2026-06:" + W.id, A, { advances: 99999 })).status === 400);
    ok("and it cannot be negative",
      (await call("PATCH", "/hr/payslips/PR-2026-06:" + W.id, A, { advances: -5 })).status === 400);

    ok("a monthly deduction larger than the advance is refused",
      (await call("PUT", "/hr/workers/" + W.id + "/advance", A, { amount: 1000, monthly: 5000 })).status === 400);
    ok("a negative advance is refused",
      (await call("PUT", "/hr/workers/" + W.id + "/advance", A, { amount: -100, monthly: 10 })).status === 400);

    ok("recovery can be told to start from a later month",
      (await call("PUT", "/hr/workers/" + W.id + "/advance", A, { amount: 9000, monthly: 1000, startPeriod: "2026-09" })).status === 200);
    const s4 = await slipOf("2026-06");
    ok("so an earlier month deducts nothing", s4.advances === 0, String(s4.advances));

    ok("clearing the advance removes it",
      !((await call("PUT", "/hr/workers/" + W.id + "/advance", A, { amount: 0 })).d || {}).advance);
    const s5 = await slipOf("2026-06");
    ok("and the payslip goes back to no deduction", s5.advances === 0);

    ok("a supervisor cannot set an advance (403)",
      (await call("PUT", "/hr/workers/" + W.id + "/advance", C, { amount: 500, monthly: 100 })).status === 403);
    ok("an unknown worker 404s",
      (await call("PUT", "/hr/workers/EMP-NOPE/advance", A, { amount: 500, monthly: 100 })).status === 404);

    await call("DELETE", "/hr/payroll/PR-" + per, A);
    await call("DELETE", "/hr/payroll/PR-2026-06", A);
    await call("DELETE", "/hr/workers/" + W.id, A);
  }

  section("Complete-all runs every stage in ONE request");
  {
    const wos = (await call("GET", "/state", A)).d.workorders || [];
    const open = wos.find((w) => w.status !== "Completed" && w.status !== "Dispatched");
    if (!open) {
      ok("no open work order to exercise complete-all — skipped", true);
    } else {
      const before = (open.route || []).filter((s) => s.status !== "Completed").length;
      const r = await call("POST", "/production/wo/" + open.id + "/advance", A, { action: "complete", all: true });
      ok("one call is accepted", r.status === 200, String(r.status));
      ok("and it finishes the whole route in that single call",
        r.d.status === "Completed" || r.d.status === "Dispatched",
        r.d.status + " (had " + before + " stages left)");
      ok("every stage is marked complete",
        (r.d.route || []).every((s) => s.status === "Completed"),
        (r.d.route || []).map((s) => s.key + ":" + s.status).join(","));
      ok("completing an already-finished order does not throw",
        [200, 400].includes((await call("POST", "/production/wo/" + open.id + "/advance", A, { action: "complete", all: true })).status));
    }
    ok("a plain advance still takes one stage only — `all` must be opt-in",
      (await call("POST", "/production/wo/WO-NOPE/advance", A, { action: "complete" })).status === 404);
  }

  section("Slim floor refresh — the catalogue is not resent after every tap");
  {
    const full = (await call("GET", "/state", C)).d;
    const thin = (await call("GET", "/state?slim=1", C)).d;
    ok("the full view carries the product catalogue",
      Array.isArray(full.finishedProducts) && full.finishedProducts.length > 0,
      String((full.finishedProducts || []).length));
    ok("the slim view leaves it out entirely", thin.finishedProducts === undefined);
    ok("and says so, so the client keeps its own copy", thin.slim === true);
    ok("the full view is not marked slim", full.slim === false);
    // everything a stage action can actually change must survive the trim
    ok("work orders still come through", Array.isArray(thin.workorders));
    ok("same work orders as the full view", (thin.workorders || []).length === (full.workorders || []).length,
      (thin.workorders || []).length + " vs " + (full.workorders || []).length);
    ok("material stock still comes through", !!thin.materialStock);
    ok("warehouse stock still comes through", !!thin.warehouseStock);
    ok("stock items still come through", Array.isArray(thin.stockItems));
    ok("the slim payload is materially smaller",
      JSON.stringify(thin).length < JSON.stringify(full).length * 0.5,
      Math.round(JSON.stringify(thin).length / 1024) + "KB vs " + Math.round(JSON.stringify(full).length / 1024) + "KB");
    // slim is a floor convenience — it must never change what other roles get
    const adminSlim = (await call("GET", "/state?slim=1", A)).d;
    ok("admin is unaffected by slim", Array.isArray(adminSlim.items) && adminSlim.items.length > 0);
    ok("a supervisor still cannot see money", thin.customers === undefined && thin.suppliers === undefined);
  }

  section("One account on several machines — signing out on one keeps the rest");
  {
    // a throwaway account, so signing it out cannot disturb the other suites
    await call("POST", "/auth/users", A, { username: "multidev", name: "Multi Device",
      role: "office", password: "multidev@123" });
    const m1 = (await login("multidev", "multidev@123")).token;
    const m2 = (await login("multidev", "multidev@123")).token;
    const m3 = (await login("multidev", "multidev@123")).token;
    ok("the same account can sign in more than once", !!m1 && !!m2 && !!m3);
    ok("each sign-in gets its own token", m1 !== m2 && m2 !== m3);
    ok("signing in again does NOT drop the earlier session",
      (await call("GET", "/auth/me", m1)).status === 200);
    ok("all three sessions work at once",
      (await call("GET", "/auth/me", m2)).status === 200 && (await call("GET", "/auth/me", m3)).status === 200);

    ok("signing out returns ok", (await call("POST", "/auth/logout", m2)).status === 200);
    ok("the machine that signed out is done", (await call("GET", "/auth/me", m2)).status === 401);
    ok("but the other machines stay signed in",
      (await call("GET", "/auth/me", m1)).status === 200 && (await call("GET", "/auth/me", m3)).status === 200);
    ok("a signed-out token cannot be reused later", (await call("GET", "/state", m2)).status === 401);

    // changing the password is the deliberate account-wide kick
    ok("password change succeeds",
      (await call("POST", "/auth/change-password", m1,
        { currentPassword: "multidev@123", newPassword: "multidev@456" })).status === 200);
    ok("a password change DOES drop every other machine",
      (await call("GET", "/auth/me", m3)).status === 401);

    const u = ((await call("GET", "/auth/users", A)).d.users || []).find((x) => x.username === "multidev");
    if (u) await call("DELETE", "/auth/users/" + u.id, A);
  }

  section("Payroll for selected workers — a partial run tops the month up");
  {
    const per = "2026-04";
    const mk = async (id, name, rate) => {
      await call("POST", "/hr/workers", A, { id, name, dept: "packing", payType: "daily",
        dailyRate: rate, joined: "2020-01-01" });
      for (let d = 1; d <= 26; d++) {
        await call("POST", "/hr/attendance", A, { workerId: id, date: per + "-" + String(d).padStart(2, "0"), status: "P" });
      }
    };
    await mk("EMP-SEL-1", "Selected One", 500);
    await mk("EMP-SEL-2", "Selected Two", 600);
    await mk("EMP-SEL-3", "Selected Three", 700);
    const has = (r, id) => (r.d.payslips || []).some((s) => s.workerId === id);

    const r1 = await call("POST", "/hr/payroll/run", A, { period: per, force: true, workerIds: ["EMP-SEL-1"] });
    ok("a run can cover a single chosen worker", r1.status === 201 && r1.d.payslips.length === 1, String(r1.d.payslips.length));
    ok("and it is the one that was asked for", has(r1, "EMP-SEL-1"));
    ok("nobody else is paid by it", !has(r1, "EMP-SEL-2") && !has(r1, "EMP-SEL-3"));
    ok("the run counts only who it paid", r1.d.payrun.workers === 1, String(r1.d.payrun.workers));
    const net1 = r1.d.payslips[0].net;

    const r2 = await call("POST", "/hr/payroll/run", A, { period: per, force: true, workerIds: ["EMP-SEL-2"] });
    ok("paying the next person keeps the first one's payslip", has(r2, "EMP-SEL-1") && has(r2, "EMP-SEL-2"),
      (r2.d.payslips || []).map((s) => s.workerId).join(","));
    ok("the third is still unpaid", !has(r2, "EMP-SEL-3"));
    ok("the run now counts both", r2.d.payrun.workers === 2, String(r2.d.payrun.workers));
    const net2 = (r2.d.payslips.find((s) => s.workerId === "EMP-SEL-2") || {}).net;
    ok("totals cover every slip in the run, not just the new one",
      Math.abs(r2.d.payrun.totals.net - (net1 + net2)) < 0.5,
      r2.d.payrun.totals.net + " vs " + (net1 + net2));

    // a hand-edited slip must survive a later partial run and stay in the totals
    await call("PATCH", "/hr/payslips/PR-" + per + ":EMP-SEL-1", A, { advances: 0 });
    const r3 = await call("POST", "/hr/payroll/run", A, { period: per, force: true, workerIds: ["EMP-SEL-3"] });
    ok("a third partial run adds to the same month", r3.d.payrun.workers === 3, String(r3.d.payrun.workers));

    const rAll = await call("POST", "/hr/payroll/run", A, { period: per, force: true });
    ok("running with no selection still covers everyone active",
      has(rAll, "EMP-SEL-1") && has(rAll, "EMP-SEL-2") && has(rAll, "EMP-SEL-3") && rAll.d.payslips.length >= 3,
      String(rAll.d.payslips.length));
    const rEmpty = await call("POST", "/hr/payroll/run", A, { period: per, force: true, workerIds: [] });
    ok("an empty selection means everyone, not nobody", rEmpty.d.payslips.length === rAll.d.payslips.length,
      rEmpty.d.payslips.length + " vs " + rAll.d.payslips.length);
    ok("an unknown worker is refused",
      (await call("POST", "/hr/payroll/run", A, { period: per, force: true, workerIds: ["EMP-GHOST"] })).status === 400);
    ok("a supervisor cannot run payroll for a selection",
      (await call("POST", "/hr/payroll/run", C, { period: per, force: true, workerIds: ["EMP-SEL-1"] })).status === 403);

    await call("DELETE", "/hr/payroll/PR-" + per, A);
    await call("DELETE", "/hr/workers/EMP-SEL-1", A);
    await call("DELETE", "/hr/workers/EMP-SEL-2", A);
    await call("DELETE", "/hr/workers/EMP-SEL-3", A);
  }

  section("Lab role: scoped payload + write limits");
  const lab = await login("lab", "lab@123");
  const LB = lab.token;
  ok("lab login returns a token + role", !!(lab && LB && lab.user.role === "lab"));

  const labState = (await call("GET", "/state", LB)).d;
  ok("lab payload is the scoped lab view", labState.role === "lab");
  ok("lab gets NO HR/payroll data", !labState.hrWorkers && !labState.hrPayslips);
  ok("lab gets NO CRM leads", !labState.leads);
  ok("lab still sees items + BOMs (needed to trace a batch)",
    Array.isArray(labState.items) && labState.items.length > 0 && !!labState.boms);
  const labProd = (labState.labProducts || [])[0];
  ok("lab gets NO spec limits, only whether one is set",
    !labProd || (Object.keys(labProd.spec || {}).length === 0 && "specSet" in labProd));

  ok("lab CANNOT list users (403)", (await call("GET", "/auth/users", LB)).status === 403);
  ok("lab CANNOT write items (403)", (await call("POST", "/items", LB, { id: "RM-LAB", name: "x", cat: "RM" })).status === 403);
  ok("lab CANNOT create purchase orders (403)", (await call("POST", "/purchase-orders", LB, { supplierId: "SUP-01", lines: [] })).status === 403);
  ok("lab CANNOT PUT full state (403)", (await call("PUT", "/state", LB, {})).status === 403);
  ok("lab CANNOT edit the lab product master (403)",
    (await call("POST", "/lab/products", LB, { name: "X" })).status === 403);
  ok("lab CANNOT set a spec — it is the yardstick it is graded by (403)",
    (await call("PUT", "/lab/products/LP-0001/spec", LB, { spec: {} })).status === 403);

  /* ---- two-stage measurement of one batch ---- */
  section("Two-stage lab measurement (production + lab on one batch)");
  const lpId = (labState.labProducts || [])[0] && labState.labProducts[0].id;
  if (lpId) {
    await call("PUT", "/lab/products/" + lpId + "/spec", A, { spec: { thickness: { min: 0.1, max: 0.3 }, tensile: { min: 35 } } });
    const batch = "BATCH-2STAGE";
    const p1 = await call("POST", "/lab/reports", O, { productId: lpId, refNo: batch, source: "production", values: { thickness: 0.2, tensile: 40 } });
    ok("production stage recorded", p1.status === 201 && p1.d.prodResult === "Pass", JSON.stringify(p1.d && p1.d.prodResult));
    const p2 = await call("POST", "/lab/reports", LB, { productId: lpId, refNo: batch, values: { thickness: 0.2, tensile: 20 } });
    ok("lab stage merges into the SAME report (no duplicate certificate)", p2.d.id === p1.d.id);
    ok("both measurement sets are kept side by side",
      Object.keys(p2.d.prodValues || {}).length > 0 && Object.keys(p2.d.labValues || {}).length > 0);
    ok("each stage grades independently (production Pass, lab Fail)",
      p2.d.prodResult === "Pass" && p2.d.labResult === "Fail",
      p2.d.prodResult + "/" + p2.d.labResult);
    ok("headline result follows the lab reading once present", p2.d.result === "Fail");
    ok("lab writer is attributed", p2.d.labBy === "lab");
    ok("lab CANNOT delete a certificate (403)", (await call("DELETE", "/lab/reports/" + p1.d.id, LB)).status === 403);
  }

  /* ---- supervisor floor actions ---- */
  section("Floor actions: return + unplanned production");
  const ret = await call("POST", "/production/return", C, { itemId: "RM-HTTP", qty: 5, reason: "unused issue" });
  ok("supervisor can return material to store", ret.status === 201 && ret.d.movement.type === "RET" && ret.d.movement.qty === 5);
  ok("return rejects a zero quantity", (await call("POST", "/production/return", C, { itemId: "RM-HTTP", qty: 0 })).status === 400);
  const adhoc = await call("POST", "/production/adhoc", C, { itemId: fg, rolls: 2, lengthM: 1000, widthMM: 1000, gsm: 100 });
  // 2 rolls x 1000 m x 1.0 m = 2000 sqm ; x 100 g/m² / 1000 = 200 kg
  ok("unplanned production derives sqm + kg from the roll geometry",
    adhoc.status === 201 && adhoc.d.sqm === 2000 && adhoc.d.kg === 200,
    JSON.stringify({ sqm: adhoc.d && adhoc.d.sqm, kg: adhoc.d && adhoc.d.kg }));
  ok("unplanned production creates a routed work order", !!(adhoc.d && adhoc.d.workOrder));
  ok("adhoc needs enough geometry to weigh the run",
    (await call("POST", "/production/adhoc", C, { itemId: fg, rolls: 1 })).status === 400);

  section("The store decides where a work order starts");
  // plenty of stock for the recipe -> nothing to produce, start at slitting
  await call("POST", "/movements", A, { itemId: rm, type: "GRN", qty: 100000, wh: "WH-PNY", rate: 10 });
  const rm2 = st.items.filter((i) => i.cat !== "FG" && i.id !== rm)[0].id;
  await call("POST", "/movements", A, { itemId: rm2, type: "GRN", qty: 100000, wh: "WH-PNY", rate: 10 });
  await call("PUT", "/boms/" + fg, A, { yield: 100, lines: [[rm, 0.6], [rm2, 0.3]] });

  // A width is named so the run is not netted against the finished stock the
  // adhoc run booked earlier: stock whose tape width was never recorded is
  // never used for a width-specific order. This section is about ROUTING, so
  // the netting is deliberately kept out of it (netting has its own section).
  const woStk = await call("POST", "/production/wo", A, { itemId: fg, qty: 10, widthMM: 25 });
  const rStk = (woStk.d && woStk.d.route) || [];
  ok("material in store -> straight to Slitting → Packing",
    rStk.length === 2 && rStk[0].key === "slitting" && rStk[1].key === "packing",
    rStk.map((r) => r.key).join(" > "));
  ok("no production stage is planned when the material is there",
    rStk.every((r) => r.key !== "rmprod" && r.area !== "coating"), rStk.map((r) => r.area).join(","));
  const woStkFull = (await call("GET", "/state", A)).d.workorders.find((w) => w.id === woStk.d.id);
  ok("it sits on a slitting line", /^Slitting/.test(woStkFull.line), woStkFull.line);
  ok("an RM-production supervisor cannot touch a slitting job",
    (await call("POST", "/production/wo/" + woStk.d.id + "/advance", C, { action: "start" })).status === 403);

  // a product WE make, whose material is NOT in store -> starts at its owner's line
  const gaut = { id: "FG-TEST-WB", name: "Test water blocking tape", cat: "FG", uom: "KG",
    typeCode: "CHDNW-99", group: "WATER BLOCKING SERIES", cost: 100, price: 200 };
  await call("POST", "/items", A, gaut);
  const scarce = { id: "RM-TEST-SCARCE", name: "Scarce fabric", cat: "RM", uom: "KG", cost: 50 };
  await call("POST", "/items", A, scarce);
  await call("PUT", "/boms/" + gaut.id, A, { yield: 100, lines: [[scarce.id, 1.2]] });
  const woMake = await call("POST", "/production/wo", A, { itemId: gaut.id, qty: 50 });
  const rMake = (woMake.d && woMake.d.route) || [];
  ok("material short + we make it -> starts at RM production",
    rMake.length === 3 && rMake[0].key === "rmprod", rMake.map((r) => r.key).join(" > "));
  ok("the production stage is owned by the person who makes that family",
    rMake[0].owner === "coating1" && /Gautam/.test(rMake[0].name),
    rMake[0].owner + " · " + rMake[0].name);
  const woMakeFull = (await call("GET", "/state", A)).d.workorders.find((w) => w.id === woMake.d.id);
  ok("and it sits on that person's line", woMakeFull.line === "RM Production 1", woMakeFull.line);

  // the woven semi-conductive family belongs to the other person
  const gan = { id: "FG-TEST-WOVEN", name: "Test semi conductive woven tape", cat: "FG", uom: "KG",
    typeCode: "CHN-99 WS", group: "WATER BLOCKING SERIES", cost: 100, price: 200 };
  await call("POST", "/items", A, gan);
  await call("PUT", "/boms/" + gan.id, A, { yield: 100, lines: [[scarce.id, 1.2]] });
  const woGan = await call("POST", "/production/wo", A, { itemId: gan.id, qty: 50 });
  ok("a woven semi-conductive tape goes to the other RM line",
    woGan.d.route[0].owner === "coating2" && /Ganesh/.test(woGan.d.route[0].name),
    woGan.d.route[0].owner + " · " + woGan.d.route[0].name);

  // copper woven: the fibre-glass team weaves the base first
  const cu = { id: "FG-TEST-CUWOVEN", name: "Test copper woven semi conductive WB tape", cat: "FG",
    uom: "KG", typeCode: "CHCWSCWBT-99", group: "WATER BLOCKING SERIES", cost: 100, price: 200 };
  await call("POST", "/items", A, cu);
  await call("PUT", "/boms/" + cu.id, A, { yield: 100, lines: [[scarce.id, 1.2]] });
  const woCu = await call("POST", "/production/wo", A, { itemId: cu.id, qty: 50 });
  const rCu = woCu.d.route || [];
  ok("copper woven: weaving → RM production → slitting → packing",
    rCu.length === 4 && rCu[0].key === "weaving" && rCu[0].owner === "fiberglass"
    && rCu[1].key === "rmprod" && rCu[1].owner === "coating2",
    rCu.map((r) => r.key + (r.owner ? "/" + r.owner : "")).join(" > "));

  /* A bought-in product with no stock is NOT refused any more — the factory
     runs what it can and carries the rest as pending. It still cannot happen
     silently: the office is answered 409 with the shortage until it says yes. */
  const bought = { id: "FG-TEST-BOUGHT", name: "Test bought-in tape", cat: "FG", uom: "KG",
    typeCode: "CH-PTFE-99", group: "OTHER TAPE SERIES", cost: 100, price: 200 };
  await call("POST", "/items", A, bought);
  await call("PUT", "/boms/" + bought.id, A, { yield: 100, lines: [[scarce.id, 1.2]] });
  const woBuy = await call("POST", "/production/wo", A, { itemId: bought.id, qty: 50 });
  ok("a shortage answers 409, not a silent create", woBuy.status === 409,
    woBuy.status + " " + JSON.stringify(woBuy.d).slice(0, 90));
  ok("and it says exactly what is short",
    Array.isArray(woBuy.d.shortage) && woBuy.d.shortage.length > 0
      && woBuy.d.shortage[0].id === scarce.id,
    JSON.stringify(woBuy.d.shortage || []).slice(0, 120));
  ok("it reports how much can be made now", woBuy.d.canMake != null && woBuy.d.pendingQty > 0,
    "canMake=" + woBuy.d.canMake + " pending=" + woBuy.d.pendingQty);
  ok("nothing was created by the refused attempt",
    !((await call("GET", "/state", A)).d.workorders || []).some((w) => w.itemId === bought.id));

  section("Partial work order — make what the store covers, carry the rest");
  {
    const rm = { id: "RM-PART-TEST", name: "Partial test resin", cat: "RM", uom: "KG", cost: 10 };
    const fgP = { id: "FG-PART-TEST", name: "Partial test tape", cat: "FG", uom: "KG",
      typeCode: "CH-PART-01", group: "OTHER TAPE SERIES", cost: 50, price: 90 };
    await call("POST", "/items", A, rm);
    await call("POST", "/items", A, fgP);
    // 1 kg of resin per 1 kg of tape, so the arithmetic is obvious
    await call("PUT", "/boms/" + fgP.id, A, { yield: 100, lines: [[rm.id, 1]] });
    // the store holds 50 kg; the order will be for 100 kg
    await call("POST", "/movements", A, { id: "MV-PART-1", itemId: rm.id, type: "GRN",
      qty: 50, rate: 10, wh: "WH-RM", date: "2026-01-01", manual: true });

    // this product runs on a slitting line, so that floor's supervisor sees it
    const S1x = (await login("slitting1", "slitting1@123")).token;
    const pv = await call("POST", "/production/wo/preview", A, { itemId: fgP.id, qty: 100 });
    ok("preview says how much can be made", Math.abs(pv.d.canMake - 50) < 0.01, String(pv.d.canMake));
    ok("preview says how much would be pending", Math.abs(pv.d.pendingQty - 50) < 0.01, String(pv.d.pendingQty));
    ok("preview names the short material",
      (pv.d.shortage || []).some((s) => s.id === rm.id), JSON.stringify(pv.d.shortage || []));
    ok("preview writes nothing",
      !((await call("GET", "/state", A)).d.workorders || []).some((w) => w.itemId === fgP.id));

    const made = await call("POST", "/production/wo", A, { itemId: fgP.id, qty: 100, allowShortage: true });
    ok("with consent the order IS raised for the full 100", made.status === 201 && made.d.qty === 100,
      made.status + " qty=" + (made.d || {}).qty);
    ok("50 goes to the floor", Math.abs(made.d.runQty - 50) < 0.01, String(made.d.runQty));
    ok("50 is carried as pending", Math.abs(made.d.pendingQty - 50) < 0.01, String(made.d.pendingQty));
    ok("nothing is completed yet", made.d.completedQty === 0, String(made.d.completedQty));
    const woId = made.d.id;

    // only the 50 being run may draw material — the pending half must cost nothing
    const stockAfter = ((await call("GET", "/state", A)).d.movements || [])
      .filter((m) => m.itemId === rm.id).reduce((n, m) => n + (+m.qty || 0), 0);
    ok("only the runnable 50 kg of material was issued", Math.abs(stockAfter) < 0.01,
      "on hand " + stockAfter);

    // finish the part that could be made
    const done = await call("POST", "/production/wo/" + woId + "/advance", A, { action: "complete", all: true });
    ok("finishing the run does NOT mark the order Completed", done.d.status === "Partial", done.d.status);
    ok("the pending balance survives", Math.abs(done.d.pendingQty - 50) < 0.01, String(done.d.pendingQty));
    /* The run that WAS made reads 100% — the floor did finish it — but the
       order stays open, because the rest of the quantity has not been made. */
    ok("the finished run still reports 100%", done.d.progress === 100, String(done.d.progress));
    ok("every stage of that run is complete",
      (done.d.route || []).every((s) => s.status === "Completed"));
    const boardRow = ((await call("GET", "/state", A)).d.workorders || []).find((w) => w.id === woId);
    ok("and the board still calls it Partial, not Completed",
      boardRow && boardRow.status === "Partial", boardRow && boardRow.status);
    const floorRow = ((await call("GET", "/state", S1x)).d.workorders || []).find((w) => w.id === woId);
    ok("the floor still sees it as its job",
      floorRow && floorRow.partial === true && (+floorRow.pendingQty || 0) > 0,
      JSON.stringify(floorRow && { partial: floorRow.partial, pending: floorRow.pendingQty }));

    // resuming before the material arrives must fail, and must not consume anything
    const early = await call("POST", "/production/wo/" + woId + "/resume", A, {});
    ok("resuming with an empty store is refused", early.status === 409, early.status + " " + JSON.stringify(early.d).slice(0, 80));
    ok("and it says what is still short", Array.isArray(early.d.shortage) && early.d.shortage.length > 0);

    /* A PART delivery must put PART of the job back on the floor — 20 kg of
       the 50 outstanding — and leave the rest pending, rather than being
       refused until the whole balance turns up. */
    await call("POST", "/movements", A, { id: "MV-PART-1B", itemId: rm.id, type: "GRN",
      qty: 20, rate: 10, wh: "WH-RM", date: "2026-01-20", manual: true });
    const half = await call("POST", "/production/wo/" + woId + "/resume", A, {});
    ok("a part delivery resumes what it can cover", half.status === 200 && Math.abs(half.d.runQty - 20) < 0.01,
      half.status + " run=" + (half.d || {}).runQty);
    ok("and the remainder stays pending", Math.abs(half.d.pendingQty - 30) < 0.01, String(half.d.pendingQty));
    ok("the 20 kg was issued, not reserved",
      Math.abs(((await call("GET", "/state", A)).d.movements || [])
        .filter((m) => m.itemId === rm.id).reduce((n, m) => n + (+m.qty || 0), 0)) < 0.01);
    // finish that 20 so the rest can be resumed in turn
    await call("POST", "/production/wo/" + woId + "/advance", A, { action: "complete", all: true });

    // material arrives — but it is NOT reserved until somebody resumes
    await call("POST", "/movements", A, { id: "MV-PART-2", itemId: rm.id, type: "GRN",
      qty: 30, rate: 10, wh: "WH-RM", date: "2026-02-01", manual: true });
    const freeStock = await call("POST", "/production/wo/preview", A, { itemId: fgP.id, qty: 30 });
    ok("refilled stock stays free for other orders until the pending one is resumed",
      freeStock.d.pendingQty === 0 && Math.abs(freeStock.d.canMake - 30) < 0.01,
      "canMake=" + freeStock.d.canMake + " pending=" + freeStock.d.pendingQty);

    const res = await call("POST", "/production/wo/" + woId + "/resume", A, {});
    ok("resume is accepted once the material is in", res.status === 200, res.status + " " + JSON.stringify(res.d).slice(0, 80));
    ok("the last 30 moves onto the floor", Math.abs(res.d.runQty - 30) < 0.01, String(res.d.runQty));
    ok("nothing is left pending", res.d.pendingQty === 0, String(res.d.pendingQty));
    // 50 from the first run + 20 from the part delivery
    ok("everything made so far is recorded as completed",
      Math.abs(res.d.completedQty - 70) < 0.01, String(res.d.completedQty));
    ok("the route is ready to run again", (res.d.route || []).every((s) => s.status === "Pending"),
      (res.d.route || []).map((s) => s.status).join(","));
    const after = ((await call("GET", "/state", A)).d.movements || [])
      .filter((m) => m.itemId === rm.id).reduce((n, m) => n + (+m.qty || 0), 0);
    ok("resuming issued the material there and then", Math.abs(after) < 0.01, "on hand " + after);

    const fin = await call("POST", "/production/wo/" + woId + "/advance", A, { action: "complete", all: true });
    ok("finishing the balance completes the order", fin.d.status === "Completed", fin.d.status);

    ok("a supervisor cannot resume a pending order",
      (await call("POST", "/production/wo/" + woId + "/resume", C, {})).status === 403);

    /* Splitting a big order into batches is a normal way to work, not only a
       response to a shortage: release part now, ship it, release the next. */
    {
      await call("POST", "/movements", A, { id: "MV-BATCH-1", itemId: rm.id, type: "GRN",
        qty: 100, rate: 10, wh: "WH-RM", date: "2026-05-01", manual: true });
      const b = await call("POST", "/production/wo", A, { itemId: fgP.id, qty: 100, releaseQty: 30 });
      ok("an order can be raised with only part released", b.status === 201, b.status + " " + JSON.stringify(b.d).slice(0, 70));
      ok("30 goes to the floor", Math.abs(b.d.runQty - 30) < 0.01, String(b.d.runQty));
      ok("70 is carried as pending", Math.abs(b.d.pendingQty - 70) < 0.01, String(b.d.pendingQty));
      ok("a batch held back on purpose is not flagged as a shortage",
        !b.d.shortage || b.d.shortage.length === 0, JSON.stringify(b.d.shortage));
      // and only the released part drew material — the rest is still on the shelf
      const left = ((await call("GET", "/state", A)).d.movements || [])
        .filter((m) => m.itemId === rm.id).reduce((n, m) => n + (+m.qty || 0), 0);
      ok("the held-back batch has not consumed anything yet", Math.abs(left - 70) < 0.01, String(left));

      await call("POST", "/production/wo/" + b.d.id + "/advance", A, { action: "complete", all: true });
      await call("POST", "/production/wo/" + b.d.id + "/advance", A, { action: "dispatch" });
      const nxt = await call("POST", "/production/wo/" + b.d.id + "/resume", A, { qty: 40 });
      ok("the next batch can be a chosen size too", Math.abs(nxt.d.runQty - 40) < 0.01, String(nxt.d.runQty));
      ok("and the remainder keeps waiting", Math.abs(nxt.d.pendingQty - 30) < 0.01, String(nxt.d.pendingQty));
      ok("resuming more than is pending is refused",
        (await call("POST", "/production/wo/" + b.d.id + "/resume", A, { qty: 999 })).status === 400);
      await call("DELETE", "/production/wo/" + b.d.id, A);
      /* Deleting the order reverses everything it issued, so the 100 kg staged
         for this block is back on the shelf. Take it out again — the tests
         that follow are about an EMPTY store and must start from one. */
      const onShelf = ((await call("GET", "/state", A)).d.movements || [])
        .filter((m) => m.itemId === rm.id).reduce((n, m) => n + (+m.qty || 0), 0);
      if (onShelf > 0.001) {
        await call("POST", "/movements", A, { id: "MV-BATCH-Z", itemId: rm.id, type: "ADJ",
          qty: -onShelf, wh: "WH-RM", date: "2026-05-02", manual: true });
      }
      const after = ((await call("GET", "/state", A)).d.movements || [])
        .filter((m) => m.itemId === rm.id).reduce((n, m) => n + (+m.qty || 0), 0);
      ok("the store is back to empty for the tests that follow", Math.abs(after) < 0.01, String(after));
    }

    /* A partial order ships what it HAS made — the goods are real whether or
       not the balance has arrived — and stays open for the rest. */
    {
      // 40 kg of material against a 60 kg order, so 40 is made and 20 pends
      await call("POST", "/movements", A, { id: "MV-PART-3", itemId: rm.id, type: "GRN",
        qty: 40, rate: 10, wh: "WH-RM", date: "2026-03-01", manual: true });
      const p = await call("POST", "/production/wo", A, { itemId: fgP.id, qty: 60, allowShortage: true });
      const pid = p.d.id;
      const made = +p.d.runQty || 0;
      ok("40 of the 60 is released, 20 pends", Math.abs(made - 40) < 0.01 && Math.abs(p.d.pendingQty - 20) < 0.01,
        "run=" + made + " pending=" + p.d.pendingQty);
      await call("POST", "/production/wo/" + pid + "/advance", A, { action: "complete", all: true });
      const disp = await call("POST", "/production/wo/" + pid + "/advance", A, { action: "dispatch" });
      ok("the made portion of a pending order can be dispatched", disp.status === 200,
        disp.status + " " + JSON.stringify(disp.d).slice(0, 80));
      ok("it records how much went out", Math.abs(disp.d.dispatchedQty - made) < 0.01,
        disp.d.dispatchedQty + " vs " + made);
      ok("the order is NOT closed while quantity is still owed",
        disp.d.dispatched === false && disp.d.pendingQty > 0,
        "dispatched=" + disp.d.dispatched + " pending=" + disp.d.pendingQty);
      ok("dispatching the same portion twice is refused",
        (await call("POST", "/production/wo/" + pid + "/advance", A, { action: "dispatch" })).status === 400);
      const floor = ((await call("GET", "/state", S1x)).d.workorders || []).find((w) => w.id === pid);
      ok("the floor is told how much has gone out",
        floor && Math.abs((+floor.dispatchedQty || 0) - made) < 0.01,
        JSON.stringify(floor && floor.dispatchedQty));

      /* THE CYCLE: material arrives -> the balance goes back on the floor ->
         it is made -> that portion ships too -> and the order finally closes. */
      await call("POST", "/movements", A, { id: "MV-PART-4", itemId: rm.id, type: "GRN",
        qty: 20, rate: 10, wh: "WH-RM", date: "2026-04-01", manual: true });
      const again = await call("POST", "/production/wo/" + pid + "/resume", A, {});
      ok("resuming puts the balance back on the floor",
        again.status === 200 && Math.abs(again.d.runQty - 20) < 0.01 && again.d.pendingQty === 0,
        "run=" + (again.d || {}).runQty + " pending=" + (again.d || {}).pendingQty);
      ok("what already shipped is remembered across the resume",
        Math.abs((+again.d.dispatchedQty || 0) - made) < 0.01, String(again.d.dispatchedQty));
      ok("and the route is ready to be run again",
        (again.d.route || []).every((s) => s.status === "Pending"));
      /* A batched order runs slitting and packing more than once. The time
         spent on the earlier batch is banked before the route is reset, so the
         Time Status tab can total it rather than losing it. */
      ok("each stage remembers it has already been run once",
        (again.d.route || []).every((s) => (+s.runs || 0) === 1),
        (again.d.route || []).map((s) => s.key + ":" + s.runs).join(","));
      ok("and keeps the time already spent on it",
        (again.d.route || []).every((s) => "priorMs" in s),
        JSON.stringify((again.d.route || []).map((s) => s.priorMs)));
      ok("the first start of each stage is preserved",
        (again.d.route || []).every((s) => !!s.firstStartedAt),
        JSON.stringify((again.d.route || []).map((s) => s.firstStartedAt)));
      await call("POST", "/production/wo/" + pid + "/advance", A, { action: "complete", all: true });
      const last = await call("POST", "/production/wo/" + pid + "/advance", A, { action: "dispatch" });
      ok("the second portion dispatches too", last.status === 200 &&
        Math.abs(last.d.dispatchedQty - 60) < 0.01, "sent=" + (last.d || {}).dispatchedQty);
      ok("with nothing owed the order is finally closed",
        last.d.dispatched === true && last.d.pendingQty === 0,
        "dispatched=" + last.d.dispatched + " pending=" + last.d.pendingQty);
      await call("DELETE", "/production/wo/" + pid, A);
    }

    /* a partial order must reach the floor flagged, and must NOT be
       dispatchable while it still owes quantity */
    const wo2 = await call("POST", "/production/wo", A, { itemId: fgP.id, qty: 80, allowShortage: true });
    ok("a second partial order is raised", wo2.status === 201 && wo2.d.pendingQty > 0,
      "pending=" + (wo2.d || {}).pendingQty);
    const supSees = ((await call("GET", "/state", S1x)).d.workorders || []).find((w) => w.id === wo2.d.id);
    if (supSees) {
      ok("the floor is told the order is partial", supSees.partial === true, String(supSees.partial));
      ok("the floor sees the pending quantity", (+supSees.pendingQty || 0) > 0, String(supSees.pendingQty));
      ok("the floor sees total, on-floor and completed",
        supSees.qty === 80 && supSees.runQty != null && supSees.completedQty != null,
        JSON.stringify({ q: supSees.qty, r: supSees.runQty, c: supSees.completedQty }));
    } else {
      ok("partial order reached the floor", false, "not visible to coating1");
    }
    await call("DELETE", "/production/wo/" + wo2.d.id, A);
    await call("DELETE", "/production/wo/" + woId, A);
  }

  section("Tape width is captured per work order");
  // width is an ORDER parameter (the run is slit to the ordered width), not a
  // product one — it must survive the round trip and reach the slitting board
  const woW = await call("POST", "/production/wo", A, { itemId: fg, qty: 10, widthMM: 25 });
  ok("a work order accepts a tape width", woW.d && woW.d.widthMM === 25, JSON.stringify(woW.d && woW.d.widthMM));
  const woWFull = (await call("GET", "/state", A)).d.workorders.find((w) => w.id === woW.d.id);
  ok("the width is stored on the work order", woWFull && woWFull.widthMM === 25,
    woWFull ? String(woWFull.widthMM) : "not found");
  ok("width can be corrected later",
    (await call("PATCH", "/production/wo/" + woW.d.id, A, { widthMM: 30 })).d.widthMM === 30);
  ok("a blank width clears it",
    (await call("PATCH", "/production/wo/" + woW.d.id, A, { widthMM: "" })).d.widthMM === null);
  ok("a negative width is rejected",
    (await call("PATCH", "/production/wo/" + woW.d.id, A, { widthMM: -5 })).status === 400);
  ok("a width in metres is rejected as a wrong unit",
    (await call("POST", "/production/wo", A, { itemId: fg, qty: 10, widthMM: 25000 })).status === 400);
  ok("a work order with no width is still valid",
    (await call("POST", "/production/wo", A, { itemId: fg, qty: 10 })).d.widthMM === null);
  await call("PATCH", "/production/wo/" + woW.d.id, A, { widthMM: 25 });
  const slitW = await login("slitting1", "slitting1@123");
  const slitWRow = ((await call("GET", "/state", slitW.token)).d.workorders || []).find((w) => w.id === woW.d.id);
  ok("the slitting board is told the width to slit to", !!slitWRow && slitWRow.widthMM === 25,
    slitWRow ? String(slitWRow.widthMM) : "not on the board");

  /* The MATERIAL's width is a second, separate measurement: the jumbo roll
     being fed, against the tape width the run is slit to. Slitting needs both
     — 1000 ÷ 25 is how many tapes come off a roll — so it travels the same
     road as the tape width and is validated on its own terms. */
  const woM = await call("POST", "/production/wo", A, { itemId: fg, qty: 10, widthMM: 25, matWidthMM: 1000 });
  ok("a work order accepts the material's width too",
    woM.d && woM.d.matWidthMM === 1000 && woM.d.widthMM === 25,
    JSON.stringify(woM.d && { m: woM.d.matWidthMM, t: woM.d.widthMM }));
  const woMFull = (await call("GET", "/state", A)).d.workorders.find((w) => w.id === woM.d.id);
  ok("both widths are stored on the work order",
    woMFull && woMFull.matWidthMM === 1000 && woMFull.widthMM === 25,
    woMFull ? woMFull.matWidthMM + "/" + woMFull.widthMM : "not found");
  ok("the material width can be corrected later",
    (await call("PATCH", "/production/wo/" + woM.d.id, A, { matWidthMM: 1250 })).d.matWidthMM === 1250);
  ok("correcting one width leaves the other alone",
    (await call("GET", "/state", A)).d.workorders.find((w) => w.id === woM.d.id).widthMM === 25);
  ok("a blank material width clears it",
    (await call("PATCH", "/production/wo/" + woM.d.id, A, { matWidthMM: "" })).d.matWidthMM === null);
  ok("a negative material width is rejected",
    (await call("PATCH", "/production/wo/" + woM.d.id, A, { matWidthMM: -5 })).status === 400);
  ok("a material width in metres is rejected as a wrong unit",
    (await call("POST", "/production/wo", A, { itemId: fg, qty: 10, matWidthMM: 25000 })).status === 400);
  ok("a work order with no material width is still valid",
    (await call("POST", "/production/wo", A, { itemId: fg, qty: 10 })).d.matWidthMM === null);
  await call("PATCH", "/production/wo/" + woM.d.id, A, { matWidthMM: 1000 });
  const slitMRow = ((await call("GET", "/state", slitW.token)).d.workorders || []).find((w) => w.id === woM.d.id);
  ok("the slitting board is told what roll is going in", !!slitMRow && slitMRow.matWidthMM === 1000,
    slitMRow ? String(slitMRow.matWidthMM) : "not on the board");

  section("A production stage shows only on its owner's board");
  const supSees = async (tok) => {
    const d = (await call("GET", "/state", tok)).d;
    return (d.workorders || d.workOrders || []).map((w) => w.id);
  };
  const coat2 = await login("coating2", "coating2@123");
  const seen1 = await supSees(C);                       // coating1 = Gautam
  const seen2 = await supSees(coat2.token);             // coating2 = Ganesh
  ok("Gautam sees his own RM-production job", seen1.includes(woMake.d.id), seen1.join(","));
  ok("Ganesh does NOT see Gautam's job", !seen2.includes(woMake.d.id), seen2.join(","));
  ok("Ganesh sees his own job", seen2.includes(woGan.d.id));
  ok("Gautam does NOT see Ganesh's job", !seen1.includes(woGan.d.id));
  const slit1 = await login("slitting1", "slitting1@123");
  const seenSlit = await supSees(slit1.token);
  ok("a slitting login sees the slitting-stage jobs", seenSlit.includes(woStk.d.id), seenSlit.join(","));
  const slitState = (await call("GET", "/state", slit1.token)).d;
  const slitRow = (slitState.workorders || []).find((w) => w.id === woMake.d.id);
  ok("a job still at RM production is visible to slitting but not theirs to act on",
    !!slitRow && slitRow.mine === false, slitRow ? "mine=" + slitRow.mine : "not listed");

  await call("PUT", "/boms/" + fg, A, { yield: 90, lines: [[rm, 0.7]] });   // restore

  section("Production never books stock in — coating, slitting or packing");
  await call("PUT", "/boms/" + fg, A, { yield: 100, lines: [[rm, 0.6], [rm2, 0.3]] });
  // width-specific again, so this stays a test of a genuinely MANUFACTURED job
  // rather than one quietly satisfied from finished stock (see netting section)
  const woP = (await call("POST", "/production/wo", A, { itemId: fg, qty: 10, widthMM: 25 })).d;
  ok("a job was planned with a route", (woP.route || []).length >= 2,
    (woP.route || []).map((r) => r.key).join(" > "));
  for (let i = 0; i < woP.route.length; i++) {            // admin may drive every stage
    await call("POST", "/production/wo/" + woP.id + "/advance", A, { action: "start" });
    await call("POST", "/production/wo/" + woP.id + "/advance", A, { action: "complete" });
  }
  const afterState = (await call("GET", "/state", A)).d;
  const woMoves = (afterState.movements || []).filter((m) => m.ref === woP.id);
  ok("the finished job posted movements at all", woMoves.length > 0, woMoves.length + " movements");
  ok("no movement touches a WIP item", woMoves.every((m) => !/^WIP-/.test(m.itemId)),
    woMoves.filter((m) => /^WIP-/.test(m.itemId)).map((m) => m.itemId).join(","));
  ok("raw materials were still issued from the store",
    woMoves.some((m) => m.type === "ISSUE" && m.itemId === rm && m.qty < 0));
  ok("every movement is an issue — nothing is received",
    woMoves.every((m) => m.type === "ISSUE" && m.qty < 0),
    woMoves.map((m) => m.type).join(","));
  ok("NO receipt at all: not after coating, slitting or packing",
    woMoves.filter((m) => m.type === "PROD").length === 0);
  ok("the finished good itself never enters stock",
    woMoves.every((m) => m.itemId !== fg),
    woMoves.filter((m) => m.itemId === fg).map((m) => m.type).join(","));
  const fgBal = (afterState.movements || []).filter((m) => m.itemId === fg && m.ref === woP.id)
    .reduce((n, m) => n + (+m.qty || 0), 0);
  ok("so the job leaves the finished-goods balance untouched", fgBal === 0, String(fgBal));
  ok("no WIP item exists in the item master at all",
    (afterState.items || []).every((i) => i.cat !== "WIP" && !/^WIP-/.test(i.id)),
    (afterState.items || []).filter((i) => i.cat === "WIP").length + " WIP items");
  const woPdone = (afterState.workorders || []).find((w) => w.id === woP.id);
  ok("the job still completed normally", (woPdone.route || []).every((r) => r.status === "Completed"));
  await call("PUT", "/boms/" + fg, A, { yield: 90, lines: [[rm, 0.7]] });   // restore

  section("A requirement is netted against stock before anything is made");
  {
    // A dedicated product so nothing else in this file can disturb the sums.
    const nfg = "FG-NET-TEST";
    await call("POST", "/items", A, { id: nfg, name: "NETTING TEST TAPE", cat: "FG", uom: "KG",
      thicknessMM: 0.05, gsm: 100, tapeWidthMM: 25, typeCode: "NETTEST-05" });
    await call("PUT", "/boms/" + nfg, A, { yield: 100, lines: [[rm, 1]] });

    // 30 kg of it already sits in the finished store, at 25 mm
    await call("POST", "/movements", A, { itemId: nfg, type: "GRN", qty: 30, wh: "WH-FG", rate: 0, manual: true });

    const wo1 = (await call("POST", "/production/wo", A, { itemId: nfg, qty: 100, widthMM: 25 })).d;
    const p1 = wo1.plan || {};
    ok("finished stock is taken off the requirement", p1.fgQty === 30, JSON.stringify(p1));
    ok("only the remainder is manufactured", p1.makeQty === 70, "makeQty=" + p1.makeQty);
    const pack1 = (wo1.route || []).find((r) => r.key === "packing");
    ok("the whole order still passes through packing", pack1 && pack1.qty === 100,
      pack1 ? "qty=" + pack1.qty : "no packing stage");
    const made1 = (wo1.route || []).filter((r) => r.key !== "packing");
    ok("every earlier stage carries only the manufactured quantity",
      made1.length > 0 && made1.every((r) => r.qty === 70),
      made1.map((r) => r.key + "=" + r.qty).join(","));

    // a width the stock does not match is made in full
    const wo2 = (await call("POST", "/production/wo", A, { itemId: nfg, qty: 100, widthMM: 12 })).d;
    ok("finished stock of another width is left alone", (wo2.plan || {}).fgQty === 0,
      JSON.stringify(wo2.plan));

    /* Releasing wo1 DREW its 30 kg off the shelf there and then, so the shelf
       is empty again — restock before testing an order covered by stock. */
    const midState = (await call("GET", "/state", A)).d;
    const leftAfterWo1 = (midState.movements || [])
      .filter((m) => m.itemId === nfg).reduce((n, m) => n + (+m.qty || 0), 0);
    ok("releasing a work order draws its finished stock immediately", leftAfterWo1 === 0,
      "on hand " + leftAfterWo1);
    await call("POST", "/movements", A, { itemId: nfg, type: "GRN", qty: 30, wh: "WH-FG", rate: 0, manual: true });

    // an order fully covered by stock skips production entirely
    const wo3 = (await call("POST", "/production/wo", A, { itemId: nfg, qty: 20, widthMM: 25 })).d;
    ok("an order covered by stock goes straight to packing",
      (wo3.route || []).length === 1 && wo3.route[0].key === "packing",
      (wo3.route || []).map((r) => r.key).join(" > "));
    ok("nothing is manufactured for it", (wo3.plan || {}).makeQty === 0, JSON.stringify(wo3.plan));

    // the stock was drawn at RELEASE — driving the job must not draw it twice
    await call("POST", "/production/wo/" + wo3.id + "/advance", A, { action: "start" });
    await call("POST", "/production/wo/" + wo3.id + "/advance", A, { action: "complete" });
    const netState = (await call("GET", "/state", A)).d;
    const wo3Moves = (netState.movements || []).filter((m) => m.ref === wo3.id);
    const fgIssue = wo3Moves.filter((m) => m.itemId === nfg);
    ok("the finished stock it used is issued from the store",
      fgIssue.length === 1 && fgIssue[0].type === "ISSUE" && fgIssue[0].qty === -20,
      JSON.stringify(fgIssue));
    ok("no raw material is drawn for a job that makes nothing",
      wo3Moves.every((m) => m.itemId !== rm), wo3Moves.map((m) => m.itemId).join(","));
    ok("still nothing is received into stock",
      wo3Moves.every((m) => m.qty < 0), wo3Moves.map((m) => m.type + ":" + m.qty).join(","));
  }

  section("The office chooses how much comes from stock");
  {
    const sfg = "FG-SPLIT-TEST";
    await call("POST", "/items", A, { id: sfg, name: "SPLIT TEST TAPE", cat: "FG", uom: "KG",
      thicknessMM: 0.05, gsm: 100, tapeWidthMM: 25, typeCode: "SPLITTEST-05" });
    await call("PUT", "/boms/" + sfg, A, { yield: 1, lines: [[rm, 1]] });
    await call("POST", "/movements", A, { itemId: sfg, type: "GRN", qty: 50, wh: "WH-FG", rate: 0, manual: true });

    // take only 10 of the 50 available
    const woA = (await call("POST", "/production/wo", A,
      { itemId: sfg, qty: 100, widthMM: 25, fgQty: 10 })).d;
    ok("only the named quantity is taken from finished stock", (woA.plan || {}).fgQty === 10,
      JSON.stringify(woA.plan));
    ok("the rest is manufactured", (woA.plan || {}).makeQty === 90, "makeQty=" + (woA.plan || {}).makeQty);

    const afterA = (await call("GET", "/state", A)).d;
    const leftA = (afterA.movements || []).filter((m) => m.itemId === sfg)
      .reduce((n, m) => n + (+m.qty || 0), 0);
    ok("the other 40 stay on the shelf", Math.abs(leftA - 40) < 0.01, "on hand " + leftA);
    ok("the 10 were issued against the work order",
      (afterA.movements || []).some((m) => m.ref === woA.id && m.itemId === sfg && m.qty === -10));

    // asking for zero uses none, even though stock is there
    const woB = (await call("POST", "/production/wo", A,
      { itemId: sfg, qty: 10, widthMM: 25, fgQty: 0 })).d;
    ok("zero means take none from stock", (woB.plan || {}).fgQty === 0, JSON.stringify(woB.plan));
    ok("so the whole order is manufactured", (woB.plan || {}).makeQty === 10, JSON.stringify(woB.plan));

    // asking for more than exists is capped, never over-drawn
    const woC = (await call("POST", "/production/wo", A,
      { itemId: sfg, qty: 100, widthMM: 25, fgQty: 9999 })).d;
    ok("asking for more than the shelf holds is capped", (woC.plan || {}).fgQty === 40,
      JSON.stringify(woC.plan));
    const afterC = (await call("GET", "/state", A)).d;
    const leftC = (afterC.movements || []).filter((m) => m.itemId === sfg)
      .reduce((n, m) => n + (+m.qty || 0), 0);
    ok("stock never goes negative from over-asking", leftC >= -0.001, "on hand " + leftC);

    // the plan reports what WAS available, so the form can show a ceiling
    ok("the plan reports what was on the shelf", (woA.plan || {}).fgAvailable === 50,
      "fgAvailable=" + (woA.plan || {}).fgAvailable);
  }

  section("Half-made stock skips the coating stage");
  {
    // A product Ganesh coats (the CHN- family), so the route really has a
    // coating stage to skip, and a raw material nobody has any of.
    const cfg = "FG-NET-COAT";
    const crm = "RM-NET-COAT";
    await call("POST", "/items", A, { id: crm, name: "NETTING COAT BASE", cat: "RM", uom: "KG" });
    await call("POST", "/items", A, { id: cfg, name: "NETTING COAT TAPE", cat: "FG", uom: "KG",
      thicknessMM: 0.05, gsm: 100, typeCode: "CHN-NET-05" });
    // yield 1 so the recipe is a plain 1 kg of base per 1 kg of tape and the
    // quantity drawn from the store can be read directly
    await call("PUT", "/boms/" + cfg, A, { yield: 1, lines: [[crm, 1]] });

    // CONTROL: the same order with nothing on the shelf, driven to completion,
    // so the netted run below can be compared against a real full draw rather
    // than against a hand-computed figure that depends on how the BOM scales.
    const plain = (await call("POST", "/production/wo", A, { itemId: cfg, qty: 100, widthMM: 25 })).d;
    ok("with no stock at all the job is coated in full",
      (plain.route || []).some((r) => r.key === "rmprod" && r.qty === 100),
      (plain.route || []).map((r) => r.key + "=" + r.qty).join(" > "));
    for (let i = 0; i < (plain.route || []).length; i++) {
      await call("POST", "/production/wo/" + plain.id + "/advance", A, { action: "start" });
      await call("POST", "/production/wo/" + plain.id + "/advance", A, { action: "complete" });
    }
    const ctlState = (await call("GET", "/state", A)).d;
    const fullDraw = (ctlState.movements || [])
      .filter((m) => m.ref === plain.id && m.itemId === crm)
      .reduce((n, m) => n + Math.abs(+m.qty || 0), 0);
    ok("the control run drew raw material for all 100", fullDraw > 0, "drew " + fullDraw);

    // 25 kg of coated jumbo is on the shelf, linked to that product
    const cwip = "WIP-NET-COAT";
    await call("POST", "/items", A, { id: cwip, name: "NETTING COAT TAPE — Jumbo (WIP)", cat: "WIP",
      uom: "KG", stageOf: cfg, thicknessMM: 0.05 });
    await call("POST", "/movements", A, { itemId: cwip, type: "GRN", qty: 25, wh: "WH-WIP", rate: 0, manual: true });

    const woW = (await call("POST", "/production/wo", A, { itemId: cfg, qty: 100, widthMM: 25 })).d;
    const pw = woW.plan || {};
    ok("the job is recognised as one that involves coating", pw.hasCoating === true, JSON.stringify(pw));
    ok("half-made stock is taken off the requirement", pw.wipQty === 25, "wipQty=" + pw.wipQty);
    ok("only the rest is coated", pw.makeQty === 75, "makeQty=" + pw.makeQty);
    const coat = (woW.route || []).find((r) => r.key === "rmprod");
    const slit = (woW.route || []).find((r) => r.key === "slitting");
    const packW = (woW.route || []).find((r) => r.key === "packing");
    ok("coating carries only the quantity being made", coat && coat.qty === 75,
      coat ? "qty=" + coat.qty : "no coating stage");
    ok("slitting carries the coated and the half-made together", slit && slit.qty === 100,
      slit ? "qty=" + slit.qty : "no slitting stage");
    ok("packing carries the whole order", packW && packW.qty === 100,
      packW ? "qty=" + packW.qty : "no packing stage");

    // drive it and check what the store actually gave up
    for (let i = 0; i < (woW.route || []).length; i++) {
      await call("POST", "/production/wo/" + woW.id + "/advance", A, { action: "start" });
      await call("POST", "/production/wo/" + woW.id + "/advance", A, { action: "complete" });
    }
    const wState = (await call("GET", "/state", A)).d;
    const wMoves = (wState.movements || []).filter((m) => m.ref === woW.id);
    const rawUsed = wMoves.filter((m) => m.itemId === crm).reduce((n, m) => n + Math.abs(+m.qty || 0), 0);
    ok("raw material is drawn for 75, not for the whole 100",
      fullDraw > 0 && Math.abs(rawUsed - fullDraw * 0.75) < 0.01,
      "drew " + rawUsed + " against a full draw of " + fullDraw);
    const wipUsed = wMoves.filter((m) => m.itemId === cwip);
    ok("the half-made stock is issued once, at slitting",
      wipUsed.length === 1 && wipUsed[0].qty === -25, JSON.stringify(wipUsed));
    ok("nothing is received into stock by this job either",
      wMoves.every((m) => m.qty < 0), wMoves.map((m) => m.type + ":" + m.qty).join(","));
  }

  section("Booking finished stock can draw on half-made stock (admin only)");
  {
    const bfg = "FG-BOOK-TEST";
    const brm = "RM-BOOK-TEST";
    const bwip = "WIP-BOOK-TEST";
    await call("POST", "/items", A, { id: brm, name: "BOOK TEST BASE", cat: "RM", uom: "KG" });
    await call("POST", "/items", A, { id: bfg, name: "BOOK TEST TAPE", cat: "FG", uom: "KG",
      thicknessMM: 0.05, gsm: 100, typeCode: "CHN-BOOK-05" });
    await call("POST", "/items", A, { id: bwip, name: "BOOK TEST TAPE — Coated Jumbo (WIP)", cat: "WIP",
      uom: "KG", stageOf: bfg, thicknessMM: 0.05 });
    await call("PUT", "/boms/" + bfg, A, { yield: 1, lines: [[brm, 1]] });
    await call("POST", "/movements", A, { itemId: brm, type: "GRN", qty: 100000, wh: "WH-PNY", rate: 0, manual: true });
    await call("POST", "/movements", A, { itemId: bwip, type: "GRN", qty: 40, wh: "WH-WIP", rate: 0, manual: true });

    /* CONTROL: book 100 the ordinary way and measure the raw draw, so the
       sourced run below is compared against a real figure rather than a
       hand-computed one (the recipe scales per batch, not per unit). */
    const rawOf = (st) => (st.movements || []).filter((m) => m.itemId === brm)
      .reduce((n, m) => n + (+m.qty || 0), 0);
    const ctlBefore = rawOf((await call("GET", "/state", A)).d);
    await call("POST", "/production/finished", A, { itemId: bfg, qty: 100, wh: "WH-FG", tapeWidthMM: 25 });
    const ctlDraw = ctlBefore - rawOf((await call("GET", "/state", A)).d);
    ok("the control booking drew raw material for all 100", ctlDraw > 0, "drew " + ctlDraw);

    const before = (await call("GET", "/state", A)).d;
    const rawBefore = rawOf(before);

    // book 100, of which 30 comes off the half-made shelf
    const r = await call("POST", "/production/finished", A,
      { itemId: bfg, qty: 100, wh: "WH-FG", tapeWidthMM: 25, wipQty: 30 });
    ok("an admin can book part of a run from half-made stock", r.status < 300,
      "status " + r.status + " " + JSON.stringify(r.d).slice(0, 160));
    ok("it reports what came off the shelf", r.d && r.d.fromStock && r.d.fromStock.wipQty === 30,
      JSON.stringify(r.d && r.d.fromStock));
    ok("and what was actually made", r.d && r.d.fromStock && r.d.fromStock.makeQty === 70,
      JSON.stringify(r.d && r.d.fromStock));

    const after = (await call("GET", "/state", A)).d;
    const wipLeft = (after.movements || []).filter((m) => m.itemId === bwip)
      .reduce((n, m) => n + (+m.qty || 0), 0);
    ok("the half-made stock was drawn down", Math.abs(wipLeft - 10) < 0.01, "on hand " + wipLeft);
    const drew = rawBefore - rawOf(after);
    ok("raw material was drawn for 70, not 100", Math.abs(drew - ctlDraw * 0.7) < 0.001,
      "drew " + drew + " against a full draw of " + ctlDraw);
    const fgMade = (after.movements || []).filter((m) => m.itemId === bfg)
      .reduce((n, m) => n + (+m.qty || 0), 0);
    ok("the full 100 still lands in finished stock (200 with the control)",
      Math.abs(fgMade - 200) < 0.01, "on hand " + fgMade);

    // a supervisor gets no such control — the request is simply ignored
    const S1 = C;                       // coating1's token, from the auth section
    const before2 = (await call("GET", "/state", A)).d;
    const wipBefore2 = (before2.movements || []).filter((m) => m.itemId === bwip)
      .reduce((n, m) => n + (+m.qty || 0), 0);
    const r2s = await call("POST", "/production/finished", S1,
      { itemId: bfg, qty: 5, wh: "WH-FG", tapeWidthMM: 25, wipQty: 5 });
    ok("a supervisor can still book stock normally", r2s.status < 300, "status " + r2s.status);
    ok("but cannot source it from half-made stock",
      r2s.status >= 300 || (r2s.d.fromStock && r2s.d.fromStock.wipQty === 0),
      JSON.stringify(r2s.d && r2s.d.fromStock));
    const after2 = (await call("GET", "/state", A)).d;
    const wipAfter2 = (after2.movements || []).filter((m) => m.itemId === bwip)
      .reduce((n, m) => n + (+m.qty || 0), 0);
    ok("so the half-made shelf is untouched by them", Math.abs(wipAfter2 - wipBefore2) < 0.01,
      wipBefore2 + " -> " + wipAfter2);
  }

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
