/* ============================================================
   CHHAPERIA ERP — BACKEND · server entry
   Express app that:
     • exposes the /api REST surface (backend layer)
     • serves the static frontend/ (presentation layer)
   The database layer lives behind the service + repository.
   ============================================================ */
"use strict";
const path = require("path");
const fs = require("fs");
const express = require("express");
const apiRoutes = require("./routes/api");
const hrRoutes = require("./routes/hr");
const { router: authRoutes } = require("./routes/auth");
const authService = require("./services/authService");
const erpService = require("./services/erpService");
const hrService = require("./services/hrService");
const labService = require("./services/labService");
const { closeDb } = require("./db/connection");

const PORT = process.env.PORT || 4000;
const FRONTEND_DIR = path.join(__dirname, "..", "..", "frontend");

const app = express();
app.use(express.json({ limit: "25mb" }));

// Auth (login, me, user management)
app.use("/api/auth", authRoutes);
// Human Resources (workers, attendance, leave, payroll + device punch ingest)
app.use("/api/hr", hrRoutes);
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

// Serve index.html with AUTOMATIC cache-busting: rewrite every
// js/*.js?v= and css/*.css?v= to the referenced file's mtime, so any
// edit is picked up on reload with no manual ?v= bump and no restart.
function serveIndex(req, res) {
  let html;
  try { html = fs.readFileSync(path.join(FRONTEND_DIR, "index.html"), "utf8"); }
  catch (e) { return res.status(500).send("index.html not found"); }
  html = html.replace(/(src|href)="((?:js|css)\/[^"?]+)(?:\?v=[^"]*)?"/g, (m, attr, rel) => {
    let v = "0";
    try { v = String(Math.floor(fs.statSync(path.join(FRONTEND_DIR, rel)).mtimeMs)); } catch {}
    return `${attr}="${rel}?v=${v}"`;
  });
  res.set("Cache-Control", "no-store, must-revalidate");
  res.type("html").send(html);
}
app.get(["/", "/index.html"], serveIndex);

// Static frontend (index disabled — the route above owns the HTML shell)
app.use(express.static(FRONTEND_DIR, { index: false }));

// Central error handler. Log full stacks server-side; never leak an internal
// 500 message (e.g. a raw SQLite error) to the client — only intended 4xx
// messages are returned.
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error("[api error]", err.stack || err.message);
  else console.warn("[api]", status, req.method, req.path, "—", err.message);
  res.status(status).json({ error: status >= 500 ? "Internal server error" : (err.message || "Error") });
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

  // seed demo HR data (workers + leave types + recent attendance) on first run
  try { const hr = hrService.ensureHr(); if (hr.changed) console.log("  ├─ HR       : seeded " + hr.workers + " workers + attendance"); }
  catch (e) { console.error("[hr seed]", e.message); }

  // seed demo transport agencies (dispatch directory) on first run
  try { const dp = erpService.ensureDispatch(); if (dp.changed) console.log("  ├─ Dispatch : seeded " + dp.count + " transport agencies"); }
  catch (e) { console.error("[dispatch seed]", e.message); }

  // seed the lab-reports product master (finished-goods list) on first run
  try { const lp = labService.ensureLab(); if (lp.changed) console.log("  ├─ Lab      : seeded " + lp.products + " lab products"); }
  catch (e) { console.error("[lab seed]", e.message); }

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

// Graceful shutdown: stop accepting connections, close the DB handle, exit.
function shutdown(sig) {
  console.log(`\n[${sig}] shutting down…`);
  server.close(() => { try { closeDb(); } catch {} process.exit(0); });
  setTimeout(() => process.exit(0), 3000).unref(); // hard-stop if close hangs
}
["SIGINT", "SIGTERM"].forEach((s) => process.on(s, () => shutdown(s)));
// Last-resort safety nets so one bad request can't silently take the server down.
process.on("unhandledRejection", (r) => console.error("[unhandledRejection]", r));
process.on("uncaughtException", (e) => console.error("[uncaughtException]", e.stack || e));

module.exports = { app, server };
