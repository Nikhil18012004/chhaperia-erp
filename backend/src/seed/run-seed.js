/* ============================================================
   CHHAPERIA ERP — BACKEND · standalone seed runner
   Usage: npm run seed
   Wipes and regenerates the deterministic demo dataset into
   the SQLite database, then exits.
   ============================================================ */
"use strict";
const erp = require("../services/erpService");
const { closeDb, DB_FILE } = require("../db/connection");

const state = erp.reset();
console.log(`Seeded Chhaperia ERP demo data -> ${DB_FILE}`);
console.log(`  items=${state.items.length}  movements=${state.movements.length}` +
  `  SOs=${state.salesorders.length}  POs=${state.purchaseorders.length}` +
  `  WOs=${state.workorders.length}`);
closeDb();
