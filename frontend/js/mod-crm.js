/* ============================================================
   CHHAPERIA ERP — CRM PIPELINE MODULE  (frontend / presentation)
   A simple, efficient B2B sales CRM:
     • KPI strip  (open leads, weighted pipeline, win rate, won value)
     • Follow-up reminders (due today / overdue)
     • Pipedrive-style pipeline board (New→Contacted→Quoted→Won/Lost)
     • Lead detail drawer: info, activity timeline, log activity,
       move stage, edit, convert-to-customer
   Reads from ENG (engine) + DB; persists via App.persistAndRefresh().
   ============================================================ */
(function () {
  "use strict";
  const { h, esc, table, badge, toast, modal, confirm } = UI;
  const { pageHead, kpi } = MW;

  const STAGE_META = {
    New:       { color: "var(--c2)",  ic: "✨" },
    Contacted: { color: "var(--c4)",  ic: "📞" },
    Quoted:    { color: "var(--c5)",  ic: "📄" },
    Won:       { color: "var(--ok)",  ic: "🏆" },
    Lost:      { color: "var(--danger)", ic: "✕" },
  };
  const ACT_TYPES = ["Call", "Email", "Meeting", "Quotation Sent", "Site Visit", "Note"];
  const SOURCES = ["Exhibition (Wire India)", "Website Enquiry", "Referral", "Cold Call", "Existing Customer", "Trade Directory"];
  const money = (n) => ENG.money(n);
  const trim = (s, n) => { s = String(s || ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
  const todayISO = () => DB.helpers.iso(DB.helpers.today());

  M.crm = { title: "CRM Pipeline", sub: "Sales leads & enquiries", render(root, params) {
    const stats = ENG.crmStats();
    const due = ENG.dueFollowUps();

    root.appendChild(pageHead("CRM — Sales Pipeline",
      "Track enquiries from first contact to won order. Never miss a follow-up.",
      [ h("button", { class: "btn primary", onclick: () => leadForm(), html: "＋ New Lead" }) ]));

    /* ---- KPI strip ---- */
    root.appendChild(h("div", { class: "grid kpi-grid", style: "margin-bottom:16px" }, [
      kpi({ icon: "🎯", label: "Open Leads", value: ENG.num(stats.open),
            delta: stats.total + " total enquiries", deltaType: "flat" }),
      kpi({ icon: "⚖️", label: "Weighted Pipeline", value: money(stats.weighted),
            delta: "open value " + money(stats.openValue), deltaType: "flat" }),
      kpi({ icon: "🏆", label: "Win Rate", value: stats.winRate + "%",
            delta: stats.won + " won · " + stats.lost + " lost", deltaType: stats.winRate >= 50 ? "up" : "down" }),
      kpi({ icon: "💰", label: "Won Value", value: money(stats.wonValue),
            delta: "closed business", deltaType: "up" }),
    ]));

    /* ---- follow-up reminders ---- */
    if (due.length) {
      root.appendChild(h("div", { class: "card", style: "margin-bottom:16px;border-left:4px solid var(--warn)" }, [
        h("div", { class: "card-head" }, [
          h("h3", { html: "🔔 Follow-ups due (" + due.length + ")" }),
          h("div", { class: "sub", text: "Open leads due today or overdue — chase these first" }),
        ]),
        h("div", { class: "flex wrap gap" }, due.map((l) => {
          const overdue = l.nextFollowUp < todayISO();
          return h("div", {
            class: "chip", style: "cursor:pointer;padding:8px 12px;border:1px solid " + (overdue ? "var(--danger-line,var(--danger))" : "var(--line)"),
            onclick: () => leadDetail(l.id),
          }, [
            h("span", { class: "d", style: "background:" + (overdue ? "var(--danger)" : "var(--warn)") }),
            h("span", { html: "<b>" + esc(trim(l.company, 22)) + "</b> · " + (overdue ? "overdue " : "due ") + l.nextFollowUp }),
          ]);
        })),
      ]));
    }

    /* ---- pipeline board (Pipedrive-style columns) ---- */
    const pipeline = ENG.pipelineByStage();
    const board = h("div", { class: "crm-board" });
    pipeline.forEach((col) => {
      const meta = STAGE_META[col.stage] || { color: "var(--c1)", ic: "•" };
      const column = h("div", { class: "crm-col" }, [
        h("div", { class: "crm-col-head", style: "border-top:3px solid " + meta.color }, [
          h("div", { class: "flex aic gap" }, [
            h("span", { text: meta.ic }),
            h("span", { class: "crm-col-title", text: col.stage }),
            h("span", { class: "crm-col-count", text: col.count }),
          ]),
          h("div", { class: "crm-col-val", text: money(col.value) }),
        ]),
        h("div", { class: "crm-col-body" },
          col.items.length
            ? col.items.map((l) => leadCard(l))
            : [h("div", { class: "crm-empty", text: "No leads" })]
        ),
      ]);
      board.appendChild(column);
    });
    root.appendChild(board);
    if (params && params.openNew) { params.openNew = false; leadForm(); }

    /* a single draggable-feel lead card */
    function leadCard(l) {
      const overdue = l.nextFollowUp && l.nextFollowUp < todayISO() && l.stage !== "Won" && l.stage !== "Lost";
      return h("div", { class: "crm-card", onclick: () => leadDetail(l.id) }, [
        h("div", { class: "crm-card-top" }, [
          h("div", { class: "crm-card-co", text: trim(l.company, 24) }),
          h("div", { class: "crm-card-val", text: money(l.value) }),
        ]),
        h("div", { class: "crm-card-sub", text: trim((l.productName || l.product || "—"), 30) }),
        h("div", { class: "crm-card-foot" }, [
          h("span", { class: "muted", text: trim(l.contact || "—", 16) }),
          l.nextFollowUp
            ? h("span", { class: "crm-card-due", style: overdue ? "color:var(--danger)" : "color:var(--text-mut)",
                html: (overdue ? "⏰ " : "📅 ") + l.nextFollowUp.slice(5) })
            : h("span", { class: "muted", text: l.stage === "Won" ? "✓ closed" : l.stage === "Lost" ? "lost" : "" }),
        ]),
      ]);
    }
  }};

  /* ============================================================
     LEAD DETAIL — info, activity timeline, actions
     ============================================================ */
  function leadDetail(id) {
    const l = ENG.leads().find((x) => x.id === id);
    if (!l) { toast("Lead not found", { type: "danger" }); return; }
    const meta = STAGE_META[l.stage] || {};
    const acts = (l.activities || []).slice().sort((a, b) => (a.date < b.date ? 1 : -1));

    const body = h("div", {}, [
      /* stage + quick move */
      h("div", { class: "flex between aic wrap gap", style: "margin-bottom:16px" }, [
        h("div", { class: "flex aic gap" }, [
          h("span", { html: badge(stageBadge(l.stage), (meta.ic || "") + " " + l.stage) }),
          l.value ? h("span", { class: "chip", html: "💰 " + money(l.value) }) : null,
          l.quotedValue ? h("span", { class: "chip", html: "📄 Quoted " + money(l.quotedValue) }) : null,
        ]),
        (l.stage !== "Won" && l.stage !== "Lost")
          ? h("div", { class: "flex gap" }, [
              h("button", { class: "btn sm", onclick: () => moveStage(l), html: "➜ Move stage" }),
              h("button", { class: "btn sm primary", onclick: () => logActivity(l), html: "＋ Log activity" }),
            ])
          : null,
      ]),

      MW.dl([
        ["Contact", l.contact || "—"],
        ["Phone", MW.phoneCell(l.phone)],
        ["Email", MW.emailLink(l.email, { mode: "compose" })],
        ["City", l.city || "—"],
        ["Product Interest", l.productName || l.product || "—"],
        ["Source", l.source || "—"],
        ["Owner", l.owner || "—"],
        ["Created", l.created || "—"],
        ["Next Follow-up", l.nextFollowUp || "—"],
        ["Expected Close", l.expectedClose || "—"],
        l.lostReason ? ["Lost Reason", l.lostReason] : null,
        l.customerId ? ["Linked Customer", ENG.custName(l.customerId)] : null,
        l.salesOrderId ? ["Sales Order", l.salesOrderId + " →"] : null,
      ].filter(Boolean)),

      l.notes ? h("div", { class: "card", style: "margin-top:14px;box-shadow:none;background:var(--panel-2)" },
        [h("div", { class: "muted", style: "font-size:11px;font-weight:700;text-transform:uppercase;margin-bottom:4px", text: "Notes" }),
         h("div", { style: "font-size:13px;line-height:1.5", text: l.notes })]) : null,

      /* activity timeline */
      h("h3", { style: "margin:18px 0 10px;font-size:14px", text: "Activity Timeline (" + acts.length + ")" }),
      acts.length
        ? h("div", { class: "timeline" }, acts.map((a) => h("div", { class: "tl-item" }, [
            h("div", { class: "tt", html: actIcon(a.type) + " " + esc(a.type) + " <span class='muted' style='font-weight:500'>· " + a.date + "</span>" }),
            h("div", { class: "td", text: a.note || "" }),
            a.by ? h("div", { class: "muted", style: "font-size:11px;margin-top:2px", text: "by " + a.by }) : null,
          ])))
        : h("div", { class: "empty", style: "padding:20px" }, [h("div", { class: "big", text: "📭" }), h("div", { text: "No activities logged yet" })]),
    ]);

    const foot = [
      h("button", { class: "btn ghost", onclick: () => leadForm(l), text: "✎ Edit" }),
      (l.stage !== "Won" && l.stage !== "Lost")
        ? h("button", { class: "btn", style: "color:var(--danger)", onclick: () => closeLead(l, "Lost"), html: "✕ Mark Lost" })
        : null,
      (l.stage !== "Won")
        ? h("button", { class: "btn primary", style: "background:linear-gradient(135deg,var(--ok),#0f8a3c)", onclick: () => closeLead(l, "Won"), html: "🏆 Mark Won" })
        : null,
    ].filter(Boolean);

    modal({ title: l.company, sub: l.id + " · " + (l.productName || ""), wide: true, body, foot });
  }

  /* ---- move to next stage ---- */
  function moveStage(l) {
    const open = ["New", "Contacted", "Quoted"];
    const body = h("div", { class: "flex wrap gap" }, ENG.STAGES.map((st) => {
      const m = STAGE_META[st] || {};
      return h("button", { class: "btn" + (st === l.stage ? " primary" : ""),
        onclick: () => { applyStage(l, st); mo.close(); },
        html: (m.ic || "") + " " + st });
    }));
    const mo = modal({ title: "Move " + l.company, sub: "Current: " + l.stage, body });
  }
  function applyStage(l, st) {
    l.stage = st;
    if (st === "Won" || st === "Lost") l.nextFollowUp = null;
    else if (!l.nextFollowUp || l.nextFollowUp < todayISO()) l.nextFollowUp = DB.helpers.daysAhead(3);
    toast(l.company + " → " + st, { type: "ok" });
    UI.$("#modalHost").hidden = true;
    App.saveDelta(() => DB.leads.update(l.id, { stage: l.stage, nextFollowUp: l.nextFollowUp }));
  }

  /* ---- mark won / lost ----
     Marking a lead WON closes the CRM→ERP loop:
       1. ensure the company exists as a Customer (create if new)
       2. offer to raise a Sales Order from the lead's product + value
     so a won enquiry actually flows into Sales → Production → Dispatch
     instead of dead-ending in the CRM. */
  async function closeLead(l, outcome) {
    if (outcome === "Lost") {
      const reason = await promptText("Why was this lead lost?", "e.g. Price too high / lost to competitor");
      if (reason === null) return;
      l.lostReason = reason || "Not specified";
      l.stage = "Lost";
      l.nextFollowUp = null;
      UI.$("#modalHost").hidden = true;
      toast(l.company + " marked Lost", { type: "warn" });
      App.saveDelta(() => DB.leads.update(l.id, { stage: "Lost", lostReason: l.lostReason, nextFollowUp: null }));
      return;
    }

    // ----- WON -----
    l.stage = "Won";
    l.nextFollowUp = null;

    // 1) ensure a Customer record exists for this company
    let cust = ENG.data.customers.find((c) => c.name.toLowerCase() === (l.company || "").toLowerCase());
    let createdCustomer = false;
    if (!cust) {
      cust = {
        id: nextCustomerId(),
        name: l.company,
        city: l.city || "—",
        gst: "—",
        segment: "Cable Tapes",
        rating: "B",
        terms: "30 days",
        contact: l.contact || "—",
        phone: l.phone || "—",
        email: l.email || "—",
        since: String(DB.helpers.today().getFullYear()),
      };
      ENG.data.customers.push(cust);
      createdCustomer = true;
    }
    l.customerId = cust.id;

    // 2) ask whether to raise a Sales Order from this won lead
    UI.$("#modalHost").hidden = true;
    const makeSO = await confirm(
      `🏆 ${l.company} marked WON!\n\n` +
      (createdCustomer ? `• New customer "${cust.name}" added to your customer list.\n` : `• Linked to existing customer ${cust.name}.\n`) +
      `\nRaise a Sales Order now for ${l.productName || l.product}?\n` +
      `This pushes the deal into your order book → production → dispatch.`,
      { title: "Convert Won lead to order?" });

    if (makeSO) {
      const fg = ENG.item(l.product);
      const price = (fg && fg.price) || 0;
      // derive a sensible quantity from the deal value (value ÷ unit price);
      // always carry at least one line so the granular SO endpoint accepts it
      const qty = price > 0 ? Math.max(1, Math.round((l.value || 0) / price)) : 1;
      const rate = price || (l.value || 0);
      const so = {
        id: window._erpUtil.nextSeqId(ENG.data.salesorders, "SO-"),
        date: DB.helpers.iso(DB.helpers.today()),
        customerId: cust.id,
        lines: [{ itemId: l.product, qty, rate, width: (fg && fg.widthMM ? fg.widthMM[0] : 25) }],
        status: "Confirmed",
        promised: DB.helpers.daysAhead(14),
        priority: "Normal",
        value: l.value || 0,
        fromLead: l.id, // traceability back to the CRM lead
      };
      ENG.data.salesorders.push(so);
      l.salesOrderId = so.id; // traceability forward to the order
      toast(`${so.id} created from ${l.company}`, { type: "ok", title: "Lead converted to order" });
      App.saveDelta(async () => {
        if (createdCustomer) await DB.customers.upsert(cust);
        await DB.sales.create(so);
        await DB.leads.update(l.id, { stage: "Won", customerId: cust.id, salesOrderId: so.id, nextFollowUp: null });
      });
      App.go("sales");
      return;
    }

    toast(l.company + " marked Won", { type: "ok" });
    App.saveDelta(async () => {
      if (createdCustomer) await DB.customers.upsert(cust);
      await DB.leads.update(l.id, { stage: "Won", customerId: cust.id, nextFollowUp: null });
    });
    App.go("crm");
  }

  function nextCustomerId() {
    const ids = (ENG.data.customers || []).map((c) => +(String(c.id).replace(/\D/g, "")) || 0);
    const n = (ids.length ? Math.max(...ids) : 0) + 1;
    return "CUS-" + String(n).padStart(2, "0");
  }

  /* ---- log an activity ---- */
  function logActivity(l) {
    const body = h("div", { class: "form-grid" }, [
      field("Type", selectHTML("a_type", ACT_TYPES.map((t) => ({ v: t, l: t })), "Call")),
      field("Date", `<input class="input" id="a_date" type="date" value="${todayISO()}">`),
      field("Note", `<textarea class="input" id="a_note" placeholder="What happened on this touchpoint?"></textarea>`, "full"),
      field("Next follow-up", `<input class="input" id="a_next" type="date" value="${DB.helpers.daysAhead(3)}">`),
    ]);
    const mo = modal({ title: "Log Activity", sub: l.company, body,
      foot: [
        h("button", { class: "btn ghost", onclick: () => mo.close(), text: "Cancel" }),
        h("button", { class: "btn primary", onclick: save, text: "Save Activity" }),
      ] });
    function save() {
      const type = UI.$("#a_type").value, date = UI.$("#a_date").value, note = UI.$("#a_note").value.trim();
      if (!note) { toast("Add a short note", { type: "warn" }); return; }
      l.activities = l.activities || [];
      l.activities.push({ date, type, note, by: l.owner || "Sales Desk" });
      const next = UI.$("#a_next").value;
      if (next) l.nextFollowUp = next;
      // logging contact on a New lead auto-advances it to Contacted
      if (l.stage === "New") l.stage = "Contacted";
      App.saveDelta(() => DB.leads.update(l.id, { activities: l.activities, nextFollowUp: l.nextFollowUp, stage: l.stage }));
      mo.close();
      toast("Activity logged", { type: "ok" });
      leadDetail(l.id);
    }
  }

  /* ============================================================
     CREATE / EDIT LEAD
     ============================================================ */
  function leadForm(existing) {
    const edit = !!existing;
    const l = existing || { stage: "New" };
    const fgs = ENG.data.items.filter((i) => i.cat === "FG");
    const f = (k, d) => (l[k] != null ? l[k] : d);

    const body = h("div", { class: "form-grid" }, [
      field("Company *", `<input class="input" id="l_company" value="${esc(f("company", ""))}" placeholder="Customer / prospect company">`),
      field("Contact Person", `<input class="input" id="l_contact" value="${esc(f("contact", ""))}" placeholder="Name">`),
      field("Phone", `<input class="input" id="l_phone" value="${esc(f("phone", ""))}">`),
      field("Email", `<input class="input" id="l_email" value="${esc(f("email", ""))}">`),
      field("City", `<input class="input" id="l_city" value="${esc(f("city", ""))}">`),
      field("Product Interest", selectHTML("l_product", fgs.map((i) => ({ v: i.id, l: trim(i.name, 34) })), f("product", fgs[0] && fgs[0].id))),
      field("Estimated Value (₹)", `<input class="input" id="l_value" type="number" value="${f("value", 0)}">`),
      field("Source", selectHTML("l_source", SOURCES.map((s) => ({ v: s, l: s })), f("source", "Website Enquiry"))),
      field("Owner", `<input class="input" id="l_owner" value="${esc(f("owner", "Sales Desk"))}">`),
      field("Next Follow-up", `<input class="input" id="l_next" type="date" value="${f("nextFollowUp", DB.helpers.daysAhead(3)) || DB.helpers.daysAhead(3)}">`),
      field("Notes", `<textarea class="input" id="l_notes" placeholder="Requirement, volumes, remarks…">${esc(f("notes", ""))}</textarea>`, "full"),
    ]);

    const mo = modal({ title: edit ? "Edit Lead" : "New Lead", sub: edit ? l.id : "Capture a sales enquiry", body,
      foot: [
        h("button", { class: "btn ghost", onclick: () => mo.close(), text: "Cancel" }),
        h("button", { class: "btn primary", onclick: save, text: edit ? "Save Changes" : "Create Lead" }),
      ] });

    function save() {
      const company = UI.$("#l_company").value.trim();
      if (!company) { toast("Company is required", { type: "warn" }); return; }
      const productId = UI.$("#l_product").value;
      const fg = ENG.item(productId);
      const obj = edit ? l : { id: nextLeadId(), stage: "New", created: todayISO(), activities: [] };
      Object.assign(obj, {
        company,
        contact: UI.$("#l_contact").value.trim(),
        phone: UI.$("#l_phone").value.trim(),
        email: UI.$("#l_email").value.trim(),
        city: UI.$("#l_city").value.trim(),
        product: productId,
        productName: fg ? fg.name : "",
        value: +UI.$("#l_value").value || 0,
        source: UI.$("#l_source").value,
        owner: UI.$("#l_owner").value.trim() || "Sales Desk",
        nextFollowUp: (obj.stage === "Won" || obj.stage === "Lost") ? null : UI.$("#l_next").value,
        notes: UI.$("#l_notes").value.trim(),
      });
      if (!edit) ENG.data.leads.push(obj);
      mo.close();
      toast(edit ? "Lead updated" : "Lead created", { type: "ok" });
      App.saveDelta(() => edit ? DB.leads.update(obj.id, obj) : DB.leads.create(obj));
      App.go("crm");
    }
  }

  function nextLeadId() {
    const ids = (ENG.data.leads || []).map((l) => +(String(l.id).replace(/\D/g, "")) || 0);
    const n = (ids.length ? Math.max(...ids) : 0) + 1;
    return "LD-" + String(n).padStart(4, "0");
  }

  /* ============================================================
     small shared helpers
     ============================================================ */
  function field(label, inner, cls) {
    return h("div", { class: "field" + (cls === "full" ? " full" : "") }, [h("label", { text: label }), h("div", { html: inner })]);
  }
  function selectHTML(id, opts, sel) {
    return `<select class="select" id="${id}">` +
      opts.map((o) => `<option value="${esc(o.v)}" ${o.v === sel ? "selected" : ""}>${esc(o.l)}</option>`).join("") +
      `</select>`;
  }
  function stageBadge(st) {
    return { New: "info", Contacted: "warn", Quoted: "violet", Won: "ok", Lost: "danger" }[st] || "mut";
  }
  function actIcon(t) {
    return { Call: "📞", Email: "✉️", Meeting: "🤝", "Quotation Sent": "📄", "Site Visit": "🏭", Note: "📝" }[t] || "•";
  }
  /* tiny text prompt built on the modal system */
  function promptText(title, ph) {
    return new Promise((res) => {
      const body = h("div", {}, [h("textarea", { class: "input", id: "pt_in", placeholder: ph || "" })]);
      const mo = modal({ title, body,
        foot: [
          h("button", { class: "btn ghost", onclick: () => { mo.close(); res(null); }, text: "Cancel" }),
          h("button", { class: "btn primary", onclick: () => { const v = UI.$("#pt_in").value.trim(); mo.close(); res(v); }, text: "OK" }),
        ] });
    });
  }

  // register the ⌘K quick action for CRM
  window.ERPActions = Object.assign(window.ERPActions || {}, {
    newLead: { ic: "🎯", label: "New Lead", run: () => App.go("crm", { openNew: true }) },
  });
})();
