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
const BC = require("../../../frontend/js/bomcalc");

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
      const plan = S.computeStagePlan(wo.itemId, wo.qty, data, wo.materialChoices);
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

  // A run cannot be released without the materials to make it: reject the
  // work order outright when any BOM component is short of store stock.
  const bom = (data.boms || {})[body.itemId];
  if (bom) {
    const onHand = {};
    (data.movements || []).forEach((mv) => { onHand[mv.itemId] = (onHand[mv.itemId] || 0) + (+mv.qty || 0); });
    const need = {};
    BC.toLegacy(bom, BC.metaFromItem(item), body.materialChoices || {}).forEach(([rid, per]) => {
      need[rid] = (need[rid] || 0) + (per * qty) / (bom.yield || 1);
    });
    const short = Object.entries(need)
      .filter(([rid, n]) => (onHand[rid] || 0) + 1e-6 < n)
      .map(([rid, n]) => {
        const it = (data.items || []).find((x) => x.id === rid) || {};
        return (it.name || rid) + " (need " + n.toFixed(2) + " " + (it.uom || "") + ", in store " + (onHand[rid] || 0).toFixed(2) + ")";
      });
    if (short.length) throw err("Materials short — cannot create this work order: " + short.join("; "), 400);
  }

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
  //    (toLegacy handles both legacy tuples and rich imported lines)
  BC.toLegacy(bom, BC.metaFromItem(item)).forEach(([rid, per]) => {
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
  const wo = withRoute(found);
  const route = wo.route || [];
  const curStage = route[Math.min(Math.max(wo.stageIdx || 0, 0), Math.max(route.length - 1, 0))] || {};
  if (!isOffice && user.area !== "all" && !S.areaCovers(user.area, curStage.area)) {
    throw err("This job is at the “" + (curStage.name || "current") + "” stage — not your work area", 403);
  }

  // 2) the materials this job's product actually consumes (union across stages).
  //    Legacy WOs with no derivable BOM plan → null (fall back to any raw material,
  //    still bounded by the category + on-hand checks below).
  const RAW = new Set(["RM", "PKG", "CON"]);
  const plan = S.computeStagePlan(wo.itemId, wo.qty, data, wo.materialChoices);
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
  const line = body.line || getLineForItem(item) || "Coating Line 1";
  const wo = {
    id: "WO-" + String(max + 1).padStart(4, "0"),
    date: todayISO(), itemId: item.id, qty: kg, status: "Released",
    due: null, line, progress: 0, priority: "Normal",
    route: S.freshRoute({ line, itemId: item.id }), stageIdx: 0, legacy: false,
    adhoc: true, rolls, lengthM, widthMM, gsm, sqm,
    createdBy: user.username, createdAt: now,
  };
  wo.status = S.rollupStatus(wo);
  repo.putWorkOrder(wo);

  const ref = "AP-" + Date.now().toString(36).toUpperCase();
  const moves = [{ id: mvId(), date: todayISO(), itemId: item.id, wh, type: "PROD",
    qty: Math.abs(kg), rate: item.cost || 0, ref, note: "Ad-hoc production " + wo.id, by: user.username }];

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

module.exports = { advance, createWorkOrder, produceFinished, recordExcessMaterial,
  updateWorkOrderStatus, returnStock, createAdhocProduction, ACTIONS };
