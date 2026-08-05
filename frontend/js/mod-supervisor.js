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
    /* the RM-production stage IS the coating floor — its stage NAME carries
       whose line it is ("RM Production — Gautam Saw"), which is the wrong
       thing to print on a button. Without this entry the timeline pill and
       every button read the raw key, "rmprod". */
    rmprod:     { ic: "🎨", label: "Coating" },
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

    /* opts.quiet — leave the cards on screen while refetching. Wiping them to
         "Loading your jobs…" after every tap is what made the panel feel slow;
         the data is only a few hundred milliseconds away.
       opts.slim  — ask for the volatile parts only and keep the product
         catalogue already in memory, which is ~70% of the payload. */
    async refresh(opts) {
      opts = opts || {};
      const view = UI.$("#view");
      if (!opts.quiet) view.innerHTML = '<div class="sup-loading">Loading your jobs…</div>';
      try {
        const fresh = await DB.loadAsync({ slim: opts.slim });
        // a slim reply carries no catalogue — keep the one we already have
        this.data = fresh.slim
          ? Object.assign({}, this.data, fresh, { finishedProducts: (this.data || {}).finishedProducts || [] })
          : fresh;
        if (this.data && this.data.org) { const on = UI.$("#orgName"); if (on) on.textContent = this.data.org.short; }
        this.buildNav();
        this.render();
      } catch (err) {
        if (opts.quiet) { toast(err.message, { type: "danger" }); return; }
        view.innerHTML = '<div class="sup-loading">⚠ ' + esc(err.message) + '</div>';
      }
    },

    /* bucket a WO from THIS area's perspective.
       An order still owing quantity is NOT done, however finished this run
       looks — it stays in My Jobs until the whole order has been made. The
       partial test comes first because `myDone` goes true the moment the
       released portion is off the machines, which is exactly the state the
       job has to keep being visible in. */
    buckets() {
      const g = { active: [], incoming: [], done: [] };
      (this.data.workorders || []).forEach((w) => {
        const partial = (+w.pendingQty || 0) > 1e-6 && !w.dispatched;
        const runDone = (w.route || []).length > 0 && (w.route || []).every((s) => s.status === "Completed");
        const madeQ = (+w.completedQty || 0) + (+w.runQty || 0);
        const toShip = madeQ - (+w.dispatchedQty || 0);
        /* An order still owing quantity cycles between the two lists, and it is
           the UNSHIPPED goods that decide which:
             something made and not yet gone  -> Completed, to be dispatched
             nothing waiting to go out        -> My Jobs, the order is open
           So it lands in Completed when a run finishes, returns to My Jobs the
           moment that portion ships, and does the same again for the next one. */
        if (partial) g[(runDone && toShip > 0.001) ? "done" : "active"].push(w);
        else if (w.dispatched || w.myDone || runDone) g.done.push(w);
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
          H("button", { class: "btn", onclick: () => this.openAdhoc(), html: "🏭 Production Entry" }),
          H("button", { class: "btn", onclick: () => this.openReturn(), html: "↩ Return" }),
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

      /* Where this job stands, worked out once and used by the chip, the
         warning box and the buttons — so all three tell the same story. */
      const pend = +w.pendingQty || 0;
      const madeQ = (+w.completedQty || 0) + (+w.runQty || 0);
      const sentQ = +w.dispatchedQty || 0;
      const runFinished = (w.route || []).length > 0 && (w.route || []).every((s) => s.status === "Completed");
      const readyToShip = !w.dispatched && runFinished && (madeQ - sentQ) > 0.001
        && (this.area === "slitting" || this.area === "all");

      /* A finished run read "Packing · to start", because the chip only looked
         at the current stage's status and a completed route leaves the pointer
         on the last stage. Say what is actually true of the job. */
      const chipCol = readyToShip ? "var(--ok)" : (STATUS_COLOR[cur.status] || "var(--text-mut)");
      const chipTxt = w.dispatched ? "Dispatched"
        : readyToShip ? "Ready to dispatch"
        : runFinished ? (pend > 0 ? "Waiting on material" : "Your part done")
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
        // the order's own slitting width wins over any width held on the product
        w.widthMM ? fact("Width", w.widthMM + " mm")
          : (p.widthMM ? fact("Width", (Array.isArray(p.widthMM) ? p.widthMM.join("/") : p.widthMM) + " mm") : null),
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

      /* Materials for THIS area's stage (only meaningful while it's their turn).
         Each line names the STORE it comes out of — the server works that out
         from the issue posted against this job, falling back to the store the
         issue will use — so the floor is not sent hunting round the stores for
         a material the ledger already knows the location of. */
      let mat = null;
      if (w.mine && w.materials && w.materials.length) {
        mat = H("details", { class: "sup-mat" }, [
          H("summary", { text: "🧱 Materials for " + ((STAGE_META[cur.key] || {}).label || "this stage") + " (" + w.materials.length + ")" }),
          H("div", { class: "sup-mat-list" }, w.materials.map((m) =>
            H("div", { class: "sup-mat-row" }, [
              H("div", { class: "sup-mat-nm" }, [
                H("span", { text: m.name || m.id }),
                m.whName ? H("span", { class: "sup-mat-wh", text: "🏬 " + m.whName }) : null,
              ].filter(Boolean)),
              H("b", { text: fmtQty(m.required) + " " + (m.uom || "") }),
            ]))),
        ]);
      }

      /* QC on a coated batch. The work order's number IS the batch number, and
         the reading has to be in before the stage can be closed — so the card
         says what is outstanding rather than letting Finish fail at the server. */
      const lab = w.lab && w.lab.required ? w.lab : null;
      const labBlocking = !!(lab && cur.area === "coating" && !lab.entered);
      /* No banner while the reading is outstanding: the action button already
         says "Enter Lab Report", and a warning strip repeating it was noise on
         a card the floor reads at a glance. Once the reading IS in, a slim
         confirmation stays — it is the only way back to correct a value. */
      let labBox = null;
      if (lab && lab.entered && w.mine && !w.dispatched) {
        labBox = H("div", { class: "sup-lab done" }, [
          H("div", { class: "sup-lab-main" }, [
            H("div", { class: "sup-lab-t", text: "✓ Lab report entered" }),
            H("div", { class: "sup-lab-s",
              text: "Batch " + lab.batchNo + " · " + lab.params.length + " reading" + (lab.params.length === 1 ? "" : "s") + " recorded" }),
          ]),
          H("button", { class: "sup-lab-btn", onclick: () => this.openLab(w), text: "✎ Edit reading" }),
        ]);
      }

      const actions = H("div", { class: "sup-actions" });
      /* Part of this order could not be made — the store was short. The floor
         must see that the job is NOT finished; what it can DO about it depends
         on whether there are finished goods waiting to go out. */
      if (pend > 0) {
        // headline and explanation are one warning, so they share one red box
        actions.appendChild(H("div", { class: "sup-partial" }, [
          H("div", { class: "sup-partial-head",
            text: "⏸ PARTIAL — " + ENG.num(pend) + " kg awaiting material" }),
          H("div", { class: "sup-partial-sub",
            text: ENG.num(w.qty) + " kg ordered · " + ENG.num(madeQ) + " kg covered · "
              + ENG.num(pend) + " kg pending — the office will release it when the material arrives" }),
          // what has already gone out, so a part shipment is never sent twice
          sentQ > 0 ? H("div", { class: "sup-partial-sub",
            text: "🚚 " + ENG.num(sentQ) + " kg dispatched" + (madeQ - sentQ > 0.001
              ? " · " + ENG.num(madeQ - sentQ) + " kg ready to dispatch" : "") }) : null,
        ].filter(Boolean)));
      }
      /* Goods that are MADE and not yet gone can always be dispatched — tested
         BEFORE "is it my job", because a partial order is still the floor's job
         while it waits for material, and that branch would otherwise swallow it
         and offer no button at all. */
      if (w.dispatched) {
        actions.appendChild(H("div", { class: "sup-done-tag", text: "✓ Dispatched" }));
      } else if (readyToShip) {
        actions.appendChild(H("button", { class: "sup-act primary",
          onclick: (e) => this.act(w, "dispatch", e.currentTarget),
          text: "🚚 Dispatch " + ENG.num(madeQ - sentQ) + " kg" }));
      } else if (w.mine) {
        /* ONE BUTTON, ONE NEXT STEP.
           A coated stage runs Start → Enter Lab Report → Complete, and the
           button is only ever whichever of those comes next. A locked
           "Finish" sitting beside a separate reading button asked the floor
           to work out the order for themselves; this states it. */
        const label = (STAGE_META[cur.key] || {}).label || cur.name;
        if (cur.status === "Pending") {
          actions.appendChild(H("button", { class: "sup-act primary", onclick: (e) => this.act(w, "start", e.currentTarget), text: "▶ Start " + label }));
        } else if (cur.status === "In Production") {
          if (labBlocking) {
            actions.appendChild(H("button", { class: "sup-act primary", onclick: () => this.openLab(w),
              title: "Batch " + lab.batchNo + " — " + (lab.missing.length || lab.params.length) + " reading(s) to record",
              text: "🧪 Enter Lab Report" }));
          } else {
            actions.appendChild(H("button", { class: "sup-act primary", onclick: (e) => this.act(w, "complete", e.currentTarget), text: "✓ Complete " + label }));
          }
          actions.appendChild(H("button", { class: "sup-act ghost", onclick: (e) => this.act(w, "pause", e.currentTarget), text: "↩ Pause" }));
        }
      } else if (!w.mine && !w.myDone && pend <= 0) {
        actions.appendChild(H("div", { class: "sup-done-tag", style: "color:var(--text-mut)", text: "⏳ Waiting on " + ((STAGE_META[cur.key] || {}).label || cur.name) }));
      }

      return H("div", { class: "sup-card" + (overdue ? " overdue" : "") + (pend > 0 ? " partial" : "") },
        [head, this.timeline(w), factsNode, mat, labBox, actions].filter(Boolean));
    },

    /* ============================================================
       The floor's lab reading. One field per parameter the Products
       master states a limit for — the limits themselves never come
       down here, so a reading cannot be nudged until it passes.
       Saving it is what unlocks "Finish Coating".
       ============================================================ */
    async openLab(w) {
      const self = this;
      let sheet;
      try { sheet = await DB.production.labSheet(w.id); }
      catch (err) { toast(err.message, { type: "danger" }); return; }
      if (!sheet.product) { toast("No lab product is linked to this item — ask the office to link one.", { type: "warn" }); return; }
      if (!sheet.params.length) { toast("No test parameters are set for this product yet.", { type: "warn" }); return; }

      const inputs = {};
      const grid = H("div", { class: "sup-lab-grid" }, sheet.params.map((p) => {
        const v = sheet.prodValues && sheet.prodValues[p.key];
        const inp = H("input", { class: "input", type: "number", step: "any", inputmode: "decimal",
          value: v == null ? "" : String(v) });
        inputs[p.key] = inp;
        return H("div", { class: "sup-lab-fld" }, [
          H("label", {}, [H("span", { text: p.label }), H("span", { class: "u", text: p.unit || "" })]),
          inp,
        ]);
      }));
      const remarks = H("input", { class: "input", placeholder: "Optional — anything odd about this batch" });

      const save = H("button", { class: "btn primary", text: "Save reading" });
      save.onclick = async () => {
        const values = {};
        const missing = [];
        sheet.params.forEach((p) => {
          const raw = (inputs[p.key].value || "").trim();
          if (raw === "" || isNaN(+raw)) missing.push(p.label); else values[p.key] = +raw;
        });
        if (missing.length) { toast("Still to measure: " + missing.join(", "), { type: "warn" }); return; }
        save.disabled = true; save.textContent = "Saving…";
        try {
          await DB.production.saveLab(w.id, { values, remarks: (remarks.value || "").trim() });
          mo.close();
          toast("Lab reading saved for batch " + sheet.batchNo, { type: "ok" });
          await self.refresh({ quiet: true, slim: true });
        } catch (err) {
          toast(err.message, { type: "danger" });
          save.disabled = false; save.textContent = "Save reading";
        }
      };

      const mo = UI.modal({
        title: "🧪 Lab report — batch " + sheet.batchNo,
        sub: (sheet.product.code || "") + " · " + sheet.product.name,
        body: H("div", {}, [
          H("div", { class: "sup-lab-ctx", html:
            "Measure the batch you have just coated. <b>Every</b> reading is needed before this stage can be finished. "
            + "The lab incharge adds their own measurement to the same certificate after slitting." }),
          grid,
          H("div", { class: "sup-lab-fld", style: "margin-top:12px" }, [H("label", {}, [H("span", { text: "Remarks" })]), remarks]),
        ]),
        foot: [H("button", { class: "btn ghost", onclick: () => mo.close(), text: "Cancel" }), save],
      });
    },

    async act(w, action, btn) {
      if (btn) { btn.disabled = true; btn.textContent = "…"; }
      try {
        await DB.production.advance(w.id, action);
        const verb = { start: "started", complete: "completed", pause: "paused", dispatch: "dispatched" }[action] || action;
        toast((w.product ? w.product.name : w.id) + " — stage " + verb, { type: "ok" });
        await this.refresh({ quiet: true, slim: true });
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
    /* ---- Return: send material back to a store -------------------------
       Unused issue, over-draw, or finished stock coming back off the line.
       Posts a single RET movement — never a silent adjustment. */
    openReturn() {
      const self = this;
      const items = (this.data.stockItems || []).filter((i) => ["RM", "PKG", "CON", "FG"].includes(i.cat));
      const warehouses = this.data.warehouses || [];
      if (!items.length) { toast("No materials available to return.", { type: "warn" }); return; }

      const itemSel = MW.select(items.map((i) => ({ value: i.id, label: i.name + (i.cat ? " · " + i.cat : "") })), () => {}, items[0].id);
      const qtyInp = H("input", { class: "input", type: "number", min: "0", step: "any", value: "" });
      const whSel = MW.select(warehouses.map((w) => ({ value: w.id, label: w.name + (w.type ? " · " + w.type : "") })), () => {}, (warehouses[0] || {}).id);
      const reasonInp = H("input", { class: "input", placeholder: "e.g. unused issue, roll rejected" });
      [itemSel, qtyInp, whSel, reasonInp].forEach((el) => { el.style.width = "100%"; });

      const body = H("div", {}, [
        field("Material", itemSel),
        field("Quantity returned", qtyInp),
        field("Return to store", whSel),
        field("Reason", reasonInp),
      ]);
      const mo = UI.modal({
        title: "↩ Return to Store", sub: "Posts a return movement against the chosen store", body,
        foot: [H("button", { class: "btn ghost", onclick: () => mo.close(), text: "Cancel" }),
          H("button", { class: "btn primary", onclick: (e) => save(e.currentTarget), text: "Record Return" })],
      });
      async function save(btn) {
        const qty = +qtyInp.value || 0;
        if (!qty || qty <= 0) { toast("Enter a valid quantity", { type: "warn" }); return; }
        if (btn) { btn.disabled = true; btn.textContent = "…"; }
        try {
          await DB.production.returnStock({ itemId: itemSel.value, qty, wh: whSel.value, reason: reasonInp.value });
          mo.close(); toast("Return recorded", { type: "ok" }); await self.refresh();
        } catch (err) {
          if (btn) { btn.disabled = false; btn.textContent = "Record Return"; }
          toast("Could not record the return: " + (err && err.message ? err.message : err), { type: "danger" });
        }
      }
    },

    /* ---- Production Entry: a run made without a planned work order ------
       Rolls are measured, not weighed, so kg is derived from the geometry:
         sqm = length x (width/1000) x rolls ;  kg = sqm x gsm / 1000 */
    openAdhoc() {
      const self = this;
      const products = (this.data.stockItems || []).filter((i) => i.cat === "FG");
      const warehouses = this.data.warehouses || [];
      if (!products.length) { toast("No finished products available.", { type: "warn" }); return; }
      const fgWh = warehouses.find((w) => String(w.type || "").toLowerCase().includes("finish")) || warehouses[0];

      const prodSel = MW.select(products.map((p) => ({ value: p.id, label: p.name })), () => draw(), products[0].id);
      const rollsInp = H("input", { class: "input", type: "number", min: "1", step: "1", value: "1", oninput: () => draw() });
      const lenInp = H("input", { class: "input", type: "number", min: "0", step: "any", value: "1000", oninput: () => draw() });
      const widInp = H("input", { class: "input", type: "number", min: "0", step: "any", value: "1000", oninput: () => draw() });
      const gsmInp = H("input", { class: "input", type: "number", min: "0", step: "any", placeholder: "product GSM", oninput: () => draw() });
      const batchInp = H("input", { class: "input", placeholder: "batch / lot no (for the lab report)" });
      const whSel = MW.select(warehouses.map((w) => ({ value: w.id, label: w.name + (w.type ? " · " + w.type : "") })), () => {}, fgWh ? fgWh.id : (warehouses[0] || {}).id);
      [prodSel, rollsInp, lenInp, widInp, gsmInp, batchInp, whSel].forEach((el) => { el.style.width = "100%"; });
      const readout = H("div", { style: "margin-top:14px;padding:12px;border-radius:12px;background:var(--panel-2);font-weight:700" });

      function calc() {
        const rolls = +rollsInp.value || 0, len = +lenInp.value || 0, wid = +widInp.value || 0, gsm = +gsmInp.value || 0;
        const sqm = len * (wid / 1000) * rolls;
        return { rolls, len, wid, gsm, sqm, kg: (sqm * gsm) / 1000 };
      }
      function draw() {
        const c = calc();
        readout.innerHTML = "";
        readout.appendChild(H("div", { text: fmtQty(c.sqm) + " sqm" + (c.gsm ? "  ·  " + fmtQty(c.kg) + " kg" : "") }));
        if (!c.gsm) readout.appendChild(H("div", { class: "muted", style: "font-weight:400;font-size:11.5px;margin-top:4px", text: "Enter the GSM to get the weight." }));
      }

      const body = H("div", {}, [
        field("Finished product", prodSel),
        field("Rolls", rollsInp),
        field("Length per roll (m)", lenInp),
        field("Width (mm)", widInp),
        field("GSM (g/m²)", gsmInp),
        field("Batch / lot no", batchInp),
        field("Store finished stock in", whSel),
        readout,
      ]);
      const mo = UI.modal({
        title: "🏭 Production Entry", sub: "Records an unplanned run · creates a work order and adds the output", body,
        foot: [H("button", { class: "btn ghost", onclick: () => mo.close(), text: "Cancel" }),
          H("button", { class: "btn primary", onclick: (e) => save(e.currentTarget), text: "Record Production" })],
      });
      draw();

      async function save(btn) {
        const c = calc();
        if (!c.kg || c.kg <= 0) { toast("Enter rolls, length, width and GSM", { type: "warn" }); return; }
        if (btn) { btn.disabled = true; btn.textContent = "…"; }
        try {
          const res = await DB.production.adhoc({ itemId: prodSel.value, rolls: c.rolls, lengthM: c.len,
            widthMM: c.wid, gsm: c.gsm, wh: whSel.value, refNo: batchInp.value });
          mo.close();
          toast((res.workOrder || "Production") + " recorded — " + fmtQty(res.kg) + " kg"
            + (res.deducted ? " (raw materials deducted)" : " (no BOM — materials not deducted)"), { type: "ok" });
          await self.refresh();
        } catch (err) {
          if (btn) { btn.disabled = false; btn.textContent = "Record Production"; }
          toast("Could not record production: " + (err && err.message ? err.message : err), { type: "danger" });
        }
      }
    },

    /* The SAME form the office gets on the Production page: category (finished
       goods or a half-made roll), the product picked first and its THICKNESS
       second, GSM, the unit the floor actually counted in, and — for a
       finished good — the tape width it was slit to. */
    openProduce() {
      const products = this.data.finishedProducts || [];
      const warehouses = this.data.warehouses || [];
      if (!products.length) { toast("No finished product has a BOM recipe yet — ask office to add one first.", { type: "warn" }); return; }
      const self = this;
      const U = global._erpUtil || {};
      const fgWh = warehouses.find((w) => String(w.type || "").toLowerCase().includes("finish")) || warehouses[0];
      const wipWh = warehouses.find((w) => w.id === "WH-WIP");
      const isMtr = (u) => ["M", "MTR", "METER"].includes(String(u || "").toUpperCase());
      /* what the store holds, summed across every warehouse that holds it —
         materialStock is the floor's own (quantities-only) stock feed */
      const matStock = this.data.materialStock || {};
      const onHandOf = (id) => (matStock[id] || []).reduce((n, r) => n + (+r.qty || 0), 0);

      /* half-made stock is only ever the COATED JUMBO */
      const wipStage = () => "Coated Jumbo Roll";
      const famOf = (p) => {
        const fam = (U.familyCode ? U.familyCode(p.typeCode, p.thicknessMM) : "")
          || (U.baseCode ? U.baseCode(p.typeCode || "") : "") || (p.typeCode || "");
        return (p.cat === "WIP" ? "WIP-" : "FG-") + fam;
      };
      const keyOf = (p) => famOf(p) + "|" + (p.productName || p.name || p.id)
        + "|" + (p.cat === "WIP" ? wipStage(p) : "");
      const nameLabel = (k) => { const s = k.split("|"); return s[0] + " — " + s[1] + (s[2] ? " — " + s[2] : ""); };

      const catSel = MW.select([{ value: "FG", label: "Finished Goods" }, { value: "WIP", label: "Work in Process" }],
        () => buildPicker(), "FG");
      const prodSel = MW.select([], () => buildThk(), null);
      const thkSel = MW.select([], () => { fillParams(); }, null);
      const gsmInp = H("input", { class: "input", type: "number", min: "0", step: "any", placeholder: "product GSM", oninput: () => draw() });
      const qtyInp = H("input", { class: "input", type: "number", min: "0", step: "any", value: "100", oninput: () => draw() });
      const uomSel = MW.select([], () => draw(), "KG");
      const tapeInp = H("input", { class: "input", type: "number", min: "0", step: "0.5", placeholder: "e.g. 25", oninput: () => draw() });
      const whSel = MW.select(warehouses.map((w) => ({ value: w.id, label: w.name + (w.type ? " · " + w.type : "") })), () => {}, fgWh ? fgWh.id : (warehouses[0] || {}).id);
      [catSel, prodSel, thkSel, gsmInp, qtyInp, uomSel, tapeInp, whSel].forEach((el) => { el.style.width = "100%"; });
      const preview = H("div", { style: "grid-column:1/-1" });
      const tapeField = gridField("Tape Width (mm)", tapeInp);
      const convHint = H("div", { class: "muted", style: "grid-column:1/-1;font-size:11px;margin-top:-6px" });

      let byName = {};
      function currentProduct() { return products.find((p) => p.id === thkSel.value) || null; }
      function catNow() { return catSel.value; }

      function buildPicker() {
        const list = products.filter((p) => (p.cat || "FG") === catNow());
        byName = {};
        list.forEach((p) => { (byName[keyOf(p)] = byName[keyOf(p)] || []).push(p); });
        Object.values(byName).forEach((a) => a.sort((x, y) => (x.thicknessMM || 0) - (y.thicknessMM || 0)));
        const names = Object.keys(byName).sort();
        prodSel.innerHTML = "";
        names.forEach((n) => prodSel.appendChild(H("option", { value: n }, nameLabel(n))));
        // the floor counts a jumbo in running metres; a slit finished roll never
        uomSel.innerHTML = "";
        const units = [{ v: "KG", l: "Kilogram (kg)" }, { v: "SQM", l: "Square Meter (sqm)" }];
        if (catNow() !== "FG") units.push({ v: "MTR", l: "Meter (m)" });
        units.forEach((u) => uomSel.appendChild(H("option", { value: u.v }, u.l)));
        uomSel.value = "KG";
        tapeField.style.display = catNow() === "FG" ? "" : "none";
        // a half-made roll belongs in the WIP store, a finished one in finished goods
        const want = catNow() === "FG" ? fgWh : (wipWh || fgWh);
        if (want) whSel.value = want.id;
        buildThk();
      }
      function buildThk() {
        const group = byName[prodSel.value] || [];
        thkSel.innerHTML = "";
        group.forEach((p) => thkSel.appendChild(H("option", { value: p.id },
          (p.thicknessMM != null ? p.thicknessMM + " mm" : (p.typeCode || p.id)) + " · " + p.id)));
        if (group.length) thkSel.value = group[0].id;
        fillParams();
      }
      function fillParams() {
        const p = currentProduct() || {};
        gsmInp.value = p.gsm != null ? p.gsm : "";
        if (catNow() === "FG") tapeInp.value = p.tapeWidthMM != null ? p.tapeWidthMM : "";
        drawLab(p.id);
        draw();
      }
      /* the width the quantity is measured across — the slit tape for a
         finished good, the full web for a jumbo */
      function widthMM() {
        if (catNow() === "FG") { const t = +tapeInp.value || 0; if (t > 0) return t; }
        return 1000;
      }
      /* kg ⇄ sqm ⇄ metres, across the GSM and that width */
      function derive() {
        const q = +qtyInp.value || 0, unit = uomSel.value, gsm = +gsmInp.value || 0, w = widthMM() / 1000;
        if (!q) return null;
        let kg = null, sqm = null, len = null;
        if (unit === "KG") { kg = q; if (gsm) { sqm = kg * 1000 / gsm; len = sqm / w; } }
        else if (unit === "SQM") { sqm = q; len = sqm / w; if (gsm) kg = sqm * gsm / 1000; }
        else { len = q; sqm = len * w; if (gsm) kg = sqm * gsm / 1000; }
        return { kg, sqm, len, wid: widthMM() };
      }
      /* what actually posts: the item's OWN unit, whatever it was counted in */
      function postQty() {
        const p = currentProduct(); if (!p) return null;
        const c = derive(); if (!c) return null;
        const uom = String(p.uom || "KG").toUpperCase();
        if (isMtr(uom)) return c.len;
        if (uom === "SQM") return c.sqm;
        return c.kg == null ? null : c.kg * ({ KG: 1, GRAM: 1000, MG: 1e6 }[uom] || 1);
      }
      function draw() {
        const p = currentProduct();
        const c = derive();
        const bits = [];
        if (c) {
          if (c.sqm != null) bits.push(fmtQty(c.sqm) + " sqm");
          if (c.len != null) bits.push(fmtQty(c.len) + " m @ " + c.wid + " mm");
          if (c.kg != null) bits.push(fmtQty(c.kg) + " kg");
        }
        convHint.textContent = bits.length ? "= " + bits.join("  ·  ")
          : (c ? "Enter the GSM to convert between kg, sqm and metres" : "");
        preview.innerHTML = "";
        if (!p) return;
        const qty = postQty() || 0;
        if (!p.recipe || !p.recipe.length) {
          preview.appendChild(H("div", { class: "muted", style: "font-size:12px;margin-top:12px",
            text: "No BOM recipe for this product — no materials will be deducted." }));
        } else {
          /* the very same list New Work Order shows, from the very same
             renderer — need, in store, and short, against live stock */
          const rows = p.recipe.map((r) => ({
            name: r.name, code: r.id !== r.name ? r.id : null, uom: r.uom || "",
            need: r.perUnit * qty, have: onHandOf(r.id),
          }));
          if (U.materialsList) U.materialsList(preview, [{ label: null, lines: rows }],
            { title: "Raw materials to be deducted from store" });
        }
        preview.appendChild(H("div", { style: "display:flex;justify-content:space-between;gap:12px;font-size:13.5px;padding:10px 0 0;font-weight:700;color:var(--ok)" }, [
          H("span", { text: catNow() === "FG" ? "→ Added to finished stock" : "→ Added to work in process" }),
          H("b", { text: fmtQty(qty) + " " + (p.uom || "") }),
        ]));
      }

      /* the SAME layout the office gets: a form-grid of .field cells, not the
         floor's stacked one-per-row style, so both look identical */
      /* Nothing goes into a store unmeasured. The batch is named here (there
         is no work order behind hand-booked stock) and the readings taken
         against it; the server refuses the booking without a complete set.
         Parameters come from the product's entry under Lab Reports → Products
         and are fetched per product, so a half-made roll picks up its parent's
         spec — and no limit is ever sent to the floor. */
      const batchInp2 = H("input", { class: "input", placeholder: "e.g. 0042" });
      batchInp2.style.width = "100%";
      const labHost = H("div", { style: "grid-column:1/-1" });
      let labParams = [], labFor = null;

      async function drawLab(itemId) {
        if (!itemId || itemId === labFor) return;
        labFor = itemId; labParams = [];
        labHost.innerHTML = "";
        let sheet = null;
        try { sheet = await DB.production.finishedLabSheet(itemId); }
        catch (e) { labHost.appendChild(H("div", { class: "muted", style: "font-size:11.5px", text: "Could not load the test parameters — " + (e.message || e) })); return; }
        if (labFor !== itemId) return;                 // the picker moved on
        if (!sheet || !sheet.required) {
          labHost.appendChild(H("div", { class: "muted", style: "font-size:11.5px;padding:8px 0",
            text: "No lab parameters are set for this product — nothing to measure before booking." }));
          return;
        }
        labParams = sheet.params || [];
        labHost.appendChild(H("div", { class: "sup-lab-ctx", style: "margin:10px 0",
          html: "🧪 <b>Lab report required</b> — measure the batch you have just made. Every reading is needed before this stock can be booked." }));
        const grid = H("div", { class: "sup-lab-grid" });
        labParams.forEach((p) => {
          const inp = H("input", { class: "input", type: "number", step: "any", inputmode: "decimal" });
          inp.setAttribute("data-lab", p.key);
          grid.appendChild(H("div", { class: "sup-lab-fld" }, [
            H("label", {}, [H("span", { text: p.label }), H("span", { class: "u", text: p.unit || "" })]),
            inp,
          ]));
        });
        labHost.appendChild(grid);
      }
      const labValuesNow = () => {
        const o = {};
        labHost.querySelectorAll("input[data-lab]").forEach((el) => {
          const v = (el.value || "").trim();
          if (v !== "" && !isNaN(+v)) o[el.getAttribute("data-lab")] = +v;
        });
        return o;
      };
      const labMissing = () => labParams.filter((p) => labValuesNow()[p.key] == null).map((p) => p.label);

      const body = H("div", { class: "form-grid" }, [
        gridField("Category", catSel),
        gridField("Product", prodSel, "full"),
        gridField("Thickness (mm)", thkSel),
        gridField("GSM (g/m²)", gsmInp),
        gridField("Quantity produced", qtyInp),
        gridField("Unit of Quantity", uomSel),
        tapeField,
        gridField("Store it in", whSel),
        gridField("Batch / lot no", batchInp2),
        convHint,
        labHost,
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
      buildPicker();

      async function save(btn) {
        const p = currentProduct();
        if (!p) { toast("Pick a product", { type: "warn" }); return; }
        if (!(+qtyInp.value > 0)) { toast("Enter a valid quantity", { type: "warn" }); return; }
        const tapeWidthMM = catNow() === "FG" ? (+tapeInp.value || null) : null;
        if (catNow() === "FG" && !tapeWidthMM) { toast("Enter the tape width for a finished good", { type: "warn" }); return; }
        const qty = postQty();
        if (qty == null || !(qty > 0)) {
          toast("Enter the GSM so the quantity can be converted to " + (p.uom || "KG"), { type: "warn" }); return;
        }
        /* the batch has to be named and measured before it can go into a store
           — said here so the floor is told what is missing, enforced anyway
           by the server */
        const batch = (batchInp2.value || "").trim();
        if (labParams.length) {
          if (!batch) { toast("Enter the batch / lot no — the lab report is filed against it", { type: "warn" }); return; }
          const miss = labMissing();
          if (miss.length) { toast("Enter every lab reading first — missing: " + miss.join(", "),
            { type: "warn", title: "Lab report required" }); return; }
        }
        if (btn) { btn.disabled = true; btn.textContent = "…"; }
        try {
          const res = await DB.production.addFinishedStock(Object.assign({
            itemId: p.id, qty: +qty.toFixed(3), wh: whSel.value,
            tapeWidthMM, gsm: +gsmInp.value || null,
          }, labParams.length ? { refNo: batch, labValues: labValuesNow() } : {}));
          mo.close();
          const where = (res && res.produced && res.produced.whName) || "stock";
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

  /* the office's .field cell, but taking a live control instead of an HTML
     string — so a form built here sits in a .form-grid and looks identical */
  function gridField(label, control, cls) {
    return UI.h("div", { class: "field" + (cls === "full" ? " full" : "") }, [
      UI.h("label", { text: label }),
      UI.h("div", {}, [control]),
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
