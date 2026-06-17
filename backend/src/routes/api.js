/* ============================================================
   CHHAPERIA ERP — BACKEND · REST routes
   Thin HTTP layer. Maps the frontend's data contract onto the
   ERP service:
       GET    /api/health         -> liveness
       GET    /api/state          -> full dataset (seeds if empty)
       PUT    /api/state          -> replace full dataset
       PATCH  /api/settings       -> patch UI settings
       POST   /api/reset          -> regenerate demo data
   ============================================================ */
"use strict";
const express = require("express");
const erp = require("../services/erpService");

const router = express.Router();

router.get("/health", (req, res) => {
  res.json({ ok: true, service: "chhaperia-erp-api", time: new Date().toISOString() });
});

router.get("/state", (req, res, next) => {
  try { res.json(erp.getState()); } catch (e) { next(e); }
});

router.put("/state", (req, res, next) => {
  try { res.json(erp.saveState(req.body)); } catch (e) { next(e); }
});

router.patch("/settings", (req, res, next) => {
  try { res.json(erp.updateSettings(req.body)); } catch (e) { next(e); }
});

router.post("/reset", (req, res, next) => {
  try { res.json(erp.reset()); } catch (e) { next(e); }
});

module.exports = router;
