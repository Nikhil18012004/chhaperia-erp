/* ============================================================
   CHHAPERIA ERP — BACKEND · REST routes (protected)
       GET    /api/health         -> liveness (public)
       GET    /api/state          -> role-scoped dataset (auth)
       PUT    /api/state          -> replace full dataset (admin/office)
       PATCH  /api/settings       -> patch UI settings (admin/office)
       POST   /api/reset          -> regenerate demo data (admin only)
   Auth is enforced server-side: supervisors receive only their
   money-free, area-scoped production view.
   ============================================================ */
"use strict";
const express = require("express");
const erp = require("../services/erpService");
const view = require("../services/viewService");
const production = require("../services/productionService");
const lab = require("../services/labService");
const grnTest = require("../services/grnTestService");
const catalogue = require("../services/catalogueService");
const tds = require("../services/tdsService");
const { requireAuth, requireRole } = require("./auth");

const router = express.Router();

router.get("/health", (req, res) => {
  res.json({ ok: true, service: "chhaperia-erp-api", time: new Date().toISOString() });
});

// Role-scoped read: admin/office get the full dataset, supervisors get their view.
router.get("/state", requireAuth, async (req, res, next) => {
  // ?slim=1 — the floor's refresh after a stage action; skips the bulky
  // product catalogue the client already holds. Ignored for other roles.
  try { res.json(await view.stateForUser(req.user, { slim: req.query.slim === "1" })); } catch (e) { next(e); }
});

// Supervisor (or office/admin) advances a work order's CURRENT stage.
// action: start | pause | complete | dispatch  — area-scoped, money-free.
// Stage transitions are driven by supervisors (their area) + admin; office
// plans work orders but does not determine process stages.
// `all: true` runs every remaining stage in this one request instead of the
// browser firing a POST per stage.
router.post("/production/wo/:id/advance", requireAuth, requireRole("supervisor", "admin"), async (req, res, next) => {
  const b = req.body || {};
  try {
    res.json(b.all && b.action === "complete"
      ? await production.advanceAll(req.user, req.params.id, b)
      : await production.advance(req.user, req.params.id, b.action, b));
  } catch (e) { next(e); }
});

/* The coating floor's own lab reading for a job. GET returns the parameters
   the Products master asks for (never the limits — grading stays server-side);
   POST records the production measurement against the batch. Coating cannot be
   completed until this is in, which is why it lives beside the stage actions. */
router.get("/production/wo/:id/lab", requireAuth, requireRole("supervisor", "admin", "office"), async (req, res, next) => {
  try { res.json(await production.labSheet(req.user, req.params.id)); } catch (e) { next(e); }
});
router.post("/production/wo/:id/lab", requireAuth, requireRole("supervisor", "admin", "office"), async (req, res, next) => {
  try { res.status(201).json(await production.recordLabReading(req.user, req.params.id, req.body || {})); }
  catch (e) { next(e); }
});

// Back-compat: advance by target status (maps to a stage action).
router.post("/production/wo/:id/status", requireAuth, requireRole("supervisor", "admin"), async (req, res, next) => {
  try { res.json(await production.updateWorkOrderStatus(req.user, req.params.id, (req.body || {}).status, req.body || {})); }
  catch (e) { next(e); }
});

// What raising this order would mean — shortage, how much can be made now,
// how much would be pending. Read-only; the New Work Order form warns from it.
router.post("/production/wo/preview", requireAuth, requireRole("admin", "office"), async (req, res, next) => {
  try { res.json(await production.previewWorkOrder(req.user, req.body || {})); }
  catch (e) { next(e); }
});

// Office/admin create a new work order (with a fresh multi-stage route).
// A shortage answers 409 with the detail unless `allowShortage` is set.
router.post("/production/wo", requireAuth, requireRole("admin", "office"), async (req, res, next) => {
  try { res.status(201).json(await production.createWorkOrder(req.user, req.body || {})); }
  catch (e) { next(e); }
});

// Office/admin put a pending balance back on the floor — issues its material.
router.post("/production/wo/:id/resume", requireAuth, requireRole("admin", "office"), async (req, res, next) => {
  try { res.json(await production.resumeWorkOrder(req.user, req.params.id, req.body || {})); }
  catch (e) { next(e); }
});

// Supervisor/admin record finished stock made on the floor: deduct raw
// materials from the store per BOM + add the produced qty to a chosen warehouse.
/* The QC sheet a product must carry before it can be booked into store —
   the parameter list only, never the limits. */
router.get("/production/finished/:itemId/lab", requireAuth, requireRole("supervisor", "admin", "office"), async (req, res, next) => {
  try { res.json(await production.finishedStockLabSheet(req.user, req.params.itemId)); } catch (e) { next(e); }
});
router.post("/production/finished", requireAuth, requireRole("supervisor", "admin", "office"), async (req, res, next) => {
  try { res.status(201).json(await production.produceFinished(req.user, req.body || {})); }
  catch (e) { next(e); }
});

/* Say where a coated roll was put down, for a coating stage that closed
   before the question was asked. WRITE ONCE — a store already recorded is
   never changed here; the gate on completing coating is where it is normally
   captured. Records a location, posts no movement. */
router.post("/production/wo/:id/wip-store", requireAuth, requireRole("supervisor", "admin", "office"), async (req, res, next) => {
  try { res.json(await production.setWipStore(req.user, req.params.id, req.body || {})); } catch (e) { next(e); }
});

// Floor action: send material back to a store (unused issue / over-draw / FG off the line).
router.post("/production/return", requireAuth, requireRole("supervisor", "admin", "office"), async (req, res, next) => {
  try { res.status(201).json(await production.returnStock(req.user, req.body || {})); } catch (e) { next(e); }
});

// Floor action: record a run made without a planned work order (rolls/length/width → sqm & kg).
router.post("/production/adhoc", requireAuth, requireRole("supervisor", "admin", "office"), async (req, res, next) => {
  try { res.status(201).json(await production.createAdhocProduction(req.user, req.body || {})); } catch (e) { next(e); }
});

// Supervisor/admin/office: report raw material drawn from the store beyond what the
// job was issued (material/qty/location/reason). Deducts each quantity from the store.
router.post("/production/excess-material", requireAuth, requireRole("supervisor", "admin", "office"), async (req, res, next) => {
  try { res.status(201).json(await production.recordExcessMaterial(req.user, req.body || {})); }
  catch (e) { next(e); }
});

// ---- Granular inventory writes (avoid rewriting the whole dataset) ----
// Create or update a single stock item.
router.post("/items", requireAuth, requireRole("admin", "office"), async (req, res, next) => {
  try { res.status(201).json(await erp.upsertItem(req.body || {})); } catch (e) { next(e); }
});
router.patch("/items/:id", requireAuth, requireRole("admin", "office"), async (req, res, next) => {
  try { res.json(await erp.upsertItem(Object.assign({}, req.body || {}, { id: req.params.id }))); } catch (e) { next(e); }
});
// Append a single stock movement (manual receipt / adjustment).
router.post("/movements", requireAuth, requireRole("admin", "office"), async (req, res, next) => {
  try { res.status(201).json(await erp.addMovement(req.body || {})); } catch (e) { next(e); }
});
// Receive goods against a PO (posts GRN movements + updates PO status).
router.post("/purchase-orders/:id/receive", requireAuth, requireRole("admin", "office"), async (req, res, next) => {
  try { res.json(await erp.receivePurchaseOrder(req.params.id, req.body || {}, req.user)); } catch (e) { next(e); }
});

// ---- Granular Trade / CRM writes (no more full-state clobber) ----
const rw = requireRole("admin", "office");
// Purchase orders: create / update / delete (delete reverses its GRN movements)
router.post("/purchase-orders", requireAuth, rw, async (req, res, next) => {
  try { res.status(201).json(await erp.createPurchaseOrder(req.body || {})); } catch (e) { next(e); }
});
router.patch("/purchase-orders/:id", requireAuth, rw, async (req, res, next) => {
  try { res.json(await erp.updatePurchaseOrder(req.params.id, req.body || {})); } catch (e) { next(e); }
});
router.delete("/purchase-orders/:id", requireAuth, rw, async (req, res, next) => {
  try { res.json(await erp.deletePurchaseOrder(req.params.id)); } catch (e) { next(e); }
});
// Sales orders: create / update / delete (delete reverses its SALE movements)
router.post("/sales-orders", requireAuth, rw, async (req, res, next) => {
  try { res.status(201).json(await erp.createSalesOrder(req.body || {})); } catch (e) { next(e); }
});
router.patch("/sales-orders/:id", requireAuth, rw, async (req, res, next) => {
  try { res.json(await erp.updateSalesOrder(req.params.id, req.body || {})); } catch (e) { next(e); }
});
router.delete("/sales-orders/:id", requireAuth, rw, async (req, res, next) => {
  try { res.json(await erp.deleteSalesOrder(req.params.id)); } catch (e) { next(e); }
});
router.post("/sales-orders/:id/dispatch", requireAuth, rw, async (req, res, next) => {
  try { res.json(await erp.dispatchSalesOrder(req.params.id, req.body || {}, req.user)); } catch (e) { next(e); }
});
// Bill of materials: save recipe / delete
router.put("/boms/:itemId", requireAuth, rw, async (req, res, next) => {
  try { res.json(await erp.saveBom(req.params.itemId, req.body || {})); } catch (e) { next(e); }
});
router.delete("/boms/:itemId", requireAuth, rw, async (req, res, next) => {
  try { res.json(await erp.deleteBom(req.params.itemId)); } catch (e) { next(e); }
});
// CRM leads: create / update / delete
router.post("/leads", requireAuth, rw, async (req, res, next) => {
  try { res.status(201).json(await erp.createLead(req.body || {})); } catch (e) { next(e); }
});
router.patch("/leads/:id", requireAuth, rw, async (req, res, next) => {
  try { res.json(await erp.updateLead(req.params.id, req.body || {}, req.user)); } catch (e) { next(e); }
});
router.delete("/leads/:id", requireAuth, rw, async (req, res, next) => {
  try { res.json(await erp.deleteLead(req.params.id)); } catch (e) { next(e); }
});
// Customer upsert (CRM Won→customer) + granular edit / delete
router.post("/customers", requireAuth, rw, async (req, res, next) => {
  try { res.status(201).json(await erp.upsertCustomer(req.body || {})); } catch (e) { next(e); }
});
router.patch("/customers/:id", requireAuth, rw, async (req, res, next) => {
  try { res.json(await erp.updateCustomer(req.params.id, req.body || {})); } catch (e) { next(e); }
});
router.delete("/customers/:id", requireAuth, rw, async (req, res, next) => {
  try { res.json(await erp.deleteCustomer(req.params.id)); } catch (e) { next(e); }
});
// Suppliers: create / update / delete (delete blocked while POs/items reference it)
router.post("/suppliers", requireAuth, rw, async (req, res, next) => {
  try { res.status(201).json(await erp.createSupplier(req.body || {})); } catch (e) { next(e); }
});
router.patch("/suppliers/:id", requireAuth, rw, async (req, res, next) => {
  try { res.json(await erp.updateSupplier(req.params.id, req.body || {})); } catch (e) { next(e); }
});
router.delete("/suppliers/:id", requireAuth, rw, async (req, res, next) => {
  try { res.json(await erp.deleteSupplier(req.params.id)); } catch (e) { next(e); }
});
// Org / company profile (invoice entities, bank details, taglines)
router.patch("/org", requireAuth, rw, async (req, res, next) => {
  try { res.json(await erp.updateOrg(req.body || {})); } catch (e) { next(e); }
});
// Warehouses: master-data edits (rename etc.)
router.patch("/warehouses/:id", requireAuth, rw, async (req, res, next) => {
  try { res.json(await erp.updateWarehouse(req.params.id, req.body || {})); } catch (e) { next(e); }
});
// Appointments (calendar diary): create / update / delete
router.post("/appointments", requireAuth, rw, async (req, res, next) => {
  try { res.status(201).json(await erp.createAppointment(req.body || {})); } catch (e) { next(e); }
});
router.patch("/appointments/:id", requireAuth, rw, async (req, res, next) => {
  try { res.json(await erp.updateAppointment(req.params.id, req.body || {})); } catch (e) { next(e); }
});
router.delete("/appointments/:id", requireAuth, rw, async (req, res, next) => {
  try { res.json(await erp.deleteAppointment(req.params.id)); } catch (e) { next(e); }
});
// Complaints: a customer's problem tied to the batch it came from
router.post("/complaints", requireAuth, rw, async (req, res, next) => {
  try { res.status(201).json(await erp.createComplaint(req.body || {}, req.user)); } catch (e) { next(e); }
});
router.patch("/complaints/:id", requireAuth, rw, async (req, res, next) => {
  try { res.json(await erp.updateComplaint(req.params.id, req.body || {}, req.user)); } catch (e) { next(e); }
});
router.delete("/complaints/:id", requireAuth, rw, async (req, res, next) => {
  try { res.json(await erp.deleteComplaint(req.params.id)); } catch (e) { next(e); }
});
// Quotations: a price offered for one product in one unit, then negotiated.
// A new price is a round (reprice); the quote closes won at a final price or
// lost against a counter price, and the lead follows. These verbs are the
// only way a quote changes status after it is raised.
router.post("/quotations", requireAuth, rw, async (req, res, next) => {
  try { res.status(201).json(await erp.createQuotation(req.body || {}, req.user)); } catch (e) { next(e); }
});
router.patch("/quotations/:id", requireAuth, rw, async (req, res, next) => {
  try { res.json(await erp.updateQuotation(req.params.id, req.body || {}, req.user)); } catch (e) { next(e); }
});
router.delete("/quotations/:id", requireAuth, rw, async (req, res, next) => {
  try { res.json(await erp.deleteQuotation(req.params.id)); } catch (e) { next(e); }
});
router.post("/quotations/:id/reprice", requireAuth, rw, async (req, res, next) => {
  try { res.json(await erp.repriceQuotation(req.params.id, req.body || {}, req.user)); } catch (e) { next(e); }
});
router.post("/quotations/:id/win", requireAuth, rw, async (req, res, next) => {
  try { res.json(await erp.winQuotation(req.params.id, req.body || {}, req.user)); } catch (e) { next(e); }
});
router.post("/quotations/:id/lose", requireAuth, rw, async (req, res, next) => {
  try { res.json(await erp.loseQuotation(req.params.id, req.body || {}, req.user)); } catch (e) { next(e); }
});
router.post("/quotations/:id/reopen", requireAuth, rw, async (req, res, next) => {
  try { res.json(await erp.reopenQuotation(req.params.id, req.user)); } catch (e) { next(e); }
});
// Who else received a batch, and what the lab measured on it — read-only
router.get("/batches/:id/spread", requireAuth, async (req, res, next) => {
  try { res.json(await erp.batchSpread(req.params.id)); } catch (e) { next(e); }
});
// Transporters (dispatch providers): create / update / delete
router.post("/transporters", requireAuth, rw, async (req, res, next) => {
  try { res.status(201).json(await erp.createTransporter(req.body || {})); } catch (e) { next(e); }
});
router.patch("/transporters/:id", requireAuth, rw, async (req, res, next) => {
  try { res.json(await erp.updateTransporter(req.params.id, req.body || {})); } catch (e) { next(e); }
});
router.delete("/transporters/:id", requireAuth, rw, async (req, res, next) => {
  try { res.json(await erp.deleteTransporter(req.params.id)); } catch (e) { next(e); }
});
// ---- Lab reports: QC product master + test certificates ----
// Product master (create/update/delete + hidden spec) — admin/office.
router.post("/lab/products", requireAuth, rw, async (req, res, next) => {
  try { res.status(201).json(await lab.createProduct(req.body || {})); } catch (e) { next(e); }
});
router.patch("/lab/products/:id", requireAuth, rw, async (req, res, next) => {
  try { res.json(await lab.updateProduct(req.params.id, req.body || {})); } catch (e) { next(e); }
});
router.delete("/lab/products/:id", requireAuth, rw, async (req, res, next) => {
  try { res.json(await lab.deleteProduct(req.params.id)); } catch (e) { next(e); }
});
// Spec is sensitive (hidden from the entry form) — admin only.
router.put("/lab/products/:id/spec", requireAuth, requireRole("admin"), async (req, res, next) => {
  try { res.json(await lab.setProductSpec(req.params.id, (req.body || {}).spec || req.body || {})); } catch (e) { next(e); }
});
// Test reports: create / update. The lab incharge may write REPORTS ONLY —
// never the product master and never the spec (those stay admin/office above),
// so the yardstick cannot be edited by the person being measured against it.
const rwLab = requireRole("admin", "office", "lab");
/* The reply carries the graded certificate — but the person who took the
   measurement is not shown its verdict (the same rule as the spec limits, and
   as the lab payload in viewService). Without this the grade would come
   straight back in the response to their own write. */
function forWriter(report, user) {
  if (!user || user.role !== "lab") return report;
  const out = Object.assign({}, report);
  ["result", "results", "prodResult", "prodResults", "labResult", "labResults"]
    .forEach((k) => { delete out[k]; });
  return out;
}
router.post("/lab/reports", requireAuth, rwLab, async (req, res, next) => {
  try { res.status(201).json(forWriter(await lab.createReport(req.body || {}, req.user), req.user)); } catch (e) { next(e); }
});
router.patch("/lab/reports/:id", requireAuth, rwLab, async (req, res, next) => {
  try { res.json(forWriter(await lab.updateReport(req.params.id, req.body || {}, req.user), req.user)); } catch (e) { next(e); }
});
// Deleting a certificate is a records decision — kept with admin/office.
router.delete("/lab/reports/:id", requireAuth, rw, async (req, res, next) => {
  try { res.json(await lab.deleteReport(req.params.id)); } catch (e) { next(e); }
});
/* A FAILED CERTIFICATE GOES TO THE ADMIN. The batch is not stopped anywhere
   (a failed floor reading no longer holds coating; a failed lab reading
   describes stock already on the shelf), so the failure raises a ruling:
   accept the batch — a concession, on the record — or reject it. Admin's
   alone, as for a failed incoming lot. */
router.post("/lab/reports/:id/decision", requireAuth, requireRole("admin"), async (req, res, next) => {
  try { res.json(await lab.decideReport(req.params.id, req.body || {}, req.user)); } catch (e) { next(e); }
});

/* ---- THE TDS BOOKLET ----
   One copy for every login — the floor, the lab, the office — and admin
   replaces it from the browser (a PDF, or a Word document that is converted
   where the server can). The bytes live under the data directory, never in
   the repo; the bundled booklet is what is served until one is uploaded. */
router.get("/tds", requireAuth, (req, res, next) => {
  try { res.json(tds.describe()); } catch (e) { next(e); }
});
router.get("/tds/file", requireAuth, (req, res, next) => {
  try {
    const f = tds.fileFor({ original: req.query.original === "1" });
    if (!f) return res.status(404).json({ error: "No TDS booklet is on the server" });
    const download = req.query.dl === "1" || !f.viewable;
    res.set("Cache-Control", "private, no-cache");
    res.type(f.mime);
    res.set("Content-Disposition", (download ? "attachment" : "inline")
      + "; filename*=UTF-8''" + encodeURIComponent(f.name));
    res.sendFile(f.path);
  } catch (e) { next(e); }
});
router.put("/tds", requireAuth, requireRole("admin"), async (req, res, next) => {
  try { res.json(await tds.put(req.body || {}, req.user)); } catch (e) { next(e); }
});
router.delete("/tds", requireAuth, requireRole("admin"), (req, res, next) => {
  try { res.json(tds.reset()); } catch (e) { next(e); }
});

/* ---- INCOMING-MATERIAL TESTING (after a PO is received) ----
   The lab incharge reaches these; admin/office may also file a reading so a
   receipt is never stuck waiting on one person. The parameter list and its
   limits are the material master's business, so they stay with admin — the
   same split as the finished-goods spec above. */
// The catalogue an admin picks parameters from (shape only, no limits).
router.get("/grn-tests/params", requireAuth, (req, res) => {
  res.json({ params: grnTest.PARAMS });
});
// The lab incharge's incoming worklist — every receipt line still owing a reading.
router.get("/grn-tests/pending", requireAuth, rwLab, async (req, res, next) => {
  try { res.json({ pending: await grnTest.pendingTests() }); } catch (e) { next(e); }
});
// What the entry form needs for one material on one receipt (never the limits).
router.get("/grns/:grnId/tests/:itemId", requireAuth, rwLab, async (req, res, next) => {
  try { res.json(await grnTest.testFormFor(req.params.grnId, req.params.itemId)); } catch (e) { next(e); }
});
/* Filing a reading answers with the report — but the person who took the
   measurement is not shown its verdict, exactly as /lab/reports does above:
   without this the grade would come straight back in the reply to their own
   write, and a reading whose Pass/Fail is visible can be nudged until it
   passes. */
function testForWriter(out, user) {
  if (!user || user.role !== "lab" || !out || !out.test) return out;
  const test = Object.assign({}, out.test);
  ["result", "results"].forEach((k) => { delete test[k]; });
  return Object.assign({}, out, { test });
}
router.post("/grns/:grnId/tests", requireAuth, rwLab, async (req, res, next) => {
  try {
    res.status(201).json(testForWriter(await grnTest.submitTest(req.params.grnId, req.body || {}, req.user), req.user));
  } catch (e) { next(e); }
});
router.delete("/grn-tests/:id", requireAuth, rw, async (req, res, next) => {
  try { res.json(await grnTest.deleteTest(req.params.id)); } catch (e) { next(e); }
});
/* WHICH readings a material needs is the lab incharge's trade as much as
   admin's, so both may set the parameter list. The LIMITS are a different
   thing: they are the yardstick the incharge's own reading is graded against,
   so a non-admin `spec` is ignored inside setItemQc — the same division as
   /lab/products/:id/spec. Office is deliberately out of both: it books goods
   in, it does not define how they are checked. */
router.put("/items/:id/qc", requireAuth, requireRole("admin", "lab"), async (req, res, next) => {
  try { res.json(await grnTest.setItemQc(req.params.id, req.body || {}, req.user)); } catch (e) { next(e); }
});

/* ---- A FAILED LOT GOES TO THE ADMIN ----
   The goods were booked into the store when the receipt was posted, so failing
   a lot cannot quietly move stock — it raises a decision. Approving the
   rejection transfers the lot to the quarantine store (production can no
   longer draw it); declining it leaves the lot standing as good stock. That
   ruling is admin's alone: it is the difference between material the factory
   may use and material it may not. */
router.get("/grn-tests/decisions", requireAuth, requireRole("admin", "office"), async (req, res, next) => {
  try { res.json({ pending: await grnTest.pendingDecisions() }); } catch (e) { next(e); }
});
router.post("/grn-tests/:id/decision", requireAuth, requireRole("admin"), async (req, res, next) => {
  try { res.json(await grnTest.decideTest(req.params.id, req.body || {}, req.user)); } catch (e) { next(e); }
});

// Delete a stock item / work order
router.delete("/items/:id", requireAuth, rw, async (req, res, next) => {
  try { res.json(await erp.deleteItem(req.params.id)); } catch (e) { next(e); }
});
router.delete("/production/wo/:id", requireAuth, rw, async (req, res, next) => {
  try { res.json(await erp.deleteWorkOrder(req.params.id)); } catch (e) { next(e); }
});
router.patch("/production/wo/:id", requireAuth, requireRole("admin", "office"), async (req, res, next) => {
  try { res.json(await production.updateWorkOrder(req.user, req.params.id, req.body || {})); } catch (e) { next(e); }
});

// Only admin/office can write the full dataset.
router.put("/state", requireAuth, requireRole("admin", "office"), async (req, res, next) => {
  try { res.json(await erp.saveState(req.body)); } catch (e) { next(e); }
});

// System settings (theme/accent/sticker config). Office may write them too —
// it already holds PUT /state, which carries the settings document wholesale,
// so this is no wider than what the role can do anyway.
router.patch("/settings", requireAuth, requireRole("admin", "office"), async (req, res, next) => {
  try { res.json(await erp.updateSettings(req.body)); } catch (e) { next(e); }
});

/* ---- THE CATALOGUE, ONE SHOT + THE APPROVAL QUEUE (2026-09-02) ----
   A new item with its test parameters and its recipe in one request. Admin
   and office apply it at once; the lab incharge's entry becomes a proposal
   (202) that only an admin may approve — and an approval applies through the
   very same service code, so the two paths cannot differ. */
router.post("/catalogue/new-item", requireAuth, requireRole("admin", "office", "lab"), async (req, res, next) => {
  try { const r = await catalogue.submitNewItem(req.body || {}, req.user); res.status(r.proposed ? 202 : 201).json(r); } catch (e) { next(e); }
});
router.get("/approvals", requireAuth, requireRole("admin", "office", "lab"), async (req, res, next) => {
  try { res.json({ approvals: await catalogue.list() }); } catch (e) { next(e); }
});
router.post("/approvals", requireAuth, requireRole("admin", "office", "lab"), async (req, res, next) => {
  try { const b = req.body || {}; res.status(201).json(await catalogue.propose(b.kind, b.payload, req.user)); } catch (e) { next(e); }
});
router.post("/approvals/:id/decide", requireAuth, requireRole("admin"), async (req, res, next) => {
  try { res.json(await catalogue.decide(req.params.id, req.body || {}, req.user)); } catch (e) { next(e); }
});
router.delete("/approvals/:id", requireAuth, requireRole("admin", "office", "lab"), async (req, res, next) => {
  try { res.json(await catalogue.remove(req.params.id, req.user)); } catch (e) { next(e); }
});

// Reset is destructive -> admin only.
router.post("/reset", requireAuth, requireRole("admin"), async (req, res, next) => {
  try { res.json(await erp.reset()); } catch (e) { next(e); }
});

module.exports = router;
