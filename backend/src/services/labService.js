/* ============================================================
   CHHAPERIA ERP — BACKEND · Lab Reports service
   QC test certificates for finished goods.

   Design notes
   ------------
   • Lab reports have their OWN product master (`lab_products`),
     decoupled from the inventory `items` table and seeded from the
     factory's finished-goods list. It is REPLACED when the real
     product data file (codes + BOM + stages + TDS specs) arrives.
   • A per-product `spec` map {param:{min,max}} lives on the product
     (BACKEND-ONLY — never sent to the data-entry form). On submit the
     server grades entered values against it → Pass/Fail per param +
     overall. Until specs are loaded from the TDS, overall = "Pending".
   • WHICH PARAMETERS A REPORT CARRIES is decided by that spec: a
     product is tested on exactly the parameters the Products master
     states a limit for, and on nothing else. A product whose spec has
     not been loaded yet falls back to the material-TYPE catalogue —
     flags (mica / waterBlocking / semiConductive) selecting from
     common + swelling + resistance + BDV — so it can still be measured.
   • A WORK ORDER IS A BATCH. The batch number printed on an invoice is
     the work order's own number, so a certificate is tied to a job by
     `woId`, and findable by either the W.O. number or the plain batch
     number. Coating cannot be finished until that certificate carries a
     complete measurement (see coatingGate).
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
   WHICH PARAMETERS THIS PRODUCT IS TESTED ON
   The Products master is the authority: a parameter belongs on the
   report when the product's spec states a limit for it. `specKeys`
   is the redacted form the non-admin payload carries — the keys
   without the limits — so every role agrees on the parameter list
   while only admin sees the thresholds.
   ============================================================ */
function hasLimit(sp) {
  return !!sp && (sp.min != null || sp.max != null || sp.nominal != null || sp.unparsed != null);
}
function specKeys(product) {
  const spec = (product || {}).spec || {};
  return Object.keys(spec).filter((k) => hasLimit(spec[k]));
}
/** The parameter rows a report for this product carries, in catalog order. */
function paramsForProduct(product, flags) {
  product = product || {};
  const keys = Array.isArray(product.specKeys) ? product.specKeys : specKeys(product);
  const picked = PARAMS.filter((p) => keys.indexOf(p.key) >= 0);
  // no spec loaded yet — fall back to the material-type catalogue so the
  // product is still measurable rather than having no parameters at all
  return picked.length ? picked : applicableParams(flags || product.flags);
}
/** True when every parameter of `params` carries a value. */
function setComplete(values, params) {
  if (!params || !params.length) return false;
  return params.every((p) => num((values || {})[p.key]) != null);
}
/** The parameters still missing a value. */
function missingParams(values, params) {
  return (params || []).filter((p) => num((values || {})[p.key]) == null);
}

/* ============================================================
   PASS / FAIL — grade entered values against the product spec.
   Spec shape: { paramKey: { min?, max? } }. A param with a value
   but no spec is "na" (awaiting TDS). Overall is:
     Fail    → any applicable param fails its spec
     Pass    → at least one param evaluated and none failed
     Pending → no param could be evaluated (no specs yet)
   `params` is the row list from paramsForProduct(); a flags object
   is still accepted so older callers keep working.
   ============================================================ */
function evaluate(values, spec, params) {
  values = values || {}; spec = spec || {};
  const rows = Array.isArray(params) ? params : applicableParams(params);
  const results = {};
  let anyEval = false, anyFail = false;
  rows.forEach((p) => {
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
    /* The import links every lab product to the inventory item it tests, and
       carries its GSM. Both were being dropped on the first edit through the
       API — and the item link is what ties a work order to its certificate,
       so losing it would quietly disable the coating gate. */
    itemId: p.itemId != null ? String(p.itemId).trim() || null : null,
    gsm: p.gsm != null && p.gsm !== "" && !isNaN(+p.gsm) ? +p.gsm : null,
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

/* A batch is measured TWICE: once on the floor as it is produced, and again
   by the lab incharge after slitting. Both sets live on the same report and
   are graded independently against the same hidden spec, so the two can be
   compared side by side. `values` remains the report's headline set (the lab
   reading once it exists, else the production one) so every existing caller
   keeps working. */
function pickValues(raw, params) {
  const out = {};
  (params || []).forEach((p) => { const v = num((raw || {})[p.key]); if (v != null) out[p.key] = v; });
  return out;
}
/** Which measurement set a writer owns, from their role. */
function sourceForUser(user) {
  if (!user) return "lab";
  if (user.role === "supervisor") return "production";
  return user.role === "lab" ? "lab" : null;   // admin/office may write either
}

function buildReport(body, existing, user) {
  body = body || {};
  const product = repo.getLabProduct(body.productId);
  if (!product) throw err("Unknown product " + (body.productId || ""), 400);
  // Prefer the report's own type toggles (the entry form can override the
  // product's derived flags); fall back to the product's flags.
  const src = body.flags && typeof body.flags === "object" ? body.flags : (product.flags || deriveFlags(product.name));
  const flags = { mica: !!src.mica, waterBlocking: !!src.waterBlocking, semiConductive: !!src.semiConductive };
  const base = existing || {};
  // the product's spec decides the parameter rows — the type toggles only
  // matter for a product whose spec has not been loaded yet
  const params = paramsForProduct(product, flags);

  // Which set is this write? Explicit `source` wins, else infer from the role.
  const owned = sourceForUser(user);
  const target = body.source === "production" || body.source === "lab" ? body.source : (owned || "lab");

  let prodValues = base.prodValues || {};
  let labValues = base.labValues || {};
  if (body.prodValues) prodValues = pickValues(body.prodValues, params);
  if (body.labValues) labValues = pickValues(body.labValues, params);
  if (body.values) {
    // A plain `values` write lands in the set the writer owns. A supervisor
    // can never overwrite the lab's reading, and the lab can never overwrite
    // the floor's — they are separate records of the same batch.
    if (target === "production") prodValues = pickValues(body.values, params);
    else labValues = pickValues(body.values, params);
  }
  if (owned && user && user.role === "supervisor" && body.labValues) {
    throw err("Production entry cannot write the lab incharge's measurements", 403);
  }
  if (owned === "lab" && user && user.role === "lab" && body.prodValues) {
    throw err("Lab entry cannot write the production floor's measurements", 403);
  }

  const prodGraded = evaluate(prodValues, product.spec, params);
  const labGraded = evaluate(labValues, product.spec, params);
  // headline = the lab reading once present, otherwise the floor's
  const hasLab = Object.keys(labValues).length > 0;
  const values = hasLab ? labValues : prodValues;
  const graded = hasLab ? labGraded : prodGraded;

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
    // the parameters this certificate covers, as the Products master defined
    // them at the time of writing
    paramKeys: params.map((p) => p.key),
    values,
    results: graded.results,
    result: graded.result,
    // the two independent measurement sets + their own grades
    prodValues, prodResults: prodGraded.results, prodResult: prodGraded.result,
    labValues, labResults: labGraded.results, labResult: labGraded.result,
    // has each stage measured EVERY parameter? the coating gate reads this
    prodComplete: setComplete(prodValues, params),
    labComplete: setComplete(labValues, params),
    prodBy: body.prodBy != null ? String(body.prodBy).trim()
      : (target === "production" && user ? user.username : (base.prodBy || "")),
    labBy: body.labBy != null ? String(body.labBy).trim()
      : (target === "lab" && user ? user.username : (base.labBy || "")),
    woId: body.woId != null ? String(body.woId).trim() : (base.woId || ""),
    assignee: body.assignee != null ? (String(body.assignee).trim() || "Pending") : (base.assignee || "Pending"),
    testedBy: body.testedBy != null ? String(body.testedBy).trim() : (base.testedBy || ""),
    remarks: body.remarks != null ? String(body.remarks).trim() : (base.remarks || ""),
    createdAt: base.createdAt || new Date().toISOString(),
  };
}

/** Find an existing report for the same batch/lot so the two stages merge. */
function findByRef(productId, refNo, reports) {
  const ref = String(refNo || "").trim();
  if (!ref) return null;
  return (reports || listReports())
    .find((r) => r.productId === productId && String(r.refNo || "").trim() === ref) || null;
}

function createReport(body, user) {
  // Second stage of the SAME batch updates the first report instead of
  // creating a duplicate certificate for it.
  const existing = findByRef((body || {}).productId, (body || {}).refNo);
  if (existing) return repo.putLabReport(buildReport(Object.assign({}, body, { id: existing.id }), existing, user));
  return repo.putLabReport(buildReport(body, null, user));
}
function updateReport(id, patch, user) {
  const existing = repo.getLabReport(id);
  if (!existing) throw err("Report not found", 404);
  patch = patch || {};
  // merge so a partial patch (e.g. just assignee) keeps productId/refNo
  const merged = Object.assign({}, existing, patch, { id });
  /* …but NOT the measurement sets. buildReport already carries those forward
     from `existing`, and folding them into the patch made it look as though
     the writer had submitted them: the lab incharge editing a batch the floor
     had already measured was refused for "writing the production floor's
     measurements", and a patch of nothing but an assignee copied one stage's
     readings into the other's column. Only what the caller actually sent is
     treated as a write. */
  if (!patch.prodValues) delete merged.prodValues;
  if (!patch.labValues) delete merged.labValues;
  if (!patch.values) delete merged.values;
  return repo.putLabReport(buildReport(merged, existing, user));
}
function deleteReport(id) {
  if (!repo.getLabReport(id)) throw err("Report not found", 404);
  return repo.deleteLabReport(id);
}

/* ============================================================
   WORK ORDERS ARE BATCHES
   A job on the floor and a batch on a certificate are the same
   thing, so the two are joined here rather than by whoever happens
   to be typing. `woId` is the real link; refNo is matched as well
   so a certificate written by hand against the batch number (or the
   full W.O. number) still counts.
   ============================================================ */
function batchNoOf(woId) {
  return String(woId || "").replace(/^WO[\s-]*/i, "") || String(woId || "");
}

/** The lab product that tests a given inventory item. */
function productForItem(itemId, products) {
  const id = String(itemId || "");
  if (!id) return null;
  const list = products || listProducts();
  return list.find((p) => p.itemId && String(p.itemId) === id)
    // the import links every product to its item; this is the belt-and-braces
    // path for a product added by hand, whose code is the item id less "FG-"
    || list.find((p) => p.code && "FG-" + String(p.code) === id)
    || null;
}

/** The certificate covering a work order, however it was referenced. */
function reportForWO(wo, reports, product) {
  const id = String((wo && wo.id) || "");
  if (!id) return null;
  const bn = batchNoOf(id);
  const list = reports || listReports();
  return list.find((r) => String(r.woId || "") === id)
    || list.find((r) => (!product || r.productId === product.id)
      && [id, bn].indexOf(String(r.refNo || "").trim()) >= 0)
    || null;
}

/** Does this job pass through the coating floor? */
function hasCoatingStage(wo) {
  return ((wo && wo.route) || []).some((r) => r && r.area === "coating");
}

/**
 * Where a work order stands with QC.
 * Returns { woId, batchNo, product, params, report, prodValues, labValues,
 *           prodComplete, labComplete, missingProd, missingLab, coating }.
 * `data` is an already-loaded state (avoids a second full read).
 */
function labStatusForWO(wo, data) {
  data = data || {};
  const products = data.labProducts || listProducts();
  const reports = data.labReports || listReports();
  const product = productForItem(wo && wo.itemId, products);
  const params = product ? paramsForProduct(product) : [];
  const report = product ? reportForWO(wo, reports, product) : reportForWO(wo, reports, null);
  const prodValues = (report && report.prodValues) || {};
  const labValues = (report && report.labValues) || {};
  return {
    woId: (wo || {}).id || null,
    batchNo: batchNoOf((wo || {}).id),
    itemId: (wo || {}).itemId || null,
    product: product
      ? { id: product.id, code: product.code, name: product.name, thickness: product.thickness, refMode: product.refMode || "batch" }
      : null,
    params: params.map((p) => ({ key: p.key, label: p.label, unit: p.unit })),
    reportId: report ? report.id : null,
    prodValues, labValues,
    prodComplete: setComplete(prodValues, params),
    labComplete: setComplete(labValues, params),
    missingProd: missingParams(prodValues, params).map((p) => p.label),
    missingLab: missingParams(labValues, params).map((p) => p.label),
    coating: hasCoatingStage(wo),
  };
}

/* ============================================================
   THE COATING GATE
   A coated batch does not leave the coating floor unmeasured. The
   supervisor who ran it records the production reading against the
   work order; until every parameter the Products master asks for
   carries a value, the stage cannot be completed. A lab reading
   counts too — the point is that the batch HAS been measured, not
   who held the micrometer.
   ============================================================ */
function coatingGate(wo, data) {
  const st = labStatusForWO(wo, data);
  if (!st.product) {
    // nothing in the lab master tests this product — there is no certificate
    // to demand, and refusing the stage would strand the job on the floor
    return { ok: true, reason: "no-lab-product", status: st };
  }
  if (!st.params.length) return { ok: true, reason: "no-parameters", status: st };
  if (st.prodComplete || st.labComplete) return { ok: true, reason: "measured", status: st };
  const missing = st.reportId ? st.missingProd : st.params.map((p) => p.label);
  return {
    ok: false,
    reason: st.reportId ? "incomplete" : "missing",
    status: st,
    message: "Lab report required before coating can be finished — batch "
      + st.batchNo + " (" + (st.product.code || st.product.name) + ") still needs "
      + missing.length + " reading" + (missing.length === 1 ? "" : "s") + ": "
      + missing.join(", ") + ".",
  };
}

/* ============================================================
   THE FINISHED-STOCK GATE
   Nothing is booked into a store unmeasured either. Stock added by
   hand carries no work order, so the batch is named by whoever
   books it and the certificate is filed against that. The rule is
   otherwise the coating gate's: every parameter the Products
   master asks for, or the booking is refused.

   Returns { ok, required, product, params, refNo, values, message }.
   `values` is the set to record once the caller's own writes have
   gone through — validated here, saved by the caller.
   ============================================================ */
function finishedStockGate(itemId, body, data) {
  body = body || {}; data = data || {};
  const products = data.labProducts || listProducts();
  const reports = data.labReports || listReports();
  const product = productForItem(itemId, products);
  const params = product ? paramsForProduct(product) : [];
  const base = { required: !!(product && params.length), product, params };
  // nothing in the lab master tests this product — there is no certificate to ask for
  if (!base.required) return Object.assign({ ok: true, reason: "no-parameters" }, base);

  const refNo = String(body.refNo != null ? body.refNo : (body.batchNo || "")).trim();
  if (!refNo) {
    return Object.assign({ ok: false, reason: "no-batch" }, base, {
      message: "Enter the batch / lot number this stock was made on — its lab report is filed against it.",
    });
  }
  const existing = findByRef(product.id, refNo, reports);
  const already = existing
    && (setComplete(existing.prodValues, params) || setComplete(existing.labValues, params));
  if (already) return Object.assign({ ok: true, reason: "already-measured", refNo, reportId: existing.id }, base);

  const supplied = body.labValues || body.values || null;
  const missing = missingParams(supplied || {}, params);
  if (missing.length) {
    return Object.assign({ ok: false, reason: supplied ? "incomplete" : "missing", refNo }, base, {
      missing: missing.map((p) => p.label),
      message: "Enter the lab report for batch " + refNo + " before booking this stock — "
        + missing.length + " reading" + (missing.length === 1 ? "" : "s") + " missing: "
        + missing.map((p) => p.label).join(", ") + ".",
    });
  }
  return Object.assign({ ok: true, reason: "supplied", refNo, values: pickValues(supplied, params),
    reportId: existing ? existing.id : null }, base);
}

/**
 * Every work order the lab still owes a reading on, newest first.
 * `stage` says what is outstanding: "production" (the floor has not
 * measured a coated batch yet) or "lab" (the incharge's own reading).
 */
function pendingLabWork(data) {
  data = data || {};
  const wos = data.workorders || [];
  const out = [];
  wos.forEach((wo) => {
    if (!wo || wo.dispatched) return;
    const st = labStatusForWO(wo, data);
    if (!st.product || !st.params.length) return;
    if (st.labComplete) return;                       // the lab is done with it
    out.push(Object.assign({}, st, {
      date: wo.date || null,
      due: wo.due || null,
      qty: wo.qty != null ? wo.qty : null,
      status: wo.status || null,
      productName: st.product.name,
      productCode: st.product.code,
      // the floor still owes its reading on a coating job that has not been measured
      stage: st.coating && !st.prodComplete ? "production" : "lab",
    }));
  });
  return out.sort((a, b) => String(b.woId).localeCompare(String(a.woId)));
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
  specKeys, paramsForProduct, setComplete, missingParams,
  listProducts, createProduct, updateProduct, deleteProduct, setProductSpec,
  listReports, createReport, updateReport, deleteReport,
  batchNoOf, productForItem, reportForWO, hasCoatingStage, findByRef,
  labStatusForWO, coatingGate, finishedStockGate, pendingLabWork,
  ensureLab,
};
