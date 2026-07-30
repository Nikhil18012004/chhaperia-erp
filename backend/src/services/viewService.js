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
const BC = require("../../../frontend/js/bomcalc");

/* map a work order's free-text line to a production area */
function lineToArea(line) {
  const s = String(line || "").toLowerCase();
  if (s.includes("coat")) return "coating";
  if (s.includes("slit")) return "slitting";
  if (s.includes("fiber") || s.includes("glass") || s.includes("fg")) return "fiberglass";
  return "other";
}

function fullState() {
  if (repo.isEmpty()) repo.saveState(buildSeed());
  return repo.getState();
}

/* ---- ADMIN / OFFICE: full data (office could be trimmed later) ----
   One exception: the lab SPEC (the TDS min/max limits) is the yardstick a
   report is graded against, and the people entering reports must not be able
   to read it — otherwise a measured value can be tuned until it passes.
   Grading happens server-side, so office only needs to know WHETHER a spec
   exists, never what it says. Admin owns the spec editor and keeps the values. */
function stateForOfficer(user) {
  const d = fullState();
  const isAdmin = user && user.role === "admin";
  if (!isAdmin && Array.isArray(d.labProducts)) {
    d.labProducts = d.labProducts.map((p) => Object.assign({}, p, {
      spec: {},
      specSet: !!(p.spec && Object.keys(p.spec).length),
    }));
  }
  return d;
}

/* ============================================================
   SUPERVISOR VIEW — money-free, area-scoped.
   Returns only:
     • org (name/logo) + the supervisor's area
     • work orders for their area, with what-to-make + status
     • the BOM/recipe (specs, quantities) for those products
     • raw-material & finished-goods QUANTITIES (no costs/values)
   Strips: prices, costs, customers, suppliers, sales, money.
   ============================================================ */
function stateForSupervisor(area, username) {
  const d = fullState();
  const itemById = Object.fromEntries(d.items.map((i) => [i.id, i]));
  const custById = Object.fromEntries((d.customers || []).map((c) => [c.id, c]));
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

  // materials THIS area needs for the WO's current stage (quantities only, no cost)
  function stageMaterials(wo, stage) {
    const plan = S.computeStagePlan(wo.itemId, wo.qty, d, wo.materialChoices);
    if (!plan || !plan[stage.key]) return [];
    return plan[stage.key].consume.map(([rid, q]) => ({
      id: rid, name: (itemById[rid] || {}).name || rid,
      uom: (itemById[rid] || {}).uom || "", required: q,
    }));
  }

  const myWOs = (d.workorders || [])
    .map((wo) => ({ wo, route: routeOf(wo) }))
    .filter(({ route }) => involved(route))
    .map(({ wo, route }) => {
      const it = itemById[wo.itemId] || {};
      const idx = Math.min(Math.max(wo.stageIdx || 0, 0), route.length - 1);
      const cur = route[idx];
      const myStage = S.stageForArea(route, area) || cur;
      /* An RM-production stage belongs to one person: it appears on their board
         only. Slitting and packing carry no owner, so every slitting and
         fibre-glass login keeps seeing them. */
      const ownedByMe = (st) => !st || !st.owner || st.owner === username;
      const mine = area === "all"
        ? (cur.status !== "Completed" || !wo.dispatched)
        : (S.areaCovers(area, cur.area) && cur.status !== "Completed" && ownedByMe(cur));
      const myDone = area !== "all" && route.filter(isMyStage).every((r) => r.status === "Completed");
      return {
        id: wo.id, date: wo.date, due: wo.due, status: wo.status,
        progress: wo.progress, priority: wo.priority, line: wo.line,
        product: { id: wo.itemId, name: it.name, typeCode: it.typeCode || null,
          uom: it.uom, widthMM: it.widthMM || null },
        qty: wo.qty,
        widthMM: wo.widthMM != null ? wo.widthMM : null,   // the width this run is slit to
        customer: showCustomer ? customerForWO(wo) : undefined, // label info for slitting only
        updatedBy: wo.updatedBy || null, updatedAt: wo.updatedAt || null,
        // routing / stage hand-off
        route: route.map((r) => ({ key: r.key, name: r.name, area: r.area, seq: r.seq, status: r.status,
          owner: r.owner || null, line: r.line || null,
          doneBy: r.doneBy || null, doneAt: r.doneAt || null })),
        stageIdx: idx,
        stage: { key: cur.key, name: cur.name, area: cur.area, seq: cur.seq, status: cur.status },
        myStageKey: myStage.key,
        spec: S.specForWO(wo, d),   // order spec (e.g. copper-wire count), or null
        mine, myDone, dispatched: !!wo.dispatched,
        // recipe for THIS area's stage (quantities only)
        materials: stageMaterials(wo, myStage),
      };
    });

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
  const finishedProducts = d.items
    .filter((i) => i.cat === "FG" && boms[i.id] && (boms[i.id].lines || []).length)
    .map((i) => {
      const bom = boms[i.id];
      const Y = bom.yield || 1;
      return {
        id: i.id, name: i.name, uom: i.uom || "KG",
        // Lines may be legacy [id, qty] tuples OR rich objects from the real
        // BOM import — toLegacy() flattens both to [id, perUnitOfFG].
        recipe: BC.toLegacy(bom, BC.metaFromItem(i)).map(([rid, per]) => ({
          id: rid, name: (itemById[rid] || {}).name || rid,
          uom: (itemById[rid] || {}).uom || "", perUnit: per / Y,
        })),
      };
    });
  // warehouses the finished stock can be stored in (id/name/type/city, no locations detail)
  const warehouses = (d.warehouses || []).map((w) => ({ id: w.id, name: w.name, type: w.type || null, city: w.city || null }));

  // on-hand per (item, warehouse), from movements — quantities only, never costs
  const RAW = new Set(["RM", "PKG", "CON"]);
  const whName = Object.fromEntries((d.warehouses || []).map((w) => [w.id, w.name]));
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
      .map((wh) => ({ wh, name: whName[wh] || wh, qty: Math.round(onHand[iid][wh] * 100) / 100 }))
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
    finishedProducts,            // producible FGs + per-unit recipe (for Add to Finished Stock)
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
function stateForLab() {
  const d = fullState();
  return {
    role: "lab",
    org: d.org,
    settings: d.settings || {},
    warehouses: d.warehouses || [],
    categories: d.categories || [],
    items: d.items || [],
    boms: d.boms || {},
    movements: d.movements || [],
    workorders: d.workorders || [],
    purchaseorders: d.purchaseorders || [],
    salesorders: d.salesorders || [],
    suppliers: d.suppliers || [],
    customers: d.customers || [],          // sales orders reference them by id
    labProducts: (d.labProducts || []).map((p) => Object.assign({}, p, {
      spec: {}, specSet: !!(p.spec && Object.keys(p.spec).length),
    })),
    labReports: d.labReports || [],
    generatedAt: new Date().toISOString(),
  };
}

/** Top-level dispatcher by user. */
function stateForUser(user) {
  if (!user) { const e = new Error("Not authenticated"); e.status = 401; throw e; }
  if (user.role === "supervisor") return stateForSupervisor(user.area || "all", user.username);
  if (user.role === "lab") return stateForLab();
  return stateForOfficer(user); // admin + office (office gets no lab spec values)
}

module.exports = { stateForUser, stateForSupervisor, stateForOfficer, stateForLab, lineToArea };
