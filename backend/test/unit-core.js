/* ============================================================
   CHHAPERIA ERP — the shared maths, checked on their own

   gst.js, bomcalc.js and ccy.js are loaded by the browser AND
   required by the server, so a number they get wrong is wrong on
   the screen, on the printed invoice and in the ledger at once.
   Known answers first, then sweeps that look for the one case in a
   thousand. No database, no server.

     node backend/test/unit-core.js
   ============================================================ */
"use strict";
const GST = require("../../frontend/js/gst");
const BC = require("../../frontend/js/bomcalc");
const CCY = require("../../frontend/js/ccy");

let pass = 0, fail = 0;
const results = [];
let cur = "";
function section(t) { cur = t; console.log("\n" + t); }
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); } else { fail++; console.log("  ✗ " + name + (extra !== undefined ? "  — " + extra : "")); }
  results.push({ section: cur, name, ok: !!cond, detail: cond ? undefined : String(extra === undefined ? "" : extra).slice(0, 600) });
}
const near = (a, b, e) => Math.abs(a - b) < (e || 1e-9);
const J = JSON.stringify;

section("GST — GSTIN and state");
ok("a well-formed GSTIN passes", GST.validGSTIN("29AAICC5462H1ZE"));
ok("lower case and spaces are tolerated", GST.validGSTIN(" 29aaicc5462h1ze "));
ok("14 characters fail", !GST.validGSTIN("29AAICC5462H1Z"));
ok("a PAN is not a GSTIN", !GST.validGSTIN("AAICC5462H"));
/* the 15th character is a mod-36 check digit over the first 14 */
function gstinCheck(g) {
  const cs = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"; let sum = 0;
  for (let i = 0; i < 14; i++) { const p = cs.indexOf(g[i]) * (i % 2 ? 2 : 1); sum += Math.floor(p / 36) + (p % 36); }
  return cs[(36 - (sum % 36)) % 36];
}
ok("the company's own GSTIN carries a correct check digit", gstinCheck("29AAICC5462H1ZE") === "E");
ok("a GSTIN with a wrong check digit (a typo) is refused", !GST.validGSTIN("29AAICC5462H1ZX"),
  "29AAICC5462H1ZX is accepted — validGSTIN checks the shape only, never the check digit (should be " + gstinCheck("29AAICC5462H1ZX") + ")");
ok("state code 29 is Karnataka", GST.stateFromGSTIN("29AAICC5462H1ZE") === "29" && GST.stateName("29") === "Karnataka");
ok("an unknown state code gives null", GST.stateFromGSTIN("99ABCDE1234F1Z5") === null);
ok("the rate slabs are 0/5/12/18/28", J(GST.RATES) === "[0,5,12,18,28]");

section("GST — one line");
{
  const a = GST.calcLine({ qty: 10, rate: 100, gstPct: 18 }, false);
  ok("10 × ₹100 at 18%, intra-state: taxable 1000, CGST 90 + SGST 90, total 1180",
    a.taxable === 1000 && a.cgst === 90 && a.sgst === 90 && a.igst === 0 && a.total === 1180, J(a));
  const b = GST.calcLine({ qty: 10, rate: 100, gstPct: 18 }, true);
  ok("…inter-state: IGST 180", b.igst === 180 && b.cgst === 0 && b.sgst === 0, J(b));
  const c = GST.calcLine({ qty: 3, rate: 99.99, discPct: 10, gstPct: 12 }, false);
  ok("a 10% discount comes off before tax", c.taxable === 269.97 && c.tax === 32.4, J(c));
  const z = GST.calcLine({ qty: 5, rate: 40, gstPct: 0 }, false);
  ok("a 0% line carries no tax", z.tax === 0 && z.total === 200, J(z));
}

section("GST — CGST + SGST always add up to the tax (a sweep)");
{
  let bad = 0, first = null, n = 0;
  for (let paise = 1; paise <= 200000; paise += 7) {
    const l = GST.calcLine({ qty: 1, rate: paise / 100, gstPct: 18 }, false);
    n++;
    if (Math.round((l.cgst + l.sgst) * 100) !== Math.round(l.tax * 100)) { bad++; if (!first) first = J({ rate: paise / 100, tax: l.tax, cgst: l.cgst, sgst: l.sgst, total: l.total }); }
  }
  ok("on every one of " + n + " line values, CGST + SGST equals the line's tax", bad === 0,
    bad + " lines disagree by a paisa — e.g. " + first + " (the invoice's line total uses the tax, its summary uses CGST + SGST)");
  let dbad = 0, dfirst = null;
  for (let k = 1; k < 3000; k++) {
    const lines = [{ qty: 1 + (k % 7), rate: (k * 13.37) % 997 + 0.01, gstPct: 18 }, { qty: 2, rate: (k * 7.11) % 311 + 0.03, gstPct: 12 }];
    const d = GST.calcDoc({ lines, interState: false });
    const sumLines = d.lines.reduce((s, r) => s + r.total, 0);
    const docTotal = d.taxable + d.cgst + d.sgst;
    if (Math.abs(sumLines - docTotal) > 0.004) { dbad++; if (!dfirst) dfirst = J({ lines: lines.map((x) => x.rate.toFixed(2)), sumOfLineTotals: +sumLines.toFixed(2), taxablePlusTax: +docTotal.toFixed(2) }); }
  }
  ok("the sum of the line totals equals taxable + CGST + SGST on every one of 2,999 two-line invoices", dbad === 0, dbad + " invoices disagree, e.g. " + dfirst);
}

section("GST — the document");
{
  const d = GST.calcDoc({ lines: [{ qty: 10, rate: 100, gstPct: 18 }, { qty: 5, rate: 50, gstPct: 12 }], interState: false, freight: 100 });
  ok("freight is taxed at the highest line rate (18%)", d.chargesGstPct === 18, J(d));
  ok("taxable 1250, CGST 90+15+9 = 114, SGST 114", d.taxable === 1250 && d.cgst === 114 && d.sgst === 114, J({ t: d.taxable, c: d.cgst, s: d.sgst }));
  ok("grand total = 1250 + 100 + 228 = 1578, round-off 0", d.grandTotal === 1578 && d.roundOff === 0, J({ g: d.grandTotal, r: d.roundOff }));
  const e = GST.calcDoc({ lines: [{ qty: 1, rate: 100.3, gstPct: 18 }], interState: true });
  ok("the grand total rounds to the rupee and says by how much", e.grandTotal === 118 && near(e.roundOff, -0.35, 1e-9), J({ g: e.grandTotal, r: e.roundOff, igst: e.igst }));
  const empty = GST.calcDoc({});
  ok("an empty document is all zeros", empty.grandTotal === 0 && empty.totalTax === 0);
}

section("Amounts in words");
{
  ok("₹1,23,456.50", GST.amountInWords(123456.5) === "Rupees One Lakh Twenty Three Thousand Four Hundred Fifty Six and Fifty Paise Only", GST.amountInWords(123456.5));
  ok("₹1,00,00,000 is One Crore", GST.amountInWords(1e7) === "Rupees One Crore Only", GST.amountInWords(1e7));
  ok("₹0", GST.amountInWords(0) === "Rupees Zero Only");
  ok("₹1,234 crore", GST.amountInWords(12340000000) === "Rupees One Thousand Two Hundred Thirty Four Crore Only", GST.amountInWords(12340000000));
  ok("USD 18,380.29 per the doc comment", GST.amountInWordsCcy(18380.29, "USD") === "United States Dollar Eighteen Thousand Three Hundred Eighty and Cents Twenty Nine Only", GST.amountInWordsCcy(18380.29, "USD"));
  const w = GST.amountInWords(2.999);
  ok("an amount whose paise round up to 100 does not print 'undefined'", !/undefined/.test(w), w);
  ok("0.1 + 0.2 reads Thirty Paise", GST.amountInWords(0.1 + 0.2) === "Rupees Zero and Thirty Paise Only", GST.amountInWords(0.1 + 0.2));
  let bad = 0, ex = "";
  for (let p = 0; p < 100000; p += 1) { const s = GST.amountInWords(p / 100); if (/undefined|NaN/.test(s)) { bad++; ex = ex || (p / 100) + " → " + s; } }
  ok("every amount from ₹0.00 to ₹999.99 reads cleanly", bad === 0, bad + " bad, e.g. " + ex);
}

section("BOM — units and numbers");
{
  ok("MTRS/M/METER are MTR, GM/G are GRAM, KGS is KG", BC.normUnit("mtrs") === "MTR" && BC.normUnit("m") === "MTR" && BC.normUnit("Gm") === "GRAM" && BC.normUnit("kgs") === "KG");
  ok("Excel's 3.3000000000000002E-2 reads 0.033", near(BC.num("3.3000000000000002E-2"), 0.033));
  ok("a range reads as no number", BC.num("0.08-0.10") === null && BC.num("CLOFT 912 / CLOFT 913") === null);
  ok("thousands separators are ignored", BC.num("1,234.5") === 1234.5);
  ok("'-' means not applicable", BC.num("-") === null && BC.isBlank("--"));
  ok("thickness is held to 3 decimals", BC.thk3("0.14000000000000001") === "0.14" && BC.thk3("0.0151") === "0.015");
  ok("a range stays a range", BC.thk3("0.08-0.10") === "0.08-0.10");
  const roll = { gsm: 200, width: 1000 };
  ok("100 kg of a 200 gsm, 1000 mm roll is 500 m", near(BC.convertQty(100, "KG", "MTR", roll), 500));
  ok("…and 500 m is 100 kg", near(BC.convertQty(500, "MTR", "KG", roll), 100));
  ok("1000 g is 1 kg", near(BC.convertQty(1000, "GRAM", "KG"), 1));
  ok("70 mg is 0.00007 kg", near(BC.convertQty(70, "MG", "KG"), 0.00007));
  ok("metres of a roll with no GSM cannot be turned into kg (null, never a guess)", BC.convertQty(10, "MTR", "KG", { width: 1000 }) === null);
  ok("NOS cannot be turned into kg", BC.convertQty(10, "NOS", "KG", roll) === null);
  const neg = BC.num("-5");
  ok("a negative figure in a cell reads negative (so a save can refuse it)", neg === -5, J(neg));
}

section("BOM — normalising the two line shapes");
{
  const n = BC.normalize([["RM-A", "1.5"], { id: "RM-B", qty: "2", unit: "grams", rmThk: "0.1" }, null, 7]);
  ok("a tuple and an object both come out as lines; junk is dropped", n.length === 2 && n[0].qty === 1.5 && n[1].unit === "GRAM" && n[1].rmThk === "0.1", J(n));
  const r = BC.normalizeLine({ id: "RM-C", rmThk: "0.08-0.10", qty: 1 });
  ok("a ranged thickness flags the line", r.ranged === true && J(r.rangedOn) === '["rmThk"]');
  const lay = BC.normalizeLine({ id: "X", qty: 1, layer: "  TOP   LAYER " });
  ok("the layer survives and is tidied", lay.layer === "TOP LAYER");
  const res = BC.resolve({ lines: [{ id: "A", qty: 1 }, { id: "INK", qty: 1, optional: true }, { rm: "RESIN", rmGsm: "40/50", qty: 1 }] }, { 2: "RESIN-50" });
  ok("an optional line is out unless the order asks for it; a ranged pick is applied", res.length === 2 && res[1].id === "RESIN-50", J(res.map((x) => x.id)));
  const res2 = BC.resolve({ lines: [{ id: "A", qty: 1 }, { id: "INK", qty: 1, optional: true }] }, { "use:1": true });
  ok("…and in when it does", res2.length === 2);
}

section("BOM — the production maths");
{
  /* 150 gsm product on a 60 gsm fabric, 1000 m² batch: pickup GSM 90.
     50 kg of paste at 80% pickup puts 40 kg on the web → 444.44 m². */
  const c = BC.compute({ lines: [{ id: "FAB", unit: "MTR", rmGsm: "60", qty: 1000 }, { id: "PASTE", unit: "KG", qty: 50, pickupPct: 80 }] }, { fgGsm: 150 });
  ok("a 150 gsm product is 150 kg per 1000 m² batch", c.fgKgPerBatch === 150);
  ok("…the fabric is the substrate (60 gsm), pickup GSM 90", c.fabricGsm === 60 && c.pickupGsm === 90, J({ f: c.fabricGsm, p: c.pickupGsm }));
  ok("…50 kg of paste at 80% is 40 kg of pickup", near(c.totalPickupQty, 40));
  ok("…which covers 444.44 m²", near(c.totalProductionSqm, 444.4444444, 1e-6), c.totalProductionSqm);
  ok("…and paste per kg of product is 50/150", near(c.lines[1].consumptionPerKg, 1 / 3));
  const legacy = BC.toLegacy({ lines: [["RM-A", 2]] }, {}, null, null);
  ok("a recipe on a product with NO GSM is read per kg", J(legacy) === '[["RM-A",2]]', J(legacy));
  const batch = BC.toLegacy({ lines: [{ id: "RM-A", qty: 150, unit: "KG" }] }, { fgGsm: 150, basis: "batch" }, null, null);
  ok("a recipe on a product WITH a GSM is read per 1000 m² batch (150 kg per batch → 1 kg/kg)", near(batch[0][1], 1), J(batch));
  const tuple = BC.toLegacy({ lines: [["RM-A", 1]] }, { fgGsm: 150, basis: "batch" }, null, null);
  ok("…even a plain [id, qty] tuple, which the per-kg editors write, is divided by the batch (1 → 0.00667)",
    near(tuple[0][1], 1), "a tuple of 1 per kg is issued as " + tuple[0][1] + " per kg on a 150 gsm product");
  const mg = BC.toLegacy({ lines: [{ id: "MEOH", qty: 70, unit: "MG" }] }, {}, null, { MEOH: { uom: "KG" } });
  ok("70 mg of methanol stocked in KG is issued as 0.00007 kg, not 70 kg", near(mg[0][1], 0.00007), J(mg));
  const meta = BC.metaFromItem({ gsm: 120, thicknessMM: 0.2 });
  ok("metaFromItem reads the product's GSM and the standard batch", meta.fgGsm === 120 && meta.batchWidthMM === 1000 && meta.batchLengthM === 1000 && meta.basis === "batch");
  const cands = BC.candidatesFor({ rm: "Glass cloth", rmThk: "0.08-0.10", qty: 1 },
    [{ id: "G1", name: "Glass cloth", thicknessMM: 0.09 }, { id: "G2", name: "Glass cloth", thicknessMM: 0.12 }, { id: "P1", name: "Paste", thicknessMM: 0.09 }]);
  ok("a ranged line finds only the stock inside the span", J(cands) === '["G1"]', J(cands));
  ok("default pickup: carbon 50%, SAP 100%, methanol 0%, unknown null",
    BC.defaultPickup("CARBON PASTE") === 50 && BC.defaultPickup("SAP powder") === 100 && BC.defaultPickup("METHANOL") === 0 && BC.defaultPickup("Glass") === null);
}

section("Currencies and countries");
{
  ok("India invoices in INR", CCY.forCountry("India") === "INR");
  ok("Ecuador and Panama invoice in USD (dollarised)", CCY.forCountry("Ecuador") === "USD" && CCY.forCountry("Panama") === "USD");
  ok("the UAE invoices in AED", CCY.forCountry("United Arab Emirates") === "AED" || CCY.forCountry("UAE") === "AED");
  ok("INR's symbol is ₹", CCY.sym("INR") === "₹" && CCY.known("usd"));
  ok("an unknown currency is not 'known' and prints its code", !CCY.known("XYZ") && CCY.name("XYZ") === "XYZ");
  const opts = CCY.countryOptions();
  ok("the country picker lists 150+ countries, each with a currency", opts.length >= 150 && opts.every((o) => /—/.test(o.l)), opts.length);
}

console.log("\n" + (fail === 0 ? "PASS" : "FAIL") + " — " + pass + " passed, " + fail + " failed\n");
if (process.env.AUDIT_OUT) require("fs").writeFileSync(process.env.AUDIT_OUT, J({ suite: "unit_core", pass, fail, results }, null, 1));
process.exit(fail === 0 ? 0 : 1);
