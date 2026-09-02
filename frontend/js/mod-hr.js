/* ============================================================
   CHHAPERIA ERP — HUMAN RESOURCES & PAYROLL  (frontend)
   Tabs: Dashboard · Workers · Attendance (muster + biometric)
         · Leave · Payroll · Settings
   Monthly-salary base (pay is monthly only; a worker in their own
   accommodation gets a flat no-room allowance) with configurable
   PF/ESI/PT and admin-defined leave types. Biometric device pushes punches to
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
  /* Sunday is the weekly off for every worker (ruling 2026-08-28) — a
     constant here as on the server (hrService WEEK_OFF), never a setting */
  const isWeekOff = (ds) => new Date(String(ds).slice(0, 10) + "T12:00:00").getDay() === 0;
  const workingISO = (from, to) => eachISO(from, to).filter((d) => !isWeekOff(d));

  let curTab = "dashboard";
  // what the payroll tab is currently showing, so the header's print-all
  // button knows which run to print
  let payrollCtx = { run: null, slips: [] };
  /* payslip picking on the payroll tab — which run the ticks belong to, the
     ticks themselves, and what the search/department filter is narrowed to */
  let paySelRunId = null, paySel = {}, paySearch = "", paySelDept = "all";
  /* what Print / Export act on: the ticked payslips, or everything the search
     is showing when nothing is ticked. Set by the payroll tab as it renders. */
  let payActing = () => payrollCtx.slips || [];
  function workers() { return ENG.data.hrWorkers || []; }
  function wById(id) { return workers().find((w) => w.id === id) || { name: id }; }
  function attendance() { return ENG.data.hrAttendance || []; }
  function leaveTypes() { return ENG.data.hrLeaveTypes || []; }
  function leaves() { return ENG.data.hrLeaves || []; }
  function payruns() { return ENG.data.hrPayruns || []; }
  function payslips() { return ENG.data.hrPayslips || []; }
  /* the flat monthly sum paid to a worker who stays in their own accommodation
     instead of a company room (HR Settings → Accommodation; server default ₹1,000) */
  function noRoomAllowance() {
    const hr = (ENG.data.settings || {}).hr || {};
    return hr.noRoomAllowance != null ? (+hr.noRoomAllowance || 0) : 1000;
  }
  /* paid leave: at most this many paid days in any one month (HR Settings →
     Leave; server default 1, 0 = no limit). Further paid-leave days in that
     month are unpaid and do not use the annual quota. */
  function paidLeaveCap() {
    const hr = (ENG.data.settings || {}).hr || {};
    return hr.paidLeaveMaxPerMonth != null ? (+hr.paidLeaveMaxPerMonth || 0) : 1;
  }
  function eachISO(from, to) {
    const out = []; let d = new Date(from + "T12:00:00"); const end = new Date(to + "T12:00:00");
    while (d <= end) { out.push(DB.helpers.iso(d)); d.setDate(d.getDate() + 1); }
    return out;
  }
  /* the payslip's "N leave day(s) over the monthly paid limit" note */
  function capNote(s) {
    return s.leaveOverCap ? " · " + num(s.leaveOverCap, 0) + " leave day" + (s.leaveOverCap === 1 ? "" : "s") + " over the monthly paid limit went unpaid" : "";
  }

  /* run an HR API call, reload the dataset, land on the given view */
  async function save(apiCall, tab) {
    try { await apiCall(); await App.reloadState(); App.go(TAB_ID[tab || curTab] || "hr"); }
    catch (e) { toast(e.message || "Save failed", { type: "danger", title: "HR" }); }
  }

  const TAB_RENDER = { dashboard: tabDashboard, workers: tabWorkers, attendance: tabAttendance,
    leave: tabLeave, payroll: tabPayroll, settings: tabSettings };
  const TAB_HEAD = {
    dashboard: ["Human Resources & Payroll", "Workforce, biometric attendance, leave and monthly payroll — at a glance."],
    workers: ["Workers", "Your workforce — labours & staff, wage rates and biometric IDs."],
    attendance: ["Attendance", "Biometric muster roll, overtime and manual corrections."],
    leave: ["Leave", "Requests, approvals and live balances."],
    payroll: ["Payroll", "Monthly salaries paid to attendance, with statutory deductions."],
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
      h("button", { class: "btn primary", onclick: () => exportPayroll(), html: "🗎 Export" })];
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
    const wageCapacity = active.reduce((s, w) => s + (w.monthlyCtc || 0) + (w.ownAccommodation ? noRoomAllowance() : 0), 0);

    host.appendChild(h("div", { class: "grid kpi-grid", style: "margin-bottom:16px" }, [
      kpi({ icon: "👷", label: "Active Workers", value: num(active.length) }),
      kpi({ icon: "✅", label: "Present Today", value: num(present),
        delta: isWeekOff(today) ? "Sunday · weekly off" : (absent ? absent + " absent" : "full house"),
        deltaType: isWeekOff(today) ? "flat" : (absent ? "down" : "up") }),
      kpi({ icon: "🌴", label: "On Leave Today", value: num(onLeave) }),
      kpi({ icon: "💰", label: "Est. Monthly Wage Bill", value: money(wageCapacity), delta: "CTC + room allowances", deltaType: "flat" }),
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
          h("div", { class: "flex between", style: "font-size:13px;margin-bottom:4px" }, [
            h("span", { html: "<b>" + esc(cap(d)) + "</b>" }), h("span", { class: "muted", text: v.present + "/" + v.total })]),
          h("div", { html: UI.meter(pct, pct >= 80 ? "ok" : pct >= 50 ? "warn" : "danger") })]);
      }) : [h("div", { class: "muted", text: "No attendance punched yet today — use the Attendance tab." })]),
    ]));
    // pending leave requests
    const pend = leaves().filter((l) => l.status === "Pending").slice(0, 8);
    grid.appendChild(h("div", { class: "card" }, [
      h("div", { class: "card-head" }, [h("h3", { html: "🔔 Pending Leave (" + pending + ")" }), h("div", { class: "sub", text: "Approve or reject in the Leave tab" })]),
      h("div", {}, pend.length ? pend.map((l) => h("div", { class: "flex between aic", style: "padding:7px 0;border-bottom:1px solid var(--line);cursor:pointer", onclick: () => App.go("hr-leave") }, [
        h("div", {}, [h("div", { style: "font-weight:600;font-size:13px", text: wById(l.workerId).name }), h("div", { class: "muted", style: "font-size:12px", text: (ltName(l.type)) + " · " + l.fromDate + " → " + l.toDate })]),
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
    let filter = App.viewState("filter", () => ({ q: "", qRaw: "", dept: "all" }));
    const bar = h("div", { class: "toolbar" }, [
      MW.searchInput("Search name, code, device…", (v) => { filter.qRaw = v; filter.q = v.toLowerCase(); draw(); }, filter.qRaw),
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
        { key: "ctc", label: "Monthly CTC", num: true, render: (r) => money(r.monthlyCtc), sort: (r) => r.monthlyCtc || 0 },
        { key: "stay", label: "Accommodation", sort: (r) => (r.ownAccommodation ? 1 : 0),
          render: (r) => r.ownAccommodation ? badge("warn", "Own · +" + money(noRoomAllowance()) + "/mo") : badge("mut", "Company room") },
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
        ["Monthly CTC", money(w.monthlyCtc)],
        ["Accommodation", w.ownAccommodation ? "Own accommodation · +" + money(noRoomAllowance()) + "/month" : "Company room"],
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
        h("button", { class: "btn ghost", onclick: () => { UI.$("#modalHost").hidden = true; workerForm(w); }, text: "✎ Edit" }),
        h("button", { class: "btn primary", onclick: () => printWorkerProfile(w), text: "🖨 Print Profile" })] });
    DB.hr.balances(id).then(({ balances }) => { const box = UI.$("#wk_bal"); if (!box) return; box.innerHTML = "";
      if (!balances.length) { box.appendChild(h("span", { class: "muted", text: "No leave types configured." })); return; }
      balances.forEach((b) => box.appendChild(h("div", { class: "chip", style: "padding:8px 12px" },
        // a type with no quota (unpaid leave) has nothing to be "left" of — say what was taken
        h("span", { html: `<b>${esc(b.name)}</b> · ` + (b.entitled > 0
          ? `${b.balance} left <span class="muted">/ ${b.entitled}</span>`
          : `${b.taken} taken <span class="muted">· no quota</span>`) })))); }).catch(() => {});
  }

  function workerForm(w) {
    const edit = !!w; w = w || { payType: "monthly", active: true };
    const f = (k, d) => (w[k] != null ? w[k] : (d == null ? "" : d));
    const body = h("div", { class: "form-grid" }, [
      U.field("Worker Code", `<input class="input" id="w_id" value="${esc(f("id"))}" ${edit ? "disabled" : ""} placeholder="Auto (EMP-000N) if blank">`),
      U.field("Full Name", `<input class="input" id="w_name" value="${esc(f("name"))}" placeholder="e.g. Ramesh Kumar">`),
      U.field("Department", U.selectHTML("w_dept", DEPTS.map((d) => ({ v: d, l: cap(d) })), f("dept", "coating"))),
      U.field("Designation", `<input class="input" id="w_desig" value="${esc(f("designation"))}" placeholder="e.g. Machine Operator">`),
      U.field("Monthly CTC (₹)", `<input class="input" id="w_ctc" type="number" value="${f("monthlyCtc", 0)}">`),
      // the plant houses its workers; one who stays elsewhere is paid the no-room allowance
      U.field("Accommodation", U.selectHTML("w_stay", [{ v: "0", l: "Company room" },
        { v: "1", l: "Own accommodation (+" + money(noRoomAllowance()) + "/month)" }], w.ownAccommodation ? "1" : "0")),
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
      const payload = { name, dept: g("w_dept"), designation: g("w_desig").trim(), payType: "monthly",
        monthlyCtc: +g("w_ctc") || 0, ownAccommodation: g("w_stay") === "1", deviceUid: g("w_dev").trim() || null,
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
     WORKER PROFILE — printed sheet
     The worker's bio-data on one branded A4: a navy masthead with the
     worker code set in an orange corner disc, an identity card with an
     initials avatar and the day rate, then employment and pay / statutory
     / bank details with the values set flush right, a sign-off, and a
     document-control strip. Nothing derived — no attendance, leave or
     payroll history; those live on their own tabs and the payslip.
     ============================================================ */

  /* "2024-03-11" -> "1 yr 5 mos" — how long they have been on the rolls */
  function serviceLen(joined) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(joined || ""));
    if (!m) return "—";
    const from = new Date(+m[1], +m[2] - 1, +m[3]), now = new Date();
    let mos = (now.getFullYear() - from.getFullYear()) * 12 + (now.getMonth() - from.getMonth());
    if (now.getDate() < from.getDate()) mos--;
    if (mos < 0) return "—";
    const y = Math.floor(mos / 12), r = mos % 12;
    return (y ? y + (y === 1 ? " yr " : " yrs ") : "") + r + (r === 1 ? " mo" : " mos");
  }

  function workerProfileDocHtml(w) {
    const co = payCompany();
    const initials = String(w.name || "").trim().split(/\s+/).slice(0, 2)
      .map((s) => (s[0] || "")).join("").toUpperCase() || "?";
    const active = w.active !== false;
    /* label left, value flush right — the mockup's ledger look */
    const kv = (rows) => rows.filter(Boolean).map(([l, v]) =>
      `<tr><td>${esc(l)}</td><td class="v">${esc(v == null || v === "" ? "—" : String(v))}</td></tr>`).join("");
    let secNo = 0;
    const sec = (title, inner) => `<section class="blk">
      <div class="sec"><i>${++secNo}</i><b>${esc(title)}</b></div>${inner}</section>`;
    const chip = (t) => `<span class="chip">${esc(t)}</span>`;

    return `<!doctype html><html><head><meta charset="utf-8"><title>Worker Profile — ${esc(w.name)} (${esc(w.id)})</title>
<style>
  /* ---- Bio-data on one branded page. The sheet is full-bleed — the navy
     masthead and the tail strip run to the paper edge — so the @page margin
     is zero and the grey ground is the page itself; the cards float on it.
     Ask the print dialog for background graphics, as with the payslip. ---- */
  *{margin:0;padding:0;box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  body{font:10px/1.4 "Segoe UI",Arial,sans-serif;color:#2b2f33}
  .page{width:210mm;min-height:296.5mm;background:#eef0f3;display:flex;flex-direction:column;overflow:hidden}

  /* ---- masthead: navy band, white logo card, orange corner disc ---- */
  .hd{position:relative;background:#1b2433;padding:7mm 9mm;display:flex;align-items:center;gap:7mm;overflow:hidden}
  .hd-disc{position:absolute;top:-26mm;right:-20mm;width:62mm;height:62mm;border-radius:50%;background:#d95f16}
  .hd-disc2{position:absolute;top:-32mm;right:-12mm;width:58mm;height:58mm;border-radius:50%;background:#ee752a}
  .hd-logo{position:relative;background:#fff;border-radius:9px;padding:9px 14px;flex:0 0 auto;
    box-shadow:0 2px 8px rgba(0,0,0,.28)}
  .hd-logo img{height:32px;display:block}
  .hd-co{position:relative;flex:1;min-width:0;padding-right:34mm}
  .hd-conm{font-size:15px;font-weight:800;color:#fff;letter-spacing:-.2px;line-height:1.2}
  .hd-coad{font-size:9px;color:#9aa3b2;margin-top:3px;line-height:1.45;max-width:110mm}
  .hd-id{position:relative;flex:0 0 auto;text-align:right;color:#fff}
  .hd-id-l{font-size:8px;font-weight:800;letter-spacing:1.2px;text-transform:uppercase}
  .hd-id-m{font-size:22px;font-weight:800;letter-spacing:-.4px;margin-top:1px;font-variant-numeric:tabular-nums}
  .hd-id-d{font-size:8px;color:rgba(255,255,255,.85);margin-top:2px}
  .hd-bar{height:2.8mm;background:#e8641e}

  .wrap{flex:1 0 auto;padding:6mm 8mm 0}

  /* ---- identity card: avatar, name, chips, and the rate ---- */
  .idc{background:#fff;border-radius:14px;padding:6mm 7mm;display:flex;align-items:center;gap:6mm;
    box-shadow:0 2px 10px rgba(18,24,32,.07)}
  .av{width:19mm;height:19mm;border-radius:50%;border:2.5px solid #e8641e;background:#fdeee2;color:#e8641e;
    display:flex;align-items:center;justify-content:center;font-size:9mm;font-weight:800;flex:0 0 auto;
    letter-spacing:-.5px}
  .idc-mid{flex:1;min-width:0}
  .nm-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .nm{font-size:22px;font-weight:800;color:#12151a;letter-spacing:-.5px;line-height:1.1}
  .pill{font-size:8px;font-weight:800;letter-spacing:1px;text-transform:uppercase;
    border-radius:999px;padding:2.5px 10px;border:1.6px solid}
  .pill.on{color:#1c7a3d;border-color:#35a15c;background:#f2faf4}
  .pill.off{color:#a32a20;border-color:#c4453a;background:#fdf2f1}
  .role{font-size:12px;font-weight:700;color:#2b2f33;margin-top:2.5px}
  .role i{font-style:normal;color:#9aa1a8;margin:0 4px}
  .chips{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
  .chip{font-size:8px;font-weight:800;letter-spacing:.6px;text-transform:uppercase;color:#4b5158;
    background:#eceff3;border-radius:8px;padding:3.5px 10px;white-space:nowrap}
  .rate{flex:0 0 auto;background:#e9eef6;border-radius:11px;padding:5mm 7mm;text-align:center;min-width:44mm}
  .rate b{display:block;font-size:19px;font-weight:800;color:#12151a;letter-spacing:-.4px;
    font-variant-numeric:tabular-nums}
  .rate span{display:block;font-size:8px;font-weight:800;letter-spacing:1px;text-transform:uppercase;
    color:#6b7280;margin-top:2.5px}

  /* ---- the main card, with its orange spine ---- */
  .main{position:relative;background:#fff;border-radius:14px;margin-top:5mm;padding:7mm 8mm 6mm 9.5mm;
    box-shadow:0 2px 10px rgba(18,24,32,.07)}
  .main:before{content:"";position:absolute;left:0;top:0;bottom:0;width:2.4mm;background:#e8641e;
    border-radius:14px 0 0 14px}

  .blk+.blk{margin-top:6.5mm}
  .sec{display:flex;align-items:center;gap:9px;border-bottom:1.8px solid #232a36;
    padding-bottom:2.4mm;margin-bottom:1mm}
  .sec i{font-style:normal;font-size:9px;font-weight:800;background:#1b2433;color:#fff;width:16px;height:16px;
    border-radius:4px;display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto}
  .sec b{font-size:12px;font-weight:800;letter-spacing:.5px;color:#12151a;text-transform:uppercase}

  .cols{display:flex;gap:11mm}
  .cols>div{flex:1;min-width:0}
  table.kv{border-collapse:collapse;width:100%}
  table.kv td{padding:2.7mm 0 1.8mm;border-bottom:1px solid #6f7680;font-size:10px;vertical-align:bottom}
  table.kv td:first-child{color:#6b7177}
  table.kv td.v{text-align:right;font-weight:700;color:#12151a;word-break:break-word}

  /* pay & bank sits in its peach panel, as on the mockup */
  .panel{background:#fdf1e6;border:1px solid #f6ddc4;border-radius:10px;padding:1mm 5mm 2mm;margin-top:2mm}
  .panel table.kv td{border-bottom-color:#e3c6a8}

  .sign{display:flex;justify-content:space-between;align-items:flex-start;gap:12mm;margin-top:6mm}
  .sign-note{font-size:8.6px;color:#6b7177;max-width:95mm;line-height:1.55;padding-top:1mm}
  .sign-box{flex:0 0 auto;text-align:right;min-width:62mm}
  .sign-for{font-size:11px;font-weight:800;color:#12151a}
  .sign-line{height:13mm;border-bottom:1.4px solid #3a414d;margin-bottom:2.2mm}
  .sign-lbl{font-size:10px;font-weight:800;color:#12151a}

  /* ---- page foot: the record line, document control, navy tail ---- */
  .meta{display:flex;justify-content:space-between;gap:8mm;padding:4.5mm 1mm 3.5mm;font-size:8px;color:#9aa1a8}
  .docctl{background:#fff;border-radius:10px;padding:3.4mm 5mm;display:flex;justify-content:space-between;
    align-items:center;gap:8mm;box-shadow:0 2px 10px rgba(18,24,32,.07)}
  .docctl b{font-size:8px;font-weight:800;letter-spacing:1.2px;color:#3f4650;text-transform:uppercase}
  .docctl span{font-size:9px;color:#6b7177}
  .tail{height:4mm;background:#1b2433;margin-top:5mm}

  @media screen{
    body{background:#d6dade;padding:20px}
    .page{margin:0 auto;box-shadow:0 4px 22px rgba(15,20,28,.28)}
  }
  @media print{
    body{background:#fff}
    .page{width:auto}
  }
  @page{size:A4 portrait;margin:0}
</style></head><body>
<div class="page">
  <header class="hd">
    <div class="hd-disc"></div><div class="hd-disc2"></div>
    <div class="hd-logo"><img src="${location.origin}/assets/logo-full-print.png" alt="${esc(co.name)}"
      onerror="this.src='${location.origin}/assets/logo-invoice.png'"></div>
    <div class="hd-co">
      <div class="hd-conm">${esc(co.name)}</div>
      <div class="hd-coad">${esc(co.address || "")}</div>
    </div>
    <div class="hd-id">
      <div class="hd-id-l">Employee Bio-Data</div>
      <div class="hd-id-m">${esc(w.id)}</div>
      <div class="hd-id-d">as on ${esc(dmy(iso()))}</div>
    </div>
  </header>
  <div class="hd-bar"></div>

  <div class="wrap">
    <div class="idc">
      <div class="av">${esc(initials)}</div>
      <div class="idc-mid">
        <div class="nm-row"><span class="nm">${esc(w.name)}</span>
          <span class="pill ${active ? "on" : "off"}">${active ? "Active" : "Inactive"}</span></div>
        <div class="role">${esc(w.designation || "—")}<i>·</i>${esc(cap(w.dept || "—"))} Department</div>
        <div class="chips">
          ${chip("Monthly Salary")}
          ${chip(w.ownAccommodation ? "Own Accommodation" : "Company Room")}
          ${chip("Shift " + (w.shift || "General"))}
          ${chip("Joined " + dmy(w.joined))}
          ${chip("Service " + serviceLen(w.joined))}
        </div>
      </div>
      <aside class="rate">
        <b>${RS(w.monthlyCtc)}</b>
        <span>Monthly CTC</span>
      </aside>
    </div>

    <div class="main">
      ${sec("Employment Details", `<div class="cols">
        <div><table class="kv"><tbody>${kv([
          ["Worker Code", w.id], ["Department", cap(w.dept || "")],
          ["Date of Joining", dmy(w.joined)], ["Shift", w.shift || "General"], ["Phone", w.phone],
        ])}</tbody></table></div>
        <div><table class="kv"><tbody>${kv([
          ["Full Name", w.name], ["Designation", w.designation],
          ["Length of Service", serviceLen(w.joined)], ["Status", active ? "Active" : "Inactive"],
          ["Biometric Device ID", w.deviceUid],
        ])}</tbody></table></div>
      </div>`)}

      ${sec("Pay, Statutory & Bank", `<div class="panel"><div class="cols">
        <div><table class="kv"><tbody>${kv([
          ["Pay Type", "Monthly salary"],
          ["Monthly CTC", RS(w.monthlyCtc) + " / month"], ["UAN", w.uan], ["Bank A/C Number", w.bankAcc],
        ])}</tbody></table></div>
        <div><table class="kv"><tbody>${kv([
          ["Accommodation", w.ownAccommodation ? "Own · " + RS(noRoomAllowance()) + " / month allowance" : "Company room"], ["PF Number", w.pfNo],
          ["ESI Number", w.esiNo], ["Bank IFSC", w.bankIfsc],
        ])}</tbody></table></div>
      </div></div>`)}

      <div class="sign">
        <div class="sign-note">Generated from the HR records held on ${esc(dmy(iso()))}. This is an internal
          document — please report any discrepancy to the HR desk within 7 days.</div>
        <div class="sign-box">
          <div class="sign-for">For ${esc(co.name)}</div>
          <div class="sign-line"></div>
          <div class="sign-lbl">Authorised Signatory</div>
        </div>
      </div>
    </div>

    <div class="meta">
      <span>${esc(co.name)} · Employee Bio-Data · ${esc(w.id)} · ${esc(w.name)}</span>
      <span>Generated ${esc(dmy(iso()))}</span>
    </div>
    <div class="docctl">
      <b>Document Control</b>
      <span>Internal HR record — verify against HRMS before external use</span>
    </div>
  </div>

  <div class="tail"></div>
</div>
<script>window.onload=function(){window.print();}<\/script>
</body></html>`;
  }

  function printWorkerProfile(w) {
    const win = window.open("", "_blank");
    if (!win) { toast("Popup blocked — allow popups for this site to print", { type: "warn" }); return; }
    win.document.write(workerProfileDocHtml(w));
    win.document.close();
  }

  /* ============================================================
     ATTENDANCE — monthly muster matrix + biometric simulator
     ============================================================ */
  function tabAttendance(host, params) {
    const now = DB.helpers.today();
    let period = (params && params.period) || `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
    let dept = "all", q = "";
    const bar = h("div", { class: "toolbar", style: "flex-wrap:wrap;gap:10px" }, [
      U.field ? h("div", { class: "field", style: "margin:0" }, [h("label", { text: "Month" }), h("div", {}, h("input", { class: "input", type: "month", value: period, style: "max-width:170px", onchange: (e) => { period = e.target.value; draw(); } }))]) : null,
      // a full muster is a wall of names; searching gets one worker's row on
      // screen without scrolling past everyone else
      MW.searchInput("Search worker, code, designation…", (v) => { q = v.toLowerCase().trim(); draw(); }),
      MW.select([{ value: "all", label: "All Departments" }, ...DEPTS.map((d) => ({ value: d, label: cap(d) }))], (v) => { dept = v; draw(); }),
      h("button", { class: "btn primary", onclick: () => simulate(), html: "🔌 Simulate Biometric Punches" }),
    ]);
    host.appendChild(bar);
    host.appendChild(h("div", { class: "flex gap wrap", style: "margin:4px 0 12px;font-size:12px" },
      Object.entries(STATUS_META).map(([k, m]) => h("span", { class: "chip" }, h("span", { html: `<span class="badge-s s-${m[0]}">${k}</span> ${m[1]}` })))));
    const grid = h("div"); host.appendChild(grid);
    function draw() {
      grid.innerHTML = "";
      const [y, m] = period.split("-").map(Number);
      const days = new Date(y, m, 0).getDate();
      const list = workers().filter((w) => w.active !== false && (dept === "all" || w.dept === dept)
        && (!q || (w.name + " " + w.id + " " + (w.designation || "") + " " + (w.dept || "") + " " + (w.deviceUid || "")).toLowerCase().includes(q)));
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
        const none = q ? "No worker matches that search" : "No workers";
        tbody.appendChild(h("tr", {}, h("td", { colspan: days + 3 }, h("div", { class: "empty", style: "padding:24px", text: none }))));
        mob.appendChild(h("div", { class: "empty", style: "padding:36px 20px", text: none }));
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
          else if (wd === 0) { letter = "WO"; cls = "s-mut"; }
          const title = a ? (STATUS_META[a.status] ? STATUS_META[a.status][1] : a.status) + (a.otHours ? " · OT " + a.otHours + "h" : "")
            : (wd === 0 ? "Sunday — weekly off (tap only if the worker came in)" : "Mark " + ds);
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
    /* The "Mark Attendance" button is gone: it opened dayEntry on an arbitrary
       first worker, which is not how anyone marks a day. Attendance is edited
       where it is read — tap the worker's cell in the muster and dayEntry
       opens on that worker and that date. */

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
      h("div", { id: "l_hint", class: "dim", style: "grid-column:1/-1;font-size:12px;line-height:1.5" }),
    ]);
    /* paid leave is capped per month — say up front how many of these days
       will actually be paid, counting the worker's other requests that month */
    const hint = () => {
      const box = UI.$("#l_hint"); if (!box) return;
      const t = lts.find((x) => x.id === UI.$("#l_type").value) || {};
      const from = UI.$("#l_from").value, to = UI.$("#l_to").value, wk = UI.$("#l_wk").value;
      const cap = paidLeaveCap();
      const span = from && to && to >= from ? eachISO(from, to) : [];
      const work = span.filter((d) => !isWeekOff(d));
      const sundays = span.length - work.length;
      const sunNote = sundays ? " Sunday is the weekly off — " + sundays + " of these " + span.length + " day(s) " + (sundays === 1 ? "is" : "are") + " not counted." : "";
      if (span.length && !work.length) { box.textContent = "Those dates are all on the weekly off — Sunday is not a leave day."; return; }
      if (t.paid === false) { box.textContent = "Unpaid leave — these days are deducted from pay." + sunNote; return; }
      if (!cap || !from || !to || to < from) { box.textContent = sunNote.trim(); return; }
      const used = {};
      (ENG.data.hrLeaves || []).forEach((l) => {
        if (l.workerId !== wk || l.status === "Rejected") return;
        const lt = lts.find((x) => x.id === l.type) || {};
        if (lt.paid === false) return;
        workingISO(l.fromDate, l.toDate || l.fromDate).forEach((d) => { used[d.slice(0, 7)] = (used[d.slice(0, 7)] || 0) + 1; });
      });
      let paid = 0, unpaid = 0;
      work.forEach((d) => { const m = d.slice(0, 7); if ((used[m] || 0) < cap) { used[m] = (used[m] || 0) + 1; paid++; } else unpaid++; });
      box.textContent = (unpaid
        ? "Only " + cap + " paid leave day" + (cap === 1 ? "" : "s") + " a month: " + paid + " of these " + (paid + unpaid) + " day(s) will be paid, " + unpaid + " unpaid."
        : "Within the monthly paid-leave limit — all " + paid + " day(s) paid.") + sunNote;
    };
    ["l_wk", "l_type", "l_from", "l_to"].forEach((id) => { const el = body.querySelector("#" + id); if (el) el.addEventListener("change", hint); });
    setTimeout(hint, 0);
    const mo = modal({ title: "Apply Leave", sub: "Raise a leave request", body,
      foot: [h("button", { class: "btn ghost", onclick: () => mo.close(), text: "Cancel" }),
        h("button", { class: "btn primary", onclick: () => { const p = { workerId: UI.$("#l_wk").value, type: UI.$("#l_type").value, fromDate: UI.$("#l_from").value, toDate: UI.$("#l_to").value, reason: UI.$("#l_reason").value }; if (p.toDate < p.fromDate) { toast("End date before start", { type: "warn" }); return; } if (!workingISO(p.fromDate, p.toDate).length) { toast("Those dates are all on the weekly off — Sunday is not a leave day", { type: "warn" }); return; } mo.close(); save(() => DB.hr.leave.apply(p), "leave"); }, text: "Submit" })] });
  }

  /* ============================================================
     PAYROLL
     ============================================================ */
  function tabPayroll(host, params) {
    const runs = payruns();
    const now = DB.helpers.today();
    const defPeriod = (params && params.period) || (runs[0] && runs[0].period) || `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
    if (!runs.length) { host.appendChild(h("div", { class: "empty", style: "margin-top:30px" }, [h("div", { class: "big", text: "💰" }), h("div", { style: "font-weight:700", text: "No pay runs yet" }), h("div", { class: "muted", style: "margin-top:6px", text: "Payslips appear here once a pay run exists for a month." })])); return; }
    const run = runs.find((r) => r.period === defPeriod) || runs[0];
    const slips = payslips().filter((s) => s.payrunId === run.id);
    payrollCtx = { run, slips };
    /* Which month is on screen. Payroll is view-only here, so this lists the
       runs that actually exist rather than offering any month at all — picking
       a month with no pay run would only ever show an empty screen. */
    host.appendChild(h("div", { class: "toolbar", style: "gap:10px" }, [
      h("div", { class: "field", style: "margin:0" }, [
        h("label", { text: "Pay Period" }),
        h("div", {}, MW.select(runs.map((r) => ({ value: r.period,
          label: periodLabel(r.period) + "  ·  " + (r.status || "Draft")
            + "  ·  net " + money((r.totals || {}).net || 0) })),
        (v) => { if (v !== run.period) App.go("hr-payroll", { period: v }); }, run.period)),
      ]),
      h("span", { class: "muted", style: "font-size:12px;align-self:flex-end;padding-bottom:9px",
        text: runs.length === 1 ? "1 pay run" : runs.length + " pay runs" }),
    ]));
    const tot = (run.totals || {});
    host.appendChild(h("div", { class: "grid kpi-grid", style: "margin-bottom:14px" }, [
      kpi({ icon: "👷", label: "Workers Paid", value: num(slips.length) }),
      kpi({ icon: "💵", label: "Gross", value: money(tot.gross || 0) }),
      kpi({ icon: "🏦", label: "Deductions", value: money((tot.pf || 0) + (tot.esi || 0) + (tot.pt || 0)) }),
      kpi({ icon: "💰", label: "Net Payout", value: money(tot.net || 0) }),
    ]));
    /* A run can cover only some of the floor, so say plainly who is still
       unpaid this month — otherwise a partial run looks like a complete one. */
    const paid = {}; slips.forEach((s) => { paid[s.workerId] = true; });
    const unpaid = workers().filter((w) => w.active !== false && !paid[w.id]);
    if (unpaid.length) {
      host.appendChild(h("div", { class: "flex gap wrap", style: "align-items:center;margin-bottom:12px;padding:10px 14px;border:1.5px solid var(--line);border-radius:10px" }, [
        h("span", { html: `${badge("warn", "Partial run")} <b>${unpaid.length}</b> active worker${unpaid.length === 1 ? " is" : "s are"} not in this run` }),
        h("span", { class: "muted", style: "font-size:12px;flex:1;min-width:120px",
          text: unpaid.slice(0, 4).map((w) => w.name).join(", ") + (unpaid.length > 4 ? ` +${unpaid.length - 4} more` : "") }),
      ]));
    }
    /* selection survives sorting and searching, but belongs to ONE run —
       switching month must not carry ticks over to different people */
    if (paySelRunId !== run.id) { paySelRunId = run.id; paySel = {}; paySearch = ""; paySelDept = "all"; }

    const tableHost = h("div");
    const countChip = h("span", { class: "chip" });
    const printBtn = h("button", { class: "btn" });
    const depts = [];
    slips.forEach((s) => { const d = (s.dept || "").toLowerCase(); if (d && depts.indexOf(d) < 0) depts.push(d); });
    depts.sort();

    /* Every space-separated term must match somewhere — so "ram coat" finds
       Ramesh on the coating floor, which a plain substring search cannot. */
    const matches = (s) => {
      if (paySelDept !== "all" && (s.dept || "").toLowerCase() !== paySelDept) return false;
      const q = paySearch.trim().toLowerCase();
      if (!q) return true;
      const hay = [s.name, s.workerId, s.dept, s.designation].join(" ").toLowerCase();
      return q.split(/\s+/).every((t) => hay.indexOf(t) >= 0);
    };
    const shown = () => slips.filter(matches);
    const chosen = () => { const ids = Object.keys(paySel).filter((k) => paySel[k]);
      return ids.length ? slips.filter((s) => paySel[s.workerId]) : []; };
    /* nothing ticked = act on everything the search is showing */
    const acting = () => (chosen().length ? chosen() : shown());
    payActing = acting;   // the header's Export button acts on the same set

    function syncBar() {
      const n = chosen().length, v = shown().length;
      countChip.textContent = n ? `${n} selected` : `${v} of ${slips.length} shown`;
      countChip.style.borderColor = n ? "var(--accent)" : "var(--line)";
      printBtn.innerHTML = n ? `🖨 Print Selected (${n})` : `🖨 Print All (${v})`;
      printBtn.disabled = !acting().length;
    }
    const setAll = (on) => {
      shown().forEach((s) => { if (on) paySel[s.workerId] = true; else delete paySel[s.workerId]; });
      draw();
    };
    printBtn.onclick = () => printPayslips(acting(), run);

    const searchBox = MW.searchInput("Search worker, code, department…", (v) => { paySearch = v; draw(); });
    host.appendChild(h("div", { class: "toolbar", style: "gap:10px" }, [
      searchBox,
      MW.select([{ value: "all", label: "All Departments" }]
        .concat(depts.map((d) => ({ value: d, label: cap(d) }))), (v) => { paySelDept = v; draw(); }, "all"),
      h("button", { class: "btn ghost", onclick: () => setAll(true), text: "☑ Select All" }),
      h("button", { class: "btn ghost", onclick: () => setAll(false), text: "Clear" }),
      countChip,
      h("div", { style: "margin-left:auto" }, printBtn),
    ]));
    host.appendChild(tableHost);
    draw();

    function draw() {
      tableHost.innerHTML = "";
      tableHost.appendChild(buildTable(shown()));
      syncBar();
    }
    function buildTable(rows) {
      return table(rows, [
      { key: "sel", label: "", noSort: true, width: "38px",
        render: (r) => { const cb = h("input", { type: "checkbox", style: "width:16px;height:16px;cursor:pointer" });
          cb.checked = !!paySel[r.workerId];
          cb.onchange = () => { if (cb.checked) paySel[r.workerId] = true; else delete paySel[r.workerId]; syncBar(); };
          return cb; } },
      { key: "worker", label: "Worker", render: (r) => `<div class="cell-main">${esc(r.name)}</div><div class="cell-sub">${cap(r.dept || "")}</div>`, sort: (r) => r.name },
      { key: "present", label: "Days", num: true, render: (r) => num(r.payableDays, 1), sort: (r) => r.payableDays },
      { key: "ot", label: "OT h", num: true, render: (r) => r.otHours ? num(r.otHours, 1) : "—", sort: (r) => r.otHours },
      { key: "gross", label: "Gross", num: true, sort: (r) => r.gross,
        render: (r) => {
          const extras = [r.roomAllowance ? money(r.roomAllowance) + " room allowance" : "",
            r.attendanceBonus ? money(r.attendanceBonus) + " attendance bonus" : ""].filter(Boolean);
          return money(r.gross) + (extras.length ? `<div class="cell-sub">incl. ${esc(extras.join(" · "))}</div>` : "");
        } },
      { key: "pf", label: "PF", num: true, render: (r) => r.deductions.pf ? money(r.deductions.pf) : "—", sort: (r) => r.deductions.pf },
      { key: "esi", label: "ESI", num: true, render: (r) => r.deductions.esi ? money(r.deductions.esi) : "—", sort: (r) => r.deductions.esi },
      { key: "pt", label: "PT", num: true, render: (r) => r.deductions.pt ? money(r.deductions.pt) : "—", sort: (r) => r.deductions.pt },
      // the instalment, with what is still owed after it
      { key: "adv", label: "Advance", num: true, sort: (r) => r.advances,
        render: (r) => r.advances
          ? money(r.advances) + (r.advance && r.advance.closing ? `<div class="cell-sub">${esc(money(r.advance.closing))} left</div>` : "")
          : "—" },
      { key: "net", label: "Net Pay", num: true, render: (r) => `<span class="strong">${money(r.net)}</span>`, sort: (r) => r.net },
      /* mobileCards would take column ONE as the card title — that is now the
         tick box, so the phone falls back to the stacked table instead */
      ], { onRow: (r) => payslipDetail(r, run), mobileCards: false,
        empty: paySearch || paySelDept !== "all" ? "No payslip matches that search" : "No payslips" });
    }
  }
  /* ---- export the run to Excel -------------------------------------------
     One row per payslip, the same columns as the table on screen. It goes
     through the shared preview first, so the figures can be checked before
     the .xlsx is written. */
  function exportPayroll() {
    const run = payrollCtx.run;
    // the ticked payslips, or everything the search is showing
    const slips = run ? payActing() : [];
    if (!run || !slips.length) { toast("Nothing to export — no payslips selected", { type: "warn" }); return; }
    const n2 = (v) => Math.round((+v || 0) * 100) / 100;
    const head = ["Worker", "Code", "Department", "Days", "OT Hours", "Gross",
      "PF", "ESI", "PT", "Advance", "Net Pay"];
    const rows = slips.map((s) => {
      const d = s.deductions || {};
      return [s.name || s.workerId, s.workerId, cap(s.dept || ""), n2(s.payableDays),
        n2(s.otHours), n2(s.gross), n2(d.pf), n2(d.esi), n2(d.pt), n2(s.advances), n2(s.net)];
    });
    MW.dataPreview({ title: "Payroll " + run.period, head, rows,
      name: "chhaperia_payroll_" + run.period + ".xlsx", sheet: "Payroll " + run.period });
  }

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
      room: sum((p) => p.roomAllowance), bonus: sum((p) => p.attendanceBonus),
      gross: sum((p) => p.gross), net: sum((p) => p.net),
      pf: sum((p) => (p.deductions || {}).pf), esi: sum((p) => (p.deductions || {}).esi),
      pt: sum((p) => (p.deductions || {}).pt), adv: sum((p) => p.advances),
    };
  }

  /* PAID LEAVE STILL PENDING — what the worker may still take this calendar
     year. Mirrors hrService.leaveBalances: an "earned" type accrues ONE DAY
     PER MONTH WORKED, "none" grants nothing, everything else uses its quota;
     approved leave of that type in the same year is taken off.
     UNPAID types are ignored — the slip is about paid entitlement. */
  function paidLeavePending(workerId, period) {
    const year = String(period || "").slice(0, 4) || String(new Date().getFullYear());
    // one day per calendar month the worker has any attendance in
    const monthsWorked = new Set();
    (ENG.data.hrAttendance || []).forEach((a) => {
      if (a.workerId !== workerId) return;
      if (!String(a.date || "").startsWith(year)) return;
      if (a.status !== "P" && a.status !== "HD") return;
      monthsWorked.add(String(a.date).slice(0, 7));
    });
    const rows = [];
    leaveTypes().forEach((t) => {
      if (t.paid === false) return;
      const entitled = t.accrual === "earned" ? monthsWorked.size
        : (t.accrual === "none" ? 0 : (+t.quota || 0));
      // paid types count at most `cap` days in any month — the same rule the
      // server applies in leaveBalances / computeSlip
      const cap = paidLeaveCap();
      const byMonth = {};
      (ENG.data.hrLeaves || []).forEach((l) => {
        if (l.workerId !== workerId || l.type !== t.id || l.status !== "Approved") return;
        workingISO(l.fromDate, l.toDate || l.fromDate).forEach((d) => {
          if (d.startsWith(year)) byMonth[d.slice(0, 7)] = (byMonth[d.slice(0, 7)] || 0) + 1;
        });
      });
      const taken = Object.values(byMonth).reduce((n, c) => n + (cap > 0 ? Math.min(c, cap) : c), 0);
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
    // a monthly worker is a fixed salary pro-rated to the days actually worked;
    // a daily worker is a rate per day. Say which, in the worker's own terms.
    const basicNote = (s.payType === "monthly"
      ? money(s.monthPerDay) + "/day (" + money(s.monthlyCtc) + " ÷ " + days(s.monthWorkingDays) + " working days) × " + days(s.payableDays) + " paid"
      : days(s.payableDays) + " days × " + money(s.dailyRate)) + capNote(s);
    const earn = [
      ["Basic", s.basicEarned, y.basic, basicNote],
      s.otPay ? ["Overtime", s.otPay, y.ot, days(s.otHours) + " h × " + money(s.hourly || 0)] : null,
      s.roomAllowance ? ["Accommodation Allowance", s.roomAllowance, y.room, "own accommodation — no company room"] : null,
      s.attendanceBonus ? ["Attendance Bonus", s.attendanceBonus, y.bonus, "no leave or absence all month"] : null,
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
  .ps-conm{font-size:13px;font-weight:800;color:#12151a;line-height:1.2;letter-spacing:-.15px}
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
  table.ps-kv td{padding:1.4px 0;font-size:10px;vertical-align:top;line-height:1.3}
  table.ps-kv td:first-child{color:#6b7177;width:44%}
  table.ps-kv td.c{width:11px;color:#9aa1a8;text-align:center}
  table.ps-kv td.v{color:#1a1c1e;font-weight:600}
  table.ps-kv td.v.nm{font-weight:800;font-size:11px}
  .ps-netcard{flex:1;border:1px solid #d7ede0;border-radius:9px;overflow:hidden;align-self:stretch;
    display:flex;flex-direction:column}
  .ps-netcard-top{display:flex;align-items:center;gap:10px;background:#f2faf5;padding:9px 12px}
  .ps-netbar{flex:0 0 3px;align-self:stretch;min-height:28px;background:#38a169;border-radius:3px}
  .ps-netamt{font-size:17px;font-weight:800;color:#12151a;line-height:1.1;letter-spacing:-.3px}
  .ps-netlbl{font-size:8px;color:#38a169;font-weight:800;margin-top:2px;
    letter-spacing:.7px;text-transform:uppercase}
  .ps-netcard-foot{padding:5px 12px 6px;border-top:1px dashed #d7ede0;margin-top:auto}
  .ps-netcard-foot div{display:flex;font-size:10px;padding:1px 0}
  .ps-netcard-foot span{color:#6b7177;flex:0 0 52%}
  .ps-netcard-foot i{font-style:normal;color:#9aa1a8;flex:0 0 11px;text-align:center}
  .ps-netcard-foot b{color:#12151a;font-weight:700}

  /* PF / UAN / leave strip */
  .ps-ids{display:flex;flex-wrap:wrap;gap:5px 24px;padding:6px 11px;font-size:10px;
    background:#f7f8f9;border:1px solid #eceff1;border-radius:8px}
  .ps-ids>div{display:flex;align-items:baseline;min-width:0}
  .ps-ids span{color:#6b7177}
  .ps-ids i{font-style:normal;color:#9aa1a8;padding:0 6px}
  .ps-ids b{color:#12151a;font-weight:700;overflow-wrap:anywhere}
  /* the leave balance takes the rest of the row so its breakdown has room */
  .ps-ids .ps-leave{margin-left:auto}
  .ps-ids .ps-leave b{color:#0f766e}
  .ps-ids .ps-leave em{font-style:normal;color:#8b9096;font-size:9px;padding-left:7px}

  /* earnings + deductions */
  .ps-money{display:flex;border:1px solid #dfe3e6;border-radius:9px;overflow:hidden;margin-top:6px}
  table.ps-half{flex:1;width:50%;border-collapse:collapse}
  table.ps-half+table.ps-half{border-left:1px solid #e3e6e9}
  table.ps-half th{font-size:8px;font-weight:800;letter-spacing:.8px;color:#4b5158;
    padding:6px 10px 5px;text-align:left;background:#f7f8f9;border-bottom:1px solid #e3e6e9}
  table.ps-half td{padding:3.6px 10px;font-size:10px;vertical-align:top}
  /* zebra rows make a long list readable across the fold */
  table.ps-half tbody tr:nth-child(even) td{background:#fafbfc}
  table.ps-half th.amt,table.ps-half td.amt{text-align:right;white-space:nowrap}
  table.ps-half th.ytd,table.ps-half td.ytd{text-align:right;white-space:nowrap;width:26%}
  table.ps-half td.amt{font-weight:700;color:#12151a}
  table.ps-half td.ytd{color:#8b9096}
  table.ps-half td.lbl{color:#2b2f33}
  table.ps-half tr.pad td{padding:3.6px 10px}
  td .n{font-size:8px;color:#8b9096;margin-top:1px;line-height:1.25}
  table.ps-half tfoot td{background:#f1f3f5;font-weight:800;color:#12151a;font-size:10px;
    padding:5px 10px;border-top:1px solid #e3e6e9}

  /* total net payable — the anchor of the sheet */
  .ps-payable{display:flex;justify-content:space-between;align-items:stretch;
    border-radius:9px;margin-top:6px;overflow:hidden;background:#1f2937}
  .ps-payable>div:first-child{padding:6px 13px}
  .ps-payable-t{font-size:10px;font-weight:800;color:#fff;letter-spacing:.6px}
  .ps-payable-s{font-size:9px;color:#9aa5b1;margin-top:1px}
  .ps-payable-v{background:#38a169;display:flex;align-items:center;padding:6px 18px;
    font-size:14px;font-weight:800;color:#fff;white-space:nowrap;letter-spacing:-.2px}

  .ps-words{text-align:right;font-size:10px;color:#12151a;margin-top:5px}
  .ps-words span{color:#6b7177}

  /* signature + seal — space is LEFT for a real signature and stamp */
  .ps-sign{margin-top:auto;padding-top:6px;border-top:1px solid #e3e6e9;
    display:flex;justify-content:space-between;align-items:flex-end;gap:16px}
  .ps-sign-l{font-size:9px;color:#8b9096;min-width:0}
  .ps-sign-emp{color:#4b5158}
  .ps-sign-note{margin-top:2px}
  .ps-sign-r{display:flex;align-items:flex-end;gap:12px;flex:0 0 auto}
  .ps-seal{width:54px;height:54px;border:1px dashed #c7ced4;border-radius:50%;
    display:flex;align-items:center;justify-content:center;
    font-size:8px;letter-spacing:1px;text-transform:uppercase;color:#c0c7cd}
  .ps-sign-box{text-align:center;min-width:150px}
  .ps-sign-for{font-size:9px;color:#4b5158}
  .ps-sign-for b{color:#12151a;font-weight:700}
  .ps-sign-space{height:24px}                       /* room to actually sign */
  .ps-sign-lbl{font-size:9px;font-weight:700;color:#12151a;
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
          ["Basic earned", s.basicEarned, (s.payType === "monthly"
            ? money(s.monthPerDay) + "/day (" + money(s.monthlyCtc) + " ÷ " + num(s.monthWorkingDays, 0) + " working days) × " + num(s.payableDays, 1) + " paid"
            : num(s.payableDays, 1) + " days × " + money(s.dailyRate)) + capNote(s)],
          s.otPay ? ["Overtime", s.otPay, num(s.otHours, 1) + " h × " + money(s.hourly || 0)] : null,
          s.roomAllowance ? ["Accommodation allowance", s.roomAllowance, "own accommodation — no company room"] : null,
          s.attendanceBonus ? ["Attendance bonus", s.attendanceBonus, "no leave or absence all month"] : null,
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
      h("div", { class: "muted", style: "font-size:12px;margin-top:8px" },
        "Employer contribution — PF " + money(emp.pf || 0) + " · ESI " + money(emp.esi || 0)
        // a worker asking "why no bonus this month?" gets the answer here
        + (s.attendanceBonusNote && !s.attendanceBonus ? " · Attendance bonus not earned: " + s.attendanceBonusNote : "")),
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
    if (a) body.appendChild(h("div", { class: "muted", style: "font-size:12px;margin-top:8px" },
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
        /* The instalment only reaches the payslip when the run is regenerated —
           but only THIS worker's slip changed, so regenerate just theirs. A
           blanket re-run would drag every active worker into what may well be
           a deliberately partial run. */
        if (run && run.status !== "Finalized") {
          await DB.hr.payroll.run(run.period, { force: true, workerIds: [s.workerId] });
        }
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
    load();
    /* this tab is one of the few that fetches on every render instead of
       reading ENG's in-memory dataset, so a stopped server or an expired
       session leaves it with nothing to draw — offer the retry in place */
    function load() {
      box.innerHTML = "";
      box.appendChild(h("div", { class: "muted", text: "Loading configuration…" }));
      DB.hr.config.get()
        .then((cfg) => renderSettings(box, cfg))
        .catch((e) => { box.innerHTML = ""; box.appendChild(MW.loadError("the HR configuration", e, load)); });
    }
  }
  function renderSettings(box, cfg) {
    const d = cfg.deductions || {};
    const pt = (d.pt && d.pt.slabs) || [{ upTo: 24999, amt: 0 }, { upTo: 999999999, amt: 200 }];
    const ptThreshold = (pt[0] && pt[0].upTo) || 24999;
    const ptAmount = (pt[pt.length - 1] && pt[pt.length - 1].amt) || 0;
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
      // not a choice any more: Sunday is the weekly off for every worker
      h("div", { style: "margin-top:8px" }, [h("label", { class: "muted", style: "font-size:11px;font-weight:700;text-transform:uppercase", text: "Weekly Off" }),
        h("div", { class: "flex aic gap wrap", style: "margin-top:6px" }, [
          h("span", { class: "chip", text: "☀️ Sunday" }),
          h("span", { class: "muted", style: "font-size:12px", text: "for every worker — pay divides the month by its working days, and a Sunday inside a leave is not a leave day" })])]),
    ]));

    // deductions
    grid.appendChild(h("div", { class: "card" }, [
      h("div", { class: "card-head" }, [h("h3", { text: "🏦 Statutory Deductions" }), h("div", { class: "sub", text: "Toggle each on/off and set the rate" })]),
      dedRow("PF (Provident Fund)", "pf", [["Rate %", "c_pf_rate", (d.pf || {}).rate], ["Wage Cap ₹/mo", "c_pf_cap", (d.pf || {}).wageCapMonthly], ["Employer %", "c_pf_emp", (d.pf || {}).employerRate]], (d.pf || {}).on),
      dedRow("ESI (State Insurance)", "esi", [["Employee %", "c_esi_rate", (d.esi || {}).empRate], ["Employer %", "c_esi_emp", (d.esi || {}).employerRate], ["Gross ≤ ₹", "c_esi_th", (d.esi || {}).grossThreshold]], (d.esi || {}).on),
      dedRow("Professional Tax (Karnataka)", "pt", [["Nil up to ₹", "c_pt_th", ptThreshold], ["Amount above ₹", "c_pt_amt", ptAmount]], (d.pt || {}).on),
    ]));

    /* THE PERKS, in ONE card and each under its own name. They were a card
       apiece and read as unrelated policies, but they are the same kind of
       thing: a flat sum paid on top of salary, counted in gross and never in
       the PF basic — so that shared rule is stated once, on the card, and
       each perk states only what is its own. */
    grid.appendChild(h("div", { class: "card" }, [
      h("div", { class: "card-head" }, [h("h3", { text: "🎁 Perks & Allowances" }),
        h("div", { class: "sub", text: "Paid on top of salary — each counts in gross (ESI), none in the PF basic" })]),
      h("div", { class: "perk-list" }, [
        perkRow("🏠", "Accommodation", "A company room, or this much extra",
          [["No-room allowance", "c_room", cfg.noRoomAllowance != null ? cfg.noRoomAllowance : 1000, "₹ / month"]],
          "Set per worker under Workers → Accommodation. Paid flat on top of salary in any month the worker was paid for at least one day."),
        perkRow("🏅", "Attendance Bonus", "A full month, once the worker is past their first months",
          [["Bonus", "c_abonus", cfg.attendanceBonus != null ? cfg.attendanceBonus : 1000, "₹ / month"],
           ["Qualifies after", "c_amonths", cfg.attendanceBonusAfterMonths != null ? cfg.attendanceBonusAfterMonths : 3, "months of service"]],
          "Earned by a worker who was present every working day of the month — no leave of either kind, no absence, no half day — counted from Joined On."),
      ]),
    ]));

    // leave — the monthly cap on paid days (the annual quota lives on the type)
    grid.appendChild(h("div", { class: "card" }, [
      h("div", { class: "card-head" }, [h("h3", { text: "🌴 Leave" }), h("div", { class: "sub", text: "Paid leave, per month" })]),
      h("div", { class: "form-grid" }, [
        U.field("Paid leave days allowed per month", `<input class="input" id="c_plcap" type="number" step="1" min="0" value="${cfg.paidLeaveMaxPerMonth != null ? cfg.paidLeaveMaxPerMonth : 1}">`),
      ]),
      h("p", { class: "dim", style: "font-size:12px;line-height:1.6;margin-top:8px",
        text: "Paid Leave accrues one day per month worked (the type below). In any one month only this many of a worker's paid-leave days are paid — the rest go unpaid and do not use the balance. Set 0 for no monthly limit." }),
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
      h("div", { class: "card-head" }, [h("h3", { text: "🗂 Leave Types" }), h("div", { class: "sub", text: "Two by ruling — Paid Leave (one day per month worked, at most one paid day taken a month) and Unpaid Leave" })]),
      table(lts, [
        { key: "id", label: "Code", render: (r) => `<span class="mono strong">${r.id}</span>`, noSort: true },
        { key: "name", label: "Name", cls: "nm", render: (r) => esc(r.name), noSort: true },
        { key: "quota", label: "Annual Quota", num: true, render: (r) => r.accrual === "earned" ? "1 day per month worked" : num(r.quota, 1) + " days", noSort: true },
        { key: "accrual", label: "Accrual", render: (r) => badge("mut", r.accrual), noSort: true },
        { key: "paid", label: "Paid", render: (r) => r.paid ? badge("ok", "Paid") : badge("mut", "Unpaid"), noSort: true },
        { key: "act", label: "", noSort: true, render: (r) => h("button", { class: "btn sm ghost", onclick: (e) => { e.stopPropagation(); delLeaveType(r); }, text: "🗑" }) },
      ], { onRow: (r) => leaveTypeForm(r), empty: "No leave types — add one with ＋ Leave Type" }),
    ]));

    /* ONE PERK, as its own tile: the icon, its name and what it is for, a badge
       saying what it is currently worth, its figures, and the rule underneath.
       Each field carries its unit (₹ / month, months of service) BESIDE the box
       rather than in a parenthesis in its label — the numbers are what the eye
       lands on and they were reading as bare digits.
       The badge is live: both perks are switched off by setting the money to 0,
       and a tile that says "Off" states that far more plainly than a lone zero
       in a box, which is why the notes no longer have to spell it out. */
    function perkRow(icon, label, sub, fields, note) {
      const moneyId = fields[0][1];
      const state = h("span", { class: "perk-state" });
      const box = h("div", { class: "perk" }, [
        h("div", { class: "perk-head" }, [
          h("span", { class: "perk-ic", text: icon }),
          h("div", { class: "perk-id" }, [
            h("b", { class: "perk-name", text: label }),
            h("span", { class: "perk-sub", text: sub })]),
          state,
        ]),
        h("div", { class: "perk-fields" }, fields.map(([lb, id, val, unit]) => h("label", { class: "perk-f" }, [
          h("span", { class: "perk-f-lbl", text: lb }),
          h("span", { class: "perk-f-in" }, [
            h("input", { class: "input", id, type: "number", step: "1", min: "0", value: val != null ? val : 0 }),
            h("span", { class: "perk-f-unit", text: unit })]),
        ]))),
        h("p", { class: "perk-note", text: note }),
      ]);
      const paint = () => {
        const el = box.querySelector("#" + moneyId);
        const amt = el ? Math.max(0, +el.value || 0) : 0;
        state.textContent = amt > 0 ? money(amt) + " / month" : "Off";
        state.classList.toggle("off", !(amt > 0));
        box.classList.toggle("is-off", !(amt > 0));
      };
      box.addEventListener("input", paint);
      paint();
      return box;
    }
    function dedRow(label, key, fields, on) {
      return h("div", { style: "padding:10px 0;border-bottom:1px solid var(--line)" }, [
        h("label", { class: "flex aic gap", style: "cursor:pointer;margin-bottom:8px" }, [
          h("input", { type: "checkbox", id: "c_" + key + "_on", checked: on ? "checked" : null }),
          h("b", { text: label })]),
        h("div", { class: "flex gap wrap ded-fields" }, fields.map(([lb, id, val]) => h("div", { class: "ded-f" }, [
          h("label", { class: "muted", style: "font-size:11px", text: lb }),
          h("input", { class: "input", id, type: "number", step: "0.01", value: val != null ? val : 0 })]))),
      ]);
    }
    function gv(id) { const el = UI.$("#" + id); return el ? el.value : ""; }
    function ck(id) { const el = UI.$("#" + id); return !!(el && el.checked); }
    function saveCfg() {
      const patch = {
        standardDayHours: +gv("c_std") || 8, otMultiplier: +gv("c_otm") || 2, halfDayBelowHours: +gv("c_half") || 4,
        deviceKey: gv("c_devkey").trim(), noRoomAllowance: Math.max(0, +gv("c_room") || 0),
        paidLeaveMaxPerMonth: Math.max(0, +gv("c_plcap") || 0),
        attendanceBonus: Math.max(0, +gv("c_abonus") || 0), attendanceBonusAfterMonths: Math.max(0, +gv("c_amonths") || 0),
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
      U.field("Accrual", U.selectHTML("lt_accrual", [{ v: "fixed", l: "Fixed (credited yearly)" }, { v: "earned", l: "Earned (1 day per month worked)" }, { v: "none", l: "None (0 balance)" }], t.accrual || "fixed")),
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
