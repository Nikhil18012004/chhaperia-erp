/* ============================================================
   CHHAPERIA ERP — BACKEND · server entry
   Express app that:
     • exposes the /api REST surface (backend layer)
     • serves the static frontend/ (presentation layer)
   The database layer lives behind the service + repository.
   ============================================================ */
"use strict";
const path = require("path");
const express = require("express");
const apiRoutes = require("./routes/api");
const { router: authRoutes } = require("./routes/auth");
const authService = require("./services/authService");
const erpService = require("./services/erpService");

const PORT = process.env.PORT || 4000;
const FRONTEND_DIR = path.join(__dirname, "..", "..", "frontend");

const app = express();
app.use(express.json({ limit: "25mb" }));

// Auth (login, me, user management)
app.use("/api/auth", authRoutes);
// API (protected, role-scoped)
app.use("/api", apiRoutes);

// Never cache the HTML shell, so bumped script ?v= URLs always take effect
// (browsers were reusing a stale index.html that still pointed at old JS).
app.use((req, res, next) => {
  if (req.path === "/" || req.path.endsWith(".html")) {
    res.set("Cache-Control", "no-store, must-revalidate");
  }
  next();
});

// Static frontend
app.use(express.static(FRONTEND_DIR));
app.get("/", (req, res) => {
  res.set("Cache-Control", "no-store, must-revalidate");
  res.sendFile(path.join(FRONTEND_DIR, "index.html"));
});

// Central error handler
app.use((err, req, res, next) => {
  console.error("[api error]", err.message);
  res.status(err.status || 500).json({ error: err.message || "Internal error" });
});

const server = app.listen(PORT, () => {
  // ensure default accounts exist on first run
  let seedInfo = { seeded: false };
  try { seedInfo = authService.seedDefaultUsers(); } catch (e) { console.error("[user seed]", e.message); }

  // ensure the multi-stage routing model is applied to existing data (idempotent)
  try { const m = erpService.ensureStageModel(); if (m.changed) console.log("  ├─ Stages   : migrated data to multi-stage routing"); }
  catch (e) { console.error("[stage migration]", e.message); }

  // restore the CRM pipeline if this DB was seeded before the CRM module existed
  try { const c = erpService.ensureCrm(); if (c.changed) console.log("  ├─ CRM      : restored " + c.count + " sales leads"); }
  catch (e) { console.error("[crm restore]", e.message); }

  console.log(`\n  Chhaperia ERP`);
  console.log(`  ├─ API      : http://localhost:${PORT}/api`);
  console.log(`  ├─ Frontend : http://localhost:${PORT}/`);
  console.log(`  ├─ Database : SQLite (data/chhaperia.db)`);
  if (seedInfo.seeded) {
    console.log(`  └─ Users    : seeded ${seedInfo.count} default accounts (admin/admin@123)\n`);
  } else {
    console.log(`  └─ Users    : ${seedInfo.count || "existing"} accounts\n`);
  }
});

module.exports = { app, server };
