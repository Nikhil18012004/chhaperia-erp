/* ============================================================
   CHHAPERIA ERP — smoke tests (no framework, no build step)
   Runs the DB + service layer against a THROWAWAY SQLite file
   so it never touches data/chhaperia.db. Exits non-zero on any
   failure so it can gate a commit / CI.

     node backend/test/smoke.js      (or: npm test)
   ============================================================ */
"use strict";
const path = require("path");
const fs = require("fs");

/* A scratch DATABASE on the configured MySQL server and a scratch DIRECTORY
   inside the project, both named for this run and both removed at the end —
   the same isolation the throwaway .db file used to give, one level up. The
   files no longer go to the shared system temp folder: everything this
   project writes stays under the project. Set BEFORE the connection module
   loads. */
const scratch = require("./scratch");
const RUN = scratch.claim("smoke");

const repo = require("../src/db/repository");
const erp = require("../src/services/erpService");
const { closeDb } = require("../src/db/connection");
const { buildSeed } = require("../src/seed/seed");

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra ? "  — " + extra : "")); }
}
function section(t) { console.log("\n" + t); }
function throws(fn) { try { fn(); return false; } catch { return true; } }
/* The service calls are async now: a rejection is not a throw to try/catch,
   so the old helper would wave every failing call straight through. */
async function throwsAsync(fn) { try { await fn(); return false; } catch { return true; } }

async function main() {
try {
  section("Seed integrity (pure generator)");
  const seed = buildSeed();
  ok("buildSeed returns items[]", Array.isArray(seed.items) && seed.items.length > 0, "items=" + (seed.items || []).length);
  ok("buildSeed returns movements[]", Array.isArray(seed.movements) && seed.movements.length > 0);
  const ids = new Set(seed.items.map((i) => i.id));
  ok("every movement references a real item", seed.movements.every((m) => ids.has(m.itemId)));

  section("State load (auto-seeds on empty)");
  const state = await erp.getState();
  ok("getState seeds & returns items", Array.isArray(state.items) && state.items.length > 0, "items=" + state.items.length);
  ok("getState returns purchaseorders", Array.isArray(state.purchaseorders));

  section("Granular: upsertItem");
  const created = await erp.upsertItem({ id: "RM-SMOKE", name: "Smoke Test Foil", cat: "RM", uom: "KG", cost: 42, reorder: 5, thickness: 0.05 });
  ok("item created with promoted cost", created && created.cost === 42);
  ok("item keeps extra doc field (thickness)", created && created.thickness === 0.05);
  const updated = await erp.upsertItem({ id: "RM-SMOKE", name: "Smoke Test Foil v2", cat: "RM", uom: "KG", cost: 50 });
  ok("item update overwrites cost", (await repo.getItem("RM-SMOKE")).cost === 50);
  ok("item update rename applied", (await repo.getItem("RM-SMOKE")).name === "Smoke Test Foil v2");
  ok("upsertItem rejects missing id", await throwsAsync(async () => await erp.upsertItem({ name: "no id" })));

  section("Granular: addMovement");
  const before = (await repo.getState()).movements.length;
  const mv = await erp.addMovement({ itemId: "RM-SMOKE", wh: "WH-PNY", type: "GRN", qty: 100, rate: 50, note: "smoke" });
  ok("addMovement returns an id", mv && mv.ok && !!mv.id);
  ok("movement count increased by 1", (await repo.getState()).movements.length === before + 1);
  ok("addMovement rejects no itemId", await throwsAsync(async () => await erp.addMovement({ type: "GRN", qty: 1 })));
  ok("addMovement rejects non-numeric qty", await throwsAsync(async () => await erp.addMovement({ itemId: "RM-SMOKE", type: "GRN", qty: "abc" })));

  section("Granular: receivePurchaseOrder");
  const openPO = (await repo.getState()).purchaseorders.find((p) => p.status !== "Received" && (p.lines || []).length);
  if (!openPO) { ok("an open PO exists to receive", false, "none found in seed"); }
  else {
    const line0 = openPO.lines[0];
    const want = Math.max(1, Math.round((line0.qty - (line0.recd || 0)) / 2));
    const r = await erp.receivePurchaseOrder(openPO.id, { wh: "WH-PNY", lines: [{ i: 0, qty: want }] });
    ok("receive posts >=1 movement", r && r.posted >= 1);
    const after = await repo.getPurchaseOrder(openPO.id);
    ok("PO line recd advanced", (after.lines[0].recd || 0) >= want - 0.01);
    ok("PO status is Partially/Received", ["Partially Received", "Received"].includes(after.status), after.status);
    ok("receive unknown PO 404s", await throwsAsync(async () => await erp.receivePurchaseOrder("PO-NOPE", { lines: [{ i: 0, qty: 1 }] })));
  }

  section("Reset");
  const reseed = await erp.reset();
  ok("reset returns a fresh dataset", Array.isArray(reseed.items) && reseed.items.length > 0);
  ok("reset dropped the smoke item", !await repo.getItem("RM-SMOKE"));

  /* ============================================================
     BOM production maths (frontend/js/bomcalc.js — shared with the UI).
     Worked by hand from the real sheet row for CHDSW-25, so these
     numbers are the specification, not a snapshot of the code.
       fabric   : 2 x NON-WOVEN @ 20 g/m²  -> 40 g/m²
       FG       : 100 g/m²                 -> pickup GSM 60
       pickup   : carbon 60x50 + SAP 40x100 + bondex 7x80 + carbon 6x50
                = 30 + 40 + 5.6 + 3        -> 78.6 kg
       total    : 78.6 x 1000 / 60         -> 1310 sqm
     ============================================================ */
  section("BOM production maths");
  const BC = require("../../frontend/js/bomcalc");
  const L = [
    { rm: "NON-WOVEN FABRIC", rmGsm: "20", qty: 1000, unit: "MTR" },
    { rm: "CARBON PASTE", qty: 60, unit: "KG" },
    { rm: "SAP", qty: 40, unit: "KG" },
    { rm: "WATER RO", qty: 100, unit: "KG" },
    { rm: "BONDEX", qty: 7, unit: "KG" },
    { rm: "BPO", qty: 40, unit: "GRAM" },
    { rm: "NON-WOVEN FABRIC", rmType: "COMPRESSED/THERMAL BONDING", rmGsm: "20", qty: 1000, unit: "MTR" },
    { rm: "CARBON PASTE", qty: 6, unit: "KG" },
  ].map((l) => Object.assign({}, l, { pickupPct: BC.defaultPickup(l.rm) }));
  const calc = BC.compute({ lines: L }, { fgGsm: 100 });

  ok("pickup % defaults applied (carbon 50 / SAP 100 / bondex 80 / solvent 0)",
    BC.defaultPickup("CARBON PASTE") === 50 && BC.defaultPickup("SAP") === 100 &&
    BC.defaultPickup("BONDEX") === 80 && BC.defaultPickup("WATER RO") === 0);
  ok("layer count derived from GSM-bearing fabric lines (2)", calc.fabricCount === 2 && calc.layers === 2);
  ok("fabric GSM sums both layers (40)", calc.fabricGsm === 40);
  ok("pickup GSM = FG − fabric (60)", calc.pickupGsm === 60);
  ok("FG kg per 1000 sqm batch (100)", calc.fgKgPerBatch === 100);
  ok("total pickup qty (78.6 kg)", Math.abs(calc.totalPickupQty - 78.6) < 1e-9, String(calc.totalPickupQty));
  ok("TOTAL PRODUCTION = 1310 sqm", Math.round(calc.totalProductionSqm) === 1310, String(calc.totalProductionSqm));
  ok("consumption/kg = qty / fgKgPerBatch", Math.abs(calc.lines[1].consumptionPerKg - 0.6) < 1e-9);
  ok("consumption/sqm = qty / batch sqm", Math.abs(calc.lines[1].consumptionPerSqm - 0.06) < 1e-9);
  ok("fabric excluded from pickup mass (substrate, not pickup)", calc.lines[0].pickupQty == null);
  ok("ranged line detected from a '/' choice", calc.rangedLines === 1 && calc.lines[6].ranged === true);

  // both line shapes must survive the same reader
  ok("legacy tuples still normalise", BC.normalize([["RM-X", 2]])[0].id === "RM-X");
  // 60 kg of carbon in a batch that yields 100 kg of FG = 0.6 per kg
  const legacy = BC.toLegacy({ lines: [{ id: "RM-CARBON", rm: "CARBON PASTE", qty: 60, unit: "KG" }] }, { fgGsm: 100 });
  ok("batch qty converts to per-unit of FG for legacy consumers (0.6)",
    legacy.length === 1 && legacy[0][0] === "RM-CARBON" && Math.abs(legacy[0][1] - 0.6) < 1e-9,
    JSON.stringify(legacy));
  // a ranged line resolves to the operator's pick
  const resolved = BC.resolve({ lines: L }, { 6: "RM-PICKED" });
  ok("operator's material choice resolves the ranged line",
    resolved[6].id === "RM-PICKED" && resolved[6].ranged === false);
  // Excel's scientific notation must not be read as a whole number
  ok("scientific notation parses (3.3E-2 = 0.033 mm, not 3.3)",
    Math.abs(BC.numLoose("3.3000000000000002E-2") - 0.033) < 1e-9);

  section("Sliding session — working through the day never signs you out");
  {
    const auth = require("../src/services/authService");
    const user = { id: "U-SLIDE", role: "admin", area: null, tokenVersion: 0 };
    const realNow = Date.now;
    /* mint a token as if the clock were `msAgo` in the past, so a token's age
       can be tested without waiting six hours for one to ripen */
    const tokenAged = (msAgo) => {
      Date.now = () => realNow() - msAgo;
      try { return auth.issueToken(user); } finally { Date.now = realNow; }
    };
    const HOUR = 60 * 60 * 1000;

    ok("a fresh token is left alone (no needless re-signing)",
      auth.renewedToken(auth.issueToken(user), user) === null);
    ok("a token 5h old is still left alone", auth.renewedToken(tokenAged(5 * HOUR), user) === null);

    const old = tokenAged(7 * HOUR);
    const renewed = auth.renewedToken(old, user);
    ok("a token past halfway IS reissued", typeof renewed === "string" && renewed !== old);
    ok("the reissued token verifies", !!auth.verifyToken(renewed));
    ok("and it runs later than the one it replaced",
      auth.verifyToken(renewed).exp > auth.verifyToken(old).exp);

    // the whole point of an expiry is that an abandoned machine lapses
    ok("an already-expired token is NEVER silently renewed",
      auth.renewedToken(tokenAged(13 * HOUR), user) === null);
    ok("nor is a forged one", auth.renewedToken("not.a.token", user) === null);
    ok("Date.now was restored", Date.now === realNow);
  }

  section("Earned leave accrues one day per MONTH worked");
  {
    const hr = require("../src/services/hrService");
    const year = String(new Date().getFullYear());
    const W = "W-EL-TEST";
    await repo.putWorker({ id: W, name: "Earned Leave Tester", dept: "coating", dailyRate: 500, active: true });
    // ensure an "earned" type exists to measure against
    await repo.putLeaveType({ id: "ELT", name: "Earned Leave (test)", quota: 12, accrual: "earned", paid: true });
    const entitledFor = async () => ((await hr.leaveBalances(W)).find((b) => b.type === "ELT") || {}).entitled;
    const present = async (date) => await repo.putAttendance({ workerId: W, date, status: "P" });

    ok("no attendance ⇒ 0 days earned", await entitledFor() === 0);

    // a single month, worked many times over, is still worth exactly one day
    for (const d of ["-01-05", "-01-06", "-01-07", "-01-08", "-01-09"]) await present(year + d);
    ok("five days inside ONE month earn 1 day (not 5, and not 0)", await entitledFor() === 1,
      "got " + await entitledFor());

    // a second month adds exactly one more, however few days are worked in it
    await present(year + "-02-11");
    ok("one day worked in a SECOND month earns the 2nd day", await entitledFor() === 2,
      "got " + await entitledFor());

    // half days still count the month; absences and leave do not create one
    await repo.putAttendance({ workerId: W, date: year + "-03-02", status: "HD" });
    ok("a half day still earns its month", await entitledFor() === 3, "got " + await entitledFor());
    await repo.putAttendance({ workerId: W, date: year + "-04-02", status: "A" });
    ok("an ABSENT month earns nothing", await entitledFor() === 3, "got " + await entitledFor());
    // ...but working any other day of that same month does earn it
    await present(year + "-04-20");
    ok("working later in that month still earns it", await entitledFor() === 4, "got " + await entitledFor());

    // twelve worked months = twelve days, which is the annual figure
    for (const m of ["-05", "-06", "-07", "-08", "-09", "-10", "-11", "-12"]) await present(year + m + "-15");
    ok("a full year of work earns 12 days", await entitledFor() === 12, "got " + await entitledFor());

    // last year's attendance must not leak into this year's balance
    await present(String(+year - 1) + "-06-10");
    ok("last year's work does not inflate this year", await entitledFor() === 12, "got " + await entitledFor());
  }

  /* ============================================================
     Filling in where a coated roll was left, for a stage that
     closed before the question was asked.

     A blank cannot be produced through the API any more — the gate
     on completing coating sees to that — so the job is built here
     in the shape the old flow left behind, which is exactly the
     shape sitting in the live database.
     ============================================================ */
  section("A coated roll's store can be filled in once, never rewritten");
  {
    const production = require("../src/services/productionService");
    const coating = { username: "coating1", role: "supervisor", area: "coating" };
    const st = await repo.getState();
    const fgAny = (st.items || []).find((i) => i.cat === "FG");
    const wo = {
      id: "WO-LEGACY-1", date: "2026-08-01", itemId: fgAny.id, qty: 10,
      status: "In Production", progress: 50, priority: "Normal", stageIdx: 1,
      route: [
        { key: "rmprod", name: "RM Production", area: "coating", seq: 1, status: "Completed", posted: true },
        { key: "slitting", name: "Slitting", area: "slitting", seq: 2, status: "Pending", posted: false },
      ],
    };
    await repo.putWorkOrder(wo);
    const movesBefore = ((await repo.getState()).movements || []).length;

    ok("a store is refused if it is not a real warehouse",
      await throwsAsync(async () => await production.setWipStore(coating, wo.id, { wh: "WH-NOWHERE" })));
    ok("and refused if none is named",
      await throwsAsync(async () => await production.setWipStore(coating, wo.id, {})));

    await production.setWipStore(coating, wo.id, { wh: "WH-WIP" });
    const filled = await repo.getWorkOrder(wo.id);
    ok("the blank is filled in on the stage that made the roll",
      filled.route[0].outWh === "WH-WIP" && filled.route[0].outWhBy === "coating1",
      filled.route[0].outWh + " by " + filled.route[0].outWhBy);
    ok("recording it books nothing into that store",
      ((await repo.getState()).movements || []).length === movesBefore,
      movesBefore + " → " + ((await repo.getState()).movements || []).length);
    ok("and it cannot be rewritten afterwards",
      await throwsAsync(async () => await production.setWipStore(coating, wo.id, { wh: "WH-QC" })));
    ok("the first answer still stands", (await repo.getWorkOrder(wo.id)).route[0].outWh === "WH-WIP");

    // a stage still on the machines has nothing to say yet — the gate on
    // completing coating is where that one is captured
    const open = Object.assign({}, wo, { id: "WO-LEGACY-2",
      route: [{ key: "rmprod", name: "RM Production", area: "coating", seq: 1, status: "In Production" },
        { key: "slitting", name: "Slitting", area: "slitting", seq: 2, status: "Pending" }] });
    await repo.putWorkOrder(open);
    ok("a coating stage that has not finished is not asked yet",
      await throwsAsync(async () => await production.setWipStore(coating, open.id, { wh: "WH-WIP" })));
  }

  section("Full-state save round-trips every collection (the Excel import path)");
  {
    /* Dispatch, Lab and HR import their sheets through a full-state save. A
       collection saveState forgets is dropped without a word — the import says
       "59 rows saved", the reload brings back none of them and the section
       looks empty. Round-trip one row of each and demand it survives. */
    const st = await repo.getState();
    st.transporters = (st.transporters || []).concat(
      [{ id: "TR-SMOKE", name: "Smoke Carrier", city: "Bengaluru", rating: "B", active: false }]);
    st.labProducts = (st.labProducts || []).concat([{ id: "LP-SMOKE", code: "SMOKE", name: "Smoke Lab Product" }]);
    st.labReports = (st.labReports || []).concat(
      [{ id: "LR-SMOKE", productId: "LP-SMOKE", refNo: "B-1", values: { tensile: 42 } }]);
    st.appointments = (st.appointments || []).concat([{ id: "AP-SMOKE", date: "2026-08-06", title: "Smoke meeting" }]);
    st.complaints = (st.complaints || []).concat([{ id: "CMP-SMOKE", customerId: "CUS-01", batch: "WO-0001",
      status: "Open", raised: "2026-08-06", claim: "Smoke claim" }]);
    st.quotations = (st.quotations || []).concat([{ id: "QTN-SMOKE", customerId: "CUS-01", leadId: "", itemId: "FG-CM25G", status: "Open",
      date: "2026-08-06", uom: "KG", qty: 500, price: 940, value: 470000, rounds: 1,
      history: [{ at: "2026-08-06T09:00:00.000Z", by: "office", kind: "quoted", price: 940, qty: 500 }] }]);
    st.hrWorkers = (st.hrWorkers || []).concat(
      [{ id: "EMP-SMOKE", name: "Smoke Worker", dept: "Coating", payType: "daily", dailyRate: 700, active: false }]);
    st.hrAttendance = (st.hrAttendance || []).concat(
      [{ id: "EMP-SMOKE:2026-08-06", workerId: "EMP-SMOKE", date: "2026-08-06", status: "P", hours: 8 }]);
    await erp.saveState(st);

    const back = await repo.getState();
    const tr = (back.transporters || []).find((t) => t.id === "TR-SMOKE");
    ok("an imported transporter survives a full-state save", !!tr);
    // the dispatch sheet is full of INACTIVE rows; false must come back as false
    ok("and its Inactive status comes back verbatim", !!tr && tr.active === false, tr && String(tr.active));
    ok("and its other columns come back", !!tr && tr.city === "Bengaluru" && tr.rating === "B");
    ok("an imported lab product survives", (back.labProducts || []).some((p) => p.id === "LP-SMOKE"));
    const lr = (back.labReports || []).find((r) => r.id === "LR-SMOKE");
    ok("an imported lab report survives with its measurements", !!lr && lr.values && lr.values.tensile === 42);
    ok("a calendar appointment survives", (back.appointments || []).some((a) => a.id === "AP-SMOKE"));
    const cmp = (back.complaints || []).find((c) => c.id === "CMP-SMOKE");
    ok("a complaint survives", !!cmp && cmp.batch === "WO-0001" && cmp.status === "Open" && cmp.claim === "Smoke claim");
    const qt = (back.quotations || []).find((q) => q.id === "QTN-SMOKE");
    ok("a quotation survives", !!qt && qt.itemId === "FG-CM25G" && qt.status === "Open" && qt.uom === "KG" && qt.price === 940
      && qt.value === 470000 && qt.history && qt.history[0].price === 940, JSON.stringify(qt));
    const wk = (back.hrWorkers || []).find((w) => w.id === "EMP-SMOKE");
    ok("an imported worker survives", !!wk && wk.dailyRate === 700);
    ok("an imported attendance row survives", (back.hrAttendance || []).some((a) => a.id === "EMP-SMOKE:2026-08-06"));

    // NEGATIVE 1: dropping a row from the payload must really delete it —
    // otherwise "save" is a merge and a deletion would silently come back.
    const pruned = await repo.getState();
    pruned.transporters = pruned.transporters.filter((t) => t.id !== "TR-SMOKE");
    await erp.saveState(pruned);
    ok("removing a transporter from the payload deletes it",
      !(await repo.getState()).transporters.some((t) => t.id === "TR-SMOKE"));

    // NEGATIVE 2: a payload that never mentions the collection must leave it
    // alone. buildSeed() carries no transporters/lab/HR keys, so an unguarded
    // wipe would make every reset and boot-time migration erase them.
    await repo.putTransporter({ id: "TR-KEEP", name: "Survives a seed-shaped save", active: true });
    const lean = await repo.getState();
    delete lean.transporters;
    delete lean.labProducts;
    delete lean.hrWorkers;
    await erp.saveState(lean);
    const afterLean = await repo.getState();
    ok("a payload with no transporters key leaves the table untouched",
      afterLean.transporters.some((t) => t.id === "TR-KEEP"), "n=" + afterLean.transporters.length);
    ok("same for lab products and workers",
      Array.isArray(afterLean.labProducts) && Array.isArray(afterLean.hrWorkers));
  }

  section("Every Import/Export section round-trips its own sheet");
  {
    /* Runs the REAL frontend import engine (csvio.js, loaded here with a window
       shim the same way erpService already borrows bomcalc.js) over a sheet in
       each section's own template format, then saves it the way the Import
       button does. Guards the whole promise: what the sheet says is what the
       section shows after a reload. Only the XLSX helpers in csvio.js need a
       browser, and rows-as-arrays is exactly what they would have produced. */
    global.window = global;
    require("../../frontend/js/csvio.js");

    const base = await repo.getState();
    const anItem = base.items.find((i) => i.cat === "RM") || base.items[0];
    const anFg = base.items.find((i) => i.cat === "FG") || base.items[0];
    const noBom = (base.items.find((i) => i.cat === "FG" && !base.boms[i.id]) || {}).id;
    const aWh = (base.warehouses[0] || {}).id || "WH-PNY";
    const aWorker = (base.hrWorkers || [])[0] || { id: "EMP-0001" };

    const OVERRIDE = {
      items: { id: "RM-RT", cat: "RM", uom: "KG" },
      movements: { id: "MV-RT", itemId: anItem.id, wh: aWh, type: "GRN", date: "2026-08-06" },
      workorders: { id: "WO-RT", itemId: anFg.id, date: "2026-08-06" },
      salesorders: { id: "SO-RT", customerId: base.customers[0].id, date: "2026-08-06",
        lines: JSON.stringify([{ itemId: anFg.id, qty: 5, rate: 100 }]) },
      purchaseorders: { id: "PO-RT", supplierId: base.suppliers[0].id, date: "2026-08-06",
        lines: JSON.stringify([{ itemId: anItem.id, qty: 5, rate: 100, recd: 0 }]) },
      customers: { id: "CUS-RT" }, suppliers: { id: "SUP-RT" },
      boms: { itemId: noBom || anFg.id, lines: JSON.stringify([{ itemId: anItem.id, qty: 2 }]) },
      leads: { id: "LD-RT", product: anFg.id },
      labreports: { id: "LR-RT", productId: ((base.labProducts || [])[0] || {}).id || "LP-001" },
      labproducts: { id: "LP-RT", code: "RT" },
      transporters: { id: "TR-RT" },
      hrworkers: { id: "EMP-RT", payType: "daily" },
      hrattendance: { id: aWorker.id + ":2026-08-06", workerId: aWorker.id, date: "2026-08-06", status: "P" },
    };
    const cellFor = (key, c) => {
      const o = OVERRIDE[key] || {};
      if (c.k in o) return String(o[c.k]);
      if (c.type === "num") return "7";
      if (c.type === "bool") return "ACTIVE";   // the word people actually type
      if (c.type === "list") return "Alpha|Beta";
      if (c.type === "json") return "";
      if (/date|since|joined|due|eta|promised|created|expectedClose|nextFollowUp/i.test(c.k)) return "2026-08-06";
      return "RT " + c.k;
    };
    const recordsOf = (state, ent) => (ent.kind === "map"
      ? Object.keys(state[ent.path] || {}).map((id) => Object.assign({ itemId: id }, state[ent.path][id]))
      : state[ent.path] || []);

    for (const key of Object.keys(CSVIO.ENTITIES)) {
      const ent = CSVIO.ENTITIES[key];
      global.ENG = { data: await repo.getState() };
      const header = ent.cols.map((c) => c.label);
      const row = ent.cols.map((c) => cellFor(key, c));

      ok(key + ": the template header is recognised", CSVIO.detect(header) === key, "got " + CSVIO.detect(header));

      let diff;
      try { diff = CSVIO.buildDiff(key, [header, row]); }
      catch (e) { ok(key + ": the sheet can be read", false, e.message); continue; }
      // an id that already exists is an update — both mean "the user gave us this row"
      const landed = diff.add.concat(diff.update);
      ok(key + ": the row is queued to write", landed.length === 1 && !diff.errors.length,
        "add=" + diff.add.length + " upd=" + diff.update.length + " err=" + JSON.stringify(diff.errors));
      if (!landed.length) continue;

      const id = landed[0].id;
      CSVIO.apply(diff);
      try { await erp.saveState(ENG.data); }
      catch (e) { ok(key + ": the save is accepted", false, e.message); continue; }

      const got = recordsOf(await repo.getState(), ent).find((r) => String(r[ent.idKey]) === String(id));
      ok(key + ": the row is still there after a reload", !!got, ent.idKey + "=" + id);
      if (!got) continue;

      /* Only the columns the section's own template ships (ent.form) are the
         user's to set. Everything else — a work order's status and progress,
         ABC class — is calculated by the app, so the server rewriting those is
         the design, not lost data. */
      const formKeys = new Set(ent.form || ent.cols.map((c) => c.k));
      const lost = [];
      ent.cols.forEach((c) => {
        if (c.k === ent.idKey || !formKeys.has(c.k)) return;
        const want = cellFor(key, c);
        const v = c.path ? c.path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), got) : got[c.k];
        if (c.type === "num") { if (Number(v) !== Number(want)) lost.push(c.k); return; }
        if (c.type === "bool") { if (v !== true) lost.push(c.k + "=" + v); return; }
        if (c.type === "list") { if (!Array.isArray(v) || v.join("|") !== want) lost.push(c.k); return; }
        if (c.type === "json") { if (want && v == null) lost.push(c.k); return; }
        if (String(v == null ? "" : v) !== want) lost.push(c.k + "=" + JSON.stringify(v));
      });
      ok(key + ": every column the user filled in came back verbatim", lost.length === 0, lost.join(", "));
    }
  }

  /* ---------- exchange rates: Google's printed figure, and only Google -------
     The dashboard is checked against a Google search by the office, so the
     parser must return the number Google DISPLAYS. It reads obfuscated class
     names off the quote page, so this pins the shape with a fixture — if
     Google restyles the page these fail here instead of on the dashboard.
     Offline by design: no network in the test suite. */
  section("Exchange rates (Google-only)");
  {
    const fx = require("../src/services/fxService");
    // trimmed from a real www.google.com/finance/quote/USD-INR response
    const FIXTURE =
      '<style>.N6SYTe{font-weight:500;font-size:24px}</style>' +
      '<div class="KycIzb"><div class="gO24Ff">United States Dollar / Indian Rupee</div>' +
      '<div class="N6SYTe"><span jsname="Pdsbrc" class=""><span>95.4283</span></span></div>' +
      '<div class="DAicsd"><div jsname="ohpORc"></div>' +
      '<span jsname="vY9t3b" class=""><span class="ougHge">+0.03%</span></span></div>' +
      '<div class="jZZ2de">Aug 11, 6:36:00 AM UTC</div></div>' +
      '<a href="./quote/EUR-INR"><span jsname="Pdsbrc"><span>110.0669</span></span></a>';

    const q = fx.parseQuote(FIXTURE);
    ok("a Google quote page can be parsed", !!q);
    ok("the rate is the figure Google DISPLAYS, not the history tail",
      q && q.rate === 95.4283, q && String(q.rate));
    ok("the printed digits are kept verbatim for display",
      q && q.shown === "95.4283", q && q.shown);
    ok("Google's own as-of line is captured",
      q && q.asOf === "Aug 11, 6:36:00 AM UTC", q && q.asOf);
    ok("today's move is captured for the arrow", q && q.change === "+0.03%", q && q.change);
    // the page also lists OTHER pairs (EUR/INR above); the headline must win
    ok("a related pair on the same page is not mistaken for the headline",
      q && q.rate !== 110.0669);

    ok("a page whose markup we no longer recognise yields nothing (never a guess)",
      fx.parseQuote("<html><body>no quote here</body></html>") === null);
    ok("a non-numeric price is rejected",
      fx.parseQuote('<div class="N6SYTe"><span><span>—</span></span></div>') === null);
    // thousands separators appear on weak-currency pairs (e.g. IDR-INR)
    const c = fx.parseQuote('<div class="N6SYTe"><span><span>1,234.56</span></span></div>');
    ok("a comma-grouped price parses to a number", c && c.rate === 1234.56, c && String(c.rate));

    ok("the dashboard's six currencies are the eagerly fetched set",
      ["USD", "EUR", "GBP", "AED", "CNY", "JPY"].every((x) => fx.BASE_CODES.includes(x)) &&
      fx.BASE_CODES.length === 6, fx.BASE_CODES.join(","));
  }

  /* ---------- a client's currency follows their country ----------------------
     The sales desk types a country on the customer master and the money that
     client is invoiced in follows from it (frontend/js/ccy.js, shared with the
     sales order and the dashboard converter). Pure lookups — no network. */
  section("Country → currency");
  {
    const CCY = require("../../frontend/js/ccy.js");

    ok("the country table covers the world, not a handful of markets",
      CCY.COUNTRIES.length > 180, CCY.COUNTRIES.length + " countries");
    ok("every country's currency is one we can name and print",
      CCY.COUNTRIES.filter((c) => !CCY.known(c.ccy)).length === 0,
      CCY.COUNTRIES.filter((c) => !CCY.known(c.ccy)).map((c) => c.name + "=" + c.ccy).join(", "));
    const dupes = [];
    const seenCc = {}, seenName = {};
    CCY.COUNTRIES.forEach((c) => {
      if (seenCc[c.cc]) dupes.push("cc " + c.cc);
      if (seenName[CCY.norm(c.name)]) dupes.push("name " + c.name);
      seenCc[c.cc] = seenName[CCY.norm(c.name)] = 1;
    });
    ok("no country is listed twice", dupes.length === 0, dupes.join(", "));

    ok("India bills in rupees", CCY.forCountry("India") === "INR");
    ok("a Gulf client bills in dirhams", CCY.forCountry("United Arab Emirates") === "AED");
    ok("a euro-area client bills in euro", CCY.forCountry("Germany") === "EUR");
    // the desk types what it types: aliases, ISO codes, punctuation, accents
    ok("\"usa\" resolves", CCY.forCountry("usa") === "USD");
    ok("\"U.A.E.\" resolves", CCY.forCountry("U.A.E.") === "AED");
    ok("\"UK\" resolves", CCY.forCountry("UK") === "GBP");
    ok("an ISO-2 code resolves", CCY.forCountry("SG") === "SGD");
    ok("an ISO-3 code resolves", CCY.forCountry("LKA") === "LKR");
    ok("accents are folded — Côte d'Ivoire finds the CFA franc",
      CCY.forCountry("Côte d'Ivoire") === "XOF", CCY.forCountry("Côte d'Ivoire"));
    ok("a country stores under its canonical spelling",
      (CCY.country("holland") || {}).name === "Netherlands");

    /* The rule the table follows: the currency you would actually INVOICE in,
       which for a dollarised economy is not the one on the banknotes. */
    ok("a dollarised economy bills in dollars, not its own note",
      CCY.forCountry("Ecuador") === "USD" && CCY.forCountry("Panama") === "USD" &&
      CCY.forCountry("Zimbabwe") === "USD");

    // nothing recognised must never guess — the caller keeps what it had
    ok("an unknown country yields nothing rather than a guess",
      CCY.forCountry("Atlantis") === "" && CCY.forCountry("") === "" &&
      CCY.forCountry(null) === "");

    ok("a currency reads as code, symbol and name", CCY.full("USD") === "USD $ — US Dollar", CCY.full("USD"));
    ok("a currency with no Latin symbol still reads cleanly",
      CCY.short("SDG") === "SDG", CCY.short("SDG"));
    ok("an unknown code degrades to itself rather than throwing",
      CCY.name("ZZZ") === "ZZZ" && CCY.short("ZZZ") === "ZZZ");

    /* The dashboard converter offers a deliberate subset — the currencies the
       office actually converts between. Pinned so growing the master table for
       the customer master never quietly reshapes that card's pickers. */
    ok("the converter still offers exactly its own 42 currencies",
      CCY.CONVERTER_CODES.length === 42 && new Set(CCY.CONVERTER_CODES).size === 42,
      String(CCY.CONVERTER_CODES.length));
    ok("every converter code is nameable",
      CCY.CONVERTER_CODES.every((c) => CCY.known(c)));
    ok("the converter list is sorted by NAME, not code",
      CCY.sortedByName(CCY.CONVERTER_CODES)[0] === "AUD",
      CCY.sortedByName(CCY.CONVERTER_CODES).slice(0, 3).join(","));

    /* rate() is a thin caller of /api/fx/pair, i.e. of the Google-only feed
       pinned above; what is worth checking HERE — the suite is synchronous and
       offline — is that asking for one outside a browser is inert rather than
       an exception. What it resolves TO (a figure, or null so the caller shows
       "—") is the fxService contract tested in the section above. */
    const savedFetch = global.fetch;
    global.fetch = undefined;
    let rateThrew = null;
    let thenable = null;
    try { thenable = CCY.rate("USD", "INR"); } catch (e) { rateThrew = e.message; }
    global.fetch = savedFetch;
    ok("asking for a rate with no feed available does not throw", rateThrew === null, rateThrew);
    ok("rate() always hands back a promise", thenable && typeof thenable.then === "function");
  }
} catch (e) {
  fail++;
  console.log("\n  ✗ UNCAUGHT: " + (e && e.stack ? e.stack : e));
} finally {
  /* close the pool, then drop this run's scratch database and directory
     (and sweep anything a run that died left behind) */
  try { await closeDb(); } catch {}
  await scratch.release(RUN);
}

}

main().then(() => {
  console.log("\n" + (fail === 0 ? "PASS" : "FAIL") + " — " + pass + " passed, " + fail + " failed\n");
  process.exit(fail === 0 ? 0 : 1);
});
