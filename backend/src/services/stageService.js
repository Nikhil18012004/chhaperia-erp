/* ============================================================
   CHHAPERIA ERP — BACKEND · stage / routing service
   Production is multi-stage and DIFFERS BY PRODUCT. Each product
   follows a "process template" — an ordered list of stages, each
   owned by a production AREA. A work order carries that route so a
   job HANDS OFF between the supervisor panels instead of being
   stuck in one area.

   Process templates
   -----------------
   • standard  (most tapes):   Coating → Slitting → Packing
   • fgtape    (fibre-glass tape): Fibre-Glass Production → Packing
                (made to order spec, no slitting)
   • copperwb  (copper-woven semi-cond WB tape, FG-CU-WBT):
                Copper-Wire Weaving → Semi-Cond WB Coating → Packing
                (weave N copper wires per order, then coat with the
                 semi-conductive water-blocking paste)

   Areas
   -----
   • coating    — coats/laminates standard tapes
   • slitting   — slits + packs + dispatches (the shared pool)
   • fiberglass — runs the fibre-glass floor (fibre-glass tape +
                  copper weaving/coating) AND also covers everything
                  the slitting pool does (see areaCovers()).

   Stock is posted PER STAGE as work-in-process (WIP): each stage
   consumes the previous stage's WIP + its own raw materials and
   produces the next WIP; the final (packing) stage produces the
   finished good. Per-stage recipes are DERIVED from the single BOM
   by classifying each material's role (base / paste / pack), so it
   works on the current data with no manual recipe authoring.

   `ensureStageModel` is an idempotent migration: it adds the WIP
   items + attaches a route to every work order WITHOUT wiping data.
   Legacy work orders are flagged so advancing them hands off between
   panels but does NOT re-post stock the old flow already booked;
   brand-new work orders get the full per-stage posting.
   ============================================================ */
"use strict";

/* ---- yields ---- */
const Y_SLIT = 0.98;   // slitting trim loss (kept for reference / callers)
const Y_PACK = 0.995;  // packing loss

/* default packaging consumption at the packing stage, per kg of FG.
   (these PKG items exist in the item master but were never in any BOM) */
const PACK_DEFAULTS = [
  { id: "PKG-CARTON",  per: 1 / 25,  min: 1, round: true },  // ~1 export carton / 25 kg
  { id: "PKG-STRETCH", per: 0.02 },                          // stretch wrap kg / kg
  { id: "PKG-LABEL",   per: 1 / 500 },                       // barcode label rolls
];

const r2 = (n) => Math.round((+n || 0) * 100) / 100;
const indexBy = (arr, k) => Object.fromEntries((arr || []).map((x) => [x[k], x]));

/* WIP item ids derived deterministically from the FG id + a suffix */
function wipId(fgId, suffix) { return "WIP-" + String(fgId).replace(/^FG-/, "") + "-" + suffix; }

/* ============================================================
   PROCESS TEMPLATES
   Each stage lists the material ROLES it consumes (base = the
   physical carrier/weave; paste = coating/impregnation chemistry;
   pack = cores/packaging). Stages produce a WIP (`wip` suffix)
   except the final packing stage, which produces the finished good.
   ============================================================ */
const TEMPLATES = {
  standard: {
    wips: [["J", "Coated Jumbo (WIP)"], ["S", "Slit Rolls (WIP)"]],
    stages: [
      { key: "coating",  name: "Coating / Lamination", area: "coating",  roles: ["base", "paste"], wip: "J" },
      { key: "slitting", name: "Slitting",             area: "slitting", roles: ["pack"],           wip: "S" },
      { key: "packing",  name: "Packing & Dispatch",   area: "slitting", roles: [], packDefaults: true },
    ],
  },
  fgtape: {
    wips: [["P", "Produced Roll (WIP)"]],
    stages: [
      { key: "production", name: "Fibre-Glass Production", area: "fiberglass", roles: ["base", "paste", "pack"], wip: "P" },
      { key: "packing",    name: "Packing & Dispatch",     area: "slitting",   roles: [], packDefaults: true },
    ],
  },
  copperwb: {
    // number of copper wires woven in is an order spec captured per work order
    spec: { key: "copperWires", label: "Copper wires (per tape)", hint: "as per order" },
    wips: [["W", "Copper-Woven Base (WIP)"], ["C", "Semi-Cond WB Coated (WIP)"]],
    stages: [
      { key: "weaving", name: "Copper-Wire Weaving",   area: "fiberglass", roles: ["base"],         wip: "W" },
      { key: "wbcoat",  name: "Semi-Cond WB Coating",  area: "fiberglass", roles: ["paste", "pack"], wip: "C" },
      { key: "packing", name: "Packing & Dispatch",    area: "slitting",   roles: [], packDefaults: true },
    ],
  },
};

/* which template each product uses (default 'standard') */
const PRODUCT_TEMPLATE = {
  "FG-FG-TAPE": "fgtape",   // fibre-glass tape — produced & packed to order spec
  "FG-CU-WBT":  "copperwb", // copper-woven semi-conductive water-blocking tape
};

function templateKeyFor(fgId) { return PRODUCT_TEMPLATE[fgId] || "standard"; }
function templateFor(fgId) { return TEMPLATES[templateKeyFor(fgId)]; }
function specForProduct(fgId) { return templateFor(fgId).spec || null; }

/* products made on the fibre-glass floor (any template whose first stage is fiberglass) */
const FIBERGLASS_PRODUCTS = new Set(
  Object.keys(PRODUCT_TEMPLATE).filter((id) => TEMPLATES[PRODUCT_TEMPLATE[id]].stages[0].area === "fiberglass")
);

/* classify a raw material's ROLE in the process */
function materialRole(id) {
  const s = String(id || "").toUpperCase();
  if (s.startsWith("PKG-") || s.includes("CORE")) return "pack";
  if (/MICA|SAP|CARBON|SILICONE|ACRYLIC|ADH|INORGANIC|SOLVENT|RESIN|BINDER|PASTE/.test(s)) return "paste";
  return "base"; // copper wire, glass cloth/yarn, nonwoven, films, foils, cotton, foam…
}

/* Area membership. A fibre-glass supervisor does EVERYTHING a slitting
   supervisor does (shares the slitting & dispatch pool) PLUS the fibre-glass
   floor stages — so a stage owned by 'slitting' may also be handled by a
   'fiberglass' user, but not the other way round. */
function areaCovers(userArea, stageArea) {
  if (userArea === "all") return true;
  if (userArea === stageArea) return true;
  if (userArea === "fiberglass" && stageArea === "slitting") return true;
  return false;
}

/* ============================================================
   computeStagePlan — derived per-stage recipe to produce `qty` kg
   of finished good `fgId`. Returns an object keyed by stage key:
     { <stageKey>: { consume:[[id,qty>0]…], produce:[id,qty>0], wh } }
   Each stage consumes the previous stage's WIP + its role materials;
   the final stage produces the finished good. Returns null (no BOM).
   ============================================================ */
function computeStagePlan(fgId, qty, data) {
  const bom = (data.boms || {})[fgId];
  if (!bom) return null;
  const itemsById = indexBy(data.items || [], "id");
  const tpl = templateFor(fgId);
  const stages = tpl.stages;
  const Y = bom.yield || 1;

  // assign each BOM line to the first stage that consumes its role (else stage 0)
  const perStage = stages.map(() => []);
  (bom.lines || []).forEach(([rid, per]) => {
    const role = materialRole(rid);
    let si = stages.findIndex((s) => (s.roles || []).includes(role));
    if (si < 0) si = 0;
    perStage[si].push([rid, r2(per * qty / Y)]); // scale raws by overall yield
  });

  const plan = {};
  let prevWip = null;
  stages.forEach((s, i) => {
    const isLast = i === stages.length - 1;
    const consume = [];
    if (prevWip) consume.push([prevWip, r2(qty)]);   // previous WIP (nominal mass = qty)
    perStage[i].forEach((l) => consume.push(l));
    if (s.packDefaults) {
      PACK_DEFAULTS.forEach((p) => {
        if (!itemsById[p.id]) return;
        let q = p.per * qty;
        if (p.round) q = Math.max(p.min || 0, Math.round(q));
        q = r2(q);
        if (q > 0) consume.push([p.id, q]);
      });
    }
    const produceId = isLast ? fgId : wipId(fgId, s.wip);
    plan[s.key] = { consume, produce: [produceId, r2(qty)], wh: isLast ? "WH-FG" : "WH-WIP" };
    prevWip = isLast ? null : produceId;
  });
  return plan;
}

/* ---- movement builder for a single stage's posting ---- */
let _mvSeq = 0;
function mvId() { return "MV-" + Date.now().toString(36).toUpperCase() + "-" + (++_mvSeq).toString(36).toUpperCase(); }

function stageMovements(plan, stageKey, wo, itemsById, byWho, dateISO) {
  const st = plan[stageKey];
  if (!st) return [];
  const moves = [];
  st.consume.forEach(([rid, q]) => {
    if (!q) return;
    moves.push({ id: mvId(), date: dateISO, itemId: rid, wh: "WH-WIP", type: "ISSUE",
      qty: -Math.abs(q), rate: (itemsById[rid] || {}).cost || 0, ref: wo.id,
      note: "Stage " + stageKey + " → " + wo.itemId, by: byWho });
  });
  const [pid, pq] = st.produce;
  if (pq) {
    moves.push({ id: mvId(), date: dateISO, itemId: pid, wh: st.wh, type: "PROD",
      qty: Math.abs(pq), rate: (itemsById[pid] || {}).cost || 0, ref: wo.id,
      note: stageKey === "packing" ? "Finished goods (packed)" : "WIP output (" + stageKey + ")",
      by: byWho });
  }
  return moves;
}

/* ============================================================
   Route construction
   ============================================================ */
function freshRoute(wo) {
  const stages = templateFor(wo.itemId).stages;
  return stages.map((s, i) => ({
    key: s.key,
    name: s.name,
    area: s.area,
    seq: i + 1,
    status: "Pending",            // Pending | In Production | Completed
    posted: false,                // have this stage's stock movements been posted?
    startedBy: null, startedAt: null,
    doneBy: null, doneAt: null,
  }));
}

/* seed a route for a work order that predates the stage model */
function seedRouteFromLegacy(wo) {
  const route = freshRoute(wo);
  const s = String(wo.status || "").toLowerCase();
  const done = s === "completed" || s === "packed" || s === "dispatched";

  // a legacy WO on a slitting line is already past its first production stage
  let curIdx = String(wo.line || "").toLowerCase().includes("slit") ? Math.min(1, route.length - 1) : 0;

  route.forEach((r, i) => {
    if (done) {
      r.status = "Completed"; r.posted = true; r.doneBy = wo.updatedBy || "legacy"; r.doneAt = wo.updatedAt || wo.date;
    } else if (i < curIdx) {
      r.status = "Completed"; r.posted = true; r.doneBy = "legacy"; r.doneAt = wo.date;
    } else if (i === curIdx) {
      r.status = (s === "in progress" || s === "in production") ? "In Production" : "Pending";
      r.posted = true; // legacy stock for the active stage already accounted for by the seed
    } else {
      r.status = "Pending"; r.posted = false;
    }
  });

  return { route, stageIdx: done ? route.length - 1 : curIdx, legacy: true };
}

/* recompute the flat wo.status (for admin views / analytics) from the route */
function rollupStatus(wo) {
  if (wo.dispatched) return "Dispatched";
  const route = wo.route || [];
  if (!route.length) return wo.status || "Released";
  const allDone = route.every((r) => r.status === "Completed");
  if (allDone) return "Completed";
  const anyStarted = route.some((r) => r.status !== "Pending");
  return anyStarted ? "In Production" : "Released";
}

/* the stage a given area should act on next for this WO (or null) */
function stageForArea(route, area) {
  if (!route) return null;
  const active = route.find((r) => areaCovers(area, r.area) && r.status !== "Completed");
  if (active) return active;
  const owned = route.filter((r) => areaCovers(area, r.area));
  return owned.length ? owned[owned.length - 1] : null;
}

function currentStage(wo) {
  const route = wo.route || [];
  if (!route.length) return null;
  const idx = Math.min(Math.max(wo.stageIdx || 0, 0), route.length - 1);
  return route[idx];
}

/* order-spec (e.g. copper-wire count) for a work order, or null */
function specForWO(wo) {
  const sp = specForProduct(wo.itemId);
  if (!sp) return null;
  return { key: sp.key, label: sp.label, hint: sp.hint || null, value: wo[sp.key] == null ? null : wo[sp.key] };
}

/* ============================================================
   ensureStageModel(data) — idempotent migration (mutates `data`).
   1) create the WIP items each product's template needs (if missing)
   2) attach a route + stageIdx to every work order (if missing)
   Returns { changed:boolean }. Does NOT touch historical movements.
   ============================================================ */
function ensureStageModel(data) {
  let changed = false;
  data.items = data.items || [];
  data.workorders = data.workorders || [];
  const itemsById = indexBy(data.items, "id");
  const boms = data.boms || {};

  // 1) WIP items per product template
  Object.keys(boms).forEach((fgId) => {
    const fg = itemsById[fgId];
    if (!fg) return;
    const tpl = templateFor(fgId);
    const Y = boms[fgId].yield || 1;

    // material cost per role (per kg FG), then accumulate per stage for WIP valuation
    const roleCost = { base: 0, paste: 0, pack: 0 };
    (boms[fgId].lines || []).forEach(([rid, per]) => { roleCost[materialRole(rid)] += per * ((itemsById[rid] || {}).cost || 0); });
    const cumCost = {}; let cum = 0;
    tpl.stages.forEach((s) => { (s.roles || []).forEach((role) => { cum += roleCost[role] || 0; }); if (s.wip) cumCost[s.wip] = Math.round(cum / Y); });

    tpl.wips.forEach(([suf, label], k) => {
      const id = wipId(fgId, suf);
      if (itemsById[id]) return;
      const wipItem = {
        id, name: fg.name + " — " + label, cat: "WIP", uom: fg.uom || "KG",
        cost: cumCost[suf] || Math.round((fg.cost || 0) * (k + 1) / (tpl.wips.length + 1)),
        price: 0, reorder: 0, safety: 0, lead: 0, abc: "C",
        hsn: fg.hsn || "", supplierId: null, group: fg.group || null,
        stageOf: fgId, barcode: "",
      };
      data.items.push(wipItem);
      itemsById[id] = wipItem;
      changed = true;
    });
  });

  // 2) attach routes to work orders that don't have one
  data.workorders.forEach((wo) => {
    if (wo.route && wo.route.length) return;
    const seeded = seedRouteFromLegacy(wo);
    wo.route = seeded.route;
    wo.stageIdx = seeded.stageIdx;
    wo.legacy = seeded.legacy;
    wo.status = rollupStatus(wo);
    changed = true;
  });

  return { changed };
}

module.exports = {
  TEMPLATES, PRODUCT_TEMPLATE, FIBERGLASS_PRODUCTS, Y_SLIT, Y_PACK,
  wipId, templateKeyFor, templateFor, specForProduct, specForWO,
  materialRole, areaCovers,
  computeStagePlan, stageMovements,
  freshRoute, seedRouteFromLegacy, rollupStatus,
  stageForArea, currentStage, ensureStageModel,
};
