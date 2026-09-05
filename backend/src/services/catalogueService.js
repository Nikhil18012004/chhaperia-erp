/* ============================================================
   CHHAPERIA ERP — CATALOGUE SERVICE (2026-09-02)
   ONE SHOT for a new material or product: the item itself, the
   parameters it is tested on (catalogue picks plus its own, each
   with a unit and a static figure or a range), the lab product a
   finished good is certified against, and its recipe — created for
   a product, or joined for a material — in ONE request.

   And the APPROVAL QUEUE. The lab incharge may submit exactly the
   same thing, or a recipe on its own, but nothing of theirs lands in
   the catalogue until an admin approves it. Admin and office apply
   directly. An approval applies through the very same code path a
   direct entry takes, so the two can never differ.
   ============================================================ */
"use strict";
const repo = require("../db/repository");
const erp = require("./erpService");
const GT = require("./grnTestService");
const LAB = require("./labService");
const BC = require("../../../frontend/js/bomcalc");

function err(msg, status) { const e = new Error(msg); e.status = status || 400; return e; }
function str(v, n) { return v == null ? "" : String(v).trim().slice(0, n || 200); }
function num(v) { return v == null || v === "" || isNaN(+v) ? null : +v; }
function todayISO() { const x = new Date(); const p = (n) => String(n).padStart(2, "0"); return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`; }
function nextId(list, prefix) {
  let max = 0;
  (list || []).forEach((x) => { const m = /(\d+)\s*$/.exec(String((x && x.id) || "")); if (m) max = Math.max(max, +m[1]); });
  return prefix + String(max + 1).padStart(4, "0");
}

/* ---- the item ---- */
const ITEM_FIELDS = ["name", "cat", "uom", "reorder", "safety", "lead", "cost", "price", "hsn", "gstRate", "barcode",
  "thicknessMM", "gsm", "width", "length", "tapeWidthMM", "fabric", "typeCode", "group", "series", "productName",
  "material", "grade", "abc", "moq", "supplierId"];
const NUM_FIELDS = ["cost", "price", "reorder", "safety", "lead", "gstRate", "thicknessMM", "gsm", "width", "length", "tapeWidthMM", "moq"];
function cleanItem(raw) {
  raw = raw || {};
  const id = str(raw.id, 80).toUpperCase();
  if (!id) throw err("The new item needs a code", 400);
  if (!str(raw.name, 200)) throw err("The new item needs a name", 400);
  const item = { id, active: true };
  ITEM_FIELDS.forEach((k) => { if (raw[k] !== undefined && raw[k] !== null && raw[k] !== "") item[k] = raw[k]; });
  item.name = str(raw.name, 200);
  item.cat = str(raw.cat, 20).toUpperCase() || "RM";
  item.uom = str(raw.uom, 20).toUpperCase() || "KG";
  NUM_FIELDS.forEach((k) => { if (item[k] != null) { const n = num(item[k]); if (n == null) delete item[k]; else item[k] = n; } });
  if (item.lead == null) item.lead = 7;
  if (item.fabric != null) item.fabric = !!item.fabric;
  if (!item.barcode) item.barcode = "890" + Math.floor(Math.random() * 1e7);
  if (item.cat === "FG") {
    item.productName = str(item.productName, 200) || item.name;
    item.typeCode = str(item.typeCode, 60) || id.replace(/^FG-/, "");
  }
  return item;
}

/* ---- the readings it is tested on ---- */
function cleanTests(raw) {
  raw = raw || {};
  const custom = GT.normalizeCustom(raw.custom || raw.testParams || []);
  const catalogue = GT.PARAMS.concat(LAB.PARAMS).map((p) => p.key);
  const params = [...new Set((Array.isArray(raw.params) ? raw.params : []).map((k) => str(k, 40)).filter((k) => catalogue.indexOf(k) >= 0))];
  const spec = {};
  const src = raw.spec && typeof raw.spec === "object" ? raw.spec : {};
  Object.keys(src).forEach((k) => {
    const s = src[k] || {};
    const min = num(s.min), max = num(s.max), nominal = num(s.nominal);
    if (min == null && max == null && nominal == null) return;
    if (min != null && max != null && min > max) throw err("Minimum cannot exceed maximum for " + k, 400);
    spec[k] = {};
    if (min != null) spec[k].min = min;
    if (max != null) spec[k].max = max;
    if (nominal != null) spec[k].nominal = nominal;
  });
  return { custom, params, spec };
}

/* ---- the recipe ---- */
function cleanBomLines(lines) {
  return BC.normalize(lines || []).filter((l) => (l.id || (l.options && l.options.length)) && l.qty > 0);
}
function cleanYield(y) {
  y = num(y); if (y == null) y = 1; if (y > 1) y = y / 100;
  return Math.min(1, Math.max(0.01, y));
}
function cleanBom(raw) {
  if (!raw || !raw.mode || raw.mode === "none") return null;
  if (raw.mode === "create") {
    const lines = cleanBomLines(raw.lines);
    if (!lines.length) throw err("The recipe needs at least one component with a quantity", 400);
    return { mode: "create", yield: cleanYield(raw.yield), lines };
  }
  if (raw.mode === "append") {
    const productId = str(raw.productId, 80).toUpperCase();
    const qty = num(raw.qty);
    if (!productId) throw err("Pick the product whose recipe this material joins", 400);
    if (!(qty > 0)) throw err("The quantity per kg of product must be greater than zero", 400);
    /* the component this one takes the place of, where it takes anyone's:
       blank means it simply joins the recipe and nothing comes off */
    const replaceId = str(raw.replaceId, 80).toUpperCase();
    return { mode: "append", productId, qty, unit: str(raw.unit, 10).toUpperCase() || "KG",
      pickupPct: num(raw.pickupPct), replaceId: replaceId || null };
  }
  throw err("Unknown recipe mode " + str(raw.mode, 20), 400);
}

/* ============================================================
   A NEW ITEM, ONE SHOT
   payload: { item:{…}, tests:{ params:[keys], custom:[{label,unit}],
             spec:{key:{min,max,nominal}} }, bom:{ mode:"create"|"append"|
             "none", … }, lab:{…optional lab-product fields} }
   ============================================================ */
async function validateNewItem(payload) {
  payload = payload || {};
  const item = cleanItem(payload.item);
  const tests = cleanTests(payload.tests);
  const bom = cleanBom(payload.bom);
  if (!await repo.categoryExists(item.cat)) throw err("Unknown category " + item.cat, 400);
  if (bom && bom.mode === "create") {
    if (item.cat !== "FG") throw err("Only a finished good carries a recipe of its own — a material joins another product's recipe instead", 400);
    for (const l of bom.lines) {
      if (l.id === item.id) throw err("A product cannot be its own component", 400);
      if (l.id && !await repo.getItem(l.id)) throw err("Unknown component " + l.id, 400);
    }
  }
  if (bom && bom.mode === "append") {
    if (item.cat === "FG") throw err("A finished good does not go into another product's recipe — give it a recipe of its own", 400);
    const b = await repo.getBom(bom.productId);
    if (!b) throw err(bom.productId + " has no recipe to add this material to", 400);
    /* replacing something means there is something to replace: a stale form,
       or a recipe edited since it was opened, must not silently append */
    if (bom.replaceId) {
      if (bom.replaceId === item.id) throw err("A material cannot replace itself", 400);
      if (!BC.normalize(b.lines || []).some((l) => l.id === bom.replaceId)) {
        throw err(bom.replaceId + " is not on the recipe of " + bom.productId + " — there is nothing to replace", 400);
      }
    }
  }
  return { item, tests, bom, lab: payload.lab && typeof payload.lab === "object" ? payload.lab : null };
}
async function storeFor(cat) {
  const whs = (await repo.getState()).warehouses || [];
  const want = cat === "FG" ? "finished" : cat === "WIP" ? "wip" : "raw";
  const hit = whs.find((w) => String(w.type || "").toLowerCase().indexOf(want) >= 0)
    || whs.find((w) => !/quarantine/i.test(String(w.type || ""))) || whs[0];
  return hit ? hit.id : null;
}
async function openingMovement(item, user, note) {
  const wh = await storeFor(item.cat);
  if (!wh) return null;
  return await erp.addMovement({ id: "MV-NEW-" + Date.now().toString(36).toUpperCase() + "-" + Math.floor(Math.random() * 1e4),
    date: todayISO(), itemId: item.id, wh, type: "OPEN", qty: 0, rate: item.cost || 0, ref: "NEW",
    note: note + (user && user.username ? " by " + user.username : "") });
}
async function applyNewItem(payload, user) {
  const p = await validateNewItem(payload);
  if (await repo.getItem(p.item.id)) throw err("Item " + p.item.id + " already exists", 409);
  if (p.tests.custom.length) p.item.testParams = p.tests.custom;
  const item = await erp.upsertItem(p.item);
  await openingMovement(item, user, "Item created");
  /* the readings it is checked on — catalogue picks and its own parameters.
     Applied as admin: a proposal reaching this point has BEEN approved by
     one, and a direct entry came from admin or office. */
  let qc = null;
  const gtKeys = p.tests.params.filter((k) => GT.PARAMS.some((q) => q.key === k));
  if (gtKeys.length || p.tests.custom.length || Object.keys(p.tests.spec).length) {
    qc = await GT.setItemQc(item.id, { params: gtKeys.concat(p.tests.custom.map((c) => c.key)), spec: p.tests.spec, custom: p.tests.custom }, { role: "admin" });
  }
  /* a finished good is certified against a LAB PRODUCT — the same parameters
     go there, with their limits, so the certificate asks for exactly what
     was defined when the product was created */
  let labProduct = null;
  if (item.cat === "FG" && (p.tests.custom.length || p.tests.params.length || p.lab)) {
    const lp = Object.assign({ name: item.name, code: item.typeCode || item.id.replace(/^FG-/, ""),
      thickness: item.thicknessMM != null ? String(item.thicknessMM) : "", series: item.group || item.series || "", gsm: item.gsm },
      p.lab || {}, { itemId: item.id, params: p.tests.custom });
    const spec = {};
    p.tests.params.filter((k) => LAB.PARAMS.some((q) => q.key === k)).concat(p.tests.custom.map((c) => c.key))
      .forEach((k) => { if (p.tests.spec[k]) spec[k] = p.tests.spec[k]; });
    if (p.lab && p.lab.spec && typeof p.lab.spec === "object") Object.assign(spec, p.lab.spec);
    lp.spec = spec;
    labProduct = await LAB.createProduct(lp);
  }
  let bom = null;
  if (p.bom && p.bom.mode === "create") {
    bom = await erp.saveBom(item.id, { yield: p.bom.yield, lines: p.bom.lines });
  } else if (p.bom && p.bom.mode === "append") {
    const b = await repo.getBom(p.bom.productId);
    const lines = (b.lines || []).slice();
    const line = { id: item.id, rm: item.name, qty: p.bom.qty, unit: p.bom.unit,
      pickupPct: p.bom.pickupPct == null ? null : p.bom.pickupPct };
    /* REPLACING KEEPS THE LINE WHERE IT STOOD. A line's position is its layer,
       and a coating line that jumped to the end of the list would be computed
       as a different product altogether. The layer and the pickup the old line
       carried belong to that position, so they stay with it unless the new
       material brought its own. Lines are matched ONE AT A TIME so a malformed
       line further up cannot shift the index normalisation would drop. */
    let at = -1;
    if (p.bom.replaceId) {
      for (let i = 0; i < lines.length; i++) {
        const n = BC.normalize([lines[i]])[0];
        if (n && n.id === p.bom.replaceId) { at = i; break; }
      }
    }
    if (at >= 0) {
      const old = BC.normalize([lines[at]])[0] || {};
      if (line.pickupPct == null) line.pickupPct = old.pickupPct == null ? null : old.pickupPct;
      if (old.layer != null) line.layer = old.layer;
      if (old.optional) line.optional = true;
      lines[at] = line;
    } else lines.push(line);
    bom = await erp.saveBom(p.bom.productId, Object.assign({}, b, { lines }));
  }
  return { ok: true, item, qc, labProduct, bom };
}

/* ============================================================
   A RECIPE ON ITS OWN (the BOM page's form, proposed by the lab)
   payload: { itemId, bom:{yield, lines, alternates?}, newItem?:{…} }
   ============================================================ */
async function validateBom(payload) {
  payload = payload || {};
  const itemId = str(payload.itemId, 80).toUpperCase();
  if (!itemId) throw err("The recipe needs a product", 400);
  const raw = payload.bom || {};
  const lines = cleanBomLines(raw.lines);
  if (!lines.length) throw err("The recipe needs at least one component with a quantity", 400);
  const newItem = payload.newItem ? cleanItem(Object.assign({}, payload.newItem, { id: itemId, cat: "FG" })) : null;
  if (!newItem && !await repo.getItem(itemId)) throw err("Unknown product " + itemId, 400);
  for (const l of lines) {
    if (l.id === itemId) throw err("A product cannot be its own component", 400);
    if (l.id && !await repo.getItem(l.id)) throw err("Unknown component " + l.id, 400);
  }
  const bom = { yield: cleanYield(raw.yield), lines };
  if (Array.isArray(raw.alternates) && raw.alternates.length) bom.alternates = raw.alternates;
  /* WHAT THE LAB MEASURES ON IT, defined with the recipe (2026-09-05). A
     product's recipe and its test parameters were two trips — the BOM here,
     the parameters over in Lab Reports, if anybody remembered — and the
     certificate for a product made from a brand-new recipe asked for nothing.
     Optional: a recipe edited on its own still comes through without them. */
  const tests = payload.tests ? cleanTests(payload.tests) : null;
  return { itemId, bom, newItem, tests };
}
/* THE LAB PRODUCT A FINISHED GOOD IS CERTIFIED AGAINST, raised or brought up
   to date from a set of test parameters. One routine for the New Item form
   and the BOM form, so a product defined either way carries the same lab
   product. Both the product's OWN parameters and its limits MERGE over what
   is stored — a parameter the request names is added or brought up to date,
   one it does not name is left exactly as it was. The BOM form ADDS what the
   lab measures; taking a parameter off a certificate is a decision made in
   Lab Reports ▸ Products, with the product in front of you, never a side
   effect of a request that happened not to mention it. */
async function labProductFrom(item, tests, lab) {
  const custom = (tests && tests.custom) || [], params = (tests && tests.params) || [], spec0 = (tests && tests.spec) || {};
  if (!(custom.length || params.length || lab)) return null;
  const spec = {};
  params.filter((k) => LAB.PARAMS.some((q) => q.key === k)).concat(custom.map((c) => c.key))
    .forEach((k) => { if (spec0[k]) spec[k] = spec0[k]; });
  if (lab && lab.spec && typeof lab.spec === "object") Object.assign(spec, lab.spec);
  const existing = await LAB.productForItem(item.id);
  if (existing) {
    const own = (existing.params || []).filter((p) => p && p.key && !custom.some((c) => c.key === p.key)).concat(custom);
    return await LAB.updateProduct(existing.id, { params: own, spec: Object.assign({}, existing.spec || {}, spec),
      thickness: item.thicknessMM != null ? String(item.thicknessMM) : existing.thickness, gsm: item.gsm != null ? item.gsm : existing.gsm });
  }
  const lp = Object.assign({ name: item.name, code: item.typeCode || item.id.replace(/^FG-/, ""),
    thickness: item.thicknessMM != null ? String(item.thicknessMM) : "", series: item.group || item.series || "", gsm: item.gsm },
    lab || {}, { itemId: item.id, params: custom, spec });
  return await LAB.createProduct(lp);
}
async function applyBom(payload, user) {
  const p = await validateBom(payload);
  if (p.newItem) {
    if (await repo.getItem(p.itemId)) throw err("Item " + p.itemId + " already exists", 409);
    const item = await erp.upsertItem(p.newItem);
    await openingMovement(item, user, "Product created with its BOM");
  }
  const bom = await erp.saveBom(p.itemId, p.bom);
  let labProduct = null;
  if (p.tests) {
    const item = await repo.getItem(p.itemId);
    if (item && item.cat === "FG") labProduct = await labProductFrom(item, p.tests, null);
  }
  return { ok: true, itemId: p.itemId, bom, labProduct };
}
/* the one entry point the BOM form calls: the lab proposes, everyone else applies */
async function submitBom(payload, user) {
  if (user && user.role === "lab") return { ok: true, proposed: true, proposal: await propose("bom", payload, user) };
  return await applyBom(payload, user);
}

/* ============================================================
   THE APPROVAL QUEUE
   ============================================================ */
const KINDS = {
  item: { label: "New item", validate: validateNewItem, apply: applyNewItem },
  bom:  { label: "Recipe (BOM)", validate: validateBom, apply: applyBom },
};
function summaryOf(kind, p) {
  if (kind === "item") {
    const bits = [p.item.id + " · " + p.item.name + " (" + p.item.cat + ")"];
    const n = p.tests.params.length + p.tests.custom.length;
    if (n) bits.push(n + " test parameter" + (n === 1 ? "" : "s") + (p.tests.custom.length ? " (" + p.tests.custom.length + " new)" : ""));
    if (p.bom && p.bom.mode === "create") bits.push("recipe with " + p.bom.lines.length + " component" + (p.bom.lines.length === 1 ? "" : "s"));
    if (p.bom && p.bom.mode === "append") bits.push(p.bom.replaceId
      ? "replaces " + p.bom.replaceId + " on the recipe of " + p.bom.productId
      : "joins the recipe of " + p.bom.productId);
    return bits.join(" · ");
  }
  const nt = p.tests ? p.tests.params.length + p.tests.custom.length : 0;
  return "Recipe for " + p.itemId + (p.newItem ? " (new product " + p.newItem.name + ")" : "") + " · " + p.bom.lines.length + " component" + (p.bom.lines.length === 1 ? "" : "s")
    + (nt ? " · " + nt + " test parameter" + (nt === 1 ? "" : "s") : "");
}
async function propose(kind, payload, user) {
  const K = KINDS[kind];
  if (!K) throw err("Unknown proposal kind " + str(kind, 20), 400);
  // fails early, with the same message a direct entry would get
  const clean = await K.validate(payload);
  if (kind === "item" && await repo.getItem(clean.item.id)) throw err("Item " + clean.item.id + " already exists", 409);
  const ap = {
    id: nextId(await repo.getApprovals(), "AP-"), kind, payload,
    summary: summaryOf(kind, clean), status: "Pending",
    by: (user && user.username) || "", byRole: (user && user.role) || "", at: new Date().toISOString(),
    decidedBy: "", decidedAt: null, note: "", result: null,
  };
  await repo.putApproval(ap);
  return ap;
}
async function list() {
  return (await repo.getApprovals()).sort((a, b) => String(b.id).localeCompare(String(a.id)));
}
async function decide(id, body, user) {
  const ap = await repo.getApproval(id);
  if (!ap) throw err("Proposal not found", 404);
  if (ap.status !== "Pending") throw err("This proposal was already " + String(ap.status).toLowerCase() + " by " + (ap.decidedBy || "an admin") + ".", 409);
  body = body || {};
  if (body.approve !== true && body.approve !== false) throw err("Say whether the proposal is approved — send approve: true or false.", 400);
  if (body.approve) {
    const r = await KINDS[ap.kind].apply(ap.payload, user);
    ap.result = { itemId: (r.item && r.item.id) || r.itemId || null, labProductId: r.labProduct ? r.labProduct.id : null };
    ap.status = "Approved";
  } else {
    ap.status = "Rejected";
  }
  ap.decidedBy = (user && user.username) || "admin";
  ap.decidedAt = new Date().toISOString();
  ap.note = str(body.note, 500);
  await repo.putApproval(ap);
  return ap;
}
/* a proposer may withdraw their own pending proposal; admin may remove any */
async function remove(id, user) {
  const ap = await repo.getApproval(id);
  if (!ap) throw err("Proposal not found", 404);
  const admin = user && user.role === "admin";
  if (!admin && ap.by !== (user && user.username)) throw err("Only the person who proposed this, or an admin, may withdraw it", 403);
  if (!admin && ap.status !== "Pending") throw err("This proposal was already " + String(ap.status).toLowerCase() + " and cannot be withdrawn", 409);
  return await repo.deleteApproval(id);
}
/* the one entry point the form calls: the lab proposes, everyone else applies */
async function submitNewItem(payload, user) {
  if (user && user.role === "lab") return { ok: true, proposed: true, proposal: await propose("item", payload, user) };
  return await applyNewItem(payload, user);
}

module.exports = { validateNewItem, applyNewItem, validateBom, applyBom, submitBom, propose, list, decide, remove, submitNewItem, KINDS };
