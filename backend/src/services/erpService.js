/* ============================================================
   CHHAPERIA ERP — BACKEND · ERP service (business logic)
   Sits between the HTTP routes and the database repository.
   Handles seeding-on-empty, full-state load/save, settings
   patch and reset. Keeps routes thin and the DB layer pure.
   ============================================================ */
"use strict";
const repo = require("../db/repository");
const { buildSeed } = require("../seed/seed");

/** Load the full dataset; seed automatically on first run. */
function getState() {
  if (repo.isEmpty()) {
    repo.saveState(buildSeed());
  }
  return repo.getState();
}

/** Persist the entire dataset (the frontend saves wholesale). */
function saveState(data) {
  if (!data || !Array.isArray(data.items) || !Array.isArray(data.movements)) {
    const err = new Error("Invalid dataset: items[] and movements[] are required");
    err.status = 400;
    throw err;
  }
  return repo.saveState(data);
}

/** Patch just the UI settings document. */
function updateSettings(doc) {
  return repo.updateSettings(doc || {});
}

/** Wipe and regenerate the deterministic demo dataset. */
function reset() {
  return repo.saveState(buildSeed());
}

module.exports = { getState, saveState, updateSettings, reset };
