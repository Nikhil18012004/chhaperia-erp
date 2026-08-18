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
async function punchAuth(req, res, next) {
  const configured = process.env.CHHAPERIA_DEVICE_KEY || ((await hr.getConfig()).deviceKey || "");
  const key = req.headers["x-device-key"] || (req.query && req.query.key);
  if (configured && key && String(key) === String(configured)) { req.deviceAuth = true; return next(); }
  const user = await authSvc.userFromToken(getToken(req));
  if (user && (user.role === "admin" || user.role === "office")) { req.user = user; return next(); }
  return res.status(401).json({ error: "Biometric device key or office login required" });
}

/* ---- biometric ingestion (device → server, real-time) ---- */
// A device posts one punch: { deviceUid, ts?, direction?, deviceId? }
router.post("/punch", punchAuth, async (req, res, next) => {
  try { res.status(201).json(await hr.ingestPunch(req.body || {})); } catch (e) { next(e); }
});
// Some devices batch: { punches:[ {...}, ... ] }
router.post("/punch/batch", punchAuth, async (req, res, next) => {
  try {
    const list = (req.body && req.body.punches) || [];
    /* One at a time, in order. .map() with an async callback would answer the
       device with an array of pending promises — reported as processed, and in
       fact not yet written anywhere. */
    const out = [];
    for (const p of list) {
      try { out.push(await hr.ingestPunch(p)); }
      catch (e) { out.push({ ok: false, error: e.message }); }
    }
    res.status(201).json({ ok: true, processed: out.length, results: out });
  } catch (e) { next(e); }
});
router.get("/punches", requireAuth, office, async (req, res, next) => {
  try { res.json({ punches: await hr.recentPunches(+(req.query.limit) || 100) }); } catch (e) { next(e); }
});

/* ---- workers ---- */
router.post("/workers", requireAuth, office, async (req, res, next) => {
  try { res.status(201).json(await hr.createWorker(req.body || {})); } catch (e) { next(e); }
});
router.patch("/workers/:id", requireAuth, office, async (req, res, next) => {
  try { res.json(await hr.updateWorker(req.params.id, req.body || {})); } catch (e) { next(e); }
});
router.delete("/workers/:id", requireAuth, office, async (req, res, next) => {
  try { res.json(await hr.deleteWorker(req.params.id)); } catch (e) { next(e); }
});

/* ---- attendance (manual entry / correction) ---- */
router.post("/attendance", requireAuth, office, async (req, res, next) => {
  try { res.status(201).json(await hr.setAttendance(req.body || {})); } catch (e) { next(e); }
});

/* ---- leave ---- */
router.get("/leave-balances/:workerId", requireAuth, office, async (req, res, next) => {
  try { res.json({ balances: await hr.leaveBalances(req.params.workerId) }); } catch (e) { next(e); }
});
router.post("/leave-types", requireAuth, office, async (req, res, next) => {
  try { res.status(201).json(await hr.saveLeaveType(req.body || {})); } catch (e) { next(e); }
});
router.delete("/leave-types/:id", requireAuth, office, async (req, res, next) => {
  try { res.json(await hr.deleteLeaveType(req.params.id)); } catch (e) { next(e); }
});
router.post("/leaves", requireAuth, office, async (req, res, next) => {
  try { res.status(201).json(await hr.applyLeave(req.body || {})); } catch (e) { next(e); }
});
router.post("/leaves/:id/decide", requireAuth, office, async (req, res, next) => {
  try { res.json(await hr.decideLeave(req.params.id, (req.body || {}).status, req.user)); } catch (e) { next(e); }
});
router.delete("/leaves/:id", requireAuth, office, async (req, res, next) => {
  try { res.json(await hr.deleteLeave(req.params.id)); } catch (e) { next(e); }
});

/* ---- payroll ---- */
router.post("/payroll/run", requireAuth, office, async (req, res, next) => {
  try { res.status(201).json(await hr.runPayroll((req.body || {}).period, req.body || {})); } catch (e) { next(e); }
});
router.post("/payroll/:id/finalize", requireAuth, office, async (req, res, next) => {
  try { res.json(await hr.finalizePayrun(req.params.id)); } catch (e) { next(e); }
});
router.delete("/payroll/:id", requireAuth, office, async (req, res, next) => {
  try { res.json(await hr.deletePayrun(req.params.id)); } catch (e) { next(e); }
});
router.get("/payroll/:id/payslips", requireAuth, office, async (req, res, next) => {
  try { res.json({ payslips: await hr.payslips(req.params.id) }); } catch (e) { next(e); }
});
router.patch("/payslips/:id", requireAuth, office, async (req, res, next) => {
  try { res.json(await hr.updatePayslip(req.params.id, req.body || {})); } catch (e) { next(e); }
});

/* ---- advances: an amount paid up front, recovered monthly from payslips ---- */
router.get("/workers/:id/advance", requireAuth, office, async (req, res, next) => {
  try { res.json(await hr.advanceStatus(req.params.id)); } catch (e) { next(e); }
});
router.put("/workers/:id/advance", requireAuth, office, async (req, res, next) => {
  try { res.json(await hr.setAdvance(req.params.id, req.body || {})); } catch (e) { next(e); }
});

/* ---- config (deduction toggles/rates, OT multiplier, device key) ---- */
router.get("/config", requireAuth, office, async (req, res, next) => {
  try { res.json(await hr.getConfig()); } catch (e) { next(e); }
});
router.patch("/config", requireAuth, office, async (req, res, next) => {
  try { res.json(await hr.setConfig(req.body || {})); } catch (e) { next(e); }
});

module.exports = router;
