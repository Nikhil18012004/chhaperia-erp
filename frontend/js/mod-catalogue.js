/* ============================================================
   CHHAPERIA ERP — THE CATALOGUE, ONE SHOT (2026-09-02)
   A new material or product with, in the same dialog, the
   parameters the lab tests it on (searched from what is already in
   use, or added new with a unit and a static figure or a range) and
   its recipe — created for a product, or joined for a material.
   Admin and office save it at once. The lab incharge SENDS it: it
   lands in the approval queue, and reaches the catalogue only when
   an admin approves it (the queue is the second half of this file).
   Lives beside mod-inventory, which owns the Stock Items page and
   hands this module its form helpers through window._erpUtil.
   ============================================================ */
(function () {
  "use strict";
  const { h, esc, table, badge, toast, modal, confirm } = UI;
  const U = () => window._erpUtil || {};
  const num = (v) => (v == null || v === "" || isNaN(+v) ? null : +v);
  const catName = (id) => { const c = (ENG.data.categories || []).find((x) => x.id === id); return c ? c.name : id; };
  const itemName = (id) => { const it = ENG.item(id); return it ? it.name : id; };
  const fmtWhen = (iso) => { if (!iso) return "—"; try { return new Date(iso).toLocaleString(undefined, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }); } catch { return String(iso).slice(0, 16); } };
  /* the key a NEW parameter gets, the same way the server makes it — so a
     limit typed beside it is filed under the key the server will keep */
  const slug = (label) => { const s = String(label || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, ""); return s ? ("c_" + s).slice(0, 40) : ""; };

  let GT_CAT = null;   // the incoming-material catalogue, fetched once
  async function gtCatalogue() {
    if (GT_CAT) return GT_CAT;
    try { GT_CAT = (await DB.grnTests.catalogue()).params || []; } catch { GT_CAT = []; }
    return GT_CAT;
  }
  const labCat = () => U().labParams || [];

  /* EVERY PARAMETER ALREADY IN USE — the two catalogues and every material's
     or product's own — so a parameter is found and reused rather than typed
     again under a slightly different name. De-duplicated by name. */
  function paramPool() {
    const out = [], seen = new Set();
    const add = (p, std) => {
      const k = String(p.label || "").trim().toLowerCase();
      if (!k || seen.has(k)) return;
      seen.add(k);
      out.push({ key: p.key, label: p.label, unit: p.unit || "", std, type: p.type || "num" });
    };
    (GT_CAT || []).filter((p) => p.type !== "text").forEach((p) => add(p, true));
    labCat().forEach((p) => add(p, true));
    (ENG.data.items || []).forEach((i) => (i.testParams || []).forEach((p) => add(p, false)));
    (ENG.data.labProducts || []).forEach((lp) => (lp.params || []).forEach((p) => add(p, false)));
    return out.sort((a, b) => a.label.localeCompare(b.label));
  }

  /* ============================================================
     THE FORM
     ============================================================ */
  async function newItemWizard() {
    await gtCatalogue();
    const lab = !!(App.isLab && App.isLab());
    const F = U().field, SEL = U().selectHTML, SS = U().searchSelect;
    if (!F || !SS) { toast("Stock Items is not loaded yet — open it and try again", { type: "warn" }); return; }
    const cats = (ENG.data.categories || []).filter((c) => ["raw", "wip", "fg"].includes(c.kind) || true);
    const UNITS = [{ v: "KG", l: "Kilogram (kg)" }, { v: "MTR", l: "Metre (m)" }, { v: "SQM", l: "Square metre (sqm)" }, { v: "GRAM", l: "Gram (g)" }, { v: "LTR", l: "Litre (l)" }, { v: "NOS", l: "Numbers (nos)" }];

    /* ---- 2 · testing parameters: a row per parameter ---- */
    let tp = [], seq = 0;
    const tpHost = h("div");
    function addRow(p) {
      tp.push(Object.assign({ _k: ++seq, label: "", unit: "", std: false, key: "", mode: "range", v1: "", v2: "" }, p || {}));
      drawTp();
      const last = tp[tp.length - 1];
      setTimeout(() => { const el = UI.$("#tp_l_" + last._k) || UI.$("#tp_v1_" + last._k); if (el && !el.readOnly) el.focus(); else { const v = UI.$("#tp_v1_" + last._k); if (v) v.focus(); } }, 20);
    }
    function drawTp() {
      tpHost.innerHTML = "";
      if (!tp.length) { tpHost.appendChild(h("div", { class: "cg-empty", text: "No parameters yet — search one above, or add a new one." })); return; }
      const g = h("div", { class: "cg-grid tp" });
      ["#", "Parameter", "Type", "Value / Min", "Max", "UOM", ""].forEach((t) => g.appendChild(h("div", { class: "h", text: t })));
      tp.forEach((r, i) => {
        g.appendChild(h("div", { class: "n", text: String(i + 1) }));
        const lbl = h("input", { class: "input", id: "tp_l_" + r._k, value: r.label, placeholder: "Parameter name", readonly: r.std ? "" : null,
          title: r.std ? "A catalogue parameter — its name is fixed" : "", oninput: (e) => { r.label = e.target.value; } });
        g.appendChild(lbl);
        const mode = h("select", { class: "select", id: "tp_m_" + r._k, onchange: (e) => { r.mode = e.target.value; const mx = UI.$("#tp_v2_" + r._k); if (mx) { mx.disabled = r.mode === "static"; if (mx.disabled) { mx.value = ""; r.v2 = ""; } } const v1 = UI.$("#tp_v1_" + r._k); if (v1) v1.placeholder = r.mode === "static" ? "target" : "min"; } },
          [h("option", { value: "range", text: "Range" }), h("option", { value: "static", text: "Static" })]);
        mode.value = r.mode;
        g.appendChild(mode);
        g.appendChild(h("input", { class: "input", id: "tp_v1_" + r._k, type: "number", step: "any", value: r.v1, placeholder: r.mode === "static" ? "target" : "min", oninput: (e) => { r.v1 = e.target.value; } }));
        g.appendChild(h("input", { class: "input", id: "tp_v2_" + r._k, type: "number", step: "any", value: r.v2, placeholder: "max", disabled: r.mode === "static" ? "" : null, oninput: (e) => { r.v2 = e.target.value; } }));
        g.appendChild(h("input", { class: "input", id: "tp_u_" + r._k, value: r.unit, placeholder: "unit", readonly: r.std ? "" : null, oninput: (e) => { r.unit = e.target.value; } }));
        g.appendChild(h("button", { class: "icon-btn", title: "Remove", "aria-label": "Remove parameter", onclick: () => { tp = tp.filter((x) => x !== r); drawTp(); }, text: "✕" }));
      });
      tpHost.appendChild(g);
    }
    /* the search box over everything already in use; picking one adds a row
       and clears the box, ready for the next */
    const pickHost = h("div", { style: "flex:1;min-width:220px" });
    function drawPick() {
      const pool = paramPool().filter((p) => !tp.some((r) => r.label.trim().toLowerCase() === p.label.toLowerCase()));
      pickHost.innerHTML = SS("c_pick", pool.map((p) => ({ v: p.key + "|" + p.label, l: p.label + (p.unit ? " (" + p.unit + ")" : "") + (p.std ? "" : " · in use") })), "", "Search a parameter already in use — thickness, GSM, viscosity…");
      const hid = UI.$("#c_pick");
      if (hid) hid.addEventListener("change", () => {
        const v = hid.value; if (!v) return;
        const p = pool.find((x) => x.key + "|" + x.label === v); if (!p) return;
        addRow({ label: p.label, unit: p.unit, std: p.std, key: p.key });
        drawPick();
      });
    }
    const pickRow = h("div", { class: "flex aic", style: "gap:8px;flex-wrap:wrap" }, [
      pickHost,
      h("button", { class: "btn", onclick: () => addRow(), html: "＋ Add parameter" }),
    ]);

    /* ---- 3 · the recipe ---- */
    let bomOn = false, bomLines = [], bseq = 0;
    const bomHost = h("div");
    const compOpts = () => (ENG.data.items || []).filter((i) => ["RM", "PKG", "CON"].includes(i.cat)).map((i) => ({ v: i.id, l: i.name + "  ·  " + i.id }));
    const productOpts = () => (ENG.data.items || []).filter((i) => i.cat === "FG" && ENG.data.boms && ENG.data.boms[i.id]).map((i) => ({ v: i.id, l: (i.productName || i.name) + "  ·  " + i.id }));
    function catNow() { const e = UI.$("#c_cat"); return e ? e.value : "RM"; }
    function drawBom() {
      bomHost.innerHTML = "";
      const fg = catNow() === "FG";
      const tick = h("label", { class: "flex aic", style: "gap:8px;font-size:13px;cursor:pointer" }, [
        h("input", { type: "checkbox", id: "c_bomon", checked: bomOn ? "" : null, onchange: (e) => { bomOn = e.target.checked; drawBom(); } }),
        h("span", { text: fg ? "Create the recipe (BOM) for this product now" : "Add this material to an existing product's recipe" }),
      ]);
      bomHost.appendChild(tick);
      if (!bomOn) return;
      if (fg) {
        const g = h("div", { class: "cg-grid bm" });
        ["#", "Component", "Qty per kg", "Unit", ""].forEach((t) => g.appendChild(h("div", { class: "h", text: t })));
        if (!bomLines.length) bomLines.push({ _k: ++bseq, id: "", qty: "", unit: "KG" });
        bomLines.forEach((l, i) => {
          g.appendChild(h("div", { class: "n", text: String(i + 1) }));
          const host = h("div", { html: SS("c_bl_" + l._k, compOpts(), l.id, "Search material…") });
          g.appendChild(host);
          g.appendChild(h("input", { class: "input", type: "number", step: "any", min: "0", value: l.qty, placeholder: "0.000", oninput: (e) => { l.qty = e.target.value; } }));
          const u = h("select", { class: "select", onchange: (e) => { l.unit = e.target.value; } }, ["KG", "GRAM", "MG", "MTR", "SQM", "NOS"].map((x) => h("option", { value: x, text: x })));
          u.value = l.unit || "KG"; g.appendChild(u);
          g.appendChild(h("button", { class: "icon-btn", title: "Remove", "aria-label": "Remove component", onclick: () => { bomLines = bomLines.filter((x) => x !== l); drawBom(); }, text: "✕" }));
          setTimeout(() => { const hid = UI.$("#c_bl_" + l._k); if (hid) hid.addEventListener("change", () => { l.id = hid.value; }); }, 0);
        });
        bomHost.appendChild(g);
        bomHost.appendChild(h("div", { class: "flex aic", style: "gap:10px;margin-top:10px;flex-wrap:wrap" }, [
          h("button", { class: "btn sm", onclick: () => { bomLines.push({ _k: ++bseq, id: "", qty: "", unit: "KG" }); drawBom(); }, html: "＋ Add component" }),
          h("span", { class: "muted", style: "font-size:12px", text: "Yield %" }),
          h("input", { class: "input", id: "c_yield", type: "number", min: "1", max: "100", step: "any", value: UI.$("#c_yield") ? UI.$("#c_yield").value : "100", style: "width:90px" }),
        ]));
      } else {
        const opts = productOpts();
        if (!opts.length) { bomHost.appendChild(h("div", { class: "cg-empty", text: "No product has a recipe yet to add this material to." })); return; }
        bomHost.appendChild(h("div", { class: "form-grid", style: "margin-top:10px" }, [
          F("Product whose recipe this joins", SS("c_bp", opts, opts[0].v, "Search product…"), "full"),
          F("Quantity per kg of product", `<input class="input" id="c_bq" type="number" step="any" min="0" placeholder="e.g. 0.050">`),
          F("Unit", SEL("c_bu", ["KG", "GRAM", "MG", "MTR", "SQM", "NOS"].map((x) => ({ v: x, l: x })), "KG")),
        ]));
      }
    }

    /* ---- the dialog ---- */
    const body = h("div", {}, [
      h("div", { class: "cg-sec" }, [h("span", { text: "1 · The item" }), h("span", { class: "sp" })]),
      h("div", { class: "form-grid" }, [
        F("Item Code *", `<input class="input" id="c_id" placeholder="e.g. RM-XYZ (suggested from the name)">`),
        F("Item Name *", `<input class="input" id="c_name" placeholder="Descriptive name">`),
        F("Category", SEL("c_cat", cats.map((c) => ({ v: c.id, l: c.name })), "RM")),
        F("Unit of Measure", SEL("c_uom", UNITS, "KG")),
        F("Thickness (mm)", `<input class="input" id="c_thk" type="number" step="0.001" placeholder="e.g. 0.05">`),
        F("GSM (g/m²)", `<input class="input" id="c_gsm" type="number" step="0.1" placeholder="e.g. 90">`),
        F("Std Cost (₹)", `<input class="input" id="c_cost" type="number" step="0.01" value="0">`),
        F("Selling Price (₹)", `<input class="input" id="c_price" type="number" step="0.01" value="0">`),
        F("Reorder Point", `<input class="input" id="c_reorder" type="number" value="0">`),
        F("Lead Time (days)", `<input class="input" id="c_lead" type="number" value="7">`),
        F("HSN Code", `<input class="input" id="c_hsn">`),
        F("GST Rate (%)", `<input class="input" id="c_gst" type="number" step="0.1" value="18">`),
      ]),
      h("div", { class: "cg-sec" }, [h("span", { text: "2 · Testing parameters" }), h("span", { class: "sp" })]),
      h("p", { class: "dim", style: "font-size:12px;margin:0 0 8px;line-height:1.5",
        text: "What the lab measures on it — on every receipt of a material, on every batch certificate of a product. Search a parameter already in use, or add a new one with its unit. A range grades the reading pass or fail; a static figure is the target printed beside it." }),
      pickRow,
      tpHost,
      h("div", { class: "cg-sec" }, [h("span", { text: "3 · Recipe (BOM)" }), h("span", { class: "sp" })]),
      bomHost,
    ]);
    const btnLabel = lab ? "Send for approval" : "Create Item";
    const btn = h("button", { class: "btn primary", onclick: save, text: btnLabel });
    const mo = modal({ title: lab ? "Propose a new item" : "New Item — one shot",
      sub: lab ? "Goes to the admin for approval; nothing lands until then" : "The item, what the lab tests it on, and its recipe — all at once",
      wide: true, body, foot: [h("button", { class: "btn ghost", onclick: () => mo.close(), text: "Cancel" }), btn] });
    drawPick(); drawTp(); drawBom();
    /* the code follows the name — CATEGORY-STEM, the way the catalogue is
       coded — until the operator edits the code by hand */
    setTimeout(() => {
      const nameEl = UI.$("#c_name"), codeEl = UI.$("#c_id"), catEl = UI.$("#c_cat");
      if (!nameEl || !codeEl || !catEl) return;
      let auto = true;
      const suggest = () => { if (!auto) return; const stem = String(nameEl.value || "").toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, ""); codeEl.value = stem ? (catEl.value || "RM") + "-" + stem : ""; };
      codeEl.addEventListener("input", () => { auto = false; });
      nameEl.addEventListener("input", suggest);
      catEl.addEventListener("change", () => { suggest(); drawBom(); });
      nameEl.focus();
    }, 30);

    async function save() {
      const g = (id) => { const e = UI.$("#" + id); return e ? e.value : ""; };
      const id = g("c_id").trim().toUpperCase(), name = g("c_name").trim(), cat = g("c_cat");
      if (!id || !name) { toast("Code and name are required", { type: "warn" }); return; }
      if (ENG.item(id)) { toast("Item code already exists", { type: "danger" }); return; }
      const item = { id, name, cat, uom: g("c_uom"), thicknessMM: num(g("c_thk")), gsm: num(g("c_gsm")),
        cost: num(g("c_cost")) || 0, price: num(g("c_price")) || 0, reorder: num(g("c_reorder")) || 0,
        lead: num(g("c_lead")) || 7, hsn: g("c_hsn").trim(), gstRate: g("c_gst") === "" ? 18 : +g("c_gst") };
      /* the readings: a catalogue parameter of a MATERIAL keeps its catalogue
         key; everything else — a product's parameters, a new one — is the
         item's own, keyed from its name the same way the server keys it */
      const gtKeys = new Set((GT_CAT || []).map((p) => p.key));
      const params = [], custom = [], spec = {}, seenKeys = new Set();
      for (const r of tp) {
        const label = String(r.label || "").trim();
        if (!label) { toast("Every parameter needs a name — or remove the empty row", { type: "warn" }); return; }
        let key;
        if (cat !== "FG" && r.std && gtKeys.has(r.key)) { key = r.key; params.push(key); }
        else { key = slug(label); if (!key) { toast("The parameter name " + label + " needs a letter or a digit", { type: "warn" }); return; } custom.push({ key, label, unit: String(r.unit || "").trim() }); }
        if (seenKeys.has(key)) { toast("The parameter " + label + " is listed twice", { type: "warn" }); return; }
        seenKeys.add(key);
        const v1 = num(r.v1), v2 = num(r.v2);
        if (r.mode === "static") { if (v1 != null) spec[key] = { nominal: v1 }; }
        else if (v1 != null || v2 != null) {
          if (v1 != null && v2 != null && v1 > v2) { toast("Minimum cannot exceed maximum for " + label, { type: "warn" }); return; }
          spec[key] = {}; if (v1 != null) spec[key].min = v1; if (v2 != null) spec[key].max = v2;
        }
      }
      let bom = { mode: "none" };
      if (bomOn && cat === "FG") {
        const lines = bomLines.filter((l) => l.id && num(l.qty) > 0).map((l) => ({ id: l.id, qty: +l.qty, unit: l.unit || "KG" }));
        if (!lines.length) { toast("Add at least one component with a quantity, or untick the recipe", { type: "warn" }); return; }
        bom = { mode: "create", yield: num(g("c_yield")) || 100, lines };
      } else if (bomOn && cat !== "FG") {
        const pid = g("c_bp"), q = num(g("c_bq"));
        if (!pid) { toast("Pick the product whose recipe this material joins", { type: "warn" }); return; }
        if (!(q > 0)) { toast("Enter the quantity per kg of product", { type: "warn" }); return; }
        bom = { mode: "append", productId: pid, qty: q, unit: g("c_bu") || "KG" };
      }
      btn.disabled = true; btn.textContent = lab ? "Sending…" : "Creating…";
      try {
        const r = await DB.catalogue.newItem({ item, tests: { params, custom, spec }, bom });
        mo.close();
        const n = params.length + custom.length;
        if (r.proposed) toast("Sent to the admin for approval — " + r.proposal.id + ". Follow it under My proposals.", { type: "ok", title: "Proposal sent", dur: 6000 });
        else toast(name + " created" + (n ? " with " + n + " test parameter" + (n === 1 ? "" : "s") : "")
          + (bom.mode === "create" ? " and its recipe" : bom.mode === "append" ? ", added to the recipe of " + bom.productId : ""), { type: "ok", title: "New item", dur: 5000 });
        await App.reloadState();
      } catch (e) {
        toast(e.message || "Could not save", { type: "danger" });
        btn.disabled = false; btn.textContent = btnLabel;
      }
    }
  }

  /* ============================================================
     THE APPROVAL QUEUE — the admin's list, and the lab's own
     ============================================================ */
  const stTone = (s) => ({ Pending: "warn", Approved: "ok", Rejected: "danger" }[s] || "info");
  function specText(sp) {
    if (!sp) return "—";
    if (sp.nominal != null && sp.min == null && sp.max == null) return "target " + sp.nominal;
    const a = sp.min != null ? String(sp.min) : "", b = sp.max != null ? String(sp.max) : "";
    return a && b ? a + " – " + b : a ? "≥ " + a : b ? "≤ " + b : "—";
  }
  /* what a proposal holds, laid out for the person ruling on it */
  function payloadView(ap) {
    const p = ap.payload || {};
    const out = [];
    const kv = (rows) => h("div", { class: "cg-kv" }, rows.flatMap(([k, v]) => [h("span", { class: "k", text: k }), h("span", { text: v == null || v === "" ? "—" : String(v) })]));
    if (ap.kind === "item") {
      const it = p.item || {}, t = p.tests || {}, b = p.bom || {};
      out.push(h("div", { class: "cg-sec" }, [h("span", { text: "The item" }), h("span", { class: "sp" })]));
      out.push(kv([["Code", it.id], ["Name", it.name], ["Category", catName(it.cat)], ["Unit", it.uom], ["Thickness (mm)", it.thicknessMM], ["GSM", it.gsm], ["Std cost (₹)", it.cost], ["Selling price (₹)", it.price], ["HSN", it.hsn]]));
      const rows = [].concat((t.params || []).map((k) => {
        const cat = ((GT_CAT || []).concat(labCat())).find((q) => q.key === k) || { label: k, unit: "" };
        return { label: cat.label, unit: cat.unit, spec: (t.spec || {})[k] };
      }), (t.custom || []).map((c) => ({ label: c.label + " (new)", unit: c.unit, spec: (t.spec || {})[c.key] })));
      out.push(h("div", { class: "cg-sec" }, [h("span", { text: "Testing parameters (" + rows.length + ")" }), h("span", { class: "sp" })]));
      out.push(rows.length ? table(rows, [
        { key: "label", label: "Parameter", render: (r) => esc(r.label), noSort: true },
        { key: "spec", label: "Value", render: (r) => esc(specText(r.spec)), noSort: true, width: "140px" },
        { key: "unit", label: "UOM", render: (r) => esc(r.unit || "—"), noSort: true, width: "100px" },
      ], { mobileCards: false }) : h("div", { class: "cg-empty", text: "None" }));
      out.push(h("div", { class: "cg-sec" }, [h("span", { text: "Recipe" }), h("span", { class: "sp" })]));
      if (b.mode === "create") out.push(table(b.lines || [], [
        { key: "id", label: "Component", render: (l) => esc(itemName(l.id)) + ' <span class="mono muted">' + esc(l.id) + "</span>", noSort: true },
        { key: "qty", label: "Qty per kg", num: true, render: (l) => esc(l.qty), noSort: true, width: "120px" },
        { key: "unit", label: "Unit", render: (l) => esc(l.unit || "KG"), noSort: true, width: "90px" },
      ], { mobileCards: false }));
      else if (b.mode === "append") out.push(kv([["Joins the recipe of", itemName(b.productId) + " (" + b.productId + ")"], ["Quantity per kg", b.qty + " " + (b.unit || "KG")]]));
      else out.push(h("div", { class: "cg-empty", text: "No recipe" }));
    } else {
      const b = p.bom || {};
      out.push(h("div", { class: "cg-sec" }, [h("span", { text: "Recipe for " + (p.itemId || "") }), h("span", { class: "sp" })]));
      if (p.newItem) out.push(kv([["New product", p.newItem.name], ["Code", p.itemId], ["Unit", p.newItem.uom], ["Thickness (mm)", p.newItem.thicknessMM], ["GSM", p.newItem.gsm]]));
      out.push(kv([["Yield", (num(b.yield) != null ? (b.yield > 1 ? b.yield : b.yield * 100) : 100) + " %"]]));
      out.push(table(b.lines || [], [
        { key: "id", label: "Component", render: (l) => esc(l.id ? itemName(l.id) : (l.rm || "ranged")) + (l.id ? ' <span class="mono muted">' + esc(l.id) + "</span>" : ""), noSort: true },
        { key: "qty", label: "Qty per kg", num: true, render: (l) => esc(l.qty), noSort: true, width: "120px" },
        { key: "unit", label: "Unit", render: (l) => esc(l.unit || "KG"), noSort: true, width: "90px" },
      ], { mobileCards: false }));
    }
    return h("div", {}, out);
  }
  function listOf() {
    return (ENG.data.approvals || []).slice().sort((a, b) =>
      ((a.status === "Pending" ? 0 : 1) - (b.status === "Pending" ? 0 : 1)) || String(b.id).localeCompare(String(a.id)));
  }
  function queueTable(list, onRow) {
    return table(list, [
      { key: "id", label: "No.", width: "84px", render: (a) => '<span class="mono code">' + esc(a.id) + "</span>", sort: (a) => a.id },
      { key: "kind", label: "Kind", width: "110px", render: (a) => a.kind === "bom" ? "Recipe (BOM)" : "New item", sort: (a) => a.kind },
      { key: "summary", label: "What", cls: "nm", render: (a) => esc(a.summary || ""), sort: (a) => a.summary || "" },
      { key: "by", label: "Proposed by", width: "120px", render: (a) => esc(a.by || "—"), sort: (a) => a.by || "" },
      { key: "at", label: "When", width: "130px", render: (a) => esc(fmtWhen(a.at)), sort: (a) => a.at || "" },
      { key: "status", label: "Status", width: "110px", render: (a) => badge(stTone(a.status), a.status), sort: (a) => a.status },
      { key: "ruling", label: "Ruling", width: "160px", render: (a) => a.status === "Pending" ? '<span class="muted">awaiting the admin</span>' : esc((a.decidedBy || "") + (a.note ? " · " + a.note : "")), sort: (a) => a.decidedAt || "" },
    ], { onRow, empty: "Nothing proposed yet", mobileCards: false });
  }
  function approvalsDialog(openId) {
    const list = listOf();
    const mo = modal({ title: "🗂 Approvals", sub: "What the lab proposed for the catalogue, and what was ruled", wide: true,
      body: queueTable(list, (a) => { mo.close(); detail(a, () => approvalsDialog()); }),
      foot: [h("button", { class: "btn ghost", onclick: () => mo.close(), text: "Close" })] });
    if (openId) { const r = list.find((a) => a.id === openId); if (r) { mo.close(); setTimeout(() => detail(r, () => approvalsDialog()), 40); } }
  }
  function proposalsDialog() {
    const list = listOf();
    const mo = modal({ title: "🗂 My proposals", sub: "Sent to the admin — approved ones are in the catalogue, rejected ones are not", wide: true,
      body: queueTable(list, (a) => { mo.close(); detail(a, () => proposalsDialog()); }),
      foot: [h("button", { class: "btn ghost", onclick: () => mo.close(), text: "Close" })] });
  }
  function detail(ap, back) {
    const admin = !!(App.isAdmin && App.isAdmin());
    const mine = !!(App.user && ap.by === App.user.username);
    const note = h("input", { class: "input", id: "ap_note", placeholder: "Note for the record (optional)", "data-enter": "ignore" });
    const body = h("div", {}, [
      h("div", { class: "cg-kv", style: "margin-bottom:6px" }, [
        h("span", { class: "k", text: "Proposed by" }), h("span", { text: (ap.by || "—") + " · " + fmtWhen(ap.at) }),
        h("span", { class: "k", text: "Status" }), h("span", {}, [badge(stTone(ap.status), ap.status), ap.status !== "Pending" ? h("span", { class: "muted", style: "margin-left:8px;font-size:12px", text: (ap.decidedBy || "") + " · " + fmtWhen(ap.decidedAt) + (ap.note ? " · " + ap.note : "") }) : null]),
      ]),
      payloadView(ap),
      (admin && ap.status === "Pending") ? h("div", { class: "field", style: "margin-top:14px" }, [h("label", { text: "Ruling note" }), note]) : null,
    ]);
    const act = async (approve) => {
      if (!approve && !await confirm("Reject " + ap.id + "? Nothing lands in the catalogue and the lab is told.", { title: "Reject proposal", danger: true })) return;
      try {
        const r = await DB.approvals.decide(ap.id, approve, note.value.trim());
        mo.close();
        toast(approve ? (ap.kind === "bom" ? "Recipe applied" : "Item created") + " — " + ap.summary : "Proposal rejected", { type: approve ? "ok" : "warn", title: r.id + " " + r.status, dur: 5000 });
        await App.reloadState();
        if (back) back();
      } catch (e) { toast(e.message || "Could not rule on it", { type: "danger", dur: 7000 }); }
    };
    const withdraw = async () => {
      if (!await confirm("Withdraw " + ap.id + "? It leaves the queue.", { title: "Withdraw proposal", danger: true })) return;
      try { await DB.approvals.remove(ap.id); mo.close(); toast("Proposal withdrawn", { type: "ok" }); await App.reloadState(); if (back) back(); }
      catch (e) { toast(e.message || "Could not withdraw it", { type: "danger" }); }
    };
    const mo = modal({ title: (ap.kind === "bom" ? "Recipe proposal " : "New item proposal ") + ap.id, sub: ap.summary, wide: true, body,
      foot: [
        h("button", { class: "btn ghost", onclick: () => { mo.close(); if (back) back(); }, text: "Back" }),
        (mine && ap.status === "Pending") ? h("button", { class: "btn", onclick: withdraw, text: "Withdraw" }) : null,
        (admin && ap.status === "Pending") ? h("button", { class: "btn danger-solid", onclick: () => act(false), text: "Reject" }) : null,
        (admin && ap.status === "Pending") ? h("button", { class: "btn primary", onclick: () => act(true), text: "Approve — apply to the catalogue" }) : null,
      ].filter(Boolean) });
  }

  window.CAT = { newItemWizard, approvalsDialog, proposalsDialog, paramPool };
})();
