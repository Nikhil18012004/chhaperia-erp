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
   • slitfirst (any product whose BOM has a SINGLE raw material):
                Slitting → Packing — there is nothing to laminate, so the
                job skips coating and the one material is issued at slitting.
                Picked automatically from the BOM, see templateKeyFor().
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

   Stock effects are deliberately one-way. Each stage ISSUES the raw
   materials it consumes from the store that holds them, and NOTHING is
   ever received back — not after coating, not after slitting, not after
   packing. The goods travel from stage to stage and out of the door
   without being booked into any store, so no work-in-process or
   finished-goods receipt appears in stock, in the item master or in a
   report. (Finished stock is created only by the explicit "Add to
   Finished Stock" action.) Per-stage recipes are DERIVED from the single
   BOM by classifying each material's role (base / paste / pack), so it
   works on the current data with no manual authoring.

   `ensureStageModel` is an idempotent migration: it attaches a route
   to every work order WITHOUT wiping data.
   Legacy work orders are flagged so advancing them hands off between
   panels but does NOT re-post stock the old flow already booked;
   brand-new work orders get the full per-stage posting.
   ============================================================ */
"use strict";
const BC = require("../../../frontend/js/bomcalc");

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

/* ============================================================
   PROCESS TEMPLATES
   Each stage lists the material ROLES it consumes (base = the
   physical carrier/weave; paste = coating/impregnation chemistry;
   pack = cores/packaging). No stage produces stock — every stage
   hands its output to the next one (and the last one to dispatch)
   without booking anything in.
   ============================================================ */
/* ============================================================
   WHO PRODUCES WHAT
   The two RM-production people own different product families; anything not
   listed is bought in ready-made and only slit, packed and dispatched here.
   Matched on the product's type code (family), longest pattern first.
   ============================================================ */
const OWNERS = {
  gautam: { user: "coating1", area: "coating", line: "RM Production 1",
            label: "RM Production — Gautam Saw", person: "Gautam Saw" },
  ganesh: { user: "coating2", area: "coating", line: "RM Production 2",
            label: "RM Production 2 — Ganesh", person: "Ganesh" },
  fibre:  { user: "fiberglass", area: "fiberglass", line: "Fibre-Glass Line 1",
            label: "Fibre-Glass Production", person: "Fibre-glass team" },
};
/* Ganesh: the woven semi-conductive family, the copper-woven tape, and the
   listed coated tapes. Gautam: every other water-blocking tape. */
const GANESH_FAMILIES = [
  "CHN-", "CHSCWWBT", "CHCWSCWBT",                       // woven semi-conductive + copper woven
  "CP25GE", "CCM25GE",                                   // inorganic mica tapes
  "CH-LSZH", "CH-FSZH", "CH-FGT", "CH-ALPET", "CH-ALPFT", // LSZH / FSZH / FGT / alu laminates
  "CH-CUPET", "CH-PFGT", "CH-NW-B", "CH-PT", "CH-CT",
  "CH-RCT", "CH-RPST", "CH-BCT",
];
/* products whose base is woven by the fibre-glass team before Ganesh coats it */
const FIBRE_FIRST = ["CHCWSCWBT"];

function famOf(fgId, data) {
  const it = ((data || {}).items || []).find((i) => i && i.id === fgId) || {};
  return String(it.typeCode || fgId || "").toUpperCase().trim();
}
/* A family pattern matches the whole family or a family followed by a
   separator — so "CH-PT" catches CH-PT-12 but never CH-PTFE. */
function famMatches(fam, pattern) {
  const p = pattern.toUpperCase();
  if (fam === p) return true;
  if (fam.indexOf(p) !== 0) return false;
  if (/[^A-Z0-9]$/.test(p)) return true;        // pattern already ends at a boundary ("CHN-")
  const next = fam.charAt(p.length);
  return next === "" || /[^A-Z0-9]/.test(next); // "CH-PT" matches CH-PT-12, not CH-PTFE
}
/** Who makes this product in-house — or null when it is bought in ready-made. */
function productOwner(fgId, data) {
  const fam = famOf(fgId, data);
  const it = ((data || {}).items || []).find((i) => i && i.id === fgId) || {};
  const hit = (list) => list.some((p) => famMatches(fam, p));
  if (hit(GANESH_FAMILIES)) return OWNERS.ganesh;
  // everything else in the water-blocking series is Gautam's
  if (String(it.group || "").toUpperCase().indexOf("WATER BLOCKING") === 0) return OWNERS.gautam;
  return null;                                    // bought in — slit & pack only
}
const needsFibreFirst = (fgId, data) => FIBRE_FIRST.some((p) => famMatches(famOf(fgId, data), p));

/* ---- the stages a route can be built from ---- */
const STAGE = {
  rm: (owner) => ({ key: "rmprod", name: owner.label, area: owner.area,
                    owner: owner.user, line: owner.line, roles: ["base", "paste"] }),
  weave: () => ({ key: "weaving", name: "Copper-Wire Weaving", area: "fiberglass",
                  owner: OWNERS.fibre.user, line: OWNERS.fibre.line, roles: ["base"] }),
  slit:  (all) => ({ key: "slitting", name: "Slitting", area: "slitting",
                     roles: all ? ["base", "paste", "pack"] : ["pack"] }),
  pack:  () => ({ key: "packing", name: "Packing & Dispatch", area: "slitting",
                  roles: [], packDefaults: true }),
};

/* per-order production spec, by family */
const SPEC_BY_FAMILY = {
  CHCWSCWBT: { key: "copperWires", label: "Copper wires (per tape)", hint: "as per order" },
};

/* how many raw materials the product's recipe actually consumes */
function bomMaterialCount(fgId, data) {
  const bom = ((data || {}).boms || {})[fgId];
  if (!bom) return 0;
  const fg = ((data || {}).items || []).find((i) => i && i.id === fgId) || {};
  try { return BC.toLegacy(bom, BC.metaFromItem(fg)).length; }
  catch { return (bom.lines || []).length; }
}

/** What the recipe needs for `qty`, and how much of it the store holds. */
function materialCheck(fgId, qty, data, choices) {
  const bom = ((data || {}).boms || {})[fgId];
  const out = { need: [], short: [], ok: true };
  if (!bom) return out;
  const fg = ((data || {}).items || []).find((i) => i && i.id === fgId) || {};
  const onHand = {};
  ((data || {}).movements || []).forEach((m) => { onHand[m.itemId] = (onHand[m.itemId] || 0) + (+m.qty || 0); });
  const Y = bom.yield || 1;
  const need = {};
  BC.toLegacy(bom, BC.metaFromItem(fg), choices || {}).forEach(([rid, per]) => {
    need[rid] = (need[rid] || 0) + (per * (+qty || 0)) / Y;
  });
  Object.keys(need).forEach((rid) => {
    const have = +(onHand[rid] || 0);
    const row = { id: rid, need: r2(need[rid]), have: r2(have) };
    out.need.push(row);
    if (have + 1e-6 < need[rid]) { out.short.push(row); out.ok = false; }
  });
  return out;
}

/* ============================================================
   ROUTE SELECTION
   A work order looks at the store FIRST: if the material this product is made
   from is already there in the quantity needed, the job starts at SLITTING.
   If it is not, the job starts at the RM PRODUCTION stage of whoever makes
   that product (and, for the copper-woven tape, at fibre-glass weaving before
   it) so the material gets produced first. A bought-in product has no
   production stage — it can only be slit once the goods are in.
   ============================================================ */
function routeStagesFor(fgId, data, opts) {
  opts = opts || {};
  const owner = productOwner(fgId, data);
  const chk = materialCheck(fgId, opts.qty, data, opts.materialChoices);
  const haveMaterial = chk.ok;                       // no BOM => nothing to miss
  if (haveMaterial || !owner) return [STAGE.slit(true), STAGE.pack()];
  const stages = [];
  if (needsFibreFirst(fgId, data)) stages.push(STAGE.weave());
  stages.push(STAGE.rm(owner));
  stages.push(STAGE.slit(false), STAGE.pack());
  return stages;
}
function templateFor(fgId, data, opts) { return { stages: routeStagesFor(fgId, data, opts) }; }
function templateKeyFor(fgId, data, opts) {
  return routeStagesFor(fgId, data, opts).map((s) => s.key).join(">");
}
function specForProduct(fgId, data) {
  const fam = famOf(fgId, data);
  const key = Object.keys(SPEC_BY_FAMILY).find((p) => famMatches(fam, p));
  return key ? SPEC_BY_FAMILY[key] : null;
}

/* The lines each area runs. A work order's line must belong to the area that
   STARTS its route, so a job that skips coating never sits on a coating line. */
const LINES_BY_AREA = {
  coating:    ["RM Production 1", "RM Production 2"],
  slitting:   ["Slitting A", "Slitting B"],
  fiberglass: ["Fibre-Glass Line 1", "Fibre-Glass Line 2"],
};
function startArea(fgId, data, opts) {
  const first = (routeStagesFor(fgId, data, opts) || [])[0] || {};
  return first.area || "slitting";
}
/* keep `wanted` when it is a line of the right area, else pick deterministically */
function lineForProduct(fgId, data, wanted, opts) {
  const stages = routeStagesFor(fgId, data, opts);
  const first = stages[0] || {};
  if (first.line) return first.line;                 // the owner's own line
  const pool = LINES_BY_AREA[first.area || "slitting"] || LINES_BY_AREA.slitting;
  if (wanted && pool.indexOf(wanted) >= 0) return wanted;
  const hash = Array.from(String(fgId || "")).reduce((n, c) => n + c.charCodeAt(0), 0);
  return pool[hash % pool.length];
}

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
   Each stage consumes only its own role materials; nothing is carried
   between stages as stock and no stage produces stock. Returns null (no
   BOM).
   ============================================================ */
/* `choices` maps a ranged BOM line index -> the stock item actually chosen
   for this work order (see BOMCALC.candidatesFor / resolve). */
function computeStagePlan(fgId, qty, data, choices) {
  const bom = (data.boms || {})[fgId];
  if (!bom) return null;
  const itemsById = indexBy(data.items || [], "id");
  const tpl = { stages: routeStagesFor(fgId, data, { qty, materialChoices: choices }) };
  const stages = tpl.stages;
  const Y = bom.yield || 1;

  // assign each BOM line to the first stage that consumes its role (else stage 0)
  const perStage = stages.map(() => []);
  // toLegacy() accepts both the legacy [id, qty] tuple and the rich object
  // form the real BOM import produces, so neither shape can reach the
  // array-destructuring below unconverted.
  BC.toLegacy(bom, BC.metaFromItem(itemsById[fgId]), choices).forEach(([rid, per]) => {
    const role = materialRole(rid);
    let si = stages.findIndex((s) => (s.roles || []).includes(role));
    if (si < 0) si = 0;
    perStage[si].push([rid, r2(per * qty / Y)]); // scale raws by overall yield
  });

  const plan = {};
  stages.forEach((s, i) => {
    const isLast = i === stages.length - 1;
    const consume = [];
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
    /* NO stage output is stocked — not coating, not slitting, not packing. Each
       stage only ISSUES what it consumes; the goods move from stage to stage and
       out of the door without ever being booked into a store. (Finished stock is
       only ever created by the explicit "Add to Finished Stock" action.) */
    plan[s.key] = { consume, produce: null, wh: null, last: isLast };
  });
  return plan;
}

/* ---- movement builder for a single stage's posting ---- */
let _mvSeq = 0;
function mvId() { return "MV-" + Date.now().toString(36).toUpperCase() + "-" + (++_mvSeq).toString(36).toUpperCase(); }

function stageMovements(plan, stageKey, wo, itemsById, byWho, dateISO, movements) {
  const st = plan[stageKey];
  if (!st) return [];
  /* Raw materials are issued FROM THE WAREHOUSE THAT HOLDS THEM (whichever
     store they were received into) — issuing everything against one warehouse
     hid the deduction from the store's warehouse view. */
  const whFor = (rid) => {
    const it = itemsById[rid] || {};
    if (it.cat === "WIP" || /^WIP-/.test(rid)) return "WH-WIP";
    const byWh = {};
    (movements || []).forEach((m) => { if (m.itemId === rid) byWh[m.wh] = (byWh[m.wh] || 0) + (+m.qty || 0); });
    let best = null;
    Object.entries(byWh).forEach(([wh, q]) => { if (best == null || q > byWh[best]) best = wh; });
    return best || "WH-PNY";
  };
  const moves = [];
  st.consume.forEach(([rid, q]) => {
    if (!q) return;
    moves.push({ id: mvId(), date: dateISO, itemId: rid, wh: whFor(rid), type: "ISSUE",
      qty: -Math.abs(q), rate: (itemsById[rid] || {}).cost || 0, ref: wo.id,
      note: "Stage " + stageKey + " → " + wo.itemId, by: byWho });
  });
  /* No receipt is posted for any stage — see computeStagePlan(). A stage's
     output is not stock, so completing coating, slitting or packing books
     nothing in. */
  return moves;
}

/* ============================================================
   Route construction
   ============================================================ */
function freshRoute(wo, data) {
  const stages = routeStagesFor(wo.itemId, data, { qty: wo.qty, materialChoices: wo.materialChoices });
  return stages.map((s, i) => ({
    key: s.key,
    name: s.name,
    area: s.area,
    owner: s.owner || null,       // only this person's board shows the stage
    line: s.line || null,
    seq: i + 1,
    status: "Pending",            // Pending | In Production | Completed
    posted: false,                // have this stage's stock movements been posted?
    startedBy: null, startedAt: null,
    doneBy: null, doneAt: null,
  }));
}

/* seed a route for a work order that predates the stage model */
function seedRouteFromLegacy(wo, data) {
  const route = freshRoute(wo, data);
  const s = String(wo.status || "").toLowerCase();
  const done = s === "completed" || s === "packed" || s === "dispatched";

  // a legacy WO on a slitting line is already past its first production stage
  const startsAtCoating = route.length > 0 && route[0].area === "coating";
  let curIdx = (startsAtCoating && String(wo.line || "").toLowerCase().includes("slit"))
    ? Math.min(1, route.length - 1) : 0;

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

/* route-derived completion % (Completed = 1, In Production = 0.5 of a stage).
   Single source of truth for progress — productionService delegates here so
   the stored wo.progress can never drift from the route. */
function calcProgress(route) {
  if (!route || !route.length) return 0;
  let p = 0;
  route.forEach((r) => { if (r.status === "Completed") p += 1; else if (r.status === "In Production") p += 0.5; });
  return Math.round((p / route.length) * 100);
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
function specForWO(wo, data) {
  const sp = specForProduct(wo.itemId, data);
  if (!sp) return null;
  return { key: sp.key, label: sp.label, hint: sp.hint || null, value: wo[sp.key] == null ? null : wo[sp.key] };
}

/* ============================================================
   ensureStageModel(data) — idempotent migration (mutates `data`).
   Attaches a route + stageIdx to every work order (if missing) and keeps the
   flat status/progress fields honest. No WIP items are created: an unfinished
   stage's output is never stocked, it is handed straight to the next stage.
   Returns { changed:boolean }. Does NOT touch historical movements.
   ============================================================ */
function ensureStageModel(data) {
  let changed = false;
  data.items = data.items || [];
  data.workorders = data.workorders || [];

  // attach routes to work orders that don't have one, and reconcile the
  //    flat status + progress fields against the route for EVERY work order.
  //    (Seed data set progress to a random value independent of the route, so
  //    without this the Production board's progress bar disagreed with its
  //    stage dots. Runs idempotently on every boot → self-heals old data.)
  data.workorders.forEach((wo) => {
    if (!wo.route || !wo.route.length) {
      const seeded = seedRouteFromLegacy(wo, data);
      wo.route = seeded.route;
      wo.stageIdx = seeded.stageIdx;
      wo.legacy = seeded.legacy;
      changed = true;
    } else if (!wo.legacy) {
      // the product's route may have changed (e.g. its BOM is down to a single
      // material, so it now skips coating). Re-route only while NOTHING has
      // started — a job in flight keeps the route it was planned with.
      const untouched = wo.route.every((r) => r.status === "Pending" && !r.posted);
      const want = routeStagesFor(wo.itemId, data,
        { qty: wo.qty, materialChoices: wo.materialChoices }).map((s) => s.key).join(">");
      if (untouched && wo.route.map((r) => r.key).join(">") !== want) {
        wo.route = freshRoute(wo, data);
        wo.stageIdx = 0;
        // the line has to follow the route to the area that now starts the job
        const line = lineForProduct(wo.itemId, data, wo.line);
        if (line !== wo.line) wo.line = line;
        changed = true;
      }
    }
    const status = rollupStatus(wo);
    const progress = calcProgress(wo.route);
    if (wo.status !== status) { wo.status = status; changed = true; }
    if (wo.progress !== progress) { wo.progress = progress; changed = true; }
  });

  return { changed };
}

module.exports = {
  OWNERS_BY_KEY: OWNERS, Y_SLIT, Y_PACK,
  templateKeyFor, templateFor, specForProduct, specForWO, bomMaterialCount,
  LINES_BY_AREA, startArea, lineForProduct, OWNERS, productOwner, materialCheck, routeStagesFor,
  materialRole, areaCovers,
  computeStagePlan, stageMovements,
  freshRoute, seedRouteFromLegacy, rollupStatus, calcProgress,
  stageForArea, currentStage, ensureStageModel,
};
