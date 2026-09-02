/* ============================================================
   CHHAPERIA ERP — BACKEND · role-based view service
   Decides WHAT DATA each role is allowed to receive. This is
   real, server-side enforcement: a supervisor's money/customer
   data never leaves the server, rather than being hidden in the
   browser. Admin/office get the full dataset; supervisors get a
   money-free, area-scoped production view only.
   ============================================================ */
"use strict";
const repo = require("../db/repository");
const { buildSeed } = require("../seed/seed");
const S = require("./stageService");
const LAB = require("./labService");
const GT = require("./grnTestService");
const BC = require("../../../frontend/js/bomcalc");

/* map a work order's free-text line to a production area */
function lineToArea(line) {
  const s = String(line || "").toLowerCase();
  if (s.includes("coat")) return "coating";
  if (s.includes("slit")) return "slitting";
  if (s.includes("fiber") || s.includes("glass") || s.includes("fg")) return "fiberglass";
  return "other";
}

async function fullState() {
  if (await repo.isEmpty()) await repo.saveState(buildSeed());
  return await repo.getState();
}

/* ---- ADMIN / OFFICE: full data (office could be trimmed later) ----
   One exception: the lab SPEC (the TDS min/max limits) is the yardstick a
   report is graded against, and the people entering reports must not be able
   to read it — otherwise a measured value can be tuned until it passes.
   Grading happens server-side, so office only needs to know WHETHER a spec
   exists, never what it says. Admin owns the spec editor and keeps the values.

   `specKeys` goes out to everyone: WHICH parameters a product is tested on is
   the shape of the report form, not a threshold anybody can grade against by
   eye — the numbers stay behind. */
function redactSpec(p) {
  return Object.assign({}, p, {
    spec: {},
    specSet: !!(p.spec && Object.keys(p.spec).length),
    specKeys: LAB.specKeys(p),
  });
}
/* The INCOMING-material yardstick is the same secret as the TDS spec above,
   only it lives on the stock item (`qcSpec`) rather than on a lab product. The
   parameter LIST travels — it is the shape of the entry form — while the limits
   stay behind, so a storekeeper's reading cannot be tuned until it passes.
   `qcSpecSet` lets a screen say "limits are set" without saying what they are. */
function redactItemQc(i) {
  if (!i || (i.qcSpec == null && i.qcParams == null)) return i;
  const out = Object.assign({}, i);
  delete out.qcSpec;
  out.qcSpecSet = GT.specKeys(i).length > 0;
  return out;
}
/* Which jobs still owe a measurement. Computed here, from the unredacted
   products, so every role reads the same list off one calculation. */
async function labPendingFor(d) {
  try { return await LAB.pendingLabWork(d); } catch { return []; }
}
async function grnTestPendingFor(d) {
  try { return await GT.pendingTests(d); } catch { return []; }
}

async function stateForOfficer(user) {
  const d = await fullState();
  const isAdmin = user && user.role === "admin";
  const pending = await labPendingFor(d);
  if (Array.isArray(d.labProducts)) {
    d.labProducts = isAdmin
      ? d.labProducts.map((p) => Object.assign({}, p, { specKeys: LAB.specKeys(p) }))
      : d.labProducts.map(redactSpec);
  }
  // admin owns the material master and keeps its limits; office sees only that
  // limits exist — it is office who books goods in against them
  if (!isAdmin && Array.isArray(d.items)) d.items = d.items.map(redactItemQc);
  d.labPending = pending;
  d.grnTestPending = await grnTestPendingFor(d);
  /* Failed lots waiting on the admin's ruling — approve the rejection and the
     lot is quarantined, decline it and it stands as good stock. Office sees the
     list too (it is their delivery and their debit note), but only admin may
     rule; the route enforces that. */
  try { d.grnQcDecisions = await GT.pendingDecisions(d); } catch { d.grnQcDecisions = []; }
  /* …and failed finished-goods certificates awaiting the same kind of ruling
     (a floor reading or the lab's own). Nothing is held by these; the batch
     has left the floor and the admin is told. */
  d.labQcDecisions = await labDecisionsFor(d);
  return d;
}
async function labDecisionsFor(d) {
  try { return await LAB.pendingLabDecisions(d); } catch { return []; }
}
async function grnDecisionsFor(d) {
  try { return await GT.pendingDecisions(d); } catch { return []; }
}
/* the lab is told WHICH batch failed, never which parameter or by how much */
const withoutFailed = (q) => { const o = Object.assign({}, q); delete o.failed; return o; };

/* ============================================================
   SUPERVISOR VIEW — money-free, area-scoped.
   Returns only:
     • org (name/logo) + the supervisor's area
     • work orders for their area, with what-to-make + status
     • the BOM/recipe (specs, quantities) for those products
     • raw-material & finished-goods QUANTITIES (no costs/values)
   Strips: prices, costs, customers, suppliers, sales, money.
   ============================================================ */
/* `opts.slim` drops `finishedProducts` — the product catalogue with a full
   per-unit recipe expanded for each of the 200-odd products. It is ~70% of
   this payload and it only feeds the occasional "Add to Finished Stock"
   picker, so the floor does not need it resent after every Start/Finish tap.
   Everything that a stage action can actually change is still included. */
async function stateForSupervisor(area, username, opts) {
  const d = await fullState();
  const itemById = Object.fromEntries(d.items.map((i) => [i.id, i]));
  const custById = Object.fromEntries((d.customers || []).map((c) => [c.id, c]));
  // the one label for a store, used by the job sheets and the stock feeds below
  const whNameById = Object.fromEntries((d.warehouses || []).map((w) => [w.id, w.name]));
  const whNameOf = (id) => whNameById[id] || id || "";
  // slitting team does packing → they may see the customer name (for labels) but NO money
  const showCustomer = area === "slitting" || area === "all";

  // resolve a customer name for a WO via an explicit link or a matching sales order
  function customerForWO(wo) {
    if (wo.customerId && custById[wo.customerId]) return custById[wo.customerId].name;
    if (wo.soId) { const so = (d.salesorders || []).find((s) => s.id === wo.soId); if (so && custById[so.customerId]) return custById[so.customerId].name; }
    // fall back: an open sales order that needs this product
    const so = (d.salesorders || []).find((s) => s.status !== "Dispatched" && (s.lines || []).some((l) => l.itemId === wo.itemId));
    return so && custById[so.customerId] ? custById[so.customerId].name : null;
  }

  // ensure every WO has a route, then keep those THIS area is involved in
  function routeOf(wo) {
    if (wo.route && wo.route.length) return wo.route;
    return S.seedRouteFromLegacy(wo).route;
  }
  /* Does this job belong on my board at all? A stage counts as mine when my
     area covers it AND (for an RM-production stage) I am the person who owns
     it — the two RM lines never see each other's jobs, while slitting and
     packing stay shared. */
  function isMyStage(r) {
    return S.areaCovers(area, r.area) && (!r.owner || r.owner === username);
  }
  function involved(route) {
    return area === "all" || route.some(isMyStage);
  }

  /* ---- WHERE the floor picks each material up ----------------------------
     A job draws from three different places — the store that took the
     delivery, the WIP floor, the finished bay — and the supervisor was told
     WHAT to draw but never WHERE from, so every job began with a walk round
     the stores. Each line now names its store.

     Two sources, in order: the ISSUE actually posted against this work order
     is a fact and wins; a material not yet issued (a pending balance) falls
     back to stageService.issuingWarehouse — the very rule the issue will use
     when it is posted, so the answer cannot contradict itself later. */
  const woIssuedFrom = {};   // woId -> { itemId -> [whId] }
  (d.movements || []).forEach((m) => {
    if (!m.ref || !m.wh || (+m.qty || 0) >= 0) return;
    const by = woIssuedFrom[m.ref] || (woIssuedFrom[m.ref] = {});
    const seen = by[m.itemId] || (by[m.itemId] = []);
    if (!seen.includes(m.wh)) seen.push(m.wh);
  });

  // materials THIS area needs for the WO's current stage (quantities only, no cost)
  function stageMaterials(wo, stage) {
    const plan = S.computeStagePlan(wo.itemId, wo.qty, d, wo.materialChoices, wo.plan);
    if (!plan || !plan[stage.key]) return [];
    const issued = woIssuedFrom[wo.id] || {};
    return plan[stage.key].consume.map(([rid, q]) => {
      const stores = (issued[rid] && issued[rid].length)
        ? issued[rid]
        : [S.issuingWarehouse(rid, itemById, d.movements)].filter(Boolean);
      return {
        id: rid, name: (itemById[rid] || {}).name || rid,
        uom: (itemById[rid] || {}).uom || "", required: q,
        // the store to fetch it from — id for the client, name to print
        wh: stores[0] || null,
        whName: stores.map((w) => whNameOf(w)).join(" · ") || null,
      };
    });
  }

  const myWOs = await Promise.all((d.workorders || [])
    .map((wo) => ({ wo, route: routeOf(wo) }))
    .filter(({ route }) => involved(route))
    .map(async ({ wo, route }) => {
      const it = itemById[wo.itemId] || {};
      const idx = Math.min(Math.max(wo.stageIdx || 0, 0), route.length - 1);
      const cur = route[idx];
      const myStage = S.stageForArea(route, area) || cur;
      /* An RM-production stage belongs to one person: it appears on their board
         only. Slitting and packing carry no owner, so every slitting and
         fibre-glass login keeps seeing them. */
      const ownedByMe = (st) => !st || !st.owner || st.owner === username;
      /* An order with a balance waiting on raw material is NOT finished, so it
         stays on the job list of every area that works it — flagged, with no
         action to take — until the office resumes the balance. */
      const partial = (+wo.pendingQty || 0) > 1e-6 && !wo.dispatched;
      const mine = area === "all"
        ? (cur.status !== "Completed" || !wo.dispatched)
        : ((S.areaCovers(area, cur.area) && cur.status !== "Completed" && ownedByMe(cur)) || partial);
      const myDone = area !== "all" && route.filter(isMyStage).every((r) => r.status === "Completed");
      return {
        id: wo.id, date: wo.date, due: wo.due, status: wo.status,
        progress: wo.progress, priority: wo.priority, line: wo.line,
        product: { id: wo.itemId, name: it.name, typeCode: it.typeCode || null,
          uom: it.uom, widthMM: it.widthMM || null },
        qty: wo.qty,
        /* the floor must be able to see that a job is only PART of the order:
           what is on the machine now, what is already made, and what is still
           waiting on raw material the office has to resume */
        runQty: wo.runQty != null ? wo.runQty : wo.qty,
        completedQty: +wo.completedQty || 0,
        pendingQty: +wo.pendingQty || 0,
        dispatchedQty: +wo.dispatchedQty || 0,
        /* Which sales order took the goods, and who it went to. The floor no
           longer dispatches, so this stamp — written by dispatchSalesOrder — is
           the only way the crew that packed a run learns it has gone. The order
           number is what they recognise it by. Neither field is money, so both
           are safe on this money-free view; the customer name is already shown
           to slitting for labelling. */
        dispatchedTo: wo.dispatchedTo || null,
        dispatchedCustomer: showCustomer ? (wo.dispatchedCustomer || null) : undefined,
        partial,
        widthMM: wo.widthMM != null ? wo.widthMM : null,   // the width this run is slit to
        // and the width of the roll going in — slitting needs both to know how
        // many tapes come off one roll and how much edge is left over
        matWidthMM: wo.matWidthMM != null ? wo.matWidthMM : null,
        customer: showCustomer ? customerForWO(wo) : undefined, // label info for slitting only
        updatedBy: wo.updatedBy || null, updatedAt: wo.updatedAt || null,
        // routing / stage hand-off
        route: route.map((r) => ({ key: r.key, name: r.name, area: r.area, seq: r.seq, status: r.status,
          owner: r.owner || null, line: r.line || null,
          doneBy: r.doneBy || null, doneAt: r.doneAt || null })),
        /* WHERE THE COATED ROLL WAS PUT DOWN — the store the coating floor
           named as it closed the stage. A LOCATION, not stock: nothing was
           booked in anywhere, so this is the only record of where the jumbo
           physically is, and slitting is sent to it rather than hunting.
           Null on a job with no coating stage, and on one coated before this
           was ever asked for. */
        wipAt: (() => {
          const st = route.find((r) => r.area === "coating" && r.outWh);
          if (!st) return null;
          return { wh: st.outWh, name: whNameOf(st.outWh), by: st.outWhBy || null, at: st.outWhAt || null };
        })(),
        // does this job pass through coating at all? decides whether a missing
        // location is worth saying anything about
        coated: route.some((r) => r.area === "coating"),
        stageIdx: idx,
        stage: { key: cur.key, name: cur.name, area: cur.area, seq: cur.seq, status: cur.status },
        myStageKey: myStage.key,
        spec: S.specForWO(wo, d),   // order spec (e.g. copper-wire count), or null
        /* QC for a coated batch: the parameters this product is tested on (no
           limits — the floor must not be able to grade its own reading by eye)
           and what has been measured so far. Null for a job that never touches
           the coating floor, so no other panel grows a lab form. */
        lab: LAB.hasCoatingStage({ route }) ? await (async () => {
          const st = await LAB.labStatusForWO(wo, d);
          return {
            batchNo: st.batchNo,
            product: st.product,
            params: st.params,
            values: st.prodValues,
            entered: st.prodComplete,
            labEntered: st.labComplete,
            missing: st.missingProd,
            // nothing in the lab master tests this product — no certificate is due
            required: !!(st.product && st.params.length),
          };
        })() : null,
        mine, myDone, dispatched: !!wo.dispatched,
        // recipe for THIS area's stage (quantities only)
        materials: stageMaterials(wo, myStage),
      };
    }));

  // stock QUANTITIES only (raw + finished), no valuation
  // WIP is not stocked any more (a stage hands its output straight to the next
  // stage), so the old WIP plumbing items are never shown
  const stock = d.items
    .filter((i) => ["RM", "FG", "PKG", "CON"].includes(i.cat))
    .map((i) => ({ id: i.id, name: i.name, cat: i.cat, uom: i.uom }));

  // finished-goods products that can be produced on the floor (have a BOM), each
  // with a per-unit recipe so the "Add to Finished Stock" form can preview what
  // will be consumed. No costs/prices — quantities only.
  const boms = d.boms || {};
  /* The floor's form picks a product and then a THICKNESS, and can book either
     a finished good or a half-made (WORK IN PROCESS) roll — so the payload
     carries the size fields that picker needs, and the WIP items alongside the
     finished ones. A WIP roll has no recipe of its own: it draws on its
     parent's, and only on what the coating stage consumes. */
  const perUnitRecipe = (owner, roleFilter) => {
    const bom = boms[owner.id];
    if (!bom) return [];
    const Y = bom.yield || 1;
    // Lines may be legacy [id, qty] tuples OR rich objects from the real
    // BOM import — toLegacy() flattens both to [id, perUnitOfFG].
    return BC.toLegacy(bom, BC.metaFromItem(owner), null, itemById)
      .filter(([rid]) => (roleFilter ? roleFilter(rid) : true))
      .map(([rid, per]) => ({
        id: rid, name: (itemById[rid] || {}).name || rid,
        uom: (itemById[rid] || {}).uom || "", perUnit: per / Y,
      }));
  };
  const sizeOf = (i) => ({
    typeCode: i.typeCode || null,
    productName: i.productName || i.name || i.id,
    thicknessMM: i.thicknessMM != null ? i.thicknessMM : null,
    gsm: i.gsm != null ? i.gsm : null,
    tapeWidthMM: i.tapeWidthMM != null ? i.tapeWidthMM : null,
  });
  const slim = !!(opts && opts.slim);
  const producibleFg = slim ? [] : d.items
    .filter((i) => i.cat === "FG" && boms[i.id] && (boms[i.id].lines || []).length);
  const fgProducts = producibleFg.map((i) => Object.assign(
    { id: i.id, name: i.name, cat: "FG", uom: i.uom || "KG", recipe: perUnitRecipe(i) },
    sizeOf(i),
  ));
  const fgById = Object.fromEntries(producibleFg.map((i) => [i.id, i]));
  const wipProducts = d.items
    .filter((i) => i.cat === "WIP" && i.stageOf && fgById[i.stageOf])
    .map((i) => {
      const parent = fgById[i.stageOf];
      return Object.assign(
        { id: i.id, name: i.name, cat: "WIP", uom: i.uom || "KG", stageOf: i.stageOf,
          recipe: perUnitRecipe(parent, (rid) => ["base", "paste"].includes(S.materialRole(rid))) },
        sizeOf(parent),
        // a half-made roll keeps its own thickness when it has one
        i.thicknessMM != null ? { thicknessMM: i.thicknessMM } : {},
        { tapeWidthMM: null },
      );
    });
  const finishedProducts = fgProducts.concat(wipProducts);
  // warehouses the finished stock can be stored in (id/name/type/city, no locations detail)
  const warehouses = (d.warehouses || []).map((w) => ({ id: w.id, name: w.name, type: w.type || null, city: w.city || null }));

  // on-hand per (item, warehouse), from movements — quantities only, never costs
  const RAW = new Set(["RM", "PKG", "CON"]);
  const onHand = {}; // itemId -> { whId -> qty }
  (d.movements || []).forEach((m) => {
    const it = itemById[m.itemId];
    if (!it || !m.wh) return;
    (onHand[m.itemId] || (onHand[m.itemId] = {}));
    onHand[m.itemId][m.wh] = (onHand[m.itemId][m.wh] || 0) + (+m.qty || 0);
  });
  // raw materials only — lets the floor pick, when reporting excess,
  // only the store(s) that actually hold the chosen material
  const materialStock = {}; // itemId -> [{ wh, name, qty }] (only stores with stock, most first)
  Object.keys(onHand).forEach((iid) => {
    if (!RAW.has((itemById[iid] || {}).cat)) return;
    const rows = Object.keys(onHand[iid])
      .map((wh) => ({ wh, name: whNameOf(wh), qty: Math.round(onHand[iid][wh] * 100) / 100 }))
      .filter((r) => r.qty > 0.0001)
      .sort((a, b) => b.qty - a.qty);
    if (rows.length) materialStock[iid] = rows;
  });

  // everything each warehouse holds (all categories) — feeds the supervisor's
  // view-only Warehouses page. Quantities only, no valuation.
  const warehouseStock = {}; // whId -> [{ id, name, cat, uom, qty }] (biggest first)
  Object.keys(onHand).forEach((iid) => {
    const it = itemById[iid] || {};
    Object.keys(onHand[iid]).forEach((wh) => {
      const qty = Math.round(onHand[iid][wh] * 100) / 100;
      if (qty <= 0.0001) return;
      (warehouseStock[wh] || (warehouseStock[wh] = [])).push({
        id: iid, name: it.name || iid, cat: it.cat || "", uom: it.uom || "", qty,
      });
    });
  });
  Object.values(warehouseStock).forEach((rows) => rows.sort((a, b) => b.qty - a.qty));

  return {
    role: "supervisor",
    area,
    org: { name: d.org.name, short: d.org.short, group: d.org.group },
    workorders: myWOs,
    stockItems: stock,           // names/uom only; live qty comes from /production/stock if needed
    // omitted entirely on a slim refresh — the client keeps the copy it has
    ...(slim ? {} : { finishedProducts }), // producible FGs + per-unit recipe (Add to Finished Stock)
    slim,                        // so the client knows not to overwrite what it cached
    warehouses,                  // storage choices for finished stock
    materialStock,               // itemId -> stores that hold it (for the excess-material form)
    warehouseStock,              // whId -> everything it holds (view-only Warehouses page)
    settings: d.settings || {},
    generatedAt: new Date().toISOString(),
  };
}

/* ============================================================
   LAB VIEW — QC incharge.
   Sees stock, production, BOMs and the trade documents needed to
   trace a batch, plus the lab module. Deliberately built as an
   ALLOWLIST: a role that simply fell through to the full dataset
   would receive payroll, CRM and every cost in the business
   (which is exactly how an earlier "sales desk" role leaked the
   whole database while the UI merely hid its menus).
   Excluded: HR/payroll, CRM leads, transporters, and the lab spec
   limits themselves — grading is server-side, so the person
   entering measurements must not see the thresholds.
   ============================================================ */
async function stateForLab() {
  const d = await fullState();
  return {
    role: "lab",
    org: d.org,
    settings: d.settings || {},
    warehouses: d.warehouses || [],
    categories: d.categories || [],
    // the incoming-test limits are withheld here for the same reason the TDS
    // spec is: this is the role that takes the readings
    items: (d.items || []).map(redactItemQc),
    boms: d.boms || {},
    movements: d.movements || [],
    workorders: d.workorders || [],
    purchaseorders: d.purchaseorders || [],
    salesorders: d.salesorders || [],
    suppliers: d.suppliers || [],
    customers: d.customers || [],          // sales orders reference them by id
    /* GOODS RECEIPTS — the incharge tests what arrived, so the receipt that
       booked it in is part of the job, not procurement's private business. The
       receipt is a quantity-and-document record; the money on a purchase order
       is already in this payload (the order itself is), so nothing new is
       exposed by naming which delivery a reading belongs to. */
    grns: d.grns || [],
    /* Their own filed readings, with the VERDICT removed — same rule as
       labReports below. `complete` is not a grade (it only says whether the
       measuring is finished) so it stays, which is what drives the worklist. */
    grnTests: (d.grnTests || []).map((t) => {
      const out = Object.assign({}, t);
      ["result", "results"].forEach((k) => { delete out[k]; });
      return out;
    }),
    grnTestPending: await grnTestPendingFor(d),
    labProducts: (d.labProducts || []).map(redactSpec),
    /* The person taking the measurements is never shown the VERDICT either —
       the same reason the spec limits are withheld from them. A reading whose
       Pass/Fail is visible can be nudged until it passes, and the grade adds
       nothing to the job of measuring. Grading stays server-side; the office
       reads the result. `prodComplete` / `labComplete` are not grades — they
       only say whether a stage has finished measuring — so they stay. */
    labReports: (d.labReports || []).map((r) => {
      const out = Object.assign({}, r);
      /* The one batch-level fact that DOES reach the incharge (since
         2026-09-02): that a certificate is flagged for the admin's ruling. It
         names no parameter and no limit — enough to open the certificate and
         to know the office has been told, not enough to nudge a reading. */
      out.attention = LAB.attentionOf(r);
      ["result", "results", "prodResult", "prodResults", "labResult", "labResults"]
        .forEach((k) => { delete out[k]; });
      return out;
    }),
    // the incharge's own worklist: every job still owing a reading
    labPending: await labPendingFor(d),
    /* Failed batches and failed incoming lots waiting on the admin — the lab
       is told WHICH, never which parameter or by how much. Ruling stays
       admin's alone; the routes enforce that. */
    labQcDecisions: (await labDecisionsFor(d)).map(withoutFailed),
    grnQcDecisions: (await grnDecisionsFor(d)).map(withoutFailed),
    generatedAt: new Date().toISOString(),
  };
}

/** Top-level dispatcher by user. */
async function stateForUser(user, opts) {
  if (!user) { const e = new Error("Not authenticated"); e.status = 401; throw e; }
  if (user.role === "supervisor") return await stateForSupervisor(user.area || "all", user.username, opts);
  if (user.role === "lab") return await stateForLab();
  return await stateForOfficer(user); // admin + office (office gets no lab spec values)
}

module.exports = { stateForUser, stateForSupervisor, stateForOfficer, stateForLab, lineToArea };
