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

  /* WHICH PARAMETERS A REPORT CARRIES — mirrors labService.paramsForProduct.
     The Products master is the authority: a product is tested on exactly the
     parameters its spec states a limit for. Admin holds the limits themselves;
     everyone else gets `specKeys`, the same list with the numbers withheld.
     A product whose spec has not been loaded yet falls back to its material
     type, so it stays measurable instead of having no parameters at all. */
  const hasLimit = (s) => !!s && (s.min != null || s.max != null || s.nominal != null || s.unparsed != null);
  function specKeysOf(p) {
    if (!p) return [];
    if (Array.isArray(p.specKeys)) return p.specKeys;
    return Object.keys(p.spec || {}).filter((k) => hasLimit(p.spec[k]));
  }
  function paramsFor(product, flags) {
    const keys = specKeysOf(product);
    const picked = PARAMS.filter((p) => keys.indexOf(p.key) >= 0);
    return picked.length ? picked : applicable(flags || (product || {}).flags);
  }
  /* the rows a SAVED report shows: the parameters it was written against,
     falling back to the product's current list for reports made before the
     parameter set was recorded on the certificate */
  function paramsForReport(r) {
    const keys = Array.isArray(r && r.paramKeys) ? r.paramKeys : null;
    if (keys && keys.length) return PARAMS.filter((p) => keys.indexOf(p.key) >= 0);
    return paramsFor(prodById(r && r.productId), r && r.flags);
  }
  const refLabel = (mode) => (mode === "lot" ? "Lot / W.O. No." : "Batch No.");
  const typeChips = (flags) => TYPE_TOGGLES.filter((t) => (flags || {})[t.key]).map((t) => `<span class="chip">${t.label}</span>`).join("") || `<span class="muted" style="font-size:11px">General</span>`;
  function resultBadge(r) { return r === "Pass" ? badge("ok", "Pass") : r === "Fail" ? badge("danger", "Fail") : badge("mut", "Pending"); }
  const prodById = (id) => products().find((p) => p.id === id);

  let VIEW = "reports";   // "reports" | "products" — persists across re-render
  // within Test Reports: the worklist, the finished certificates, or everything
  let TAB = "pending";    // "pending" | "done" | "all"

  /* Non-optimistic write: the server grades Pass/Fail, so reload state
     then re-render; optionally run a follow-up (e.g. show the result). */
  async function commit(apiCall, after) {
    try { const res = await apiCall(); await App.reloadState(); if (after) after(res); }
    catch (e) { toast("Save failed — " + (e.message || e), { type: "danger", title: "Sync error" }); }
  }

  /* The complaint screen prints a batch's lab reading with these same labels
     and units. Sharing the catalogue keeps it to two copies (this one and the
     backend's) rather than three that would drift apart. */
  M["lab-reports"] = { title: "Lab Reports", sub: "QC test certificates", PARAMS, render(root, params) {
    if (params && params.view) VIEW = params.view;

    /* THE LAB INCHARGE HAS ONE JOB: measure the batches waiting on him. His
       page is that worklist and nothing else — no product master, no archive
       of finished certificates, and no way to raise a report against a batch
       nobody made. A certificate leaves his list the moment he files it.
       Everyone else gets the full three-tab view. */
    const labOnly = App.isLab();
    if (labOnly) VIEW = "reports";

    /* No "New Report" button anywhere: a certificate is only ever raised
       against a real batch — by the coating floor, by whoever books finished
       stock, or by the incharge working this list. There is nothing left for
       a blank form to be for. */
    const newBtn = (!labOnly && VIEW === "products")
      ? h("button", { class: "btn primary", onclick: () => productForm(), html: "＋ New Product" })
      : null;
    root.appendChild(pageHead(
      labOnly ? "Lab Reports" : "Lab Reports — Quality Control",
      labOnly
        ? "Pending lists every batch awaiting a reading; enter the measured values against a batch number and it moves to Completed. Values are graded against the product's TDS spec on submit."
        : "Test certificates for finished goods. A report carries the parameters this product's entry under Products states a limit for; measured values are graded against that spec on submit.",
      // the Excel menu follows the visible tab: certificates vs the product master
      labOnly ? [] : [MW.excelMenu(VIEW === "reports" ? "labreports" : "labproducts"), newBtn].filter(Boolean)));

    // segmented view switch — the incharge has only the one view
    if (!labOnly) {
      root.appendChild(h("div", { class: "flex gap", style: "margin-bottom:16px" }, [
        segBtn("reports", "🧪 Test Reports"),
        segBtn("products", "📦 Products"),
      ]));
    }

    /* Incoming-material testing is NOT shown here. It lives in Procurement,
       against the goods receipt that brought the material in — that is where the
       delivery, the supplier and the receipt document already are, and a second
       worklist on this page only split the same job across two screens. This
       page is the finished-goods certificates and nothing else. */
    if (VIEW === "reports") renderReports(root, labOnly); else renderProducts(root);

    if (params && params.openNew) { params.openNew = false; if (!labOnly && VIEW === "products") productForm(); }
    if (params && params.openPending) { params.openPending = false; pendingModal(); return; }
    // the incharge is told what is waiting the first time they land here
    maybeAnnouncePending();
  }};

  function segBtn(view, label) {
    const on = VIEW === view;
    return h("button", { class: "chip", style: "cursor:pointer;padding:8px 14px;font-weight:600;border:1.5px solid " + (on ? "var(--accent)" : "var(--line)") + (on ? ";color:var(--accent)" : ""),
      onclick: () => { VIEW = view; App.go("lab-reports"); }, text: label });
  }

  /* ============================================================
     PENDING LAB WORK
     A work order IS a batch, so every open job is a certificate the
     lab still owes a reading on. The list is computed server-side
     (labService.pendingLabWork) so the floor, the incharge and the
     office all read the same worklist.
     `stage` says who is holding it up: "production" — the coating
     floor has not measured the batch it just ran; "lab" — it is the
     incharge's turn.
     ============================================================ */
  const pending = () => ENG.data.labPending || [];
  const pendingForLab = () => pending().filter((p) => p.stage === "lab");

  function openPending(row) {
    const rep = row.reportId ? reports().find((r) => r.id === row.reportId) : null;
    if (rep) reportForm(rep);
    else reportForm(null, { productId: (row.product || {}).id, refNo: row.batchNo, woId: row.woId });
  }

  function pendingRows(list) {
    return table(list, [
      { key: "wo", label: "W.O. / Batch", width: "132px",
        render: (r) => `<div style="font-weight:700">${esc(r.batchNo)}</div><div class="muted" style="font-size:10.5px">${esc(r.woId)}</div>`,
        sort: (r) => r.woId },
      { key: "product", label: "Product", cls: "nm",
        render: (r) => `<div style="font-weight:600">${esc(r.productCode || "—")}</div><div class="muted" style="font-size:11.5px">${esc(U.trim(r.productName || "", 40))}</div>`,
        sort: (r) => r.productCode || "" },
      { key: "qty", label: "Qty", width: "84px", render: (r) => (r.qty == null ? "—" : ENG.num(r.qty)), sort: (r) => r.qty || 0 },
      { key: "floor", label: "Production", width: "116px", noSort: true,
        render: (r) => !r.coating ? `<span class="muted" style="font-size:11px">n/a</span>`
          : r.prodComplete ? badge("ok", "entered") : badge("warn", "awaiting") },
      { key: "lab", label: "Lab", width: "104px", noSort: true,
        render: (r) => r.labComplete ? badge("ok", "entered") : badge("mut", "awaiting") },
      { key: "need", label: "Still to measure", noSort: true,
        render: (r) => { const m = r.stage === "production" ? r.missingProd : r.missingLab;
          return m && m.length ? `<span class="muted" style="font-size:11.5px">${esc(m.join(", "))}</span>`
            : `<span class="muted" style="font-size:11.5px">—</span>`; } },
      { key: "act", label: "", noSort: true, width: "116px",
        render: (r) => actionCell([[r.reportId ? "Update" : "Enter", () => openPending(r)]]) },
    ], { onRow: openPending, sort: "wo", dir: -1,
      empty: "Nothing outstanding — every open job has been measured" });
  }

  /* The incharge is told once per sign-in what is waiting, rather than having
     to remember to look. Also reachable any time from the page head. */
  function pendingModal() {
    const list = pending();
    if (!list.length) { toast("No lab work pending — every open job has been measured", { type: "ok" }); return; }
    const past = pendingForLab().length;
    const mo = modal({ title: "🧪 Pending lab work", wide: true,
      sub: list.length + " batch" + (list.length === 1 ? "" : "es") + " awaiting a reading"
        + (past !== list.length ? " · " + past + " past slitting" : ""),
      body: h("div", {}, [
        h("div", { class: "muted", style: "font-size:12px;margin-bottom:12px;line-height:1.6",
          html: "Each work order is a batch. Enter the measured values against its batch number — the readings are graded against the product's TDS spec automatically." }),
        pendingRows(list),
      ]),
      foot: [h("button", { class: "btn primary", onclick: () => mo.close(), text: "Close" })] });
  }

  /* shown once per sign-in; the flag is per user so a shared machine still
     prompts the next person to log in */
  function maybeAnnouncePending() {
    if (!App.isLab()) return;
    if (!pending().length) return;
    const key = "chh_labpending_" + ((App.user && App.user.username) || "?");
    try { if (sessionStorage.getItem(key)) return; sessionStorage.setItem(key, "1"); } catch { /* private mode */ }
    setTimeout(pendingModal, 350);
  }

  /* ============================================================
     TEST REPORTS
     ============================================================ */
  function renderReports(root, labOnly) {
    let filter = { q: "", result: "all", series: "all" };
    const rs = reports();
    /* The incharge sees EVERY outstanding batch, the same list the office
       sees — he may enter a reading whether or not the coating floor has
       filed theirs. (The two-stage design would have shown him only the
       batches past slitting; the factory wants one worklist.) */
    const pend = pending();
    // he has two states, not three: still to do, and done. "All" is an
    // archive view and belongs to whoever reads certificates.
    if (labOnly && TAB === "all") TAB = "pending";

    /* No Pass/Fail anywhere in his view — see stateForLab. His numbers are
       about work done, not about verdicts. */
    root.appendChild(h("div", { class: "grid kpi-grid", style: "margin-bottom:16px" }, labOnly ? [
      kpi({ icon: "🧪", label: "Pending", value: ENG.num(pend.length) }),
      kpi({ icon: "🎨", label: "Awaiting the floor", value: ENG.num(pend.filter((p) => p.stage === "production").length) }),
      kpi({ icon: "✅", label: "Filed by you", value: ENG.num(rs.filter(reportDone).length) }),
    ] : [
      kpi({ icon: "🧪", label: "Pending", value: ENG.num(pend.length) }),
      kpi({ icon: "✅", label: "Passed", value: ENG.num(rs.filter((r) => r.result === "Pass").length) }),
      kpi({ icon: "⛔", label: "Failed", value: ENG.num(rs.filter((r) => r.result === "Fail").length) }),
      kpi({ icon: "🗂", label: "Total Reports", value: ENG.num(rs.length) }),
    ]));

    /* Pending / Completed / All — the same three-way split the Production
       board uses, so the worklist and the archive live on one page instead of
       a panel stacked above a table. The incharge gets no switch: a batch he
       has filed is done with, and belongs to whoever reads the certificates. */
    const seg = h("div", { class: "seg", style: "margin-bottom:14px" });
    const segBtn2 = (label, key) => {
      const b = h("button", { class: TAB === key ? "on" : "", text: label,
        onclick: () => { TAB = key; [...seg.children].forEach((c) => c.classList.remove("on")); b.classList.add("on"); draw(); } });
      return b;
    };
    seg.appendChild(segBtn2("Pending" + (pend.length ? " (" + pend.length + ")" : ""), "pending"));
    seg.appendChild(segBtn2("Completed", "done"));
    if (!labOnly) seg.appendChild(segBtn2("All", "all"));
    root.appendChild(seg);

    const seriesList = [...new Set(products().map((p) => p.series).filter(Boolean))].sort();
    root.appendChild(h("div", { class: "toolbar" }, [
      searchInput(labOnly ? "Search batch, W.O. no., product…" : "Search product, code, batch / lot no…",
        (v) => { filter.q = v.toLowerCase(); draw(); }),
      labOnly ? null : select([{ value: "all", label: "All Results" }, { value: "Pass", label: "Pass" }, { value: "Fail", label: "Fail" }, { value: "Pending", label: "Pending" }], (v) => { filter.result = v; draw(); }),
      select([{ value: "all", label: "All Series" }, ...seriesList.map((s) => ({ value: s, label: s }))], (v) => { filter.series = v; draw(); }),
      h("div", { style: "margin-left:auto" }, h("span", { class: "chip", id: "lrCount" })),
    ].filter(Boolean)));
    const host = h("div"); root.appendChild(host);

    /* A certificate is COMPLETE once the lab incharge's own reading covers
       every parameter — the floor's measurement alone leaves it half-done. */
    function reportDone(r) {
      if (typeof r.labComplete === "boolean") return r.labComplete;
      const ps = paramsForReport(r);
      return ps.length > 0 && ps.every((p) => (r.labValues || {})[p.key] != null);
    }
    function matchesQ(hay) { return !filter.q || hay.toLowerCase().includes(filter.q); }

    function rows() {
      return reports().filter((r) => {
        if (TAB === "done" && !reportDone(r)) return false;
        if (filter.result !== "all") { const grp = (r.result === "Pass" || r.result === "Fail") ? r.result : "Pending"; if (grp !== filter.result) return false; }
        if (filter.series !== "all") { const p = prodById(r.productId); if (!p || p.series !== filter.series) return false; }
        if (!matchesQ(r.productName + " " + r.productCode + " " + (r.refNo || "") + " " + r.id + " " + (r.assignee || ""))) return false;
        return true;
      }).sort((a, b) => (a.reportDate < b.reportDate ? 1 : a.reportDate > b.reportDate ? -1 : (a.id < b.id ? 1 : -1)));
    }
    function pendRows() {
      return pend.filter((p) => filter.series === "all"
        ? true : ((prodById((p.product || {}).id) || {}).series === filter.series))
        .filter((p) => matchesQ((p.productName || "") + " " + (p.productCode || "") + " " + p.batchNo + " " + p.woId));
    }

    function draw() {
      const c = UI.$("#lrCount");
      host.innerHTML = "";
      if (!products().length) { host.appendChild(emptyBox("No lab products yet", "Add products under the Products tab, then create reports.")); if (c) c.textContent = "0"; return; }
      if (TAB === "pending") {
        const data = pendRows();
        if (c) c.textContent = data.length + " batch" + (data.length === 1 ? "" : "es");
        const mineCount = data.filter((p) => p.stage === "lab").length;
        host.appendChild(h("div", { class: "muted", style: "font-size:11.5px;margin-bottom:10px",
          text: data.length
            ? mineCount + " past slitting · " + (data.length - mineCount) + " the coating floor has not measured yet"
            : "" }));
        host.appendChild(pendingRows(data));
        return;
      }
      const data = rows();
      if (c) c.textContent = data.length + " report" + (data.length === 1 ? "" : "s");
      host.appendChild(table(data, [
        { key: "reportDate", label: "Date", width: "104px" },
        { key: "product", label: "Product", cls: "nm", render: (r) => `<div style="font-weight:600">${esc(r.productCode || "—")}</div><div class="muted" style="font-size:11.5px">${esc(U.trim(r.productName, 40))}</div>`, sort: (r) => r.productCode || "" },
        { key: "ref", label: "Batch / Lot", render: (r) => `<div>${esc(r.refNo || "—")}</div><div class="muted" style="font-size:10.5px">${refLabel(r.refMode)}</div>`, sort: (r) => r.refNo || "" },
        { key: "type", label: "Type", noSort: true, render: (r) => `<div class="flex gap wrap">${typeChips(r.flags)}</div>` },
        // the verdict is not the tester's business — see stateForLab
        { key: "result", label: "Result", width: "92px", hide: labOnly, render: (r) => resultBadge(r.result), sort: (r) => r.result },
        { key: "assignee", label: "Assignee", render: (r) => esc(r.assignee || "Pending"), sort: (r) => r.assignee || "" },
        /* A certificate the incharge has filed is finished as far as he is
           concerned — he reads it, he does not reopen it. Corrections to a
           filed reading are the office's call. */
        { key: "act", label: "", noSort: true, width: "120px", render: (r) => actionCell(
          labOnly ? [["View", () => reportDetail(r)]]
            : [["View", () => reportDetail(r)], ["Edit", () => reportForm(r)]]) },
      ].filter((c) => !c.hide), { onRow: (r) => reportDetail(r),
        empty: TAB === "done" ? "No certificate has both readings yet" : "No reports match your filters",
        sort: "reportDate", dir: -1 }));
    }
    draw();
  }

  /* A batch is measured twice — on the floor as it is produced, and again by
     the lab incharge after slitting. Both sets are graded against the same
     hidden TDS spec, so they are shown side by side: the TDS column states
     the requirement, the other two show what each stage actually measured.
     The TDS limits are only present for admin (the server withholds them from
     everyone else), so that column degrades to the verdict alone. */
  /* A spec limit as a person writes it. A tolerance worked out in binary
     floating point ("0.14 ± 0.015") can carry a 17-digit tail like
     0.15500000000000003; twelve significant digits is beyond anything a TDS
     states, so trimming there shows 0.155 without altering a real figure.
     Non-numeric limits are passed through untouched. */
  function sn(v) {
    const x = +v;
    return Number.isFinite(x) ? String(+x.toPrecision(12)) : esc(String(v));
  }
  function specText(sp, unit) {
    if (!sp) return `<span class="muted">—</span>`;
    if (sp.unparsed) return `<span class="muted" title="Two thresholds in the source — left ungraded">${esc(sp.unparsed)}</span>`;
    const u = unit ? ` <span class="muted" style="font-size:10px">${unit}</span>` : "";
    if (sp.min != null && sp.max != null) return `${sn(sp.min)} – ${sn(sp.max)}${u}`;
    if (sp.min != null) return `≥ ${sn(sp.min)}${u}`;
    if (sp.max != null) return `≤ ${sn(sp.max)}${u}`;
    if (sp.nominal != null) return `${sn(sp.nominal)}${u}`;
    return `<span class="muted">—</span>`;
  }
  function verdictOf(res) {
    return res === "pass" ? badge("ok", "Pass") : res === "fail" ? badge("danger", "Fail")
      : res === "na" ? `<span class="muted" style="font-size:11px">no spec</span>` : "";
  }
  /* `bare` prints the measurement with no verdict and no pass/fail tint — the
     lab incharge's view. Everyone else sees how each reading graded. */
  function measCell(vals, results, key, unit, bare) {
    const v = (vals || {})[key];
    if (v == null || v === "") return `<span class="muted">—</span>`;
    const res = (results || {})[key];
    if (bare) return `<span style="font-weight:700">${esc(String(v))}</span> <span class="muted" style="font-size:10.5px">${unit}</span>`;
    const tint = res === "fail" ? "color:var(--danger);font-weight:700" : res === "pass" ? "font-weight:700" : "";
    return `<span style="${tint}">${esc(String(v))}</span> <span class="muted" style="font-size:10.5px">${unit}</span> ${verdictOf(res)}`;
  }

  function reportDetail(r) {
    const prod = r.prodValues || {}, lab = r.labValues || {};
    const hasProd = Object.keys(prod).length > 0, hasLab = Object.keys(lab).length > 0;
    const twoStage = hasProd || hasLab;
    // the merged TDS | Production | Lab view is for admin/office only; the lab
    // and production logins each see just their own reading
    const merged = twoStage && !App.isLab();
    // the tester sees his parameters and his readings — no verdict, no limits
    const bare = App.isLab();
    const products = (ENG.data.labProducts || []);
    const spec = ((products.find((p) => p.id === r.productId) || {}).spec) || {};

    const rowsHtml = paramsForReport(r).map((p) => {
      if (!merged) {
        const vals = App.isLab() ? (hasLab ? lab : r.values) : r.values;
        const res = App.isLab() ? (hasLab ? r.labResults : r.results) : r.results;
        return `<tr><td class="nm" style="padding:6px 10px">${esc(p.label)}</td>`
          + `<td class="num" style="padding:6px 10px">${measCell(vals, res, p.key, p.unit, bare)}</td></tr>`;
      }
      return `<tr><td class="nm" style="padding:6px 10px">${esc(p.label)}</td>`
        + `<td class="num" style="padding:6px 10px">${specText(spec[p.key], p.unit)}</td>`
        + `<td class="num" style="padding:6px 10px">${measCell(prod, r.prodResults, p.key, p.unit)}</td>`
        + `<td class="num" style="padding:6px 10px">${measCell(lab, r.labResults, p.key, p.unit)}</td></tr>`;
    }).join("");
    const headHtml = merged
      ? `<tr><th style="text-align:left">Parameter</th><th class="num">TDS spec</th>`
        + `<th class="num">Production${r.prodBy ? ` <span class="muted" style="font-weight:400">· ${esc(r.prodBy)}</span>` : ""}</th>`
        + `<th class="num">Lab${r.labBy ? ` <span class="muted" style="font-weight:400">· ${esc(r.labBy)}</span>` : ""}</th></tr>`
      : `<tr><th style="text-align:left">Parameter</th><th class="num">Measured</th></tr>`;
    const body = h("div", {}, [
      h("div", { class: "flex between aic", style: "margin-bottom:12px" }, [
        h("div", {}, [h("div", { style: "font-weight:700;font-size:15px", text: r.productCode + " · " + r.productName }),
          h("div", { class: "muted", style: "font-size:12px", text: refLabel(r.refMode) + " " + (r.refNo || "—") + " · " + r.reportDate + " · " + r.id })]),
        bare ? h("div", { class: "chip", style: "font-size:11px", text: hasLab ? "Reading filed" : "Awaiting your reading" })
          : h("div", { html: resultBadge(r.result) }),
      ]),
      h("div", { class: "flex gap wrap", style: "margin-bottom:12px", html: typeChips(r.flags) }),
      h("div", { class: "table-wrap" }, h("div", { html: `<table class="tbl"><thead>${headHtml}</thead><tbody>${rowsHtml}</tbody></table>` })),
      merged ? h("div", { class: "flex gap wrap", style: "margin-top:10px;font-size:12px" }, [
        h("span", { class: "muted", text: "Stage result:" }),
        h("span", { html: "Production " + (hasProd ? resultBadge(r.prodResult) : `<span class="muted">not entered</span>`) }),
        h("span", { html: "Lab " + (hasLab ? resultBadge(r.labResult) : `<span class="muted">awaiting slitting</span>`) }),
      ]) : null,
      (!bare && r.result === "Pending") ? h("div", { class: "muted", style: "font-size:12px;margin-top:10px", text: "⏳ No lab spec set for these parameters yet — result will grade automatically once the spec (from the TDS) is loaded." }) : null,
      MW.dl([["Assignee", r.assignee || "Pending"], ["Tested by", r.testedBy || "—"],
        ["Work order", r.woId || "—"], ["Remarks", r.remarks || "—"]]),
    ]);
    const mo = modal({ title: "Lab Report " + r.id, sub: r.productCode + " · " + r.reportDate, wide: true, body,
      /* The incharge files a reading from his Pending list and that is the end
         of it: no reopening a filed certificate, and deleting one is a records
         decision either way. The server enforces the same split. */
      foot: [bare ? null : h("button", { class: "btn danger", onclick: () => delReport(r, mo), text: "🗑 Delete" }),
        bare ? null : h("button", { class: "btn ghost", onclick: () => { mo.close(); reportForm(r); }, text: "✎ Edit" }),
        h("button", { class: "btn primary", onclick: () => mo.close(), text: "Close" })].filter(Boolean) });
  }

  async function delReport(r, mo) {
    if (!await confirm(`Delete lab report ${r.id} (${r.productCode})?`, { title: "Delete Report", danger: true })) return;
    if (mo) mo.close();
    commit(() => DB.labReports.remove(r.id), () => toast("Report " + r.id + " deleted", { type: "ok", title: "Removed" }));
  }

  /* `seed` opens the form against a specific batch — used by the pending-work
     list, where the product and the batch number come from the work order and
     the incharge only has to type the readings. */
  function reportForm(existing, seed) {
    const edit = !!existing;
    seed = seed || {};
    if (!products().length) { toast("Add a product first (Products tab)", { type: "warn" }); return; }
    const list = products().slice().sort((a, b) => (a.series + a.code).localeCompare(b.series + b.code));
    let prod = (edit ? prodById(existing.productId) : prodById(seed.productId)) || list[0];
    // the report records the product's material type; the PARAMETERS come from
    // its spec, so there is nothing to toggle here any more
    let flags = Object.assign({ mica: false, waterBlocking: false, semiConductive: false }, edit ? existing.flags : prod.flags);
    // the lab writes its own reading; the floor's stays untouched beside it
    const mine = () => (App.isLab() && existing && existing.labValues) ? existing.labValues : (edit ? existing.values : {});
    const vals = Object.assign({}, mine());
    const woId = edit ? (existing.woId || "") : (seed.woId || "");

    const prodOpts = list.map((p) => ({ v: p.id, l: U.trim((p.code || p.name) + " — " + p.name + " (" + (p.thickness || "—") + ")", 60) }));
    const refSeed = edit ? (existing.refNo || "") : (seed.refNo || "");
    const lockRef = !edit && !!seed.refNo;   // the batch came from a work order

    const body = h("div", {}, [
      seed.woId ? h("div", { class: "muted", style: "font-size:12px;margin-bottom:10px;padding:9px 11px;border:1px solid var(--line);border-radius:9px;background:var(--panel-2)",
        html: `Work order <b>${esc(seed.woId)}</b> · batch <b>${esc(refSeed)}</b> — the readings below are graded against this product's TDS spec.` }) : null,
      h("div", { class: "form-grid" }, [
        U.field("Product", U.searchSelect("lr_prod", prodOpts, prod.id, "Search product…"), "full"),
        U.field("Reference No.",
          `<input class="input" id="lr_ref" value="${esc(refSeed)}"${lockRef ? " readonly" : ""} placeholder="e.g. B-2026-0142"><div class="muted" id="lr_refmode" style="font-size:10.5px;margin-top:3px">${refLabel(prod.refMode)}</div>`),
        U.field("Report Date", `<input class="input" id="lr_date" type="date" value="${edit ? esc(existing.reportDate) : DB.helpers.iso(DB.helpers.today())}">`),
      ]),
      h("div", { style: "margin:6px 0 4px" }, [
        h("label", { class: "muted", style: "font-size:11px;font-weight:700;text-transform:uppercase", text: "Test parameters" }),
        h("div", { class: "muted", style: "font-size:11px", id: "lr_paramnote" }),
      ]),
      h("div", { id: "lr_params", class: "form-grid", style: "margin-top:8px" }),
      h("h3", { style: "margin:14px 0 8px;font-size:13px", text: "Sign-off" }),
      h("div", { class: "form-grid" }, [
        U.field("Assignee", `<input class="input" id="lr_assignee" value="${esc(edit ? existing.assignee || "" : "")}" placeholder="Pending">`),
        U.field("Tested by", `<input class="input" id="lr_by" value="${esc(edit ? existing.testedBy || "" : "")}">`),
        U.field("Remarks", `<input class="input" id="lr_remarks" value="${esc(edit ? existing.remarks || "" : "")}">`, "full"),
      ]),
    ].filter(Boolean));

    const mo = modal({ title: edit ? "Edit Lab Report" : "New Lab Report", sub: edit ? existing.id : "Enter measured values — Pass/Fail is graded on submit", wide: true, body,
      foot: [h("button", { class: "btn ghost", onclick: () => mo.close(), text: "Cancel" }),
        h("button", { class: "btn primary", onclick: doSave, text: edit ? "Save & Re-grade" : "Submit Report" })] });

    // read current values from the (about-to-be-replaced) param inputs into `vals`
    function captureValues() { PARAMS.forEach((p) => { const el = UI.$("#lrv_" + p.key); if (el) { const v = el.value.trim(); if (v === "") delete vals[p.key]; else vals[p.key] = v; } }); }

    function rebuildParams() {
      const host = UI.$("#lr_params"); if (!host) return;
      host.innerHTML = "";
      const rows = paramsFor(prod, flags);
      const note = UI.$("#lr_paramnote");
      if (note) {
        note.textContent = specKeysOf(prod).length
          ? rows.length + " parameter" + (rows.length === 1 ? "" : "s") + " — from this product's entry under Products."
          : "No spec set for this product yet, so its material type decides the list. Set one under Products.";
      }
      rows.forEach((p) => {
        const v = vals[p.key] != null ? vals[p.key] : "";
        host.insertAdjacentHTML("beforeend",
          `<div class="field"><label>${esc(p.label)} <span class="muted" style="font-weight:500">(${p.unit})</span></label><div><input class="input" id="lrv_${p.key}" type="number" step="any" value="${esc(String(v))}"></div></div>`);
      });
    }
    rebuildParams();

    // product change → adopt its flags, parameters + ref label, keep entered values
    UI.$("#lr_prod").addEventListener("change", (e) => {
      captureValues();
      prod = prodById(e.target.value) || prod;
      flags = Object.assign({ mica: false, waterBlocking: false, semiConductive: false }, prod.flags);
      const lbl = UI.$("#lr_refmode"); if (lbl) lbl.textContent = refLabel(prod.refMode);
      rebuildParams();
    });

    function doSave() {
      captureValues();
      const refNo = (UI.$("#lr_ref").value || "").trim();
      if (!refNo) { toast(refLabel(prod.refMode) + " is required", { type: "warn" }); return; }
      const values = {};
      paramsFor(prod, flags).forEach((p) => { if (vals[p.key] != null && vals[p.key] !== "") values[p.key] = +vals[p.key]; });
      const payload = {
        productId: prod.id, refNo, reportDate: UI.$("#lr_date").value || DB.helpers.iso(DB.helpers.today()),
        flags: { mica: !!flags.mica, waterBlocking: !!flags.waterBlocking, semiConductive: !!flags.semiConductive },
        values, assignee: (UI.$("#lr_assignee").value || "").trim() || "Pending",
        testedBy: (UI.$("#lr_by").value || "").trim(), remarks: (UI.$("#lr_remarks").value || "").trim(),
      };
      // keep the certificate tied to the job it was made on
      if (woId) payload.woId = woId;
      mo.close();
      commit(() => edit ? DB.labReports.update(existing.id, payload) : DB.labReports.create(payload), (saved) => {
        /* the tester is told the reading was filed, never how it graded — the
           response still carries the verdict for everyone else */
        if (App.isLab()) toast("Reading filed for batch " + refNo, { type: "ok", title: "Submitted" });
        else toast("Report " + (saved && saved.id ? saved.id : "") + " — " + (saved ? saved.result : ""), { type: saved && saved.result === "Fail" ? "danger" : "ok", title: edit ? "Re-graded" : "Submitted" });
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
        { key: "name", label: "Product", cls: "nm", render: (p) => esc(U.trim(p.name, 46)) },
        { key: "thickness", label: "Thk (mm)", width: "90px", render: (p) => esc(p.thickness || "—") },
        { key: "series", label: "Series", width: "130px", render: (p) => esc(p.series || "—") },
        { key: "type", label: "Type", noSort: true, render: (p) => `<div class="flex gap wrap">${typeChips(p.flags)}</div>` },
        { key: "ref", label: "Ref", width: "84px", render: (p) => refLabel(p.refMode).replace(" No.", ""), sort: (p) => p.refMode },
        // `specSet` is what non-admins receive — the limits themselves are
        // withheld so a tester cannot grade against them by eye.
        { key: "spec", label: "Spec", width: "70px", noSort: true, render: (p) => (p.specSet || (p.spec && Object.keys(p.spec).length)) ? badge("ok", "set") : badge("mut", "—") },
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
          `<input class="input" id="sp_min_${par.key}" type="number" step="any" placeholder="min" style="width:110px" value="${sp.min != null ? esc(sn(sp.min)) : ""}">` +
          `<input class="input" id="sp_max_${par.key}" type="number" step="any" placeholder="max" style="width:110px" value="${sp.max != null ? esc(sn(sp.max)) : ""}"></div>`);
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

  /* ⌘K quick action — the WORKLIST, not a blank form. A certificate only
     exists against a real batch, so there is nothing for a "New Report"
     action to create. */
  window.ERPActions = Object.assign(window.ERPActions || {}, {
    labPendingWork: { mod: "lab-reports", ic: "🧪", label: "Pending lab work",
      run: () => App.go("lab-reports", { view: "reports", openPending: true }) },
  });
})();
