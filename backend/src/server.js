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

const PORT = process.env.PORT || 4000;
const FRONTEND_DIR = path.join(__dirname, "..", "..", "frontend");

const app = express();
app.use(express.json({ limit: "25mb" }));

// Auth (login, me, user management)
app.use("/api/auth", authRoutes);
// API (protected, role-scoped)
app.use("/api", apiRoutes);

// Static frontend
app.use(express.static(FRONTEND_DIR));
app.get("/", (req, res) => res.sendFile(path.join(FRONTEND_DIR, "index.html")));

// Central error handler
app.use((err, req, res, next) => {
  console.error("[api error]", err.message);
  res.status(err.status || 500).json({ error: err.message || "Internal error" });
});

const server = app.listen(PORT, () => {
  // ensure default accounts exist on first run
  let seedInfo = { seeded: false };
  try { seedInfo = authService.seedDefaultUsers(); } catch (e) { console.error("[user seed]", e.message); }

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
