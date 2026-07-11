/* ============================================================
   CHHAPERIA ERP — BACKEND · Lab Reports service
   QC test certificates for finished goods.

   Design notes
   ------------
   • Lab reports have their OWN product master (`lab_products`),
     decoupled from the inventory `items` table and seeded from the
     factory's finished-goods list. It is REPLACED when the real
     product data file (codes + BOM + stages + TDS specs) arrives.
   • Each product carries material-TYPE flags (mica / waterBlocking /
     semiConductive) that decide WHICH test parameters apply:
       - common (always): tensile, elongation, thickness, mass/area
       - waterBlocking  : swelling speed + heights (1/3/10 min)
       - semiConductive : surface + volume resistance
       - mica           : breakdown voltage (BDV)
   • A per-product `spec` map {param:{min,max}} lives on the product
     (BACKEND-ONLY — never sent to the data-entry form). On submit the
     server grades entered values against it → Pass/Fail per param +
     overall. Until specs are loaded from the TDS, overall = "Pending".
   • `refMode` is per product: daily-made/stocked goods use a BATCH
     number; made-to-order goods use a LOT / work-order number.
   ============================================================ */
"use strict";
const repo = require("../db/repository");

function err(msg, status) { const e = new Error(msg); e.status = status || 400; return e; }
function num(v) { return v == null || v === "" || isNaN(+v) ? null : +v; }
function todayISO() { const x = new Date(); const p = (n) => String(n).padStart(2, "0"); return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`; }

/* ---- next sequential id from existing rows ---- */
function nextId(list, prefix, width) {
  let max = 0;
  (list || []).forEach((x) => { const m = /(\d+)\s*$/.exec(String((x && x.id) || "")); if (m) max = Math.max(max, +m[1]); });
  return prefix + String(max + 1).padStart(width || 3, "0");
}

/* ============================================================
   PARAMETER CATALOG — single source of truth (shared shape with
   the frontend). `group` maps to a product flag; the "common"
   group always applies.
   ============================================================ */
const PARAMS = [
  { key: "tensile",           label: "Tensile",                 unit: "N/cm",      group: "common" },
  { key: "elongation",        label: "Elongation",              unit: "%",         group: "common" },
  { key: "thickness",         label: "Thickness",               unit: "mm",        group: "common" },
  { key: "massPerArea",       label: "Mass per unit area",      unit: "g/m²",      group: "common" },
  { key: "swellSpeed",        label: "Swelling speed",          unit: "mm/1 min",  group: "waterBlocking" },
  { key: "swellHeight3",      label: "Swelling height (3 min)", unit: "mm/3 min",  group: "waterBlocking" },
  { key: "swellHeight10",     label: "Swelling height (10 min)",unit: "mm/10 min", group: "waterBlocking" },
  { key: "surfaceResistance", label: "Surface resistance",      unit: "Ω",         group: "semiConductive" },
  { key: "volumeResistance",  label: "Volume resistance",       unit: "kΩ·cm",     group: "semiConductive" },
  { key: "bdv",               label: "Breakdown voltage (BDV)", unit: "kV/layer",  group: "mica" },
];

/** Derive material-type flags from a product NAME (keyword match). */
function deriveFlags(name) {
  const s = String(name || "").toUpperCase();
  return {
    mica: /\bMICA\b/.test(s),
    waterBlocking: /WATER\s*BLOCKING/.test(s),
    semiConductive: /SEMI\s*CONDUCTIVE/.test(s),
  };
}

/** Parameters that apply given a product's flags. */
function applicableParams(flags) {
  flags = flags || {};
  return PARAMS.filter((p) => p.group === "common" || flags[p.group]);
}

/* ============================================================
   PASS / FAIL — grade entered values against the product spec.
   Spec shape: { paramKey: { min?, max? } }. A param with a value
   but no spec is "na" (awaiting TDS). Overall is:
     Fail    → any applicable param fails its spec
     Pass    → at least one param evaluated and none failed
     Pending → no param could be evaluated (no specs yet)
   ============================================================ */
function evaluate(values, spec, flags) {
  values = values || {}; spec = spec || {};
  const results = {};
  let anyEval = false, anyFail = false;
  applicableParams(flags).forEach((p) => {
    const v = num(values[p.key]);
    if (v == null) { results[p.key] = "—"; return; }           // not entered
    const sp = spec[p.key];
    if (!sp || (sp.min == null && sp.max == null)) { results[p.key] = "na"; return; }
    anyEval = true;
    let ok = true;
    if (sp.min != null && v < +sp.min) ok = false;
    if (sp.max != null && v > +sp.max) ok = false;
    results[p.key] = ok ? "pass" : "fail";
    if (!ok) anyFail = true;
  });
  return { results, result: !anyEval ? "Pending" : anyFail ? "Fail" : "Pass" };
}

/* ============================================================
   PRODUCTS (lab master)
   ============================================================ */
function listProducts() { return repo.getState().labProducts || []; }

function normalizeProduct(p) {
  p = p || {};
  if (!p.name) throw err("Product needs a name", 400);
  const flags = p.flags && typeof p.flags === "object" ? p.flags : deriveFlags(p.name);
  const spec = p.spec && typeof p.spec === "object" ? p.spec : {};
  return {
    id: p.id,
    name: String(p.name).trim(),
    code: String(p.code || "").trim(),
    thickness: p.thickness != null ? String(p.thickness).trim() : "",
    series: p.series || "",
    flags: { mica: !!flags.mica, waterBlocking: !!flags.waterBlocking, semiConductive: !!flags.semiConductive },
    refMode: p.refMode === "lot" ? "lot" : "batch",
    spec,
    notes: p.notes || "",
    active: p.active !== false,
  };
}

function createProduct(p) {
  const prod = normalizeProduct(p);
  if (!prod.id) prod.id = nextId(listProducts(), "LP-");
  else if (repo.getLabProduct(prod.id)) throw err("Product " + prod.id + " already exists", 409);
  return repo.putLabProduct(prod);
}
function updateProduct(id, patch) {
  const existing = repo.getLabProduct(id);
  if (!existing) throw err("Product not found", 404);
  const merged = Object.assign({}, existing, patch || {}, { id });
  return repo.putLabProduct(normalizeProduct(merged));
}
function deleteProduct(id) {
  if (!repo.getLabProduct(id)) throw err("Product not found", 404);
  return repo.deleteLabProduct(id);
}
/** Set only the (hidden) spec for a product — admin flow, kept out of report entry. */
function setProductSpec(id, spec) {
  const existing = repo.getLabProduct(id);
  if (!existing) throw err("Product not found", 404);
  existing.spec = spec && typeof spec === "object" ? spec : {};
  return repo.putLabProduct(existing);
}

/* ============================================================
   REPORTS
   ============================================================ */
function listReports() { return repo.getState().labReports || []; }

function buildReport(body, existing) {
  body = body || {};
  const product = repo.getLabProduct(body.productId);
  if (!product) throw err("Unknown product " + (body.productId || ""), 400);
  // Prefer the report's own type toggles (the entry form can override the
  // product's derived flags); fall back to the product's flags.
  const src = body.flags && typeof body.flags === "object" ? body.flags : (product.flags || deriveFlags(product.name));
  const flags = { mica: !!src.mica, waterBlocking: !!src.waterBlocking, semiConductive: !!src.semiConductive };
  // keep only values for parameters that actually apply to this product
  const values = {};
  applicableParams(flags).forEach((p) => { const v = num((body.values || {})[p.key]); if (v != null) values[p.key] = v; });
  const graded = evaluate(values, product.spec, flags);
  const base = existing || {};
  return {
    id: base.id || body.id || nextId(listReports(), "LR-", 4),
    productId: product.id,
    productCode: product.code,
    productName: product.name,
    thickness: product.thickness,
    refMode: product.refMode || "batch",
    refNo: String(body.refNo != null ? body.refNo : base.refNo || "").trim(),
    reportDate: body.reportDate || base.reportDate || todayISO(),
    flags,
    values,
    results: graded.results,
    result: graded.result,
    assignee: body.assignee != null ? (String(body.assignee).trim() || "Pending") : (base.assignee || "Pending"),
    testedBy: body.testedBy != null ? String(body.testedBy).trim() : (base.testedBy || ""),
    remarks: body.remarks != null ? String(body.remarks).trim() : (base.remarks || ""),
    createdAt: base.createdAt || new Date().toISOString(),
  };
}

function createReport(body) { return repo.putLabReport(buildReport(body, null)); }
function updateReport(id, patch) {
  const existing = repo.getLabReport(id);
  if (!existing) throw err("Report not found", 404);
  // merge so a partial patch (e.g. just assignee) keeps productId/values
  const merged = Object.assign({}, existing, patch || {}, { id });
  return repo.putLabReport(buildReport(merged, existing));
}
function deleteReport(id) {
  if (!repo.getLabReport(id)) throw err("Report not found", 404);
  return repo.deleteLabReport(id);
}

/* ============================================================
   SEED — the factory finished-goods list (name, code, thickness).
   Material flags are derived from the name. `refMode` defaults to
   "batch"; specs start empty until the TDS is loaded. Populate-if-
   empty so a real data file can replace it later without conflict.
   ============================================================ */
const SEED = [
  // ---- MICA SERIES (mica → BDV) ----
  ["FIRES P PHLOGOPITE MICA GLASS BACKED TAPE", "CP25G-08", "0.08", "Mica"],
  ["FIRES P PHLOGOPITE MICA GLASS BACKED TAPE", "CP25G-10", "0.1", "Mica"],
  ["FIRES P PHLOGOPITE MICA GLASS BACKED TAPE", "CP25G-11", "0.11", "Mica"],
  ["FIRES P PHLOGOPITE MICA GLASS BACKED TAPE", "CP25G-12", "0.12", "Mica"],
  ["FIRES P PHLOGOPITE MICA GLASS BACKED TAPE", "CP25G-14", "0.14", "Mica"],
  ["FIRES P PHLOGOPITE MICA GLASS BACKED TAPE", "CP25G-15", "0.15", "Mica"],
  ["FIRES P INORGANIC PHLOGOPITE MICA TAPE", "CP25GE13", "0.13", "Mica"],
  ["FIRES P INORGANIC PHLOGOPITE MICA TAPE", "CP25GE-145", "0.145", "Mica"],
  ["FIRES M INORGANIC MUSCOVITE MICA TAPE", "CCM25GE-10", "0.1", "Mica"],
  ["FIRES M INORGANIC MUSCOVITE MICA TAPE", "CCM25GE-13", "0.13", "Mica"],
  ["FIRES M INORGANIC MUSCOVITE MICA TAPE", "CCM25GE-16", "0.16", "Mica"],
  ["FIRES M MUSCOVITE MICA GLASS BACKED TAPE", "CM25G-08-10", "0.08-0.10", "Mica"],
  ["FIRES M MUSCOVITE MICA GLASS BACKED TAPE", "CM25G-11-12", "0.11-0.12", "Mica"],
  ["FIRES M MUSCOVITE MICA GLASS BACKED TAPE", "CM25G-13", "0.13", "Mica"],
  ["FIRES M MUSCOVITE MICA GLASS BACKED TAPE", "CM25G-14", "0.14", "Mica"],
  ["FIRES M DOUBLE GLASS – MUSCOVITE GLASS MICA GLASS TAPE", "CCM25DG-125", "0.125", "Mica"],
  // ---- WATER BLOCKING SERIES ----
  ["NON CONDUCTIVE WATER BLOCKING TAPE", "CHDNW-15 (SINGLE SIDE)", "0.15", "Water Blocking"],
  ["NON CONDUCTIVE WATER BLOCKING TAPE", "CHDNW-15 (DOUBLE SIDE)", "0.15", "Water Blocking"],
  ["NON CONDUCTIVE WATER BLOCKING TAPE", "CHDNW-20", "0.2", "Water Blocking"],
  ["NON CONDUCTIVE WATER BLOCKING TAPE", "CHDNW-25", "0.25", "Water Blocking"],
  ["NON CONDUCTIVE WATER BLOCKING TAPE", "CHDNW-30", "0.3", "Water Blocking"],
  ["NON CONDUCTIVE WATER BLOCKING TAPE", "CHDNW-30E", "0.3", "Water Blocking"],
  ["NON CONDUCTIVE WATER BLOCKING TAPE", "CHDNW-50", "0.5", "Water Blocking"],
  ["DOUBLE SIDE SEMI CONDUCTIVE LAMINATED WATER BLOCKING TAPE", "CHDSW-25", "0.25", "Water Blocking"],
  ["DOUBLE SIDE SEMI CONDUCTIVE LAMINATED WATER BLOCKING TAPE", "CHDSW-30", "0.3", "Water Blocking"],
  ["DOUBLE SIDE SEMI CONDUCTIVE LAMINATED WATER BLOCKING TAPE", "CHDSW-321216", "0.32,0.12,0.16", "Water Blocking"],
  ["DOUBLE SIDE SEMI CONDUCTIVE LAMINATED WATER BLOCKING TAPE", "CHDSW-40", "0.4", "Water Blocking"],
  ["DOUBLE SIDE SEMI CONDUCTIVE LAMINATED WATER BLOCKING TAPE", "CHDSW-45", "0.45", "Water Blocking"],
  ["DOUBLE SIDE SEMI CONDUCTIVE LAMINATED WATER BLOCKING TAPE", "CHDSW-50", "0.5", "Water Blocking"],
  ["SEMI CONDUCTIVE WOVEN WATER BLOCKING TAPE", "CHSCWWBT-18", "0.18", "Water Blocking"],
  ["SEMI CONDUCTIVE WOVEN WATER BLOCKING TAPE", "CHSCWWBT-20", "0.2", "Water Blocking"],
  ["SEMI CONDUCTIVE WATER BLOCKING FOAM (BULKY)", "CHSMWBT-F-100", "1", "Water Blocking"],
  ["SEMI CONDUCTIVE WATER BLOCKING FOAM (BULKY)", "CHSMWBT-F-125", "1.25", "Water Blocking"],
  ["SEMI CONDUCTIVE WATER BLOCKING FOAM (BULKY)", "CHSMWBT-F-150", "1.5", "Water Blocking"],
  ["SEMI CONDUCTIVE WATER BLOCKING FOAM (BULKY)", "CHSMWBT-F-200", "2", "Water Blocking"],
  ["COPPER WIRE WOVEN SEMI CONDUCTIVE WATER BLOCKING TAPE", "CHCWSCWBT-50", "0.5", "Water Blocking"],
  ["WATER BLOCKING ROPE", "CWR", "2 to 20 diameter", "Water Blocking"],
  // ---- SEMI CONDUCTIVE (non water-blocking) ----
  ["SEMI CONDUCTIVE WOVEN TAPE", "CHN-12 WS", "0.12", "Semi Conductive"],
  ["SEMI CONDUCTIVE WOVEN TAPE", "CHN-20 WS", "0.2", "Semi Conductive"],
  ["SEMI CONDUCTIVE WOVEN TAPE", "CHN-30 WS", "0.3", "Semi Conductive"],
  ["SEMI CONDUCTIVE WOVEN TAPE", "CHN-12 TDM", "0.12", "Semi Conductive"],
  ["SEMI CONDUCTIVE WOVEN TAPE", "CHN-20 TDM", "0.2", "Semi Conductive"],
  ["SEMI CONDUCTIVE WOVEN TAPE", "CHN-30 TDM", "0.3", "Semi Conductive"],
  ["SEMI CONDUCTIVE WOVEN TAPE", "CHN-20 TDMS", "0.25", "Semi Conductive"],
  ["SEMI CONDUCTIVE NONWOVEN TAPE", "CHCNW-12", "0.12", "Semi Conductive"],
  ["SEMI CONDUCTIVE NONWOVEN TAPE", "CHCNW-15", "0.15", "Semi Conductive"],
  ["SEMI CONDUCTIVE NONWOVEN TAPE", "CHCNW-20", "0.2", "Semi Conductive"],
  // ---- FIRE / LSZH ----
  ["LOW SMOKE ZERO HALOGEN", "CH-LSZH-12", "0.12", "Fire Resistant"],
  ["LOW SMOKE ZERO HALOGEN", "CH-LSZH-20", "0.2", "Fire Resistant"],
  ["FIRE SURVIVAL ZERO HALOGEN TAPE", "CH-FSZH-18", "0.18", "Fire Resistant"],
  // ---- OTHER TAPE SERIES ----
  ["FIBER GLASS TAPE", "CH-FGT-12", "0.12", "Other"],
  ["FIBER GLASS TAPE", "CH-FGT-20", "0.2", "Other"],
  ["FIBER GLASS TAPE", "CH-FGT-30", "0.3", "Other"],
  ["FIBER GLASS TAPE", "CH-FGT-58", "0.58", "Other"],
  ["ALUMINIUM POLYESTER TAPE", "CH-ALPET", "0.24", "Other"],
  ["ALUMINIUM POLYESTER TAPE", "CH-ALPET", "0.27", "Other"],
  ["ALUMINIUM POLYESTER TAPE", "CH-ALPET", "0.3", "Other"],
  ["ALUMINIUM POLYESTER TAPE", "CH-ALPET-50", "0.5", "Other"],
  ["ALUMINIUM POLYIMIDE TAPE", "CH-ALPFT-34", "0.34", "Other"],
  ["ALUMINIUM POLYIMIDE TAPE", "CH-ALPFT-50", "0.5", "Other"],
  ["COPPER POLYESTER TAPE", "CH-CUPET-50", "0.5", "Other"],
  ["FOAMED POLYPROPYLENE TAPE", "CH-FPP-10", "0.1", "Other"],
  ["FOAMED POLYPROPYLENE TAPE", "CH-FPP-125", "0.125", "Other"],
  ["FOAMED POLYPROPYLENE TAPE", "CH-FPP-15", "0.15", "Other"],
  ["FOAMED POLYPROPYLENE TAPE", "CH-FPP-20", "0.2", "Other"],
  ["POLY FIBER GLASS TAPE", "CH-PFGT-14", "0.14", "Other"],
  ["POLY FIBER GLASS TAPE", "CH-PFGT-16", "0.16", "Other"],
  ["NON WOVEN FLEECE TAPE", "CH-NW-F-05", "0.05", "Other"],
  ["NON WOVEN FLEECE TAPE", "CH-NW-F-100", "0.1", "Other"],
  ["NON WOVEN FLEECE TAPE", "CH-NW-F-125", "0.125", "Other"],
  ["NON WOVEN NON COMPRESSED TAPE", "CH-NW-12", "0.12", "Other"],
  ["NON WOVEN NON COMPRESSED TAPE", "CH-NW-15", "0.15", "Other"],
  ["NON WOVEN NON COMPRESSED TAPE", "CH-NW-20", "0.2", "Other"],
  ["NON WOVEN BINDER TAPE", "CH-NW-B-07", "0.07", "Other"],
  ["NON WOVEN BINDER TAPE", "CH-NW-B-10", "0.1", "Other"],
  ["NON WOVEN BINDER TAPE", "CH-NW-B-15", "0.15", "Other"],
  ["NON WOVEN BINDER TAPE", "CH-NW-B-20", "0.2", "Other"],
  ["POLYESTER TAPE", "CH-PET", "0.015", "Other"],
  ["POLYESTER TAPE", "CH-PET", "0.019", "Other"],
  ["POLYESTER TAPE", "CH-PET", "0.025", "Other"],
  ["POLYESTER TAPE", "CH-PET", "0.03", "Other"],
  ["POLYESTER TAPE", "CH-PET", "0.036", "Other"],
  ["POLYESTER TAPE", "CH-PET", "0.05", "Other"],
  ["POLYIMIDE FILM", "CH-PFT", "0.025", "Other"],
  ["POLYIMIDE FILM", "CH-PFT", "0.05", "Other"],
  ["POLYIMIDE FILM", "CH-PFT", "0.075", "Other"],
  ["POLYIMIDE FILM", "CH-PFT", "0.1", "Other"],
  ["POLYIMIDE FILM", "CH-PFT", "0.125", "Other"],
  ["POLYIMIDE FILM", "CH-PFT", "0.175", "Other"],
  ["PTFE SKIVED TAPE", "CH-PTFE", "0.05", "Other"],
  ["PTFE SKIVED TAPE", "CH-PTFE", "0.075", "Other"],
  ["PTFE SKIVED TAPE", "CH-PTFE", "0.1", "Other"],
  ["POLYESTER BINDER TAPE", "CH-PT-12 (WHITE COLOR)", "0.11-0.12", "Other"],
  ["POLYESTER BINDER TAPE", "CH-PT-12 (GRAY COLOR)", "0.11-0.12", "Other"],
  ["POLYESTER BINDER TAPE", "CH-PT-16 (WHITE COLOR)", "0.16", "Other"],
  ["POLYESTER BINDER TAPE", "CH-PT-16 (GRAY COLOR)", "0.16", "Other"],
  ["COTTON BINDER TAPE", "CH-CT-15", "0.15", "Other"],
  ["COTTON BINDER TAPE", "CH-CT-25", "0.25", "Other"],
  ["COTTON BINDER TAPE", "CH-CT-35", "0.35", "Other"],
  ["RUBBERISED COTTON TAPE", "CH-RCT-15", "0.15", "Other"],
  ["RUBBERISED COTTON TAPE", "CH-RCT-20", "0.2", "Other"],
  ["RUBBERISED COTTON TAPE", "CH-RCT-30", "0.3", "Other"],
  ["RUBBER PROOFED SYNTHETIC TAPE", "CH-RPST-13", "0.13", "Other"],
  ["RUBBER PROOFED SYNTHETIC TAPE", "CH-RPST-16", "0.16", "Other"],
  ["BITUMINISED COTTON TAPE", "CH-BCT-20 (SINGLE SIDE)", "0.2", "Other"],
  ["BITUMINISED COTTON TAPE", "CH-BCT-40 (DOUBLE SIDE)", "0.4", "Other"],
];

function ensureLab() {
  if (!repo.labProductsEmpty()) return { changed: false, products: listProducts().length };
  SEED.forEach(([name, code, thickness, series], i) => {
    repo.putLabProduct({
      id: "LP-" + String(i + 1).padStart(3, "0"),
      name, code, thickness, series,
      flags: deriveFlags(name),
      refMode: "batch",
      spec: {},
      active: true,
    });
  });
  return { changed: true, products: SEED.length };
}

module.exports = {
  PARAMS, deriveFlags, applicableParams, evaluate,
  listProducts, createProduct, updateProduct, deleteProduct, setProductSpec,
  listReports, createReport, updateReport, deleteReport,
  ensureLab,
};
