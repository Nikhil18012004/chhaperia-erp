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

const PORT = process.env.PORT || 4000;
const FRONTEND_DIR = path.join(__dirname, "..", "..", "frontend");

const app = express();
app.use(express.json({ limit: "25mb" }));

// API
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
  console.log(`\n  Chhaperia ERP`);
  console.log(`  ├─ API      : http://localhost:${PORT}/api`);
  console.log(`  ├─ Frontend : http://localhost:${PORT}/`);
  console.log(`  └─ Database : SQLite (data/chhaperia.db)\n`);
});

module.exports = { app, server };
