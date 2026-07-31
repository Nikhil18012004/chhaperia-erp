/* ============================================================
   CHHAPERIA ERP — TEMPORARY DEMO DATASET  (load / purge)

   Builds a complete, presentable workflow on top of the REAL product
   master, from the physical stock counts in the storeroom spreadsheets:

     physical stock  -> receipts into the MAIN STORE (WH-PNY)
     purchase orders -> raised 7-10 days BEFORE each receipt, then received
     finished goods  -> booked into the main store (>= 5000 kg)
     sales orders    -> spread over the last two months, ~3000 kg drawn
     work orders     -> full route, part-finished, and short-route jobs,
                        each stage stamped with the login that does it

   EVERYTHING it writes is tagged `demo: <TAG>` in its doc JSON *and*
   listed in data/demo-manifest.json. `--purge` removes exactly those
   rows and nothing else, returning the database to its previous state.
   Records that already existed are never modified, only referenced.

   Usage:
     node tools/demo-data.js --load [--dry]
     node tools/demo-data.js --purge
     node tools/demo-data.js --status
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");
const Database = require("better-sqlite3");

const ROOT = path.join(__dirname, "..");
const DB_FILE = process.env.CHHAPERIA_DB_FILE || path.join(ROOT, "data", "chhaperia.db");
const MANIFEST = path.join(ROOT, "data", "demo-manifest.json");
const TAG = "DEMO-DATASET";
const STORE = "WH-PNY";                 // "main store."
const ARGS = process.argv.slice(2);
const DRY = ARGS.includes("--dry");

const SOURCE_FILES = [
  "U2 ground store data.xlsx",
  "Chemical_store data.xlsx",
  "SUBU MICA(AutoRecovered).xlsx",
  "fabric stock.xlsx",
  "U2 BASEMENT STOCK.xlsx",
].map((f) => path.join(os.homedir(), "Downloads", f));

/* ============================================================
   1. XLSX READER (a .xlsx is a zip of XML — no dependency needed)
   ============================================================ */
function unzipTo(src, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  const zip = path.join(dest, "_book.zip");
  fs.copyFileSync(src, zip);
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${dest.replace(/'/g, "''")}' -Force`],
    { stdio: "pipe" });
  return dest;
}
const unesc = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (m, d) => String.fromCharCode(+d)).replace(/&amp;/g, "&");
const tText = (frag) => (frag.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || [])
  .map((t) => unesc(t.replace(/<t[^>]*>/, "").replace(/<\/t>/, ""))).join("");

function readSheets(file) {
  const dir = unzipTo(file, path.join(os.tmpdir(), "chh-demo-" + path.basename(file).replace(/\W+/g, "_")));
  const ssPath = path.join(dir, "xl", "sharedStrings.xml");
  const SS = fs.existsSync(ssPath)
    ? (fs.readFileSync(ssPath, "utf8").match(/<si>[\s\S]*?<\/si>/g) || []).map(tText) : [];
  const wsDir = path.join(dir, "xl", "worksheets");
  const colIdx = (ref) => {
    let n = 0; for (const ch of ref.match(/^([A-Z]+)/)[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  };
  return fs.readdirSync(wsDir).filter((f) => /^sheet\d+\.xml$/.test(f))
    .sort((a, b) => +a.match(/\d+/)[0] - +b.match(/\d+/)[0])
    .map((f) => {
      const xml = fs.readFileSync(path.join(wsDir, f), "utf8");
      const rows = [];
      const rowRe = /<row[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
      let rm;
      while ((rm = rowRe.exec(xml))) {
        const cells = [];
        const cRe = /<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
        let cm;
        while ((cm = cRe.exec(rm[2]))) {
          const attrs = cm[1], inner = cm[2] || "";
          const ref = (attrs.match(/r="([A-Z]+\d+)"/) || [])[1];
          if (!ref) continue;
          const t = (attrs.match(/t="([^"]*)"/) || [])[1];
          let v = null;
          if (t === "inlineStr") v = tText(inner);
          else { const vm = inner.match(/<v>([\s\S]*?)<\/v>/); if (vm) v = t === "s" ? (SS[+vm[1]] ?? "") : unesc(vm[1]); }
          if (v !== null && String(v).trim() !== "") cells[colIdx(ref)] = String(v).trim();
        }
        rows[+rm[1] - 1] = cells;
      }
      return rows;
    });
}

/* ============================================================
   2. THE PHYSICAL STOCK, AS COUNTED
   Each line: what the sheet says, plus how much of it there is.
   `kg` is a real weight from the sheet; `rolls` is a piece count the
   sheet gives with no weight, converted with a STATED assumption.
   ============================================================ */
const num = (v) => { const n = parseFloat(String(v == null ? "" : v).replace(/[^0-9.\-]/g, "")); return isFinite(n) ? n : null; };

function collectStock() {
  const out = [];
  const push = (o) => { if (o && (o.kg > 0 || o.rolls > 0)) out.push(o); };

  // ---- SUBU MICA: mica by type + thickness, weights in kg -------------
  const mica = readSheets(SOURCE_FILES[2]);
  (mica[0] || []).forEach((r) => {
    if (!r || !r[0]) return;
    const type = String(r[0]).toUpperCase().trim();
    if (!/^(CP25G|CP25H|CM25G|CM25 ?DG|CCM25G|MICA PAPER)$/.test(type)) return;
    const kg = num(r[4]);
    if (!kg || kg <= 0) return;                        // lot present but empty
    push({ src: "SUBU MICA", desc: type + " " + (r[1] || ""), type,
      thk: num(r[1]), lot: r[2] || "", kg, supplier: "mica" });
  });
  (mica[1] || []).forEach((r) => {
    if (!r || !r[1]) return;
    const kg = num(r[3]);
    if (!kg || kg <= 0) return;
    push({ src: "SUBU MICA (sheet 2)", desc: String(r[1]) + " " + (r[2] || ""),
      type: String(r[1]).toUpperCase().trim(), thk: num(r[2]), kg, supplier: "generic" });
  });

  // ---- CHEMICAL STORE: total quantity in kg ---------------------------
  (readSheets(SOURCE_FILES[1])[0] || []).forEach((r) => {
    if (!r || !r[0]) return;
    const nm = String(r[0]).trim();
    if (/^CHEMICAL STORE$/i.test(nm) || /^Name$/i.test(nm)) return;
    const kg = num(r[3]);
    if (!kg || kg <= 0) return;
    push({ src: "Chemical store", desc: nm, kg, supplier: "chemical" });
  });

  // ---- U2 GROUND STORE: total quantity in kg --------------------------
  (readSheets(SOURCE_FILES[0])[0] || []).forEach((r) => {
    if (!r || !r[0]) return;
    const nm = String(r[0]).trim();
    if (/GROUND FLOOR STORE|^NAME$/i.test(nm)) return;
    const kg = num(r[5]);
    if (!kg || kg <= 0) return;
    push({ src: "U2 ground store", desc: nm + " " + (r[1] || ""), kg, supplier: "yarn" });
  });

  // ---- FABRIC STOCK: roll counts, supplier named ----------------------
  (readSheets(SOURCE_FILES[3])[0] || []).forEach((r) => {
    if (!r || !r[1] || !/^\d+$/.test(String(r[0] || ""))) return;
    const rolls = num(r[3]);
    if (!rolls || rolls <= 0) return;
    push({ src: "Fabric stock", desc: String(r[1]).trim(), rolls,
      supplier: String(r[2] || "").trim().toLowerCase() });
  });

  // ---- U2 BASEMENT: roll / pallet counts ------------------------------
  (readSheets(SOURCE_FILES[4])[0] || []).forEach((r) => {
    if (!r || !r[1] || !/^\d+$/.test(String(r[0] || ""))) return;
    const q = String(r[2] || "");
    const n = num(q);
    if (!n || n <= 0) return;
    push({ src: "U2 basement", desc: String(r[1]).trim(),
      rolls: /PALLET/i.test(q) ? n * 4 : n, palletised: /PALLET/i.test(q), supplier: "generic" });
  });

  return out;
}

/* ============================================================
   3. MAP A COUNTED LINE ONTO THE REAL ITEM MASTER
   ============================================================ */
const norm = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
const tokens = (s) => norm(s).split(" ").filter((t) => t.length > 2);

function buildMatcher(items) {
  const rm = items.filter((i) => i.cat === "RM");
  return function match(line) {
    const d = norm(line.desc);

    // mica is keyed by grade + thickness, which the item ids already encode
    const micaType = (d.match(/\b(CCM25G|CM25 ?DG|CM25G|CP25G|CP25H)\b/) || [])[1];
    if (micaType) {
      const grade = micaType.replace(/\s+/g, "");
      const cands = rm.filter((i) => norm(i.grade) === grade || norm(i.id).includes(grade));
      if (cands.length) {
        if (line.thk != null) {
          let best = null, gap = Infinity;
          cands.forEach((c) => {
            const g = Math.abs((+c.thicknessMM || 0) - line.thk);
            if (g < gap) { gap = g; best = c; }
          });
          if (best && gap <= 0.02) return { item: best, why: "mica grade + thickness" };
        }
        return { item: cands[0], why: "mica grade" };
      }
    }

    // otherwise score on shared words, requiring a decent overlap
    const want = tokens(line.desc);
    if (!want.length) return null;
    let best = null, score = 0;
    rm.forEach((i) => {
      const have = new Set(tokens(i.name + " " + (i.grade || "")));
      let s = 0;
      want.forEach((w) => { if (have.has(w)) s += w.length; });
      if (s > score) { score = s; best = i; }
    });
    if (best && score >= 6) return { item: best, why: "name match" };
    return null;
  };
}

/* how much of the item's OWN unit a counted line represents */
function toItemQty(line, item, assume) {
  const uom = String(item.uom || "KG").toUpperCase();
  const gsm = +item.gsm || 0;
  const widthM = (+item.width || 1000) / 1000;
  if (line.kg > 0) {
    if (uom === "MTR") {
      if (!gsm) return null;
      return round2((line.kg * 1000 / gsm) / widthM);      // kg -> sqm -> m
    }
    if (uom === "GRAM") return round2(line.kg * 1000);
    if (uom === "MG") return round2(line.kg * 1e6);
    return round2(line.kg);
  }
  // only a piece count on the sheet
  const perRoll = assume.metresPerRoll;
  if (uom === "MTR") return round2(line.rolls * perRoll);
  const kg = line.rolls * perRoll * widthM * (gsm || assume.fallbackGsm) / 1000;
  if (uom === "GRAM") return round2(kg * 1000);
  if (uom === "MG") return round2(kg * 1e6);
  return round2(kg);
}
const round2 = (n) => Math.round((+n || 0) * 100) / 100;

/* ============================================================
   4. DATES — everything sits in the last two months
   ============================================================ */
function isoAdd(base, days) {
  const d = new Date(base + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function today() { return new Date().toISOString().slice(0, 10); }

/* ============================================================
   5. LOAD
   ============================================================ */
function load(db) {
  const state = readState(db);
  if (state.items.some((i) => i.demo === TAG) || fs.existsSync(MANIFEST)) {
    console.error("A demo dataset is already loaded. Run --purge first.");
    process.exit(1);
  }

  const man = { tag: TAG, createdAt: new Date().toISOString(), source: SOURCE_FILES,
    items: [], movements: [], purchaseorders: [], salesorders: [], workorders: [] };

  const counted = collectStock();
  const match = buildMatcher(state.items);
  const ASSUME = { metresPerRoll: 1000, fallbackGsm: 100 };

  /* -- 5a. every counted line becomes a receipt into the main store ---- */
  const T = today();
  // receipts land across the last ~8 weeks so the ledger reads like a history
  const receiptDates = [isoAdd(T, -54), isoAdd(T, -47), isoAdd(T, -33), isoAdd(T, -26),
    isoAdd(T, -19), isoAdd(T, -12)];
  const SUPPLIERS = state.suppliers.map((s) => s.id);
  const supplierFor = { mica: SUPPLIERS[0], chemical: SUPPLIERS[1] || SUPPLIERS[0],
    yarn: SUPPLIERS[2] || SUPPLIERS[0], dollar: SUPPLIERS[3] || SUPPLIERS[0],
    china: SUPPLIERS[4] || SUPPLIERS[0], kusumgar: SUPPLIERS[5] || SUPPLIERS[0],
    generic: SUPPLIERS[6] || SUPPLIERS[0] };

  const mapped = [], unmapped = [];
  counted.forEach((line, i) => {
    const m = match(line);
    if (!m) { unmapped.push(line); return; }
    const qty = toItemQty(line, m.item, ASSUME);
    if (!qty || qty <= 0) { unmapped.push(line); return; }
    mapped.push({ line, item: m.item, why: m.why, qty,
      date: receiptDates[i % receiptDates.length],
      supplierId: supplierFor[line.supplier] || supplierFor.generic });
  });

  /* -- 5b. group receipts into purchase orders, raised 7-10 days before - */
  const byPo = new Map();
  mapped.forEach((r) => {
    const key = r.supplierId + "|" + r.date;
    if (!byPo.has(key)) byPo.set(key, []);
    byPo.get(key).push(r);
  });
  let poSeq = 0, mvSeq = 0;
  const mvId = () => "MV-DEMO-" + String(++mvSeq).padStart(4, "0");
  const rateFor = (it) => Math.max(20, Math.round((+it.cost || 0) || (String(it.uom) === "MTR" ? 45 : 180)));

  byPo.forEach((rows, key) => {
    const [supplierId, recvDate] = key.split("|");
    const gap = 7 + (poSeq % 4);                       // 7..10 days before
    const poDate = isoAdd(recvDate, -gap);
    const id = "PO-DEMO-" + String(++poSeq).padStart(3, "0");
    const lines = rows.map((r) => ({ itemId: r.item.id, qty: r.qty, rate: rateFor(r.item), recd: r.qty }));
    const value = round2(lines.reduce((n, l) => n + l.qty * l.rate, 0));
    man.purchaseorders.push(id);
    write(db, "purchase_orders", {
      id, date: poDate, supplierId, status: "Received", eta: recvDate, value, lines,
      demo: TAG, createdBy: "office", note: "Storeroom count — " + rows[0].line.src,
    });
    rows.forEach((r) => {
      const m = { id: mvId(), date: recvDate, itemId: r.item.id, wh: STORE, type: "GRN",
        qty: r.qty, rate: rateFor(r.item), ref: id, note: "Goods receipt vs " + id, by: "office",
        supplierId };
      man.movements.push(m.id);
      writeMovement(db, m);
    });
  });

  /* -- 5c. finished goods into the main store (>= 5000 kg) ------------- */
  const fgAll = state.items.filter((i) => i.cat === "FG" && state.boms[i.id]);
  // spread across the range we actually sell, biggest families first
  const fgPick = fgAll.slice(0, 14);
  const fgDate = isoAdd(T, -16);
  let fgTotal = 0;
  const fgStock = [];
  fgPick.forEach((fg, i) => {
    const qty = [600, 520, 480, 450, 420, 380, 360, 340, 320, 300, 280, 260, 250, 240][i] || 200;
    fgTotal += qty;
    const m = { id: mvId(), date: isoAdd(fgDate, -(i % 5)), itemId: fg.id, wh: STORE, type: "PROD",
      qty, rate: +fg.cost || 0, ref: "FP-DEMO-STOCK",
      note: "Opening finished stock — main store", by: "admin" };
    man.movements.push(m.id);
    writeMovement(db, m);
    fgStock.push({ fg, qty });
  });

  /* -- 5d. sales orders across the last two months (~3000 kg) ---------- */
  const CUST = state.customers.map((c) => c.id);
  const soPlan = [
    { id: "SO-DEMO-001", date: isoAdd(T, -45), promised: isoAdd(T, -30), take: 1150, cust: CUST[0] },
    { id: "SO-DEMO-002", date: isoAdd(T, -28), promised: isoAdd(T, -14), take: 1000, cust: CUST[1] || CUST[0] },
    { id: "SO-DEMO-003", date: isoAdd(T, -11), promised: isoAdd(T, 5), take: 880, cust: CUST[2] || CUST[0] },
  ];
  let fgIdx = 0;
  soPlan.forEach((so, si) => {
    const lines = [];
    let left = so.take;
    while (left > 0 && fgIdx < fgStock.length) {
      const s = fgStock[fgIdx];
      const take = Math.min(left, Math.floor(s.qty * 0.72));
      if (take > 0) {
        lines.push({ itemId: s.fg.id, qty: take, rate: Math.max(240, Math.round(+s.fg.price || 780)),
          width: 25, batch: "" });
        left -= take;
      }
      fgIdx++;
    }
    const value = round2(lines.reduce((n, l) => n + l.qty * l.rate, 0));
    const dispatched = si < 2;                      // the two older ones have shipped
    man.salesorders.push(so.id);
    write(db, "sales_orders", {
      id: so.id, date: so.date, customerId: so.cust,
      status: dispatched ? "Dispatched" : "Confirmed",
      promised: so.promised, priority: si === 2 ? "High" : "Normal", value, lines,
      demo: TAG, createdBy: "office",
    });
    if (dispatched) {
      lines.forEach((l) => {
        const m = { id: mvId(), date: so.promised, itemId: l.itemId, wh: STORE, type: "SALE",
          qty: -Math.abs(l.qty), rate: l.rate, ref: so.id,
          note: "Dispatched against " + so.id, by: "office" };
        man.movements.push(m.id);
        writeMovement(db, m);
      });
    }
  });

  /* -- 5e. work orders: full route, part-done, and short routes -------- */
  const woPlan = [
    { n: 1, from: "full",     qty: 300, done: 3, days: -38, so: "SO-DEMO-001" },
    { n: 2, from: "full",     qty: 260, done: 3, days: -31, so: "SO-DEMO-002" },
    { n: 3, from: "full",     qty: 240, done: 1, days: -9,  so: null },
    { n: 4, from: "slitting", qty: 180, done: 1, days: -6,  so: null },
    { n: 5, from: "slitting", qty: 150, done: 2, days: -20, so: "SO-DEMO-002" },
    { n: 6, from: "packing",  qty: 120, done: 1, days: -4,  so: null },
  ];
  const ROUTE = {
    full: [
      { key: "rmprod", name: "RM Production — Gautam Saw", area: "coating", owner: "coating1", line: "RM Production 1" },
      { key: "slitting", name: "Slitting", area: "slitting", owner: null, line: "Slitting A" },
      { key: "packing", name: "Packing & Dispatch", area: "slitting", owner: null, line: "Slitting A" },
    ],
    slitting: [
      { key: "slitting", name: "Slitting", area: "slitting", owner: null, line: "Slitting A" },
      { key: "packing", name: "Packing & Dispatch", area: "slitting", owner: null, line: "Slitting A" },
    ],
    packing: [
      { key: "packing", name: "Packing & Dispatch", area: "slitting", owner: null, line: "Slitting B" },
    ],
  };
  const STAGE_USER = { rmprod: "coating1", slitting: "slitting1", packing: "slitting2" };
  woPlan.forEach((p) => {
    const fg = fgPick[(p.n - 1) % fgPick.length];
    const id = "WO-DEMO-" + String(p.n).padStart(3, "0");
    const start = isoAdd(T, p.days);
    const route = ROUTE[p.from].map((s, i) => {
      const done = i < p.done;
      const active = i === p.done;
      return Object.assign({}, s, {
        seq: i + 1, qty: p.qty,
        status: done ? "Completed" : (active ? "In Production" : "Pending"),
        posted: true,
        startedBy: done || active ? STAGE_USER[s.key] : null,
        startedAt: done || active ? start + "T04:30:00.000Z" : null,
        doneBy: done ? STAGE_USER[s.key] : null,
        doneAt: done ? isoAdd(start, i + 1) + "T11:00:00.000Z" : null,
      });
    });
    const allDone = route.every((r) => r.status === "Completed");
    man.workorders.push(id);
    write(db, "work_orders", {
      id, date: start, itemId: fg.id, qty: p.qty,
      status: allDone ? "Completed" : "In Production",
      due: isoAdd(start, 12), line: route[0].line,
      progress: Math.round((p.done / route.length) * 100),
      priority: p.n === 3 ? "High" : "Normal",
      widthMM: 25, route, stageIdx: Math.min(p.done, route.length - 1), legacy: false,
      dispatched: !!p.so && allDone,
      soId: p.so || null,
      plan: { qty: p.qty, fgQty: 0, wipQty: 0, makeQty: p.qty, fgSources: [], wipSources: [],
        hasCoating: p.from === "full" },
      demo: TAG, createdBy: "office", createdAt: start + "T03:00:00.000Z",
      updatedBy: STAGE_USER[route[Math.min(p.done, route.length - 1)].key], updatedAt: start + "T11:30:00.000Z",
    });
    // the raw material each completed stage consumed
    const bom = state.boms[fg.id];
    if (bom) {
      (bom.lines || []).slice(0, 3).forEach((l, li) => {
        const rid = Array.isArray(l) ? l[0] : l.id;
        if (!rid || !state.itemById[rid]) return;
        const need = round2(p.qty * 0.9 * (li === 0 ? 1 : 0.35));
        const m = { id: mvId(), date: isoAdd(start, 1), itemId: rid, wh: STORE, type: "ISSUE",
          qty: -Math.abs(need), rate: +state.itemById[rid].cost || 0, ref: id,
          note: "Stage " + route[0].key + " → " + fg.id, by: STAGE_USER[route[0].key] };
        man.movements.push(m.id);
        writeMovement(db, m);
      });
    }
  });

  if (!DRY) fs.writeFileSync(MANIFEST, JSON.stringify(man, null, 2));
  return { man, mapped, unmapped, counted, fgTotal, soPlan, woPlan, ASSUME };
}

/* ============================================================
   6. PURGE — remove exactly what was loaded
   ============================================================ */
function purge(db) {
  let man = null;
  if (fs.existsSync(MANIFEST)) man = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  const counts = { movements: 0, purchase_orders: 0, sales_orders: 0, work_orders: 0, items: 0 };

  const tx = db.transaction(() => {
    // 1) by manifest — authoritative
    if (man) {
      (man.movements || []).forEach((id) => { counts.movements += db.prepare("DELETE FROM movements WHERE id=?").run(id).changes; });
      (man.purchaseorders || []).forEach((id) => { counts.purchase_orders += db.prepare("DELETE FROM purchase_orders WHERE id=?").run(id).changes; });
      (man.salesorders || []).forEach((id) => { counts.sales_orders += db.prepare("DELETE FROM sales_orders WHERE id=?").run(id).changes; });
      (man.workorders || []).forEach((id) => { counts.work_orders += db.prepare("DELETE FROM work_orders WHERE id=?").run(id).changes; });
      (man.items || []).forEach((id) => { counts.items += db.prepare("DELETE FROM items WHERE id=?").run(id).changes; });
    }
    // 2) belt and braces — anything still carrying the tag, or a DEMO id
    counts.movements += db.prepare("DELETE FROM movements WHERE id LIKE 'MV-DEMO-%' OR ref LIKE '%-DEMO-%' OR ref='FP-DEMO-STOCK'").run().changes;
    counts.purchase_orders += db.prepare("DELETE FROM purchase_orders WHERE id LIKE 'PO-DEMO-%' OR doc LIKE '%\"demo\":\"" + TAG + "\"%'").run().changes;
    counts.sales_orders += db.prepare("DELETE FROM sales_orders WHERE id LIKE 'SO-DEMO-%' OR doc LIKE '%\"demo\":\"" + TAG + "\"%'").run().changes;
    counts.work_orders += db.prepare("DELETE FROM work_orders WHERE id LIKE 'WO-DEMO-%' OR doc LIKE '%\"demo\":\"" + TAG + "\"%'").run().changes;
    counts.items += db.prepare("DELETE FROM items WHERE id LIKE '%-DEMO-%' OR doc LIKE '%\"demo\":\"" + TAG + "\"%'").run().changes;
  });
  tx();
  if (fs.existsSync(MANIFEST)) fs.unlinkSync(MANIFEST);
  return counts;
}

/* ============================================================
   7. DB helpers
   ============================================================ */
const J = (v) => JSON.stringify(v == null ? {} : v);
function readState(db) {
  const P = (s, d) => { try { return s ? JSON.parse(s) : d; } catch (e) { return d; } };
  const items = db.prepare("SELECT * FROM items").all().map((r) => Object.assign({}, P(r.doc, {}), {
    id: r.id, name: r.name, cat: r.cat, uom: r.uom, cost: r.cost, price: r.price, grp: r.grp }));
  const itemById = Object.fromEntries(items.map((i) => [i.id, i]));
  const boms = {};
  // the BOM table is keyed by item_id, and carries yield + lines directly
  db.prepare("SELECT * FROM boms").all().forEach((b) => {
    boms[b.item_id] = { yield: b.yield || 1, lines: P(b.lines, []), alternates: P(b.alternates, {}) };
  });
  return {
    items, itemById, boms,
    suppliers: db.prepare("SELECT * FROM suppliers").all().map((s) => Object.assign({ id: s.id }, P(s.doc, {}))),
    customers: db.prepare("SELECT * FROM customers").all().map((c) => Object.assign({ id: c.id }, P(c.doc, {}))),
  };
}
function writeMovement(db, m) {
  if (DRY) return;
  db.prepare(`INSERT INTO movements (id,date,item_id,wh,type,qty,rate,ref,note,by_who,supplier_id)
    VALUES(@id,@date,@item_id,@wh,@type,@qty,@rate,@ref,@note,@by_who,@supplier_id)`)
    .run({ id: m.id, date: m.date, item_id: m.itemId, wh: m.wh, type: m.type, qty: m.qty,
      rate: m.rate || 0, ref: m.ref || null, note: m.note || null, by_who: m.by || null,
      supplier_id: m.supplierId || null });
}
function write(db, table, rec) {
  if (DRY) return;
  if (table === "purchase_orders") {
    const { id, date, supplierId, status, eta, value, lines, ...rest } = rec;
    db.prepare(`INSERT INTO purchase_orders (id,date,supplier_id,status,eta,value,lines,doc)
      VALUES(@id,@date,@supplier_id,@status,@eta,@value,@lines,@doc)`)
      .run({ id, date, supplier_id: supplierId, status, eta, value, lines: J(lines), doc: J(rest) });
  } else if (table === "sales_orders") {
    const { id, date, customerId, status, promised, priority, value, lines, ...rest } = rec;
    db.prepare(`INSERT INTO sales_orders (id,date,customer_id,status,promised,priority,value,lines,doc)
      VALUES(@id,@date,@customer_id,@status,@promised,@priority,@value,@lines,@doc)`)
      .run({ id, date, customer_id: customerId, status, promised, priority, value, lines: J(lines), doc: J(rest) });
  } else if (table === "work_orders") {
    const { id, date, itemId, qty, status, due, line, progress, priority, ...rest } = rec;
    db.prepare(`INSERT INTO work_orders (id,date,item_id,qty,status,due,line,progress,priority,doc)
      VALUES(@id,@date,@item_id,@qty,@status,@due,@line,@progress,@priority,@doc)`)
      .run({ id, date, item_id: itemId, qty, status, due, line, progress, priority, doc: J(rest) });
  }
}

/* ============================================================
   8. MAIN
   ============================================================ */
function main() {
  if (!fs.existsSync(DB_FILE)) { console.error("Database not found: " + DB_FILE); process.exit(1); }
  const db = new Database(DB_FILE);
  db.pragma("journal_mode = WAL");

  if (ARGS.includes("--purge")) {
    const c = purge(db);
    console.log("PURGED the temporary dataset:");
    Object.entries(c).forEach(([k, v]) => console.log("  " + k.padEnd(18) + v + " row(s) removed"));
    console.log("\nThe database is back to its pre-demo state. No feature or real record was touched.");
    db.close(); return;
  }
  if (ARGS.includes("--status")) {
    const q = (sql) => db.prepare(sql).get().c;
    console.log("demo movements     : " + q("SELECT COUNT(*) c FROM movements WHERE id LIKE 'MV-DEMO-%'"));
    console.log("demo purchase orders: " + q("SELECT COUNT(*) c FROM purchase_orders WHERE id LIKE 'PO-DEMO-%'"));
    console.log("demo sales orders   : " + q("SELECT COUNT(*) c FROM sales_orders WHERE id LIKE 'SO-DEMO-%'"));
    console.log("demo work orders    : " + q("SELECT COUNT(*) c FROM work_orders WHERE id LIKE 'WO-DEMO-%'"));
    console.log("manifest            : " + (fs.existsSync(MANIFEST) ? MANIFEST : "(none)"));
    db.close(); return;
  }
  if (!ARGS.includes("--load")) {
    console.log("Usage: node tools/demo-data.js --load [--dry] | --purge | --status");
    db.close(); return;
  }

  const before = snapshotCounts(db);
  const r = load(db);
  const after = snapshotCounts(db);

  console.log("\n=== PHYSICAL STOCK READ FROM THE STOREROOM SHEETS ===");
  console.log("counted lines with a usable quantity : " + r.counted.length);
  console.log("mapped onto the real item master     : " + r.mapped.length);
  console.log("not matched (skipped, not invented)  : " + r.unmapped.length);
  if (r.unmapped.length) r.unmapped.forEach((u) => console.log("    - " + u.src + ": " + u.desc));
  console.log("\nassumption for piece counts: 1 roll = " + r.ASSUME.metresPerRoll + " m");

  console.log("\n=== WHAT WAS CREATED (all tagged " + TAG + ") ===");
  console.log("purchase orders : " + r.man.purchaseorders.length + "  (raised 7-10 days before each receipt)");
  console.log("sales orders    : " + r.man.salesorders.length);
  console.log("work orders     : " + r.man.workorders.length);
  console.log("stock movements : " + r.man.movements.length);
  console.log("finished goods booked into the main store: " + r.fgTotal + " kg");

  console.log("\n=== ROW COUNTS BEFORE -> AFTER ===");
  Object.keys(before).forEach((k) => console.log("  " + k.padEnd(18) + before[k] + " -> " + after[k]));
  console.log("\nmanifest: " + MANIFEST);
  console.log("to remove it all: node tools/demo-data.js --purge");
  db.close();
}
function snapshotCounts(db) {
  const q = (t) => db.prepare("SELECT COUNT(*) c FROM " + t).get().c;
  return { items: q("items"), movements: q("movements"), purchase_orders: q("purchase_orders"),
    sales_orders: q("sales_orders"), work_orders: q("work_orders") };
}
main();
