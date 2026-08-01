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
const { requireAuth, requireRole } = require("./auth");

const router = express.Router();

router.get("/health", (req, res) => {
  res.json({ ok: true, service: "chhaperia-erp-api", time: new Date().toISOString() });
});

// Role-scoped read: admin/office get the full dataset, supervisors get their view.
router.get("/state", requireAuth, (req, res, next) => {
  // ?slim=1 — the floor's refresh after a stage action; skips the bulky
  // product catalogue the client already holds. Ignored for other roles.
  try { res.json(view.stateForUser(req.user, { slim: req.query.slim === "1" })); } catch (e) { next(e); }
});

// Supervisor (or office/admin) advances a work order's CURRENT stage.
// action: start | pause | complete | dispatch  — area-scoped, money-free.
// Stage transitions are driven by supervisors (their area) + admin; office
// plans work orders but does not determine process stages.
// `all: true` runs every remaining stage in this one request instead of the
// browser firing a POST per stage.
router.post("/production/wo/:id/advance", requireAuth, requireRole("supervisor", "admin"), (req, res, next) => {
  const b = req.body || {};
  try {
    res.json(b.all && b.action === "complete"
      ? production.advanceAll(req.user, req.params.id)
      : production.advance(req.user, req.params.id, b.action));
  } catch (e) { next(e); }
});

// Back-compat: advance by target status (maps to a stage action).
router.post("/production/wo/:id/status", requireAuth, requireRole("supervisor", "admin"), (req, res, next) => {
  try { res.json(production.updateWorkOrderStatus(req.user, req.params.id, (req.body || {}).status)); }
  catch (e) { next(e); }
});

// What raising this order would mean — shortage, how much can be made now,
// how much would be pending. Read-only; the New Work Order form warns from it.
router.post("/production/wo/preview", requireAuth, requireRole("admin", "office"), (req, res, next) => {
  try { res.json(production.previewWorkOrder(req.user, req.body || {})); }
  catch (e) { next(e); }
});

// Office/admin create a new work order (with a fresh multi-stage route).
// A shortage answers 409 with the detail unless `allowShortage` is set.
router.post("/production/wo", requireAuth, requireRole("admin", "office"), (req, res, next) => {
  try { res.status(201).json(production.createWorkOrder(req.user, req.body || {})); }
  catch (e) { next(e); }
});

// Office/admin put a pending balance back on the floor — issues its material.
router.post("/production/wo/:id/resume", requireAuth, requireRole("admin", "office"), (req, res, next) => {
  try { res.json(production.resumeWorkOrder(req.user, req.params.id, req.body || {})); }
  catch (e) { next(e); }
});

// Supervisor/admin record finished stock made on the floor: deduct raw
// materials from the store per BOM + add the produced qty to a chosen warehouse.
router.post("/production/finished", requireAuth, requireRole("supervisor", "admin", "office"), (req, res, next) => {
  try { res.status(201).json(production.produceFinished(req.user, req.body || {})); }
  catch (e) { next(e); }
});

// Floor action: send material back to a store (unused issue / over-draw / FG off the line).
router.post("/production/return", requireAuth, requireRole("supervisor", "admin", "office"), (req, res, next) => {
  try { res.status(201).json(production.returnStock(req.user, req.body || {})); } catch (e) { next(e); }
});

// Floor action: record a run made without a planned work order (rolls/length/width → sqm & kg).
router.post("/production/adhoc", requireAuth, requireRole("supervisor", "admin", "office"), (req, res, next) => {
  try { res.status(201).json(production.createAdhocProduction(req.user, req.body || {})); } catch (e) { next(e); }
});

// Supervisor/admin/office: report raw material drawn from the store beyond what the
// job was issued (material/qty/location/reason). Deducts each quantity from the store.
router.post("/production/excess-material", requireAuth, requireRole("supervisor", "admin", "office"), (req, res, next) => {
  try { res.status(201).json(production.recordExcessMaterial(req.user, req.body || {})); }
  catch (e) { next(e); }
});

// ---- Granular inventory writes (avoid rewriting the whole dataset) ----
// Create or update a single stock item.
router.post("/items", requireAuth, requireRole("admin", "office"), (req, res, next) => {
  try { res.status(201).json(erp.upsertItem(req.body || {})); } catch (e) { next(e); }
});
router.patch("/items/:id", requireAuth, requireRole("admin", "office"), (req, res, next) => {
  try { res.json(erp.upsertItem(Object.assign({}, req.body || {}, { id: req.params.id }))); } catch (e) { next(e); }
});
// Append a single stock movement (manual receipt / adjustment).
router.post("/movements", requireAuth, requireRole("admin", "office"), (req, res, next) => {
  try { res.status(201).json(erp.addMovement(req.body || {})); } catch (e) { next(e); }
});
// Receive goods against a PO (posts GRN movements + updates PO status).
router.post("/purchase-orders/:id/receive", requireAuth, requireRole("admin", "office"), (req, res, next) => {
  try { res.json(erp.receivePurchaseOrder(req.params.id, req.body || {}, req.user)); } catch (e) { next(e); }
});

// ---- Granular Trade / CRM writes (no more full-state clobber) ----
const rw = requireRole("admin", "office");
// Purchase orders: create / update / delete (delete reverses its GRN movements)
router.post("/purchase-orders", requireAuth, rw, (req, res, next) => {
  try { res.status(201).json(erp.createPurchaseOrder(req.body || {})); } catch (e) { next(e); }
});
router.patch("/purchase-orders/:id", requireAuth, rw, (req, res, next) => {
  try { res.json(erp.updatePurchaseOrder(req.params.id, req.body || {})); } catch (e) { next(e); }
});
router.delete("/purchase-orders/:id", requireAuth, rw, (req, res, next) => {
  try { res.json(erp.deletePurchaseOrder(req.params.id)); } catch (e) { next(e); }
});
// Sales orders: create / update / delete (delete reverses its SALE movements)
router.post("/sales-orders", requireAuth, rw, (req, res, next) => {
  try { res.status(201).json(erp.createSalesOrder(req.body || {})); } catch (e) { next(e); }
});
router.patch("/sales-orders/:id", requireAuth, rw, (req, res, next) => {
  try { res.json(erp.updateSalesOrder(req.params.id, req.body || {})); } catch (e) { next(e); }
});
router.delete("/sales-orders/:id", requireAuth, rw, (req, res, next) => {
  try { res.json(erp.deleteSalesOrder(req.params.id)); } catch (e) { next(e); }
});
router.post("/sales-orders/:id/dispatch", requireAuth, rw, (req, res, next) => {
  try { res.json(erp.dispatchSalesOrder(req.params.id, req.body || {}, req.user)); } catch (e) { next(e); }
});
// Bill of materials: save recipe / delete
router.put("/boms/:itemId", requireAuth, rw, (req, res, next) => {
  try { res.json(erp.saveBom(req.params.itemId, req.body || {})); } catch (e) { next(e); }
});
router.delete("/boms/:itemId", requireAuth, rw, (req, res, next) => {
  try { res.json(erp.deleteBom(req.params.itemId)); } catch (e) { next(e); }
});
// CRM leads: create / update / delete
router.post("/leads", requireAuth, rw, (req, res, next) => {
  try { res.status(201).json(erp.createLead(req.body || {})); } catch (e) { next(e); }
});
router.patch("/leads/:id", requireAuth, rw, (req, res, next) => {
  try { res.json(erp.updateLead(req.params.id, req.body || {})); } catch (e) { next(e); }
});
router.delete("/leads/:id", requireAuth, rw, (req, res, next) => {
  try { res.json(erp.deleteLead(req.params.id)); } catch (e) { next(e); }
});
// Customer upsert (CRM Won→customer) + granular edit / delete
router.post("/customers", requireAuth, rw, (req, res, next) => {
  try { res.status(201).json(erp.upsertCustomer(req.body || {})); } catch (e) { next(e); }
});
router.patch("/customers/:id", requireAuth, rw, (req, res, next) => {
  try { res.json(erp.updateCustomer(req.params.id, req.body || {})); } catch (e) { next(e); }
});
router.delete("/customers/:id", requireAuth, rw, (req, res, next) => {
  try { res.json(erp.deleteCustomer(req.params.id)); } catch (e) { next(e); }
});
// Suppliers: create / update / delete (delete blocked while POs/items reference it)
router.post("/suppliers", requireAuth, rw, (req, res, next) => {
  try { res.status(201).json(erp.createSupplier(req.body || {})); } catch (e) { next(e); }
});
router.patch("/suppliers/:id", requireAuth, rw, (req, res, next) => {
  try { res.json(erp.updateSupplier(req.params.id, req.body || {})); } catch (e) { next(e); }
});
router.delete("/suppliers/:id", requireAuth, rw, (req, res, next) => {
  try { res.json(erp.deleteSupplier(req.params.id)); } catch (e) { next(e); }
});
// Org / company profile (invoice entities, bank details, taglines)
router.patch("/org", requireAuth, rw, (req, res, next) => {
  try { res.json(erp.updateOrg(req.body || {})); } catch (e) { next(e); }
});
// Warehouses: master-data edits (rename etc.)
router.patch("/warehouses/:id", requireAuth, rw, (req, res, next) => {
  try { res.json(erp.updateWarehouse(req.params.id, req.body || {})); } catch (e) { next(e); }
});
// Transporters (dispatch providers): create / update / delete
router.post("/transporters", requireAuth, rw, (req, res, next) => {
  try { res.status(201).json(erp.createTransporter(req.body || {})); } catch (e) { next(e); }
});
router.patch("/transporters/:id", requireAuth, rw, (req, res, next) => {
  try { res.json(erp.updateTransporter(req.params.id, req.body || {})); } catch (e) { next(e); }
});
router.delete("/transporters/:id", requireAuth, rw, (req, res, next) => {
  try { res.json(erp.deleteTransporter(req.params.id)); } catch (e) { next(e); }
});
// ---- Lab reports: QC product master + test certificates ----
// Product master (create/update/delete + hidden spec) — admin/office.
router.post("/lab/products", requireAuth, rw, (req, res, next) => {
  try { res.status(201).json(lab.createProduct(req.body || {})); } catch (e) { next(e); }
});
router.patch("/lab/products/:id", requireAuth, rw, (req, res, next) => {
  try { res.json(lab.updateProduct(req.params.id, req.body || {})); } catch (e) { next(e); }
});
router.delete("/lab/products/:id", requireAuth, rw, (req, res, next) => {
  try { res.json(lab.deleteProduct(req.params.id)); } catch (e) { next(e); }
});
// Spec is sensitive (hidden from the entry form) — admin only.
router.put("/lab/products/:id/spec", requireAuth, requireRole("admin"), (req, res, next) => {
  try { res.json(lab.setProductSpec(req.params.id, (req.body || {}).spec || req.body || {})); } catch (e) { next(e); }
});
// Test reports: create / update. The lab incharge may write REPORTS ONLY —
// never the product master and never the spec (those stay admin/office above),
// so the yardstick cannot be edited by the person being measured against it.
const rwLab = requireRole("admin", "office", "lab");
router.post("/lab/reports", requireAuth, rwLab, (req, res, next) => {
  try { res.status(201).json(lab.createReport(req.body || {}, req.user)); } catch (e) { next(e); }
});
router.patch("/lab/reports/:id", requireAuth, rwLab, (req, res, next) => {
  try { res.json(lab.updateReport(req.params.id, req.body || {}, req.user)); } catch (e) { next(e); }
});
// Deleting a certificate is a records decision — kept with admin/office.
router.delete("/lab/reports/:id", requireAuth, rw, (req, res, next) => {
  try { res.json(lab.deleteReport(req.params.id)); } catch (e) { next(e); }
});

// Delete a stock item / work order
router.delete("/items/:id", requireAuth, rw, (req, res, next) => {
  try { res.json(erp.deleteItem(req.params.id)); } catch (e) { next(e); }
});
router.delete("/production/wo/:id", requireAuth, rw, (req, res, next) => {
  try { res.json(erp.deleteWorkOrder(req.params.id)); } catch (e) { next(e); }
});
router.patch("/production/wo/:id", requireAuth, requireRole("admin", "office"), (req, res, next) => {
  try { res.json(production.updateWorkOrder(req.user, req.params.id, req.body || {})); } catch (e) { next(e); }
});

// Only admin/office can write the full dataset.
router.put("/state", requireAuth, requireRole("admin", "office"), (req, res, next) => {
  try { res.json(erp.saveState(req.body)); } catch (e) { next(e); }
});

// System settings (theme/accent/config) are admin only.
router.patch("/settings", requireAuth, requireRole("admin"), (req, res, next) => {
  try { res.json(erp.updateSettings(req.body)); } catch (e) { next(e); }
});

// Reset is destructive -> admin only.
router.post("/reset", requireAuth, requireRole("admin"), (req, res, next) => {
  try { res.json(erp.reset()); } catch (e) { next(e); }
});

module.exports = router;
