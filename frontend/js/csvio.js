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

  /* ---- column type helpers ----
     A column normally maps to a flat field of the same name. `col.path` maps it
     to a nested one instead ("values.tensile", "spec.thickness.min"), which is
     how a spreadsheet column can carry a measured value or a spec limit without
     the user ever typing JSON. */
  function readPath(o, path) {
    return path.split(".").reduce((v, k) => (v == null ? undefined : v[k]), o);
  }
  function writePath(o, path, val) {
    const parts = path.split(".");
    let t = o;
    for (let i = 0; i < parts.length - 1; i++) {
      if (t[parts[i]] == null || typeof t[parts[i]] !== "object") t[parts[i]] = {};
      t = t[parts[i]];
    }
    t[parts[parts.length - 1]] = val;
  }
  function getVal(o, col) {
    if (col.get) { try { const g = col.get(o); return g == null ? "" : String(g); } catch (_) { return ""; } }
    const v = col.path ? readPath(o, col.path) : o[col.k];
    if (col.type === "json") return v == null ? "" : JSON.stringify(v);
    if (col.type === "list") return Array.isArray(v) ? v.join("|") : (v == null ? "" : String(v));
    return v == null ? "" : String(v);
  }
  function setVal(target, col, raw) {
    const put = (v) => { if (col.path) writePath(target, col.path, v); else target[col.k] = v; };
    if (col.type === "num") {
      // a blank measurement/limit must stay blank, not become a real 0
      if (raw === "" && col.path) { put(null); return; }
      const n = raw === "" ? 0 : Number(raw); put(isNaN(n) ? 0 : n); return;
    }
    // a Status column is filled in by hand as often as it is exported, so accept
    // the words people actually type. Anchored, so INACTIVE never reads as ACTIVE.
    if (col.type === "bool") { put(/^(true|1|yes|y|active|on)$/i.test(raw)); return; }
    if (col.type === "list") { put(raw === "" ? [] : raw.split("|").map((x) => (x !== "" && !isNaN(+x) ? +x : x))); return; }
    if (col.type === "json") { try { put(raw === "" ? null : JSON.parse(raw)); } catch { /* keep old */ } return; }
    put(raw);
  }
  /* C(key, label, type, path)
     key   = the field in the record (and the header an Export writes for older
             files);  label = the full name shown in the sheet, worded the same
     way as the section's own form. Imports accept either spelling. */
  const C = (k, label, type, path) => ({ k, label: label || k, type: type || "str", path: path || null });

  /* A hand-filled sheet writes "-" (or "N/A") in a cell it has nothing for.
     Those are blanks, not values — otherwise every empty column imports the
     literal dash, and a dash in the id column would key every such row the
     same. Read through this everywhere a data cell is taken from a row. */
  const PLACEHOLDER = /^(?:[-–—]+|n\/a|n\.a\.?)$/i;
  function cellAt(row, i) {
    const s = String(row && row[i] == null ? "" : row[i]).trim();
    return PLACEHOLDER.test(s) ? "" : s;
  }

  /* header cell -> column matching: case/spacing/punctuation-insensitive, so
     "Supplier Name *", "supplier name" and "name" all find the same column */
  const norm = (v) => String(v == null ? "" : v).toLowerCase().replace(/[^a-z0-9]/g, "");
  function headerIndex(header) {
    const idx = {};
    (header || []).forEach((cell, i) => { const n = norm(cell); if (n && !(n in idx)) idx[n] = i; });
    return idx;
  }
  const colAt = (idx, col) => {
    const byLabel = idx[norm(col.label)];
    if (byLabel != null) return byLabel;
    const byKey = idx[norm(col.k)];
    if (byKey != null) return byKey;
    /* aliases: the page-toolbar EXPORT writes short headings ("Code") while
       the template writes full ones ("Item Code") — both must round-trip */
    for (const a of (col.alts || [])) { const i = idx[norm(a)]; if (i != null) return i; }
    return null;
  };

  /* ---- entity registry ----
     cols = every field the section round-trips through Export.
     form = the fields the section's own "+ New ..." dialog collects; the Excel
            import template ships exactly these, so filling in a sheet feels the
            same as filling in the form. Anything outside `form` (running totals,
            grades, ABC class, progress) is calculated or set by the app.       */
  const PARAM_LABELS = {
    tensile: "Tensile (N/cm)", elongation: "Elongation (%)", thickness: "Thickness (mm)",
    massPerArea: "Mass per unit area (g/m2)", swellSpeed: "Swelling speed (mm/1 min)",
    swellHeight3: "Swelling height 3 min (mm)", swellHeight10: "Swelling height 10 min (mm)",
    surfaceResistance: "Surface resistance (ohm)", volumeResistance: "Volume resistance (kohm-cm)",
    bdv: "Breakdown voltage BDV (kV/layer)",
  };
  const PARAM_KEYS = ["tensile", "elongation", "thickness", "massPerArea", "swellSpeed",
    "swellHeight3", "swellHeight10", "surfaceResistance", "volumeResistance", "bdv"];
  // one column per test parameter, written into the report's values{} object
  const measCols = PARAM_KEYS.map((k) => C(k, PARAM_LABELS[k], "num", "values." + k));
  // min/max spec limits per parameter -> spec.<param>.{min,max}
  const specCols = [].concat.apply([], PARAM_KEYS.map((k) => [
    C("min_" + k, "Min " + PARAM_LABELS[k], "num", "spec." + k + ".min"),
    C("max_" + k, "Max " + PARAM_LABELS[k], "num", "spec." + k + ".max"),
  ]));

  const ENTITIES = {
    items: {
      label: "Stock Items", idKey: "id", kind: "array", path: "items",
      cols: [Object.assign(C("id", "Item Code"), { alts: ["Code"] }), C("name", "Item Name"), C("cat", "Category"), C("uom", "Unit of Measure"),
        /* On Hand is NOT a field on the item — stock lives in movements. On
           export it is read live from the ledger (in the unit the screen
           shows); on import it lands in a side channel the preview turns into
           stock ADJUSTMENTS, so a stock-take typed into the exported sheet
           actually reaches the store. */
        Object.assign(C("onHand", "On Hand", "num", "_onHand"), {
          get: (o) => { const E = global.ENG;
            if (!E || !E.status || !o.id) return "";
            const it = E.item(o.id) || o; const st = E.status(o.id);
            return st ? String(Math.round(E.dispQty(it, st.onHand) * 100) / 100) : ""; },
        }),
        C("cost", "Std Cost (Rs)", "num"), C("price", "Selling Price (Rs)", "num"),
        C("reorder", "Reorder Point", "num"), C("safety", "Safety Stock", "num"), C("lead", "Lead Time (days)", "num"), C("hsn", "HSN Code"), C("gstRate", "GST Rate (%)", "num"),
        C("barcode", "Barcode"), C("abc", "ABC Class"), C("supplierId", "Supplier ID"), C("group", "Group"), C("typeCode", "Type Code"), C("std", "Standard"),
        C("flameC", "Flame Class", "num"), C("widthMM", "Width (mm)", "list")],
      form: ["id", "name", "cat", "uom", "reorder", "safety", "lead", "cost", "price",
        "hsn", "gstRate", "barcode"],
    },
    workorders: {
      label: "Work Orders", idKey: "id", kind: "array", path: "workorders", autoId: "WO-",
      cols: [C("id", "W.O. Number"), C("date", "Start Date"), C("itemId", "Product Item Code"), C("qty", "Quantity", "num"), C("status", "Status"), C("due", "Due Date"),
        C("line", "Production Line"), C("progress", "Progress (%)", "num"), C("priority", "Priority")],
      form: ["id", "itemId", "qty", "line", "due", "priority"],
    },
    salesorders: {
      label: "Sales Orders", idKey: "id", kind: "array", path: "salesorders", autoId: "SO-",
      cols: [C("id", "S.O. Number"), C("date", "Order Date"), C("customerId", "Customer ID"), C("status", "Status"), C("promised", "Promised Date"),
        C("priority", "Priority"), C("value", "Order Value (Rs)", "num"), C("lines", "Line Items (JSON)", "json")],
    },
    purchaseorders: {
      label: "Purchase Orders", idKey: "id", kind: "array", path: "purchaseorders", autoId: "PO-",
      cols: [C("id", "P.O. Number"), C("date", "Order Date"), C("supplierId", "Supplier ID"), C("status", "Status"), C("eta", "ETA"),
        C("value", "Order Value (Rs)", "num"), C("lines", "Line Items (JSON)", "json")],
    },
    customers: {
      label: "Customers", idKey: "id", kind: "array", path: "customers", autoId: "CUS-",
      cols: [C("id", "Customer ID"), C("name", "Customer Name"), C("segment", "Segment"), C("gst", "GSTIN"), C("stateCode", "GST State Code"), C("state", "State"),
        C("address", "Billing Address"), C("shipTo", "Ship-To Address"), C("city", "City"), C("country", "Country"), C("currency", "Currency"),
        C("rating", "Grade"), C("contact", "Contact Person"), C("phone", "Phone"),
        C("email", "Email"), C("terms", "Payment Terms"), C("since", "Customer Since")],
      // Currency is imported as written and NOT re-derived from Country: the
      // sheet is the user's own record of what a client actually settles in,
      // and a Vietnamese buyer paying in dollars must not be silently reset to
      // dong. A blank one falls back to the country's currency at display time.
      form: ["id", "name", "segment", "gst", "stateCode", "state", "address", "shipTo",
        "city", "country", "currency", "rating", "contact", "phone", "email", "terms", "since"],
    },
    suppliers: {
      label: "Suppliers", idKey: "id", kind: "array", path: "suppliers", autoId: "SUP-",
      cols: [C("id", "Supplier ID"), C("name", "Supplier Name"), C("category", "Category"), C("gst", "GSTIN"), C("stateCode", "GST State Code"), C("state", "State"),
        C("address", "Address"), C("city", "City"), C("country", "Country"), C("contact", "Contact Person"), C("phone", "Phone"), C("email", "Email"),
        C("terms", "Payment Terms"), C("rating", "Rating", "num"), C("onTime", "On-Time %", "num")],
      form: ["id", "name", "category", "gst", "stateCode", "state", "address", "city",
        "country", "contact", "phone", "email", "terms"],
    },
    movements: {
      label: "Stock Movements", idKey: "id", kind: "array", path: "movements", autoId: "MV-IMP-",
      cols: [C("id", "Movement ID"), C("date", "Date"), C("itemId", "Item Code"), C("wh", "Warehouse Code"), C("type", "Movement Type"), C("qty", "Quantity", "num"),
        C("rate", "Rate (Rs)", "num"), C("ref", "Reference"), C("note", "Note"), C("by", "Posted By"), C("supplierId", "Supplier ID")],
      form: ["id", "date", "itemId", "wh", "type", "qty", "rate", "ref", "note"],
    },
    boms: {
      label: "Bills of Material", idKey: "itemId", kind: "map", path: "boms",
      cols: [C("itemId", "Product Item Code"), C("yield", "Yield", "num"), C("lines", "Components (JSON)", "json")],
    },
    /* ---- CRM / lab / dispatch / HR ----
       autoId = leave id blank on a new row and the next id in the series is
                generated;  makeId = the id is built from other columns. */
    leads: {
      label: "CRM Leads", idKey: "id", kind: "array", path: "leads", autoId: "LD-",
      cols: [C("id", "Lead ID"), C("company", "Company"), C("contact", "Contact Person"), C("phone", "Phone"), C("email", "Email"), C("city", "City"),
        C("product", "Product Interest (Item Code)"), C("value", "Estimated Value (Rs)", "num"), C("source", "Source"), C("stage", "Stage"), C("owner", "Owner"),
        C("nextFollowUp", "Next Follow-up"), C("notes", "Notes"), C("productName", "Product Name"), C("created", "Created On"),
        C("expectedClose", "Expected Close"), C("customerId", "Customer ID")],
      form: ["id", "company", "contact", "phone", "email", "city", "product", "value",
        "source", "stage", "owner", "nextFollowUp", "notes"],
    },
    labreports: {
      label: "Lab Reports", idKey: "id", kind: "array", path: "labReports", autoId: "LR-",
      cols: [C("id", "Report ID"), C("productId", "Lab Product ID"), C("refNo", "Batch / Lot No."), C("reportDate", "Report Date"), C("assignee", "Assignee"),
        C("testedBy", "Tested By"), C("remarks", "Remarks")].concat(measCols,
        [C("productCode", "Product Code"), C("productName", "Product Name"), C("refMode", "Reference Mode"), C("woId", "Work Order"), C("result", "Result"),
          C("prodBy", "Production Entry By"), C("labBy", "Lab Entry By")]),
      form: ["id", "productId", "refNo", "reportDate", "assignee", "testedBy", "remarks"]
        .concat(PARAM_KEYS),
    },
    labproducts: {
      label: "Lab Products", idKey: "id", kind: "array", path: "labProducts",
      makeId: (o) => (o.code ? "LP-" + o.code : ""), idFrom: ["code"],
      cols: [C("id", "Lab Product ID"), C("code", "Code / Type"), C("name", "Product Name"), C("thickness", "Thickness (mm)", "num"), C("series", "Series"),
        C("refMode", "Reference Mode"), C("mica", "Type: Mica (BDV)", "bool", "flags.mica"),
        C("waterBlocking", "Type: Water-blocking", "bool", "flags.waterBlocking"),
        C("semiConductive", "Type: Semi-conductive", "bool", "flags.semiConductive"),
        C("active", "Status (Active)", "bool")].concat(specCols, [C("itemId", "Stock Item Code"), C("gsm", "GSM", "num"), C("notes", "Notes")]),
      // the product dialog has no Status control, so `active` stays out of the sheet
      form: ["id", "code", "name", "thickness", "series", "refMode", "mica",
        "waterBlocking", "semiConductive"].concat(specCols.map((c) => c.k)),
    },
    transporters: {
      label: "Dispatch - Transporters", idKey: "id", kind: "array", path: "transporters", autoId: "TR-",
      cols: [C("id", "Transporter ID"), C("name", "Agency / Carrier Name"), C("contact", "Contact Person"), C("phone", "Phone"), C("email", "Email"), C("city", "City"), C("state", "State"),
        C("gstin", "GSTIN"), C("pan", "PAN"), C("vehicleTypes", "Vehicle Types", "list"), C("routes", "Service Routes / Lanes"), C("rateBasis", "Rate Basis"),
        C("baseRate", "Base Rate (Rs)", "num"), C("onTime", "On-Time %", "num"), C("rating", "Rating"), C("owner", "Owner (internal)"), C("terms", "Payment Terms"),
        C("active", "Status (Active)", "bool"), C("notes", "Notes")],
      form: ["id", "name", "contact", "phone", "email", "city", "state", "gstin", "pan",
        "vehicleTypes", "routes", "rateBasis", "baseRate", "onTime", "rating", "owner",
        "terms", "active", "notes"],
    },
    hrworkers: {
      label: "Workers", idKey: "id", kind: "array", path: "hrWorkers", autoId: "EMP-",
      cols: [C("id", "Worker Code"), C("name", "Full Name"), C("dept", "Department"), C("designation", "Designation"), C("payType", "Pay Type"),
        C("dailyRate", "Daily Rate (Rs/day)", "num"), C("monthlyCtc", "Monthly CTC (Rs)", "num"), C("deviceUid", "Biometric Device ID"), C("phone", "Phone"),
        C("joined", "Joined On"), C("pfNo", "PF Number"), C("esiNo", "ESI Number"), C("bankAcc", "Bank A/C"), C("bankIfsc", "Bank IFSC"),
        C("active", "Status (Active)", "bool"), C("shift", "Shift")],
      form: ["id", "name", "dept", "designation", "payType", "dailyRate", "monthlyCtc",
        "deviceUid", "phone", "joined", "pfNo", "esiNo", "bankAcc", "bankIfsc", "active"],
    },
    hrattendance: {
      label: "Attendance", idKey: "id", kind: "array", path: "hrAttendance",
      // one row per worker per day - the id IS workerId:date, so the sheet only
      // needs those two columns and we build the key from them
      makeId: (o) => (o.workerId && o.date ? o.workerId + ":" + o.date : ""),
      idFrom: ["workerId", "date"],
      cols: [C("workerId", "Worker Code"), C("date", "Date"), C("status", "Status"), C("inTime", "In Time"), C("outTime", "Out Time"),
        C("otHours", "OT Hours", "num"), C("note", "Note"), C("id", "Attendance ID"), C("hours", "Hours Worked", "num"), C("source", "Source")],
      form: ["workerId", "date", "status", "inTime", "outTime", "otHours", "note"],
    },
  };

  /* The columns the import template ships for a section = its form fields.
     Sections whose records have line items (PO / SO / BOM) have no form list:
     a flat sheet cannot express their lines, so they stay export-only. */
  function formCols(key) {
    const ent = ENTITIES[key]; if (!ent || !ent.form) return null;
    const byKey = {}; ent.cols.forEach((c) => { byKey[c.k] = c; });
    return ent.form.map((k) => byKey[k]).filter(Boolean);
  }

  /* ---- Excel (.xlsx) read / write — SheetJS, vendored locally ---- */
  /* A cell that reads as a clean number becomes a real Excel number, so the
     sheet sorts/sums properly. Leading-zero strings (HSN codes) stay text. */
  function xlsxCell(v) {
    if (typeof v !== "string" || v === "") return v;
    if (/^0\d/.test(v)) return v; // preserve leading zeros
    return /^-?\d*\.?\d+$/.test(v) ? +v : v;
  }
  function downloadXLSX(name, header, rows, sheetName) {
    const aoa = [header].concat((rows || []).map((r) => r.map(xlsxCell)));
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = header.map((hd, i) => ({
      wch: Math.min(42, Math.max(String(hd).length, ...aoa.slice(1, 200).map((r) => String(r[i] == null ? "" : r[i]).length)) + 2),
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, (sheetName || "Sheet1").slice(0, 31));
    XLSX.writeFile(wb, name);
  }
  function sheetRows(ws) {
    if (!ws) return [];
    return XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "" })
      .map((r) => r.map((x) => (x == null ? "" : String(x).trim())))
      .filter((r) => r.length && r.some((x) => x !== ""));
  }
  /* First sheet of a workbook → array-of-arrays of strings (same shape the
     CSV parser produced, so detect/buildDiff work unchanged). */
  function parseXLSX(arrayBuffer) {
    const wb = XLSX.read(arrayBuffer, { type: "array" });
    return sheetRows(wb.Sheets[wb.SheetNames[0]]);
  }
  /* EVERY sheet of a workbook → [{name, rows, key}] where key is the entity the
     sheet's header matches (null = not importable, e.g. the guide sheet). Lets
     one template workbook carry a sheet per section. */
  function parseWorkbook(arrayBuffer) {
    const wb = XLSX.read(arrayBuffer, { type: "array" });
    return wb.SheetNames.map((name) => {
      const rows = sheetRows(wb.Sheets[name]);
      return { name, rows, key: rows.length ? detect(rows[0]) : null };
    });
  }

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

  function entityTable(key) {
    const ent = ENTITIES[key]; if (!ent) return null;
    const recs = entityRecords(key);
    return { label: ent.label, header: ent.cols.map((c) => c.label),
      rows: recs.map((o) => ent.cols.map((c) => getVal(o, c))) };
  }
  function exportEntity(key) {
    const t = entityTable(key); if (!t) return;
    downloadXLSX("chhaperia_" + key + ".xlsx", t.header, t.rows, t.label);
    return t.rows.length;
  }

  /* ---- detect which entity a header belongs to ----
     The sheet must carry the id column OR (for composite-key entities) the
     columns the id is built from, and at least 3 recognised columns so an
     unrelated sheet (e.g. the template's guide page) never matches. */
  function detect(header) {
    const idx = headerIndex(header);
    let best = null, bestScore = 0;
    Object.keys(ENTITIES).forEach((key) => {
      const ent = ENTITIES[key];
      const byKey = {}; ent.cols.forEach((c) => { byKey[c.k] = c; });
      const has = (k) => byKey[k] && colAt(idx, byKey[k]) != null;
      const keyed = has(ent.idKey) || (ent.idFrom || []).every(has);
      if (!keyed) return;
      const score = ent.cols.reduce((n, c) => n + (colAt(idx, c) != null ? 1 : 0), 0);
      if (score >= 3 && score > bestScore) { bestScore = score; best = key; }
    });
    return best;
  }

  /* ---- build a diff (no mutation) ---- */
  function buildDiff(key, parsed) {
    const ent = ENTITIES[key];
    const idx = headerIndex(parsed[0]);
    const colIndex = {};
    ent.cols.forEach((c) => { const i = colAt(idx, c); if (i != null) colIndex[c.k] = i; });
    const idCol = ent.cols.filter((c) => c.k === ent.idKey)[0];
    const idIdx = idCol ? (colAt(idx, idCol) != null ? colAt(idx, idCol) : -1) : -1;

    const existing = {};
    entityRecords(key).forEach((o) => { existing[o[ent.idKey]] = o; });

    /* next free sequential id for autoId entities — counts ids created earlier
       in this same file too, so a sheet of 20 blank-id rows gets 20 ids */
    const taken = new Set(Object.keys(existing));
    function nextAutoId() {
      const pre = ent.autoId;
      let max = 0, width = 3;
      taken.forEach((id) => {
        id = String(id);
        if (!id.startsWith(pre)) return;
        const m = /(\d+)\s*$/.exec(id);
        if (m) { max = Math.max(max, +m[1]); width = Math.max(width, m[1].length); }
      });
      const id = pre + String(max + 1).padStart(width, "0");
      taken.add(id);
      return id;
    }

    const add = [], update = [], unchanged = [], errors = [], qty = [];
    for (let r = 1; r < parsed.length; r++) {
      const row = parsed[r];
      // read the row's columns first — a composite id is built from them
      const draft = {};
      ent.cols.forEach((c) => { if (c.k in colIndex) setVal(draft, c, cellAt(row, colIndex[c.k])); });
      let id = idIdx >= 0 ? cellAt(row, idIdx) : "";
      if (!id && ent.makeId) id = ent.makeId(draft) || "";
      if (!id && ent.autoId) id = nextAutoId();
      if (!id) {
        errors.push({ line: r + 1, msg: "missing " + (ent.idFrom ? ent.idFrom.join(" + ") : ent.idKey) });
        continue;
      }
      const prev = existing[id];
      const after = prev ? JSON.parse(JSON.stringify(prev)) : {};
      ent.cols.forEach((c) => {
        if (!(c.k in colIndex)) return;
        if (c.path && c.path[0] === "_") return;  // side channel, never a field
        const raw = cellAt(row, colIndex[c.k]);
        // On an UPDATE an empty cell means "leave this value alone". The import
        // template carries every column, so a half-filled row must never wipe
        // the fields the user didn't type into.
        if (prev && raw === "") return;
        setVal(after, c, raw);
      });
      after[ent.idKey] = id;                     // blank / generated / composite
      /* THE SHEET SPEAKS THE SCREEN'S LANGUAGE. Since metre-bought material is
         READ in kilograms, the exported sheet says "kg" and writes kg figures —
         and importing that sheet back must not re-file the item under kg or
         store kilogram thresholds in a metre-unit field. So a uom that merely
         echoes the DISPLAY unit is kept as stored, and reorder/safety figures
         on a weighable web convert back to the stocking unit. */
      const E = global.ENG;
      if (key === "items" && prev && E && E.dispUom) {
        if (after.uom != null && norm(after.uom) === norm(E.dispUom(prev))) after.uom = prev.uom;
        if (E.readsAsKg && E.readsAsKg(prev)) {
          const per = E.kgPerUnit(prev);
          if (per) ["reorder", "safety"].forEach((f) => {
            if (f in colIndex && cellAt(row, colIndex[f]) !== "")
              after[f] = Math.round((+after[f] || 0) / per * 1000) / 1000;
          });
        }
      }
      /* an On Hand figure travels beside the row, in display units */
      if (key === "items" && ("onHand" in colIndex)) {
        const rawQ = cellAt(row, colIndex.onHand);
        if (rawQ !== "" && isFinite(+rawQ)) qty.push({ id, shown: +rawQ, isNew: !prev });
      }
      if (!prev) add.push({ id, after });
      else if (JSON.stringify(prev) !== JSON.stringify(after)) update.push({ id, before: prev, after });
      else unchanged.push({ id });
    }
    return { key, ent, add, update, unchanged, errors, qty };
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

  global.CSVIO = { ENTITIES, parse, toCSV, exportEntity, entityTable, detect, buildDiff, apply,
    entityRecords, downloadXLSX, parseXLSX, parseWorkbook, formCols };
})(window);
