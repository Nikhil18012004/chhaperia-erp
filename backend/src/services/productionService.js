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
function advance(user, woId, action) {
  if (!user) throw err("Not authenticated", 401);
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
      const plan = S.computeStagePlan(wo.itemId, wo.qty, data, wo.materialChoices, wo.plan);
      if (plan && plan[stage.key]) {
        const moves = S.stageMovements(plan, stage.key, wo, itemsById, by, todayISO(), data.movements);
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

  return summarize(wo, data);
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

/* Tape width (mm) as entered on a work order. Blank clears it; anything that
   is not a sane positive measurement is rejected rather than silently stored. */
function widthOf(v) {
  if (v === undefined || v === null || v === "") return null;
  const w = +v;
  if (!isFinite(w) || w <= 0) throw err("Enter a valid tape width in mm", 400);
  if (w > 5000) throw err("Tape width looks wrong — enter it in millimetres", 400);
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

  /* Net the requirement against stock that already exists: finished goods go
     straight to packing, half-made rolls skip coating and start at slitting,
     and only the remainder is manufactured. */
  const plan = S.planForRequirement(body.itemId, qty, data, {
    widthMM: width, materialChoices: body.materialChoices,
    // the planner takes as much from stock as it can unless the office named
    // an amount — a blank means "use whatever is there", 0 means "use none"
    fgQty: body.fgQty, wipQty: body.wipQty,
  });

  // A run cannot be released without the materials to make it — but only the
  // part being MANUFACTURED needs any, so the check follows the netted figure.
  if (plan.makeQty > 0) {
    assertMaterialsAvailable(data, item, plan.makeQty, body.materialChoices);
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
    route: S.freshRoute({ line, itemId: body.itemId, qty, widthMM: width, plan,
      materialChoices: body.materialChoices }, data),
    stageIdx: 0, legacy: false,
    createdBy: user.username, createdAt: new Date().toISOString(),
  };
  if (width != null) wo.widthMM = width;
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
  const itemsById = Object.fromEntries((data.items || []).map((i) => [i.id, i]));
  const stagePlan = S.computeStagePlan(wo.itemId, wo.qty, data, wo.materialChoices, plan);
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
  return {
    ok: true, ref,
    produced: { itemId: item.id, name: item.name, qty, uom: item.uom || "", wh: warehouse.id, whName: warehouse.name },
    // how the run was met: off the shelf vs actually made from the recipe
    fromStock: { fgQty: fromStock.fgQty, wipQty: fromStock.wipQty, makeQty },
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
    // how the requirement was met: from finished stock, from half-made stock,
    // and how much is genuinely being manufactured
    plan: wo.plan || null,
    route: (wo.route || []).map((r) => ({ key: r.key, name: r.name, area: r.area, seq: r.seq,
      owner: r.owner || null, line: r.line || null,
      qty: r.qty != null ? r.qty : (wo.qty != null ? wo.qty : null),
      status: r.status, doneBy: r.doneBy, doneAt: r.doneAt })),
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

module.exports = { advance, createWorkOrder, updateWorkOrder, produceFinished, recordExcessMaterial,
  updateWorkOrderStatus, returnStock, createAdhocProduction, ACTIONS };
