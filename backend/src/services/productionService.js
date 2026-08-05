/* ============================================================
   CHHAPERIA ERP — BACKEND · production service (stage engine)
   Supervisor-facing write operations. Security model:
     • a supervisor may ONLY act on a work order whose CURRENT
       stage belongs to their area
     • only safe stage transitions are allowed
     • no money/customer fields are ever returned
   Completing a stage hands the job to the next area's panel and (for
   non-legacy work orders) issues that stage's materials from the store.
   No stage ever receives stock — not coating, slitting or packing.
   Writes are
   TARGETED (one WO row + appended movements) — no full-state
   rewrite, so panels no longer clobber each other.
   ============================================================ */
"use strict";
const repo = require("../db/repository");
const { buildSeed } = require("../seed/seed");
const S = require("./stageService");
const LAB = require("./labService");
const { getLineForItem } = require("./routing");
const BC = require("../../../frontend/js/bomcalc");

const ACTIONS = ["start", "pause", "complete", "dispatch"];

// The raw-material store the BOM draws down when finished stock is produced.
const RAW_STORE = "WH-PNY";

function err(msg, status) { const e = new Error(msg); e.status = status || 400; return e; }

let _mvSeq = 0;
function mvId() { return "MV-" + Date.now().toString(36).toUpperCase() + "-" + (++_mvSeq).toString(36).toUpperCase(); }
const r2 = (n) => Math.round((+n || 0) * 100) / 100;
const r3 = (n) => Math.round((+n || 0) * 1000) / 1000;

function fullState() {
  if (repo.isEmpty()) repo.saveState(buildSeed());
  return repo.getState();
}

function todayISO() {
  const x = new Date();
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
}

const calcProgress = S.calcProgress; // single source of truth (stageService)

/** Ensure a WO has a route (bridges any WO that predates the stage model). */
function withRoute(wo, data) {
  if (!wo.route || !wo.route.length) {
    const seeded = S.seedRouteFromLegacy(wo, data);
    wo.route = seeded.route; wo.stageIdx = seeded.stageIdx; wo.legacy = seeded.legacy;
  }
  return wo;
}

/* ============================================================
   advance — move a work order's CURRENT stage.
   action: start | pause | complete | dispatch
   ============================================================ */
function advance(user, woId, action, opts) {
  if (!user) throw err("Not authenticated", 401);
  opts = opts || {};
  const isOffice = user.role === "admin" || user.role === "office";
  if (!isOffice && user.role !== "supervisor") throw err("Forbidden", 403);
  if (!ACTIONS.includes(action)) throw err("Invalid action '" + action + "'", 400);

  const data = fullState();                       // read-only context (items, boms)
  const itemsById = Object.fromEntries((data.items || []).map((i) => [i.id, i]));

  const found = repo.getWorkOrder(woId);
  if (!found || !found.id) throw err("Work order not found", 404);
  const wo = withRoute(found, data);

  const route = wo.route;
  const idx = Math.min(Math.max(wo.stageIdx || 0, 0), route.length - 1);
  const stage = route[idx];

  // supervisors are locked to the stage currently in their area
  // (fibre-glass supervisors also cover the slitting/dispatch pool)
  if (!isOffice && user.area !== "all" && !S.areaCovers(user.area, stage.area)) {
    throw err("This job is at the “" + stage.name + "” stage — not your work area", 403);
  }

  const now = new Date().toISOString();
  const by = user.username;

  if (action === "dispatch") {
    if (!route.every((r) => r.status === "Completed")) throw err("Finish packing before dispatch", 400);
    /* A partial order ships what it HAS made. The goods on the floor are real
       whether or not the balance has arrived, so dispatch releases the made
       quantity and the order stays open for the rest. Only an order with
       nothing pending is closed outright. */
    const madeNow = r3((+wo.completedQty || 0) + (+wo.runQty || 0));
    const already = +wo.dispatchedQty || 0;
    if (madeNow - already <= 1e-6) throw err("Nothing new to dispatch on this order", 400);
    wo.dispatchedQty = madeNow;
    wo.dispatchedBy = by; wo.dispatchedAt = now;
    if ((+wo.pendingQty || 0) <= 1e-6) wo.dispatched = true;
  } else if (action === "start") {
    if (stage.status === "Completed") throw err("This stage is already completed", 400);
    stage.status = "In Production";
    stage.startedBy = stage.startedBy || by;
    stage.startedAt = stage.startedAt || now;
  } else if (action === "pause") {
    if (stage.status === "Completed") throw err("Cannot pause a completed stage", 400);
    stage.status = "Pending";
  } else if (action === "complete") {
    if (stage.status === "Completed") throw err("This stage is already completed", 400);
    /* A COATED BATCH IS NOT FINISHED UNTIL IT HAS BEEN MEASURED.
       The supervisor who ran the coating records the reading against this
       work order — its number IS the batch number — and only then can the
       stage be closed and the job handed on. Enforced here rather than in
       the browser, so no panel and no direct API call can walk past it. */
    if (stage.area === "coating") {
      const gate = LAB.coatingGate(wo, data);
      if (!gate.ok) { const e = err(gate.message, 409); e.labGate = gate; throw e; }
    }
    /* WHERE THE COATED ROLL IS PUT DOWN.
       The jumbo coming off coating is not booked into stock — no stage books
       anything in — but it is a physical roll that the slitting floor has to
       go and find. So the supervisor closing coating names the store it is
       carried to, and that travels with the job to the next stage's board.
       It records a LOCATION, never a movement: no quantity enters any store.

       Required, and required here rather than in the browser, so no panel and
       no direct API call can close coating without saying where the roll went.
       Only asked when a stage follows — nobody is waiting on a roll that the
       coating stage is the last to touch. */
    if (stage.area === "coating" && idx < route.length - 1) {
      const want = String(opts.wipWh == null ? "" : opts.wipWh).trim();
      if (!want) {
        const e = err("Choose the store the coated roll is going to — slitting is told where to fetch it", 409);
        e.needsWipWh = true;
        throw e;
      }
      const wh = (data.warehouses || []).find((w) => w.id === want);
      if (!wh) throw err("Unknown store '" + want + "'", 400);
      stage.outWh = wh.id; stage.outWhBy = by; stage.outWhAt = now;
    }
    // post this stage's stock movements (skip for legacy WOs — old flow already did)
    if (!wo.legacy && !stage.posted) {
      // only the portion actually on the floor draws material
      const runQ = wo.runQty != null ? wo.runQty : wo.qty;
      const plan = S.computeStagePlan(wo.itemId, runQ, data, wo.materialChoices, wo.plan);
      if (plan && plan[stage.key]) {
        const moves = S.stageMovements(plan, stage.key, wo, itemsById, by, todayISO(), data.movements);
        if (moves.length) repo.addMovements(moves);
      }
      stage.posted = true;
    }
    /* A stage finished without ever being started — "Complete all" does this —
       had no measurable time. Stamp the start now so the duration is a real
       zero rather than an unknown, and every stage has a bounded span. */
    if (!stage.startedAt) { stage.startedAt = now; stage.startedBy = stage.startedBy || by; }
    stage.status = "Completed"; stage.doneBy = by; stage.doneAt = now;
    // hand off to the next stage (next area's panel picks it up)
    if (idx < route.length - 1) wo.stageIdx = idx + 1;
    else wo.packedAt = now;
  }

  wo.progress = calcProgress(route);
  wo.status = S.rollupStatus(wo);   // reports Partial while quantity is owed
  wo.updatedBy = by; wo.updatedAt = now;
  repo.putWorkOrder(wo);

  return summarize(wo, data);
}

/* ============================================================
   setWipStore — say where a coated roll was put down, for a stage
   that closed without being asked.

   WRITE ONCE. A store already recorded is never changed: the note is a
   statement of where the roll was carried as it came off the line, and
   letting it be rewritten later would leave slitting reading a location
   nobody can vouch for. What it DOES allow is filling in a blank — every
   batch coated before the question was asked, which is otherwise stuck
   telling the next floor "not recorded" for good.

   Like the gate itself, this records a LOCATION and posts no movement:
   nothing is booked into the store named.
   ============================================================ */
function setWipStore(user, woId, body) {
  if (!user) throw err("Not authenticated", 401);
  const isOffice = user.role === "admin" || user.role === "office";
  if (!isOffice && user.role !== "supervisor") throw err("Forbidden", 403);
  body = body || {};
  const data = fullState();
  const found = repo.getWorkOrder(woId);
  if (!found || !found.id) throw err("Work order not found", 404);
  const wo = withRoute(found, data);

  const stage = (wo.route || []).find((r) => r.area === "coating");
  if (!stage) throw err("This job does not pass through coating", 400);
  // the floor that coated it is the one that knows where it went
  if (!isOffice && user.area !== "all" && !S.areaCovers(user.area, stage.area)) {
    throw err("Only the coating floor can say where the coated roll was left", 403);
  }
  if (stage.status !== "Completed") {
    throw err("The store is chosen as coating is completed", 400);
  }
  if (stage.outWh) throw err("The store for this roll is already recorded as " + stage.outWh, 409);

  const want = String(body.wh == null ? "" : body.wh).trim();
  if (!want) throw err("Choose the store the coated roll was left in", 400);
  const wh = (data.warehouses || []).find((w) => w.id === want);
  if (!wh) throw err("Unknown store '" + want + "'", 400);

  const now = new Date().toISOString();
  stage.outWh = wh.id; stage.outWhBy = user.username; stage.outWhAt = now;
  wo.updatedBy = user.username; wo.updatedAt = now;
  repo.putWorkOrder(wo);
  return summarize(wo, data);
}

/* ============================================================
   resumeWorkOrder — the office puts a pending balance back on the floor.
   Pending material is never reserved: stock that arrives is free for any
   order until somebody resumes THIS one, which issues it there and then.
   That is why the check and the issue happen together, in one step.
   ============================================================ */
function resumeWorkOrder(user, id, body) {
  if (!user) throw err("Not authenticated", 401);
  if (user.role !== "admin" && user.role !== "office") throw err("Only the office can resume a pending order", 403);
  body = body || {};
  const data = fullState();
  const wo = (data.workorders || []).find((w) => w.id === id);
  if (!wo) throw err("Work order not found", 404);
  if (wo.dispatched) throw err("This order has been dispatched", 400);
  const pending = +wo.pendingQty || 0;
  if (pending <= 1e-6) throw err("Nothing is pending on this work order", 400);
  /* The portion already released has to be off the machines first. Judge that
     by the ROUTE, not by wo.status — a finished partial run reads "Partial",
     which is precisely the state resume exists to move on from. */
  const runDone = (wo.route || []).length > 0 && (wo.route || []).every((r) => r.status === "Completed");
  if ((+wo.runQty || 0) > 1e-6 && !runDone) {
    throw err("Finish the quantity already on the floor before resuming the balance", 400);
  }
  const item = (data.items || []).find((i) => i.id === wo.itemId);
  if (!item) throw err("Unknown product", 400);

  // how much of the balance the store can cover NOW
  const cap = maxMakeable(data, item, wo.materialChoices);
  const want = body.qty != null ? +body.qty : pending;
  if (!(want > 0)) throw err("Enter a valid quantity", 400);
  if (want > pending + 1e-6) throw err("Only " + pending + " is pending on this order", 400);
  /* Release whatever the store CAN cover and leave the rest pending — a part
     delivery should put part of the job back on the floor, not be refused
     until the whole balance has arrived. Only a store that can make nothing
     at all is an error. */
  const canDo = isFinite(cap) ? Math.floor(cap * 1000) / 1000 : want;
  const take = Math.round(Math.min(want, Math.max(0, canDo)) * 1000) / 1000;
  if (!(take > 1e-6)) {
    const e = err("The store still has nothing this job can be made from.", 409);
    e.shortage = shortageFor(data, item, want, wo.materialChoices);
    e.canMake = 0;
    throw e;
  }

  // issue this portion's raw material now, then hand the run to the floor
  const itemsById = Object.fromEntries((data.items || []).map((i) => [i.id, i]));
  const net = { qty: take, fgQty: 0, wipQty: 0, makeQty: take, fgSources: [], wipSources: [] };
  const stagePlan = S.computeStagePlan(wo.itemId, take, data, wo.materialChoices, net);
  const moves = [];
  if (stagePlan) {
    (wo.route || []).forEach((r) => {
      if (!stagePlan[r.key]) return;
      S.stageMovements(stagePlan, r.key, wo, itemsById, user.username, todayISO(), data.movements)
        .forEach((m) => moves.push(m));
    });
  }
  if (moves.length) repo.addMovements(moves);

  wo.completedQty = Math.round(((+wo.completedQty || 0) + (+wo.runQty || 0)) * 1000) / 1000;
  wo.runQty = take;
  wo.pendingQty = Math.round((pending - take) * 1000) / 1000;
  if (wo.pendingQty <= 1e-6) { wo.pendingQty = 0; delete wo.shortage; delete wo.pendingSince; }
  else { wo.shortage = shortageFor(data, item, wo.pendingQty, wo.materialChoices); wo.pendingSince = todayISO(); }
  /* The route runs again for this portion, so its timestamps are cleared —
     but the time the floor spent on the LAST run is real and must not vanish
     with them. Bank each stage's elapsed time and the number of runs, so the
     Time Status tab can report the total across every batch of the order. */
  (wo.route || []).forEach((r) => {
    if (r.startedAt && r.doneAt) {
      const ms = Date.parse(r.doneAt) - Date.parse(r.startedAt);
      if (isFinite(ms) && ms > 0) r.priorMs = (+r.priorMs || 0) + ms;
    }
    if (r.status === "Completed") r.runs = (+r.runs || 0) + 1;
    if (r.startedAt && !r.firstStartedAt) r.firstStartedAt = r.startedAt;
    r.status = "Pending"; r.posted = true;
    delete r.doneBy; delete r.doneAt; delete r.startedBy; delete r.startedAt;
  });
  wo.stageIdx = 0;
  wo.resumedBy = user.username; wo.resumedAt = new Date().toISOString();
  wo.progress = 0;
  wo.status = S.rollupStatus(wo);
  repo.putWorkOrder(wo);
  return summarize(wo, data);
}

/* Complete every remaining stage in ONE request.
   "Complete all" used to fire a separate HTTP call per stage from the browser
   — six round trips, each re-reading the whole dataset and re-checking the
   same permissions. The loop belongs on this side of the wire. Each pass goes
   through the ordinary advance(), so not one stage rule is duplicated or
   skipped, and a stage that refuses still throws exactly as it would alone. */
function advanceAll(user, woId, opts) {
  let wo = null, lastIdx = -1;
  for (let pass = 0; pass < 12; pass++) {
    // the coating stage in the run still has to say where it put the roll —
    // driving every stage at once does not excuse the job from the gate
    wo = advance(user, woId, "complete", opts);
    if (wo.status === "Completed" || wo.status === "Dispatched") break;
    // a route that stops moving would otherwise spin until the cap
    if (wo.stageIdx === lastIdx) break;
    lastIdx = wo.stageIdx;
  }
  return wo;
}

/* ============================================================
   THE FLOOR'S LAB READING
   The coating supervisor measures the batch they have just run and
   records it against the work order. It is the same certificate the
   lab incharge later adds their own reading to — one batch, one
   document, two independent measurements (see labService).

   The floor writes the PRODUCTION set only; labService refuses a
   supervisor who tries to write the lab's. The parameters are the
   ones the Products master states a limit for, and every one of them
   must carry a value: a half-filled sheet would open the very gap
   the coating gate exists to close.
   ============================================================ */
function labWOFor(user, woId, data) {
  if (!user) throw err("Not authenticated", 401);
  const isOffice = user.role === "admin" || user.role === "office";
  if (!isOffice && user.role !== "supervisor") throw err("Forbidden", 403);
  const found = repo.getWorkOrder(woId);
  if (!found || !found.id) throw err("Work order not found", 404);
  const wo = withRoute(found, data);
  if (!isOffice) {
    /* A supervisor measures the batch THEY coated. The reading belongs to the
       coating stage, so it is that stage — not merely the job — that must be
       theirs, owner included: the two RM lines never see each other's work,
       and slitting has no business recording a coating measurement. Judged on
       the ROUTE rather than the current stage, so a reading can still be
       corrected after the job has moved on. */
    const mine = (wo.route || []).some((r) => r.area === "coating"
      && S.areaCovers(user.area || "all", r.area)
      && (!r.owner || r.owner === user.username));
    if (!mine) throw err("The lab reading for this job belongs to the coating floor that runs it", 403);
  }
  return wo;
}

/** What the floor has to measure for this job, and what it has measured so far. */
function labSheet(user, woId) {
  const data = fullState();
  const wo = labWOFor(user, woId, data);
  const st = LAB.labStatusForWO(wo, data);
  return Object.assign({}, st, {
    qty: wo.qty, runQty: wo.runQty != null ? wo.runQty : wo.qty,
    // the floor's own reading is what it is asked for; the lab's is shown as context
    required: st.coating,
  });
}

function recordLabReading(user, woId, body) {
  body = body || {};
  const data = fullState();
  const wo = labWOFor(user, woId, data);
  const st = LAB.labStatusForWO(wo, data);
  if (!st.product) throw err("No lab product is linked to " + (wo.itemId || "this product") + " — the office must link one before a reading can be recorded", 400);
  if (!st.params.length) throw err("No test parameters are defined for " + (st.product.code || st.product.name) + " — set its spec in Lab Reports → Products first", 400);

  const values = body.values || body.prodValues || {};
  const missing = st.params.filter((p) => { const v = values[p.key]; return v == null || v === "" || isNaN(+v); });
  if (missing.length) {
    throw err("Enter every reading before submitting — missing: " + missing.map((p) => p.label).join(", "), 400);
  }

  const payload = {
    productId: st.product.id,
    refNo: st.batchNo,                 // the batch number IS the work order number
    woId: wo.id,
    source: "production",
    values,
    testedBy: body.testedBy != null ? String(body.testedBy) : (user.name || user.username),
    remarks: body.remarks != null ? String(body.remarks) : undefined,
  };
  if (payload.remarks === undefined) delete payload.remarks;
  const saved = st.reportId
    ? LAB.updateReport(st.reportId, payload, user)
    : LAB.createReport(payload, user);
  return { workOrder: wo.id, report: saved, status: LAB.labStatusForWO(wo, fullState()) };
}

/* ============================================================
   createWorkOrder — office/admin plan a new production run.
   Builds a fresh 3-stage route (non-legacy → full per-stage
   posting as it progresses).
   ============================================================ */
/* A short material is only a hard stop for goods we BUY ready-made. Anything we
   produce ourselves simply starts a stage earlier: the work order is routed
   through its owner's RM production so the missing material gets made first
   (see stageService.routeStagesFor). */
function assertMaterialsAvailable(data, item, qty, materialChoices) {
  const bom = (data.boms || {})[item.id];
  if (!bom) return;
  if (S.productOwner(item.id, data)) return;        // made in-house → route, don't block
  const onHand = {};
  (data.movements || []).forEach((mv) => { onHand[mv.itemId] = (onHand[mv.itemId] || 0) + (+mv.qty || 0); });
  const need = {};
  BC.toLegacy(bom, BC.metaFromItem(item), materialChoices || {}).forEach(([rid, per]) => {
    need[rid] = (need[rid] || 0) + (per * qty) / (bom.yield || 1);
  });
  const short = Object.entries(need)
    .filter(([rid, n]) => (onHand[rid] || 0) + 1e-6 < n)
    .map(([rid, n]) => {
      const it = (data.items || []).find((x) => x.id === rid) || {};
      return (it.name || rid) + " (need " + n.toFixed(2) + " " + (it.uom || "") + ", in store " + (onHand[rid] || 0).toFixed(2) + ")";
    });
  if (short.length) {
    throw err("This product is bought in ready-made, and the store is short: " + short.join("; ")
      + ". Raise a purchase order first.", 400);
  }
}

/* ============================================================
   PARTIAL WORK ORDERS
   An order for 100 kg with 50 kg of material in the store used to be refused
   outright. That is the wrong answer for this factory: the floor makes the
   50 kg it can, and the rest waits — sometimes for months — until the raw
   material arrives. So the order is raised in full, the part that CAN be made
   is released to the floor, and the remainder is carried as pending.

   Quantities on a work order:
     qty          what was ordered                        (100)
     runQty       released to the floor right now         (50)
     completedQty finished across all runs so far         (0 → 50)
     pendingQty   still waiting for material              (50)
   qty === completedQty + runQty + pendingQty, always.

   Pending material is NOT reserved. Stock that arrives is free for any order
   until somebody in the office resumes this one, which issues it there and
   then (see resumeWorkOrder).
   ============================================================ */

/* per-unit material requirement of a product, wastage (yield) included */
function perUnitNeed(data, item, materialChoices) {
  const bom = (data.boms || {})[item.id];
  if (!bom) return null;
  const per = {};
  BC.toLegacy(bom, BC.metaFromItem(item), materialChoices || {}).forEach(([rid, p]) => {
    per[rid] = (per[rid] || 0) + p / (bom.yield || 1);
  });
  return per;
}

function onHandMap(data) {
  const onHand = {};
  (data.movements || []).forEach((mv) => { onHand[mv.itemId] = (onHand[mv.itemId] || 0) + (+mv.qty || 0); });
  return onHand;
}

/* How much of `item` the store can actually make right now. Infinity when the
   recipe is unknown or needs nothing — never a fabricated ceiling. */
function maxMakeable(data, item, materialChoices) {
  const per = perUnitNeed(data, item, materialChoices);
  if (!per) return Infinity;
  const onHand = onHandMap(data);
  let cap = Infinity;
  Object.keys(per).forEach((rid) => {
    const p = per[rid];
    if (!(p > 0)) return;
    cap = Math.min(cap, (onHand[rid] || 0) / p);
  });
  return cap;
}

/* What the store is short of to make `qty` — the list the office is warned
   with before the order is raised anyway. */
function shortageFor(data, item, qty, materialChoices) {
  const per = perUnitNeed(data, item, materialChoices);
  if (!per) return [];
  const onHand = onHandMap(data);
  return Object.keys(per)
    .map((rid) => {
      const need = per[rid] * qty, have = onHand[rid] || 0;
      const it = (data.items || []).find((x) => x.id === rid) || {};
      return { id: rid, name: it.name || rid, uom: it.uom || "",
        need: Math.round(need * 1000) / 1000, have: Math.round(have * 1000) / 1000,
        short: Math.round((need - have) * 1000) / 1000 };
    })
    .filter((r) => r.short > 1e-6);
}

/** What raising this order would mean — used by the New Work Order form to
    warn BEFORE anything is written. Never mutates. */
function previewWorkOrder(user, body) {
  if (!user) throw err("Not authenticated", 401);
  if (user.role !== "admin" && user.role !== "office") throw err("Forbidden", 403);
  body = body || {};
  const data = fullState();
  const item = (data.items || []).find((i) => i.id === body.itemId);
  if (!item) throw err("Unknown product", 400);
  const qty = +body.qty;
  if (!qty || qty <= 0) throw err("Enter a valid quantity", 400);
  const plan = S.planForRequirement(body.itemId, qty, data, {
    widthMM: body.widthMM ? +body.widthMM : null, materialChoices: body.materialChoices,
    fgQty: body.fgQty, wipQty: body.wipQty,
  });
  const makeQty = plan.makeQty || 0;
  const cap = maxMakeable(data, item, body.materialChoices);
  const canMake = Math.max(0, Math.min(makeQty, isFinite(cap) ? Math.floor(cap * 1000) / 1000 : makeQty));
  const pending = Math.round((makeQty - canMake) * 1000) / 1000;
  return {
    qty, makeQty, fromStock: Math.round((qty - makeQty) * 1000) / 1000,
    canMake, pendingQty: pending > 1e-6 ? pending : 0,
    shortage: pending > 1e-6 ? shortageFor(data, item, makeQty, body.materialChoices) : [],
  };
}

/* Tape width (mm) as entered on a work order. Blank clears it; anything that
   is not a sane positive measurement is rejected rather than silently stored. */
function widthOf(v) {
  if (v === undefined || v === null || v === "") return null;
  const w = +v;
  if (!isFinite(w) || w <= 0) throw err("Enter a valid tape width in mm", 400);
  if (w > 5000) throw err("Tape width looks wrong — enter it in millimetres", 400);
  return w;
}

/* Width (mm) of the MATERIAL going in — the jumbo roll being fed — as opposed
   to the tape width the run is slit to. Two different measurements: the store
   holds 1000 mm rolls and the customer orders 25 mm tape, and the floor needs
   both on the job to know how many tapes come off a roll. Same validation, its
   own message, so an operator is told which of the two is wrong. */
function matWidthOf(v) {
  if (v === undefined || v === null || v === "") return null;
  const w = +v;
  if (!isFinite(w) || w <= 0) throw err("Enter a valid material width in mm", 400);
  if (w > 5000) throw err("Material width looks wrong — enter it in millimetres", 400);
  return w;
}

/* updateWorkOrder — edit a planned run. Due date, priority and tape width can
   change any time before dispatch; quantity and line only while NOTHING has
   been posted or completed (stage movements are derived from them). */
function updateWorkOrder(user, id, body) {
  if (!user) throw err("Not authenticated", 401);
  if (user.role !== "admin" && user.role !== "office") throw err("Forbidden", 403);
  body = body || {};
  const data = fullState();
  const wo = (data.workorders || []).find((w) => w.id === id);
  if (!wo) throw err("Work order not found", 404);
  if (wo.dispatched) throw err("Dispatched work orders cannot be edited", 400);
  const started = (wo.route || []).some((s) => s.posted || s.status !== "Pending");

  // renumber the WO — the row key AND every movement ref move together
  if (body.id !== undefined) {
    const newId = String(body.id || "").trim().toUpperCase();
    if (!newId) throw err("Work order number cannot be empty", 400);
    if (newId.length > 24) throw err("Work order number is too long", 400);
    if (newId !== wo.id) {
      if ((data.workorders || []).some((w) => w.id === newId)) throw err("Work order " + newId + " already exists", 409);
      repo.renameWorkOrder(wo.id, newId);
      wo.id = newId;
    }
  }
  // switch the product (name/code/thickness = a different FG item) — only
  // while nothing has started; the route and materials derive from it
  if (body.itemId !== undefined && body.itemId !== wo.itemId) {
    if (started) throw err("Product cannot change after production has started", 400);
    const newItem = (data.items || []).find((i) => i.id === body.itemId && i.cat === "FG");
    if (!newItem) throw err("Unknown product", 400);
    assertMaterialsAvailable(data, newItem, body.qty !== undefined ? +body.qty : wo.qty, null);
    wo.itemId = body.itemId;
    delete wo.materialChoices;                 // the picks belonged to the old recipe
    const q2 = body.qty !== undefined ? +body.qty : wo.qty;
    wo.line = lineForItem(newItem, data, null, { qty: q2 });
    wo.route = S.freshRoute({ line: wo.line, itemId: wo.itemId, qty: q2 }, data);
    wo.stageIdx = 0;
  }
  if (body.due !== undefined) wo.due = body.due || null;
  if (body.priority !== undefined) wo.priority = body.priority || "Normal";
  if (body.widthMM !== undefined) {
    const width = widthOf(body.widthMM);
    if (width == null) delete wo.widthMM; else wo.widthMM = width;
  }
  if (body.matWidthMM !== undefined) {
    const mw = matWidthOf(body.matWidthMM);
    if (mw == null) delete wo.matWidthMM; else wo.matWidthMM = mw;
  }
  if (body.qty !== undefined) {
    const q = +body.qty;
    if (!q || q <= 0) throw err("Enter a valid quantity", 400);
    if (started && Math.abs(q - wo.qty) > 1e-9) throw err("Quantity cannot change after production has started", 400);
    if (Math.abs(q - wo.qty) > 1e-9) {
      const item = (data.items || []).find((i) => i.id === wo.itemId);
      if (item) assertMaterialsAvailable(data, item, q, wo.materialChoices);
      wo.qty = q;
    }
  }
  if (body.line !== undefined && body.line && body.line !== wo.line) {
    if (started) throw err("Line cannot change after production has started", 400);
    const item2 = (data.items || []).find((i) => i.id === wo.itemId);
    wo.line = item2 ? lineForItem(item2, data, body.line, { qty: wo.qty }) : body.line;
    wo.route = S.freshRoute({ line: wo.line, itemId: wo.itemId, qty: wo.qty,
      materialChoices: wo.materialChoices }, data);
    wo.stageIdx = 0;
  }
  wo.progress = calcProgress(wo.route || []);
  wo.status = S.rollupStatus(wo);
  wo.updatedBy = user.username; wo.updatedAt = new Date().toISOString();
  repo.putWorkOrder(wo);
  return summarize(wo, data);
}

function createWorkOrder(user, body) {
  if (!user) throw err("Not authenticated", 401);
  if (user.role !== "admin" && user.role !== "office") throw err("Forbidden", 403);
  body = body || {};
  const data = fullState();
  const item = (data.items || []).find((i) => i.id === body.itemId);
  if (!item) throw err("Unknown product", 400);
  const qty = +body.qty;
  if (!qty || qty <= 0) throw err("Enter a valid quantity", 400);

  // The width the run is slit to is decided per ORDER, not per product — it is
  // recorded on the work order and printed as the size on the invoice. It is
  // also what finished stock has to match before it can be used, so it is
  // resolved BEFORE the requirement is netted.
  const width = widthOf(body.widthMM);
  // and the width of the roll being FED, which is a property of the material
  const matWidth = matWidthOf(body.matWidthMM);

  /* Net the requirement against stock that already exists: finished goods go
     straight to packing, half-made rolls skip coating and start at slitting,
     and only the remainder is manufactured. */
  const plan = S.planForRequirement(body.itemId, qty, data, {
    widthMM: width, materialChoices: body.materialChoices,
    // the planner takes as much from stock as it can unless the office named
    // an amount — a blank means "use whatever is there", 0 means "use none"
    fgQty: body.fgQty, wipQty: body.wipQty,
  });

  /* How much of the MANUFACTURED part the store can actually cover today.
     Anything beyond that is carried as pending instead of the order being
     refused — see the PARTIAL WORK ORDERS note above. A product we make
     ourselves is exempt: its shortages are solved by routing the job through
     its own RM production, not by waiting for a delivery. */
  const makeQty = plan.makeQty || 0;
  const inHouse = !!S.productOwner(item.id, data);
  let runQty = makeQty, pendingQty = 0, shortage = [];
  if (makeQty > 0 && !inHouse) {
    const cap = maxMakeable(data, item, body.materialChoices);
    if (isFinite(cap) && cap < makeQty - 1e-6) {
      runQty = Math.max(0, Math.floor(cap * 1000) / 1000);
      pendingQty = Math.round((makeQty - runQty) * 1000) / 1000;
      shortage = shortageFor(data, item, makeQty, body.materialChoices);
      // the office has to have seen the shortage and said yes
      if (!body.allowShortage) {
        const e = err("Only " + runQty + " of " + makeQty + " can be made — the store is short. "
          + "Confirm to raise the order with the balance pending.", 409);
        e.shortage = shortage; e.canMake = runQty; e.pendingQty = pendingQty;
        throw e;
      }
    }
  }

  /* A big order is often run in batches even when the store is full — the
     floor makes a part, it ships, and the next part follows. `releaseQty`
     puts only that much on the machines now; the remainder is carried exactly
     like a material-blocked balance and released the same way, by resuming. */
  const rel = body.releaseQty == null || body.releaseQty === "" ? null : +body.releaseQty;
  if (rel != null) {
    if (!isFinite(rel) || rel <= 0) throw err("Enter a valid quantity to release", 400);
    if (rel < runQty - 1e-6) {
      pendingQty = Math.round((pendingQty + (runQty - rel)) * 1000) / 1000;
      runQty = Math.round(rel * 1000) / 1000;
    }
  }

  // next WO id
  let max = 0;
  (data.workorders || []).forEach((w) => { const m = /(\d+)/.exec(w.id || ""); if (m) max = Math.max(max, +m[1]); });
  const id = "WO-" + String(max + 1).padStart(4, "0");

  // the line follows the route: a job that must be produced starts on its
  // owner's RM line, otherwise it lands on a slitting line
  const line = lineForItem(item, data, body.line, { qty: plan.makeQty || qty, materialChoices: body.materialChoices });
  const wo = {
    id, date: todayISO(), itemId: body.itemId, qty,
    status: "Released", due: body.due || null, line,
    progress: 0, priority: body.priority || "Normal",
    plan,
    // what is on the floor now, what is finished, what still waits for material
    runQty: Math.round((qty - pendingQty) * 1000) / 1000,
    completedQty: 0,
    pendingQty,
    route: S.freshRoute({ line, itemId: body.itemId, qty, widthMM: width, plan,
      materialChoices: body.materialChoices }, data),
    stageIdx: 0, legacy: false,
    createdBy: user.username, createdAt: new Date().toISOString(),
  };
  if (width != null) wo.widthMM = width;
  if (matWidth != null) wo.matWidthMM = matWidth;
  // capture any per-order production spec (e.g. copper-wire count) for this product
  const spec = S.specForProduct(body.itemId, data);
  if (spec && body[spec.key] != null && body[spec.key] !== "") wo[spec.key] = body[spec.key];
  // A ranged BOM line names a choice or a span, not one material. Whichever was
  // picked against live store stock at issue is recorded here, so every later
  // stage posts the material actually chosen rather than re-guessing.
  if (body.materialChoices && typeof body.materialChoices === "object") {
    const byId = Object.fromEntries((data.items || []).map((i) => [i.id, true]));
    const picks = {};
    Object.entries(body.materialChoices).forEach(([k, v]) => {
      if (/^\d+$/.test(String(k)) && typeof v === "string" && byId[v]) picks[k] = v;
    });
    if (Object.keys(picks).length) wo.materialChoices = picks;
  }
  /* ---- the store is drawn down the moment the run is RELEASED ----------
     Everything the job consumes — the finished rolls taken off the shelf,
     the half-made rolls, and the raw materials for the part being made — is
     issued now, in one go, against this work order. Each stage is therefore
     marked as already posted so completing it later cannot draw the same
     stock a second time. Deleting the work order rolls all of it back
     (repo.deleteWorkOrder removes movements by ref). */
  if (pendingQty > 0) {
    // a balance held back on purpose is not a shortage, and must not read as one
    if (shortage.length) wo.shortage = shortage;
    wo.pendingSince = todayISO();
  }
  /* Only the part being RUN draws material. The finished / half-made rolls the
     planner netted are real stock and are issued in full; the raw materials
     scale to runQty, so a pending balance costs the store nothing until the
     office resumes it. */
  const itemsById = Object.fromEntries((data.items || []).map((i) => [i.id, i]));
  const runNet = Object.assign({}, plan, { makeQty: runQty });
  const runTotal = (plan.fgQty || 0) + (plan.wipQty || 0) + runQty;
  const stagePlan = S.computeStagePlan(wo.itemId, runTotal, data, wo.materialChoices, runNet);
  const moves = [];
  if (stagePlan) {
    (wo.route || []).forEach((r) => {
      if (!stagePlan[r.key]) return;
      S.stageMovements(stagePlan, r.key, wo, itemsById, user.username, todayISO(), data.movements)
        .forEach((m) => moves.push(m));
    });
  }
  if (moves.length) repo.addMovements(moves);
  (wo.route || []).forEach((r) => { r.posted = true; });
  wo.stockPosted = true;
  wo.stockPostedAt = new Date().toISOString();

  wo.status = S.rollupStatus(wo);
  repo.putWorkOrder(wo);
  return summarize(wo, data);
}

/* ============================================================
   produceFinished — floor action: record finished stock made.
   Deducts the raw materials from the store per the product's BOM
   (same recipe a work order uses) and posts the produced quantity
   to the finished-goods warehouse the supervisor chose.
   body: { itemId, qty, wh }
   ============================================================ */
function produceFinished(user, body) {
  if (!user) throw err("Not authenticated", 401);
  if (!["supervisor", "admin", "office"].includes(user.role)) throw err("Forbidden", 403);
  body = body || {};
  const data = fullState();

  const item = (data.items || []).find((i) => i.id === body.itemId);
  if (!item) throw err("Unknown product", 400);
  if (item.cat !== "FG" && item.cat !== "WIP") {
    throw err("Only finished goods or work in process can be booked here", 400);
  }
  // A WIP item is a half-made version of a finished good: it carries no recipe
  // of its own, so it draws on its parent's — and only on the part of it the
  // coating stage actually consumes (the base web and the paste chemistry).
  const isWip = item.cat === "WIP";
  const recipeOwnerId = isWip ? (item.stageOf || "") : item.id;
  if (isWip && !recipeOwnerId) {
    throw err("This work-in-process item is not linked to a finished product — cannot work out its materials", 400);
  }
  const recipeOwner = isWip
    ? (data.items || []).find((i) => i.id === recipeOwnerId)
    : item;
  if (isWip && !recipeOwner) throw err("Unknown parent product " + recipeOwnerId, 400);

  const bom = (data.boms || {})[recipeOwnerId];
  if (!bom || !(bom.lines || []).length) throw err("This product has no BOM recipe — cannot deduct raw materials", 400);

  const qty = +body.qty;
  if (!qty || qty <= 0) throw err("Enter a valid quantity", 400);

  const warehouse = (data.warehouses || []).find((w) => w.id === body.wh);
  if (!warehouse) throw err("Choose a valid warehouse to store the finished stock", 400);

  /* ---- NOTHING GOES INTO A STORE UNMEASURED --------------------------------
     Same rule as the coating gate, at the other end of the line: stock is
     only booked once the batch carries a lab report covering every parameter
     the Products master states a limit for. This stock has no work order, so
     the batch is named by whoever books it and the certificate is filed
     against that name. Validated BEFORE any movement is posted, so a refused
     booking leaves nothing behind; the reading itself is written after the
     stock lands, once the booking is known to have succeeded.
     A half-made roll is graded against its parent product's spec — it is the
     same web, measured before it is slit. */
  const gate = LAB.finishedStockGate(recipeOwnerId, body, data);
  if (!gate.ok) { const e = err(gate.message, 409); e.labGate = gate; throw e; }

  const itemsById = Object.fromEntries((data.items || []).map((i) => [i.id, i]));
  const Y = bom.yield || 1;
  const by = user.username;
  const date = todayISO();
  const ref = "FP-" + Date.now().toString(36).toUpperCase(); // finished-production batch ref

  /* A ranged BOM line names a choice or a span, not one material. Whichever
     the form picked against live store stock is honoured here, so the issue
     posts the material actually chosen — the same contract a work order has. */
  let picks = {};
  if (body.materialChoices && typeof body.materialChoices === "object") {
    Object.entries(body.materialChoices).forEach(([k, v]) => {
      if (/^\d+$/.test(String(k)) && typeof v === "string" && itemsById[v]) picks[k] = v;
    });
  }

  /* ---- part of the output can come from stock that already exists --------
     ADMIN ONLY. A run of finished goods can be made partly from half-made
     rolls already on the shelf (and, where a matching item exists, from
     finished stock): that part draws no raw material at all, only the stock
     itself. Everything left over is made from the recipe as usual. */
  const isAdmin = user.role === "admin";
  const wantFg = isAdmin ? body.fgQty : null;
  const wantWip = isAdmin ? body.wipQty : null;
  let fromStock = { fgQty: 0, wipQty: 0, fgSources: [], wipSources: [] };
  if (isAdmin && ((+wantFg || 0) > 0 || (+wantWip || 0) > 0)) {
    // never a source for itself — booking an item cannot consume that item
    const stockData = Object.assign({}, data, {
      items: (data.items || []).filter((i) => i.id !== item.id),
    });
    /* The stock is drawn directly rather than through planForRequirement:
       that planner only offers half-made rolls to a job whose ROUTE would
       coat, which is the right rule for a work order but the wrong one here.
       Booking output from a jumbo already on the shelf is valid whatever the
       route would have done. */
    const fgDraw = S.drawFrom(S.finishedStockFor(recipeOwnerId, stockData, body.tapeWidthMM),
      Math.min(+wantFg || 0, qty));
    const wipDraw = S.drawFrom(S.wipStockFor(recipeOwnerId, stockData),
      Math.min(+wantWip || 0, r2(qty - fgDraw.taken)));
    fromStock = { fgQty: fgDraw.taken, wipQty: wipDraw.taken,
      fgSources: fgDraw.used, wipSources: wipDraw.used };
  }
  const fromStockQty = r2(fromStock.fgQty + fromStock.wipQty);
  if (fromStockQty > qty + 1e-6) throw err("More was taken from stock than is being produced", 400);
  const makeQty = r2(qty - fromStockQty);

  const moves = [];
  const consumed = [];
  // 0) whatever is being taken off the shelf is issued as itself
  [].concat(fromStock.fgSources, fromStock.wipSources).forEach((s) => {
    if (!(s.qty > 0)) return;
    const src = itemsById[s.id] || {};
    moves.push({ id: mvId(), date, itemId: s.id, wh: src.cat === "WIP" ? "WH-WIP" : FG_STORE,
      type: "ISSUE", qty: -Math.abs(s.qty), rate: src.cost || 0, ref,
      note: "Taken from stock → " + item.id, by });
    consumed.push({ id: s.id, name: src.name || s.id, qty: s.qty, uom: src.uom || "" });
  });
  // 1) deduct each raw material from the store, scaled by the BOM + overall yield
  //    (toLegacy handles both legacy tuples and rich imported lines)
  BC.toLegacy(bom, BC.metaFromItem(recipeOwner), picks).forEach(([rid, per]) => {
    // half-made stock has not been slit or packed, so it never draws the
    // packaging materials — only what the coating stage puts into the web
    if (isWip && !["base", "paste"].includes(S.materialRole(rid))) return;
    const need = r2(per * makeQty / Y);
    if (!need || !itemsById[rid]) return;
    moves.push({ id: mvId(), date, itemId: rid, wh: RAW_STORE, type: "ISSUE",
      qty: -Math.abs(need), rate: (itemsById[rid] || {}).cost || 0, ref,
      note: "Production issue → " + item.id, by });
    consumed.push({ id: rid, name: (itemsById[rid] || {}).name || rid, qty: need, uom: (itemsById[rid] || {}).uom || "" });
  });
  // 2) add the produced quantity to the chosen warehouse
  const tapeWidth = body.tapeWidthMM == null || body.tapeWidthMM === "" ? null : +body.tapeWidthMM || null;
  moves.push({ id: mvId(), date, itemId: item.id, wh: warehouse.id, type: "PROD",
    qty: Math.abs(qty), rate: item.cost || 0, ref,
    note: (isWip ? "Work in process added at " : "Finished stock added at ") + warehouse.name
      + (tapeWidth ? " · " + tapeWidth + " mm tape width" : ""), by });

  repo.addMovements(moves);

  /* The parameters the form collected belong to the ITEM — the tape width a
     finished good is slit to is what a later work order matches its stock on,
     so it has to persist rather than live only in the movement note. */
  const patch = {};
  if (tapeWidth && !isWip) patch.tapeWidthMM = tapeWidth;
  if (body.thicknessMM != null && body.thicknessMM !== "") patch.thicknessMM = +body.thicknessMM || null;
  if (body.gsm != null && body.gsm !== "") patch.gsm = +body.gsm || null;
  if (Object.keys(patch).length) repo.putItem(Object.assign({}, item, patch));

  /* the batch's certificate, now that the stock is really in. Readings taken
     on the floor are the PRODUCTION set; the lab incharge adds theirs to the
     same document later, exactly as for a coated work order. */
  let labReport = null;
  if (gate.values) {
    labReport = LAB.createReport({
      productId: gate.product.id, refNo: gate.refNo, source: "production",
      values: gate.values,
      testedBy: body.testedBy != null ? String(body.testedBy) : (user.name || user.username),
    }, user);
  }

  return {
    ok: true, ref,
    produced: { itemId: item.id, name: item.name, qty, uom: item.uom || "", wh: warehouse.id, whName: warehouse.name },
    // how the run was met: off the shelf vs actually made from the recipe
    fromStock: { fgQty: fromStock.fgQty, wipQty: fromStock.wipQty, makeQty },
    consumed,
    batchNo: gate.refNo || null,
    labReport: labReport ? { id: labReport.id, result: labReport.prodResult } : null,
  };
}

/**
 * What the lab asks for before a given product can be booked into store.
 * The form calls this to build its readings block; it never carries the spec
 * limits, so nobody can tune a measurement until it passes.
 */
function finishedStockLabSheet(user, itemId) {
  if (!user) throw err("Not authenticated", 401);
  if (!["supervisor", "admin", "office"].includes(user.role)) throw err("Forbidden", 403);
  const data = fullState();
  const item = (data.items || []).find((i) => i.id === itemId);
  if (!item) throw err("Unknown product", 400);
  const ownerId = item.cat === "WIP" ? (item.stageOf || "") : item.id;
  const g = LAB.finishedStockGate(ownerId, {}, data);
  return { itemId: item.id, recipeOwnerId: ownerId, required: g.required,
    product: g.product ? { id: g.product.id, code: g.product.code, name: g.product.name,
      refMode: g.product.refMode || "batch" } : null,
    params: g.params };
}

/* ============================================================
   Excess material — a supervisor reports raw material drawn from
   the store BEYOND what the job was issued for, justifying each
   line (material, quantity, location, reason). Each quantity is
   deducted from the store as an ISSUE movement.
   body: { woId?, lines:[{ itemId, qty, location, reason }] }
   ============================================================ */
function recordExcessMaterial(user, body) {
  if (!user) throw err("Not authenticated", 401);
  const isOffice = user.role === "admin" || user.role === "office";
  if (!isOffice && user.role !== "supervisor") throw err("Forbidden", 403);
  body = body || {};
  const lines = Array.isArray(body.lines) ? body.lines : [];
  if (!lines.length) throw err("Add at least one material to justify", 400);

  const data = fullState();
  const itemsById = Object.fromEntries((data.items || []).map((i) => [i.id, i]));
  const whById = Object.fromEntries((data.warehouses || []).map((w) => [w.id, w]));

  // 1) the excess is always tied to a REAL job, and (for supervisors) one in
  //    their own work area — same authorization rule as advance().
  const found = repo.getWorkOrder(body.woId);
  if (!found || !found.id) throw err("Work order not found", 404);
  const wo = withRoute(found, data);
  const route = wo.route || [];
  const curStage = route[Math.min(Math.max(wo.stageIdx || 0, 0), Math.max(route.length - 1, 0))] || {};
  if (!isOffice && user.area !== "all" && !S.areaCovers(user.area, curStage.area)) {
    throw err("This job is at the “" + (curStage.name || "current") + "” stage — not your work area", 403);
  }

  // 2) the materials this job's product actually consumes (union across stages).
  //    Legacy WOs with no derivable BOM plan → null (fall back to any raw material,
  //    still bounded by the category + on-hand checks below).
  const RAW = new Set(["RM", "PKG", "CON"]);
  const plan = S.computeStagePlan(wo.itemId, wo.qty, data, wo.materialChoices, wo.plan);
  const jobMaterials = plan
    ? new Set(Object.keys(plan).flatMap((k) => (plan[k].consume || []).map(([rid]) => rid)))
    : null;

  // 3) on-hand per (requested item, warehouse) from movements — deducted as we go
  //    so multiple lines against the same store can't collectively over-draw.
  const reqIds = new Set(lines.map((l) => l && l.itemId).filter(Boolean));
  const onHand = {};
  (data.movements || []).forEach((m) => {
    if (!reqIds.has(m.itemId) || !m.wh) return;
    (onHand[m.itemId] || (onHand[m.itemId] = {}));
    onHand[m.itemId][m.wh] = (onHand[m.itemId][m.wh] || 0) + (+m.qty || 0);
  });
  const availOf = (iid, wh) => Math.round((((onHand[iid] || {})[wh]) || 0) * 100) / 100;

  const by = user.username;
  const date = todayISO();
  const ref = "EX-" + Date.now().toString(36).toUpperCase();  // excess-material batch ref
  const woRef = String(wo.id);

  const moves = [];
  const deducted = [];
  lines.forEach((ln, i) => {
    const tag = "Line " + (i + 1) + ": ";
    const it = itemsById[ln && ln.itemId];
    const qty = r2(ln && ln.qty);
    if (!it) throw err(tag + "unknown material", 400);
    if (!RAW.has(it.cat)) throw err(tag + it.name + " is not a raw material and can't be issued here", 400);
    if (jobMaterials && !jobMaterials.has(it.id)) throw err(tag + it.name + " is not used by this job", 400);
    if (!qty || qty <= 0) throw err(tag + "enter a valid quantity", 400);
    const wh = ln && ln.location;
    if (!whById[wh]) throw err(tag + "choose a valid store to take it from", 400);
    const avail = availOf(it.id, wh);
    if (avail <= 0) throw err(tag + whById[wh].name + " holds no " + it.name, 400);
    if (qty > avail) throw err(tag + "only " + avail + " " + (it.uom || "") + " of " + it.name + " in " + whById[wh].name + " — can't take " + qty, 400);
    onHand[it.id][wh] = avail - qty;  // reserve against the running balance
    const reason = String((ln && ln.reason) || "").trim() || "Unspecified";
    moves.push({ id: mvId(), date, itemId: it.id, wh, type: "ISSUE",
      qty: -Math.abs(qty), rate: it.cost || 0, ref,
      note: "Excess material (" + woRef + ") — " + reason, by });
    deducted.push({ id: it.id, name: it.name || it.id, qty, uom: it.uom || "", location: whById[wh].name, reason });
  });

  if (!moves.length) throw err("No valid material lines", 400);
  repo.addMovements(moves);
  return { ok: true, ref, woId: woRef, deducted };
}

/* ---- legacy status-based endpoint kept working (maps to actions) ---- */
function updateWorkOrderStatus(user, woId, status, opts) {
  const map = {
    "In Production": "start", "In Progress": "start", "Released": "start",
    "Pending": "pause",
    "Completed": "complete", "Packed": "complete", "Done": "complete",
    "Dispatched": "dispatch",
  };
  const action = map[status];
  if (!action) throw err("Invalid status '" + status + "'", 400);
  // the body travels on, so this older route can still answer the coating
  // gate (wipWh) rather than being unable to close the stage at all
  return advance(user, woId, action, opts);
}

/* The production line must belong to the area that actually STARTS the job:
   a single-material product skips coating, so it must not land on a coating
   line whatever the caller asked for. Pools live in stageService. */
function lineForItem(item, data, wanted, opts) {
  const pool = S.LINES_BY_AREA[S.startArea(item.id, data, opts)] || S.LINES_BY_AREA.slitting;
  if (!wanted) {
    const fromRouting = getLineForItem(item);          // legacy group-based hint
    if (pool.indexOf(fromRouting) >= 0) return fromRouting;
  }
  return S.lineForProduct(item.id, data, wanted, opts);
}

/* trim a WO to what the UI needs (no money) */
function summarize(wo, data) {
  return {
    id: wo.id, status: wo.status, progress: wo.progress,
    stageIdx: wo.stageIdx, dispatched: !!wo.dispatched,
    widthMM: wo.widthMM != null ? wo.widthMM : null,
    matWidthMM: wo.matWidthMM != null ? wo.matWidthMM : null,
    // total / on the floor / finished / waiting for material
    qty: wo.qty,
    runQty: wo.runQty != null ? wo.runQty : wo.qty,
    completedQty: +wo.completedQty || 0,
    pendingQty: +wo.pendingQty || 0,
    dispatchedQty: +wo.dispatchedQty || 0,
    shortage: wo.shortage || null,
    // how the requirement was met: from finished stock, from half-made stock,
    // and how much is genuinely being manufactured
    plan: wo.plan || null,
    route: (wo.route || []).map((r) => ({ key: r.key, name: r.name, area: r.area, seq: r.seq,
      owner: r.owner || null, line: r.line || null,
      qty: r.qty != null ? r.qty : (wo.qty != null ? wo.qty : null),
      status: r.status, doneBy: r.doneBy, doneAt: r.doneAt,
      startedAt: r.startedAt || null, startedBy: r.startedBy || null,
      // time already spent on this stage in earlier batches of the same order
      priorMs: +r.priorMs || 0, runs: +r.runs || 0, firstStartedAt: r.firstStartedAt || null })),
    spec: S.specForWO(wo, data),
    updatedAt: wo.updatedAt,
  };
}

/* ============================================================
   returnStock — floor action: send material BACK to a store.
   Unused issue, over-draw, or finished stock coming back off the
   line. Posts a single RET movement; never negative, never a
   silent adjustment of someone else's numbers.
   ============================================================ */
const FG_STORE = "WH-FG";

function returnStock(user, body) {
  if (!user) throw err("Not authenticated", 401);
  if (!["supervisor", "admin", "office"].includes(user.role)) throw err("Forbidden", 403);
  body = body || {};
  const data = fullState();
  const item = (data.items || []).find((i) => i.id === body.itemId);
  if (!item) throw err("Unknown material", 400);
  const qty = +body.qty;
  if (!qty || qty <= 0) throw err("Enter a valid quantity", 400);

  // default the destination from the material's own category
  const isFinished = item.cat === "FG";
  const wh = body.wh || (isFinished ? FG_STORE : RAW_STORE);
  if (!(data.warehouses || []).some((w) => w.id === wh)) throw err("Choose a valid store", 400);

  const mv = {
    id: mvId(), date: todayISO(), itemId: item.id, wh, type: "RET",
    qty: Math.abs(r2(qty)), rate: item.cost || 0,
    ref: "RET-" + Date.now().toString(36).toUpperCase(),
    note: (body.reason ? String(body.reason).slice(0, 140) : "Returned from floor"),
    by: user.username,
  };
  repo.addMovements([mv]);
  return { ok: true, movement: mv, item: { id: item.id, name: item.name, uom: item.uom } };
}

/* ============================================================
   createAdhocProduction — floor action: record a run that was
   made without a planned work order.
   Rolls are measured, not weighed, so kg is derived:
     sqm  = length_m x (width_mm / 1000) x rolls
     kg   = sqm x gsm / 1000
   A routed work order is created so the run appears on the normal
   job boards. Raw materials are only deducted when the product
   actually has a BOM — otherwise the run is recorded and flagged,
   rather than inventing a consumption.
   ============================================================ */
function createAdhocProduction(user, body) {
  if (!user) throw err("Not authenticated", 401);
  if (!["supervisor", "admin", "office"].includes(user.role)) throw err("Forbidden", 403);
  body = body || {};
  const data = fullState();
  const item = (data.items || []).find((i) => i.id === body.itemId);
  if (!item) throw err("Unknown product", 400);
  if (item.cat !== "FG") throw err("Only finished goods can be recorded as production", 400);

  const rolls = +body.rolls || 1;
  const lengthM = +body.lengthM || 0;
  const widthMM = +body.widthMM || 0;
  const gsm = +body.gsm || +item.gsm || 0;
  let sqm = +body.sqm || 0, kg = +body.kg || 0;
  if (!sqm && lengthM > 0 && widthMM > 0) sqm = lengthM * (widthMM / 1000) * rolls;
  if (!kg && sqm && gsm) kg = (sqm * gsm) / 1000;
  sqm = r2(sqm); kg = r2(kg);
  if (!kg || kg <= 0) throw err("Enter rolls/length/width (with a GSM) or a direct quantity", 400);

  const wh = body.wh || FG_STORE;
  if (!(data.warehouses || []).some((w) => w.id === wh)) throw err("Choose a valid store", 400);

  // a routed WO so the run shows on the same boards as planned work
  let max = 0;
  (data.workorders || []).forEach((w) => { const m = /(\d+)/.exec(w.id || ""); if (m) max = Math.max(max, +m[1]); });
  const now = new Date().toISOString();
  const line = lineForItem(item, data, body.line, { qty: kg });
  const wo = {
    id: "WO-" + String(max + 1).padStart(4, "0"),
    date: todayISO(), itemId: item.id, qty: kg, status: "Released",
    due: null, line, progress: 0, priority: "Normal",
    route: S.freshRoute({ line, itemId: item.id, qty: kg }, data), stageIdx: 0, legacy: false,
    adhoc: true, rolls, lengthM, widthMM, gsm, sqm,
    createdBy: user.username, createdAt: now,
  };
  wo.status = S.rollupStatus(wo);
  repo.putWorkOrder(wo);

  const ref = "AP-" + Date.now().toString(36).toUpperCase();
  // the run's output is NOT stocked (same rule as every stage) — only the
  // materials it burned are posted below
  const moves = [];

  const bom = (data.boms || {})[item.id];
  const consumed = [];
  let deducted = false;
  if (bom && (bom.lines || []).length) {
    const itemsById = Object.fromEntries((data.items || []).map((i) => [i.id, i]));
    const Y = bom.yield || 1;
    BC.toLegacy(bom, BC.metaFromItem(item)).forEach(([rid, per]) => {
      const need = r2(per * kg / Y);
      if (!need || !itemsById[rid]) return;
      moves.push({ id: mvId(), date: todayISO(), itemId: rid, wh: RAW_STORE, type: "ISSUE",
        qty: -Math.abs(need), rate: itemsById[rid].cost || 0, ref,
        note: "Ad-hoc issue → " + item.id, by: user.username });
      consumed.push({ id: rid, name: itemsById[rid].name || rid, qty: need, uom: itemsById[rid].uom || "" });
    });
    deducted = consumed.length > 0;
  }
  repo.addMovements(moves);

  return {
    ok: true, workOrder: wo.id, itemId: item.id, name: item.name,
    rolls, lengthM, widthMM, gsm, sqm, kg, wh,
    consumed, deducted,
    note: deducted ? null : "No BOM for this product — production recorded, raw materials not deducted",
  };
}

module.exports = { advance, advanceAll, createWorkOrder, updateWorkOrder, produceFinished, recordExcessMaterial,
  previewWorkOrder, resumeWorkOrder, maxMakeable, shortageFor,
  labSheet, recordLabReading, finishedStockLabSheet,
  updateWorkOrderStatus, returnStock, createAdhocProduction, setWipStore, ACTIONS };
