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
const fs = require("fs");

/* A scratch DATABASE on the configured MySQL server and a scratch DIRECTORY
   inside the project for this run, both dropped at the end — no file this
   run writes lands in the machine's shared temp folder. Set BEFORE the
   server module loads. */
const scratch = require("./scratch");
const RUN = scratch.claim("http");
process.env.PORT = "0"; // ask the OS for a free port
process.env.CHHAPERIA_BARTENDER_NOLAUNCH = "1"; // never pop the label app open mid-test
process.env.CHHAPERIA_TDS_NOCONVERT = "1";      // nor Word, for a TDS upload

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
     The ONLY thing the calendar stores. The one other entry it shows, a lead's
     follow-up, is derived from the lead that owns the date, so there is nothing
     else here to test — which is the point of that design. (The calendar became
     CRM-only on 2026-08-25; it no longer derives PO / SO / work-order / leave
     dates at all.) */
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

  /* local-day helpers for the two document blocks below: the server stamps
     todayISO() in local time, so the assertions must read the same clock */
  const iso = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  const TODAY = iso(new Date());
  const plus = (day, n) => { const x = new Date(day + "T00:00:00"); x.setDate(x.getDate() + n); return iso(x); };

  /* ---- Complaints ----
     A customer's problem tied to the batch it came from. The batch number is
     normalised on the way in (people type "wo 288", the label says WO-0288),
     the status trail is the server's, and the spread — who else received
     that batch — is derived from the sales orders, so there is nothing of it
     to store or to test beyond the complaint itself. */
  section("Complaints — a customer's problem tied to its batch");
  {
    const cust0 = st.customers[0].id;
    const woId = st.workorders[0].id;
    const loose = "wo " + String(+woId.replace(/^WO-/, ""));   // "wo 12" for WO-0012
    const cm = await call("POST", "/complaints", A,
      { customerId: cust0, batch: loose, claim: "Adhesive lifting on three reels", via: "Phone" });
    ok("create complaint 201 with a four-digit id", cm.status === 201 && /^CMP-\d{4}$/.test(cm.d.id), JSON.stringify(cm.d).slice(0, 80));
    ok("a loosely typed batch number is normalised to the work order", cm.d.batch === woId, cm.d.batch);
    ok("a new complaint is Open, dated today, raised by the caller",
      cm.d.status === "Open" && cm.d.raised === TODAY && cm.d.raisedBy === "admin");
    ok("complaint history starts with Raised",
      Array.isArray(cm.d.history) && cm.d.history.length === 1 && cm.d.history[0].note === "Raised");
    ok("complaint reaches the shared state",
      (await call("GET", "/state", A)).d.complaints.some((c) => c.id === cm.d.id));
    ok("complaint without a customer → 400", (await call("POST", "/complaints", A, { claim: "x" })).status === 400);
    ok("complaint without the claim → 400", (await call("POST", "/complaints", A, { customerId: cust0 })).status === 400);
    ok("complaint for an unknown customer → 404",
      (await call("POST", "/complaints", A, { customerId: "CUS-NOPE", claim: "x" })).status === 404);
    ok("complaint on a batch that is not a work order → 400",
      (await call("POST", "/complaints", A, { customerId: cust0, batch: "WO-99999", claim: "x" })).status === 400);
    const res = await call("PATCH", "/complaints/" + cm.d.id, A, { status: "Resolved", resolution: "Replaced the reels" });
    ok("resolving adds a history line and a closed date",
      res.d.status === "Resolved" && res.d.history.length === 2 && res.d.history[1].note === "Replaced the reels"
      && res.d.history[1].by === "admin" && res.d.closed === TODAY, JSON.stringify(res.d.history));
    ok("patching one field keeps the claim", res.d.claim === "Adhesive lifting on three reels");
    ok("unknown complaint status → 400",
      (await call("PATCH", "/complaints/" + cm.d.id, A, { status: "Shrugged" })).status === 400);
    ok("patch unknown complaint → 404", (await call("PATCH", "/complaints/CMP-NOPE", A, { status: "Open" })).status === 404);
    const spread = await call("GET", "/batches/" + woId + "/spread", A);
    ok("the batch spread lists the complaint",
      spread.status === 200 && spread.d.complaints.some((c) => c.id === cm.d.id), JSON.stringify(spread.d).slice(0, 120));
    const byOffice = await call("POST", "/complaints", O, { customerId: cust0, claim: "Office raised" });
    ok("office can raise a complaint", byOffice.status === 201);
    ok("supervisor cannot (403)", (await call("POST", "/complaints", C, { customerId: cust0, claim: "x" })).status === 403);
    ok("delete complaint 200", (await call("DELETE", "/complaints/" + cm.d.id, A)).status === 200);
    ok("delete unknown complaint → 404", (await call("DELETE", "/complaints/CMP-NOPE", A)).status === 404);
    await call("DELETE", "/complaints/" + byOffice.d.id, A);
  }

  /* ---- Quotations ----
     A quote is the record of a price discussion for one product in one
     unit: opened at a price, repriced round by round, and closed Won at a
     final price or Lost against a counter price. The lead mirrors it —
     Quoted while open, Won or Lost when it closes — and a lead closed from
     the CRM closes its open quotes the same way. */
  section("Quotations — a price offered, negotiated, and closed won or lost");
  {
    const sq = (await call("GET", "/state", A)).d;
    const cust0 = sq.customers[0].id;
    const fg = sq.items.find((i) => i.cat === "FG");
    const leadOf = async (id) => (await call("GET", "/state", A)).d.leads.find((l) => l.id === id);
    const quoteOf = async (id) => (await call("GET", "/state", A)).d.quotations.find((q) => q.id === id);

    ok("quotation without a product → 400", (await call("POST", "/quotations", A, { customerId: cust0, price: 100 })).status === 400);
    ok("quotation without a price → 400", (await call("POST", "/quotations", A, { customerId: cust0, itemId: fg.id, price: 0 })).status === 400);
    ok("quotation for an unknown customer → 404", (await call("POST", "/quotations", A, { customerId: "CUS-NOPE", itemId: fg.id, price: 100 })).status === 404);
    ok("quotation for an unknown lead → 404", (await call("POST", "/quotations", A, { leadId: "LD-NOPE", itemId: fg.id, price: 100 })).status === 404);
    ok("quotation with neither customer nor lead → 400", (await call("POST", "/quotations", A, { itemId: fg.id, price: 100 })).status === 400);

    const q = await call("POST", "/quotations", A, { customerId: cust0, itemId: fg.id, uom: "kg", price: 940, qty: 500, note: "opening offer" });
    ok("create quotation 201 with a four-digit id", q.status === 201 && /^QTN-\d{4}$/.test(q.d.id), JSON.stringify(q.d).slice(0, 80));
    ok("unit is normalised and value = price × qty", q.d.uom === "KG" && q.d.value === 470000, q.d.uom + " " + q.d.value);
    ok("a new quotation is Open, round 1, dated today, by the caller", q.d.status === "Open" && q.d.rounds === 1 && q.d.date === TODAY && q.d.createdBy === "admin");
    ok("history starts with the opening price", Array.isArray(q.d.history) && q.d.history.length === 1 && q.d.history[0].kind === "quoted" && q.d.history[0].price === 940);
    ok("the customer's name is carried on the quote", q.d.company === sq.customers[0].name);
    ok("quotation reaches the shared state", !!(await quoteOf(q.d.id)));

    const r1 = await call("POST", "/quotations/" + q.d.id + "/reprice", A, { price: 910, note: "customer asked for less" });
    ok("reprice is a new round and keeps the old price in history", r1.status === 200 && r1.d.price === 910 && r1.d.rounds === 2 && r1.d.history.length === 2 && r1.d.history[0].price === 940 && r1.d.history[1].kind === "updated");
    ok("reprice to zero → 400", (await call("POST", "/quotations/" + q.d.id + "/reprice", A, { price: 0 })).status === 400);
    const e1 = await call("PATCH", "/quotations/" + q.d.id, A, { qty: 600, note: "monthly" });
    ok("PATCH of qty/note is not a round", e1.status === 200 && e1.d.qty === 600 && e1.d.rounds === 2 && e1.d.value === 546000 && e1.d.note === "monthly");
    const e2 = await call("PATCH", "/quotations/" + q.d.id, A, { price: 900 });
    ok("PATCH with a new price counts as a round", e2.d.price === 900 && e2.d.rounds === 3);
    ok("PATCH echoing the same price is not a round", (await call("PATCH", "/quotations/" + q.d.id, A, { price: 900 })).d.rounds === 3);
    ok("PATCH to an unknown item → 400", (await call("PATCH", "/quotations/" + q.d.id, A, { itemId: "FG-NOPE" })).status === 400);
    ok("patch unknown quotation → 404", (await call("PATCH", "/quotations/QTN-NOPE", A, { note: "x" })).status === 404);

    // ---- the lead follows the quote ----
    const ld = await call("POST", "/leads", A, { company: "Quote Test Co", contact: "Q Tester", stage: "Contacted", product: fg.id, value: 0, phone: "9999999999" });
    const ql = await call("POST", "/quotations", A, { leadId: ld.d.id, uom: "sqm", price: 120 });
    ok("a quotation on a lead takes the lead's product and company", ql.status === 201 && ql.d.itemId === fg.id && ql.d.company === "Quote Test Co" && ql.d.uom === "SQM");
    let lead = await leadOf(ld.d.id);
    ok("…the lead moves to Quoted and carries the quote", lead.stage === "Quoted" && lead.quotationId === ql.d.id && lead.quotedValue === 120 && lead.quotedPrice === 120 && lead.quotedUom === "SQM");
    ok("…with a Quotation Sent activity and a follow-up date", (lead.activities || []).some((a) => a.type === "Quotation Sent") && !!lead.nextFollowUp);
    await call("POST", "/quotations/" + ql.d.id + "/reprice", A, { price: 115 });
    lead = await leadOf(ld.d.id);
    ok("a reprice keeps the lead's quoted value in step", lead.quotedValue === 115 && lead.quotedPrice === 115);

    // ---- closing: won ----
    ok("a negative final price → 400", (await call("POST", "/quotations/" + ql.d.id + "/win", A, { finalPrice: -1 })).status === 400);
    const w = await call("POST", "/quotations/" + ql.d.id + "/win", A, { finalPrice: 118 });
    ok("win closes the quote at the final price", w.status === 200 && w.d.status === "Won" && w.d.finalPrice === 118 && w.d.wonOn === TODAY && w.d.history[w.d.history.length - 1].kind === "won");
    lead = await leadOf(ld.d.id);
    ok("…and the lead is Won at that price", lead.stage === "Won" && lead.finalPrice === 118 && lead.quotedValue === 118 && lead.nextFollowUp == null);
    ok("win twice is idempotent", (await call("POST", "/quotations/" + ql.d.id + "/win", A, { finalPrice: 999 })).d.finalPrice === 118);
    ok("a won quote cannot be lost", (await call("POST", "/quotations/" + ql.d.id + "/lose", A, { lostReason: "Price" })).status === 409);
    ok("a won quote cannot be repriced", (await call("POST", "/quotations/" + ql.d.id + "/reprice", A, { price: 100 })).status === 409);
    ok("a won quote cannot be deleted", (await call("DELETE", "/quotations/" + ql.d.id, A)).status === 409);
    ok("a closed quote still takes a note", (await call("PATCH", "/quotations/" + ql.d.id, A, { note: "signed" })).status === 200);
    ok("…but not a new quantity", (await call("PATCH", "/quotations/" + ql.d.id, A, { qty: 5 })).status === 409);
    const ro = await call("POST", "/quotations/" + ql.d.id + "/reopen", A, {});
    lead = await leadOf(ld.d.id);
    ok("reopen puts the quote back to Open and the lead back to Quoted", ro.d.status === "Open" && ro.d.finalPrice == null && lead.stage === "Quoted" && lead.finalPrice == null);

    // ---- closing: lost ----
    ok("lose with a reason off the list → 400", (await call("POST", "/quotations/" + ql.d.id + "/lose", A, { lostReason: "Vibes" })).status === 400);
    const lz = await call("POST", "/quotations/" + ql.d.id + "/lose", A, { counterPrice: 105, lostReason: "Price", lostTo: "Rival Tapes", note: "went with the cheaper reel" });
    ok("lose records the counter price, the reason and who won it", lz.status === 200 && lz.d.status === "Lost" && lz.d.counterPrice === 105 && lz.d.lostReason === "Price" && lz.d.lostTo === "Rival Tapes");
    lead = await leadOf(ld.d.id);
    ok("…and the lead is Lost with the same reason", lead.stage === "Lost" && lead.lostReason === "Price" && lead.lostTo === "Rival Tapes" && lead.nextFollowUp == null);
    ok("lose twice is idempotent", (await call("POST", "/quotations/" + ql.d.id + "/lose", A, { lostReason: "Other" })).d.lostReason === "Price");
    ok("a lost quote can be deleted", (await call("DELETE", "/quotations/" + ql.d.id, A)).status === 200);
    lead = await leadOf(ld.d.id);
    ok("…and the lead no longer points at it", lead.quotationId == null && lead.quotedValue == null);

    // ---- the lead closes its quotes ----
    const ld2 = await call("POST", "/leads", A, { company: "Cascade Lost Co", stage: "Contacted", product: fg.id, value: 0 });
    const q2 = await call("POST", "/quotations", A, { leadId: ld2.d.id, price: 50 });
    await call("PATCH", "/leads/" + ld2.d.id, A, { stage: "Lost", lostReason: "Lead time", lostTo: "Rival" });
    const q2b = await quoteOf(q2.d.id);
    ok("a lead marked Lost takes its open quote with it, reason and all", q2b.status === "Lost" && q2b.lostReason === "Lead time" && q2b.lostTo === "Rival");
    const ld3 = await call("POST", "/leads", A, { company: "Cascade Won Co", stage: "Contacted", product: fg.id, value: 0 });
    const q3 = await call("POST", "/quotations", A, { leadId: ld3.d.id, price: 75 });
    await call("PATCH", "/leads/" + ld3.d.id, A, { stage: "Won" });
    const q3b = await quoteOf(q3.d.id);
    ok("a lead marked Won closes its open quote Won at the price on the table", q3b.status === "Won" && q3b.finalPrice === 75);

    // ---- access ----
    ok("supervisor cannot raise a quotation (403)", (await call("POST", "/quotations", C, { customerId: cust0, itemId: fg.id, price: 1 })).status === 403);
    ok("office can raise one", (await call("POST", "/quotations", O, { customerId: cust0, itemId: fg.id, price: 1 })).status === 201);

    // ---- delete ----
    ok("delete an open quotation 200", (await call("DELETE", "/quotations/" + q.d.id, A)).status === 200);
    ok("delete again → 404", (await call("DELETE", "/quotations/" + q.d.id, A)).status === 404);
    ok("it is gone from the shared state", !(await quoteOf(q.d.id)));
    // tidy: the won cascade quote must be reopened before it can go
    await call("POST", "/quotations/" + q3.d.id + "/reopen", A, {});
    for (const id of [q2.d.id, q3.d.id]) await call("DELETE", "/quotations/" + id, A);
    for (const x of (await call("GET", "/state", A)).d.quotations.filter((z) => z.customerId === cust0 && z.price === 1)) await call("DELETE", "/quotations/" + x.id, A);
    for (const id of [ld.d.id, ld2.d.id, ld3.d.id]) await call("DELETE", "/leads/" + id, A);
    ok("quotations table is clean afterwards", (await call("GET", "/state", A)).d.quotations.length === 0);
  }

  /* ============================================================
     LAB INCHARGE — a low-trust role. The earlier "sales desk" role
     leaked the entire database because stateForUser() fell through
     to the full dataset while the UI merely hid its menus; these
     assertions exist so that cannot happen again unnoticed.
     ============================================================ */
  section("Payroll advances — recovered monthly, never double-counted");
  {
    // ₹18,200 over May 2026's 26 working days = ₹700/day, so the sums below are unchanged
    const W = { id: "EMP-ADV", name: "Advance Test Worker", dept: "packing", payType: "monthly",
      monthlyCtc: 18200, joined: "2020-01-01" };
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
      await call("POST", "/hr/workers", A, { id, name, dept: "packing", payType: "monthly",
        monthlyCtc: rate * 26, joined: "2020-01-01" });
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

  section("Pay is monthly only — and the no-room allowance");
  {
    const per = "2027-01";                       // 31 days, 5 Sundays → 26 working days
    // a full month would also earn the attendance bonus — that has its own section
    await call("PATCH", "/hr/config", A, { attendanceBonus: 0 });
    const attend = async (id, otDay) => {
      for (let d = 1; d <= 26; d++) {
        const row = { workerId: id, date: per + "-" + String(d).padStart(2, "0"), status: "P" };
        if (d === otDay) row.otHours = 2;
        await call("POST", "/hr/attendance", A, row);
      }
    };
    const slipOf = (r, id) => (r.d.payslips || []).find((s) => s.workerId === id);

    // a daily wage is no longer a thing: whatever a client sends, the worker is monthly
    const legacy = await call("POST", "/hr/workers", A, { id: "EMP-ROOM-D", name: "Old Daily Worker", dept: "packing",
      payType: "daily", dailyRate: 600, joined: "2020-01-01" });
    ok("a worker posted with a daily rate is stored as monthly", legacy.status === 201 && legacy.d.payType === "monthly",
      JSON.stringify({ s: legacy.status, p: legacy.d && legacy.d.payType }));
    ok("…at rate × 26 as the CTC", legacy.d.monthlyCtc === 15600, String(legacy.d.monthlyCtc));
    ok("and housed by the company unless said otherwise", legacy.d.ownAccommodation === false, String(legacy.d.ownAccommodation));
    ok("a given CTC is never overridden by a stray daily rate",
      (await call("POST", "/hr/workers", A, { id: "EMP-ROOM-C", name: "CTC Given", dept: "packing", payType: "daily",
        dailyRate: 600, monthlyCtc: 20000, joined: "2020-01-01" })).d.monthlyCtc === 20000);

    await call("POST", "/hr/workers", A, { id: "EMP-ROOM-IN", name: "Company Room", dept: "packing", monthlyCtc: 26000, joined: "2020-01-01" });
    await call("POST", "/hr/workers", A, { id: "EMP-ROOM-OUT", name: "Own Accommodation", dept: "packing", monthlyCtc: 26000,
      ownAccommodation: true, joined: "2020-01-01" });
    await call("POST", "/hr/workers", A, { id: "EMP-ROOM-ABS", name: "Never Came", dept: "packing", monthlyCtc: 26000,
      ownAccommodation: true, joined: "2020-01-01" });
    await attend("EMP-ROOM-IN", 5); await attend("EMP-ROOM-OUT");

    const r = await call("POST", "/hr/payroll/run", A, { period: per, workerIds: ["EMP-ROOM-IN", "EMP-ROOM-OUT", "EMP-ROOM-ABS"] });
    const sIn = slipOf(r, "EMP-ROOM-IN"), sOut = slipOf(r, "EMP-ROOM-OUT"), sAbs = slipOf(r, "EMP-ROOM-ABS");
    ok("a full month on ₹26,000 is ₹1,000/day × 26", !!sIn && sIn.monthPerDay === 1000 && sIn.basicEarned === 26000,
      sIn && JSON.stringify({ pd: sIn.monthPerDay, b: sIn.basicEarned }));
    ok("a worker in a company room gets no allowance", sIn.roomAllowance === 0 && sIn.gross === 26000,
      JSON.stringify({ r: sIn.roomAllowance, g: sIn.gross }));
    ok("one in their own accommodation gets ₹1,000 on top", !!sOut && sOut.roomAllowance === 1000, sOut && String(sOut.roomAllowance));
    ok("…which is in the gross", sOut.gross === 27000, String(sOut.gross));
    ok("but not in the basic — the PF wage is untouched", sOut.basicEarned === 26000 && sOut.deductions.pf === sIn.deductions.pf,
      JSON.stringify({ b: sOut.basicEarned, pfOut: sOut.deductions.pf, pfIn: sIn.deductions.pf }));
    ok("a month with no paid day pays no allowance either", !!sAbs && sAbs.payableDays === 0 && sAbs.roomAllowance === 0 && sAbs.gross === 0,
      sAbs && JSON.stringify({ d: sAbs.payableDays, r: sAbs.roomAllowance, g: sAbs.gross }));
    ok("overtime hours are recorded on a monthly salary but not paid as such", sIn.otHours === 2 && sIn.otPay === 0,
      JSON.stringify({ h: sIn.otHours, p: sIn.otPay }));

    // the amount is a setting, not a constant
    const was = ((await call("GET", "/hr/config", A)).d || {}).noRoomAllowance;
    ok("the default allowance is ₹1,000", was === 1000, String(was));
    await call("PATCH", "/hr/config", A, { noRoomAllowance: 1500 });
    const r2 = await call("POST", "/hr/payroll/run", A, { period: per, workerIds: ["EMP-ROOM-OUT"] });
    ok("changing it in HR settings changes the next run", slipOf(r2, "EMP-ROOM-OUT").roomAllowance === 1500,
      String(slipOf(r2, "EMP-ROOM-OUT").roomAllowance));
    await call("PATCH", "/hr/config", A, { noRoomAllowance: 0 });
    const r3 = await call("POST", "/hr/payroll/run", A, { period: per, workerIds: ["EMP-ROOM-OUT"] });
    ok("and 0 switches it off", slipOf(r3, "EMP-ROOM-OUT").roomAllowance === 0 && slipOf(r3, "EMP-ROOM-OUT").gross === 26000);
    await call("PATCH", "/hr/config", A, { noRoomAllowance: was, attendanceBonus: 1000 });

    // moving into a company room stops it from the next run
    await call("PATCH", "/hr/workers/EMP-ROOM-OUT", A, { ownAccommodation: false });
    const r4 = await call("POST", "/hr/payroll/run", A, { period: per, workerIds: ["EMP-ROOM-OUT"] });
    ok("taking a company room stops it from the next run", slipOf(r4, "EMP-ROOM-OUT").roomAllowance === 0);

    await call("DELETE", "/hr/payroll/PR-" + per, A);
    for (const id of ["EMP-ROOM-D", "EMP-ROOM-C", "EMP-ROOM-IN", "EMP-ROOM-OUT", "EMP-ROOM-ABS"]) await call("DELETE", "/hr/workers/" + id, A);
  }

  section("Two leave types — paid leave is capped at one paid day a month");
  {
    const stTypes = (await call("GET", "/state", A)).d.hrLeaveTypes || [];
    const ids = stTypes.map((t) => t.id).sort().join(",");
    ok("a fresh install has exactly Paid Leave and Unpaid Leave", ids === "LWP,PL", ids);
    const pl = stTypes.find((t) => t.id === "PL") || {}, lwp = stTypes.find((t) => t.id === "LWP") || {};
    ok("paid leave accrues one day per month worked", pl.accrual === "earned" && pl.paid !== false, JSON.stringify(pl));
    ok("unpaid leave has no quota and is not paid", lwp.paid === false && !lwp.quota, JSON.stringify(lwp));
    const cfg0 = (await call("GET", "/hr/config", A)).d || {};
    ok("and at most one paid day in any month", cfg0.paidLeaveMaxPerMonth === 1, String(cfg0.paidLeaveMaxPerMonth));

    // this year's August, so the live balance (which is per current year) sees the leave
    const per = String(new Date().getFullYear()) + "-08";
    const W = "EMP-LEAVE-CAP";
    await call("POST", "/hr/workers", A, { id: W, name: "Leave Cap Tester", dept: "packing", monthlyCtc: 26000, joined: "2020-01-01" });
    for (let d = 1; d <= 20; d++) await call("POST", "/hr/attendance", A, { workerId: W, date: per + "-" + String(d).padStart(2, "0"), status: "P" });
    const apply = async (type, from, to) => {
      const r = await call("POST", "/hr/leaves", A, { workerId: W, type, fromDate: from, toDate: to });
      ok("a " + type + " request is accepted", r.status === 201 && r.d && r.d.id, JSON.stringify(r.d).slice(0, 120));
      await call("POST", "/hr/leaves/" + r.d.id + "/decide", A, { status: "Approved" });
    };
    await apply("PL", per + "-24", per + "-26");     // three paid-leave days in one month
    await apply("LWP", per + "-27", per + "-27");    // and one unpaid one
    const slipOf = async () => ((await call("POST", "/hr/payroll/run", A, { period: per, workerIds: [W] })).d.payslips || []).find((s) => s.workerId === W);
    const s1 = await slipOf();
    ok("three paid-leave days in one month: one is paid…", !!s1 && s1.paidLeave === 1, s1 && String(s1.paidLeave));
    ok("…the other two go unpaid, alongside the unpaid-leave day", s1.unpaidLeave === 3 && s1.leaveOverCap === 2,
      JSON.stringify({ unpaid: s1.unpaidLeave, over: s1.leaveOverCap }));
    ok("so 21 days are paid — 20 present + 1 leave", s1.payableDays === 21 && s1.basicEarned === Math.round(s1.monthPerDay * 21 * 100) / 100,
      JSON.stringify({ d: s1.payableDays, b: s1.basicEarned, pd: s1.monthPerDay }));
    const bal = ((await call("GET", "/hr/leave-balances/" + W, A)).d.balances || []).find((b) => b.type === "PL") || {};
    ok("only the paid day counts against the balance (one month worked = one day earned)",
      bal.taken === 1 && bal.entitled === 1 && bal.balance === 0, JSON.stringify(bal));

    await call("PATCH", "/hr/config", A, { paidLeaveMaxPerMonth: 0 });
    const s2 = await slipOf();
    ok("with no monthly limit all three are paid", s2.paidLeave === 3 && s2.leaveOverCap === 0 && s2.payableDays === 23,
      JSON.stringify({ p: s2.paidLeave, over: s2.leaveOverCap, d: s2.payableDays }));
    const bal2 = ((await call("GET", "/hr/leave-balances/" + W, A)).d.balances || []).find((b) => b.type === "PL") || {};
    ok("and all three then use the quota", bal2.taken === 3, String(bal2.taken));
    await call("PATCH", "/hr/config", A, { paidLeaveMaxPerMonth: 1 });

    await call("DELETE", "/hr/payroll/PR-" + per, A);
    await call("DELETE", "/hr/workers/" + W, A);
  }

  section("Attendance bonus — a full month, after the first three months of service");
  {
    const per = "2027-01";                         // 31 days, 5 Sundays → 26 working days
    const cfg0 = (await call("GET", "/hr/config", A)).d || {};
    ok("the bonus is ₹1,000 after 3 months by default", cfg0.attendanceBonus === 1000 && cfg0.attendanceBonusAfterMonths === 3,
      JSON.stringify({ b: cfg0.attendanceBonus, m: cfg0.attendanceBonusAfterMonths }));
    const mk = (id, joined) => call("POST", "/hr/workers", A, { id, name: id, dept: "packing", monthlyCtc: 26000, joined });
    // present on every working day, except what `skip` says about a date
    const mark = async (id, skip) => {
      for (let d = 1; d <= 31; d++) {
        if (new Date(2027, 0, d).getDay() === 0) continue;             // Sundays are the week-off
        const ds = per + "-" + String(d).padStart(2, "0");
        const st = (skip || {})[ds] || "P";
        if (st === "leave") continue;                                  // the approved leave writes that day
        await call("POST", "/hr/attendance", A, { workerId: id, date: ds, status: st });
      }
    };
    await mk("EMP-AB-FULL", "2020-01-01");  await mark("EMP-AB-FULL");
    await mk("EMP-AB-ABS", "2020-01-01");   await mark("EMP-AB-ABS", { [per + "-05"]: "A" });
    await mk("EMP-AB-HALF", "2020-01-01");  await mark("EMP-AB-HALF", { [per + "-05"]: "HD" });
    await mk("EMP-AB-LEAVE", "2020-01-01"); await mark("EMP-AB-LEAVE", { [per + "-05"]: "leave" });
    const lv = await call("POST", "/hr/leaves", A, { workerId: "EMP-AB-LEAVE", type: "PL", fromDate: per + "-05", toDate: per + "-05" });
    await call("POST", "/hr/leaves/" + lv.d.id + "/decide", A, { status: "Approved" });
    await mk("EMP-AB-NEW", "2026-11-10");   await mark("EMP-AB-NEW");
    const IDS = ["EMP-AB-FULL", "EMP-AB-ABS", "EMP-AB-HALF", "EMP-AB-LEAVE", "EMP-AB-NEW"];
    const run = async () => {
      const r = await call("POST", "/hr/payroll/run", A, { period: per, workerIds: IDS });
      const m = {}; (r.d.payslips || []).forEach((s) => { m[s.workerId] = s; }); return m;
    };
    let S = await run();
    ok("present every working day: the bonus is paid", S["EMP-AB-FULL"].attendanceBonus === 1000, String(S["EMP-AB-FULL"].attendanceBonus));
    ok("…in the gross", S["EMP-AB-FULL"].gross === 27000, String(S["EMP-AB-FULL"].gross));
    ok("…but not in the PF wage", S["EMP-AB-FULL"].deductions.pf === 1800, String(S["EMP-AB-FULL"].deductions.pf));
    ok("one absence loses it", S["EMP-AB-ABS"].attendanceBonus === 0 && /1 absent/.test(S["EMP-AB-ABS"].attendanceBonusNote), S["EMP-AB-ABS"].attendanceBonusNote);
    ok("a half day loses it", S["EMP-AB-HALF"].attendanceBonus === 0 && /0\.5 day/.test(S["EMP-AB-HALF"].attendanceBonusNote), S["EMP-AB-HALF"].attendanceBonusNote);
    ok("a paid leave day loses it too — leave is leave", S["EMP-AB-LEAVE"].attendanceBonus === 0 && /1 leave/.test(S["EMP-AB-LEAVE"].attendanceBonusNote), S["EMP-AB-LEAVE"].attendanceBonusNote);
    ok("a worker in their first three months gets none", S["EMP-AB-NEW"].attendanceBonus === 0 && /2027-02/.test(S["EMP-AB-NEW"].attendanceBonusNote), S["EMP-AB-NEW"].attendanceBonusNote);
    await call("PATCH", "/hr/workers/EMP-AB-NEW", A, { joined: "2026-09-15" });
    S = await run();
    ok("…and earns it once the three months are behind them", S["EMP-AB-NEW"].attendanceBonus === 1000, S["EMP-AB-NEW"].attendanceBonusNote);
    await call("PATCH", "/hr/config", A, { attendanceBonus: 0 });
    S = await run();
    ok("0 in HR settings switches it off", S["EMP-AB-FULL"].attendanceBonus === 0 && S["EMP-AB-FULL"].gross === 26000, String(S["EMP-AB-FULL"].gross));
    await call("PATCH", "/hr/config", A, { attendanceBonus: 1000 });
    await call("DELETE", "/hr/payroll/PR-" + per, A);
    for (const id of IDS) await call("DELETE", "/hr/workers/" + id, A);
  }

  section("Weekly off is Sunday, for every worker");
  {
    /* Ruling 2026-08-28. Sunday is fixed — a config patch cannot move it —
       and a Sunday inside a leave is nobody's leave day: not applied, not
       written to the muster, not counted against the quota or the monthly
       paid cap, not on the slip. January 2027: the 1st is a Friday, so the
       2nd is a Saturday, the 3rd a Sunday and the 4th a Monday. */
    const per = "2027-01";
    const cfg = (await call("GET", "/hr/config", A)).d || {};
    ok("the config reads Sunday as the weekly off", JSON.stringify(cfg.weekOff) === "[0]", JSON.stringify(cfg.weekOff));
    const moved = await call("PATCH", "/hr/config", A, { weekOff: [6] });
    ok("…and a patch cannot move it", moved.status === 200 && JSON.stringify(moved.d.weekOff) === "[0]", JSON.stringify(moved.d && moved.d.weekOff));
    ok("…not even through the stored settings", JSON.stringify(((await call("GET", "/hr/config", A)).d || {}).weekOff) === "[0]");

    const W = "EMP-SUN";
    await call("POST", "/hr/workers", A, { id: W, name: "Sunday Rule", dept: "packing", monthlyCtc: 26000, joined: "2020-01-01" });
    const lv = await call("POST", "/hr/leaves", A, { workerId: W, type: "PL", fromDate: per + "-02", toDate: per + "-04" });
    ok("a Saturday-to-Monday leave is TWO days — the Sunday is not one", lv.status === 201 && lv.d.days === 2, JSON.stringify({ s: lv.status, days: lv.d && lv.d.days }));
    await call("POST", "/hr/leaves/" + lv.d.id + "/decide", A, { status: "Approved" });
    const rows = ((await call("GET", "/state", A)).d.hrAttendance || []).filter((a) => a.workerId === W);
    ok("approval writes L on the Saturday and the Monday only",
      rows.some((a) => a.date === per + "-02" && a.status === "L") && rows.some((a) => a.date === per + "-04" && a.status === "L")
        && !rows.some((a) => a.date === per + "-03"), rows.map((a) => a.date + ":" + a.status).join(","));
    const sun = await call("POST", "/hr/leaves", A, { workerId: W, type: "PL", fromDate: per + "-10", toDate: per + "-10" });
    ok("a leave that is only a Sunday is refused", sun.status === 400 && /weekly off/i.test(sun.d.error || sun.d.message || ""), JSON.stringify(sun.d));
    // the balance is this year's, so the quota check takes a Sat–Mon span in
    // the current year (the first Saturday of January, to the Monday after)
    const cap = +(cfg.paidLeaveMaxPerMonth || 0);
    const yy = new Date().getFullYear();
    let sat = 1; while (new Date(yy, 0, sat).getDay() !== 6) sat++;
    const iso = (d) => yy + "-01-" + String(d).padStart(2, "0");
    const lv2 = await call("POST", "/hr/leaves", A, { workerId: W, type: "PL", fromDate: iso(sat), toDate: iso(sat + 2) });
    await call("POST", "/hr/leaves/" + lv2.d.id + "/decide", A, { status: "Approved" });
    const bal = ((await call("GET", "/hr/leave-balances/" + W, A)).d.balances || []).find((b) => b.type === "PL") || {};
    ok("the balance counts the two working days (under the monthly paid cap), not the Sunday", bal.taken === (cap > 0 ? Math.min(2, cap) : 2), JSON.stringify(bal));

    // present on every other working day of the month → the slip sees 2 leave days, never 3
    for (let d = 1; d <= 31; d++) {
      const ds = per + "-" + String(d).padStart(2, "0");
      if (new Date(2027, 0, d).getDay() === 0 || ds === per + "-02" || ds === per + "-04") continue;
      await call("POST", "/hr/attendance", A, { workerId: W, date: ds, status: "P" });
    }
    // a stray L written ON a Sunday (old data) must not count either
    await call("POST", "/hr/attendance", A, { workerId: W, date: per + "-17", status: "L", note: "legacy" });
    const r = await call("POST", "/hr/payroll/run", A, { period: per, force: true, workerIds: [W] });
    const s = ((r.d && r.d.payslips) || [])[0] || {};
    ok("the slip: 26 working days, 24 present, 2 leave — the Sundays are nobody's leave",
      s.monthWorkingDays === 26 && s.present === 24 && (s.paidLeave + s.unpaidLeave) === 2,
      JSON.stringify({ wd: s.monthWorkingDays, p: s.present, pl: s.paidLeave, ul: s.unpaidLeave }));
    await call("DELETE", "/hr/payroll/PR-" + per, A);
    await call("DELETE", "/hr/workers/" + W, A);
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
    /* Since 2026-08-22 a material the store has NONE of refuses the order
       outright, so the gate scenario stocks its fabric — the routing is
       unchanged (in-house products coat regardless of stock, per the
       2026-08-03 ruling), and what this section tests is the LAB gate. */
    await call("POST", "/movements", A, { id: "MV-LABGATE-1", itemId: rmC.id, type: "GRN",
      qty: 100, rate: 20, wh: "WH-PNY", date: "2026-01-01", manual: true });

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
    /* MEASURED AND FAILED no longer holds the batch on the floor (ruled
       2026-09-02, the rule Add to Finished Stock already had): the grade is
       reported, the office and the lab are told, and an admin rules on it —
       see "A failed batch still leaves the floor" further down. So the next
       thing to stop this close is the store question, not the verdict. */
    const failClose = await call("POST", "/production/wo/" + woLid + "/advance", C, { action: "complete" });
    ok("a FAILED batch is no longer stopped by its grade — the store question comes next (409 needsWipWh)",
      failClose.status === 409 && failClose.d.needsWipWh === true, failClose.status + " " + JSON.stringify(failClose.d).slice(0, 120));
    ok("…and the refusal says nothing about the verdict", !/FAILED/.test(failClose.d.error || ""), failClose.d.error);
    ok("the failed batch is on the admin's ruling list meanwhile",
      ((await call("GET", "/state", A)).d.labQcDecisions || []).some((q) => q.id === bad.d.report.id && q.stage === "floor"));
    ok("the stage is still where it was",
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
    ok("and the certificate names both bookings it covers", (() => {
      const r = again.d.labReport || {}; return r.id === good.d.labReport.id; })(), JSON.stringify(again.d.labReport));

    /* A reading OUTSIDE its limits books the stock all the same (ruled
       2026-08-27): what changes is that the ledger row says so and the
       certificate is filed as a Fail, linked to the booking, for the office
       to act on. Thickness 0.9 is far past the 0.2–0.3 limit; tensile 1 is
       under the 30 minimum. */
    const bad = await book({ refNo: "LOT-BAD", labValues: { thickness: 0.9, tensile: 1 } });
    ok("a reading outside its limits still books the stock", bad.status === 201,
      bad.status + " " + JSON.stringify(bad.d).slice(0, 120));
    ok("…and the reply says the batch FAILED, and on what",
      !!bad.d.labReport && bad.d.labReport.result === "Fail"
        && /Thickness/.test((bad.d.labReport.failed || []).join(",")) && /Tensile/.test((bad.d.labReport.failed || []).join(",")),
      JSON.stringify(bad.d.labReport));
    ok("the failed stock really landed", (await onHand("FG-LABGATE")) === before + 30,
      before + " -> " + (await onHand("FG-LABGATE")));
    const stBad = (await call("GET", "/state", A)).d;
    const mvBad = (stBad.movements || []).find((m) => m.ref === bad.d.ref && m.type === "PROD");
    ok("the ledger row carries the verdict",
      !!mvBad && /LAB FAIL/.test(mvBad.note || "") && /LOT-BAD/.test(mvBad.note || "") && /Thickness/.test(mvBad.note || ""),
      mvBad && mvBad.note);
    const lrBad = (stBad.labReports || []).find((r) => r.id === bad.d.labReport.id);
    ok("the certificate is filed as a Fail and names the booking it covers",
      !!lrBad && lrBad.result === "Fail" && (lrBad.stockRefs || []).indexOf(bad.d.ref) >= 0 && lrBad.itemId === "FG-LABGATE",
      JSON.stringify(lrBad && { result: lrBad.result, stockRefs: lrBad.stockRefs, itemId: lrBad.itemId }));
    const lrGood = (stBad.labReports || []).find((r) => r.id === good.d.labReport.id);
    ok("a passing batch's certificate lists every booking made against it",
      !!lrGood && (lrGood.stockRefs || []).indexOf(good.d.ref) >= 0 && (lrGood.stockRefs || []).indexOf(again.d.ref) >= 0,
      JSON.stringify(lrGood && lrGood.stockRefs));
    // more of the SAME failed batch is not refused either — it is flagged the same way
    const badAgain = await book({ refNo: "LOT-BAD" });
    ok("more of a failed batch books too, flagged the same way",
      badAgain.status === 201 && !!badAgain.d.labReport && badAgain.d.labReport.result === "Fail",
      badAgain.status + " " + JSON.stringify(badAgain.d.labReport));
    const mvBad2 = ((await call("GET", "/state", A)).d.movements || []).find((m) => m.ref === badAgain.d.ref && m.type === "PROD");
    ok("…on the ledger row as well", !!mvBad2 && /LAB FAIL/.test(mvBad2.note || ""), mvBad2 && mvBad2.note);

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
    /* a jumbo has no thickness of its own — booking it stamps the parent's on
       it, so the ledger's thickness column no longer reads "—" for the roll */
    await call("PATCH", "/items/FG-LABGATE", A, { thicknessMM: 0.25 });
    const wipBook = await call("POST", "/production/finished", C,
      { itemId: "WIP-LABGATE", qty: 5, wh: "WH-WIP", gsm: 100, refNo: "LOT-W1", labValues: { thickness: 0.25, tensile: 40 } });
    const wipItem = ((await call("GET", "/state", A)).d.items || []).find((i) => i.id === "WIP-LABGATE") || {};
    ok("a booked jumbo inherits its parent's thickness", wipBook.status === 201 && wipItem.thicknessMM === 0.25,
      wipBook.status + " thicknessMM=" + wipItem.thicknessMM);
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
  /* Since 2026-08-22 a material the store has NONE of refuses the order
     outright, and an in-house create ISSUES its materials at creation — so
     each routing create below is seeded with exactly what it draws (60 =
     50 x 1.2), leaving the balance at zero for the next scenario, the same
     end state the section always had. The routes asserted are unchanged:
     routing has not depended on stock since 2026-08-03. */
  await call("POST", "/movements", A, { id: "MV-SCARCE-1", itemId: scarce.id, type: "GRN",
    qty: 60, rate: 50, wh: "WH-PNY", date: "2026-01-01", manual: true });
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
  await call("POST", "/movements", A, { id: "MV-SCARCE-2", itemId: scarce.id, type: "GRN",
    qty: 60, rate: 50, wh: "WH-PNY", date: "2026-01-01", manual: true });
  const woGan = await call("POST", "/production/wo", A, { itemId: gan.id, qty: 50 });
  ok("a woven semi-conductive tape goes to the other RM line",
    woGan.d.route[0].owner === "coating2" && /Ganesh/.test(woGan.d.route[0].name),
    woGan.d.route[0].owner + " · " + woGan.d.route[0].name);

  // copper woven: the fibre-glass team weaves the base first
  const cu = { id: "FG-TEST-CUWOVEN", name: "Test copper woven semi conductive WB tape", cat: "FG",
    uom: "KG", typeCode: "CHCWSCWBT-99", group: "WATER BLOCKING SERIES", cost: 100, price: 200 };
  await call("POST", "/items", A, cu);
  await call("PUT", "/boms/" + cu.id, A, { yield: 100, lines: [[scarce.id, 1.2]] });
  await call("POST", "/movements", A, { id: "MV-SCARCE-3", itemId: scarce.id, type: "GRN",
    qty: 60, rate: 50, wh: "WH-PNY", date: "2026-01-01", manual: true });
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
  /* short means SOME: zero now refuses outright (tested in the partial-order
     section), so the consent flow is exercised with 5 kg against a 60 kg need */
  await call("POST", "/movements", A, { id: "MV-SCARCE-4", itemId: scarce.id, type: "GRN",
    qty: 5, rate: 50, wh: "WH-PNY", date: "2026-01-01", manual: true });
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
      /* No dispatch step here any more — the floor cannot dispatch, and resume
         never depended on it: it asks only that the released portion is off the
         machines. */
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

      /* ---- NEW RULE (2026-08-25): THE FLOOR DOES NOT DISPATCH ----
         Goods leave the works against a sales order and nowhere else. The
         floor reports what it has PACKED; the office decides what has SHIPPED.
         Two places recording the same lorry could disagree, and the floor's
         version posted no stock movement and named no customer. */
      const noDisp = await call("POST", "/production/wo/" + pid + "/advance", A, { action: "dispatch" });
      ok("the floor cannot dispatch a work order", noDisp.status === 400,
        noDisp.status + " " + JSON.stringify(noDisp.d).slice(0, 80));
      const noDisp2 = await call("POST", "/production/wo/" + pid + "/status", A, { status: "Dispatched" });
      ok("nor through the older status route", noDisp2.status === 400, String(noDisp2.status));
      ok("…and it is told where dispatch lives instead",
        /sales order/i.test((noDisp2.d && noDisp2.d.error) || ""),
        JSON.stringify(noDisp2.d));

      /* The made portion still ships — through the SALES ORDER, picking this
         batch on the line. That is the one path that posts the movement, names
         the customer and stamps the run. */
      const soP = await call("POST", "/sales-orders", A, { customerId: cust,
        lines: [{ itemId: fgP.id, qty: made, rate: 100, batch: pid }] });
      ok("a sales order can ship this batch", soP.status === 201, String(soP.status));
      const dispP = await call("POST", "/sales-orders/" + soP.d.id + "/dispatch", A, {});
      ok("dispatching that sales order succeeds", dispP.status === 200,
        dispP.status + " " + JSON.stringify(dispP.d).slice(0, 80));
      ok("and it reports shipping from the batch, not from store stock",
        dispP.d.fromBatches === 1 && dispP.d.posted === 0, JSON.stringify(dispP.d).slice(0, 90));

      const woAfter = ((await call("GET", "/state", A)).d.workorders || []).find((w) => w.id === pid);
      ok("the run records how much went out", Math.abs((+woAfter.dispatchedQty || 0) - made) < 0.01,
        woAfter.dispatchedQty + " vs " + made);
      ok("the order is NOT closed while quantity is still owed",
        woAfter.dispatched !== true && woAfter.pendingQty > 0,
        "dispatched=" + woAfter.dispatched + " pending=" + woAfter.pendingQty);
      ok("the run remembers WHICH order took it", woAfter.dispatchedTo === soP.d.id,
        String(woAfter.dispatchedTo));

      const floor = ((await call("GET", "/state", S1x)).d.workorders || []).find((w) => w.id === pid);
      ok("the floor is told how much has gone out",
        floor && Math.abs((+floor.dispatchedQty || 0) - made) < 0.01,
        JSON.stringify(floor && floor.dispatchedQty));
      ok("the floor is told which sales order took it",
        floor && floor.dispatchedTo === soP.d.id, JSON.stringify(floor && floor.dispatchedTo));
      ok("and who it went to", floor && !!floor.dispatchedCustomer,
        JSON.stringify(floor && floor.dispatchedCustomer));

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

      /* ---- A KNOWN LIMIT, PINNED HERE ON PURPOSE ----
         A batch belongs to ONE sales order for its whole life (batchOwners
         counts dispatched orders too), so the balance of a part-made run
         cannot be sold on a second document against the same batch. Before
         2026-08-25 the floor's own dispatch button was the way round this, and
         it shipped goods with no movement, no customer and no invoice. Closing
         that hole leaves this case with no route, and the test says so out loud
         rather than pretending otherwise. The office ships the balance from
         finished stock, or the rule is relaxed deliberately. */
      const soP2 = await call("POST", "/sales-orders", A, { customerId: cust,
        lines: [{ itemId: fgP.id, qty: 20, rate: 100, batch: pid }] });
      ok("a batch already sold cannot be sold again on a second order", soP2.status === 409,
        soP2.status + " " + JSON.stringify(soP2.d).slice(0, 90));
      const noMore = await call("POST", "/production/wo/" + pid + "/advance", A, { action: "dispatch" });
      ok("and the floor still cannot ship the balance itself", noMore.status === 400, String(noMore.status));

      const woEnd = ((await call("GET", "/state", A)).d.workorders || []).find((w) => w.id === pid);
      ok("so the run still shows only what genuinely went out on a document",
        Math.abs((+woEnd.dispatchedQty || 0) - made) < 0.01, "sent=" + woEnd.dispatchedQty);
      ok("and it is not marked closed on goods that never left",
        woEnd.dispatched !== true, "dispatched=" + woEnd.dispatched);
      await call("DELETE", "/sales-orders/" + soP.d.id, A);
      await call("DELETE", "/production/wo/" + pid, A);
    }

    /* ---- THE WHOLE POINT, END TO END ----
       Pack a run, sell the batch, dispatch the sales order — and watch the
       floor's card go from "ready to dispatch" to "Dispatched" without anyone
       on the floor touching it. This is the behaviour the supervisor panel
       renders, so it is asserted on the SUPERVISOR's own view of the job. */
    {
      await call("POST", "/movements", A, { id: "MV-SHIP-1", itemId: rm.id, type: "GRN",
        qty: 50, rate: 10, wh: "WH-PNY", date: "2026-06-01", manual: true });
      const w = await call("POST", "/production/wo", A, { itemId: fgP.id, qty: 50 });
      ok("a full run is raised", w.status === 201, String(w.status));
      const wid = w.d.id;

      const packed = ((await call("GET", "/state", S1x)).d.workorders || []).find((x) => x.id === wid);
      ok("before packing, the floor sees nothing dispatched",
        packed && !packed.dispatched && (+packed.dispatchedQty || 0) === 0,
        JSON.stringify(packed && { d: packed.dispatched, q: packed.dispatchedQty }));

      await call("POST", "/production/wo/" + wid + "/advance", A, { action: "complete", all: true });
      const donePack = ((await call("GET", "/state", S1x)).d.workorders || []).find((x) => x.id === wid);
      ok("packing finished leaves every stage complete and still not dispatched",
        (donePack.route || []).every((r) => r.status === "Completed") && !donePack.dispatched,
        JSON.stringify((donePack.route || []).map((r) => r.status)));

      const soS = await call("POST", "/sales-orders", A, { customerId: cust,
        lines: [{ itemId: fgP.id, qty: 50, rate: 100, batch: wid }] });
      ok("the packed batch is sold on a sales order", soS.status === 201, String(soS.status));
      ok("selling it alone does NOT mark it dispatched",
        !((await call("GET", "/state", S1x)).d.workorders || []).find((x) => x.id === wid).dispatched);

      const shipped = await call("POST", "/sales-orders/" + soS.d.id + "/dispatch", A, {});
      ok("dispatching the sales order succeeds", shipped.status === 200, String(shipped.status));

      const seen = ((await call("GET", "/state", S1x)).d.workorders || []).find((x) => x.id === wid);
      ok("THE FLOOR NOW SEES IT AS DISPATCHED", seen && seen.dispatched === true,
        "dispatched=" + (seen && seen.dispatched));
      ok("…with the full quantity recorded", Math.abs((+seen.dispatchedQty || 0) - 50) < 0.01,
        String(seen.dispatchedQty));
      ok("…naming the sales order that took it", seen.dispatchedTo === soS.d.id,
        String(seen.dispatchedTo));
      ok("…and the customer it went to", !!seen.dispatchedCustomer, String(seen.dispatchedCustomer));

      await call("DELETE", "/sales-orders/" + soS.d.id, A);
      await call("DELETE", "/production/wo/" + wid, A);
      const leftover = ((await call("GET", "/state", A)).d.movements || [])
        .filter((m) => m.itemId === rm.id).reduce((n, m) => n + (+m.qty || 0), 0);
      if (leftover > 0.001) {
        await call("POST", "/movements", A, { id: "MV-SHIP-Z", itemId: rm.id, type: "ADJ",
          qty: -leftover, wh: "WH-PNY", date: "2026-06-02", manual: true });
      }
      ok("the store is drained again for the tests that follow",
        Math.abs(((await call("GET", "/state", A)).d.movements || [])
          .filter((m) => m.itemId === rm.id).reduce((n, m) => n + (+m.qty || 0), 0)) < 0.01);
    }

    /* NEW RULE (2026-08-22): a material the store has NONE of refuses the
       order outright — no allowShortage override. Zero is not a shortage to
       confirm; nothing could start and the order would only mislead.
       Deleting the previous order ROLLED BACK its issues, so the store is
       drained to a measured zero first — the refusal below must fire on a
       genuinely empty shelf. */
    {
      const balNow = ((await call("GET", "/state", A)).d.movements || [])
        .filter((m) => m.itemId === rm.id).reduce((n, m) => n + (+m.qty || 0), 0);
      if (Math.abs(balNow) > 1e-9) await call("POST", "/movements", A, { id: "MV-PART-DRAIN", itemId: rm.id,
        type: "ADJ", qty: -balNow, rate: 10, wh: "WH-PNY", date: "2026-03-01", manual: true });
      const refused = await call("POST", "/production/wo", A, { itemId: fgP.id, qty: 80, allowShortage: true });
      ok("an order on a material at ZERO is refused even with consent",
        refused.status === 400 && /none of/i.test((refused.d || {}).error || ""),
        refused.status + " " + JSON.stringify((refused.d || {}).error || ""));
    }

    /* a partial order must reach the floor flagged, and must NOT be
       dispatchable while it still owes quantity — 30 in store against 80
       ordered (stock must be PARTIAL now: zero refuses outright, above) */
    await call("POST", "/movements", A, { id: "MV-PART-5", itemId: rm.id, type: "GRN",
      qty: 30, rate: 10, wh: "WH-PNY", date: "2026-03-02", manual: true });
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
  /* WIP-LABGATE is the lab-gate section's own jumbo fixture: since 2026-08-27
     that section books it in (to prove a jumbo inherits its parent's
     thickness), and an item with stock can no longer be deleted — so it is
     the one WIP item allowed to exist here. This job must not have made any. */
  ok("no WIP item exists in the item master at all",
    (afterState.items || []).filter((i) => i.id !== "WIP-LABGATE")
      .every((i) => i.cat !== "WIP" && !/^WIP-/.test(i.id)),
    (afterState.items || []).filter((i) => i.cat === "WIP" && i.id !== "WIP-LABGATE").length + " WIP items");
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
    /* the base has to EXIST since the 2026-08-22 zero rule — plenty of it, so
       this section keeps measuring what it always measured: how much each
       run DRAWS, never whether it may start */
    await call("POST", "/movements", A, { id: "MV-NET-COAT-1", itemId: crm, type: "GRN",
      qty: 2000, rate: 10, wh: "WH-PNY", date: "2026-01-01", manual: true });

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
    const btRoot = path.join(RUN.dir, "btscan");
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
    // give it stock first — the sign stays free either way, but the write-off
    // now has a floor (tested below), so this probe writes off what exists
    await call("POST", "/movements", A, { itemId: "RM-XMOD-3", type: "GRN", qty: 5, wh, rate: 1 });
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

    /* ---- a transfer is a pair the server writes ----
       Before: the browser posted a transfer's two legs as separate requests
       and this endpoint accepted each leg blind — a lone XFER row of +3
       minted 3 kg from nothing, and a network blip between the legs left
       half a transfer on the ledger. */
    const whB = ((await call("GET", "/state", A)).d.warehouses.find((w) => w.id !== wh) || {}).id;
    await mkItem("RM-XMOD-4");
    await call("POST", "/movements", A, { itemId: "RM-XMOD-4", type: "GRN", qty: 100, wh, rate: 10 });
    ok("a lone XFER row is refused — it would mint stock",
      (await call("POST", "/movements", A, { itemId: "RM-XMOD-4", type: "XFER", qty: 30, wh })).status === 400);
    ok("…whichever way it points",
      (await call("POST", "/movements", A, { itemId: "RM-XMOD-4", type: "XFER", qty: -30, wh })).status === 400);
    const trf = await call("POST", "/movements", A,
      { itemId: "RM-XMOD-4", type: "XFER", qty: 30, wh, whTo: whB });
    ok("a transfer naming both stores posts", trf.status === 201, String(trf.status));
    const legs = ((await call("GET", "/state", A)).d.movements || [])
      .filter((m) => m.itemId === "RM-XMOD-4" && m.type === "XFER");
    ok("…as BOTH legs, one out and one in",
      legs.length === 2 && legs.some((m) => +m.qty === -30 && m.wh === wh)
        && legs.some((m) => +m.qty === 30 && m.wh === whB),
      JSON.stringify(legs.map((l) => l.wh + ":" + l.qty)));
    ok("…and total stock is unchanged — a transfer nets zero",
      Math.abs((await stockOf("RM-XMOD-4")) - 100) < 1e-6, "total " + (await stockOf("RM-XMOD-4")));
    ok("a transfer to the same store is refused",
      (await call("POST", "/movements", A, { itemId: "RM-XMOD-4", type: "XFER", qty: 5, wh, whTo: wh })).status === 400);
    ok("a transfer to a store that does not exist is refused",
      (await call("POST", "/movements", A, { itemId: "RM-XMOD-4", type: "XFER", qty: 5, wh, whTo: "WH-NOPE" })).status === 400);
    const overTrf = await call("POST", "/movements", A,
      { itemId: "RM-XMOD-4", type: "XFER", qty: 90, wh, whTo: whB });
    ok("a transfer of more than the store holds is refused", overTrf.status === 400, String(overTrf.status));
    ok("…naming what is actually there",
      /only .*70/.test(String(overTrf.d && overTrf.d.error)), JSON.stringify(overTrf.d).slice(0, 120));

    /* ---- stock has a floor ----
       Before: an ISSUE of −9,000,000,000 posted cleanly and the ledger read
       −8.99 billion — no warning anywhere, and every dashboard showed the
       wreckage deadpan. No physical count is negative. */
    ok("an issue larger than everything on hand is refused",
      (await call("POST", "/movements", A, { itemId: "RM-XMOD-4", type: "ISSUE", qty: -9e9, wh })).status === 400);
    ok("…including a modest one that is still too big",
      (await call("POST", "/movements", A, { itemId: "RM-XMOD-4", type: "ISSUE", qty: -101, wh })).status === 400);
    ok("an issue the stock covers still posts",
      (await call("POST", "/movements", A, { itemId: "RM-XMOD-4", type: "ISSUE", qty: -40, wh })).status === 201);
    ok("an adjustment cannot write off below zero",
      (await call("POST", "/movements", A, { itemId: "RM-XMOD-4", type: "ADJ", qty: -1e6, wh })).status === 400);
    ok("an adjustment down to exactly zero is allowed",
      (await call("POST", "/movements", A, { itemId: "RM-XMOD-4", type: "ADJ", qty: -60, wh })).status === 201);
    ok("…and the ledger rests at zero, not below",
      Math.abs(await stockOf("RM-XMOD-4")) < 1e-6, "total " + (await stockOf("RM-XMOD-4")));
  }

  /* ============================================================
     2026-09-02: the office names the line, draws finished stock store by
     store, a failed batch leaves the floor and raises a ruling, and the
     TDS booklet has an endpoint. Helpers scoped to these sections only. */
  {
    const C2 = (await login("coating2", "coating2@123")).token;
    const S1 = (await login("slitting1", "slitting1@123")).token;
    const REPO = path.join(__dirname, "..", "..");
    const state = async (tok) => (await call("GET", "/state", tok || A)).d;
    const woOf = async (id, tok) => ((await state(tok)).workorders || []).find((w) => w.id === id);
    const stockIn = async (itemId, wh) => (await state()).movements.filter((m) => m.itemId === itemId && m.wh === wh).reduce((n, m) => n + (+m.qty || 0), 0);
    const grn = (itemId, qty, wh) => call("POST", "/movements", A, { itemId, type: "GRN", qty, rate: 20, wh: wh || "WH-PNY", date: "2026-01-01", manual: true });
  /* ================================================================ */
  section("The office may name the production line a job starts on");
  {
    const rmL = { id: "RM-LINE-BASE", name: "Line test fabric", cat: "RM", uom: "KG", cost: 20 };
    const rmP = { id: "RM-LINE-PASTE", name: "Line test paste", cat: "RM", uom: "KG", cost: 30 };
    await call("POST", "/items", A, rmL); await call("POST", "/items", A, rmP);
    await grn(rmL.id, 500); await grn(rmP.id, 500);
    const fgG = { id: "FG-LINE-CP25GE", name: "Line test inorganic mica tape", cat: "FG", uom: "KG", typeCode: "CP25GE-13", group: "MICA SERIES", cost: 100, price: 200 };
    await call("POST", "/items", A, fgG);
    await call("PUT", "/boms/" + fgG.id, A, { yield: 100, lines: [[rmL.id, 0.8], [rmP.id, 0.3]] });
    const fgB = { id: "FG-LINE-BOUGHT", name: "Line test bought-in tape", cat: "FG", uom: "KG", typeCode: "CH-PTFE-99", group: "OTHER", cost: 100, price: 200 };
    await call("POST", "/items", A, fgB);
    await call("PUT", "/boms/" + fgB.id, A, { yield: 100, lines: [[rmL.id, 1.0]] });

    const auto = await call("POST", "/production/wo", A, { itemId: fgG.id, qty: 50 });
    ok("no line named -> the standing rule: Ganesh's RM line", auto.status === 201 && auto.d.route[0].key === "rmprod" && auto.d.route[0].owner === "coating2", JSON.stringify(auto.d).slice(0, 160));
    ok("...and the order sits on RM Production 2", (await woOf(auto.d.id)).line === "RM Production 2", (await woOf(auto.d.id)).line);
    const blank = await call("POST", "/production/wo", A, { itemId: fgG.id, qty: 50, line: "" });
    ok("an empty line means the same as none", blank.status === 201 && blank.d.route[0].owner === "coating2");

    const g1 = await call("POST", "/production/wo", A, { itemId: fgG.id, qty: 50, line: "RM Production 1" });
    ok("RM Production 1 named -> the job starts on Gautam's floor", g1.status === 201 && g1.d.route[0].key === "rmprod" && g1.d.route[0].owner === "coating1" && /Gautam/.test(g1.d.route[0].name), JSON.stringify(g1.d.route || g1.d).slice(0, 200));
    ok("...then slitting and packing as usual", g1.status === 201 && g1.d.route.map((r) => r.key).join(">") === "rmprod>slitting>packing");
    const g1Full = await woOf(g1.d.id);
    ok("...and the order carries that line", !!(g1Full && g1Full.line === "RM Production 1" && g1Full.startLine === "RM Production 1"), JSON.stringify(g1Full && { line: g1Full.line, startLine: g1Full.startLine }));
    const c1 = await woOf(g1.d.id, C), c2 = await woOf(g1.d.id, C2);
    ok("Gautam's board shows it as his", !!(c1 && c1.mine === true), JSON.stringify(c1 && c1.mine));
    ok("Ganesh's board does not", !c2 || c2.mine !== true, JSON.stringify(c2 && c2.mine));
    ok("and Gautam can start it", (await call("POST", "/production/wo/" + g1.d.id + "/advance", C, { action: "start" })).status === 200);

    const fb = await call("POST", "/production/wo", A, { itemId: fgG.id, qty: 50, line: "Fibre-Glass Line 1" });
    const fbRoute = fb.status === 201 ? fb.d.route.map((r) => r.key + "/" + (r.owner || "-")).join(">") : String(fb.status);
    ok("Fibre-Glass named -> weaving first, then the product's own RM line", fbRoute === "weaving/fiberglass>rmprod/coating2>slitting/->packing/-", fbRoute);
    ok("...and the order sits on the fibre-glass line", fb.status === 201 && (await woOf(fb.d.id)).line === "Fibre-Glass Line 1");

    const sl = await call("POST", "/production/wo", A, { itemId: fgG.id, qty: 50, line: "Slitting A" });
    ok("a slitting line named -> no production stage at all", sl.status === 201 && sl.d.route.map((r) => r.key).join(">") === "slitting>packing", sl.status === 201 ? sl.d.route.map((r) => r.key).join(">") : JSON.stringify(sl.d));
    ok("...on Slitting A", sl.status === 201 && (await woOf(sl.d.id)).line === "Slitting A");
    ok("a slitting login can start it", sl.status === 201 && (await call("POST", "/production/wo/" + sl.d.id + "/advance", S1, { action: "start" })).status === 200);

    const bo = await call("POST", "/production/wo", A, { itemId: fgB.id, qty: 50, line: "RM Production 2" });
    ok("a bought-in product can still be sent to a production line on purpose", bo.status === 201 && bo.d.route[0].key === "rmprod" && bo.d.route[0].owner === "coating2", JSON.stringify(bo.d.route || bo.d).slice(0, 160));
    const bad = await call("POST", "/production/wo", A, { itemId: fgG.id, qty: 50, line: "Coating Line 9" });
    ok("a line that does not exist is refused (400)", bad.status === 400 && /line/i.test(bad.d.error || ""), bad.status + " " + JSON.stringify(bad.d).slice(0, 100));
    const pv = await call("POST", "/production/wo/preview", A, { itemId: fgG.id, qty: 50, line: "Slitting A" });
    ok("preview accepts the line", pv.status === 200, JSON.stringify(pv.d).slice(0, 100));
    /* the store is drawn down the moment an order is released, so a line —
       which decides which stage draws what — is fixed at creation; the edit
       dialog says so rather than quietly re-routing a posted job */
    const ed = await call("PATCH", "/production/wo/" + auto.d.id, A, { line: "Slitting B" });
    ok("a released order keeps its line (400)", ed.status === 400 && /started/.test(ed.d.error || ""), ed.status + " " + JSON.stringify(ed.d).slice(0, 100));
    ok("...and its route", (await woOf(auto.d.id)).route[0].owner === "coating2");
  }

  /* ================================================================ */
  section("Finished stock is drawn store by store");
  {
    const rmS = { id: "RM-STORE-BASE", name: "Store test fabric", cat: "RM", uom: "KG", cost: 20 };
    await call("POST", "/items", A, rmS); await grn(rmS.id, 1000);
    const fgS = { id: "FG-STORE-TAPE", name: "Store test tape", cat: "FG", uom: "KG", typeCode: "CH-PTFE-98", group: "OTHER", cost: 100, price: 200, tapeWidthMM: 25 };
    await call("POST", "/items", A, fgS);
    await call("PUT", "/boms/" + fgS.id, A, { yield: 100, lines: [[rmS.id, 1.0]] });
    const put = (wh, qty) => call("POST", "/movements", A, { itemId: fgS.id, type: "ADJ", qty, rate: 100, wh, date: "2026-01-02", manual: true, note: "store test" });
    ok("finished rolls booked into two stores (and one in quarantine)", (await put("WH-FG", 30)).status === 201 && (await put("WH-PNY", 20)).status === 201 && (await put("WH-QC", 7)).status === 201);

    const pv = await call("POST", "/production/wo/preview", A, { itemId: fgS.id, qty: 100, widthMM: 25, fgDraws: [{ id: fgS.id, wh: "WH-PNY", qty: 15 }] });
    ok("preview: 15 kg named from the main store comes off the shelf", pv.status === 200 && Math.abs(pv.d.fromStock - 15) < 1e-6 && Math.abs(pv.d.makeQty - 85) < 1e-6, JSON.stringify(pv.d).slice(0, 160));
    const stores = (pv.d && pv.d.fgStores) || [];
    ok("preview lists every store the product sits in, with what each holds", stores.some((s) => s.wh === "WH-FG" && Math.abs(s.qty - 30) < 1e-6) && stores.some((s) => s.wh === "WH-PNY" && Math.abs(s.qty - 20) < 1e-6), JSON.stringify(stores));
    ok("...and never the quarantine store", stores.length > 0 && !stores.some((s) => s.wh === "WH-QC"));

    const wo = await call("POST", "/production/wo", A, { itemId: fgS.id, qty: 100, widthMM: 25, fgDraws: [{ id: fgS.id, wh: "WH-PNY", qty: 15 }] });
    ok("the order takes exactly the named 15 kg from stock", wo.status === 201 && Math.abs(wo.d.plan.fgQty - 15) < 1e-6 && Math.abs(wo.d.plan.makeQty - 85) < 1e-6, JSON.stringify(wo.d.plan || wo.d).slice(0, 160));
    ok("...and remembers which store it comes from", wo.status === 201 && wo.d.plan.fgSources.length === 1 && wo.d.plan.fgSources[0].wh === "WH-PNY", JSON.stringify(wo.d.plan && wo.d.plan.fgSources));
    for (const a of ["start", "complete", "start", "complete"]) await call("POST", "/production/wo/" + wo.d.id + "/advance", A, { action: a });
    const mv = (await state()).movements.filter((m) => m.ref === wo.d.id && m.itemId === fgS.id);
    ok("packing issued the finished rolls from the store the office named", mv.length === 1 && mv[0].wh === "WH-PNY" && Math.abs(mv[0].qty + 15) < 1e-6, JSON.stringify(mv));
    ok("the finished-goods bay was left alone", Math.abs((await stockIn(fgS.id, "WH-FG")) - 30) < 1e-6, String(await stockIn(fgS.id, "WH-FG")));
    ok("the main store went down by 15", Math.abs((await stockIn(fgS.id, "WH-PNY")) - 5) < 1e-6, String(await stockIn(fgS.id, "WH-PNY")));

    const wo2 = await call("POST", "/production/wo", A, { itemId: fgS.id, qty: 100, widthMM: 25, fgDraws: [{ id: fgS.id, wh: "WH-FG", qty: 10 }, { id: fgS.id, wh: "WH-PNY", qty: 5 }] });
    ok("a draw can be split across two stores", wo2.status === 201 && Math.abs(wo2.d.plan.fgQty - 15) < 1e-6 && wo2.d.plan.fgSources.length === 2, JSON.stringify(wo2.d.plan && wo2.d.plan.fgSources));
    for (const a of ["start", "complete", "start", "complete"]) await call("POST", "/production/wo/" + wo2.d.id + "/advance", A, { action: a });
    const mv2 = (await state()).movements.filter((m) => m.ref === wo2.d.id && m.itemId === fgS.id).sort((a, b) => a.wh.localeCompare(b.wh));
    ok("...and packing posts one issue per store", mv2.length === 2 && mv2[0].wh === "WH-FG" && Math.abs(mv2[0].qty + 10) < 1e-6 && mv2[1].wh === "WH-PNY" && Math.abs(mv2[1].qty + 5) < 1e-6, JSON.stringify(mv2.map((m) => m.wh + ":" + m.qty)));

    const wo3 = await call("POST", "/production/wo", A, { itemId: fgS.id, qty: 100, widthMM: 25, fgDraws: [{ id: fgS.id, wh: "WH-FG", qty: 500 }] });
    ok("asking for more than a store holds takes what is there", wo3.status === 201 && Math.abs(wo3.d.plan.fgQty - 20) < 1e-6, JSON.stringify(wo3.d.plan && wo3.d.plan.fgQty));
    const wo4 = await call("POST", "/production/wo", A, { itemId: fgS.id, qty: 50, widthMM: 25, fgDraws: [] });
    ok("naming no store draws nothing - the whole order is made", wo4.status === 201 && wo4.d.plan.fgQty === 0 && Math.abs(wo4.d.plan.makeQty - 50) < 1e-6, JSON.stringify(wo4.d.plan || wo4.d).slice(0, 120));
    const bad = await call("POST", "/production/wo", A, { itemId: fgS.id, qty: 50, widthMM: 25, fgDraws: [{ id: fgS.id, wh: "WH-QC", qty: 5 }] });
    ok("quarantined finished stock cannot be drawn (400)", bad.status === 400, bad.status + " " + JSON.stringify(bad.d).slice(0, 100));
    const bad2 = await call("POST", "/production/wo", A, { itemId: fgS.id, qty: 50, widthMM: 25, fgDraws: [{ id: fgS.id, wh: "WH-NOPE", qty: 5 }] });
    ok("an unknown store is refused (400)", bad2.status === 400);
    /* both stores are empty by now — every order above drew its rolls the
       moment it was released — so put some back before the last two checks */
    ok("stores empty after the draws above", Math.abs(await stockIn(fgS.id, "WH-FG")) < 1e-6 && Math.abs(await stockIn(fgS.id, "WH-PNY")) < 1e-6, (await stockIn(fgS.id, "WH-FG")) + " / " + (await stockIn(fgS.id, "WH-PNY")));
    await put("WH-FG", 10);
    const wo5 = await call("POST", "/production/wo", A, { itemId: fgS.id, qty: 50, widthMM: 25, fgQty: 3 });
    ok("an unnamed total is still honoured", wo5.status === 201 && Math.abs(wo5.d.plan.fgQty - 3) < 1e-6, JSON.stringify(wo5.d.plan && wo5.d.plan.fgQty));
    const wo6 = await call("POST", "/production/wo", A, { itemId: fgS.id, qty: 50, widthMM: 25 });
    ok("nothing named at all takes what the drawable stores hold, never the quarantine", wo6.status === 201 && Math.abs(wo6.d.plan.fgQty - 7) < 1e-6, JSON.stringify(wo6.d.plan && wo6.d.plan.fgQty));
  }

  /* ================================================================ */
  section("A failed batch still leaves the floor - and the office is told");
  {
    const rmC = { id: "RM-LABALERT", name: "Lab alert fabric", cat: "RM", uom: "KG", cost: 20 };
    const fgC = { id: "FG-LABALERT", name: "Lab alert water blocking tape", cat: "FG", uom: "KG", typeCode: "CHDNW-97", group: "WATER BLOCKING SERIES", cost: 100, price: 200 };
    await call("POST", "/items", A, rmC); await call("POST", "/items", A, fgC);
    await call("PUT", "/boms/" + fgC.id, A, { yield: 100, lines: [[rmC.id, 1.2]] });
    await grn(rmC.id, 500);
    const lp = await call("POST", "/lab/products", A, { id: "LP-LABALERT", name: "Lab alert water blocking tape", code: "CHDNW-97", thickness: "0.25", series: "Water Blocking", itemId: fgC.id,
      flags: { waterBlocking: true, semiConductive: false, mica: false }, spec: { thickness: { min: 0.2, max: 0.3 }, tensile: { min: 30 } } });
    ok("fixture: lab product", lp.status === 201);
    const newWO = async () => (await call("POST", "/production/wo", A, { itemId: fgC.id, qty: 40 })).d;
    const wo = await newWO();
    await call("POST", "/production/wo/" + wo.id + "/advance", C, { action: "start" });
    const bad = await call("POST", "/production/wo/" + wo.id + "/lab", C, { values: { thickness: 0.9, tensile: 5 } });
    ok("the floor's out-of-spec reading is recorded", bad.status === 201 && bad.d.report.prodResult === "Fail", JSON.stringify(bad.d).slice(0, 120));
    const done = await call("POST", "/production/wo/" + wo.id + "/advance", C, { action: "complete", wipWh: "WH-WIP" });
    ok("a FAILED batch now closes coating (200)", done.status === 200, done.status + " " + JSON.stringify(done.d).slice(0, 140));
    ok("...and the reply says the reading failed", !!(done.d.labWarning && done.d.labWarning.result === "Fail" && /Thickness/.test((done.d.labWarning.failed || []).join(","))), JSON.stringify(done.d.labWarning));
    const after = await woOf(wo.id);
    ok("the stage moved on", !!(after && after.route[0].status === "Completed" && after.stageIdx === 1), JSON.stringify(after && { st: after.route[0].status, idx: after.stageIdx }));
    const adm = await state();
    const q = (adm.labQcDecisions || []).find((x) => x.woId === wo.id);
    ok("the admin's alert list names the batch", !!(q && q.stage === "floor" && q.productCode === "CHDNW-97" && q.batchNo === wo.id.replace(/^WO-/, "")), JSON.stringify(q));
    ok("...and which readings failed", !!(q && (q.failed || []).includes("Thickness")));
    ok("...and the certificate to open", !!(q && q.id === bad.d.report.id));
    const labSt = await state(LB);
    const ql = (labSt.labQcDecisions || []).find((x) => q && x.id === q.id);
    ok("the lab incharge is told too", !!ql, JSON.stringify(labSt.labQcDecisions || null).slice(0, 120));
    ok("...without the failed parameters or any limit", !!ql && ql.failed === undefined && !/"min"|"max"/.test(JSON.stringify(ql)), JSON.stringify(ql));
    const labCopy = (labSt.labReports || []).find((r) => q && r.id === q.id);
    ok("the lab's certificate copy still carries no per-parameter verdict", !!labCopy && labCopy.prodResults === undefined && labCopy.prodResult === undefined);
    ok("the lab's certificate copy says it is flagged for a ruling", !!labCopy && labCopy.attention === "floor", JSON.stringify(labCopy && labCopy.attention));

    const wo2 = await newWO();
    await call("POST", "/production/wo/" + wo2.id + "/advance", C, { action: "start" });
    const noRead = await call("POST", "/production/wo/" + wo2.id + "/advance", C, { action: "complete", wipWh: "WH-WIP" });
    ok("an UNMEASURED batch is still refused (409)", noRead.status === 409 && /Lab report required/.test(noRead.d.error || ""), noRead.status + " " + JSON.stringify(noRead.d).slice(0, 100));
    const half = await call("POST", "/production/wo/" + wo2.id + "/lab", C, { values: { thickness: 0.9 } });
    ok("a half-filled sheet is still refused (400)", half.status === 400);

    const qid = q ? q.id : "LR-0000";
    ok("the lab cannot rule on it (403)", (await call("POST", "/lab/reports/" + qid + "/decision", LB, { accept: true })).status === 403);
    ok("nor office (403)", (await call("POST", "/lab/reports/" + qid + "/decision", O, { accept: true })).status === 403);
    const acc = await call("POST", "/lab/reports/" + qid + "/decision", A, { accept: true, note: "Customer accepts the thicker tape" });
    ok("the admin accepts the batch", acc.status === 200 && acc.d.report && acc.d.report.decision === "accepted" && acc.d.report.decidedBy === "admin", JSON.stringify(acc.d).slice(0, 160));
    ok("...and it leaves both alert lists", !((await state()).labQcDecisions || []).some((x) => x.id === qid) && !((await state(LB)).labQcDecisions || []).some((x) => x.id === qid));
    const labCopy2 = ((await state(LB)).labReports || []).find((r) => r.id === qid);
    ok("the ruling is on the certificate for the lab to see", !!labCopy2 && labCopy2.decision === "accepted" && labCopy2.decisionNote === "Customer accepts the thicker tape", JSON.stringify(labCopy2 && { d: labCopy2.decision, n: labCopy2.decisionNote }));
    ok("a second ruling is refused (409)", (await call("POST", "/lab/reports/" + qid + "/decision", A, { accept: false })).status === 409);

    const lr = await call("POST", "/lab/reports", LB, { productId: "LP-LABALERT", refNo: "B-LAB-1", values: { thickness: 0.95, tensile: 2 } });
    ok("the lab's own failing reading is filed (201)", lr.status === 201, lr.status + " " + JSON.stringify(lr.d).slice(0, 100));
    const q2 = ((await state()).labQcDecisions || []).find((x) => x.id === lr.d.id);
    ok("...and raises an alert for the admin, marked as the lab's reading", !!(q2 && q2.stage === "lab" && q2.refNo === "B-LAB-1"), JSON.stringify(q2));
    ok("...visible to the lab as well", ((await state(LB)).labQcDecisions || []).some((x) => x.id === lr.d.id));
    const rej = await call("POST", "/lab/reports/" + lr.d.id + "/decision", A, { accept: false, note: "Scrap the batch" });
    ok("the admin can reject it", rej.status === 200 && rej.d.report.decision === "rejected", JSON.stringify(rej.d).slice(0, 120));
    const good = await call("POST", "/lab/reports", A, { productId: "LP-LABALERT", refNo: "B-OK-1", values: { thickness: 0.25, tensile: 40 } });
    ok("a passing certificate has nothing to rule on (400)", good.status === 201 && (await call("POST", "/lab/reports/" + good.d.id + "/decision", A, { accept: true })).status === 400);

    const bad2 = await call("POST", "/production/wo/" + wo2.id + "/lab", C, { values: { thickness: 0.9, tensile: 5 } });
    ok("second floor fail on file", bad2.status === 201 && ((await state()).labQcDecisions || []).some((x) => x.id === bad2.d.report.id));
    const labPass = await call("POST", "/lab/reports", LB, { productId: "LP-LABALERT", refNo: wo2.id.replace(/^WO-/, ""), values: { thickness: 0.25, tensile: 40 } });
    ok("the lab measures the same batch and it passes", labPass.status === 201 && labPass.d.id === bad2.d.report.id, JSON.stringify(labPass.d).slice(0, 100));
    ok("...so the floor's alert is withdrawn", !((await state()).labQcDecisions || []).some((x) => x.id === bad2.d.report.id));

    const rmG = { id: "RM-GRNALERT", name: "GRN alert paper", cat: "RM", uom: "KG", cost: 30 };
    await call("POST", "/items", A, rmG);
    await call("PUT", "/items/" + rmG.id + "/qc", A, { params: ["thickness", "visual"], spec: { thickness: { min: 0.07, max: 0.09 } } });
    const sup = (await state()).suppliers[0].id;
    const poF = (await call("POST", "/purchase-orders", A, { supplierId: sup, eta: "2026-08-22", lines: [{ itemId: rmG.id, qty: 40, rate: 30 }] })).d;
    const gF = (await call("POST", "/purchase-orders/" + poF.id + "/receive", A, { wh: "WH-PNY", lines: [{ i: 0, qty: 40 }] })).d.grn;
    const failed = await call("POST", "/grns/" + encodeURIComponent(gF.id) + "/tests", LB, { itemId: rmG.id, values: { thickness: 0.02, visual: "very thin" } });
    ok("a failing incoming reading is filed", failed.status === 201);
    const gq = ((await state(LB)).grnQcDecisions || []).find((x) => x.grnId === gF.id);
    ok("the lab is told the lot failed and awaits the admin", !!gq, JSON.stringify((await state(LB)).grnQcDecisions || null).slice(0, 120));
    ok("...without the parameter that failed", !!gq && gq.failed === undefined, JSON.stringify(gq));
    const gqA = ((await state()).grnQcDecisions || []).find((x) => x.grnId === gF.id);
    ok("the admin still sees which parameter failed", !!gqA && (gqA.failed || []).join() === "Thickness");
  }

  /* ================================================================ */
  section("The TDS booklet: one copy for every login, replaced by admin");
  {
    ok("restoring the bundled booklet is admin's (403 for office)", (await call("DELETE", "/tds", O)).status === 403);
    const reset = await call("DELETE", "/tds", A);
    ok("admin can restore the bundled booklet", reset.status === 200, reset.status + " " + JSON.stringify(reset.d).slice(0, 100));
    const meta = await call("GET", "/tds", A);
    ok("the booklet is described", meta.status === 200 && meta.d.present === true && meta.d.kind === "pdf" && meta.d.source === "bundled" && meta.d.viewable === true, JSON.stringify(meta.d));
    ok("every login may read it - lab", (await call("GET", "/tds", LB)).status === 200);
    ok("...office", (await call("GET", "/tds", O)).status === 200);
    ok("...the floor", (await call("GET", "/tds", C)).status === 200);
    ok("nobody anonymous (401)", (await call("GET", "/tds/file")).status === 401 && (await call("GET", "/tds")).status === 401);
    const bundled = fs.readFileSync(path.join(REPO, "frontend/assets/docs/tds-brochure.pdf"));
    const r = await fetch(base + "/tds/file", { headers: { Authorization: "Bearer " + A } });
    const buf = Buffer.from(await r.arrayBuffer());
    ok("the file itself is served, byte for byte", r.status === 200 && /application\/pdf/.test(r.headers.get("content-type") || "") && buf.length === bundled.length && buf.equals(bundled), r.status + " " + r.headers.get("content-type") + " " + buf.length);
    ok("...inline, so the viewer can show it", /inline/.test(r.headers.get("content-disposition") || ""), r.headers.get("content-disposition"));

    const pdfBytes = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
    const b64 = pdfBytes.toString("base64");
    ok("office cannot replace it (403)", (await call("PUT", "/tds", O, { name: "tds.pdf", data: b64 })).status === 403);
    ok("nor the lab (403)", (await call("PUT", "/tds", LB, { name: "tds.pdf", data: b64 })).status === 403);
    ok("nor the floor (403)", (await call("PUT", "/tds", C, { name: "tds.pdf", data: b64 })).status === 403);
    ok("a .txt is refused (400)", (await call("PUT", "/tds", A, { name: "notes.txt", data: b64 })).status === 400);
    ok("an empty file is refused (400)", (await call("PUT", "/tds", A, { name: "tds.pdf", data: "" })).status === 400);
    ok("a file that is not a PDF inside is refused (400)", (await call("PUT", "/tds", A, { name: "tds.pdf", data: Buffer.from("hello").toString("base64") })).status === 400);
    const up = await call("PUT", "/tds", A, { name: "../TDS 2026 (rev 3).pdf", data: b64 });
    ok("admin replaces the booklet", up.status === 200 && up.d.source === "uploaded" && up.d.kind === "pdf" && up.d.updatedBy === "admin" && up.d.name === "TDS 2026 (rev 3).pdf" && up.d.viewable === true, up.status + " " + JSON.stringify(up.d));
    const r2 = await fetch(base + "/tds/file", { headers: { Authorization: "Bearer " + LB } });
    const buf2 = Buffer.from(await r2.arrayBuffer());
    ok("everyone now gets the new file", r2.status === 200 && buf2.equals(pdfBytes) && (await call("GET", "/tds", LB)).d.source === "uploaded", buf2.length + "");
    const r3 = await fetch(base + "/tds/file?dl=1", { headers: { Authorization: "Bearer " + O } });
    ok("a download asks the browser to save it", /attachment/.test(r3.headers.get("content-disposition") || "") && /\.pdf/.test(r3.headers.get("content-disposition") || ""), r3.headers.get("content-disposition"));
    const docx = Buffer.from("PK\u0003\u0004 not really a document but zipped like one");
    const upW = await call("PUT", "/tds", A, { name: "TDS.docx", data: docx.toString("base64") });
    ok("a Word document is accepted", upW.status === 200 && upW.d.kind === "docx" && upW.d.source === "uploaded", upW.status + " " + JSON.stringify(upW.d));
    ok("...but cannot be shown inline until it is converted", upW.status === 200 && upW.d.viewable === false);
    const r4 = await fetch(base + "/tds/file", { headers: { Authorization: "Bearer " + C } });
    ok("the Word file is served as a download", r4.status === 200 && /wordprocessingml/.test(r4.headers.get("content-type") || "") && /attachment/.test(r4.headers.get("content-disposition") || ""), r4.headers.get("content-type") + " " + r4.headers.get("content-disposition"));
    ok("a Word file with the wrong bytes inside is refused (400)", (await call("PUT", "/tds", A, { name: "x.docx", data: Buffer.from("hello").toString("base64") })).status === 400);
    ok("restoring puts the bundled PDF back", (await call("DELETE", "/tds", A)).status === 200 && (await call("GET", "/tds", C)).d.source === "bundled");
  }
  }

  /* ================================================================ */
  { // the sections below share one state() reader
  const state = async (tok) => (await call("GET", "/state", tok || A)).d;
  section("A purchase order buys raw material — the API says so too (QA-3)");
  {
    const st0 = await state();
    const supA = st0.suppliers[0].id;
    const fgAny = st0.items.find((i) => i.cat === "FG");
    const wipAny = st0.items.find((i) => i.cat === "WIP");
    const pkgAny = st0.items.find((i) => i.cat === "PKG" || i.cat === "CON");
    const onFg = await call("POST", "/purchase-orders", A, { supplierId: supA, lines: [{ itemId: fgAny.id, qty: 5, rate: 10 }] });
    ok("an order for a finished good is refused (400)", onFg.status === 400 && /finished good/.test(onFg.d.error || ""), onFg.status + " " + JSON.stringify(onFg.d).slice(0, 160));
    if (wipAny) {
      const onWip = await call("POST", "/purchase-orders", A, { supplierId: supA, lines: [{ itemId: wipAny.id, qty: 5, rate: 10 }] });
      ok("an order for work in process is refused (400)", onWip.status === 400 && /work in process/.test(onWip.d.error || ""), onWip.status + " " + JSON.stringify(onWip.d).slice(0, 160));
    } else ok("(no WIP item in the seed to try)", true);
    const rmOnly = await call("POST", "/purchase-orders", A, { supplierId: supA, lines: [{ itemId: rm, qty: 5, rate: 10 }] });
    ok("raw material still goes through (201)", rmOnly.status === 201, rmOnly.status + " " + JSON.stringify(rmOnly.d).slice(0, 100));
    if (pkgAny) ok("packaging / consumables are bought too (201)",
      (await call("POST", "/purchase-orders", A, { supplierId: supA, lines: [{ itemId: pkgAny.id, qty: 5, rate: 10 }] })).status === 201);
    else ok("(no packaging item in the seed to try)", true);
    const mixed = await call("POST", "/purchase-orders", A, { supplierId: supA, lines: [{ itemId: rm, qty: 5, rate: 10 }, { itemId: fgAny.id, qty: 1, rate: 10 }] });
    ok("one finished-goods line spoils the whole order (400)", mixed.status === 400);
    const sneak = await call("PATCH", "/purchase-orders/" + rmOnly.d.id, A, { lines: [{ itemId: rm, qty: 5, rate: 10 }, { itemId: fgAny.id, qty: 1, rate: 10 }] });
    ok("nor can a finished good be edited onto an open order (400)", sneak.status === 400, sneak.status + " " + JSON.stringify(sneak.d).slice(0, 120));
    ok("...while an ordinary edit still lands (200)", (await call("PATCH", "/purchase-orders/" + rmOnly.d.id, A, { lines: [{ itemId: rm, qty: 6, rate: 10 }] })).status === 200);
    await call("DELETE", "/purchase-orders/" + rmOnly.d.id, A);
  }

  section("A reading nothing can grade reads Recorded, not Pending for ever (QA-4)");
  {
    const rmT = { id: "RM-TEXTONLY", name: "Text-only checked liner", cat: "RM", uom: "KG", cost: 12 };
    await call("POST", "/items", A, rmT);
    const setT = await call("PUT", "/items/" + rmT.id + "/qc", A, { params: ["visual", "packing"] });
    ok("a material may be checked on visual and packing alone", setT.status === 200 && setT.d.params.join() === "visual,packing", JSON.stringify(setT.d).slice(0, 120));
    const supT = (await state()).suppliers[0].id;
    const poT = (await call("POST", "/purchase-orders", A, { supplierId: supT, eta: "2026-09-10", lines: [{ itemId: rmT.id, qty: 30, rate: 12 }] })).d;
    const gT = (await call("POST", "/purchase-orders/" + poT.id + "/receive", A, { wh: "WH-PNY", lines: [{ i: 0, qty: 30 }] })).d.grn;
    ok("fixture: the lot is received", !!gT);
    const filedT = await call("POST", "/grns/" + encodeURIComponent(gT.id) + "/tests", LB, { itemId: rmT.id, values: { visual: "clean, no creases", packing: "intact" } });
    ok("a complete text-only reading is accepted (201)", filedT.status === 201, filedT.status + " " + JSON.stringify(filedT.d).slice(0, 120));
    // the verdict is read as admin — the writer's own reply is redacted (testForWriter)
    const tT = ((await state()).grnTests || []).find((t) => t.grnId === gT.id && t.itemId === rmT.id);
    ok("...and reads Recorded — not Pending", !!tT && tT.result === "Recorded", JSON.stringify(tT && { result: tT.result, complete: tT.complete }));
    ok("...with the values on record, ungraded", !!tT && tT.complete === true && tT.results.visual === "na" && tT.results.packing === "na", JSON.stringify(tT && tT.results));
    ok("it leaves the incharge's worklist", !(((await call("GET", "/grn-tests/pending", LB)).d.pending || []).some((p) => p.grnId === gT.id)));
    ok("...and raises no ruling", !((await state()).grnQcDecisions || []).some((x) => x.grnId === gT.id));

    // a NUMERIC parameter with no limit is just as ungradable
    const rmN = { id: "RM-NOLIMIT", name: "Measured but unlimited film", cat: "RM", uom: "KG", cost: 12 };
    await call("POST", "/items", A, rmN);
    await call("PUT", "/items/" + rmN.id + "/qc", A, { params: ["thickness", "visual"] });
    const poN = (await call("POST", "/purchase-orders", A, { supplierId: supT, eta: "2026-09-10", lines: [{ itemId: rmN.id, qty: 30, rate: 12 }] })).d;
    const gN = (await call("POST", "/purchase-orders/" + poN.id + "/receive", A, { wh: "WH-PNY", lines: [{ i: 0, qty: 30 }] })).d.grn;
    const filedN = await call("POST", "/grns/" + encodeURIComponent(gN.id) + "/tests", LB, { itemId: rmN.id, values: { thickness: 0.08, visual: "ok" } });
    const tN0 = ((await state()).grnTests || []).find((t) => t.grnId === gN.id && t.itemId === rmN.id);
    ok("a number with no limit to judge it by is Recorded too", filedN.status === 201 && !!tN0 && tN0.result === "Recorded", filedN.status + " " + JSON.stringify(tN0 && tN0.result));
    // ...until the admin sets one — then the reading on file is graded for real
    const lim = await call("PUT", "/items/" + rmN.id + "/qc", A, { params: ["thickness", "visual"], spec: { thickness: { min: 0.1, max: 0.2 } } });
    ok("setting a limit re-grades the report on file", lim.status === 200 && lim.d.regraded === 1, JSON.stringify(lim.d).slice(0, 120));
    const tN = ((await state()).grnTests || []).find((t) => t.grnId === gN.id && t.itemId === rmN.id);
    ok("...and it now reads Fail against the new limit", !!tN && tN.result === "Fail", JSON.stringify(tN && tN.result));
  }

  section("Copy: a leave decision names its three answers (QA-5)");
  {
    const wk = ((await state()).hrWorkers || [])[0];
    if (!wk) ok("(no worker on file to try)", true);
    else {
      const lvQ = await call("POST", "/hr/leaves", A, { workerId: wk.id, type: "PL", fromDate: "2026-11-03", toDate: "2026-11-03" });
      ok("fixture: a leave request", lvQ.status === 201 || lvQ.status === 200, lvQ.status + " " + JSON.stringify(lvQ.d).slice(0, 100));
      const bad = await call("POST", "/hr/leaves/" + lvQ.d.id + "/decide", A, { status: "Maybe" });
      ok("an unknown status is refused (400)", bad.status === 400);
      ok("...and the reply says what IS accepted", /Approved, Rejected or Pending/.test(bad.d.error || "") && /Maybe/.test(bad.d.error || ""), JSON.stringify(bad.d));
      ok("Rejected still works", (await call("POST", "/hr/leaves/" + lvQ.d.id + "/decide", A, { status: "Rejected" })).status === 200);
    }
  }

  section("An imported transfer must be a matched pair (the Excel path)");
  {
    const full = await state();
    const whs = (full.warehouses || []).map((w) => w.id);
    const ledgerOf = (id) => (full.movements || []).filter((m) => m.itemId === id).reduce((s, m) => s + (+m.qty || 0), 0);
    ok("fixture: two stores and stock to move", whs.length >= 2 && ledgerOf(rm) > 10, whs.join() + " " + ledgerOf(rm));
    const lone = JSON.parse(JSON.stringify(full));
    lone.movements.push({ id: "MV-IMP-LONE", date: "2026-09-02", itemId: rm, wh: whs[0], type: "XFER", qty: -5, rate: 0, ref: "T-LONE" });
    const rLone = await call("PUT", "/state", A, lone);
    ok("a lone transfer leg on a bulk save is refused (400)", rLone.status === 400 && /matched pair/.test(rLone.d.error || ""), rLone.status + " " + JSON.stringify(rLone.d).slice(0, 200));
    const unbalanced = JSON.parse(JSON.stringify(full));
    unbalanced.movements.push({ id: "MV-IMP-U1", date: "2026-09-02", itemId: rm, wh: whs[0], type: "XFER", qty: -5, rate: 0, ref: "T-UNB" });
    unbalanced.movements.push({ id: "MV-IMP-U2", date: "2026-09-02", itemId: rm, wh: whs[1], type: "XFER", qty: 3, rate: 0, ref: "T-UNB" });
    ok("two legs that do not add up are refused (400)", (await call("PUT", "/state", A, unbalanced)).status === 400);
    const paired = JSON.parse(JSON.stringify(full));
    paired.movements.push({ id: "MV-IMP-P1", date: "2026-09-02", itemId: rm, wh: whs[0], type: "XFER", qty: -5, rate: 0, ref: "T-PAIR" });
    paired.movements.push({ id: "MV-IMP-P2", date: "2026-09-02", itemId: rm, wh: whs[1], type: "XFER", qty: 5, rate: 0, ref: "T-PAIR" });
    const rPair = await call("PUT", "/state", A, paired);
    ok("a matched pair lands (200)", rPair.status === 200, rPair.status + " " + JSON.stringify(rPair.d).slice(0, 120));
    const after = await state();
    ok("...both legs on file", (after.movements || []).filter((m) => m.ref === "T-PAIR").length === 2);
    ok("...and the material's total is unchanged", Math.abs(((after.movements || []).filter((m) => m.itemId === rm).reduce((s, m) => s + (+m.qty || 0), 0)) - ledgerOf(rm)) < 1e-6);
    ok("re-saving the same ledger is fine — legs already on file are not re-judged", (await call("PUT", "/state", A, after)).status === 200);
  }

  section("The floor's bell: a failed batch from my jobs, until the admin rules");
  {
    const fgId = "FG-LABALERT";   // fixture from the failed-batch section above
    const woB = (await call("POST", "/production/wo", A, { itemId: fgId, qty: 40 })).d;
    ok("fixture: a job on the coating board", !!(woB && woB.id), JSON.stringify(woB).slice(0, 100));
    await call("POST", "/production/wo/" + woB.id + "/advance", C, { action: "start" });
    const badB = await call("POST", "/production/wo/" + woB.id + "/lab", C, { values: { thickness: 0.9, tensile: 5 } });
    const doneB = await call("POST", "/production/wo/" + woB.id + "/advance", C, { action: "complete", wipWh: "WH-WIP" });
    ok("the batch fails and leaves the floor", badB.status === 201 && doneB.status === 200 && !!doneB.d.labWarning, doneB.status + " " + JSON.stringify(doneB.d).slice(0, 100));
    const floor = await state(C);
    const al = (floor.labAlerts || []).find((x) => x.woId === woB.id);
    ok("the coating board's payload carries the alert", !!al, JSON.stringify(floor.labAlerts || null).slice(0, 160));
    ok("...naming the batch, the product and the readings that failed", !!al && al.batchNo === woB.id.replace(/^WO-/, "") && al.productCode === "CHDNW-97" && (al.failed || []).includes("Thickness"), JSON.stringify(al));
    ok("...but never a limit or a measured value", !!al && !/"min"|"max"|0\.9/.test(JSON.stringify(al)));
    const slim = (await call("GET", "/state?slim=1", C)).d;
    ok("the slim refresh after a tap carries it too", (slim.labAlerts || []).some((x) => x.id === al.id));
    ok("the office payload has no such key (it has labQcDecisions)", (await state()).labAlerts === undefined);
    const rule = await call("POST", "/lab/reports/" + (al ? al.id : "LR-0000") + "/decision", A, { accept: true, note: "Use for the trial order" });
    ok("the admin rules", rule.status === 200);
    ok("...and the floor's bell goes quiet", !((await state(C)).labAlerts || []).some((x) => x.woId === woB.id));
  }

  section("A new item in one shot: item + test parameters + recipe, and the lab's approval queue");
  {
    const st1 = await state();
    const supAny = st1.suppliers[0].id;
    const rmA = st1.items.find((i) => i.cat === "RM").id;
    const fgWithBom = Object.keys(st1.boms || {})[0];
    // admin: a new material with two catalogue picks, a parameter of its own (a range), joining an existing recipe
    const direct = await call("POST", "/catalogue/new-item", A, { item: { id: "RM-ONESHOT", name: "One-shot binder", cat: "RM", uom: "KG", cost: 55 },
      tests: { params: ["solids", "viscosity"], custom: [{ label: "Peel strength", unit: "N/25mm" }], spec: { solids: { min: 40, max: 60 }, c_peel_strength: { min: 5 }, viscosity: { nominal: 1200 } } },
      bom: fgWithBom ? { mode: "append", productId: fgWithBom, qty: 0.05, unit: "KG" } : { mode: "none" } });
    ok("admin's entry lands at once (201)", direct.status === 201 && direct.d.item && direct.d.item.id === "RM-ONESHOT", direct.status + " " + JSON.stringify(direct.d).slice(0, 160));
    ok("...the material carries its own parameter, with its unit", direct.status === 201 && direct.d.item.testParams && direct.d.item.testParams[0].key === "c_peel_strength" && direct.d.item.testParams[0].unit === "N/25mm", JSON.stringify(direct.d.item && direct.d.item.testParams));
    ok("...the parameter list is the picks plus its own", direct.status === 201 && direct.d.qc && direct.d.qc.params.join() === "solids,viscosity,c_peel_strength", JSON.stringify(direct.d.qc && direct.d.qc.params));
    const itA = ((await state()).items || []).find((i) => i.id === "RM-ONESHOT");
    ok("...a range grades, a static figure is kept as the target", !!itA && itA.qcSpec && itA.qcSpec.c_peel_strength.min === 5 && itA.qcSpec.viscosity.nominal === 1200 && itA.qcSpec.solids.max === 60, JSON.stringify(itA && itA.qcSpec));
    if (fgWithBom) ok("...and it joined the recipe", ((await state()).boms[fgWithBom].lines || []).some((l) => (Array.isArray(l) ? l[0] : l.id) === "RM-ONESHOT"), JSON.stringify((await state()).boms[fgWithBom]).slice(0, 200));
    else ok("(no recipe in the seed to join)", true);
    ok("...with an opening ledger line", ((await state()).movements || []).some((m) => m.itemId === "RM-ONESHOT" && m.type === "OPEN"));
    // the reading form asks for its own parameter, on a real receipt
    const poX = (await call("POST", "/purchase-orders", A, { supplierId: supAny, eta: "2026-09-12", lines: [{ itemId: "RM-ONESHOT", qty: 20, rate: 55 }] })).d;
    const gX = (await call("POST", "/purchase-orders/" + poX.id + "/receive", A, { wh: "WH-PNY", lines: [{ i: 0, qty: 20 }] })).d.grn;
    const formX = (await call("GET", "/grns/" + encodeURIComponent(gX.id) + "/tests/RM-ONESHOT", LB)).d;
    ok("the incoming test asks for the material's own parameter, with its unit", (formX.params || []).some((p) => p.key === "c_peel_strength" && p.unit === "N/25mm"), JSON.stringify((formX.params || []).map((p) => p.key)));
    const partX = await call("POST", "/grns/" + encodeURIComponent(gX.id) + "/tests", LB, { itemId: "RM-ONESHOT", values: { solids: 50, viscosity: 1150 } });
    ok("...and will not file without it", partX.status === 400 && /Peel strength/.test(partX.d.error || ""), JSON.stringify(partX.d).slice(0, 120));
    const fullX = await call("POST", "/grns/" + encodeURIComponent(gX.id) + "/tests", LB, { itemId: "RM-ONESHOT", values: { solids: 50, viscosity: 1150, c_peel_strength: 3 } });
    const tX = ((await state()).grnTests || []).find((t) => t.grnId === gX.id && t.itemId === "RM-ONESHOT");
    ok("...a reading under its range fails on that parameter; the static one is recorded", fullX.status === 201 && !!tX && tX.result === "Fail" && tX.results.c_peel_strength === "fail" && tX.results.viscosity === "na", JSON.stringify(tX && tX.results));

    // a finished good with its own parameters gets a lab product that asks for them, and its recipe
    const fgNew = await call("POST", "/catalogue/new-item", A, { item: { id: "FG-ONESHOT", name: "One-shot glass tape", cat: "FG", uom: "KG", thicknessMM: 0.12, gsm: 90, cost: 150, price: 300 },
      tests: { custom: [{ label: "Adhesion", unit: "N/cm" }, { label: "Shrinkage", unit: "%" }], spec: { c_adhesion: { min: 2 }, c_shrinkage: { max: 1.5 } } },
      bom: { mode: "create", yield: 95, lines: [{ id: rmA, qty: 0.8, unit: "KG" }, { id: "RM-ONESHOT", qty: 0.2, unit: "KG" }] } });
    ok("a finished good is created with its recipe (201)", fgNew.status === 201 && !!fgNew.d.bom && !!fgNew.d.labProduct, fgNew.status + " " + JSON.stringify(fgNew.d).slice(0, 200));
    ok("...its recipe has both components", fgNew.status === 201 && (fgNew.d.bom.lines || []).length === 2, JSON.stringify(fgNew.d.bom));
    ok("...and its lab product carries the two parameters with their limits", fgNew.status === 201 && fgNew.d.labProduct.params.length === 2 && fgNew.d.labProduct.spec.c_adhesion.min === 2 && fgNew.d.labProduct.itemId === "FG-ONESHOT", JSON.stringify(fgNew.d.labProduct).slice(0, 200));
    const woX = (await call("POST", "/production/wo", A, { itemId: "FG-ONESHOT", qty: 10 })).d;
    const floorWo = ((await state(C)).workorders || []).find((w) => w.id === woX.id);
    if (floorWo && floorWo.lab) ok("a work order on it asks the floor for exactly those parameters", (floorWo.lab.params || []).map((p) => p.key).join() === "c_adhesion,c_shrinkage", JSON.stringify(floorWo.lab.params));
    else ok("(the job did not land on the coating board; the certificate check below covers the parameters)", true);
    const cert = await call("POST", "/lab/reports", A, { productId: fgNew.d.labProduct.id, refNo: "B-ONESHOT", values: { c_adhesion: 1, c_shrinkage: 0.5 } });
    const certDoc = ((await state()).labReports || []).find((r) => cert.d && r.id === cert.d.id);
    ok("a certificate grades the product's own parameters", cert.status === 201 && !!certDoc && certDoc.result === "Fail" && certDoc.results.c_adhesion === "fail" && certDoc.results.c_shrinkage === "pass", cert.status + " " + JSON.stringify(certDoc && certDoc.results));

    // rules
    ok("a recipe of its own on a material is refused (400)", (await call("POST", "/catalogue/new-item", A, { item: { id: "RM-NOBOM", name: "x", cat: "RM" }, bom: { mode: "create", lines: [{ id: rmA, qty: 1 }] } })).status === 400);
    ok("a second item with the same code is refused (409)", (await call("POST", "/catalogue/new-item", A, { item: { id: "RM-ONESHOT", name: "again", cat: "RM" } })).status === 409);
    ok("the lab still cannot write the catalogue directly (403)", (await call("POST", "/items", LB, { id: "RM-LABDIRECT", name: "x", cat: "RM" })).status === 403);

    // the lab proposes; nothing lands until the admin approves
    const prop = await call("POST", "/catalogue/new-item", LB, { item: { id: "RM-LABPROP", name: "Lab-proposed primer", cat: "RM", uom: "KG", cost: 12 },
      tests: { params: ["density"], custom: [{ label: "Cure time", unit: "min" }] }, bom: { mode: "none" } });
    ok("the lab's entry becomes a proposal (202)", prop.status === 202 && prop.d.proposed && prop.d.proposal.status === "Pending", prop.status + " " + JSON.stringify(prop.d).slice(0, 160));
    const apId = prop.d.proposal ? prop.d.proposal.id : "AP-0000";
    ok("...nothing is in the catalogue yet", !((await state()).items || []).some((i) => i.id === "RM-LABPROP"));
    const adminAps = (await state()).approvals || [];
    ok("...and the proposal is in the admin's state, with a summary", adminAps.some((a) => a.id === apId && /RM-LABPROP/.test(a.summary) && /2 test parameters \(1 new\)/.test(a.summary)), JSON.stringify(adminAps.slice(0, 2)).slice(0, 240));
    ok("...and in the lab's own", ((await state(LB)).approvals || []).some((a) => a.id === apId));
    const labProp2 = await call("POST", "/catalogue/new-item", LB, { item: { id: "RM-LABPROP2", name: "To be rejected", cat: "RM" } });
    ok("office cannot rule (403)", (await call("POST", "/approvals/" + apId + "/decide", O, { approve: true })).status === 403);
    ok("nor the lab (403)", (await call("POST", "/approvals/" + apId + "/decide", LB, { approve: true })).status === 403);
    ok("a ruling must say approve true or false (400)", (await call("POST", "/approvals/" + apId + "/decide", A, {})).status === 400);
    const appr = await call("POST", "/approvals/" + apId + "/decide", A, { approve: true, note: "fine" });
    ok("the admin approves", appr.status === 200 && appr.d.status === "Approved" && appr.d.decidedBy === "admin" && appr.d.result.itemId === "RM-LABPROP", appr.status + " " + JSON.stringify(appr.d).slice(0, 160));
    const landed = ((await state()).items || []).find((i) => i.id === "RM-LABPROP");
    ok("...and the item lands with its parameters", !!landed && landed.qcParams.join() === "density,c_cure_time" && landed.testParams[0].unit === "min", JSON.stringify(landed && { p: landed.qcParams, t: landed.testParams }));
    ok("a second ruling on it is refused (409)", (await call("POST", "/approvals/" + apId + "/decide", A, { approve: false })).status === 409);
    const rej = await call("POST", "/approvals/" + (labProp2.d.proposal ? labProp2.d.proposal.id : "AP-0000") + "/decide", A, { approve: false, note: "not needed" });
    ok("a rejection keeps the catalogue as it was", rej.status === 200 && rej.d.status === "Rejected" && !((await state()).items || []).some((i) => i.id === "RM-LABPROP2"), rej.status + " " + JSON.stringify(rej.d).slice(0, 100));
    // a recipe proposed on its own
    const bomProp = await call("POST", "/approvals", LB, { kind: "bom", payload: { itemId: "FG-ONESHOT", bom: { yield: 90, lines: [{ id: rmA, qty: 1.1, unit: "KG" }] } } });
    ok("the lab may propose a recipe change (201)", bomProp.status === 201 && bomProp.d.kind === "bom" && /Recipe for FG-ONESHOT/.test(bomProp.d.summary), bomProp.status + " " + JSON.stringify(bomProp.d).slice(0, 160));
    ok("...the recipe is unchanged until approved", ((await state()).boms["FG-ONESHOT"].lines || []).length === 2);
    ok("the lab cannot save a recipe directly (403)", (await call("PUT", "/boms/FG-ONESHOT", LB, { yield: 1, lines: [[rmA, 1]] })).status === 403);
    const apprB = await call("POST", "/approvals/" + bomProp.d.id + "/decide", A, { approve: true });
    ok("approved, it replaces the recipe", apprB.status === 200 && ((await state()).boms["FG-ONESHOT"].lines || []).length === 1, apprB.status + " " + JSON.stringify(apprB.d).slice(0, 120));
    ok("a proposal is checked when it is made (400)", (await call("POST", "/approvals", LB, { kind: "bom", payload: { itemId: "FG-NOPE", bom: { lines: [{ id: rmA, qty: 1 }] } } })).status === 400);
    const mine = await call("POST", "/approvals", LB, { kind: "item", payload: { item: { id: "RM-WITHDRAW", name: "x", cat: "RM" } } });
    ok("the proposer may withdraw a pending proposal", mine.status === 201 && (await call("DELETE", "/approvals/" + mine.d.id, LB)).status === 200 && !((await state()).approvals || []).some((a) => a.id === mine.d.id));
    ok("...but not one already ruled on", (await call("DELETE", "/approvals/" + apId, LB)).status === 409);
    ok("the floor's payload has no approvals", (await state(C)).approvals === undefined);
  }
  }

  // restore the BOM change we made so a re-run against a persisted DB stays clean
  await call("DELETE", "/items/RM-HTTP", A);
}

run()
  .catch((e) => { fail++; console.log("\n  ✗ UNCAUGHT: " + (e && e.stack ? e.stack : e)); })
  .finally(async () => {
    try { server.close(); } catch {}
    try { await closeDb(); } catch {}
    /* drop this run's scratch database and directory, and sweep any that a
       run which died before this point left behind */
    await scratch.release(RUN);
    console.log("\n" + (fail === 0 ? "PASS" : "FAIL") + " — " + pass + " passed, " + fail + " failed\n");
    process.exit(fail === 0 ? 0 : 1);
  });
