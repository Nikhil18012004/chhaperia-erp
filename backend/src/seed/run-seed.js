/* ============================================================
   CHHAPERIA ERP — BACKEND · standalone seed runner
   Usage: npm run seed
   Wipes and regenerates the deterministic demo dataset into
   the MySQL database, then exits.

   ⚠ The work is inside main(). A top-level await is not legal in
   a CommonJS file, and the seed is now asynchronous because the
   database is a server rather than a file.
   ============================================================ */
"use strict";
const erp = require("../services/erpService");
const { closeDb, readConfig } = require("../db/connection");

async function main() {
  const cfg = readConfig();
  const state = await erp.reset();
  console.log(`Seeded Chhaperia ERP demo data -> mysql://${cfg.host}:${cfg.port}/${cfg.database}`);
  console.log(`  items=${state.items.length}  movements=${state.movements.length}` +
    `  SOs=${state.salesorders.length}  POs=${state.purchaseorders.length}` +
    `  WOs=${state.workorders.length}`);
}

main()
  .then(() => closeDb())
  .then(() => process.exit(0))
  .catch(async (e) => {
    console.error("Seed failed:", e && e.message);
    try { await closeDb(); } catch { /* the pool may never have opened */ }
    process.exit(1);
  });
