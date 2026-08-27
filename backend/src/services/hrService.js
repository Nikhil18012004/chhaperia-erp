/* ============================================================
   CHHAPERIA ERP — BACKEND · Human Resources service
   Workers/labour master, biometric attendance, leave and a
   configurable monthly-salary payroll engine. Pay is MONTHLY only
   (ruling 2026-08-27): a CTC pro-rated to the days actually paid,
   plus a flat allowance for a worker who does not take a company room.

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
  // the plant houses its workers; one who stays in their OWN accommodation
  // instead is paid this much on top of salary, flat, every month (0 = off)
  noRoomAllowance: 1000,
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
async function getConfig() {
  const s = await repo.getSettings() || {};
  return deepMerge(HR_DEFAULTS, s.hr || {});
}
async function setConfig(patch) {
  const s = await repo.getSettings() || {};
  s.hr = deepMerge(await getConfig(), patch || {});
  await repo.updateSettings(s);
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
/** Pay is MONTHLY only (ruling 2026-08-27). A worker that still carries a
    daily rate — an older row, or an old import sheet — becomes a monthly
    worker at rate × 26 (the standard month the dashboard already assumes)
    unless a CTC was given. `ownAccommodation` is the opt-IN that earns the
    no-room allowance: anything but an explicit yes means "housed by us", so
    a blank column or an old record never pays money by accident. */
function normalizeWorker(w) {
  if (w.payType !== "monthly") {
    if (!num(w.monthlyCtc) && num(w.dailyRate) > 0) w.monthlyCtc = round(num(w.dailyRate) * 26);
    w.payType = "monthly";
  }
  w.dailyRate = num(w.dailyRate);
  w.monthlyCtc = num(w.monthlyCtc);
  w.ownAccommodation = w.ownAccommodation === true || /^(true|1|yes|y)$/i.test(String(w.ownAccommodation));
  return w;
}
async function listWorkers() { return (await repo.getState()).hrWorkers; }
async function createWorker(w) {
  w = w || {};
  if (!w.name) throw err("Worker needs a name", 400);
  if (!w.id) w.id = nextId((await repo.getState()).hrWorkers, "EMP-");
  else if (await repo.getWorker(w.id)) throw err("Worker " + w.id + " already exists", 409);
  if (w.deviceUid && await repo.getWorkerByDevice(w.deviceUid) && (await repo.getWorkerByDevice(w.deviceUid)).id !== w.id)
    throw err("Device id " + w.deviceUid + " is already mapped to another worker", 409);
  normalizeWorker(w);
  w.joined = w.joined || todayISO();
  return await repo.putWorker(w);
}
async function updateWorker(id, patch) {
  const existing = await repo.getWorker(id);
  if (!existing) throw err("Worker not found", 404);
  const merged = Object.assign({}, existing, patch || {}, { id });
  if (merged.deviceUid) {
    const owner = await repo.getWorkerByDevice(merged.deviceUid);
    if (owner && owner.id !== id) throw err("Device id " + merged.deviceUid + " is already mapped to " + owner.id, 409);
  }
  normalizeWorker(merged);
  return await repo.putWorker(merged);
}
async function deleteWorker(id) {
  if (!await repo.getWorker(id)) throw err("Worker not found", 404);
  return await repo.deleteWorker(id);
}

/* ============================================================
   ATTENDANCE — biometric punch ingestion + derivation
   ============================================================ */
/** Recompute one worker's daily muster row from that day's punches. */
async function recomputeAttendance(workerId, date) {
  const cfg = await getConfig();
  const punches = (await repo.punchesForDate(date)).filter((p) => p.workerId === workerId).sort((a, b) => (a.ts < b.ts ? -1 : 1));
  if (!punches.length) return null;
  const first = punches[0].ts, last = punches[punches.length - 1].ts;
  const inT = first.slice(11, 16), outT = punches.length > 1 ? last.slice(11, 16) : null;
  let hours = punches.length > 1 ? (new Date(last) - new Date(first)) / 3.6e6 : 0;
  hours = round(hours);
  const ot = Math.max(0, round(hours - cfg.standardDayHours));
  let status = "P";
  if (punches.length > 1 && hours > 0 && hours < cfg.halfDayBelowHours) status = "HD";
  return await repo.putAttendance({ workerId, date, status, inTime: inT, outTime: outT, hours, otHours: ot, source: "device" });
}

/** Ingest ONE raw biometric punch (device → server). Resolves the worker by
    device user id, stores the punch, and refreshes that day's muster. */
async function ingestPunch(body) {
  body = body || {};
  const deviceUid = String(body.deviceUid || body.userId || body.uid || body.pin || "").trim();
  if (!deviceUid) throw err("Punch needs a device user id (deviceUid)", 400);
  const rawTs = body.ts || body.time || new Date().toISOString();
  if (isNaN(new Date(rawTs).getTime())) throw err("Punch has an invalid timestamp", 400);
  const ts = normalizeTs(rawTs, await getConfig());   // store factory-local wall-clock
  const worker = await repo.getWorkerByDevice(deviceUid);
  const punch = await repo.addPunch({
    id: rid("PN"), workerId: worker ? worker.id : null, deviceUid, ts,
    direction: body.direction || body.state || "auto", deviceId: body.deviceId || body.sn || null,
    source: body.source || "device",
  });
  let attendance = null;
  if (worker) attendance = await recomputeAttendance(worker.id, ts.slice(0, 10));
  return { ok: true, matched: !!worker, workerId: worker ? worker.id : null, punch, attendance };
}

/** Manual muster entry / correction (HR desk). */
async function setAttendance(a) {
  a = a || {};
  if (!a.workerId || !a.date) throw err("Attendance needs workerId and date", 400);
  if (!await repo.getWorker(a.workerId)) throw err("Unknown worker " + a.workerId, 400);
  let hours = num(a.hours), ot = num(a.otHours);
  if (!hours && a.inTime && a.outTime) {
    hours = round((new Date(a.date + "T" + a.outTime) - new Date(a.date + "T" + a.inTime)) / 3.6e6);
    ot = Math.max(0, round(hours - (await getConfig()).standardDayHours));
  }
  return await repo.putAttendance({ workerId: a.workerId, date: a.date, status: a.status || "P",
    inTime: a.inTime || null, outTime: a.outTime || null, hours, otHours: ot, note: a.note || null, source: "manual" });
}

async function recentPunches(limit) { return await repo.recentPunches(limit || 100); }

/* ============================================================
   LEAVE — configurable types, apply / approve, live balances
   ============================================================ */
async function saveLeaveType(t) {
  if (!t || !t.id) throw err("Leave type needs an id/code", 400);
  return await repo.putLeaveType(Object.assign({ name: t.id }, t));
}
async function deleteLeaveType(id) { return await repo.deleteLeaveType(id); }

function daysBetween(from, to) { return eachDate(from, to).length; }

/** How many days an "earned" leave type has accrued this year: ONE DAY PER
    MONTH WORKED. A month counts once the worker has any attendance in it, so
    a worker who joined in June earns from June — twelve days over a full
    year. Keep this in step with paidLeavePending() in frontend/js/mod-hr.js,
    which shows the same figure on the payslip. */
function earnedLeaveDays(attendance, workerId, year) {
  const months = new Set();
  attendance.forEach((a) => {
    if (a.workerId !== workerId) return;
    if (!String(a.date || "").startsWith(year)) return;
    if (a.status !== "P" && a.status !== "HD") return;
    months.add(String(a.date).slice(0, 7));   // YYYY-MM
  });
  return months.size;
}

/** Live leave balances for a worker: quota (or earned) − approved-this-year. */
async function leaveBalances(workerId) {
  const st = await repo.getState();
  const year = String(new Date().getFullYear());
  const earned = earnedLeaveDays(st.hrAttendance || [], workerId, year);
  return (st.hrLeaveTypes || []).map((t) => {
    const entitled = t.accrual === "earned" ? earned : (t.accrual === "none" ? 0 : t.quota);
    const taken = st.hrLeaves.filter((l) => l.workerId === workerId && l.type === t.id && l.status === "Approved" && l.fromDate.startsWith(year))
      .reduce((s, l) => s + (l.days || 0), 0);
    return { type: t.id, name: t.name, entitled, taken, balance: round(entitled - taken, 1) };
  });
}

async function applyLeave(l) {
  l = l || {};
  if (!l.workerId || !await repo.getWorker(l.workerId)) throw err("Unknown worker", 400);
  if (!l.type || !await repo.getLeaveType(l.type)) throw err("Unknown leave type", 400);
  if (!l.fromDate || !l.toDate) throw err("Leave needs from and to dates", 400);
  if (l.toDate < l.fromDate) throw err("End date is before start date", 400);
  const days = l.days != null ? num(l.days) : daysBetween(l.fromDate, l.toDate);
  const lv = { id: l.id || nextId((await repo.getState()).hrLeaves, "LV-"), workerId: l.workerId, type: l.type,
    fromDate: l.fromDate, toDate: l.toDate, days, status: l.status || "Pending",
    reason: l.reason || null, appliedOn: l.appliedOn || todayISO() };
  return await repo.putLeave(lv);
}

async function decideLeave(id, status, user) {
  const lv = await repo.getLeave(id);
  if (!lv) throw err("Leave not found", 404);
  if (!["Approved", "Rejected", "Pending"].includes(status)) throw err("Invalid status", 400);
  lv.status = status;
  lv.decidedBy = (user && user.username) || "office";
  await repo.putLeave(lv);
  // reflect an approved leave on the muster so payroll pays it as a leave day
  if (status === "Approved") {
    for (const d of eachDate(lv.fromDate, lv.toDate)) {
      const existing = await repo.getAttendance(lv.workerId, d);
      if (!existing || existing.source !== "device") {
        await repo.putAttendance({ workerId: lv.workerId, date: d, status: "L", note: lv.type + " leave", source: "leave" });
      }
    }
  }
  return lv;
}
async function deleteLeave(id) {
  if (!await repo.getLeave(id)) throw err("Leave not found", 404);
  return await repo.deleteLeave(id);
}

/* ============================================================
   PAYROLL — daily-wage base, configurable OT + deductions
   ============================================================ */
function ptForGross(gross, slabs) {
  const s = (slabs || []).slice().sort((a, b) => a.upTo - b.upTo).find((x) => gross <= (x.upTo == null ? Infinity : x.upTo));
  return s ? num(s.amt) : 0;
}

/* ============================================================
   ADVANCES — money paid to a worker up front and recovered from
   later payslips in fixed monthly instalments.

   It lives on the worker as
     advance: { amount, monthly, note, startPeriod, startedOn }
   and what has already been recovered is DERIVED from finalised
   payslips rather than stored. That matters: a Draft pay run can
   be re-run any number of times, and deriving the balance means a
   re-run can never double-count a recovery the way a running
   counter would.
   ============================================================ */
function advanceOf(worker) {
  const a = worker && worker.advance;
  if (!a) return null;
  const amount = round(num(a.amount));
  if (amount <= 0) return null;
  return { amount, monthly: round(num(a.monthly)), note: a.note || "",
    startPeriod: a.startPeriod || null, startedOn: a.startedOn || null };
}

/** Recovered so far — counted ONLY from FINALISED runs, and never from the
    period being computed (that instalment is what we are working out). */
async function advanceRecovered(workerId, exceptPeriod, st) {
  st = st || await repo.getState();
  const finalised = {};
  (st.hrPayruns || []).forEach((pr) => {
    if (pr.status === "Finalized" && pr.period !== exceptPeriod) finalised[pr.id] = true;
  });
  return round((st.hrPayslips || []).reduce((sum, s) =>
    (finalised[s.payrunId] && s.workerId === workerId ? sum + num(s.advances) : sum), 0));
}

/** What this period should recover from a worker, and the balance either side.
    The last instalment is trimmed to whatever is still outstanding, so an
    advance is never over-recovered. */
async function advanceForPeriod(worker, period, st) {
  const adv = advanceOf(worker);
  if (!adv) return null;
  if (adv.startPeriod && period < adv.startPeriod) return null;   // not started yet
  const recovered = await advanceRecovered(worker.id, period, st);
  const opening = round(Math.max(0, adv.amount - recovered));
  if (opening <= 0) return { amount: adv.amount, opening: 0, instalment: 0, closing: 0, cleared: true };
  const instalment = round(Math.min(adv.monthly > 0 ? adv.monthly : opening, opening));
  return { amount: adv.amount, opening, instalment, closing: round(opening - instalment), cleared: false };
}

/** Set / clear a worker's advance. `null` (or a zero amount) clears it. */
async function setAdvance(workerId, body) {
  const w = await repo.getWorker(workerId);
  if (!w) throw err("Worker not found", 404);
  body = body || {};
  const amount = round(num(body.amount));
  if (!amount) { delete w.advance; return await repo.putWorker(w); }
  if (amount < 0) throw err("Advance amount cannot be negative", 400);
  const monthly = round(num(body.monthly));
  if (monthly < 0) throw err("Monthly deduction cannot be negative", 400);
  if (monthly > amount) throw err("Monthly deduction cannot exceed the advance itself", 400);
  if (body.startPeriod && !/^\d{4}-\d{2}$/.test(body.startPeriod)) throw err("Recovery start must be YYYY-MM", 400);
  w.advance = { amount, monthly, note: String(body.note || "").slice(0, 200),
    startPeriod: body.startPeriod || null,
    startedOn: (w.advance && w.advance.startedOn) || todayISO() };
  return await repo.putWorker(w);
}

/** A worker's advance with its live balance — what the UI shows. */
async function advanceStatus(workerId) {
  const w = await repo.getWorker(workerId);
  if (!w) throw err("Worker not found", 404);
  const adv = advanceOf(w);
  if (!adv) return { workerId, name: w.name, advance: null };
  const recovered = await advanceRecovered(workerId, null);
  return { workerId, name: w.name,
    advance: Object.assign({}, adv, { recovered, outstanding: round(Math.max(0, adv.amount - recovered)) }) };
}

/** Compute one worker's payslip for a period (YYYY-MM) from attendance. */
async function computeSlip(worker, period, cfg, isPaidLeaveDay, advance) {
  const att = (await repo.attendanceForPeriod(period)).filter((a) => a.workerId === worker.id);
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

  // Everyone is on a monthly salary: the CTC becomes a per-day rate over the
  // calendar month less its week-offs (Sundays by default — so a 31-day month
  // with 5 Sundays is 26 working days, a 30-day with 4 is 26, etc.) and is
  // paid for the days actually present or on paid leave. The payslip shows
  // "Monthly ₹X · ₹Y/day (Z working days) × N paid days". A row that still
  // carries a daily rate is read through the same rule as every write path.
  worker = normalizeWorker(Object.assign({}, worker));
  const y = +period.split("-")[0], m = +period.split("-")[1];
  const daysInMonth = new Date(y, m, 0).getDate();
  let monthWorkingDays = 0;
  for (let d = 1; d <= daysInMonth; d++) if (!isWeekOff(`${y}-${pad(m)}-${pad(d)}`, cfg)) monthWorkingDays++;
  const monthPerDay = round(num(worker.monthlyCtc) / (monthWorkingDays || 1));
  const basicEarned = round(monthPerDay * payableDays);
  // The no-room allowance: the plant houses its workers, and one who stays in
  // their own accommodation is paid a flat sum on top every month — but not
  // for a month in which they were not paid for a single day. It is part of
  // gross (so ESI sees it) but not of basic (so PF does not).
  const roomAllowance = worker.ownAccommodation && payableDays > 0 ? round(num(cfg.noRoomAllowance)) : 0;
  const allowances = num(worker.allowances);
  const gross = round(basicEarned + roomAllowance + allowances);

  const d = cfg.deductions || {};
  const pf = d.pf && d.pf.on ? round((num(d.pf.rate) / 100) * Math.min(basicEarned, num(d.pf.wageCapMonthly) || basicEarned)) : 0;
  const esi = d.esi && d.esi.on && gross <= num(d.esi.grossThreshold) ? round((num(d.esi.empRate) / 100) * gross) : 0;
  const pt = d.pt && d.pt.on ? ptForGross(gross, d.pt.slabs) : 0;
  const employerPf = d.pf && d.pf.on ? round((num(d.pf.employerRate || d.pf.rate) / 100) * Math.min(basicEarned, num(d.pf.wageCapMonthly) || basicEarned)) : 0;
  const employerEsi = d.esi && d.esi.on && gross <= num(d.esi.grossThreshold) ? round((num(d.esi.employerRate) / 100) * gross) : 0;

  // this month's advance instalment, if the worker is carrying one
  const advances = advance ? advance.instalment : 0;
  const net = round(gross - pf - esi - pt - advances);
  return {
    workerId: worker.id, name: worker.name, dept: worker.dept, payType: worker.payType,
    dailyRate: worker.dailyRate, monthlyCtc: num(worker.monthlyCtc), monthWorkingDays, monthPerDay,
    ownAccommodation: worker.ownAccommodation, roomAllowance,
    present: round(present, 1), paidLeave, unpaidLeave, absent, payableDays: round(payableDays, 1),
    otHours: round(otHours), otPay: 0, allowances, hourly: 0,
    basicEarned, gross,
    deductions: { pf, esi, pt }, employer: { pf: employerPf, esi: employerEsi }, advances, net,
    // the balance either side of this recovery, so the payslip can show it
    advance: advance ? { total: advance.amount, opening: advance.opening, closing: advance.closing } : null,
  };
}

/** Generate (or regenerate) a Draft pay run for the period. */
async function runPayroll(period, opts) {
  opts = opts || {};
  if (!/^\d{4}-\d{2}$/.test(period || "")) throw err("Period must be YYYY-MM", 400);
  const cfg = await getConfig();
  const st = await repo.getState();
  const existing = await repo.getPayrun("PR-" + period);
  /* ⚠ NO `force` ESCAPE HERE. `opts` is the request body, so a finalized pay
     run used to be reopened by anyone who put {"force":true} in it — and a
     re-run writes the row back as a Draft, quietly un-finalizing sealed wages.
     That is not only an audit problem: advance recovery counts instalments
     only from FINALIZED runs, so a run that slips back to draft lets the same
     instalment be taken off a worker twice. Reopening is now a deliberate,
     separate act — see reopenPayrun below. */
  if (existing && existing.status === "Finalized") {
    throw err("Pay run for " + period + " is finalized. Reopen it first if it genuinely "
      + "has to be recalculated — that is recorded against the run.", 409);
  }
  /* Payroll normally covers every active worker. `workerIds` narrows it to a
     chosen few — the clerk who settles the coating floor today and the rest on
     Friday. An explicit pick outranks the active filter, so someone who has
     since left can still be given a final payslip. */
  const asked = Array.isArray(opts.workerIds)
    ? opts.workerIds.map(String).filter((id, i, a) => id && a.indexOf(id) === i) : null;
  let workers;
  if (asked && asked.length) {
    const byId = {};
    (st.hrWorkers || []).forEach((w) => { byId[w.id] = w; });
    const unknown = asked.filter((id) => !byId[id]);
    if (unknown.length) throw err("Unknown worker: " + unknown.join(", "), 400);
    workers = asked.map((id) => byId[id]);
  } else {
    workers = (st.hrWorkers || []).filter((w) => w.active !== false);
  }
  if (!workers.length) throw err("No workers to pay", 400);

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

  /* One worker at a time. .map() with an async callback yields promises, and
     every total below would be computed from those instead of from wages. */
  const slips = [];
  for (const w of workers)
    slips.push(await computeSlip(w, period, cfg, isPaidLeaveDay,
      await advanceForPeriod(w, period, st)));
  const payrunId = "PR-" + period;
  /* A run for a few people must not wipe the payslips already made for this
     month, and the header has to agree with the list under it — so the totals
     cover EVERY slip in the run, not just the ones recomputed just now. Slips
     edited by hand keep their adjusted figures. */
  const merged = {};
  (await repo.payslipsForRun(payrunId)).forEach((s) => { merged[s.workerId] = s; });
  slips.forEach((s) => { merged[s.workerId] = s; });
  const allSlips = Object.keys(merged).map((k) => merged[k]);
  const totals = allSlips.reduce((t, s) => { const d = s.deductions || {};
    return { gross: t.gross + num(s.gross), net: t.net + num(s.net),
      pf: t.pf + num(d.pf), esi: t.esi + num(d.esi), pt: t.pt + num(d.pt),
      advances: t.advances + num(s.advances) }; },
    { gross: 0, net: 0, pf: 0, esi: 0, pt: 0, advances: 0 });
  const payrun = await repo.putPayrun({ id: payrunId, period, status: "Draft", generatedAt: new Date().toISOString(),
    workers: allSlips.length, totals: { gross: round(totals.gross), net: round(totals.net),
      pf: round(totals.pf), esi: round(totals.esi), pt: round(totals.pt),
      advances: round(totals.advances) }, config: cfg });
  for (const s of slips) await repo.putPayslip(Object.assign({ id: payrunId + ":" + s.workerId, payrunId }, s));
  return { payrun, payslips: await repo.payslipsForRun(payrunId) };
}

async function finalizePayrun(id) {
  const pr = await repo.getPayrun(id);
  if (!pr) throw err("Pay run not found", 404);
  pr.status = "Finalized";
  return await repo.putPayrun(pr);
}
/* The deliberate way back out of Finalized. Separate from runPayroll so it can
   never be a side effect of a flag in a request body, and it records who
   reopened it and when — the run's own history of having been sealed once. */
async function reopenPayrun(id, user, reason) {
  const pr = await repo.getPayrun(id);
  if (!pr) throw err("Pay run not found", 404);
  if (pr.status !== "Finalized") throw err("Pay run " + id + " is not finalized", 400);
  pr.status = "Draft";
  pr.reopenedAt = new Date().toISOString();
  pr.reopenedBy = (user && user.username) || "";
  pr.reopenReason = reason ? String(reason).slice(0, 300) : "";
  return await repo.putPayrun(pr);
}
async function deletePayrun(id) {
  const pr = await repo.getPayrun(id);
  if (!pr) throw err("Pay run not found", 404);
  /* Deleting a pay run takes its payslips with it. A finalized run is wages
     that have been signed off, so it is not something to remove on a whim. */
  if (pr.status === "Finalized") {
    throw err("Pay run " + id + " is finalized and cannot be deleted. Reopen it first if it "
      + "really has to go.", 409);
  }
  return await repo.deletePayrun(id);
}
/** Adjust one payslip's advances/manual lines and recompute net.
    A one-month override of the standing instalment: it may not recover more
    than the worker still owes, and the closing balance follows it. */
async function updatePayslip(id, patch) {
  const [payrunId] = id.split(":");
  const pr = await repo.getPayrun(payrunId);
  if (!pr) throw err("Pay run not found", 404);
  if (pr.status === "Finalized") throw err("Pay run is finalized", 400);
  const slip = (await repo.payslipsForRun(payrunId)).find((s) => s.id === id);
  if (!slip) throw err("Payslip not found", 404);
  let advances = round(num((patch || {}).advances));
  if (advances < 0) throw err("A deduction cannot be negative", 400);
  const st = await repo.getState();
  const worker = (st.hrWorkers || []).find((w) => w.id === slip.workerId);
  const plan = worker ? await advanceForPeriod(worker, pr.period, st) : null;
  if (plan) {
    if (advances > plan.opening) throw err("Only " + plan.opening + " is still outstanding on this advance", 400);
    slip.advance = { total: plan.amount, opening: plan.opening, closing: round(plan.opening - advances) };
  }
  slip.advances = advances;
  slip.net = round(slip.gross - slip.deductions.pf - slip.deductions.esi - slip.deductions.pt - advances);
  return await repo.putPayslip(slip);
}
async function payslips(payrunId) { return await repo.payslipsForRun(payrunId); }

/* ============================================================
   SEED — populate demo HR data on first run (idempotent).
   Mirrors ensureCrm: only fills when the workers table is empty.
   ============================================================ */
/** Every worker is paid monthly since 2026-08-27. Rows written before that
    still say "daily": move each one across (rate × 26 becomes the CTC unless
    one was already set) so payroll never silently pays a ₹0 salary. Runs at
    boot, touches only the rows that need it, so it is a no-op thereafter. */
async function migrateToMonthly() {
  const stale = ((await repo.getState()).hrWorkers || []).filter((w) => w.payType !== "monthly");
  for (const w of stale) await repo.putWorker(normalizeWorker(w));
  return stale.length;
}

async function ensureHr() {
  const moved = await migrateToMonthly();
  if (!await repo.hrIsEmpty()) return { changed: false, moved, workers: (await repo.getState()).hrWorkers.length };
  const LEAVE_SEED = [["EL", "Earned Leave", 12, "earned"], ["CL", "Casual Leave", 7, "fixed"],
    ["SL", "Sick Leave", 7, "fixed"]];
  for (let i = 0; i < LEAVE_SEED.length; i++) {
    const [id, name, quota, accrual] = LEAVE_SEED[i];
    await repo.putLeaveType({ id, name, quota, accrual, paid: true,
      color: ["#0fb5ae", "#7c5cff", "#e0a000"][i] });
  }
  // [name, dept, designation, monthly CTC, stays in own accommodation?]
  const demo = [
    ["Ramesh Kumar", "coating", "Machine Operator", 16000, false],
    ["Suresh Patil", "coating", "Coating Helper", 13500, false],
    ["Lakshmi Devi", "slitting", "Slitting Operator", 14500, true],
    ["Anil Yadav", "slitting", "Packing Helper", 13000, false],
    ["Farida Begum", "fiberglass", "Weaving Operator", 15000, false],
    ["Mahesh Naik", "fiberglass", "Fibre-Glass Helper", 13500, false],
    ["Geeta Sharma", "packing", "Packing & QC", 14000, true],
    ["Vijay Rao", "admin", "Store Keeper", 18000, false],
  ];
  /* .map() would collect promises, not workers. Built one at a time so each
     row is written — and awaited — before the next. */
  const workers = [];
  for (let i = 0; i < demo.length; i++) {
    const d = demo[i];
    workers.push(await repo.putWorker({
      id: "EMP-" + String(1001 + i).slice(1), name: d[0], dept: d[1], designation: d[2], payType: "monthly",
      monthlyCtc: d[3], ownAccommodation: d[4], deviceUid: String(1001 + i), active: true, joined: "2025-01-15",
      phone: "9" + (400000000 + i * 111111), shift: "General",
    }));
  }
  const t = new Date();
  for (let wi = 0; wi < workers.length; wi++) {
    const w = workers[wi];
    for (let back = 24; back >= 1; back--) {
      const dt = new Date(t.getFullYear(), t.getMonth(), t.getDate() - back);
      const ds = `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
      if (dt.getDay() === 0) continue;                 // Sunday weekly-off
      const k = (wi + back) % 13;
      if (k === 0) { await repo.putAttendance({ workerId: w.id, date: ds, status: "A", source: "manual" }); continue; }
      const half = k === 5;
      const ot = k % 4 === 0 ? 2 : (k % 6 === 0 ? 1.5 : 0);
      const hours = half ? 4 : round(8 + ot);
      const outH = half ? 13 : 17 + Math.floor((ot * 60 + 30) / 60);
      const outM = half ? 0 : ((ot * 60 + 30) % 60);
      await repo.putAttendance({ workerId: w.id, date: ds, status: half ? "HD" : "P",
        inTime: "09:00", outTime: `${pad(outH)}:${pad(outM)}`, hours, otHours: ot, source: "device" });
    }
  }
  return { changed: true, moved, workers: workers.length };
}

module.exports = {
  getConfig, setConfig, HR_DEFAULTS, ensureHr, normalizeWorker, migrateToMonthly,
  listWorkers, createWorker, updateWorker, deleteWorker,
  ingestPunch, setAttendance, recomputeAttendance, recentPunches,
  saveLeaveType, deleteLeaveType, leaveBalances, applyLeave, decideLeave, deleteLeave,
  runPayroll, finalizePayrun, reopenPayrun, deletePayrun, updatePayslip, payslips, computeSlip,
  setAdvance, advanceStatus, advanceForPeriod,
};
