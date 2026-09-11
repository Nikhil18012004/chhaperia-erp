/* ============================================================
   CHHAPERIA ERP — AUDIT 2: the business rules, pushed at the edges

   Every section states a rule the ERP either documents in its own
   comments or that the ledger cannot do without, and then tries to
   break it the way a busy plant would: a store that holds none of
   the stock, an order edited after it shipped, a work order deleted
   and renumbered, a lot failed after it was used, a unit that is not
   the stocking unit, two clerks pressing Save at the same moment.

   A failing check here is a FINDING, not a flaky test: the detail
   printed beside it is the evidence.

     node backend/test/http-audit-rules.js
   ============================================================ */
"use strict";
const H = require("./_harness")("audit_rules");
const { call, login, ok, note, section, J } = H;

async function run() {
  await H.start();
  const A = await login("admin"), O = await login("office"), L = await login("lab");
  const C = await login("coating1"), S1 = await login("slitting1");
  ok("every role signs in", !!(A && O && L && C && S1));

  const state = async () => (await call("GET", "/state", A)).d;
  const onHand = (st, id, wh) => +((st.movements || []).filter((m) => m.itemId === id && (wh == null || m.wh === wh))
    .reduce((n, m) => n + (+m.qty || 0), 0)).toFixed(6);
  const stock = async (id, wh) => onHand(await state(), id, wh);
  async function rm(id, perWh, extra) {
    const r = await call("POST", "/items", A, Object.assign({ id, name: id + " material", cat: "RM", uom: "KG", cost: 10 }, extra || {}));
    for (const [wh, q] of Object.entries(perWh || {})) {
      await call("POST", "/movements", A, { itemId: id, type: "GRN", qty: q, wh, rate: 10, manual: true, date: "2026-09-01", ref: "SEED-" + id });
    }
    return r;
  }
  /* a finished good with a one-line recipe and a one-parameter spec (thickness 0–10) */
  async function fg(id, lines, extra) {
    await call("POST", "/items", A, Object.assign({ id, name: id + " tape", cat: "FG", uom: "KG", cost: 50, price: 100,
      group: "OTHER TAPE SERIES", typeCode: id.replace(/^FG-/, "") }, extra || {}));
    if (lines) await call("PUT", "/boms/" + id, A, { yield: 1, lines });
    const lp = await call("POST", "/lab/products", A, { name: id + " tape", itemId: id, spec: { thickness: { min: 0, max: 10 } } });
    return lp.d;
  }
  const LOT = (ref) => ({ refNo: ref, labValues: { thickness: 1 } });
  const sup0 = (await state()).suppliers[0].id;
  const cust0 = (await state()).customers[0].id;

  /* ============================================================ */
  section("A. Stock has a floor — in every store, on every path");
  {
    await rm("RM-AU-A1", { "WH-PNY": 100 });
    const adj = await call("POST", "/movements", A, { itemId: "RM-AU-A1", type: "ADJ", qty: -50, wh: "WH-FG", note: "count" });
    ok("a write-off in a store that holds none of the material is refused", adj.status === 400,
      adj.status + " — WH-FG now reads " + (await stock("RM-AU-A1", "WH-FG")) + " (WH-PNY " + (await stock("RM-AU-A1", "WH-PNY")) + ")");
    const iss = await call("POST", "/movements", A, { itemId: "RM-AU-A1", type: "ISSUE", qty: -30, wh: "WH-WIP" });
    ok("…so is an issue from the wrong store", iss.status === 400, iss.status + " — WH-WIP now reads " + (await stock("RM-AU-A1", "WH-WIP")));
    const tooMuch = await call("POST", "/movements", A, { itemId: "RM-AU-A1", type: "ISSUE", qty: -1000, wh: "WH-PNY" });
    ok("an issue larger than the whole on-hand is refused (the item-level floor)", tooMuch.status === 400, tooMuch.status);

    /* dispatch of a line with no batch — plain finished stock */
    await call("POST", "/items", A, { id: "FG-AU-A2", name: "Audit dispatch tape", cat: "FG", uom: "KG", cost: 50, price: 100 });
    await call("POST", "/movements", A, { itemId: "FG-AU-A2", type: "GRN", qty: 100, wh: "WH-PNY", manual: true, note: "stock in the raw store" });
    const so = await call("POST", "/sales-orders", O, { customerId: cust0, lines: [{ itemId: "FG-AU-A2", qty: 10, rate: 100 }] });
    const d = await call("POST", "/sales-orders/" + so.d.id + "/dispatch", O, { wh: "WH-FG" });
    const fgBay = await stock("FG-AU-A2", "WH-FG");
    ok("dispatching from a store that holds none of the goods is refused (or drawn from where they are)", d.status >= 400 || fgBay >= 0,
      d.status + " — the Finished Goods Bay now reads " + fgBay + " while WH-PNY still holds " + (await stock("FG-AU-A2", "WH-PNY")));

    /* producing finished stock with too little raw material */
    await rm("RM-AU-A3", { "WH-PNY": 5 });
    await fg("FG-AU-A3", [["RM-AU-A3", 1]]);
    const book = await call("POST", "/production/finished", A, Object.assign({ itemId: "FG-AU-A3", qty: 20, wh: "WH-FG" }, LOT("LOT-A3")));
    const rmLeft = await stock("RM-AU-A3");
    ok("booking 20 kg of finished stock needing 20 kg of raw with only 5 in store is refused", book.status >= 400 || rmLeft >= 0,
      book.status + " — the raw material now reads " + rmLeft + " kg");

    /* an unplanned run recorded on the floor, same shortage */
    await rm("RM-AU-A4", { "WH-PNY": 10 });
    await fg("FG-AU-A4", [["RM-AU-A4", 1]]);
    const adh = await call("POST", "/production/adhoc", C, { itemId: "FG-AU-A4", kg: 25 });
    const rmA4 = await stock("RM-AU-A4");
    ok("an unplanned run that needs more raw than the store holds is refused", adh.status >= 400 || rmA4 >= 0,
      adh.status + " — the raw material now reads " + rmA4 + " kg");
  }

  /* ============================================================ */
  section("B. An unplanned (ad-hoc) run is issued ONCE");
  {
    await rm("RM-AU-B1", { "WH-PNY": 1000 });
    await fg("FG-AU-B1", [["RM-AU-B1", 1]]);
    const adh = await call("POST", "/production/adhoc", A, { itemId: "FG-AU-B1", kg: 40 });
    ok("the run is recorded (201) and raises a work order", adh.status === 201 && adh.d.workOrder, adh.status + " " + J(adh.d).slice(0, 140));
    const afterRec = await stock("RM-AU-B1");
    ok("recording it issues the 40 kg it burned", Math.abs(afterRec - 960) < 1e-6, afterRec);
    const woId = adh.d.workOrder;
    const wo = (await state()).workorders.find((w) => w.id === woId) || {};
    note("the ad-hoc work order lands on the boards as", wo.status + " · route " + (wo.route || []).map((r) => r.key + ":" + r.status + (r.posted ? "(posted)" : "")).join(" > "));
    const all = await call("POST", "/production/wo/" + woId + "/advance", A, { action: "complete", all: true });
    const afterDone = await stock("RM-AU-B1");
    ok("completing its stages on the board does not issue the same material a second time",
      Math.abs(afterDone - 960) < 1e-6, all.status + " — raw now " + afterDone + " kg (issued " + (960 - afterDone) + " kg more)");
  }

  /* ============================================================ */
  section("C. A shipped order stays shipped");
  {
    await call("POST", "/items", A, { id: "FG-AU-C1", name: "Audit shipped tape", cat: "FG", uom: "KG", cost: 50, price: 100 });
    await call("POST", "/movements", A, { itemId: "FG-AU-C1", type: "GRN", qty: 100, wh: "WH-FG", manual: true });
    const so = (await call("POST", "/sales-orders", O, { customerId: cust0, lines: [{ itemId: "FG-AU-C1", qty: 10, rate: 100 }] })).d;
    await call("POST", "/sales-orders/" + so.id + "/dispatch", O, {});
    ok("dispatch takes 10 out", Math.abs((await stock("FG-AU-C1")) - 90) < 1e-6);
    const back = await call("PATCH", "/sales-orders/" + so.id, O, { status: "Confirmed" });
    const again = await call("POST", "/sales-orders/" + so.id + "/dispatch", O, {});
    const left = await stock("FG-AU-C1");
    ok("a dispatched order cannot be set back to Confirmed and shipped a second time",
      Math.abs(left - 90) < 1e-6, "PATCH status→Confirmed " + back.status + ", second dispatch " + again.status + " — stock now " + left + " (" + (90 - left) + " more taken)");

    const so2 = (await call("POST", "/sales-orders", O, { customerId: cust0, lines: [{ itemId: "FG-AU-C1", qty: 5, rate: 100 }] })).d;
    const fake = await call("PATCH", "/sales-orders/" + so2.id, O, { status: "Dispatched" });
    const disp2 = await call("POST", "/sales-orders/" + so2.id + "/dispatch", O, {});
    ok("an order cannot be marked Dispatched by an edit (skipping the stock movement)", fake.status >= 400 || disp2.status === 200,
      "PATCH status→Dispatched " + fake.status + ", then dispatch " + disp2.status + " " + J(disp2.d.error || "") + " — no stock ever left");

    const so3 = (await call("POST", "/sales-orders", O, { customerId: cust0, lines: [{ itemId: "FG-AU-C1", qty: 5, rate: 100 }] })).d;
    await call("PATCH", "/sales-orders/" + so3.id, O, { status: "Cancelled" });
    const d3 = await call("POST", "/sales-orders/" + so3.id + "/dispatch", O, {});
    ok("a cancelled order cannot be dispatched", d3.status >= 400, d3.status + " — it shipped");

    const before = await stock("FG-AU-C1");
    const del = await call("DELETE", "/sales-orders/" + so.id, O);
    note("deleting a DISPATCHED order", del.status + " — stock went from " + before + " to " + (await stock("FG-AU-C1")) + " (its dispatch is reversed as if the goods came back)");

    const v = await call("POST", "/sales-orders", O, { customerId: cust0, value: 1, lines: [{ itemId: "FG-AU-C1", qty: 10, rate: 100 }] });
    ok("an order's value is its lines (a client-sent value of 1 does not replace ₹1,000)", v.d.value === 1000, "stored value " + v.d.value);
    const neg = await call("POST", "/sales-orders", O, { customerId: cust0, lines: [{ itemId: "FG-AU-C1", qty: 10, rate: -100 }] });
    ok("a negative rate on a sales line is refused", neg.status === 400, neg.status + " value " + (neg.d && neg.d.value));
    const pneg = await call("POST", "/purchase-orders", O, { supplierId: sup0, lines: [{ itemId: "RM-AU-A1", qty: 10, rate: -5 }] });
    ok("a negative rate on a purchase line is refused", pneg.status === 400, pneg.status + " value " + (pneg.d && pneg.d.value));
  }

  /* ============================================================ */
  section("D. Deleting a purchase order after its stock was used");
  {
    await call("POST", "/items", A, { id: "RM-AU-D1", name: "Audit delivered resin", cat: "RM", uom: "KG", cost: 10 });
    const po = (await call("POST", "/purchase-orders", O, { supplierId: sup0, lines: [{ itemId: "RM-AU-D1", qty: 100, rate: 10 }] })).d;
    await call("POST", "/purchase-orders/" + po.id + "/receive", O, { wh: "WH-PNY", lines: [{ i: 0, qty: 100 }] });
    await call("POST", "/movements", A, { itemId: "RM-AU-D1", type: "ISSUE", qty: -80, wh: "WH-PNY", note: "used" });
    const del = await call("DELETE", "/purchase-orders/" + po.id, O);
    const now = await stock("RM-AU-D1");
    ok("a received order whose stock has since been used cannot be deleted (it would leave the store negative)",
      del.status >= 400 || now >= 0, del.status + " — the material now reads " + now + " kg");
  }

  /* ============================================================ */
  section("E. A work order's number is its batch — deleting or renumbering it");
  {
    /* a water-blocking tape made in-house: it passes through the coating floor */
    await rm("RM-AU-E1", { "WH-PNY": 5000 });
    await call("POST", "/items", A, { id: "FG-AU-E1", name: "Audit water blocking tape", cat: "FG", uom: "KG",
      typeCode: "CHDNW-97", group: "WATER BLOCKING SERIES", cost: 100, price: 200 });
    await call("PUT", "/boms/FG-AU-E1", A, { yield: 100, lines: [["RM-AU-E1", 1.2]] });
    await call("POST", "/lab/products", A, { name: "Audit water blocking tape", itemId: "FG-AU-E1",
      spec: { thickness: { min: 0.2, max: 0.3 } } });
    const w1 = (await call("POST", "/production/wo", A, { itemId: "FG-AU-E1", qty: 10 })).d;
    ok("the job starts on the coating floor", (w1.route || [])[0] && w1.route[0].area === "coating", J((w1.route || []).map((r) => r.area)));
    await call("POST", "/production/wo/" + w1.id + "/advance", C, { action: "start" });
    const rd = await call("POST", "/production/wo/" + w1.id + "/lab", C, { values: { thickness: 0.25 } });
    ok("the floor measures batch " + w1.id, rd.status === 201, rd.status + " " + J(rd.d).slice(0, 100));
    await call("DELETE", "/production/wo/" + w1.id, A);
    const w2 = (await call("POST", "/production/wo", A, { itemId: "FG-AU-E1", qty: 10 })).d;
    note("the next work order raised takes the number", w2.id + (w2.id === w1.id ? " — the SAME number as the deleted one" : ""));
    const sheet = await call("GET", "/production/wo/" + w2.id + "/lab", C);
    ok("a new work order does not inherit the deleted one's certificate",
      !(sheet.d && sheet.d.reportId), "the new " + w2.id + " already carries report " + (sheet.d && sheet.d.reportId) + " (prodComplete " + (sheet.d && sheet.d.prodComplete) + ")");
    await call("POST", "/production/wo/" + w2.id + "/advance", C, { action: "start" });
    const close = await call("POST", "/production/wo/" + w2.id + "/advance", C, { action: "complete", wipWh: "WH-WIP" });
    ok("…so its coating cannot close before IT is measured", close.status === 409,
      "coating closed with " + close.status + " without anyone measuring " + w2.id);

    /* renumbering: the ledger follows the new number — do the certificate and the orders? */
    const w3 = (await call("POST", "/production/wo", A, { itemId: "FG-AU-E1", qty: 10 })).d;
    await call("POST", "/production/wo/" + w3.id + "/advance", C, { action: "start" });
    await call("POST", "/production/wo/" + w3.id + "/lab", C, { values: { thickness: 0.26 } });
    const so = (await call("POST", "/sales-orders", O, { customerId: cust0, lines: [{ itemId: "FG-AU-E1", qty: 5, rate: 200, batch: w3.id }] })).d;
    const ren = await call("PATCH", "/production/wo/" + w3.id, O, { id: "WO-AU-RENUM" });
    ok("the office renumbers the work order (200)", ren.status === 200 && ren.d.id === "WO-AU-RENUM", ren.status + " " + J(ren.d).slice(0, 80));
    const sh2 = await call("GET", "/production/wo/WO-AU-RENUM/lab", C);
    ok("the renumbered job keeps its certificate", !!(sh2.d && sh2.d.reportId) && sh2.d.prodComplete === true,
      "reportId " + J(sh2.d && sh2.d.reportId) + " prodComplete " + J(sh2.d && sh2.d.prodComplete) + " — the floor must measure it again");
    const soBack = (await state()).salesorders.find((s) => s.id === so.id);
    ok("…and the sales order that ships it follows the new number", soBack && soBack.lines[0].batch === "WO-AU-RENUM",
      "the order's line still names " + (soBack && soBack.lines[0].batch));
    const disp = await call("POST", "/sales-orders/" + so.id + "/dispatch", O, {});
    ok("…so the order can still be dispatched", disp.status === 200, disp.status + " " + J(disp.d.error || ""));
    const ren2 = await call("PATCH", "/production/wo/WO-AU-RENUM", O, { id: "wo-9999 x" });
    note("renumbering to a free-text id", ren2.status + " → " + J(ren2.d && ren2.d.id));
  }

  /* ============================================================ */
  section("F. A failed incoming lot, ruled on after it was used / in another unit");
  {
    const mk = async (id, extra) => {
      await call("POST", "/items", A, Object.assign({ id, name: id + " paste", cat: "RM", uom: "KG", cost: 10 }, extra || {}));
      await call("PUT", "/items/" + id + "/qc", A, { params: ["viscosity"], spec: { viscosity: { min: 100, max: 200 } } });
    };
    await mk("RM-AU-F1");
    const po = (await call("POST", "/purchase-orders", O, { supplierId: sup0, lines: [{ itemId: "RM-AU-F1", qty: 100, rate: 10 }] })).d;
    const g = (await call("POST", "/purchase-orders/" + po.id + "/receive", O, { wh: "WH-PNY", lines: [{ i: 0, qty: 100 }] })).d.grn;
    await call("POST", "/movements", A, { itemId: "RM-AU-F1", type: "ISSUE", qty: -80, wh: "WH-PNY", note: "used before the lab got to it" });
    const t = (await call("POST", "/grns/" + encodeURIComponent(g.id) + "/tests", L, { itemId: "RM-AU-F1", values: { viscosity: 500 } })).d.test;
    const dec = await call("POST", "/grn-tests/" + t.id + "/decision", A, { approve: true });
    const pny = await stock("RM-AU-F1", "WH-PNY"), qc = await stock("RM-AU-F1", "WH-QC");
    ok("quarantining a failed lot moves only what is still on the shelf (no negative store)", pny >= 0,
      dec.status + " — WH-PNY now " + pny + ", quarantine " + qc + " (80 of the 100 had already been used)");

    /* a roll stocked in metres, bought in kilograms */
    await call("POST", "/items", A, { id: "RM-AU-F2", name: "Audit roll fabric", cat: "RM", uom: "MTR", cost: 1, gsm: 200, width: 1000 });
    await call("PUT", "/items/RM-AU-F2/qc", A, { params: ["thickness"], spec: { thickness: { min: 0.1, max: 0.2 } } });
    const po2 = (await call("POST", "/purchase-orders", O, { supplierId: sup0, lines: [{ itemId: "RM-AU-F2", qty: 100, rate: 5, uom: "KG" }] })).d;
    const g2 = (await call("POST", "/purchase-orders/" + po2.id + "/receive", O, { wh: "WH-PNY", lines: [{ i: 0, qty: 100 }] })).d.grn;
    const inStore = await stock("RM-AU-F2", "WH-PNY");
    ok("100 kg of a 200 gsm, 1 m roll lands as 500 m", Math.abs(inStore - 500) < 0.01, inStore);
    const t2 = (await call("POST", "/grns/" + encodeURIComponent(g2.id) + "/tests", L, { itemId: "RM-AU-F2", values: { thickness: 0.9 } })).d.test;
    await call("POST", "/grn-tests/" + t2.id + "/decision", A, { approve: true });
    const q2 = await stock("RM-AU-F2", "WH-QC"), p2 = await stock("RM-AU-F2", "WH-PNY");
    ok("the WHOLE failed lot (500 m) goes to quarantine, in the stocking unit", Math.abs(q2 - 500) < 0.01 && Math.abs(p2) < 0.01,
      "quarantine holds " + q2 + " m and " + p2 + " m of the failed lot is still drawable in the main store");

    /* the order the quarantined lot came in on is deleted */
    const del = await call("DELETE", "/purchase-orders/" + po2.id, O);
    const p3 = await stock("RM-AU-F2", "WH-PNY"), q3 = await stock("RM-AU-F2", "WH-QC");
    ok("deleting that order leaves no stock behind in any store", Math.abs(p3) < 0.01 && Math.abs(q3) < 0.01,
      "DELETE " + del.status + " — main store " + p3 + ", quarantine " + q3);
  }

  /* ============================================================ */
  section("G. What the floor may put back into the store");
  {
    await call("POST", "/items", A, { id: "RM-AU-G1", name: "Audit never-issued resin", cat: "RM", uom: "KG", cost: 10 });
    const r = await call("POST", "/production/return", C, { itemId: "RM-AU-G1", qty: 1000000, wh: "WH-PNY", reason: "leftover" });
    ok("a supervisor cannot 'return' material that was never issued (1,000,000 kg minted)", r.status >= 400,
      r.status + " — the store now holds " + (await stock("RM-AU-G1")) + " kg of it");
    await call("POST", "/items", A, { id: "FG-AU-G2", name: "Audit unmeasured tape", cat: "FG", uom: "KG", cost: 50, price: 100 });
    await call("PUT", "/boms/FG-AU-G2", A, { yield: 1, lines: [["RM-AU-G1", 1]] });
    await call("POST", "/lab/products", A, { name: "Audit unmeasured tape", itemId: "FG-AU-G2", spec: { thickness: { min: 0, max: 1 } } });
    const book = await call("POST", "/production/finished", C, { itemId: "FG-AU-G2", qty: 50, wh: "WH-FG" });
    ok("the store door refuses 50 kg of it unmeasured (409)", book.status === 409, book.status);
    const ret = await call("POST", "/production/return", C, { itemId: "FG-AU-G2", qty: 50, wh: "WH-FG", reason: "off the line" });
    ok("…and a 'return' is not a way round the lab gate", ret.status >= 400,
      ret.status + " — the Finished Goods Bay now holds " + (await stock("FG-AU-G2", "WH-FG")) + " kg with no certificate");
    const ex = await call("POST", "/production/excess-material", C, { woId: "WO-NOPE", lines: [{ itemId: "RM-AU-G1", qty: 1, location: "WH-PNY" }] });
    ok("excess material against an unknown work order is 404", ex.status === 404, ex.status);
  }

  /* ============================================================ */
  section("H. Two clerks press Save at the same moment");
  {
    const par = (n, f) => Promise.all(Array.from({ length: n }, (_, i) => f(i)));
    /* the item-level floor under load */
    await rm("RM-AU-H1", { "WH-PNY": 10 });
    const iss = await par(10, () => call("POST", "/movements", A, { itemId: "RM-AU-H1", type: "ISSUE", qty: -10, wh: "WH-PNY" }));
    const okN = iss.filter((r) => r.status === 201).length;
    const left = await stock("RM-AU-H1");
    ok("10 simultaneous issues of the whole 10 kg: exactly one goes through", okN === 1 && left >= 0,
      okN + " accepted — the material now reads " + left + " kg");

    /* the same shortage through work orders */
    await rm("RM-AU-H2", { "WH-PNY": 100 });
    await fg("FG-AU-H2", [["RM-AU-H2", 1]]);
    const wos = await par(5, () => call("POST", "/production/wo", O, { itemId: "FG-AU-H2", qty: 30, allowShortage: true }));
    const left2 = await stock("RM-AU-H2");
    ok("5 simultaneous work orders of 30 kg against 100 kg never take the store negative", left2 >= -1e-6,
      J(wos.map((r) => r.status + ":" + (r.d.id || "") + "/run " + (r.d.runQty != null ? r.d.runQty : "?"))) + " — raw now " + left2);

    /* numbering: each document its own number */
    const check = async (label, n, create, listOf, idOf) => {
      const before = new Set((listOf(await state()) || []).map(idOf));
      const rs = await par(n, create);
      const statuses = rs.map((r) => r.status);
      const ids = rs.filter((r) => r.status < 300).map((r) => idOf(r.d)).filter(Boolean);
      const after = (listOf(await state()) || []).filter((x) => !before.has(idOf(x)));
      ok(n + " simultaneous " + label + ": " + n + " distinct numbers and " + n + " records",
        new Set(ids).size === n && after.length === n,
        "statuses " + J(statuses) + " · ids " + J(ids) + " · records now on file " + after.length);
    };
    await rm("RM-AU-H3", { "WH-PNY": 100000 });
    await fg("FG-AU-H3", [["RM-AU-H3", 1]]);
    await check("work orders", 6, () => call("POST", "/production/wo", O, { itemId: "FG-AU-H3", qty: 5 }), (s) => s.workorders, (x) => x && x.id);
    const stH3 = await state();
    const woIssues = (stH3.movements || []).filter((m) => m.itemId === "RM-AU-H3" && m.type === "ISSUE");
    const liveH3 = (stH3.workorders || []).filter((w) => w.itemId === "FG-AU-H3");
    const drawn = woIssues.reduce((n, m) => n - (+m.qty || 0), 0);
    const needed = liveH3.reduce((n, w) => n + (+w.runQty || +w.qty || 0), 0);
    ok("…and the material issued is what the work orders on file actually need",
      Math.abs(drawn - needed) < 1e-6,
      woIssues.length + " issues totalling " + drawn + " kg against " + liveH3.length + " work order(s) needing " + needed + " kg — "
      + (drawn - needed) + " kg left the store for orders that no longer exist");
    await check("purchase orders", 6, () => call("POST", "/purchase-orders", O, { supplierId: sup0, lines: [{ itemId: "RM-AU-H3", qty: 1, rate: 1 }] }), (s) => s.purchaseorders, (x) => x && x.id);
    await check("sales orders", 6, () => call("POST", "/sales-orders", O, { customerId: cust0, lines: [{ itemId: "FG-AU-H3", qty: 1, rate: 1 }] }), (s) => s.salesorders, (x) => x && x.id);
    await check("CRM leads", 6, (i) => call("POST", "/leads", O, { company: "Race Co " + i }), (s) => s.leads, (x) => x && x.id);
    await check("suppliers", 6, (i) => call("POST", "/suppliers", O, { name: "Race Supplier " + i }), (s) => s.suppliers, (x) => x && x.id);
    await check("quotations", 6, () => call("POST", "/quotations", O, { customerId: cust0, itemId: "FG-AU-H3", price: 10 }), (s) => s.quotations, (x) => x && x.id);
    await check("complaints", 6, (i) => call("POST", "/complaints", O, { customerId: cust0, claim: "race " + i }), (s) => s.complaints, (x) => x && x.id);
    await check("lab certificates", 6, (i) => call("POST", "/lab/reports", A, { productId: "LP-001", refNo: "RACE-" + i, values: { tensile: 1 } }), (s) => s.labReports, (x) => x && x.id);
    await check("HR workers", 6, (i) => call("POST", "/hr/workers", O, { name: "Race Worker " + i, monthlyCtc: 10000 }), (s) => s.hrWorkers, (x) => x && x.id);
    await check("transporters", 6, (i) => call("POST", "/transporters", O, { name: "Race Roadways " + i }), (s) => s.transporters, (x) => x && x.id);
    await check("appointments", 6, (i) => call("POST", "/appointments", O, { title: "Race " + i, date: "2026-09-20" }), (s) => s.appointments, (x) => x && x.id);

    /* goods receipts on six different orders at once — one number series */
    const pos = [];
    for (let i = 0; i < 6; i++) pos.push((await call("POST", "/purchase-orders", O, { supplierId: sup0, lines: [{ itemId: "RM-AU-H3", qty: 10, rate: 1 }] })).d.id);
    const recs = await Promise.all(pos.map((id) => call("POST", "/purchase-orders/" + id + "/receive", O, { wh: "WH-PNY", lines: [{ i: 0, qty: 10 }] })));
    const grnIds = recs.filter((r) => r.status === 200).map((r) => r.d.grn.id);
    ok("six receipts on six orders at the same moment all go through with six GRN numbers",
      grnIds.length === 6 && new Set(grnIds).size === 6, J(recs.map((r) => r.status + (r.status === 200 ? ":" + r.d.grn.id : ":" + String(r.d.error || "").slice(0, 60)))));

    /* the fixes the code already claims — confirm them under load */
    const poX = (await call("POST", "/purchase-orders", O, { supplierId: sup0, lines: [{ itemId: "RM-AU-H3", qty: 100, rate: 1 }] })).d;
    const b0 = await stock("RM-AU-H3");
    await par(4, () => call("POST", "/purchase-orders/" + poX.id + "/receive", O, { wh: "WH-PNY", lines: [{ i: 0, qty: 100 }] }));
    ok("four simultaneous receipts of the same 100-unit order book 100, not 400", Math.abs((await stock("RM-AU-H3")) - b0 - 100) < 1e-6, (await stock("RM-AU-H3")) - b0);
    await call("POST", "/movements", A, { itemId: "FG-AU-H3", type: "GRN", qty: 50, wh: "WH-FG", manual: true });
    const soX = (await call("POST", "/sales-orders", O, { customerId: cust0, lines: [{ itemId: "FG-AU-H3", qty: 10, rate: 1 }] })).d;
    const f0 = await stock("FG-AU-H3");
    await par(4, () => call("POST", "/sales-orders/" + soX.id + "/dispatch", O, {}));
    ok("four simultaneous dispatches of one order ship it once", Math.abs(f0 - (await stock("FG-AU-H3")) - 10) < 1e-6, f0 - (await stock("FG-AU-H3")));
  }

  /* ============================================================ */
  section("I. Items, recipes and the references to them");
  {
    const noCat = await call("POST", "/items", A, { id: "RM-AU-NOCAT", name: "No category" });
    ok("an item without a category is refused (400)", noCat.status === 400, noCat.status + " — stored with cat " + J(noCat.d && noCat.d.cat));
    const patchNew = await call("PATCH", "/items/RM-AU-NEVER", A, { name: "Created by a PATCH" });
    ok("PATCH of an item that does not exist is 404, not a silent create", patchNew.status === 404, patchNew.status + " " + J(patchNew.d).slice(0, 80));
    const negCost = await call("POST", "/items", A, { id: "RM-AU-NEG", name: "Negative cost", cat: "RM", cost: -5, price: -1 });
    ok("a negative cost or price is refused", negCost.status === 400, negCost.status + " cost " + (negCost.d && negCost.d.cost));

    await call("POST", "/items", A, { id: "FG-AU-I1", name: "Audit deletable tape", cat: "FG", uom: "KG", cost: 1 });
    const q = await call("POST", "/quotations", O, { customerId: cust0, itemId: "FG-AU-I1", price: 10 });
    const del = await call("DELETE", "/items/FG-AU-I1", O);
    const st = await state();
    const orphanLp = (st.labProducts || []).filter((p) => p.itemId === "FG-AU-I1");
    const orphanQ = (st.quotations || []).filter((x) => x.itemId === "FG-AU-I1");
    ok("an item on a live quotation cannot be deleted", del.status === 400,
      del.status + " — " + orphanQ.length + " quotation(s) now quote a product that no longer exists");
    ok("deleting an item does not strand its lab product", orphanLp.length === 0 || del.status >= 400,
      orphanLp.length + " lab product(s) still point at the deleted item: " + J(orphanLp.map((p) => p.id)));
    if (q.d && q.d.id) await call("DELETE", "/quotations/" + q.d.id, O);

    const cyc1 = await call("PUT", "/boms/FG-AU-A3", A, { yield: 1, lines: [["FG-AU-B1", 1]] });
    const cyc2 = await call("PUT", "/boms/FG-AU-B1", A, { yield: 1, lines: [["FG-AU-A3", 1]] });
    ok("a recipe loop (A made of B, B made of A) is refused", cyc1.status >= 400 || cyc2.status >= 400,
      "both saved (" + cyc1.status + ", " + cyc2.status + ")");
    const self = await call("PUT", "/boms/FG-AU-A3", A, { yield: 1, lines: [["FG-AU-A3", 1]] });
    ok("a product in its own recipe is refused through the plain BOM route too", self.status === 400, self.status);
    await call("PUT", "/boms/FG-AU-A3", A, { yield: 1, lines: [["RM-AU-A3", 1]] });
    await call("PUT", "/boms/FG-AU-B1", A, { yield: 1, lines: [["RM-AU-B1", 1]] });
  }

  /* ============================================================ */
  section("J. HR — leave, the muster and the pay it drives");
  {
    const w = (await call("POST", "/hr/workers", O, { name: "Audit Leave Worker", monthlyCtc: 26000, joined: "2024-01-01" })).d;
    const types = (await state()).hrLeaveTypes || [];
    const paid = (types.find((t) => t.paid !== false) || types[0] || {}).id;
    const lv = (await call("POST", "/hr/leaves", O, { workerId: w.id, type: paid, fromDate: "2026-07-06", toDate: "2026-07-07" })).d;
    await call("POST", "/hr/leaves/" + lv.id + "/decide", O, { status: "Approved" });
    const musterOf = async () => ((await state()).hrAttendance || []).filter((a) => a.workerId === w.id && a.date >= "2026-07-06" && a.date <= "2026-07-07");
    ok("approving a leave writes it on the muster", (await musterOf()).filter((a) => a.status === "L").length === 2, J(await musterOf()));
    await call("POST", "/hr/leaves/" + lv.id + "/decide", O, { status: "Rejected" });
    const m2 = await musterOf();
    ok("rejecting it afterwards takes it off the muster again", m2.filter((a) => a.status === "L").length === 0,
      "the muster still reads " + J(m2.map((a) => a.date + ":" + a.status)) + " — payroll will pay the rejected leave");
    const lv2 = (await call("POST", "/hr/leaves", O, { workerId: w.id, type: paid, fromDate: "2026-07-08", toDate: "2026-07-08" })).d;
    await call("POST", "/hr/leaves/" + lv2.id + "/decide", O, { status: "Approved" });
    await call("DELETE", "/hr/leaves/" + lv2.id, O);
    const m3 = ((await state()).hrAttendance || []).filter((a) => a.workerId === w.id && a.date === "2026-07-08");
    ok("deleting an approved leave takes its day off the muster", !m3.some((a) => a.status === "L"), "still " + J(m3));
    const direct = (await call("POST", "/hr/leaves", O, { workerId: w.id, type: paid, fromDate: "2026-07-09", toDate: "2026-07-09", status: "Approved" })).d;
    const m4 = ((await state()).hrAttendance || []).filter((a) => a.workerId === w.id && a.date === "2026-07-09");
    ok("a leave filed as already Approved is on the muster too (or the status is refused)", direct.status !== "Approved" || m4.some((a) => a.status === "L"),
      "leave " + direct.id + " reads Approved but the muster has " + J(m4));
    const o1 = await call("POST", "/hr/leaves", O, { workerId: w.id, type: paid, fromDate: "2026-07-13", toDate: "2026-07-15" });
    const o2 = await call("POST", "/hr/leaves", O, { workerId: w.id, type: paid, fromDate: "2026-07-14", toDate: "2026-07-16" });
    ok("a leave overlapping one already filed for the same worker is refused", o2.status >= 400,
      o1.status + "/" + o2.status + " — two leaves cover 14–15 July");
    const bad = await call("POST", "/hr/attendance", O, { workerId: w.id, date: "2026-02-30", status: "ZZ", hours: -5 });
    ok("attendance for 30 February, status 'ZZ', −5 hours is refused", bad.status === 400, bad.status + " " + J(bad.d).slice(0, 120));

    /* a full month on a round salary pays the round salary */
    const w2 = (await call("POST", "/hr/workers", O, { name: "Audit Full Month", monthlyCtc: 15000, joined: "2024-01-01" })).d;
    for (let d = 1; d <= 31; d++) {
      const iso = "2026-08-" + String(d).padStart(2, "0");
      if (new Date(iso + "T12:00:00").getDay() === 0) continue;
      await call("POST", "/hr/attendance", O, { workerId: w2.id, date: iso, status: "P", hours: 8 });
    }
    const run = await call("POST", "/hr/payroll/run", O, { period: "2026-08", workerIds: [w2.id] });
    const slip = (run.d.payslips || []).find((s) => s.workerId === w2.id) || {};
    ok("a full month on ₹15,000 earns a basic of exactly ₹15,000", slip.basicEarned === 15000,
      "basic " + slip.basicEarned + " (" + slip.monthPerDay + "/day × " + slip.payableDays + " days)");
    ok("…PF is 12% of it (₹1,800), PT ₹0 below ₹25,000", slip.deductions && slip.deductions.pf === 1800 && slip.deductions.pt === 0, J(slip.deductions));
    ok("…ESI is 0.75% of gross (gross ≤ ₹21,000)", slip.deductions && Math.abs(slip.deductions.esi - Math.round(0.0075 * slip.gross * 100) / 100) < 0.011, J({ gross: slip.gross, esi: slip.deductions && slip.deductions.esi }));
    note("full-month payslip", J({ gross: slip.gross, net: slip.net, bonus: slip.attendanceBonus, room: slip.roomAllowance }));
    await call("POST", "/hr/payroll/PR-2026-08/finalize", O);
    const late = await call("POST", "/hr/attendance", O, { workerId: w2.id, date: "2026-08-03", status: "A" });
    ok("the muster of a FINALISED pay month cannot be edited behind it", late.status >= 400,
      late.status + " — August is paid and sealed, yet its attendance changed");
    const delW = await call("DELETE", "/hr/workers/" + w2.id, O);
    const slips = ((await state()).hrPayslips || []).filter((s) => s.workerId === w2.id);
    ok("a worker with a finalised payslip cannot be deleted", delW.status >= 400,
      delW.status + " — " + slips.length + " finalised payslip(s) now belong to nobody");
  }

  /* ============================================================ */
  section("K. What the lab incharge's login receives");
  {
    const ls = (await call("GET", "/state", L)).d;
    const money = (rows) => [...new Set((rows || []).flatMap((r) => Object.keys(r || {}).filter((k) => /^(cost|price|rate|value|amount)$/i.test(k) && +r[k])))];
    const it = money(ls.items), mv = money(ls.movements), so = money(ls.salesorders), po = money(ls.purchaseorders);
    note("money fields in the lab's /api/state", J({ items: it, movements: mv, salesorders: so, purchaseorders: po }));
    ok("the lab login is not sent item costs and selling prices (its store pages use the money-free feed)", it.length === 0,
      "items carry " + J(it) + "; movements carry " + J(mv) + "; sales orders carry " + J(so));
    note("the lab also receives org.companies[].bank (blank today, filled once A6 is supplied)",
      J(((ls.org || {}).companies || []).map((c) => Object.keys(c.bank || {}))));
    ok("…and never HR or payroll", !("hrWorkers" in ls) && !("hrPayslips" in ls) && !("leads" in ls), Object.keys(ls).join(","));
  }

  /* ============================================================ */
  section("L. Goods-receipt numbering across the financial year");
  {
    const mkPo = async () => (await call("POST", "/purchase-orders", O, { supplierId: sup0, lines: [{ itemId: "RM-AU-H3", qty: 2, rate: 1 }] })).d.id;
    const a = await call("POST", "/purchase-orders/" + (await mkPo()) + "/receive", O, { wh: "WH-PNY", date: "2027-03-31", lines: [{ i: 0, qty: 2 }] });
    const b = await call("POST", "/purchase-orders/" + (await mkPo()) + "/receive", O, { wh: "WH-PNY", date: "2027-04-01", lines: [{ i: 0, qty: 2 }] });
    ok("31 March 2027 is FY 26-27, 1 April 2027 starts GRN/27-28/0001",
      /^GRN\/26-27\//.test(a.d.grn.id) && b.d.grn.id === "GRN/27-28/0001", a.d.grn.id + " · " + b.d.grn.id);
    const c = await call("POST", "/purchase-orders/" + (await mkPo()) + "/receive", O, { wh: "WH-PNY", date: "31/03/2027", lines: [{ i: 0, qty: 2 }] });
    ok("a receipt date that is not YYYY-MM-DD is refused", c.status === 400, c.status + " → " + J(c.d.grn && c.d.grn.id));
  }

  /* ============================================================ */
  section("M. The TDS booklet upload");
  {
    const pdf = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n").toString("base64");
    const up = await call("PUT", "/tds", A, { name: "audit.pdf", data: pdf });
    ok("admin uploads a PDF (200)", up.status === 200, up.status + " " + J(up.d).slice(0, 120));
    const f = await fetch(H.base + "/api/tds/file", { headers: { Authorization: "Bearer " + S1 } });
    ok("every login reads it back as a PDF", f.status === 200 && /pdf/.test(f.headers.get("content-type") || ""), f.status + " " + f.headers.get("content-type"));
    ok("a file that only claims to be a PDF is refused", (await call("PUT", "/tds", A, { name: "x.pdf", data: Buffer.from("MZ not a pdf").toString("base64") })).status === 400);
    const trav = await call("PUT", "/tds", A, { name: "../../evil.pdf", data: pdf });
    const fs = require("fs"), path = require("path");
    const escaped = fs.existsSync(path.join(process.env.CHHAPERIA_DATA_DIR, "..", "evil.pdf"))
      || fs.existsSync(path.join(process.env.CHHAPERIA_DATA_DIR, "evil.pdf"));
    ok("a path in the file name cannot write outside the TDS folder", !escaped && (trav.status === 400 || trav.status === 200),
      trav.status + " " + J(trav.d).slice(0, 120));
    ok("an office login cannot replace it (403)", (await call("PUT", "/tds", O, { name: "a.pdf", data: pdf })).status === 403);
    ok("admin can go back to the bundled booklet", (await call("DELETE", "/tds", A)).status === 200);
  }

  /* ============================================================ */
  section("O. A recipe typed 'per kg' is drawn per kg");
  {
    /* The New Item form labels every recipe quantity "Qty per kg" (and the
       join-a-recipe box "Quantity per kg of product"). The server reads a
       recipe as PER BATCH (1000 m²) whenever the finished good carries a GSM
       (bomcalc.toLegacy / metaFromItem), and per kg otherwise. */
    const drawOf = (r, id) => ((r.d.consumed || []).find((c) => c.id === id) || {}).qty;
    await rm("RM-AU-O1", { "WH-PNY": 100000 });
    await rm("RM-AU-O2", { "WH-PNY": 100000 });
    const mkNew = (id, gsm) => call("POST", "/catalogue/new-item", O, {
      item: Object.assign({ id, name: id + " tape", cat: "FG", uom: "KG", cost: 50, price: 100 }, gsm ? { gsm } : {}),
      tests: { params: ["thickness"], spec: { thickness: { min: 0, max: 10 } } },
      bom: { mode: "create", yield: 100, lines: [{ id: "RM-AU-O1", qty: 1, unit: "KG" }] } });
    const n1 = await mkNew("FG-AU-O1", null);
    ok("a product with no GSM is created with its recipe", n1.status === 201, n1.status + " " + J(n1.d).slice(0, 100));
    const b1 = await call("POST", "/production/finished", A, Object.assign({ itemId: "FG-AU-O1", qty: 10, wh: "WH-FG" }, LOT("LOT-O1")));
    ok("…10 kg of it draws 10 kg of a 1-per-kg material", Math.abs(drawOf(b1, "RM-AU-O1") - 10) < 1e-6, J(b1.d.consumed || b1.d));
    const n2 = await mkNew("FG-AU-O2", 150);
    const b2 = await call("POST", "/production/finished", A, Object.assign({ itemId: "FG-AU-O2", qty: 10, wh: "WH-FG" }, LOT("LOT-O2")));
    ok("the same recipe typed 'per kg' on a product that has a GSM (150) also draws 10 kg for 10 kg",
      Math.abs(drawOf(b2, "RM-AU-O1") - 10) < 1e-6, n2.status + " — it drew " + drawOf(b2, "RM-AU-O1") + " kg (read as per 1000 m² batch = 150 kg of product)");
    /* the Add to Finished Stock form carries a GSM box that is written onto the item */
    const b3 = await call("POST", "/production/finished", A, Object.assign({ itemId: "FG-AU-O1", qty: 10, wh: "WH-FG", gsm: 150 }, LOT("LOT-O1")));
    const b4 = await call("POST", "/production/finished", A, Object.assign({ itemId: "FG-AU-O1", qty: 10, wh: "WH-FG" }, LOT("LOT-O1")));
    ok("typing a GSM on the Add to Finished Stock form does not change how much the NEXT booking draws",
      Math.abs(drawOf(b4, "RM-AU-O1") - drawOf(b3, "RM-AU-O1")) < 1e-6,
      "before " + drawOf(b3, "RM-AU-O1") + " kg, after " + drawOf(b4, "RM-AU-O1") + " kg for the same 10 kg");
    /* a material joining that product's recipe 'per kg of product' */
    const j = await call("POST", "/catalogue/new-item", O, { item: { id: "RM-AU-O3", name: "Audit additive", cat: "RM", uom: "KG", cost: 5 },
      bom: { mode: "append", productId: "FG-AU-O2", qty: 0.5, unit: "KG" } });
    await call("POST", "/movements", A, { itemId: "RM-AU-O3", type: "GRN", qty: 1000, wh: "WH-PNY", manual: true });
    const b5 = await call("POST", "/production/finished", A, Object.assign({ itemId: "FG-AU-O2", qty: 10, wh: "WH-FG" }, LOT("LOT-O2")));
    ok("a material joining a recipe at '0.5 per kg of product' draws 5 kg for 10 kg",
      Math.abs(drawOf(b5, "RM-AU-O3") - 5) < 1e-6, j.status + " — it drew " + drawOf(b5, "RM-AU-O3") + " kg");
  }

  /* ============================================================ */
  section("M2. How wide is the double-save window?");
  {
    /* The same create sent twice, the second after a delay — a double-click,
       or two clerks. Whatever lands inside the window takes the same number. */
    const t0 = Date.now(); await call("GET", "/state", A); const readMs = Date.now() - t0;
    note("one full-state read on this database takes", readMs + " ms (the live data is about the same size)");
    const rows = [];
    for (const gap of [0, 20, 50, 100, 200, 400]) {
      const p1 = call("POST", "/purchase-orders", O, { supplierId: sup0, lines: [{ itemId: "RM-AU-H3", qty: 1, rate: 1 }] });
      await new Promise((r) => setTimeout(r, gap));
      const p2 = call("POST", "/purchase-orders", O, { supplierId: sup0, lines: [{ itemId: "RM-AU-H3", qty: 2, rate: 1 }] });
      const [a, b] = await Promise.all([p1, p2]);
      rows.push(gap + " ms → " + (a.d.id === b.d.id ? "SAME number " + a.d.id + " (one order lost)" : a.d.id + " / " + b.d.id));
    }
    note("two purchase orders saved N ms apart", rows.join(" · "));
    const woRows = [];
    for (const gap of [0, 20, 50, 100, 200]) {
      const p1 = call("POST", "/production/wo", O, { itemId: "FG-AU-H3", qty: 1 });
      await new Promise((r) => setTimeout(r, gap));
      const p2 = call("POST", "/production/wo", O, { itemId: "FG-AU-H3", qty: 1 });
      const [a, b] = await Promise.all([p1, p2]);
      woRows.push(gap + " ms → " + (a.d.id === b.d.id ? "SAME number " + a.d.id : a.d.id + " / " + b.d.id));
    }
    note("two work orders raised N ms apart", woRows.join(" · "));
    ok("two saves 20–50 ms apart never share a number", rows.concat(woRows).filter((r) => /^(20|50) ms/.test(r)).every((r) => !/SAME/.test(r)),
      rows.concat(woRows).filter((r) => /^(20|50) ms/.test(r)).join(" · "));
  }

  /* ============================================================ */
  section("M3. A label designed on one screen, saved over from another");
  {
    const s0 = ((await call("GET", "/state", A)).d.settings || {}).labelDocs || [];
    const doc = (id, name) => ({ id, name, w: 50, h: 30, objects: [{ id: "o_" + id.slice(2), type: "text", x: 1, y: 1, w: 20, h: 5, text: name }] });
    /* both screens opened the studio when the library held s0 */
    const a = await call("PATCH", "/settings", A, { labelDocs: s0.concat([doc("d_audita", "Made on the office PC")]) });
    const b = await call("PATCH", "/settings", O, { labelDocs: s0.concat([doc("d_auditb", "Made on the store PC")]) });
    const names = (((await call("GET", "/state", A)).d.settings || {}).labelDocs || []).map((d) => d.name);
    ok("a label saved from one screen survives a save from another screen opened before it",
      names.indexOf("Made on the office PC") >= 0 && names.indexOf("Made on the store PC") >= 0,
      "saves " + a.status + "/" + b.status + " — the library now holds " + J(names.slice(-3)));
  }

  /* ============================================================ */
  section("M4. Excess material — the floor's own checks");
  {
    await rm("RM-AU-X1", { "WH-PNY": 50 });
    await fg("FG-AU-X1", [["RM-AU-X1", 1]]);
    const wo = (await call("POST", "/production/wo", O, { itemId: "FG-AU-X1", qty: 10 })).d;
    const area = (wo.route || [])[0] && wo.route[0].area;
    const wrong = area === "slitting" ? C : S1;
    const right = area === "slitting" ? S1 : C;
    ok("a supervisor from another floor cannot book excess against the job (403)",
      (await call("POST", "/production/excess-material", wrong, { woId: wo.id, lines: [{ itemId: "RM-AU-X1", qty: 1, location: "WH-PNY", reason: "x" }] })).status === 403);
    const over = await call("POST", "/production/excess-material", right, { woId: wo.id, lines: [{ itemId: "RM-AU-X1", qty: 1000, location: "WH-PNY", reason: "spill" }] });
    ok("…nor draw more than the store holds (400)", over.status === 400, over.status + " " + J(over.d).slice(0, 100));
    const two = await call("POST", "/production/excess-material", right, { woId: wo.id, lines: [
      { itemId: "RM-AU-X1", qty: 25, location: "WH-PNY", reason: "a" }, { itemId: "RM-AU-X1", qty: 25, location: "WH-PNY", reason: "b" }] });
    ok("two lines against the same store cannot together over-draw it", two.status === 400, two.status + " — store now " + (await stock("RM-AU-X1", "WH-PNY")));
    const okx = await call("POST", "/production/excess-material", right, { woId: wo.id, lines: [{ itemId: "RM-AU-X1", qty: 5, location: "WH-PNY", reason: "trim loss" }] });
    ok("a justified excess within stock is booked (201)", okx.status === 201, okx.status + " " + J(okx.d).slice(0, 100));
  }

  /* ============================================================ */
  section("N1. An Excel import saves the browser's whole copy of the data");
  {
    /* what the import does: DB.save(ENG.data) → PUT /state with everything the
       browser loaded. Meanwhile the floor keeps working. */
    const browserCopy = await state();
    await call("POST", "/movements", A, { itemId: "RM-AU-X1", type: "GRN", qty: 7, wh: "WH-PNY", note: "delivered while the import dialog was open" });
    const woFloor = (await call("POST", "/production/wo", O, { itemId: "FG-AU-X1", qty: 1 })).d;
    const put = await call("PUT", "/state", O, browserCopy);
    const after = await state();
    const mvKept = (after.movements || []).some((m) => m.note === "delivered while the import dialog was open");
    const woKept = (after.workorders || []).some((w) => w.id === woFloor.id);
    ok("a movement posted while an import was being reviewed survives the import's save", mvKept,
      "PUT " + put.status + " — the receipt of 7 kg is gone from the ledger");
    ok("…and so does a work order raised meanwhile", woKept, woFloor.id + " is gone (its material issue went with it)");
  }

  /* ============================================================ */
  section("N. The whole-dataset write (PUT /api/state) — last, it rewrites the database");
  {
    const before = await state();
    const counts = (s) => ({ customers: (s.customers || []).length, suppliers: (s.suppliers || []).length,
      purchaseorders: (s.purchaseorders || []).length, salesorders: (s.salesorders || []).length,
      workorders: (s.workorders || []).length, grns: (s.grns || []).length, labReports: (s.labReports || []).length,
      hrWorkers: (s.hrWorkers || []).length, hrPayslips: (s.hrPayslips || []).length, leads: (s.leads || []).length });
    /* the minimum a bulk save needs to satisfy the foreign keys (items →
       categories, movements → warehouses) — everything else simply left out,
       the way a partial Excel sheet or a stale browser tab would leave it out */
    const r = await call("PUT", "/state", O, { items: before.items, movements: before.movements,
      categories: before.categories, warehouses: before.warehouses });
    const after = await state();
    const lost = Object.entries(counts(before)).filter(([k, n]) => counts(after)[k] < n).map(([k, n]) => k + " " + n + "→" + counts(after)[k]);
    ok("an office PUT /state that leaves out customers, suppliers and orders does not erase them",
      lost.length === 0, "PUT answered " + r.status + " and erased: " + lost.join(", "));
  }
}

run().then(() => H.finish(), (e) => H.finish(e));
