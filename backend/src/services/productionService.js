/* ============================================================
   CHHAPERIA ERP — BACKEND · production service
   Supervisor-facing write operations. Security model:
     • a supervisor may ONLY touch work orders in their own area
     • only a safe set of status transitions is allowed
     • no money/customer fields are ever returned
   Uses the existing whole-state repository (load → mutate one WO
   → save). Heavier stock-posting stays in the office app.
   ============================================================ */
"use strict";
const repo = require("../db/repository");
const { buildSeed } = require("../seed/seed");
const { lineToArea } = require("./viewService");

const STATUS_FLOW = ["Pending", "In Production", "Completed", "Packed", "Dispatched"];
// which statuses each area is allowed to set
const AREA_ALLOWED = {
  coating:    ["Pending", "In Production", "Completed"],
  fiberglass: ["Pending", "In Production", "Completed"],
  slitting:   ["Pending", "In Production", "Completed", "Packed", "Dispatched"],
};

function err(msg, status) { const e = new Error(msg); e.status = status || 400; return e; }

function fullState() {
  if (repo.isEmpty()) repo.saveState(buildSeed());
  return repo.getState();
}

/** Update a work order's status, scoped to the supervisor's area. */
function updateWorkOrderStatus(user, woId, status) {
  if (!user) throw err("Not authenticated", 401);
  const isAdmin = user.role === "admin";
  if (!isAdmin && user.role !== "supervisor") throw err("Forbidden", 403);

  if (!STATUS_FLOW.includes(status)) throw err("Invalid status", 400);

  const data = fullState();
  const wo = (data.workorders || []).find((w) => w.id === woId);
  if (!wo) throw err("Work order not found", 404);

  const woArea = lineToArea(wo.line);

  // supervisors are locked to their own area
  if (!isAdmin) {
    if (user.area !== "all" && woArea !== user.area) throw err("This job is not in your work area", 403);
    if (!(AREA_ALLOWED[user.area] || []).includes(status)) throw err("Your area cannot set status '" + status + "'", 403);
  }

  // apply
  wo.status = status;
  if (status === "Pending") wo.progress = 0;
  else if (status === "In Production") wo.progress = Math.max(wo.progress || 0, 25);
  else if (status === "Completed" || status === "Packed" || status === "Dispatched") wo.progress = 100;
  wo.updatedBy = user.username;
  wo.updatedAt = new Date().toISOString();

  repo.saveState(data);
  return { id: wo.id, status: wo.status, progress: wo.progress, updatedAt: wo.updatedAt };
}

module.exports = { updateWorkOrderStatus, STATUS_FLOW, AREA_ALLOWED };
