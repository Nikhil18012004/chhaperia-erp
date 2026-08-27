/* ============================================================
   CHHAPERIA ERP — WORK CALENDAR  (frontend / presentation)

   Every role's own dates on one grid. The CRM keeps its own diary
   at mod-calendar.js and that file is deliberately CRM-ONLY — the
   sales desk asked for its follow-ups without the shop floor in
   the way, and that instruction still stands. So this is a second,
   separate screen rather than a widening of that one:

     Calendar       (Sales & CRM)  — appointments + lead follow-ups
     Work Calendar  (My Work)      — what MY role owes, by date

   WHAT EACH ROLE SEES is decided by `roles` on each SOURCE below.
   That list is presentation only and is not a security boundary:
   the server hands every role a payload already scoped to it
   (viewService.stateForUser), so a source a role must not see is
   not in ENG.data to begin with — every reader below is written
   `(D.x || [])` for exactly that reason. The role filter is here
   so the chips do not advertise categories that would always be
   empty, not to hide anything the browser was trusted with.

   READ-ONLY BY DESIGN. Nothing is created here and nothing is
   edited here. Every entry is DERIVED from a record that already
   exists elsewhere, so no date on this grid can disagree with the
   record it came from, and clicking one goes to the module that
   owns it — which is where the work is actually done. Booking an
   appointment stays with the CRM calendar, which owns that record.
   ============================================================ */
(function () {
  "use strict";
  const { h } = UI;
  const { pageHead } = MW;

  const DAY = 86400000;
  const WD = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const MONTHS = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];

  const todayISO = () => DB.helpers.iso(DB.helpers.today());
  const money = (n) => ENG.money(n);
  const trim = (s, n) => { s = String(s || ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };

  /* ---- who owes what ----
     `roles` is the list of roles the source is WORK FOR. Read it as the answer
     to "is this my job?", not "am I allowed to know?" — office is shown the
     production due date because office promised it to a customer; the lab is
     shown it because the lab has to test what comes off that run. The
     supervisor is absent from every row on purpose: that role never reaches
     this screen (it runs the separate SUP panel, which carries its own
     Schedule view built from the same idea). */
  const SOURCES = [
    { key: "appt",  label: "Appointments",   ic: "📅", color: "var(--c1)", roles: ["admin", "office"] },
    { key: "lead",  label: "Follow-ups",     ic: "🎯", color: "var(--c8)", roles: ["admin", "office"] },
    { key: "po",    label: "Arrivals",       ic: "🛒", color: "var(--c2)", roles: ["admin", "office", "lab"] },
    { key: "so",    label: "Despatches",     ic: "🧾", color: "var(--c3)", roles: ["admin", "office"] },
    { key: "wo",    label: "Production",     ic: "⚙️", color: "var(--c4)", roles: ["admin", "office", "lab"] },
    { key: "lab",   label: "Lab tests",      ic: "🧪", color: "var(--c5)", roles: ["admin", "lab"] },
    { key: "grnt",  label: "Incoming tests", ic: "🔬", color: "var(--c6)", roles: ["admin", "lab"] },
    { key: "leave", label: "Leave",          ic: "🌴", color: "var(--c7)", roles: ["admin", "office"] },
  ];

  const roleNow = () => (App.user && App.user.role) || "office";
  const mySources = () => SOURCES.filter((s) => s.roles.indexOf(roleNow()) !== -1);
  function srcColor(key) { return (SOURCES.find((s) => s.key === key) || {}).color || "var(--c1)"; }

  /* What the strap line should say, per role — the screen is the same, but
     what it is FOR is not. */
  const ROLE_SUB = {
    admin: "Every date the business owes — arrivals, despatches, runs, tests and leave",
    office: "What the office owes — arrivals to chase, despatches to ship and follow-ups to make",
    lab: "What the lab owes — batches waiting on a reading and deliveries waiting on a test",
  };

  M.workcal = { title: "Work Calendar", sub: "Your dates, by role", render(root, params) {
    const mine = mySources();
    /* filter + view state survives a redraw but not a page change — the same
       lifetime every other toolbar in the app gives its state */
    const on = {}; mine.forEach((s) => { on[s.key] = true; });
    let view = "month";
    let q = "";
    let cursor = startOfDay(DB.helpers.today());

    root.appendChild(pageHead("Work Calendar",
      ROLE_SUB[roleNow()] || "The dates your work falls due on",
      [ h("button", { class: "btn", onclick: () => { cursor = startOfDay(DB.helpers.today()); draw(); },
          html: "◎ Today" }) ]));

    const kpiHost = h("div", { class: "grid kpi-grid", style: "margin-bottom:16px" });
    root.appendChild(kpiHost);

    const seg = h("div", { class: "seg", style: "margin-bottom:14px" },
      [segBtn("Month", "month"), segBtn("Week", "week"), segBtn("Day", "day"), segBtn("Agenda", "agenda")]);
    root.appendChild(seg);

    const label = h("div", { class: "cal-label" });
    root.appendChild(h("div", { class: "toolbar" }, [
      h("div", { class: "cal-nav" }, [
        h("button", { class: "icon-btn", "aria-label": "Previous", onclick: () => step(-1), html: "&lsaquo;" }),
        label,
        h("button", { class: "icon-btn", "aria-label": "Next", onclick: () => step(1), html: "&rsaquo;" }),
      ]),
      MW.searchInput("Search order, product, party…", (v) => { q = v.toLowerCase().trim(); draw(); }),
      h("div", { style: "margin-left:auto" }, h("span", { class: "chip", id: "wcCount" })),
    ]));

    const chips = h("div", { class: "cal-chips" }, mine.map((s) => {
      const b = h("button", { class: "cal-chip on", style: "--sc:" + s.color,
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
    /* one arrow means one of whatever is on screen. Agenda runs forward from
       wherever the cursor is, so it steps a month at a time. */
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

      mine.forEach((s) => {
        const el = chips.querySelector('[data-src="' + s.key + '"]');
        if (el) el.textContent = String(all.filter((e) => e.source === s.key).length);
      });
      const c = UI.$("#wcCount");
      if (c) c.textContent = shown.length + (shown.length === 1 ? " entry" : " entries");

      drawKpis(all);
      label.textContent = periodLabel();

      host.innerHTML = "";
      if (!all.length) { host.appendChild(emptyState()); return; }
      if (view === "month") host.appendChild(monthGrid(shown));
      else if (view === "week") host.appendChild(spanList(shown, weekStart(cursor), 7));
      else if (view === "day") host.appendChild(spanList(shown, startOfDay(cursor), 1, "day"));
      else host.appendChild(agenda(shown));
    }

    function emptyState() {
      return h("div", { class: "empty" }, [h("div", { class: "big", text: "🗓" }),
        h("div", { text: "Nothing is scheduled against your work yet" }),
        h("div", { class: "muted", style: "font-size:12px;margin-top:4px",
          text: "Dates appear here as soon as an order, a run or a test carries one" })]);
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

    /* ---- headline numbers: what is late, what is now ----
       `chaseable` is what separates a date somebody must ACT on from a date
       that is merely true — leave is not "overdue", it just happened. */
    function drawKpis(all) {
      const t = todayISO();
      const weekEnd = DB.helpers.iso(new Date(startOfDay(DB.helpers.today()).getTime() + 7 * DAY));
      const late = all.filter((e) => e.date < t && !e.done && e.chaseable);
      const today = all.filter((e) => e.date === t);
      const week = all.filter((e) => e.date >= t && e.date < weekEnd);
      const open = all.filter((e) => !e.done && e.chaseable);
      kpiHost.innerHTML = "";
      [ MW.kpi({ icon: "🔴", label: "Overdue", value: ENG.num(late.length),
          delta: late.length ? "Needs chasing" : "All clear", deltaType: late.length ? "down" : "up",
          onClick: () => listModal("Overdue — " + late.length, "Past their date and still open", late) }),
        MW.kpi({ icon: "📌", label: "Today", value: ENG.num(today.length),
          onClick: () => listModal("Today · " + t, "Everything falling due today", today) }),
        MW.kpi({ icon: "🗓", label: "Next 7 Days", value: ENG.num(week.length),
          onClick: () => listModal("Next 7 days", "The week ahead, in date order", week) }),
        MW.kpi({ icon: "📋", label: "Open Items", value: ENG.num(open.length),
          onClick: () => listModal("Everything open", "Every dated job still owing something", open) }),
      ].forEach((k) => kpiHost.appendChild(k));
    }

    /* ============================================================
       MONTH GRID — six rows of seven, Monday first (a factory week,
       not an American one).
       ============================================================ */
    function monthGrid(events) {
      const byDate = groupByDate(events);
      const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
      const start = weekStart(first);
      const wrap = h("div", { class: "cal-wrap" });
      wrap.appendChild(h("div", { class: "cal-head" }, WD.map((d) => h("div", { class: "cal-hd", text: d }))));
      const grid = h("div", { class: "cal-grid" });
      const t = todayISO();

      /* Always WHOLE weeks — a cell count that is not a multiple of seven
         leaves the last row ragged in a 7-column grid, and some months need
         six rows where others need five. */
      const daysInMonth = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
      const lead = Math.round((first - start) / DAY);
      const total = Math.ceil((lead + daysInMonth) / 7) * 7;

      for (let i = 0; i < total; i++) {
        const d = new Date(start.getTime() + i * DAY);
        const ds = DB.helpers.iso(d);
        const outside = d.getMonth() !== cursor.getMonth();
        const list = byDate[ds] || [];
        grid.appendChild(h("div", { class: "cal-cell" + (outside ? " out" : "") + (ds === t ? " today" : "") }, [
          h("div", { class: "cal-cell-top" }, [
            h("span", { class: "cal-cell-n", text: String(d.getDate()) }),
            list.length > 3 ? h("button", { class: "cal-more", text: "+" + (list.length - 3),
              onclick: (e) => { e.stopPropagation(); dayModal(ds, list); } }) : null,
          ].filter(Boolean)),
          h("div", { class: "cal-cell-body" }, list.slice(0, 3).map((ev) => evPill(ev))),
        ]));
      }
      wrap.appendChild(grid);
      return wrap;
    }

    /* ============================================================
       WEEK / DAY — the same column list, one day wide or seven.
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
          ]),
          h("div", { class: "cal-col-body" }, list.length
            ? list.map((ev) => evRow(ev))
            : [h("div", { class: "cal-none", text: "Nothing due" })]),
        ]));
      }
      return wrap;
    }

    /* ============================================================
       AGENDA — a flat forward-looking list. The view to work from on
       a phone, where a 7-column grid is unreadable.
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
        // the lab is never sent money, so an entry only carries a value if it has one
        ev.value ? h("span", { class: "cal-row-v", text: money(ev.value) }) : null,
      ].filter(Boolean));
    }
    function toneCls(ev) {
      if (ev.done) return " done";
      if (ev.chaseable && ev.date < todayISO()) return " late";
      if (ev.date === todayISO()) return " now";
      return "";
    }

    /* Nothing is edited here — clicking goes to the module that owns the
       record. canAccess is checked because a source can be work for a role
       whose nav does not carry the owning module; landing on a screen the
       role cannot open would be a dead end, so the entry says where to look
       instead. */
    function openEvent(ev) {
      if (!ev.go || !App.canAccess(ev.go)) {
        UI.toast(ev.id + " is worked from " + (ev.owner || "its own module"), { type: "info" });
        return;
      }
      UI.$("#modalHost").hidden = true;
      App.go(ev.go, { highlight: (ev.raw && ev.raw.id) || ev.id });
    }

    function dayModal(ds, list) {
      UI.modal({ title: fmtLong(parseISO(ds)), sub: list.length + (list.length === 1 ? " entry" : " entries"),
        wide: true, body: h("div", { class: "cal-day-list" }, list.map((ev) => evRow(ev))) });
    }
    function listModal(title, sub, list) {
      UI.modal({ title, sub, wide: true,
        body: list.length
          ? h("div", { class: "cal-day-list" }, list.slice().sort(byDateTime).map((ev) => evRow(ev)))
          : h("div", { class: "empty" }, [h("div", { class: "big", text: "✓" }), h("div", { text: "Nothing here" })]) });
    }

    /* ============================================================
       EVENT SOURCES

       Every reader is guarded with `(D.x || [])` and every source is
       gated on `want(key)`. Both matter: the guard is because the
       server genuinely does not send a role collections it has no
       business with, and the gate is so the chip counts describe
       this role's work rather than the whole business.
       ============================================================ */
    function buildEvents() {
      const out = [];
      const D = ENG.data || {};
      const want = (k) => mine.some((s) => s.key === k);
      const push = (e) => out.push(Object.assign(
        { done: false, chaseable: true, time: "" }, e, { color: srcColor(e.source) }));

      // --- appointments: a commitment made to a time, not to an order ----
      if (want("appt")) (D.appointments || []).forEach((a) => {
        push({ id: a.id, date: a.date, time: a.time || "", source: "appt", raw: a, done: !!a.done,
          icon: "📅", title: a.title, owner: "the Calendar",
          sub: [a.kind, a.location].filter(Boolean).join(" · ") || "Appointment", go: "calendar" });
      });

      // --- CRM follow-ups: the call we said we would make ----------------
      if (want("lead")) (D.leads || []).forEach((l) => {
        if (!l.nextFollowUp || l.stage === "Won" || l.stage === "Lost") return;
        push({ id: l.id, date: l.nextFollowUp, source: "lead", raw: l, icon: "🎯",
          title: "Chase " + l.company, value: l.value || 0, owner: "the CRM",
          sub: l.stage + " · " + (l.productName || l.product || "—") + (l.contact ? " · " + l.contact : ""),
          go: "crm" });
      });

      // --- purchase orders: goods we are waiting on ----------------------
      if (want("po")) (D.purchaseorders || []).forEach((p) => {
        if (!p.eta || p.status === "Received") return;
        const pend = (p.lines || []).reduce((s, l) => s + Math.max(0, l.qty - (l.recd || 0)) * l.rate, 0);
        push({ id: p.id, date: p.eta, source: "po", raw: p, icon: "🛒",
          title: ENG.sup(p.supplierId) + " arriving", value: pend, owner: "Procurement",
          sub: p.id + " · " + (p.lines || []).length + " item(s) · " + p.status, go: "purchase" });
      });

      // --- sales orders: the ship-by we agreed ---------------------------
      if (want("so")) (D.salesorders || []).forEach((s) => {
        if (!s.promised || s.status === "Dispatched") return;
        push({ id: s.id, date: s.promised, source: "so", raw: s, icon: "🧾",
          title: "Ship to " + ENG.custName(s.customerId), value: s.value || 0, owner: "Sales Orders",
          sub: s.id + " · " + (s.lines || []).length + " line(s) · " + s.priority, go: "sales" });
      });

      // --- work orders: the run that must come off the line --------------
      if (want("wo")) (D.workorders || []).forEach((w) => {
        if (!w.due) return;
        const finished = (w.status === "Completed" || w.status === "Dispatched") && !((+w.pendingQty || 0) > 1e-6);
        if (finished) return;
        const it = ENG.item(w.itemId) || {};
        push({ id: w.id, date: w.due, source: "wo", raw: w, icon: "⚙️",
          title: trim(it.name || w.itemId, 30) + " due", owner: "Production",
          sub: w.id + " · " + (it.id ? ENG.qtyText(it, w.qty, 0) : ENG.num(w.qty) + " kg") + " · " + (w.status || ""),
          go: "production" });
      });

      /* --- batches waiting on a reading --------------------------------
         Dated by the run's own due date: the reading is owed by the time the
         batch is due off, not on some date of its own. A job with no due date
         has nothing to place it on the grid, so it is left to the Lab Reports
         worklist rather than being parked on today and read as late. */
      if (want("lab")) (D.labPending || []).forEach((p) => {
        if (!p.due) return;
        push({ id: p.woId, date: p.due, source: "lab", raw: p, icon: "🧪",
          title: "Test " + trim(p.productName || p.productCode || p.woId, 26), owner: "Lab Reports",
          sub: p.woId + " · " + (p.productCode || "") + (p.stage === "production" ? " · floor reading" : " · lab reading"),
          go: "lab-reports" });
      });

      /* --- deliveries waiting on an incoming test ----------------------
         Dated by the GRN's own date — the day the lorry landed is the day the
         test started being owed, so an untested receipt drifts left into
         "overdue" on its own as the days pass, which is the point. */
      if (want("grnt")) (D.grnTestPending || []).forEach((t) => {
        if (!t.date) return;
        push({ id: t.grnId + ":" + t.itemId, date: t.date, source: "grnt", raw: t, icon: "🔬",
          title: "Test " + trim(t.itemName || t.itemId, 26), owner: "Procurement",
          sub: t.grnId + (t.invNo ? " · inv " + t.invNo : "") + " · " + (t.params || []).length + " reading(s)",
          go: "purchase" });
      });

      /* --- approved leave: who will not be here -------------------------
         One entry PER DAY of the absence, because "is Ramesh in on the 14th?"
         is the question being asked, not "when did his leave start". Not
         chaseable — an absence is a fact, not a job going late. */
      if (want("leave")) (D.hrLeaves || []).forEach((lv) => {
        if (lv.status !== "Approved" || !lv.fromDate) return;
        const w = (D.hrWorkers || []).find((x) => x.id === lv.workerId) || {};
        const end = parseISO(lv.toDate || lv.fromDate);
        for (let d = parseISO(lv.fromDate); d <= end; d = new Date(d.getTime() + DAY)) {
          push({ id: lv.id + ":" + DB.helpers.iso(d), date: DB.helpers.iso(d), source: "leave", raw: lv,
            icon: "🌴", chaseable: false, title: (w.name || lv.workerId) + " on leave", owner: "Leave",
            sub: (w.dept || "") + " · " + lv.fromDate + " → " + (lv.toDate || lv.fromDate), go: "hr-leave" });
        }
      });

      return out.sort(byDateTime);
    }

    function matches(ev, needle) {
      if (!needle) return true;
      return (ev.title + " " + ev.sub + " " + ev.id).toLowerCase().includes(needle);
    }

    // land on a given month when something else sends us here with a date
    if (params && params.date) cursor = startOfDay(parseISO(params.date));
    draw();
  }};

  /* ============================================================
     helpers — the same date maths the CRM calendar uses; kept local
     so neither screen can quietly change the other's grid.
     ============================================================ */
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
})();
