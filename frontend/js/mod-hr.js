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
  // what the payroll tab is currently showing, so the header's print-all
  // button knows which run to print
  let payrollCtx = { run: null, slips: [] };
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
    // Workers + Attendance carry an Excel ▾ (bulk load from a spreadsheet)
    if (curTab === "workers") return [MW.excelMenu("hrworkers"),
      h("button", { class: "btn primary", onclick: () => workerForm(), html: "＋ New Worker" })];
    if (curTab === "attendance") return [MW.excelMenu("hrattendance")];
    if (curTab === "leave") return [h("button", { class: "btn primary", onclick: () => leaveForm(), html: "＋ Apply Leave" })];
    if (curTab === "payroll") return [
      h("button", { class: "btn", title: "Print every payslip of this run — two to an A4 sheet",
        onclick: () => printPayslips(payrollCtx.slips || [], payrollCtx.run),
        html: "🖨 Print All Payslips" }),
      h("button", { class: "btn primary", onclick: () => runPayrollFlow(), html: "▶ Run Payroll" })];
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
      // widths kept tight so a full 31-day month fits a laptop card without scrolling
      const head = h("tr", {}, [h("th", { style: "position:sticky;left:0;background:var(--panel);min-width:136px", text: "Worker" })]);
      for (let d = 1; d <= days; d++) { const wd = new Date(y, m - 1, d).getDay();
        head.appendChild(h("th", { style: "padding:4px 1px;font-size:10px;" + (wd === 0 ? "color:var(--danger)" : ""), text: d })); }
      head.appendChild(h("th", { style: "min-width:46px;padding:10px 4px", text: "P" }));
      head.appendChild(h("th", { style: "min-width:46px;padding:10px 4px", text: "OT" }));
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
        tr.appendChild(h("td", { class: "nm", style: "position:sticky;left:0;background:var(--panel);font-weight:600;font-size:12px;min-width:136px", text: U.trim(w.name, 20) }));
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
          tr.appendChild(h("td", { style: "text-align:center;padding:2px 1px;cursor:pointer", title, onclick: () => dayEntry(w, ds, a) },
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
    payrollCtx = { run, slips };
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
      // the instalment, with what is still owed after it
      { key: "adv", label: "Advance", num: true, sort: (r) => r.advances,
        render: (r) => r.advances
          ? money(r.advances) + (r.advance && r.advance.closing ? `<div class="cell-sub">${esc(money(r.advance.closing))} left</div>` : "")
          : "—" },
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

  /* ============================================================
     PAYSLIP — printed sheet
     Same masthead as the tax invoice (logo, company block, GSTIN strip), the
     worker's name in bold, and the money in proper tables instead of a boxed
     list. The sheet follows the standard Indian salary-slip layout and takes
     exactly HALF an A4 each, so two print per sheet and a whole finalised run
     comes out in one go.
     ============================================================ */
  function payCompany() {
    const cos = ((ENG.data.org || {}).companies) || [];
    return cos[0] || { name: (ENG.data.org || {}).name || "Chhaperia", address: "", gstin: "" };
  }
  const IN2 = (n) => (+n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const RS = (n) => "₹" + IN2(n);
  /* days read as "26" or "25.5" — a whole number never carries a ".0" */
  const days = (n) => (Math.abs((+n || 0) % 1) < 0.05 ? String(Math.round(+n || 0)) : num(n, 1));
  const MONTHS = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  /* "2026-05" -> "May 2026" */
  function periodLabel(p) {
    const m = /^(\d{4})-(\d{2})$/.exec(String(p || ""));
    return m ? MONTHS[+m[2] - 1] + " " + m[1] : String(p || "—");
  }
  /* "2026-05-29" -> "29/05/2026" */
  function dmy(d) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || ""));
    return m ? m[3] + "/" + m[2] + "/" + m[1] : "—";
  }
  /* The Indian financial year a period belongs to: April → March. */
  function fyStart(period) {
    const m = /^(\d{4})-(\d{2})$/.exec(String(period || ""));
    if (!m) return "0000-00";
    return (+m[2] >= 4 ? +m[1] : +m[1] - 1) + "-04";
  }
  /* Year-to-date: the same component summed across this worker's payslips
     from the start of the financial year up to and including this period.
     One pay run per period, so nothing is counted twice. */
  function ytdFor(s, run) {
    const from = fyStart(run.period), to = run.period;
    const periodOf = {};
    payruns().forEach((r) => { periodOf[r.id] = r.period; });
    const mine = payslips().filter((p) => {
      if (p.workerId !== s.workerId) return false;
      const per = periodOf[p.payrunId];
      return per && per >= from && per <= to;
    });
    // the slip being printed may be fresher than the copy in state
    const rows = mine.some((p) => p.id === s.id) ? mine.map((p) => (p.id === s.id ? s : p)) : mine.concat([s]);
    const sum = (f) => rows.reduce((n, p) => n + (+f(p) || 0), 0);
    return {
      basic: sum((p) => p.basicEarned), ot: sum((p) => p.otPay), allow: sum((p) => p.allowances),
      gross: sum((p) => p.gross), net: sum((p) => p.net),
      pf: sum((p) => (p.deductions || {}).pf), esi: sum((p) => (p.deductions || {}).esi),
      pt: sum((p) => (p.deductions || {}).pt), adv: sum((p) => p.advances),
    };
  }

  /* PAID LEAVE STILL PENDING — what the worker may still take this calendar
     year. Mirrors hrService.leaveBalances: an "earned" type accrues one day
     per 20 days actually worked, "none" grants nothing, everything else uses
     its quota; approved leave of that type in the same year is taken off.
     UNPAID types are ignored — the slip is about paid entitlement. */
  function paidLeavePending(workerId, period) {
    const year = String(period || "").slice(0, 4) || String(new Date().getFullYear());
    const worked = (ENG.data.hrAttendance || []).filter((a) => a.workerId === workerId
      && String(a.date || "").startsWith(year) && (a.status === "P" || a.status === "HD"))
      .reduce((n, a) => n + (a.status === "HD" ? 0.5 : 1), 0);
    const rows = [];
    leaveTypes().forEach((t) => {
      if (t.paid === false) return;
      const entitled = t.accrual === "earned" ? Math.floor(worked / 20)
        : (t.accrual === "none" ? 0 : (+t.quota || 0));
      const taken = (ENG.data.hrLeaves || []).filter((l) => l.workerId === workerId
        && l.type === t.id && l.status === "Approved" && String(l.fromDate || "").startsWith(year))
        .reduce((n, l) => n + (+l.days || 0), 0);
      if (entitled <= 0 && taken <= 0) return;
      rows.push({ name: t.name, entitled, taken, balance: Math.round((entitled - taken) * 10) / 10 });
    });
    const total = rows.reduce((n, r) => n + r.balance, 0);
    return { rows, total: Math.round(total * 10) / 10, year };
  }

  function payslipSheet(s, run) {
    const d = s.deductions || {}, emp = s.employer || {};
    const co = payCompany();
    const w = wById(s.workerId) || {};
    const y = ytdFor(s, run);
    const dedTotal = (d.pf || 0) + (d.esi || 0) + (d.pt || 0) + (s.advances || 0);
    // LOP = days not paid for: absences and any unpaid leave
    const lop = (s.absent || 0) + (s.unpaidLeave || 0);
    const pl = paidLeavePending(s.workerId, run.period);

    /* [label, this month, year to date, optional note] */
    const earn = [
      ["Basic", s.basicEarned, y.basic, days(s.payableDays) + " days × " + money(s.dailyRate)],
      s.otPay ? ["Overtime", s.otPay, y.ot, days(s.otHours) + " h × " + money(s.hourly || 0)] : null,
      s.allowances ? ["Allowances", s.allowances, y.allow, ""] : null,
    ].filter(Boolean);
    const ded = [
      d.pf ? ["EPF Contribution", d.pf, y.pf, ""] : null,
      d.esi ? ["ESI Contribution", d.esi, y.esi, ""] : null,
      d.pt ? ["Professional Tax", d.pt, y.pt, ""] : null,
      // an advance shows what it is recovering against, so the worker can see
      // the balance come down month by month
      s.advances ? ["Advance Recovery", s.advances, y.adv, advNote(s)] : null,
    ].filter(Boolean);
    const rowsOf = (list) => (list.length ? list : [["—", 0, 0, ""]])
      .map(([l, v, ytd, note]) => `<tr><td class="lbl">${esc(l)}${note ? `<div class="n">${esc(note)}</div>` : ""}</td>` +
        `<td class="amt">${RS(v)}</td><td class="ytd">${RS(ytd)}</td></tr>`).join("");
    // both halves share a row grid so their Gross / Total lines sit level
    const padTo = Math.max(earn.length, ded.length);
    const pad = (list) => `<tr class="pad"><td colspan="3">&nbsp;</td></tr>`.repeat(Math.max(0, padTo - (list.length || 1)));

    return `<section class="slip">
      <header class="ps-top">
        <div class="ps-org">
          <img class="ps-logo" src="${location.origin}/assets/logo-invoice.png" alt="${esc(co.name)}">
          <div>
            <div class="ps-conm">${esc(co.name)}</div>
            <div class="ps-coad">${esc(co.address || "")}</div>
          </div>
        </div>
        <div class="ps-for">
          <div class="ps-for-l">Payslip For the Month</div>
          <div class="ps-for-m">${esc(periodLabel(run.period))}</div>
        </div>
      </header>
      <div class="ps-rule"></div>

      <div class="ps-sum">
        <div class="ps-sum-l">
          <div class="ps-sec">EMPLOYEE SUMMARY</div>
          <table class="ps-kv"><tbody>
            <tr><td>Employee Name</td><td class="c">:</td><td class="v nm">${esc(s.name)}</td></tr>
            <tr><td>Designation</td><td class="c">:</td><td class="v">${esc(w.designation || cap(s.dept || "—"))}</td></tr>
            <tr><td>Employee ID</td><td class="c">:</td><td class="v">${esc(s.workerId)}</td></tr>
            <tr><td>Date of Joining</td><td class="c">:</td><td class="v">${esc(dmy(w.joined))}</td></tr>
            <tr><td>Pay Period</td><td class="c">:</td><td class="v">${esc(periodLabel(run.period))}</td></tr>
            <tr><td>Pay Date</td><td class="c">:</td><td class="v">${esc(dmy((run.generatedAt || "").slice(0, 10)))}</td></tr>
          </tbody></table>
        </div>
        <aside class="ps-netcard">
          <div class="ps-netcard-top">
            <div class="ps-netbar"></div>
            <div>
              <div class="ps-netamt">${RS(s.net)}</div>
              <div class="ps-netlbl">Employee Net Pay</div>
            </div>
          </div>
          <div class="ps-netcard-foot">
            <div><span>Paid Days</span><i>:</i><b>${days(s.payableDays)}</b></div>
            <div><span>LOP Days</span><i>:</i><b>${days(lop)}</b></div>
            <div><span>Paid Leave Taken</span><i>:</i><b>${days(s.paidLeave || 0)}</b></div>
          </div>
        </aside>
      </div>

      <div class="ps-ids">
        <div><span>PF A/C Number</span><i>:</i><b>${esc(w.pfNo || "—")}</b></div>
        <div><span>UAN</span><i>:</i><b>${esc(w.uan || "—")}</b></div>
        <div class="ps-leave"><span>Paid Leave Pending (${esc(pl.year)})</span><i>:</i><b>${days(pl.total)} ${pl.total === 1 ? "day" : "days"}</b>${
          pl.rows.length ? `<em>${esc(pl.rows.map((r) => r.name + " " + days(r.balance)).join(" · "))}</em>` : ""}</div>
      </div>

      <div class="ps-money">
        <table class="ps-half">
          <thead><tr><th class="lbl">EARNINGS</th><th class="amt">AMOUNT</th><th class="ytd">YTD</th></tr></thead>
          <tbody>${rowsOf(earn)}${pad(earn)}</tbody>
          <tfoot><tr><td class="lbl">Gross Earnings</td><td class="amt">${RS(s.gross)}</td><td class="ytd"></td></tr></tfoot>
        </table>
        <table class="ps-half">
          <thead><tr><th class="lbl">DEDUCTIONS</th><th class="amt">AMOUNT</th><th class="ytd">YTD</th></tr></thead>
          <tbody>${rowsOf(ded)}${pad(ded)}</tbody>
          <tfoot><tr><td class="lbl">Total Deductions</td><td class="amt">${RS(dedTotal)}</td><td class="ytd"></td></tr></tfoot>
        </table>
      </div>

      <div class="ps-payable">
        <div>
          <div class="ps-payable-t">TOTAL NET PAYABLE</div>
          <div class="ps-payable-s">Gross Earnings - Total Deductions</div>
        </div>
        <div class="ps-payable-v">${RS(s.net)}</div>
      </div>

      <div class="ps-words"><span>Amount In Words :</span> ${esc(GST.amountInWords(Math.round(s.net || 0)))}</div>

      <div class="ps-sign">
        <div class="ps-sign-l">
          <div class="ps-sign-emp">Employer contribution — PF ${money(emp.pf || 0)} · ESI ${money(emp.esi || 0)}</div>
          <div class="ps-sign-note">Please report any discrepancy within 7 days of receiving this slip.</div>
        </div>
        <div class="ps-sign-r">
          <div class="ps-seal">Seal</div>
          <div class="ps-sign-box">
            <div class="ps-sign-for">For <b>${esc(co.name)}</b></div>
            <div class="ps-sign-space"></div>
            <div class="ps-sign-lbl">Authorised Signatory</div>
          </div>
        </div>
      </div>
    </section>`;
  }

  function payslipDocHtml(list, run) {
    const co = payCompany();
    const sheets = list.map((s) => payslipSheet(s, run)).join("");
    return `<!doctype html><html><head><meta charset="utf-8"><title>Payslip ${esc(run.period)}${list.length > 1 ? " — " + list.length + " workers" : " — " + esc(list[0].name)}</title>
<style>
  /* ---- The payslip follows the standard Indian salary-slip layout: company
     masthead under a brand rule, EMPLOYEE SUMMARY beside a net-pay card, a
     strip carrying PF / UAN and the PAID LEAVE still pending, then EARNINGS
     and DEDUCTIONS side by side with an AMOUNT and a YTD column, the TOTAL
     NET PAYABLE bar, the amount in words, and a signature block that leaves
     real space for a signature and the company seal.
     Each slip is HALF an A4, so two print per sheet. ---- */
  *{margin:0;padding:0;box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  body{font:10px/1.32 "Segoe UI",Arial,sans-serif;color:#2b2f33;background:#eceff1}
  /* one payslip = HALF an A4, so two print per sheet */
  .slip{width:210mm;height:148.5mm;background:#fff;padding:5mm 9mm 4mm;margin:0 auto;overflow:hidden;
    display:flex;flex-direction:column;border-bottom:1px dashed #b9c0c7}

  /* masthead — the company sits under its own brand rule */
  .ps-top{display:flex;justify-content:space-between;align-items:center;gap:16px;padding-bottom:4px}
  .ps-org{display:flex;align-items:center;gap:10px;min-width:0}
  .ps-logo{height:40px;width:auto;max-width:150px;object-fit:contain;object-position:left center}
  .ps-conm{font-size:13.5px;font-weight:800;color:#12151a;line-height:1.2;letter-spacing:-.15px}
  .ps-coad{font-size:9px;color:#6b7177;margin-top:1px;line-height:1.3}
  .ps-for{text-align:right;flex:0 0 auto}
  .ps-for-l{font-size:8px;font-weight:700;letter-spacing:.75px;text-transform:uppercase;color:#9aa1a8}
  .ps-for-m{font-size:13px;font-weight:800;color:#12151a;margin-top:2px;letter-spacing:-.1px}
  /* a thin brand rule carries the eye across the whole sheet */
  .ps-rule{height:2px;border-radius:2px;background:linear-gradient(90deg,#F06820 0 34%,#1f2937 34% 100%)}

  /* employee summary + net pay card */
  .ps-sum{display:flex;gap:16px;align-items:stretch;padding:8px 0 7px}
  .ps-sum-l{flex:1.25;min-width:0}
  .ps-sec{font-size:8px;font-weight:800;letter-spacing:.9px;color:#9aa1a8;margin-bottom:5px;
    text-transform:uppercase}
  table.ps-kv{border-collapse:collapse;width:100%}
  table.ps-kv td{padding:1.4px 0;font-size:9.5px;vertical-align:top;line-height:1.3}
  table.ps-kv td:first-child{color:#6b7177;width:44%}
  table.ps-kv td.c{width:11px;color:#9aa1a8;text-align:center}
  table.ps-kv td.v{color:#1a1c1e;font-weight:600}
  table.ps-kv td.v.nm{font-weight:800;font-size:10.5px}
  .ps-netcard{flex:1;border:1px solid #d7ede0;border-radius:9px;overflow:hidden;align-self:stretch;
    display:flex;flex-direction:column}
  .ps-netcard-top{display:flex;align-items:center;gap:10px;background:#f2faf5;padding:9px 12px}
  .ps-netbar{flex:0 0 3px;align-self:stretch;min-height:28px;background:#38a169;border-radius:3px}
  .ps-netamt{font-size:17px;font-weight:800;color:#12151a;line-height:1.1;letter-spacing:-.3px}
  .ps-netlbl{font-size:8px;color:#38a169;font-weight:800;margin-top:2px;
    letter-spacing:.7px;text-transform:uppercase}
  .ps-netcard-foot{padding:5px 12px 6px;border-top:1px dashed #d7ede0;margin-top:auto}
  .ps-netcard-foot div{display:flex;font-size:9.5px;padding:1px 0}
  .ps-netcard-foot span{color:#6b7177;flex:0 0 52%}
  .ps-netcard-foot i{font-style:normal;color:#9aa1a8;flex:0 0 11px;text-align:center}
  .ps-netcard-foot b{color:#12151a;font-weight:700}

  /* PF / UAN / leave strip */
  .ps-ids{display:flex;flex-wrap:wrap;gap:5px 24px;padding:6px 11px;font-size:9.5px;
    background:#f7f8f9;border:1px solid #eceff1;border-radius:8px}
  .ps-ids>div{display:flex;align-items:baseline;min-width:0}
  .ps-ids span{color:#6b7177}
  .ps-ids i{font-style:normal;color:#9aa1a8;padding:0 6px}
  .ps-ids b{color:#12151a;font-weight:700;overflow-wrap:anywhere}
  /* the leave balance takes the rest of the row so its breakdown has room */
  .ps-ids .ps-leave{margin-left:auto}
  .ps-ids .ps-leave b{color:#0f766e}
  .ps-ids .ps-leave em{font-style:normal;color:#8b9096;font-size:8.5px;padding-left:7px}

  /* earnings + deductions */
  .ps-money{display:flex;border:1px solid #dfe3e6;border-radius:9px;overflow:hidden;margin-top:6px}
  table.ps-half{flex:1;width:50%;border-collapse:collapse}
  table.ps-half+table.ps-half{border-left:1px solid #e3e6e9}
  table.ps-half th{font-size:8px;font-weight:800;letter-spacing:.8px;color:#4b5158;
    padding:6px 10px 5px;text-align:left;background:#f7f8f9;border-bottom:1px solid #e3e6e9}
  table.ps-half td{padding:3.6px 10px;font-size:9.5px;vertical-align:top}
  /* zebra rows make a long list readable across the fold */
  table.ps-half tbody tr:nth-child(even) td{background:#fafbfc}
  table.ps-half th.amt,table.ps-half td.amt{text-align:right;white-space:nowrap}
  table.ps-half th.ytd,table.ps-half td.ytd{text-align:right;white-space:nowrap;width:26%}
  table.ps-half td.amt{font-weight:700;color:#12151a}
  table.ps-half td.ytd{color:#8b9096}
  table.ps-half td.lbl{color:#2b2f33}
  table.ps-half tr.pad td{padding:3.6px 10px}
  td .n{font-size:8px;color:#8b9096;margin-top:1px;line-height:1.25}
  table.ps-half tfoot td{background:#f1f3f5;font-weight:800;color:#12151a;font-size:9.5px;
    padding:5px 10px;border-top:1px solid #e3e6e9}

  /* total net payable — the anchor of the sheet */
  .ps-payable{display:flex;justify-content:space-between;align-items:stretch;
    border-radius:9px;margin-top:6px;overflow:hidden;background:#1f2937}
  .ps-payable>div:first-child{padding:6px 13px}
  .ps-payable-t{font-size:9.5px;font-weight:800;color:#fff;letter-spacing:.6px}
  .ps-payable-s{font-size:8.5px;color:#9aa5b1;margin-top:1px}
  .ps-payable-v{background:#38a169;display:flex;align-items:center;padding:6px 18px;
    font-size:14px;font-weight:800;color:#fff;white-space:nowrap;letter-spacing:-.2px}

  .ps-words{text-align:right;font-size:9.5px;color:#12151a;margin-top:5px}
  .ps-words span{color:#6b7177}

  /* signature + seal — space is LEFT for a real signature and stamp */
  .ps-sign{margin-top:auto;padding-top:6px;border-top:1px solid #e3e6e9;
    display:flex;justify-content:space-between;align-items:flex-end;gap:16px}
  .ps-sign-l{font-size:8.5px;color:#8b9096;min-width:0}
  .ps-sign-emp{color:#4b5158}
  .ps-sign-note{margin-top:2px}
  .ps-sign-r{display:flex;align-items:flex-end;gap:12px;flex:0 0 auto}
  .ps-seal{width:54px;height:54px;border:1px dashed #c7ced4;border-radius:50%;
    display:flex;align-items:center;justify-content:center;
    font-size:7.5px;letter-spacing:1px;text-transform:uppercase;color:#c0c7cd}
  .ps-sign-box{text-align:center;min-width:150px}
  .ps-sign-for{font-size:9px;color:#4b5158}
  .ps-sign-for b{color:#12151a;font-weight:700}
  .ps-sign-space{height:24px}                       /* room to actually sign */
  .ps-sign-lbl{font-size:8.5px;font-weight:700;color:#12151a;
    border-top:1px solid #9aa1a8;padding-top:3px}
  @media print{
    body{background:#fff}
    .slip{margin:0;border-bottom:none}
    .slip:nth-child(even){page-break-after:always}   /* two payslips per sheet */
    .slip:last-child{page-break-after:auto}
  }
  @page{size:A4 portrait;margin:0}
</style></head><body>${sheets}
<script>window.onload=function(){window.print();}<\/script>
</body></html>`;
  }

  function printPayslips(list, run) {
    if (!list.length) { toast("Nothing to print", { type: "warn" }); return; }
    const w = window.open("", "_blank");
    if (!w) { toast("Popup blocked — allow popups for this site to print", { type: "warn" }); return; }
    w.document.write(payslipDocHtml(list, run)); w.document.close();
  }

  function payslipDetail(s, run) {
    const d = s.deductions || {}, emp = s.employer || {};
    /* same two tables the printed slip carries, so the screen and the paper
       agree — no boxed key/value list */
    const money2 = (v) => "₹ " + (+v || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const moneyTable = (title, rows, totalLabel, total) => {
      const tb = h("table", { class: "tbl pay-tbl" });
      tb.appendChild(h("thead", {}, h("tr", {}, [h("th", { text: title }), h("th", { class: "num", text: "Amount" })])));
      tb.appendChild(h("tbody", {}, (rows.length ? rows : [["—", 0, ""]]).map(([l, v, n2]) =>
        h("tr", {}, [
          h("td", { class: "nm" }, [h("div", { text: l }), n2 ? h("div", { class: "cell-sub", text: n2 }) : null]),
          h("td", { class: "num", text: money2(v) }),
        ]))));
      tb.appendChild(h("tfoot", {}, h("tr", {}, [
        h("td", { class: "nm", html: "<b>" + esc(totalLabel) + "</b>" }),
        h("td", { class: "num", html: "<b>" + esc(money2(total)) + "</b>" })])));
      return tb;
    };
    const dedTotal = (d.pf || 0) + (d.esi || 0) + (d.pt || 0) + (s.advances || 0);
    const body = h("div", {}, [
      h("div", { class: "pay-who" }, [
        h("div", {}, [h("span", { text: "Employee" }), h("b", { class: "nm", text: s.name })]),
        h("div", {}, [h("span", { text: "Code" }), h("b", { text: s.workerId })]),
        h("div", {}, [h("span", { text: "Department" }), h("b", { text: cap(s.dept || "—") })]),
        h("div", {}, [h("span", { text: "Pay period" }), h("b", { text: run.period })]),
        h("div", {}, [h("span", { text: "Days paid" }), h("b", { text: num(s.payableDays, 1) })]),
        h("div", {}, [h("span", { text: "Overtime" }), h("b", { text: s.otHours ? num(s.otHours, 1) + " h" : "—" })]),
      ]),
      h("div", { class: "pay-cols" }, [
        moneyTable("Earnings", [
          ["Basic earned", s.basicEarned, num(s.payableDays, 1) + " days × " + money(s.dailyRate)],
          s.otPay ? ["Overtime", s.otPay, num(s.otHours, 1) + " h × " + money(s.hourly || 0)] : null,
          s.allowances ? ["Allowances", s.allowances, ""] : null,
        ].filter(Boolean), "Gross earnings", s.gross),
        moneyTable("Deductions", [
          d.pf ? ["Provident Fund (PF)", d.pf, ""] : null,
          d.esi ? ["ESI", d.esi, ""] : null,
          d.pt ? ["Professional Tax", d.pt, ""] : null,
          s.advances ? ["Advance recovery", s.advances, advNote(s)] : null,
        ].filter(Boolean), "Total deductions", dedTotal),
      ]),
      h("div", { class: "pay-net" }, [h("span", { text: "NET PAY" }), h("b", { text: money2(s.net) })]),
      h("div", { class: "muted", style: "font-size:11.5px;margin-top:8px" },
        "Employer contribution — PF " + money(emp.pf || 0) + " · ESI " + money(emp.esi || 0)),
    ]);
    const foot = [];
    if (run.status !== "Finalized") foot.push(h("button", { class: "btn ghost", onclick: () => advanceForm(s, run), text: "₹ Advance" }));
    foot.push(h("button", { class: "btn primary", onclick: () => printPayslips([s], run), text: "🖨 Print Payslip" }));
    modal({ title: "Payslip — " + s.name, sub: run.period + " · " + run.id, wide: true, body, foot });
  }

  /* the "3,000 of 20,000 · 17,000 left" line under an advance recovery */
  function advNote(s) {
    const a = s.advance;
    if (!a || !a.total) return "";
    return "of " + money(a.total) + " advance · " + money(a.closing) + " left after this month";
  }

  /* ============================================================
     ADVANCE — money paid to a worker up front and recovered from
     their payslips in fixed monthly instalments. Optional: a worker
     without one simply has no advance line. The form takes the two
     numbers that define it — the amount and the monthly deduction —
     and shows what that means before it is saved.
     ============================================================ */
  async function advanceForm(s, run) {
    let a = null;
    try { a = ((await DB.hr.advance.get(s.workerId)) || {}).advance || null; }
    catch (e) { toast(e.message || "Could not load the advance", { type: "danger" }); return; }

    const body = h("div", {}, [
      h("div", { class: "form-grid" }, [
        U.field("Advance amount (₹)",
          `<input class="input" id="adv_amt" type="number" min="0" step="1" value="${a ? a.amount : ""}" placeholder="e.g. 20000">
           <div class="muted" style="font-size:11px;margin-top:3px">The total paid to the worker.</div>`),
        U.field("Monthly deduction (₹)",
          `<input class="input" id="adv_mon" type="number" min="0" step="1" value="${a ? a.monthly : ""}" placeholder="e.g. 2000">
           <div class="muted" style="font-size:11px;margin-top:3px">Taken off each payslip until it is cleared.</div>`),
        U.field("Start recovering from",
          `<input class="input" id="adv_from" type="month" value="${a && a.startPeriod ? a.startPeriod : (run ? run.period : "")}">`),
        U.field("Note (optional)", `<input class="input" id="adv_note" value="${esc((a && a.note) || "")}" placeholder="reason / reference">`),
      ]),
    ]);
    // what those two numbers actually mean, restated as they are typed
    const plan = h("div", { class: "muted", style: "font-size:12px;margin-top:10px;padding:9px 12px;border:1px solid var(--line);border-radius:8px" });
    body.appendChild(plan);
    if (a) body.appendChild(h("div", { class: "muted", style: "font-size:11.5px;margin-top:8px" },
      "Recovered so far " + money(a.recovered) + " of " + money(a.amount) + " · outstanding " + money(a.outstanding)
      + (a.startedOn ? " · taken " + a.startedOn : "")));

    const foot = [h("button", { class: "btn ghost", onclick: () => mo.close(), text: "Cancel" })];
    if (a) foot.push(h("button", { class: "btn danger", onclick: () => saveAdv(0, 0), text: "🗑 Clear advance" }));
    foot.push(h("button", { class: "btn primary", onclick: () => saveAdv(), text: "Save Advance" }));
    const mo = modal({ title: "Advance — " + s.name, sub: "Paid up front, recovered from monthly pay", body, foot });

    const restate = () => {
      const amt = +UI.$("#adv_amt").value || 0, mon = +UI.$("#adv_mon").value || 0;
      if (!amt) { plan.textContent = "No advance — nothing will be deducted."; return; }
      if (!mon) { plan.textContent = "With no monthly deduction the whole " + money(amt) + " comes off the next payslip."; return; }
      if (mon > amt) { plan.textContent = "The monthly deduction cannot be more than the advance itself."; return; }
      const months = Math.ceil(amt / mon), last = amt - mon * (months - 1);
      plan.textContent = money(mon) + " a month for " + months + " month" + (months > 1 ? "s" : "")
        + (last !== mon ? " (last month " + money(last) + ")" : "") + " — clears " + money(amt) + ".";
    };
    ["adv_amt", "adv_mon"].forEach((id) => { const el = UI.$("#" + id); if (el) el.addEventListener("input", restate); });
    restate();

    async function saveAdv(amtOverride, monOverride) {
      const amount = amtOverride != null ? amtOverride : (+UI.$("#adv_amt").value || 0);
      const monthly = monOverride != null ? monOverride : (+UI.$("#adv_mon").value || 0);
      if (amount && monthly > amount) { toast("The monthly deduction cannot exceed the advance", { type: "warn" }); return; }
      const startPeriod = (UI.$("#adv_from") || {}).value || null;
      const note = (UI.$("#adv_note") || {}).value || "";
      mo.close(); UI.$("#modalHost").hidden = true;
      await save(async () => {
        await DB.hr.advance.set(s.workerId, { amount, monthly, startPeriod, note });
        // the instalment only reaches the payslips when the run is regenerated
        if (run && run.status !== "Finalized") await DB.hr.payroll.run(run.period, { force: true });
        toast(amount ? "Advance set for " + s.name : "Advance cleared for " + s.name, { type: "ok" });
      }, "payroll");
    }
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
        { key: "name", label: "Name", cls: "nm", render: (r) => esc(r.name), noSort: true },
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
