/* ============================================================
   CHHAPERIA ERP — BACKEND · Incoming-material testing ("GRN testing")

   The flow this serves
   --------------------
   A purchase order is received → the server issues a numbered GRN
   (erpService.receivePurchaseOrder) → the material now needs checking
   before anyone trusts it. The lab incharge opens the receipt, reads
   the parameters this material is tested on, enters the measured
   values, and the result is graded here and shown back on the PO.

   Design decisions, and why
   -------------------------
   • WHERE THE PARAMETERS COME FROM. Raw materials have no equivalent
     of the finished-goods TDS, so the parameter list lives on the
     ITEM itself: `qcParams` (which parameters) + `qcSpec` (the
     limits). An item that has never been configured falls back to
     parameters derived from what the master already RECORDS about it
     — a material whose thickness/GSM/width are known is checked on
     exactly those, plus a visual check. No tolerances are invented:
     until an admin sets limits the report grades "Pending", which is
     honest, rather than passing everything by default.
   • THE MEASURER NEVER SEES THE YARDSTICK. `qcSpec` is stripped from
     every non-admin payload and the verdict is stripped from the lab
     role's, exactly as labService/viewService already do for
     finished goods — a reading whose Pass/Fail is visible can be
     nudged until it passes. Grading is server-side, always.
   • A FAILED LOT IS NOT BLOCKED HERE. The goods were booked into
     stock when the receipt was posted; this service records and
     flags the failure so the office can raise a debit note through
     the rejection path that already exists. It deliberately does not
     hold or reverse stock — that would be a quarantine flow with its
     own release action, and it is not what was asked for.
   • ONE REPORT PER (RECEIPT × MATERIAL). Re-measuring updates the
     report rather than filing a second, contradictory result for the
     same delivery.
   ============================================================ */
"use strict";
const repo = require("../db/repository");

let _mvSeq = 0;
function mvId() { return "MV-" + Date.now().toString(36).toUpperCase() + "-" + (++_mvSeq).toString(36).toUpperCase(); }

function err(msg, status) { const e = new Error(msg); e.status = status || 400; return e; }
function num(v) { return v == null || v === "" || isNaN(+v) ? null : +v; }
function todayISO() { const x = new Date(); const p = (n) => String(n).padStart(2, "0"); return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`; }
const str = (v, n) => (v == null ? "" : String(v).trim().slice(0, n || 120));

/* ============================================================
   PARAMETER CATALOGUE — what an incoming material CAN be checked
   on. `type:"text"` rows are recorded but never graded (a visual
   check has no min/max), so they read "na" and never fail a lot.
   This list is the menu an admin picks from per material; the
   factory's own parameter list drops straight in here.
   ============================================================ */
const PARAMS = [
  { key: "thickness",   label: "Thickness",           unit: "mm",   type: "num" },
  { key: "massPerArea", label: "Mass per unit area",  unit: "g/m²", type: "num" },
  { key: "width",       label: "Width",               unit: "mm",   type: "num" },
  { key: "rollLength",  label: "Length per roll",     unit: "m",    type: "num" },
  { key: "tensile",     label: "Tensile",             unit: "N/cm", type: "num" },
  { key: "elongation",  label: "Elongation",          unit: "%",    type: "num" },
  { key: "bdv",         label: "Breakdown voltage",   unit: "kV",   type: "num" },
  { key: "moisture",    label: "Moisture",            unit: "%",    type: "num" },
  { key: "solids",      label: "Solid content",       unit: "%",    type: "num" },
  { key: "viscosity",   label: "Viscosity",           unit: "cP",   type: "num" },
  { key: "density",     label: "Density",             unit: "g/cm³", type: "num" },
  { key: "ph",          label: "pH",                  unit: "",     type: "num" },
  { key: "visual",      label: "Visual / appearance", unit: "",     type: "text" },
  { key: "packing",     label: "Packing condition",   unit: "",     type: "text" },
];
const BY_KEY = Object.fromEntries(PARAMS.map((p) => [p.key, p]));

/** Is this material a sheet good (fabric / tape / film) rather than a liquid? */
function isSheet(item) {
  item = item || {};
  return !!item.fabric || String(item.uom || "").toUpperCase() === "MTR"
    || item.gsm != null || item.thicknessMM != null;
}

/* ============================================================
   WHICH PARAMETERS THIS MATERIAL IS CHECKED ON
   An explicit `qcParams` on the item always wins — that is what the admin
   or the lab incharge saved. The list below is the STARTING POINT the
   factory's own materials are seeded with (ensureItemQc), worked out from
   what each material actually IS: a mica paper is not checked like a
   carbon paste, and a drum of solvent is not checked like a fabric.
   Everything here is a parameter someone at goods-in can actually take a
   reading for; no limits are invented, so nothing grades until an admin
   sets them.
   ============================================================ */
function classify(item) {
  item = item || {};
  const n = String(item.name || item.id || "").toUpperCase();
  const uom = String(item.uom || "").toUpperCase();
  if (/\bMICA\b/.test(n)) return "mica";
  if (/PACKING|CARTON|BOX|PALLET|CORE|STRETCH|TAPE ROLL|LABEL|STICKER/.test(n)
    || ["PLT", "BOX", "ROLL", "NOS", "PCS"].indexOf(uom) >= 0) return "packing";
  if (isSheet(item)) return "sheet";
  if (/PASTE|ADHESIVE|BONDEX|RESIN|BINDER|LACQUER|COATING/.test(n)) return "paste";
  if (/SOLVENT|METHANOL|MEK|ACITATE|ACETATE|TOLUENE|WATER|THINNER|ALCOHOL/.test(n)) return "liquid";
  if (/SAP|POWDER|HARDNER|HARDENER|PEROXIDE|BPO|CATALYST|PIGMENT|FILLER/.test(n)
    || ["GRAM", "MG"].indexOf(uom) >= 0) return "powder";
  if (uom === "KG") return "paste";     // the rest of the KG chemicals
  return "other";
}
const BY_CLASS = {
  // mica paper is the flagship raw material — its dielectric strength is the
  // whole point of buying it, so it is checked on BDV as well as the geometry
  mica:    ["thickness", "massPerArea", "width", "bdv", "visual"],
  sheet:   ["thickness", "massPerArea", "width", "visual"],
  paste:   ["solids", "viscosity", "density", "visual"],
  liquid:  ["density", "visual", "packing"],
  powder:  ["moisture", "visual", "packing"],
  packing: ["visual", "packing"],
  other:   ["visual"],
};
function derivedParamKeys(item) {
  const keys = (BY_CLASS[classify(item)] || BY_CLASS.other).slice();
  /* Never ask for a figure the master does not hold: a fabric with no width
     recorded has nothing to check the delivered width against. */
  const drop = [];
  if (item && item.widthMM == null && item.width == null) drop.push("width");
  const kept = keys.filter((k) => drop.indexOf(k) < 0);
  return kept.length ? kept : ["visual"];
}
function paramKeysForItem(item) {
  const own = (item || {}).qcParams;
  if (Array.isArray(own) && own.length) {
    const picked = own.map((k) => str(k, 40)).filter((k) => BY_KEY[k]);
    if (picked.length) return [...new Set(picked)];
  }
  return derivedParamKeys(item);
}
/** The parameter rows a report for this material carries, in catalogue order. */
function paramsForItem(item) {
  const keys = paramKeysForItem(item);
  return PARAMS.filter((p) => keys.indexOf(p.key) >= 0)
    .map((p) => ({ key: p.key, label: p.label, unit: p.unit, type: p.type }));
}
/** True when the material has been configured by hand (vs. running on defaults). */
function isConfigured(item) {
  const own = (item || {}).qcParams;
  return Array.isArray(own) && own.some((k) => BY_KEY[str(k, 40)]);
}
function specOf(item) {
  const s = (item || {}).qcSpec;
  return s && typeof s === "object" ? s : {};
}
function hasLimit(sp) { return !!sp && (sp.min != null || sp.max != null); }
/** Which parameters carry a limit — the shape of the spec, without the numbers. */
function specKeys(item) {
  const spec = specOf(item);
  return Object.keys(spec).filter((k) => hasLimit(spec[k]));
}

/* ============================================================
   GRADING — measured values against the material's hidden spec.
   A numeric parameter with a limit passes or fails; one without a
   limit is "na" (nothing to grade against yet); a text parameter is
   always "na" — it is recorded for the record, not graded.
     Fail     → any parameter breached its limit
     Pass     → at least one parameter graded and none failed
     Pending  → a limit exists but nothing was graded against it yet
     Recorded → NO limit exists to grade against — the reading is on
                record, and that is all it can ever be. A material checked
                on visual and packing alone (the default) used to sit
                "Pending" for ever, which read as work still owed.
   ============================================================ */
function evaluate(values, spec, params) {
  values = values || {}; spec = spec || {};
  const results = {};
  let anyEval = false, anyFail = false;
  (params || []).forEach((p) => {
    const raw = values[p.key];
    if (p.type === "text") { results[p.key] = str(raw, 200) ? "na" : "—"; return; }
    const v = num(raw);
    if (v == null) { results[p.key] = "—"; return; }          // not measured
    const sp = spec[p.key];
    if (!hasLimit(sp)) { results[p.key] = "na"; return; }      // no limit to judge it by
    anyEval = true;
    let ok = true;
    if (sp.min != null && v < +sp.min) ok = false;
    if (sp.max != null && v > +sp.max) ok = false;
    results[p.key] = ok ? "pass" : "fail";
    if (!ok) anyFail = true;
  });
  const gradable = (params || []).some((p) => p.type !== "text" && hasLimit(spec[p.key]));
  return { results, result: anyEval ? (anyFail ? "Fail" : "Pass") : gradable ? "Pending" : "Recorded" };
}
/* Reports filed before "Recorded" existed sit "Pending" although nothing
   could ever grade them. Runs at boot; a report whose verdict does not change
   is not touched. */
async function regradeUngraded() {
  let n = 0;
  for (const t of await repo.getGrnTests()) {
    if (!t || !t.complete || t.result !== "Pending") continue;
    const item = await repo.getItem(t.itemId) || {};
    const graded = evaluate(t.values, specOf(item), paramsForItem(item));
    if (graded.result === t.result) continue;
    await repo.putGrnTest(Object.assign({}, t, { results: graded.results, result: graded.result }));
    n++;
  }
  return n;
}

/** Keep only the parameters this material is checked on, in their own type. */
function pickValues(raw, params) {
  const out = {};
  (params || []).forEach((p) => {
    const v = (raw || {})[p.key];
    if (p.type === "text") { const s = str(v, 200); if (s) out[p.key] = s; return; }
    const n = num(v); if (n != null) out[p.key] = n;
  });
  return out;
}
/** Every parameter measured? Text rows count as measured once written. */
function isComplete(values, params) {
  if (!params || !params.length) return false;
  return params.every((p) => {
    const v = (values || {})[p.key];
    return p.type === "text" ? !!str(v, 200) : num(v) != null;
  });
}
function missingParams(values, params) {
  return (params || []).filter((p) => {
    const v = (values || {})[p.key];
    return p.type === "text" ? !str(v, 200) : num(v) == null;
  });
}

function nextId(list) {
  let max = 0;
  (list || []).forEach((x) => { const m = /(\d+)\s*$/.exec(String((x && x.id) || "")); if (m) max = Math.max(max, +m[1]); });
  return "GT-" + String(max + 1).padStart(4, "0");
}

/* ============================================================
   THE MATERIAL MASTER SIDE (admin)
   `qcParams` + `qcSpec` are written together: the parameter list is
   the shape of the form and the spec is the yardstick, and letting
   them drift apart is how a report ends up graded on a parameter it
   never asked for.
   ============================================================ */
/* WHO MAY CHANGE WHAT.
   The lab incharge decides WHICH readings a material needs — that is their
   trade, and they are the one standing at the delivery. They may not touch the
   LIMITS: those are the yardstick their own reading is graded against, and the
   whole point of grading server-side is that the measurer cannot move the
   goalposts (the same rule labService applies to the TDS spec). So a lab write
   carries the parameter list only; a `spec` from anyone but admin is ignored,
   not rejected, so their save still succeeds. */
async function setItemQc(itemId, body, user) {
  const item = await repo.getItem(itemId);
  if (!item) throw err("Unknown item " + itemId, 404);
  body = body || {};
  const isAdmin = !user || user.role === "admin";
  let keys = null;
  if (Array.isArray(body.params)) {
    keys = [...new Set(body.params.map((k) => str(k, 40)).filter((k) => BY_KEY[k]))];
  }
  if (keys) item.qcParams = keys;

  let specChanged = false;
  if (isAdmin) {
    const spec = {};
    const src = body.spec && typeof body.spec === "object" ? body.spec : {};
    // limits are only meaningful for a parameter actually on the list, and only
    // for a numeric one — a visual check has no min/max
    const allowed = keys || paramKeysForItem(item);
    Object.keys(src).forEach((k) => {
      if (!BY_KEY[k] || BY_KEY[k].type === "text" || allowed.indexOf(k) < 0) return;
      const min = num(src[k] && src[k].min), max = num(src[k] && src[k].max);
      if (min == null && max == null) return;
      if (min != null && max != null && min > max) {
        throw err("Minimum cannot exceed maximum for " + BY_KEY[k].label, 400);
      }
      spec[k] = {};
      if (min != null) spec[k].min = min;
      if (max != null) spec[k].max = max;
    });
    item.qcSpec = spec;
    specChanged = true;
  }
  await repo.putItem(item);
  /* Limits changed → every report already filed on this material was graded
     against the OLD yardstick, so re-grade them. Leaving stale verdicts on
     screen next to a new spec is how a lot reads Pass against limits it would
     now fail. A parameter-list change re-grades too: a report's rows come from
     the list, so dropping one has to drop its verdict with it. */
  const regraded = await regradeItem(itemId, item);
  return { ok: true, itemId, params: paramKeysForItem(item), specKeys: specKeys(item),
    specEditable: isAdmin, specChanged, regraded };
}

/* ============================================================
   SEEDING THE FACTORY'S OWN MATERIALS
   Rather than leave every material on a derived fallback, each purchasable
   item is given a real starting parameter list worked out from what it is
   (see classify/BY_CLASS). Idempotent and non-destructive: an item that
   already carries a list — because someone edited it — is never touched, so
   this can run on every boot. Limits are NOT seeded; inventing a tolerance
   would make a lot pass or fail against a number nobody agreed to.
   ============================================================ */
const PURCHASABLE = ["RM", "PKG", "CON"];
async function ensureItemQc() {
  const items = (await repo.getState()).items || [];
  let changed = 0;
  /* for…of, not forEach. The body writes to the database now, and forEach
     throws away the promise its callback returns — the loop would report a
     count and return before a single item had actually been saved. */
  for (const i of items) {
    if (PURCHASABLE.indexOf(i.cat) < 0) continue;
    if (Array.isArray(i.qcParams) && i.qcParams.length) continue;   // already configured
    const keys = derivedParamKeys(i);
    const full = await repo.getItem(i.id);
    if (!full) continue;
    full.qcParams = keys;
    await repo.putItem(full);
    changed++;
  }
  return { changed, items: items.filter((i) => PURCHASABLE.indexOf(i.cat) >= 0).length };
}

/** Re-grade the reports for one material after its spec changed. */
async function regradeItem(itemId, item) {
  const params = paramsForItem(item);
  const spec = specOf(item);
  let n = 0;
  for (const t of (await repo.getGrnTests()).filter((t) => t.itemId === itemId)) {
    const graded = evaluate(t.values, spec, params);
    await repo.putGrnTest(Object.assign({}, t, {
      params, results: graded.results, result: graded.result,
      complete: isComplete(t.values, params),
    }));
    n++;
  }
  return n;
}

/* ============================================================
   THE TEST ITSELF
   ============================================================ */
/** What the entry form needs for one material on one receipt. */
async function testFormFor(grnId, itemId) {
  const grn = await repo.getGrn(grnId);
  if (!grn) throw err("Goods receipt not found", 404);
  const line = (grn.lines || []).find((l) => l.itemId === itemId);
  if (!line) throw err("This receipt has no line for " + itemId, 404);
  const item = await repo.getItem(itemId) || {};
  const existing = await repo.getGrnTestFor(grnId, itemId);
  return {
    grnId, itemId,
    grn: { id: grn.id, date: grn.date, poId: grn.poId, supplierId: grn.supplierId,
      invNo: grn.invNo || "", status: grn.status || "Posted" },
    item: { id: itemId, name: item.name || line.name || itemId, uom: line.uom || item.uom || "" },
    line: { ordered: line.ordered, qty: line.qty, accepted: line.accepted, rejected: line.rejected },
    params: paramsForItem(item),
    configured: isConfigured(item),
    specSet: specKeys(item).length > 0,
    values: existing ? existing.values || {} : {},
    remarks: existing ? existing.remarks || "" : "",
    testId: existing ? existing.id : null,
    testedBy: existing ? existing.testedBy || "" : "",
    testedAt: existing ? existing.testedAt || null : null,
  };
}

/**
 * File (or re-file) the readings for one material on one receipt.
 * body: { itemId, values:{param:value}, remarks?, date? }
 */
async function submitTest(grnId, body, user) {
  body = body || {};
  const grn = await repo.getGrn(grnId);
  if (!grn) throw err("Goods receipt not found", 404);
  if (grn.status === "Cancelled") throw err("This goods receipt was cancelled — there is nothing to test.", 400);
  const itemId = str(body.itemId, 80);
  const line = (grn.lines || []).find((l) => l.itemId === itemId);
  if (!line) throw err("This receipt has no line for " + (itemId || "that material"), 400);

  const item = await repo.getItem(itemId) || {};
  const params = paramsForItem(item);
  if (!params.length) throw err("No test parameters are set for " + (item.name || itemId) + ".", 400);

  const existing = await repo.getGrnTestFor(grnId, itemId);
  const values = pickValues(body.values, params);
  const missing = missingParams(values, params);
  if (missing.length) {
    throw err("Enter every reading before filing the report — "
      + missing.length + " still missing: " + missing.map((p) => p.label).join(", ") + ".", 400);
  }
  const graded = evaluate(values, specOf(item), params);
  const now = new Date().toISOString();
  /* A FAIL RAISES A DECISION, IT DOES NOT MAKE ONE.
     The lot is already in the store — it was booked in when the receipt was
     posted — so failing it cannot quietly move stock. It puts the lot in front
     of the admin instead: approve the rejection and it is transferred to the
     quarantine store, decline it and the lot stands as good stock. A re-test
     that flips the verdict clears any decision already taken, because a
     decision belongs to the reading it was made on. */
  const priorDecision = existing && existing.result === graded.result ? (existing.decision || "") : "";
  const test = {
    id: (existing && existing.id) || nextId(await repo.getGrnTests()),
    grnId, itemId,
    poId: grn.poId || "", supplierId: grn.supplierId || "",
    itemName: item.name || line.name || itemId,
    uom: line.uom || item.uom || "",
    wh: grn.wh || "",                       // the store the lot was booked into
    acceptedQty: +line.accepted || 0,        // what a quarantine transfer moves
    date: str(body.date, 20) || (existing && existing.date) || todayISO(),
    /* SAMPLING + TRACEABILITY — what a real incoming-inspection report has to
       state and mine did not: how much was inspected out of how much arrived,
       and what the supplier's own identity for the lot was. Without the sample
       size a reading is an anecdote; without the supplier's batch/heat number a
       failure cannot be pinned to the lot they shipped. All optional — nothing
       is invented when the storekeeper does not have it. */
    sampleSize: num(body.sampleSize) != null ? num(body.sampleSize)
      : (existing && existing.sampleSize != null ? existing.sampleSize : null),
    supplierBatch: body.supplierBatch != null ? str(body.supplierBatch, 60)
      : (existing && existing.supplierBatch) || "",
    certRef: body.certRef != null ? str(body.certRef, 60)
      : (existing && existing.certRef) || "",
    params, values,
    results: graded.results, result: graded.result,
    complete: isComplete(values, params),
    /* "" = no decision owed (a pass) or owed and not yet taken (a fail);
       read together with `result`, and awaitingDecision() below says which. */
    decision: priorDecision,
    decidedBy: priorDecision ? existing.decidedBy || "" : "",
    decidedAt: priorDecision ? existing.decidedAt || null : null,
    decisionNote: priorDecision ? existing.decisionNote || "" : "",
    testedBy: (user && user.username) || str(body.testedBy) || "user",
    testedAt: now,
    remarks: str(body.remarks, 500),
    createdAt: (existing && existing.createdAt) || now,
  };
  await repo.putGrnTest(test);
  return { ok: true, test, awaitingDecision: awaitingDecision(test) };
}

/** A failed lot with no admin decision yet — this is what notifies the admin. */
function awaitingDecision(t) {
  return !!t && t.result === "Fail" && !t.decision;
}

/**
 * The admin's ruling on a failed lot.
 *   approve === true  → the rejection stands: the accepted quantity is
 *                       TRANSFERRED to the quarantine store, out of reach of
 *                       production (see stageService/productionService, which
 *                       exclude quarantine stores from what a job may draw).
 *   approve === false → the rejection is declined: the lot stays where it is
 *                       and is good stock. Nothing moves.
 * Only ever posts the transfer once, so a double-click cannot move the lot twice.
 */
async function decideTest(id, body, user) {
  body = body || {};
  const t = await repo.getGrnTest(id);
  if (!t) throw err("Test report not found", 404);
  if (t.result !== "Fail") throw err("Only a failed lot needs a decision — this one reads " + (t.result || "Pending") + ".", 400);
  if (t.decision) throw err("This lot was already " + t.decision + " by " + (t.decidedBy || "an admin") + ".", 409);
  const approve = body.approve === true || body.approve === "true";
  const now = new Date().toISOString();
  const note = str(body.note, 500);

  let moved = null;
  if (approve) {
    const qty = +t.acceptedQty || 0;
    const from = t.wh || "";
    const hold = await quarantineWarehouse();
    if (!hold) throw err("No quarantine store exists to hold the lot. Add a warehouse of type 'Quarantine'.", 400);
    if (qty > 0 && from && from !== hold) {
      /* An XFER PAIR, the ledger idiom this ERP already uses to re-home stock:
         the lot leaves the receiving store and lands in quarantine, and both
         halves quote the GRN so the movement is traceable to the delivery that
         brought it in. Total on-hand is unchanged — this is a location change,
         not a write-off. Writing the lot off is a separate decision (a debit
         note / return), and not one to take on the lab's behalf. */
      const ref = t.grnId;
      const note2 = "Failed incoming test — quarantined on admin approval";
      await repo.addMovements([
        { id: mvId(), date: todayISO(), itemId: t.itemId, wh: from, type: "XFER",
          qty: -Math.abs(qty), rate: 0, ref, note: note2, by: (user && user.username) || "admin" },
        { id: mvId(), date: todayISO(), itemId: t.itemId, wh: hold, type: "XFER",
          qty: Math.abs(qty), rate: 0, ref, note: note2, by: (user && user.username) || "admin" },
      ]);
      moved = { qty: Math.abs(qty), from, to: hold };
    }
  }
  const out = Object.assign({}, t, {
    decision: approve ? "quarantined" : "released",
    decidedBy: (user && user.username) || "admin",
    decidedAt: now,
    decisionNote: note,
    quarantined: approve ? moved : null,
  });
  await repo.putGrnTest(out);
  return { ok: true, test: out, moved };
}

/** The store that holds quarantined material, by warehouse TYPE not by id. */
async function quarantineWarehouse() {
  const whs = (await repo.getState()).warehouses || [];
  const hold = whs.find((w) => /quarantine|qc.?hold|reject/i.test(String(w.type || "") + " " + String(w.name || "")));
  return hold ? hold.id : null;
}
/** Ids of every store whose contents production must not be able to draw. */
async function heldWarehouseIds(data) {
  const whs = (data && data.warehouses) || (await repo.getState()).warehouses || [];
  return whs.filter((w) => /quarantine|qc.?hold|reject/i.test(String(w.type || "") + " " + String(w.name || "")))
    .map((w) => w.id);
}

/** Every failed lot still waiting on the admin — the notification list. */
async function pendingDecisions(data) {
  data = data || {};
  const tests = data.grnTests || await repo.getGrnTests();
  const grns = data.grns || await repo.getGrns();
  const live = new Set(grns.filter((g) => g.status !== "Cancelled").map((g) => g.id));
  return tests.filter((t) => awaitingDecision(t) && live.has(t.grnId))
    .map((t) => ({
      id: t.id, grnId: t.grnId, poId: t.poId || "", itemId: t.itemId, itemName: t.itemName,
      supplierId: t.supplierId || "", date: t.date || null,
      acceptedQty: +t.acceptedQty || 0, uom: t.uom || "", wh: t.wh || "",
      testedBy: t.testedBy || "", testedAt: t.testedAt || null,
      failed: Object.keys(t.results || {}).filter((k) => t.results[k] === "fail")
        .map((k) => (BY_KEY[k] || {}).label || k),
    }))
    .sort((a, b) => String(b.grnId).localeCompare(String(a.grnId)));
}

async function deleteTest(id) {
  if (!await repo.getGrnTest(id)) throw err("Test report not found", 404);
  return await repo.deleteGrnTest(id);
}

/* ============================================================
   READING IT BACK — what the PO and the receipt show
   ============================================================ */
/** Per-line test state for one receipt, plus the receipt's overall verdict. */
async function statusForGrn(grn, data) {
  data = data || {};
  const items = data.items || null;
  const itemById = items ? Object.fromEntries(items.map((i) => [i.id, i])) : null;
  const tests = data.grnTests || await repo.getGrnTests();
  const mine = tests.filter((t) => t.grnId === grn.id);
  /* Prefetched rather than read inside .map(): the callback would need an
     await, and .map() would then hand back an array of promises. */
  const fetched = {};
  if (!itemById) for (const l of (grn.lines || [])) fetched[l.itemId] = await repo.getItem(l.itemId);
  const lines = (grn.lines || []).map((l) => {
    const item = (itemById ? itemById[l.itemId] : fetched[l.itemId]) || {};
    const t = mine.find((x) => x.itemId === l.itemId) || null;
    return {
      itemId: l.itemId, name: l.name || item.name || l.itemId,
      params: paramsForItem(item).length,
      tested: !!(t && t.complete),
      result: t ? t.result : null,
      testId: t ? t.id : null,
      decision: t ? t.decision || "" : "",
      awaitingDecision: awaitingDecision(t),
      testedBy: t ? t.testedBy : null, testedAt: t ? t.testedAt : null,
    };
  });
  const testable = lines.filter((l) => l.params > 0);
  const anyFail = lines.some((l) => l.result === "Fail");
  const allTested = testable.length > 0 && testable.every((l) => l.tested);
  return {
    grnId: grn.id,
    lines,
    pending: testable.filter((l) => !l.tested).length,
    // a failed lot the admin has not ruled on yet is the loudest state there is
    awaitingDecision: lines.filter((l) => l.awaitingDecision).length,
    quarantined: lines.filter((l) => l.decision === "quarantined").length,
    // "Fail" the moment one material fails — a receipt is only as good as its
    // worst line, and a part-tested delivery must not read as cleared
    result: anyFail ? "Fail" : !testable.length ? "Not required"
      : !allTested ? "Pending" : lines.some((l) => l.result === "Pass") ? "Pass" : "Recorded",
  };
}

/** Roll the receipts of one purchase order into a single QC verdict. */
async function statusForPo(poId, data) {
  data = data || {};
  const grns = (data.grns || await repo.getGrns())
    .filter((g) => g.poId === poId && g.status !== "Cancelled");
  if (!grns.length) return { poId, result: "No receipt", pending: 0, grns: [] };
  /* Sequential, not .map(): an async callback makes .map() return promises,
     and the reduce/some just below would be counting promise objects. */
  const each = [];
  for (const g of grns) each.push(await statusForGrn(g, data));
  const pending = each.reduce((s, x) => s + x.pending, 0);
  const anyFail = each.some((x) => x.result === "Fail");
  const required = each.some((x) => x.result !== "Not required");
  return {
    poId, grns: each, pending,
    awaitingDecision: each.reduce((s, x) => s + x.awaitingDecision, 0),
    quarantined: each.reduce((s, x) => s + x.quarantined, 0),
    result: anyFail ? "Fail" : !required ? "Not required"
      : pending ? "Pending" : each.some((x) => x.result === "Pass") ? "Pass" : "Recorded",
  };
}

/**
 * The lab incharge's incoming worklist: every posted receipt line that
 * still owes a reading, newest receipt first.
 */
async function pendingTests(data) {
  data = data || {};
  const grns = (data.grns || await repo.getGrns()).filter((g) => g.status !== "Cancelled");
  const out = [];
  for (const g of grns) {
    const st = await statusForGrn(g, data);
    st.lines.forEach((l) => {
      if (!l.params || l.tested) return;
      out.push({
        grnId: g.id, date: g.date || null, poId: g.poId || "",
        supplierId: g.supplierId || "", invNo: g.invNo || "",
        itemId: l.itemId, itemName: l.name, params: l.params,
      });
    });
  }
  return out.sort((a, b) => String(b.grnId).localeCompare(String(a.grnId)));
}

module.exports = {
  PARAMS, paramsForItem, paramKeysForItem, isConfigured, specOf, specKeys,
  classify, derivedParamKeys,
  evaluate, pickValues, isComplete, missingParams,
  setItemQc, regradeItem, regradeUngraded, ensureItemQc,
  testFormFor, submitTest, deleteTest,
  decideTest, awaitingDecision, pendingDecisions,
  quarantineWarehouse, heldWarehouseIds,
  statusForGrn, statusForPo, pendingTests,
};
