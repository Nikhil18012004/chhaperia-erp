#!/usr/bin/env node
/* ============================================================
   CHHAPERIA ERP — TEMPORARY DEMO DATA · loader / remover
   ------------------------------------------------------------
   A throw-away layer of realistic data laid on top of the live
   database so the whole workflow — store → purchase order →
   goods receipt → work order → production stages → sales order →
   dispatch → test certificate — can be shown end to end.

     node tools/temp-demo load      build the demo layer
     node tools/temp-demo status    what is loaded right now
     node tools/temp-demo verify    re-check the loaded layer
     node tools/temp-demo remove    put the database back exactly

   HOW "PUT IT BACK EXACTLY" WORKS
   Everything this script writes goes through the ERP's own service
   layer, so the records are identical in shape to ones made in the
   browser. Before the first write it records the id of every row
   that already exists; afterwards it records the id of every row it
   created, the previous value of every field it changed, and the
   full contents of every row it moved aside. `remove` replays that
   list backwards. Nothing the user creates later is touched, and no
   feature, table or column is altered at any point.
   ============================================================ */
"use strict";

const path = require("path");
const fs = require("fs");

/* ------------------------------------------------------------
   1. SIMULATED CLOCK
   The ERP stamps "now" on everything it writes, so the demo has to
   be built with the clock set to the day each event happened —
   otherwise every purchase order, stage hand-off and dispatch would
   be dated today. This is installed BEFORE the services are loaded
   so they capture the patched Date.
   ------------------------------------------------------------ */
const RealDate = Date;
let SIM = null;                                   // ms, or null = real time

function setDay(iso, hour, minute) {
  if (!iso) { SIM = null; return; }
  const [y, m, d] = String(iso).split("-").map(Number);
  // built in LOCAL time so the service's todayISO() lands on this exact day
  SIM = new RealDate(y, m - 1, d, hour == null ? 9 : hour, minute == null ? 30 : minute, 0, 0).getTime();
}

class SimDate extends RealDate {
  constructor(...args) {
    if (args.length === 0 && SIM != null) super(SIM);
    else super(...args);
  }
  static now() { return SIM != null ? SIM : RealDate.now(); }
}
global.Date = SimDate;

/* ------------------------------------------------------------
   2. THE ERP'S OWN SERVICES (loaded after the clock is patched)
   ------------------------------------------------------------ */
const ROOT = path.join(__dirname, "..", "..");
const SRC = path.join(ROOT, "backend", "src");
const repo = require(path.join(SRC, "db", "repository"));
const erp = require(path.join(SRC, "services", "erpService"));
const production = require(path.join(SRC, "services", "productionService"));
const lab = require(path.join(SRC, "services", "labService"));
const { getDb } = require(path.join(SRC, "db", "connection"));

const C = require("./catalog");

const MANIFEST = path.join(ROOT, "data", "temp-demo-manifest.json");

/* ---- the people who do the work (the app's real logins) ---- */
const USERS = {
  admin: { username: "admin", role: "admin", area: null },
  office: { username: "office", role: "office", area: null },
  coating1: { username: "coating1", role: "supervisor", area: "coating" },
  coating2: { username: "coating2", role: "supervisor", area: "coating" },
  slitting1: { username: "slitting1", role: "supervisor", area: "slitting" },
  slitting2: { username: "slitting2", role: "supervisor", area: "slitting" },
  fiberglass: { username: "fiberglass", role: "supervisor", area: "fiberglass" },
  lab: { username: "lab", role: "lab", area: null },
};

/* ---- console helpers ---- */
const OK = "  ok  ";
const log = (s) => process.stdout.write(s + "\n");
const step = (s) => log("\n── " + s);
const r2 = (n) => Math.round((+n || 0) * 100) / 100;
const inr = (n) => "₹" + Math.round(+n || 0).toLocaleString("en-IN");

/* ------------------------------------------------------------
   3. TABLES the demo touches, and how to read / delete a row
   ------------------------------------------------------------ */
const TABLES = {
  suppliers: { sql: "suppliers", get: repo.getSupplier, del: repo.deleteSupplier },
  items: { sql: "items", get: repo.getItem, del: repo.deleteItem },
  movements: { sql: "movements" },
  purchase_orders: { sql: "purchase_orders", get: repo.getPurchaseOrder, del: repo.deletePurchaseOrder },
  sales_orders: { sql: "sales_orders", get: repo.getSalesOrder, del: repo.deleteSalesOrder },
  work_orders: { sql: "work_orders", get: repo.getWorkOrder, del: repo.deleteWorkOrder },
  lab_reports: { sql: "lab_reports", get: repo.getLabReport, del: repo.deleteLabReport },
};

function idsOf(table) {
  return getDb().prepare(`SELECT id FROM ${TABLES[table].sql}`).all().map((r) => r.id);
}
function rawRows(table) {
  return getDb().prepare(`SELECT * FROM ${TABLES[table].sql}`).all();
}

/* ------------------------------------------------------------
   4. LOAD
   ------------------------------------------------------------ */
function load() {
  if (fs.existsSync(MANIFEST)) {
    throw new Error("The demo layer is already loaded.\n" +
      "Run `node tools/temp-demo remove` first if you want to rebuild it.");
  }
  erp.getState();                                  // seed-on-empty guard, as the app does

  const before = {};
  Object.keys(TABLES).forEach((t) => { before[t] = idsOf(t); });

  const manifest = {
    tag: C.TAG,
    loadedAt: new RealDate().toISOString(),
    created: {},                                   // table -> [ids this script made]
    itemPatch: {},                                 // itemId -> previous {cost, price, uom}
    movedAside: { work_orders: [], movements: [] },// full rows taken out of the way
    summary: {},
  };
  Object.keys(TABLES).forEach((t) => { manifest.created[t] = []; });

  /* Every id is recorded AS IT IS CREATED, never worked out afterwards by
     comparing before with after. Work-order numbering restarts once the old
     test runs are moved aside, so a fresh WO-0001 would otherwise look like a
     row that had been there all along — and `remove` would leave it behind. */
  const mark = (table, id) => {
    if (id && manifest.created[table].indexOf(id) < 0) manifest.created[table].push(id);
  };

  /* ---------- 4a. move the development test data aside ---------- */
  step("Setting the development test data aside");
  manifest.movedAside.work_orders = rawRows("work_orders");
  manifest.movedAside.movements = rawRows("movements");
  const db = getDb();
  db.transaction(() => {
    db.prepare("DELETE FROM work_orders").run();
    db.prepare("DELETE FROM movements").run();
  })();
  log(`${OK}${manifest.movedAside.work_orders.length} test work orders and ` +
      `${manifest.movedAside.movements.length} scratch movements stored for restore`);

  /* ---------- 4b. suppliers named by the stock sheets ---------- */
  step("Suppliers named on the stock sheets");
  C.NEW_SUPPLIERS.forEach((s) => {
    if (repo.getSupplier(s.id)) { log(`  ..  ${s.id} already exists — left alone`); return; }
    erp.createSupplier(Object.assign({}, s, { _temp: C.TAG }));
    mark("suppliers", s.id);
    log(`${OK}${s.id}  ${s.name}`);
  });

  /* ---------- 4c. store items the sheets name ---------- */
  step("Store items the sheets name that were not in the item master");
  let madeItems = 0;
  C.NEW_ITEMS.forEach((it) => {
    if (repo.getItem(it.id)) { log(`  ..  ${it.id} already exists — left alone`); return; }
    erp.upsertItem(Object.assign({
      cat: "RM", reorder: 0, safety: 0, lead: 21, _temp: C.TAG,
    }, it));
    mark("items", it.id);
    madeItems++;
  });
  log(`${OK}${madeItems} new raw-material items created`);

  /* ---------- 4d. rates on the items the demo trades in ---------- */
  step("Putting rates on the items this demo trades in");
  const patchItem = (id, patch) => {
    const cur = repo.getItem(id);
    if (!cur) return false;
    if (!manifest.itemPatch[id]) {
      manifest.itemPatch[id] = { cost: cur.cost, price: cur.price, uom: cur.uom };
    }
    erp.upsertItem(Object.assign({ id }, patch));
    return true;
  };

  // raw-material cost comes from the price actually paid on its purchase order
  const rmCost = {};
  C.PURCHASE_ORDERS.forEach((po) => po.lines.forEach((l) => { rmCost[l.itemId] = l.rate; }));
  let rmPriced = 0;
  Object.entries(rmCost).forEach(([id, rate]) => { if (patchItem(id, { cost: rate })) rmPriced++; });
  log(`${OK}${rmPriced} raw materials costed from their purchase orders`);

  // methanol is bought and stored by weight; the master had it in milligrams
  if (repo.getItem("RM-METHANOL")) {
    patchItem("RM-METHANOL", { uom: "KG" });
    log(`${OK}RM-METHANOL unit corrected MG → KG (340 kg is in the chemical store)`);
  }

  // finished goods get a selling price, and a cost at a 32% gross margin
  let fgPriced = 0;
  Object.entries(C.FG_PRICE).forEach(([id, price]) => {
    if (patchItem(id, { price, cost: r2(price * 0.68) })) fgPriced++;
  });
  log(`${OK}${fgPriced} finished goods priced`);

  /* ---------- 4e. purchase orders + goods receipts ---------- */
  step("Purchase orders and goods receipts into the main store");
  const poIdByKey = {};
  let poValue = 0, grnLines = 0;

  const buildLines = (po) => po.lines.map((l) => {
    // mica tape is held in metres at a known GSM; the sheets count kilos
    const qty = l.kg != null ? r2(l.kg * 1000 / l.gsm) : r2(l.qty);
    const line = { itemId: l.itemId, qty, rate: l.rate, recd: 0 };
    const bits = [];
    if (l.kg != null) bits.push(`${l.kg} kg @ ${l.gsm} g/m²`);
    if (l.lot) bits.push("lot " + l.lot);
    if (l.drums) bits.push(l.drums);
    if (bits.length) line.note = bits.join(" · ");
    return line;
  });

  /* Raise a purchase order and book the whole delivery into the main store. */
  const raiseAndReceive = (spec, lines) => {
    setDay(spec.date, 10, 15);
    const created = erp.createPurchaseOrder({
      supplierId: spec.supplierId, date: spec.date, eta: spec.recv, status: "Open",
      lines, notes: spec.note, _temp: C.TAG,
    });
    mark("purchase_orders", created.id);

    /* Received one line at a time, a minute apart.
       The app builds a goods-receipt movement id from the clock plus the item
       code, so two lines for the SAME item received in the same instant would
       collide — which is exactly what a two-lot mica delivery is. Booking the
       lines in one by one is also how the store actually counts a lorry in. */
    created.lines.forEach((_, i) => {
      setDay(spec.recv, 11, i);
      erp.receivePurchaseOrder(created.id, {
        wh: "WH-PNY", date: spec.recv,
        lines: [{ i, qty: created.lines[i].qty }],
      }, USERS.office);
    });

    const after = repo.getPurchaseOrder(created.id);
    poValue += after.value || 0;
    grnLines += after.lines.length;
    log(`${OK}${after.id}  ${spec.date} → received ${spec.recv} (${spec.gap}d)  ` +
        `${after.lines.length} lines  ${inr(after.value)}  [${after.status}]`);
    return after;
  };

  C.PURCHASE_ORDERS.forEach((po) => {
    poIdByKey[po.key] = raiseAndReceive(po, buildLines(po)).id;
  });

  // one order still in transit
  setDay(C.OPEN_PURCHASE_ORDER.date, 16, 20);
  const openPo = erp.createPurchaseOrder({
    supplierId: C.OPEN_PURCHASE_ORDER.supplierId, date: C.OPEN_PURCHASE_ORDER.date,
    eta: C.OPEN_PURCHASE_ORDER.eta, status: "Open",
    lines: buildLines(C.OPEN_PURCHASE_ORDER), notes: C.OPEN_PURCHASE_ORDER.note, _temp: C.TAG,
  });
  poIdByKey[C.OPEN_PURCHASE_ORDER.key] = openPo.id;
  mark("purchase_orders", openPo.id);
  log(`${OK}${openPo.id}  ${C.OPEN_PURCHASE_ORDER.date}  still in transit, ETA ` +
      `${C.OPEN_PURCHASE_ORDER.eta}  ${inr(openPo.value)}  [Open]`);

  /* ---------- 4f. opening finished stock ---------- */
  step("Opening finished-goods stock (Finished Goods Bay)");
  setDay(C.FG_OPENING_DATE, 8, 0);
  let fgKg = 0;
  C.FG_OPENING.forEach(([id, qty]) => {
    const it = repo.getItem(id);
    if (!it) { log(`  !!  ${id} is not in the item master — skipped`); return; }
    erp.addMovement({
      date: C.FG_OPENING_DATE, itemId: id, wh: "WH-FG", type: "OPEN", qty,
      rate: it.cost || 0, ref: "OB-DEMO", note: "Opening finished stock", by: "admin",
    });
    fgKg += qty;
  });
  log(`${OK}${C.FG_OPENING.length} products, ${r2(fgKg)} kg into WH-FG on ${C.FG_OPENING_DATE}`);

  /* ---------- 4g. work orders, driven stage by stage ---------- */
  step("Work orders — released by the office, run by the floor");
  const woIdByKey = {};
  C.WORK_ORDERS.forEach((w) => {
    setDay(w.created, 9, 45);
    const body = {
      itemId: w.itemId, qty: w.qty, due: w.due, priority: w.priority,
      fgQty: w.fgQty, wipQty: 0,
    };
    if (w.widthMM != null) body.widthMM = w.widthMM;
    if (w.materialChoices) body.materialChoices = w.materialChoices;
    if (w.copperWires != null) body.copperWires = w.copperWires;

    const res = production.createWorkOrder(USERS.office, body);
    const id = res.id || res.wo.id;
    woIdByKey[w.key] = id;
    mark("work_orders", id);

    const wo = repo.getWorkOrder(id);
    const routeNames = (wo.route || []).map((r) => r.name).join(" → ");
    log(`${OK}${id}  ${w.itemId}  ${w.qty} kg  ${w.created}`);
    log(`      route: ${routeNames}`);
    if (wo.plan && wo.plan.fgQty > 0) {
      log(`      ${wo.plan.fgQty} kg taken from finished stock, ${wo.plan.makeQty} kg made`);
    }

    // drive the stages, each on its day, by the person whose area it is
    w.stages.forEach((s) => {
      setDay(s.day, s.by.startsWith("coating") ? 7 : 14, 20);
      production.advance(USERS[s.by], id, s.action);
    });
    const done = repo.getWorkOrder(id);
    log(`      → ${done.status} (${done.progress}%)  last touched by ${done.updatedBy || "—"}`);
  });

  /* ---------- 4g2. buy what the coating lines actually consumed ----------
     The five stock sheets are today's shelf count, so they list nothing that
     June's and July's runs already used up. Those runs have now been recorded
     and have drawn their fabric, paste, SAP and solvent out of the store; this
     buys it, from the right supplier, delivered before the first run.

     It is done AFTER the work orders on purpose. Where a job starts is decided
     from the store at the moment it is planned — material there, it starts at
     slitting; material short, it starts on the coating line that makes it. The
     coating jobs must therefore be planned against the sheets alone. Every
     date still reads in order: ordered 28 May, received 6 June, first run 15
     June. */
  step("Buying the material the coating lines consumed");
  {
    const onHand = {};
    (repo.getState().movements || []).forEach((mv) => {
      onHand[mv.itemId] = (onHand[mv.itemId] || 0) + (+mv.qty || 0);
    });
    const short = Object.entries(onHand)
      .filter(([, q]) => q < -0.005)
      .map(([id, q]) => ({ id, need: -q }));

    /* round up to something a buyer would actually order */
    const tidy = (n) => {
      const withBuffer = n * (1 + C.PRODUCTION_BUFFER);
      const mag = Math.pow(10, Math.max(0, String(Math.floor(withBuffer)).length - 2));
      return Math.ceil(withBuffer / mag) * mag;
    };

    const bySupplier = {};
    const unpriced = [];
    short.forEach((s) => {
      const spec = C.PRODUCTION_MATERIALS[s.id];
      if (!spec) { unpriced.push(s.id); return; }
      (bySupplier[spec.supplierId] = bySupplier[spec.supplierId] || []).push({
        itemId: s.id, qty: tidy(s.need), rate: spec.rate, recd: 0,
        note: `consumed by the June/July runs (${r2(s.need)} drawn)`,
      });
    });
    if (unpriced.length) {
      throw new Error("No price or supplier on file for material the runs consumed:\n  "
        + unpriced.join("\n  ") + "\nAdd them to PRODUCTION_MATERIALS in catalog.js.");
    }

    Object.entries(bySupplier).forEach(([supplierId, lines]) => {
      lines.sort((a, b) => (a.itemId < b.itemId ? -1 : 1));
      const po = raiseAndReceive(Object.assign({ supplierId }, C.PRODUCTION_PO), lines);
      lines.forEach((l) => { if (!repo.getItem(l.itemId).cost) patchItem(l.itemId, { cost: l.rate }); });
      poIdByKey["PROD-" + supplierId] = po.id;
    });
    log(`${OK}${short.length} materials across ${Object.keys(bySupplier).length} suppliers — ` +
        "the store no longer issues anything it never received");
  }

  /* ---------- 4h. sales orders + dispatch ---------- */
  step("Sales orders and dispatch");
  const soIdByKey = {};
  let soValue = 0, shippedKg = 0;
  C.SALES_ORDERS.forEach((so) => {
    setDay(so.date, 12, 10);
    const lines = so.lines.map((l) => {
      const line = { itemId: l.itemId, qty: l.qty, rate: l.rate };
      if (l.batch) line.batch = woIdByKey[l.batch] || l.batch;
      if (l.width != null) line.width = l.width;
      return line;
    });
    const created = erp.createSalesOrder({
      customerId: so.customerId, date: so.date, promised: so.promised,
      priority: so.priority, status: "Confirmed", lines,
      company: "CCM", invoiceType: "Tax Invoice", currency: "INR",
      transportMode: "By Road", transporterId: so.transporter || "",
      dispatchDate: so.dispatch || "", _temp: C.TAG,
    });
    soIdByKey[so.key] = created.id;
    mark("sales_orders", created.id);
    soValue += created.value || 0;

    if (so.dispatch) {
      setDay(so.dispatch, 15, 40);
      erp.dispatchSalesOrder(created.id, { date: so.dispatch, wh: "WH-FG" }, USERS.office);
      so.lines.forEach((l) => { shippedKg += l.qty; });
      log(`${OK}${created.id}  ${so.date}  ${so.customerId}  ${lines.length} lines  ` +
          `${inr(created.value)}  → dispatched ${so.dispatch}`);
    } else {
      log(`${OK}${created.id}  ${so.date}  ${so.customerId}  ${lines.length} lines  ` +
          `${inr(created.value)}  [Confirmed — not yet dispatched]`);
    }
    lines.filter((l) => l.batch).forEach((l) => log(`      batch ${l.batch} claimed for ${l.itemId}`));
  });

  /* ---------- 4i. test certificates ---------- */
  step("Test certificates (production entry, then lab)");
  const labProducts = repo.getState().labProducts || [];
  let certs = 0;
  C.LAB_REPORTS.forEach((r) => {
    const prod = labProducts.find((p) => String(p.code || "").trim().toUpperCase()
      === r.productCode.trim().toUpperCase());
    const woId = woIdByKey[r.woKey];
    if (!prod || !woId) { log(`  !!  no lab product for ${r.productCode} — skipped`); return; }
    const values = nominalValues(prod);
    if (!Object.keys(values).length) { log(`  !!  ${r.productCode} has no spec to test against — skipped`); return; }

    const floorUser = USERS[floorFor(r.woKey)];
    setDay(r.date, 13, 0);
    lab.createReport({ productId: prod.id, refNo: woId.replace(/^WO-?/, ""), woId,
      reportDate: r.date, source: "production", values,
      assignee: "lab", remarks: "Production floor reading", _temp: C.TAG }, floorUser);

    setDay(r.date, 16, 30);
    lab.createReport({ productId: prod.id, refNo: woId.replace(/^WO-?/, ""), woId,
      reportDate: r.date, source: "lab", values: nominalValues(prod, 1),
      testedBy: "Lab Incharge (QC)", remarks: "Certificate issued", _temp: C.TAG }, USERS.lab);

    const rep = (repo.getState().labReports || []).find((x) => x.productId === prod.id
      && String(x.refNo) === woId.replace(/^WO-?/, ""));
    certs++;
    log(`${OK}${rep ? rep.id : "LR"}  ${r.productCode}  batch ${woId.replace(/^WO-?/, "")}  ` +
        `→ ${rep ? rep.result : "?"}`);
  });
  log(`${OK}${certs} certificates raised`);

  /* ---------- 4j. write the manifest ---------- */
  setDay(null);
  /* Belt and braces: add anything that is present now, was not present at the
     start, and has not already been recorded. Stock movements and test
     certificates are given their ids by the services themselves, so this is
     how they get caught — while the rows recorded by hand above stay recorded
     even when their id existed before (work-order numbering restarts). */
  Object.keys(TABLES).forEach((t) => {
    const seen = new Set(before[t]);
    idsOf(t).filter((id) => !seen.has(id)).forEach((id) => mark(t, id));
  });
  /* A movement created by the demo can never be one of the rows moved aside —
     those were all deleted first — but assert it rather than assume it. */
  const asideMv = new Set(manifest.movedAside.movements.map((m) => m.id));
  const clash = manifest.created.movements.filter((id) => asideMv.has(id));
  if (clash.length) throw new Error("id clash between new and set-aside movements: " + clash.join(", "));
  manifest.summary = {
    purchaseOrders: manifest.created.purchase_orders.length,
    purchaseValue: Math.round(poValue),
    receiptLines: grnLines,
    newItems: manifest.created.items.length,
    newSuppliers: manifest.created.suppliers.length,
    itemsRepriced: Object.keys(manifest.itemPatch).length,
    fgOpeningKg: r2(fgKg),
    workOrders: manifest.created.work_orders.length,
    salesOrders: manifest.created.sales_orders.length,
    salesValue: Math.round(soValue),
    shippedKg: r2(shippedKg),
    labReports: manifest.created.lab_reports.length,
    movements: manifest.created.movements.length,
  };
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));

  step("Done");
  log(`  manifest: ${path.relative(ROOT, MANIFEST)}`);
  printSummary(manifest.summary);
  log("\n  To undo every bit of this and return the database to exactly");
  log("  the state it was in before:   node tools/temp-demo remove\n");
}

/* the supervisor who ran the last production stage of a work order */
function floorFor(woKey) {
  const w = C.WORK_ORDERS.find((x) => x.key === woKey) || {};
  const last = (w.stages || []).slice().reverse().find((s) => s.action === "complete");
  return last ? last.by : "slitting1";
}

/* A believable in-spec reading for every parameter the product is graded on.
   `jitter` nudges the lab's own reading slightly off the floor's, as two real
   measurements of the same batch would be. */
function nominalValues(prod, jitter) {
  const spec = prod.spec || {};
  const out = {};
  Object.entries(spec).forEach(([k, s]) => {
    if (!s || s.unparsed || s.directional) return;
    let v = null;
    if (s.nominal != null) v = s.nominal;
    else if (s.min != null && s.max != null) v = (s.min + s.max) / 2;
    else if (s.min != null) v = s.min * 1.15;
    else if (s.max != null) v = s.max * 0.7;
    if (v == null) return;
    if (jitter) {
      const span = (s.min != null && s.max != null) ? (s.max - s.min) * 0.12 : Math.abs(v) * 0.02;
      v = v + span;
      if (s.max != null && v > s.max) v = s.max;
      if (s.min != null && v < s.min) v = s.min;
    }
    out[k] = Math.abs(v) >= 100 ? Math.round(v) : r2(v);
  });
  return out;
}

/* ------------------------------------------------------------
   5. REMOVE — replay the manifest backwards
   ------------------------------------------------------------ */
function remove() {
  if (!fs.existsSync(MANIFEST)) {
    throw new Error("No demo layer is loaded (no manifest at " + path.relative(ROOT, MANIFEST) + ").");
  }
  const m = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  const db = getDb();
  erp.getState();

  /* Order matters: rows that reference others go first. Movements created by
     the demo are deleted explicitly rather than left to any cascade, so a row
     can never be orphaned or double-deleted. */
  const ORDER = ["lab_reports", "movements", "sales_orders", "work_orders",
    "purchase_orders", "items", "suppliers"];

  step("Deleting everything the demo created");
  const counts = {};
  db.transaction(() => {
    ORDER.forEach((t) => {
      const ids = m.created[t] || [];
      const stmt = db.prepare(`DELETE FROM ${TABLES[t].sql} WHERE id=?`);
      let n = 0;
      ids.forEach((id) => { n += stmt.run(id).changes; });
      counts[t] = n;
    });
  })();
  ORDER.forEach((t) => log(`${OK}${String(counts[t]).padStart(5)}  ${t}`));

  step("Restoring the values that were changed");
  let restored = 0;
  db.transaction(() => {
    Object.entries(m.itemPatch || {}).forEach(([id, prev]) => {
      const row = db.prepare("SELECT id FROM items WHERE id=?").get(id);
      if (!row) return;                              // item itself was a demo item
      db.prepare("UPDATE items SET cost=?, price=?, uom=? WHERE id=?")
        .run(prev.cost || 0, prev.price || 0, prev.uom || null, id);
      restored++;
    });
  })();
  log(`${OK}${restored} items put back to their previous cost / price / unit`);

  step("Putting the development test data back");
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((r) => r.name);
  let back = 0;
  db.transaction(() => {
    [["work_orders", m.movedAside.work_orders], ["movements", m.movedAside.movements]]
      .forEach(([t, rows]) => {
        if (!rows || !rows.length) return;
        const cs = cols(t);
        const stmt = db.prepare(
          `INSERT OR REPLACE INTO ${t} (${cs.join(",")}) VALUES (${cs.map((c) => "@" + c).join(",")})`);
        rows.forEach((r) => {
          const rec = {};
          cs.forEach((c) => { rec[c] = r[c] === undefined ? null : r[c]; });
          stmt.run(rec);
          back++;
        });
      });
  })();
  log(`${OK}${back} rows restored (${(m.movedAside.work_orders || []).length} work orders, ` +
      `${(m.movedAside.movements || []).length} movements)`);

  fs.unlinkSync(MANIFEST);
  step("Done");
  log("  The database is back to the state it was in before the demo was loaded.");
  log("  No feature, table or column was changed at any point.\n");
  status();
}

/* ------------------------------------------------------------
   6. STATUS / VERIFY
   ------------------------------------------------------------ */
function printSummary(s) {
  log("");
  log(`  purchase orders   ${s.purchaseOrders}  (${inr(s.purchaseValue)}, ${s.receiptLines} receipt lines)`);
  log(`  new store items   ${s.newItems}  ·  new suppliers ${s.newSuppliers}`);
  log(`  items repriced    ${s.itemsRepriced}`);
  log(`  opening FG stock  ${s.fgOpeningKg} kg`);
  log(`  work orders       ${s.workOrders}`);
  log(`  sales orders      ${s.salesOrders}  (${inr(s.salesValue)}, ${s.shippedKg} kg shipped)`);
  log(`  test certificates ${s.labReports}`);
  log(`  stock movements   ${s.movements}`);
}

function status() {
  if (!fs.existsSync(MANIFEST)) {
    log("\n  No demo layer is loaded. The database holds only its own data.\n");
    return;
  }
  const m = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  log(`\n  Demo layer loaded ${m.loadedAt}   tag ${m.tag}`);
  printSummary(m.summary);
  log("\n  Remove it with:  node tools/temp-demo remove\n");
}

function verify() {
  if (!fs.existsSync(MANIFEST)) throw new Error("Nothing loaded to verify.");
  const m = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  const data = erp.getState();
  const problems = [];

  step("Checking the loaded demo layer");

  // 1. every row the manifest claims still exists
  Object.entries(m.created).forEach(([t, ids]) => {
    const have = new Set(idsOf(t));
    const missing = ids.filter((id) => !have.has(id));
    if (missing.length) problems.push(`${t}: ${missing.length} recorded row(s) have gone missing`);
  });

  // 2. no negative stock anywhere
  const onHand = {};
  (data.movements || []).forEach((mv) => { onHand[mv.itemId] = (onHand[mv.itemId] || 0) + (+mv.qty || 0); });
  const neg = Object.entries(onHand).filter(([, q]) => q < -0.01);
  if (neg.length) {
    neg.forEach(([id, q]) => problems.push(`negative stock: ${id} = ${r2(q)}`));
  } else log(`${OK}no item is in negative stock (${Object.keys(onHand).length} items with movement)`);

  // 3. every movement points at a real item
  const itemIds = new Set((data.items || []).map((i) => i.id));
  const orphan = (data.movements || []).filter((mv) => !itemIds.has(mv.itemId));
  if (orphan.length) problems.push(`${orphan.length} movement(s) reference an unknown item`);
  else log(`${OK}every stock movement points at a real item`);

  // 4. every order line points at a real item, supplier, customer
  const supIds = new Set((data.suppliers || []).map((s) => s.id));
  const custIds = new Set((data.customers || []).map((c) => c.id));
  (data.purchaseorders || []).forEach((po) => {
    if (!supIds.has(po.supplierId)) problems.push(`${po.id} names an unknown supplier ${po.supplierId}`);
    po.lines.forEach((l) => { if (!itemIds.has(l.itemId)) problems.push(`${po.id} line ${l.itemId} is not an item`); });
  });
  (data.salesorders || []).forEach((so) => {
    if (!custIds.has(so.customerId)) problems.push(`${so.id} names an unknown customer ${so.customerId}`);
    so.lines.forEach((l) => { if (!itemIds.has(l.itemId)) problems.push(`${so.id} line ${l.itemId} is not an item`); });
  });
  log(`${OK}${(data.purchaseorders || []).length} purchase and ${(data.salesorders || []).length} sales orders reference real masters`);

  // 5. every batch claimed on a sales order is a finished, unclaimed-enough run
  const woById = Object.fromEntries((data.workorders || []).map((w) => [w.id, w]));
  const claimed = {};
  (data.salesorders || []).forEach((so) => (so.lines || []).forEach((l) => {
    if (!l.batch) return;
    claimed[l.batch] = (claimed[l.batch] || 0) + (+l.qty || 0);
    const w = woById[l.batch];
    if (!w) { problems.push(`${so.id} claims batch ${l.batch}, which is not a work order`); return; }
    if (!(w.route || []).every((r) => r.status === "Completed")) {
      problems.push(`${so.id} claims batch ${l.batch}, which has not finished production`);
    }
    if (w.itemId !== l.itemId) problems.push(`${so.id} claims batch ${l.batch} for the wrong product`);
  }));
  Object.entries(claimed).forEach(([bid, q]) => {
    const w = woById[bid];
    if (w && q > (+w.qty || 0) + 0.01) problems.push(`batch ${bid} is over-claimed (${q} of ${w.qty})`);
  });
  log(`${OK}${Object.keys(claimed).length} batch claims trace to a finished work order`);

  // 6. every purchase order is either fully received or deliberately open
  (data.purchaseorders || []).forEach((po) => {
    const recd = po.lines.every((l) => (l.recd || 0) >= l.qty - 0.001);
    if (po.status === "Received" && !recd) problems.push(`${po.id} is marked Received but has unreceived lines`);
    if (po.status === "Open" && po.lines.some((l) => (l.recd || 0) > 0)) {
      problems.push(`${po.id} is marked Open but something was received against it`);
    }
  });
  log(`${OK}purchase order statuses agree with what was received`);

  // 7. work order progress agrees with its route
  (data.workorders || []).forEach((w) => {
    const route = w.route || [];
    if (!route.length) { problems.push(`${w.id} has no route`); return; }
    const done = route.filter((r) => r.status === "Completed").length;
    if (done === route.length && w.status !== "Completed" && w.status !== "Dispatched") {
      problems.push(`${w.id} has every stage complete but reads "${w.status}"`);
    }
  });
  log(`${OK}${(data.workorders || []).length} work orders agree with their routes`);

  // 8. every PO was raised 7-10 days before its receipt
  const gaps = [];
  (data.purchaseorders || []).forEach((po) => {
    const grn = (data.movements || []).filter((mv) => mv.ref === po.id && mv.type === "GRN");
    if (!grn.length) return;
    const days = Math.round((RealDate.parse(grn[0].date) - RealDate.parse(po.date)) / 86400000);
    gaps.push(days);
    if (days < 7 || days > 10) problems.push(`${po.id} was received ${days} days after it was raised (want 7-10)`);
  });
  if (gaps.length) log(`${OK}all ${gaps.length} receipts landed ${Math.min(...gaps)}-${Math.max(...gaps)} days after the order`);

  step(problems.length ? "PROBLEMS FOUND" : "All checks passed");
  problems.forEach((p) => log("  !!  " + p));
  if (!problems.length) log("  Nothing in the demo layer is broken, orphaned or untraceable.\n");
  else { log(""); process.exitCode = 1; }
  return problems;
}

/* ------------------------------------------------------------ */
const CMD = (process.argv[2] || "status").toLowerCase();
try {
  if (CMD === "load") load();
  else if (CMD === "remove" || CMD === "clean" || CMD === "unload") remove();
  else if (CMD === "verify" || CMD === "check") verify();
  else if (CMD === "status") status();
  else {
    log("usage: node tools/temp-demo <load|status|verify|remove>");
    process.exitCode = 2;
  }
} catch (e) {
  log("\nFAILED: " + e.message);
  if (process.env.DEBUG) log(e.stack);
  process.exitCode = 1;
}
