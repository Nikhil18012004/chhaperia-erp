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
} catch (e) {
  fail++;
  console.log("\n  ✗ UNCAUGHT: " + (e && e.stack ? e.stack : e));
} finally {
  try { closeDb(); } catch {}
  try { fs.rmSync(TMP, { force: true }); fs.rmSync(TMP + "-wal", { force: true }); fs.rmSync(TMP + "-shm", { force: true }); } catch {}
}

console.log("\n" + (fail === 0 ? "PASS" : "FAIL") + " — " + pass + " passed, " + fail + " failed\n");
process.exit(fail === 0 ? 0 : 1);
