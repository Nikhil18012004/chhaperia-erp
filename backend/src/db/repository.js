/* ============================================================
   CHHAPERIA ERP — DATABASE LAYER · repository (DAO)  [MySQL 8.4]
   The ONLY module that knows SQL. Exposes a document-oriented
   API to the backend services:
       getState()           -> full dataset (frontend shape)
       saveState(dataset)   -> replace everything in one tx
       isEmpty()            -> nothing seeded yet?
       updateSettings(doc)  -> patch settings only (fast path)
   The "state" shape intentionally matches what the frontend
   engine expects, so the UI contract is unchanged.

   FOUR THINGS THE MOVE OFF SQLITE CHANGED HERE

   1. EVERY FUNCTION IS ASYNC. MySQL is a socket, not a file.
      Every caller of these functions awaits them, all the way up
      through the services to the route handlers.

   2. EVERY FUNCTION TAKES AN OPTIONAL EXECUTOR `x`. Outside a
      transaction it is omitted and the pool is used. INSIDE one it
      MUST be passed down, because a transaction lives on a single
      connection and a query taken from the pool is not part of it.
      That failure is silent — the write simply commits on its own
      — so `x` is threaded through every path that writes.

   3. NO forEach AROUND AN AWAIT. Array.prototype.forEach ignores
      the promise its callback returns, so a loop that looked like
      it inserted a hundred rows would fire a hundred un-awaited
      inserts and return before any of them landed — inside a
      transaction that then commits, which is data loss that
      reports success. Every such loop is a for…of.

   4. UPSERTS ARE `ON DUPLICATE KEY UPDATE`. SQLite's
      `ON CONFLICT(id) DO UPDATE SET c=excluded.c` becomes
      `... VALUES(...) AS new ON DUPLICATE KEY UPDATE c=new.c`.
      Worth knowing: MySQL fires this on ANY unique-key collision,
      not only the column named. Every table here has exactly one
      key, so today the two are equivalent — the day a UNIQUE index
      is added to one of them, that stops being true.

   Identifiers are backquoted throughout. `lines` and `lead` are
   reserved words in MySQL 8, and quoting only those two would
   leave the next one to be discovered in production.
   ============================================================ */
"use strict";
const { db, withTx } = require("./connection");

const J = (v) => (v == null ? null : JSON.stringify(v));

/* Reading a JSON column gives back a PARSED value — mysql2 does that
   for the JSON type. Reading the same data out of an older TEXT
   column gives a string. P() takes either, so a database part-way
   through a migration cannot produce two different shapes. */
/* A complaint row → the record the UI sees. The four promoted columns win
   over any stale copy inside the doc, the same rule appointments follow. */
const rowToComplaint = (r) => Object.assign({}, P(r.doc, {}),
  { id: r.id, customerId: r.customer_id, batch: r.batch, status: r.status, raised: r.raised });
/* A quotation row → the record the UI sees. Same rule: the six promoted
   columns win over any stale copy inside the doc. */
const rowToQuotation = (r) => Object.assign({}, P(r.doc, {}),
  { id: r.id, customerId: r.customer_id, leadId: r.lead_id, itemId: r.item_id, status: r.status, date: r.date });
const P = (v, d) => {
  if (v == null) return d;
  if (typeof v === "object") return v;
  try { return JSON.parse(v); } catch { return d; }
};

/* The executor for this call: the transaction's, or the pool's. */
const ex = async (x) => x || (await db());

/* ---------- READ: assemble the full dataset document ---------- */
async function getState(x0) {
  const x = await ex(x0);

  const org = P(await x.val("SELECT `doc` FROM `org` WHERE `id`=1"), null);
  const settings = P(await x.val("SELECT `doc` FROM `settings` WHERE `id`=1"), {
    theme: "dark", accent: "orange", autoAccent: false, lowStockOnly: false,
  });
  const meta = {};
  for (const r of await x.all("SELECT `k`,`v` FROM `meta`")) meta[r.k] = r.v;

  const warehouses = await x.all("SELECT `id`,`name`,`type`,`city` FROM `warehouses`");
  const categories = await x.all("SELECT `id`,`name`,`kind` FROM `categories`");
  const suppliers = (await x.all("SELECT `doc` FROM `suppliers`")).map((r) => P(r.doc));
  const customers = (await x.all("SELECT `doc` FROM `customers`")).map((r) => P(r.doc));
  const transporters = (await x.all("SELECT `doc` FROM `transporters`")).map((r) => P(r.doc));
  // the date is a promoted column, so it wins over any stale copy in the doc
  const appointments = (await x.all("SELECT `id`,`date`,`doc` FROM `appointments`"))
    .map((r) => Object.assign({}, P(r.doc, {}), { id: r.id, date: r.date }));
  const complaints = (await x.all("SELECT `id`,`customer_id`,`batch`,`status`,`raised`,`doc` FROM `complaints`"))
    .map(rowToComplaint);
  const quotations = (await x.all("SELECT `id`,`customer_id`,`lead_id`,`item_id`,`status`,`date`,`doc` FROM `quotations`"))
    .map(rowToQuotation);

  // items: merge promoted columns back into the doc
  const items = (await x.all("SELECT * FROM `items`")).map((r) => {
    const extra = P(r.doc, {});
    return Object.assign({}, extra, {
      id: r.id, name: r.name, cat: r.cat, uom: r.uom,
      cost: r.cost, price: r.price, reorder: r.reorder, safety: r.safety,
      lead: r.lead, abc: r.abc, hsn: r.hsn, supplierId: r.supplier_id,
      group: r.grp,
    });
  });

  const boms = {};
  for (const r of await x.all("SELECT `item_id`,`yield`,`lines`,`alternates` FROM `boms`")) {
    boms[r.item_id] = { yield: r.yield, lines: P(r.lines, []) };
    const alt = P(r.alternates, null);
    if (alt && alt.length) boms[r.item_id].alternates = alt;
  }

  const movements = (await x.all(
    "SELECT `id`,`date`,`item_id`,`wh`,`type`,`qty`,`rate`,`ref`,`note`,`by_who`,`supplier_id` " +
    "FROM `movements` ORDER BY `date` ASC, `id` ASC"
  )).map((m) => {
    const o = { id: m.id, date: m.date, itemId: m.item_id, wh: m.wh, type: m.type,
      qty: m.qty, rate: m.rate, ref: m.ref, note: m.note, by: m.by_who };
    if (m.supplier_id) o.supplierId = m.supplier_id;
    return o;
  });

  const workorders = (await x.all("SELECT * FROM `work_orders`")).map((w) =>
    Object.assign({}, P(w.doc, {}), {
      id: w.id, date: w.date, itemId: w.item_id, qty: w.qty, status: w.status,
      due: w.due, line: w.line, progress: w.progress, priority: w.priority,
    })
  );

  const salesorders = (await x.all("SELECT * FROM `sales_orders`")).map((s) =>
    Object.assign({}, P(s.doc, {}), {
      id: s.id, date: s.date, customerId: s.customer_id, status: s.status,
      promised: s.promised, priority: s.priority, value: s.value, lines: P(s.lines, []),
    })
  );

  const purchaseorders = (await x.all("SELECT * FROM `purchase_orders`")).map((p) =>
    Object.assign({}, P(p.doc, {}), {
      id: p.id, date: p.date, supplierId: p.supplier_id, status: p.status,
      eta: p.eta, value: p.value, lines: P(p.lines, []),
    })
  );

  // CRM leads — merge promoted columns back into the doc (which holds activities[])
  const leads = (await x.all("SELECT * FROM `leads`")).map((l) =>
    Object.assign({}, P(l.doc, {}), {
      id: l.id, company: l.company, contact: l.contact, stage: l.stage,
      value: l.value, owner: l.owner, created: l.created,
      nextFollowUp: l.next_follow_up, customerId: l.customer_id,
    })
  );

  // ---- Human Resources (workers, attendance, leave, payroll) ----
  const hrWorkers = (await x.all("SELECT * FROM `hr_workers`")).map(mapWorker);
  const hrAttendance = (await x.all("SELECT * FROM `hr_attendance`")).map(mapAtt);
  const hrLeaveTypes = (await x.all("SELECT * FROM `hr_leave_types`"))
    .map((r) => ({ id: r.id, name: r.name, quota: r.quota, accrual: r.accrual, paid: !!r.paid, color: r.color }));
  const hrLeaves = (await x.all("SELECT * FROM `hr_leaves`")).map(mapLeave);
  const hrPayruns = (await x.all("SELECT * FROM `hr_payruns` ORDER BY `period` DESC"))
    .map((r) => Object.assign({}, P(r.doc, {}), { id: r.id, period: r.period, status: r.status, generatedAt: r.generated_at }));
  const hrPayslips = (await x.all("SELECT * FROM `hr_payslips`"))
    .map((r) => Object.assign({ id: r.id, payrunId: r.payrun_id, workerId: r.worker_id }, P(r.doc, {})));

  // ---- Lab reports (QC test certificates + their own product master) ----
  const labProducts = (await x.all("SELECT `doc` FROM `lab_products`")).map((r) => P(r.doc));
  const labReports = (await x.all("SELECT `doc` FROM `lab_reports`")).map((r) => P(r.doc));

  // ---- Goods receipt notes (numbered receipt documents) ----
  const grns = (await x.all("SELECT `id`,`doc` FROM `grns` ORDER BY `id` ASC"))
    .map((r) => Object.assign({}, P(r.doc, {}), { id: r.id }));

  // ---- Incoming-material test reports, one per (receipt × material) ----
  const grnTests = (await x.all("SELECT `id`,`grn_id`,`item_id`,`doc` FROM `grn_tests` ORDER BY `id` ASC"))
    .map((r) => Object.assign({}, P(r.doc, {}), { id: r.id, grnId: r.grn_id, itemId: r.item_id }));

  return {
    version: 1,
    seededAt: meta.seededAt || null,
    org, warehouses, categories, items, boms, suppliers, customers, transporters,
    movements, workorders, salesorders, purchaseorders, leads, appointments, complaints, quotations, settings,
    hrWorkers, hrAttendance, hrLeaveTypes, hrLeaves, hrPayruns, hrPayslips,
    labProducts, labReports, grns, grnTests,
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

/* ---------- WRITE: replace the entire dataset in one transaction ----------
   ⚠ The wipe order is load-bearing now. SQLite only enforced foreign keys
   because PRAGMA foreign_keys asked it to; InnoDB always does. boms points at
   items and items points at categories, so they must empty in that order —
   which is the order this list was already in. */
async function saveState(data) {
  await withTx(async (x) => {
    const d = data;

    for (const t of ["movements", "work_orders", "sales_orders", "purchase_orders",
      "boms", "items", "suppliers", "customers", "warehouses", "categories",
      "leads", "org", "settings", "meta"]) {
      await x.run("DELETE FROM `" + t + "`");
    }

    await x.run("INSERT INTO `org`(`id`,`doc`) VALUES(1,?)", [J(d.org || {})]);
    await x.run("INSERT INTO `settings`(`id`,`doc`) VALUES(1,?)", [J(d.settings || {})]);
    await x.run("INSERT INTO `meta`(`k`,`v`) VALUES('seededAt',?)",
      [d.seededAt || new Date().toISOString()]);
    await x.run("INSERT INTO `meta`(`k`,`v`) VALUES('version',?)", [String(d.version || 1)]);

    const WH = "INSERT INTO `warehouses`(`id`,`name`,`type`,`city`) VALUES(:id,:name,:type,:city)";
    for (const w of d.warehouses || [])
      await x.run(WH, { id: w.id, name: w.name, type: w.type || null, city: w.city || null });

    const CAT = "INSERT INTO `categories`(`id`,`name`,`kind`) VALUES(:id,:name,:kind)";
    for (const c of d.categories || [])
      await x.run(CAT, { id: c.id, name: c.name, kind: c.kind || null });

    const SUP = "INSERT INTO `suppliers`(`id`,`doc`) VALUES(?,?)";
    for (const s of d.suppliers || []) await x.run(SUP, [s.id, J(s)]);

    const CUS = "INSERT INTO `customers`(`id`,`doc`) VALUES(?,?)";
    for (const c of d.customers || []) await x.run(CUS, [c.id, J(c)]);

    const IT = "INSERT INTO `items` " +
      "(`id`,`name`,`cat`,`uom`,`cost`,`price`,`reorder`,`safety`,`lead`,`abc`,`hsn`,`supplier_id`,`grp`,`doc`) " +
      "VALUES(:id,:name,:cat,:uom,:cost,:price,:reorder,:safety,:lead,:abc,:hsn,:supplier_id,:grp,:doc)";
    for (const i of d.items || []) {
      const { id, name, cat, uom, cost, price, reorder, safety, lead, abc, hsn, supplierId, group, ...rest } = i;
      await x.run(IT, {
        id, name, cat: cat || null, uom: uom || null,
        cost: cost || 0, price: price || 0, reorder: reorder || 0, safety: safety || 0,
        lead: lead || 7, abc: abc || null, hsn: hsn || null,
        supplier_id: supplierId || null, grp: group || null, doc: J(rest),
      });
    }

    const BOM = "INSERT INTO `boms`(`item_id`,`yield`,`lines`,`alternates`) VALUES(?,?,?,?)";
    for (const [itemId, b] of Object.entries(d.boms || {}))
      await x.run(BOM, [itemId, b.yield || 1, J(b.lines || []),
        (Array.isArray(b.alternates) && b.alternates.length) ? J(b.alternates) : null]);

    const MV = "INSERT INTO `movements` " +
      "(`id`,`date`,`item_id`,`wh`,`type`,`qty`,`rate`,`ref`,`note`,`by_who`,`supplier_id`) " +
      "VALUES(:id,:date,:item_id,:wh,:type,:qty,:rate,:ref,:note,:by_who,:supplier_id)";
    for (const m of d.movements || [])
      await x.run(MV, {
        id: m.id, date: m.date, item_id: m.itemId, wh: m.wh || null, type: m.type,
        qty: m.qty, rate: m.rate || 0, ref: m.ref || null, note: m.note || null,
        by_who: m.by || null, supplier_id: m.supplierId || null,
      });

    const WO = "INSERT INTO `work_orders` " +
      "(`id`,`date`,`item_id`,`qty`,`status`,`due`,`line`,`progress`,`priority`,`doc`) " +
      "VALUES(:id,:date,:item_id,:qty,:status,:due,:line,:progress,:priority,:doc)";
    for (const w of d.workorders || []) {
      const { id, date, itemId, qty, status, due, line, progress, priority, ...rest } = w;
      await x.run(WO, { id, date, item_id: itemId, qty, status, due: due || null, line: line || null,
        progress: progress || 0, priority: priority || null, doc: J(rest) });
    }

    const SO = "INSERT INTO `sales_orders` " +
      "(`id`,`date`,`customer_id`,`status`,`promised`,`priority`,`value`,`lines`,`doc`) " +
      "VALUES(:id,:date,:customer_id,:status,:promised,:priority,:value,:lines,:doc)";
    for (const s of d.salesorders || []) {
      const { id, date, customerId, status, promised, priority, value, lines, ...rest } = s;
      await x.run(SO, { id, date, customer_id: customerId, status, promised: promised || null,
        priority: priority || null, value: value || 0, lines: J(lines || []), doc: J(rest) });
    }

    const PO = "INSERT INTO `purchase_orders` " +
      "(`id`,`date`,`supplier_id`,`status`,`eta`,`value`,`lines`,`doc`) " +
      "VALUES(:id,:date,:supplier_id,:status,:eta,:value,:lines,:doc)";
    for (const p of d.purchaseorders || []) {
      const { id, date, supplierId, status, eta, value, lines, ...rest } = p;
      await x.run(PO, { id, date, supplier_id: supplierId, status, eta: eta || null,
        value: value || 0, lines: J(lines || []), doc: J(rest) });
    }

    const LD = "INSERT INTO `leads` " +
      "(`id`,`company`,`contact`,`stage`,`value`,`owner`,`created`,`next_follow_up`,`customer_id`,`doc`) " +
      "VALUES(:id,:company,:contact,:stage,:value,:owner,:created,:next_follow_up,:customer_id,:doc)";
    for (const l of d.leads || []) {
      const { id, company, contact, stage, value, owner, created, nextFollowUp, customerId, ...rest } = l;
      await x.run(LD, { id, company, contact: contact || null, stage: stage || "New",
        value: value || 0, owner: owner || null, created: created || null,
        next_follow_up: nextFollowUp || null, customer_id: customerId || null, doc: J(rest) });
    }

    /* ---- the collections getState() also hands out ----
       Dispatch, Lab, HR and the Calendar are part of the state document, so a
       full-state save has to write them back. It used to stop at leads: every
       row an Excel import added to those sections was accepted, reported as
       saved, and then silently dropped on the way to disk.

       Guarded on the key being present, because a payload that never mentions a
       collection is not the same as one that empties it: buildSeed() carries no
       transporters / lab / HR / appointments keys, so reset() and the boot-time
       migrations must leave those tables standing rather than wipe them. */
    const replace = async (key, table, write) => {
      if (!Array.isArray(d[key])) return;
      await x.run("DELETE FROM `" + table + "`");
      for (const row of d[key]) await write(row);
    };

    const TR = "INSERT INTO `transporters`(`id`,`doc`) VALUES(?,?)";
    await replace("transporters", "transporters", (t) => x.run(TR, [t.id, J(t)]));

    const CM = "INSERT INTO `complaints`(`id`,`customer_id`,`batch`,`status`,`raised`,`doc`) " +
      "VALUES(:id,:customer_id,:batch,:status,:raised,:doc)";
    await replace("complaints", "complaints", (c) => {
      const { id, customerId, batch, status, raised, ...rest } = c;
      return x.run(CM, { id, customer_id: customerId || null, batch: batch || null,
        status: status || null, raised: raised || null, doc: J(rest) });
    });

    const QT = "INSERT INTO `quotations`(`id`,`customer_id`,`lead_id`,`item_id`,`status`,`date`,`doc`) " +
      "VALUES(:id,:customer_id,:lead_id,:item_id,:status,:date,:doc)";
    await replace("quotations", "quotations", (q) => {
      const { id, customerId, leadId, itemId, status, date, ...rest } = q;
      return x.run(QT, { id, customer_id: customerId || null, lead_id: leadId || null, item_id: itemId || null,
        status: status || null, date: date || null, doc: J(rest) });
    });

    const LP = "INSERT INTO `lab_products`(`id`,`doc`) VALUES(?,?)";
    await replace("labProducts", "lab_products", (p) => x.run(LP, [p.id, J(p)]));

    const LRP = "INSERT INTO `lab_reports`(`id`,`doc`) VALUES(?,?)";
    await replace("labReports", "lab_reports", (r) => x.run(LRP, [r.id, J(r)]));

    const GR = "INSERT INTO `grns`(`id`,`doc`) VALUES(?,?)";
    await replace("grns", "grns", (g) => { const { id, ...rest } = g; return x.run(GR, [id, J(rest)]); });

    const GT = "INSERT INTO `grn_tests`(`id`,`grn_id`,`item_id`,`doc`) VALUES(:id,:grn_id,:item_id,:doc)";
    await replace("grnTests", "grn_tests", (t) => {
      const { id, grnId, itemId, ...rest } = t;
      return x.run(GT, { id, grn_id: grnId || "", item_id: itemId || "", doc: J(rest) });
    });

    const AP = "INSERT INTO `appointments`(`id`,`date`,`doc`) VALUES(:id,:date,:doc)";
    await replace("appointments", "appointments", (a) => {
      const { id, date, ...rest } = a;
      return x.run(AP, { id, date: date || null, doc: J(rest) });
    });

    const HW = "INSERT INTO `hr_workers` " +
      "(`id`,`name`,`dept`,`designation`,`pay_type`,`daily_rate`,`monthly_ctc`,`device_uid`,`active`,`joined`,`doc`) " +
      "VALUES(:id,:name,:dept,:designation,:pay_type,:daily_rate,:monthly_ctc,:device_uid,:active,:joined,:doc)";
    await replace("hrWorkers", "hr_workers", (w) => {
      const { id, name, dept, designation, payType, dailyRate, monthlyCtc, deviceUid, active, joined, ...rest } = w;
      return x.run(HW, { id, name: name || "", dept: dept || null, designation: designation || null,
        pay_type: payType || "daily", daily_rate: dailyRate || 0, monthly_ctc: monthlyCtc || 0,
        device_uid: deviceUid || null, active: active === false ? 0 : 1, joined: joined || null, doc: J(rest) });
    });

    const HA = "INSERT INTO `hr_attendance` " +
      "(`id`,`worker_id`,`date`,`status`,`in_time`,`out_time`,`hours`,`ot_hours`,`note`,`source`) " +
      "VALUES(:id,:worker_id,:date,:status,:in_time,:out_time,:hours,:ot_hours,:note,:source)";
    await replace("hrAttendance", "hr_attendance", (a) =>
      x.run(HA, { id: a.id || a.workerId + ":" + a.date, worker_id: a.workerId, date: a.date,
        status: a.status || null, in_time: a.inTime || null, out_time: a.outTime || null,
        hours: a.hours || 0, ot_hours: a.otHours || 0, note: a.note || null, source: a.source || "device" }));

    const HLT = "INSERT INTO `hr_leave_types`(`id`,`name`,`quota`,`accrual`,`paid`,`color`) " +
      "VALUES(:id,:name,:quota,:accrual,:paid,:color)";
    await replace("hrLeaveTypes", "hr_leave_types", (t) =>
      x.run(HLT, { id: t.id, name: t.name || t.id, quota: t.quota || 0,
        accrual: t.accrual || "fixed", paid: t.paid === false ? 0 : 1, color: t.color || null }));

    const HL = "INSERT INTO `hr_leaves` " +
      "(`id`,`worker_id`,`type`,`from_date`,`to_date`,`days`,`status`,`reason`,`applied_on`,`decided_by`) " +
      "VALUES(:id,:worker_id,:type,:from_date,:to_date,:days,:status,:reason,:applied_on,:decided_by)";
    await replace("hrLeaves", "hr_leaves", (l) =>
      x.run(HL, { id: l.id, worker_id: l.workerId, type: l.type, from_date: l.fromDate, to_date: l.toDate,
        days: l.days || 0, status: l.status || "Pending", reason: l.reason || null,
        applied_on: l.appliedOn || null, decided_by: l.decidedBy || null }));

    const HPR = "INSERT INTO `hr_payruns`(`id`,`period`,`status`,`generated_at`,`doc`) " +
      "VALUES(:id,:period,:status,:generated_at,:doc)";
    await replace("hrPayruns", "hr_payruns", (pr) => {
      const { id, period, status, generatedAt, ...rest } = pr;
      return x.run(HPR, { id, period, status: status || "Draft", generated_at: generatedAt || null, doc: J(rest) });
    });

    const HPS = "INSERT INTO `hr_payslips`(`id`,`payrun_id`,`worker_id`,`doc`) " +
      "VALUES(:id,:payrun_id,:worker_id,:doc)";
    await replace("hrPayslips", "hr_payslips", (ps) => {
      const { id, payrunId, workerId, ...rest } = ps;
      return x.run(HPS, { id, payrun_id: payrunId, worker_id: workerId, doc: J(rest) });
    });
  });
  return getState();
}

async function isEmpty(x0) {
  const x = await ex(x0);
  const n = await x.val("SELECT COUNT(*) AS `c` FROM `items`");
  return Number(n) === 0;
}

/* ---------- TARGETED WRITES ----------
   Single-row updates for hot paths (a supervisor advancing a work
   order). These avoid rewriting the ENTIRE dataset on every tap,
   which was slow and caused last-writer-wins races between panels. */

/** Read one work order in the frontend document shape (or null). */
async function getWorkOrder(id, x0) {
  const x = await ex(x0);
  const w = await x.one("SELECT * FROM `work_orders` WHERE `id`=?", [id]);
  if (!w) return null;
  return Object.assign({}, P(w.doc, {}), {
    id: w.id, date: w.date, itemId: w.item_id, qty: w.qty, status: w.status,
    due: w.due, line: w.line, progress: w.progress, priority: w.priority,
  });
}

/** Stock on hand for ONE item, summed in the database rather than by loading
    every movement. Used by dispatch, which has to refuse before it writes. */
async function onHandOf(itemId, x0) {
  const x = await ex(x0);
  const r = await x.one("SELECT COALESCE(SUM(`qty`),0) AS q FROM `movements` WHERE `item_id`=?", [itemId]);
  return +((r && r.q) || 0);
}

/** On-hand of one item in ONE store — a transfer may only draw what is there. */
async function onHandAt(itemId, wh, x0) {
  const x = await ex(x0);
  const r = await x.one("SELECT COALESCE(SUM(`qty`),0) AS q FROM `movements` WHERE `item_id`=? AND `wh`=?", [itemId, wh]);
  return +((r && r.q) || 0);
}

/** Insert-or-replace one work order (extra fields kept in doc JSON). */
async function putWorkOrder(w, x0) {
  const x = await ex(x0);
  const { id, date, itemId, qty, status, due, line, progress, priority, ...rest } = w;
  await x.run(
    "INSERT INTO `work_orders` " +
    "(`id`,`date`,`item_id`,`qty`,`status`,`due`,`line`,`progress`,`priority`,`doc`) " +
    "VALUES(:id,:date,:item_id,:qty,:status,:due,:line,:progress,:priority,:doc) AS `new` " +
    "ON DUPLICATE KEY UPDATE " +
    "`date`=`new`.`date`, `item_id`=`new`.`item_id`, `qty`=`new`.`qty`, " +
    "`status`=`new`.`status`, `due`=`new`.`due`, `line`=`new`.`line`, " +
    "`progress`=`new`.`progress`, `priority`=`new`.`priority`, `doc`=`new`.`doc`",
    { id, date: date || null, item_id: itemId || null, qty: qty || 0,
      status: status || null, due: due || null, line: line || null,
      progress: progress || 0, priority: priority || null, doc: J(rest) });
  return getWorkOrder(id, x);
}

/** Append stock movements (used when a stage posts its consumption/output). */
/* Pass `x0` when these movements must land in the SAME transaction as the
   document they belong to — a goods receipt or a dispatch. Without it the
   movements commit on their own, which is what let a crash (or a second
   overlapping request) leave stock posted against an order that still reads
   as un-received. */
async function addMovements(moves, x0) {
  if (!moves || !moves.length) return 0;
  const write = async (x) => {
    const MV = "INSERT INTO `movements` " +
      "(`id`,`date`,`item_id`,`wh`,`type`,`qty`,`rate`,`ref`,`note`,`by_who`,`supplier_id`) " +
      "VALUES(:id,:date,:item_id,:wh,:type,:qty,:rate,:ref,:note,:by_who,:supplier_id)";
    for (const m of moves)
      await x.run(MV, {
        id: m.id, date: m.date, item_id: m.itemId, wh: m.wh || null, type: m.type,
        qty: m.qty, rate: m.rate || 0, ref: m.ref || null, note: m.note || null,
        by_who: m.by || null, supplier_id: m.supplierId || null,
      });
  };
  if (x0) await write(x0); else await withTx(write);
  return moves.length;
}

/* ---- locking reads ----
   `SELECT … FOR UPDATE` inside a transaction. The row stays locked until that
   transaction ends, so a second request wanting the same order waits for the
   first to commit and then reads what it actually wrote — instead of both
   reading the same pending quantity and both posting it. Only meaningful with
   a transaction executor; called without one it is an ordinary read. */
async function getPurchaseOrderForUpdate(id, x0) {
  const x = await ex(x0);
  const p = await x.one("SELECT * FROM `purchase_orders` WHERE `id`=? FOR UPDATE", [id]);
  if (!p) return null;
  return Object.assign({}, P(p.doc, {}), {
    id: p.id, date: p.date, supplierId: p.supplier_id, status: p.status,
    eta: p.eta, value: p.value, lines: P(p.lines, []),
  });
}
async function getSalesOrderForUpdate(id, x0) {
  const x = await ex(x0);
  const s = await x.one("SELECT * FROM `sales_orders` WHERE `id`=? FOR UPDATE", [id]);
  if (!s) return null;
  return Object.assign({}, P(s.doc, {}), {
    id: s.id, date: s.date, customerId: s.customer_id, status: s.status,
    promised: s.promised, priority: s.priority, value: s.value, lines: P(s.lines, []),
  });
}

/** Append a single stock movement (hot path for manual receipts/adjustments). */
async function addMovement(m) { return addMovements([m]); }

/** Read one item in the frontend document shape (or null). */
async function getItem(id, x0) {
  const x = await ex(x0);
  const r = await x.one("SELECT * FROM `items` WHERE `id`=?", [id]);
  if (!r) return null;
  return Object.assign({}, P(r.doc, {}), {
    id: r.id, name: r.name, cat: r.cat, uom: r.uom, cost: r.cost, price: r.price,
    reorder: r.reorder, safety: r.safety, lead: r.lead, abc: r.abc, hsn: r.hsn,
    supplierId: r.supplier_id, group: r.grp,
  });
}

/** Insert-or-update one item (promoted columns + extra fields in doc JSON). */
async function putItem(i, x0) {
  const x = await ex(x0);
  const { id, name, cat, uom, cost, price, reorder, safety, lead, abc, hsn, supplierId, group, ...rest } = i;
  await x.run(
    "INSERT INTO `items` " +
    "(`id`,`name`,`cat`,`uom`,`cost`,`price`,`reorder`,`safety`,`lead`,`abc`,`hsn`,`supplier_id`,`grp`,`doc`) " +
    "VALUES(:id,:name,:cat,:uom,:cost,:price,:reorder,:safety,:lead,:abc,:hsn,:supplier_id,:grp,:doc) AS `new` " +
    "ON DUPLICATE KEY UPDATE " +
    "`name`=`new`.`name`, `cat`=`new`.`cat`, `uom`=`new`.`uom`, `cost`=`new`.`cost`, " +
    "`price`=`new`.`price`, `reorder`=`new`.`reorder`, `safety`=`new`.`safety`, " +
    "`lead`=`new`.`lead`, `abc`=`new`.`abc`, `hsn`=`new`.`hsn`, " +
    "`supplier_id`=`new`.`supplier_id`, `grp`=`new`.`grp`, `doc`=`new`.`doc`",
    { id, name: name || null, cat: cat || null, uom: uom || null,
      cost: cost || 0, price: price || 0, reorder: reorder || 0, safety: safety || 0,
      lead: lead || 7, abc: abc || null, hsn: hsn || null,
      supplier_id: supplierId || null, grp: group || null, doc: J(rest) });
  return getItem(id, x);
}

/** Read one purchase order in the frontend document shape (or null). */
async function getPurchaseOrder(id, x0) {
  const x = await ex(x0);
  const p = await x.one("SELECT * FROM `purchase_orders` WHERE `id`=?", [id]);
  if (!p) return null;
  return Object.assign({}, P(p.doc, {}), {
    id: p.id, date: p.date, supplierId: p.supplier_id, status: p.status,
    eta: p.eta, value: p.value, lines: P(p.lines, []),
  });
}

/** Insert-or-update one purchase order. */
async function putPurchaseOrder(p, x0) {
  const x = await ex(x0);
  const { id, date, supplierId, status, eta, value, lines, ...rest } = p;
  await x.run(
    "INSERT INTO `purchase_orders` " +
    "(`id`,`date`,`supplier_id`,`status`,`eta`,`value`,`lines`,`doc`) " +
    "VALUES(:id,:date,:supplier_id,:status,:eta,:value,:lines,:doc) AS `new` " +
    "ON DUPLICATE KEY UPDATE " +
    "`date`=`new`.`date`, `supplier_id`=`new`.`supplier_id`, `status`=`new`.`status`, " +
    "`eta`=`new`.`eta`, `value`=`new`.`value`, `lines`=`new`.`lines`, `doc`=`new`.`doc`",
    { id, date: date || null, supplier_id: supplierId || null, status: status || null,
      eta: eta || null, value: value || 0, lines: J(lines || []), doc: J(rest) });
  return getPurchaseOrder(id, x);
}

/** Delete one purchase order and reverse any stock movements posted against
    it (GRN receipts), all in one transaction. Its goods receipt notes are
    CANCELLED, not deleted — a numbered document must never silently vanish.

    ⚠ `doc->>'$.poId'` and not json_extract(...). MySQL's JSON_EXTRACT returns
    a JSON value, so a quoted "PO-1" never equals the plain string PO-1 and the
    UPDATE would match nothing at all — silently. ->> unquotes it, which is
    what SQLite's json_extract did by itself. */
async function deletePurchaseOrder(id) {
  await withTx(async (x) => {
    await x.run("DELETE FROM `movements` WHERE `ref`=?", [id]);
    await x.run("UPDATE `grns` SET `doc`=JSON_SET(`doc`,'$.status','Cancelled') " +
      "WHERE `doc`->>'$.poId'=?", [id]);
    await x.run("DELETE FROM `purchase_orders` WHERE `id`=?", [id]);
  });
  return { id };
}

/* ---------- GOODS RECEIPT NOTES (granular) ---------- */
async function getGrns(x0) {
  const x = await ex(x0);
  return (await x.all("SELECT `id`,`doc` FROM `grns` ORDER BY `id` ASC"))
    .map((r) => Object.assign({}, P(r.doc, {}), { id: r.id }));
}
async function putGrn(g, x0) {
  const x = await ex(x0);
  const { id, ...rest } = g;
  await x.run("INSERT INTO `grns`(`id`,`doc`) VALUES(:id,:doc) AS `new` " +
    "ON DUPLICATE KEY UPDATE `doc`=`new`.`doc`", { id, doc: J(rest) });
  return g;
}
/* Writing a NEWLY NUMBERED goods receipt. Deliberately a plain INSERT, not the
   upsert above: a goods receipt is a numbered statutory document, and if two
   receipts ever compute the same number the upsert would silently destroy one
   of them. A duplicate key here aborts the whole receipt transaction instead,
   so nothing is half-written and the operator retries onto the next number. */
async function insertGrn(g, x0) {
  const x = await ex(x0);
  const { id, ...rest } = g;
  try {
    await x.run("INSERT INTO `grns`(`id`,`doc`) VALUES(:id,:doc)", { id, doc: J(rest) });
  } catch (e) {
    if (e && (e.code === "ER_DUP_ENTRY" || e.errno === 1062)) {
      const dup = new Error("Goods receipt " + id + " was just issued by another receipt. "
        + "Nothing was saved — try again and it will take the next number.");
      dup.status = 409;
      throw dup;
    }
    throw e;
  }
  return g;
}
async function getGrn(id, x0) {
  const x = await ex(x0);
  const r = await x.one("SELECT `id`,`doc` FROM `grns` WHERE `id`=?", [id]);
  return r ? Object.assign({}, P(r.doc, {}), { id: r.id }) : null;
}

/* ---------- INCOMING-MATERIAL TEST REPORTS (granular) ---------- */
const grnTestRow = (r) => Object.assign({}, P(r.doc, {}),
  { id: r.id, grnId: r.grn_id, itemId: r.item_id });
async function getGrnTests(x0) {
  const x = await ex(x0);
  return (await x.all("SELECT `id`,`grn_id`,`item_id`,`doc` FROM `grn_tests` ORDER BY `id` ASC")).map(grnTestRow);
}
async function getGrnTest(id, x0) {
  const x = await ex(x0);
  const r = await x.one("SELECT `id`,`grn_id`,`item_id`,`doc` FROM `grn_tests` WHERE `id`=?", [id]);
  return r ? grnTestRow(r) : null;
}
/* One report per (receipt × material) — re-measuring the same line updates it
   rather than filing a second, contradictory result for the same delivery. */
async function getGrnTestFor(grnId, itemId, x0) {
  const x = await ex(x0);
  const r = await x.one(
    "SELECT `id`,`grn_id`,`item_id`,`doc` FROM `grn_tests` WHERE `grn_id`=? AND `item_id`=?",
    [grnId, itemId]);
  return r ? grnTestRow(r) : null;
}
async function putGrnTest(t, x0) {
  const x = await ex(x0);
  const { id, grnId, itemId, ...rest } = t;
  await x.run("INSERT INTO `grn_tests`(`id`,`grn_id`,`item_id`,`doc`) " +
    "VALUES(:id,:grn_id,:item_id,:doc) AS `new` " +
    "ON DUPLICATE KEY UPDATE `grn_id`=`new`.`grn_id`, `item_id`=`new`.`item_id`, `doc`=`new`.`doc`",
    { id, grn_id: grnId || "", item_id: itemId || "", doc: J(rest) });
  return t;
}
async function deleteGrnTest(id, x0) {
  const x = await ex(x0);
  await x.run("DELETE FROM `grn_tests` WHERE `id`=?", [id]);
  return { id };
}

/* ---------- SALES ORDERS (granular) ---------- */
async function getSalesOrder(id, x0) {
  const x = await ex(x0);
  const s = await x.one("SELECT * FROM `sales_orders` WHERE `id`=?", [id]);
  if (!s) return null;
  return Object.assign({}, P(s.doc, {}), {
    id: s.id, date: s.date, customerId: s.customer_id, status: s.status,
    promised: s.promised, priority: s.priority, value: s.value, lines: P(s.lines, []),
  });
}
async function putSalesOrder(s, x0) {
  const x = await ex(x0);
  const { id, date, customerId, status, promised, priority, value, lines, ...rest } = s;
  await x.run(
    "INSERT INTO `sales_orders` " +
    "(`id`,`date`,`customer_id`,`status`,`promised`,`priority`,`value`,`lines`,`doc`) " +
    "VALUES(:id,:date,:customer_id,:status,:promised,:priority,:value,:lines,:doc) AS `new` " +
    "ON DUPLICATE KEY UPDATE " +
    "`date`=`new`.`date`, `customer_id`=`new`.`customer_id`, `status`=`new`.`status`, " +
    "`promised`=`new`.`promised`, `priority`=`new`.`priority`, `value`=`new`.`value`, " +
    "`lines`=`new`.`lines`, `doc`=`new`.`doc`",
    { id, date: date || null, customer_id: customerId || null, status: status || null,
      promised: promised || null, priority: priority || null, value: value || 0,
      lines: J(lines || []), doc: J(rest) });
  return getSalesOrder(id, x);
}
/** Delete one sales order and reverse any dispatch (SALE) movements. */
async function deleteSalesOrder(id) {
  await withTx(async (x) => {
    await x.run("DELETE FROM `movements` WHERE `ref`=?", [id]);
    await x.run("DELETE FROM `sales_orders` WHERE `id`=?", [id]);
  });
  return { id };
}

/* ---------- BILL OF MATERIALS (granular) ---------- */
async function getBom(itemId, x0) {
  const x = await ex(x0);
  const b = await x.one("SELECT `item_id`,`yield`,`lines`,`alternates` FROM `boms` WHERE `item_id`=?", [itemId]);
  if (!b) return null;
  const out = { itemId: b.item_id, yield: b.yield, lines: P(b.lines, []) };
  const alt = P(b.alternates, null);
  if (alt && alt.length) out.alternates = alt;
  return out;
}
async function putBom(itemId, bom, x0) {
  const x = await ex(x0);
  const alt = (bom && Array.isArray(bom.alternates) && bom.alternates.length) ? J(bom.alternates) : null;
  await x.run("INSERT INTO `boms`(`item_id`,`yield`,`lines`,`alternates`) VALUES(?,?,?,?) AS `new` " +
    "ON DUPLICATE KEY UPDATE `yield`=`new`.`yield`, `lines`=`new`.`lines`, `alternates`=`new`.`alternates`",
    [itemId, (bom && bom.yield) || 1, J((bom && bom.lines) || []), alt]);
  return getBom(itemId, x);
}
async function deleteBom(itemId, x0) {
  const x = await ex(x0);
  await x.run("DELETE FROM `boms` WHERE `item_id`=?", [itemId]);
  return { itemId };
}

/* ---------- CRM LEADS (granular) ---------- */
async function getLead(id, x0) {
  const x = await ex(x0);
  const l = await x.one("SELECT * FROM `leads` WHERE `id`=?", [id]);
  if (!l) return null;
  return Object.assign({}, P(l.doc, {}), {
    id: l.id, company: l.company, contact: l.contact, stage: l.stage,
    value: l.value, owner: l.owner, created: l.created,
    nextFollowUp: l.next_follow_up, customerId: l.customer_id,
  });
}
async function putLead(l, x0) {
  const x = await ex(x0);
  const { id, company, contact, stage, value, owner, created, nextFollowUp, customerId, ...rest } = l;
  await x.run(
    "INSERT INTO `leads` " +
    "(`id`,`company`,`contact`,`stage`,`value`,`owner`,`created`,`next_follow_up`,`customer_id`,`doc`) " +
    "VALUES(:id,:company,:contact,:stage,:value,:owner,:created,:next_follow_up,:customer_id,:doc) AS `new` " +
    "ON DUPLICATE KEY UPDATE " +
    "`company`=`new`.`company`, `contact`=`new`.`contact`, `stage`=`new`.`stage`, " +
    "`value`=`new`.`value`, `owner`=`new`.`owner`, `created`=`new`.`created`, " +
    "`next_follow_up`=`new`.`next_follow_up`, `customer_id`=`new`.`customer_id`, `doc`=`new`.`doc`",
    { id, company: company || "", contact: contact || null, stage: stage || "New",
      value: value || 0, owner: owner || null, created: created || null,
      next_follow_up: nextFollowUp || null, customer_id: customerId || null, doc: J(rest) });
  return getLead(id, x);
}
async function deleteLead(id, x0) {
  const x = await ex(x0);
  await x.run("DELETE FROM `leads` WHERE `id`=?", [id]);
  return { id };
}

/* ---------- CUSTOMERS (granular) — used by CRM Won→customer conversion ---------- */
async function getCustomer(id, x0) {
  const x = await ex(x0);
  const c = await x.one("SELECT `doc` FROM `customers` WHERE `id`=?", [id]);
  return c ? P(c.doc) : null;
}
async function putCustomer(c, x0) {
  const x = await ex(x0);
  await x.run("INSERT INTO `customers`(`id`,`doc`) VALUES(?,?) AS `new` " +
    "ON DUPLICATE KEY UPDATE `doc`=`new`.`doc`", [c.id, J(c)]);
  return c;
}
async function deleteCustomer(id, x0) {
  const x = await ex(x0);
  await x.run("DELETE FROM `customers` WHERE `id`=?", [id]);
  return { id };
}

/* ---------- SUPPLIERS (granular) ---------- */
async function getSupplier(id, x0) {
  const x = await ex(x0);
  const s = await x.one("SELECT `doc` FROM `suppliers` WHERE `id`=?", [id]);
  return s ? P(s.doc) : null;
}
async function putSupplier(s, x0) {
  const x = await ex(x0);
  await x.run("INSERT INTO `suppliers`(`id`,`doc`) VALUES(?,?) AS `new` " +
    "ON DUPLICATE KEY UPDATE `doc`=`new`.`doc`", [s.id, J(s)]);
  return s;
}
async function deleteSupplier(id, x0) {
  const x = await ex(x0);
  await x.run("DELETE FROM `suppliers` WHERE `id`=?", [id]);
  return { id };
}

/* ---------- ORG (company profile — holds the invoice company entities) ---------- */
async function getOrg(x0) {
  const x = await ex(x0);
  return P(await x.val("SELECT `doc` FROM `org` WHERE `id`=1"), null);
}
async function putOrg(doc, x0) {
  const x = await ex(x0);
  await x.run("INSERT INTO `org`(`id`,`doc`) VALUES(1,?) AS `new` " +
    "ON DUPLICATE KEY UPDATE `doc`=`new`.`doc`", [J(doc || {})]);
  return doc;
}

/* ---------- ITEM / WORK-ORDER deletes ---------- */
async function deleteItem(id, x0) {
  const x = await ex(x0);
  await x.run("DELETE FROM `items` WHERE `id`=?", [id]);
  return { id };
}
async function renameWorkOrder(oldId, newId) {
  // the WO number is the row key and the ref every stage movement carries —
  // both move together or the ledger orphans
  await withTx(async (x) => {
    await x.run("UPDATE `movements` SET `ref`=? WHERE `ref`=?", [newId, oldId]);
    await x.run("UPDATE `work_orders` SET `id`=? WHERE `id`=?", [newId, oldId]);
  });
  return { id: newId };
}
async function deleteWorkOrder(id) {
  // mirror deleteSalesOrder: the WO's posted stage movements (ISSUE/PROD)
  // go with it, so stock figures roll back instead of orphaning
  await withTx(async (x) => {
    await x.run("DELETE FROM `movements` WHERE `ref`=?", [id]);
    await x.run("DELETE FROM `work_orders` WHERE `id`=?", [id]);
  });
  return { id };
}

/* ---------- WAREHOUSES ---------- */
async function getWarehouse(id, x0) {
  const x = await ex(x0);
  return (await x.one("SELECT `id`,`name`,`type`,`city` FROM `warehouses` WHERE `id`=?", [id])) || null;
}
async function putWarehouse(w, x0) {
  const x = await ex(x0);
  await x.run("INSERT INTO `warehouses`(`id`,`name`,`type`,`city`) VALUES(:id,:name,:type,:city) AS `new` " +
    "ON DUPLICATE KEY UPDATE `name`=`new`.`name`, `type`=`new`.`type`, `city`=`new`.`city`",
    { id: w.id, name: w.name, type: w.type || null, city: w.city || null });
  return w;
}

/* ---------- TRANSPORTERS (dispatch providers) ---------- */
async function getTransporter(id, x0) {
  const x = await ex(x0);
  const t = await x.one("SELECT `doc` FROM `transporters` WHERE `id`=?", [id]);
  return t ? P(t.doc) : null;
}
async function putTransporter(t, x0) {
  const x = await ex(x0);
  await x.run("INSERT INTO `transporters`(`id`,`doc`) VALUES(?,?) AS `new` " +
    "ON DUPLICATE KEY UPDATE `doc`=`new`.`doc`", [t.id, J(t)]);
  return t;
}
async function deleteTransporter(id, x0) {
  const x = await ex(x0);
  await x.run("DELETE FROM `transporters` WHERE `id`=?", [id]);
  return { id };
}

/* ---------- APPOINTMENTS (calendar diary entries) ---------- */
async function getAppointment(id, x0) {
  const x = await ex(x0);
  const a = await x.one("SELECT `id`,`date`,`doc` FROM `appointments` WHERE `id`=?", [id]);
  return a ? Object.assign({}, P(a.doc, {}), { id: a.id, date: a.date }) : null;
}
async function putAppointment(a, x0) {
  const x = await ex(x0);
  const { id, date, ...rest } = a;
  await x.run("INSERT INTO `appointments`(`id`,`date`,`doc`) VALUES(:id,:date,:doc) AS `new` " +
    "ON DUPLICATE KEY UPDATE `date`=`new`.`date`, `doc`=`new`.`doc`",
    { id, date: date || null, doc: J(rest) });
  return getAppointment(id, x);
}
async function deleteAppointment(id, x0) {
  const x = await ex(x0);
  await x.run("DELETE FROM `appointments` WHERE `id`=?", [id]);
  return { id };
}

/* ---- complaints ---- */
const CMP_COLS = "`id`,`customer_id`,`batch`,`status`,`raised`,`doc`";
async function getComplaint(id, x0) {
  const x = await ex(x0);
  const r = await x.one("SELECT " + CMP_COLS + " FROM `complaints` WHERE `id`=?", [id]);
  return r ? rowToComplaint(r) : null;
}
async function putComplaint(c, x0) {
  const x = await ex(x0);
  const { id, customerId, batch, status, raised, ...rest } = c;
  await x.run("INSERT INTO `complaints`(" + CMP_COLS + ") " +
    "VALUES(:id,:customer_id,:batch,:status,:raised,:doc) AS `new` " +
    "ON DUPLICATE KEY UPDATE `customer_id`=`new`.`customer_id`, `batch`=`new`.`batch`, " +
    "`status`=`new`.`status`, `raised`=`new`.`raised`, `doc`=`new`.`doc`",
    { id, customer_id: customerId || null, batch: batch || null, status: status || null,
      raised: raised || null, doc: J(rest) });
  return getComplaint(id, x);
}
async function deleteComplaint(id, x0) {
  const x = await ex(x0);
  await x.run("DELETE FROM `complaints` WHERE `id`=?", [id]);
  return { id };
}

/* ---- quotations ---- */
const QTN_COLS = "`id`,`customer_id`,`lead_id`,`item_id`,`status`,`date`,`doc`";
async function getQuotation(id, x0) {
  const x = await ex(x0);
  const r = await x.one("SELECT " + QTN_COLS + " FROM `quotations` WHERE `id`=?", [id]);
  return r ? rowToQuotation(r) : null;
}
async function putQuotation(q, x0) {
  const x = await ex(x0);
  const { id, customerId, leadId, itemId, status, date, ...rest } = q;
  await x.run("INSERT INTO `quotations`(" + QTN_COLS + ") " +
    "VALUES(:id,:customer_id,:lead_id,:item_id,:status,:date,:doc) AS `new` " +
    "ON DUPLICATE KEY UPDATE `customer_id`=`new`.`customer_id`, `lead_id`=`new`.`lead_id`, `item_id`=`new`.`item_id`, " +
    "`status`=`new`.`status`, `date`=`new`.`date`, `doc`=`new`.`doc`",
    { id, customer_id: customerId || null, lead_id: leadId || null, item_id: itemId || null, status: status || null,
      date: date || null, doc: J(rest) });
  return getQuotation(id, x);
}
async function deleteQuotation(id, x0) {
  const x = await ex(x0);
  await x.run("DELETE FROM `quotations` WHERE `id`=?", [id]);
  return { id };
}

/* ---------- LAB REPORTS (QC certificates + own product master) ---------- */
async function getLabProduct(id, x0) {
  const x = await ex(x0);
  const r = await x.one("SELECT `doc` FROM `lab_products` WHERE `id`=?", [id]);
  return r ? P(r.doc) : null;
}
async function putLabProduct(p, x0) {
  const x = await ex(x0);
  await x.run("INSERT INTO `lab_products`(`id`,`doc`) VALUES(?,?) AS `new` " +
    "ON DUPLICATE KEY UPDATE `doc`=`new`.`doc`", [p.id, J(p)]);
  return p;
}
async function deleteLabProduct(id, x0) {
  const x = await ex(x0);
  await x.run("DELETE FROM `lab_products` WHERE `id`=?", [id]);
  return { id };
}
async function labProductsEmpty(x0) {
  const x = await ex(x0);
  return Number(await x.val("SELECT COUNT(*) AS `n` FROM `lab_products`")) === 0;
}

async function getLabReport(id, x0) {
  const x = await ex(x0);
  const r = await x.one("SELECT `doc` FROM `lab_reports` WHERE `id`=?", [id]);
  return r ? P(r.doc) : null;
}
async function putLabReport(rep, x0) {
  const x = await ex(x0);
  await x.run("INSERT INTO `lab_reports`(`id`,`doc`) VALUES(?,?) AS `new` " +
    "ON DUPLICATE KEY UPDATE `doc`=`new`.`doc`", [rep.id, J(rep)]);
  return rep;
}
async function deleteLabReport(id, x0) {
  const x = await ex(x0);
  await x.run("DELETE FROM `lab_reports` WHERE `id`=?", [id]);
  return { id };
}

async function getSettings(x0) {
  const x = await ex(x0);
  return P(await x.val("SELECT `doc` FROM `settings` WHERE `id`=1"), {});
}
async function categoryExists(id, x0) {
  const x = await ex(x0);
  return !!(await x.one("SELECT 1 AS `ok` FROM `categories` WHERE `id`=?", [id]));
}

async function updateSettings(doc, x0) {
  const x = await ex(x0);
  await x.run("INSERT INTO `settings`(`id`,`doc`) VALUES(1,?) AS `new` " +
    "ON DUPLICATE KEY UPDATE `doc`=`new`.`doc`", [J(doc || {})]);
  return doc;
}

/* ============================================================
   HUMAN RESOURCES — granular accessors
   ============================================================ */
/* ---- workers ---- */
async function getWorker(id, x0) {
  const x = await ex(x0);
  const r = await x.one("SELECT * FROM `hr_workers` WHERE `id`=?", [id]);
  return r ? mapWorker(r) : null;
}
async function getWorkerByDevice(uid, x0) {
  const x = await ex(x0);
  const r = await x.one("SELECT * FROM `hr_workers` WHERE `device_uid`=?", [String(uid)]);
  return r ? mapWorker(r) : null;
}
async function putWorker(w, x0) {
  const x = await ex(x0);
  const { id, name, dept, designation, payType, dailyRate, monthlyCtc, deviceUid, active, joined, ...rest } = w;
  await x.run(
    "INSERT INTO `hr_workers` " +
    "(`id`,`name`,`dept`,`designation`,`pay_type`,`daily_rate`,`monthly_ctc`,`device_uid`,`active`,`joined`,`doc`) " +
    "VALUES(:id,:name,:dept,:designation,:pay_type,:daily_rate,:monthly_ctc,:device_uid,:active,:joined,:doc) AS `new` " +
    "ON DUPLICATE KEY UPDATE " +
    "`name`=`new`.`name`, `dept`=`new`.`dept`, `designation`=`new`.`designation`, " +
    "`pay_type`=`new`.`pay_type`, `daily_rate`=`new`.`daily_rate`, `monthly_ctc`=`new`.`monthly_ctc`, " +
    "`device_uid`=`new`.`device_uid`, `active`=`new`.`active`, `joined`=`new`.`joined`, `doc`=`new`.`doc`",
    { id, name: name || "", dept: dept || null, designation: designation || null,
      pay_type: payType || "daily", daily_rate: dailyRate || 0, monthly_ctc: monthlyCtc || 0,
      device_uid: deviceUid || null, active: active === false ? 0 : 1, joined: joined || null, doc: J(rest) });
  return getWorker(id, x);
}
async function deleteWorker(id, x0) {
  const x = await ex(x0);
  await x.run("DELETE FROM `hr_workers` WHERE `id`=?", [id]);
  return { id };
}

/* ---- punches (append-only) ---- */
async function addPunch(p, x0) {
  const x = await ex(x0);
  await x.run("INSERT INTO `hr_punches`(`id`,`worker_id`,`device_uid`,`ts`,`direction`,`device_id`,`source`) " +
    "VALUES(:id,:worker_id,:device_uid,:ts,:direction,:device_id,:source)",
    { id: p.id, worker_id: p.workerId || null, device_uid: p.deviceUid || null, ts: p.ts,
      direction: p.direction || "auto", device_id: p.deviceId || null, source: p.source || "device" });
  return p;
}
const punchRow = (r) => ({ id: r.id, workerId: r.worker_id, deviceUid: r.device_uid,
  ts: r.ts, direction: r.direction, deviceId: r.device_id, source: r.source });
async function punchesForDate(date, x0) {
  const x = await ex(x0);
  return (await x.all("SELECT * FROM `hr_punches` WHERE `ts` LIKE ? ORDER BY `ts` ASC", [date + "%"]))
    .map(punchRow);
}
/* LIMIT is interpolated, NOT bound. It is coerced to an integer and clamped
   first, so nothing but a number can reach the SQL — some MySQL/driver
   combinations send a bound LIMIT as a string and reject it, and a validated
   integer is the one safe way to write this. */
async function recentPunches(limit, x0) {
  const x = await ex(x0);
  const n = Math.max(1, Math.min(1000, Math.floor(Number(limit) || 100)));
  return (await x.all("SELECT * FROM `hr_punches` ORDER BY `ts` DESC LIMIT " + n)).map(punchRow);
}

/* ---- attendance (daily muster) ---- */
async function getAttendance(workerId, date, x0) {
  const x = await ex(x0);
  const r = await x.one("SELECT * FROM `hr_attendance` WHERE `id`=?", [workerId + ":" + date]);
  return r ? mapAtt(r) : null;
}
async function putAttendance(a, x0) {
  const x = await ex(x0);
  const id = a.workerId + ":" + a.date;
  await x.run(
    "INSERT INTO `hr_attendance` " +
    "(`id`,`worker_id`,`date`,`status`,`in_time`,`out_time`,`hours`,`ot_hours`,`note`,`source`) " +
    "VALUES(:id,:worker_id,:date,:status,:in_time,:out_time,:hours,:ot_hours,:note,:source) AS `new` " +
    "ON DUPLICATE KEY UPDATE `status`=`new`.`status`, `in_time`=`new`.`in_time`, " +
    "`out_time`=`new`.`out_time`, `hours`=`new`.`hours`, `ot_hours`=`new`.`ot_hours`, " +
    "`note`=`new`.`note`, `source`=`new`.`source`",
    { id, worker_id: a.workerId, date: a.date, status: a.status || null,
      in_time: a.inTime || null, out_time: a.outTime || null, hours: a.hours || 0,
      ot_hours: a.otHours || 0, note: a.note || null, source: a.source || "device" });
  return getAttendance(a.workerId, a.date, x);
}
async function attendanceForPeriod(period, x0) {
  const x = await ex(x0);
  return (await x.all("SELECT * FROM `hr_attendance` WHERE `date` LIKE ? ORDER BY `date` ASC",
    [period + "%"])).map(mapAtt);
}

/* ---- leave types ---- */
async function putLeaveType(t, x0) {
  const x = await ex(x0);
  await x.run("INSERT INTO `hr_leave_types`(`id`,`name`,`quota`,`accrual`,`paid`,`color`) " +
    "VALUES(:id,:name,:quota,:accrual,:paid,:color) AS `new` " +
    "ON DUPLICATE KEY UPDATE `name`=`new`.`name`, `quota`=`new`.`quota`, " +
    "`accrual`=`new`.`accrual`, `paid`=`new`.`paid`, `color`=`new`.`color`",
    { id: t.id, name: t.name || t.id, quota: t.quota || 0, accrual: t.accrual || "fixed",
      paid: t.paid === false ? 0 : 1, color: t.color || null });
  return t;
}
async function getLeaveType(id, x0) {
  const x = await ex(x0);
  const r = await x.one("SELECT * FROM `hr_leave_types` WHERE `id`=?", [id]);
  return r ? { id: r.id, name: r.name, quota: r.quota, accrual: r.accrual, paid: !!r.paid, color: r.color } : null;
}
async function deleteLeaveType(id, x0) {
  const x = await ex(x0);
  await x.run("DELETE FROM `hr_leave_types` WHERE `id`=?", [id]);
  return { id };
}

/* ---- leaves ---- */
async function getLeave(id, x0) {
  const x = await ex(x0);
  const r = await x.one("SELECT * FROM `hr_leaves` WHERE `id`=?", [id]);
  return r ? mapLeave(r) : null;
}
async function putLeave(l, x0) {
  const x = await ex(x0);
  await x.run(
    "INSERT INTO `hr_leaves` " +
    "(`id`,`worker_id`,`type`,`from_date`,`to_date`,`days`,`status`,`reason`,`applied_on`,`decided_by`) " +
    "VALUES(:id,:worker_id,:type,:from_date,:to_date,:days,:status,:reason,:applied_on,:decided_by) AS `new` " +
    "ON DUPLICATE KEY UPDATE `worker_id`=`new`.`worker_id`, `type`=`new`.`type`, " +
    "`from_date`=`new`.`from_date`, `to_date`=`new`.`to_date`, `days`=`new`.`days`, " +
    "`status`=`new`.`status`, `reason`=`new`.`reason`, `applied_on`=`new`.`applied_on`, " +
    "`decided_by`=`new`.`decided_by`",
    { id: l.id, worker_id: l.workerId, type: l.type, from_date: l.fromDate, to_date: l.toDate,
      days: l.days || 0, status: l.status || "Pending", reason: l.reason || null,
      applied_on: l.appliedOn || null, decided_by: l.decidedBy || null });
  return getLeave(l.id, x);
}
async function deleteLeave(id, x0) {
  const x = await ex(x0);
  await x.run("DELETE FROM `hr_leaves` WHERE `id`=?", [id]);
  return { id };
}

/* ---- payroll ---- */
async function getPayrun(id, x0) {
  const x = await ex(x0);
  const r = await x.one("SELECT * FROM `hr_payruns` WHERE `id`=?", [id]);
  return r ? Object.assign({}, P(r.doc, {}), { id: r.id, period: r.period, status: r.status, generatedAt: r.generated_at }) : null;
}
async function putPayrun(pr, x0) {
  const x = await ex(x0);
  const { id, period, status, generatedAt, ...rest } = pr;
  await x.run("INSERT INTO `hr_payruns`(`id`,`period`,`status`,`generated_at`,`doc`) " +
    "VALUES(:id,:period,:status,:generated_at,:doc) AS `new` " +
    "ON DUPLICATE KEY UPDATE `period`=`new`.`period`, `status`=`new`.`status`, " +
    "`generated_at`=`new`.`generated_at`, `doc`=`new`.`doc`",
    { id, period, status: status || "Draft", generated_at: generatedAt || null, doc: J(rest) });
  return getPayrun(id, x);
}
async function putPayslip(ps, x0) {
  const x = await ex(x0);
  const { id, payrunId, workerId, ...rest } = ps;
  await x.run("INSERT INTO `hr_payslips`(`id`,`payrun_id`,`worker_id`,`doc`) " +
    "VALUES(:id,:payrun_id,:worker_id,:doc) AS `new` " +
    "ON DUPLICATE KEY UPDATE `payrun_id`=`new`.`payrun_id`, `worker_id`=`new`.`worker_id`, `doc`=`new`.`doc`",
    { id, payrun_id: payrunId, worker_id: workerId, doc: J(rest) });
  return ps;
}
async function payslipsForRun(payrunId, x0) {
  const x = await ex(x0);
  return (await x.all("SELECT * FROM `hr_payslips` WHERE `payrun_id`=?", [payrunId]))
    .map((r) => Object.assign({ id: r.id, payrunId: r.payrun_id, workerId: r.worker_id }, P(r.doc, {})));
}
async function deletePayrun(id) {
  await withTx(async (x) => {
    await x.run("DELETE FROM `hr_payslips` WHERE `payrun_id`=?", [id]);
    await x.run("DELETE FROM `hr_payruns` WHERE `id`=?", [id]);
  });
  return { id };
}
async function hrIsEmpty(x0) {
  const x = await ex(x0);
  return Number(await x.val("SELECT COUNT(*) AS `c` FROM `hr_workers`")) === 0;
}

module.exports = { getState, saveState, isEmpty, updateSettings, getWorkOrder, putWorkOrder, onHandOf, onHandAt,
  addMovements, addMovement, getItem, putItem, getPurchaseOrder, putPurchaseOrder,
  deletePurchaseOrder, getGrns, putGrn, insertGrn, getGrn,
  getGrnTests, getGrnTest, getGrnTestFor, putGrnTest, deleteGrnTest,
  getSalesOrder, putSalesOrder, deleteSalesOrder,
  // transaction plumbing for flows that must post document + stock together
  withTx, getPurchaseOrderForUpdate, getSalesOrderForUpdate,
  getBom, putBom, deleteBom, getLead, putLead, deleteLead,
  getComplaint, putComplaint, deleteComplaint,
  getQuotation, putQuotation, deleteQuotation,
  getCustomer, putCustomer, deleteCustomer,
  getSupplier, putSupplier, deleteSupplier,
  getOrg, putOrg,
  deleteItem, deleteWorkOrder, renameWorkOrder,
  getSettings, categoryExists,
  getWarehouse, putWarehouse,
  getTransporter, putTransporter, deleteTransporter,
  getAppointment, putAppointment, deleteAppointment,
  // HR
  getWorker, getWorkerByDevice, putWorker, deleteWorker,
  addPunch, punchesForDate, recentPunches,
  getAttendance, putAttendance, attendanceForPeriod,
  putLeaveType, getLeaveType, deleteLeaveType,
  getLeave, putLeave, deleteLeave,
  getPayrun, putPayrun, putPayslip, payslipsForRun, deletePayrun, hrIsEmpty,
  // Lab reports
  getLabProduct, putLabProduct, deleteLabProduct, labProductsEmpty,
  getLabReport, putLabReport, deleteLabReport,
};
