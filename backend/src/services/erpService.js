/* ============================================================
   CHHAPERIA ERP — BACKEND · ERP service (business logic)
   Sits between the HTTP routes and the database repository.
   Handles seeding-on-empty, full-state load/save, settings
   patch and reset. Keeps routes thin and the DB layer pure.
   ============================================================ */
"use strict";
const repo = require("../db/repository");
const { buildSeed } = require("../seed/seed");
const S = require("./stageService");

/** Load the full dataset; seed automatically on first run. */
function getState() {
  if (repo.isEmpty()) {
    repo.saveState(buildSeed());
  }
  return repo.getState();
}

/** One-time (idempotent) migration: derive WIP items + attach stage
    routes to work orders. Runs at boot and after any bulk save so
    imported/restored data is always stage-ready. Never wipes data. */
function ensureStageModel() {
  if (repo.isEmpty()) repo.saveState(buildSeed());
  const data = repo.getState();
  const res = S.ensureStageModel(data);
  if (res.changed || !(data.settings && data.settings._stageModel)) {
    data.settings = Object.assign({}, data.settings, { _stageModel: 1 });
    repo.saveState(data);
  }
  return res;
}

/** Restore the CRM pipeline if it is empty (this DB was originally
    seeded before the CRM module existed, so its leads table is blank).
    Leads are (re)built from the deterministic generator but re-pointed
    at the CURRENT customers/products so every reference stays valid.
    Populate-if-empty only — never clobbers existing leads. */
function ensureCrm() {
  if (repo.isEmpty()) repo.saveState(buildSeed());
  const data = repo.getState();
  if ((data.leads || []).length > 0) return { changed: false, count: data.leads.length };

  const itemById = Object.fromEntries((data.items || []).map((i) => [i.id, i]));
  const custIds = new Set((data.customers || []).map((c) => c.id));
  const fgIds = (data.items || []).filter((i) => i.cat === "FG").map((i) => i.id);
  if (!fgIds.length || !custIds.size) return { changed: false, count: 0 };

  const leads = (buildSeed().leads || []).map((l) => {
    const lead = Object.assign({}, l);
    // re-point product / customer references at the current dataset
    if (!itemById[lead.product]) lead.product = fgIds[0];
    lead.productName = (itemById[lead.product] || {}).name || lead.productName;
    if (lead.customerId && !custIds.has(lead.customerId)) lead.customerId = data.customers[0].id;
    return lead;
  });

  data.leads = leads;
  repo.saveState(data);
  return { changed: true, count: leads.length };
}

/** Persist the entire dataset (the frontend saves wholesale). */
function saveState(data) {
  if (!data || !Array.isArray(data.items) || !Array.isArray(data.movements)) {
    const err = new Error("Invalid dataset: items[] and movements[] are required");
    err.status = 400;
    throw err;
  }
  // keep any newly-introduced work orders / products stage-ready
  S.ensureStageModel(data);
  return repo.saveState(data);
}

/** Patch just the UI settings document. */
function updateSettings(doc) {
  return repo.updateSettings(doc || {});
}

/** Wipe and regenerate the deterministic demo dataset. */
function reset() {
  return repo.saveState(buildSeed());
}

function todayISO() {
  const x = new Date();
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
}
function err(msg, status) { const e = new Error(msg); e.status = status || 400; return e; }

/* ============================================================
   Granular writes — single-row updates for hot inventory paths,
   so a stock receipt / item edit no longer rewrites the ENTIRE
   dataset (faster + no last-writer-wins clobber between users).
   ============================================================ */

/** Create or update one stock item. Partial fields are merged over the
    existing row (so a PATCH never nulls out omitted columns). */
function upsertItem(item) {
  if (!item || !item.id) throw err("Item id is required", 400);
  const existing = repo.getItem(item.id);
  if (!existing && !item.name) throw err("New item needs a name", 400);
  const merged = existing ? Object.assign({}, existing, item) : item;
  return repo.putItem(merged);
}

/** Append one stock movement (manual receipt / adjustment). */
function addMovement(m) {
  if (!m || !m.itemId || !m.type) throw err("Movement needs itemId and type", 400);
  if (m.qty == null || isNaN(+m.qty)) throw err("Movement needs a numeric qty", 400);
  if (!m.id) m.id = "MV-" + Date.now() + "-" + Math.floor(Math.random() * 1e4);
  if (!m.date) m.date = todayISO();
  repo.addMovement(m);
  return { ok: true, id: m.id };
}

/** Receive goods against a PO: post GRN movements + update the PO row.
    body: { wh, date?, by?, lines:[{i:lineIndex, qty}] } */
function receivePurchaseOrder(poId, body) {
  body = body || {};
  const po = repo.getPurchaseOrder(poId);
  if (!po) throw err("Purchase order not found", 404);
  const wh = body.wh || "WH-PNY";
  const date = body.date || todayISO();
  const by = body.by || "user";
  const moves = [];
  (body.lines || []).forEach(({ i, qty }) => {
    const l = po.lines[i];
    if (!l) return;
    let rq = +qty || 0;
    const pend = l.qty - (l.recd || 0);
    if (rq > pend) rq = pend;
    if (rq > 0) {
      moves.push({ id: "MV-" + Date.now() + "-" + l.itemId, date, itemId: l.itemId, wh,
        type: "GRN", qty: rq, rate: l.rate || 0, ref: po.id, note: "Goods receipt vs PO",
        supplierId: po.supplierId, by });
      l.recd = +((l.recd || 0) + rq).toFixed(3);
    }
  });
  if (!moves.length) throw err("No quantity to receive", 400);
  repo.addMovements(moves);
  po.status = po.lines.every((l) => (l.recd || 0) >= l.qty - 0.0001) ? "Received" : "Partially Received";
  repo.putPurchaseOrder(po);
  return { ok: true, posted: moves.length, po: { id: po.id, status: po.status, lines: po.lines } };
}

module.exports = { getState, saveState, updateSettings, reset, ensureStageModel, ensureCrm,
  upsertItem, addMovement, receivePurchaseOrder };
