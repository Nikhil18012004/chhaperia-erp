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

/* ---- ADMIN / OFFICE: full data (office could be trimmed later) ---- */
function stateForOfficer() {
  return fullState();
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
function stateForSupervisor(area) {
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

  // work orders in this supervisor's area (open/active first)
  const myWOs = (d.workorders || [])
    .filter((wo) => area === "all" ? true : lineToArea(wo.line) === area)
    .map((wo) => {
      const it = itemById[wo.itemId] || {};
      const bom = (d.boms || {})[wo.itemId]; // boms is an object keyed by itemId
      return {
        id: wo.id, date: wo.date, due: wo.due, status: wo.status,
        progress: wo.progress, priority: wo.priority, line: wo.line,
        product: { id: wo.itemId, name: it.name, typeCode: it.typeCode || null,
          uom: it.uom, widthMM: it.widthMM || null },
        qty: wo.qty,
        customer: showCustomer ? customerForWO(wo) : undefined, // label info for slitting only
        updatedBy: wo.updatedBy || null, updatedAt: wo.updatedAt || null,
        // recipe: what materials & how much (QUANTITIES ONLY, no cost)
        materials: bom ? (bom.lines || []).map(([rid, per]) => ({
          id: rid, name: (itemById[rid] || {}).name, uom: (itemById[rid] || {}).uom,
          needPerYield: per, yield: bom.yield,
          required: +(per * wo.qty / (bom.yield || 1)).toFixed(2),
        })) : [],
      };
    });

  // stock QUANTITIES only (raw + finished), no valuation
  const stock = d.items
    .filter((i) => ["RM", "WIP", "FG", "PKG", "CON"].includes(i.cat))
    .map((i) => ({ id: i.id, name: i.name, cat: i.cat, uom: i.uom }));

  return {
    role: "supervisor",
    area,
    org: { name: d.org.name, short: d.org.short, group: d.org.group },
    workorders: myWOs,
    stockItems: stock,           // names/uom only; live qty comes from /production/stock if needed
    settings: d.settings || {},
    generatedAt: new Date().toISOString(),
  };
}

/** Top-level dispatcher by user. */
function stateForUser(user) {
  if (!user) { const e = new Error("Not authenticated"); e.status = 401; throw e; }
  if (user.role === "supervisor") return stateForSupervisor(user.area || "all");
  return stateForOfficer(); // admin + office
}

module.exports = { stateForUser, stateForSupervisor, stateForOfficer, lineToArea };
