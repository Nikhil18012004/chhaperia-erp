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
const BC = require("../../../frontend/js/bomcalc");

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
  // keep any newly-introduced work orders / products stage-ready
  S.ensureStageModel(data);
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

function todayISO() {
  const x = new Date();
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
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
  (body.lines || []).forEach(({ i, qty, rejected }) => {
    const l = po.lines[i];
    if (!l) return;
    let rq = +qty || 0;
    const pend = l.qty - (l.recd || 0);
    if (rq > pend) rq = pend;
    if (rq <= 0) return;
    let rej = +rejected || 0;
    if (rej < 0) rej = 0;
    if (rej > rq) rej = rq;
    const acc = +(rq - rej).toFixed(3);
    const item = itemById[l.itemId] || {};
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
      moves.push({ id: mvId(), date, itemId: l.itemId, wh,
        type: "GRN", qty: stockQty, rate: l.rate || 0, ref: po.id, note,
        supplierId: po.supplierId, by });
      l.recd = +((l.recd || 0) + acc).toFixed(3);   // progress is in the ORDER's unit
    }
    grnLines.push({ itemId: l.itemId, name: item.name || l.itemId,
      uom: BC.normUnit(from) || item.uom || "", hsn: l.hsn || item.hsn || "",
      ordered: l.qty, qty: rq, rejected: rej, accepted: acc,
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

/* ---- Purchase orders (create / update / delete) ---- */
async function createPurchaseOrder(po) {
  po = po || {};
  if (!Array.isArray(po.lines) || !po.lines.length) throw err("A purchase order needs at least one line", 400);
  if (!po.supplierId) throw err("A purchase order needs a supplier", 400);
  if (!await repo.getSupplier(po.supplierId)) throw err("Unknown supplier " + po.supplierId, 400);
  await assertLinesReferenceRealItems(po.lines, "purchase order");
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
  return await repo.putPurchaseOrder(merged);
}
async function deletePurchaseOrder(id) {
  if (!await repo.getPurchaseOrder(id)) throw err("Purchase order not found", 404);
  return await repo.deletePurchaseOrder(id);
}

/* ---- Sales orders (create / update / delete) ---- */
async function createSalesOrder(so) {
  so = so || {};
  if (!Array.isArray(so.lines) || !so.lines.length) throw err("A sales order needs at least one line", 400);
  if (!so.customerId) throw err("A sales order needs a customer", 400);
  if (!await repo.getCustomer(so.customerId)) throw err("Unknown customer " + so.customerId, 400);
  await assertLinesReferenceRealItems(so.lines, "sales order");
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
async function dispatchSalesOrder(soId, body, user) {
  return await repo.withTx(async (x) => {
    body = body || {};
    const so = await repo.getSalesOrderForUpdate(soId, x);
    if (!so) throw err("Sales order not found", 404);
    if (so.status === "Dispatched") throw err("Sales order already dispatched", 400);
    const date = body.date || todayISO();
    const wh = body.wh || "WH-FG";
    const by = (user && user.username) || "sales";
    const moves = (so.lines || []).map((l) => ({
      id: mvId(), date, itemId: l.itemId, wh, type: "SALE",
      qty: -Math.abs(num(l.qty)), rate: l.rate || 0, ref: so.id, note: "Dispatch vs SO", by,
    }));
    if (moves.length) await repo.addMovements(moves, x);
    so.status = "Dispatched";
    await repo.putSalesOrder(so, x);
    return { ok: true, posted: moves.length, so: { id: so.id, status: so.status } };
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
async function updateLead(id, patch) {
  const existing = await repo.getLead(id);
  if (!existing) throw err("Lead not found", 404);
  const merged = Object.assign({}, existing, patch || {}, { id });
  if (!merged.company) throw err("A lead needs a company", 400);
  return await repo.putLead(merged);
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
  createAppointment, updateAppointment, deleteAppointment, APPT_KINDS };
