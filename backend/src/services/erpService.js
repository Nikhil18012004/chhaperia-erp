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
const HR = require("./hrService");
const BC = require("../../../frontend/js/bomcalc");
// the same tax engine the invoice prints from, so a quotation's money and the
// order it becomes can never disagree on a figure

/* Movement ids. A timestamp alone is not unique — several movements are posted
   inside the same millisecond, and keying the tail on the item id collides the
   moment one document names the same item twice (a two-lot delivery received
   against one PO used to throw UNIQUE constraint failed and 500 on the user).
   A process counter makes the tail strictly increasing instead. Same shape as
   stageService/productionService, which already learned this. */
let _mvSeq = 0;
function mvId() { return "MV-" + Date.now().toString(36).toUpperCase() + "-" + (++_mvSeq).toString(36).toUpperCase(); }

/** Load the full dataset; seed automatically on first run. */
async function getState() {
  if (await repo.isEmpty()) {
    await repo.saveState(buildSeed());
  }
  return await repo.getState();
}

/** One-time (idempotent) migration: attach stage
    routes to work orders. Runs at boot and after any bulk save so
    imported/restored data is always stage-ready. Never wipes data. */
async function ensureStageModel() {
  if (await repo.isEmpty()) await repo.saveState(buildSeed());
  const data = await repo.getState();
  const res = S.ensureStageModel(data);
  if (res.changed || !(data.settings && data.settings._stageModel)) {
    data.settings = Object.assign({}, data.settings, { _stageModel: 1 });
    await repo.saveState(data);
  }
  return res;
}

/** Restore the CRM pipeline if it is empty (this DB was originally
    seeded before the CRM module existed, so its leads table is blank).
    Leads are (re)built from the deterministic generator but re-pointed
    at the CURRENT customers/products so every reference stays valid.
    Populate-if-empty only — never clobbers existing leads. */
async function ensureCrm() {
  if (await repo.isEmpty()) await repo.saveState(buildSeed());
  const data = await repo.getState();
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
  await repo.saveState(data);
  return { changed: true, count: leads.length };
}

/** Persist the entire dataset (the frontend saves wholesale). Validates
    shape + referential integrity so a malformed backup/restore can't quietly
    persist orphan movements or non-array collections. */
async function saveState(data) {
  if (!data || typeof data !== "object") throw err("Invalid dataset", 400);
  const arrays = ["items", "movements", "warehouses", "categories", "suppliers",
    "customers", "purchaseorders", "salesorders", "workorders", "leads", "grns"];
  for (const k of arrays) {
    if (data[k] != null && !Array.isArray(data[k])) throw err(`Invalid dataset: ${k} must be an array`, 400);
  }
  if (!Array.isArray(data.items) || !Array.isArray(data.movements)) {
    throw err("Invalid dataset: items[] and movements[] are required", 400);
  }
  // referential integrity: every movement must reference a known item
  const itemIds = new Set(data.items.map((i) => i && i.id));
  const orphan = data.movements.find((m) => m && m.itemId && !itemIds.has(m.itemId));
  if (orphan) throw err(`Movement ${orphan.id || ""} references unknown item ${orphan.itemId}`, 400);
  /* A TRANSFER IS A PAIR. The movements endpoint refuses a lone XFER leg (it
     would mint or destroy stock) — but a bulk save, which is where the Excel
     import lands, took one without a word. New transfer rows must balance:
     for one material, one date and one reference the legs sum to zero, with
     an OUT and an IN. Rows already on file are left alone, so an old ledger
     never blocks a save. */
  const known = new Set(((await repo.getState()).movements || []).map((m) => m && m.id));
  const legs = {};
  data.movements.forEach((m) => {
    if (!m || m.type !== "XFER" || known.has(m.id)) return;
    const k = [m.itemId, String(m.date || "").slice(0, 10), m.ref || ""].join("|");
    const g = legs[k] = legs[k] || { rows: [], sum: 0, item: m.itemId, ref: m.ref || "", date: m.date };
    g.rows.push(m); g.sum += +m.qty || 0;
  });
  const odd = Object.values(legs).find((g) => g.rows.length < 2 || Math.abs(g.sum) > 1e-6
    || !g.rows.some((r) => +r.qty > 0) || !g.rows.some((r) => +r.qty < 0));
  if (odd) {
    throw err("Transfer " + (odd.ref ? odd.ref + " " : "") + "of " + odd.item + " on " + String(odd.date || "").slice(0, 10)
      + " is not a matched pair (" + odd.rows.length + " leg" + (odd.rows.length === 1 ? "" : "s") + ", net "
      + (+odd.sum.toFixed(3)) + "). A transfer needs an OUT leg and an IN leg of the same quantity — post it "
      + "from Move Stock, or put both legs on the sheet with the same item, date and reference.", 400);
  }
  // keep any newly-introduced work orders / products stage-ready
  S.ensureStageModel(data);
  // pay is monthly only — an imported sheet may still carry daily rates
  if (Array.isArray(data.hrWorkers)) data.hrWorkers.forEach((w) => { if (w) HR.normalizeWorker(w); });
  return await repo.saveState(data);
}

/** Patch the UI settings document — whitelist known keys, coerce types, and
    MERGE over the stored settings so internal flags (e.g. _stageModel) survive. */
/* Kept beside updateSettings so the two lists that must agree with the
   frontend's STICKER_FIELDS / PAGE_SIZES are visible in one place. */
const STICKER_FIELD_KEYS = ["product", "supplier", "grade", "dateOfReceipt", "grnNo",
  "invoiceNo", "qty", "thickness", "gsm", "inspectedBy", "status"];
const STICKER_PAGES = ["A3", "A4", "A5", "A6", "Letter", "Legal", "custom"];

async function updateSettings(doc) {
  doc = doc || {};
  if (typeof doc !== "object" || Array.isArray(doc)) throw err("Settings must be an object", 400);
  const clean = Object.assign({}, await repo.getSettings() || {});
  if (doc.theme != null) clean.theme = doc.theme === "light" ? "light" : "dark";
  if (doc.accent != null) clean.accent = String(doc.accent).slice(0, 20);
  if ("autoAccent" in doc) clean.autoAccent = !!doc.autoAccent;
  if ("lowStockOnly" in doc) clean.lowStockOnly = !!doc.lowStockOnly;
  /* Label printing config: the whole print definition — which fields print,
     the sheet, its margins, the grid, the label size and the gaps. Whitelisted
     key by key so a bad client can't stuff arbitrary JSON into the shared
     settings document. ADDING A LABEL FIELD means adding its key to
     STICKER_FIELD_KEYS below AND to STICKER_FIELDS in frontend/js/mod-trade.js;
     a key missing here is silently dropped on save. w/h are the pre-layout
     roll size, still accepted so an older saved config keeps working. */
  if (doc.sticker != null && typeof doc.sticker === "object" && !Array.isArray(doc.sticker)) {
    const s = doc.sticker;
    const mm = (v, d) => { v = +v; return isNaN(v) || v <= 0 ? d : Math.min(300, Math.max(25, v)); };
    // a margin or gap of 0 is a real choice, so dim() accepts it; pick() won't
    const dim = (v, d, lo, hi) => { v = +v; return isNaN(v) ? d : Math.min(hi, Math.max(lo, v)); };
    const pick = (v, d, lo, hi) => { v = +v; return isNaN(v) || v <= 0 ? d : Math.min(hi, Math.max(lo, v)); };
    const int = (v, d, lo, hi) => { v = Math.round(+v); return isNaN(v) ? d : Math.min(hi, Math.max(lo, v)); };
    /* Fields the operator invented in the dialog. The key becomes a settings
       key AND a CSV column name, so it is held to a strict shape rather than
       trusted; anything else is dropped. */
    const custom = (Array.isArray(s.custom) ? s.custom : []).slice(0, 40)
      .map((c) => ({ k: String((c && c.k) || ""), label: String((c && c.label) || "").slice(0, 44) }))
      .filter((c) => /^cx[A-Za-z0-9]{1,20}$/.test(c.k) && c.label);
    const keys = STICKER_FIELD_KEYS.concat(custom.map((c) => c.k));
    const fields = {};
    keys.forEach((k) => { fields[k] = !s.fields || s.fields[k] !== false; });
    /* `order` is what actually prints, and in what sequence — unknown keys and
       repeats are stripped so a bad client can't grow it without bound. */
    const order = (Array.isArray(s.order) ? s.order : []).map(String)
      .filter((k, i, a) => keys.indexOf(k) >= 0 && a.indexOf(k) === i);
    const txt = (v, d, max) => (v == null ? d : String(v)).slice(0, max);
    /* Colours go straight into the print stylesheet, so only a #rrggbb literal
       is ever stored — anything else (a url(), a second declaration) must never
       survive the save. */
    const hex = (v, d) => (/^#[0-9a-fA-F]{6}$/.test(String(v || "")) ? String(v).toLowerCase() : d);
    /* The background picture is a data URL rendered in an <img>. SVG is
       deliberately excluded — an SVG can carry script — and the base64 charset
       in the pattern doubles as attribute-injection proof. */
    const IMG_RE = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;
    const img = (v) => (typeof v === "string" && v.length <= 750000 && IMG_RE.test(v) ? v : "");
    /* Symbols placed on the label: glyph + centre position + size. The glyph
       cap (2 characters, counted as a person counts them) is what keeps markup
       and whole sentences out; everything numeric clamps. */
    const syms = (Array.isArray(s.syms) ? s.syms : []).slice(0, 12).map((o) => {
      const g = String((o && o.g) || "").trim();
      if (!g || [...g].length > 2) return null;
      return { g, x: dim(o && o.x, 0, 0, 1000), y: dim(o && o.y, 0, 0, 1000), s: dim(o && o.s, 8, 2, 200) };
    }).filter(Boolean);
    clean.sticker = {
      w: mm(s.w, 100), h: mm(s.h, 150), fields, custom,
      // an empty order means "never picked" — the client falls back to the ticks
      order: order.length ? order : undefined,
      title: txt(s.title, "RAW MATERIAL", 120),
      para: txt(s.para, "", 1200),
      bg: hex(s.bg, "#ffffff"),                 // label background colour
      capC: hex(s.capC, ""), valC: hex(s.valC, ""),   // caption/value text ("" = auto ink)
      // the design layer: a whitelisted font, per-part inks, per-block font
      // sizes (mm, 0 = auto scale) and free positions (mm from the top-left)
      font: ["times", "georgia", "cambria", "arial", "calibri", "courier"].indexOf(s.font) >= 0 ? s.font : "times",
      titleC: hex(s.titleC, ""), prodC: hex(s.prodC, ""), paraC: hex(s.paraC, ""),
      fieldC: (() => {
        const o = {};
        keys.forEach((k) => {
          const v = s.fieldC && s.fieldC[k];
          if (/^#[0-9a-fA-F]{6}$/.test(String(v || ""))) o[k] = String(v).toLowerCase();
        });
        return o;
      })(),
      fs: (() => {
        const src = s.fs || {}, o = {};
        ["title", "prod", "body", "para"].forEach((k) => { o[k] = dim(src[k], 0, 0, 60); });
        return o;
      })(),
      pos: (() => {
        const src = s.pos || {}, o = {};
        ["title", "prod", "body", "para"].forEach((k) => {
          const p = src[k];
          if (p && typeof p === "object" && isFinite(+p.x) && isFinite(+p.y))
            o[k] = { x: dim(p.x, 0, -500, 1000), y: dim(p.y, 0, -500, 1000) };
        });
        return o;
      })(),
      /* label outline: rectangle, rounded, ellipse, circle or disc (circle
         with a punched hole); the curved ones carry their own parameters */
      shape: ["rect", "round", "ellipse", "circle", "disc"].indexOf(s.shape) >= 0 ? s.shape : "rect",
      radius: dim(s.radius, 4, 0, 100),         // rounded-rectangle corner, mm
      holeDia: dim(s.holeDia, 15, 0, 1000),     // disc centre hole, mm
      /* which side of the geometry auto-fit solves: the gaps (label size is
         the operator's), the label size (gaps are the operator's), or neither */
      autoFit: ["gaps", "size", "none"].indexOf(s.autoFit) >= 0 ? s.autoFit
        : (s.autoSize === false ? "none" : "gaps"),
      bgImg: img(s.bgImg),                      // watermark/background picture
      bgImgOp: int(s.bgImgOp, 70, 0, 95),       // its transparency, %
      bgImgFit: s.bgImgFit === "h" ? "h" : "w", // scaled to label height or width
      bgImgX: dim(s.bgImgX, 0, -300, 300), bgImgY: dim(s.bgImgY, 0, -300, 300),
      syms,                                     // placed symbols
      layout: s.layout === "plain" ? "plain" : "table",
      copies: int(s.copies, 1, 1, 500),
      page: STICKER_PAGES.includes(s.page) ? s.page : "A4",
      pageW: pick(s.pageW, 210, 20, 1000), pageH: pick(s.pageH, 297, 20, 1000),
      landscape: !!s.landscape,
      unit: s.unit === "cm" ? "cm" : "mm",
      mTop: dim(s.mTop, 10, 0, 200), mBottom: dim(s.mBottom, 10, 0, 200),
      mLeft: dim(s.mLeft, 8, 0, 200), mRight: dim(s.mRight, 8, 0, 200),
      rows: int(s.rows, 2, 1, 50), cols: int(s.cols, 2, 1, 20),
      // 0 = no label size has ever been set; the layout decides it instead
      labelW: dim(s.labelW, 0, 0, 1000), labelH: dim(s.labelH, 0, 0, 1000),
      gapX: dim(s.gapX, 3, 0, 100), gapY: dim(s.gapY, 3, 0, 100),
    };
  }
  /* ============================================================
     LABEL STUDIO DESIGNS
     The designer's saved templates. They live here rather than in a file on
     someone's laptop, so a label designed on the office PC prints from the
     store PC. Everything is rebuilt field by field: these values are written
     straight into a print stylesheet and an <img src>, so a colour is only
     ever a #rrggbb literal and a picture is only ever a RASTER data URL —
     SVG is excluded because an SVG can carry script. Mirrors cleanDoc() and
     cleanObject() in frontend/js/labelstudio.js; a key missing here is
     silently dropped on save, so the two lists must be changed together.
     ============================================================ */
  if (doc.labelDocs != null && Array.isArray(doc.labelDocs)) {
    // the sticker block's helpers are scoped to that block, so this one has its own
    const dim = (v, d, lo, hi) => { v = +v; return isNaN(v) ? d : Math.min(hi, Math.max(lo, v)); };
    const iv = (v, d, lo, hi) => { v = Math.round(+v); return isNaN(v) ? d : Math.min(hi, Math.max(lo, v)); };
    const tx = (v, d, max) => (v == null ? d : String(v)).slice(0, max);
    const hx = (v, d) => (/^#[0-9a-fA-F]{6}$/.test(String(v || "")) ? String(v).toLowerCase() : d);
    const one = (list, v, d) => (list.indexOf(v) >= 0 ? v : d);
    const IMG = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;
    const LS_TYPES = ["text", "barcode", "qr", "image", "box", "ellipse", "line"];
    const LS_SYMS = ["code128", "code39", "ean13", "itf", "qr"];
    const LS_FONTS = ["arial", "times", "georgia", "calibri", "courier", "impact"];
    const LS_PAGES = ["A4", "A5", "A6", "A3", "Letter", "Legal", "custom"];
    // where a field gets its words. "field" reads it out of the ERP at print
    // time — MUST stay in step with SRC_KINDS in frontend/js/labelstudio.js,
    // because a kind missing from here is silently downgraded to "fixed" and
    // the binding is gone with no error anywhere.
    const LS_SRC = ["fixed", "date", "serial", "prompt", "field"];
    // "product.name" / "batch.number". Shape only: which fields exist is the
    // frontend's catalogue, and a binding whose field was renamed must SURVIVE
    // a save so it can be repaired, not be quietly blanked here.
    const LS_FIELD = /^[a-zA-Z][a-zA-Z0-9]{0,23}(\.[a-zA-Z][a-zA-Z0-9_]{0,23}){1,2}$/;

    const cleanObj = (o, W, H) => {
      if (!o || typeof o !== "object" || Array.isArray(o)) return null;
      const t = one(LS_TYPES, o.type, "text");
      const r = {
        id: /^o_[a-z0-9]{1,12}$/.test(String(o.id || "")) ? o.id : "o_" + Math.random().toString(36).slice(2, 9),
        type: t,
        x: dim(o.x, 0, -W, W * 2), y: dim(o.y, 0, -H, H * 2),
        w: dim(o.w, 10, 0.2, W * 3), h: dim(o.h, 10, 0.05, H * 3),
        rot: dim(o.rot, 0, -360, 360),
        // the eye in Object Layers: hidden everywhere, on screen and on the sheet
        hidden: !!o.hidden,
      };
      const s = (o.src && typeof o.src === "object") ? o.src : {};
      r.src = {
        kind: one(LS_SRC, s.kind, "fixed"),
        prefix: tx(s.prefix, "", 40), suffix: tx(s.suffix, "", 40),
        fmt: tx(s.fmt, "DD.MM.YYYY", 40),
        start: iv(s.start, 1, 0, 999999999), step: iv(s.step, 1, 1, 10000), pad: iv(s.pad, 0, 0, 12),
        prompt: tx(s.prompt, "", 40), def: tx(s.def, "", 120),
        field: LS_FIELD.test(String(s.field || "")) ? String(s.field) : "",
      };
      if (t === "text" || t === "barcode" || t === "qr") {
        r.text = tx(o.text, "", 600);
        r.font = one(LS_FONTS, o.font, "arial");
        r.size = dim(o.size, 4, 0.6, 120);
        r.color = hx(o.color, "#000000");
      }
      if (t === "text") {
        r.bold = !!o.bold; r.italic = !!o.italic;
        r.underline = !!o.underline; r.strike = !!o.strike;
        r.align = one(["left", "center", "right", "justify"], o.align, "left");
        r.valign = one(["start", "middle", "end"], o.valign, "middle");
        r.lineH = dim(o.lineH, 1.25, 0.8, 3); r.shrink = o.shrink !== false;
        // Wrap Text — off means the line runs on and is clipped by its box
        r.wrap = o.wrap !== false;
        r.tcase = one(["none", "upper", "lower", "title"], o.tcase, "none");
        // shading is written straight into a background:, so only a hex literal
        r.shade = hx(o.shade, "");
        r.indentL = dim(o.indentL, 0, 0, 200); r.indentR = dim(o.indentR, 0, 0, 200);
      }
      if (t === "barcode" || t === "qr") {
        r.sym = t === "qr" ? "qr" : one(LS_SYMS, o.sym, "code128");
        r.showText = !!o.showText;
        r.ecl = one(["L", "M", "Q", "H"], o.ecl, "M");
      }
      if (t === "image") {
        r.data = (typeof o.data === "string" && o.data.length <= 900000 && IMG.test(o.data)) ? o.data : "";
        r.fit = one(["contain", "cover", "fill"], o.fit, "contain");
      }
      if (t === "line") { r.stroke = hx(o.stroke, "#000000"); r.strokeW = dim(o.strokeW, 0.6, 0.05, 20); }
      if (t === "box" || t === "ellipse") {
        r.fill = hx(o.fill, ""); r.stroke = hx(o.stroke, "#000000");
        r.strokeW = dim(o.strokeW, 0.4, 0, 20); r.radius = dim(o.radius, 0, 0, 100);
      }
      return r;
    };

    clean.labelDocs = doc.labelDocs.slice(0, 40).map((d) => {
      d = (d && typeof d === "object" && !Array.isArray(d)) ? d : {};
      const W = dim(d.w, 100, 5, 1000), H = dim(d.h, 60, 5, 1000);
      return {
        id: /^d_[a-z0-9]{1,12}$/.test(String(d.id || "")) ? d.id : "d_" + Math.random().toString(36).slice(2, 9),
        name: tx(d.name, "Label", 60) || "Label",
        w: W, h: H,
        bg: hx(d.bg, "#ffffff"),
        /* A background PICTURE on the label itself. Same rule as a placed
           picture: a RASTER data URL only — an SVG can carry script and this
           value goes straight into a background-image. */
        bgImage: (typeof d.bgImage === "string" && d.bgImage.length <= 900000
          && IMG.test(d.bgImage)) ? d.bgImage : "",
        bgFit: one(["cover", "contain", "fill", "tile", "custom"], d.bgFit, "cover"),
        bgX: dim(d.bgX, 0, -2000, 2000), bgY: dim(d.bgY, 0, -2000, 2000),
        // 0 means "as big as the label", so it follows a change of stock
        bgW: dim(d.bgW, 0, 0, 2000), bgH: dim(d.bgH, 0, 0, 2000),
        bgOpacity: dim(d.bgOpacity, 100, 5, 100),
        // a NEW label is cut with rounded corners; a saved one keeps its own
        shape: one(["rect", "round", "ellipse"], d.shape, "round"),
        radius: dim(d.radius, 3, 0, 100),
        border: !!d.border, borderC: hx(d.borderC, "#000000"), borderW: dim(d.borderW, 0.3, 0.05, 10),
        grid: dim(d.grid, 2, 0.5, 20), snap: d.snap !== false,
        mode: d.mode === "roll" ? "roll" : "sheet",
        page: one(LS_PAGES, d.page, "A4"),
        pageW: dim(d.pageW, 210, 20, 1000), pageH: dim(d.pageH, 297, 20, 1000),
        landscape: !!d.landscape,
        mTop: dim(d.mTop, 8, 0, 200), mBottom: dim(d.mBottom, 8, 0, 200),
        mLeft: dim(d.mLeft, 8, 0, 200), mRight: dim(d.mRight, 8, 0, 200),
        gapX: dim(d.gapX, 3, 0, 100), gapY: dim(d.gapY, 3, 0, 100),
        autoFit: !!d.autoFit,
        copies: iv(d.copies, 1, 1, 500), qty: iv(d.qty, 1, 1, 5000),
        updated: tx(d.updated, "", 30),
        // when it was last opened or saved — what the Recent list sorts on
        usedAt: tx(d.usedAt, "", 40),
        objects: (Array.isArray(d.objects) ? d.objects : []).slice(0, 120)
          .map((o) => cleanObj(o, W, H)).filter(Boolean),
      };
    });
  }
  return await repo.updateSettings(clean);
}

/** Wipe and regenerate the deterministic demo dataset. */
async function reset() {
  return await repo.saveState(buildSeed());
}

function isoOf(x) {
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
}
function todayISO() { return isoOf(new Date()); }
/* an ISO date moved by n days (negative goes back), in local time like todayISO */
function addDays(iso, n) {
  const d = new Date(String(iso || todayISO()) + "T00:00:00");
  if (isNaN(d)) return iso;
  d.setDate(d.getDate() + n);
  return isoOf(d);
}
function err(msg, status) { const e = new Error(msg); e.status = status || 400; return e; }

/* ============================================================
   Granular writes — single-row updates for hot inventory paths,
   so a stock receipt / item edit no longer rewrites the ENTIRE
   dataset (faster + no last-writer-wins clobber between users).
   ============================================================ */

/** Create or update one stock item. Partial fields are merged over the
    existing row (so a PATCH never nulls out omitted columns). */
async function upsertItem(item) {
  if (!item || !item.id) throw err("Item id is required", 400);
  const existing = await repo.getItem(item.id);
  if (!existing && !item.name) throw err("New item needs a name", 400);
  const merged = existing ? Object.assign({}, existing, item) : Object.assign({}, item);
  // coerce numeric columns so a stringy "42" never lands in a REAL column
  ["cost", "price", "reorder", "safety", "lead"].forEach((k) => {
    if (merged[k] != null && merged[k] !== "") merged[k] = +merged[k] || 0;
  });
  // fail fast on a bad category instead of leaking a raw FK-violation 500
  if (merged.cat && !await repo.categoryExists(merged.cat)) throw err("Unknown category " + merged.cat, 400);
  return await repo.putItem(merged);
}

const MOVE_TYPES = ["OPEN", "GRN", "ISSUE", "PROD", "SALE", "ADJ", "RET", "SCRAP", "XFER"];

/** Append one stock movement (manual receipt / adjustment). */
/* Which way each type is allowed to point. The ledger stores an outbound
   movement as a NEGATIVE quantity, so the sign is not cosmetic — it is the
   direction. Without this check a receipt of −5000 was accepted as an
   undocumented write-off, and an "issue" of +9,000,000,000 was accepted as a
   receipt. ADJ and XFER are deliberately absent: an adjustment goes either way
   by definition, and a transfer is a signed pair. A zero is allowed through
   because creating an item posts an OPEN of 0 to mark its arrival. */
const MOVE_INBOUND = ["OPEN", "GRN", "PROD", "RET"];
const MOVE_OUTBOUND = ["ISSUE", "SALE", "SCRAP"];

async function addMovement(m) {
  if (!m || !m.itemId || !m.type) throw err("Movement needs itemId and type", 400);
  if (m.qty == null || isNaN(+m.qty)) throw err("Movement needs a numeric qty", 400);
  if (!MOVE_TYPES.includes(m.type)) throw err("Invalid movement type '" + m.type + "'", 400);
  const q = +m.qty;
  if (q < 0 && MOVE_INBOUND.includes(m.type))
    throw err("A " + m.type + " movement brings stock IN, so its quantity cannot be negative. "
      + "Use an adjustment (ADJ) to write stock off.", 400);
  if (q > 0 && MOVE_OUTBOUND.includes(m.type))
    throw err("A " + m.type + " movement takes stock OUT, so its quantity must be negative.", 400);
  const mvItem = await repo.getItem(m.itemId);
  if (!mvItem) throw err("Unknown item " + m.itemId, 400);
  /* An unknown store is not a harmless label: the stock lands at an address no
     warehouse view will ever show, so it is invisible everywhere but the raw
     ledger. */
  if (m.wh && !await repo.getWarehouse(m.wh))
    throw err("Unknown warehouse " + m.wh, 400);
  // WIP items are stage-engine plumbing — a receipt into one silently hides
  // the stock from every work order (which consumes the RAW material).
  // This actually happened: 2000 m of mica tape got booked to WIP-CP25G-08-S,
  // posted by a stale browser tab running an older Add Stock form.
  // Add Stock now offers WIP deliberately, so a receipt carrying `manual` is
  // allowed through; anything else reaching a WIP item is still refused.
  if (m.type === "GRN" && mvItem.cat === "WIP" && !m.manual) {
    throw err("Cannot receive stock into a WIP item (" + m.itemId + "). Receive the raw material itself instead.", 400);
  }
  /* A transfer is a signed pair, and the SERVER writes the pair. The browser
     used to post the two legs as separate requests and this endpoint accepted
     each leg blind — so a lone XFER row minted (or destroyed) stock, and a
     network blip between the legs stranded half a transfer. Now one request
     names both stores and both rows land in one transaction, or neither does. */
  if (m.type === "XFER") {
    if (!m.wh || !m.whTo)
      throw err("A transfer moves stock between two stores in one step — send wh (from) "
        + "and whTo (to). A lone XFER row would mint or destroy stock, so it is refused.", 400);
    if (!await repo.getWarehouse(m.whTo)) throw err("Unknown warehouse " + m.whTo, 400);
    if (m.whTo === m.wh) throw err("A transfer needs two different stores — it is already in " + m.wh + ".", 400);
    const amt = Math.abs(q);
    if (!(amt > 0)) throw err("A transfer needs a quantity greater than zero.", 400);
    const there = await repo.onHandAt(m.itemId, m.wh);
    if (amt > there + 1e-6)
      throw err("Cannot move " + amt + " " + (mvItem.uom || "") + " of " + (mvItem.name || m.itemId)
        + " out of " + m.wh + ": only " + +there.toFixed(3) + " is there.", 400);
    const date = m.date || todayISO();
    const rate = (m.rate != null && m.rate !== "") ? (+m.rate || 0) : 0;
    const out = { id: m.id || mvId(), date, itemId: m.itemId, wh: m.wh, type: "XFER",
      qty: -amt, rate, ref: m.ref || null, note: m.note || null, by: m.by || null };
    const inn = { id: m.idTo || mvId(), date, itemId: m.itemId, wh: m.whTo, type: "XFER",
      qty: amt, rate, ref: m.ref || null, note: m.noteTo || m.note || null, by: m.by || null };
    await repo.addMovements([out, inn]);
    return { ok: true, id: out.id, idTo: inn.id };
  }
  /* Stock has a floor. The sign rules above stop a receipt posing as a
     write-off, but nothing bounded the size: an ISSUE of −9,000,000,000 posted
     cleanly and the ledger read −8.99 billion with no warning anywhere. No
     physical count is negative, so no manual movement may take an item below
     zero — a ledger that overstates the shelf is corrected down TO zero (ADJ),
     never through it. */
  if (q < 0) {
    const have = await repo.onHandOf(m.itemId);
    if (-q > have + 1e-6)
      throw err("This would take " + (mvItem.name || m.itemId) + " to "
        + +(have + q).toFixed(3) + " " + (mvItem.uom || "") + ". Only " + +have.toFixed(3)
        + " is on hand, and stock cannot go below zero.", 400);
  }
  m.qty = +m.qty;
  if (m.rate != null && m.rate !== "") m.rate = +m.rate || 0;
  if (!m.id) m.id = mvId();
  if (!m.date) m.date = todayISO();
  await repo.addMovement(m);
  return { ok: true, id: m.id };
}

/* GRN numbers run in an April–March fiscal-year series: GRN/26-27/0001.
   Issued here, inside the receive path, so both receiving screens share one
   sequence and two browsers can never mint the same number. */
async function nextGrnNo(dateISO, x) {
  const [y, m] = String(dateISO).split("-").map(Number);
  const startYY = (m >= 4 ? y : y - 1) % 100;
  const fy = String(startYY).padStart(2, "0") + "-" + String((startYY + 1) % 100).padStart(2, "0");
  let max = 0;
  (await repo.getGrns(x)).forEach((g) => {
    const match = new RegExp("^GRN/" + fy + "/(\\d+)$").exec(String(g.id || ""));
    if (match) max = Math.max(max, +match[1]);
  });
  return "GRN/" + fy + "/" + String(max + 1).padStart(4, "0");
}
const strOr = (v, n) => (v == null ? "" : String(v).slice(0, n || 80));

/** Receive goods against a PO: post GRN movements, update the PO row and
    issue a numbered goods receipt note.
    body: { wh, date?, lines:[{i:lineIndex, qty, rejected?}],
            invNo?, invDate?, vehicle?, lrNo?, remarks? };
    `user` is the actor (from the auth token) so the receipt is attributed
    to a real person. Only the ACCEPTED quantity (received − rejected) posts
    to stock and advances the order — a rejected lot goes back on the truck,
    so the line stays owed; the rejection lives on the GRN for the debit note. */
/* ⚠ WHAT ARRIVED is what goes into stock — never what was ordered.
   This used to clamp the entered quantity down to whatever the line still
   had outstanding (`if (rq > pend) rq = pend`), so a supplier who delivered
   200 kg against a 156 kg order had 156 booked, silently: HTTP 200, and a
   goods receipt that read 156 as though that were what came off the truck.
   An over-delivery is a real event and the ledger has to show it.
   It must still be DELIBERATE, though. That same clamp was what made a
   replayed receipt harmless — the second copy found nothing outstanding,
   shrank to zero and was refused. With the clamp gone, a double-submitted
   request would book the delivery twice. So an over-receipt is accepted only
   when the caller says it meant one (`allowOver`), which the receiving form
   sets once the operator has been shown the excess on screen. Everything
   within the outstanding quantity is unaffected and needs no flag. */
/* ⚠ ONE TRANSACTION, and the order is read FOR UPDATE inside it.
   Receiving is a read-modify-write: it reads what is still outstanding,
   decides what to post, and writes the movements, the goods receipt and the
   order's progress. Split across three commits — which is what it used to be
   — two receipts arriving together both read the same outstanding quantity
   and both post it in full, and a failure part-way left stock in the ledger
   with the order still reading as un-received. Measured before this changed:
   two simultaneous receipts of a 100-unit order booked 200 units, 3 runs out
   of 3. The lock is what makes the second request wait and then see the first
   one's work; the single transaction is what makes the three writes land or
   vanish together. */
async function receivePurchaseOrder(poId, body, user) {
  return await repo.withTx(async (x) => receiveInTx(x, poId, body, user));
}
async function receiveInTx(x, poId, body, user) {
  body = body || {};
  const po = await repo.getPurchaseOrderForUpdate(poId, x);
  if (!po) throw err("Purchase order not found", 404);
  const wh = body.wh || "WH-PNY";
  const date = body.date || todayISO();
  const by = (user && user.username) || body.by || "user";
  const moves = [];
  const grnLines = [];
  /* Every material this receipt touches, read ONCE up front. The loop below
     is a forEach callback and so cannot await; turning it into a for…of
     would rewrite forty lines of receipt arithmetic to change nothing about
     what they compute. Reading ahead leaves that arithmetic untouched. */
  const itemById = {};
  for (const { i } of (body.lines || [])) {
    const l = po.lines[i];
    if (l && !(l.itemId in itemById)) itemById[l.itemId] = await repo.getItem(l.itemId);
  }
  const allowOver = body.allowOver === true || body.allowOver === "true";
  (body.lines || []).forEach(({ i, qty, rejected }) => {
    const l = po.lines[i];
    if (!l) return;
    const rq = +qty || 0;
    if (rq <= 0) return;
    const item0 = itemById[l.itemId] || {};
    const pend = +(l.qty - (l.recd || 0)).toFixed(3);
    const over = +(rq - Math.max(0, pend)).toFixed(3);
    if (over > 0.0001 && !allowOver) {
      const unit = BC.normUnit(l.uom || item0.uom) || "";
      throw err("Cannot receive " + rq + (unit ? " " + unit : "") + " of "
        + (item0.name || l.itemId) + " against " + po.id + ": only "
        + Math.max(0, pend) + " of the " + l.qty + " ordered is still outstanding"
        + (pend <= 0 ? " (the line is already fully received)" : "")
        + ". Confirm the over-receipt to book the extra " + over + " into stock.", 400);
    }
    let rej = +rejected || 0;
    if (rej < 0) rej = 0;
    if (rej > rq) rej = rq;
    const acc = +(rq - rej).toFixed(3);
    const item = item0;
    const from = l.uom || item.uom;
    let stockQty = acc;
    let note = "Goods receipt vs PO";
    if (acc > 0) {
      /* A roll may be ordered by length and invoiced by weight, or the other
         way round. Stock is only ever held in the material's OWN unit, so the
         received quantity is restated into it here — through the roll's fixed
         width and its GSM, which makes the figure exact rather than a guess.
         The PO line keeps its own unit; only the stock movement is converted. */
      if (BC.normUnit(from) !== BC.normUnit(item.uom)) {
        const conv = BC.convertQty(acc, from, item.uom, item);
        if (conv == null) {
          throw err("Cannot receive " + acc + " " + from + " of " + (item.name || l.itemId)
            + " — it is stocked in " + (item.uom || "?")
            + " and the two cannot be reconciled. Set the material's width and GSM, or order in "
            + (item.uom || "its stocking unit") + ".", 400);
        }
        stockQty = Math.round(conv * 1000) / 1000;
        note = "Goods receipt vs PO — " + acc + " " + BC.normUnit(from)
          + " received as " + stockQty + " " + BC.normUnit(item.uom);
      }
      /* An over-delivery is spelt out on the movement itself: the ledger is
         where someone asks "why is there more of this than we ordered?" */
      if (over > 0.0001) {
        note += " — " + over + " " + (BC.normUnit(from) || "") + " OVER the "
          + l.qty + " ordered";
      }
      moves.push({ id: mvId(), date, itemId: l.itemId, wh,
        type: "GRN", qty: stockQty, rate: l.rate || 0, ref: po.id, note,
        supplierId: po.supplierId, by });
      l.recd = +((l.recd || 0) + acc).toFixed(3);   // progress is in the ORDER's unit
    }
    grnLines.push({ itemId: l.itemId, name: item.name || l.itemId,
      uom: BC.normUnit(from) || item.uom || "", hsn: l.hsn || item.hsn || "",
      ordered: l.qty, qty: rq, rejected: rej, accepted: acc,
      over: over > 0.0001 ? over : 0,
      rate: l.rate || 0, stockQty: acc > 0 ? stockQty : 0 });
  });
  if (!grnLines.length) throw err("No quantity to receive", 400);
  const grn = {
    id: await nextGrnNo(date, x), date, poId: po.id, poDate: po.date || "",
    supplierId: po.supplierId, company: po.company || "", wh, by, status: "Posted",
    invNo: strOr(body.invNo), invDate: strOr(body.invDate, 20),
    vehicle: strOr(body.vehicle, 20), lrNo: strOr(body.lrNo, 40),
    remarks: strOr(body.remarks, 500), lines: grnLines,
  };
  if (moves.length) await repo.addMovements(moves, x);
  await repo.insertGrn(grn, x);
  po.status = po.lines.every((l) => (l.recd || 0) >= l.qty - 0.0001) ? "Received" : "Partially Received";
  await repo.putPurchaseOrder(po, x);
  return { ok: true, posted: moves.length, grn, po: { id: po.id, status: po.status, lines: po.lines } };
}

/* collision-free sequential id from the highest numeric suffix in use. */
function nextId(list, prefix) {
  let max = 0, width = 3;
  (list || []).forEach((x) => {
    const m = /(\d+)\s*$/.exec(String((x && x.id) || ""));
    if (m) { max = Math.max(max, +m[1]); width = Math.max(width, m[1].length); }
  });
  return prefix + String(max + 1).padStart(width, "0");
}
function num(v) { return v == null || v === "" || isNaN(+v) ? 0 : +v; }

/* ---- referential checks shared by both order types ----
   An order naming a party or a material that does not exist is accepted
   happily by the database (the schema declares almost no foreign keys), and
   the breakage only shows up later on a screen that cannot render it. These
   two run at the door instead. `upsertItem` already validates its category
   the same way; this is that rule applied to the orders. */
async function assertLinesReferenceRealItems(lines, what) {
  for (const l of (lines || [])) {
    const id = l && l.itemId;
    if (!id) throw err("Every " + what + " line needs a material", 400);
    if (!await repo.getItem(id)) throw err("Unknown item " + id, 400);
    if (num(l.qty) <= 0) throw err("Line quantity for " + id + " must be greater than zero", 400);
  }
}

/* ---- A PURCHASE ORDER BUYS MATERIAL ------------------------------------
   Raw material, packaging and consumables come in through the gate; work in
   process is made on the floor, and finished goods go OUT, on a sales order.
   The picker in the browser has offered raw material only since 2026-08-22,
   but the API still accepted an order for a finished good — the rule lived in
   the browser alone. It lives here now. A line an older order already carried
   keeps its item, so editing that order never trips over its own history. */
const BOUGHT_CATS = ["RM", "PKG", "CON"];   // the same list grnTestService calls PURCHASABLE
async function assertLinesAreBought(lines, existingLines) {
  const already = new Set((existingLines || []).map((l) => l && l.itemId));
  for (const l of (lines || [])) {
    if (!l || !l.itemId || already.has(l.itemId)) continue;
    const it = await repo.getItem(l.itemId);
    if (it && BOUGHT_CATS.indexOf(it.cat) < 0) {
      const what = it.cat === "FG" ? "a finished good" : it.cat === "WIP" ? "work in process" : "not a bought-in material";
      throw err("A purchase order buys raw material — " + (it.name || l.itemId) + " (" + l.itemId + ") is " + what
        + ". Finished goods are made here and sold on a sales order; work in process is never bought.", 400);
    }
  }
}

/* ---- Purchase orders (create / update / delete) ---- */
async function createPurchaseOrder(po) {
  po = po || {};
  if (!Array.isArray(po.lines) || !po.lines.length) throw err("A purchase order needs at least one line", 400);
  if (!po.supplierId) throw err("A purchase order needs a supplier", 400);
  if (!await repo.getSupplier(po.supplierId)) throw err("Unknown supplier " + po.supplierId, 400);
  await assertLinesReferenceRealItems(po.lines, "purchase order");
  await assertLinesAreBought(po.lines, []);
  if (!po.id) po.id = nextId((await repo.getState()).purchaseorders, "PO-");
  else if (await repo.getPurchaseOrder(po.id)) throw err("Purchase order " + po.id + " already exists", 409);
  po.date = po.date || todayISO();
  po.status = po.status || "Open";
  po.value = num(po.value) || po.lines.reduce((s, l) => s + num(l.qty) * num(l.rate), 0);
  return await repo.putPurchaseOrder(po);
}
/* ⚠ An order that has taken delivery of anything is CLOSED to edits.
   Receiving works out what is still outstanding from the order's own `recd`
   figures, so rewriting the lines wipes the record of what already arrived:
   the order reopens as though nothing had been delivered and the same goods
   can be booked into stock a second time. Measured before this changed: 1600
   units and two goods receipts against a 1000-unit order.
   The UI already hides its Edit button once anything is received — that check
   lived only in the browser, which is exactly why it needed to live here. */
async function assertNothingReceived(po, verb) {
  const recd = (po.lines || []).reduce((s, l) => s + num(l.recd), 0);
  if (recd > 0) {
    throw err("Cannot " + verb + " " + po.id + ": " + (+recd.toFixed(3))
      + " unit(s) have already been received against it. Raise a return or a stock "
      + "adjustment instead — editing the order would let the same delivery be booked twice.", 409);
  }
}
async function updatePurchaseOrder(id, patch) {
  const existing = await repo.getPurchaseOrder(id);
  if (!existing) throw err("Purchase order not found", 404);
  await assertNothingReceived(existing, "edit");
  const merged = Object.assign({}, existing, patch || {}, { id });
  if (!Array.isArray(merged.lines) || !merged.lines.length) throw err("A purchase order needs at least one line", 400);
  if (merged.supplierId && !await repo.getSupplier(merged.supplierId))
    throw err("Unknown supplier " + merged.supplierId, 400);
  await assertLinesReferenceRealItems(merged.lines, "purchase order");
  await assertLinesAreBought(merged.lines, existing.lines);
  return await repo.putPurchaseOrder(merged);
}
async function deletePurchaseOrder(id) {
  if (!await repo.getPurchaseOrder(id)) throw err("Purchase order not found", 404);
  return await repo.deletePurchaseOrder(id);
}

/* ---- Sales orders (create / update / delete) ---- */
/* ---- A FINISHED JOB BELONGS TO ONE ORDER ----------------------------------
   A sales line names the work order it is served from, and that number is what
   prints on the invoice as the batch. Nothing stopped a second order naming
   the same one: the picker listed every finished run whether or not an order
   had already taken it, and the server never looked at the field at all — so
   two customers could be sent the same batch number for goods that exist once.
   A batch is claimed by ONE live order, and that is the whole rule.

   ⚠ THE QUANTITY IS DELIBERATELY NOT CHECKED against what the run produced.
   An order for 500 kg against a 20 kg batch is ordinary trade: the batch says
   which goods the order is served from, the balance is made to order. An
   earlier version of this refused the excess and was wrong — it would have
   blocked every make-to-order sale. The batch is traceability, not a ceiling.

   A cancelled order claims nothing, so cancelling puts the batch back on the
   shelf. Editing an order ignores its own lines, or a line would be read as
   competing with itself. */
async function batchOwners(exceptSoId) {
  const owner = {};
  ((await repo.getState()).salesorders || []).forEach((so) => {
    if (!so || so.status === "Cancelled" || (exceptSoId && so.id === exceptSoId)) return;
    (so.lines || []).forEach((l) => { if (l && l.batch && !owner[l.batch]) owner[l.batch] = so.id; });
  });
  return owner;
}
async function assertBatchesAreFree(lines, exceptSoId) {
  const ids = [...new Set((lines || []).map((l) => l && l.batch).filter(Boolean))];
  if (!ids.length) return;
  const owner = await batchOwners(exceptSoId);
  for (const woId of ids) {
    if (!await repo.getWorkOrder(woId)) throw err("Unknown work order " + woId + " on a sales line", 400);
    if (owner[woId]) {
      throw err(woId + " is already on " + owner[woId]
        + " — raise this order against another finished job.", 409);
    }
  }
}
async function createSalesOrder(so) {
  so = so || {};
  if (!Array.isArray(so.lines) || !so.lines.length) throw err("A sales order needs at least one line", 400);
  if (!so.customerId) throw err("A sales order needs a customer", 400);
  if (!await repo.getCustomer(so.customerId)) throw err("Unknown customer " + so.customerId, 400);
  await assertLinesReferenceRealItems(so.lines, "sales order");
  await assertBatchesAreFree(so.lines, so.id);
  if (!so.id) so.id = nextId((await repo.getState()).salesorders, "SO-");
  else if (await repo.getSalesOrder(so.id)) throw err("Sales order " + so.id + " already exists", 409);
  so.date = so.date || todayISO();
  so.status = so.status || "Confirmed";
  so.priority = so.priority || "Normal";
  so.value = num(so.value) || so.lines.reduce((s, l) => s + num(l.qty) * num(l.rate), 0);
  return await repo.putSalesOrder(so);
}
/* A dispatched order has already moved stock and has an invoice printed from
   this very document, so its lines are sealed the way a received PO's are.
   Everything else about it — transporter, remarks, the paperwork fields —
   stays editable, because those are routinely filled in after the lorry goes. */
async function updateSalesOrder(id, patch) {
  const existing = await repo.getSalesOrder(id);
  if (!existing) throw err("Sales order not found", 404);
  patch = patch || {};
  if (existing.status === "Dispatched" && patch.lines
      && JSON.stringify(patch.lines) !== JSON.stringify(existing.lines || [])) {
    throw err("Cannot change the lines of " + id + ": it has been dispatched and its stock "
      + "movements and invoice are already issued against these figures.", 409);
  }
  const merged = Object.assign({}, existing, patch, { id });
  if (!Array.isArray(merged.lines) || !merged.lines.length) throw err("A sales order needs at least one line", 400);
  if (merged.customerId && !await repo.getCustomer(merged.customerId))
    throw err("Unknown customer " + merged.customerId, 400);
  await assertLinesReferenceRealItems(merged.lines, "sales order");
  await assertBatchesAreFree(merged.lines, id);
  return await repo.putSalesOrder(merged);
}
async function deleteSalesOrder(id) {
  if (!await repo.getSalesOrder(id)) throw err("Sales order not found", 404);
  return await repo.deleteSalesOrder(id);
}
/** Dispatch a sales order: post SALE (outbound) movements for every line and
    mark it Dispatched — in one shot, server-side (mirrors receivePurchaseOrder).
    `user` is the actor from the auth token. */
/* ⚠ ONE TRANSACTION, order read FOR UPDATE — same reasoning as
   receivePurchaseOrder above. The "already dispatched" check is worthless if
   it runs outside the write it guards: two dispatches arriving together both
   passed it before either wrote the status, and the order shipped twice.
   Measured before this changed: 6 shipping movements for a 3-line order.
   NOTE this deliberately does NOT check stock on hand. Dispatching into
   negative finished stock is expected here — production books nothing in
   (ruled 2026-07-30), so the ledger goes negative by design until somebody
   runs "Add to Finished Stock". Blocking it would stop real dispatches. */
/* ---- DISPATCHING A SALES ORDER ----
   Nothing is booked INTO stock anywhere in production: a run travels stage to
   stage and out of the door (the no-stock rule). So deducting finished goods
   on dispatch was taking out something that had never gone in, and the item
   went further negative with every order shipped — which is what "need 99,
   have -102" was.

   A line that names a BATCH is that work order being shipped. It is recorded
   against the WORK ORDER, where Production Control shows it, and it takes
   NOTHING out of the store.

   A line with NO batch is genuine finished stock, put there deliberately by
   "Add to Finished Stock", so that still comes out of the store — and if it
   is not there, the dispatch is REFUSED. There is no "post it anyway": a
   negative balance is not a warning, it is a wrong number that every
   valuation, reorder and ATP figure downstream then repeats. */
async function dispatchSalesOrder(soId, body, user) {
  return await repo.withTx(async (x) => {
    body = body || {};
    const so = await repo.getSalesOrderForUpdate(soId, x);
    if (!so) throw err("Sales order not found", 404);
    if (so.status === "Dispatched") throw err("Sales order already dispatched", 400);
    const date = body.date || todayISO();
    const wh = body.wh || "WH-FG";
    const by = (user && user.username) || "sales";
    const now = new Date().toISOString();
    const r3v = (n) => Math.round(n * 1000) / 1000;
    /* who it went to, read once — Production Control names the customer on the
       run, which is how the floor recognises a job it packed */
    const cust = so.customerId ? await repo.getCustomer(so.customerId, x) : null;
    const custName = (cust && cust.name) || so.customerId || null;

    const moves = [];
    const batches = [];
    for (const l of (so.lines || [])) {
      const qty = Math.abs(num(l.qty));
      if (!qty) continue;

      if (l.batch) {
        const wo = await repo.getWorkOrder(l.batch, x);
        if (!wo) throw err("Batch " + l.batch + " is no longer a work order — re-pick the batch on this line.", 400);
        /* What the run actually MADE, the same way readyBatches reads it: a
           part-served order has made only completed + on-the-floor, and an
           ordinary one made what it was raised for. The shipped figure is
           capped at that, never at the line — an order for 500 kg against a
           20 kg run is ordinary make-to-order trade and is NOT refused here
           (the batch is traceability, never a ceiling). */
        const partial = (wo.runQty != null || wo.completedQty != null || wo.pendingQty != null);
        const made = partial ? r3v(num(wo.completedQty) + num(wo.runQty)) : num(wo.qty);
        wo.dispatchedQty = Math.min(made, r3v(num(wo.dispatchedQty) + qty));
        wo.dispatchedBy = by;
        wo.dispatchedAt = now;
        wo.dispatchedTo = so.id;                       // shown in Production Control
        wo.dispatchedCustomer = custName;
        /* only an order with no balance left waiting on material is closed */
        if (num(wo.pendingQty) <= 1e-6) wo.dispatched = true;
        await repo.putWorkOrder(wo, x);
        batches.push({ batch: wo.id, qty });
        continue;
      }

      const have = await repo.onHandOf(l.itemId, x);
      if (have + 1e-6 < qty) {
        const it = await repo.getItem(l.itemId);
        throw err(
          "Not enough finished stock for " + ((it && it.name) || l.itemId) +
          " — " + qty + " needed, " + r3v(have) + " in store. Either add the finished stock first, " +
          "or pick the batch (work order) this line ships from: a batch ships the run itself and " +
          "takes nothing out of the store.", 400);
      }
      moves.push({
        id: mvId(), date, itemId: l.itemId, wh, type: "SALE",
        qty: -qty, rate: l.rate || 0, ref: so.id, note: "Dispatch vs SO", by,
      });
    }

    if (moves.length) await repo.addMovements(moves, x);
    so.status = "Dispatched";
    await repo.putSalesOrder(so, x);
    return { ok: true, posted: moves.length, fromBatches: batches.length,
             batches, so: { id: so.id, status: so.status } };
  });
}

/* ---- BOM (save recipe / delete) ---- */
async function saveBom(itemId, bom) {
  if (!itemId) throw err("BOM needs a product id", 400);
  if (!await repo.getItem(itemId)) throw err("Unknown product " + itemId, 400);
  bom = bom || {};
  if (!Array.isArray(bom.lines) || !bom.lines.length) throw err("A BOM needs at least one component", 400);
  // Normalise to the rich line shape and KEEP it. Flattening to [id, qty]
  // here would silently discard pickup %, the material's type/thickness/GSM
  // and the ranged flag on every save — i.e. lose the recipe's real content.
  // A ranged line has no single id yet (it resolves against stock at issue),
  // so it is valid as long as it carries candidate options.
  const clean = BC.normalize(bom.lines)
    .filter((l) => (l.id || (l.options && l.options.length)) && l.qty > 0);
  if (!clean.length) throw err("A BOM needs at least one component with a positive quantity", 400);
  let y = num(bom.yield) || 1;
  if (y > 1) y = y / 100;                       // accept 0-1 fraction or 1-100 percent
  y = Math.min(1, Math.max(0.01, y));
  const out = { yield: y, lines: clean };
  // alternate approved recipes (different fabric supplier) travel with the BOM
  if (Array.isArray(bom.alternates) && bom.alternates.length) {
    out.alternates = bom.alternates.map((a) => ({
      label: String(a.label || "").slice(0, 60) || "Variant",
      lines: BC.normalize(a.lines).filter((l) => (l.id || (l.options && l.options.length)) && l.qty > 0),
    })).filter((a) => a.lines.length);
  }
  return await repo.putBom(itemId, out);
}
async function deleteBom(itemId) {
  if (!await repo.getBom(itemId)) throw err("No BOM for " + itemId, 404);
  return await repo.deleteBom(itemId);
}

/* ---- CRM leads (create / update / delete) ---- */
async function createLead(lead) {
  lead = lead || {};
  if (!lead.company) throw err("A lead needs a company", 400);
  if (!lead.id) lead.id = nextId((await repo.getState()).leads, "LD-");
  else if (await repo.getLead(lead.id)) throw err("Lead " + lead.id + " already exists", 409);
  lead.stage = lead.stage || "New";
  lead.created = lead.created || todayISO();
  if (!Array.isArray(lead.activities)) lead.activities = [];
  return await repo.putLead(lead);
}
async function updateLead(id, patch, user) {
  const existing = await repo.getLead(id);
  if (!existing) throw err("Lead not found", 404);
  const merged = Object.assign({}, existing, patch || {}, { id });
  if (!merged.company) throw err("A lead needs a company", 400);
  const saved = await repo.putLead(merged);
  /* A lead closed from the CRM closes its open quotes the same way: lost
     takes the lead's reason so the "why we lost" bars count it, won closes
     them at the price on the table. Quotes already decided are left alone. */
  if (patch && (patch.stage === "Lost" || patch.stage === "Won") && patch.stage !== existing.stage) {
    await closeQuotesOfLead(merged, patch.stage, user);
  }
  return saved;
}
async function deleteLead(id) {
  if (!await repo.getLead(id)) throw err("Lead not found", 404);
  return await repo.deleteLead(id);
}

/* ---- Customer upsert (CRM Won→customer conversion) ---- */
async function upsertCustomer(cust) {
  if (!cust || !cust.id || !cust.name) throw err("Customer needs an id and name", 400);
  return await repo.putCustomer(cust);
}
async function updateCustomer(id, patch) {
  const existing = await repo.getCustomer(id);
  if (!existing) throw err("Customer not found", 404);
  const merged = Object.assign({}, existing, patch || {}, { id });
  if (!merged.name) throw err("Customer needs a name", 400);
  return await repo.putCustomer(merged);
}
async function deleteCustomer(id) {
  if (!await repo.getCustomer(id)) throw err("Customer not found", 404);
  const st = await repo.getState();
  const sos = (st.salesorders || []).filter((s) => s.customerId === id).length;
  const leads = (st.leads || []).filter((l) => l.customerId === id).length;
  if (sos) throw err(`Cannot delete: ${sos} sales order(s) reference this customer. Delete or re-point them first.`, 400);
  if (leads) throw err(`Cannot delete: ${leads} CRM lead(s) reference this customer. Delete or re-point them first.`, 400);
  return await repo.deleteCustomer(id);
}

/* ---- Suppliers (create / update / delete) ---- */
async function createSupplier(s) {
  s = s || {};
  if (!s.name) throw err("Supplier needs a name", 400);
  if (!s.id) s.id = nextId((await repo.getState()).suppliers, "SUP-");
  else if (await repo.getSupplier(s.id)) throw err("Supplier " + s.id + " already exists", 409);
  return await repo.putSupplier(s);
}
async function updateSupplier(id, patch) {
  const existing = await repo.getSupplier(id);
  if (!existing) throw err("Supplier not found", 404);
  const merged = Object.assign({}, existing, patch || {}, { id });
  if (!merged.name) throw err("Supplier needs a name", 400);
  return await repo.putSupplier(merged);
}
async function deleteSupplier(id) {
  if (!await repo.getSupplier(id)) throw err("Supplier not found", 404);
  const st = await repo.getState();
  const pos = (st.purchaseorders || []).filter((p) => p.supplierId === id).length;
  const items = (st.items || []).filter((i) => i.supplierId === id).length;
  if (pos) throw err(`Cannot delete: ${pos} purchase order(s) reference this supplier. Delete or re-point them first.`, 400);
  if (items) throw err(`Cannot delete: ${items} item(s) name this supplier as their source. Re-point them first.`, 400);
  return await repo.deleteSupplier(id);
}

/* Populate-if-empty: the two billing entities every PO/SO invoices under.
   Cable Material's identifiers come from its own printed invoice template;
   International's GSTIN is pending from the user (Settings → Invoice
   Companies shows a warning until it is filled in). */
async function ensureCompanies() {
  const org = await repo.getOrg() || {};
  if (Array.isArray(org.companies) && org.companies.length) return { changed: false, count: org.companies.length };
  const ADDRESS = "Sy. No. 18, K.G. Kuntanahalli, Kasaba Hobli, Doddaballapur Taluk, Bangalore Rural District - 561203, Karnataka, India";
  const TAGLINE = "Material Science Meets Global Demand";
  org.companies = [
    { key: "CCM", name: "Chhaperia Cable Material Pvt. Ltd.", tagline: TAGLINE,
      gstin: "29AAICC5462H1ZE", pan: "AAICC5462H", cin: "U27320KA2008PTC046773",
      iec: "AAICC5462H",
      address: ADDRESS, stateCode: "29", state: "Karnataka",
      phone: "+91 80 2763 0006", email: "info@micagroup.net", website: "www.micagroup.net",
      bank: { name: "", acName: "", acNo: "", ifsc: "", branch: "", upi: "", swift: "", address: "" }, terms: [] },
    { key: "CIC", name: "Chhaperia International Company", tagline: TAGLINE,
      gstin: "29ABIPC4133H1ZV", pan: "ABIPC4133H", cin: "",
      iec: "",
      address: ADDRESS, stateCode: "29", state: "Karnataka",
      phone: "+91 80 2763 0006", email: "info@micagroup.net", website: "www.micagroup.net",
      bank: { name: "", acName: "", acNo: "", ifsc: "", branch: "", upi: "", swift: "", address: "" }, terms: [] },
  ];
  org.tagline = org.tagline || TAGLINE;
  org.gst = org.companies[0].gstin;      // legacy single-entity fields follow the primary company
  await repo.putOrg(org);
  return { changed: true, count: org.companies.length };
}

/* ---- Org / company profile (invoice entities live in org.companies[]) ---- */
async function updateOrg(patch) {
  patch = patch || {};
  if (typeof patch !== "object" || Array.isArray(patch)) throw err("Org patch must be an object", 400);
  const merged = Object.assign({}, await repo.getOrg() || {}, patch);
  if (Array.isArray(patch.companies)) {
    merged.companies = patch.companies.map((c) => ({
      key: String(c.key || "").trim() || "CO",
      name: String(c.name || "").trim(),
      tagline: c.tagline || "",
      gstin: String(c.gstin || "").trim().toUpperCase(),
      pan: String(c.pan || "").trim().toUpperCase(),
      cin: String(c.cin || "").trim().toUpperCase(),
      iec: String(c.iec || "").trim().toUpperCase(),
      address: c.address || "",
      stateCode: String(c.stateCode || "").trim() || (String(c.gstin || "").trim().slice(0, 2) || ""),
      state: c.state || "",
      phone: c.phone || "", email: c.email || "", website: c.website || "",
      bank: {
        name: (c.bank && c.bank.name) || "",
        acName: (c.bank && c.bank.acName) || "",
        acNo: (c.bank && c.bank.acNo) || "",
        ifsc: (c.bank && c.bank.ifsc) || "",
        branch: (c.bank && c.bank.branch) || "",
        upi: (c.bank && c.bank.upi) || "",
        swift: (c.bank && c.bank.swift) || "",
        address: (c.bank && c.bank.address) || "",
      },
      terms: Array.isArray(c.terms) ? c.terms.map(String) : [],
    })).filter((c) => c.name);
  }
  return await repo.putOrg(merged);
}

/* ---- Warehouses: master-data edits (rename etc.) ---- */
async function updateWarehouse(id, patch) {
  const existing = await repo.getWarehouse(id);
  if (!existing) throw err("Warehouse not found", 404);
  const merged = Object.assign({}, existing, patch || {}, { id });
  merged.name = String(merged.name || "").trim();
  if (!merged.name) throw err("Warehouse needs a name", 400);
  return await repo.putWarehouse(merged);
}

/* ---- Appointments (calendar diary entries) ----
   Deliberately thin. An appointment is a commitment to a TIME, so a date is
   the one thing it cannot be without — everything else (who it is with, where,
   the notes) is optional and rides in the doc. The calendar's other entries are
   derived from POs, SOs, work orders and leads and never land in this table. */
const APPT_KINDS = ["Meeting", "Call", "Site Visit", "Sample Follow-up", "Payment Follow-up", "Reminder"];
async function createAppointment(a) {
  a = a || {};
  if (!a.title) throw err("An appointment needs a title", 400);
  if (!a.date) throw err("An appointment needs a date", 400);
  if (a.kind && !APPT_KINDS.includes(a.kind)) throw err("Unknown appointment kind " + a.kind, 400);
  if (!a.id) a.id = nextId((await repo.getState()).appointments, "AP-");
  else if (await repo.getAppointment(a.id)) throw err("Appointment " + a.id + " already exists", 409);
  a.kind = a.kind || "Meeting";
  a.created = a.created || todayISO();
  if (a.done == null) a.done = false;
  return await repo.putAppointment(a);
}
async function updateAppointment(id, patch) {
  const existing = await repo.getAppointment(id);
  if (!existing) throw err("Appointment not found", 404);
  const merged = Object.assign({}, existing, patch || {}, { id });
  if (!merged.title) throw err("An appointment needs a title", 400);
  if (!merged.date) throw err("An appointment needs a date", 400);
  if (merged.kind && !APPT_KINDS.includes(merged.kind)) throw err("Unknown appointment kind " + merged.kind, 400);
  return await repo.putAppointment(merged);
}
async function deleteAppointment(id) {
  if (!await repo.getAppointment(id)) throw err("Appointment not found", 404);
  return await repo.deleteAppointment(id);
}

/* ---- Complaints (a customer's problem, tied to the batch it came from) ----
   Before this a complaint was a phone call somebody remembered. Tying it to
   the batch turns an argument into a fact: the lab report for that run says
   whether the customer is right, and the sales orders that carried the same
   batch say who ELSE holds it and has not called yet. Both are DERIVED here
   from records the ERP already keeps — nothing about the spread is stored,
   so it can never disagree with the dispatches it is read from. */
const CMP_STATUS = ["Open", "Investigating", "Resolved", "Rejected"];
function normBatch(b) {
  const s = String(b || "").trim().toUpperCase();
  if (!s) return "";
  return /^WO[\s-]*\d+$/.test(s) ? "WO-" + s.replace(/^WO[\s-]*/, "").padStart(4, "0") : s;
}
async function createComplaint(c, user) {
  c = c || {};
  if (!c.customerId) throw err("A complaint needs a customer", 400);
  if (!String(c.claim || "").trim()) throw err("A complaint needs the claim — what the customer said", 400);
  const st = await repo.getState();
  if (!(st.customers || []).some((x) => x.id === c.customerId)) throw err("Customer " + c.customerId + " not found", 404);
  // nextId reads its zero-padding from the ids already present; with none it
  // falls back to three digits, so the very first complaint would be CMP-001
  // and every later one four wide. Seed the width instead.
  if (!c.id) c.id = nextId((st.complaints || []).length ? st.complaints : [{ id: "CMP-0000" }], "CMP-");
  else if (await repo.getComplaint(c.id)) throw err("Complaint " + c.id + " already exists", 409);
  c.batch = normBatch(c.batch);
  if (c.batch && !(st.workorders || []).some((w) => w.id === c.batch))
    throw err("Batch " + c.batch + " is not a work order — check the number on the label", 400);
  c.status = CMP_STATUS.includes(c.status) ? c.status : "Open";
  c.raised = c.raised || todayISO();
  c.raisedBy = c.raisedBy || (user && user.username) || "";
  c.history = [{ at: new Date().toISOString(), by: c.raisedBy, status: c.status, note: "Raised" }];
  return await repo.putComplaint(c);
}
async function updateComplaint(id, patch, user) {
  const existing = await repo.getComplaint(id);
  if (!existing) throw err("Complaint not found", 404);
  patch = patch || {};
  if (patch.status && !CMP_STATUS.includes(patch.status)) throw err("Unknown complaint status " + patch.status, 400);
  if (patch.batch != null) {
    patch.batch = normBatch(patch.batch);
    if (patch.batch && !((await repo.getState()).workorders || []).some((w) => w.id === patch.batch))
      throw err("Batch " + patch.batch + " is not a work order", 400);
  }
  const merged = Object.assign({}, existing, patch, { id });
  // every status change is a line in the history, so "who closed this and
  // when" is never a matter of memory
  if (patch.status && patch.status !== existing.status) {
    merged.history = (existing.history || []).concat([{ at: new Date().toISOString(),
      by: (user && user.username) || "", status: patch.status, note: patch.resolution || "" }]);
    if (patch.status === "Resolved" || patch.status === "Rejected") merged.closed = todayISO();
  }
  return await repo.putComplaint(merged);
}
async function deleteComplaint(id) {
  if (!await repo.getComplaint(id)) throw err("Complaint not found", 404);
  return await repo.deleteComplaint(id);
}
/** Everything the complaint screen needs about one batch: the lab reading
 *  and every sales order that shipped it. Read-only; nothing is written. */
async function batchSpread(batch) {
  batch = normBatch(batch);
  if (!batch) return { batch: "", orders: [], report: null };
  const st = await repo.getState();
  const wo = (st.workorders || []).find((w) => w.id === batch) || null;
  const custName = (id) => ((st.customers || []).find((c) => c.id === id) || {}).name || id || "";
  const orders = [];
  (st.salesorders || []).forEach((so) => {
    const qty = (so.lines || []).filter((l) => l && normBatch(l.batch) === batch)
      .reduce((s, l) => s + (+l.qty || 0), 0);
    if (qty > 0) orders.push({ soId: so.id, customerId: so.customerId, customer: custName(so.customerId),
      qty, status: so.status, date: so.date, dispatchedOn: (so.doc && so.doc.dispatchedOn) || so.dispatchedOn || null });
  });
  const complaints = (st.complaints || []).filter((c) => c.batch === batch)
    .map((c) => ({ id: c.id, customerId: c.customerId, status: c.status }));
  const lab = require("./labService");
  let report = null;
  try { report = wo ? await lab.reportForWO(wo, st.labReports) : null; } catch (e) { report = null; }
  return { batch, workOrder: wo ? { id: wo.id, itemId: wo.itemId, qty: wo.qty, status: wo.status } : null,
    orders, complaints, report };
}

/* ---- Quotations (the price offered, and the haggling that followed) ----
   A quotation here is not a tax document. It is the record of a price
   discussion: for THIS product, in THIS unit, we offered THIS rate — and
   what happened next. Every counter-offer is appended to the history and
   never overwrites the one before, so the desk can see the road from the
   first number to the last. A quote closes one of two ways, and each
   carries the figure the next person needs: Won carries the FINAL price the
   order is raised at; Lost carries the COUNTER price the customer would have
   paid, which is the only honest input to "were we too expensive". The lead
   follows the quote — Quoted while it is open, Won or Lost when it closes —
   and a lead closed from the CRM takes its open quotes with it. */
const QTN_STATUS = ["Open", "Won", "Lost"];
/* the units a price is talked in on the floor; a product's own stocking
   unit is the default, but a sqm price for a kg-stocked tape is common */
const QTN_UOMS = ["KG", "SQM", "MTR"];
/* Mirrors ENG.LOST_REASONS in frontend/js/engine.js — the chips the CRM's
   lost form offers. A reason outside the list is refused here because the
   "why we lost" bars group on it. Keep the two in step. */
const LOST_REASONS = ["Price", "Lead time", "Quality / spec", "No response", "Budget dropped", "Existing supplier", "Other"];
const r2 = (v) => Math.round(num(v) * 100) / 100;

function quoteUom(u, item) {
  const s = String(u || "").trim().toUpperCase();
  if (QTN_UOMS.includes(s)) return s;
  const iu = String((item && item.uom) || "").toUpperCase();
  return QTN_UOMS.includes(iu) ? iu : "KG";
}
/* what a quote is worth: the price times the quantity when one was talked
   about, the bare price when it was not — the lead's "quoted value" reads this */
function quoteValue(price, qty) { return num(qty) > 0 ? r2(num(price) * num(qty)) : r2(num(price)); }
function quoteText(q, price) {
  const p = price != null ? price : q.price;
  const u = String(q.uom || "").toLowerCase();
  return "₹" + num(p) + "/" + u + (num(q.qty) > 0 ? " × " + num(q.qty) + " " + u : "");
}
function stamp(by, kind, extra) {
  return Object.assign({ at: new Date().toISOString(), by: by || "", kind }, extra || {});
}
const closedLead = (l) => !l || l.stage === "Won" || l.stage === "Lost";

/* The lead mirrors its quote: the number on the chip, the stage, and a line
   in the timeline. Written straight through the DAO — never via updateLead —
   so the lead→quote cascade below cannot loop back into here. */
async function mirrorQuoteOnLead(lead, q, by, note) {
  if (!lead) return;
  lead.quotationId = q.id;
  lead.quotedValue = quoteValue(q.status === "Won" ? q.finalPrice : q.price, q.qty);
  lead.quotedPrice = q.status === "Won" ? q.finalPrice : q.price;
  lead.quotedUom = q.uom;
  lead.quoteDate = q.date;
  if (q.status === "Open" && ["New", "Contacted", "Sample"].includes(lead.stage)) lead.stage = "Quoted";
  if (!closedLead(lead)) {
    const t = todayISO();
    if (!lead.nextFollowUp || lead.nextFollowUp < t) lead.nextFollowUp = addDays(t, 3);
  }
  if (note) {
    lead.activities = lead.activities || [];
    lead.activities.push({ date: todayISO(), type: "Quotation Sent", note, by: by || lead.owner || "Sales Desk" });
  }
  await repo.putLead(lead);
}

async function createQuotation(body, user) {
  body = body || {};
  const st = await repo.getState();
  const lead = body.leadId ? (st.leads || []).find((l) => l.id === body.leadId) : null;
  if (body.leadId && !lead) throw err("Lead " + body.leadId + " not found", 404);
  const customerId = body.customerId || (lead && lead.customerId) || "";
  if (!customerId && !lead) throw err("A quotation needs a customer or a lead", 400);
  if (customerId && !(st.customers || []).some((c) => c.id === customerId)) throw err("Customer " + customerId + " not found", 404);
  const itemId = body.itemId || (lead && lead.product) || "";
  const item = (st.items || []).find((i) => i.id === itemId);
  if (!item) throw err("Pick the product being quoted", 400);
  const price = num(body.price);
  if (!(price > 0)) throw err("A quotation needs a price greater than zero", 400);
  const qty = num(body.qty);
  if (qty < 0) throw err("Quantity cannot be negative", 400);
  const by = (user && user.username) || "";
  const note = String(body.note || "").trim();
  const date = body.date || todayISO();
  const q = {
    // seeded so the very first id is four digits wide, not QTN-001
    id: nextId((st.quotations || []).length ? st.quotations : [{ id: "QTN-0000" }], "QTN-"),
    date, leadId: lead ? lead.id : "", customerId,
    company: lead ? lead.company : (((st.customers || []).find((c) => c.id === customerId) || {}).name || ""),
    itemId, productName: item.name || itemId,
    uom: quoteUom(body.uom, item), qty, price, value: quoteValue(price, qty),
    note, status: "Open", rounds: 1, lastUpdated: date, createdBy: by,
    history: [stamp(by, "quoted", { price, qty, note })],
  };
  const saved = await repo.putQuotation(q);
  if (lead) await mirrorQuoteOnLead(lead, saved, by, "Quoted " + quoteText(saved) + " — " + saved.id);
  return saved;
}

/* Edits that are not a new price: unit, quantity, note, product. A changed
   price is a round of the negotiation and is recorded as one. */
async function updateQuotation(id, patch, user) {
  const q = await repo.getQuotation(id);
  if (!q) throw err("Quotation not found", 404);
  patch = patch || {};
  const keys = Object.keys(patch).filter((k) => k !== "id");
  if (q.status !== "Open" && keys.some((k) => k !== "note")) {
    throw err(id + " is closed as " + q.status + " — reopen it to change anything but the note", 409);
  }
  const by = (user && user.username) || "";
  if (patch.itemId != null && patch.itemId !== q.itemId) {
    const item = await repo.getItem(patch.itemId);
    if (!item) throw err("Unknown item " + patch.itemId, 400);
    q.itemId = patch.itemId; q.productName = item.name || patch.itemId;
    if (patch.uom == null) q.uom = quoteUom(q.uom, item);
  }
  if (patch.uom != null) q.uom = quoteUom(patch.uom, await repo.getItem(q.itemId));
  if (patch.qty != null) { if (num(patch.qty) < 0) throw err("Quantity cannot be negative", 400); q.qty = num(patch.qty); }
  if (patch.note != null) q.note = String(patch.note).trim();
  if (patch.customerId != null) {
    if (patch.customerId && !await repo.getCustomer(patch.customerId)) throw err("Customer " + patch.customerId + " not found", 404);
    q.customerId = patch.customerId;
  }
  if (patch.price != null && num(patch.price) !== num(q.price)) return await repriceQuotation(id, { price: patch.price, note: patch.note }, user, q);
  q.value = quoteValue(q.price, q.qty);
  const saved = await repo.putQuotation(q);
  const lead = saved.leadId ? await repo.getLead(saved.leadId) : null;
  if (lead && lead.quotationId === id) await mirrorQuoteOnLead(lead, saved, by, "");
  return saved;
}

/* A new number in the same conversation. */
async function repriceQuotation(id, body, user, loaded) {
  const q = loaded || await repo.getQuotation(id);
  if (!q) throw err("Quotation not found", 404);
  if (q.status !== "Open") throw err(id + " is closed as " + q.status + " — reopen it before changing the price", 409);
  body = body || {};
  const price = num(body.price);
  if (!(price > 0)) throw err("The new price must be greater than zero", 400);
  if (body.qty != null) { if (num(body.qty) < 0) throw err("Quantity cannot be negative", 400); q.qty = num(body.qty); }
  const by = (user && user.username) || "";
  const note = String(body.note || "").trim();
  q.price = price; q.value = quoteValue(price, q.qty);
  q.rounds = num(q.rounds || 1) + 1;
  q.lastUpdated = todayISO();
  q.history = (q.history || []).concat([stamp(by, "updated", { price, qty: q.qty, note })]);
  const saved = await repo.putQuotation(q);
  const lead = saved.leadId ? await repo.getLead(saved.leadId) : null;
  if (lead) await mirrorQuoteOnLead(lead, saved, by, "Quote updated to " + quoteText(saved) + (note ? " — " + note : ""));
  return saved;
}

/* Closing a quote is what moves the lead. Won carries the final price; the
   order itself is raised by the desk (the CRM's convert step) so the human
   decides quantity and dates, not this function. */
async function winQuotation(id, body, user) {
  const q = await repo.getQuotation(id);
  if (!q) throw err("Quotation not found", 404);
  if (q.status === "Lost") throw err(id + " was lost — reopen it first", 409);
  if (q.status === "Won") return q;                       // idempotent
  body = body || {};
  if (body.finalPrice != null && num(body.finalPrice) < 0) throw err("The final price cannot be negative", 400);
  const finalPrice = num(body.finalPrice) > 0 ? num(body.finalPrice) : num(q.price);
  if (body.qty != null) { if (num(body.qty) < 0) throw err("Quantity cannot be negative", 400); q.qty = num(body.qty); }
  const by = (user && user.username) || "";
  const note = String(body.note || "").trim();
  // a quote raised against a bare lead has no customer until it is won and one
  // is created; adopt it here so the won quote can be printed and billed
  if (!q.customerId && body.customerId && await repo.getCustomer(body.customerId)) q.customerId = body.customerId;
  Object.assign(q, { status: "Won", finalPrice, wonOn: todayISO(), lastUpdated: todayISO(),
    value: quoteValue(finalPrice, q.qty),
    history: (q.history || []).concat([stamp(by, "won", { price: finalPrice, qty: q.qty, note })]) });
  const saved = await repo.putQuotation(q);
  const lead = saved.leadId ? await repo.getLead(saved.leadId) : null;
  if (lead && lead.stage !== "Lost") {
    lead.stage = "Won"; lead.nextFollowUp = null; lead.finalPrice = finalPrice;
    if (body.customerId) lead.customerId = body.customerId;
    await mirrorQuoteOnLead(lead, saved, by, "Won at " + quoteText(saved, finalPrice) + (note ? " — " + note : ""));
  }
  return saved;
}

async function loseQuotation(id, body, user) {
  const q = await repo.getQuotation(id);
  if (!q) throw err("Quotation not found", 404);
  if (q.status === "Won") throw err(id + " was won — reopen it first", 409);
  if (q.status === "Lost") return q;
  body = body || {};
  const lostReason = String(body.lostReason || "").trim();
  if (!LOST_REASONS.includes(lostReason)) throw err("Pick the reason it was lost: " + LOST_REASONS.join(", "), 400);
  if (body.counterPrice != null && num(body.counterPrice) < 0) throw err("The counter price cannot be negative", 400);
  const by = (user && user.username) || "";
  const note = String(body.note || "").trim();
  Object.assign(q, { status: "Lost", lostOn: todayISO(), lastUpdated: todayISO(),
    counterPrice: num(body.counterPrice), lostReason, lostTo: String(body.lostTo || "").trim(), lostNote: note,
    history: (q.history || []).concat([stamp(by, "lost", { price: num(body.counterPrice), note: [lostReason, body.lostTo, note].filter(Boolean).join(" · ") })]) });
  const saved = await repo.putQuotation(q);
  const lead = saved.leadId ? await repo.getLead(saved.leadId) : null;
  if (lead && !closedLead(lead)) {
    Object.assign(lead, { stage: "Lost", nextFollowUp: null, lostReason, lostTo: saved.lostTo, lostNote: note });
    await mirrorQuoteOnLead(lead, saved, by, "Lost" + (saved.counterPrice > 0 ? " against " + quoteText(saved, saved.counterPrice) : "") + " — " + lostReason);
  }
  return saved;
}

/* A mis-click is undone here; the lead goes back to Quoted only if this
   quote is the one it was closed on and no order has been raised since. */
async function reopenQuotation(id, user) {
  const q = await repo.getQuotation(id);
  if (!q) throw err("Quotation not found", 404);
  if (q.status === "Open") return q;
  const by = (user && user.username) || "";
  const was = q.status;
  Object.assign(q, { status: "Open", lastUpdated: todayISO(), value: quoteValue(q.price, q.qty),
    history: (q.history || []).concat([stamp(by, "reopened", { price: q.price, note: "was " + was })]) });
  delete q.finalPrice; delete q.wonOn; delete q.counterPrice; delete q.lostOn; delete q.lostReason; delete q.lostTo; delete q.lostNote;
  const saved = await repo.putQuotation(q);
  const lead = saved.leadId ? await repo.getLead(saved.leadId) : null;
  if (lead && lead.quotationId === id && !lead.salesOrderId && (lead.stage === "Won" || lead.stage === "Lost")) {
    lead.stage = "Quoted";
    delete lead.finalPrice; delete lead.lostReason; delete lead.lostTo; delete lead.lostNote;
    await mirrorQuoteOnLead(lead, saved, by, "Quote " + id + " reopened");
  }
  return saved;
}

async function deleteQuotation(id) {
  const q = await repo.getQuotation(id);
  if (!q) throw err("Quotation not found", 404);
  if (q.status === "Won") throw err(id + " was won — it is the record the order was raised on. Reopen it first if it was a mistake.", 409);
  const out = await repo.deleteQuotation(id);
  if (q.leadId) {
    const lead = await repo.getLead(q.leadId);
    if (lead && lead.quotationId === id) {
      delete lead.quotationId; delete lead.quotedValue; delete lead.quotedPrice; delete lead.quotedUom; delete lead.quoteDate;
      await repo.putLead(lead);
    }
  }
  return out;
}

/* The lead→quote cascade, called from updateLead: a lead closed from the CRM
   closes its open quotes the same way, at the price on the table. */
async function closeQuotesOfLead(lead, outcome, user) {
  const by = (user && user.username) || "";
  const st = await repo.getState();
  for (const q of (st.quotations || []).filter((x) => x.leadId === lead.id && x.status === "Open")) {
    if (outcome === "Won") {
      Object.assign(q, { status: "Won", finalPrice: num(q.price), wonOn: todayISO(), lastUpdated: todayISO(),
        history: (q.history || []).concat([stamp(by, "won", { price: num(q.price), note: "Lead marked won" })]) });
    } else {
      Object.assign(q, { status: "Lost", lostOn: todayISO(), lastUpdated: todayISO(), counterPrice: 0,
        lostReason: LOST_REASONS.includes(lead.lostReason) ? lead.lostReason : "Other",
        lostTo: lead.lostTo || "", lostNote: lead.lostNote || "",
        history: (q.history || []).concat([stamp(by, "lost", { price: 0, note: "Lead marked lost" + (lead.lostReason ? " · " + lead.lostReason : "") })]) });
    }
    await repo.putQuotation(q);
  }
}
/* ---- Transporters (dispatch providers) ---- */
async function createTransporter(t) {
  t = t || {};
  if (!t.name) throw err("Transporter needs a name", 400);
  if (!t.id) t.id = nextId((await repo.getState()).transporters, "TR-");
  else if (await repo.getTransporter(t.id)) throw err("Transporter " + t.id + " already exists", 409);
  if (t.active == null) t.active = true;
  return await repo.putTransporter(t);
}
async function updateTransporter(id, patch) {
  const existing = await repo.getTransporter(id);
  if (!existing) throw err("Transporter not found", 404);
  const merged = Object.assign({}, existing, patch || {}, { id });
  if (!merged.name) throw err("Transporter needs a name", 400);
  return await repo.putTransporter(merged);
}
async function deleteTransporter(id) {
  if (!await repo.getTransporter(id)) throw err("Transporter not found", 404);
  return await repo.deleteTransporter(id);
}
/** No-op. The demo transport agencies were removed on request (2026-08-05);
 *  the dispatch directory now starts empty and is filled by the user only. */
async function ensureDispatch() {
  return { changed: false, count: ((await repo.getState()).transporters || []).length };
}

/* ---- Deletes for item / work order ----
   Guarded the way deleteSupplier and deleteCustomer already are. Without this
   an item could be deleted while orders, recipes and its whole stock ledger
   still pointed at it: the frontend silently SKIPS movements whose item has
   gone, so the material's history and its valuation vanished from every report
   with no error at all, and the Sales Orders screen threw on the first line
   that named it. Nothing underneath catches this — the schema declares almost
   no foreign keys. */
async function deleteItem(id) {
  if (!await repo.getItem(id)) throw err("Item not found", 404);
  const st = await repo.getState();
  const moves = (st.movements || []).filter((m) => m.itemId === id).length;
  const pos = (st.purchaseorders || []).filter((p) => (p.lines || []).some((l) => l.itemId === id)).length;
  const sos = (st.salesorders || []).filter((s) => (s.lines || []).some((l) => l.itemId === id)).length;
  const wos = (st.workorders || []).filter((w) => w.itemId === id).length;
  const boms = Object.entries(st.boms || {})
    .filter(([k, b]) => k === id || (b.lines || []).some((l) => (Array.isArray(l) ? l[0] : l && l.id) === id)).length;
  const blocks = [
    [moves, "stock movement(s)"], [pos, "purchase order(s)"], [sos, "sales order(s)"],
    [wos, "work order(s)"], [boms, "bill(s) of materials"],
  ].filter(([n]) => n > 0).map(([n, w]) => n + " " + w);
  if (blocks.length) {
    throw err("Cannot delete " + id + ": " + blocks.join(", ") + " still reference it. "
      + "Deactivate the item instead — deleting it would erase its stock history from every report.", 400);
  }
  return await repo.deleteItem(id);
}
async function deleteWorkOrder(id) {
  if (!await repo.getWorkOrder(id)) throw err("Work order not found", 404);
  return await repo.deleteWorkOrder(id);
}

module.exports = { getState, saveState, updateSettings, reset, ensureStageModel, ensureCrm,
  upsertItem, addMovement, receivePurchaseOrder,
  createPurchaseOrder, updatePurchaseOrder, deletePurchaseOrder,
  createSalesOrder, updateSalesOrder, deleteSalesOrder, dispatchSalesOrder,
  saveBom, deleteBom, createLead, updateLead, deleteLead,
  upsertCustomer, updateCustomer, deleteCustomer,
  createSupplier, updateSupplier, deleteSupplier, updateOrg, ensureCompanies,
  deleteItem, deleteWorkOrder, nextId, updateWarehouse,
  createTransporter, updateTransporter, deleteTransporter, ensureDispatch,
  createAppointment, updateAppointment, deleteAppointment, APPT_KINDS,
  createComplaint, updateComplaint, deleteComplaint, batchSpread, CMP_STATUS,
  createQuotation, updateQuotation, repriceQuotation, winQuotation, loseQuotation, reopenQuotation, deleteQuotation,
  QTN_STATUS, QTN_UOMS, LOST_REASONS };
