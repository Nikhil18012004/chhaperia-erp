/* ============================================================
   CHHAPERIA ERP — BACKEND · ERP service (business logic)
   Sits between the HTTP routes and the database repository.
   Handles seeding-on-empty, full-state load/save, settings
   patch and reset. Keeps routes thin and the DB layer pure.
   ============================================================ */
"use strict";
const repo = require("../db/repository");
const { buildSeed } = require("../seed/seed");
const S = require("./stageService");

/** Load the full dataset; seed automatically on first run. */
function getState() {
  if (repo.isEmpty()) {
    repo.saveState(buildSeed());
  }
  return repo.getState();
}

/** One-time (idempotent) migration: derive WIP items + attach stage
    routes to work orders. Runs at boot and after any bulk save so
    imported/restored data is always stage-ready. Never wipes data. */
function ensureStageModel() {
  if (repo.isEmpty()) repo.saveState(buildSeed());
  const data = repo.getState();
  const res = S.ensureStageModel(data);
  if (res.changed || !(data.settings && data.settings._stageModel)) {
    data.settings = Object.assign({}, data.settings, { _stageModel: 1 });
    repo.saveState(data);
  }
  return res;
}

/** Restore the CRM pipeline if it is empty (this DB was originally
    seeded before the CRM module existed, so its leads table is blank).
    Leads are (re)built from the deterministic generator but re-pointed
    at the CURRENT customers/products so every reference stays valid.
    Populate-if-empty only — never clobbers existing leads. */
function ensureCrm() {
  if (repo.isEmpty()) repo.saveState(buildSeed());
  const data = repo.getState();
  if ((data.leads || []).length > 0) return { changed: false, count: data.leads.length };

  const itemById = Object.fromEntries((data.items || []).map((i) => [i.id, i]));
  const custIds = new Set((data.customers || []).map((c) => c.id));
  const fgIds = (data.items || []).filter((i) => i.cat === "FG").map((i) => i.id);
  if (!fgIds.length || !custIds.size) return { changed: false, count: 0 };

  const leads = (buildSeed().leads || []).map((l) => {
    const lead = Object.assign({}, l);
    // re-point product / customer references at the current dataset
    if (!itemById[lead.product]) lead.product = fgIds[0];
    lead.productName = (itemById[lead.product] || {}).name || lead.productName;
    if (lead.customerId && !custIds.has(lead.customerId)) lead.customerId = data.customers[0].id;
    return lead;
  });

  data.leads = leads;
  repo.saveState(data);
  return { changed: true, count: leads.length };
}

/** Persist the entire dataset (the frontend saves wholesale). */
function saveState(data) {
  if (!data || !Array.isArray(data.items) || !Array.isArray(data.movements)) {
    const err = new Error("Invalid dataset: items[] and movements[] are required");
    err.status = 400;
    throw err;
  }
  // keep any newly-introduced work orders / products stage-ready
  S.ensureStageModel(data);
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

module.exports = { getState, saveState, updateSettings, reset, ensureStageModel, ensureCrm };
