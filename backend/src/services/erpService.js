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
const BC = require("../../../frontend/js/bomcalc");

/* Movement ids. A timestamp alone is not unique — several movements are posted
   inside the same millisecond, and keying the tail on the item id collides the
   moment one document names the same item twice (a two-lot delivery received
   against one PO used to throw UNIQUE constraint failed and 500 on the user).
   A process counter makes the tail strictly increasing instead. Same shape as
   stageService/productionService, which already learned this. */
let _mvSeq = 0;
function mvId() { return "MV-" + Date.now().toString(36).toUpperCase() + "-" + (++_mvSeq).toString(36).toUpperCase(); }

/** Load the full dataset; seed automatically on first run. */
function getState() {
  if (repo.isEmpty()) {
    repo.saveState(buildSeed());
  }
  return repo.getState();
}

/** One-time (idempotent) migration: attach stage
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
    "customers", "purchaseorders", "salesorders", "workorders", "leads", "grns"];
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
/* Kept beside updateSettings so the two lists that must agree with the
   frontend's STICKER_FIELDS / PAGE_SIZES are visible in one place. */
const STICKER_FIELD_KEYS = ["product", "supplier", "grade", "dateOfReceipt", "grnNo",
  "invoiceNo", "qty", "thickness", "gsm", "inspectedBy", "status"];
const STICKER_PAGES = ["A3", "A4", "A5", "A6", "Letter", "Legal", "custom"];

function updateSettings(doc) {
  doc = doc || {};
  if (typeof doc !== "object" || Array.isArray(doc)) throw err("Settings must be an object", 400);
  const clean = Object.assign({}, repo.getSettings() || {});
  if (doc.theme != null) clean.theme = doc.theme === "light" ? "light" : "dark";
  if (doc.accent != null) clean.accent = String(doc.accent).slice(0, 20);
  if ("autoAccent" in doc) clean.autoAccent = !!doc.autoAccent;
  if ("lowStockOnly" in doc) clean.lowStockOnly = !!doc.lowStockOnly;
  /* Label printing config: the whole print definition — which fields print,
     the sheet, its margins, the grid, the label size and the gaps. Whitelisted
     key by key so a bad client can't stuff arbitrary JSON into the shared
     settings document. ADDING A LABEL FIELD means adding its key to
     STICKER_FIELD_KEYS below AND to STICKER_FIELDS in frontend/js/mod-trade.js;
     a key missing here is silently dropped on save. w/h are the pre-layout
     roll size, still accepted so an older saved config keeps working. */
  if (doc.sticker != null && typeof doc.sticker === "object" && !Array.isArray(doc.sticker)) {
    const s = doc.sticker;
    const mm = (v, d) => { v = +v; return isNaN(v) || v <= 0 ? d : Math.min(300, Math.max(25, v)); };
    // a margin or gap of 0 is a real choice, so dim() accepts it; pick() won't
    const dim = (v, d, lo, hi) => { v = +v; return isNaN(v) ? d : Math.min(hi, Math.max(lo, v)); };
    const pick = (v, d, lo, hi) => { v = +v; return isNaN(v) || v <= 0 ? d : Math.min(hi, Math.max(lo, v)); };
    const int = (v, d, lo, hi) => { v = Math.round(+v); return isNaN(v) ? d : Math.min(hi, Math.max(lo, v)); };
    /* Fields the operator invented in the dialog. The key becomes a settings
       key AND a CSV column name, so it is held to a strict shape rather than
       trusted; anything else is dropped. */
    const custom = (Array.isArray(s.custom) ? s.custom : []).slice(0, 40)
      .map((c) => ({ k: String((c && c.k) || ""), label: String((c && c.label) || "").slice(0, 44) }))
      .filter((c) => /^cx[A-Za-z0-9]{1,20}$/.test(c.k) && c.label);
    const keys = STICKER_FIELD_KEYS.concat(custom.map((c) => c.k));
    const fields = {};
    keys.forEach((k) => { fields[k] = !s.fields || s.fields[k] !== false; });
    /* `order` is what actually prints, and in what sequence — unknown keys and
       repeats are stripped so a bad client can't grow it without bound. */
    const order = (Array.isArray(s.order) ? s.order : []).map(String)
      .filter((k, i, a) => keys.indexOf(k) >= 0 && a.indexOf(k) === i);
    const txt = (v, d, max) => (v == null ? d : String(v)).slice(0, max);
    clean.sticker = {
      w: mm(s.w, 100), h: mm(s.h, 150), fields, custom,
      // an empty order means "never picked" — the client falls back to the ticks
      order: order.length ? order : undefined,
      title: txt(s.title, "RAW MATERIAL", 120),
      para: txt(s.para, "", 1200),
      layout: s.layout === "plain" ? "plain" : "table",
      copies: int(s.copies, 1, 1, 500),
      page: STICKER_PAGES.includes(s.page) ? s.page : "A4",
      pageW: pick(s.pageW, 210, 20, 1000), pageH: pick(s.pageH, 297, 20, 1000),
      landscape: !!s.landscape,
      unit: s.unit === "cm" ? "cm" : "mm",
      mTop: dim(s.mTop, 10, 0, 200), mBottom: dim(s.mBottom, 10, 0, 200),
      mLeft: dim(s.mLeft, 8, 0, 200), mRight: dim(s.mRight, 8, 0, 200),
      rows: int(s.rows, 2, 1, 50), cols: int(s.cols, 2, 1, 20),
      autoSize: s.autoSize !== false,
      // 0 = no label size has ever been set; the layout decides it instead
      labelW: dim(s.labelW, 0, 0, 1000), labelH: dim(s.labelH, 0, 0, 1000),
      gapX: dim(s.gapX, 3, 0, 100), gapY: dim(s.gapY, 3, 0, 100),
    };
  }
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

const MOVE_TYPES = ["OPEN", "GRN", "ISSUE", "PROD", "SALE", "ADJ", "RET", "SCRAP", "XFER"];

/** Append one stock movement (manual receipt / adjustment). */
function addMovement(m) {
  if (!m || !m.itemId || !m.type) throw err("Movement needs itemId and type", 400);
  if (m.qty == null || isNaN(+m.qty)) throw err("Movement needs a numeric qty", 400);
  if (!MOVE_TYPES.includes(m.type)) throw err("Invalid movement type '" + m.type + "'", 400);
  const mvItem = repo.getItem(m.itemId);
  if (!mvItem) throw err("Unknown item " + m.itemId, 400);
  // WIP items are stage-engine plumbing — a receipt into one silently hides
  // the stock from every work order (which consumes the RAW material).
  // This actually happened: 2000 m of mica tape got booked to WIP-CP25G-08-S,
  // posted by a stale browser tab running an older Add Stock form.
  // Add Stock now offers WIP deliberately, so a receipt carrying `manual` is
  // allowed through; anything else reaching a WIP item is still refused.
  if (m.type === "GRN" && mvItem.cat === "WIP" && !m.manual) {
    throw err("Cannot receive stock into a WIP item (" + m.itemId + "). Receive the raw material itself instead.", 400);
  }
  m.qty = +m.qty;
  if (m.rate != null && m.rate !== "") m.rate = +m.rate || 0;
  if (!m.id) m.id = mvId();
  if (!m.date) m.date = todayISO();
  repo.addMovement(m);
  return { ok: true, id: m.id };
}

/* GRN numbers run in an April–March fiscal-year series: GRN/26-27/0001.
   Issued here, inside the receive path, so both receiving screens share one
   sequence and two browsers can never mint the same number. */
function nextGrnNo(dateISO) {
  const [y, m] = String(dateISO).split("-").map(Number);
  const startYY = (m >= 4 ? y : y - 1) % 100;
  const fy = String(startYY).padStart(2, "0") + "-" + String((startYY + 1) % 100).padStart(2, "0");
  let max = 0;
  repo.getGrns().forEach((g) => {
    const match = new RegExp("^GRN/" + fy + "/(\\d+)$").exec(String(g.id || ""));
    if (match) max = Math.max(max, +match[1]);
  });
  return "GRN/" + fy + "/" + String(max + 1).padStart(4, "0");
}
const strOr = (v, n) => (v == null ? "" : String(v).slice(0, n || 80));

/** Receive goods against a PO: post GRN movements, update the PO row and
    issue a numbered goods receipt note.
    body: { wh, date?, lines:[{i:lineIndex, qty, rejected?}],
            invNo?, invDate?, vehicle?, lrNo?, remarks? };
    `user` is the actor (from the auth token) so the receipt is attributed
    to a real person. Only the ACCEPTED quantity (received − rejected) posts
    to stock and advances the order — a rejected lot goes back on the truck,
    so the line stays owed; the rejection lives on the GRN for the debit note. */
function receivePurchaseOrder(poId, body, user) {
  body = body || {};
  const po = repo.getPurchaseOrder(poId);
  if (!po) throw err("Purchase order not found", 404);
  const wh = body.wh || "WH-PNY";
  const date = body.date || todayISO();
  const by = (user && user.username) || body.by || "user";
  const moves = [];
  const grnLines = [];
  (body.lines || []).forEach(({ i, qty, rejected }) => {
    const l = po.lines[i];
    if (!l) return;
    let rq = +qty || 0;
    const pend = l.qty - (l.recd || 0);
    if (rq > pend) rq = pend;
    if (rq <= 0) return;
    let rej = +rejected || 0;
    if (rej < 0) rej = 0;
    if (rej > rq) rej = rq;
    const acc = +(rq - rej).toFixed(3);
    const item = repo.getItem(l.itemId) || {};
    const from = l.uom || item.uom;
    let stockQty = acc;
    let note = "Goods receipt vs PO";
    if (acc > 0) {
      /* A roll may be ordered by length and invoiced by weight, or the other
         way round. Stock is only ever held in the material's OWN unit, so the
         received quantity is restated into it here — through the roll's fixed
         width and its GSM, which makes the figure exact rather than a guess.
         The PO line keeps its own unit; only the stock movement is converted. */
      if (BC.normUnit(from) !== BC.normUnit(item.uom)) {
        const conv = BC.convertQty(acc, from, item.uom, item);
        if (conv == null) {
          throw err("Cannot receive " + acc + " " + from + " of " + (item.name || l.itemId)
            + " — it is stocked in " + (item.uom || "?")
            + " and the two cannot be reconciled. Set the material's width and GSM, or order in "
            + (item.uom || "its stocking unit") + ".", 400);
        }
        stockQty = Math.round(conv * 1000) / 1000;
        note = "Goods receipt vs PO — " + acc + " " + BC.normUnit(from)
          + " received as " + stockQty + " " + BC.normUnit(item.uom);
      }
      moves.push({ id: mvId(), date, itemId: l.itemId, wh,
        type: "GRN", qty: stockQty, rate: l.rate || 0, ref: po.id, note,
        supplierId: po.supplierId, by });
      l.recd = +((l.recd || 0) + acc).toFixed(3);   // progress is in the ORDER's unit
    }
    grnLines.push({ itemId: l.itemId, name: item.name || l.itemId,
      uom: BC.normUnit(from) || item.uom || "", hsn: l.hsn || item.hsn || "",
      ordered: l.qty, qty: rq, rejected: rej, accepted: acc,
      rate: l.rate || 0, stockQty: acc > 0 ? stockQty : 0 });
  });
  if (!grnLines.length) throw err("No quantity to receive", 400);
  const grn = {
    id: nextGrnNo(date), date, poId: po.id, poDate: po.date || "",
    supplierId: po.supplierId, company: po.company || "", wh, by, status: "Posted",
    invNo: strOr(body.invNo), invDate: strOr(body.invDate, 20),
    vehicle: strOr(body.vehicle, 20), lrNo: strOr(body.lrNo, 40),
    remarks: strOr(body.remarks, 500), lines: grnLines,
  };
  if (moves.length) repo.addMovements(moves);
  repo.putGrn(grn);
  po.status = po.lines.every((l) => (l.recd || 0) >= l.qty - 0.0001) ? "Received" : "Partially Received";
  repo.putPurchaseOrder(po);
  return { ok: true, posted: moves.length, grn, po: { id: po.id, status: po.status, lines: po.lines } };
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
    id: mvId(), date, itemId: l.itemId, wh, type: "SALE",
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
  // Normalise to the rich line shape and KEEP it. Flattening to [id, qty]
  // here would silently discard pickup %, the material's type/thickness/GSM
  // and the ranged flag on every save — i.e. lose the recipe's real content.
  // A ranged line has no single id yet (it resolves against stock at issue),
  // so it is valid as long as it carries candidate options.
  const clean = BC.normalize(bom.lines)
    .filter((l) => (l.id || (l.options && l.options.length)) && l.qty > 0);
  if (!clean.length) throw err("A BOM needs at least one component with a positive quantity", 400);
  let y = num(bom.yield) || 1;
  if (y > 1) y = y / 100;                       // accept 0-1 fraction or 1-100 percent
  y = Math.min(1, Math.max(0.01, y));
  const out = { yield: y, lines: clean };
  // alternate approved recipes (different fabric supplier) travel with the BOM
  if (Array.isArray(bom.alternates) && bom.alternates.length) {
    out.alternates = bom.alternates.map((a) => ({
      label: String(a.label || "").slice(0, 60) || "Variant",
      lines: BC.normalize(a.lines).filter((l) => (l.id || (l.options && l.options.length)) && l.qty > 0),
    })).filter((a) => a.lines.length);
  }
  return repo.putBom(itemId, out);
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
function updateCustomer(id, patch) {
  const existing = repo.getCustomer(id);
  if (!existing) throw err("Customer not found", 404);
  const merged = Object.assign({}, existing, patch || {}, { id });
  if (!merged.name) throw err("Customer needs a name", 400);
  return repo.putCustomer(merged);
}
function deleteCustomer(id) {
  if (!repo.getCustomer(id)) throw err("Customer not found", 404);
  const st = repo.getState();
  const sos = (st.salesorders || []).filter((s) => s.customerId === id).length;
  const leads = (st.leads || []).filter((l) => l.customerId === id).length;
  if (sos) throw err(`Cannot delete: ${sos} sales order(s) reference this customer. Delete or re-point them first.`, 400);
  if (leads) throw err(`Cannot delete: ${leads} CRM lead(s) reference this customer. Delete or re-point them first.`, 400);
  return repo.deleteCustomer(id);
}

/* ---- Suppliers (create / update / delete) ---- */
function createSupplier(s) {
  s = s || {};
  if (!s.name) throw err("Supplier needs a name", 400);
  if (!s.id) s.id = nextId(repo.getState().suppliers, "SUP-");
  else if (repo.getSupplier(s.id)) throw err("Supplier " + s.id + " already exists", 409);
  return repo.putSupplier(s);
}
function updateSupplier(id, patch) {
  const existing = repo.getSupplier(id);
  if (!existing) throw err("Supplier not found", 404);
  const merged = Object.assign({}, existing, patch || {}, { id });
  if (!merged.name) throw err("Supplier needs a name", 400);
  return repo.putSupplier(merged);
}
function deleteSupplier(id) {
  if (!repo.getSupplier(id)) throw err("Supplier not found", 404);
  const st = repo.getState();
  const pos = (st.purchaseorders || []).filter((p) => p.supplierId === id).length;
  const items = (st.items || []).filter((i) => i.supplierId === id).length;
  if (pos) throw err(`Cannot delete: ${pos} purchase order(s) reference this supplier. Delete or re-point them first.`, 400);
  if (items) throw err(`Cannot delete: ${items} item(s) name this supplier as their source. Re-point them first.`, 400);
  return repo.deleteSupplier(id);
}

/* Populate-if-empty: the two billing entities every PO/SO invoices under.
   Cable Material's identifiers come from its own printed invoice template;
   International's GSTIN is pending from the user (Settings → Invoice
   Companies shows a warning until it is filled in). */
function ensureCompanies() {
  const org = repo.getOrg() || {};
  if (Array.isArray(org.companies) && org.companies.length) return { changed: false, count: org.companies.length };
  const ADDRESS = "Sy. No. 18, K.G. Kuntanahalli, Kasaba Hobli, Doddaballapur Taluk, Bangalore Rural District - 561203, Karnataka, India";
  const TAGLINE = "Material Science Meets Global Demand";
  org.companies = [
    { key: "CCM", name: "Chhaperia Cable Material Pvt. Ltd.", tagline: TAGLINE,
      gstin: "29AAICC5462H1ZE", pan: "AAICC5462H", cin: "U27320KA2008PTC046773",
      iec: "AAICC5462H",
      address: ADDRESS, stateCode: "29", state: "Karnataka",
      phone: "+91 80 2763 0006", email: "info@micagroup.net", website: "www.micagroup.net",
      bank: { name: "", acName: "", acNo: "", ifsc: "", branch: "", upi: "", swift: "", address: "" }, terms: [] },
    { key: "CIC", name: "Chhaperia International Company", tagline: TAGLINE,
      gstin: "29ABIPC4133H1ZV", pan: "ABIPC4133H", cin: "",
      iec: "",
      address: ADDRESS, stateCode: "29", state: "Karnataka",
      phone: "+91 80 2763 0006", email: "info@micagroup.net", website: "www.micagroup.net",
      bank: { name: "", acName: "", acNo: "", ifsc: "", branch: "", upi: "", swift: "", address: "" }, terms: [] },
  ];
  org.tagline = org.tagline || TAGLINE;
  org.gst = org.companies[0].gstin;      // legacy single-entity fields follow the primary company
  repo.putOrg(org);
  return { changed: true, count: org.companies.length };
}

/* ---- Org / company profile (invoice entities live in org.companies[]) ---- */
function updateOrg(patch) {
  patch = patch || {};
  if (typeof patch !== "object" || Array.isArray(patch)) throw err("Org patch must be an object", 400);
  const merged = Object.assign({}, repo.getOrg() || {}, patch);
  if (Array.isArray(patch.companies)) {
    merged.companies = patch.companies.map((c) => ({
      key: String(c.key || "").trim() || "CO",
      name: String(c.name || "").trim(),
      tagline: c.tagline || "",
      gstin: String(c.gstin || "").trim().toUpperCase(),
      pan: String(c.pan || "").trim().toUpperCase(),
      cin: String(c.cin || "").trim().toUpperCase(),
      iec: String(c.iec || "").trim().toUpperCase(),
      address: c.address || "",
      stateCode: String(c.stateCode || "").trim() || (String(c.gstin || "").trim().slice(0, 2) || ""),
      state: c.state || "",
      phone: c.phone || "", email: c.email || "", website: c.website || "",
      bank: {
        name: (c.bank && c.bank.name) || "",
        acName: (c.bank && c.bank.acName) || "",
        acNo: (c.bank && c.bank.acNo) || "",
        ifsc: (c.bank && c.bank.ifsc) || "",
        branch: (c.bank && c.bank.branch) || "",
        upi: (c.bank && c.bank.upi) || "",
        swift: (c.bank && c.bank.swift) || "",
        address: (c.bank && c.bank.address) || "",
      },
      terms: Array.isArray(c.terms) ? c.terms.map(String) : [],
    })).filter((c) => c.name);
  }
  return repo.putOrg(merged);
}

/* ---- Warehouses: master-data edits (rename etc.) ---- */
function updateWarehouse(id, patch) {
  const existing = repo.getWarehouse(id);
  if (!existing) throw err("Warehouse not found", 404);
  const merged = Object.assign({}, existing, patch || {}, { id });
  merged.name = String(merged.name || "").trim();
  if (!merged.name) throw err("Warehouse needs a name", 400);
  return repo.putWarehouse(merged);
}

/* ---- Appointments (calendar diary entries) ----
   Deliberately thin. An appointment is a commitment to a TIME, so a date is
   the one thing it cannot be without — everything else (who it is with, where,
   the notes) is optional and rides in the doc. The calendar's other entries are
   derived from POs, SOs, work orders and leads and never land in this table. */
const APPT_KINDS = ["Meeting", "Call", "Site Visit", "Sample Follow-up", "Payment Follow-up", "Reminder"];
function createAppointment(a) {
  a = a || {};
  if (!a.title) throw err("An appointment needs a title", 400);
  if (!a.date) throw err("An appointment needs a date", 400);
  if (a.kind && !APPT_KINDS.includes(a.kind)) throw err("Unknown appointment kind " + a.kind, 400);
  if (!a.id) a.id = nextId(repo.getState().appointments, "AP-");
  else if (repo.getAppointment(a.id)) throw err("Appointment " + a.id + " already exists", 409);
  a.kind = a.kind || "Meeting";
  a.created = a.created || todayISO();
  if (a.done == null) a.done = false;
  return repo.putAppointment(a);
}
function updateAppointment(id, patch) {
  const existing = repo.getAppointment(id);
  if (!existing) throw err("Appointment not found", 404);
  const merged = Object.assign({}, existing, patch || {}, { id });
  if (!merged.title) throw err("An appointment needs a title", 400);
  if (!merged.date) throw err("An appointment needs a date", 400);
  if (merged.kind && !APPT_KINDS.includes(merged.kind)) throw err("Unknown appointment kind " + merged.kind, 400);
  return repo.putAppointment(merged);
}
function deleteAppointment(id) {
  if (!repo.getAppointment(id)) throw err("Appointment not found", 404);
  return repo.deleteAppointment(id);
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
/** No-op. The demo transport agencies were removed on request (2026-08-05);
 *  the dispatch directory now starts empty and is filled by the user only. */
function ensureDispatch() {
  return { changed: false, count: (repo.getState().transporters || []).length };
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
  saveBom, deleteBom, createLead, updateLead, deleteLead,
  upsertCustomer, updateCustomer, deleteCustomer,
  createSupplier, updateSupplier, deleteSupplier, updateOrg, ensureCompanies,
  deleteItem, deleteWorkOrder, nextId, updateWarehouse,
  createTransporter, updateTransporter, deleteTransporter, ensureDispatch,
  createAppointment, updateAppointment, deleteAppointment, APPT_KINDS };
