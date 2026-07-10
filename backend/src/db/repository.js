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
  const transporters = db.prepare("SELECT doc FROM transporters").all().map((r) => P(r.doc));

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

  // ---- Human Resources (workers, attendance, leave, payroll) ----
  const hrWorkers = db.prepare("SELECT * FROM hr_workers").all().map(mapWorker);
  const hrAttendance = db.prepare("SELECT * FROM hr_attendance").all().map(mapAtt);
  const hrLeaveTypes = db.prepare("SELECT * FROM hr_leave_types").all()
    .map((r) => ({ id: r.id, name: r.name, quota: r.quota, accrual: r.accrual, paid: !!r.paid, color: r.color }));
  const hrLeaves = db.prepare("SELECT * FROM hr_leaves").all().map(mapLeave);
  const hrPayruns = db.prepare("SELECT * FROM hr_payruns ORDER BY period DESC").all()
    .map((r) => Object.assign({}, P(r.doc, {}), { id: r.id, period: r.period, status: r.status, generatedAt: r.generated_at }));
  const hrPayslips = db.prepare("SELECT * FROM hr_payslips").all()
    .map((r) => Object.assign({ id: r.id, payrunId: r.payrun_id, workerId: r.worker_id }, P(r.doc, {})));

  return {
    version: 1,
    seededAt: meta.seededAt || null,
    org, warehouses, categories, items, boms, suppliers, customers, transporters,
    movements, workorders, salesorders, purchaseorders, leads, settings,
    hrWorkers, hrAttendance, hrLeaveTypes, hrLeaves, hrPayruns, hrPayslips,
  };
}

/* ---------- HR row ⇄ document mappers ---------- */
function mapWorker(r) {
  return Object.assign({}, P(r.doc, {}), {
    id: r.id, name: r.name, dept: r.dept, designation: r.designation, payType: r.pay_type,
    dailyRate: r.daily_rate, monthlyCtc: r.monthly_ctc, deviceUid: r.device_uid,
    active: !!r.active, joined: r.joined,
  });
}
function mapAtt(r) {
  return { id: r.id, workerId: r.worker_id, date: r.date, status: r.status,
    inTime: r.in_time, outTime: r.out_time, hours: r.hours, otHours: r.ot_hours, note: r.note, source: r.source };
}
function mapLeave(r) {
  return { id: r.id, workerId: r.worker_id, type: r.type, fromDate: r.from_date, toDate: r.to_date,
    days: r.days, status: r.status, reason: r.reason, appliedOn: r.applied_on, decidedBy: r.decided_by };
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

/** Append a single stock movement (hot path for manual receipts/adjustments). */
function addMovement(m) { return addMovements([m]); }

/** Read one item in the frontend document shape (or null). */
function getItem(id) {
  const db = getDb();
  const r = db.prepare("SELECT * FROM items WHERE id=?").get(id);
  if (!r) return null;
  return Object.assign({}, P(r.doc, {}), {
    id: r.id, name: r.name, cat: r.cat, uom: r.uom, cost: r.cost, price: r.price,
    reorder: r.reorder, safety: r.safety, lead: r.lead, abc: r.abc, hsn: r.hsn,
    supplierId: r.supplier_id, group: r.grp,
  });
}

/** Insert-or-update one item (promoted columns + extra fields in doc JSON). */
function putItem(i) {
  const db = getDb();
  const { id, name, cat, uom, cost, price, reorder, safety, lead, abc, hsn, supplierId, group, ...rest } = i;
  db.prepare(`INSERT INTO items
      (id,name,cat,uom,cost,price,reorder,safety,lead,abc,hsn,supplier_id,grp,doc)
      VALUES(@id,@name,@cat,@uom,@cost,@price,@reorder,@safety,@lead,@abc,@hsn,@supplier_id,@grp,@doc)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, cat=excluded.cat, uom=excluded.uom, cost=excluded.cost,
        price=excluded.price, reorder=excluded.reorder, safety=excluded.safety,
        lead=excluded.lead, abc=excluded.abc, hsn=excluded.hsn,
        supplier_id=excluded.supplier_id, grp=excluded.grp, doc=excluded.doc`)
    .run({ id, name: name || null, cat: cat || null, uom: uom || null,
      cost: cost || 0, price: price || 0, reorder: reorder || 0, safety: safety || 0,
      lead: lead || 7, abc: abc || null, hsn: hsn || null,
      supplier_id: supplierId || null, grp: group || null, doc: J(rest) });
  return getItem(id);
}

/** Read one purchase order in the frontend document shape (or null). */
function getPurchaseOrder(id) {
  const db = getDb();
  const p = db.prepare("SELECT * FROM purchase_orders WHERE id=?").get(id);
  if (!p) return null;
  return Object.assign({}, P(p.doc, {}), {
    id: p.id, date: p.date, supplierId: p.supplier_id, status: p.status,
    eta: p.eta, value: p.value, lines: P(p.lines, []),
  });
}

/** Insert-or-update one purchase order. */
function putPurchaseOrder(p) {
  const db = getDb();
  const { id, date, supplierId, status, eta, value, lines, ...rest } = p;
  db.prepare(`INSERT INTO purchase_orders
      (id,date,supplier_id,status,eta,value,lines,doc)
      VALUES(@id,@date,@supplier_id,@status,@eta,@value,@lines,@doc)
      ON CONFLICT(id) DO UPDATE SET
        date=excluded.date, supplier_id=excluded.supplier_id, status=excluded.status,
        eta=excluded.eta, value=excluded.value, lines=excluded.lines, doc=excluded.doc`)
    .run({ id, date: date || null, supplier_id: supplierId || null, status: status || null,
      eta: eta || null, value: value || 0, lines: J(lines || []), doc: J(rest) });
  return getPurchaseOrder(id);
}

/** Delete one purchase order and reverse any stock movements posted against
    it (GRN receipts), all in one transaction. */
function deletePurchaseOrder(id) {
  const db = getDb();
  const tx = db.transaction((pid) => {
    db.prepare("DELETE FROM movements WHERE ref=?").run(pid);
    db.prepare("DELETE FROM purchase_orders WHERE id=?").run(pid);
  });
  tx(id);
  return { id };
}

/* ---------- SALES ORDERS (granular) ---------- */
function getSalesOrder(id) {
  const db = getDb();
  const s = db.prepare("SELECT * FROM sales_orders WHERE id=?").get(id);
  if (!s) return null;
  return Object.assign({}, P(s.doc, {}), {
    id: s.id, date: s.date, customerId: s.customer_id, status: s.status,
    promised: s.promised, priority: s.priority, value: s.value, lines: P(s.lines, []),
  });
}
function putSalesOrder(s) {
  const db = getDb();
  const { id, date, customerId, status, promised, priority, value, lines, ...rest } = s;
  db.prepare(`INSERT INTO sales_orders
      (id,date,customer_id,status,promised,priority,value,lines,doc)
      VALUES(@id,@date,@customer_id,@status,@promised,@priority,@value,@lines,@doc)
      ON CONFLICT(id) DO UPDATE SET
        date=excluded.date, customer_id=excluded.customer_id, status=excluded.status,
        promised=excluded.promised, priority=excluded.priority, value=excluded.value,
        lines=excluded.lines, doc=excluded.doc`)
    .run({ id, date: date || null, customer_id: customerId || null, status: status || null,
      promised: promised || null, priority: priority || null, value: value || 0,
      lines: J(lines || []), doc: J(rest) });
  return getSalesOrder(id);
}
/** Delete one sales order and reverse any dispatch (SALE) movements. */
function deleteSalesOrder(id) {
  const db = getDb();
  const tx = db.transaction((sid) => {
    db.prepare("DELETE FROM movements WHERE ref=?").run(sid);
    db.prepare("DELETE FROM sales_orders WHERE id=?").run(sid);
  });
  tx(id);
  return { id };
}

/* ---------- BILL OF MATERIALS (granular) ---------- */
function getBom(itemId) {
  const db = getDb();
  const b = db.prepare("SELECT item_id,yield,lines FROM boms WHERE item_id=?").get(itemId);
  if (!b) return null;
  return { itemId: b.item_id, yield: b.yield, lines: P(b.lines, []) };
}
function putBom(itemId, bom) {
  const db = getDb();
  db.prepare(`INSERT INTO boms(item_id,yield,lines) VALUES(?,?,?)
      ON CONFLICT(item_id) DO UPDATE SET yield=excluded.yield, lines=excluded.lines`)
    .run(itemId, (bom && bom.yield) || 1, J((bom && bom.lines) || []));
  return getBom(itemId);
}
function deleteBom(itemId) {
  const db = getDb();
  db.prepare("DELETE FROM boms WHERE item_id=?").run(itemId);
  return { itemId };
}

/* ---------- CRM LEADS (granular) ---------- */
function getLead(id) {
  const db = getDb();
  const l = db.prepare("SELECT * FROM leads WHERE id=?").get(id);
  if (!l) return null;
  return Object.assign({}, P(l.doc, {}), {
    id: l.id, company: l.company, contact: l.contact, stage: l.stage,
    value: l.value, owner: l.owner, created: l.created,
    nextFollowUp: l.next_follow_up, customerId: l.customer_id,
  });
}
function putLead(l) {
  const db = getDb();
  const { id, company, contact, stage, value, owner, created, nextFollowUp, customerId, ...rest } = l;
  db.prepare(`INSERT INTO leads
      (id,company,contact,stage,value,owner,created,next_follow_up,customer_id,doc)
      VALUES(@id,@company,@contact,@stage,@value,@owner,@created,@next_follow_up,@customer_id,@doc)
      ON CONFLICT(id) DO UPDATE SET
        company=excluded.company, contact=excluded.contact, stage=excluded.stage,
        value=excluded.value, owner=excluded.owner, created=excluded.created,
        next_follow_up=excluded.next_follow_up, customer_id=excluded.customer_id, doc=excluded.doc`)
    .run({ id, company: company || "", contact: contact || null, stage: stage || "New",
      value: value || 0, owner: owner || null, created: created || null,
      next_follow_up: nextFollowUp || null, customer_id: customerId || null, doc: J(rest) });
  return getLead(id);
}
function deleteLead(id) {
  const db = getDb();
  db.prepare("DELETE FROM leads WHERE id=?").run(id);
  return { id };
}

/* ---------- CUSTOMERS (granular) — used by CRM Won→customer conversion ---------- */
function getCustomer(id) {
  const db = getDb();
  const c = db.prepare("SELECT doc FROM customers WHERE id=?").get(id);
  return c ? P(c.doc) : null;
}
function putCustomer(c) {
  const db = getDb();
  db.prepare("INSERT INTO customers(id,doc) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET doc=excluded.doc")
    .run(c.id, J(c));
  return c;
}

/* ---------- ITEM / WORK-ORDER deletes ---------- */
function deleteItem(id) {
  const db = getDb();
  db.prepare("DELETE FROM items WHERE id=?").run(id);
  return { id };
}
function deleteWorkOrder(id) {
  const db = getDb();
  db.prepare("DELETE FROM work_orders WHERE id=?").run(id);
  return { id };
}

/* ---------- TRANSPORTERS (dispatch providers) ---------- */
function getTransporter(id) {
  const db = getDb();
  const t = db.prepare("SELECT doc FROM transporters WHERE id=?").get(id);
  return t ? P(t.doc) : null;
}
function putTransporter(t) {
  const db = getDb();
  db.prepare("INSERT INTO transporters(id,doc) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET doc=excluded.doc")
    .run(t.id, J(t));
  return t;
}
function deleteTransporter(id) { getDb().prepare("DELETE FROM transporters WHERE id=?").run(id); return { id }; }

function getSettings() {
  const db = getDb();
  return P(db.prepare("SELECT doc FROM settings WHERE id=1").pluck().get(), {});
}
function categoryExists(id) {
  const db = getDb();
  return !!db.prepare("SELECT 1 FROM categories WHERE id=?").get(id);
}

function updateSettings(doc) {
  const db = getDb();
  db.prepare("INSERT INTO settings(id,doc) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET doc=excluded.doc")
    .run(J(doc || {}));
  return doc;
}

/* ============================================================
   HUMAN RESOURCES — granular accessors
   ============================================================ */
/* ---- workers ---- */
function getWorker(id) {
  const db = getDb();
  const r = db.prepare("SELECT * FROM hr_workers WHERE id=?").get(id);
  return r ? mapWorker(r) : null;
}
function getWorkerByDevice(uid) {
  const db = getDb();
  const r = db.prepare("SELECT * FROM hr_workers WHERE device_uid=?").get(String(uid));
  return r ? mapWorker(r) : null;
}
function putWorker(w) {
  const db = getDb();
  const { id, name, dept, designation, payType, dailyRate, monthlyCtc, deviceUid, active, joined, ...rest } = w;
  db.prepare(`INSERT INTO hr_workers
      (id,name,dept,designation,pay_type,daily_rate,monthly_ctc,device_uid,active,joined,doc)
      VALUES(@id,@name,@dept,@designation,@pay_type,@daily_rate,@monthly_ctc,@device_uid,@active,@joined,@doc)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, dept=excluded.dept, designation=excluded.designation,
        pay_type=excluded.pay_type, daily_rate=excluded.daily_rate, monthly_ctc=excluded.monthly_ctc,
        device_uid=excluded.device_uid, active=excluded.active, joined=excluded.joined, doc=excluded.doc`)
    .run({ id, name: name || "", dept: dept || null, designation: designation || null,
      pay_type: payType || "daily", daily_rate: dailyRate || 0, monthly_ctc: monthlyCtc || 0,
      device_uid: deviceUid || null, active: active === false ? 0 : 1, joined: joined || null, doc: J(rest) });
  return getWorker(id);
}
function deleteWorker(id) { getDb().prepare("DELETE FROM hr_workers WHERE id=?").run(id); return { id }; }

/* ---- punches (append-only) ---- */
function addPunch(p) {
  getDb().prepare(`INSERT INTO hr_punches(id,worker_id,device_uid,ts,direction,device_id,source)
      VALUES(@id,@worker_id,@device_uid,@ts,@direction,@device_id,@source)`)
    .run({ id: p.id, worker_id: p.workerId || null, device_uid: p.deviceUid || null, ts: p.ts,
      direction: p.direction || "auto", device_id: p.deviceId || null, source: p.source || "device" });
  return p;
}
function punchesForDate(date) {
  return getDb().prepare("SELECT * FROM hr_punches WHERE ts LIKE ? ORDER BY ts ASC").all(date + "%")
    .map((r) => ({ id: r.id, workerId: r.worker_id, deviceUid: r.device_uid, ts: r.ts, direction: r.direction, deviceId: r.device_id, source: r.source }));
}
function recentPunches(limit) {
  return getDb().prepare("SELECT * FROM hr_punches ORDER BY ts DESC LIMIT ?").all(limit || 100)
    .map((r) => ({ id: r.id, workerId: r.worker_id, deviceUid: r.device_uid, ts: r.ts, direction: r.direction, deviceId: r.device_id, source: r.source }));
}

/* ---- attendance (daily muster) ---- */
function getAttendance(workerId, date) {
  const r = getDb().prepare("SELECT * FROM hr_attendance WHERE id=?").get(workerId + ":" + date);
  return r ? mapAtt(r) : null;
}
function putAttendance(a) {
  const db = getDb();
  const id = a.workerId + ":" + a.date;
  db.prepare(`INSERT INTO hr_attendance(id,worker_id,date,status,in_time,out_time,hours,ot_hours,note,source)
      VALUES(@id,@worker_id,@date,@status,@in_time,@out_time,@hours,@ot_hours,@note,@source)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status, in_time=excluded.in_time,
        out_time=excluded.out_time, hours=excluded.hours, ot_hours=excluded.ot_hours,
        note=excluded.note, source=excluded.source`)
    .run({ id, worker_id: a.workerId, date: a.date, status: a.status || null,
      in_time: a.inTime || null, out_time: a.outTime || null, hours: a.hours || 0,
      ot_hours: a.otHours || 0, note: a.note || null, source: a.source || "device" });
  return getAttendance(a.workerId, a.date);
}
function attendanceForPeriod(period) {
  return getDb().prepare("SELECT * FROM hr_attendance WHERE date LIKE ? ORDER BY date ASC").all(period + "%").map(mapAtt);
}

/* ---- leave types ---- */
function putLeaveType(t) {
  getDb().prepare(`INSERT INTO hr_leave_types(id,name,quota,accrual,paid,color)
      VALUES(@id,@name,@quota,@accrual,@paid,@color)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, quota=excluded.quota,
        accrual=excluded.accrual, paid=excluded.paid, color=excluded.color`)
    .run({ id: t.id, name: t.name || t.id, quota: t.quota || 0, accrual: t.accrual || "fixed",
      paid: t.paid === false ? 0 : 1, color: t.color || null });
  return t;
}
function getLeaveType(id) {
  const r = getDb().prepare("SELECT * FROM hr_leave_types WHERE id=?").get(id);
  return r ? { id: r.id, name: r.name, quota: r.quota, accrual: r.accrual, paid: !!r.paid, color: r.color } : null;
}
function deleteLeaveType(id) { getDb().prepare("DELETE FROM hr_leave_types WHERE id=?").run(id); return { id }; }

/* ---- leaves ---- */
function getLeave(id) {
  const r = getDb().prepare("SELECT * FROM hr_leaves WHERE id=?").get(id);
  return r ? mapLeave(r) : null;
}
function putLeave(l) {
  const db = getDb();
  db.prepare(`INSERT INTO hr_leaves(id,worker_id,type,from_date,to_date,days,status,reason,applied_on,decided_by)
      VALUES(@id,@worker_id,@type,@from_date,@to_date,@days,@status,@reason,@applied_on,@decided_by)
      ON CONFLICT(id) DO UPDATE SET worker_id=excluded.worker_id, type=excluded.type,
        from_date=excluded.from_date, to_date=excluded.to_date, days=excluded.days,
        status=excluded.status, reason=excluded.reason, applied_on=excluded.applied_on, decided_by=excluded.decided_by`)
    .run({ id: l.id, worker_id: l.workerId, type: l.type, from_date: l.fromDate, to_date: l.toDate,
      days: l.days || 0, status: l.status || "Pending", reason: l.reason || null,
      applied_on: l.appliedOn || null, decided_by: l.decidedBy || null });
  return getLeave(l.id);
}
function deleteLeave(id) { getDb().prepare("DELETE FROM hr_leaves WHERE id=?").run(id); return { id }; }

/* ---- payroll ---- */
function getPayrun(id) {
  const r = getDb().prepare("SELECT * FROM hr_payruns WHERE id=?").get(id);
  return r ? Object.assign({}, P(r.doc, {}), { id: r.id, period: r.period, status: r.status, generatedAt: r.generated_at }) : null;
}
function putPayrun(pr) {
  const db = getDb();
  const { id, period, status, generatedAt, ...rest } = pr;
  db.prepare(`INSERT INTO hr_payruns(id,period,status,generated_at,doc)
      VALUES(@id,@period,@status,@generated_at,@doc)
      ON CONFLICT(id) DO UPDATE SET period=excluded.period, status=excluded.status,
        generated_at=excluded.generated_at, doc=excluded.doc`)
    .run({ id, period, status: status || "Draft", generated_at: generatedAt || null, doc: J(rest) });
  return getPayrun(id);
}
function putPayslip(ps) {
  const db = getDb();
  const { id, payrunId, workerId, ...rest } = ps;
  db.prepare(`INSERT INTO hr_payslips(id,payrun_id,worker_id,doc) VALUES(@id,@payrun_id,@worker_id,@doc)
      ON CONFLICT(id) DO UPDATE SET payrun_id=excluded.payrun_id, worker_id=excluded.worker_id, doc=excluded.doc`)
    .run({ id, payrun_id: payrunId, worker_id: workerId, doc: J(rest) });
  return ps;
}
function payslipsForRun(payrunId) {
  return getDb().prepare("SELECT * FROM hr_payslips WHERE payrun_id=?").all(payrunId)
    .map((r) => Object.assign({ id: r.id, payrunId: r.payrun_id, workerId: r.worker_id }, P(r.doc, {})));
}
function deletePayrun(id) {
  const db = getDb();
  const tx = db.transaction((pid) => {
    db.prepare("DELETE FROM hr_payslips WHERE payrun_id=?").run(pid);
    db.prepare("DELETE FROM hr_payruns WHERE id=?").run(pid);
  });
  tx(id);
  return { id };
}
function hrIsEmpty() { return getDb().prepare("SELECT COUNT(*) AS c FROM hr_workers").pluck().get() === 0; }

module.exports = { getState, saveState, isEmpty, updateSettings, getWorkOrder, putWorkOrder,
  addMovements, addMovement, getItem, putItem, getPurchaseOrder, putPurchaseOrder,
  deletePurchaseOrder, getSalesOrder, putSalesOrder, deleteSalesOrder,
  getBom, putBom, deleteBom, getLead, putLead, deleteLead,
  getCustomer, putCustomer, deleteItem, deleteWorkOrder,
  getSettings, categoryExists,
  getTransporter, putTransporter, deleteTransporter,
  // HR
  getWorker, getWorkerByDevice, putWorker, deleteWorker,
  addPunch, punchesForDate, recentPunches,
  getAttendance, putAttendance, attendanceForPeriod,
  putLeaveType, getLeaveType, deleteLeaveType,
  getLeave, putLeave, deleteLeave,
  getPayrun, putPayrun, putPayslip, payslipsForRun, deletePayrun, hrIsEmpty };
