/* ============================================================
   CHHAPERIA ERP — SUPERVISOR PANEL (SUP)  ·  STAGE-AWARE
   Renders INSIDE the admin shell (#app) so it inherits the
   sidebar, topbar, dynamic accent + dark/light theme — but the
   nav is limited to production, and the content is big, tap-
   friendly job cards (no money, no sales, area-scoped).

   The job flows through a ROUTE of stages:
       Coating / Lamination → Slitting → Packing & Dispatch
   A card shows the whole route; the supervisor can only act on
   the stage that is currently in THEIR area. Completing a stage
   hands the job to the next area's panel automatically.
   ============================================================ */
(function (global) {
  "use strict";
  const H = UI.h, esc = UI.esc, toast = UI.toast;
  const { pageHead, kpi } = MW;

  const AREA_LABEL = { coating: "Coating / Lamination", slitting: "Slitting & Dispatch", fiberglass: "Fibre-Glass + Slitting & Dispatch", all: "All Production" };
  const AREA_ICON = { coating: "🎨", slitting: "✂️", fiberglass: "🧵", all: "🏭" };
  const STAGE_META = {
    coating:    { ic: "🎨", label: "Coating" },
    production: { ic: "🧵", label: "Production" },
    weaving:    { ic: "🧶", label: "Weaving" },
    wbcoat:     { ic: "🎨", label: "WB Coating" },
    slitting:   { ic: "✂️", label: "Slitting" },
    packing:    { ic: "📦", label: "Packing" },
  };
  const STATUS_COLOR = { "Completed": "var(--ok)", "In Production": "var(--info)", "Pending": "var(--text-mut)" };

  const SUP = {
    user: null, area: "all", data: null, filter: "active",

    async boot(user) {
      this.user = user;
      this.area = user.area || "all";

      const theme = (function () { try { return localStorage.getItem("chh_theme"); } catch { return null; } })() || "dark";
      document.documentElement.setAttribute("data-theme", theme);
      document.documentElement.setAttribute("data-accent", "orange");

      const sp = UI.$("#splash"); if (sp) { sp.classList.add("hide"); setTimeout(() => sp.remove(), 600); }
      UI.$("#login").hidden = true;
      const app = UI.$("#app"); app.hidden = false; app.classList.add("sup-mode");

      this.bindChrome();
      this.setUserChip();
      await this.refresh();
    },

    bindChrome() {
      const tt = UI.$("#themeToggle");
      if (tt) tt.onclick = () => {
        const cur = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
        document.documentElement.setAttribute("data-theme", cur);
        try { localStorage.setItem("chh_theme", cur); } catch {}
      };
      const mt = UI.$("#menuToggle"); if (mt) mt.onclick = () => UI.$("#app").classList.toggle("collapsed");
      const lo = UI.$("#logoutBtn"); if (lo) lo.onclick = () => App.logout();
      const on = UI.$("#orgName"), os = UI.$("#orgSub");
      if (on) on.textContent = (this.data && this.data.org ? this.data.org.short : "Chhaperia");
      if (os) os.textContent = "Production Floor";
    },

    setUserChip() {
      const u = this.user;
      const nm = UI.$("#userName"), rl = UI.$("#userRole"), av = UI.$("#userAvatar");
      if (nm) nm.textContent = u.name || u.username;
      if (rl) rl.textContent = "Supervisor · " + (AREA_LABEL[this.area] || this.area);
      if (av) av.textContent = (u.name || u.username).split(" ").map(x => x[0]).slice(0, 2).join("").toUpperCase();
    },

    async refresh() {
      const view = UI.$("#view");
      view.innerHTML = '<div class="sup-loading">Loading your jobs…</div>';
      try {
        this.data = await DB.loadAsync(); // role-scoped supervisor view
        if (this.data && this.data.org) { const on = UI.$("#orgName"); if (on) on.textContent = this.data.org.short; }
        this.buildNav();
        this.render();
      } catch (err) {
        view.innerHTML = '<div class="sup-loading">⚠ ' + esc(err.message) + '</div>';
      }
    },

    /* bucket a WO from THIS area's perspective */
    buckets() {
      const g = { active: [], incoming: [], done: [] };
      (this.data.workorders || []).forEach((w) => {
        if (w.dispatched || w.myDone) g.done.push(w);
        else if (w.mine) g.active.push(w);
        else g.incoming.push(w);   // upstream — coming to this area later
      });
      return g;
    },

    buildNav() {
      const g = this.buckets();
      const items = [
        { sec: "Production" },
        { id: "active", ic: "⚙️", label: "My Jobs", pill: g.active.length },
      ];
      if (g.incoming.length) items.push({ id: "incoming", ic: "⏳", label: "Coming Up", pill: g.incoming.length });
      items.push({ id: "done", ic: "✅", label: "Completed" });
      items.push({ id: "all", ic: "📋", label: "All Jobs" });
      items.push({ sec: "Store" });
      items.push({ id: "warehouses", ic: "🏬", label: "Warehouses" });

      const nav = UI.$("#nav"); nav.innerHTML = "";
      items.forEach((n) => {
        if (n.sec) { nav.appendChild(H("div", { class: "nav-section", text: n.sec })); return; }
        const item = H("div", { class: "nav-item" + (n.id === this.filter ? " active" : ""), onclick: () => { this.filter = n.id; this.buildNav(); this.render(); } }, [
          H("span", { class: "ic", text: n.ic }),
          H("span", { class: "lbl", text: n.label }),
        ]);
        if (n.pill) item.appendChild(H("span", { class: "pill", text: n.pill }));
        nav.appendChild(item);
      });
    },

    render() {
      const view = UI.$("#view"); view.innerHTML = "";
      view.classList.remove("fade-in"); void view.offsetWidth; view.classList.add("fade-in");

      if (this.filter === "warehouses") { this.renderWarehouses(view); view.scrollTop = 0; return; }

      const g = this.buckets();
      const hasIncoming = g.incoming.length > 0;
      const titleMap = { active: "My Jobs", incoming: "Coming Up", done: "Completed Jobs", all: "All Jobs" };

      UI.$("#crumbs").innerHTML = `<span>Chhaperia</span><span class="sep">/</span><span class="cur">${esc(titleMap[this.filter] || "My Jobs")}</span>`;

      view.appendChild(pageHead(
        AREA_ICON[this.area] + " " + (AREA_LABEL[this.area] || this.area),
        "Tap a job to move it to the next stage. Once you complete a stage it hands off to the next team automatically.",
        [
          H("button", { class: "btn primary", onclick: () => this.openProduce(), html: "➕ Add to Finished Stock" }),
          H("button", { class: "btn", onclick: () => this.refresh(), html: "↻ Refresh" }),
        ]
      ));

      view.appendChild(H("div", { class: "grid kpi-grid", style: "margin-bottom:18px" }, [
        kpi({ icon: "⚙️", label: "My Active Jobs", value: g.active.length, deltaType: "flat", delta: "in your area now", onClick: () => { this.filter = "active"; this.buildNav(); this.render(); } }),
        kpi({ icon: "⏳", label: "Coming Up", value: g.incoming.length, deltaType: "flat", delta: "upstream, heading to you" }),
        kpi({ icon: "✅", label: "Completed", value: g.done.length, deltaType: "up", delta: "handed off / dispatched" }),
        kpi({ icon: "🏭", label: "Total Jobs", value: (this.data.workorders || []).length, deltaType: "flat", delta: "you're involved in" }),
      ]));

      const tabs = [["active", "My Jobs (" + g.active.length + ")"]];
      if (hasIncoming) tabs.push(["incoming", "Coming Up (" + g.incoming.length + ")"]);
      tabs.push(["done", "Completed"]); tabs.push(["all", "All"]);
      view.appendChild(H("div", { class: "sup-tabs" }, tabs.map(([k, lbl]) =>
        H("button", { class: "sup-tab" + (this.filter === k ? " on" : ""), onclick: () => { this.filter = k; this.buildNav(); this.render(); }, text: lbl })
      )));

      let show = this.filter === "all" ? (this.data.workorders || []).slice() : (g[this.filter] || []);
      show = this.sortJobs(show);

      const list = H("div", { class: "sup-list" });
      if (!show.length) {
        list.appendChild(H("div", { class: "sup-empty" }, [
          H("div", { class: "big", text: "🎉" }),
          H("div", { text: this.filter === "active" ? "No jobs in your area right now. You're all caught up!" : "Nothing here." }),
        ]));
      } else {
        show.forEach((w) => list.appendChild(this.card(w)));
      }
      view.appendChild(list);
      view.scrollTop = 0;
    },

    /* ============================================================
       Warehouses — VIEW ONLY. Stock by location for the floor:
       what each store holds and how much. Quantities only (the
       server never sends costs/values to supervisors) and no
       actions — no move, adjust or receive from here.
       ============================================================ */
    renderWarehouses(view) {
      UI.$("#crumbs").innerHTML = '<span>Chhaperia</span><span class="sep">/</span><span class="cur">Warehouses</span>';

      const whs = this.data.warehouses || [];
      const stockByWh = this.data.warehouseStock || {};
      const WH_ICON = { "Raw Material": "🧱", "WIP": "⚙️", "Finished Goods": "🎁", "Quarantine": "🔬" };
      const CAT_LABEL = { RM: "Raw Material", WIP: "Work in Progress", FG: "Finished Goods", PKG: "Packaging", CON: "Consumables" };

      view.appendChild(pageHead(
        "🏬 Warehouses",
        "What each store holds right now — view only. Tap a warehouse to see every material inside.",
        [H("button", { class: "btn", onclick: () => this.refresh(), html: "↻ Refresh" })]
      ));

      if (!whs.length) {
        view.appendChild(H("div", { class: "sup-empty" }, [
          H("div", { class: "big", text: "🏬" }),
          H("div", { text: "No warehouses set up yet." }),
        ]));
        return;
      }

      const grid = H("div", { class: "grid cols-2" });
      whs.forEach((w) => {
        const rows = stockByWh[w.id] || [];
        const top = rows.slice(0, 5);
        grid.appendChild(H("div", { class: "card hover", style: "cursor:pointer", onclick: () => detail(w), title: "View all materials in " + w.name }, [
          H("div", { class: "flex between aic" }, [
            H("div", {}, [
              H("h3", { style: "font-size:16px", text: w.name }),
              H("div", { class: "muted", style: "font-size:12px", text: [w.city, w.type].filter(Boolean).join(" · ") || w.id }),
            ]),
            H("div", { class: "kpi-ic", text: WH_ICON[w.type] || "🏬" }),
          ]),
          H("div", { class: "flex between", style: "margin:16px 0;padding:14px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)" }, [
            stat("Materials", rows.length ? String(rows.length) : "Empty"),
            stat("Type", w.type || "—"),
            stat("Access", "👁 View only"),
          ]),
          H("div", { class: "muted", style: "font-size:11px;font-weight:700;text-transform:uppercase;margin-bottom:8px", text: "Top items" }),
          H("div", {}, top.length ? top.map((r) => H("div", { class: "flex between", style: "font-size:12.5px;padding:4px 0" }, [
            H("span", { text: trim(r.name, 30) }),
            H("span", { class: "mono muted", text: fmtQty(r.qty) + " " + (r.uom || "") }),
          ])) : [H("div", { class: "muted", text: "No stock" })]),
          H("div", { class: "muted", style: "font-size:11.5px;margin-top:10px;text-align:right", text: "View all materials →" }),
        ]));
      });
      view.appendChild(grid);

      /* drill-down: every material held in this warehouse (read-only) */
      function detail(w) {
        const rows = stockByWh[w.id] || [];
        let q = "";
        const tableHost = H("div", { style: "max-height:56vh;overflow:auto" });
        const countChip = H("span", { class: "chip" });
        function draw() {
          const data = q ? rows.filter((r) => (r.name + " " + r.id + " " + (CAT_LABEL[r.cat] || r.cat)).toLowerCase().includes(q)) : rows;
          countChip.textContent = data.length + " material" + (data.length === 1 ? "" : "s");
          tableHost.innerHTML = "";
          tableHost.appendChild(UI.table(data, [
            { key: "item", label: "Material", render: (r) => `<div class="cell-main">${esc(trim(r.name, 36))}</div><div class="cell-sub">${esc(r.id)}</div>`, sort: (r) => r.name },
            { key: "cat", label: "Category", render: (r) => `<span class="muted">${esc(CAT_LABEL[r.cat] || r.cat || "—")}</span>`, sort: (r) => r.cat },
            { key: "qty", label: "Quantity", num: true, render: (r) => `<span style="font-weight:700">${fmtQty(r.qty)}</span> <span class="muted">${esc(r.uom || "")}</span>`, sort: (r) => r.qty },
          ], { empty: q ? "No materials match" : "No stock in this warehouse", sort: "qty", dir: -1 }));
        }
        const body = H("div", {}, [
          H("div", { class: "toolbar", style: "margin-bottom:10px" }, [
            MW.searchInput("Search material, code, category…", (v) => { q = v.toLowerCase(); draw(); }),
            H("div", { style: "margin-left:auto" }, countChip),
          ]),
          tableHost,
        ]);
        const mo = UI.modal({
          title: (WH_ICON[w.type] || "🏬") + " " + w.name,
          sub: [w.city, w.type].filter(Boolean).join(" · ") + " — all materials on hand · view only",
          body,
          foot: [H("button", { class: "btn ghost", onclick: () => mo.close(), text: "Close" })],
        });
        draw();
      }
    },

    assignmentStamp(w) {
      const route = w.route || [];
      const idx = Math.min(Math.max(w.stageIdx || 0, 0), Math.max(route.length - 1, 0));
      const prev = idx > 0 ? route[idx - 1] : null;
      return (prev && prev.doneAt) || w.date || w.updatedAt || "";
    },

    workOrderSeq(w) {
      const m = /(\d+)(?!.*\d)/.exec(String(w.id || ""));
      return m ? +m[1] : 0;
    },

    sortJobs(rows) {
      const prio = { Urgent: 0, High: 1, Normal: 2, Low: 3 };
      const bucketRank = (w) => w.mine ? 0 : (!w.myDone && !w.dispatched ? 1 : 2);
      return rows.slice().sort((a, b) => {
        const br = bucketRank(a) - bucketRank(b);
        if (this.filter === "all" && br) return br;
        const ad = String(this.assignmentStamp(a));
        const bd = String(this.assignmentStamp(b));
        const rec = bd.localeCompare(ad);
        if (rec) return rec;
        const seq = this.workOrderSeq(b) - this.workOrderSeq(a);
        if (seq) return seq;
        const p = (prio[a.priority] ?? 2) - (prio[b.priority] ?? 2);
        if (p) return p;
        return String(a.due || "").localeCompare(String(b.due || ""));
      });
    },

    /* the route timeline: three connected stage pills */
    timeline(w) {
      const row = H("div", { class: "sup-timeline", style: "display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:10px 0 4px" });
      (w.route || []).forEach((s, i) => {
        if (i > 0) row.appendChild(H("span", { style: "color:var(--text-mut);font-size:13px", text: "→" }));
        const meta = STAGE_META[s.key] || { ic: "•", label: s.key };
        const isCur = i === w.stageIdx && !w.dispatched;
        const col = STATUS_COLOR[s.status] || "var(--text-mut)";
        const mark = s.status === "Completed" ? "✓" : (s.status === "In Production" ? "▶" : "•");
        row.appendChild(H("span", {
          title: s.name + " — " + s.status + (s.doneBy ? " (by " + s.doneBy + ")" : ""),
          style: "display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:999px;font-size:12px;font-weight:600;"
            + "border:1.5px solid " + col + ";color:" + col + ";"
            + (isCur ? "box-shadow:0 0 0 3px color-mix(in srgb," + col + " 22%, transparent);background:color-mix(in srgb," + col + " 12%, transparent)" : "background:transparent"),
        }, [H("span", { text: meta.ic }), H("span", { text: meta.label }), H("span", { style: "opacity:.8", text: mark })]));
      });
      if (w.dispatched) row.appendChild(H("span", { style: "margin-left:4px;font-size:12px;font-weight:700;color:var(--ok)", text: "🚚 Dispatched" }));
      return row;
    },

    card(w) {
      const p = w.product || {};
      const cur = w.stage || {};
      const due = w.due ? new Date(w.due) : null;
      const overdue = due && !w.dispatched && !w.myDone && DB.helpers.iso(due) < DB.helpers.iso(DB.helpers.today());

      const chipCol = STATUS_COLOR[cur.status] || "var(--text-mut)";
      const chipTxt = w.dispatched ? "Dispatched"
        : (w.mine ? (STAGE_META[cur.key] || {}).label + " · " + (cur.status === "In Production" ? "in progress" : "to start")
          : (w.myDone ? "Your part done" : "At " + ((STAGE_META[cur.key] || {}).label || cur.name)));

      const head = H("div", { class: "sup-card-head" }, [
        H("div", {}, [
          H("div", { class: "sup-card-prod", text: p.name || w.itemId || "Product" }),
          H("div", { class: "sup-card-meta", text: [p.typeCode, w.id].filter(Boolean).join(" · ") }),
        ]),
        H("div", { class: "sup-status", style: "color:" + chipCol + ";border-color:" + chipCol }, chipTxt),
      ]);

      const facts = H("div", { class: "sup-facts" }, [
        fact("Make", H("b", { text: fmtQty(w.qty) + " " + (p.uom || "") })),
        w.spec ? fact(w.spec.label, H("b", { style: w.spec.value == null ? "color:var(--danger)" : "", text: w.spec.value == null ? "— not set" : String(w.spec.value) })) : null,
        w.customer ? fact("Customer", w.customer) : null,
        p.widthMM ? fact("Width", (Array.isArray(p.widthMM) ? p.widthMM.join("/") : p.widthMM) + " mm") : null,
        w.due ? fact("Due", H("span", { style: overdue ? "color:var(--danger);font-weight:700" : "", text: w.due + (overdue ? " ⏰" : "") })) : null,
        w.priority && w.priority !== "Normal" ? fact("Priority", H("span", { style: "font-weight:700;color:var(--danger)", text: w.priority })) : null,
      ].filter(Boolean));

      // "Report extra material" — a small button tucked into the space to the right
      // of the facts (beside Priority). Shown while the job is in this supervisor's
      // hands, i.e. when they're drawing material from the store.
      let factsNode = facts;
      if (w.mine && !w.dispatched) {
        const xbtn = H("button", { class: "sup-excess-mini", title: "Report extra material taken from the store", onclick: () => this.openExcess(w) }, [
          H("span", { class: "ic", text: "⚠" }),
          H("span", { class: "lbl", text: "Extra" }),
        ]);
        factsNode = H("div", { class: "sup-facts-row" }, [facts, xbtn]);
      }

      // materials for THIS area's stage (only meaningful while it's their turn)
      let mat = null;
      if (w.mine && w.materials && w.materials.length) {
        mat = H("details", { class: "sup-mat" }, [
          H("summary", { text: "🧱 Materials for " + ((STAGE_META[cur.key] || {}).label || "this stage") + " (" + w.materials.length + ")" }),
          H("div", { class: "sup-mat-list" }, w.materials.map((m) =>
            H("div", { class: "sup-mat-row" }, [
              H("span", { text: m.name || m.id }),
              H("b", { text: fmtQty(m.required) + " " + (m.uom || "") }),
            ]))),
        ]);
      }

      const actions = H("div", { class: "sup-actions" });
      if (w.dispatched) {
        actions.appendChild(H("div", { class: "sup-done-tag", text: "✓ Dispatched" }));
      } else if (w.mine) {
        const label = (STAGE_META[cur.key] || {}).label || cur.name;
        if (cur.status === "Pending") {
          actions.appendChild(H("button", { class: "sup-act primary", onclick: (e) => this.act(w, "start", e.currentTarget), text: "▶ Start " + label }));
        } else if (cur.status === "In Production") {
          actions.appendChild(H("button", { class: "sup-act primary", onclick: (e) => this.act(w, "complete", e.currentTarget), text: "✓ Finish " + label }));
          actions.appendChild(H("button", { class: "sup-act ghost", onclick: (e) => this.act(w, "pause", e.currentTarget), text: "↩ Pause" }));
        }
      } else if (w.myDone && !w.dispatched && (w.route || []).every((s) => s.status === "Completed") && (this.area === "slitting" || this.area === "all")) {
        // fully made & packed, waiting to ship
        actions.appendChild(H("button", { class: "sup-act primary", onclick: (e) => this.act(w, "dispatch", e.currentTarget), text: "🚚 Mark Dispatched" }));
      } else if (!w.mine && !w.myDone) {
        actions.appendChild(H("div", { class: "sup-done-tag", style: "color:var(--text-mut)", text: "⏳ Waiting on " + ((STAGE_META[cur.key] || {}).label || cur.name) }));
      }

      return H("div", { class: "sup-card" + (overdue ? " overdue" : "") }, [head, this.timeline(w), factsNode, mat, actions].filter(Boolean));
    },

    async act(w, action, btn) {
      if (btn) { btn.disabled = true; btn.textContent = "…"; }
      try {
        await DB.production.advance(w.id, action);
        const verb = { start: "started", complete: "completed", pause: "paused", dispatch: "dispatched" }[action] || action;
        toast((w.product ? w.product.name : w.id) + " — stage " + verb, { type: "ok" });
        await this.refresh();
      } catch (err) {
        toast(err.message, { type: "danger" });
        if (btn) btn.disabled = false;
        this.render();
      }
    },

    /* ============================================================
       Report extra material — the supervisor drew more raw material
       from the store than the job was issued. They justify each line
       (material, qty, location, reason); on submit each quantity is
       deducted from the store. No free-text note / overall comment.
       ============================================================ */
    openExcess(w) {
      const self = this;
      const RAW_CATS = ["RM", "PKG", "CON"];
      // materials this job/product actually uses (falls back to all raw materials)
      const jobMats = (w.materials || []).map((m) => ({ id: m.id, name: m.name, uom: m.uom || "" }));
      const mats = jobMats.length ? jobMats : (this.data.stockItems || []).filter((i) => RAW_CATS.includes(i.cat));
      const whs = this.data.warehouses || [];
      const stockMap = this.data.materialStock || {}; // itemId -> [{ wh, name, qty }]
      if (!mats.length) { toast("This job has no materials to report against yet.", { type: "warn" }); return; }
      const REASONS = ["Wastage / rework", "Machine setup loss", "Spillage / handling loss", "Quality rejection", "Extra coating pass", "Damaged material", "Other"];
      const uomOf = (id) => { const m = mats.find((x) => x.id === id); return m ? (m.uom || "") : ""; };
      // stores that actually hold this material (qty > 0); fall back to all warehouses
      const locsFor = (id) => {
        const rows = stockMap[id];
        if (rows && rows.length) return rows.map((r) => ({ id: r.wh, label: r.name + " · " + fmtQty(r.qty) + " " + uomOf(id) }));
        return whs.map((x) => ({ id: x.id, label: x.name }));
      };

      const linesBox = H("div", { class: "xm-lines" });
      const summ = H("span", { class: "xm-summ" });
      const saveBtn = H("button", { class: "btn primary", onclick: (e) => submit(e.currentTarget), text: "Deduct from store" });

      function rows() { return Array.prototype.slice.call(linesBox.querySelectorAll(".xm-line")); }
      function sync() {
        const valid = rows().map((r) => r._read()).filter((r) => r._valid);
        summ.textContent = valid.length
          ? valid.length + " material" + (valid.length > 1 ? "s" : "") + " · deducts from store on submit"
          : "Add a material, quantity and reason";
        saveBtn.disabled = !valid.length;
      }

      function addLine() {
        const matSel = H("select", { class: "select", onchange: () => { uomEl.textContent = uomOf(matSel.value); fillLoc(); } },
          mats.map((m) => H("option", { value: m.id, text: m.name })));
        const qtyInp = H("input", { class: "input", type: "number", min: "0", step: "any", placeholder: "0", oninput: sync });
        const uomEl = H("span", { class: "xm-uom", text: uomOf(matSel.value) });
        const locSel = H("select", { class: "select" });
        function fillLoc() { locSel.innerHTML = ""; locsFor(matSel.value).forEach((o) => locSel.appendChild(H("option", { value: o.id, text: o.label }))); }
        fillLoc();
        const otherInp = H("input", { class: "input", placeholder: "Type the reason", oninput: sync });
        const otherWrap = H("div", { class: "xm-fld", style: "display:none" }, [H("label", { text: "Other reason" }), otherInp]);
        const reasonSel = H("select", { class: "select",
          onchange: () => { otherWrap.style.display = reasonSel.value === "Other" ? "" : "none"; if (reasonSel.value === "Other") otherInp.focus(); sync(); } },
          REASONS.map((r) => H("option", { value: r, text: r })));
        const rm = H("button", { class: "xm-rm", title: "Remove", onclick: () => { row.remove(); sync(); }, text: "✕" });

        const row = H("div", { class: "xm-line" }, [
          H("div", { class: "xm-grid" }, [
            H("div", { class: "xm-fld" }, [H("label", { text: "Material" }), matSel]),
            H("div", { class: "xm-fld" }, [H("label", { text: "Qty" }), H("div", { class: "xm-qty" }, [qtyInp, uomEl])]),
            H("div", { class: "xm-fld" }, [H("label", { text: "Reason" }), reasonSel]),
          ]),
          H("div", { class: "xm-grid r2" }, [
            H("div", { class: "xm-fld" }, [H("label", { text: "Taken from" }), locSel]),
            otherWrap,
            rm,
          ]),
        ]);
        row._read = () => {
          const isOther = reasonSel.value === "Other";
          const reason = isOther ? otherInp.value.trim() : reasonSel.value;
          const qty = +qtyInp.value || 0;
          return { itemId: matSel.value, qty, location: locSel.value, reason,
            _valid: qty > 0 && matSel.value && (!isOther || otherInp.value.trim().length > 0) };
        };
        linesBox.appendChild(row);
        sync();
      }

      async function submit(btn) {
        const lines = rows().map((r) => r._read()).filter((r) => r._valid).map((r) => ({ itemId: r.itemId, qty: r.qty, location: r.location, reason: r.reason }));
        if (!lines.length) { toast("Add a material, quantity and reason (type it if you pick “Other”).", { type: "warn" }); return; }
        if (btn) { btn.disabled = true; btn.textContent = "…"; }
        try {
          await DB.production.recordExcess({ woId: w.id, lines });
          mo.close();
          toast(lines.length + " material" + (lines.length > 1 ? "s" : "") + " deducted from store", { type: "ok" });
          await self.refresh();
        } catch (err) {
          toast(err.message, { type: "danger" });
          if (btn) { btn.disabled = false; btn.textContent = "Deduct from store"; }
        }
      }

      const body = H("div", {}, [
        H("div", { class: "xm-ctx", html: "⚠ Log any raw material drawn from the store <b>beyond</b> what this job was issued. Each line is deducted from store on submit." }),
        H("div", { class: "xm-lines-h" }, [
          H("span", { class: "xm-t", text: "Materials taken" }),
          H("button", { class: "btn", onclick: () => addLine(), html: "＋ Add material" }),
        ]),
        linesBox,
      ]);
      const mo = UI.modal({
        title: "⚠ Extra material taken",
        sub: "WO " + w.id + " · deducts from store",
        body,
        foot: [summ, H("div", { class: "xm-foot-btns" }, [
          H("button", { class: "btn ghost", onclick: () => mo.close(), text: "Cancel" }),
          saveBtn,
        ])],
      });
      addLine();
    },

    /* ============================================================
       Add to Finished Stock — record production made on the floor.
       Deducts raw materials from the store per the product's BOM and
       adds the produced quantity to the warehouse the supervisor picks.
       ============================================================ */
    openProduce() {
      const products = this.data.finishedProducts || [];
      const warehouses = this.data.warehouses || [];
      if (!products.length) { toast("No finished product has a BOM recipe yet — ask office to add one first.", { type: "warn" }); return; }
      const self = this;
      const fgWh = warehouses.find((w) => String(w.type || "").toLowerCase().includes("finish")) || warehouses[0];

      const prodSel = MW.select(products.map((p) => ({ value: p.id, label: p.name })), () => draw(), products[0].id);
      const qtyInp = H("input", { class: "input", type: "number", min: "0", step: "any", value: "100", oninput: () => draw() });
      const whSel = MW.select(warehouses.map((w) => ({ value: w.id, label: w.name + (w.type ? " · " + w.type : "") })), () => {}, fgWh ? fgWh.id : (warehouses[0] || {}).id);
      [prodSel, qtyInp, whSel].forEach((el) => { el.style.width = "100%"; });
      const preview = H("div", { style: "margin-top:16px" });

      function currentProduct() { return products.find((p) => p.id === prodSel.value) || products[0]; }
      function draw() {
        const p = currentProduct();
        const qty = +qtyInp.value || 0;
        preview.innerHTML = "";
        preview.appendChild(H("div", { class: "muted", style: "font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px", text: "Raw materials to be deducted from store" }));
        if (!p.recipe || !p.recipe.length) { preview.appendChild(H("div", { class: "muted", text: "No recipe lines for this product." })); return; }
        p.recipe.forEach((r) => {
          preview.appendChild(H("div", { style: "display:flex;justify-content:space-between;gap:12px;font-size:13px;padding:7px 0;border-bottom:1px solid var(--line)" }, [
            H("span", { text: r.name }),
            H("b", { text: fmtQty(r.perUnit * qty) + " " + (r.uom || "") }),
          ]));
        });
        preview.appendChild(H("div", { style: "display:flex;justify-content:space-between;gap:12px;font-size:13.5px;padding:10px 0 0;font-weight:700;color:var(--ok)" }, [
          H("span", { text: "→ Added to finished stock" }),
          H("b", { text: fmtQty(qty) + " " + (p.uom || "") }),
        ]));
      }

      const body = H("div", {}, [
        field("Finished product", prodSel),
        field("Quantity produced", qtyInp),
        field("Store finished stock in", whSel),
        preview,
      ]);

      const mo = UI.modal({
        title: "➕ Add to Finished Stock",
        sub: "Deducts raw materials by BOM · adds the output to your chosen warehouse",
        body,
        foot: [
          H("button", { class: "btn ghost", onclick: () => mo.close(), text: "Cancel" }),
          H("button", { class: "btn primary", onclick: (e) => save(e.currentTarget), text: "Add to Finished Stock" }),
        ],
      });
      draw();

      async function save(btn) {
        const p = currentProduct();
        const qty = +qtyInp.value || 0;
        if (!qty || qty <= 0) { toast("Enter a valid quantity", { type: "warn" }); return; }
        if (btn) { btn.disabled = true; btn.textContent = "…"; }
        try {
          const res = await DB.production.addFinishedStock({ itemId: p.id, qty, wh: whSel.value });
          mo.close();
          const where = (res && res.produced && res.produced.whName) || "finished stock";
          toast("Added " + fmtQty(qty) + " " + (p.uom || "") + " of " + p.name + " → " + where, { type: "ok" });
          await self.refresh();
        } catch (err) {
          toast(err.message, { type: "danger" });
          if (btn) { btn.disabled = false; btn.textContent = "Add to Finished Stock"; }
        }
      }
    },
  };

  function field(label, control) {
    return UI.h("div", { style: "margin-bottom:14px" }, [
      UI.h("div", { class: "muted", style: "font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px", text: label }),
      control,
    ]);
  }

  function fact(label, val) {
    return UI.h("div", { class: "sup-fact" }, [
      UI.h("div", { class: "sup-fact-l", text: label }),
      UI.h("div", { class: "sup-fact-v" }, val instanceof Node ? val : UI.h("span", { html: String(val) })),
    ]);
  }
  function fmtQty(n) { n = +n || 0; return n % 1 === 0 ? n.toLocaleString("en-IN") : n.toLocaleString("en-IN", { maximumFractionDigits: 1 }); }
  function stat(label, val) {
    return UI.h("div", {}, [
      UI.h("div", { class: "muted", style: "font-size:11px", text: label }),
      UI.h("div", { style: "font-weight:700;font-size:15px;margin-top:2px", text: String(val) }),
    ]);
  }
  function trim(s, n) { s = String(s || ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; }

  global.SUP = SUP;
})(window);
