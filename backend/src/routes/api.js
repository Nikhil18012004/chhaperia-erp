/* ============================================================
   CHHAPERIA ERP — BACKEND · REST routes (protected)
       GET    /api/health         -> liveness (public)
       GET    /api/state          -> role-scoped dataset (auth)
       PUT    /api/state          -> replace full dataset (admin/office)
       PATCH  /api/settings       -> patch UI settings (admin/office)
       POST   /api/reset          -> regenerate demo data (admin only)
   Auth is enforced server-side: supervisors receive only their
   money-free, area-scoped production view.
   ============================================================ */
"use strict";
const express = require("express");
const erp = require("../services/erpService");
const view = require("../services/viewService");
const production = require("../services/productionService");
const { requireAuth, requireRole } = require("./auth");

const router = express.Router();

router.get("/health", (req, res) => {
  res.json({ ok: true, service: "chhaperia-erp-api", time: new Date().toISOString() });
});

// Role-scoped read: admin/office get the full dataset, supervisors get their view.
router.get("/state", requireAuth, (req, res, next) => {
  try { res.json(view.stateForUser(req.user)); } catch (e) { next(e); }
});

// Supervisor (or office/admin) advances a work order's CURRENT stage.
// action: start | pause | complete | dispatch  — area-scoped, money-free.
router.post("/production/wo/:id/advance", requireAuth, requireRole("supervisor", "admin", "office"), (req, res, next) => {
  try { res.json(production.advance(req.user, req.params.id, (req.body || {}).action)); }
  catch (e) { next(e); }
});

// Back-compat: advance by target status (maps to a stage action).
router.post("/production/wo/:id/status", requireAuth, requireRole("supervisor", "admin", "office"), (req, res, next) => {
  try { res.json(production.updateWorkOrderStatus(req.user, req.params.id, (req.body || {}).status)); }
  catch (e) { next(e); }
});

// Office/admin create a new work order (with a fresh multi-stage route).
router.post("/production/wo", requireAuth, requireRole("admin", "office"), (req, res, next) => {
  try { res.status(201).json(production.createWorkOrder(req.user, req.body || {})); }
  catch (e) { next(e); }
});

// Only admin/office can write the full dataset.
router.put("/state", requireAuth, requireRole("admin", "office"), (req, res, next) => {
  try { res.json(erp.saveState(req.body)); } catch (e) { next(e); }
});

router.patch("/settings", requireAuth, requireRole("admin", "office"), (req, res, next) => {
  try { res.json(erp.updateSettings(req.body)); } catch (e) { next(e); }
});

// Reset is destructive -> admin only.
router.post("/reset", requireAuth, requireRole("admin"), (req, res, next) => {
  try { res.json(erp.reset()); } catch (e) { next(e); }
});

module.exports = router;
