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

/** Persist the entire dataset (the frontend saves wholesale). Validates
    shape + referential integrity so a malformed backup/restore can't quietly
    persist orphan movements or non-array collections. */
function saveState(data) {
  if (!data || typeof data !== "object") throw err("Invalid dataset", 400);
  const arrays = ["items", "movements", "warehouses", "categories", "suppliers",
    "customers", "purchaseorders", "salesorders", "workorders", "leads"];
  for (const k of arrays) {
    if (data[k] != null && !Array.isArray(data[k])) throw err(`Invalid dataset: ${k} must be an array`, 400);
  }
  if (!Array.isArray(data.items) || !Array.isArray(data.movements)) {
    throw err("Invalid dataset: items[] and movements[] are required", 400);
  }
  // referential integrity: every movement must reference a known item
  const itemIds = new Set(data.items.map((i) => i && i.id));
  const orphan = data.movements.find((m) => m && m.itemId && !itemIds.has(m.itemId));
  if (orphan) throw err(`Movement ${orphan.id || ""} references unknown item ${orphan.itemId}`, 400);
  // keep any newly-introduced work orders / products stage-ready
  S.ensureStageModel(data);
  return repo.saveState(data);
}

/** Patch the UI settings document — whitelist known keys, coerce types, and
    MERGE over the stored settings so internal flags (e.g. _stageModel) survive. */
function updateSettings(doc) {
  doc = doc || {};
  if (typeof doc !== "object" || Array.isArray(doc)) throw err("Settings must be an object", 400);
  const clean = Object.assign({}, repo.getSettings() || {});
  if (doc.theme != null) clean.theme = doc.theme === "light" ? "light" : "dark";
  if (doc.accent != null) clean.accent = String(doc.accent).slice(0, 20);
  if ("autoAccent" in doc) clean.autoAccent = !!doc.autoAccent;
  if ("lowStockOnly" in doc) clean.lowStockOnly = !!doc.lowStockOnly;
  return repo.updateSettings(clean);
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
  const merged = existing ? Object.assign({}, existing, item) : Object.assign({}, item);
  // coerce numeric columns so a stringy "42" never lands in a REAL column
  ["cost", "price", "reorder", "safety", "lead"].forEach((k) => {
    if (merged[k] != null && merged[k] !== "") merged[k] = +merged[k] || 0;
  });
  // fail fast on a bad category instead of leaking a raw FK-violation 500
  if (merged.cat && !repo.categoryExists(merged.cat)) throw err("Unknown category " + merged.cat, 400);
  return repo.putItem(merged);
}

const MOVE_TYPES = ["OPEN", "GRN", "ISSUE", "PROD", "SALE", "ADJ", "RET", "SCRAP"];

/** Append one stock movement (manual receipt / adjustment). */
function addMovement(m) {
  if (!m || !m.itemId || !m.type) throw err("Movement needs itemId and type", 400);
  if (m.qty == null || isNaN(+m.qty)) throw err("Movement needs a numeric qty", 400);
  if (!MOVE_TYPES.includes(m.type)) throw err("Invalid movement type '" + m.type + "'", 400);
  if (!repo.getItem(m.itemId)) throw err("Unknown item " + m.itemId, 400);
  m.qty = +m.qty;
  if (m.rate != null && m.rate !== "") m.rate = +m.rate || 0;
  if (!m.id) m.id = "MV-" + Date.now() + "-" + Math.floor(Math.random() * 1e4);
  if (!m.date) m.date = todayISO();
  repo.addMovement(m);
  return { ok: true, id: m.id };
}

/** Receive goods against a PO: post GRN movements + update the PO row.
    body: { wh, date?, lines:[{i:lineIndex, qty}] }; `user` is the actor
    (from the auth token) so the receipt is attributed to a real person. */
function receivePurchaseOrder(poId, body, user) {
  body = body || {};
  const po = repo.getPurchaseOrder(poId);
  if (!po) throw err("Purchase order not found", 404);
  const wh = body.wh || "WH-PNY";
  const date = body.date || todayISO();
  const by = (user && user.username) || body.by || "user";
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

/* collision-free sequential id from the highest numeric suffix in use. */
function nextId(list, prefix) {
  let max = 0, width = 3;
  (list || []).forEach((x) => {
    const m = /(\d+)\s*$/.exec(String((x && x.id) || ""));
    if (m) { max = Math.max(max, +m[1]); width = Math.max(width, m[1].length); }
  });
  return prefix + String(max + 1).padStart(width, "0");
}
function num(v) { return v == null || v === "" || isNaN(+v) ? 0 : +v; }

/* ---- Purchase orders (create / update / delete) ---- */
function createPurchaseOrder(po) {
  po = po || {};
  if (!Array.isArray(po.lines) || !po.lines.length) throw err("A purchase order needs at least one line", 400);
  if (!po.id) po.id = nextId(repo.getState().purchaseorders, "PO-");
  else if (repo.getPurchaseOrder(po.id)) throw err("Purchase order " + po.id + " already exists", 409);
  po.date = po.date || todayISO();
  po.status = po.status || "Open";
  po.value = num(po.value) || po.lines.reduce((s, l) => s + num(l.qty) * num(l.rate), 0);
  return repo.putPurchaseOrder(po);
}
function updatePurchaseOrder(id, patch) {
  const existing = repo.getPurchaseOrder(id);
  if (!existing) throw err("Purchase order not found", 404);
  const merged = Object.assign({}, existing, patch || {}, { id });
  if (!Array.isArray(merged.lines) || !merged.lines.length) throw err("A purchase order needs at least one line", 400);
  return repo.putPurchaseOrder(merged);
}
function deletePurchaseOrder(id) {
  if (!repo.getPurchaseOrder(id)) throw err("Purchase order not found", 404);
  return repo.deletePurchaseOrder(id);
}

/* ---- Sales orders (create / update / delete) ---- */
function createSalesOrder(so) {
  so = so || {};
  if (!Array.isArray(so.lines) || !so.lines.length) throw err("A sales order needs at least one line", 400);
  if (!so.id) so.id = nextId(repo.getState().salesorders, "SO-");
  else if (repo.getSalesOrder(so.id)) throw err("Sales order " + so.id + " already exists", 409);
  so.date = so.date || todayISO();
  so.status = so.status || "Confirmed";
  so.priority = so.priority || "Normal";
  so.value = num(so.value) || so.lines.reduce((s, l) => s + num(l.qty) * num(l.rate), 0);
  return repo.putSalesOrder(so);
}
function updateSalesOrder(id, patch) {
  const existing = repo.getSalesOrder(id);
  if (!existing) throw err("Sales order not found", 404);
  const merged = Object.assign({}, existing, patch || {}, { id });
  if (!Array.isArray(merged.lines) || !merged.lines.length) throw err("A sales order needs at least one line", 400);
  return repo.putSalesOrder(merged);
}
function deleteSalesOrder(id) {
  if (!repo.getSalesOrder(id)) throw err("Sales order not found", 404);
  return repo.deleteSalesOrder(id);
}
/** Dispatch a sales order: post SALE (outbound) movements for every line and
    mark it Dispatched — in one shot, server-side (mirrors receivePurchaseOrder).
    `user` is the actor from the auth token. */
function dispatchSalesOrder(soId, body, user) {
  body = body || {};
  const so = repo.getSalesOrder(soId);
  if (!so) throw err("Sales order not found", 404);
  if (so.status === "Dispatched") throw err("Sales order already dispatched", 400);
  const date = body.date || todayISO();
  const wh = body.wh || "WH-FG";
  const by = (user && user.username) || "sales";
  const moves = (so.lines || []).map((l) => ({
    id: "MV-" + Date.now() + "-" + l.itemId, date, itemId: l.itemId, wh, type: "SALE",
    qty: -Math.abs(num(l.qty)), rate: l.rate || 0, ref: so.id, note: "Dispatch vs SO", by,
  }));
  if (moves.length) repo.addMovements(moves);
  so.status = "Dispatched";
  repo.putSalesOrder(so);
  return { ok: true, posted: moves.length, so: { id: so.id, status: so.status } };
}

/* ---- BOM (save recipe / delete) ---- */
function saveBom(itemId, bom) {
  if (!itemId) throw err("BOM needs a product id", 400);
  if (!repo.getItem(itemId)) throw err("Unknown product " + itemId, 400);
  bom = bom || {};
  if (!Array.isArray(bom.lines) || !bom.lines.length) throw err("A BOM needs at least one component", 400);
  const clean = bom.lines
    .map((l) => (Array.isArray(l) ? [l[0], num(l[1])] : [l.rawId || l.id, num(l.per || l.qty)]))
    .filter((l) => l[0] && l[1] > 0);
  if (!clean.length) throw err("A BOM needs at least one component with a positive quantity", 400);
  let y = num(bom.yield) || 1;
  if (y > 1) y = y / 100;                       // accept 0-1 fraction or 1-100 percent
  y = Math.min(1, Math.max(0.01, y));
  return repo.putBom(itemId, { yield: y, lines: clean });
}
function deleteBom(itemId) {
  if (!repo.getBom(itemId)) throw err("No BOM for " + itemId, 404);
  return repo.deleteBom(itemId);
}

/* ---- CRM leads (create / update / delete) ---- */
function createLead(lead) {
  lead = lead || {};
  if (!lead.company) throw err("A lead needs a company", 400);
  if (!lead.id) lead.id = nextId(repo.getState().leads, "LD-");
  else if (repo.getLead(lead.id)) throw err("Lead " + lead.id + " already exists", 409);
  lead.stage = lead.stage || "New";
  lead.created = lead.created || todayISO();
  if (!Array.isArray(lead.activities)) lead.activities = [];
  return repo.putLead(lead);
}
function updateLead(id, patch) {
  const existing = repo.getLead(id);
  if (!existing) throw err("Lead not found", 404);
  const merged = Object.assign({}, existing, patch || {}, { id });
  if (!merged.company) throw err("A lead needs a company", 400);
  return repo.putLead(merged);
}
function deleteLead(id) {
  if (!repo.getLead(id)) throw err("Lead not found", 404);
  return repo.deleteLead(id);
}

/* ---- Customer upsert (CRM Won→customer conversion) ---- */
function upsertCustomer(cust) {
  if (!cust || !cust.id || !cust.name) throw err("Customer needs an id and name", 400);
  return repo.putCustomer(cust);
}

/* ---- Transporters (dispatch providers) ---- */
function createTransporter(t) {
  t = t || {};
  if (!t.name) throw err("Transporter needs a name", 400);
  if (!t.id) t.id = nextId(repo.getState().transporters, "TR-");
  else if (repo.getTransporter(t.id)) throw err("Transporter " + t.id + " already exists", 409);
  if (t.active == null) t.active = true;
  return repo.putTransporter(t);
}
function updateTransporter(id, patch) {
  const existing = repo.getTransporter(id);
  if (!existing) throw err("Transporter not found", 404);
  const merged = Object.assign({}, existing, patch || {}, { id });
  if (!merged.name) throw err("Transporter needs a name", 400);
  return repo.putTransporter(merged);
}
function deleteTransporter(id) {
  if (!repo.getTransporter(id)) throw err("Transporter not found", 404);
  return repo.deleteTransporter(id);
}
/** Seed a few demo transport agencies on first run (populate-if-empty). */
function ensureDispatch() {
  const st = repo.getState();
  if ((st.transporters || []).length > 0) return { changed: false, count: st.transporters.length };
  const demo = [
    { name: "Sri Balaji Roadways", contact: "Ravi Shetty", phone: "98450 12345", email: "ops@sribalaji.in", city: "Bengaluru", state: "Karnataka", gstin: "29ABCFS1234K1Z5", vehicleTypes: ["Truck (32ft)", "Trailer"], routes: "Bengaluru · Chennai · Hyderabad", rateBasis: "Per trip", baseRate: 18000, onTime: 94, rating: "A", owner: "Dispatch Desk", terms: "30 days", active: true, notes: "Preferred for HT cable dispatches to South." },
    { name: "Doddaballapur Cargo Movers", contact: "Manjunath R", phone: "99001 23456", email: "book@dblcargo.com", city: "Doddaballapur", state: "Karnataka", gstin: "29AAGCD7788L1Z2", vehicleTypes: ["LCV", "Tempo"], routes: "Local · Bengaluru metro", rateBasis: "Per km", baseRate: 42, onTime: 88, rating: "B", owner: "Plant Store", terms: "15 days", active: true, notes: "Fast local & last-mile." },
    { name: "Bharat Express Logistics", contact: "Sanjay Gupta", phone: "98111 45678", email: "sanjay@bharatexp.in", city: "Bengaluru", state: "Karnataka", gstin: "29AAACB9012M1Z8", vehicleTypes: ["Container (20ft)", "Container (40ft)"], routes: "PAN-India · Mumbai · Delhi · Kolkata", rateBasis: "Per ton", baseRate: 2600, onTime: 91, rating: "A", owner: "Dispatch Desk", terms: "45 days", active: true, notes: "Containerised, good for exports via port." },
    { name: "Krishna Freight Carriers", contact: "Lokesh N", phone: "94488 77661", email: "krishnafreight@gmail.com", city: "Tumakuru", state: "Karnataka", gstin: "29ABLFK3344N1Z0", vehicleTypes: ["Truck (20ft)", "LCV"], routes: "Karnataka · Kerala", rateBasis: "Per trip", baseRate: 12500, onTime: 79, rating: "C", owner: "Plant Store", terms: "Advance", active: true, notes: "Backup carrier; confirm availability." },
    { name: "SafeWheels Transport Co.", contact: "Imran Khan", phone: "90080 55221", email: "dispatch@safewheels.co.in", city: "Hosur", state: "Tamil Nadu", gstin: "33AABCS6677P1Z4", vehicleTypes: ["Trailer", "Truck (32ft)"], routes: "Hosur · Chennai · Coimbatore", rateBasis: "Per trip", baseRate: 16500, onTime: 96, rating: "A", owner: "Dispatch Desk", terms: "30 days", active: true, notes: "Excellent on-time record; insured." },
  ];
  let n = 0;
  demo.forEach((d, i) => { d.id = "TR-" + String(i + 1).padStart(3, "0"); repo.putTransporter(d); n++; });
  return { changed: true, count: n };
}

/* ---- Deletes for item / work order ---- */
function deleteItem(id) {
  if (!repo.getItem(id)) throw err("Item not found", 404);
  return repo.deleteItem(id);
}
function deleteWorkOrder(id) {
  if (!repo.getWorkOrder(id)) throw err("Work order not found", 404);
  return repo.deleteWorkOrder(id);
}

module.exports = { getState, saveState, updateSettings, reset, ensureStageModel, ensureCrm,
  upsertItem, addMovement, receivePurchaseOrder,
  createPurchaseOrder, updatePurchaseOrder, deletePurchaseOrder,
  createSalesOrder, updateSalesOrder, deleteSalesOrder, dispatchSalesOrder,
  saveBom, deleteBom, createLead, updateLead, deleteLead, upsertCustomer,
  deleteItem, deleteWorkOrder, nextId,
  createTransporter, updateTransporter, deleteTransporter, ensureDispatch };
