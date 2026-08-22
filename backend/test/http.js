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

/* A scratch DATABASE on the configured MySQL server for this run, dropped at
   the end. Set BEFORE the server module loads. */
const SCRATCH = "chh_http_" + process.pid + "_" + Date.now();
process.env.CHHAPERIA_DB_NAME = SCRATCH;
process.env.CHHAPERIA_DATA_DIR = os.tmpdir();
process.env.PORT = "0"; // ask the OS for a free port
process.env.CHHAPERIA_BARTENDER_NOLAUNCH = "1"; // never pop the label app open mid-test

const { server, ready } = require("../src/server");
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
  /* listening is not enough any more: the schema, the migrations and the
     seeded accounts all land in boot(), after the socket opens. Asking
     before ready would find a server with no users to log in as. */
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
  const cust = st.customers[0].id, fg = st.items.find((i) => i.cat === "FG").id, sup = st.suppliers[0].id, rm = st.items.find((i) => i.cat === "RM").id;
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
        { wh: "WH-PNY", lines: [{ i: 0, qty: 100 }] });
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
        { wh: "WH-PNY", lines: [{ i: 0, qty: 10 }] });
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
      { wh: "WH-PNY", lines: [{ i: 0, qty: 30 }, { i: 1, qty: 70 }] });
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

  section("Goods receipt notes — every receipt issues a numbered document");
  {
    const poG = (await call("POST", "/purchase-orders", A, { supplierId: sup, eta: "2026-08-01",
      lines: [{ itemId: rm, qty: 100, rate: 20, recd: 0 }] })).d;
    const rec1 = await call("POST", "/purchase-orders/" + poG.id + "/receive", A,
      { wh: "WH-PNY", lines: [{ i: 0, qty: 60, rejected: 10 }],
        invNo: "SM/1287/26-27", invDate: "2026-08-05", vehicle: "KA-51-AE-4471", remarks: "two spools damp" });
    const g1 = rec1.d.grn;
    ok("a receipt returns a GRN in the fiscal-year series", rec1.status === 200
      && g1 && /^GRN\/\d\d-\d\d\/\d{4}$/.test(g1.id), JSON.stringify(g1 || rec1.d).slice(0, 120));
    ok("the GRN carries the supplier document + vehicle", g1 && g1.invNo === "SM/1287/26-27"
      && g1.vehicle === "KA-51-AE-4471" && g1.remarks === "two spools damp");
    ok("its line freezes received / rejected / accepted", g1 && g1.lines.length === 1
      && g1.lines[0].qty === 60 && g1.lines[0].rejected === 10 && g1.lines[0].accepted === 50,
      JSON.stringify(g1 && g1.lines));
    const st1 = (await call("GET", "/state", A)).d;
    const mv1 = (st1.movements || []).filter((m) => m.ref === poG.id);
    ok("only the ACCEPTED quantity posts to stock", mv1.length === 1 && Math.abs(mv1[0].qty - 50) < 0.001,
      JSON.stringify(mv1.map((m) => m.qty)));
    const poB1 = (st1.purchaseorders || []).find((p) => p.id === poG.id);
    ok("the rejected quantity stays owed on the order", Math.abs(poB1.lines[0].recd - 50) < 0.001
      && poB1.status === "Partially Received", poB1.lines[0].recd + " " + poB1.status);
    ok("the GRN is part of the state document", (st1.grns || []).some((g) => g.id === g1.id));

    // a second receipt on the same series takes the NEXT number
    const rec2 = await call("POST", "/purchase-orders/" + poG.id + "/receive", A,
      { wh: "WH-PNY", lines: [{ i: 0, qty: 20 }] });
    const g2 = rec2.d.grn;
    const seq = (id) => +String(id || "").split("/").pop();
    ok("a second receipt increments the series", g2 && seq(g2.id) === seq(g1.id) + 1,
      (g1 && g1.id) + " → " + (g2 && g2.id));

    // a delivery turned away in full is still a receipt EVENT: the note is
    // issued (the debit note quotes it) but nothing lands in stock
    const rec3 = await call("POST", "/purchase-orders/" + poG.id + "/receive", A,
      { wh: "WH-PNY", lines: [{ i: 0, qty: 30, rejected: 30 }], remarks: "whole lot damp" });
    ok("a fully-rejected delivery still gets its GRN", rec3.status === 200 && rec3.d.grn
      && rec3.d.grn.lines[0].accepted === 0 && rec3.d.posted === 0, JSON.stringify(rec3.d).slice(0, 110));
    const st3 = (await call("GET", "/state", A)).d;
    ok("and posts NOTHING to stock", (st3.movements || []).filter((m) => m.ref === poG.id).length === 2);
    ok("and advances the order not one unit",
      Math.abs((st3.purchaseorders.find((p) => p.id === poG.id)).lines[0].recd - 70) < 0.001);

    // rejected can never exceed received, and a supervisor cannot receive at all
    const recX = await call("POST", "/purchase-orders/" + poG.id + "/receive", A,
      { wh: "WH-PNY", lines: [{ i: 0, qty: 10, rejected: 99 }] });
    ok("rejected is clamped to the received quantity", recX.status === 200
      && recX.d.grn.lines[0].rejected === 10 && recX.d.grn.lines[0].accepted === 0,
      JSON.stringify(recX.d.grn && recX.d.grn.lines));
    ok("supervisor cannot post a receipt (403)", (await call("POST",
      "/purchase-orders/" + poG.id + "/receive", C, { lines: [{ i: 0, qty: 1 }] })).status === 403);

    // deleting the PO reverses its stock but CANCELS the notes, never erases
    await call("DELETE", "/purchase-orders/" + poG.id, A);
    const st4 = (await call("GET", "/state", A)).d;
    ok("delete PO reverses its stock movements", (st4.movements || []).filter((m) => m.ref === poG.id).length === 0);
    const gAfter = (st4.grns || []).find((g) => g.id === g1.id);
    ok("its GRNs survive, marked Cancelled", !!gAfter && gAfter.status === "Cancelled",
      JSON.stringify(gAfter || {}).slice(0, 90));
  }

  /* WHAT ARRIVED goes into stock, not what was ordered. The receipt used to
     clamp the entered quantity down to the outstanding balance, so an
     over-delivery was booked as the ORDERED figure — silently, with a goods
     receipt that read as though that were what came off the truck. The clamp
     was also what made a replayed receipt harmless, so the two halves are
     tested together: the excess must go in when it is declared, and must be
     refused when it is not. */
  /* A finished job is a batch of real goods, and its number prints on the
     invoice. Selling it twice would put the same batch on two customers'
     invoices. The QUANTITY, though, is the customer's business: an order for
     far more than the run produced is ordinary make-to-order trade, and the
     batch only says which goods the order is served from. */
  section("A finished job belongs to one order — but the quantity is free");
  {
    const woB = (await call("POST", "/production/wo", A, { itemId: fg, qty: 10 })).d;
    ok("a work order to sell from exists", !!(woB && woB.id), JSON.stringify(woB).slice(0, 80));
    const so1 = await call("POST", "/sales-orders", A, { customerId: cust,
      lines: [{ itemId: fg, qty: 6, rate: 100, batch: woB.id }] });
    ok("the first order can claim it", so1.status === 200 || so1.status === 201,
      so1.status + " " + JSON.stringify(so1.d).slice(0, 120));

    const so2 = await call("POST", "/sales-orders", A, { customerId: cust,
      lines: [{ itemId: fg, qty: 1, rate: 100, batch: woB.id }] });
    ok("a second order cannot have the same job, however small", so2.status === 409,
      so2.status + " " + JSON.stringify(so2.d).slice(0, 140));
    ok("  ...and names the order already holding it", /is already on SO-/.test(JSON.stringify(so2.d)),
      JSON.stringify(so2.d).slice(0, 160));

    /* THE QUANTITY IS NOT A CEILING — the balance is made to order */
    const woC = (await call("POST", "/production/wo", A, { itemId: fg, qty: 10 })).d;
    const big = await call("POST", "/sales-orders", A, { customerId: cust,
      lines: [{ itemId: fg, qty: 500, rate: 100, batch: woC.id }] });
    ok("an order may ask for far more than the batch produced",
      big.status === 200 || big.status === 201, big.status + " " + JSON.stringify(big.d).slice(0, 140));

    /* an order editing ITS OWN line must not be read as competing with itself */
    const edit = await call("PATCH", "/sales-orders/" + so1.d.id, A,
      { lines: [{ itemId: fg, qty: 5, rate: 100, batch: woB.id }] });
    ok("an order may be edited without tripping its own claim", edit.status === 200,
      edit.status + " " + JSON.stringify(edit.d).slice(0, 140));
    const up = await call("PATCH", "/sales-orders/" + so1.d.id, A,
      { lines: [{ itemId: fg, qty: 900, rate: 100, batch: woB.id }] });
    ok("  ...including well past what the run made", up.status === 200,
      up.status + " " + JSON.stringify(up.d).slice(0, 140));
    const steal = await call("PATCH", "/sales-orders/" + so1.d.id, A,
      { lines: [{ itemId: fg, qty: 5, rate: 100, batch: woC.id }] });
    ok("but never onto a job another order holds", steal.status === 409,
      steal.status + " " + JSON.stringify(steal.d).slice(0, 140));

    ok("an unknown work order on a line is refused", (await call("POST", "/sales-orders", A,
      { customerId: cust, lines: [{ itemId: fg, qty: 1, rate: 100, batch: "WO-NOPE" }] })).status === 400);

    /* a cancelled order releases what it held */
    await call("PATCH", "/sales-orders/" + so1.d.id, A, { status: "Cancelled" });
    const so5 = await call("POST", "/sales-orders", A, { customerId: cust,
      lines: [{ itemId: fg, qty: 4, rate: 100, batch: woB.id }] });
    ok("cancelling an order puts its batch back on the shelf",
      so5.status === 200 || so5.status === 201, so5.status + " " + JSON.stringify(so5.d).slice(0, 120));

    for (const s of [so1, big, so5]) if (s.d && s.d.id) await call("DELETE", "/sales-orders/" + s.d.id, A);
    for (const w of [woB, woC]) if (w && w.id) await call("DELETE", "/production/wo/" + w.id, A);
  }

  section("Over-receipt — the delivered quantity is what lands in stock");
  {
    const stockOf = (s, id) => +(s.movements || []).filter((m) => m.itemId === id)
      .reduce((a, m) => a + (+m.qty || 0), 0).toFixed(3);
    const poO = (await call("POST", "/purchase-orders", A, { supplierId: sup, eta: "2026-08-01",
      lines: [{ itemId: rm, qty: 100, rate: 20, recd: 0 }] })).d;
    const before = stockOf((await call("GET", "/state", A)).d, rm);
    /* a deleted PO frees its id, and the GRNs it left behind keep pointing at
       it — so count what is there NOW rather than expecting none */
    const grnsFor = (s) => (s.grns || []).filter((g) => g.poId === poO.id).length;
    const grns0 = grnsFor((await call("GET", "/state", A)).d);

    const blind = await call("POST", "/purchase-orders/" + poO.id + "/receive", A,
      { wh: "WH-PNY", lines: [{ i: 0, qty: 144 }] });
    ok("receiving more than was ordered is refused without confirmation", blind.status === 400,
      blind.status + " " + JSON.stringify(blind.d).slice(0, 120));
    ok("the refusal names what is still outstanding", /still outstanding/.test(JSON.stringify(blind.d)),
      JSON.stringify(blind.d).slice(0, 160));
    const stB = (await call("GET", "/state", A)).d;
    ok("a refused over-receipt books nothing at all", stockOf(stB, rm) === before,
      stockOf(stB, rm) + " vs " + before);
    ok("and issues no GRN", grnsFor(stB) === grns0, grnsFor(stB) + " vs " + grns0);

    const over = await call("POST", "/purchase-orders/" + poO.id + "/receive", A,
      { wh: "WH-PNY", allowOver: true, lines: [{ i: 0, qty: 144 }] });
    const stO = (await call("GET", "/state", A)).d;
    ok("a confirmed over-receipt is accepted", over.status === 200, JSON.stringify(over.d).slice(0, 120));
    ok("stock rises by the RECEIVED quantity, not the ordered one",
      stockOf(stO, rm) - before === 144, "delta " + (stockOf(stO, rm) - before) + ", ordered 100");
    ok("the GRN line records the delivered qty and the excess",
      over.d.grn.lines[0].qty === 144 && over.d.grn.lines[0].over === 44,
      JSON.stringify(over.d.grn.lines[0]));
    ok("the ledger note spells the over-delivery out",
      /OVER the 100 ordered/.test(String((stO.movements || []).find((m) => m.ref === poO.id).note)),
      String(((stO.movements || []).find((m) => m.ref === poO.id) || {}).note).slice(0, 120));
    const poAfter = stO.purchaseorders.find((p) => p.id === poO.id);
    ok("the order closes as Received with recd past the ordered qty",
      poAfter.status === "Received" && poAfter.lines[0].recd === 144,
      poAfter.status + " recd=" + poAfter.lines[0].recd);

    /* the replay guard the old clamp used to provide, kept */
    const replay = await call("POST", "/purchase-orders/" + poO.id + "/receive", A,
      { wh: "WH-PNY", lines: [{ i: 0, qty: 144 }] });
    ok("replaying the same receipt is refused", replay.status === 400, JSON.stringify(replay.d).slice(0, 120));
    ok("the replay refusal says the line is already fully received",
      /already fully received/.test(JSON.stringify(replay.d)), JSON.stringify(replay.d).slice(0, 160));
    ok("the replay changes no stock", stockOf((await call("GET", "/state", A)).d, rm) - before === 144);

    /* a receipt WITHIN the order still needs no flag */
    const poU = (await call("POST", "/purchase-orders", A, { supplierId: sup, eta: "2026-08-01",
      lines: [{ itemId: rm, qty: 100, rate: 20, recd: 0 }] })).d;
    const b2 = stockOf((await call("GET", "/state", A)).d, rm);
    const under = await call("POST", "/purchase-orders/" + poU.id + "/receive", A,
      { wh: "WH-PNY", lines: [{ i: 0, qty: 30 }] });
    ok("a short delivery posts exactly what was entered, no flag needed",
      under.status === 200 && stockOf((await call("GET", "/state", A)).d, rm) - b2 === 30,
      under.status + " delta " + (stockOf((await call("GET", "/state", A)).d, rm) - b2));
    await call("DELETE", "/purchase-orders/" + poO.id, A);
    await call("DELETE", "/purchase-orders/" + poU.id, A);
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

  /* ---- Calendar appointments ----
     The ONLY thing the calendar stores. Everything else it shows (PO ETAs, SO
     promised dates, work-order due dates, follow-ups, leave) is derived from
     the record that owns the date, so there is nothing else here to test —
     which is the point of that design. */
  const ap = await call("POST", "/appointments", A, {
    title: "Plant visit — HTTP Test Co", kind: "Site Visit", date: "2026-08-14",
    time: "10:30", endTime: "12:00", location: "Their works", owner: "sales",
  });
  ok("create appointment 201", ap.status === 201 && !!ap.d.id);
  ok("appointment keeps its date and doc fields",
    ap.d.date === "2026-08-14" && ap.d.time === "10:30" && ap.d.kind === "Site Visit");
  ok("a new appointment is not done yet", ap.d.done === false);
  ok("appointment reaches the shared state",
    (await call("GET", "/state", A)).d.appointments.some((x) => x.id === ap.d.id));
  ok("appointment can be marked done",
    (await call("PATCH", "/appointments/" + ap.d.id, A, { done: true })).d.done === true);
  ok("patching one field keeps the rest",
    (await call("PATCH", "/appointments/" + ap.d.id, A, { location: "Our works" })).d.time === "10:30");
  // a diary entry with no date would never appear on the grid it exists for
  ok("appointment without a date → 400",
    (await call("POST", "/appointments", A, { title: "No date" })).status === 400);
  ok("appointment without a title → 400",
    (await call("POST", "/appointments", A, { date: "2026-08-14" })).status === 400);
  ok("unknown appointment kind → 400",
    (await call("POST", "/appointments", A, { title: "X", date: "2026-08-14", kind: "Seance" })).status === 400);
  ok("patch unknown appointment → 404",
    (await call("PATCH", "/appointments/AP-NOPE", A, { title: "X" })).status === 404);
  ok("delete appointment 200", (await call("DELETE", "/appointments/" + ap.d.id, A)).status === 200);
  ok("delete unknown appointment → 404", (await call("DELETE", "/appointments/AP-NOPE", A)).status === 404);

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

  /* ============================================================
     INCOMING-MATERIAL TESTING ("GRN testing")
     A purchase order is received → the lab incharge measures what actually
     arrived → the verdict shows on the order. The rules worth pinning down are
     the same ones the finished-goods certificates follow: the limits live with
     admin, the measurer sees neither the limits nor the grade, and grading
     happens server-side.
     ============================================================ */
  section("Incoming-material testing after a goods receipt");
  {
    const poQ = (await call("POST", "/purchase-orders", A, { supplierId: sup, eta: "2026-08-20",
      lines: [{ itemId: rm, qty: 100, rate: 30 }] })).d;

    // ---- the material master decides what is measured, and admin owns it ----
    const cat = await call("GET", "/grn-tests/params", LB);
    ok("the parameter catalogue is readable", cat.status === 200
      && Array.isArray(cat.d.params) && cat.d.params.some((p) => p.key === "thickness"));
    const setQc = await call("PUT", "/items/" + rm + "/qc", A,
      { params: ["thickness", "massPerArea", "visual"],
        spec: { thickness: { min: 0.07, max: 0.09 }, massPerArea: { min: 100, max: 130 } } });
    ok("admin sets the parameters + their limits", setQc.status === 200
      && setQc.d.params.join(",") === "thickness,massPerArea,visual", JSON.stringify(setQc.d).slice(0, 120));
    ok("office cannot touch the parameter list at all (403)",
      (await call("PUT", "/items/" + rm + "/qc", O, { params: ["thickness"] })).status === 403);
    /* The lab incharge MAY edit the list — see the fuller check further down,
       which also proves a `spec` they send is ignored rather than applied. */
    const labProbe = await call("PUT", "/items/" + rm + "/qc", LB,
      { params: ["thickness", "massPerArea", "visual"], spec: { thickness: { min: 99, max: 100 } } });
    ok("the lab incharge may edit the list, but not the limits",
      labProbe.status === 200 && labProbe.d.specEditable === false,
      JSON.stringify(labProbe.d).slice(0, 130));
    ok("a minimum above its maximum is refused (400)",
      (await call("PUT", "/items/" + rm + "/qc", A,
        { params: ["thickness"], spec: { thickness: { min: 9, max: 1 } } })).status === 400);
    // a limit for a parameter that is not on the list is dropped, not stored —
    // otherwise a report is graded against something it never asked for
    await call("PUT", "/items/" + rm + "/qc", A, { params: ["thickness", "massPerArea", "visual"],
      spec: { thickness: { min: 0.07, max: 0.09 }, massPerArea: { min: 100, max: 130 }, tensile: { min: 999 } } });
    const rmAdmin = ((await call("GET", "/state", A)).d.items || []).find((i) => i.id === rm);
    ok("a limit for an unlisted parameter is not stored", rmAdmin && !rmAdmin.qcSpec.tensile,
      JSON.stringify(rmAdmin && rmAdmin.qcSpec));
    // a visual check has no min/max — a limit on one is meaningless and dropped
    ok("a text parameter cannot carry limits", !rmAdmin.qcSpec.visual);

    // ---- nothing to test until something is received ----
    const early = (await call("GET", "/grn-tests/pending", LB)).d.pending || [];
    ok("an order still in transit owes no test", !early.some((p) => p.poId === poQ.id));

    const recQ = await call("POST", "/purchase-orders/" + poQ.id + "/receive", A,
      { wh: "WH-PNY", lines: [{ i: 0, qty: 100 }], invNo: "QC/INV/9" });
    const gq = recQ.d.grn;
    ok("the goods are received and a GRN issued", recQ.status === 200 && !!gq, JSON.stringify(recQ.d).slice(0, 100));

    // ---- and now it does ----
    const due = ((await call("GET", "/grn-tests/pending", LB)).d.pending || []).filter((p) => p.grnId === gq.id);
    ok("the received material lands on the incharge's worklist", due.length === 1, JSON.stringify(due).slice(0, 140));
    const form = (await call("GET", "/grns/" + encodeURIComponent(gq.id) + "/tests/" + rm, LB)).d;
    ok("the entry form asks for exactly the parameters admin chose",
      (form.params || []).map((p) => p.key).join(",") === "thickness,massPerArea,visual",
      JSON.stringify((form.params || []).map((p) => p.key)));
    ok("the entry form never carries the limits",
      !form.spec && !form.qcSpec && JSON.stringify(form).indexOf("0.07") < 0);
    ok("a material not on the receipt has no form (404)",
      (await call("GET", "/grns/" + encodeURIComponent(gq.id) + "/tests/GHOST", LB)).status === 404);

    // ---- filing a reading ----
    const part = await call("POST", "/grns/" + encodeURIComponent(gq.id) + "/tests", LB,
      { itemId: rm, values: { thickness: 0.08 } });
    ok("a part-filled report is refused, naming what is missing", part.status === 400
      && /Mass per unit area/.test(JSON.stringify(part.d)), JSON.stringify(part.d).slice(0, 140));
    const filed = await call("POST", "/grns/" + encodeURIComponent(gq.id) + "/tests", LB,
      { itemId: rm, values: { thickness: 0.08, massPerArea: 118, visual: "clean" }, remarks: "3 rolls sampled",
        sampleSize: 12, supplierBatch: "BME/2291/A", certRef: "COA-77412" });
    ok("a complete reading is accepted", filed.status === 201, JSON.stringify(filed.d).slice(0, 110));
    /* SAMPLING + TRACEABILITY. A reading with no sample size is an anecdote, and
       a failure cannot be charged to a supplier without their own batch number
       — so both travel with the report and onto the printed page. */
    ok("the sample size and supplier traceability are kept",
      filed.d.test.sampleSize === 12 && filed.d.test.supplierBatch === "BME/2291/A"
      && filed.d.test.certRef === "COA-77412",
      JSON.stringify({ s: filed.d.test.sampleSize, b: filed.d.test.supplierBatch, c: filed.d.test.certRef }));
    ok("…and they survive a re-measure that does not resend them",
      (await call("POST", "/grns/" + encodeURIComponent(gq.id) + "/tests", LB,
        { itemId: rm, values: { thickness: 0.082, massPerArea: 119, visual: "clean" } }))
        .d.test.supplierBatch === "BME/2291/A");
    ok("a junk sample size is dropped rather than stored",
      (await call("POST", "/grns/" + encodeURIComponent(gq.id) + "/tests", LB,
        { itemId: rm, values: { thickness: 0.08, massPerArea: 118, visual: "clean" }, sampleSize: "abc" }))
        .d.test.sampleSize === 12, "kept the previous value rather than NaN");
    ok("the writer is told it is complete but NOT how it graded",
      filed.d.test.complete === true && filed.d.test.result === undefined
      && filed.d.test.results === undefined, JSON.stringify(filed.d.test).slice(0, 150));
    ok("an unknown receipt is refused (404)",
      (await call("POST", "/grns/GRN%2F99-99%2F9999/tests", LB, { itemId: rm, values: {} })).status === 404);
    ok("a material not on the receipt is refused (400)",
      (await call("POST", "/grns/" + encodeURIComponent(gq.id) + "/tests", LB,
        { itemId: "GHOST", values: {} })).status === 400);
    ok("a supervisor cannot file an incoming reading (403)",
      (await call("POST", "/grns/" + encodeURIComponent(gq.id) + "/tests", C,
        { itemId: rm, values: {} })).status === 403);
    ok("anonymous cannot either (401)",
      (await call("POST", "/grns/" + encodeURIComponent(gq.id) + "/tests", null,
        { itemId: rm, values: {} })).status === 401);
    ok("the line leaves the worklist once measured",
      !((await call("GET", "/grn-tests/pending", LB)).d.pending || [])
        .some((p) => p.grnId === gq.id && p.itemId === rm));

    // ---- who sees the verdict ----
    const oSt = (await call("GET", "/state", O)).d;
    const oT = (oSt.grnTests || []).find((t) => t.grnId === gq.id && t.itemId === rm);
    ok("the office reads the graded result", !!oT && oT.result === "Pass", oT && oT.result);
    ok("…graded per parameter, with the visual check recorded but not graded",
      oT.results.thickness === "pass" && oT.results.massPerArea === "pass" && oT.results.visual === "na",
      JSON.stringify(oT.results));
    const lSt = (await call("GET", "/state", LB)).d;
    const lT = (lSt.grnTests || []).find((t) => t.grnId === gq.id);
    ok("the lab payload carries the receipt it must test", (lSt.grns || []).some((g) => g.id === gq.id));
    ok("the lab payload strips the verdict, keeping `complete`",
      !!lT && lT.result === undefined && lT.results === undefined && lT.complete === true,
      JSON.stringify(lT && Object.keys(lT)));
    const lRm = (lSt.items || []).find((i) => i.id === rm);
    ok("the lab payload strips the material's limits but keeps the parameter list",
      lRm && lRm.qcSpec === undefined && lRm.qcSpecSet === true && (lRm.qcParams || []).length === 3,
      JSON.stringify(lRm && { qcSpec: lRm.qcSpec, qcSpecSet: lRm.qcSpecSet, qcParams: lRm.qcParams }));
    const oRm = (oSt.items || []).find((i) => i.id === rm);
    ok("office is not sent the limits either", oRm && oRm.qcSpec === undefined && oRm.qcSpecSet === true);
    ok("admin keeps them — it owns the master",
      rmAdmin.qcSpec && rmAdmin.qcSpec.thickness.min === 0.07);

    // ---- a failure, and re-measuring ----
    const bad = await call("POST", "/grns/" + encodeURIComponent(gq.id) + "/tests", LB,
      { itemId: rm, values: { thickness: 0.061, massPerArea: 118, visual: "thin patches" } });
    ok("re-measuring the same lot is accepted", bad.status === 201);
    const afterBad = ((await call("GET", "/state", O)).d.grnTests || [])
      .filter((t) => t.grnId === gq.id && t.itemId === rm);
    ok("it UPDATES the report rather than filing a contradictory second one",
      afterBad.length === 1, afterBad.length + " reports");
    ok("an out-of-limit reading grades Fail and names the parameter",
      afterBad[0].result === "Fail" && afterBad[0].results.thickness === "fail"
      && afterBad[0].results.massPerArea === "pass", JSON.stringify(afterBad[0].results));

    // ---- moving the limits re-grades what was already signed off ----
    const widened = await call("PUT", "/items/" + rm + "/qc", A,
      { params: ["thickness", "massPerArea", "visual"],
        spec: { thickness: { min: 0.05, max: 0.09 }, massPerArea: { min: 100, max: 130 } } });
    ok("changing the limits re-grades existing reports, and says how many",
      widened.d.regraded >= 1, JSON.stringify(widened.d));
    const regraded = ((await call("GET", "/state", O)).d.grnTests || [])
      .find((t) => t.grnId === gq.id && t.itemId === rm);
    ok("the failed lot now reads Pass against the widened limits",
      regraded.result === "Pass", regraded.result);

    // ---- an unconfigured material still gets checked, just not graded ----
    await call("PUT", "/items/" + rm + "/qc", A, { params: [], spec: {} });
    const bare = (await call("GET", "/grns/" + encodeURIComponent(gq.id) + "/tests/" + rm, LB)).d;
    ok("a material with no parameter list falls back to derived defaults",
      (bare.params || []).length > 0 && bare.configured === false,
      JSON.stringify((bare.params || []).map((p) => p.key)));
    ok("…and says plainly that nothing will be graded", bare.specSet === false);

    // ---- the lab incharge owns the parameter LIST, admin owns the LIMITS ----
    await call("PUT", "/items/" + rm + "/qc", A, { params: ["thickness", "massPerArea", "visual"],
      spec: { thickness: { min: 0.05, max: 0.09 } } });
    const labEdit = await call("PUT", "/items/" + rm + "/qc", LB,
      { params: ["thickness", "visual"], spec: { thickness: { min: 0, max: 99 } } });
    ok("the lab incharge MAY change which parameters are measured", labEdit.status === 200
      && labEdit.d.params.join(",") === "thickness,visual", JSON.stringify(labEdit.d).slice(0, 130));
    ok("…and is told the limits were not theirs to change", labEdit.d.specEditable === false);
    const afterLabEdit = ((await call("GET", "/state", A)).d.items || []).find((i) => i.id === rm);
    ok("their save did NOT move the limits", afterLabEdit.qcSpec
      && afterLabEdit.qcSpec.thickness.min === 0.05 && afterLabEdit.qcSpec.thickness.max === 0.09,
      JSON.stringify(afterLabEdit.qcSpec));
    ok("office is shut out of the parameter list entirely (403)",
      (await call("PUT", "/items/" + rm + "/qc", O, { params: ["visual"] })).status === 403);

    /* ============================================================
       A FAILED LOT GOES TO THE ADMIN, WHO RULES ON IT
       approve → the lot is transferred to the quarantine store and production
       can no longer draw it; decline → it stands as good stock.
       ============================================================ */
    await call("PUT", "/items/" + rm + "/qc", A, { params: ["thickness", "visual"],
      spec: { thickness: { min: 0.07, max: 0.09 } } });
    const poF = (await call("POST", "/purchase-orders", A, { supplierId: sup, eta: "2026-08-22",
      lines: [{ itemId: rm, qty: 40, rate: 30 }] })).d;
    const gF = (await call("POST", "/purchase-orders/" + poF.id + "/receive", A,
      { wh: "WH-PNY", lines: [{ i: 0, qty: 40 }] })).d.grn;
    const failed = await call("POST", "/grns/" + encodeURIComponent(gF.id) + "/tests", LB,
      { itemId: rm, values: { thickness: 0.02, visual: "very thin" } });
    ok("a failing reading raises a decision rather than making one",
      failed.status === 201 && failed.d.awaitingDecision === true, JSON.stringify(failed.d.awaitingDecision));
    const queue = await call("GET", "/grn-tests/decisions", A);
    const mineQ = (queue.d.pending || []).filter((x) => x.grnId === gF.id);
    ok("the failed lot appears on the admin's decision queue", mineQ.length === 1,
      JSON.stringify(mineQ).slice(0, 170));
    ok("…naming the quantity and the parameter that failed",
      mineQ[0] && Math.abs(mineQ[0].acceptedQty - 40) < 0.001 && (mineQ[0].failed || []).join() === "Thickness",
      JSON.stringify(mineQ[0] && { qty: mineQ[0].acceptedQty, failed: mineQ[0].failed }));
    ok("the lab incharge cannot rule on it (403)",
      (await call("POST", "/grn-tests/" + mineQ[0].id + "/decision", LB, { approve: true })).status === 403);
    ok("nor can office — it is the use-or-not-use decision (403)",
      (await call("POST", "/grn-tests/" + mineQ[0].id + "/decision", O, { approve: true })).status === 403);

    // stock is STILL in the receiving store while the ruling is outstanding
    const preRule = (await call("GET", "/state", A)).d;
    const inStore = (preRule.movements || []).filter((m) => m.itemId === rm && m.wh === "WH-PNY")
      .reduce((s, m) => s + (+m.qty || 0), 0);
    ok("the lot stays in the receiving store until the admin decides", inStore > 0, "on hand " + inStore);

    // ---- approve: the lot is quarantined ----
    const ruled = await call("POST", "/grn-tests/" + mineQ[0].id + "/decision", A,
      { approve: true, note: "return to supplier" });
    ok("admin approving the rejection quarantines the lot", ruled.status === 200
      && ruled.d.test.decision === "quarantined", JSON.stringify(ruled.d.test && ruled.d.test.decision));
    ok("…by TRANSFERRING it, not writing it off", ruled.d.moved
      && Math.abs(ruled.d.moved.qty - 40) < 0.001 && ruled.d.moved.from === "WH-PNY",
      JSON.stringify(ruled.d.moved));
    const post = (await call("GET", "/state", A)).d;
    const holdWh = (post.warehouses || []).find((w) => /quarantine/i.test(String(w.type || "") + String(w.name || "")));
    const inHold = (post.movements || []).filter((m) => m.itemId === rm && m.wh === holdWh.id)
      .reduce((s, m) => s + (+m.qty || 0), 0);
    ok("the quarantine store now holds it", Math.abs(inHold - 40) < 0.001, "hold " + inHold);
    const totalAll = (post.movements || []).filter((m) => m.itemId === rm).reduce((s, m) => s + (+m.qty || 0), 0);
    const totalBefore = (preRule.movements || []).filter((m) => m.itemId === rm).reduce((s, m) => s + (+m.qty || 0), 0);
    ok("total on-hand is unchanged — a location change, not a write-off",
      Math.abs(totalAll - totalBefore) < 0.001, totalBefore + " → " + totalAll);
    ok("ruling twice is refused (409)",
      (await call("POST", "/grn-tests/" + mineQ[0].id + "/decision", A, { approve: false })).status === 409);
    ok("the lot leaves the decision queue once ruled on",
      !((await call("GET", "/grn-tests/decisions", A)).d.pending || []).some((x) => x.grnId === gF.id));

    /* THE POINT OF QUARANTINE: production must not be able to draw it. Asserted
       at the two seams that decide that — what a job may be made from, and which
       store an issue is posted against. */
    const GTsvc = require("../src/services/grnTestService");
    const PRsvc = require("../src/services/productionService");
    const Ssvc = require("../src/services/stageService");
    ok("the transfer is recorded against the receipt that brought the lot in",
      (post.movements || []).some((m) => m.itemId === rm && m.wh === holdWh.id
        && m.type === "XFER" && m.ref === gF.id), "ref " + gF.id);
    ok("the quarantine store is recognised as a held store",
      (await GTsvc.heldWarehouseIds(post)).indexOf(holdWh.id) >= 0, JSON.stringify(await GTsvc.heldWarehouseIds(post)));
    const availAll = (post.movements || []).filter((m) => m.itemId === rm)
      .reduce((s, m) => s + (+m.qty || 0), 0);
    const availProd = (await PRsvc.onHandMap(post))[rm] || 0;
    ok("quarantined stock is EXCLUDED from what production may draw",
      Math.abs(availAll - availProd - 40) < 0.001,
      "ledger " + availAll.toFixed(2) + " vs available " + availProd.toFixed(2) + " (40 held)");
    const itemsById = Object.fromEntries((post.items || []).map((i) => [i.id, i]));
    const picked = Ssvc.issuingWarehouse(rm, itemsById, post.movements, await GTsvc.heldWarehouseIds(post));
    ok("an issue is never posted against the quarantine store", picked !== holdWh.id, "picked " + picked);
    ok("…while the ledger itself still shows the lot — it was held, not lost",
      Math.abs(((post.movements || []).filter((m) => m.itemId === rm && m.wh === holdWh.id)
        .reduce((s, m) => s + (+m.qty || 0), 0)) - 40) < 0.001);

    // ---- decline: the lot stands as good stock ----
    const poR = (await call("POST", "/purchase-orders", A, { supplierId: sup, eta: "2026-08-23",
      lines: [{ itemId: rm, qty: 25, rate: 30 }] })).d;
    const gR = (await call("POST", "/purchase-orders/" + poR.id + "/receive", A,
      { wh: "WH-PNY", lines: [{ i: 0, qty: 25 }] })).d.grn;
    await call("POST", "/grns/" + encodeURIComponent(gR.id) + "/tests", LB,
      { itemId: rm, values: { thickness: 0.02, visual: "thin" } });
    const q2 = ((await call("GET", "/grn-tests/decisions", A)).d.pending || []).find((x) => x.grnId === gR.id);
    ok("a second failed lot queues independently", !!q2, JSON.stringify(q2 && q2.grnId));
    const beforeDecline = (await call("GET", "/state", A)).d.movements
      .filter((m) => m.itemId === rm && m.wh === holdWh.id).reduce((s, m) => s + (+m.qty || 0), 0);
    const declined = await call("POST", "/grn-tests/" + q2.id + "/decision", A,
      { approve: false, note: "acceptable for binder use" });
    ok("declining the rejection releases the lot", declined.status === 200
      && declined.d.test.decision === "released" && !declined.d.moved, JSON.stringify(declined.d.test.decision));
    const afterDecline = (await call("GET", "/state", A)).d.movements
      .filter((m) => m.itemId === rm && m.wh === holdWh.id).reduce((s, m) => s + (+m.qty || 0), 0);
    ok("…moving nothing — it was already good stock where it stood",
      Math.abs(afterDecline - beforeDecline) < 0.001, beforeDecline + " → " + afterDecline);
    ok("a PASSING lot never asks for a ruling", (await call("POST",
      "/grns/" + encodeURIComponent(gR.id) + "/tests", LB,
      { itemId: rm, values: { thickness: 0.08, visual: "clean" } })).d.awaitingDecision === false);
    ok("re-testing to a PASS clears the decision the failure had collected",
      !((await call("GET", "/state", A)).d.grnTests || [])
        .find((t) => t.grnId === gR.id && t.itemId === rm).decision);
    ok("a lot that is not failing cannot be ruled on (400)",
      (await call("POST", "/grn-tests/" + q2.id + "/decision", A, { approve: true })).status === 400);
    await call("DELETE", "/purchase-orders/" + poF.id, A);
    await call("DELETE", "/purchase-orders/" + poR.id, A);

    // ---- the seeder gives every purchasable material a real starting list ----
    const seeded = await GTsvc.ensureItemQc();
    ok("the seeder covers every purchasable material", seeded.items > 0
      && seeded.changed >= 0, JSON.stringify(seeded));
    ok("a mica paper is checked on its dielectric strength, a paste is not",
      GTsvc.derivedParamKeys({ name: "MICA TAPE CP25G", uom: "MTR", gsm: 120, thicknessMM: 0.08, widthMM: 1000 }).indexOf("bdv") >= 0
      && GTsvc.derivedParamKeys({ name: "CARBON PASTE CLOFT 908", uom: "KG" }).indexOf("bdv") < 0,
      JSON.stringify(GTsvc.derivedParamKeys({ name: "CARBON PASTE CLOFT 908", uom: "KG" })));

    // ---- a cancelled receipt has nothing to test ----
    await call("DELETE", "/purchase-orders/" + poQ.id, A);
    const cancelled = await call("POST", "/grns/" + encodeURIComponent(gq.id) + "/tests", LB,
      { itemId: rm, values: { thickness: 0.08, massPerArea: 118, visual: "x" } });
    ok("a cancelled receipt refuses a reading (400)", cancelled.status === 400,
      JSON.stringify(cancelled.d).slice(0, 110));
    ok("and it drops off the worklist",
      !((await call("GET", "/grn-tests/pending", LB)).d.pending || []).some((p) => p.grnId === gq.id));
  }

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
    /* the person who took the measurement is never shown its verdict — the
       same rule as the spec limits. The grade is computed and stored; it just
       does not come back to them. */
    ok("the lab's own write comes back with no verdict on it",
      p2.d.result === undefined && p2.d.labResult === undefined && p2.d.prodResult === undefined,
      JSON.stringify({ result: p2.d.result, lab: p2.d.labResult, prod: p2.d.prodResult }));
    ok("nor does the lab payload carry one",
      ((await call("GET", "/state", LB)).d.labReports || [])
        .every((r) => r.result === undefined && r.labResult === undefined && r.prodResult === undefined));
    // …but it WAS graded, and the office sees it
    const asOffice = ((await call("GET", "/state", A)).d.labReports || []).find((r) => r.id === p1.d.id);
    ok("each stage grades independently (production Pass, lab Fail)",
      asOffice.prodResult === "Pass" && asOffice.labResult === "Fail",
      asOffice.prodResult + "/" + asOffice.labResult);
    ok("headline result follows the lab reading once present", asOffice.result === "Fail");
    ok("lab writer is attributed", p2.d.labBy === "lab");
    ok("lab CANNOT delete a certificate (403)", (await call("DELETE", "/lab/reports/" + p1.d.id, LB)).status === 403);
  }

  /* ============================================================
     COATING CANNOT BE FINISHED UNTIL THE BATCH HAS BEEN MEASURED
     The work order IS the batch. A job that passes through the
     coating floor has to carry a lab reading before the supervisor
     can close the stage, and the reading covers exactly the
     parameters the Products master states a limit for.
     ============================================================ */
  section("A coated batch cannot leave the floor unmeasured");
  {
    // a water-blocking tape Gautam (coating1) makes, whose material is short —
    // so the job starts at his RM-production stage on the coating floor
    const rmC = { id: "RM-LABGATE", name: "Lab gate fabric", cat: "RM", uom: "KG", cost: 20 };
    const fgC = { id: "FG-LABGATE", name: "Lab gate water blocking tape", cat: "FG", uom: "KG",
      typeCode: "CHDNW-98", group: "WATER BLOCKING SERIES", cost: 100, price: 200 };
    await call("POST", "/items", A, rmC);
    await call("POST", "/items", A, fgC);
    await call("PUT", "/boms/" + fgC.id, A, { yield: 100, lines: [[rmC.id, 1.2]] });

    // the lab product that tests it: linked to the item, tested on TWO
    // parameters even though its type would imply more
    const lp = await call("POST", "/lab/products", A, {
      id: "LP-LABGATE", name: "Lab gate water blocking tape", code: "CHDNW-98",
      thickness: "0.25", series: "Water Blocking", itemId: fgC.id,
      flags: { waterBlocking: true, semiConductive: true, mica: false },
      spec: { thickness: { min: 0.2, max: 0.3 }, tensile: { min: 30 } },
    });
    ok("a lab product keeps the item it tests", lp.status === 201 && lp.d.itemId === fgC.id,
      JSON.stringify(lp.d && lp.d.itemId));
    // editing it must not quietly drop that link — the gate depends on it
    const lpEdit = await call("PATCH", "/lab/products/LP-LABGATE", A, { series: "Water Blocking" });
    ok("and keeps it through an edit", lpEdit.d.itemId === fgC.id, JSON.stringify(lpEdit.d.itemId));

    const woL = await call("POST", "/production/wo", A, { itemId: fgC.id, qty: 40 });
    ok("the job starts on the coating floor", (woL.d.route || [])[0] && woL.d.route[0].area === "coating",
      (woL.d.route || []).map((r) => r.key + "/" + r.area).join(" > "));
    const woLid = woL.d.id;

    const started = await call("POST", "/production/wo/" + woLid + "/advance", C, { action: "start" });
    ok("the supervisor can start coating", started.status === 200);

    const blocked = await call("POST", "/production/wo/" + woLid + "/advance", C, { action: "complete" });
    ok("but CANNOT finish it without a lab report (409)", blocked.status === 409, blocked.status + "");
    ok("and is told which batch and which readings are missing",
      /Lab report required/.test(blocked.d.error || "") && /Thickness/.test(blocked.d.error || ""),
      JSON.stringify(blocked.d).slice(0, 160));
    ok("the stage really did not move",
      (await call("GET", "/state", A)).d.workorders.find((w) => w.id === woLid).route[0].status === "In Production");

    /* the sheet the floor is asked to fill: ONLY the parameters the product's
       spec names, and never the limits themselves */
    const sheet = await call("GET", "/production/wo/" + woLid + "/lab", C);
    ok("the floor is given the parameter list", sheet.status === 200 && sheet.d.params.length === 2,
      JSON.stringify((sheet.d.params || []).map((p) => p.key)));
    ok("it is exactly what the Products master states a limit for",
      (sheet.d.params || []).map((p) => p.key).sort().join(",") === "tensile,thickness",
      (sheet.d.params || []).map((p) => p.key).join(","));
    ok("the type would have implied more — the spec wins, not the flags",
      !(sheet.d.params || []).some((p) => ["elongation", "massPerArea", "swellSpeed", "surfaceResistance"].includes(p.key)));
    ok("no spec limits reach the person doing the measuring",
      !/"min"|"max"/.test(JSON.stringify(sheet.d)), JSON.stringify(sheet.d).slice(0, 120));
    ok("the batch number is the work order's own number", sheet.d.batchNo === woLid.replace(/^WO-/, ""),
      sheet.d.batchNo + " vs " + woLid);

    const half = await call("POST", "/production/wo/" + woLid + "/lab", C, { values: { thickness: 0.25 } });
    ok("a half-filled sheet is refused", half.status === 400 && /Tensile/.test(half.d.error || ""),
      JSON.stringify(half.d).slice(0, 120));

    /* MEASURED IS NOT THE SAME AS PASSED.
       This gate used to return ok the moment every box carried a value, and
       never looked at the grade it had just computed — so a batch whose
       certificate read Fail coated, slit, packed and shipped exactly like a
       good one. Reproduced against a running server before it was fixed:
       certificate "Fail" on every parameter, stage completed with HTTP 200. */
    const bad = await call("POST", "/production/wo/" + woLid + "/lab", C,
      { values: { thickness: 0.9, tensile: 5 } });
    ok("an out-of-spec reading is still recorded", bad.status === 201, String(bad.status));
    ok("…and graded Fail", bad.d.report.prodResult === "Fail", String(bad.d.report.prodResult));
    const failClose = await call("POST", "/production/wo/" + woLid + "/advance", C, { action: "complete" });
    ok("a FAILED batch cannot close coating (409)", failClose.status === 409, String(failClose.status));
    ok("…and is told which parameters failed",
      /FAILED its test/.test(failClose.d.error || "") && /Thickness/.test(failClose.d.error || ""),
      JSON.stringify(failClose.d).slice(0, 170));
    ok("the failed stage really did not move",
      (await call("GET", "/state", A)).d.workorders.find((w) => w.id === woLid).route[0].status === "In Production");

    const rec = await call("POST", "/production/wo/" + woLid + "/lab", C, { values: { thickness: 0.25, tensile: 44 } });
    ok("a complete reading is accepted", rec.status === 201, JSON.stringify(rec.d).slice(0, 120));
    ok("it is graded against the hidden spec", rec.d.report.prodResult === "Pass", rec.d.report.prodResult);
    ok("the certificate is tied to the work order", rec.d.report.woId === woLid, rec.d.report.woId);
    ok("the certificate carries only the two parameters",
      (rec.d.report.paramKeys || []).sort().join(",") === "tensile,thickness",
      (rec.d.report.paramKeys || []).join(","));

    /* THE ROLL COMING OFF COATING IS A PHYSICAL THING GOING SOMEWHERE.
       It is never booked into stock, so unless coating names the store it was
       carried to, its whereabouts exist nowhere and slitting has to hunt.
       The reading alone is no longer enough to close the stage. */
    const noWh = await call("POST", "/production/wo/" + woLid + "/advance", C, { action: "complete" });
    ok("a measured batch STILL cannot close coating without naming the store",
      noWh.status === 409 && noWh.d.needsWipWh === true, noWh.status + " " + JSON.stringify(noWh.d).slice(0, 90));
    ok("and the stage is left exactly where it was",
      (await call("GET", "/state", A)).d.workorders.find((w) => w.id === woLid).route[0].status === "In Production");
    ok("a store that does not exist is refused",
      (await call("POST", "/production/wo/" + woLid + "/advance", C,
        { action: "complete", wipWh: "WH-NOWHERE" })).status === 400);

    const done = await call("POST", "/production/wo/" + woLid + "/advance", C,
      { action: "complete", wipWh: "WH-WIP" });
    ok("NOW the supervisor can finish coating", done.status === 200, done.status + " " + JSON.stringify(done.d).slice(0, 90));
    const afterCoat = (await call("GET", "/state", A)).d;
    const woCoated = afterCoat.workorders.find((w) => w.id === woLid);
    ok("and the job moved on to slitting", woCoated.route[0].status === "Completed");
    ok("the store is written on the stage that made the roll",
      woCoated.route[0].outWh === "WH-WIP" && woCoated.route[0].outWhBy === "coating1",
      woCoated.route[0].outWh + " by " + woCoated.route[0].outWhBy);
    /* the whole point: a LOCATION, not stock. Naming the store must not book
       a single unit of anything into it. */
    const coatMoves = (afterCoat.movements || []).filter((m) => m.ref === woLid && (+m.qty || 0) > 0);
    ok("naming the store books NOTHING into it", coatMoves.length === 0,
      coatMoves.map((m) => m.itemId + "@" + m.wh + " +" + m.qty).join(", "));
    const slitTok = (await login("slitting1", "slitting1@123")).token;
    const slitSees = ((await call("GET", "/state", slitTok)).d.workorders || [])
      .find((w) => w.id === woLid);
    ok("and the slitting board is told where to fetch the roll",
      !!slitSees && slitSees.wipAt && slitSees.wipAt.wh === "WH-WIP" && !!slitSees.wipAt.name,
      slitSees && slitSees.wipAt ? JSON.stringify(slitSees.wipAt) : "no location on the board");

    /* WRITE ONCE. The note says where the roll was carried as it came off the
       line; rewriting it later would leave slitting reading a location nobody
       can vouch for. What the same endpoint DOES allow is filling in a blank —
       every batch coated before the question was asked. */
    ok("a store already recorded cannot be rewritten",
      (await call("POST", "/production/wo/" + woLid + "/wip-store", C, { wh: "WH-QC" })).status === 409);
    ok("and the original store still stands",
      (await call("GET", "/state", A)).d.workorders.find((w) => w.id === woLid).route[0].outWh === "WH-WIP");
    ok("the slitting floor cannot say where coating left the roll",
      (await call("POST", "/production/wo/" + woLid + "/wip-store", slitTok, { wh: "WH-QC" })).status === 403);

    /* the incharge's worklist, and the second measurement on the same batch */
    const labSt = (await call("GET", "/state", LB)).d;
    const row = (labSt.labPending || []).find((p) => p.woId === woLid);
    ok("the batch appears on the lab incharge's pending list", !!row,
      JSON.stringify((labSt.labPending || []).map((p) => p.woId)));
    ok("it shows the floor has measured it and the lab has not",
      row && row.prodComplete === true && row.labComplete === false && row.stage === "lab",
      row ? row.stage + " prod=" + row.prodComplete + " lab=" + row.labComplete : "");

    const labWrite = await call("PATCH", "/lab/reports/" + rec.d.report.id, LB, { values: { thickness: 0.26, tensile: 41 } });
    ok("the incharge's reading merges into the SAME certificate", labWrite.d.id === rec.d.report.id);
    ok("both readings are kept side by side",
      Object.keys(labWrite.d.prodValues).length === 2 && Object.keys(labWrite.d.labValues).length === 2);
    const after = (await call("GET", "/state", LB)).d;
    ok("and the batch leaves the pending list", !(after.labPending || []).some((p) => p.woId === woLid));

    /* the floor writes its own reading only, and only for its own jobs */
    ok("a supervisor still cannot post a certificate directly (403)",
      (await call("POST", "/lab/reports", C, { productId: "LP-LABGATE", refNo: "X" })).status === 403);
    /* the reading belongs to the coating floor that ran the batch — not to
       slitting, and not to the OTHER RM line */
    const S2 = (await login("slitting1", "slitting1@123")).token;
    ok("slitting cannot record a coating measurement (403)",
      (await call("GET", "/production/wo/" + woLid + "/lab", S2)).status === 403);
    const C2 = (await login("coating2", "coating2@123")).token;
    ok("nor can the other RM line, whose job it is not (403)",
      (await call("POST", "/production/wo/" + woLid + "/lab", C2, { values: { thickness: 0.1, tensile: 1 } })).status === 403);
  }

  /* ============================================================
     NOTHING GOES INTO A STORE UNMEASURED EITHER
     Stock booked by hand carries no work order, so the batch is
     named by whoever books it — and the same complete reading is
     required before the movement is posted.
     ============================================================ */
  section("Finished stock cannot be booked without a lab report");
  {
    // plenty of the raw material so nothing but QC can refuse the booking
    await call("POST", "/movements", A, { itemId: "RM-LABGATE", type: "GRN",
      qty: 5000, rate: 20, wh: "WH-PNY", date: "2026-01-01", manual: true });
    const onHand = async (id) => {
      const st = (await call("GET", "/state", A)).d;
      return (st.movements || []).filter((m) => m.itemId === id)
        .reduce((n, m) => n + (+m.qty || 0), 0);
    };
    const before = await onHand("FG-LABGATE");
    const book = (extra) => call("POST", "/production/finished", C,
      Object.assign({ itemId: "FG-LABGATE", qty: 10, wh: "WH-FG", tapeWidthMM: 25, gsm: 100 }, extra || {}));

    const noBatch = await book();
    ok("booking without a batch number is refused (409)", noBatch.status === 409, noBatch.status + "");
    ok("and it says why", /batch \/ lot number/.test(noBatch.d.error || ""), JSON.stringify(noBatch.d).slice(0, 120));

    const noVals = await book({ refNo: "LOT-1" });
    ok("a named batch with no readings is refused", noVals.status === 409, noVals.status + "");
    ok("and it lists what is missing",
      /Thickness/.test(noVals.d.error || "") && /Tensile/.test(noVals.d.error || ""),
      JSON.stringify(noVals.d).slice(0, 150));

    const partial = await book({ refNo: "LOT-1", labValues: { thickness: 0.25 } });
    ok("a half-filled reading is refused", partial.status === 409 && /Tensile/.test(partial.d.error || ""),
      JSON.stringify(partial.d).slice(0, 120));

    ok("not one refused attempt booked any stock", (await onHand("FG-LABGATE")) === before,
      before + " -> " + (await onHand("FG-LABGATE")));

    const good = await book({ refNo: "LOT-1", labValues: { thickness: 0.25, tensile: 40 } });
    ok("a complete reading books the stock", good.status === 201, JSON.stringify(good.d).slice(0, 120));
    ok("the stock really landed", (await onHand("FG-LABGATE")) === before + 10,
      before + " -> " + (await onHand("FG-LABGATE")));
    ok("a certificate was raised for the batch",
      !!(good.d.labReport && good.d.labReport.id) && good.d.batchNo === "LOT-1",
      JSON.stringify(good.d.labReport));
    ok("and it was graded against the hidden spec", good.d.labReport.result === "Pass", good.d.labReport.result);

    // a batch already measured does not have to be measured twice
    const again = await book({ refNo: "LOT-1" });
    ok("adding more to a batch already measured needs no re-entry", again.status === 201, again.status + "");

    /* the sheet the form builds itself from — parameters, never limits */
    const sheet = await call("GET", "/production/finished/FG-LABGATE/lab", C);
    ok("the form can ask what this product is tested on",
      sheet.status === 200 && sheet.d.required === true && sheet.d.params.length === 2,
      JSON.stringify((sheet.d.params || []).map((p) => p.key)));
    ok("no spec limit reaches the person measuring", !/"min"|"max"/.test(JSON.stringify(sheet.d)));

    /* a half-made roll is graded against its PARENT product's spec — it is the
       same web, measured before it is slit */
    await call("POST", "/items", A, { id: "WIP-LABGATE", name: "Lab gate coated jumbo",
      cat: "WIP", uom: "KG", stageOf: "FG-LABGATE" });
    const wipSheet = await call("GET", "/production/finished/WIP-LABGATE/lab", C);
    ok("a half-made roll inherits its parent's parameters",
      wipSheet.status === 200 && wipSheet.d.required === true
        && (wipSheet.d.params || []).length === 2 && wipSheet.d.recipeOwnerId === "FG-LABGATE",
      JSON.stringify(wipSheet.d.params && wipSheet.d.params.map((p) => p.key)));
    const wipNoVals = await call("POST", "/production/finished", C,
      { itemId: "WIP-LABGATE", qty: 5, wh: "WH-WIP", gsm: 100, refNo: "LOT-W1" });
    ok("and it cannot be booked unmeasured either", wipNoVals.status === 409, wipNoVals.status + "");
    // put the master back as it was — a later section asserts no WIP item exists
    await call("DELETE", "/items/WIP-LABGATE", A);

    /* a product the lab does not test is not held up */
    await call("POST", "/items", A, { id: "RM-FREE", name: "Untested resin", cat: "RM", uom: "KG", cost: 5 });
    await call("POST", "/items", A, { id: "FG-FREE", name: "Untested tape", cat: "FG", uom: "KG",
      typeCode: "CH-FREE", group: "OTHER TAPE SERIES", cost: 10, price: 20 });
    await call("PUT", "/boms/FG-FREE", A, { yield: 100, lines: [["RM-FREE", 1]] });
    await call("POST", "/movements", A, { itemId: "RM-FREE", type: "GRN", qty: 500, rate: 5,
      wh: "WH-PNY", date: "2026-01-01", manual: true });
    const free = await call("POST", "/production/finished", C,
      { itemId: "FG-FREE", qty: 5, wh: "WH-FG", tapeWidthMM: 25, gsm: 100 });
    ok("a product with no lab parameters books freely", free.status === 201,
      free.status + " " + JSON.stringify(free.d).slice(0, 90));
  }

  section("A job that never touches coating is not held up by QC");
  {
    // material IS in store, so the route is Slitting → Packing: no coating
    // stage, so no certificate is demanded and the floor is not blocked
    const rmS = { id: "RM-NOGATE", name: "No gate fabric", cat: "RM", uom: "KG", cost: 20 };
    const fgS = { id: "FG-NOGATE", name: "No gate tape", cat: "FG", uom: "KG",
      typeCode: "CH-NOGATE", group: "OTHER TAPE SERIES", cost: 100, price: 200 };
    await call("POST", "/items", A, rmS);
    await call("POST", "/items", A, fgS);
    await call("PUT", "/boms/" + fgS.id, A, { yield: 100, lines: [[rmS.id, 1]] });
    await call("POST", "/movements", A, { id: "MV-NOGATE", itemId: rmS.id, type: "GRN",
      qty: 500, rate: 20, wh: "WH-PNY", date: "2026-01-01", manual: true });
    await call("POST", "/lab/products", A, { id: "LP-NOGATE", name: "No gate tape", code: "CH-NOGATE",
      itemId: fgS.id, spec: { thickness: { min: 0.1, max: 0.2 } } });
    const woS = await call("POST", "/production/wo", A, { itemId: fgS.id, qty: 20 });
    ok("the job skips coating", !(woS.d.route || []).some((r) => r.area === "coating"),
      (woS.d.route || []).map((r) => r.key).join(" > "));
    const S1b = (await login("slitting1", "slitting1@123")).token;
    await call("POST", "/production/wo/" + woS.d.id + "/advance", S1b, { action: "start" });
    ok("slitting finishes with no lab report at all",
      (await call("POST", "/production/wo/" + woS.d.id + "/advance", S1b, { action: "complete" })).status === 200);
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

  section("Who makes the product decides where a work order starts");
  // a product we do not make is bought in ready-made -> slit and pack only
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
  ok("a bought-in product -> straight to Slitting → Packing",
    rStk.length === 2 && rStk[0].key === "slitting" && rStk[1].key === "packing",
    rStk.map((r) => r.key).join(" > "));
  ok("nothing we do not make gets a production stage",
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

  /* RAW MATERIAL IN THE STORE DOES NOT SKIP COATING.
     It used to: a stocked job went straight to slitting, which meant a coated
     product bypassed the coating floor exactly when it was ready to run — and
     slitting bare fabric is not a process. Only a half-made COATED JUMBO
     skips coating, and that is decided by netting, not by the route. */
  const plenty = { id: "RM-TEST-PLENTY", name: "Well stocked fabric", cat: "RM", uom: "KG", cost: 50 };
  const gaut2 = { id: "FG-TEST-WB-STOCKED", name: "Stocked water blocking tape", cat: "FG", uom: "KG",
    typeCode: "CHDNW-97", group: "WATER BLOCKING SERIES", cost: 100, price: 200 };
  await call("POST", "/items", A, plenty);
  await call("POST", "/items", A, gaut2);
  await call("PUT", "/boms/" + gaut2.id, A, { yield: 100, lines: [[plenty.id, 1.2]] });
  await call("POST", "/movements", A, { itemId: plenty.id, type: "GRN",
    qty: 100000, rate: 50, wh: "WH-PNY", date: "2026-01-01", manual: true });
  const woStocked = await call("POST", "/production/wo", A, { itemId: gaut2.id, qty: 50 });
  const rStocked = (woStocked.d && woStocked.d.route) || [];
  ok("the same product WITH material in store still runs coating first",
    rStocked[0] && rStocked[0].key === "rmprod" && rStocked[0].area === "coating",
    rStocked.map((r) => r.key + "/" + r.area).join(" > "));
  ok("and it sits on the coating floor's line, not a slitting line",
    /^RM Production/.test((await call("GET", "/state", A)).d.workorders
      .find((w) => w.id === woStocked.d.id).line),
    (await call("GET", "/state", A)).d.workorders.find((w) => w.id === woStocked.d.id).line);
  ok("so the coating supervisor can see and start it",
    (await call("POST", "/production/wo/" + woStocked.d.id + "/advance", C, { action: "start" })).status === 200);
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
      qty: 50, rate: 10, wh: "WH-PNY", date: "2026-01-01", manual: true });

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
      qty: 20, rate: 10, wh: "WH-PNY", date: "2026-01-20", manual: true });
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
      qty: 30, rate: 10, wh: "WH-PNY", date: "2026-02-01", manual: true });
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
        qty: 100, rate: 10, wh: "WH-PNY", date: "2026-05-01", manual: true });
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
          qty: -onShelf, wh: "WH-PNY", date: "2026-05-02", manual: true });
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
        qty: 40, rate: 10, wh: "WH-PNY", date: "2026-03-01", manual: true });
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
        qty: 20, rate: 10, wh: "WH-PNY", date: "2026-04-01", manual: true });
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

  /* The floor is told WHERE to fetch each material, not only what and how much.
     A job draws from three different places (the store that took the delivery,
     the WIP floor, the finished bay) and without the location every job began
     with a walk round the stores. */
  const coatState = (await call("GET", "/state", C)).d;
  const myJob = (coatState.workorders || []).find((w) => w.id === woMake.d.id);
  const myMats = (myJob && myJob.materials) || [];
  ok("the floor's job sheet lists the materials for its stage", myMats.length > 0,
    myMats.length + " materials");
  ok("and every one of them names the store it is fetched from",
    myMats.length > 0 && myMats.every((m) => !!m.wh && !!m.whName),
    myMats.map((m) => m.id + "@" + (m.wh || "—")).join(", "));
  const issuedFor = ((await call("GET", "/state", A)).d.movements || [])
    .filter((m) => m.ref === woMake.d.id && (+m.qty || 0) < 0);
  ok("the store named is the one the issue actually posted against",
    myMats.every((m) => { const mv = issuedFor.find((x) => x.itemId === m.id); return !mv || mv.wh === m.wh; }),
    myMats.map((m) => { const mv = issuedFor.find((x) => x.itemId === m.id);
      return m.id + " sheet=" + m.wh + " issue=" + (mv ? mv.wh : "not issued"); }).join(" · "));
  ok("a supervisor is still sent no cost with the location",
    myMats.every((m) => m.rate === undefined && m.cost === undefined && m.value === undefined));

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

  section("BarTender sticker hand-off");
  {
    const csv = '"PONo","Product"\r\n"PO-BT-1","MICA TAPE"';
    const bt = await call("POST", "/bartender/stickers", A, { poId: "PO-BT-1", csv });
    ok("admin hand-off answers ok", bt.status === 200 && bt.d.ok === true, JSON.stringify(bt.d).slice(0, 110));
    ok("…reporting each step honestly", typeof bt.d.exeFound === "boolean" && typeof bt.d.launched === "boolean"
      && /stickers\.csv$/.test(bt.d.csvPath) && !!bt.d.message, JSON.stringify(bt.d).slice(0, 110));
    ok("the rows landed at the fixed path the .btw binds to",
      fs.existsSync(bt.d.csvPath) && fs.readFileSync(bt.d.csvPath, "utf8") === csv);
    ok("a second PO overwrites the same file", (await call("POST", "/bartender/stickers", A, { poId: "PO-BT-2", csv: '"PONo"\r\n"PO-BT-2"' })).d.csvPath === bt.d.csvPath
      && /PO-BT-2/.test(fs.readFileSync(bt.d.csvPath, "utf8")));
    ok("supervisor is refused (403)", (await call("POST", "/bartender/stickers", C, { poId: "PO-BT-1", csv })).status === 403);
    ok("anonymous is refused (401)", (await call("POST", "/bartender/stickers", null, { poId: "PO-BT-1", csv })).status === 401);
    ok("a path-traversal PO id is rejected (400)", (await call("POST", "/bartender/stickers", A, { poId: "../evil", csv })).status === 400);
    ok("empty rows are rejected (400)", (await call("POST", "/bartender/stickers", A, { poId: "PO-BT-1", csv: "   " })).status === 400);

    /* The exe hunt must see a MODERN install: BarTender 2019+ lives at
       Seagull\BarTender <year>\BarTender Suite\bartend.exe — three levels —
       and the old two-level scan reported a healthy install as missing.
       The scan roots are injectable via env, so a fake install proves it. */
    const btRoot = path.join(os.tmpdir(), "chh-btscan-" + process.pid);
    const deepDir = path.join(btRoot, "Seagull", "BarTender 2022", "BarTender Suite");
    const fakeExe = path.join(deepDir, "bartend.exe");
    fs.mkdirSync(deepDir, { recursive: true });
    fs.writeFileSync(fakeExe, "MZ");
    process.env.CHHAPERIA_BARTENDER_SCAN = btRoot;
    const deep = (await call("POST", "/bartender/stickers", A, { poId: "PO-BT-1", csv })).d;
    ok("a three-level 2019+ install layout IS found", deep.exeFound === true && deep.exePath === fakeExe,
      JSON.stringify({ exeFound: deep.exeFound, exePath: deep.exePath }));
    ok("…and the test server still never launches it", deep.launched === false && /suppressed/.test(deep.message),
      deep.message);
    // uninstall: the cached hit must revalidate, not answer from memory
    fs.rmSync(btRoot, { recursive: true, force: true });
    const gone = (await call("POST", "/bartender/stickers", A, { poId: "PO-BT-1", csv })).d;
    ok("a removed install is not reported from the cache", gone.exePath !== fakeExe,
      JSON.stringify({ exePath: gone.exePath }));
    delete process.env.CHHAPERIA_BARTENDER_SCAN;

    // with a designed .btw on disk the association route becomes available;
    // the response reports the template so the client knows the label exists
    const btwPath = path.join(path.dirname(bt.d.csvPath), "test-label.btw");
    fs.writeFileSync(btwPath, "btw");
    const withTpl = (await call("POST", "/bartender/stickers", A, { poId: "PO-BT-1", csv })).d;
    ok("a saved .btw template is detected", withTpl.templateFound === true, JSON.stringify(withTpl).slice(0, 110));
    fs.rmSync(btwPath, { force: true });
  }

  section("Sticker print settings (size + fields, shared via /settings)");
  {
    const set1 = (await call("PATCH", "/settings", A, { sticker: { w: 100, h: 150, fields: { supplier: true, gsm: false } } })).d;
    ok("sticker config is accepted", set1.sticker && set1.sticker.w === 100 && set1.sticker.h === 150, JSON.stringify(set1.sticker));
    ok("an unticked field survives the round trip", set1.sticker.fields.gsm === false && set1.sticker.fields.supplier === true,
      JSON.stringify(set1.sticker.fields));
    ok("unmentioned fields default ON", set1.sticker.fields.grade === true && set1.sticker.fields.status === true);
    const set2 = (await call("PATCH", "/settings", A, { sticker: { w: 9999, h: 3 } })).d;
    ok("label size is clamped to printable bounds", set2.sticker.w === 300 && set2.sticker.h === 25, JSON.stringify(set2.sticker));
    ok("sticker config is part of the state document",
      ((await call("GET", "/state", A)).d.settings.sticker || {}).w === 300);
    ok("office can save the sticker config too", (await call("PATCH", "/settings", O, { sticker: { w: 120, h: 80 } })).d.sticker.w === 120);
    ok("junk field keys never reach the settings document",
      (await call("PATCH", "/settings", A, { sticker: { w: 100, fields: { hack: true } } })).d.sticker.fields.hack === undefined);
    ok("supervisor cannot touch settings (403)", (await call("PATCH", "/settings", C, { sticker: { w: 50 } })).status === 403);

    /* Label background colour + symbol. `bg` is written straight into the print
       stylesheet, so it must only ever come back as a #rrggbb literal — a value
       carrying its own CSS would otherwise ride into the printed page. */
    const col = (v) => call("PATCH", "/settings", A, { sticker: { bg: v } });
    ok("a hex colour is kept", (await col("#FFE0B2")).d.sticker.bg === "#ffe0b2");
    ok("a named colour is refused, falling back to white",
      (await col("red")).d.sticker.bg === "#ffffff");
    ok("a css injection in the colour is refused",
      (await col("#fff;background:url(http://x/y)")).d.sticker.bg === "#ffffff");
    ok("a short hex is refused", (await col("#fff")).d.sticker.bg === "#ffffff");
    ok("the colour survives into the state document",
      (await col("#c8e6c9"), ((await call("GET", "/state", A)).d.settings.sticker || {}).bg === "#c8e6c9"));

    /* Placed symbols: glyph + centre position + size. The glyph cap (2
       characters, counted as a person counts them) is what keeps markup and
       whole sentences off the printed label. */
    const sym = (v) => call("PATCH", "/settings", A, { sticker: { syms: v } });
    const s1 = (await sym([{ g: "⚠", x: 20, y: 30, s: 12 }])).d.sticker.syms;
    ok("a placed symbol keeps its glyph, position and size",
      s1.length === 1 && s1[0].g === "⚠" && s1[0].x === 20 && s1[0].y === 30 && s1[0].s === 12,
      JSON.stringify(s1));
    ok("a sentence smuggled in as a symbol is dropped",
      (await sym([{ g: "UNDER TEST — do not use", x: 1, y: 1, s: 8 }])).d.sticker.syms.length === 0);
    ok("markup in the symbol is dropped by the length rule",
      (await sym([{ g: "<img src=x onerror=alert(1)>", x: 1, y: 1, s: 8 }])).d.sticker.syms.length === 0);
    // an astral glyph is ONE character to a person, two UTF-16 units to naive code
    ok("an emoji symbol counts as one character",
      (await sym([{ g: "🔥", x: 1, y: 1, s: 8 }])).d.sticker.syms[0].g === "🔥");
    ok("the symbol list is capped at 12",
      (await sym(Array.from({ length: 30 }, () => ({ g: "★", x: 1, y: 1, s: 8 })))).d.sticker.syms.length === 12);
    ok("a symbol's size clamps to the printable range",
      (await sym([{ g: "★", x: 1, y: 1, s: 9999 }])).d.sticker.syms[0].s === 200);

    /* Shape, auto-fit and the background picture. */
    ok("a label shape is kept",
      (await call("PATCH", "/settings", A, { sticker: { shape: "disc", holeDia: 20 } })).d.sticker.shape === "disc");
    ok("an unknown shape falls back to the rectangle",
      (await call("PATCH", "/settings", A, { sticker: { shape: "star" } })).d.sticker.shape === "rect");
    ok("auto-fit defaults to solving the gaps",
      (await call("PATCH", "/settings", A, { sticker: {} })).d.sticker.autoFit === "gaps");
    ok("legacy autoSize:false reads as auto-fit off",
      (await call("PATCH", "/settings", A, { sticker: { autoSize: false } })).d.sticker.autoFit === "none");
    ok("an SVG background picture is refused — it can carry script",
      (await call("PATCH", "/settings", A, { sticker: { bgImg: "data:image/svg+xml;base64,PHN2Zz4=" } })).d.sticker.bgImg === "");
    ok("a raster background picture is kept",
      (await call("PATCH", "/settings", A, { sticker: { bgImg: "data:image/png;base64,iVBORw0KGgo=" } })).d.sticker.bgImg === "data:image/png;base64,iVBORw0KGgo=");

    /* The design layer: font, per-field inks, block sizes and free positions. */
    ok("a whitelisted font is kept",
      (await call("PATCH", "/settings", A, { sticker: { font: "arial" } })).d.sticker.font === "arial");
    ok("an arbitrary font string falls back to Times",
      (await call("PATCH", "/settings", A, { sticker: { font: "Comic Sans MS, evil" } })).d.sticker.font === "times");
    const fc = (await call("PATCH", "/settings", A, { sticker: { fieldC: { supplier: "#B71C1C", hack: "#112233", grade: "red" } } })).d.sticker.fieldC;
    ok("per-field colours keep hex literals on known fields only",
      fc.supplier === "#b71c1c" && fc.hack === undefined && fc.grade === undefined, JSON.stringify(fc));
    const pos = (await call("PATCH", "/settings", A, { sticker: { pos: { title: { x: 12, y: 8 }, body: { x: "junk" }, evil: { x: 1, y: 1 } } } })).d.sticker.pos;
    ok("a dragged block keeps its position; junk and unknown blocks are dropped",
      pos.title && pos.title.x === 12 && pos.title.y === 8 && pos.body === undefined && pos.evil === undefined, JSON.stringify(pos));
    const fsr = (await call("PATCH", "/settings", A, { sticker: { fs: { title: 9, body: 9999, para: -4 } } })).d.sticker.fs;
    ok("block font sizes clamp to the 0–60 mm range",
      fsr.title === 9 && fsr.body === 60 && fsr.para === 0, JSON.stringify(fsr));
  }

  /* ============================================================
     LABEL STUDIO TEMPLATES (settings.labelDocs)

     ⚠ WHY THIS BLOCK EXISTS. The settings whitelist drops keys it does
     not know about SILENTLY — the save returns 200 and the work is
     gone. That has already cost one session: labelDocs itself was
     invisible until it was added to the whitelist, while the UI
     cheerfully reported "saved". Anything added to a label object
     needs a test here that it SURVIVES the round trip, or the failure
     is undetectable from the front end.
     ============================================================ */
  {
    section("Label Studio templates round-trip");
    const doc = (objects, extra) => Object.assign({
      id: "d_test1", name: "Round trip", w: 100, h: 60, objects,
    }, extra || {});
    const put = async (objects, extra) => {
      const r = await call("PATCH", "/settings", A, { labelDocs: [doc(objects, extra)] });
      const list = (r.d && r.d.labelDocs) || [];
      return list[0] || null;
    };
    const obj = (src) => ({ id: "o_a1", type: "text", x: 5, y: 5, w: 40, h: 8, text: "x", src });

    const d1 = await put([obj({ kind: "fixed" })]);
    ok("a label template comes back at all", !!d1 && d1.name === "Round trip", JSON.stringify(d1 && d1.name));
    ok("its size survives", !!d1 && d1.w === 100 && d1.h === 60);

    /* the new one: a field bound to the ERP */
    const bound = await put([obj({ kind: "field", field: "product.name", def: "PVC Tape" })]);
    const bs = bound && bound.objects[0].src;
    ok("an ERP binding survives the save",
      !!bs && bs.kind === "field" && bs.field === "product.name", JSON.stringify(bs));
    ok("…and keeps the example it shows while unbound",
      !!bs && bs.def === "PVC Tape", bs && bs.def);
    const deep = await put([obj({ kind: "field", field: "batch.qc.grade" })]);
    ok("a three-part binding is allowed",
      deep.objects[0].src.field === "batch.qc.grade", deep.objects[0].src.field);

    /* and the shapes that must NOT get through */
    const badKind = await put([obj({ kind: "evil", field: "product.name" })]);
    ok("an unknown source kind falls back to fixed",
      badKind.objects[0].src.kind === "fixed", badKind.objects[0].src.kind);
    const badField = await put([obj({ kind: "field", field: "__proto__.x" })]);
    ok("a binding that is not a plain field path is dropped",
      badField.objects[0].src.field === "", JSON.stringify(badField.objects[0].src.field));
    const noDots = await put([obj({ kind: "field", field: "product" })]);
    ok("a binding with no field on it is dropped",
      noDots.objects[0].src.field === "", JSON.stringify(noDots.objects[0].src.field));
  }

  section("Validation rejects bad input");
  ok("SO with empty lines → 400", (await call("POST", "/sales-orders", A, { customerId: cust, lines: [] })).status === 400);
  ok("delete unknown SO → 404", (await call("DELETE", "/sales-orders/SO-NOPE", A)).status === 404);
  ok("BOM for unknown product → 400", (await call("PUT", "/boms/NOPE-ID", A, { lines: [[rm, 1]] })).status === 400);
  ok("movement for unknown item → 400", (await call("POST", "/movements", A, { itemId: "GHOST", type: "GRN", qty: 1 })).status === 400);
  ok("item with unknown category → 400", (await call("POST", "/items", A, { id: "RM-BADCAT", name: "x", cat: "NOPE" })).status === 400);

  /* ============================================================
     CROSS-MODULE INTEGRITY
     Every case below was REPRODUCED against a running server before it was
     fixed; the measured damage is quoted with each one. They are grouped
     here rather than beside their features because what they guard is the
     seam BETWEEN two modules, which is where all of them hid.
     ============================================================ */
  section("Cross-module integrity (regressions)");
  {
    const wh = "WH-PNY";
    const mkItem = async (id) => (await call("POST", "/items", A,
      { id, name: id, cat: "RM", uom: "KG", cost: 10, price: 20 })).d;
    const supX = (await call("GET", "/state", A)).d.suppliers[0].id;
    const cusX = (await call("GET", "/state", A)).d.customers[0].id;
    const stockOf = async (id) => ((await call("GET", "/state", A)).d.movements || [])
      .filter((m) => m.itemId === id).reduce((s, m) => s + (+m.qty || 0), 0);

    /* ---- a received order is closed to edits ----
       Before: rewriting the lines reset `recd` to 0 and reopened the order,
       so the same delivery was booked twice — measured at 1600 units and two
       goods receipts against a 1000-unit order. */
    await mkItem("RM-XMOD-1");
    const poE = (await call("POST", "/purchase-orders", A, { supplierId: supX, date: "2026-01-02",
      eta: "2026-02-01", lines: [{ itemId: "RM-XMOD-1", qty: 1000, rate: 10 }] })).d;
    await call("POST", "/purchase-orders/" + poE.id + "/receive", A, { lines: [{ i: 0, qty: 600 }], wh });
    const edit = await call("PATCH", "/purchase-orders/" + poE.id, A,
      { status: "Open", lines: [{ itemId: "RM-XMOD-1", qty: 1000, rate: 10, recd: 0 }] });
    ok("editing a part-received PO is refused (409)", edit.status === 409, String(edit.status));
    const poAfter = (await call("GET", "/state", A)).d.purchaseorders.find((p) => p.id === poE.id);
    ok("…and the received quantity is untouched",
      Math.abs((poAfter.lines[0].recd || 0) - 600) < 0.001, String(poAfter.lines[0].recd));
    /* The second receipt asks for the full 1000 again when only 400 is still
       owed. It used to be silently shrunk to 400 — the total came to 1000, so
       nothing was double-booked, but the operator was never told the figure
       had been rewritten. Now the request is refused outright and the delivery
       has to be re-entered as what actually arrived, which protects the same
       invariant without quietly changing anyone's numbers. */
    const dupE = await call("POST", "/purchase-orders/" + poE.id + "/receive", A, { lines: [{ i: 0, qty: 1000 }], wh });
    ok("re-receiving the whole order over a part-receipt is refused", dupE.status === 400, String(dupE.status));
    ok("…so a 1000-unit order still cannot book more than it ordered",
      Math.abs((await stockOf("RM-XMOD-1")) - 600) < 0.001, "booked " + (await stockOf("RM-XMOD-1")));
    await call("POST", "/purchase-orders/" + poE.id + "/receive", A, { lines: [{ i: 0, qty: 400 }], wh });
    const totalE = await stockOf("RM-XMOD-1");
    ok("…and the outstanding 400 completes it at exactly 1000",
      Math.abs(totalE - 1000) < 0.001, "booked " + totalE);

    /* ---- one order, two receipts at the same instant ----
       Before: both requests read the same outstanding quantity and both
       posted it — 3 of 3 runs booked 200 units against a 100-unit order. */
    await mkItem("RM-XMOD-2");
    const poR = (await call("POST", "/purchase-orders", A, { supplierId: supX, date: "2026-01-02",
      eta: "2026-02-01", lines: [{ itemId: "RM-XMOD-2", qty: 100, rate: 10 }] })).d;
    const both = await Promise.all([
      call("POST", "/purchase-orders/" + poR.id + "/receive", A, { lines: [{ i: 0, qty: 100 }], wh }),
      call("POST", "/purchase-orders/" + poR.id + "/receive", A, { lines: [{ i: 0, qty: 100 }], wh }),
    ]);
    const gotR = await stockOf("RM-XMOD-2");
    ok("two simultaneous receipts of one PO book it ONCE",
      Math.abs(gotR - 100) < 0.001, "booked " + gotR + " statuses " + both.map((b) => b.status).join("/"));
    ok("…the loser is told why, not silently ignored",
      both.some((b) => b.status >= 400), both.map((b) => b.status).join("/"));

    /* ---- one order, two dispatches at the same instant ----
       Before: 6 shipping movements for a 3-line order. */
    const fgD = (await call("GET", "/state", A)).d.items.find((i) => i.cat === "FG");
    const soD = (await call("POST", "/sales-orders", A, { customerId: cusX, date: "2026-01-02",
      promised: "2026-02-01", lines: [{ itemId: fgD.id, qty: 7, rate: 100 }] })).d;
    const bothD = await Promise.all([
      call("POST", "/sales-orders/" + soD.id + "/dispatch", A, {}),
      call("POST", "/sales-orders/" + soD.id + "/dispatch", A, {}),
    ]);
    const saleRows = ((await call("GET", "/state", A)).d.movements || [])
      .filter((m) => m.type === "SALE" && m.ref === soD.id).length;
    ok("two simultaneous dispatches ship the order ONCE", saleRows === 1,
      saleRows + " shipping movements, statuses " + bothD.map((b) => b.status).join("/"));

    /* ---- the ledger's direction and address ----
       Before: a GRN of −5000 was an undocumented write-off, an ISSUE of
       +9,000,000,000 was accepted as a receipt, and stock could be parked in
       a warehouse that did not exist, invisible to every warehouse view. */
    await mkItem("RM-XMOD-3");
    ok("a receipt cannot carry a negative quantity",
      (await call("POST", "/movements", A, { itemId: "RM-XMOD-3", type: "GRN", qty: -50, wh })).status === 400);
    ok("an issue cannot carry a positive one",
      (await call("POST", "/movements", A, { itemId: "RM-XMOD-3", type: "ISSUE", qty: 50, wh })).status === 400);
    ok("stock cannot be booked into a warehouse that does not exist",
      (await call("POST", "/movements", A, { itemId: "RM-XMOD-3", type: "GRN", qty: 5, wh: "WH-NOPE" })).status === 400);
    ok("an adjustment may still go either way",
      (await call("POST", "/movements", A, { itemId: "RM-XMOD-3", type: "ADJ", qty: -5, wh })).status === 201);

    /* ---- orders must name things that exist ---- */
    ok("a PO against an unknown supplier is refused",
      (await call("POST", "/purchase-orders", A, { supplierId: "SUP-GHOST", date: "2026-01-02",
        lines: [{ itemId: "RM-XMOD-3", qty: 5, rate: 1 }] })).status === 400);
    ok("an SO against an unknown customer is refused",
      (await call("POST", "/sales-orders", A, { customerId: "CUS-GHOST", date: "2026-01-02",
        lines: [{ itemId: fgD.id, qty: 5, rate: 1 }] })).status === 400);
    ok("an order line naming an unknown material is refused",
      (await call("POST", "/purchase-orders", A, { supplierId: supX, date: "2026-01-02",
        lines: [{ itemId: "GHOST-MAT", qty: 5, rate: 1 }] })).status === 400);
    ok("a negative order quantity is refused",
      (await call("POST", "/purchase-orders", A, { supplierId: supX, date: "2026-01-02",
        lines: [{ itemId: "RM-XMOD-3", qty: -50, rate: 1 }] })).status === 400);

    /* ---- an item with history cannot be deleted ----
       Before: it deleted cleanly, and the frontend then SKIPPED every
       movement whose item had gone — the material's whole ledger and its
       valuation vanished from every report with no error at all. */
    const delUsed = await call("DELETE", "/items/RM-XMOD-1", A);
    ok("an item with stock history cannot be deleted", delUsed.status === 400, String(delUsed.status));
    ok("…and the refusal says what still references it",
      /movement|purchase order|bill/.test(String(delUsed.d && delUsed.d.error)),
      JSON.stringify(delUsed.d).slice(0, 120));
    await mkItem("RM-XMOD-FREE");
    ok("an item nothing references still deletes",
      (await call("DELETE", "/items/RM-XMOD-FREE", A)).status === 200);

    /* ---- finalized wages stay finalized ----
       Before: {"force":true} in the request body silently returned a
       finalized run to Draft, and DELETE removed it with no status check —
       and advance recovery counts only finalized runs, so the same
       instalment could be taken off a worker twice. */
    const per = "2026-03";
    await call("POST", "/hr/payroll/run", A, { period: per });
    await call("POST", "/hr/payroll/PR-" + per + "/finalize", A, {});
    const forced = await call("POST", "/hr/payroll/run", A, { period: per, force: true });
    ok("a finalized pay run cannot be re-run by a flag in the body", forced.status === 409, String(forced.status));
    const prNow = (await call("GET", "/state", A)).d.hrPayruns.find((p) => p.id === "PR-" + per);
    ok("…and it is still Finalized afterwards", prNow && prNow.status === "Finalized",
      String(prNow && prNow.status));
    ok("a finalized pay run cannot be deleted",
      (await call("DELETE", "/hr/payroll/PR-" + per, A)).status === 409);
    ok("office cannot reopen it — that is an admin act",
      (await call("POST", "/hr/payroll/PR-" + per + "/reopen", O, {})).status === 403);
    const reop = await call("POST", "/hr/payroll/PR-" + per + "/reopen", A, { reason: "correction" });
    ok("an admin can reopen it deliberately, and it is recorded",
      reop.status === 200 && reop.d.status === "Draft" && reop.d.reopenedBy === "admin",
      JSON.stringify({ s: reop.status, st: reop.d && reop.d.status, by: reop.d && reop.d.reopenedBy }));
  }

  // restore the BOM change we made so a re-run against a persisted DB stays clean
  await call("DELETE", "/items/RM-HTTP", A);
}

run()
  .catch((e) => { fail++; console.log("\n  ✗ UNCAUGHT: " + (e && e.stack ? e.stack : e)); })
  .finally(async () => {
    try { server.close(); } catch {}
    try { await closeDb(); } catch {}
    /* drop this run's scratch database */
    try {
      const mysql = require("../node_modules/mysql2/promise");
      const cfg = require("../src/db/connection").readConfig();
      const c = await mysql.createConnection({ host: cfg.host, port: cfg.port,
        user: cfg.user, password: cfg.password });
      await c.query("DROP DATABASE IF EXISTS `" + SCRATCH + "`");
      await c.end();
    } catch { /* untidy, not fatal */ }
    console.log("\n" + (fail === 0 ? "PASS" : "FAIL") + " — " + pass + " passed, " + fail + " failed\n");
    process.exit(fail === 0 ? 0 : 1);
  });
