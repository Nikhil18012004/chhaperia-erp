/* ============================================================
   CHHAPERIA ERP — OPERATIONS · Lab Reports (QC certificates)
   Test certificates for finished goods. The parameters shown on a
   report depend on the product's material TYPE (water-blocking /
   semi-conductive / mica); the spec is held on the server and never
   shown here — the entry form captures measured values only, and the
   backend grades Pass/Fail on submit.

   Three views (segmented): "Finished Goods" (batch certificates),
   "Raw Materials (GRN)" (incoming-material tests, raised ONLY against a
   purchase order's goods receipt — added 2026-08-27 at the user's ask)
   and "Products" — everything the lab tests: the lab product master
   for finished goods, and the raw materials and work-in-process it
   also measures, each opening the editor that owns it. Admin sets the
   limits; everyone else, the incharge included, sees which parameters
   a thing is tested on and never the numbers. Reports are graded
   server-side, so writes go through a reload (not optimistic) to
   bring back the computed result.
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
  // the catalogue is what the New Item form searches when a parameter is picked
  window._erpUtil = Object.assign(window._erpUtil || {}, { labParams: PARAMS });
  const TYPE_TOGGLES = [
    { key: "waterBlocking",  label: "Water-blocking" },
    { key: "semiConductive", label: "Semi-conductive" },
    { key: "mica",           label: "Mica (BDV)" },
  ];

  /* ============================================================
     THE DIVISIONS OF THE PRODUCT MASTER — READ OFF THE NAME
     The three toggles above are what a product is TESTED on: they
     decide which parameters its certificate carries, and nothing
     else. As a way of dividing the master they barely divide it —
     more than half the catalogue is flagged with none of them and
     read "General", so a list of a hundred products offered one
     undifferentiated heap.
     What the names say, though, is exactly what the tape is MADE
     of: cotton, mica, glass, non-woven, copper. So the division is
     taken from the name, first match winning, most-defining first
     — bituminised COTTON is cotton, rubberised COTTON is cotton,
     and a mica tape backed with glass is mica. Nothing is stored:
     the name IS the classification, so a renamed product divides
     itself and there is no second field to keep in step.
     Order is meaning here. Moving a rule up or down re-files
     products, so keep the specific above the general — WOVEN sits
     below NON WOVEN because "NON WOVEN" contains it.
     ============================================================ */
  const DIVISIONS = [
    /* `covers` names the toggle a division already says out loud: the mica
       toggle is read off the same word, so printing both would give every
       mica tape a cell reading "Mica  Mica (BDV)". */
    { key: "mica",       label: "Mica",           re: /\bMICA\b/, covers: "mica" },
    // LSZH and fire-survival: the name's own promise, whatever the substrate
    { key: "zeroHal",    label: "Zero-halogen",   re: /ZERO\s*HAL|LOW\s*SMOKE|FIRE\s*SURVIVAL/ },
    // aluminium / copper — foil-laminated or copper-wire woven
    { key: "metal",      label: "Metallised",     re: /ALUMINI?UM|\bCOPPER\b/ },
    { key: "ptfe",       label: "PTFE",           re: /\bPTFE\b/ },
    { key: "polyimide",  label: "Polyimide",      re: /POLY\s*IMIDE/ },
    { key: "foam",       label: "Foam",           re: /\bFOAM/ },
    // the treatment is not the cloth: bituminised and rubberised cotton are cotton
    { key: "cotton",     label: "Cotton",         re: /\bCOTTON\b/ },
    { key: "rubber",     label: "Rubber",         re: /\bRUBBER/ },
    { key: "glass",      label: "Glass",          re: /\bGLASS\b/ },
    { key: "nonwoven",   label: "Non-woven",      re: /NON[\s-]*WOVEN|NONWOVEN|\bFLEECE\b/ },
    { key: "woven",      label: "Woven",          re: /\bWOVEN\b/ },
    { key: "polyester",  label: "Polyester",      re: /POLY\s*ESTER|\bPET\b/ },
    { key: "polyprop",   label: "Polypropylene",  re: /POLY\s*PROPYLENE/ },
    { key: "laminate",   label: "Laminated",      re: /LAMINAT/ },
    { key: "rope",       label: "Rope",           re: /\bROPE\b/ },
    // says nothing of its substrate, but the name's own word still divides it
    { key: "nonCond",    label: "Non-conductive", re: /NON[\s-]*CONDUCTIVE/ },
  ];
  /* the division a name falls in — null when no rule recognises a word in it,
     which reads "General" the way an unflagged product always has */
  function divisionOf(name) {
    const s = String(name || "").toUpperCase();
    return DIVISIONS.find((d) => d.re.test(s)) || null;
  }

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
  /* a product's OWN parameters (defined with it, since 2026-09-02) are always
     on its certificate — mirrors labService.customParamsOf */
  const customOf = (p) => (p && Array.isArray(p.params)
    ? p.params.filter((q) => q && q.key && q.label).map((q) => ({ key: q.key, label: q.label, unit: q.unit || "", group: "custom" }))
    : []);
  function paramsFor(product, flags) {
    const keys = specKeysOf(product);
    const custom = customOf(product);
    const picked = PARAMS.filter((p) => keys.indexOf(p.key) >= 0);
    const base = picked.length ? picked : (custom.length ? [] : applicable(flags || (product || {}).flags));
    return base.concat(custom);
  }
  /* the rows a SAVED report shows: the parameters it was written against,
     falling back to the product's current list for reports made before the
     parameter set was recorded on the certificate */
  function paramsForReport(r) {
    const keys = Array.isArray(r && r.paramKeys) ? r.paramKeys : null;
    const prod = prodById(r && r.productId);
    if (keys && keys.length) return PARAMS.concat(customOf(prod)).filter((p) => keys.indexOf(p.key) >= 0);
    return paramsFor(prod, r && r.flags);
  }
  /* A PRODUCT'S NAME IS SHOWN IN FULL, EVERYWHERE ON THIS PAGE. These names
     run long by design — "FIRES M DOUBLE GLASS – MUSCOVITE GLASS MICA GLASS
     TAPE" is what distinguishes it from the four tapes whose names begin the
     same way — and every list here used to cut them at forty-odd characters,
     which is exactly where they start to differ. A trimmed name saved a line
     of table and cost the reader the one thing the name was for. They wrap
     instead; `nameCell` is that wrap, so the rule is kept in one place. */
  const nameCell = (name, sub) => `<div style="font-weight:600;overflow-wrap:anywhere">${esc(name || "—")}</div>`
    + (sub ? `<div class="muted" style="font-size:11px;overflow-wrap:anywhere">${sub}</div>` : "");
  const refLabel = (mode) => (mode === "lot" ? "Lot / W.O. No." : "Batch No.");
  const typeChips = (flags) => TYPE_TOGGLES.filter((t) => (flags || {})[t.key]).map((t) => `<span class="chip">${t.label}</span>`).join("") || `<span class="muted" style="font-size:11px">General</span>`;
  /* THE TYPE CELL OF THE PRODUCT MASTER — two axes, not one. First the
     division the product's NAME puts it in (what it is made of), then the
     toggles its certificate is graded on (what it is tested for). "General"
     is left for the product whose name says nothing and carries no toggle. */
  function typeCell(p) {
    const d = divisionOf(p && p.name);
    const flags = TYPE_TOGGLES
      .filter((t) => ((p && p.flags) || {})[t.key] && !(d && d.covers === t.key))
      .map((t) => `<span class="chip">${t.label}</span>`).join("");
    if (!d && !flags) return `<span class="muted" style="font-size:11px">General</span>`;
    return (d ? badge("info", d.label) : "") + flags;
  }
  const divisionLabel = (p) => (divisionOf(p && p.name) || {}).label || "General";
  function resultBadge(r) { return r === "Pass" ? badge("ok", "Pass") : r === "Fail" ? badge("danger", "Fail") : badge("mut", "Pending"); }
  const prodById = (id) => products().find((p) => p.id === id);

  let VIEW = "reports";   // "reports" | "incoming" | "products" — persists across re-render
  // within Raw Materials (GRN): the worklist or the filed tests
  let ITAB = "pending";   // "pending" | "done"
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

    /* No "New Report" button anywhere: a certificate is only ever raised
       against a real batch — by the coating floor, by whoever books finished
       stock, or by the incharge working this list. There is nothing left for
       a blank form to be for. */
    const newBtn = (!labOnly && VIEW === "products")
      ? h("button", { class: "btn primary", onclick: () => productForm(), html: "＋ New Product" })
      : null;
    const subText = VIEW === "incoming"
      ? "Incoming raw materials are tested only against the goods receipt of a purchase order — every line here came in on a PO, and nothing that did not can be tested."
      : VIEW === "products"
        ? (labOnly
          ? "Everything the lab tests — finished goods, raw materials and work in process — and the parameters each one is measured on. The pass/fail limits behind them are the admin's and are not shown here."
          : "Everything the lab tests — finished goods, raw materials and work in process — and what each one is measured on. A finished good opens its lab product; a material opens its QC parameters.")
        : labOnly
          ? "Pending lists every batch awaiting a reading; enter the measured values against a batch number and it moves to Completed. Values are graded against the product's TDS spec on submit."
          : "Test certificates for finished goods. A report carries the parameters this product's entry under Products states a limit for; measured values are graded against that spec on submit.";
    root.appendChild(pageHead(
      labOnly ? "Lab Reports" : "Lab Reports — Quality Control",
      subText,
      // the Excel menu follows the visible tab: certificates vs the product
      // master; the GRN worklist prints per receipt (the GRN cum test report)
      labOnly ? [] : [VIEW === "incoming" ? null : MW.excelMenu(VIEW === "reports" ? "labreports" : "labproducts"), newBtn].filter(Boolean)));

    /* segmented view switch — the two worklists and the master they are
       measured against, which every role can read */
    /* three of them now that the incharge keeps the master too, and the third
       ran off the edge of a phone — they wrap rather than overflow */
    root.appendChild(h("div", { class: "flex gap wrap", style: "margin-bottom:16px" }, [
      segBtn("reports", "🧪 Finished Goods"),
      segBtn("incoming", "🚚 Raw Materials (GRN)"),
      /* THE INCHARGE GETS THIS TAB TOO (2026-09-05). Which parameters a thing
         is tested on is his own worklist written down; what it must MEASURE is
         not his to see, or a reading could be tuned until it passes. The server
         already withholds the limits from him, so the tab costs nothing to
         open: he gets every detail but the numbers. */
      segBtn("products", "📦 Products"),
    ].filter(Boolean)));

    /* Incoming-material testing used to live ONLY in Procurement, against the
       goods receipt that brought the material in. The user asked (2026-08-27)
       for it here as well, in the lab's own section — but still strictly via
       the purchase order: the worklist is the server's list of received PO
       lines owing a reading, and the row opens the same GRN test form the
       receipt does. There is no way on this page to test a material that did
       not arrive on a PO. */
    if (VIEW === "reports") renderReports(root, labOnly);
    else if (VIEW === "incoming") renderIncoming(root, labOnly);
    else renderProducts(root);

    if (params && params.openNew) { params.openNew = false; if (!labOnly && VIEW === "products") productForm(); }
    if (params && params.openPending) { params.openPending = false; pendingModal(); return; }
    /* A certificate asked for by id from another screen — the complaint's
       "Send test certificate" lands here with the report the batch was graded
       on. One-shot, like openPending: cleared before the detail opens so a
       refresh does not raise it again. */
    if (params && params.open) {
      const id = params.open; params.open = null;
      const r = reports().find((x) => x.id === id);
      if (r) reportDetail(r); else toast("Lab report " + id + " is not on file", { type: "warn" });
      return;
    }
    /* An incoming test asked for by id — the lab's failed-lot alert lands
       here, on the receipt's own test report (the lab cannot rule; the admin's
       alert goes to Procurement instead). One-shot, like `open`. */
    if (params && params.openGrnTest) {
      const id = params.openGrnTest; params.openGrnTest = null;
      const t = (ENG.data.grnTests || []).find((x) => x.id === id);
      if (t) openGrnPanel(t); else toast("Incoming test " + id + " is not on file", { type: "warn" });
      return;
    }
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
        render: (r) => `<div style="font-weight:700">${esc(r.batchNo)}</div><div class="muted" style="font-size:11px">${esc(r.woId)}</div>`,
        sort: (r) => r.woId },
      { key: "product", label: "Product", cls: "nm",
        render: (r) => nameCell(r.productCode, esc(r.productName || "")),
        sort: (r) => r.productCode || "" },
      { key: "qty", label: "Qty", width: "84px", render: (r) => (r.qty == null ? "—" : ENG.num(r.qty)), sort: (r) => r.qty || 0 },
      { key: "floor", label: "Production", width: "116px", noSort: true,
        render: (r) => !r.coating ? `<span class="muted" style="font-size:11px">n/a</span>`
          : r.prodComplete ? badge("ok", "entered") : badge("warn", "awaiting") },
      { key: "lab", label: "Lab", width: "104px", noSort: true,
        render: (r) => r.labComplete ? badge("ok", "entered") : badge("mut", "awaiting") },
      { key: "need", label: "Still to measure", noSort: true,
        render: (r) => { const m = r.stage === "production" ? r.missingProd : r.missingLab;
          return m && m.length ? `<span class="muted" style="font-size:12px">${esc(m.join(", "))}</span>`
            : `<span class="muted" style="font-size:12px">—</span>`; } },
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
     RAW MATERIALS (GRN) — incoming-material tests, via purchase orders
     The worklist is ENG.data.grnTestPending, computed server-side
     (grnTestService.pendingTests): every line of every posted goods
     receipt whose material has test parameters and no complete reading
     yet. A row opens the GRN test form from Procurement (shared through
     _erpUtil), so the reading is filed against the receipt exactly as it
     is from the PO screen, and the PO reflects it. Filed tests come from
     ENG.data.grnTests; the lab incharge's copy carries no verdict (the
     server withholds it), so his rows read "Tested", never Pass/Fail.
     ============================================================ */
  const grnPending = () => ENG.data.grnTestPending || [];
  const grnTests = () => (ENG.data.grnTests || []).filter((t) => t.complete);
  const grnById = (id) => (ENG.data.grns || []).find((g) => g.id === id) || null;
  const supplierName = (id) => ((ENG.data.suppliers || []).find((s) => s.id === id) || {}).name || (id || "—");
  const itemCat = (id) => { const it = ENG.item && ENG.item(id); return it && it.cat ? (U.catName ? U.catName(it.cat) : it.cat) : "—"; };

  /* one badge per filed test — the same order of precedence Procurement uses:
     an unruled failure first, then the settled outcomes, then the verdict —
     and never a grade the payload did not carry */
  function grnBadge(t, labOnly) {
    if (!t || !t.complete) return badge("warn", "Test due");
    if (t.result === "Fail" && !t.decision) return badge("danger", "⛔ Approval due");
    if (t.decision === "quarantined") return badge("danger", "Quarantined");
    if (t.decision === "released") return badge("warn", "Failed · released");
    if (t.result === "Fail") return badge("danger", "✗ Fail");
    if (labOnly || !t.result) return badge("ok", "✓ Tested");
    return t.result === "Pass" ? badge("ok", "✓ Pass") : badge("info", t.result);
  }
  function openGrnTest(row) {
    if (!U || !U.grnTestForm) { toast("Procurement is not loaded — open the receipt from Procurement instead", { type: "warn" }); return; }
    // the form reloads state on save, which re-renders this page
    U.grnTestForm(row.grnId, row.itemId);
  }
  function openGrnPanel(t) {
    const g = grnById(t.grnId);
    if (!g || !U || !U.grnTestPanel) { toast("Goods receipt " + t.grnId + " is not on file", { type: "warn" }); return; }
    U.grnTestPanel(g);
  }

  function renderIncoming(root, labOnly) {
    const filter = App.viewState("incomingFilter", () => ({ q: "", qRaw: "" }));   // survives a quiet refresh
    const pend = grnPending();
    const done = grnTests();
    const me = (App.user && App.user.username) || "";
    const rulings = (ENG.data.grnQcDecisions || []).length;

    root.appendChild(h("div", { class: "grid kpi-grid", style: "margin-bottom:16px" }, labOnly ? [
      kpi({ icon: "🚚", label: "Awaiting test", value: ENG.num(pend.length) }),
      kpi({ icon: "✅", label: "Filed by you", value: ENG.num(done.filter((t) => t.testedBy === me).length) }),
      kpi({ icon: "📥", label: "Goods receipts", value: ENG.num((ENG.data.grns || []).filter((g) => g.status !== "Cancelled").length) }),
    ] : [
      kpi({ icon: "🚚", label: "Awaiting test", value: ENG.num(pend.length) }),
      kpi({ icon: "✅", label: "Passed", value: ENG.num(done.filter((t) => t.result === "Pass").length) }),
      kpi({ icon: "⛔", label: "Failed", value: ENG.num(done.filter((t) => t.result === "Fail").length) }),
      /* a failed lot waiting on a ruling is material the factory may be about
         to use — the tile goes straight to the admin's queue */
      (() => { const c = kpi({ icon: "⚖️", label: "Ruling due", value: ENG.num(rulings), delta: rulings ? "Decide now" : "None", deltaType: rulings ? "down" : "up" });
        if (rulings && isAdmin() && U && U.qcDecisionQueue) { c.style.cursor = "pointer"; c.setAttribute("role", "button"); c.onclick = () => U.qcDecisionQueue(); }
        return c; })(),
    ]));

    const seg = h("div", { class: "seg", style: "margin-bottom:14px" });
    const segBtn2 = (label, key) => {
      const b = h("button", { class: ITAB === key ? "on" : "", text: label,
        onclick: () => { ITAB = key; [...seg.children].forEach((c) => c.classList.remove("on")); b.classList.add("on"); draw(); } });
      return b;
    };
    seg.appendChild(segBtn2("Awaiting test" + (pend.length ? " (" + pend.length + ")" : ""), "pending"));
    seg.appendChild(segBtn2("Tested", "done"));
    root.appendChild(seg);

    root.appendChild(h("div", { class: "toolbar" }, [
      searchInput("Search material, code, PO, GRN, supplier…", (v) => { filter.qRaw = v; filter.q = v.toLowerCase(); draw(); }, filter.qRaw),
      h("div", { style: "margin-left:auto" }, h("span", { class: "chip", id: "grnCount" })),
    ]));
    root.appendChild(h("div", { class: "muted", style: "font-size:12px;margin:-4px 0 10px;line-height:1.6",
      text: "Every line arrived on a purchase order. A raw material is tested only against its goods receipt — to test a delivery that is not listed, receive its PO first." }));
    const host = h("div"); root.appendChild(host);

    const hay = (r) => [r.itemName, r.itemId, r.poId, r.grnId, r.invNo, supplierName(r.supplierId)].join(" ").toLowerCase();
    const matches = (r) => !filter.q || hay(r).includes(filter.q);
    const poCell = (r) => `<div style="font-weight:700">${esc(r.poId || "—")}</div><div class="muted" style="font-size:11px">${esc(r.grnId)}${r.invNo ? " · inv " + esc(r.invNo) : ""}</div>`;
    const matCell = (r) => nameCell(r.itemName || r.itemId, esc(r.itemId) + " · " + esc(itemCat(r.itemId)));

    function draw() {
      const c = UI.$("#grnCount");
      host.innerHTML = "";
      if (ITAB === "pending") {
        const data = pend.filter(matches);
        if (c) c.textContent = data.length + " material" + (data.length === 1 ? "" : "s") + " awaiting";
        host.appendChild(table(data, [
          { key: "date", label: "Received", width: "100px", render: (r) => esc(r.date || "—"), sort: (r) => r.date || "" },
          { key: "po", label: "Purchase Order", width: "150px", render: poCell, sort: (r) => r.poId || "" },
          { key: "mat", label: "Material", cls: "nm", render: matCell, sort: (r) => r.itemName || "" },
          { key: "sup", label: "Supplier", render: (r) => esc(supplierName(r.supplierId)), sort: (r) => supplierName(r.supplierId) },
          { key: "params", label: "Parameters", width: "96px", render: (r) => ENG.num(r.params || 0) + " to read", sort: (r) => r.params || 0 },
          { key: "act", label: "", noSort: true, width: "96px", render: (r) => actionCell([["🧪 Test", () => openGrnTest(r)]]) },
        ], { onRow: openGrnTest, sort: "date", dir: -1,
          empty: pend.length ? "No material matches" : "Nothing awaiting — every received material has been tested" }));
        return;
      }
      const data = done.filter(matches).sort((a, b) => String(b.testedAt || b.date || "").localeCompare(String(a.testedAt || a.date || "")));
      if (c) c.textContent = data.length + " test" + (data.length === 1 ? "" : "s");
      host.appendChild(table(data, [
        { key: "date", label: "Tested", width: "100px", render: (t) => esc(String(t.testedAt || t.date || "—").slice(0, 10)), sort: (t) => t.testedAt || t.date || "" },
        { key: "po", label: "Purchase Order", width: "150px", render: poCell, sort: (t) => t.poId || "" },
        { key: "mat", label: "Material", cls: "nm", render: matCell, sort: (t) => t.itemName || "" },
        { key: "sup", label: "Supplier", render: (t) => esc(supplierName(t.supplierId)), sort: (t) => supplierName(t.supplierId) },
        { key: "sample", label: "Sample", width: "90px", render: (t) => t.sampleSize == null ? `<span class="muted">—</span>` : ENG.num(t.sampleSize) + " " + esc(t.uom || ""), sort: (t) => t.sampleSize || 0 },
        { key: "res", label: labOnly ? "Status" : "Result", width: "128px", render: (t) => grnBadge(t, labOnly), sort: (t) => (t.result || "") + (t.decision || "") },
        { key: "by", label: "Tested by", width: "110px", render: (t) => esc(t.testedBy || "—"), sort: (t) => t.testedBy || "" },
        { key: "act", label: "", noSort: true, width: "128px", render: (t) => actionCell([
          ["View", () => openGrnPanel(t)],
          ["Print", () => { const g = grnById(t.grnId); if (g && U && U.printGrn) U.printGrn(g); else toast("Goods receipt " + t.grnId + " is not on file", { type: "warn" }); }],
        ]) },
      ], { onRow: openGrnPanel, empty: done.length ? "No test matches" : "No incoming material has been tested yet" }));
    }
    draw();
  }

  /* ============================================================
     TEST REPORTS
     ============================================================ */
  function renderReports(root, labOnly) {
    const filter = App.viewState("reportsFilter", () => ({ q: "", qRaw: "", result: "all", series: "all" }));   // survives a quiet refresh
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
        (v) => { filter.qRaw = v; filter.q = v.toLowerCase(); draw(); }, filter.qRaw),
      labOnly ? null : select([{ value: "all", label: "All Results" }, { value: "Pass", label: "Pass" }, { value: "Fail", label: "Fail" }, { value: "Pending", label: "Pending" }], (v) => { filter.result = v; draw(); }, filter.result),
      select([{ value: "all", label: "All Series" }, ...seriesList.map((s) => ({ value: s, label: s }))], (v) => { filter.series = v; draw(); }, filter.series),
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
        host.appendChild(h("div", { class: "muted", style: "font-size:12px;margin-bottom:10px",
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
        { key: "product", label: "Product", cls: "nm", render: (r) => nameCell(r.productCode, esc(r.productName || "")), sort: (r) => r.productCode || "" },
        { key: "ref", label: "Batch / Lot", render: (r) => `<div>${esc(r.refNo || "—")}</div><div class="muted" style="font-size:11px">${refLabel(r.refMode)}</div>`, sort: (r) => r.refNo || "" },
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
    if (bare) return `<span style="font-weight:700">${esc(String(v))}</span> <span class="muted" style="font-size:11px">${unit}</span>`;
    const tint = res === "fail" ? "color:var(--danger);font-weight:700" : res === "pass" ? "font-weight:700" : "";
    return `<span style="${tint}">${esc(String(v))}</span> <span class="muted" style="font-size:11px">${unit}</span> ${verdictOf(res)}`;
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
      /* the name is as long as the product is, and the verdict is the one thing
         on this card that must never be pushed off the edge of it — so the two
         wrap apart instead of competing for a single line */
      h("div", { class: "flex between aic gap wrap", style: "margin-bottom:12px" }, [
        h("div", { style: "flex:1 1 220px;min-width:0" }, [h("div", { style: "font-weight:700;font-size:15px;overflow-wrap:anywhere", text: r.productCode + " · " + r.productName }),
          h("div", { class: "muted", style: "font-size:12px;overflow-wrap:anywhere", text: refLabel(r.refMode) + " " + (r.refNo || "—") + " · " + r.reportDate + " · " + r.id })]),
        bare ? h("div", { class: "chip", style: "font-size:11px", text: hasLab ? "Reading filed" : "Awaiting your reading" })
          : h("div", { html: resultBadge(r.result) }),
      ]),
      h("div", { class: "flex gap wrap", style: "margin-bottom:12px", html: typeChips(r.flags) }),
      rulingBanner(r),
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
        /* THE ADMIN'S RULING on a failed batch — accept it (a concession, on
           the record) or reject it. Neither moves stock; that stays the
           office's decision on the ledger. Admin only, as the server enforces. */
        (App.isAdmin() && attentionOf(r)) ? h("button", { class: "btn danger", onclick: () => decideForm(r, false, mo), text: "✗ Reject batch" }) : null,
        (App.isAdmin() && attentionOf(r)) ? h("button", { class: "btn primary", onclick: () => decideForm(r, true, mo), text: "✓ Accept batch" }) : null,
        h("button", { class: "btn primary", onclick: () => mo.close(), text: "Close" })].filter(Boolean) });
  }

  /* Which reading is flagging this certificate — "floor" or "lab" — or null
     once it passed or an admin has ruled. The lab's payload says so outright
     (`attention`, the one batch-level fact it is given); everyone else has the
     grades and works it out the way the server does. */
  function attentionOf(r) {
    if (!r) return null;
    if (r.attention !== undefined) return r.attention || null;
    if (r.decision) return null;
    if (r.labComplete) return r.labResult === "Fail" ? "lab" : null;
    return r.prodResult === "Fail" ? "floor" : null;
  }
  function rulingBanner(r) {
    if (r.decision) {
      const ok = r.decision === "accepted";
      return h("div", { class: "qc-note" + (ok ? "" : " bad"), style: "font-size:13px;margin-bottom:12px" }, [
        h("div", { style: "font-weight:700", text: (ok ? "✓ Batch accepted" : "✗ Batch rejected") + " by " + (r.decidedBy || "admin")
          + (r.decidedAt ? " on " + String(r.decidedAt).slice(0, 10) : "") }),
        r.decisionNote ? h("div", { class: "muted", style: "font-size:12px;margin-top:2px", text: r.decisionNote }) : null,
      ]);
    }
    const att = attentionOf(r);
    if (!att) return null;
    return h("div", { class: "qc-note bad", style: "font-size:13px;margin-bottom:12px" }, [
      h("div", { style: "font-weight:700", text: "⛔ Lab data FAILED — " + (att === "lab" ? "the lab's reading" : "the floor's reading") + " is outside the limits" }),
      h("div", { class: "muted", style: "font-size:12px;margin-top:2px", text: App.isAdmin()
        ? "The batch is not held anywhere. Accept it (a concession, kept on the certificate) or reject it — neither moves stock."
        : "The admin has been alerted and will rule on this batch." }),
    ]);
  }
  function decideForm(r, accept, parent) {
    const note = h("textarea", { class: "input", rows: "2", maxlength: "500",
      placeholder: accept ? "why the batch is accepted despite the reading" : "why the batch is rejected" });
    const go = h("button", { class: "btn " + (accept ? "primary" : "danger"), text: accept ? "Accept batch" : "Reject batch",
      onclick: async () => {
        go.disabled = true; go.textContent = "Saving…";
        try {
          await DB.labReports.decide(r.id, accept, note.value);
          m2.close();
          toast((accept ? "Batch accepted" : "Batch rejected") + " — " + r.id, { type: accept ? "ok" : "warn", title: "Ruling recorded" });
          await App.reloadState();
          const fresh = reports().find((x) => x.id === r.id);
          if (fresh) reportDetail(fresh);
        } catch (e) {
          toast(e.message || "Could not record the ruling", { type: "danger" });
          go.disabled = false; go.textContent = accept ? "Accept batch" : "Reject batch";
        }
      } });
    if (parent) parent.close();
    const m2 = modal({ title: (accept ? "✓ Accept batch" : "✗ Reject batch") + " — " + r.id,
      sub: r.productCode + " · " + refLabel(r.refMode) + " " + (r.refNo || "—"),
      body: h("div", {}, [
        h("div", { class: "qc-note" + (accept ? "" : " bad"), style: "font-size:13px;margin-bottom:14px",
          text: accept ? "The batch stands despite the reading. The concession is kept on the certificate with your note."
            : "The batch is marked rejected on its certificate. Nothing is moved or written off here — that is a separate stock decision." }),
        h("div", { class: "field full" }, [h("label", { text: "Note (kept on the certificate)" }), note]),
      ]),
      foot: [h("button", { class: "btn ghost", onclick: () => { m2.close(); reportDetail(r); }, text: "Cancel" }), go] });
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

    const prodOpts = list.map((p) => ({ v: p.id, l: (p.code || p.name) + " — " + p.name + " (" + (p.thickness || "—") + ")" }));
    const refSeed = edit ? (existing.refNo || "") : (seed.refNo || "");
    const lockRef = !edit && !!seed.refNo;   // the batch came from a work order
    /* THE PRODUCT IS NOT A CHOICE ON THIS FORM. A certificate is only ever
       raised against a real batch — the work order says what was made, and the
       readings below are graded against THAT product's TDS spec. Offering a
       searchable list of every product invited the one mistake this form must
       not allow: a batch's measurements filed against a different product's
       limits, passing or failing on a spec it was never made to. Editing a
       filed certificate is the same case, only later. So the product is shown,
       not asked for, wherever it is already decided — which, since there is no
       blank New Report anywhere, is always. */
    const lockProd = edit || !!seed.productId || !!seed.woId;
    /* not an <input>: a readonly box scrolls a long name out of sight, which is
       the same loss as trimming it. The product is a fact here, not a field, so
       it is printed — code above, name below, wrapping as far as it needs. */
    const prodField = lockProd
      ? U.field("Product",
        `<div class="input" style="height:auto;min-height:38px;padding:8px 12px;line-height:1.45">`
        + `<div style="font-weight:700;overflow-wrap:anywhere">${esc(prod.code || prod.name)}</div>`
        + `<div class="muted" style="font-size:12px;overflow-wrap:anywhere">${esc(prod.name)}${prod.thickness ? " · " + esc(prod.thickness) + " mm" : ""}</div></div>`
        + `<div class="muted" style="font-size:11px;margin-top:3px">${esc(edit && !seed.woId
          ? "The certificate was raised against this product — it is what the readings were graded on."
          : "Decided by the work order — the batch was made to this product, and is graded on its spec.")}</div>`, "full")
      : U.field("Product", U.searchSelect("lr_prod", prodOpts, prod.id, "Search product…"), "full");

    const body = h("div", {}, [
      seed.woId ? h("div", { class: "muted", style: "font-size:12px;margin-bottom:10px;padding:9px 11px;border:1px solid var(--line);border-radius:9px;background:var(--panel-2)",
        html: `Work order <b>${esc(seed.woId)}</b> · batch <b>${esc(refSeed)}</b> — the readings below are graded against this product's TDS spec.` }) : null,
      h("div", { class: "form-grid" }, [
        prodField,
        U.field("Reference No. *",
          `<input class="input" id="lr_ref" value="${esc(refSeed)}"${lockRef ? " readonly" : ""} placeholder="e.g. B-2026-0142"><div class="muted" id="lr_refmode" style="font-size:11px;margin-top:3px">${refLabel(prod.refMode)}</div>`),
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
    // only a form that offers the choice has one to listen to
    { const sel = UI.$("#lr_prod"); if (sel) sel.addEventListener("change", (e) => {
      captureValues();
      prod = prodById(e.target.value) || prod;
      flags = Object.assign({ mica: false, waterBlocking: false, semiConductive: false }, prod.flags);
      const lbl = UI.$("#lr_refmode"); if (lbl) lbl.textContent = refLabel(prod.refMode);
      rebuildParams();
    }); }

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
     PRODUCTS — EVERYTHING THE LAB TESTS, NOT THE FINISHED GOODS ALONE
     The lab measures three things and this tab listed one of them. A
     finished good is a LAB PRODUCT, with a master of its own and a TDS
     spec; a raw material and a work-in-process are STOCK ITEMS, and
     what the lab measures on those was defined on the item itself
     (qcParams / qcSpec) over in Inventory. So the one page meant to
     answer "what does the lab test, and on what" answered a third of
     it, and the other two thirds were reachable only through the stock
     list — which is not where anybody looks for a test parameter.
     All three are listed here now, in one table, each row opening the
     editor that OWNS it: the lab product form for a finished good, the
     QC parameters dialog for a material. Nothing was moved to do it —
     a lab product is still a lab product and an item is still an item;
     this is the one place that reads both.
     ============================================================ */
  const items = () => ENG.data.items || [];
  const KIND = {
    fg:  { short: "FG",  ic: "🎁", plural: "Finished Goods" },
    rm:  { short: "RM",  ic: "🧱", plural: "Raw Materials" },
    wip: { short: "WIP", ic: "⚙️", plural: "Work in Process" },
  };
  /* ONE ROW SHAPE FOR BOTH MASTERS, so the table, the filters, the search
     and the division rules do not have to know which of the two a row came
     from. `src` is the record itself, kept for whatever opens it. */
  function fgRow(p) {
    const keys = specKeysOf(p);
    return { kind: "fg", name: p.name || "", flags: p.flags || {},
      code: p.code || p.id, thickness: p.thickness || "", series: p.series || "",
      ref: refLabel(p.refMode).replace(" No.", ""),
      /* catalogue keys only, plus the product's own — an own parameter that
         carries a limit is in both lists and was being counted twice */
      params: PARAMS.filter((x) => keys.indexOf(x.key) >= 0).length + customOf(p).length,
      specSet: !!(p.specSet || keys.length), src: p };
  }
  /* A WIP IS A STAGE OF A FINISHED GOOD, AND IS MEASURED ON WHAT THAT
     FINISHED GOOD IS MEASURED ON. The coated jumbo IS the tape before it is
     slit — its thickness, its GSM, its BDV are the tape's, and the reading the
     coating floor files against a batch is already graded on the product's TDS
     spec. So a WIP carries no spec of its own here: it inherits the lab product
     of the finished good it is a stage of (`stageOf` → the FG item → the lab
     product raised against it), and opening the row opens that product. One set
     of limits, edited in one place, and the two cannot drift apart. */
  const lpForItem = (itemId) => (itemId ? products().find((p) => p.itemId === itemId) : null) || null;
  function itemRow(i) {
    const lp = i.cat === "WIP" ? lpForItem(i.stageOf) : null;
    if (lp) {
      const keys = specKeysOf(lp);
      return { kind: "wip", name: i.name || i.id, flags: lp.flags || {},
        code: i.id,
        thickness: i.thicknessMM != null ? String(i.thicknessMM) : (lp.thickness || ""),
        series: lp.series || i.grp || "",
        ref: "of " + (lp.code || lp.id),
        params: PARAMS.filter((x) => keys.indexOf(x.key) >= 0).length + customOf(lp).length,
        specSet: !!(lp.specSet || keys.length),
        inherits: lp, src: i };
    }
    const spec = i.qcSpec || {};
    const listed = Array.isArray(i.qcParams) ? i.qcParams.length : 0;
    const own = Array.isArray(i.testParams) ? i.testParams.length : 0;
    return { kind: i.cat === "WIP" ? "wip" : "rm", name: i.name || i.material || i.id, flags: {},
      code: i.id, thickness: i.thicknessMM != null ? String(i.thicknessMM) : "",
      series: i.grade || i.grp || "", ref: "—",
      params: listed || own,
      /* the limits themselves are withheld from everyone but admin, exactly as
         a lab product's are — `qcSpecSet` is what says they exist */
      specSet: !!(i.qcSpecSet || Object.keys(spec).some((k) => hasLimit(spec[k]))), src: i };
  }
  const allRows = () => products().map(fgRow)
    .concat(items().filter((i) => i.cat === "RM" || i.cat === "WIP").map(itemRow));

  function renderProducts(root) {
    const labOnly = App.isLab();
    const isOffice = !isAdmin() && !labOnly;   // only these three roles reach this module
    const filter = App.viewState("labProductsFilter", () => ({ q: "", qRaw: "", kind: "all", series: "all", type: "all" }));   // survives a quiet refresh
    if (!filter.kind) filter.kind = "all";   // a filter kept from before this tab held materials
    const ps = allRows();
    const nOf = (k) => ps.filter((r) => r.kind === k).length;
    root.appendChild(h("div", { class: "grid kpi-grid", style: "margin-bottom:16px" }, [
      kpi({ icon: KIND.fg.ic,  label: "Finished goods",   value: ENG.num(nOf("fg")) }),
      kpi({ icon: KIND.rm.ic,  label: "Raw materials",    value: ENG.num(nOf("rm")) }),
      kpi({ icon: KIND.wip.ic, label: "Work in process",  value: ENG.num(nOf("wip")) }),
      kpi({ icon: "🎯", label: "Limits set", value: ENG.num(ps.filter((r) => r.specSet).length) }),
    ]));
    const seriesList = [...new Set(ps.map((r) => r.series).filter(Boolean))].sort();
    root.appendChild(h("div", { class: "toolbar" }, [
      searchInput("Search product, material, code or division…", (v) => { filter.qRaw = v; filter.q = v.toLowerCase(); draw(); }, filter.qRaw),
      /* what kind of thing it is comes first — it is the axis the tab just
         grew, and the one anybody arriving here is dividing the list by */
      select([{ value: "all", label: "Everything (" + ps.length + ")" }]
        .concat(["fg", "rm", "wip"].filter((k) => nOf(k)).map((k) => ({ value: k, label: KIND[k].plural + " (" + nOf(k) + ")" }))),
        (v) => { filter.kind = v; draw(); }, filter.kind),
      select([{ value: "all", label: "All Series" }, ...seriesList.map((s) => ({ value: s, label: s }))], (v) => { filter.series = v; draw(); }, filter.series),
      typeFilter(),
      h("div", { style: "margin-left:auto" }, h("span", { class: "chip", id: "lpCount" })),
    ]));
    const host = h("div"); root.appendChild(host);

    /* THE TYPE FILTER SPANS BOTH AXES. "Tested as" is the three toggles, which
       decide a certificate's parameters; "Made of" is the division the name
       puts the row in — and a name divides a raw material exactly as it
       divides a tape, so a material answers this filter too. Only the entries
       the list actually holds are offered, each with its count, so the filter
       is as short as the catalogue makes it. */
    function typeFilter() {
      const counts = {};
      ps.forEach((x) => { const d = divisionOf(x.name); if (d) counts[d.key] = (counts[d.key] || 0) + 1; });
      const sel = h("select", { class: "select", title: "Filter by what a product is tested on, or by what its name says it is made of",
        onchange: (e) => { filter.type = e.target.value; draw(); } }, [h("option", { value: "all", text: "All Types" })]);
      const group = (label, opts) => {
        if (!opts.length) return;
        const g = h("optgroup", { label });
        opts.forEach((o) => g.appendChild(h("option", { value: o.v, text: o.l })));
        sel.appendChild(g);
      };
      group("Tested as", TYPE_TOGGLES
        .filter((t) => ps.some((x) => x.flags && x.flags[t.key]))
        .map((t) => ({ v: t.key, l: t.label + " (" + ps.filter((x) => x.flags && x.flags[t.key]).length + ")" })));
      group("Made of", DIVISIONS
        .filter((d) => counts[d.key])
        .map((d) => ({ v: "div:" + d.key, l: d.label + " (" + counts[d.key] + ")" })));
      /* the kept filter may name something the master no longer holds — the
         last cotton tape deleted, say. Rather than show "All Types" over an
         empty table, fall back to all of them for real. */
      if (filter.type !== "all" && !sel.querySelector('option[value="' + filter.type + '"]')) filter.type = "all";
      sel.value = filter.type;
      return sel;
    }

    function rows() {
      return ps.filter((r) => {
        if (filter.kind !== "all" && r.kind !== filter.kind) return false;
        if (filter.series !== "all" && r.series !== filter.series) return false;
        if (filter.type !== "all") {
          if (filter.type.indexOf("div:") === 0) {
            const d = divisionOf(r.name);
            if (!d || d.key !== filter.type.slice(4)) return false;
          } else if (!(r.flags && r.flags[filter.type])) return false;
        }
        // the division is searchable too, so "cotton" finds them however they are named
        if (filter.q) { const s = (r.name + " " + (r.code || "") + " " + (r.series || "") + " " + divisionLabel(r)).toLowerCase(); if (!s.includes(filter.q)) return false; }
        return true;
      }).sort((a, b) => (a.kind + a.series + a.code).localeCompare(b.kind + b.series + b.code));
    }

    /* WHICH EDITOR A ROW OPENS — the one that owns the record. A finished
       good's parameters and limits live on the lab product; a material's live
       on the stock item, and the QC dialog that edits them is lent whole by
       mod-inventory, so there is one editor for them and not a second one
       here that could drift from it.
       WHO MAY OPEN WHICH is not this table's invention — it is the split the
       server already enforces. Deciding which readings a MATERIAL needs is the
       incharge's trade as much as admin's (PUT /items/:id/qc takes admin and
       lab, and drops a non-admin's limits), while office books goods in and
       does not define how they are checked. A LAB PRODUCT is the master's.
       So the rows a role cannot edit open read-only rather than opening an
       editor whose Save would come back 403. */
    function openRow(r) {
      /* a WIP has no spec of its own — it opens the finished good's, which is
         the spec its batch is actually graded on */
      if (r.inherits) return mayEdit(r) ? productForm(r.inherits, r.src) : productDetail(r.inherits, r.src);
      if (r.kind === "fg") return mayEdit(r) ? productForm(r.src) : productDetail(r.src);
      return mayEdit(r) ? materialForm(r.src) : materialDetail(r.src);
    }
    // a WIP row edits the lab product behind it, so it follows the product rule
    const mayEdit = (r) => ((r.kind === "fg" || r.inherits) ? !labOnly : !isOffice);

    function draw() {
      const data = rows(); const c = UI.$("#lpCount");
      // how many divisions the filtered list spans — the heap has a shape now
      const nd = new Set(data.map((x) => divisionLabel(x))).size;
      if (c) c.textContent = data.length + " item" + (data.length === 1 ? "" : "s") + " · " + nd + " division" + (nd === 1 ? "" : "s");
      host.innerHTML = "";
      host.appendChild(table(data, [
        { key: "code", label: "Code / Type", width: "170px", render: (r) => `<span style="font-weight:600">${esc(r.code || "—")}</span>` },
        { key: "name", label: "Product / Material", cls: "nm", render: (r) => `<div style="overflow-wrap:anywhere">${esc(r.name)}</div>` },
        /* what the row IS, and — for a finished good — what its certificate is
           raised against, which is a property of the product and of nothing else */
        /* what the row IS, and — for a finished good — what its certificate is
           raised against, which is a property of the product and of nothing
           else. Two facts, one column: the tab grew an axis and the table did
           not need to grow a column for it. */
        { key: "kind", label: "Kind", width: "112px", sort: (r) => r.kind,
          render: (r) => badge(r.kind === "fg" ? "ok" : r.kind === "rm" ? "info" : "mut", KIND[r.kind].ic + " " + KIND[r.kind].short)
            + (r.ref && r.ref !== "—" ? `<div class="muted" style="font-size:11px;margin-top:3px">${esc(r.ref)}</div>` : "") },
        { key: "thickness", label: "Thk (mm)", width: "86px", render: (r) => esc(r.thickness || "—") },
        { key: "series", label: "Series / Grade", width: "128px", render: (r) => esc(r.series || "—") },
        { key: "type", label: "Type", render: (r) => `<div class="flex gap wrap">${typeCell(r)}</div>`, sort: (r) => divisionLabel(r) },
        /* HOW MANY PARAMETERS, AND WHETHER THEY GRADE — one column, because
           they are one question. A material nobody has configured is still
           tested, on the list its own record implies, so "derived" is the
           honest word for none set; and `specSet` is what non-admins receive,
           the limits themselves withheld so a tester cannot grade by eye. */
        { key: "params", label: "Tested on", width: "116px", sort: (r) => r.params,
          render: (r) => (r.params ? `${ENG.num(r.params)} param${r.params === 1 ? "" : "s"}`
            : `<span class="muted">derived</span>`)
            + `<div class="muted" style="font-size:11px;margin-top:3px">${r.specSet ? "limits set" : "no limits"}</div>` },
        { key: "act", label: "", noSort: true, width: "78px", render: (r) => actionCell([[mayEdit(r) ? "Edit" : "View", () => openRow(r)]]) },
      ], { onRow: openRow, empty: "Nothing matches your filters",
        /* the phone card, said outright rather than guessed from the column
           labels: the code heads it, the name identifies it, and the two facts
           worth a chip are what the row IS and what it is measured on */
        cardCols: ["kind", "params"], cardSubKey: "name" }));
    }
    draw();
  }

  /* A MATERIAL'S CARD, for the role that may read it and not change it.
     The parameter LABELS live in the incoming-test catalogue rather than in
     this module, so they are fetched once and remembered; until they arrive
     (and for a key the catalogue does not know) the key itself is shown, which
     is still the name of the reading and not a blank. */
  let GT_PARAMS = null;
  async function gtCatalogue() {
    if (GT_PARAMS) return GT_PARAMS;
    GT_PARAMS = (((await DB.grnTests.catalogue()) || {}).params) || [];
    return GT_PARAMS;
  }
  function materialDetail(i) {
    const own = Array.isArray(i.testParams) ? i.testParams : [];
    const keys = Array.isArray(i.qcParams) ? i.qcParams : [];
    const listHost = h("div");
    const label = (k) => {
      const c = (GT_PARAMS || []).find((q) => q.key === k) || own.find((q) => q.key === k);
      return c ? c.label + (c.unit ? " (" + c.unit + ")" : "") : k;
    };
    function drawList() {
      listHost.innerHTML = "";
      listHost.appendChild(keys.length
        ? h("div", { class: "flex gap wrap" }, keys.map((k) => h("span", { class: "chip", text: label(k) })))
        : h("div", { class: "muted", style: "font-size:12px", text: "No list set, so a receipt is checked on what the item master itself records — thickness, GSM, width — plus a visual check." }));
    }
    if (!GT_PARAMS) DB.grnTests.catalogue()
      .then((r) => { GT_PARAMS = (r && r.params) || []; if (listHost.isConnected) drawList(); })
      .catch(() => { GT_PARAMS = []; });
    drawList();
    const d = divisionOf(i.name);
    const cell = (k, v) => h("div", {}, [
      h("div", { class: "muted", style: "font-size:11px", text: k }),
      h("div", { style: "font-weight:600;margin-top:2px", html: v }),
    ]);
    const mo = modal({ title: i.name || i.id, sub: i.id + " · " + (i.cat === "WIP" ? "work in process" : "raw material"), wide: true,
      body: h("div", {}, [
        h("div", { class: "form-grid" }, [
          cell("Material", esc(i.name || "—")),
          cell("Item code", esc(i.id)),
          cell("Grade / Group", esc(i.grade || i.grp || "—")),
          cell("Thickness (mm)", esc(i.thicknessMM != null ? String(i.thicknessMM) : "—")),
          cell("GSM (g/m²)", esc(i.gsm != null ? String(i.gsm) : "—")),
          cell("Stocked in", esc(i.uom || "—")),
          cell("Division — read off the name", d ? badge("info", d.label) : `<span class="muted">General</span>`),
        ]),
        h("h3", { style: "margin:16px 0 6px;font-size:13px", text: "What the lab measures on every receipt" }),
        listHost,
        h("div", { class: "muted", style: "font-size:12px;margin-top:16px;line-height:1.6",
          text: "🔒 The parameter list is set by the admin or the lab incharge, and the pass/fail limits behind it are the admin's — they are not shown here." }),
      ]),
      foot: [h("button", { class: "btn primary", onclick: () => mo.close(), text: "Close" })] });
  }

  /* ============================================================
     THE ONE WAY A PARAMETER IS ADDED, wherever it is added from
     This was two bare rows of controls stacked on each other — a select and
     a button, then two boxes and another button — with the placeholder text
     carrying the whole meaning of each, and the product form and the material
     form each keeping their own copy. Nothing said that the first row picks
     something the catalogue already knows while the second invents something
     this product alone is tested on, which is the only thing about them worth
     knowing.
     So: one panel, set apart from the rows above it because adding is a
     different act from editing; a line of prose that draws the distinction
     once; and two labelled lines, each with the verb that fits it. Both forms
     call this, so the product's parameters and the material's are added the
     same way and cannot drift into two designs.
     ============================================================ */
  function addParamPanel(o) {
    const box = h("div", { style: "border:1px solid var(--line);border-radius:10px;padding:12px 13px;background:var(--panel-2)" }, [
      h("div", { style: "font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--text-dim)", text: "Add a parameter" }),
      h("div", { class: "muted", style: "font-size:11px;margin-top:3px;line-height:1.5", text: o.hint }),
    ]);
    const line = (label, controls) => h("div", { style: "margin-top:11px" }, [
      h("div", { style: "font-size:11px;font-weight:700;color:var(--text-dim);margin-bottom:5px", text: label }),
      h("div", { class: "flex gap aic wrap" }, controls),
    ]);
    if (o.options.length) {
      const sel = h("select", { class: "select", style: "flex:1 1 220px;min-width:0" },
        o.options.map((x) => h("option", { value: x.v, text: x.l })));
      box.appendChild(line("Pick a parameter", [sel,
        h("button", { class: "btn sm", html: "＋ Add", onclick: (e) => { e.preventDefault(); if (sel.value) o.onAdd(sel.value); } })]));
    } else {
      box.appendChild(line("Pick a parameter", [h("div", { class: "muted", style: "font-size:12px", text: o.allUsed })]));
    }
    const nameEl = h("input", { class: "input", placeholder: "Parameter name", style: "flex:1 1 190px;min-width:0", "data-enter": "ignore" });
    const unitEl = h("input", { class: "input", placeholder: "Unit", style: "flex:0 1 100px;width:100px;min-width:72px", "data-enter": "ignore" });
    // the boxes clear only when the parameter was actually made — a rejected
    // name stays put to be corrected rather than retyped
    const create = (e) => {
      if (e) e.preventDefault();
      if (o.onCreate((nameEl.value || "").trim(), (unitEl.value || "").trim())) { nameEl.value = ""; unitEl.value = ""; }
    };
    [nameEl, unitEl].forEach((el) => el.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); create(); } }));
    box.appendChild(line(o.createLabel || "Or name a new one", [nameEl, unitEl,
      h("button", { class: "btn sm", html: "＋ Create", onclick: create })]));
    return box;
  }

  /* ============================================================
     A MATERIAL'S EDIT DIALOG, IN THE SHAPE OF THE PRODUCT ONE
     A raw material opened from this tab used to raise the stock module's QC
     dialog — a tick-list of checkboxes, laid out nothing like the product
     sitting beside it in the same table. One page, one table, and two
     different forms answering the same question: what is this tested on, and
     what counts as a pass.
     This is the product form's layout over the material's own data. What the
     ITEM MASTER owns — the name, the code, the thickness, the GSM — is shown
     and not editable here; changing those is Stock Items' business, and a lab
     screen is no place to rename a material. What the LAB owns — the
     parameters and their limits — is the editable half, laid out row for row
     exactly as a product's spec is.
     It writes through the same endpoint the stock dialog does
     (grnTests.setItemQc), so the two can never disagree, and it keeps that
     endpoint's division: which readings a material needs is the incharge's
     trade as much as admin's, while the limits are admin's alone.
     ============================================================ */
  async function materialForm(it) {
    const admin = isAdmin();
    let cat = [];
    try { cat = await gtCatalogue(); }
    catch (e) { toast(e.message || "Could not load the parameter catalogue", { type: "danger" }); return; }

    const spec = (it.qcSpec && typeof it.qcSpec === "object") ? it.qcSpec : {};
    const listed = Array.isArray(it.qcParams) ? it.qcParams : [];
    const own0 = Array.isArray(it.testParams) ? it.testParams : [];
    const ownKeys = new Set(own0.map((q) => q.key));
    const bounds = (sp) => {
      const extra = {};
      ["nominal", "tol", "unparsed"].forEach((k) => { if (sp && sp[k] != null) extra[k] = sp[k]; });
      return { min: sp && sp.min != null ? sn(sp.min) : "", max: sp && sp.max != null ? sn(sp.max) : "", extra };
    };
    /* the catalogue rows this material is tested on, then its own. A material
       carries a parameter whether or not a limit grades it — unlike a lab
       product, whose spec IS its list — so a row with empty boxes is a real
       row here: the reading is recorded, and the form says so. */
    let rows = cat.filter((c) => listed.indexOf(c.key) >= 0 && !ownKeys.has(c.key))
      .map((c) => Object.assign({ key: c.key, label: c.label, unit: c.unit || "", type: c.type || "num" }, bounds(spec[c.key])));
    let ownRows = own0.filter((q) => q && q.key && q.label)
      .map((q) => Object.assign({ key: q.key, label: q.label, unit: q.unit || "", type: "num" }, bounds(spec[q.key])));

    const CUSTOM_KEY_RE = /^[a-z][a-zA-Z0-9_]{0,39}$/;
    const slugKey = (label) => { const t = String(label || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, ""); return t ? ("c_" + t).slice(0, 40) : ""; };
    const ro = (label, value) => U.field(label, `<input class="input" value="${esc(value == null || value === "" ? "—" : String(value))}" readonly>`);
    const d = divisionOf(it.name);

    const body = h("div", {}, [
      h("div", { class: "form-grid" }, [
        ro("Material Name", it.name || it.material || it.id),
        ro("Item Code", it.id),
        ro("Thickness (mm)", it.thicknessMM),
        ro("GSM (g/m²)", it.gsm),
        ro("Grade / Group", it.grade || it.grp),
        ro("Stocked in", it.uom),
      ]),
      h("div", { class: "muted", style: "font-size:11px;margin-top:6px", text: "The item master owns these — change them under Stock Items. What the lab measures on it is set below." }),
      h("div", { class: "flex aic", style: "gap:8px;margin-top:12px;flex-wrap:wrap" }, [
        h("span", { class: "muted", style: "font-size:11px", text: "Division — read off the name:" }),
        d ? h("span", { html: badge("info", d.label) }) : h("span", { class: "muted", style: "font-size:11px", text: "General — no material word in the name" }),
      ]),
      h("div", { style: "margin-top:16px" }, [
        h("h3", { style: "margin:6px 0 4px;font-size:13px", text: "QC Spec (backend only — hidden from data entry)" }),
        h("div", { class: "muted", style: "font-size:11px;margin-bottom:8px",
          text: admin
            ? "The parameters asked for on every receipt of this material. A min or a max grades the reading pass or fail; leave both blank and it is recorded, not graded. ✕ takes the parameter off."
            : "The parameters you will be asked to measure when this material is received. You may change that list; the pass/fail limits stay with the admin, so a reading cannot be graded against a limit the person measuring it chose." }),
        h("div", { id: "lp_qc" }),
        h("div", { id: "lp_qcadd", style: "margin-top:10px" }),
      ]),
    ]);

    const mo = modal({ title: "Edit Material", sub: it.id + " · what the lab measures on it", wide: true, body,
      foot: [h("button", { class: "btn ghost", onclick: () => mo.close(), text: "Cancel" }),
        h("button", { class: "btn primary", onclick: doSave, text: "Save Changes" })] });

    function capture() {
      rows.concat(ownRows).forEach((r) => {
        const mn = UI.$("#qs_min_" + r.key), mx = UI.$("#qs_max_" + r.key);
        if (mn) r.min = mn.value.trim();
        if (mx) r.max = mx.value.trim();
      });
    }
    function qcRow(r, onX, xTitle) {
      const note = r.extra.unparsed != null ? "TDS: " + r.extra.unparsed
        : r.extra.nominal != null ? "TDS target " + sn(r.extra.nominal) + (r.extra.tol != null ? " ± " + sn(r.extra.tol) : "")
        : "";
      /* a visual check has no min and no max to give it — it is recorded, and
         the row says so rather than offering two boxes that mean nothing */
      const boxes = r.type === "text"
        ? [h("div", { class: "muted", style: "flex:0 1 230px;font-size:12px", text: "recorded, not graded" })]
        : admin
          ? [h("input", { class: "input", id: "qs_min_" + r.key, type: "number", step: "any", placeholder: "min", style: "flex:0 1 110px;width:110px;min-width:76px", value: r.min }),
             h("input", { class: "input", id: "qs_max_" + r.key, type: "number", step: "any", placeholder: "max", style: "flex:0 1 110px;width:110px;min-width:76px", value: r.max })]
          : [h("div", { class: "muted", style: "flex:0 1 230px;font-size:12px", text: it.qcSpecSet ? "graded against a limit admin has set" : "limits set by admin" })];
      return h("div", { class: "flex gap aic wrap", style: "margin-bottom:6px" }, [
        h("div", { style: "flex:1 1 150px;min-width:0;font-size:13px",
          html: `${esc(r.label)} <span class="muted">(${esc(r.unit || "—")})</span>` + (note ? `<div class="muted" style="font-size:11px">${esc(note)}</div>` : "") }),
      ].concat(boxes, [
        h("button", { class: "icon-btn", title: xTitle, text: "✕",
          onclick: (e) => { e.preventDefault(); capture(); onX(); drawQc(); } }),
      ]));
    }
    function drawQc() {
      const host = UI.$("#lp_qc"); if (!host) return;
      host.innerHTML = "";
      if (!rows.length && !ownRows.length) {
        host.appendChild(h("div", { class: "muted", style: "font-size:12px;padding:6px 0",
          text: "No list set yet, so a receipt is checked on whatever the item master records — thickness, GSM, width — plus a visual check. Add a parameter below and it becomes explicit." }));
      }
      rows.forEach((r) => host.appendChild(qcRow(r, () => { rows = rows.filter((x) => x !== r); }, "Stop measuring " + r.label)));
      if (ownRows.length) {
        host.appendChild(h("div", { class: "cg-sec" }, [h("span", { text: "Its own parameters" }), h("span", { class: "sp" })]));
        ownRows.forEach((r) => host.appendChild(qcRow(r, () => { ownRows = ownRows.filter((x) => x !== r); }, "Remove " + r.label + " from this material")));
      }
      drawQcAdd();
    }
    function drawQcAdd() {
      const host = UI.$("#lp_qcadd"); if (!host) return;
      const used = rows.map((r) => r.key);
      const left = cat.filter((c) => used.indexOf(c.key) < 0 && !ownKeys.has(c.key));
      host.innerHTML = "";
      host.appendChild(addParamPanel({
        hint: "A catalogue parameter is one every material shares. One of its own belongs to this material alone — it is asked for on every receipt of it, and a limit grades it like any other.",
        options: left.map((c) => ({ v: c.key, l: c.label + (c.unit ? " (" + c.unit + ")" : "") })),
        allUsed: "Every catalogue parameter is already on this material's list.",
        onAdd(k) {
          const c = cat.find((x) => x.key === k); if (!c) return;
          capture();
          rows.push(Object.assign({ key: c.key, label: c.label, unit: c.unit || "", type: c.type || "num" }, bounds(spec[c.key])));
          rows.sort((a, b) => cat.findIndex((x) => x.key === a.key) - cat.findIndex((x) => x.key === b.key));
          drawQc();
          const box = UI.$("#qs_min_" + c.key); if (box) { try { box.focus(); } catch { /* not focusable yet */ } }
        },
        onCreate(label, unit) {
          if (!label) { toast("Give the parameter a name", { type: "warn" }); return false; }
          const key = slugKey(label);
          if (!key || !CUSTOM_KEY_RE.test(key)) { toast("The name " + label + " needs a letter or a digit", { type: "warn" }); return false; }
          const taken = cat.some((x) => x.key === key || String(x.label).toLowerCase() === label.toLowerCase())
            || ownRows.some((x) => x.key === key || x.label.toLowerCase() === label.toLowerCase());
          if (taken) { toast("That parameter is already on the list", { type: "warn" }); return false; }
          capture();
          ownKeys.add(key);
          ownRows.push({ key, label, unit, type: "num", min: "", max: "", extra: {} });
          drawQc();
          const box = UI.$("#qs_min_" + key); if (box) { try { box.focus(); } catch { /* not focusable yet */ } }
          return true;
        },
      }));
    }
    drawQc();

    function doSave() {
      capture();
      const params = rows.map((r) => r.key).concat(ownRows.map((r) => r.key));
      if (!params.length) { toast("Add at least one parameter, or cancel to keep the derived defaults", { type: "warn" }); return; }
      const out = {};
      if (admin) {
        for (const r of rows.concat(ownRows)) {
          if (r.type === "text") continue;
          const o = Object.assign({}, r.extra); delete o.min; delete o.max;
          if (String(r.min || "").trim() !== "") o.min = +r.min;
          if (String(r.max || "").trim() !== "") o.max = +r.max;
          if (o.min != null && o.max != null && o.min > o.max) { toast("Minimum cannot exceed maximum for " + r.label, { type: "warn" }); return; }
          // a parameter with no limit still belongs on the list above; it simply
          // has no entry in the spec, which is what "recorded, not graded" means
          if (o.min != null || o.max != null || o.nominal != null) out[r.key] = o;
        }
      }
      const custom = ownRows.map((r) => ({ key: r.key, label: r.label, unit: r.unit || "" }));
      mo.close();
      commit(() => DB.grnTests.setItemQc(it.id, params, out, custom), (res) => {
        /* Say when reports were re-graded. Changing a limit silently re-scores
           lots that were already signed off, and that is exactly the kind of
           change nobody should discover by accident. */
        toast(res && res.regraded
          ? "Parameters saved — " + res.regraded + " existing test report" + (res.regraded === 1 ? "" : "s") + " re-graded against the new limits"
          : "Parameters saved for " + (it.name || it.id), { type: "ok", title: "QC parameters" });
        if (admin && !Object.keys(out).length) toast("No limit is set, so readings on " + (it.name || it.id) + " are recorded, not graded pass or fail", { type: "warn", dur: 6000 });
      });
    }
  }

  /* THE INCHARGE'S VIEW OF A PRODUCT — everything about it but the numbers.
     The limits never reach his browser (viewService withholds them), so this is
     not a form with its fields disabled: there is nothing behind it to disable.
     He gets the product as it is defined and the parameters his certificate
     will ask him for, which is what working the batch in front of him takes —
     and no yardstick to tune a reading against by eye. */
  function productDetail(p, viaWip) {
    const par = paramsFor(p);
    const d = divisionOf(p.name);
    const cell = (k, v) => h("div", {}, [
      h("div", { class: "muted", style: "font-size:11px", text: k }),
      h("div", { style: "font-weight:600;margin-top:2px", html: v }),
    ]);
    const flagged = TYPE_TOGGLES.filter((t) => p.flags && p.flags[t.key]);
    const mo = modal({ title: p.code || p.name, sub: p.id + " · lab product", wide: true,
      body: h("div", {}, [
        viaWip ? h("div", { class: "muted", style: "font-size:12px;margin-bottom:12px;padding:9px 11px;border:1px solid var(--line);border-radius:9px;background:var(--panel-2)",
          html: `<b>${esc(viaWip.id)}</b> is a stage of this product, so it is measured on exactly these parameters — the spec below is the one its batch is graded against.` }) : null,
        h("div", { class: "form-grid" }, [
          cell("Product", esc(p.name || "—")),
          cell("Code / Type", esc(p.code || "—")),
          cell("Thickness (mm)", esc(p.thickness || "—")),
          cell("Series", esc(p.series || "—")),
          cell("Certificate raised against", esc(refLabel(p.refMode))),
          cell("Division — read off the name", d ? badge("info", d.label) : `<span class="muted">General</span>`),
        ]),
        h("h3", { style: "margin:16px 0 6px;font-size:13px", text: "Material type" }),
        h("div", { class: "flex gap wrap" }, flagged.length
          ? flagged.map((t) => h("span", { class: "chip", text: t.label }))
          : [h("span", { class: "muted", style: "font-size:12px", text: "General tape — the common parameters only" })]),
        h("h3", { style: "margin:16px 0 6px;font-size:13px", text: "What its certificate asks you for" }),
        par.length
          ? h("div", { class: "flex gap wrap" }, par.map((q) => h("span", { class: "chip", text: q.label + (q.unit ? " (" + q.unit + ")" : "") })))
          : h("div", { class: "muted", style: "font-size:12px", text: "No parameters set yet — its material type decides the list." }),
        h("div", { class: "muted", style: "font-size:12px;margin-top:16px;line-height:1.6",
          text: specKeysOf(p).length
            ? "🔒 The pass/fail limits behind these parameters are the admin's and are not shown here. Every reading you file is graded against them on the server."
            : "🔒 No limits are set on this product yet, so a reading is recorded rather than graded Pass or Fail." }),
      ].filter(Boolean)),
      foot: [h("button", { class: "btn primary", onclick: () => mo.close(), text: "Close" })] });
  }

  /* `viaWip` — the work-in-process row this was opened from, when it was: a
     stage has no product of its own to edit, so it edits the finished good's. */
  function productForm(existing, viaWip) {
    const edit = !!existing;
    const p = existing || { refMode: "batch", flags: {}, series: "Other", active: true };
    const f = (k, d) => (p[k] != null ? p[k] : (d == null ? "" : d));
    const flags = Object.assign({ mica: false, waterBlocking: false, semiConductive: false }, p.flags);
    const admin = isAdmin();

    const body = h("div", {}, [
      h("div", { class: "form-grid" }, [
        U.field("Product Name *", `<input class="input" id="lp_name" value="${esc(f("name"))}" placeholder="e.g. NON CONDUCTIVE WATER BLOCKING TAPE">`, "full"),
        U.field("Code / Type", `<input class="input" id="lp_code" value="${esc(f("code"))}" placeholder="e.g. CHDNW-20">`),
        U.field("Thickness (mm)", `<input class="input" id="lp_thk" value="${esc(f("thickness"))}" placeholder="e.g. 0.2">`),
        U.field("Series", `<input class="input" id="lp_series" value="${esc(f("series", "Other"))}">`),
        U.field("Reference Mode", U.selectHTML("lp_ref", [{ v: "batch", l: "Batch No. (stocked / repeat orders)" }, { v: "lot", l: "Lot / W.O. No. (made-to-order)" }], f("refMode", "batch"))),
      ]),
      h("h3", { style: "margin:14px 0 8px;font-size:13px", text: "Material Type (recorded on the certificate; the fallback list until a spec is set)" }),
      h("div", { class: "flex gap wrap", id: "lp_flags" }, TYPE_TOGGLES.map((t) => h("label", { class: "chip", style: "cursor:pointer" }, [
        h("input", { type: "checkbox", "data-flag": t.key, checked: flags[t.key] ? "checked" : null }), " " + t.label]))),
      h("div", { class: "muted", style: "font-size:11px;margin-top:6px", text: "Tip: leave all unticked for a general tape (common parameters only)." }),
      /* THE DIVISION IS NOT A FIELD — it is read off the name, so it is shown
         rather than asked for, and it moves as the name is typed. Seeing it
         here is what tells the operator that "RUBBERISED COTTON TAPE" files
         itself under Cotton, and that renaming a product re-files it. */
      h("div", { class: "flex aic", style: "gap:8px;margin-top:12px;flex-wrap:wrap" }, [
        h("span", { class: "muted", style: "font-size:11px", text: "Division — read off the name:" }),
        h("span", { id: "lp_div" }),
      ]),
      specSection(),
    ]);

    const mo = modal({ title: edit ? "Edit Product" : "New Lab Product",
      sub: viaWip ? p.id + " · the spec behind " + viaWip.id : (edit ? p.id : "Add to the lab product master"), wide: true, body,
      foot: [
        edit ? h("button", { class: "btn danger", onclick: () => delProduct(p, mo), text: "🗑 Delete" }) : null,
        h("button", { class: "btn ghost", onclick: () => mo.close(), text: "Cancel" }),
        h("button", { class: "btn primary", onclick: doSave, text: edit ? "Save Changes" : "Create Product" }),
      ].filter(Boolean) });

    function readFlags() { const o = {}; UI.$("#lp_flags").querySelectorAll("input[data-flag]").forEach((cb) => { o[cb.getAttribute("data-flag")] = cb.checked; }); return o; }

    // Admin-only spec editor (hidden from the report entry form entirely).
    /* ============================================================
       THE SPEC IS THE PARAMETERS SOMEBODY WROTE A NUMBER AGAINST
       This editor used to print a row for every parameter the material type
       allows, blank boxes and all. So a mica tape with limits on four things
       showed five rows, and the fifth — Elongation, with nothing in either
       box — read as a spec that had merely not been filled in yet. It is not
       a spec at all: it states no requirement, it grades nothing, and stored
       that way it would put a row on every certificate that could only ever
       read "no spec".
       So the list IS the spec. A parameter is added from the picker beneath
       it, clearing both bounds takes it out again on save, and ✕ removes it
       outright. What is on screen is what the product is graded on.
       ============================================================ */
    function specSection() {
      if (!admin) return h("div", { class: "muted", style: "font-size:12px;margin-top:14px", text: "🔒 Lab spec (min/max limits) is managed by admin and used to grade reports Pass/Fail." });
      return h("div", { style: "margin-top:16px" }, [
        h("h3", { style: "margin:6px 0 4px;font-size:13px", text: "Lab Spec (backend only — hidden from data entry)" }),
        h("div", { class: "muted", style: "font-size:11px;margin-bottom:8px", text: "The parameters this product is graded on. One bound is enough; clear both and the parameter comes off the spec. Add one from the list below." }),
        h("div", { id: "lp_spec" }),
        h("div", { id: "lp_specadd", style: "margin-top:10px" }),
      ]);
    }

    /* [{ key, min, max, extra }] — `extra` carries the TDS's own figures (the
       static target and the tolerance it was worked out from, or the source
       text that could not be parsed). They have no box here, and rebuilding an
       entry from the two boxes alone dropped them on every save; they ride
       along untouched instead. */
    let specRows = [];      // catalogue parameters that carry a limit
    /* THE PRODUCT'S OWN PARAMETERS. The catalogue is ten readings and no more,
       and a product is sometimes tested on something that is not among them.
       The lab product has carried `params` for this since 2026-09-02 — they go
       on every certificate of the product — but there was nowhere to put one
       in: they could only arrive with the material through the New Item form.
       They are edited here now, beside the limits, because a parameter and the
       limit it is graded by are one thought. Unlike a catalogue row, an own
       parameter is listed whether or not it has a limit — it is on the
       certificate either way — so its ✕ takes the parameter off the product,
       not merely its limit. */
    let ownRows = [];
    const CUSTOM_KEY_RE = /^[a-z][a-zA-Z0-9_]{0,39}$/;
    /* keyed exactly as labService.slugKey keys it, so the limit typed beside a
       new parameter is filed under the key the server will keep */
    const slugKey = (label) => { const t = String(label || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, ""); return t ? ("c_" + t).slice(0, 40) : ""; };
    const parByKey = (k) => PARAMS.find((x) => x.key === k) || ownRows.find((x) => x.key === k) || { key: k, label: k, unit: "" };
    const extraOf = (sp) => { const o = {}; ["nominal", "tol", "unparsed"].forEach((k) => { if (sp && sp[k] != null) o[k] = sp[k]; }); return o; };
    const boundsOf = (sp) => ({ min: sp && sp.min != null ? sn(sp.min) : "", max: sp && sp.max != null ? sn(sp.max) : "", extra: extraOf(sp) });
    /* THE WHOLE CATALOGUE IS ON OFFER, not the material type's slice of it.
       The picker used to show only the parameters the three toggles allow, so
       a mica tape with four limits already set offered exactly one more — one
       line in a dropdown, and the other five readings of the catalogue simply
       unreachable. The toggles were never the authority here anyway: since the
       spec became the certificate's parameter list, what a product is tested
       on is what somebody wrote a limit against, and a tape can perfectly well
       be held to a swell figure without being filed as water-blocking.
       So nothing is filtered out — not from the picker, not on seeding, and not
       on save, where a limit whose toggle happened to be off used to be dropped
       without a word. The toggles keep the two jobs that are really theirs:
       they are recorded on the certificate, and they decide the fallback list
       for a product whose spec is still empty. */
    function seedSpec() {
      const spec = p.spec || {};
      specRows = PARAMS.filter((par) => hasLimit(spec[par.key]))
        .map((par) => Object.assign({ key: par.key }, boundsOf(spec[par.key])));
      ownRows = customOf(p).map((q) => Object.assign({ key: q.key, label: q.label, unit: q.unit || "" }, boundsOf(spec[q.key])));
    }
    // read the boxes back before anything redraws them, so a half-typed limit
    // survives adding a parameter or ticking a material type
    function captureSpec() {
      specRows.concat(ownRows).forEach((r) => {
        const mn = UI.$("#sp_min_" + r.key), mx = UI.$("#sp_max_" + r.key);
        if (mn) r.min = mn.value.trim();
        if (mx) r.max = mx.value.trim();
      });
    }
    /* one row, whichever list it came from. `onX` is what ✕ means here: a
       catalogue row loses its limit, an own parameter leaves the product. */
    function specRow(r, label, unit, note, onX, xTitle) {
      return h("div", { class: "flex gap aic wrap", style: "margin-bottom:6px" }, [
        h("div", { style: "flex:1 1 150px;min-width:0;font-size:13px",
          html: `${esc(label)} <span class="muted">(${esc(unit || "—")})</span>` + (note ? `<div class="muted" style="font-size:11px">${esc(note)}</div>` : "") }),
        h("input", { class: "input", id: "sp_min_" + r.key, type: "number", step: "any", placeholder: "min",
          style: "flex:0 1 110px;width:110px;min-width:76px", value: r.min }),
        h("input", { class: "input", id: "sp_max_" + r.key, type: "number", step: "any", placeholder: "max",
          style: "flex:0 1 110px;width:110px;min-width:76px", value: r.max }),
        h("button", { class: "icon-btn", title: xTitle, text: "✕",
          onclick: (e) => { e.preventDefault(); captureSpec(); onX(); drawSpec(); } }),
      ]);
    }
    /* the TDS's own words, shown rather than hidden: the admin can see what the
       sheet said even though there is no box to edit it in */
    const tdsNote = (r) => r.extra.unparsed != null ? "TDS: " + r.extra.unparsed
      : r.extra.nominal != null ? "TDS target " + sn(r.extra.nominal) + (r.extra.tol != null ? " ± " + sn(r.extra.tol) : "")
      : "";
    function drawSpec() {
      if (!admin) return;
      const host = UI.$("#lp_spec"); if (!host) return;
      host.innerHTML = "";
      if (!specRows.length && !ownRows.length) {
        host.appendChild(h("div", { class: "muted", style: "font-size:12px;padding:6px 0", text: "No limits set — readings are recorded, not graded. Add a parameter below." }));
      }
      specRows.forEach((r) => {
        const par = parByKey(r.key);
        host.appendChild(specRow(r, par.label, par.unit, tdsNote(r),
          () => { specRows = specRows.filter((x) => x !== r); }, "Take " + par.label + " off the spec"));
      });
      if (ownRows.length) {
        host.appendChild(h("div", { class: "cg-sec" }, [h("span", { text: "Its own parameters" }), h("span", { class: "sp" })]));
        host.appendChild(h("div", { class: "muted", style: "font-size:11px;margin-bottom:6px", text: "Asked for on every certificate of this product. A limit grades one like any other; without a limit the reading is recorded." }));
        ownRows.forEach((r) => {
          host.appendChild(specRow(r, r.label, r.unit, tdsNote(r),
            () => { ownRows = ownRows.filter((x) => x !== r); }, "Remove " + r.label + " from this product"));
        });
      }
      drawSpecAdd();
    }
    function drawSpecAdd() {
      const host = UI.$("#lp_specadd"); if (!host) return;
      const used = specRows.map((r) => r.key);
      const left = PARAMS.filter((par) => used.indexOf(par.key) < 0);
      const fl = readFlags();
      host.innerHTML = "";
      host.appendChild(addParamPanel({
        hint: "A catalogue parameter is one the whole master shares. One of its own belongs to this product alone — it goes on every certificate of it, and a limit grades it like any other.",
        /* the whole catalogue, with the ones outside this product's material
           type marked rather than withheld — they are unusual on such a tape,
           not forbidden on it */
        options: left.map((par) => ({ v: par.key,
          l: par.label + (par.unit ? " (" + par.unit + ")" : "")
            + (par.group !== "common" && !fl[par.group] ? "  — " + (TYPE_TOGGLES.find((t) => t.key === par.group) || {}).label : "") })),
        allUsed: "Every parameter in the catalogue already has a limit.",
        onAdd(k) {
          captureSpec();
          specRows.push(Object.assign({ key: k }, boundsOf((p.spec || {})[k])));
          // the catalogue's own order, so the list reads the same however it was built
          specRows.sort((a, b) => PARAMS.findIndex((x) => x.key === a.key) - PARAMS.findIndex((x) => x.key === b.key));
          drawSpec();
          const box = UI.$("#sp_min_" + k); if (box) { try { box.focus(); } catch { /* not focusable yet */ } }
        },
        onCreate(label, unit) {
          if (!label) { toast("Give the parameter a name", { type: "warn" }); return false; }
          const key = slugKey(label);
          if (!key || !CUSTOM_KEY_RE.test(key)) { toast("The name " + label + " needs a letter or a digit", { type: "warn" }); return false; }
          const taken = PARAMS.some((x) => x.key === key || x.label.toLowerCase() === label.toLowerCase())
            || ownRows.some((x) => x.key === key || x.label.toLowerCase() === label.toLowerCase());
          if (taken) { toast("That parameter is already on the list", { type: "warn" }); return false; }
          captureSpec();
          ownRows.push({ key, label, unit, min: "", max: "", extra: {} });
          drawSpec();
          const box = UI.$("#sp_min_" + key); if (box) { try { box.focus(); } catch { /* not focusable yet */ } }
          return true;
        },
      }));
    }
    seedSpec();
    drawSpec();
    /* Ticking a type no longer takes anybody's limits away — it only re-marks
       the picker, since a parameter outside the type is offered all the same. */
    UI.$("#lp_flags").addEventListener("change", () => {
      if (!admin) return;
      captureSpec();
      drawSpec();
    });
    function showDivision() {
      const host = UI.$("#lp_div"); if (!host) return;
      const nm = (UI.$("#lp_name") || {}).value || "";
      const d = divisionOf(nm);
      host.innerHTML = d ? badge("info", d.label)
        : `<span class="muted" style="font-size:11px">${nm.trim() ? "General — no material word in the name" : "—"}</span>`;
    }
    showDivision();
    { const nm = UI.$("#lp_name"); if (nm) nm.addEventListener("input", showDivision); }

    // the product's own parameters, as the server wants them
    const collectParams = () => (admin ? ownRows.map((r) => ({ key: r.key, label: r.label, unit: r.unit || "" })) : (p.params || []));
    /* null, having said what is wrong, rather than a spec that grades backwards */
    function collectSpec() {
      if (!admin) return p.spec || {};
      captureSpec();
      const spec = {};
      for (const r of specRows.concat(ownRows)) {
        const o = Object.assign({}, r.extra);
        delete o.min; delete o.max;
        if (String(r.min || "").trim() !== "") o.min = +r.min;
        if (String(r.max || "").trim() !== "") o.max = +r.max;
        if (o.min != null && o.max != null && o.min > o.max) {
          toast("Minimum cannot exceed maximum for " + parByKey(r.key).label, { type: "warn" });
          return null;
        }
        /* A ROW STATING NOTHING IS NOT A SPEC. Cleared of both bounds, with no
           figure from the TDS behind it, it comes off rather than being stored
           blank — the same rule the server keeps (labService.cleanSpec). */
        if (hasLimit(o)) spec[r.key] = o;
      }
      return spec;
    }

    function doSave() {
      const name = (UI.$("#lp_name").value || "").trim();
      if (!name) { toast("Product name is required", { type: "warn" }); return; }
      const payload = {
        name, code: (UI.$("#lp_code").value || "").trim(), thickness: (UI.$("#lp_thk").value || "").trim(),
        series: (UI.$("#lp_series").value || "").trim() || "Other", refMode: UI.$("#lp_ref").value,
        flags: readFlags(), params: collectParams(),
      };
      /* THE LIMITS ARE ADMIN'S, AND ARE NOT SENT BY ANYONE ELSE. Office never
         received them — viewService hands it an empty spec so a reading cannot
         be graded by eye — and that empty object was being written straight
         back, so an office edit of a product's name silently erased its whole
         TDS spec. Leaving the key off the payload lets the server's own merge
         keep what is stored. */
      if (admin) {
        const spec = collectSpec();
        if (spec === null) return;                     // collectSpec has already said why
        payload.spec = spec;
      }
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
    grnPendingWork: { mod: "lab-reports", ic: "🚚", label: "Raw material tests (GRN)",
      run: () => App.go("lab-reports", { view: "incoming" }) },
  });
})();
