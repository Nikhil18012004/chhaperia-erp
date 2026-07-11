/* ============================================================
   CHHAPERIA ERP — OPERATIONS · Lab Reports (QC certificates)
   Test certificates for finished goods. The parameters shown on a
   report depend on the product's material TYPE (water-blocking /
   semi-conductive / mica); the spec is held on the server and never
   shown here — the entry form captures measured values only, and the
   backend grades Pass/Fail on submit.

   Two views (segmented): "Test Reports" and "Products" (the lab
   product master; admin can also set the hidden spec there).
   Reports are graded server-side, so writes go through a reload
   (not optimistic) to bring back the computed result.
   ============================================================ */
(function () {
  "use strict";
  const { h, esc, table, badge, toast, modal, confirm } = UI;
  const { pageHead, kpi, searchInput, select } = MW;
  const U = window._erpUtil;

  // Parameter catalog — MUST mirror backend labService.PARAMS.
  const PARAMS = [
    { key: "tensile",           label: "Tensile",                  unit: "N/cm",      group: "common" },
    { key: "elongation",        label: "Elongation",               unit: "%",         group: "common" },
    { key: "thickness",         label: "Thickness",                unit: "mm",        group: "common" },
    { key: "massPerArea",       label: "Mass per unit area",       unit: "g/m²",      group: "common" },
    { key: "swellSpeed",        label: "Swelling speed",           unit: "mm/1 min",  group: "waterBlocking" },
    { key: "swellHeight3",      label: "Swelling height (3 min)",  unit: "mm/3 min",  group: "waterBlocking" },
    { key: "swellHeight10",     label: "Swelling height (10 min)", unit: "mm/10 min", group: "waterBlocking" },
    { key: "surfaceResistance", label: "Surface resistance",       unit: "Ω",         group: "semiConductive" },
    { key: "volumeResistance",  label: "Volume resistance",        unit: "kΩ·cm",     group: "semiConductive" },
    { key: "bdv",               label: "Breakdown voltage (BDV)",  unit: "kV/layer",  group: "mica" },
  ];
  const TYPE_TOGGLES = [
    { key: "waterBlocking",  label: "Water-blocking" },
    { key: "semiConductive", label: "Semi-conductive" },
    { key: "mica",           label: "Mica (BDV)" },
  ];

  const products = () => ENG.data.labProducts || [];
  const reports = () => ENG.data.labReports || [];
  const isAdmin = () => !!(App.isAdmin && App.isAdmin());
  const applicable = (flags) => { flags = flags || {}; return PARAMS.filter((p) => p.group === "common" || flags[p.group]); };
  const refLabel = (mode) => (mode === "lot" ? "Lot / W.O. No." : "Batch No.");
  const typeChips = (flags) => TYPE_TOGGLES.filter((t) => (flags || {})[t.key]).map((t) => `<span class="chip">${t.label}</span>`).join("") || `<span class="muted" style="font-size:11px">General</span>`;
  function resultBadge(r) { return r === "Pass" ? badge("ok", "Pass") : r === "Fail" ? badge("danger", "Fail") : badge("mut", "Pending"); }
  const prodById = (id) => products().find((p) => p.id === id);

  let VIEW = "reports";   // "reports" | "products" — persists across re-render

  /* Non-optimistic write: the server grades Pass/Fail, so reload state
     then re-render; optionally run a follow-up (e.g. show the result). */
  async function commit(apiCall, after) {
    try { const res = await apiCall(); await App.reloadState(); if (after) after(res); }
    catch (e) { toast("Save failed — " + (e.message || e), { type: "danger", title: "Sync error" }); }
  }

  M["lab-reports"] = { title: "Lab Reports", sub: "QC test certificates", render(root, params) {
    if (params && params.view) VIEW = params.view;

    const newBtn = VIEW === "reports"
      ? h("button", { class: "btn primary", onclick: () => reportForm(), html: "＋ New Report" })
      : h("button", { class: "btn primary", onclick: () => productForm(), html: "＋ New Product" });
    root.appendChild(pageHead("Lab Reports — Quality Control",
      "Test certificates for finished goods. The parameters on a report follow the product's material type; measured values are graded against the lab spec on submit.",
      [newBtn]));

    // segmented view switch
    const seg = h("div", { class: "flex gap", style: "margin-bottom:16px" }, [
      segBtn("reports", "🧪 Test Reports"),
      segBtn("products", "📦 Products"),
    ]);
    root.appendChild(seg);

    if (VIEW === "reports") renderReports(root); else renderProducts(root);

    if (params && params.openNew) { params.openNew = false; if (VIEW === "reports") reportForm(); else productForm(); }
  }};

  function segBtn(view, label) {
    const on = VIEW === view;
    return h("button", { class: "chip", style: "cursor:pointer;padding:8px 14px;font-weight:600;border:1.5px solid " + (on ? "var(--accent)" : "var(--line)") + (on ? ";color:var(--accent)" : ""),
      onclick: () => { VIEW = view; App.go("lab-reports"); }, text: label });
  }

  /* ============================================================
     TEST REPORTS
     ============================================================ */
  function renderReports(root) {
    let filter = { q: "", result: "all", series: "all" };
    const rs = reports();
    root.appendChild(h("div", { class: "grid kpi-grid", style: "margin-bottom:16px" }, [
      kpi({ icon: "🧪", label: "Total Reports", value: ENG.num(rs.length) }),
      kpi({ icon: "✅", label: "Passed", value: ENG.num(rs.filter((r) => r.result === "Pass").length) }),
      kpi({ icon: "⛔", label: "Failed", value: ENG.num(rs.filter((r) => r.result === "Fail").length) }),
      kpi({ icon: "⏳", label: "Pending Spec", value: ENG.num(rs.filter((r) => r.result !== "Pass" && r.result !== "Fail").length) }),
    ]));

    const seriesList = [...new Set(products().map((p) => p.series).filter(Boolean))].sort();
    root.appendChild(h("div", { class: "toolbar" }, [
      searchInput("Search product, code, batch / lot no…", (v) => { filter.q = v.toLowerCase(); draw(); }),
      select([{ value: "all", label: "All Results" }, { value: "Pass", label: "Pass" }, { value: "Fail", label: "Fail" }, { value: "Pending", label: "Pending" }], (v) => { filter.result = v; draw(); }),
      select([{ value: "all", label: "All Series" }, ...seriesList.map((s) => ({ value: s, label: s }))], (v) => { filter.series = v; draw(); }),
      h("div", { style: "margin-left:auto" }, h("span", { class: "chip", id: "lrCount" })),
    ]));
    const host = h("div"); root.appendChild(host);

    function rows() {
      return reports().filter((r) => {
        if (filter.result !== "all") { const grp = (r.result === "Pass" || r.result === "Fail") ? r.result : "Pending"; if (grp !== filter.result) return false; }
        if (filter.series !== "all") { const p = prodById(r.productId); if (!p || p.series !== filter.series) return false; }
        if (filter.q) { const s = (r.productName + " " + r.productCode + " " + (r.refNo || "") + " " + r.id + " " + (r.assignee || "")).toLowerCase(); if (!s.includes(filter.q)) return false; }
        return true;
      }).sort((a, b) => (a.reportDate < b.reportDate ? 1 : a.reportDate > b.reportDate ? -1 : (a.id < b.id ? 1 : -1)));
    }
    function draw() {
      const data = rows(); const c = UI.$("#lrCount"); if (c) c.textContent = data.length + " reports";
      host.innerHTML = "";
      if (!products().length) { host.appendChild(emptyBox("No lab products yet", "Add products under the Products tab, then create reports.")); return; }
      host.appendChild(table(data, [
        { key: "reportDate", label: "Date", width: "104px" },
        { key: "product", label: "Product", render: (r) => `<div style="font-weight:600">${esc(r.productCode || "—")}</div><div class="muted" style="font-size:11.5px">${esc(U.trim(r.productName, 40))}</div>`, sort: (r) => r.productCode || "" },
        { key: "ref", label: "Batch / Lot", render: (r) => `<div>${esc(r.refNo || "—")}</div><div class="muted" style="font-size:10.5px">${refLabel(r.refMode)}</div>`, sort: (r) => r.refNo || "" },
        { key: "type", label: "Type", noSort: true, render: (r) => `<div class="flex gap wrap">${typeChips(r.flags)}</div>` },
        { key: "result", label: "Result", width: "92px", render: (r) => resultBadge(r.result), sort: (r) => r.result },
        { key: "assignee", label: "Assignee", render: (r) => esc(r.assignee || "Pending"), sort: (r) => r.assignee || "" },
        { key: "act", label: "", noSort: true, width: "120px", render: (r) => actionCell([
          ["View", () => reportDetail(r)],
          ["Edit", () => reportForm(r)],
        ]) },
      ], { onRow: (r) => reportDetail(r), empty: "No reports match your filters", sort: "reportDate", dir: -1 }));
    }
    draw();
  }

  function reportDetail(r) {
    const rowsHtml = applicable(r.flags).map((p) => {
      const v = (r.values || {})[p.key];
      const res = (r.results || {})[p.key];
      const cell = v == null || v === "" ? `<span class="muted">—</span>` : `${esc(String(v))} <span class="muted" style="font-size:10.5px">${p.unit}</span>`;
      const verdict = res === "pass" ? badge("ok", "Pass") : res === "fail" ? badge("danger", "Fail") : res === "na" ? `<span class="muted" style="font-size:11px">no spec</span>` : "";
      return `<tr><td style="padding:6px 10px">${esc(p.label)}</td><td class="num" style="padding:6px 10px">${cell}</td><td style="padding:6px 10px">${verdict}</td></tr>`;
    }).join("");
    const body = h("div", {}, [
      h("div", { class: "flex between aic", style: "margin-bottom:12px" }, [
        h("div", {}, [h("div", { style: "font-weight:700;font-size:15px", text: r.productCode + " · " + r.productName }),
          h("div", { class: "muted", style: "font-size:12px", text: refLabel(r.refMode) + " " + (r.refNo || "—") + " · " + r.reportDate + " · " + r.id })]),
        h("div", { html: resultBadge(r.result) }),
      ]),
      h("div", { class: "flex gap wrap", style: "margin-bottom:12px", html: typeChips(r.flags) }),
      h("div", { class: "table-wrap" }, h("div", { html: `<table class="tbl"><thead><tr><th style="text-align:left">Parameter</th><th class="num">Measured</th><th style="text-align:left">Verdict</th></tr></thead><tbody>${rowsHtml}</tbody></table>` })),
      r.result === "Pending" ? h("div", { class: "muted", style: "font-size:12px;margin-top:10px", text: "⏳ No lab spec set for these parameters yet — result will grade automatically once the spec (from the TDS) is loaded." }) : null,
      MW.dl([["Assignee", r.assignee || "Pending"], ["Tested by", r.testedBy || "—"], ["Remarks", r.remarks || "—"]]),
    ]);
    const mo = modal({ title: "Lab Report " + r.id, sub: r.productCode + " · " + r.reportDate, wide: true, body,
      foot: [h("button", { class: "btn danger", onclick: () => delReport(r, mo), text: "🗑 Delete" }),
        h("button", { class: "btn ghost", onclick: () => { mo.close(); reportForm(r); }, text: "✎ Edit" }),
        h("button", { class: "btn primary", onclick: () => mo.close(), text: "Close" })] });
  }

  async function delReport(r, mo) {
    if (!await confirm(`Delete lab report ${r.id} (${r.productCode})?`, { title: "Delete Report", danger: true })) return;
    if (mo) mo.close();
    commit(() => DB.labReports.remove(r.id), () => toast("Report " + r.id + " deleted", { type: "ok", title: "Removed" }));
  }

  function reportForm(existing) {
    const edit = !!existing;
    if (!products().length) { toast("Add a product first (Products tab)", { type: "warn" }); return; }
    const list = products().slice().sort((a, b) => (a.series + a.code).localeCompare(b.series + b.code));
    let prod = edit ? (prodById(existing.productId) || list[0]) : list[0];
    // working flags: report's own (edit) or the product's derived flags
    let flags = Object.assign({ mica: false, waterBlocking: false, semiConductive: false }, edit ? existing.flags : prod.flags);
    const vals = Object.assign({}, edit ? existing.values : {});

    const prodOpts = list.map((p) => ({ v: p.id, l: U.trim((p.code || p.name) + " — " + p.name + " (" + (p.thickness || "—") + ")", 60) }));

    const body = h("div", {}, [
      h("div", { class: "form-grid" }, [
        U.field("Product", U.selectHTML("lr_prod", prodOpts, prod.id), "full"),
        U.field("Reference No.",
          `<input class="input" id="lr_ref" value="${esc(edit ? existing.refNo || "" : "")}" placeholder="e.g. B-2026-0142"><div class="muted" id="lr_refmode" style="font-size:10.5px;margin-top:3px">${refLabel(prod.refMode)}</div>`),
        U.field("Report Date", `<input class="input" id="lr_date" type="date" value="${edit ? esc(existing.reportDate) : DB.helpers.iso(DB.helpers.today())}">`),
      ]),
      h("div", { style: "margin:6px 0 4px" }, [
        h("label", { class: "muted", style: "font-size:11px;font-weight:700;text-transform:uppercase", text: "Applicable test parameters" }),
        h("div", { class: "muted", style: "font-size:11px", text: "Toggles pre-set from the product type; adjust if this batch differs." }),
      ]),
      h("div", { class: "flex gap wrap", id: "lr_toggles", style: "margin:8px 0 4px" }, TYPE_TOGGLES.map((t) => h("label", { class: "chip", style: "cursor:pointer" }, [
        h("input", { type: "checkbox", "data-flag": t.key, checked: flags[t.key] ? "checked" : null }), " " + t.label]))),
      h("div", { id: "lr_params", class: "form-grid", style: "margin-top:8px" }),
      h("h3", { style: "margin:14px 0 8px;font-size:13px", text: "Sign-off" }),
      h("div", { class: "form-grid" }, [
        U.field("Assignee", `<input class="input" id="lr_assignee" value="${esc(edit ? existing.assignee || "" : "")}" placeholder="Pending">`),
        U.field("Tested by", `<input class="input" id="lr_by" value="${esc(edit ? existing.testedBy || "" : "")}">`),
        U.field("Remarks", `<input class="input" id="lr_remarks" value="${esc(edit ? existing.remarks || "" : "")}">`, "full"),
      ]),
    ]);

    const mo = modal({ title: edit ? "Edit Lab Report" : "New Lab Report", sub: edit ? existing.id : "Enter measured values — Pass/Fail is graded on submit", wide: true, body,
      foot: [h("button", { class: "btn ghost", onclick: () => mo.close(), text: "Cancel" }),
        h("button", { class: "btn primary", onclick: doSave, text: edit ? "Save & Re-grade" : "Submit Report" })] });

    // read current values from the (about-to-be-replaced) param inputs into `vals`
    function captureValues() { PARAMS.forEach((p) => { const el = UI.$("#lrv_" + p.key); if (el) { const v = el.value.trim(); if (v === "") delete vals[p.key]; else vals[p.key] = v; } }); }

    function rebuildParams() {
      const host = UI.$("#lr_params"); if (!host) return;
      host.innerHTML = "";
      applicable(flags).forEach((p) => {
        const v = vals[p.key] != null ? vals[p.key] : "";
        host.insertAdjacentHTML("beforeend",
          `<div class="field"><label>${esc(p.label)} <span class="muted" style="font-weight:500">(${p.unit})</span></label><div><input class="input" id="lrv_${p.key}" type="number" step="any" value="${esc(String(v))}"></div></div>`);
      });
    }
    rebuildParams();

    // product change → adopt its flags + ref label, keep entered values
    UI.$("#lr_prod").addEventListener("change", (e) => {
      captureValues();
      prod = prodById(e.target.value) || prod;
      flags = Object.assign({ mica: false, waterBlocking: false, semiConductive: false }, prod.flags);
      UI.$("#lr_toggles").querySelectorAll("input[data-flag]").forEach((cb) => { cb.checked = !!flags[cb.getAttribute("data-flag")]; });
      const lbl = UI.$("#lr_refmode"); if (lbl) lbl.textContent = refLabel(prod.refMode);
      rebuildParams();
    });
    // toggle change → show/hide param groups
    UI.$("#lr_toggles").addEventListener("change", (e) => {
      const cb = e.target.closest("input[data-flag]"); if (!cb) return;
      captureValues();
      flags[cb.getAttribute("data-flag")] = cb.checked;
      rebuildParams();
    });

    function doSave() {
      captureValues();
      const refNo = (UI.$("#lr_ref").value || "").trim();
      if (!refNo) { toast(refLabel(prod.refMode) + " is required", { type: "warn" }); return; }
      const values = {};
      applicable(flags).forEach((p) => { if (vals[p.key] != null && vals[p.key] !== "") values[p.key] = +vals[p.key]; });
      const payload = {
        productId: prod.id, refNo, reportDate: UI.$("#lr_date").value || DB.helpers.iso(DB.helpers.today()),
        flags: { mica: !!flags.mica, waterBlocking: !!flags.waterBlocking, semiConductive: !!flags.semiConductive },
        values, assignee: (UI.$("#lr_assignee").value || "").trim() || "Pending",
        testedBy: (UI.$("#lr_by").value || "").trim(), remarks: (UI.$("#lr_remarks").value || "").trim(),
      };
      mo.close();
      commit(() => edit ? DB.labReports.update(existing.id, payload) : DB.labReports.create(payload), (saved) => {
        toast("Report " + (saved && saved.id ? saved.id : "") + " — " + (saved ? saved.result : ""), { type: saved && saved.result === "Fail" ? "danger" : "ok", title: edit ? "Re-graded" : "Submitted" });
        if (saved) reportDetail(saved);
      });
    }
  }

  /* ============================================================
     PRODUCTS (lab master)
     ============================================================ */
  function renderProducts(root) {
    let filter = { q: "", series: "all", type: "all" };
    const ps = products();
    root.appendChild(h("div", { class: "grid kpi-grid", style: "margin-bottom:16px" }, [
      kpi({ icon: "📦", label: "Products", value: ENG.num(ps.length) }),
      kpi({ icon: "💧", label: "Water-blocking", value: ENG.num(ps.filter((p) => p.flags && p.flags.waterBlocking).length) }),
      kpi({ icon: "⚡", label: "Semi-conductive", value: ENG.num(ps.filter((p) => p.flags && p.flags.semiConductive).length) }),
      kpi({ icon: "🔬", label: "Mica (BDV)", value: ENG.num(ps.filter((p) => p.flags && p.flags.mica).length) }),
    ]));
    const seriesList = [...new Set(ps.map((p) => p.series).filter(Boolean))].sort();
    root.appendChild(h("div", { class: "toolbar" }, [
      searchInput("Search product name or code…", (v) => { filter.q = v.toLowerCase(); draw(); }),
      select([{ value: "all", label: "All Series" }, ...seriesList.map((s) => ({ value: s, label: s }))], (v) => { filter.series = v; draw(); }),
      select([{ value: "all", label: "All Types" }, { value: "waterBlocking", label: "Water-blocking" }, { value: "semiConductive", label: "Semi-conductive" }, { value: "mica", label: "Mica" }], (v) => { filter.type = v; draw(); }),
      h("div", { style: "margin-left:auto" }, h("span", { class: "chip", id: "lpCount" })),
    ]));
    const host = h("div"); root.appendChild(host);

    function rows() {
      return products().filter((p) => {
        if (filter.series !== "all" && p.series !== filter.series) return false;
        if (filter.type !== "all" && !(p.flags && p.flags[filter.type])) return false;
        if (filter.q) { const s = (p.name + " " + (p.code || "") + " " + (p.series || "")).toLowerCase(); if (!s.includes(filter.q)) return false; }
        return true;
      }).sort((a, b) => (a.series + a.code).localeCompare(b.series + b.code));
    }
    function draw() {
      const data = rows(); const c = UI.$("#lpCount"); if (c) c.textContent = data.length + " products";
      host.innerHTML = "";
      host.appendChild(table(data, [
        { key: "code", label: "Code / Type", width: "170px", render: (p) => `<span style="font-weight:600">${esc(p.code || "—")}</span>` },
        { key: "name", label: "Product", render: (p) => esc(U.trim(p.name, 46)) },
        { key: "thickness", label: "Thk (mm)", width: "90px", render: (p) => esc(p.thickness || "—") },
        { key: "series", label: "Series", width: "130px", render: (p) => esc(p.series || "—") },
        { key: "type", label: "Type", noSort: true, render: (p) => `<div class="flex gap wrap">${typeChips(p.flags)}</div>` },
        { key: "ref", label: "Ref", width: "84px", render: (p) => refLabel(p.refMode).replace(" No.", ""), sort: (p) => p.refMode },
        { key: "spec", label: "Spec", width: "70px", noSort: true, render: (p) => p.spec && Object.keys(p.spec).length ? badge("ok", "set") : badge("mut", "—") },
        { key: "act", label: "", noSort: true, width: "80px", render: (p) => actionCell([["Edit", () => productForm(p)]]) },
      ], { onRow: (p) => productForm(p), empty: "No products match your filters" }));
    }
    draw();
  }

  function productForm(existing) {
    const edit = !!existing;
    const p = existing || { refMode: "batch", flags: {}, series: "Other", active: true };
    const f = (k, d) => (p[k] != null ? p[k] : (d == null ? "" : d));
    const flags = Object.assign({ mica: false, waterBlocking: false, semiConductive: false }, p.flags);
    const admin = isAdmin();

    const body = h("div", {}, [
      h("div", { class: "form-grid" }, [
        U.field("Product Name", `<input class="input" id="lp_name" value="${esc(f("name"))}" placeholder="e.g. NON CONDUCTIVE WATER BLOCKING TAPE">`, "full"),
        U.field("Code / Type", `<input class="input" id="lp_code" value="${esc(f("code"))}" placeholder="e.g. CHDNW-20">`),
        U.field("Thickness (mm)", `<input class="input" id="lp_thk" value="${esc(f("thickness"))}" placeholder="e.g. 0.2">`),
        U.field("Series", `<input class="input" id="lp_series" value="${esc(f("series", "Other"))}">`),
        U.field("Reference Mode", U.selectHTML("lp_ref", [{ v: "batch", l: "Batch No. (stocked / repeat orders)" }, { v: "lot", l: "Lot / W.O. No. (made-to-order)" }], f("refMode", "batch"))),
      ]),
      h("h3", { style: "margin:14px 0 8px;font-size:13px", text: "Material Type (drives which test parameters apply)" }),
      h("div", { class: "flex gap wrap", id: "lp_flags" }, TYPE_TOGGLES.map((t) => h("label", { class: "chip", style: "cursor:pointer" }, [
        h("input", { type: "checkbox", "data-flag": t.key, checked: flags[t.key] ? "checked" : null }), " " + t.label]))),
      h("div", { class: "muted", style: "font-size:11px;margin-top:6px", text: "Tip: leave all unticked for a general tape (common parameters only)." }),
      specSection(),
    ]);

    const mo = modal({ title: edit ? "Edit Product" : "New Lab Product", sub: edit ? p.id : "Add to the lab product master", wide: true, body,
      foot: [
        edit ? h("button", { class: "btn danger", onclick: () => delProduct(p, mo), text: "🗑 Delete" }) : null,
        h("button", { class: "btn ghost", onclick: () => mo.close(), text: "Cancel" }),
        h("button", { class: "btn primary", onclick: doSave, text: edit ? "Save Changes" : "Create Product" }),
      ].filter(Boolean) });

    function readFlags() { const o = {}; UI.$("#lp_flags").querySelectorAll("input[data-flag]").forEach((cb) => { o[cb.getAttribute("data-flag")] = cb.checked; }); return o; }

    // Admin-only spec editor (hidden from the report entry form entirely).
    function specSection() {
      if (!admin) return h("div", { class: "muted", style: "font-size:11.5px;margin-top:14px", text: "🔒 Lab spec (min/max limits) is managed by admin and used to grade reports Pass/Fail." });
      return h("div", { style: "margin-top:16px" }, [
        h("h3", { style: "margin:6px 0 4px;font-size:13px", text: "Lab Spec (backend only — hidden from data entry)" }),
        h("div", { class: "muted", style: "font-size:11px;margin-bottom:8px", text: "Min/Max limits per parameter. Leave blank to skip a bound. Reports grade Pass/Fail against these." }),
        h("div", { id: "lp_spec" }),
      ]);
    }
    function rebuildSpec() {
      if (!admin) return;
      const host = UI.$("#lp_spec"); if (!host) return;
      const fl = readFlags(); const spec = p.spec || {};
      host.innerHTML = "";
      applicable(fl).forEach((par) => {
        const sp = spec[par.key] || {};
        host.insertAdjacentHTML("beforeend",
          `<div class="flex gap aic" style="margin-bottom:6px"><div style="flex:1;font-size:12.5px">${esc(par.label)} <span class="muted">(${par.unit})</span></div>` +
          `<input class="input" id="sp_min_${par.key}" type="number" step="any" placeholder="min" style="width:110px" value="${sp.min != null ? esc(String(sp.min)) : ""}">` +
          `<input class="input" id="sp_max_${par.key}" type="number" step="any" placeholder="max" style="width:110px" value="${sp.max != null ? esc(String(sp.max)) : ""}"></div>`);
      });
    }
    rebuildSpec();
    UI.$("#lp_flags").addEventListener("change", rebuildSpec);

    function collectSpec() {
      if (!admin) return p.spec || {};
      const fl = readFlags(); const spec = {};
      applicable(fl).forEach((par) => {
        const mn = UI.$("#sp_min_" + par.key), mx = UI.$("#sp_max_" + par.key);
        const o = {};
        if (mn && mn.value.trim() !== "") o.min = +mn.value;
        if (mx && mx.value.trim() !== "") o.max = +mx.value;
        if (o.min != null || o.max != null) spec[par.key] = o;
      });
      return spec;
    }

    function doSave() {
      const name = (UI.$("#lp_name").value || "").trim();
      if (!name) { toast("Product name is required", { type: "warn" }); return; }
      const payload = {
        name, code: (UI.$("#lp_code").value || "").trim(), thickness: (UI.$("#lp_thk").value || "").trim(),
        series: (UI.$("#lp_series").value || "").trim() || "Other", refMode: UI.$("#lp_ref").value,
        flags: readFlags(), spec: collectSpec(),
      };
      mo.close();
      commit(() => edit ? DB.labProducts.update(p.id, payload) : DB.labProducts.create(payload),
        () => toast(name + (edit ? " updated" : " added"), { type: "ok" }));
    }
  }

  async function delProduct(p, mo) {
    const used = reports().filter((r) => r.productId === p.id).length;
    const msg = used ? `Delete ${p.code || p.name}? ${used} report(s) reference it (they will remain but lose the product link).` : `Delete product ${p.code || p.name}?`;
    if (!await confirm(msg, { title: "Delete Product", danger: true })) return;
    if (mo) mo.close();
    commit(() => DB.labProducts.remove(p.id), () => toast((p.code || p.name) + " deleted", { type: "ok", title: "Removed" }));
  }

  /* ---------- small helpers ---------- */
  function actionCell(actions) {
    return h("div", { class: "flex gap" }, actions.map(([label, fn]) =>
      h("button", { class: "btn ghost", style: "padding:4px 9px;font-size:12px", onclick: (e) => { e.stopPropagation(); fn(); }, text: label })));
  }
  function emptyBox(title, sub) {
    return h("div", { class: "empty", style: "margin-top:24px" }, [h("div", { class: "big", text: "🧪" }),
      h("div", { style: "font-weight:700", text: title }), h("div", { class: "muted", style: "margin-top:6px", text: sub })]);
  }

  // ⌘K quick action
  window.ERPActions = Object.assign(window.ERPActions || {}, {
    newLabReport: { ic: "🧪", label: "New Lab Report", run: () => App.go("lab-reports", { view: "reports", openNew: true }) },
  });
})();
