/* ============================================================
   CHHAPERIA ERP — DATABASE LAYER · repository (DAO)
   The ONLY module that knows SQL. Exposes a document-oriented
   API to the backend services:
       getState()           -> full dataset (frontend shape)
       saveState(dataset)   -> replace everything in one tx
       isEmpty()            -> nothing seeded yet?
       updateSettings(doc)  -> patch settings only (fast path)
   The "state" shape intentionally matches what the frontend
   engine expects, so the UI contract is unchanged.
   ============================================================ */
"use strict";
const { getDb } = require("./connection");

const J = (v) => (v == null ? null : JSON.stringify(v));
const P = (v, d) => { try { return v == null ? d : JSON.parse(v); } catch { return d; } };

/* ---------- READ: assemble the full dataset document ---------- */
function getState() {
  const db = getDb();

  const org = P(db.prepare("SELECT doc FROM org WHERE id=1").pluck().get(), null);
  const settings = P(db.prepare("SELECT doc FROM settings WHERE id=1").pluck().get(), {
    theme: "dark", accent: "orange", autoAccent: false, lowStockOnly: false,
  });
  const meta = {};
  db.prepare("SELECT k,v FROM meta").all().forEach((r) => (meta[r.k] = r.v));

  const warehouses = db.prepare("SELECT id,name,type,city FROM warehouses").all();
  const categories = db.prepare("SELECT id,name,kind FROM categories").all();
  const suppliers = db.prepare("SELECT doc FROM suppliers").all().map((r) => P(r.doc));
  const customers = db.prepare("SELECT doc FROM customers").all().map((r) => P(r.doc));

  // items: merge promoted columns back into the doc
  const items = db.prepare("SELECT * FROM items").all().map((r) => {
    const extra = P(r.doc, {});
    return Object.assign({}, extra, {
      id: r.id, name: r.name, cat: r.cat, uom: r.uom,
      cost: r.cost, price: r.price, reorder: r.reorder, safety: r.safety,
      lead: r.lead, abc: r.abc, hsn: r.hsn, supplierId: r.supplier_id,
      group: r.grp,
    });
  });

  const boms = {};
  db.prepare("SELECT item_id,yield,lines FROM boms").all().forEach((r) => {
    boms[r.item_id] = { yield: r.yield, lines: P(r.lines, []) };
  });

  const movements = db.prepare(
    "SELECT id,date,item_id,wh,type,qty,rate,ref,note,by_who,supplier_id FROM movements ORDER BY date ASC, id ASC"
  ).all().map((m) => {
    const o = { id: m.id, date: m.date, itemId: m.item_id, wh: m.wh, type: m.type,
      qty: m.qty, rate: m.rate, ref: m.ref, note: m.note, by: m.by_who };
    if (m.supplier_id) o.supplierId = m.supplier_id;
    return o;
  });

  const workorders = db.prepare("SELECT * FROM work_orders").all().map((w) =>
    Object.assign({}, P(w.doc, {}), {
      id: w.id, date: w.date, itemId: w.item_id, qty: w.qty, status: w.status,
      due: w.due, line: w.line, progress: w.progress, priority: w.priority,
    })
  );

  const salesorders = db.prepare("SELECT * FROM sales_orders").all().map((s) =>
    Object.assign({}, P(s.doc, {}), {
      id: s.id, date: s.date, customerId: s.customer_id, status: s.status,
      promised: s.promised, priority: s.priority, value: s.value, lines: P(s.lines, []),
    })
  );

  const purchaseorders = db.prepare("SELECT * FROM purchase_orders").all().map((p) =>
    Object.assign({}, P(p.doc, {}), {
      id: p.id, date: p.date, supplierId: p.supplier_id, status: p.status,
      eta: p.eta, value: p.value, lines: P(p.lines, []),
    })
  );

  // CRM leads — merge promoted columns back into the doc (which holds activities[])
  const leads = db.prepare("SELECT * FROM leads").all().map((l) =>
    Object.assign({}, P(l.doc, {}), {
      id: l.id, company: l.company, contact: l.contact, stage: l.stage,
      value: l.value, owner: l.owner, created: l.created,
      nextFollowUp: l.next_follow_up, customerId: l.customer_id,
    })
  );

  return {
    version: 1,
    seededAt: meta.seededAt || null,
    org, warehouses, categories, items, boms, suppliers, customers,
    movements, workorders, salesorders, purchaseorders, leads, settings,
  };
}

/* ---------- WRITE: replace the entire dataset in one transaction ---------- */
function saveState(data) {
  const db = getDb();
  const tx = db.transaction((d) => {
    // wipe
    for (const t of ["movements", "work_orders", "sales_orders", "purchase_orders",
      "boms", "items", "suppliers", "customers", "warehouses", "categories",
      "leads", "org", "settings", "meta"]) {
      db.prepare(`DELETE FROM ${t}`).run();
    }

    db.prepare("INSERT INTO org(id,doc) VALUES(1,?)").run(J(d.org || {}));
    db.prepare("INSERT INTO settings(id,doc) VALUES(1,?)").run(J(d.settings || {}));
    db.prepare("INSERT INTO meta(k,v) VALUES('seededAt',?)")
      .run(d.seededAt || new Date().toISOString());
    db.prepare("INSERT INTO meta(k,v) VALUES('version',?)").run(String(d.version || 1));

    const wh = db.prepare("INSERT INTO warehouses(id,name,type,city) VALUES(@id,@name,@type,@city)");
    (d.warehouses || []).forEach((w) => wh.run({ id: w.id, name: w.name, type: w.type || null, city: w.city || null }));

    const cat = db.prepare("INSERT INTO categories(id,name,kind) VALUES(@id,@name,@kind)");
    (d.categories || []).forEach((c) => cat.run({ id: c.id, name: c.name, kind: c.kind || null }));

    const sup = db.prepare("INSERT INTO suppliers(id,doc) VALUES(?,?)");
    (d.suppliers || []).forEach((s) => sup.run(s.id, J(s)));

    const cus = db.prepare("INSERT INTO customers(id,doc) VALUES(?,?)");
    (d.customers || []).forEach((c) => cus.run(c.id, J(c)));

    const it = db.prepare(`INSERT INTO items
      (id,name,cat,uom,cost,price,reorder,safety,lead,abc,hsn,supplier_id,grp,doc)
      VALUES(@id,@name,@cat,@uom,@cost,@price,@reorder,@safety,@lead,@abc,@hsn,@supplier_id,@grp,@doc)`);
    (d.items || []).forEach((i) => {
      const { id, name, cat, uom, cost, price, reorder, safety, lead, abc, hsn, supplierId, group, ...rest } = i;
      it.run({
        id, name, cat: cat || null, uom: uom || null,
        cost: cost || 0, price: price || 0, reorder: reorder || 0, safety: safety || 0,
        lead: lead || 7, abc: abc || null, hsn: hsn || null,
        supplier_id: supplierId || null, grp: group || null, doc: J(rest),
      });
    });

    const bom = db.prepare("INSERT INTO boms(item_id,yield,lines) VALUES(?,?,?)");
    Object.entries(d.boms || {}).forEach(([itemId, b]) => bom.run(itemId, b.yield || 1, J(b.lines || [])));

    const mv = db.prepare(`INSERT INTO movements
      (id,date,item_id,wh,type,qty,rate,ref,note,by_who,supplier_id)
      VALUES(@id,@date,@item_id,@wh,@type,@qty,@rate,@ref,@note,@by_who,@supplier_id)`);
    (d.movements || []).forEach((m) => mv.run({
      id: m.id, date: m.date, item_id: m.itemId, wh: m.wh || null, type: m.type,
      qty: m.qty, rate: m.rate || 0, ref: m.ref || null, note: m.note || null,
      by_who: m.by || null, supplier_id: m.supplierId || null,
    }));

    const wo = db.prepare(`INSERT INTO work_orders
      (id,date,item_id,qty,status,due,line,progress,priority,doc)
      VALUES(@id,@date,@item_id,@qty,@status,@due,@line,@progress,@priority,@doc)`);
    (d.workorders || []).forEach((w) => {
      const { id, date, itemId, qty, status, due, line, progress, priority, ...rest } = w;
      wo.run({ id, date, item_id: itemId, qty, status, due: due || null, line: line || null,
        progress: progress || 0, priority: priority || null, doc: J(rest) });
    });

    const so = db.prepare(`INSERT INTO sales_orders
      (id,date,customer_id,status,promised,priority,value,lines,doc)
      VALUES(@id,@date,@customer_id,@status,@promised,@priority,@value,@lines,@doc)`);
    (d.salesorders || []).forEach((s) => {
      const { id, date, customerId, status, promised, priority, value, lines, ...rest } = s;
      so.run({ id, date, customer_id: customerId, status, promised: promised || null,
        priority: priority || null, value: value || 0, lines: J(lines || []), doc: J(rest) });
    });

    const po = db.prepare(`INSERT INTO purchase_orders
      (id,date,supplier_id,status,eta,value,lines,doc)
      VALUES(@id,@date,@supplier_id,@status,@eta,@value,@lines,@doc)`);
    (d.purchaseorders || []).forEach((p) => {
      const { id, date, supplierId, status, eta, value, lines, ...rest } = p;
      po.run({ id, date, supplier_id: supplierId, status, eta: eta || null,
        value: value || 0, lines: J(lines || []), doc: J(rest) });
    });

    const ld = db.prepare(`INSERT INTO leads
      (id,company,contact,stage,value,owner,created,next_follow_up,customer_id,doc)
      VALUES(@id,@company,@contact,@stage,@value,@owner,@created,@next_follow_up,@customer_id,@doc)`);
    (d.leads || []).forEach((l) => {
      const { id, company, contact, stage, value, owner, created, nextFollowUp, customerId, ...rest } = l;
      ld.run({ id, company, contact: contact || null, stage: stage || "New",
        value: value || 0, owner: owner || null, created: created || null,
        next_follow_up: nextFollowUp || null, customer_id: customerId || null, doc: J(rest) });
    });
  });
  tx(data);
  return getState();
}

function isEmpty() {
  const db = getDb();
  const n = db.prepare("SELECT COUNT(*) AS c FROM items").pluck().get();
  return n === 0;
}

/* ---------- TARGETED WRITES ----------
   Single-row updates for hot paths (a supervisor advancing a work
   order). These avoid rewriting the ENTIRE dataset on every tap,
   which was slow and caused last-writer-wins races between panels. */

/** Read one work order in the frontend document shape (or null). */
function getWorkOrder(id) {
  const db = getDb();
  const w = db.prepare("SELECT * FROM work_orders WHERE id=?").get(id);
  if (!w) return null;
  return Object.assign({}, P(w.doc, {}), {
    id: w.id, date: w.date, itemId: w.item_id, qty: w.qty, status: w.status,
    due: w.due, line: w.line, progress: w.progress, priority: w.priority,
  });
}

/** Insert-or-replace one work order (extra fields kept in doc JSON). */
function putWorkOrder(w) {
  const db = getDb();
  const { id, date, itemId, qty, status, due, line, progress, priority, ...rest } = w;
  db.prepare(`INSERT INTO work_orders
      (id,date,item_id,qty,status,due,line,progress,priority,doc)
      VALUES(@id,@date,@item_id,@qty,@status,@due,@line,@progress,@priority,@doc)
      ON CONFLICT(id) DO UPDATE SET
        date=excluded.date, item_id=excluded.item_id, qty=excluded.qty,
        status=excluded.status, due=excluded.due, line=excluded.line,
        progress=excluded.progress, priority=excluded.priority, doc=excluded.doc`)
    .run({ id, date: date || null, item_id: itemId || null, qty: qty || 0,
      status: status || null, due: due || null, line: line || null,
      progress: progress || 0, priority: priority || null, doc: J(rest) });
  return getWorkOrder(id);
}

/** Append stock movements (used when a stage posts its consumption/output). */
function addMovements(moves) {
  if (!moves || !moves.length) return 0;
  const db = getDb();
  const mv = db.prepare(`INSERT INTO movements
      (id,date,item_id,wh,type,qty,rate,ref,note,by_who,supplier_id)
      VALUES(@id,@date,@item_id,@wh,@type,@qty,@rate,@ref,@note,@by_who,@supplier_id)`);
  const tx = db.transaction((rows) => {
    rows.forEach((m) => mv.run({
      id: m.id, date: m.date, item_id: m.itemId, wh: m.wh || null, type: m.type,
      qty: m.qty, rate: m.rate || 0, ref: m.ref || null, note: m.note || null,
      by_who: m.by || null, supplier_id: m.supplierId || null,
    }));
  });
  tx(moves);
  return moves.length;
}

function updateSettings(doc) {
  const db = getDb();
  db.prepare("INSERT INTO settings(id,doc) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET doc=excluded.doc")
    .run(J(doc || {}));
  return doc;
}

module.exports = { getState, saveState, isEmpty, updateSettings, getWorkOrder, putWorkOrder, addMovements };
