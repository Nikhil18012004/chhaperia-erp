/* ============================================================
   CHHAPERIA ERP — BOM LINE MODEL + PRODUCTION MATHS
   Shared, dependency-free, and deliberately in ONE file: the
   backend `require()`s it and the browser loads it as a script,
   so the Edit-BOM screen and the server can never disagree on a
   number. Pure arithmetic — no DOM, no storage, no I/O.

   ---- Two line shapes exist in the wild -------------------
     • legacy tuple  [rawItemId, qtyPerUnitOfFG]
     • rich object   { id, rm, rmType, rmThk, rmGsm, qty, unit,
                       pickupPct, ranged, options[] }
   The rich shape arrived with the real product/BOM import: each
   line carries the material's own spec (type / thickness / GSM)
   plus its pickup %, and its qty is expressed PER BATCH rather
   than per kg of finished good.

   EVERY reader of a BOM must go through normalize() here. A bare
   object reaching an array-destructuring `([id, qty]) => …` is
   what used to make the supervisor view throw
   "object is not iterable" and return HTTP 500.

   ---- The production maths --------------------------------
   Standard batch = 1000 mm width x 1000 m length = 1000 sqm.
     fgKgPerBatch  = fgGsm x batchSqm / 1000
     consumption/sqm = qty / batchSqm
     consumption/kg  = qty / fgKgPerBatch
     pickupQty       = qty x pickupPct / 100      (coating only)
     pickupGsm       = fgGsm - SUM(fabric GSM)    (both, if 2 layers)
     totalProduction(sqm) = totalPickupQty x 1000 / pickupGsm

   Fabrics are the SUBSTRATE, not pickup: they are excluded from
   the pickup total and instead consumed by pickupGsm above.
   ============================================================ */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.BOMCALC = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* Standard production dimensions (overridable per BOM via meta). */
  var BATCH = { widthMM: 1000, lengthM: 1000 };
  var batchSqm = function (m) {
    m = m || {};
    var w = +m.batchWidthMM || BATCH.widthMM, l = +m.batchLengthM || BATCH.lengthM;
    return (w / 1000) * l;
  };

  /* ---- unit handling -------------------------------------
     The sheet mixes KG / GRAM / MG / ML / MTR (and 'Kg'). Only
     mass units can be summed; MTR is a length whose mass comes
     from its GSM, and is handled as a fabric (substrate). */
  var MASS_TO_KG = { KG: 1, GRAM: 1e-3, G: 1e-3, MG: 1e-6, ML: 1e-3 /* ~water density */ };
  function normUnit(u) {
    u = String(u == null ? "" : u).trim().toUpperCase();
    if (u === "MTRS" || u === "MTR" || u === "M" || u === "METER") return "MTR";
    if (u === "GRAMS" || u === "GM" || u === "G") return "GRAM";
    if (u === "KGS" || u === "KG") return "KG";
    return u;
  }
  function toKg(qty, unit) {
    var f = MASS_TO_KG[normUnit(unit)];
    return f == null ? null : qty * f;
  }

  /* ---- value parsing -------------------------------------
     Sheet cells use "-" for "not applicable" and express choice
     or span as "A or B", "A/B", "0.08-0.10". A ranged value is
     NOT a number: it must be resolved against real stock at
     issue time, so we keep the raw text and flag the line. */
  var RANGE_RE = /(\d\s*[-–—]\s*\d)|(\bto\b)|(\bor\b)|\//i;
  function isBlank(v) {
    if (v == null) return true;
    var s = String(v).trim();
    return s === "" || s === "-" || s === "--";
  }
  function isRanged(v) { return !isBlank(v) && RANGE_RE.test(String(v)); }

  /* ---- roll geometry: length <-> weight ------------------
     Tape and sheet are quoted by length OR by weight depending on the
     supplier, and the two convert through the roll's own width and GSM:
         kg = metres x widthMM x gsm / 1,000,000
     The width is fixed per material and the GSM is its spec, so the figure is
     exact, not an estimate. Returns null when the material does not carry
     both — nothing is guessed. */
  function kgPerMetre(item) {
    if (!item) return null;
    var gsm = numLoose(item.gsm), wmm = numLoose(item.width);
    if (gsm == null || wmm == null || gsm <= 0 || wmm <= 0) return null;
    return (wmm * gsm) / 1e6;
  }
  /* Restate `qty` from one unit into another for a sheet material. Handles
     MTR <-> KG through the roll, and plain mass conversions (g, mg) through
     toKg(). Returns null when the two units cannot be reconciled, so a caller
     can refuse rather than post a wrong quantity into stock. */
  function convertQty(qty, fromUnit, toUnit, item) {
    var q = numLoose(qty);
    if (q == null) return null;
    var a = normUnit(fromUnit), b = normUnit(toUnit);
    if (!a || !b || a === b) return q;
    var ka = toKg(1, a), kb = toKg(1, b);
    if (ka != null && kb != null) return (q * ka) / kb;   // both are masses
    var kpm = kgPerMetre(item);
    if (kpm) {
      if (a === "MTR" && kb != null) return (q * kpm) / kb;   // length -> mass
      if (b === "MTR" && ka != null) return (q * ka) / kpm;   // mass -> length
    }
    return null;
  }

  /* THICKNESS_DP — this factory measures thickness to three decimals of a
     millimetre. Anything finer is an artefact of Excel or of binary floating
     point, never a real measurement. */
  var THICKNESS_DP = 3;
  function thk3(v) {
    if (v == null || v === "") return null;
    var s = String(v).trim();
    if (isRanged(s)) return s;                 // a span stays a span
    var n = numLoose(s);
    if (n == null) return s;                   // not a number — pass it through
    return String(+n.toFixed(THICKNESS_DP));
  }
  /* Excel hands back scientific notation for small thicknesses
     ("3.3000000000000002E-2"). Missing the exponent would read that
     as 3.3 mm instead of 0.033 mm, so it is matched explicitly. */
  var NUM_RE = /-?\d+(\.\d+)?([eE][-+]?\d+)?/;
  function num(v) {
    if (isBlank(v)) return null;
    if (typeof v === "number") return isFinite(v) ? v : null;
    var s = String(v).replace(/,/g, "").trim();
    if (isRanged(s)) return null;                     // ambiguous on purpose
    var m = s.match(NUM_RE);
    return m ? parseFloat(m[0]) : null;
  }
  /* Lower bound of a ranged value, for display/estimates only. */
  function numLoose(v) {
    if (isBlank(v)) return null;
    var m = String(v).match(NUM_RE);
    return m ? parseFloat(m[0]) : null;
  }

  /* ---- pickup % defaults ---------------------------------
     What fraction of a material actually ends up in the finished
     good. Solvents and carriers flash off during coating, so
     they contribute nothing. Everything not listed defaults to
     null => the operator sets it by hand in Edit BOM. */
  var PICKUP_RULES = [
    { re: /\bCARBON\b/i,                     pct: 50 },   // paste & powder
    { re: /\bBONDEX\b/i,                     pct: 80 },
    { re: /\bSAP\b/i,                        pct: 100 },
    { re: /WATER|METHANOL|\bMEK\b|\bBPO\b|\bDC\b|\bT\s?C\b|TOLUENE|ETHYLE?\s*AC[EI]TATE|SOLVENT/i, pct: 0 },
  ];
  function defaultPickup(rmName) {
    var n = String(rmName || "");
    for (var i = 0; i < PICKUP_RULES.length; i++) if (PICKUP_RULES[i].re.test(n)) return PICKUP_RULES[i].pct;
    return null;
  }

  /* ---- line normalisation -------------------------------- */
  function normalizeLine(l) {
    if (l == null) return null;
    // legacy tuple: [rawItemId, qtyPerUnitOfFG]
    if (Array.isArray(l)) {
      var q = num(l[1]);
      return { id: l[0] || null, rm: null, rmType: null, rmThk: null, rmGsm: null,
        qty: q == null ? 0 : q, unit: "KG", pickupPct: null,
        ranged: false, rangedOn: [], options: [], layer: null, legacy: true };
    }
    if (typeof l !== "object") return null;
    var rangedOn = [];
    ["rmType", "rmThk", "rmGsm"].forEach(function (k) { if (isRanged(l[k])) rangedOn.push(k); });
    var qty = num(l.qty != null ? l.qty : (l.per != null ? l.per : l.qtyPerBatch));
    return {
      id: l.id || l.rawId || l.itemId || null,
      rm: l.rm || l.materialName || null,
      rmType: isBlank(l.rmType) ? null : String(l.rmType).trim(),
      /* Thickness is measured to three decimals and no further. Excel hands
         back "1.4999999999999999E-2" and binary arithmetic leaves tails like
         0.14000000000000001; both mean 0.015 and 0.14. Bind the value here,
         where EVERY line passes through, so the same figure reaches matching,
         costing, the screen and the printed sheet. A range ("0.08-0.10") is
         left alone — it is a span, not a measurement. */
      rmThk: isBlank(l.rmThk) ? null : thk3(l.rmThk),
      rmGsm: isBlank(l.rmGsm) ? null : String(l.rmGsm).trim(),
      qty: qty == null ? 0 : qty,
      unit: normUnit(l.unit) || "KG",
      pickupPct: l.pickupPct == null ? null : (num(l.pickupPct) || 0),
      ranged: rangedOn.length > 0 || !!l.ranged,
      rangedOn: rangedOn,
      options: Array.isArray(l.options) ? l.options.slice() : [],
      // the sheet's layer section this line belongs to (e.g. "TOP LAYER");
      // must survive normalisation or every save strips the layer grouping
      layer: isBlank(l.layer) ? null : String(l.layer).replace(/\s+/g, " ").trim(),
      legacy: false,
    };
  }
  function normalize(lines) {
    if (!lines) return [];
    var arr = Array.isArray(lines) ? lines : [];
    return arr.map(normalizeLine).filter(Boolean);
  }

  /* A fabric line is the substrate: a length (MTR) carrying a GSM.
     It is consumed by pickupGsm, never counted as pickup mass. */
  function isFabric(line) {
    return normUnit(line.unit) === "MTR" && numLoose(line.rmGsm) != null;
  }

  /* ---- the full roll-up ----------------------------------
     Returns per-line figures plus batch totals. `meta` supplies
     fgGsm (and optionally batch dimensions); without it the
     per-kg and total-production figures are simply null rather
     than a fabricated number. */
  function compute(bom, meta) {
    bom = bom || {};
    meta = meta || bom.meta || {};
    var lines = normalize(bom.lines);
    var area = batchSqm(meta);
    var fgGsm = num(meta.fgGsm);
    var fgKgPerBatch = fgGsm == null ? null : (fgGsm * area) / 1000;

    var fabricGsm = 0, fabricCount = 0;
    lines.forEach(function (l) {
      if (!isFabric(l)) return;
      var g = numLoose(l.rmGsm);
      if (g != null) { fabricGsm += g; fabricCount++; }
    });

    var totalPickupKg = 0, totalMassKg = 0, anyPickupSet = false;
    var rows = lines.map(function (l) {
      var fabric = isFabric(l);
      var kg = fabric
        ? ((numLoose(l.rmGsm) || 0) * area) / 1000            // fabric mass from its GSM
        : toKg(l.qty, l.unit);
      var pct = l.pickupPct;
      if (pct != null) anyPickupSet = true;
      var pickupKg = (!fabric && pct != null && kg != null) ? (kg * pct) / 100 : null;
      if (kg != null) totalMassKg += kg;
      if (pickupKg) totalPickupKg += pickupKg;
      return Object.assign({}, l, {
        fabric: fabric,
        massKg: kg,
        pickupQty: pickupKg,
        consumptionPerSqm: area ? l.qty / area : null,
        consumptionPerKg: fgKgPerBatch ? l.qty / fgKgPerBatch : null,
      });
    });

    /* pickup GSM — what the coating must add on top of the substrate */
    var pickupGsm = (fgGsm != null && fabricCount) ? fgGsm - fabricGsm : null;
    /* batch area cancels out: totalPickupKg / (pickupGsm*area/1000) * area */
    var totalProductionSqm = (pickupGsm && pickupGsm > 0)
      ? (totalPickupKg * 1000) / pickupGsm : null;

    return {
      lines: rows,
      batchSqm: area,
      fgGsm: fgGsm,
      fgKgPerBatch: fgKgPerBatch,
      fabricCount: fabricCount,
      fabricGsm: fabricCount ? fabricGsm : null,
      layers: fabricCount || null,
      pickupGsm: pickupGsm,
      totalQtyKg: totalMassKg,
      totalPickupQty: anyPickupSet ? totalPickupKg : null,
      totalPickupPerSqm: (anyPickupSet && area) ? totalPickupKg / area : null,
      totalPickupPerKg: (anyPickupSet && fgKgPerBatch) ? totalPickupKg / fgKgPerBatch : null,
      totalProductionSqm: totalProductionSqm,
      rangedLines: rows.filter(function (r) { return r.ranged; }).length,
    };
  }

  /* ---- ranged materials ----------------------------------
     A ranged line does not name one material: the sheet gives a
     choice ("CLOFT 912 / CLOFT 913") or a span ("0.08-0.10"). The
     real material is chosen at ISSUE time against what the store
     actually holds, so these helpers find the candidates. */
  function rangeBounds(v) {
    if (isBlank(v)) return null;
    var nums = String(v).match(/\d+(\.\d+)?/g);
    if (!nums || !nums.length) return null;
    var vals = nums.map(parseFloat);
    return { lo: Math.min.apply(null, vals), hi: Math.max.apply(null, vals) };
  }
  var norm = function (s) { return String(s == null ? "" : s).toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim(); };

  /** Candidate stock items for a BOM line, most specific rule first. */
  function candidatesFor(line, items) {
    line = normalizeLine(line) || {};
    items = items || [];
    // explicit grades already resolved at import time
    if (line.options && line.options.length) {
      var byId = {};
      items.forEach(function (i) { byId[i.id] = i; });
      return line.options.filter(function (id) { return byId[id]; });
    }
    if (!line.ranged) return line.id ? [line.id] : [];
    // otherwise match on material name, then narrow by any ranged dimension
    var want = norm(line.rm);
    var thk = isRanged(line.rmThk) ? rangeBounds(line.rmThk) : null;
    var gsm = isRanged(line.rmGsm) ? rangeBounds(line.rmGsm) : null;
    var eps = 1e-6;
    return items.filter(function (i) {
      var mat = norm(i.material || i.name);
      if (!mat || (mat.indexOf(want) < 0 && want.indexOf(mat) < 0)) return false;
      if (thk) { var t = numLoose(i.thicknessMM); if (t == null || t < thk.lo - eps || t > thk.hi + eps) return false; }
      if (gsm) { var g = numLoose(i.gsm); if (g == null || g < gsm.lo - eps || g > gsm.hi + eps) return false; }
      return true;
    }).map(function (i) { return i.id; });
  }

  /** Apply the operator's per-line material choices (index -> itemId). */
  function resolve(bom, choices) {
    var lines = normalize(bom && bom.lines);
    choices = choices || {};
    return lines.map(function (l, i) {
      var pick = choices[i] || choices[String(i)];
      return pick ? Object.assign({}, l, { id: pick, ranged: false }) : l;
    });
  }

  /* Production parameters live on the FINISHED GOOD (its GSM and batch
     dimensions), not on the recipe — so every caller derives meta the
     same way instead of hand-rolling it. */
  function metaFromItem(item) {
    // getState() flattens the stored doc onto the item, but tolerate a nested
    // `doc` too so this works on a raw repository row as well.
    var d = item || {};
    if (d.gsm == null && d.doc) d = d.doc;
    var b = d.batch || {};
    return {
      fgGsm: d.gsm != null ? d.gsm : null,
      fgThk: d.thicknessMM != null ? d.thicknessMM : null,
      batchWidthMM: b.widthMM || BATCH.widthMM,
      batchLengthM: b.lengthM || BATCH.lengthM,
      basis: d.gsm != null ? "batch" : "unit",
    };
  }

  /* ---- legacy bridge -------------------------------------
     Existing consumers (stage planning, finished-goods posting)
     want [rawItemId, qtyPerUnitOfFG]. Batch-based BOMs convert
     via fgKgPerBatch; unit-based ones pass straight through.

     ⚠ THE FIGURE THAT COMES OUT IS IN THE MATERIAL'S OWN STOCKING UNIT.
     Every caller treats it that way — it is compared against stock on hand,
     multiplied by the average cost, and posted as an ISSUE — but the line it
     comes from carries its OWN unit, and the recipe sheet mixes them: this
     factory's real BOMs hold 54 lines whose unit differs from the unit the
     material is stocked in, 36 of them "so many MG" of something kept in KG.
     Read raw, a line asking for 70 mg of methanol demanded 70 KILOGRAMS —
     a million times the truth. The store then looked hopelessly short, and a
     work order raised for 100 kg ran a few kilos and held the rest pending.
     So each line is restated into the material's unit here, which is why the
     lookup is wanted. Both a map and a function are accepted, since half the
     callers hold one and half the other.
     A pair that cannot be reconciled (no GSM or width to turn metres into
     kilos) is LEFT ALONE rather than dropped: an unconvertible line is a
     material that still has to be issued, and silently zeroing it would take
     a requirement off the shop floor altogether. */
  function toLegacy(bom, meta, choices, items) {
    bom = bom || {};
    meta = meta || bom.meta || {};
    var lines = choices ? resolve(bom, choices) : normalize(bom.lines);
    var c = compute({ lines: lines }, meta);
    var perUnitBasis = String(meta.basis || bom.basis || "").toLowerCase() === "batch" || !!c.fgKgPerBatch;
    var look = typeof items === "function"
      ? items
      : function (id) { return items ? items[id] : null; };
    return lines.map(function (l) {
      if (!l.id) return null;
      var qty = l.qty;
      var rm = look(l.id);
      var from = normUnit(l.unit), to = rm ? normUnit(rm.uom) : "";
      if (from && to && from !== to) {
        var conv = convertQty(qty, from, to, rm);
        if (conv != null) qty = conv;
      }
      var per = (perUnitBasis && c.fgKgPerBatch) ? qty / c.fgKgPerBatch : qty;
      return [l.id, per];
    }).filter(function (x) { return x && x[1] > 0; });
  }

  return {
    BATCH: BATCH, batchSqm: batchSqm,
    normUnit: normUnit, toKg: toKg,
    isBlank: isBlank, isRanged: isRanged, num: num, numLoose: numLoose,
    thk3: thk3, THICKNESS_DP: THICKNESS_DP,
    kgPerMetre: kgPerMetre, convertQty: convertQty,
    defaultPickup: defaultPickup, PICKUP_RULES: PICKUP_RULES,
    normalizeLine: normalizeLine, normalize: normalize,
    isFabric: isFabric, compute: compute, toLegacy: toLegacy,
    metaFromItem: metaFromItem,
    rangeBounds: rangeBounds, candidatesFor: candidatesFor, resolve: resolve,
  };
});
