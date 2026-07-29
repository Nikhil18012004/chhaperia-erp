/* ============================================================
   CHHAPERIA ERP — GST ENGINE (Indian Goods & Services Tax)
   Shared, dependency-free, loaded by the browser and require()-
   able by the backend/tests — same pattern as bomcalc.js, so the
   entry form and the printed invoice can never disagree on a tax
   figure.

   ---- The rules implemented ------------------------------
   • Every taxable line: taxable = qty × rate − discount.
   • Place of supply decides the split (IGST Act §7-8):
       intra-state (supplier state == place of supply)
             → CGST rate/2  +  SGST rate/2
       inter-state → IGST at the full rate
   • A GSTIN's first two digits ARE the state code, so party
     state is derived from it when present.
   • Freight/insurance charged on the invoice follow the tax
     treatment of a composite supply — taxed at the highest
     line rate on the invoice (CBIC guidance for freight on
     goods invoices).
   • Grand total is rounded to the nearest rupee (§170 CGST
     Act allows rounding); the ± difference is shown as Round
     Off.
   ============================================================ */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.GST = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* GST state codes (census codes used in GSTIN prefixes). */
  var STATES = [
    ["01", "Jammu & Kashmir"], ["02", "Himachal Pradesh"], ["03", "Punjab"],
    ["04", "Chandigarh"], ["05", "Uttarakhand"], ["06", "Haryana"],
    ["07", "Delhi"], ["08", "Rajasthan"], ["09", "Uttar Pradesh"],
    ["10", "Bihar"], ["11", "Sikkim"], ["12", "Arunachal Pradesh"],
    ["13", "Nagaland"], ["14", "Manipur"], ["15", "Mizoram"],
    ["16", "Tripura"], ["17", "Meghalaya"], ["18", "Assam"],
    ["19", "West Bengal"], ["20", "Jharkhand"], ["21", "Odisha"],
    ["22", "Chhattisgarh"], ["23", "Madhya Pradesh"], ["24", "Gujarat"],
    ["26", "Dadra & Nagar Haveli and Daman & Diu"], ["27", "Maharashtra"],
    ["29", "Karnataka"], ["30", "Goa"], ["31", "Lakshadweep"],
    ["32", "Kerala"], ["33", "Tamil Nadu"], ["34", "Puducherry"],
    ["35", "Andaman & Nicobar Islands"], ["36", "Telangana"],
    ["37", "Andhra Pradesh"], ["38", "Ladakh"], ["97", "Other Territory"],
  ];
  var STATE_NAME = {};
  STATES.forEach(function (s) { STATE_NAME[s[0]] = s[1]; });

  /* Standard GST rate slabs for the rate dropdowns. */
  var RATES = [0, 5, 12, 18, 28];

  var GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z][ZC][0-9A-Z]$/;
  function validGSTIN(g) { return GSTIN_RE.test(String(g || "").trim().toUpperCase()); }

  /** First two digits of a GSTIN are the state code. */
  function stateFromGSTIN(gstin) {
    var g = String(gstin || "").trim();
    var code = g.slice(0, 2);
    return STATE_NAME[code] ? code : null;
  }
  function stateName(code) { return STATE_NAME[String(code || "")] || ""; }

  function num(v) { return v == null || v === "" || isNaN(+v) ? 0 : +v; }
  function r2(v) { return Math.round(v * 100) / 100; }

  /* ---- one line ----
     {qty, rate, discPct?, gstPct?} → taxable + tax split for it. */
  function calcLine(l, interState) {
    var qty = num(l.qty), rate = num(l.rate);
    var gross = qty * rate;
    var disc = gross * num(l.discPct) / 100;
    var taxable = r2(gross - disc);
    var pct = num(l.gstPct);
    var tax = r2(taxable * pct / 100);
    return {
      qty: qty, rate: rate, discPct: num(l.discPct), gstPct: pct,
      gross: r2(gross), discount: r2(disc), taxable: taxable,
      cgst: interState ? 0 : r2(tax / 2),
      sgst: interState ? 0 : r2(tax / 2),
      igst: interState ? tax : 0,
      tax: tax,
      total: r2(taxable + tax),
    };
  }

  /* ---- the whole document ----
     opts: { lines:[{qty,rate,discPct,gstPct}], interState,
             freight?, insurance? }
     Freight/insurance are taxed at the highest line GST rate
     present (composite supply of the same goods). */
  function calcDoc(opts) {
    opts = opts || {};
    var interState = !!opts.interState;
    var rows = (opts.lines || []).map(function (l) { return calcLine(l, interState); });
    var taxable = 0, cgst = 0, sgst = 0, igst = 0, discount = 0;
    var maxPct = 0;
    rows.forEach(function (r) {
      taxable += r.taxable; discount += r.discount;
      cgst += r.cgst; sgst += r.sgst; igst += r.igst;
      if (r.gstPct > maxPct) maxPct = r.gstPct;
    });
    var freight = num(opts.freight), insurance = num(opts.insurance);
    var chargeTax = r2((freight + insurance) * maxPct / 100);
    if (interState) igst += chargeTax;
    else { cgst += chargeTax / 2; sgst += chargeTax / 2; }
    taxable = r2(taxable); cgst = r2(cgst); sgst = r2(sgst); igst = r2(igst);
    var raw = taxable + freight + insurance + cgst + sgst + igst;
    var grand = Math.round(raw);
    return {
      lines: rows,
      interState: interState,
      discount: r2(discount),
      taxable: taxable,
      freight: r2(freight), insurance: r2(insurance),
      chargesGstPct: maxPct,
      cgst: cgst, sgst: sgst, igst: igst,
      totalTax: r2(cgst + sgst + igst),
      roundOff: r2(grand - raw),
      grandTotal: grand,
    };
  }

  /* ---- amount in words (Indian numbering: crore / lakh) ---- */
  var ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
    "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
  var TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
  function two(n) { return n < 20 ? ONES[n] : (TENS[Math.floor(n / 10)] + (n % 10 ? " " + ONES[n % 10] : "")); }
  function three(n) {
    var h = Math.floor(n / 100), rest = n % 100;
    return (h ? ONES[h] + " Hundred" + (rest ? " " : "") : "") + (rest ? two(rest) : "");
  }
  function inWords(n) {
    n = Math.floor(Math.abs(n));
    if (n === 0) return "Zero";
    var parts = [];
    var crore = Math.floor(n / 1e7); n %= 1e7;
    var lakh = Math.floor(n / 1e5); n %= 1e5;
    var thousand = Math.floor(n / 1000); n %= 1000;
    if (crore) parts.push((crore > 99 ? inWords(crore) : two(crore)) + " Crore");
    if (lakh) parts.push(two(lakh) + " Lakh");
    if (thousand) parts.push(two(thousand) + " Thousand");
    if (n) parts.push(three(n));
    return parts.join(" ");
  }
  /** ₹ amount → "Rupees One Lakh Twenty Three Thousand … and Fifty Paise Only" */
  function amountInWords(amount) {
    var v = Math.abs(num(amount));
    var rupees = Math.floor(v);
    var paise = Math.round((v - rupees) * 100);
    var s = "Rupees " + inWords(rupees);
    if (paise) s += " and " + two(paise) + " Paise";
    return s + " Only";
  }

  return {
    STATES: STATES, STATE_NAME: STATE_NAME, RATES: RATES,
    validGSTIN: validGSTIN, stateFromGSTIN: stateFromGSTIN, stateName: stateName,
    calcLine: calcLine, calcDoc: calcDoc,
    amountInWords: amountInWords,
  };
});
