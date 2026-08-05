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

  /* -- a specific work order by id -- */
  const woId = /\b(wo[- ]?\d+)\b/i.exec(q);
  if (woId) {
    const id = woId[1].toUpperCase().replace(/\s+/, "-").replace("WO", "WO-").replace("WO--", "WO-");
    /* Real ids are zero-padded to four ("WO-0012"), so a strict string compare
       failed every natural way of typing it — "WO 12", "wo12", even the help
       text's own "WO-012". Compare the number, not the padding. */
    const woNum = (s) => { const m = /^\s*wo[-\s]?0*(\d+)\s*$/i.exec(String(s || "")); return m ? m[1] : null; };
    const want = woNum(id);
    const wo = (st.workorders || []).find((w) => want != null && woNum(w.id) === want);
    if (!wo) return `I can't see a work order "${id}" from your login.`;
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
     A quoted id ("SO-14", "so 14") still gets you here. */
  const soRef = /\bso[-\s]?\d+\b/i.test(q);
  if (soRef || has("sales order", "sales", "revenue", "order value", "customer order", "dispatched")) {
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

  /* -- purchase orders --  ("po " matched any word ending in -po: "tempo") -- */
  const poRef = /\bpo[-\s]?\d+\b/i.test(q);
  if (poRef || has("purchase order", "purchase", "incoming material", "supplier order")) {
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

  return null; // no intent matched — caller falls back to KB / help
}

const HELP = [
  "I answer from the live ERP data — every answer is fetched fresh the moment you ask. Try:",
  "• \"stock of <item name>\"",
  "• \"low stock\" / \"what needs reordering\"",
  "• \"production today\" / \"WO-012 status\"",
  "• \"open sales orders\" / \"purchase orders pending\"",
  "• \"customer <name>\" / \"supplier <name>\"",
  "• \"pending lab tests\"",
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
