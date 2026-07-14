/* ============================================================
   CHHAPERIA ERP — BACKEND · production service (stage engine)
   Supervisor-facing write operations. Security model:
     • a supervisor may ONLY act on a work order whose CURRENT
       stage belongs to their area
     • only safe stage transitions are allowed
     • no money/customer fields are ever returned
   The job flows Coating → Slitting → Packing; completing a stage
   hands the job to the next area's panel and (for non-legacy work
   orders) posts that stage's WIP stock movements. Writes are
   TARGETED (one WO row + appended movements) — no full-state
   rewrite, so panels no longer clobber each other.
   ============================================================ */
"use strict";
const repo = require("../db/repository");
const { buildSeed } = require("../seed/seed");
const S = require("./stageService");
const { getLineForItem } = require("./routing");

const ACTIONS = ["start", "pause", "complete", "dispatch"];

// The raw-material store the BOM draws down when finished stock is produced.
const RAW_STORE = "WH-PNY";

function err(msg, status) { const e = new Error(msg); e.status = status || 400; return e; }

let _mvSeq = 0;
function mvId() { return "MV-" + Date.now().toString(36).toUpperCase() + "-" + (++_mvSeq).toString(36).toUpperCase(); }
const r2 = (n) => Math.round((+n || 0) * 100) / 100;

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
function withRoute(wo) {
  if (!wo.route || !wo.route.length) {
    const seeded = S.seedRouteFromLegacy(wo);
    wo.route = seeded.route; wo.stageIdx = seeded.stageIdx; wo.legacy = seeded.legacy;
  }
  return wo;
}

/* ============================================================
   advance — move a work order's CURRENT stage.
   action: start | pause | complete | dispatch
   ============================================================ */
function advance(user, woId, action) {
  if (!user) throw err("Not authenticated", 401);
  const isOffice = user.role === "admin" || user.role === "office";
  if (!isOffice && user.role !== "supervisor") throw err("Forbidden", 403);
  if (!ACTIONS.includes(action)) throw err("Invalid action '" + action + "'", 400);

  const data = fullState();                       // read-only context (items, boms)
  const itemsById = Object.fromEntries((data.items || []).map((i) => [i.id, i]));

  const found = repo.getWorkOrder(woId);
  if (!found || !found.id) throw err("Work order not found", 404);
  const wo = withRoute(found);

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
    wo.dispatched = true; wo.dispatchedBy = by; wo.dispatchedAt = now;
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
    // post this stage's stock movements (skip for legacy WOs — old flow already did)
    if (!wo.legacy && !stage.posted) {
      const plan = S.computeStagePlan(wo.itemId, wo.qty, data);
      if (plan && plan[stage.key]) {
        const moves = S.stageMovements(plan, stage.key, wo, itemsById, by, todayISO());
        if (moves.length) repo.addMovements(moves);
      }
      stage.posted = true;
    }
    stage.status = "Completed"; stage.doneBy = by; stage.doneAt = now;
    // hand off to the next stage (next area's panel picks it up)
    if (idx < route.length - 1) wo.stageIdx = idx + 1;
    else wo.packedAt = now;
  }

  wo.progress = calcProgress(route);
  wo.status = S.rollupStatus(wo);
  wo.updatedBy = by; wo.updatedAt = now;
  repo.putWorkOrder(wo);

  return summarize(wo);
}

/* ============================================================
   createWorkOrder — office/admin plan a new production run.
   Builds a fresh 3-stage route (non-legacy → full per-stage
   posting as it progresses).
   ============================================================ */
function createWorkOrder(user, body) {
  if (!user) throw err("Not authenticated", 401);
  if (user.role !== "admin" && user.role !== "office") throw err("Forbidden", 403);
  body = body || {};
  const data = fullState();
  const item = (data.items || []).find((i) => i.id === body.itemId);
  if (!item) throw err("Unknown product", 400);
  const qty = +body.qty;
  if (!qty || qty <= 0) throw err("Enter a valid quantity", 400);

  // next WO id
  let max = 0;
  (data.workorders || []).forEach((w) => { const m = /(\d+)/.exec(w.id || ""); if (m) max = Math.max(max, +m[1]); });
  const id = "WO-" + String(max + 1).padStart(4, "0");

  // default the production line from routing (same logic the seed uses) so a
  // WO created without an explicit line still lands on the right area's board
  const line = body.line || getLineForItem(item) || "Coating Line 1";
  const wo = {
    id, date: todayISO(), itemId: body.itemId, qty,
    status: "Released", due: body.due || null, line,
    progress: 0, priority: body.priority || "Normal",
    route: S.freshRoute({ line, itemId: body.itemId }), stageIdx: 0, legacy: false,
    createdBy: user.username, createdAt: new Date().toISOString(),
  };
  // capture any per-order production spec (e.g. copper-wire count) for this product
  const spec = S.specForProduct(body.itemId);
  if (spec && body[spec.key] != null && body[spec.key] !== "") wo[spec.key] = body[spec.key];
  wo.status = S.rollupStatus(wo);
  repo.putWorkOrder(wo);
  return summarize(wo);
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
  if (item.cat !== "FG") throw err("Only finished goods can be added to finished stock", 400);

  const bom = (data.boms || {})[body.itemId];
  if (!bom || !(bom.lines || []).length) throw err("This product has no BOM recipe — cannot deduct raw materials", 400);

  const qty = +body.qty;
  if (!qty || qty <= 0) throw err("Enter a valid quantity", 400);

  const warehouse = (data.warehouses || []).find((w) => w.id === body.wh);
  if (!warehouse) throw err("Choose a valid warehouse to store the finished stock", 400);

  const itemsById = Object.fromEntries((data.items || []).map((i) => [i.id, i]));
  const Y = bom.yield || 1;
  const by = user.username;
  const date = todayISO();
  const ref = "FP-" + Date.now().toString(36).toUpperCase(); // finished-production batch ref

  const moves = [];
  const consumed = [];
  // 1) deduct each raw material from the store, scaled by the BOM + overall yield
  (bom.lines || []).forEach(([rid, per]) => {
    const need = r2(per * qty / Y);
    if (!need || !itemsById[rid]) return;
    moves.push({ id: mvId(), date, itemId: rid, wh: RAW_STORE, type: "ISSUE",
      qty: -Math.abs(need), rate: (itemsById[rid] || {}).cost || 0, ref,
      note: "Production issue → " + item.id, by });
    consumed.push({ id: rid, name: (itemsById[rid] || {}).name || rid, qty: need, uom: (itemsById[rid] || {}).uom || "" });
  });
  // 2) add the produced finished quantity to the chosen warehouse
  moves.push({ id: mvId(), date, itemId: item.id, wh: warehouse.id, type: "PROD",
    qty: Math.abs(qty), rate: item.cost || 0, ref,
    note: "Finished stock added at " + warehouse.name, by });

  repo.addMovements(moves);
  return {
    ok: true, ref,
    produced: { itemId: item.id, name: item.name, qty, uom: item.uom || "", wh: warehouse.id, whName: warehouse.name },
    consumed,
  };
}

/* ---- legacy status-based endpoint kept working (maps to actions) ---- */
function updateWorkOrderStatus(user, woId, status) {
  const map = {
    "In Production": "start", "In Progress": "start", "Released": "start",
    "Pending": "pause",
    "Completed": "complete", "Packed": "complete", "Done": "complete",
    "Dispatched": "dispatch",
  };
  const action = map[status];
  if (!action) throw err("Invalid status '" + status + "'", 400);
  return advance(user, woId, action);
}

/* trim a WO to what the UI needs (no money) */
function summarize(wo) {
  return {
    id: wo.id, status: wo.status, progress: wo.progress,
    stageIdx: wo.stageIdx, dispatched: !!wo.dispatched,
    route: (wo.route || []).map((r) => ({ key: r.key, name: r.name, area: r.area, seq: r.seq,
      status: r.status, doneBy: r.doneBy, doneAt: r.doneAt })),
    spec: S.specForWO(wo),
    updatedAt: wo.updatedAt,
  };
}

module.exports = { advance, createWorkOrder, produceFinished, updateWorkOrderStatus, ACTIONS };
