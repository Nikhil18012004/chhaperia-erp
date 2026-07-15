/* ============================================================
   CHHAPERIA ERP — HUMAN RESOURCES & PAYROLL  (frontend)
   Tabs: Dashboard · Workers · Attendance (muster + biometric)
         · Leave · Payroll · Settings
   Daily-wage base with fully-configurable OT + PF/ESI/PT and
   admin-defined leave types. Biometric device pushes punches to
   /api/hr/punch; the server derives the daily muster.
   ============================================================ */
(function () {
  "use strict";
  const { h, esc, table, badge, toast, modal, confirm } = UI;
  const { pageHead, kpi } = MW;
  const U = window._erpUtil;
  const money = (n) => ENG.money(n);
  const num = (n, d) => ENG.num(n, d);
  const iso = () => DB.helpers.iso(DB.helpers.today());
  const pad = (n) => String(n).padStart(2, "0");

  // each HR view is its own top-level nav item (id) ⇄ internal tab name
  const ID_TAB = { hr: "dashboard", "hr-workers": "workers", "hr-attendance": "attendance",
    "hr-leave": "leave", "hr-payroll": "payroll", "hr-settings": "settings" };
  const TAB_ID = { dashboard: "hr", workers: "hr-workers", attendance: "hr-attendance",
    leave: "hr-leave", payroll: "hr-payroll", settings: "hr-settings" };
  const DEPTS = ["coating", "slitting", "fiberglass", "packing", "admin", "maintenance"];
  const STATUS_META = { P: ["ok", "Present"], HD: ["warn", "Half day"], A: ["danger", "Absent"], L: ["info", "Leave"], WO: ["mut", "Week-off"] };

  let curTab = "dashboard";
  function workers() { return ENG.data.hrWorkers || []; }
  function wById(id) { return workers().find((w) => w.id === id) || { name: id }; }
  function attendance() { return ENG.data.hrAttendance || []; }
  function leaveTypes() { return ENG.data.hrLeaveTypes || []; }
  function leaves() { return ENG.data.hrLeaves || []; }
  function payruns() { return ENG.data.hrPayruns || []; }
  function payslips() { return ENG.data.hrPayslips || []; }

  /* run an HR API call, reload the dataset, land on the given view */
  async function save(apiCall, tab) {
    try { await apiCall(); await App.reloadState(); App.go(TAB_ID[tab || curTab] || "hr"); }
    catch (e) { toast(e.message || "Save failed", { type: "danger", title: "HR" }); }
  }

  const TAB_RENDER = { dashboard: tabDashboard, workers: tabWorkers, attendance: tabAttendance,
    leave: tabLeave, payroll: tabPayroll, settings: tabSettings };
  const TAB_HEAD = {
    dashboard: ["Human Resources & Payroll", "Workforce, biometric attendance, leave and daily-wage payroll — at a glance."],
    workers: ["Workers", "Your workforce — labours & staff, wage rates and biometric IDs."],
    attendance: ["Attendance", "Biometric muster roll, overtime and manual corrections."],
    leave: ["Leave", "Requests, approvals and live balances."],
    payroll: ["Payroll", "Attendance-driven daily-wage payslips with statutory deductions."],
    settings: ["HR Settings", "Overtime, deduction rules, biometric device and leave types."],
  };
  const TAB_TITLE = { dashboard: "HR · Overview", workers: "HR · Workers", attendance: "HR · Attendance",
    leave: "HR · Leave", payroll: "HR · Payroll", settings: "HR · Settings" };

  // register one module per nav item; the sidebar section provides navigation
  Object.keys(ID_TAB).forEach((id) => {
    const tab = ID_TAB[id];
    M[id] = { title: TAB_TITLE[tab], sub: "HR & Payroll", render(root, params) {
      curTab = tab;
      const head = TAB_HEAD[tab];
      root.appendChild(pageHead(head[0], head[1], headerActions()));
      const host = h("div"); root.appendChild(host);
      (TAB_RENDER[tab] || tabDashboard)(host, params);
    }};
  });

  function headerActions() {
    if (curTab === "workers") return [h("button", { class: "btn primary", onclick: () => workerForm(), html: "＋ New Worker" })];
    if (curTab === "leave") return [h("button", { class: "btn primary", onclick: () => leaveForm(), html: "＋ Apply Leave" })];
    if (curTab === "payroll") return [h("button", { class: "btn primary", onclick: () => runPayrollFlow(), html: "▶ Run Payroll" })];
    if (curTab === "settings") return [h("button", { class: "btn", onclick: () => leaveTypeForm(), html: "＋ Leave Type" })];
    return [];
  }

  /* ============================================================
     DASHBOARD
     ============================================================ */
  function tabDashboard(host) {
    const today = iso();
    const active = workers().filter((w) => w.active !== false);
    const todayAtt = attendance().filter((a) => a.date === today);
    const present = todayAtt.filter((a) => a.status === "P" || a.status === "HD").length;
    const onLeave = todayAtt.filter((a) => a.status === "L").length;
    const absent = todayAtt.filter((a) => a.status === "A").length;
    const pending = leaves().filter((l) => l.status === "Pending").length;
    const wageCapacity = active.reduce((s, w) => s + (w.payType === "monthly" ? (w.monthlyCtc || 0) : (w.dailyRate || 0) * 26), 0);

    host.appendChild(h("div", { class: "grid kpi-grid", style: "margin-bottom:16px" }, [
      kpi({ icon: "👷", label: "Active Workers", value: num(active.length) }),
      kpi({ icon: "✅", label: "Present Today", value: num(present), delta: absent ? absent + " absent" : "full house", deltaType: absent ? "down" : "up" }),
      kpi({ icon: "🌴", label: "On Leave Today", value: num(onLeave) }),
      kpi({ icon: "💰", label: "Est. Monthly Wage Bill", value: money(wageCapacity), delta: "at ~26 days", deltaType: "flat" }),
    ]));

    // attendance by department (today)
    const byDept = {};
    active.forEach((w) => { const d = w.dept || "—"; byDept[d] = byDept[d] || { present: 0, total: 0 };
      byDept[d].total++; const a = todayAtt.find((x) => x.workerId === w.id); if (a && (a.status === "P" || a.status === "HD")) byDept[d].present++; });
    const grid = h("div", { class: "grid cols-2", style: "margin-bottom:16px" });
    grid.appendChild(h("div", { class: "card" }, [
      h("div", { class: "card-head" }, [h("h3", { text: "Attendance by Department (today)" }), h("div", { class: "sub", text: today })]),
      h("div", {}, Object.keys(byDept).length ? Object.entries(byDept).map(([d, v]) => {
        const pct = v.total ? Math.round(v.present / v.total * 100) : 0;
        return h("div", { style: "margin-bottom:10px" }, [
          h("div", { class: "flex between", style: "font-size:12.5px;margin-bottom:4px" }, [
            h("span", { html: "<b>" + esc(cap(d)) + "</b>" }), h("span", { class: "muted", text: v.present + "/" + v.total })]),
          h("div", { html: UI.meter(pct, pct >= 80 ? "ok" : pct >= 50 ? "warn" : "danger") })]);
      }) : [h("div", { class: "muted", text: "No attendance punched yet today — use the Attendance tab." })]),
    ]));
    // pending leave requests
    const pend = leaves().filter((l) => l.status === "Pending").slice(0, 8);
    grid.appendChild(h("div", { class: "card" }, [
      h("div", { class: "card-head" }, [h("h3", { html: "🔔 Pending Leave (" + pending + ")" }), h("div", { class: "sub", text: "Approve or reject in the Leave tab" })]),
      h("div", {}, pend.length ? pend.map((l) => h("div", { class: "flex between aic", style: "padding:7px 0;border-bottom:1px solid var(--line);cursor:pointer", onclick: () => App.go("hr-leave") }, [
        h("div", {}, [h("div", { style: "font-weight:600;font-size:13px", text: wById(l.workerId).name }), h("div", { class: "muted", style: "font-size:11.5px", text: (ltName(l.type)) + " · " + l.fromDate + " → " + l.toDate })]),
        h("span", { html: badge("warn", l.days + "d") })])) : [h("div", { class: "muted", text: "No pending requests." })]),
    ]));
    host.appendChild(grid);

    // live biometric punch feed
    const feed = h("div", { class: "card" }, [
      h("div", { class: "card-head" }, [h("h3", { html: "🔌 Live Biometric Feed" }), h("div", { class: "sub", text: "Most recent device punches" })]),
      h("div", { id: "hr_feed" }, h("div", { class: "muted", text: "Loading…" })),
    ]);
    host.appendChild(feed);
    DB.hr.punches(12).then(({ punches }) => {
      const box = UI.$("#hr_feed"); if (!box) return; box.innerHTML = "";
      if (!punches.length) { box.appendChild(h("div", { class: "muted", text: "No punches yet. Go to Attendance → Simulate to demo the device." })); return; }
      punches.forEach((p) => box.appendChild(h("div", { class: "flex between aic", style: "padding:6px 0;border-bottom:1px solid var(--line)" }, [
        h("div", { class: "flex aic gap" }, [h("span", { text: p.direction === "out" ? "🔴" : "🟢" }),
          h("span", { style: "font-weight:600;font-size:13px", text: p.workerId ? wById(p.workerId).name : "Unknown (uid " + p.deviceUid + ")" })]),
        h("span", { class: "mono muted", style: "font-size:12px", text: (p.ts || "").slice(0, 16).replace("T", " ") })])));
    }).catch(() => {});
  }

  /* ============================================================
     WORKERS
     ============================================================ */
  function tabWorkers(host) {
    let filter = { q: "", dept: "all" };
    const bar = h("div", { class: "toolbar" }, [
      MW.searchInput("Search name, code, device…", (v) => { filter.q = v.toLowerCase(); draw(); }),
      MW.select([{ value: "all", label: "All Departments" }, ...DEPTS.map((d) => ({ value: d, label: cap(d) }))], (v) => { filter.dept = v; draw(); }),
      h("div", { style: "margin-left:auto" }, h("span", { class: "chip", id: "wkCount" })),
    ]);
    host.appendChild(bar);
    const tHost = h("div"); host.appendChild(tHost);
    function rows() {
      return workers().filter((w) => {
        if (filter.dept !== "all" && w.dept !== filter.dept) return false;
        if (filter.q) { const s = (w.name + " " + w.id + " " + (w.deviceUid || "") + " " + (w.designation || "")).toLowerCase(); if (!s.includes(filter.q)) return false; }
        return true;
      });
    }
    function draw() {
      const data = rows(); const c = UI.$("#wkCount"); if (c) c.textContent = data.length + " workers";
      tHost.innerHTML = "";
      tHost.appendChild(table(data, [
        { key: "id", label: "Code", render: (r) => `<span class="mono strong">${r.id}</span>`, sort: (r) => r.id },
        { key: "name", label: "Worker", render: (r) => `<div class="cell-main">${esc(r.name)}</div><div class="cell-sub">${esc(r.designation || "—")}</div>`, sort: (r) => r.name },
        { key: "dept", label: "Department", render: (r) => badge("mut", cap(r.dept || "—")), sort: (r) => r.dept || "" },
        { key: "pay", label: "Pay", render: (r) => r.payType === "monthly" ? "Monthly" : "Daily", sort: (r) => r.payType },
        { key: "rate", label: "Rate", num: true, render: (r) => r.payType === "monthly" ? money(r.monthlyCtc) + "/mo" : money(r.dailyRate) + "/day", sort: (r) => r.dailyRate || r.monthlyCtc },
        { key: "device", label: "Biometric ID", render: (r) => r.deviceUid ? `<span class="mono">${esc(r.deviceUid)}</span>` : '<span class="muted">—</span>', sort: (r) => r.deviceUid || "" },
        { key: "active", label: "Status", render: (r) => r.active === false ? badge("mut", "Inactive") : badge("ok", "Active"), sort: (r) => (r.active === false ? 1 : 0) },
      ], { onRow: (r) => workerDetail(r.id), empty: "No workers — add one with ＋ New Worker" }));
    }
    draw();
  }

  function workerDetail(id) {
    const w = wById(id);
    const recentAtt = attendance().filter((a) => a.workerId === id).sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 10);
    const body = h("div", {}, [
      MW.dl([
        ["Department", cap(w.dept || "—")], ["Designation", w.designation || "—"],
        ["Pay Type", w.payType === "monthly" ? "Monthly salary" : "Daily wage"],
        [w.payType === "monthly" ? "Monthly CTC" : "Daily Rate", w.payType === "monthly" ? money(w.monthlyCtc) : money(w.dailyRate)],
        ["Biometric ID", w.deviceUid || "—"], ["Phone", w.phone || "—"], ["Joined", w.joined || "—"],
        ["Shift", w.shift || "General"], ["PF No.", w.pfNo || "—"], ["ESI No.", w.esiNo || "—"],
        ["Bank A/C", w.bankAcc ? (w.bankAcc + " · " + (w.bankIfsc || "")) : "—"],
      ]),
      h("h3", { style: "margin:16px 0 8px;font-size:14px", text: "Leave Balances" }),
      h("div", { id: "wk_bal", class: "flex gap wrap" }, h("span", { class: "muted", text: "Loading…" })),
      h("h3", { style: "margin:16px 0 8px;font-size:14px", text: "Recent Attendance" }),
      table(recentAtt, [
        { key: "date", label: "Date", render: (r) => r.date, noSort: true },
        { key: "status", label: "Status", render: (r) => badge((STATUS_META[r.status] || ["mut", r.status])[0], (STATUS_META[r.status] || ["", r.status])[1]), noSort: true },
        { key: "in", label: "In", render: (r) => r.inTime || "—", noSort: true },
        { key: "out", label: "Out", render: (r) => r.outTime || "—", noSort: true },
        { key: "hours", label: "Hours", num: true, render: (r) => r.hours ? num(r.hours, 2) : "—", noSort: true },
        { key: "ot", label: "OT", num: true, render: (r) => r.otHours ? `<span class="badge-s s-warn">${num(r.otHours, 2)}h</span>` : "—", noSort: true },
      ], { empty: "No attendance yet" }),
    ]);
    modal({ title: w.name, sub: w.id + " · " + cap(w.dept || ""), wide: true, body,
      foot: [h("button", { class: "btn danger", onclick: () => delWorker(w), text: "🗑 Delete" }),
        h("button", { class: "btn ghost", onclick: () => { UI.$("#modalHost").hidden = true; workerForm(w); }, text: "✎ Edit" })] });
    DB.hr.balances(id).then(({ balances }) => { const box = UI.$("#wk_bal"); if (!box) return; box.innerHTML = "";
      if (!balances.length) { box.appendChild(h("span", { class: "muted", text: "No leave types configured." })); return; }
      balances.forEach((b) => box.appendChild(h("div", { class: "chip", style: "padding:8px 12px" },
        h("span", { html: `<b>${esc(b.name)}</b> · ${b.balance} left <span class="muted">/ ${b.entitled}</span>` })))); }).catch(() => {});
  }

  function workerForm(w) {
    const edit = !!w; w = w || { payType: "daily", active: true };
    const f = (k, d) => (w[k] != null ? w[k] : (d == null ? "" : d));
    const body = h("div", { class: "form-grid" }, [
      U.field("Worker Code", `<input class="input" id="w_id" value="${esc(f("id"))}" ${edit ? "disabled" : ""} placeholder="Auto (EMP-000N) if blank">`),
      U.field("Full Name", `<input class="input" id="w_name" value="${esc(f("name"))}" placeholder="e.g. Ramesh Kumar">`),
      U.field("Department", U.selectHTML("w_dept", DEPTS.map((d) => ({ v: d, l: cap(d) })), f("dept", "coating"))),
      U.field("Designation", `<input class="input" id="w_desig" value="${esc(f("designation"))}" placeholder="e.g. Machine Operator">`),
      U.field("Pay Type", U.selectHTML("w_ptype", [{ v: "daily", l: "Daily wage" }, { v: "monthly", l: "Monthly salary" }], f("payType", "daily"))),
      U.field("Daily Rate (₹/day)", `<input class="input" id="w_rate" type="number" value="${f("dailyRate", 0)}">`),
      U.field("Monthly CTC (₹, if monthly)", `<input class="input" id="w_ctc" type="number" value="${f("monthlyCtc", 0)}">`),
      U.field("Biometric Device ID", `<input class="input" id="w_dev" value="${esc(f("deviceUid"))}" placeholder="Punch-machine user id">`),
      U.field("Phone", `<input class="input" id="w_phone" value="${esc(f("phone"))}">`),
      U.field("Joined On", `<input class="input" id="w_join" type="date" value="${f("joined", iso())}">`),
      U.field("PF Number", `<input class="input" id="w_pf" value="${esc(f("pfNo"))}">`),
      U.field("ESI Number", `<input class="input" id="w_esi" value="${esc(f("esiNo"))}">`),
      U.field("Bank A/C", `<input class="input" id="w_bank" value="${esc(f("bankAcc"))}">`),
      U.field("Bank IFSC", `<input class="input" id="w_ifsc" value="${esc(f("bankIfsc"))}">`),
      U.field("Status", U.selectHTML("w_active", [{ v: "1", l: "Active" }, { v: "0", l: "Inactive" }], w.active === false ? "0" : "1")),
    ]);
    const mo = modal({ title: edit ? "Edit Worker" : "New Worker", sub: edit ? w.id : "Add a worker / labour", wide: true, body,
      foot: [h("button", { class: "btn ghost", onclick: () => mo.close(), text: "Cancel" }),
        h("button", { class: "btn primary", onclick: doSave, text: edit ? "Save Changes" : "Create Worker" })] });
    function doSave() {
      const g = (id) => { const el = UI.$("#" + id); return el ? el.value : ""; };
      const name = g("w_name").trim(); if (!name) { toast("Name is required", { type: "warn" }); return; }
      const payload = { name, dept: g("w_dept"), designation: g("w_desig").trim(), payType: g("w_ptype"),
        dailyRate: +g("w_rate") || 0, monthlyCtc: +g("w_ctc") || 0, deviceUid: g("w_dev").trim() || null,
        phone: g("w_phone").trim(), joined: g("w_join"), pfNo: g("w_pf").trim(), esiNo: g("w_esi").trim(),
        bankAcc: g("w_bank").trim(), bankIfsc: g("w_ifsc").trim(), active: g("w_active") === "1" };
      mo.close();
      if (edit) save(() => DB.hr.worker.update(w.id, payload), "workers");
      else { const code = g("w_id").trim().toUpperCase(); if (code) payload.id = code; save(() => DB.hr.worker.create(payload), "workers"); }
    }
  }
  async function delWorker(w) {
    if (!await confirm(`Delete ${w.name} (${w.id})? Their attendance/leave history stays but the worker record is removed.`, { title: "Delete Worker", danger: true })) return;
    UI.$("#modalHost").hidden = true; save(() => DB.hr.worker.remove(w.id), "workers");
  }

  /* ============================================================
     ATTENDANCE — monthly muster matrix + biometric simulator
     ============================================================ */
  function tabAttendance(host, params) {
    const now = DB.helpers.today();
    let period = (params && params.period) || `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
    let dept = "all";
    const bar = h("div", { class: "toolbar", style: "flex-wrap:wrap;gap:10px" }, [
      U.field ? h("div", { class: "field", style: "margin:0" }, [h("label", { text: "Month" }), h("div", {}, h("input", { class: "input", type: "month", value: period, style: "max-width:170px", onchange: (e) => { period = e.target.value; draw(); } }))]) : null,
      MW.select([{ value: "all", label: "All Departments" }, ...DEPTS.map((d) => ({ value: d, label: cap(d) }))], (v) => { dept = v; draw(); }),
      h("button", { class: "btn", onclick: () => manualEntry(), html: "✎ Mark Attendance" }),
      h("button", { class: "btn primary", onclick: () => simulate(), html: "🔌 Simulate Biometric Punches" }),
    ]);
    host.appendChild(bar);
    host.appendChild(h("div", { class: "flex gap wrap", style: "margin:4px 0 12px;font-size:11.5px" },
      Object.entries(STATUS_META).map(([k, m]) => h("span", { class: "chip" }, h("span", { html: `<span class="badge-s s-${m[0]}">${k}</span> ${m[1]}` })))));
    const grid = h("div"); host.appendChild(grid);
    function draw() {
      grid.innerHTML = "";
      const [y, m] = period.split("-").map(Number);
      const days = new Date(y, m, 0).getDate();
      const list = workers().filter((w) => w.active !== false && (dept === "all" || w.dept === dept));
      const attMap = {}; attendance().forEach((a) => { attMap[a.workerId + ":" + a.date] = a; });
      const WD = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
      // ---- desktop/tablet: scrolling matrix (hidden ≤640px) ----
      const wrap = h("div", { class: "muster-full", style: "overflow-x:auto;border:1px solid var(--line);border-radius:12px" });
      const tbl = h("table", { class: "tbl muster" });
      const head = h("tr", {}, [h("th", { style: "position:sticky;left:0;background:var(--panel);text-align:left;min-width:150px", text: "Worker" })]);
      for (let d = 1; d <= days; d++) { const wd = new Date(y, m - 1, d).getDay();
        head.appendChild(h("th", { style: "padding:4px 2px;font-size:10px;" + (wd === 0 ? "color:var(--danger)" : ""), text: d })); }
      head.appendChild(h("th", { style: "min-width:56px", text: "P" }));
      head.appendChild(h("th", { style: "min-width:56px", text: "OT" }));
      tbl.appendChild(h("thead", {}, head));
      const tbody = h("tbody");
      // ---- phone: one card per worker, name header + scrollable day strip ----
      const mob = h("div", { class: "muster-mobile" });
      if (!list.length) {
        tbody.appendChild(h("tr", {}, h("td", { colspan: days + 3 }, h("div", { class: "empty", style: "padding:24px", text: "No workers" }))));
        mob.appendChild(h("div", { class: "empty", style: "padding:36px 20px", text: "No workers" }));
      }
      list.forEach((w) => {
        const tr = h("tr");
        tr.appendChild(h("td", { style: "position:sticky;left:0;background:var(--panel);font-weight:600;font-size:12px;min-width:150px", text: U.trim(w.name, 20) }));
        const strip = h("div", { class: "mstrip" });
        let p = 0, ot = 0;
        for (let d = 1; d <= days; d++) {
          const ds = `${y}-${pad(m)}-${pad(d)}`;
          const a = attMap[w.id + ":" + ds];
          const wd = new Date(y, m - 1, d).getDay();
          let letter = "", cls = "";
          if (a) { letter = a.status; const meta = STATUS_META[a.status] || ["mut", ""]; cls = "s-" + meta[0];
            if (a.status === "P") p++; else if (a.status === "HD") p += 0.5; ot += a.otHours || 0; }
          else if (wd === 0) { letter = "·"; cls = "s-mut"; }
          const title = a ? (STATUS_META[a.status] ? STATUS_META[a.status][1] : a.status) + (a.otHours ? " · OT " + a.otHours + "h" : "") : "Mark " + ds;
          tr.appendChild(h("td", { style: "text-align:center;padding:2px;cursor:pointer", title, onclick: () => dayEntry(w, ds, a) },
            letter ? h("span", { class: "badge-s " + cls, style: "min-width:20px;display:inline-block", text: letter }) : h("span", { class: "muted", text: "" })));
          // phone strip cell: weekday + day number + status pip, tap to edit
          strip.appendChild(h("button", { class: "mcell" + (wd === 0 ? " sun" : ""), title, onclick: () => dayEntry(w, ds, a) }, [
            h("span", { class: "mcell-wd", text: WD[wd] }),
            h("span", { class: "mcell-d", text: d }),
            letter ? h("span", { class: "badge-s " + cls, text: letter }) : h("span", { class: "mcell-e", text: "–" }),
          ]));
        }
        tr.appendChild(h("td", { style: "text-align:center;font-weight:700", text: p }));
        tr.appendChild(h("td", { style: "text-align:center", html: ot ? `<span class="badge-s s-warn">${num(ot, 1)}h</span>` : '<span class="muted">—</span>' }));
        tbody.appendChild(tr);
        const stats = [h("span", { class: "badge-s s-ok", text: "P " + p })];
        if (ot) stats.push(h("span", { class: "badge-s s-warn", text: "OT " + num(ot, 1) + "h" }));
        mob.appendChild(h("div", { class: "mcard" }, [
          h("div", { class: "mcard-head" }, [
            h("span", { class: "mcard-name", text: U.trim(w.name, 28) }),
            h("span", { class: "mcard-stats" }, stats),
          ]),
          strip,
        ]));
      });
      tbl.appendChild(tbody); wrap.appendChild(tbl);
      grid.appendChild(wrap); grid.appendChild(mob);
    }
    draw();

    function dayEntry(w, ds, a) {
      const body = h("div", { class: "form-grid" }, [
        U.field("Status", U.selectHTML("d_status", Object.keys(STATUS_META).map((k) => ({ v: k, l: STATUS_META[k][1] })), a ? a.status : "P")),
        U.field("In Time", `<input class="input" id="d_in" type="time" value="${a && a.inTime ? a.inTime : "09:00"}">`),
        U.field("Out Time", `<input class="input" id="d_out" type="time" value="${a && a.outTime ? a.outTime : "17:30"}">`),
        U.field("OT Hours", `<input class="input" id="d_ot" type="number" step="0.5" value="${a ? a.otHours || 0 : 0}">`),
        U.field("Note", `<input class="input" id="d_note" value="${esc(a && a.note || "")}">`, "full"),
      ]);
      const mo = modal({ title: "Attendance — " + w.name, sub: ds, body,
        foot: [h("button", { class: "btn ghost", onclick: () => mo.close(), text: "Cancel" }),
          h("button", { class: "btn primary", onclick: () => { const p = { workerId: w.id, date: ds, status: UI.$("#d_status").value, inTime: UI.$("#d_in").value, outTime: UI.$("#d_out").value, otHours: +UI.$("#d_ot").value || 0, note: UI.$("#d_note").value }; mo.close(); save(() => DB.hr.attendance(p), "attendance"); }, text: "Save" })] });
    }
    function manualEntry() { const list = workers().filter((w) => w.active !== false); if (list.length) dayEntry(list[0], iso(), null); }

    async function simulate() {
      const active = workers().filter((w) => w.active !== false && w.deviceUid);
      if (!active.length) { toast("Add workers with a Biometric Device ID first", { type: "warn" }); return; }
      const today = iso();
      const pick = active.slice(0, Math.min(5, active.length));
      const jobs = [];
      pick.forEach((w, i) => {
        jobs.push(DB.hr.punch({ deviceUid: w.deviceUid, ts: today + "T09:0" + (i % 6) + ":00", direction: "in", deviceId: "SIM-01", source: "sim" }));
        const outH = 17 + (i % 3); const outM = i % 2 ? "45" : "10";
        jobs.push(DB.hr.punch({ deviceUid: w.deviceUid, ts: today + "T" + pad(outH) + ":" + outM + ":00", direction: "out", deviceId: "SIM-01", source: "sim" }));
      });
      try { await Promise.all(jobs); toast(pick.length + " workers punched in/out (simulated device)", { type: "ok", title: "Biometric" }); await App.reloadState(); App.go("hr-attendance", { period }); }
      catch (e) { toast(e.message, { type: "danger" }); }
    }
  }

  /* ============================================================
     LEAVE
     ============================================================ */
  function tabLeave(host) {
    const data = leaves().slice().sort((a, b) => (a.appliedOn < b.appliedOn ? 1 : -1));
    const pend = data.filter((l) => l.status === "Pending").length;
    host.appendChild(h("div", { class: "grid kpi-grid", style: "margin-bottom:16px" }, [
      kpi({ icon: "🌴", label: "Total Requests", value: num(data.length) }),
      kpi({ icon: "🔔", label: "Pending", value: num(pend), delta: pend ? "Action needed" : "All clear", deltaType: pend ? "down" : "up" }),
      kpi({ icon: "✅", label: "Approved", value: num(data.filter((l) => l.status === "Approved").length) }),
      kpi({ icon: "🗂", label: "Leave Types", value: num(leaveTypes().length) }),
    ]));
    host.appendChild(table(data, [
      { key: "worker", label: "Worker", render: (r) => `<div class="cell-main">${esc(wById(r.workerId).name)}</div><div class="cell-sub">${r.workerId}</div>`, sort: (r) => wById(r.workerId).name },
      { key: "type", label: "Type", render: (r) => badge("info", ltName(r.type)), sort: (r) => r.type },
      { key: "from", label: "From", render: (r) => r.fromDate, sort: (r) => r.fromDate },
      { key: "to", label: "To", render: (r) => r.toDate, sort: (r) => r.toDate },
      { key: "days", label: "Days", num: true, render: (r) => num(r.days, 1), sort: (r) => r.days },
      { key: "status", label: "Status", render: (r) => badge(r.status === "Approved" ? "ok" : r.status === "Rejected" ? "danger" : "warn", r.status), sort: (r) => r.status },
      { key: "act", label: "", noSort: true, render: (r) => leaveActions(r) },
    ], { onRow: (r) => leaveDetail(r), empty: "No leave requests — apply with ＋ Apply Leave" }));
  }
  function leaveActions(l) {
    if (l.status !== "Pending") return h("button", { class: "btn sm ghost", onclick: (e) => { e.stopPropagation(); delLeave(l); }, text: "🗑" });
    return h("div", { class: "flex gap" }, [
      h("button", { class: "btn sm primary", onclick: (e) => { e.stopPropagation(); save(() => DB.hr.leave.decide(l.id, "Approved"), "leave"); }, text: "Approve" }),
      h("button", { class: "btn sm", style: "color:var(--danger)", onclick: (e) => { e.stopPropagation(); save(() => DB.hr.leave.decide(l.id, "Rejected"), "leave"); }, text: "Reject" }),
    ]);
  }
  function leaveDetail(l) {
    const body = h("div", {}, [MW.dl([
      ["Worker", wById(l.workerId).name + " (" + l.workerId + ")"], ["Type", ltName(l.type)],
      ["From", l.fromDate], ["To", l.toDate], ["Days", num(l.days, 1)],
      ["Status", l.status], ["Reason", l.reason || "—"], ["Applied On", l.appliedOn || "—"],
      l.decidedBy ? ["Decided By", l.decidedBy] : null,
    ].filter(Boolean))]);
    const foot = [h("button", { class: "btn danger", onclick: () => delLeave(l), text: "🗑 Delete" })];
    if (l.status === "Pending") { foot.push(h("button", { class: "btn", style: "color:var(--danger)", onclick: () => { UI.$("#modalHost").hidden = true; save(() => DB.hr.leave.decide(l.id, "Rejected"), "leave"); }, text: "Reject" }));
      foot.push(h("button", { class: "btn primary", onclick: () => { UI.$("#modalHost").hidden = true; save(() => DB.hr.leave.decide(l.id, "Approved"), "leave"); }, text: "Approve" })); }
    modal({ title: "Leave — " + wById(l.workerId).name, sub: l.id, body, foot });
  }
  async function delLeave(l) { if (!await confirm(`Delete this ${ltName(l.type)} request?`, { title: "Delete Leave", danger: true })) return; UI.$("#modalHost").hidden = true; save(() => DB.hr.leave.remove(l.id), "leave"); }
  function leaveForm() {
    const ws = workers().filter((w) => w.active !== false); const lts = leaveTypes();
    if (!ws.length) { toast("Add a worker first", { type: "warn" }); return; }
    if (!lts.length) { toast("Define a leave type in Settings first", { type: "warn" }); return; }
    const body = h("div", { class: "form-grid" }, [
      U.field("Worker", U.selectHTML("l_wk", ws.map((w) => ({ v: w.id, l: w.name })), ws[0].id)),
      U.field("Leave Type", U.selectHTML("l_type", lts.map((t) => ({ v: t.id, l: t.name })), lts[0].id)),
      U.field("From", `<input class="input" id="l_from" type="date" value="${iso()}">`),
      U.field("To", `<input class="input" id="l_to" type="date" value="${iso()}">`),
      U.field("Reason", `<input class="input" id="l_reason" placeholder="Optional">`, "full"),
    ]);
    const mo = modal({ title: "Apply Leave", sub: "Raise a leave request", body,
      foot: [h("button", { class: "btn ghost", onclick: () => mo.close(), text: "Cancel" }),
        h("button", { class: "btn primary", onclick: () => { const p = { workerId: UI.$("#l_wk").value, type: UI.$("#l_type").value, fromDate: UI.$("#l_from").value, toDate: UI.$("#l_to").value, reason: UI.$("#l_reason").value }; if (p.toDate < p.fromDate) { toast("End date before start", { type: "warn" }); return; } mo.close(); save(() => DB.hr.leave.apply(p), "leave"); }, text: "Submit" })] });
  }

  /* ============================================================
     PAYROLL
     ============================================================ */
  function tabPayroll(host, params) {
    const runs = payruns();
    const now = DB.helpers.today();
    const defPeriod = (params && params.period) || (runs[0] && runs[0].period) || `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
    // run list + period picker
    host.appendChild(h("div", { class: "toolbar", style: "gap:10px" }, [
      h("div", { class: "field", style: "margin:0" }, [h("label", { text: "Pay Period" }), h("div", {}, h("input", { class: "input", type: "month", id: "pr_period", value: defPeriod, style: "max-width:170px" }))]),
      h("button", { class: "btn primary", onclick: () => runPayrollFlow(UI.$("#pr_period").value), html: "▶ Run / Refresh" }),
    ]));
    if (!runs.length) { host.appendChild(h("div", { class: "empty", style: "margin-top:30px" }, [h("div", { class: "big", text: "💰" }), h("div", { style: "font-weight:700", text: "No pay runs yet" }), h("div", { class: "muted", style: "margin-top:6px", text: "Pick a month and click Run to generate payslips from attendance." })])); return; }
    // runs strip
    host.appendChild(h("div", { class: "flex gap wrap", style: "margin-bottom:14px" }, runs.map((r) => h("button", { class: "chip", style: "cursor:pointer;padding:8px 12px;border:1.5px solid " + (r.period === defPeriod ? "var(--accent)" : "var(--line)"), onclick: () => App.go("hr-payroll", { period: r.period }) }, [
      h("span", { html: `<b>${r.period}</b> · ${badge(r.status === "Finalized" ? "ok" : "warn", r.status)} · net ${money((r.totals || {}).net || 0)}` })]))));
    const run = runs.find((r) => r.period === defPeriod) || runs[0];
    const slips = payslips().filter((s) => s.payrunId === run.id);
    const tot = (run.totals || {});
    host.appendChild(h("div", { class: "grid kpi-grid", style: "margin-bottom:14px" }, [
      kpi({ icon: "👷", label: "Workers Paid", value: num(slips.length) }),
      kpi({ icon: "💵", label: "Gross", value: money(tot.gross || 0) }),
      kpi({ icon: "🏦", label: "Deductions", value: money((tot.pf || 0) + (tot.esi || 0) + (tot.pt || 0)) }),
      kpi({ icon: "💰", label: "Net Payout", value: money(tot.net || 0) }),
    ]));
    host.appendChild(h("div", { class: "flex gap", style: "margin-bottom:12px;justify-content:flex-end" }, [
      h("button", { class: "btn danger", onclick: () => delRun(run), text: "🗑 Delete Run" }),
      run.status !== "Finalized" ? h("button", { class: "btn primary", onclick: () => finalizeRun(run), text: "🔒 Finalize" }) : h("span", { class: "chip", html: badge("ok", "Finalized " + (run.generatedAt || "").slice(0, 10)) }),
    ]));
    host.appendChild(table(slips, [
      { key: "worker", label: "Worker", render: (r) => `<div class="cell-main">${esc(r.name)}</div><div class="cell-sub">${cap(r.dept || "")}</div>`, sort: (r) => r.name },
      { key: "present", label: "Days", num: true, render: (r) => num(r.payableDays, 1), sort: (r) => r.payableDays },
      { key: "ot", label: "OT h", num: true, render: (r) => r.otHours ? num(r.otHours, 1) : "—", sort: (r) => r.otHours },
      { key: "gross", label: "Gross", num: true, render: (r) => money(r.gross), sort: (r) => r.gross },
      { key: "pf", label: "PF", num: true, render: (r) => r.deductions.pf ? money(r.deductions.pf) : "—", sort: (r) => r.deductions.pf },
      { key: "esi", label: "ESI", num: true, render: (r) => r.deductions.esi ? money(r.deductions.esi) : "—", sort: (r) => r.deductions.esi },
      { key: "pt", label: "PT", num: true, render: (r) => r.deductions.pt ? money(r.deductions.pt) : "—", sort: (r) => r.deductions.pt },
      { key: "adv", label: "Advance", num: true, render: (r) => r.advances ? money(r.advances) : "—", sort: (r) => r.advances },
      { key: "net", label: "Net Pay", num: true, render: (r) => `<span class="strong">${money(r.net)}</span>`, sort: (r) => r.net },
    ], { onRow: (r) => payslipDetail(r, run), empty: "No payslips" }));
  }
  async function runPayrollFlow(period) {
    period = period || (UI.$("#pr_period") && UI.$("#pr_period").value);
    if (!period) { const now = DB.helpers.today(); period = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`; }
    try {
      await DB.hr.payroll.run(period, { force: true });
      toast("Payroll generated for " + period, { type: "ok", title: "Payroll" });
      await App.reloadState();
      App.go("hr-payroll", { period });
    } catch (e) { toast(e.message || "Payroll failed", { type: "danger" }); }
  }
  async function finalizeRun(run) { if (!await confirm(`Finalize payroll ${run.period}? Payslips will be locked (no further edits).`, { title: "Finalize Payroll" })) return; save(() => DB.hr.payroll.finalize(run.id), "payroll"); }
  async function delRun(run) { if (!await confirm(`Delete payroll run ${run.period} and all its payslips?`, { title: "Delete Pay Run", danger: true })) return; save(() => DB.hr.payroll.remove(run.id), "payroll"); }
  function payslipDetail(s, run) {
    const d = s.deductions || {};
    const body = h("div", {}, [
      MW.dl([
        ["Worker", s.name + " (" + s.workerId + ")"], ["Department", cap(s.dept || "—")], ["Pay Period", run.period],
        ["Payable Days", num(s.payableDays, 1) + " (present " + num(s.present, 1) + (s.paidLeave ? " + leave " + s.paidLeave : "") + ")"],
        ["OT Hours", num(s.otHours, 1) + " h" + (s.otPay ? " → " + money(s.otPay) : "")],
        ["Daily Rate", money(s.dailyRate)], ["Basic Earned", money(s.basicEarned)],
        ["Gross", money(s.gross)],
        ["— PF", money(d.pf || 0)], ["— ESI", money(d.esi || 0)], ["— Professional Tax", money(d.pt || 0)],
        ["— Advance", money(s.advances || 0)], ["Net Pay", money(s.net)],
        ["Employer PF", money((s.employer || {}).pf || 0)], ["Employer ESI", money((s.employer || {}).esi || 0)],
      ]),
    ]);
    const foot = [];
    if (run.status !== "Finalized") foot.push(h("button", { class: "btn ghost", onclick: () => editAdvance(s), text: "✎ Set Advance" }));
    foot.push(h("button", { class: "btn primary", onclick: () => window.print(), text: "🖨 Print" }));
    modal({ title: "Payslip — " + s.name, sub: run.period + " · " + run.id, wide: true, body, foot });
  }
  function editAdvance(s) {
    const body = h("div", { class: "form-grid" }, [U.field("Advance / Manual Deduction (₹)", `<input class="input" id="ps_adv" type="number" value="${s.advances || 0}">`)]);
    const mo = modal({ title: "Adjust Advance", sub: s.name, body,
      foot: [h("button", { class: "btn ghost", onclick: () => mo.close(), text: "Cancel" }),
        h("button", { class: "btn primary", onclick: () => { const adv = +UI.$("#ps_adv").value || 0; mo.close(); UI.$("#modalHost").hidden = true; save(() => DB.hr.payslip.update(s.id, { advances: adv }), "payroll"); }, text: "Save" })] });
  }

  /* ============================================================
     SETTINGS — config + leave types
     ============================================================ */
  function tabSettings(host) {
    const box = h("div", {}, h("div", { class: "muted", text: "Loading configuration…" }));
    host.appendChild(box);
    DB.hr.config.get().then((cfg) => renderSettings(box, cfg)).catch((e) => { box.innerHTML = ""; box.appendChild(h("div", { class: "muted", text: "Could not load config: " + e.message })); });
  }
  function renderSettings(box, cfg) {
    const d = cfg.deductions || {};
    const pt = (d.pt && d.pt.slabs) || [{ upTo: 24999, amt: 0 }, { upTo: 999999999, amt: 200 }];
    const ptThreshold = (pt[0] && pt[0].upTo) || 24999;
    const ptAmount = (pt[pt.length - 1] && pt[pt.length - 1].amt) || 0;
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    box.innerHTML = "";
    const grid = h("div", { class: "grid cols-2" });

    // attendance / OT rules
    grid.appendChild(h("div", { class: "card" }, [
      h("div", { class: "card-head" }, h("h3", { text: "🕒 Attendance & Overtime" })),
      h("div", { class: "form-grid" }, [
        U.field("Standard Day Hours", `<input class="input" id="c_std" type="number" step="0.5" value="${cfg.standardDayHours}">`),
        U.field("OT Multiplier", `<input class="input" id="c_otm" type="number" step="0.5" value="${cfg.otMultiplier}">`),
        U.field("Half-day below (hrs)", `<input class="input" id="c_half" type="number" step="0.5" value="${cfg.halfDayBelowHours}">`),
      ]),
      h("div", { style: "margin-top:8px" }, [h("label", { class: "muted", style: "font-size:11px;font-weight:700;text-transform:uppercase", text: "Weekly Off" }),
        h("div", { class: "flex gap wrap", style: "margin-top:6px" }, days.map((dn, i) => h("label", { class: "chip", style: "cursor:pointer" }, [
          h("input", { type: "checkbox", id: "c_wo_" + i, checked: (cfg.weekOff || []).includes(i) ? "checked" : null }), " " + dn])))]),
    ]));

    // deductions
    grid.appendChild(h("div", { class: "card" }, [
      h("div", { class: "card-head" }, [h("h3", { text: "🏦 Statutory Deductions" }), h("div", { class: "sub", text: "Toggle each on/off and set the rate" })]),
      dedRow("PF (Provident Fund)", "pf", [["Rate %", "c_pf_rate", (d.pf || {}).rate], ["Wage Cap ₹/mo", "c_pf_cap", (d.pf || {}).wageCapMonthly], ["Employer %", "c_pf_emp", (d.pf || {}).employerRate]], (d.pf || {}).on),
      dedRow("ESI (State Insurance)", "esi", [["Employee %", "c_esi_rate", (d.esi || {}).empRate], ["Employer %", "c_esi_emp", (d.esi || {}).employerRate], ["Gross ≤ ₹", "c_esi_th", (d.esi || {}).grossThreshold]], (d.esi || {}).on),
      dedRow("Professional Tax (Karnataka)", "pt", [["Nil up to ₹", "c_pt_th", ptThreshold], ["Amount above ₹", "c_pt_amt", ptAmount]], (d.pt || {}).on),
    ]));
    box.appendChild(grid);

    // biometric device
    box.appendChild(h("div", { class: "card", style: "margin-top:16px" }, [
      h("div", { class: "card-head" }, [h("h3", { text: "🔌 Biometric Device" }), h("div", { class: "sub", text: "Point your eSSL/ZKTeco/Matrix device's push URL here" })]),
      h("div", { class: "form-grid" }, [
        U.field("Push URL (configure on device)", `<input class="input" value="${esc(location.origin)}/api/hr/punch" readonly onclick="this.select()">`, "full"),
        U.field("Device Key (x-device-key header)", `<input class="input" id="c_devkey" value="${esc(cfg.deviceKey || "")}" placeholder="Set a secret; the device sends it to authenticate">`),
      ]),
      h("p", { class: "dim", style: "font-size:12px;line-height:1.6;margin-top:8px", html: "The device POSTs each punch as JSON <span class='mono'>{ deviceUid, ts, direction }</span> to the URL above. Set a Device Key here and configure the same key on the device (or via the <span class='mono'>CHHAPERIA_DEVICE_KEY</span> env var). The server matches the punch to a worker by their Biometric Device ID and updates the daily muster automatically — 24/7." }),
    ]));

    // save config
    box.appendChild(h("div", { class: "flex", style: "justify-content:flex-end;margin-top:14px" },
      h("button", { class: "btn primary", onclick: saveCfg, text: "💾 Save Configuration" })));

    // leave types
    const lts = leaveTypes();
    box.appendChild(h("div", { class: "card", style: "margin-top:20px" }, [
      h("div", { class: "card-head" }, [h("h3", { text: "🗂 Leave Types" }), h("div", { class: "sub", text: "Define entitlements & accrual — used by the Leave tab" })]),
      table(lts, [
        { key: "id", label: "Code", render: (r) => `<span class="mono strong">${r.id}</span>`, noSort: true },
        { key: "name", label: "Name", render: (r) => esc(r.name), noSort: true },
        { key: "quota", label: "Annual Quota", num: true, render: (r) => r.accrual === "earned" ? "earned 1/20" : num(r.quota, 1) + " days", noSort: true },
        { key: "accrual", label: "Accrual", render: (r) => badge("mut", r.accrual), noSort: true },
        { key: "paid", label: "Paid", render: (r) => r.paid ? badge("ok", "Paid") : badge("mut", "Unpaid"), noSort: true },
        { key: "act", label: "", noSort: true, render: (r) => h("button", { class: "btn sm ghost", onclick: (e) => { e.stopPropagation(); delLeaveType(r); }, text: "🗑" }) },
      ], { onRow: (r) => leaveTypeForm(r), empty: "No leave types — add one with ＋ Leave Type" }),
    ]));

    function dedRow(label, key, fields, on) {
      return h("div", { style: "padding:10px 0;border-bottom:1px solid var(--line)" }, [
        h("label", { class: "flex aic gap", style: "cursor:pointer;margin-bottom:8px" }, [
          h("input", { type: "checkbox", id: "c_" + key + "_on", checked: on ? "checked" : null }),
          h("b", { text: label })]),
        h("div", { class: "flex gap wrap" }, fields.map(([lb, id, val]) => h("div", { style: "flex:1;min-width:120px" }, [
          h("label", { class: "muted", style: "font-size:11px", text: lb }),
          h("input", { class: "input", id, type: "number", step: "0.01", value: val != null ? val : 0 })]))),
      ]);
    }
    function gv(id) { const el = UI.$("#" + id); return el ? el.value : ""; }
    function ck(id) { const el = UI.$("#" + id); return !!(el && el.checked); }
    function saveCfg() {
      const weekOff = []; for (let i = 0; i < 7; i++) if (ck("c_wo_" + i)) weekOff.push(i);
      const patch = {
        standardDayHours: +gv("c_std") || 8, otMultiplier: +gv("c_otm") || 2, halfDayBelowHours: +gv("c_half") || 4,
        weekOff, deviceKey: gv("c_devkey").trim(),
        deductions: {
          pf: { on: ck("c_pf_on"), rate: +gv("c_pf_rate") || 0, wageCapMonthly: +gv("c_pf_cap") || 0, employerRate: +gv("c_pf_emp") || 0 },
          esi: { on: ck("c_esi_on"), empRate: +gv("c_esi_rate") || 0, employerRate: +gv("c_esi_emp") || 0, grossThreshold: +gv("c_esi_th") || 0 },
          pt: { on: ck("c_pt_on"), slabs: [{ upTo: +gv("c_pt_th") || 0, amt: 0 }, { upTo: 999999999, amt: +gv("c_pt_amt") || 0 }] },
        },
      };
      save(() => DB.hr.config.set(patch).then(() => toast("HR configuration saved", { type: "ok" })), "settings");
    }
  }
  function leaveTypeForm(t) {
    const edit = !!t; t = t || { accrual: "fixed", paid: true };
    const body = h("div", { class: "form-grid" }, [
      U.field("Code", `<input class="input" id="lt_id" value="${esc(t.id || "")}" ${edit ? "disabled" : ""} placeholder="e.g. EL / CL / SL">`),
      U.field("Name", `<input class="input" id="lt_name" value="${esc(t.name || "")}" placeholder="e.g. Earned Leave">`),
      U.field("Annual Quota (days)", `<input class="input" id="lt_quota" type="number" step="0.5" value="${t.quota || 0}">`),
      U.field("Accrual", U.selectHTML("lt_accrual", [{ v: "fixed", l: "Fixed (credited yearly)" }, { v: "earned", l: "Earned (1 per 20 worked)" }, { v: "none", l: "None (0 balance)" }], t.accrual || "fixed")),
      U.field("Paid?", U.selectHTML("lt_paid", [{ v: "1", l: "Paid leave" }, { v: "0", l: "Unpaid" }], t.paid === false ? "0" : "1")),
    ]);
    const mo = modal({ title: edit ? "Edit Leave Type" : "New Leave Type", body,
      foot: [h("button", { class: "btn ghost", onclick: () => mo.close(), text: "Cancel" }),
        h("button", { class: "btn primary", onclick: () => { const id = (UI.$("#lt_id").value || "").trim().toUpperCase(); if (!id) { toast("Code required", { type: "warn" }); return; } const p = { id, name: UI.$("#lt_name").value.trim() || id, quota: +UI.$("#lt_quota").value || 0, accrual: UI.$("#lt_accrual").value, paid: UI.$("#lt_paid").value === "1" }; mo.close(); save(() => DB.hr.leaveType.save(p), "settings"); }, text: edit ? "Save" : "Create" })] });
  }
  async function delLeaveType(t) { if (!await confirm(`Delete leave type ${t.name}? Existing leave records keep their type code.`, { title: "Delete Leave Type", danger: true })) return; save(() => DB.hr.leaveType.remove(t.id), "settings"); }

  /* ---- helpers ---- */
  function cap(s) { s = String(s || ""); return s ? s[0].toUpperCase() + s.slice(1) : s; }
  function ltName(id) { const t = leaveTypes().find((x) => x.id === id); return t ? t.name : id; }

  // ⌘K quick actions
  window.ERPActions = Object.assign(window.ERPActions || {}, {
    hrWorker:  { ic: "👷", label: "HR: Workers",     run: () => App.go("hr-workers") },
    hrLeave:   { ic: "🌴", label: "HR: Apply Leave", run: () => App.go("hr-leave") },
    hrPayroll: { ic: "💰", label: "HR: Run Payroll", run: () => App.go("hr-payroll") },
  });
})();
