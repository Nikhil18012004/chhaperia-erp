/* ============================================================
   CHHAPERIA ERP — CSV import / export engine  (CSVIO)
   Round-trippable per-entity CSV. Export writes one CSV per
   table with the column keys as the header; import parses it,
   auto-detects the entity, computes a DIFF against the current
   data (new / updated / unchanged) and shows a PREVIEW so the
   user confirms before anything is written.

   Import semantics = UPSERT + MERGE: a row whose id already
   exists updates only the columns present in the file (nested
   fields the CSV doesn't carry — e.g. a work order's stage
   route, a lead's activities — are preserved). New ids are
   added. Nothing is deleted. Writing goes through DB.save (full
   PUT /state), so the backend re-applies the stage model to any
   imported work orders / products automatically.
   ============================================================ */
(function (global) {
  "use strict";

  /* ---- column type helpers ---- */
  function getVal(o, col) {
    const v = o[col.k];
    if (col.type === "json") return v == null ? "" : JSON.stringify(v);
    if (col.type === "list") return Array.isArray(v) ? v.join("|") : (v == null ? "" : String(v));
    return v == null ? "" : String(v);
  }
  function setVal(target, col, raw) {
    if (raw === "" && col.type !== "num") { /* leave empty strings out unless numeric */ }
    if (col.type === "num") { const n = raw === "" ? 0 : Number(raw); target[col.k] = isNaN(n) ? 0 : n; return; }
    if (col.type === "bool") { target[col.k] = /^(true|1|yes|y)$/i.test(raw); return; }
    if (col.type === "list") { target[col.k] = raw === "" ? [] : raw.split("|").map((x) => (x !== "" && !isNaN(+x) ? +x : x)); return; }
    if (col.type === "json") { try { target[col.k] = raw === "" ? null : JSON.parse(raw); } catch { /* keep old */ } return; }
    target[col.k] = raw;
  }
  const C = (k, type) => ({ k, type: type || "str" });

  /* ---- entity registry ---- */
  const ENTITIES = {
    items: {
      label: "Stock Items", idKey: "id", kind: "array", path: "items",
      cols: [C("id"), C("name"), C("cat"), C("uom"), C("cost", "num"), C("price", "num"),
        C("reorder", "num"), C("safety", "num"), C("lead", "num"), C("abc"), C("hsn"),
        C("supplierId"), C("group"), C("typeCode"), C("std"), C("flameC", "num"),
        C("widthMM", "list"), C("barcode")],
    },
    workorders: {
      label: "Work Orders", idKey: "id", kind: "array", path: "workorders",
      cols: [C("id"), C("date"), C("itemId"), C("qty", "num"), C("status"), C("due"),
        C("line"), C("progress", "num"), C("priority")],
    },
    salesorders: {
      label: "Sales Orders", idKey: "id", kind: "array", path: "salesorders",
      cols: [C("id"), C("date"), C("customerId"), C("status"), C("promised"),
        C("priority"), C("value", "num"), C("lines", "json")],
    },
    purchaseorders: {
      label: "Purchase Orders", idKey: "id", kind: "array", path: "purchaseorders",
      cols: [C("id"), C("date"), C("supplierId"), C("status"), C("eta"),
        C("value", "num"), C("lines", "json")],
    },
    customers: {
      label: "Customers", idKey: "id", kind: "array", path: "customers",
      cols: [C("id"), C("name"), C("city"), C("gst"), C("segment"), C("rating"),
        C("terms"), C("contact"), C("phone"), C("email"), C("since")],
    },
    suppliers: {
      label: "Suppliers", idKey: "id", kind: "array", path: "suppliers",
      cols: [C("id"), C("name"), C("city"), C("country"), C("gst"), C("rating", "num"),
        C("onTime", "num"), C("terms"), C("contact"), C("phone"), C("email"), C("category")],
    },
    movements: {
      label: "Stock Movements", idKey: "id", kind: "array", path: "movements",
      cols: [C("id"), C("date"), C("itemId"), C("wh"), C("type"), C("qty", "num"),
        C("rate", "num"), C("ref"), C("note"), C("by"), C("supplierId")],
    },
    boms: {
      label: "Bills of Material", idKey: "itemId", kind: "map", path: "boms",
      cols: [C("itemId"), C("yield", "num"), C("lines", "json")],
    },
  };

  /* ---- CSV parse / serialize (RFC-4180-ish) ---- */
  function parse(text) {
    text = String(text || "").replace(/^﻿/, "");
    const rows = []; let row = [], field = "", inQ = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQ) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
        else field += c;
      } else if (c === '"') inQ = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (c === "\r") { /* ignore */ }
      else field += c;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => r.length && !(r.length === 1 && r[0] === ""));
  }
  function esc(v) { v = v == null ? "" : String(v); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
  function toCSV(header, rows) {
    return [header.map(esc).join(",")].concat(rows.map((r) => r.map(esc).join(","))).join("\r\n");
  }

  /* ---- rows out of the live dataset ---- */
  function entityRecords(key) {
    const ent = ENTITIES[key];
    const data = (global.ENG && ENG.data) || {};
    if (ent.kind === "map") {
      const obj = data[ent.path] || {};
      return Object.keys(obj).map((id) => Object.assign({ itemId: id }, obj[id]));
    }
    return (data[ent.path] || []).slice();
  }

  function exportEntity(key) {
    const ent = ENTITIES[key]; if (!ent) return;
    const recs = entityRecords(key);
    const header = ent.cols.map((c) => c.k);
    const rows = recs.map((o) => ent.cols.map((c) => getVal(o, c)));
    const csv = toCSV(header, rows);
    const name = "chhaperia_" + key + ".csv";
    if (global._erpUtil && _erpUtil.downloadCSV) _erpUtil.downloadCSV(name, csv);
    else { const b = new Blob([csv], { type: "text/csv" }); const a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = name; a.click(); }
    return recs.length;
  }

  /* ---- detect which entity a header belongs to ---- */
  function detect(header) {
    const set = new Set(header.map((h) => h.trim()));
    let best = null, bestScore = 0;
    Object.keys(ENTITIES).forEach((key) => {
      const ent = ENTITIES[key];
      if (!set.has(ent.idKey)) return;
      const score = ent.cols.reduce((s, c) => s + (set.has(c.k) ? 1 : 0), 0);
      if (score > bestScore) { bestScore = score; best = key; }
    });
    return best;
  }

  /* ---- build a diff (no mutation) ---- */
  function buildDiff(key, parsed) {
    const ent = ENTITIES[key];
    const header = parsed[0].map((h) => h.trim());
    const colIndex = {};
    ent.cols.forEach((c) => { const i = header.indexOf(c.k); if (i >= 0) colIndex[c.k] = i; });
    const idIdx = header.indexOf(ent.idKey);

    const existing = {};
    entityRecords(key).forEach((o) => { existing[o[ent.idKey]] = o; });

    const add = [], update = [], unchanged = [], errors = [];
    for (let r = 1; r < parsed.length; r++) {
      const row = parsed[r];
      const id = idIdx >= 0 ? (row[idIdx] || "").trim() : "";
      if (!id) { errors.push({ line: r + 1, msg: "missing " + ent.idKey }); continue; }
      const prev = existing[id];
      const after = prev ? JSON.parse(JSON.stringify(prev)) : {};
      ent.cols.forEach((c) => { if (c.k in colIndex) setVal(after, c, (row[colIndex[c.k]] == null ? "" : row[colIndex[c.k]])); });
      if (!prev) add.push({ id, after });
      else if (JSON.stringify(prev) !== JSON.stringify(after)) update.push({ id, before: prev, after });
      else unchanged.push({ id });
    }
    return { key, ent, add, update, unchanged, errors };
  }

  /* ---- apply an approved diff to ENG.data (mutates in place) ---- */
  function apply(diff) {
    const ent = diff.ent;
    const data = ENG.data;
    if (ent.kind === "map") {
      data[ent.path] = data[ent.path] || {};
      diff.add.concat(diff.update).forEach(({ after }) => {
        const id = after[ent.idKey];
        const clone = Object.assign({}, after); delete clone[ent.idKey];
        data[ent.path][id] = clone;
      });
    } else {
      const arr = data[ent.path] = data[ent.path] || [];
      const byId = {}; arr.forEach((o, i) => { byId[o[ent.idKey]] = i; });
      diff.update.forEach(({ id, after }) => { arr[byId[id]] = after; });
      diff.add.forEach(({ after }) => arr.push(after));
    }
  }

  global.CSVIO = { ENTITIES, parse, toCSV, exportEntity, detect, buildDiff, apply, entityRecords };
})(window);
