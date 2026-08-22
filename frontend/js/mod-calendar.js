/* ============================================================
   CHHAPERIA ERP — CALENDAR  (frontend / presentation)

   A CRM calendar shows meetings, calls and tasks. This one shows
   those AND every other date the business has already committed
   to, because in a factory the dates that actually hurt are not
   the ones anybody typed into a diary:

     • a purchase order's ETA          — goods we are waiting on
     • a sales order's promised date   — the ship-by we agreed
     • a work order's due date         — the run that must come off
     • a lead's next follow-up         — the call we said we'd make
     • approved leave                  — who will not be here

   Every one of those already lives on its own record, so the
   calendar DERIVES them and stores nothing. A date can therefore
   never disagree with the document it belongs to — move a PO's
   ETA and the calendar has already moved.

   The one thing it does store is an appointment: a commitment
   made to a TIME rather than to an order (the factory visit, the
   call-back), which until now had nowhere to live.
   ============================================================ */
(function () {
  "use strict";
  const { h, esc, badge, toast, modal, confirm } = UI;
  const { pageHead } = MW;
  const U = window._erpUtil;

  const DAY = 86400000;
  const WD = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const MONTHS = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];

  const todayISO = () => DB.helpers.iso(DB.helpers.today());
  const money = (n) => ENG.money(n);
  const trim = (s, n) => { s = String(s || ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };

  /* ---- what an appointment can be about ----
     Mirrors the touchpoints the CRM already logs, plus the two chases that
     are not a CRM activity at all: a sample that has gone quiet and money
     that has not landed. */
  const KINDS = [
    { v: "Meeting",          ic: "🤝" },
    { v: "Call",             ic: "📞" },
    { v: "Site Visit",       ic: "🏭" },
    { v: "Sample Follow-up", ic: "📦" },
    { v: "Payment Follow-up", ic: "💰" },
    { v: "Reminder",         ic: "📝" },
  ];
  const kindIcon = (k) => (KINDS.find((x) => x.v === k) || {}).ic || "📝";

  /* ---- the six things a day can hold ----
     `on` is the live filter state; every source can be switched off, because
     a sales desk chasing leads does not want the shop floor's due dates in
     the way, and the planner wants exactly the opposite. */
  const SOURCES = [
    { key: "appt",  label: "Appointments", ic: "📅", color: "var(--c1)", on: true },
    { key: "lead",  label: "Follow-ups",   ic: "🎯", color: "var(--c8)", on: true },
    { key: "po",    label: "PO Arrivals",  ic: "🛒", color: "var(--c2)", on: true },
    { key: "so",    label: "Deliveries",   ic: "🧾", color: "var(--c4)", on: true },
    { key: "wo",    label: "Production",   ic: "⚙️", color: "var(--c3)", on: true },
    { key: "leave", label: "Leave",        ic: "🌴", color: "var(--c7)", on: false },
  ];

  M.calendar = { title: "Calendar", sub: "Every date the business owes", render(root, params) {
    /* filter + view state survives a redraw but not a page change, which is
       the same lifetime the other modules give their toolbars */
    const on = {}; SOURCES.forEach((s) => { on[s.key] = s.on; });
    let view = "month";
    let q = "";
    // the month/week/day the grid is pointing at — always a real Date at 00:00
    let cursor = startOfDay(DB.helpers.today());

    root.appendChild(pageHead("Calendar",
      "Follow-ups, deliveries, arrivals and due dates on one grid — nothing here is typed twice",
      [ h("button", { class: "btn", onclick: () => { cursor = startOfDay(DB.helpers.today()); draw(); },
          html: "◎ Today" }),
        h("button", { class: "btn primary", onclick: () => apptForm(null, todayISO()), html: "＋ New Appointment" }) ]));

    /* ---- headline numbers: what is late, what is now ---- */
    const kpiHost = h("div", { class: "grid kpi-grid", style: "margin-bottom:16px" });
    root.appendChild(kpiHost);

    /* ---- view switch + navigation ---- */
    const seg = h("div", { class: "seg", style: "margin-bottom:14px" },
      [segBtn("Month", "month"), segBtn("Week", "week"), segBtn("Day", "day"), segBtn("Agenda", "agenda")]);
    root.appendChild(seg);

    const label = h("div", { class: "cal-label" });
    const navBar = h("div", { class: "toolbar" }, [
      h("div", { class: "cal-nav" }, [
        h("button", { class: "icon-btn", "aria-label": "Previous", onclick: () => { step(-1); }, html: "&lsaquo;" }),
        label,
        h("button", { class: "icon-btn", "aria-label": "Next", onclick: () => { step(1); }, html: "&rsaquo;" }),
      ]),
      MW.searchInput("Search party, order no., product…", (v) => { q = v.toLowerCase().trim(); draw(); }),
      h("div", { style: "margin-left:auto" }, h("span", { class: "chip", id: "calCount" })),
    ]);
    root.appendChild(navBar);

    /* ---- source filter chips ---- */
    const chips = h("div", { class: "cal-chips" }, SOURCES.map((s) => {
      const b = h("button", { class: "cal-chip" + (on[s.key] ? " on" : ""), style: "--sc:" + s.color,
        title: "Show or hide " + s.label,
        onclick: () => { on[s.key] = !on[s.key]; b.classList.toggle("on", on[s.key]); draw(); } }, [
        h("span", { class: "cal-chip-d" }),
        h("span", { text: s.ic + " " + s.label }),
        h("span", { class: "cal-chip-n", "data-src": s.key }),
      ]);
      return b;
    }));
    root.appendChild(chips);

    const host = h("div"); root.appendChild(host);

    function segBtn(l, k) {
      const b = h("button", { class: view === k ? "on" : "", text: l, onclick: () => {
        view = k; [...seg.children].forEach((c) => c.classList.remove("on")); b.classList.add("on"); draw();
      } });
      return b;
    }
    /* one arrow means one of whatever is on screen — a month in Month view, a
       week in Week view. Agenda always runs forward from today, so it has
       nothing to step through. */
    function step(dir) {
      if (view === "month") cursor = new Date(cursor.getFullYear(), cursor.getMonth() + dir, 1);
      else if (view === "week") cursor = new Date(cursor.getTime() + dir * 7 * DAY);
      else if (view === "day") cursor = new Date(cursor.getTime() + dir * DAY);
      else cursor = new Date(cursor.getTime() + dir * 30 * DAY);
      draw();
    }

    function draw() {
      const all = buildEvents();
      const shown = all.filter((e) => on[e.source] && matches(e, q));

      // per-source counts sit on the chips, so switching one off shows what
      // was being hidden
      SOURCES.forEach((s) => {
        const el = chips.querySelector('[data-src="' + s.key + '"]');
        if (el) el.textContent = String(all.filter((e) => e.source === s.key).length);
      });
      const c = UI.$("#calCount");
      if (c) c.textContent = shown.length + (shown.length === 1 ? " entry" : " entries");

      drawKpis(all);
      label.textContent = periodLabel();

      host.innerHTML = "";
      if (view === "month") host.appendChild(monthGrid(shown));
      else if (view === "week") host.appendChild(spanList(shown, weekStart(cursor), 7, "week"));
      else if (view === "day") host.appendChild(spanList(shown, startOfDay(cursor), 1, "day"));
      else host.appendChild(agenda(shown));
    }

    function periodLabel() {
      if (view === "month") return MONTHS[cursor.getMonth()] + " " + cursor.getFullYear();
      if (view === "week") {
        const a = weekStart(cursor), b = new Date(a.getTime() + 6 * DAY);
        return fmtShort(a) + " – " + fmtShort(b) + ", " + b.getFullYear();
      }
      if (view === "day") return WD[wdIndex(cursor)] + " " + fmtShort(cursor) + ", " + cursor.getFullYear();
      return "Next 30 days from " + fmtShort(cursor);
    }

    function drawKpis(all) {
      const t = todayISO();
      const weekEnd = DB.helpers.iso(new Date(startOfDay(DB.helpers.today()).getTime() + 7 * DAY));
      const late = all.filter((e) => e.date < t && !e.done && e.chaseable);
      const today = all.filter((e) => e.date === t);
      const week = all.filter((e) => e.date >= t && e.date < weekEnd);
      const appts = all.filter((e) => e.source === "appt" && e.date >= t && !e.done);
      kpiHost.innerHTML = "";
      [ MW.kpi({ icon: "🔴", label: "Overdue", value: ENG.num(late.length),
          delta: late.length ? "Needs chasing" : "All clear", deltaType: late.length ? "down" : "up",
          onClick: () => listModal("Overdue — " + late.length, "Dates that have already passed and are still open", late) }),
        MW.kpi({ icon: "📌", label: "Today", value: ENG.num(today.length),
          onClick: () => listModal("Today · " + t, "Everything falling due today", today) }),
        MW.kpi({ icon: "🗓", label: "Next 7 Days", value: ENG.num(week.length),
          onClick: () => listModal("Next 7 days", "The week ahead, in date order", week) }),
        MW.kpi({ icon: "📅", label: "Appointments", value: ENG.num(appts.length),
          onClick: () => listModal("Upcoming appointments", "Meetings, calls and visits still to happen", appts) }),
      ].forEach((k) => kpiHost.appendChild(k));
    }

    /* ============================================================
       MONTH GRID — the default. Six rows of seven, Monday first
       (a factory week, not an American one).
       ============================================================ */
    function monthGrid(events) {
      const byDate = groupByDate(events);
      const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
      const start = weekStart(first);
      const wrap = h("div", { class: "cal-wrap" });
      wrap.appendChild(h("div", { class: "cal-head" }, WD.map((d) =>
        h("div", { class: "cal-hd", text: d }))));
      const grid = h("div", { class: "cal-grid" });
      const t = todayISO();

      /* Always WHOLE weeks. Some months need five rows and some need six
         (August 2026 starts on a Saturday, so it spills into a sixth), and a
         cell count that is not a multiple of seven leaves the last row ragged
         in a 7-column grid. */
      const daysInMonth = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
      const lead = Math.round((first - start) / DAY);
      const total = Math.ceil((lead + daysInMonth) / 7) * 7;

      for (let i = 0; i < total; i++) {
        const d = new Date(start.getTime() + i * DAY);
        const ds = DB.helpers.iso(d);
        const outside = d.getMonth() !== cursor.getMonth();
        const list = byDate[ds] || [];
        const cell = h("div", { class: "cal-cell" + (outside ? " out" : "") + (ds === t ? " today" : ""),
          // the empty part of a day is the fastest way to book that day
          onclick: (e) => { if (e.target === cell || e.target.classList.contains("cal-cell-n")) apptForm(null, ds); },
          title: "Click to add an appointment on " + ds }, [
          h("div", { class: "cal-cell-top" }, [
            h("span", { class: "cal-cell-n", text: String(d.getDate()) }),
            list.length > 3 ? h("button", { class: "cal-more", text: "+" + (list.length - 3),
              onclick: (e) => { e.stopPropagation(); dayModal(ds, list); } }) : null,
          ].filter(Boolean)),
          h("div", { class: "cal-cell-body" }, list.slice(0, 3).map((ev) => evPill(ev))),
        ]);
        grid.appendChild(cell);
      }
      wrap.appendChild(grid);
      return wrap;
    }

    /* ============================================================
       WEEK / DAY — the same column list, one day wide or seven.
       Times matter here, so entries carry them and sort by them.
       ============================================================ */
    function spanList(events, from, days, mode) {
      const byDate = groupByDate(events);
      const t = todayISO();
      const wrap = h("div", { class: "cal-cols" + (mode === "day" ? " one" : "") });
      for (let i = 0; i < days; i++) {
        const d = new Date(from.getTime() + i * DAY);
        const ds = DB.helpers.iso(d);
        const list = byDate[ds] || [];
        wrap.appendChild(h("div", { class: "cal-col" + (ds === t ? " today" : "") }, [
          h("div", { class: "cal-col-head" }, [
            h("span", { class: "cal-col-wd", text: WD[wdIndex(d)] }),
            h("span", { class: "cal-col-d", text: String(d.getDate()) }),
            h("span", { class: "cal-col-m", text: MONTHS[d.getMonth()].slice(0, 3) }),
            h("button", { class: "cal-col-add", title: "Add an appointment on " + ds,
              onclick: () => apptForm(null, ds), text: "＋" }),
          ]),
          h("div", { class: "cal-col-body" }, list.length
            ? list.map((ev) => evRow(ev))
            : [h("div", { class: "cal-none", text: "Nothing due" })]),
        ]));
      }
      return wrap;
    }

    /* ============================================================
       AGENDA — a flat forward-looking list. The view to work from
       on a phone, where a 7-column grid is unreadable.
       ============================================================ */
    function agenda(events) {
      const from = DB.helpers.iso(cursor), to = DB.helpers.iso(new Date(cursor.getTime() + 30 * DAY));
      const list = events.filter((e) => e.date >= from && e.date <= to);
      if (!list.length) {
        return h("div", { class: "empty" }, [h("div", { class: "big", text: "🗓" }),
          h("div", { text: "Nothing scheduled in this window" })]);
      }
      const byDate = groupByDate(list);
      const box = h("div", { class: "cal-agenda" });
      Object.keys(byDate).sort().forEach((ds) => {
        const d = parseISO(ds);
        box.appendChild(h("div", { class: "cal-ag-day" }, [
          h("div", { class: "cal-ag-date" + (ds === todayISO() ? " today" : "") }, [
            h("span", { class: "cal-ag-n", text: String(d.getDate()) }),
            h("span", { class: "cal-ag-wd", text: WD[wdIndex(d)] + " · " + MONTHS[d.getMonth()].slice(0, 3) }),
          ]),
          h("div", { class: "cal-ag-rows" }, byDate[ds].map((ev) => evRow(ev))),
        ]));
      });
      return box;
    }

    /* ---- one event, as a pill (month) or a row (week/day/agenda) ---- */
    function evPill(ev) {
      return h("button", { class: "cal-ev" + toneCls(ev), style: "--sc:" + ev.color,
        title: ev.title + " — " + ev.sub, onclick: (e) => { e.stopPropagation(); openEvent(ev); } }, [
        h("span", { class: "cal-ev-ic", text: ev.icon }),
        h("span", { class: "cal-ev-t", text: trim(ev.title, 26) }),
      ]);
    }
    function evRow(ev) {
      return h("button", { class: "cal-row" + toneCls(ev), style: "--sc:" + ev.color,
        onclick: () => openEvent(ev) }, [
        h("span", { class: "cal-row-ic", text: ev.icon }),
        h("span", { class: "cal-row-tx" }, [
          h("span", { class: "cal-row-t", text: ev.title }),
          h("span", { class: "cal-row-s", text: ev.sub }),
        ]),
        ev.time ? h("span", { class: "cal-row-time", text: ev.time }) : null,
        ev.value ? h("span", { class: "cal-row-v", text: money(ev.value) }) : null,
      ].filter(Boolean));
    }
    function toneCls(ev) {
      if (ev.done) return " done";
      if (ev.chaseable && ev.date < todayISO()) return " late";
      if (ev.date === todayISO()) return " now";
      return "";
    }

    /* clicking an entry goes where the work is: a derived date opens its own
       module, an appointment opens its own record */
    function openEvent(ev) {
      if (ev.source === "appt") { apptDetail(ev.raw); return; }
      UI.$("#modalHost").hidden = true;
      /* Carry the record's own id across so the destination highlights the very
         line that was clicked. A leave mark's id has the day appended (one mark
         per day of the absence), so send the underlying record's id instead. */
      App.go(ev.go, { highlight: (ev.raw && ev.raw.id) || ev.id });
    }

    function dayModal(ds, list) {
      modal({ title: fmtLong(parseISO(ds)), sub: list.length + (list.length === 1 ? " entry" : " entries"),
        wide: true,
        body: h("div", { class: "cal-day-list" }, list.map((ev) => evRow(ev))),
        foot: [h("button", { class: "btn primary", onclick: () => apptForm(null, ds), html: "＋ Add appointment" })] });
    }
    function listModal(title, sub, list) {
      modal({ title, sub, wide: true,
        body: list.length
          ? h("div", { class: "cal-day-list" }, list.slice().sort(byDateTime).map((ev) => evRow(ev)))
          : h("div", { class: "empty" }, [h("div", { class: "big", text: "✓" }), h("div", { text: "Nothing here" })]) });
    }

    /* ============================================================
       EVENT SOURCES — everything below DERIVES from a record that
       already exists. Only `appt` reads a stored calendar row.
       ============================================================ */
    function buildEvents() {
      const out = [];
      const D = ENG.data;

      // --- stored appointments -----------------------------------------
      (D.appointments || []).forEach((a) => {
        const who = partyName(a);
        out.push({ id: a.id, date: a.date, time: a.time || "", source: "appt", raw: a,
          icon: kindIcon(a.kind), color: srcColor("appt"), done: !!a.done, chaseable: true,
          title: a.title,
          sub: [a.kind, who, a.location].filter(Boolean).join(" · ") || "Appointment",
          go: "calendar" });
      });

      // --- CRM follow-ups: the call we said we would make ---------------
      (D.leads || []).forEach((l) => {
        if (!l.nextFollowUp || l.stage === "Won" || l.stage === "Lost") return;
        out.push({ id: l.id, date: l.nextFollowUp, source: "lead", raw: l,
          icon: "🎯", color: srcColor("lead"), done: false, chaseable: true,
          title: "Chase " + l.company, value: l.value || 0,
          sub: l.stage + " · " + (l.productName || l.product || "—") + (l.contact ? " · " + l.contact : ""),
          go: "crm" });
      });

      // --- purchase orders: goods we are waiting on ---------------------
      (D.purchaseorders || []).forEach((p) => {
        if (!p.eta || p.status === "Received") return;
        const pend = (p.lines || []).reduce((s, l) => s + Math.max(0, l.qty - (l.recd || 0)) * l.rate, 0);
        out.push({ id: p.id, date: p.eta, source: "po", raw: p,
          icon: "🛒", color: srcColor("po"), done: false, chaseable: true,
          title: ENG.sup(p.supplierId) + " arriving", value: pend,
          sub: p.id + " · " + (p.lines || []).length + " item(s) · " + p.status,
          go: "purchase" });
      });

      // --- sales orders: the ship-by we agreed --------------------------
      (D.salesorders || []).forEach((s) => {
        if (!s.promised || s.status === "Dispatched") return;
        out.push({ id: s.id, date: s.promised, source: "so", raw: s,
          icon: "🧾", color: srcColor("so"), done: false, chaseable: true,
          title: "Ship to " + ENG.custName(s.customerId), value: s.value || 0,
          sub: s.id + " · " + (s.lines || []).length + " line(s) · " + s.priority,
          go: "sales" });
      });

      // --- work orders: the run that must come off the line -------------
      (D.workorders || []).forEach((w) => {
        if (!w.due) return;
        const finished = (w.status === "Completed" || w.status === "Dispatched") && !((+w.pendingQty || 0) > 1e-6);
        if (finished) return;
        const it = ENG.item(w.itemId) || {};
        out.push({ id: w.id, date: w.due, source: "wo", raw: w,
          icon: "⚙️", color: srcColor("wo"), done: false, chaseable: true,
          title: trim(it.name || w.itemId, 30) + " due",
          sub: w.id + " · " + ENG.num(w.qty) + " " + (it.uom || "kg") + " · " + (w.status || ""),
          go: "production" });
      });

      // --- approved leave: who will not be here -------------------------
      // one entry PER DAY of the absence, because "is Ramesh in on the 14th?"
      // is the question being asked, not "when did his leave start"
      (D.hrLeaves || []).forEach((lv) => {
        if (lv.status !== "Approved" || !lv.fromDate) return;
        const w = (D.hrWorkers || []).find((x) => x.id === lv.workerId) || {};
        const end = parseISO(lv.toDate || lv.fromDate);
        for (let d = parseISO(lv.fromDate); d <= end; d = new Date(d.getTime() + DAY)) {
          out.push({ id: lv.id + ":" + DB.helpers.iso(d), date: DB.helpers.iso(d), source: "leave", raw: lv,
            icon: "🌴", color: srcColor("leave"), done: false, chaseable: false,
            title: (w.name || lv.workerId) + " on leave",
            sub: (w.dept || "") + " · " + lv.fromDate + " → " + (lv.toDate || lv.fromDate),
            go: "hr-leave" });
        }
      });

      return out.sort(byDateTime);
    }

    function matches(ev, needle) {
      if (!needle) return true;
      return (ev.title + " " + ev.sub + " " + ev.id).toLowerCase().includes(needle);
    }

    /* ============================================================
       APPOINTMENT — create / edit / detail
       ============================================================ */
    function apptForm(existing, presetDate) {
      const edit = !!existing;
      const a = existing || {};
      const f = (k, d) => (a[k] != null && a[k] !== "" ? a[k] : d);
      const leadOpts = [{ v: "", l: "— none —" }].concat((ENG.data.leads || [])
        .filter((l) => l.stage !== "Won" && l.stage !== "Lost")
        .map((l) => ({ v: l.id, l: l.company + " (" + l.id + ")" })));
      const custOpts = [{ v: "", l: "— none —" }].concat((ENG.data.customers || [])
        .map((c) => ({ v: c.id, l: c.name })));
      const supOpts = [{ v: "", l: "— none —" }].concat((ENG.data.suppliers || [])
        .map((s) => ({ v: s.id, l: s.name })));

      const body = h("div", { class: "form-grid" }, [
        U.field("Title *", `<input class="input" id="ap_title" value="${esc(f("title", ""))}" placeholder="e.g. Plant visit — KEI Bhiwadi">`, "full"),
        U.field("Type", U.selectHTML("ap_kind", KINDS.map((k) => ({ v: k.v, l: k.ic + " " + k.v })), f("kind", "Meeting"))),
        U.field("Date *", `<input class="input" id="ap_date" type="date" value="${f("date", presetDate || todayISO())}">`),
        U.field("From", `<input class="input" id="ap_time" type="time" value="${f("time", "")}">`),
        U.field("To", `<input class="input" id="ap_end" type="time" value="${f("endTime", "")}">`),
        U.field("Owner", `<input class="input" id="ap_owner" value="${esc(f("owner", (App.user && App.user.username) || "Sales Desk"))}">`),
        U.field("Location", `<input class="input" id="ap_loc" value="${esc(f("location", ""))}" placeholder="Their plant / our works / phone">`),
        /* linking is what makes the diary worth keeping: an appointment tied
           to a lead is one click from the pipeline it belongs to */
        U.field("Lead", U.selectHTML("ap_lead", leadOpts, f("leadId", ""))),
        U.field("Customer", U.selectHTML("ap_cust", custOpts, f("customerId", ""))),
        U.field("Supplier", U.selectHTML("ap_sup", supOpts, f("supplierId", ""))),
        U.field("Notes", `<textarea class="input" id="ap_notes" placeholder="What has to happen, who is coming, what to carry…">${esc(f("notes", ""))}</textarea>`, "full"),
      ]);

      const mo = modal({ title: edit ? "Edit Appointment" : "New Appointment",
        sub: edit ? a.id : "A commitment made to a time, not to an order", wide: true, body,
        foot: [
          h("button", { class: "btn ghost", onclick: () => mo.close(), text: "Cancel" }),
          h("button", { class: "btn primary", onclick: save, text: edit ? "Save Changes" : "Create" }),
        ] });

      function save() {
        const title = UI.$("#ap_title").value.trim();
        const date = UI.$("#ap_date").value;
        if (!title) { toast("Give the appointment a title", { type: "warn" }); return; }
        if (!date) { toast("Pick a date", { type: "warn" }); return; }
        const end = UI.$("#ap_end").value, start = UI.$("#ap_time").value;
        if (start && end && end < start) { toast("The end time is before the start", { type: "warn" }); return; }
        const obj = edit ? a : { id: nextApptId(), created: todayISO(), done: false };
        Object.assign(obj, {
          title, date, kind: UI.$("#ap_kind").value,
          time: start, endTime: end,
          owner: UI.$("#ap_owner").value.trim(),
          location: UI.$("#ap_loc").value.trim(),
          leadId: UI.$("#ap_lead").value || null,
          customerId: UI.$("#ap_cust").value || null,
          supplierId: UI.$("#ap_sup").value || null,
          notes: UI.$("#ap_notes").value.trim(),
        });
        if (!edit) { ENG.data.appointments = ENG.data.appointments || []; ENG.data.appointments.push(obj); }
        mo.close();
        toast(edit ? "Appointment updated" : title + " scheduled", { type: "ok" });
        App.saveDelta(() => edit ? DB.appointments.update(obj.id, obj) : DB.appointments.create(obj));
        App.go("calendar");
      }
    }

    function apptDetail(a) {
      const who = partyName(a);
      const when = [a.date, [a.time, a.endTime].filter(Boolean).join(" – ")].filter(Boolean).join(" · ");
      const body = h("div", {}, [
        h("div", { class: "flex between aic wrap gap", style: "margin-bottom:14px" }, [
          h("span", { html: badge(a.done ? "ok" : a.date < todayISO() ? "danger" : "info",
            a.done ? "✓ Done" : a.date < todayISO() ? "Overdue" : "Scheduled") }),
          h("span", { class: "chip", html: kindIcon(a.kind) + " " + esc(a.kind || "Meeting") }),
        ]),
        MW.dl([
          ["When", when],
          ["Owner", a.owner || "—"],
          ["Location", a.location || "—"],
          ["With", who || "—"],
        ]),
        a.notes ? h("div", { class: "card", style: "margin-top:14px;box-shadow:none;background:var(--panel-2)" }, [
          h("div", { class: "muted", style: "font-size:11px;font-weight:700;text-transform:uppercase;margin-bottom:4px", text: "Notes" }),
          h("div", { style: "font-size:13px;line-height:1.5", text: a.notes }),
        ]) : null,
      ]);
      const foot = [
        h("button", { class: "btn danger", onclick: () => removeAppt(a), text: "🗑 Delete" }),
        // the linked record is usually where the next action actually lives
        a.leadId ? h("button", { class: "btn ghost", onclick: () => { UI.$("#modalHost").hidden = true; App.go("crm"); }, text: "🎯 Open lead" }) : null,
        h("button", { class: "btn ghost", onclick: () => apptForm(a), text: "✎ Edit" }),
        h("button", { class: "btn primary", onclick: () => toggleDone(a), text: a.done ? "↩ Reopen" : "✓ Mark done" }),
      ].filter(Boolean);
      modal({ title: a.title, sub: a.id + " · " + a.date, wide: true, body, foot });
    }

    function toggleDone(a) {
      a.done = !a.done;
      UI.$("#modalHost").hidden = true;
      toast(a.done ? "Marked done" : "Reopened", { type: "ok" });
      App.saveDelta(() => DB.appointments.update(a.id, { done: a.done }));
      App.go("calendar");
    }
    async function removeAppt(a) {
      if (!await confirm(`Delete "${a.title}"? This appointment will be permanently removed.`,
        { title: "Delete Appointment", danger: true })) return;
      ENG.data.appointments = (ENG.data.appointments || []).filter((x) => x.id !== a.id);
      UI.$("#modalHost").hidden = true;
      toast("Appointment deleted", { type: "ok", title: "Removed" });
      App.saveDelta(() => DB.appointments.remove(a.id));
      App.go("calendar");
    }

    draw();
    // ⌘K / the dashboard can land here asking for a fresh appointment
    if (params && params.openNew) { params.openNew = false; apptForm(null, params.date || todayISO()); }
  }};

  /* ============================================================
     helpers
     ============================================================ */
  function srcColor(key) { return (SOURCES.find((s) => s.key === key) || {}).color || "var(--c1)"; }
  function partyName(a) {
    if (a.leadId) { const l = (ENG.data.leads || []).find((x) => x.id === a.leadId); if (l) return l.company; }
    if (a.customerId) return ENG.custName(a.customerId);
    if (a.supplierId) return ENG.sup(a.supplierId);
    return "";
  }
  function nextApptId() {
    const ids = (ENG.data.appointments || []).map((a) => +(String(a.id).replace(/\D/g, "")) || 0);
    return "AP-" + String((ids.length ? Math.max(...ids) : 0) + 1).padStart(4, "0");
  }
  function groupByDate(events) {
    const map = {};
    events.forEach((e) => { (map[e.date] || (map[e.date] = [])).push(e); });
    Object.values(map).forEach((l) => l.sort(byDateTime));
    return map;
  }
  /* timed entries first and in clock order, then the all-day ones — the same
     order the day actually happens in */
  function byDateTime(a, b) {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    const at = a.time || "99:99", bt = b.time || "99:99";
    if (at !== bt) return at < bt ? -1 : 1;
    return (a.title || "") < (b.title || "") ? -1 : 1;
  }
  function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function parseISO(s) { const [y, m, d] = String(s).split("-").map(Number); return new Date(y, (m || 1) - 1, d || 1); }
  // Monday-first: getDay() is 0=Sunday, and a factory week starts on Monday
  function wdIndex(d) { return (d.getDay() + 6) % 7; }
  function weekStart(d) { const s = startOfDay(d); return new Date(s.getTime() - wdIndex(s) * DAY); }
  function fmtShort(d) { return d.getDate() + " " + MONTHS[d.getMonth()].slice(0, 3); }
  function fmtLong(d) { return WD[wdIndex(d)] + ", " + d.getDate() + " " + MONTHS[d.getMonth()] + " " + d.getFullYear(); }

  // ⌘K quick action
  window.ERPActions = Object.assign(window.ERPActions || {}, {
    newAppointment: { mod: "calendar", create: true, ic: "📅", label: "New Appointment", run: () => App.go("calendar", { openNew: true }) },
  });
})();
