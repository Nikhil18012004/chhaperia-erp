/* ============================================================
   CHHAPERIA ERP — BACKEND · chatbot service
   Answers free-text questions from TWO sources, in this order:
     1. the trainable knowledge base (chatbot_knowledge rows the
        office uploads — an exact-enough match always wins), and
     2. the LIVE dataset, read at ask-time so every answer is
        up-to-the-minute.
   SECURITY: every read goes through viewService.stateForUser(),
   never repo.getState() — the bot inherits exactly the per-role
   redaction the UI gets (supervisors see no money/customers, lab
   sees no spec limits or verdicts). An intent whose data was
   redacted away simply reports "not available for your login";
   it must NOT reach around the view service for it.
   ============================================================ */
"use strict";
const repo = require("../db/repository");
const view = require("./viewService");
const BC = require("../../../frontend/js/bomcalc");

function err(msg, status) { const e = new Error(msg); e.status = status || 400; return e; }

/* collision-free sequential id (same rule as erpService.nextId) */
function nextId(list, prefix) {
  let max = 0, width = 4;
  (list || []).forEach((x) => {
    const m = /(\d+)\s*$/.exec(String((x && x.id) || ""));
    if (m) { max = Math.max(max, +m[1]); width = Math.max(width, m[1].length); }
  });
  return prefix + String(max + 1).padStart(width, "0");
}

/* ---------------- text matching ---------------- */
const STOP = new Set(["the","a","an","is","are","was","were","of","in","on","at","to","for","and","or","do","does","did","what","whats","which","who","how","much","many","me","my","our","we","you","your","i","it","its","this","that","these","those","show","tell","give","list","get","please","can","could","would","have","has","had","with","about","there","any","all","from","by","be","will","status"]);
function tokens(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9.\-]+/g, " ").split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
}
/* overlap score of a query against a KB entry: 0..1 on query coverage,
   keywords count double, plus a substring bonus for near-verbatim asks */
function kbScore(qTokens, qRaw, entry) {
  const eq = tokens(entry.question);
  const kw = (entry.keywords || []).flatMap((k) => tokens(k));
  const a = qRaw.toLowerCase().trim(), b = String(entry.question || "").toLowerCase().trim();

  /* A question made only of stopwords ("who are we") tokenises to nothing, so it
     could never be scored — not even when retyped word for word. An exact match
     still counts; anything looser stays 0, or a two-letter ask would match it. */
  if (!qTokens.length) return a && b && a === b ? 1 : 0;
  if (!eq.length && !kw.length) return 0;

  let hits = 0;
  qTokens.forEach((t) => {
    if (eq.includes(t)) hits += 1;
    else if (kw.includes(t)) hits += 2;
  });
  let score = hits / qTokens.length;
  /* Near-verbatim bonus. It needs a length guard: a one-word trained entry like
     "stock" is contained in every stock question, and the bonus alone would push
     that canned answer past the 0.8 cut-off ahead of the live lookup. */
  if (a && b) {
    if (a === b) score += 0.5;
    else if ((a.includes(b) || b.includes(a)) && eq.length >= 3) score += 0.5;
  }
  return score;
}

/* fuzzy item lookup: how many of the query's tokens land in the item name/id */
function matchItems(qTokens, items) {
  const scored = [];
  items.forEach((it) => {
    const name = tokens(it.name).concat(String(it.id || "").toLowerCase());
    let s = 0;
    qTokens.forEach((t) => { if (name.some((n) => n === t || n.startsWith(t) || t.startsWith(n))) s++; });
    if (s > 0) scored.push({ it, s });
  });
  scored.sort((x, y) => y.s - x.s || String(x.it.name).length - String(y.it.name).length);
  const top = scored.filter((x) => x.s === scored[0]?.s);
  return top.slice(0, 5).map((x) => x.it);
}

/* ---------------- shared readers over the role-filtered state ---------------- */
const fmtQ = (n) => (Math.round((+n || 0) * 100) / 100).toLocaleString("en-IN");
const fmtM = (n) => "₹" + (Math.round(+n || 0)).toLocaleString("en-IN");
const todayISO = () => { const x = new Date(); return `${x.getFullYear()}-${String(x.getMonth()+1).padStart(2,"0")}-${String(x.getDate()).padStart(2,"0")}`; };
const shiftISO = (days) => { const x = new Date(Date.now() + days * 864e5); return `${x.getFullYear()}-${String(x.getMonth()+1).padStart(2,"0")}-${String(x.getDate()).padStart(2,"0")}`; };

function stateItems(st) { return st.items || st.stockItems || []; }

/* on-hand per item -> { qty, byWh:{name:qty} } from whatever this role's view carries */
function onHand(st) {
  const out = {};
  if (Array.isArray(st.movements) && st.movements.length) {
    const whName = {};
    (st.warehouses || []).forEach((w) => { whName[w.id] = w.name || w.id; });
    st.movements.forEach((m) => {
      if (!m.itemId) return;
      const o = out[m.itemId] || (out[m.itemId] = { qty: 0, byWh: {} });
      o.qty += (+m.qty || 0);
      if (m.wh) { const n = whName[m.wh] || m.wh; o.byWh[n] = (o.byWh[n] || 0) + (+m.qty || 0); }
    });
  } else if (st.warehouseStock) {           // supervisor view: quantities only
    const whName = {};
    (st.warehouses || []).forEach((w) => { whName[w.id] = w.name || w.id; });
    Object.keys(st.warehouseStock).forEach((wh) => {
      (st.warehouseStock[wh] || []).forEach((r) => {
        const o = out[r.id] || (out[r.id] = { qty: 0, byWh: {} });
        o.qty += (+r.qty || 0);
        o.byWh[whName[wh] || wh] = (o.byWh[whName[wh] || wh] || 0) + (+r.qty || 0);
      });
    });
  }
  return out;
}

/* Does this role's view carry stock at all? Distinct from "carries none": an
   office login on a freshly wiped dataset has movements:[] and was being told
   stock "isn't available for your login" — about data it fully owns. */
function stockVisible(st) {
  return Array.isArray(st.movements) || !!st.warehouseStock;
}

/* WOs come in two shapes: raw (officer/lab) and the supervisor's mapped view */
function woProduct(wo, itemById) {
  if (wo.product && wo.product.name) return wo.product.name;
  const it = itemById[wo.itemId]; return (it && it.name) || wo.itemId || "?";
}
function woStage(wo) {
  if (wo.stage && wo.stage.name) return wo.stage;
  const route = wo.route || [];
  const idx = Math.min(Math.max(wo.stageIdx || 0, 0), Math.max(route.length - 1, 0));
  return route[idx] || null;
}
function woOpen(wo) {
  return wo.status !== "Completed" && !wo.dispatched;
}

/* ---------------- intents over live data ---------------- */
function intentAnswers(user, q, st) {
  const ql = q.toLowerCase();
  const qT = tokens(q);
  const items = stateItems(st);
  const itemById = Object.fromEntries(items.map((i) => [i.id, i]));
  /* Match whole words, not bare substrings. A plain includes() found "lab" inside
     "available" and "test" inside "latest", so "is mica tape available" answered
     with lab statistics and never reached the stock intent that owns the word.
     The trigger must START a word; only a plural may follow, so "customer" still
     matches "customers" and "batch" matches "batches", while "label" and
     "labour" no longer count as "lab". */
  const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const has = (...words) => words.some((w) => {
    const t = String(w).trim();
    if (!t) return false;
    return new RegExp("(?:^|[^a-z0-9])" + esc(t) + "(?:e?s)?(?:[^a-z0-9]|$)", "i").test(ql);
  });
  const notForRole = (what) => `${what} isn't available for your login — ask the office team.`;

  /* -- a specific work order by id --
     Real ids are zero-padded to four ("WO-0012"), so a strict string compare
     failed every natural way of typing it — "WO 12", "wo12", even the help
     text's own "WO-012". Compare the number, not the padding. "work order 12"
     spelt out counts too. */
  const woRef = /\b(?:wo|work\s?orders?)[-\s#]?0*(\d+)\b/i.exec(q);
  if (woRef) {
    const want = woRef[1];
    const woNum = (s) => { const m = /^\s*wo[-\s]?0*(\d+)\s*$/i.exec(String(s || "")); return m ? m[1] : null; };
    const wo = (st.workorders || []).find((w) => woNum(w.id) === want);
    if (!wo) return `I can't see a work order "WO-${want}" from your login.`;
    const stg = woStage(wo);
    const lines = [
      `${wo.id} — ${woProduct(wo, itemById)}`,
      `• Qty: ${fmtQ(wo.qty)} ${((itemById[wo.itemId] || wo.product || {}).uom) || ""}`.trim(),
      `• Status: ${wo.status || "—"}${wo.dispatched ? " · Dispatched" : ""}`,
      stg ? `• Current stage: ${stg.name} (${stg.status || "Pending"})` : null,
      wo.due ? `• Due: ${wo.due}` : null,
    ].filter(Boolean);
    (wo.route || []).forEach((r) => lines.push(`   – ${r.name}: ${r.status || "Pending"}${r.doneAt ? " ✓ " + String(r.doneAt).slice(0, 10) : ""}`));
    return lines.join("\n");
  }

  /* -- a specific sales order by id ("SO-14", "sales order 14") --
     Only an id WITH digits lands here; the bare English word "so" stays out. */
  const soRef = /\b(?:so|sales\s?orders?)[-\s#]?0*(\d+)\b/i.exec(q);
  if (soRef) {
    if (!Array.isArray(st.salesorders)) return notForRole("Sales orders");
    const soNum = (s) => { const m = /^\s*so[-\s]?0*(\d+)\s*$/i.exec(String(s || "")); return m ? m[1] : null; };
    const so = st.salesorders.find((s) => soNum(s.id) === soRef[1]);
    if (!so) return `I can't see a sales order "SO-${soRef[1]}" from your login.`;
    const cust = (st.customers || []).find((c) => c.id === so.customerId);
    const out = [
      `${so.id}${cust ? " — " + cust.name : ""}`,
      `• Status: ${so.status || "Open"}`,
      so.date ? `• Ordered: ${so.date}` : null,
      so.promised || so.due ? `• Promised: ${so.promised || so.due}` : null,
      so.value != null ? `• Value: ${fmtM(so.value)}` : null,
    ].filter(Boolean);
    (so.lines || []).forEach((l) => {
      const it = itemById[l.itemId] || {};
      out.push(`   – ${it.name || l.itemId} · ${fmtQ(l.qty)} ${it.uom || ""}${l.rate != null ? " @ ₹" + fmtQ(l.rate) : ""}`);
    });
    return out.join("\n");
  }

  /* -- a specific purchase order by id ("PO-7", "purchase order 7") -- */
  const poRef = /\b(?:po|purchase\s?orders?)[-\s#]?0*(\d+)\b/i.exec(q);
  if (poRef) {
    if (!Array.isArray(st.purchaseorders)) return notForRole("Purchase orders");
    const poNum = (s) => { const m = /^\s*po[-\s]?0*(\d+)\s*$/i.exec(String(s || "")); return m ? m[1] : null; };
    const po = st.purchaseorders.find((p) => poNum(p.id) === poRef[1]);
    if (!po) return `I can't see a purchase order "PO-${poRef[1]}" from your login.`;
    const sup = (st.suppliers || []).find((s) => s.id === po.supplierId);
    const out = [
      `${po.id}${sup ? " — " + sup.name : ""}`,
      `• Status: ${po.status || "Open"}`,
      po.date ? `• Ordered: ${po.date}` : null,
      po.eta ? `• ETA: ${po.eta}` : null,
      po.value != null ? `• Value: ${fmtM(po.value)}` : null,
    ].filter(Boolean);
    (po.lines || []).forEach((l) => {
      const it = itemById[l.itemId] || {};
      const pend = (+l.qty || 0) - (+l.recd || 0);
      out.push(`   – ${it.name || l.itemId} · ordered ${fmtQ(l.qty)}, received ${fmtQ(l.recd || 0)}${pend > 0.001 ? ", PENDING " + fmtQ(pend) : " ✓"}`);
    });
    return out.join("\n");
  }

  /* -- low stock / reorder -- */
  if (has("low stock", "reorder", "running out", "shortage", "understock", "below minimum")) {
    if (!Array.isArray(st.items)) return notForRole("Stock levels vs reorder points");
    const oh = onHand(st);
    const low = st.items
      .filter((i) => (+i.reorder || 0) > 0)
      .map((i) => ({ i, qty: (oh[i.id] || {}).qty || 0 }))
      .filter((x) => x.qty <= (+x.i.reorder || 0))
      .sort((a, b) => (a.qty / (+a.i.reorder || 1)) - (b.qty / (+b.i.reorder || 1)));
    if (!low.length) return "Nothing is below its reorder level right now. ✓";
    return [`${low.length} item(s) at or below reorder level:`]
      .concat(low.slice(0, 10).map((x) => `• ${x.i.name} — ${fmtQ(x.qty)} ${x.i.uom || ""} on hand (reorder at ${fmtQ(x.i.reorder)})`))
      .concat(low.length > 10 ? [`…and ${low.length - 10} more. See Inventory for the full list.`] : [])
      .join("\n");
  }

  /* -- BOM / recipe of a product --
     Two shapes: officer/lab carry the raw `boms` map; the supervisor view
     ships `finishedProducts` with the same recipe already expanded per unit.
     Use whichever this role's view carries, so the floor gets recipe answers
     too — quantities only, exactly what their view already shows. */
  if (has("bom", "recipe", "formula", "goes into", "made of", "made from", "materials for", "material required", "materials required", "materials needed")) {
    const recipeFor = (it) => {
      const bom = st.boms && st.boms[it.id];
      if (bom && (bom.lines || []).length) {
        const Y = bom.yield || 1;
        try {
          return BC.toLegacy(bom, BC.metaFromItem(it)).map(([rid, per]) => {
            const m = itemById[rid] || {};
            return { name: m.name || rid, uom: m.uom || "", perUnit: per / Y };
          });
        } catch { /* legacy shape below */ }
        return bom.lines.map((l) => {
          const rid = Array.isArray(l) ? l[0] : l.itemId;
          const m = itemById[rid] || {};
          return { name: m.name || rid, uom: m.uom || "", perUnit: (Array.isArray(l) ? +l[1] : +l.qty) || 0 };
        });
      }
      const fp = (st.finishedProducts || []).find((p) => p.id === it.id);
      return fp && (fp.recipe || []).length ? fp.recipe : null;
    };
    const rest = qT.filter((t) => !["bom","boms","recipe","formula","material","materials","required","needed","goes","into","made","make","making"].includes(t));
    const found = matchItems(rest, items).map((it) => ({ it, recipe: recipeFor(it) })).filter((x) => x.recipe);
    if (found.length) {
      /* "materials for 500 kg of X" scales the per-unit recipe. The number must
         follow for/make/produce — a bare number would read the "25" out of a
         product named "Tape 25mm" and silently scale the whole answer by 25. */
      const qm = /\b(?:for|make|making|produce)\s+(\d+(?:\.\d+)?)/i.exec(q);
      const mult = qm && +qm[1] > 0 ? +qm[1] : 1;
      return found.slice(0, 2).map(({ it, recipe }) => {
        const head = mult !== 1
          ? `${it.name} — materials for ${fmtQ(mult)} ${it.uom || "unit"}:`
          : `${it.name} — recipe per ${it.uom || "unit"}:`;
        return [head].concat(recipe.map((r) => `   – ${r.name}: ${fmtQ((r.perUnit || 0) * mult)} ${r.uom || ""}`)).join("\n");
      }).join("\n\n");
    }
    const n = st.boms ? Object.keys(st.boms).filter((k) => ((st.boms[k] || {}).lines || []).length).length
      : (st.finishedProducts || []).filter((p) => (p.recipe || []).length).length;
    if (!n && !st.boms && !Array.isArray(st.finishedProducts)) return notForRole("BOM / recipe data");
    return `${n} product(s) have a recipe on file. Ask about one by name, e.g. "BOM of <product name>".`;
  }

  /* -- overdue / due-soon (before the production intent, which would
        otherwise swallow "overdue work orders" via the words "work order") -- */
  if (has("overdue", "delayed", "behind schedule", "due today", "due tomorrow", "due this week", "due soon", "running late")) {
    const today = todayISO();
    const wos = (st.workorders || []).filter(woOpen);
    const lines = [];
    const late = wos.filter((w) => w.due && w.due < today);
    const soon = wos.filter((w) => w.due && w.due >= today && w.due <= shiftISO(7));
    if (late.length) {
      lines.push(`${late.length} open work order(s) past their due date:`);
      late.slice(0, 8).forEach((w) => lines.push(`   – ${w.id} ${woProduct(w, itemById)} · due ${w.due}`));
    }
    if (soon.length) {
      lines.push(`${soon.length} due within 7 days:`);
      soon.slice(0, 8).forEach((w) => lines.push(`   – ${w.id} ${woProduct(w, itemById)} · due ${w.due}`));
    }
    if (Array.isArray(st.purchaseorders)) {
      const latePo = st.purchaseorders.filter((p) => p.eta && p.eta < today && (p.lines || []).some((l) => (+l.recd || 0) < (+l.qty || 0)));
      if (latePo.length) {
        lines.push(`${latePo.length} purchase order(s) past ETA with material still pending:`);
        latePo.slice(0, 5).forEach((p) => lines.push(`   – ${p.id} · ETA ${p.eta}`));
      }
    }
    if (!lines.length) return "Nothing visible to your login is overdue, and nothing is due in the next 7 days. ✓";
    return lines.join("\n");
  }

  /* -- HR: attendance, leave, payroll, workers (office/admin views only) -- */
  if (has("attendance", "absent", "absentee", "on leave", "leave request", "leave application", "pending leave", "leaves pending",
          "worker", "employee", "staff", "manpower", "headcount", "payroll", "payrun", "payslip", "salary", "salaries", "wage")) {
    if (!Array.isArray(st.hrWorkers)) return notForRole("HR data");
    const byId = Object.fromEntries(st.hrWorkers.map((w) => [w.id, w]));
    const today = todayISO();

    if (has("on leave", "leave request", "leave application", "pending leave", "leaves pending")) {
      const leaves = st.hrLeaves || [];
      if (has("on leave")) {
        const now = leaves.filter((l) => String(l.status || "").toLowerCase() === "approved" && l.fromDate <= today && (l.toDate || l.fromDate) >= today);
        if (now.length) {
          return [`${now.length} worker(s) on approved leave today:`]
            .concat(now.slice(0, 10).map((l) => `• ${(byId[l.workerId] || {}).name || l.workerId} — ${l.type || "leave"} until ${l.toDate || l.fromDate}`)).join("\n");
        }
      }
      const pend = leaves.filter((l) => String(l.status || "Pending").toLowerCase() === "pending");
      if (!pend.length) return "No leave requests are pending, and nobody is on approved leave today. ✓";
      return [`${pend.length} leave request(s) pending approval:`]
        .concat(pend.slice(0, 8).map((l) => `• ${(byId[l.workerId] || {}).name || l.workerId} — ${l.type || "leave"} · ${l.fromDate}${l.toDate && l.toDate !== l.fromDate ? " → " + l.toDate : ""}${l.days ? " · " + fmtQ(l.days) + " day(s)" : ""}`))
        .join("\n");
    }

    if (has("attendance", "absent", "absentee")) {
      /* An empty day must say "not recorded yet" — an unmarked register is not
         a full house, the same absent-≠-all-clear rule the lab intent learned. */
      const rows = (st.hrAttendance || []).filter((a) => a.date === today);
      if (!rows.length) return `No attendance has been recorded for today (${today}) yet.`;
      const byStatus = {};
      rows.forEach((a) => { const s = String(a.status || "?"); byStatus[s] = (byStatus[s] || 0) + 1; });
      const lines = [`Attendance for ${today} — ${rows.length} recorded:`,
        "• " + Object.keys(byStatus).map((s) => `${s}: ${byStatus[s]}`).join(" · ")];
      const absent = rows.filter((a) => /^a/i.test(String(a.status || "")));
      if (absent.length) {
        lines.push("Absent:");
        absent.slice(0, 10).forEach((a) => lines.push(`   – ${(byId[a.workerId] || {}).name || a.workerId}`));
      }
      return lines.join("\n");
    }

    if (has("payroll", "payrun", "payslip", "salary", "salaries", "wage")) {
      const rest = qT.filter((t) => !["payroll","payrun","payslip","salary","salaries","wage","wages"].includes(t));
      if (rest.length) {
        const hits = st.hrWorkers.filter((w) => { const n = tokens(w.name); return rest.some((t) => n.some((x) => x === t || x.startsWith(t))); });
        if (hits.length && hits.length <= 3) {
          return hits.map((w) => [`${w.name}`, w.dept ? `• Dept: ${w.dept}` : null,
            w.designation ? `• Designation: ${w.designation}` : null,
            w.payType === "monthly" ? `• Monthly CTC: ${fmtM(w.monthlyCtc)}` : `• Daily rate: ${fmtM(w.dailyRate)}`,
          ].filter(Boolean).join("\n")).join("\n\n");
        }
      }
      const runs = st.hrPayruns || [];
      if (!runs.length) return "No pay runs have been generated yet.";
      const last = runs[runs.length - 1];
      return `Pay runs on file: ${runs.length}. Latest: ${last.period || last.id} · ${last.status || "Draft"}.`;
    }

    // generic workers: a name lookup, else the headcount with a dept breakdown
    const rest = qT.filter((t) => !["worker","workers","employee","employees","staff","manpower","headcount","many","active"].includes(t));
    if (rest.length) {
      const hits = st.hrWorkers.filter((w) => { const n = tokens(w.name).concat(tokens(w.dept)); return rest.some((t) => n.some((x) => x === t || x.startsWith(t))); });
      if (hits.length && hits.length <= 3) {
        return hits.map((w) => [`${w.name}`, w.dept ? `• Dept: ${w.dept}` : null,
          w.designation ? `• Designation: ${w.designation}` : null,
          `• ${w.active === false ? "Inactive" : "Active"}${w.joined ? " · joined " + w.joined : ""}`,
        ].filter(Boolean).join("\n")).join("\n\n");
      }
    }
    const active = st.hrWorkers.filter((w) => w.active !== false);
    const byDept = {};
    active.forEach((w) => { const dp = w.dept || "—"; byDept[dp] = (byDept[dp] || 0) + 1; });
    return [`Workers: ${st.hrWorkers.length} on file, ${active.length} active.`]
      .concat(Object.keys(byDept).map((dp) => `• ${dp}: ${byDept[dp]}`)).join("\n");
  }

  /* -- calendar / appointments -- */
  if (has("appointment", "meeting", "calendar", "agenda")) {
    if (!Array.isArray(st.appointments)) return notForRole("The calendar");
    const today = todayISO();
    let scope = "coming up", rows;
    if (has("today")) { scope = "today"; rows = st.appointments.filter((a) => a.date === today); }
    else if (has("tomorrow")) { scope = "tomorrow"; const t = shiftISO(1); rows = st.appointments.filter((a) => a.date === t); }
    else if (has("week")) { scope = "this week"; const end = shiftISO(7); rows = st.appointments.filter((a) => a.date >= today && a.date <= end); }
    else rows = st.appointments.filter((a) => a.date >= today);
    rows = rows.slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
    if (!rows.length) return `No appointments ${scope}. (${st.appointments.length} on the calendar in total.)`;
    return [`${rows.length} appointment(s) ${scope}:`]
      .concat(rows.slice(0, 8).map((a) => `• ${a.date}${a.time ? " " + a.time : ""} — ${a.title || a.name || a.subject || "(untitled)"}${a.with ? " · " + a.with : ""}`))
      .join("\n");
  }

  /* -- CRM leads / follow-ups --
     "leads" plural-only on purpose: the singular would swallow "lead time". */
  if (has("leads", "crm", "pipeline", "follow up", "followup", "enquiry", "enquiries", "inquiry", "prospect")) {
    if (!Array.isArray(st.leads)) return notForRole("CRM leads");
    if (!st.leads.length) return "No leads in the CRM yet.";
    const today = todayISO();
    const byStage = {};
    st.leads.forEach((l) => { const s = l.stage || "—"; byStage[s] = (byStage[s] || 0) + 1; });
    const lines = [`Leads: ${st.leads.length} in the pipeline.`,
      "• " + Object.keys(byStage).map((s) => `${s}: ${byStage[s]}`).join(" · ")];
    const due = st.leads.filter((l) => l.nextFollowUp && l.nextFollowUp <= today && !/won|lost|closed/i.test(l.stage || ""));
    if (due.length) {
      lines.push(`${due.length} follow-up(s) due:`);
      due.slice(0, 8).forEach((l) => lines.push(`   – ${l.company || l.contact || l.id} · ${l.nextFollowUp}${l.owner ? " · " + l.owner : ""}`));
    }
    return lines.join("\n");
  }

  /* -- stock movements (GRNs in, issues out) for a day -- */
  if (has("grn", "receipt", "came in", "inward", "outward", "issued", "stock movement", "movement")) {
    if (!Array.isArray(st.movements)) return notForRole("Stock movement history");
    const yday = has("yesterday");
    const day = yday ? shiftISO(-1) : todayISO();
    const rows = st.movements.filter((m) => String(m.date || "").startsWith(day));
    if (!rows.length) return `No stock movements recorded ${yday ? "yesterday" : "today"} (${day}).`;
    const byType = {};
    rows.forEach((m) => { const t = m.type || "?"; byType[t] = (byType[t] || 0) + 1; });
    const lines = [`${rows.length} stock movement(s) on ${day}:`,
      "• " + Object.keys(byType).map((t) => `${t}: ${byType[t]}`).join(" · ")];
    rows.slice(0, 8).forEach((m) => {
      const it = itemById[m.itemId] || {};
      lines.push(`   – ${m.type || "?"} · ${it.name || m.itemId} · ${fmtQ(m.qty)} ${it.uom || ""}${m.ref ? " · " + m.ref : ""}`);
    });
    if (rows.length > 8) lines.push(`   …and ${rows.length - 8} more.`);
    return lines.join("\n");
  }

  /* -- production summary (today / overall) -- */
  if (has("production", "work order", "workorder", "jobs", "wip", "on the floor", "making")) {
    const wos = st.workorders || [];
    if (!wos.length) return "There are no work orders visible to your login.";
    const open = wos.filter(woOpen);
    const today = todayISO();
    const doneToday = wos.filter((w) => (w.route || []).some((r) => r.doneAt && String(r.doneAt).startsWith(today)));
    const lines = [`Production right now:`, `• Open work orders: ${open.length} of ${wos.length}`];
    if (doneToday.length) lines.push(`• Jobs with a stage completed today: ${doneToday.length}`);
    open.slice(0, 8).forEach((w) => {
      const stg = woStage(w);
      lines.push(`   – ${w.id} ${woProduct(w, itemById)} · ${fmtQ(w.qty)} · ${stg ? stg.name + " (" + (stg.status || "Pending") + ")" : w.status}`);
    });
    if (open.length > 8) lines.push(`   …and ${open.length - 8} more.`);
    return lines.join("\n");
  }

  /* -- sales orders / revenue --
     "so" is not a trigger: it is an ordinary English word, and "we are low on
     mica so what should I order" was being answered with a sales-order listing.
     A quoted id ("SO-14", "so 14") is answered in detail further up. */
  if (has("sales order", "sales", "revenue", "order value", "customer order", "dispatched")) {
    if (!Array.isArray(st.salesorders)) return notForRole("Sales orders");
    const sos = st.salesorders;
    const open = sos.filter((s) => s.status !== "Dispatched");
    const lines = [`Sales orders: ${sos.length} total, ${open.length} open.`];
    const withValue = sos.filter((s) => s.value != null);
    if (withValue.length && has("revenue", "value")) {
      const total = withValue.reduce((a, s) => a + (+s.value || 0), 0);
      const openV = open.reduce((a, s) => a + (+s.value || 0), 0);
      lines.push(`• Total order value: ${fmtM(total)} (open: ${fmtM(openV)})`);
    }
    const custById = Object.fromEntries((st.customers || []).map((c) => [c.id, c]));
    open.slice(0, 8).forEach((s) => {
      const cust = custById[s.customerId];
      lines.push(`   – ${s.id}${cust ? " · " + cust.name : ""}${s.value != null ? " · " + fmtM(s.value) : ""} · ${s.status || "Open"}`);
    });
    return lines.join("\n");
  }

  /* -- purchase orders --  ("po " matched any word ending in -po: "tempo").
     A quoted id ("PO-7") is answered in detail further up. */
  if (has("purchase order", "purchase", "incoming material", "supplier order")) {
    if (!Array.isArray(st.purchaseorders)) return notForRole("Purchase orders");
    const pos = st.purchaseorders;
    const pending = pos.filter((p) => (p.lines || []).some((l) => (+l.recd || 0) < (+l.qty || 0)));
    const supById = Object.fromEntries((st.suppliers || []).map((s) => [s.id, s]));
    const lines = [`Purchase orders: ${pos.length} total, ${pending.length} awaiting material.`];
    pending.slice(0, 8).forEach((p) => {
      const sup = supById[p.supplierId];
      lines.push(`   – ${p.id}${sup ? " · " + sup.name : ""}${p.eta ? " · ETA " + p.eta : ""}${p.value != null ? " · " + fmtM(p.value) : ""}`);
    });
    return lines.join("\n");
  }

  /* -- lab / QC -- */
  if (has("lab", "laboratory", "test", "qc", "quality", "batch", "certificate", "measurement")) {
    /* A supervisor's view carries neither key. Treating "redacted" as "empty"
       told the coating floor "No jobs are waiting on a lab measurement ✓" while
       batches genuinely owed one — a fabricated all-clear to the exact role
       running the QC gate. Absent data must report absent. */
    if (!Array.isArray(st.labPending) && !Array.isArray(st.labReports)) {
      return notForRole("Lab and QC status");
    }
    const pend = st.labPending || [];
    const reps = st.labReports || [];
    const lines = [];
    if (pend.length) {
      lines.push(`${pend.length} job(s) still owe a lab measurement:`);
      pend.slice(0, 8).forEach((p) => lines.push(`   – ${p.woId || p.id || "?"}${p.batchNo ? " · Batch " + p.batchNo : ""}${p.productName ? " · " + p.productName : ""}`));
    } else lines.push("No jobs are waiting on a lab measurement. ✓");
    lines.push(`Lab reports on file: ${reps.length}.`);
    return lines.join("\n");
  }

  /* -- counts ("how many X") — before the lookups so a count stays a count -- */
  if (has("how many")) {
    const c = (label, arr) => (Array.isArray(arr) ? `${label}: ${arr.length}` : null);
    const wants = [];
    if (has("item", "product", "sku")) wants.push(c("Items", items));
    if (has("customer")) wants.push(c("Customers", st.customers));
    if (has("supplier", "vendor")) wants.push(c("Suppliers", st.suppliers));
    if (has("work order", "job")) wants.push(c("Work orders", st.workorders));
    if (has("warehouse", "store")) wants.push(c("Warehouses", st.warehouses));
    const got = wants.filter(Boolean);
    if (got.length) return got.join("\n");
  }

  /* -- customer lookup -- */
  if (has("customer", "client", "buyer")) {
    if (!Array.isArray(st.customers)) return notForRole("Customer data");
    const rest = qT.filter((t) => !["customer","customers","client","clients","buyer"].includes(t));
    if (rest.length) {
      const found = st.customers.filter((c) => { const n = tokens(c.name); return rest.some((t) => n.some((x) => x.includes(t) || t.includes(x))); });
      if (found.length) {
        return found.slice(0, 3).map((c) => {
          const sos = (st.salesorders || []).filter((s) => s.customerId === c.id && s.status !== "Dispatched");
          return [`${c.name}`, c.city ? `• City: ${c.city}` : null, c.phone ? `• Phone: ${c.phone}` : null,
            c.email ? `• Email: ${c.email}` : null, c.gstin ? `• GSTIN: ${c.gstin}` : null,
            `• Open sales orders: ${sos.length}`].filter(Boolean).join("\n");
        }).join("\n\n");
      }
    }
    return `${st.customers.length} customer(s) on file: ${st.customers.slice(0, 12).map((c) => c.name).join(", ")}${st.customers.length > 12 ? ", …" : ""}`;
  }

  /* -- supplier lookup -- */
  if (has("supplier", "vendor")) {
    if (!Array.isArray(st.suppliers)) return notForRole("Supplier data");
    const rest = qT.filter((t) => !["supplier","suppliers","vendor","vendors"].includes(t));
    if (rest.length) {
      const found = st.suppliers.filter((s) => { const n = tokens(s.name); return rest.some((t) => n.some((x) => x.includes(t) || t.includes(x))); });
      if (found.length) {
        return found.slice(0, 3).map((s) => [`${s.name}`, s.city ? `• City: ${s.city}` : null,
          s.phone ? `• Phone: ${s.phone}` : null, s.email ? `• Email: ${s.email}` : null,
          s.gstin ? `• GSTIN: ${s.gstin}` : null].filter(Boolean).join("\n")).join("\n\n");
      }
    }
    return `${st.suppliers.length} supplier(s) on file: ${st.suppliers.slice(0, 12).map((s) => s.name).join(", ")}${st.suppliers.length > 12 ? ", …" : ""}`;
  }

  /* -- transporters / dispatch -- */
  if (has("transporter", "transport", "logistics", "freight", "carrier")) {
    if (!Array.isArray(st.transporters)) return notForRole("The transport directory");
    if (!st.transporters.length) return "The transport directory is empty.";
    return [`${st.transporters.length} transporter(s):`]
      .concat(st.transporters.slice(0, 8).map((t) => `• ${t.name}${t.city ? " · " + t.city : ""}${t.phone ? " · " + t.phone : ""}`)).join("\n");
  }

  /* -- price / cost of an item (officer only — others never get the fields) -- */
  if (has("price", "cost", "rate", "valuation")) {
    if (!Array.isArray(st.items) || !st.items.some((i) => i.cost != null || i.price != null)) {
      return notForRole("Price and cost data");
    }
    const found = matchItems(qT, items);
    if (found.length === 1 || (found.length && found.length <= 3)) {
      return found.map((i) => [`${i.name}`, i.cost != null ? `• Cost: ${fmtM(i.cost)} / ${i.uom || "unit"}` : null,
        i.price != null ? `• Price: ${fmtM(i.price)} / ${i.uom || "unit"}` : null].filter(Boolean).join("\n")).join("\n\n");
    }
    return "Which item's price? Try: \"price of <item name>\".";
  }

  /* -- stock of a specific item (needs a fuzzy item hit to fire) -- */
  if (has("stock", "on hand", "inventory", "how much", "how many", "available", "balance", "quantity", "qty")) {
    const found = matchItems(qT.filter((t) => !["stock","inventory","hand","available","balance","quantity","qty","much","many","left"].includes(t)), items);
    if (found.length) {
      if (!stockVisible(st)) return notForRole("Live stock quantities");
      const oh = onHand(st);
      return found.slice(0, 3).map((i) => {
        const o = oh[i.id] || { qty: 0, byWh: {} };
        const whs = Object.entries(o.byWh).filter(([, q]) => Math.abs(q) > 0.001)
          .map(([n, q]) => `${n}: ${fmtQ(q)}`).join(" · ");
        return `${i.name} — ${fmtQ(o.qty)} ${i.uom || ""} on hand${whs ? "\n   (" + whs + ")" : ""}`;
      }).join("\n");
    }
    if (has("stock", "inventory")) {
      if (!stockVisible(st)) return notForRole("Live stock quantities");
      const oh = onHand(st);
      const total = items.filter((i) => (oh[i.id] || {}).qty > 0.001).length;
      if (!total) return "Nothing is in stock right now — no item carries a balance.";
      return `${total} item(s) currently in stock. Ask about one by name, e.g. "stock of mica tape".`;
    }
  }

  /* -- warehouses -- */
  if (has("warehouse", "godown", "stores")) {
    if (!Array.isArray(st.warehouses)) return notForRole("Warehouse data");
    return [`${st.warehouses.length} warehouse(s):`]
      .concat(st.warehouses.map((w) => `• ${w.name}${w.city ? " · " + w.city : ""}`)).join("\n");
  }

  return null; // no intent matched — caller falls back to KB / item card / help
}

/* Last-resort lookup: no intent fired and no trained answer scored — but if
   the question is clearly ABOUT an item ("tell me about mica tape"), an item
   card beats the help text. Deliberately strict (two token hits, or the whole
   name covered) so a single loose word can't hijack the fallback. Runs AFTER
   the KB pass in ask(), so it can never shadow a trained answer. */
function itemCardAnswer(q, st) {
  const qT = tokens(q);
  const items = stateItems(st);
  if (!qT.length || !items.length) return null;
  const scored = [];
  items.forEach((it) => {
    const name = tokens(it.name);
    const idTok = String(it.id || "").toLowerCase();
    let s = 0;
    qT.forEach((t) => { if (t === idTok || name.some((n) => n === t || n.startsWith(t) || t.startsWith(n))) s++; });
    if (s) scored.push({ it, s, cover: s / Math.max(name.length, 1) });
  });
  if (!scored.length) return null;
  scored.sort((a, b) => b.s - a.s || b.cover - a.cover);
  if (scored[0].s < 2 && scored[0].cover < 1) return null;
  const oh = stockVisible(st) ? onHand(st) : null;
  return scored.filter((x) => x.s === scored[0].s).slice(0, 3).map(({ it }) => [
    `${it.name} (${it.id})`,
    it.cat ? `• Category: ${it.cat}` : null,
    it.uom ? `• Unit: ${it.uom}` : null,
    it.hsn ? `• HSN: ${it.hsn}` : null,
    it.cost != null ? `• Cost: ${fmtM(it.cost)} / ${it.uom || "unit"}` : null,
    it.price != null ? `• Price: ${fmtM(it.price)} / ${it.uom || "unit"}` : null,
    oh ? `• On hand: ${fmtQ((oh[it.id] || {}).qty || 0)} ${it.uom || ""}` : null,
    (+it.reorder || 0) > 0 ? `• Reorder level: ${fmtQ(it.reorder)}` : null,
    st.boms && st.boms[it.id] ? "• Has a recipe (BOM) on file — ask \"BOM of " + it.name + "\"" : null,
  ].filter(Boolean).join("\n")).join("\n\n");
}

const HELP = [
  "I answer from the live ERP data — every answer is fetched fresh the moment you ask. Try:",
  "• \"stock of <item name>\" / \"tell me about <item>\"",
  "• \"low stock\" / \"what needs reordering\"",
  "• \"production today\" / \"WO-012 status\" / \"overdue work orders\"",
  "• \"SO-14 status\" / \"PO-7 status\" / \"purchase orders pending\"",
  "• \"BOM of <product>\" / \"materials for 500 kg of <product>\"",
  "• \"customer <name>\" / \"supplier <name>\" / \"transporters\"",
  "• \"pending lab tests\"",
  "• \"who is absent today\" / \"pending leave requests\" (office)",
  "• \"appointments this week\" / \"open leads\" / \"what came in today\" (office)",
  "The office team can also train me with company Q&A under the ⚙ Train tab.",
].join("\n");

/* ---------------- public API ---------------- */

/** Answer one question for this user. Data is read AT ASK TIME (always live)
    and only through the role-filtered view. */
function ask(user, q) {
  q = String(q == null ? "" : q).trim();
  if (!q) throw err("Ask me something — e.g. \"low stock\" or \"status of WO-012\".", 400);
  if (q.length > 500) throw err("Keep questions under 500 characters.", 400);

  const kb = repo.listChatKnowledge();
  const qT = tokens(q);
  let best = null, bestScore = 0;
  kb.forEach((e) => { const s = kbScore(qT, q, e); if (s > bestScore) { best = e; bestScore = s; } });

  // a near-verbatim trained question always wins
  if (best && bestScore >= 0.8) return { answer: best.answer, source: "kb", kbId: best.id, asOf: new Date().toISOString() };

  const st = view.stateForUser(user);       // ROLE-FILTERED live data
  const live = intentAnswers(user, q, st);
  if (live) return { answer: live, source: "erp", asOf: new Date().toISOString() };

  if (best && bestScore >= 0.45) return { answer: best.answer, source: "kb", kbId: best.id, asOf: new Date().toISOString() };

  // clearly about an item, just not phrased as a stock/price question
  const card = itemCardAnswer(q, st);
  if (card) return { answer: card, source: "erp", asOf: new Date().toISOString() };

  if (/help|what can you|hi$|hello|hey/i.test(q)) return { answer: HELP, source: "help", asOf: new Date().toISOString() };
  return {
    answer: "I couldn't match that to the ERP data or my training yet.\n\n" + HELP,
    source: "help", asOf: new Date().toISOString(),
  };
}

/** Compact per-role stats for the widget's minute refresh. */
function snapshot(user) {
  const st = view.stateForUser(user, { slim: true });
  const facts = [];
  const wos = st.workorders || [];
  const open = wos.filter(woOpen);
  if (user.role === "supervisor") {
    facts.push({ k: "Jobs on board", v: wos.filter((w) => w.mine !== false).length });
    facts.push({ k: "Open", v: open.length });
  } else {
    facts.push({ k: "Open WOs", v: open.length });
    if (Array.isArray(st.items)) {
      const oh = onHand(st);
      const low = st.items.filter((i) => (+i.reorder || 0) > 0 && ((oh[i.id] || {}).qty || 0) <= (+i.reorder || 0)).length;
      facts.push({ k: "Low stock", v: low });
    }
    if (Array.isArray(st.salesorders)) facts.push({ k: "Open SOs", v: st.salesorders.filter((s) => s.status !== "Dispatched").length });
    if (Array.isArray(st.purchaseorders)) facts.push({ k: "POs pending", v: st.purchaseorders.filter((p) => (p.lines || []).some((l) => (+l.recd || 0) < (+l.qty || 0))).length });
  }
  if (Array.isArray(st.labPending)) facts.push({ k: "Lab pending", v: st.labPending.length });
  return { asOf: new Date().toISOString(), facts };
}

/* ---------------- knowledge base CRUD (admin/office) ---------------- */
function normKeywords(v) {
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
  return String(v || "").split(/[,;|]/).map((s) => s.trim()).filter(Boolean);
}
function listKnowledge() { return repo.listChatKnowledge(); }

/** Accepts one entry or a bulk array — this is the "upload training data" door. */
function addKnowledge(user, body) {
  const raw = Array.isArray(body) ? body : (Array.isArray(body && body.entries) ? body.entries : [body]);
  if (!raw.length) throw err("Nothing to train — send {question, answer} or {entries:[…]}.");
  if (raw.length > 2000) throw err("Upload at most 2000 entries per request.");
  const existing = repo.listChatKnowledge();
  const added = [];
  /* Validate the WHOLE upload before a single row is written. This used to save
     as it went, so a blank answer on row 1500 left 1499 rows committed under an
     error message that never said so — and the corrected re-upload added them
     all a second time under fresh ids. Build first, then write in one go. */
  raw.forEach((e, i) => {
    const question = String((e && e.question) || "").trim();
    const answer = String((e && e.answer) || "").trim();
    if (!question || !answer) {
      throw err(`Every entry needs a question and an answer — entry ${i + 1} of ${raw.length} is missing ${!question ? "a question" : "an answer"}. Nothing was saved.`);
    }
    added.push({
      id: nextId(existing.concat(added), "KB-"),
      question: question.slice(0, 500),
      answer: answer.slice(0, 4000),
      keywords: normKeywords(e.keywords),
      tags: normKeywords(e.tags),
      addedBy: (user && user.username) || "?",
      addedAt: new Date().toISOString(),
    });
  });
  repo.putChatKnowledgeBulk(added);
  return { added: added.length, entries: added };
}

function updateKnowledge(id, patch) {
  const cur = repo.getChatKnowledge(id);
  if (!cur) throw err("Training entry not found", 404);
  const merged = Object.assign({}, cur, {
    question: patch.question != null ? String(patch.question).trim().slice(0, 500) : cur.question,
    answer: patch.answer != null ? String(patch.answer).trim().slice(0, 4000) : cur.answer,
    keywords: patch.keywords != null ? normKeywords(patch.keywords) : cur.keywords,
    tags: patch.tags != null ? normKeywords(patch.tags) : cur.tags,
  });
  if (!merged.question || !merged.answer) throw err("Question and answer cannot be blank.");
  return repo.putChatKnowledge(merged);
}

function deleteKnowledge(id) {
  if (!repo.getChatKnowledge(id)) throw err("Training entry not found", 404);
  return repo.deleteChatKnowledge(id);
}

module.exports = { ask, snapshot, listKnowledge, addKnowledge, updateKnowledge, deleteKnowledge };
