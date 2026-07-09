/* ============================================================
   CHHAPERIA ERP — BACKEND · Human Resources routes (/api/hr)
   HR data is money-sensitive → admin/office only, EXCEPT the
   biometric punch-ingestion endpoint, which a device pushes to
   24/7 authenticated by a shared device key (falls back to an
   office login so the in-app simulator works).
   ============================================================ */
"use strict";
const express = require("express");
const hr = require("../services/hrService");
const authSvc = require("../services/authService");
const { requireAuth, requireRole, getToken } = require("./auth");

const router = express.Router();
const office = requireRole("admin", "office");

/* Punch auth: trust a valid device key, else require an office/admin session. */
function punchAuth(req, res, next) {
  const configured = process.env.CHHAPERIA_DEVICE_KEY || (hr.getConfig().deviceKey || "");
  const key = req.headers["x-device-key"] || (req.query && req.query.key);
  if (configured && key && String(key) === String(configured)) { req.deviceAuth = true; return next(); }
  const user = authSvc.userFromToken(getToken(req));
  if (user && (user.role === "admin" || user.role === "office")) { req.user = user; return next(); }
  return res.status(401).json({ error: "Biometric device key or office login required" });
}

/* ---- biometric ingestion (device → server, real-time) ---- */
// A device posts one punch: { deviceUid, ts?, direction?, deviceId? }
router.post("/punch", punchAuth, (req, res, next) => {
  try { res.status(201).json(hr.ingestPunch(req.body || {})); } catch (e) { next(e); }
});
// Some devices batch: { punches:[ {...}, ... ] }
router.post("/punch/batch", punchAuth, (req, res, next) => {
  try {
    const list = (req.body && req.body.punches) || [];
    const out = list.map((p) => { try { return hr.ingestPunch(p); } catch (e) { return { ok: false, error: e.message }; } });
    res.status(201).json({ ok: true, processed: out.length, results: out });
  } catch (e) { next(e); }
});
router.get("/punches", requireAuth, office, (req, res, next) => {
  try { res.json({ punches: hr.recentPunches(+(req.query.limit) || 100) }); } catch (e) { next(e); }
});

/* ---- workers ---- */
router.post("/workers", requireAuth, office, (req, res, next) => {
  try { res.status(201).json(hr.createWorker(req.body || {})); } catch (e) { next(e); }
});
router.patch("/workers/:id", requireAuth, office, (req, res, next) => {
  try { res.json(hr.updateWorker(req.params.id, req.body || {})); } catch (e) { next(e); }
});
router.delete("/workers/:id", requireAuth, office, (req, res, next) => {
  try { res.json(hr.deleteWorker(req.params.id)); } catch (e) { next(e); }
});

/* ---- attendance (manual entry / correction) ---- */
router.post("/attendance", requireAuth, office, (req, res, next) => {
  try { res.status(201).json(hr.setAttendance(req.body || {})); } catch (e) { next(e); }
});

/* ---- leave ---- */
router.get("/leave-balances/:workerId", requireAuth, office, (req, res, next) => {
  try { res.json({ balances: hr.leaveBalances(req.params.workerId) }); } catch (e) { next(e); }
});
router.post("/leave-types", requireAuth, office, (req, res, next) => {
  try { res.status(201).json(hr.saveLeaveType(req.body || {})); } catch (e) { next(e); }
});
router.delete("/leave-types/:id", requireAuth, office, (req, res, next) => {
  try { res.json(hr.deleteLeaveType(req.params.id)); } catch (e) { next(e); }
});
router.post("/leaves", requireAuth, office, (req, res, next) => {
  try { res.status(201).json(hr.applyLeave(req.body || {})); } catch (e) { next(e); }
});
router.post("/leaves/:id/decide", requireAuth, office, (req, res, next) => {
  try { res.json(hr.decideLeave(req.params.id, (req.body || {}).status, req.user)); } catch (e) { next(e); }
});
router.delete("/leaves/:id", requireAuth, office, (req, res, next) => {
  try { res.json(hr.deleteLeave(req.params.id)); } catch (e) { next(e); }
});

/* ---- payroll ---- */
router.post("/payroll/run", requireAuth, office, (req, res, next) => {
  try { res.status(201).json(hr.runPayroll((req.body || {}).period, req.body || {})); } catch (e) { next(e); }
});
router.post("/payroll/:id/finalize", requireAuth, office, (req, res, next) => {
  try { res.json(hr.finalizePayrun(req.params.id)); } catch (e) { next(e); }
});
router.delete("/payroll/:id", requireAuth, office, (req, res, next) => {
  try { res.json(hr.deletePayrun(req.params.id)); } catch (e) { next(e); }
});
router.get("/payroll/:id/payslips", requireAuth, office, (req, res, next) => {
  try { res.json({ payslips: hr.payslips(req.params.id) }); } catch (e) { next(e); }
});
router.patch("/payslips/:id", requireAuth, office, (req, res, next) => {
  try { res.json(hr.updatePayslip(req.params.id, req.body || {})); } catch (e) { next(e); }
});

/* ---- config (deduction toggles/rates, OT multiplier, device key) ---- */
router.get("/config", requireAuth, office, (req, res, next) => {
  try { res.json(hr.getConfig()); } catch (e) { next(e); }
});
router.patch("/config", requireAuth, requireRole("admin"), (req, res, next) => {
  try { res.json(hr.setConfig(req.body || {})); } catch (e) { next(e); }
});

module.exports = router;
