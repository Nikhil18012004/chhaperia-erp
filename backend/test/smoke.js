/* ============================================================
   CHHAPERIA ERP — smoke tests (no framework, no build step)
   Runs the DB + service layer against a THROWAWAY SQLite file
   so it never touches data/chhaperia.db. Exits non-zero on any
   failure so it can gate a commit / CI.

     node backend/test/smoke.js      (or: npm test)
   ============================================================ */
"use strict";
const path = require("path");
const os = require("os");
const fs = require("fs");

// point the DB at a temp file BEFORE the connection module loads
const TMP = path.join(os.tmpdir(), "chh-smoke-" + process.pid + "-" + Date.now() + ".db");
process.env.CHHAPERIA_DB_FILE = TMP;
process.env.CHHAPERIA_DATA_DIR = os.tmpdir();

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

try {
  section("Seed integrity (pure generator)");
  const seed = buildSeed();
  ok("buildSeed returns items[]", Array.isArray(seed.items) && seed.items.length > 0, "items=" + (seed.items || []).length);
  ok("buildSeed returns movements[]", Array.isArray(seed.movements) && seed.movements.length > 0);
  const ids = new Set(seed.items.map((i) => i.id));
  ok("every movement references a real item", seed.movements.every((m) => ids.has(m.itemId)));

  section("State load (auto-seeds on empty)");
  const state = erp.getState();
  ok("getState seeds & returns items", Array.isArray(state.items) && state.items.length > 0, "items=" + state.items.length);
  ok("getState returns purchaseorders", Array.isArray(state.purchaseorders));

  section("Granular: upsertItem");
  const created = erp.upsertItem({ id: "RM-SMOKE", name: "Smoke Test Foil", cat: "RM", uom: "KG", cost: 42, reorder: 5, thickness: 0.05 });
  ok("item created with promoted cost", created && created.cost === 42);
  ok("item keeps extra doc field (thickness)", created && created.thickness === 0.05);
  const updated = erp.upsertItem({ id: "RM-SMOKE", name: "Smoke Test Foil v2", cat: "RM", uom: "KG", cost: 50 });
  ok("item update overwrites cost", repo.getItem("RM-SMOKE").cost === 50);
  ok("item update rename applied", repo.getItem("RM-SMOKE").name === "Smoke Test Foil v2");
  ok("upsertItem rejects missing id", throws(() => erp.upsertItem({ name: "no id" })));

  section("Granular: addMovement");
  const before = repo.getState().movements.length;
  const mv = erp.addMovement({ itemId: "RM-SMOKE", wh: "WH-PNY", type: "GRN", qty: 100, rate: 50, note: "smoke" });
  ok("addMovement returns an id", mv && mv.ok && !!mv.id);
  ok("movement count increased by 1", repo.getState().movements.length === before + 1);
  ok("addMovement rejects no itemId", throws(() => erp.addMovement({ type: "GRN", qty: 1 })));
  ok("addMovement rejects non-numeric qty", throws(() => erp.addMovement({ itemId: "RM-SMOKE", type: "GRN", qty: "abc" })));

  section("Granular: receivePurchaseOrder");
  const openPO = repo.getState().purchaseorders.find((p) => p.status !== "Received" && (p.lines || []).length);
  if (!openPO) { ok("an open PO exists to receive", false, "none found in seed"); }
  else {
    const line0 = openPO.lines[0];
    const want = Math.max(1, Math.round((line0.qty - (line0.recd || 0)) / 2));
    const r = erp.receivePurchaseOrder(openPO.id, { wh: "WH-PNY", lines: [{ i: 0, qty: want }] });
    ok("receive posts >=1 movement", r && r.posted >= 1);
    const after = repo.getPurchaseOrder(openPO.id);
    ok("PO line recd advanced", (after.lines[0].recd || 0) >= want - 0.01);
    ok("PO status is Partially/Received", ["Partially Received", "Received"].includes(after.status), after.status);
    ok("receive unknown PO 404s", throws(() => erp.receivePurchaseOrder("PO-NOPE", { lines: [{ i: 0, qty: 1 }] })));
  }

  section("Reset");
  const reseed = erp.reset();
  ok("reset returns a fresh dataset", Array.isArray(reseed.items) && reseed.items.length > 0);
  ok("reset dropped the smoke item", !repo.getItem("RM-SMOKE"));

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
    repo.putWorker({ id: W, name: "Earned Leave Tester", dept: "coating", dailyRate: 500, active: true });
    // ensure an "earned" type exists to measure against
    repo.putLeaveType({ id: "ELT", name: "Earned Leave (test)", quota: 12, accrual: "earned", paid: true });
    const entitledFor = () => (hr.leaveBalances(W).find((b) => b.type === "ELT") || {}).entitled;
    const present = (date) => repo.putAttendance({ workerId: W, date, status: "P" });

    ok("no attendance ⇒ 0 days earned", entitledFor() === 0);

    // a single month, worked many times over, is still worth exactly one day
    ["-01-05", "-01-06", "-01-07", "-01-08", "-01-09"].forEach((d) => present(year + d));
    ok("five days inside ONE month earn 1 day (not 5, and not 0)", entitledFor() === 1,
      "got " + entitledFor());

    // a second month adds exactly one more, however few days are worked in it
    present(year + "-02-11");
    ok("one day worked in a SECOND month earns the 2nd day", entitledFor() === 2,
      "got " + entitledFor());

    // half days still count the month; absences and leave do not create one
    repo.putAttendance({ workerId: W, date: year + "-03-02", status: "HD" });
    ok("a half day still earns its month", entitledFor() === 3, "got " + entitledFor());
    repo.putAttendance({ workerId: W, date: year + "-04-02", status: "A" });
    ok("an ABSENT month earns nothing", entitledFor() === 3, "got " + entitledFor());
    // ...but working any other day of that same month does earn it
    present(year + "-04-20");
    ok("working later in that month still earns it", entitledFor() === 4, "got " + entitledFor());

    // twelve worked months = twelve days, which is the annual figure
    ["-05", "-06", "-07", "-08", "-09", "-10", "-11", "-12"].forEach((m) => present(year + m + "-15"));
    ok("a full year of work earns 12 days", entitledFor() === 12, "got " + entitledFor());

    // last year's attendance must not leak into this year's balance
    present(String(+year - 1) + "-06-10");
    ok("last year's work does not inflate this year", entitledFor() === 12, "got " + entitledFor());
  }
} catch (e) {
  fail++;
  console.log("\n  ✗ UNCAUGHT: " + (e && e.stack ? e.stack : e));
} finally {
  try { closeDb(); } catch {}
  try { fs.rmSync(TMP, { force: true }); fs.rmSync(TMP + "-wal", { force: true }); fs.rmSync(TMP + "-shm", { force: true }); } catch {}
}

console.log("\n" + (fail === 0 ? "PASS" : "FAIL") + " — " + pass + " passed, " + fail + " failed\n");
process.exit(fail === 0 ? 0 : 1);
