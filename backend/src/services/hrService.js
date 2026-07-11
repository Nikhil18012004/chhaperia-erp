/* ============================================================
   CHHAPERIA ERP — BACKEND · Human Resources service
   Workers/labour master, biometric attendance, leave and a
   configurable daily-wage payroll engine.

   Design notes
   ------------
   • Biometric device (eSSL/ZKTeco/Matrix, ADMS/push) POSTs raw
     punches to /api/hr/punch 24/7. We store every punch, then
     DERIVE the daily muster (first-in / last-out / hours / OT)
     for that worker+day. Manual attendance is also supported.
   • Everything is configurable (settings.hr): OT multiplier,
     which statutory deductions apply (PF/ESI/PT) and their rates,
     and the leave types (quota + accrual rule). Sensible Indian
     manufacturing defaults are baked in.
   ============================================================ */
"use strict";
const repo = require("../db/repository");

function err(msg, status) { const e = new Error(msg); e.status = status || 400; return e; }
const pad = (n) => String(n).padStart(2, "0");
function todayISO() { const x = new Date(); return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`; }
function rid(pfx) { return pfx + "-" + Date.now() + "-" + Math.floor(Math.random() * 1e4); }
function num(v) { return v == null || v === "" || isNaN(+v) ? 0 : +v; }
function round(v, d = 2) { const p = Math.pow(10, d); return Math.round((+v || 0) * p) / p; }

/* ---- next sequential id from existing rows ---- */
function nextId(list, prefix, width = 4) {
  let max = 0;
  (list || []).forEach((x) => { const m = /(\d+)\s*$/.exec(String((x && x.id) || "")); if (m) max = Math.max(max, +m[1]); });
  return prefix + String(max + 1).padStart(width, "0");
}

/* ============================================================
   CONFIG — merged over defaults, stored in settings.hr
   ============================================================ */
const HR_DEFAULTS = {
  standardDayHours: 8,        // overtime accrues beyond this per day
  otMultiplier: 2,            // Factories Act §59: 2× ordinary wage
  timezone: "Asia/Kolkata",   // factory-local tz; zoned device punches are normalised to this
  weekOff: [0],               // 0=Sun … 6=Sat
  halfDayBelowHours: 4,       // a present day under this = half day
  deductions: {
    pf:  { on: true, rate: 12, wageCapMonthly: 15000, employerRate: 12 },
    esi: { on: true, empRate: 0.75, employerRate: 3.25, grossThreshold: 21000 },
    pt:  { on: true, slabs: [ { upTo: 24999, amt: 0 }, { upTo: 999999999, amt: 200 } ] }, // Karnataka
  },
};
function deepMerge(base, over) {
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  if (Array.isArray(over)) return over.slice();
  for (const k in (over || {})) {
    if (over[k] && typeof over[k] === "object" && !Array.isArray(over[k]) && base && typeof base[k] === "object")
      out[k] = deepMerge(base[k], over[k]);
    else out[k] = over[k];
  }
  return out;
}
function getConfig() {
  const s = repo.getSettings() || {};
  return deepMerge(HR_DEFAULTS, s.hr || {});
}
function setConfig(patch) {
  const s = repo.getSettings() || {};
  s.hr = deepMerge(getConfig(), patch || {});
  repo.updateSettings(s);
  return s.hr;
}
function isWeekOff(dateStr, cfg) { return (cfg.weekOff || []).includes(new Date(dateStr + "T12:00:00").getDay()); }
function eachDate(from, to) {
  const out = []; let d = new Date(from + "T12:00:00"); const end = new Date(to + "T12:00:00");
  while (d <= end) { out.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`); d.setDate(d.getDate() + 1); }
  return out;
}
/** Normalise a punch timestamp to factory-local wall-clock (naive ISO, no tz).
    A biometric device may push UTC (`…Z`) or an offset (`+00:00`); we convert
    that absolute instant into the configured timezone so the date bucket
    (`ts LIKE 'YYYY-MM-DD%'`) and the displayed HH:MM are the real local muster
    time. Timestamps that are already naive/local are left untouched. */
function normalizeTs(ts, cfg) {
  const s = String(ts);
  if (!/([zZ]|[+-]\d\d:?\d\d)$/.test(s)) return s;               // already local/naive
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  const tz = (cfg && cfg.timezone) || "Asia/Kolkata";
  const date = d.toLocaleDateString("en-CA", { timeZone: tz });                 // YYYY-MM-DD
  const time = d.toLocaleTimeString("en-GB", { timeZone: tz, hour12: false });  // HH:MM:SS
  return `${date}T${time}`;
}

/* ============================================================
   WORKERS
   ============================================================ */
function listWorkers() { return repo.getState().hrWorkers; }
function createWorker(w) {
  w = w || {};
  if (!w.name) throw err("Worker needs a name", 400);
  if (!w.id) w.id = nextId(repo.getState().hrWorkers, "EMP-");
  else if (repo.getWorker(w.id)) throw err("Worker " + w.id + " already exists", 409);
  if (w.deviceUid && repo.getWorkerByDevice(w.deviceUid) && repo.getWorkerByDevice(w.deviceUid).id !== w.id)
    throw err("Device id " + w.deviceUid + " is already mapped to another worker", 409);
  w.payType = w.payType || "daily";
  w.dailyRate = num(w.dailyRate);
  w.monthlyCtc = num(w.monthlyCtc);
  w.joined = w.joined || todayISO();
  return repo.putWorker(w);
}
function updateWorker(id, patch) {
  const existing = repo.getWorker(id);
  if (!existing) throw err("Worker not found", 404);
  const merged = Object.assign({}, existing, patch || {}, { id });
  if (merged.deviceUid) {
    const owner = repo.getWorkerByDevice(merged.deviceUid);
    if (owner && owner.id !== id) throw err("Device id " + merged.deviceUid + " is already mapped to " + owner.id, 409);
  }
  merged.dailyRate = num(merged.dailyRate);
  merged.monthlyCtc = num(merged.monthlyCtc);
  return repo.putWorker(merged);
}
function deleteWorker(id) {
  if (!repo.getWorker(id)) throw err("Worker not found", 404);
  return repo.deleteWorker(id);
}

/* ============================================================
   ATTENDANCE — biometric punch ingestion + derivation
   ============================================================ */
/** Recompute one worker's daily muster row from that day's punches. */
function recomputeAttendance(workerId, date) {
  const cfg = getConfig();
  const punches = repo.punchesForDate(date).filter((p) => p.workerId === workerId).sort((a, b) => (a.ts < b.ts ? -1 : 1));
  if (!punches.length) return null;
  const first = punches[0].ts, last = punches[punches.length - 1].ts;
  const inT = first.slice(11, 16), outT = punches.length > 1 ? last.slice(11, 16) : null;
  let hours = punches.length > 1 ? (new Date(last) - new Date(first)) / 3.6e6 : 0;
  hours = round(hours);
  const ot = Math.max(0, round(hours - cfg.standardDayHours));
  let status = "P";
  if (punches.length > 1 && hours > 0 && hours < cfg.halfDayBelowHours) status = "HD";
  return repo.putAttendance({ workerId, date, status, inTime: inT, outTime: outT, hours, otHours: ot, source: "device" });
}

/** Ingest ONE raw biometric punch (device → server). Resolves the worker by
    device user id, stores the punch, and refreshes that day's muster. */
function ingestPunch(body) {
  body = body || {};
  const deviceUid = String(body.deviceUid || body.userId || body.uid || body.pin || "").trim();
  if (!deviceUid) throw err("Punch needs a device user id (deviceUid)", 400);
  const rawTs = body.ts || body.time || new Date().toISOString();
  if (isNaN(new Date(rawTs).getTime())) throw err("Punch has an invalid timestamp", 400);
  const ts = normalizeTs(rawTs, getConfig());   // store factory-local wall-clock
  const worker = repo.getWorkerByDevice(deviceUid);
  const punch = repo.addPunch({
    id: rid("PN"), workerId: worker ? worker.id : null, deviceUid, ts,
    direction: body.direction || body.state || "auto", deviceId: body.deviceId || body.sn || null,
    source: body.source || "device",
  });
  let attendance = null;
  if (worker) attendance = recomputeAttendance(worker.id, ts.slice(0, 10));
  return { ok: true, matched: !!worker, workerId: worker ? worker.id : null, punch, attendance };
}

/** Manual muster entry / correction (HR desk). */
function setAttendance(a) {
  a = a || {};
  if (!a.workerId || !a.date) throw err("Attendance needs workerId and date", 400);
  if (!repo.getWorker(a.workerId)) throw err("Unknown worker " + a.workerId, 400);
  let hours = num(a.hours), ot = num(a.otHours);
  if (!hours && a.inTime && a.outTime) {
    hours = round((new Date(a.date + "T" + a.outTime) - new Date(a.date + "T" + a.inTime)) / 3.6e6);
    ot = Math.max(0, round(hours - getConfig().standardDayHours));
  }
  return repo.putAttendance({ workerId: a.workerId, date: a.date, status: a.status || "P",
    inTime: a.inTime || null, outTime: a.outTime || null, hours, otHours: ot, note: a.note || null, source: "manual" });
}

function recentPunches(limit) { return repo.recentPunches(limit || 100); }

/* ============================================================
   LEAVE — configurable types, apply / approve, live balances
   ============================================================ */
function saveLeaveType(t) {
  if (!t || !t.id) throw err("Leave type needs an id/code", 400);
  return repo.putLeaveType(Object.assign({ name: t.id }, t));
}
function deleteLeaveType(id) { return repo.deleteLeaveType(id); }

function daysBetween(from, to) { return eachDate(from, to).length; }

/** Live leave balances for a worker: quota (or earned) − approved-this-year. */
function leaveBalances(workerId) {
  const st = repo.getState();
  const year = String(new Date().getFullYear());
  const daysWorked = st.hrAttendance.filter((a) => a.workerId === workerId && a.date.startsWith(year) && (a.status === "P" || a.status === "HD"))
    .reduce((s, a) => s + (a.status === "HD" ? 0.5 : 1), 0);
  return (st.hrLeaveTypes || []).map((t) => {
    const entitled = t.accrual === "earned" ? Math.floor(daysWorked / 20) : (t.accrual === "none" ? 0 : t.quota);
    const taken = st.hrLeaves.filter((l) => l.workerId === workerId && l.type === t.id && l.status === "Approved" && l.fromDate.startsWith(year))
      .reduce((s, l) => s + (l.days || 0), 0);
    return { type: t.id, name: t.name, entitled, taken, balance: round(entitled - taken, 1) };
  });
}

function applyLeave(l) {
  l = l || {};
  if (!l.workerId || !repo.getWorker(l.workerId)) throw err("Unknown worker", 400);
  if (!l.type || !repo.getLeaveType(l.type)) throw err("Unknown leave type", 400);
  if (!l.fromDate || !l.toDate) throw err("Leave needs from and to dates", 400);
  if (l.toDate < l.fromDate) throw err("End date is before start date", 400);
  const days = l.days != null ? num(l.days) : daysBetween(l.fromDate, l.toDate);
  const lv = { id: l.id || nextId(repo.getState().hrLeaves, "LV-"), workerId: l.workerId, type: l.type,
    fromDate: l.fromDate, toDate: l.toDate, days, status: l.status || "Pending",
    reason: l.reason || null, appliedOn: l.appliedOn || todayISO() };
  return repo.putLeave(lv);
}

function decideLeave(id, status, user) {
  const lv = repo.getLeave(id);
  if (!lv) throw err("Leave not found", 404);
  if (!["Approved", "Rejected", "Pending"].includes(status)) throw err("Invalid status", 400);
  lv.status = status;
  lv.decidedBy = (user && user.username) || "office";
  repo.putLeave(lv);
  // reflect an approved leave on the muster so payroll pays it as a leave day
  if (status === "Approved") {
    eachDate(lv.fromDate, lv.toDate).forEach((d) => {
      const existing = repo.getAttendance(lv.workerId, d);
      if (!existing || existing.source !== "device") {
        repo.putAttendance({ workerId: lv.workerId, date: d, status: "L", note: lv.type + " leave", source: "leave" });
      }
    });
  }
  return lv;
}
function deleteLeave(id) {
  if (!repo.getLeave(id)) throw err("Leave not found", 404);
  return repo.deleteLeave(id);
}

/* ============================================================
   PAYROLL — daily-wage base, configurable OT + deductions
   ============================================================ */
function ptForGross(gross, slabs) {
  const s = (slabs || []).slice().sort((a, b) => a.upTo - b.upTo).find((x) => gross <= (x.upTo == null ? Infinity : x.upTo));
  return s ? num(s.amt) : 0;
}

/** Compute one worker's payslip for a period (YYYY-MM) from attendance. */
function computeSlip(worker, period, cfg, isPaidLeaveDay) {
  const att = repo.attendanceForPeriod(period).filter((a) => a.workerId === worker.id);
  let present = 0, otHours = 0, paidLeave = 0, unpaidLeave = 0, absent = 0;
  att.forEach((a) => {
    if (a.status === "P") present += 1;
    else if (a.status === "HD") present += 0.5;
    else if (a.status === "L") {
      // honour the leave type's `paid` flag; unpaid types are excluded from payable days.
      // No resolver (e.g. computeSlip called directly) → treat as paid for back-compat.
      if (!isPaidLeaveDay || isPaidLeaveDay(a)) paidLeave += 1;
      else unpaidLeave += 1;
    } else if (a.status === "A") absent += 1;
    otHours += num(a.otHours);
  });
  const payableDays = present + paidLeave;

  let basicEarned, gross;
  if (worker.payType === "monthly") {
    const y = +period.split("-")[0], m = +period.split("-")[1];
    const daysInMonth = new Date(y, m, 0).getDate();
    let workingDays = 0;
    for (let d = 1; d <= daysInMonth; d++) if (!isWeekOff(`${y}-${pad(m)}-${pad(d)}`, cfg)) workingDays++;
    const perDay = num(worker.monthlyCtc) / (workingDays || 1);
    basicEarned = round(perDay * payableDays);
    gross = basicEarned;
  } else {
    basicEarned = round(num(worker.dailyRate) * payableDays);
    const hourly = num(worker.dailyRate) / (cfg.standardDayHours || 8);
    const otPay = round(otHours * hourly * (cfg.otMultiplier || 2));
    const allow = num((worker.allowances || 0));
    gross = round(basicEarned + otPay + allow);
    var otPayOut = otPay, allowOut = allow, hourlyOut = round(hourly);
  }

  const d = cfg.deductions || {};
  const pf = d.pf && d.pf.on ? round((num(d.pf.rate) / 100) * Math.min(basicEarned, num(d.pf.wageCapMonthly) || basicEarned)) : 0;
  const esi = d.esi && d.esi.on && gross <= num(d.esi.grossThreshold) ? round((num(d.esi.empRate) / 100) * gross) : 0;
  const pt = d.pt && d.pt.on ? ptForGross(gross, d.pt.slabs) : 0;
  const employerPf = d.pf && d.pf.on ? round((num(d.pf.employerRate || d.pf.rate) / 100) * Math.min(basicEarned, num(d.pf.wageCapMonthly) || basicEarned)) : 0;
  const employerEsi = d.esi && d.esi.on && gross <= num(d.esi.grossThreshold) ? round((num(d.esi.employerRate) / 100) * gross) : 0;

  const advances = 0;
  const net = round(gross - pf - esi - pt - advances);
  return {
    workerId: worker.id, name: worker.name, dept: worker.dept, payType: worker.payType,
    dailyRate: worker.dailyRate, present: round(present, 1), paidLeave, unpaidLeave, absent, payableDays: round(payableDays, 1),
    otHours: round(otHours), otPay: otPayOut || 0, allowances: allowOut || 0, hourly: hourlyOut || 0,
    basicEarned, gross,
    deductions: { pf, esi, pt }, employer: { pf: employerPf, esi: employerEsi }, advances, net,
  };
}

/** Generate (or regenerate) a Draft pay run for the period. */
function runPayroll(period, opts) {
  opts = opts || {};
  if (!/^\d{4}-\d{2}$/.test(period || "")) throw err("Period must be YYYY-MM", 400);
  const cfg = getConfig();
  const st = repo.getState();
  const existing = repo.getPayrun("PR-" + period);
  if (existing && existing.status === "Finalized" && !opts.force) throw err("Pay run for " + period + " is finalized", 400);
  const workers = st.hrWorkers.filter((w) => w.active !== false);

  // Resolve whether an "L" muster day is a PAID leave, honouring each leave
  // type's `paid` flag. Approved leave records are authoritative for the
  // worker+date → type mapping; fall back to parsing the muster note
  // ("<TYPE> leave", written by decideLeave); unknown/manual days stay paid.
  const leaveTypeById = {};
  (st.hrLeaveTypes || []).forEach((t) => { leaveTypeById[t.id] = t; });
  const leaveTypeByDay = {};
  (st.hrLeaves || []).forEach((l) => {
    if (l.status !== "Approved") return;
    eachDate(l.fromDate, l.toDate).forEach((d) => { leaveTypeByDay[l.workerId + "|" + d] = l.type; });
  });
  const isPaidLeaveDay = (a) => {
    let typeId = leaveTypeByDay[a.workerId + "|" + a.date];
    if (!typeId && a.note) { const m = /^(\S+)\s+leave$/.exec(String(a.note)); if (m) typeId = m[1]; }
    const t = typeId ? leaveTypeById[typeId] : null;
    return t ? t.paid !== false : true;
  };

  const slips = workers.map((w) => computeSlip(w, period, cfg, isPaidLeaveDay));
  const totals = slips.reduce((t, s) => ({ gross: t.gross + s.gross, net: t.net + s.net,
    pf: t.pf + s.deductions.pf, esi: t.esi + s.deductions.esi, pt: t.pt + s.deductions.pt }),
    { gross: 0, net: 0, pf: 0, esi: 0, pt: 0 });
  const payrunId = "PR-" + period;
  const payrun = repo.putPayrun({ id: payrunId, period, status: "Draft", generatedAt: new Date().toISOString(),
    workers: slips.length, totals: { gross: round(totals.gross), net: round(totals.net),
      pf: round(totals.pf), esi: round(totals.esi), pt: round(totals.pt) }, config: cfg });
  slips.forEach((s) => repo.putPayslip(Object.assign({ id: payrunId + ":" + s.workerId, payrunId }, s)));
  return { payrun, payslips: repo.payslipsForRun(payrunId) };
}

function finalizePayrun(id) {
  const pr = repo.getPayrun(id);
  if (!pr) throw err("Pay run not found", 404);
  pr.status = "Finalized";
  return repo.putPayrun(pr);
}
function deletePayrun(id) {
  if (!repo.getPayrun(id)) throw err("Pay run not found", 404);
  return repo.deletePayrun(id);
}
/** Adjust one payslip's advances/manual lines and recompute net. */
function updatePayslip(id, patch) {
  const [payrunId] = id.split(":");
  const pr = repo.getPayrun(payrunId);
  if (!pr) throw err("Pay run not found", 404);
  if (pr.status === "Finalized") throw err("Pay run is finalized", 400);
  const slip = repo.payslipsForRun(payrunId).find((s) => s.id === id);
  if (!slip) throw err("Payslip not found", 404);
  const advances = num((patch || {}).advances);
  slip.advances = advances;
  slip.net = round(slip.gross - slip.deductions.pf - slip.deductions.esi - slip.deductions.pt - advances);
  return repo.putPayslip(slip);
}
function payslips(payrunId) { return repo.payslipsForRun(payrunId); }

/* ============================================================
   SEED — populate demo HR data on first run (idempotent).
   Mirrors ensureCrm: only fills when the workers table is empty.
   ============================================================ */
function ensureHr() {
  if (!repo.hrIsEmpty()) return { changed: false, workers: repo.getState().hrWorkers.length };
  [["EL", "Earned Leave", 12, "earned"], ["CL", "Casual Leave", 7, "fixed"], ["SL", "Sick Leave", 7, "fixed"]]
    .forEach(([id, name, quota, accrual], i) => repo.putLeaveType({ id, name, quota, accrual, paid: true,
      color: ["#0fb5ae", "#7c5cff", "#e0a000"][i] }));
  const demo = [
    ["Ramesh Kumar", "coating", "Machine Operator", 620],
    ["Suresh Patil", "coating", "Coating Helper", 520],
    ["Lakshmi Devi", "slitting", "Slitting Operator", 560],
    ["Anil Yadav", "slitting", "Packing Helper", 500],
    ["Farida Begum", "fiberglass", "Weaving Operator", 580],
    ["Mahesh Naik", "fiberglass", "Fibre-Glass Helper", 510],
    ["Geeta Sharma", "packing", "Packing & QC", 540],
    ["Vijay Rao", "admin", "Store Keeper", 700],
  ];
  const workers = demo.map((d, i) => repo.putWorker({
    id: "EMP-" + String(1001 + i).slice(1), name: d[0], dept: d[1], designation: d[2], payType: "daily",
    dailyRate: d[3], deviceUid: String(1001 + i), active: true, joined: "2025-01-15",
    phone: "9" + (400000000 + i * 111111), shift: "General",
  }));
  const t = new Date();
  workers.forEach((w, wi) => {
    for (let back = 24; back >= 1; back--) {
      const dt = new Date(t.getFullYear(), t.getMonth(), t.getDate() - back);
      const ds = `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
      if (dt.getDay() === 0) continue;                 // Sunday weekly-off
      const k = (wi + back) % 13;
      if (k === 0) { repo.putAttendance({ workerId: w.id, date: ds, status: "A", source: "manual" }); continue; }
      const half = k === 5;
      const ot = k % 4 === 0 ? 2 : (k % 6 === 0 ? 1.5 : 0);
      const hours = half ? 4 : round(8 + ot);
      const outH = half ? 13 : 17 + Math.floor((ot * 60 + 30) / 60);
      const outM = half ? 0 : ((ot * 60 + 30) % 60);
      repo.putAttendance({ workerId: w.id, date: ds, status: half ? "HD" : "P",
        inTime: "09:00", outTime: `${pad(outH)}:${pad(outM)}`, hours, otHours: ot, source: "device" });
    }
  });
  return { changed: true, workers: workers.length };
}

module.exports = {
  getConfig, setConfig, HR_DEFAULTS, ensureHr,
  listWorkers, createWorker, updateWorker, deleteWorker,
  ingestPunch, setAttendance, recomputeAttendance, recentPunches,
  saveLeaveType, deleteLeaveType, leaveBalances, applyLeave, decideLeave, deleteLeave,
  runPayroll, finalizePayrun, deletePayrun, updatePayslip, payslips, computeSlip,
};
