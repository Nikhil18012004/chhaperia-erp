/* ============================================================
   CHHAPERIA ERP — CRM PIPELINE MODULE  (frontend / presentation)
   A simple, efficient B2B sales CRM:
     • KPI strip  (open leads, weighted pipeline, win rate, won value)
     • Follow-up reminders (due today / overdue)
     • Pipedrive-style pipeline board (New→Contacted→Quoted→Won/Lost)
     • Lead detail drawer: info, activity timeline, log activity,
       move stage, edit, convert-to-customer, straight to a quotation
     • Samples & Quotations — its own page (M.quotations, registered here
       because it shares the lead drawer, the sample form and the lost
       form): every reel that went out and every price offered, with the
       rounds of a negotiation and the won/lost close that moves the lead
   Reads from ENG (engine) + DB; persists via App.persistAndRefresh().
   ============================================================ */
(function () {
  "use strict";
  const { h, esc, table, badge, toast, modal, confirm } = UI;
  const { pageHead } = MW;

  const STAGE_META = {
    New:       { color: "var(--c2)",  ic: "✨" },
    Contacted: { color: "var(--c4)",  ic: "📞" },
    Sample:    { color: "var(--c7)",  ic: "📦" },
    Quoted:    { color: "var(--c5)",  ic: "📄" },
    Won:       { color: "var(--ok)",  ic: "🏆" },
    Lost:      { color: "var(--danger)", ic: "✕" },
  };
  const ACT_TYPES = ["Call", "Email", "WhatsApp", "Meeting", "Sample Sent", "Quotation Sent", "Site Visit", "Note"];
  // how a sample lands once the customer has run it — drives the next move
  const SAMPLE_VERDICTS = ["Awaiting feedback", "Approved", "Rejected", "Rework needed"];
  const SOURCES = ["Exhibition (Wire India)", "Website Enquiry", "Referral", "Cold Call", "Existing Customer", "Trade Directory"];
  /* The lost-reason list and its normaliser live in the engine so the CRM,
     the Customers screen and the quotations all group the same way. */
  const LOST_REASONS = ENG.LOST_REASONS;
  const normaliseReason = ENG.normaliseReason;
  const money = (n) => ENG.money(n);
  const trim = (s, n) => { s = String(s || ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
  const todayISO = () => DB.helpers.iso(DB.helpers.today());

  /* ---- how long a sample has been out ----
     A sample is the whole sale in this trade: the customer will not price the
     tape until they have run it. What the record never carried was TIME, so a
     reel sent in June looked exactly like one sent yesterday. Age is derived
     from sentDate and never stored, so it cannot go stale.
     SAMPLE_STALE_DAYS is the point at which an unanswered sample stops being
     patience and starts being a lost order nobody has written down. */
  const SAMPLE_STALE_DAYS = 30;
  function sampleAge(l) {
    const s = l && l.sample;
    if (!s || !s.sentDate) return null;
    return daysBetween(s.sentDate, todayISO());
  }
  /* Samples that have gone out and not come back with a decision. */
  function openSamples(leads) {
    return (leads || [])
      .filter((l) => l.sample && l.sample.sentDate
        && (!l.sample.verdict || l.sample.verdict === "Awaiting feedback")
        && l.stage !== "Won" && l.stage !== "Lost")
      .map((l) => ({ lead: l, age: sampleAge(l) || 0 }))
      .sort((a, b) => b.age - a.age);
  }
  const ageTone = (d) => (d >= 45 ? "danger" : d >= SAMPLE_STALE_DAYS ? "warn" : "info");

  M.crm = { title: "CRM Pipeline", sub: "Sales leads & enquiries", render(root, params) {
    const stats = ENG.crmStats();
    const due = ENG.dueFollowUps();
    const pipeline = ENG.pipelineByStage();
    const byStage = {}; pipeline.forEach((c) => { byStage[c.stage] = c; });

    const allLeads = ENG.leads();

    root.appendChild(pageHead("CRM — Sales Pipeline",
      "Track enquiries from first contact to won order. Never miss a follow-up.",
      [ MW.excelMenu("leads"),
        // every reel that has gone out, on one page — the count is the ones
        // still waiting on a verdict
        h("button", { class: "btn ghost", onclick: () => App.go("quotations", { tab: "samples" }),
          html: "📦 Samples & Quotes (" + openSamples(allLeads).length + ")" }),
        h("button", { class: "btn ghost", onclick: () => activityDrill(allLeads), html: "🕘 Activity" }),
        h("button", { class: "btn primary", onclick: () => leadForm(), html: "＋ New Lead" }) ]));

    /* ============ PRIORITY 1 — today's follow-ups ============
       The only time-critical thing on this page, so it leads the layout
       and carries the loudest treatment. Everything else is context. */
    const overdueList = due.filter((l) => l.nextFollowUp < todayISO());
    const todayList = due.filter((l) => l.nextFollowUp >= todayISO());
    // a sample sitting unanswered is a chase too, and nothing was surfacing it
    const staleSamples = openSamples(allLeads).filter((x) => x.age >= SAMPLE_STALE_DAYS);
    root.appendChild(followUpBlock(due, overdueList, todayList, staleSamples));

    /* ============ PRIORITY 2 — headline numbers, each drills down ============ */
    // derived, not listed: adding a stage to ENG.STAGES must not silently drop
    // its leads out of the open-pipeline breakdown
    const openStages = ENG.STAGES.filter((s) => s !== "Won" && s !== "Lost");
    const winPct = stats.winRate || 0;

    root.appendChild(h("div", { class: "crm-grid" }, [
      kpiCard({ cls: "crm-s3", ic: "⚖️", label: "Weighted Pipeline", value: money(stats.weighted),
        foot: [h("span", { text: "open value " + money(stats.openValue) })],
        onClick: () => weightedDrill(byStage, stats),
        vis: (box) => { const cv = h("canvas", { "data-h": 38 }); box.appendChild(cv);
          requestAnimationFrame(() => Charts.spark(cv, monthlyValue(allLeads, 8).values, cssv("--accent"))); } }),

      kpiCard({ cls: "crm-s3", ic: "🎯", label: "Open Leads", value: ENG.num(stats.open),
        foot: [h("span", { text: stats.total + " total enquiries" })],
        onClick: () => sourceDrill(allLeads, stats),
        vis: (box) => {
          const maxN = Math.max(1, ...openStages.map((s) => (byStage[s] || {}).count || 0));
          box.style.height = "auto"; box.style.margin = "0";
          box.appendChild(h("div", { class: "crm-mini" }, openStages.map((st) => {
            const c = (byStage[st] || {}).count || 0;
            return h("div", { class: "crm-mini-row" }, [
              h("span", { class: "crm-mini-lab", text: st }),
              h("span", { class: "crm-mini-track" }, [h("span", { style: "width:" + Math.round(c / maxN * 100) + "%;background:" + STAGE_META[st].color })]),
              h("span", { class: "crm-mini-n", text: String(c) }),
            ]);
          })));
        } }),

      kpiCard({ cls: "crm-s3", ic: "🏆", label: "Win Rate", value: winPct + "%",
        delta: { type: winPct >= 50 ? "up" : "down", text: stats.won + "W / " + stats.lost + "L" },
        foot: [h("span", { text: (stats.won + stats.lost) + " decided" })],
        onClick: () => winDrill(allLeads, stats),
        vis: (box) => { const cv = h("canvas", { "data-h": 38 }); box.appendChild(cv);
          requestAnimationFrame(() => Charts.spark(cv, winTrend(allLeads, 8), cssv(winPct >= 50 ? "--ok" : "--warn"))); } }),

      kpiCard({ cls: "crm-s3", ic: "💰", label: "Won Value", value: money(stats.wonValue),
        delta: { type: "up", text: stats.won + " closed" },
        foot: [h("span", { text: "converted business" })],
        onClick: () => stageDrill(byStage.Won || { stage: "Won", items: [], count: 0, value: 0 }),
        vis: (box) => { const cv = h("canvas", { "data-h": 38 }); box.appendChild(cv);
          requestAnimationFrame(() => Charts.spark(cv, monthlyValue(allLeads.filter((l) => l.stage === "Won"), 8).values, cssv("--ok"))); } }),
    ]));

    /* ============ PRIORITY 3 — the working surface: the board ============ */
    root.appendChild(h("div", { class: "card-head", style: "margin:2px 0 10px" }, [h("div", {}, [
      h("h3", { text: "Pipeline Board" }),
      h("div", { class: "sub", text: "Swipe or navigate through stages" }),
    ])]));

    /* ---- pipeline board as a CARD CAROUSEL -------------------------------
       One stage per slide; the middle one is brought forward and its
       neighbours sit back, so the eye lands on the stage being worked.
       The track is a real scroller with scroll-snap, which buys native
       swipe on a touch screen and two-finger scroll on a trackpad for
       free — the arrows, the dots and the arrow keys all just scroll it.
       Everything the columns could do still works: the stage header opens
       its breakdown, a card opens the lead. */
    const car = h("div", { class: "crm-car" });
    const rail = h("div", { class: "crm-car-rail" });
    const view = h("div", { class: "crm-car-view" }, [rail]);
    const prev = h("button", { class: "crm-car-nav prev", type: "button",
      "aria-label": "Previous stage", html: "&lsaquo;" });
    const next = h("button", { class: "crm-car-nav next", type: "button",
      "aria-label": "Next stage", html: "&rsaquo;" });
    const dots = h("div", { class: "crm-car-dots", role: "tablist", "aria-label": "Pipeline stages" });

    // leading/trailing spacers centre the first and last slide in the view
    const padA = h("div", { class: "crm-car-pad" });
    const padB = h("div", { class: "crm-car-pad" });
    rail.appendChild(padA);

    const slides = pipeline.map((col, i) => {
      const meta = STAGE_META[col.stage] || { color: "var(--c1)", ic: "•" };
      const slide = h("article", { class: "crm-car-slide", style: "--sc:" + meta.color,
        id: "crmcol-" + col.stage, "data-i": i, "aria-roledescription": "slide",
        "aria-label": col.stage + ", " + col.count + " leads" }, [
        h("header", { class: "crm-car-head crm-click", title: "Open the " + col.stage + " breakdown",
          onclick: () => stageDrill(col) }, [
          h("span", { class: "crm-car-ic", text: meta.ic }),
          h("span", { class: "crm-car-stage", text: col.stage }),
          h("span", { class: "crm-car-n", text: "(" + col.count + (col.count === 1 ? " Lead)" : " Leads)") }),
        ]),
        h("div", { class: "crm-car-val", text: money(col.value) }),
        h("div", { class: "crm-car-body" },
          col.items.length
            ? col.items.map((l) => leadCard(l, meta))
            : [h("div", { class: "crm-empty", text: "No leads here yet" })]
        ),
      ]);
      rail.appendChild(slide);
      const dot = h("button", { class: "crm-car-dot", type: "button", role: "tab",
        title: col.stage + " · " + col.count + " lead" + (col.count === 1 ? "" : "s"),
        "aria-label": col.stage, onclick: () => goTo(i) });
      dots.appendChild(dot);
      return { slide, dot, col };
    });
    rail.appendChild(padB);

    car.appendChild(prev); car.appendChild(view); car.appendChild(next);
    root.appendChild(car);
    root.appendChild(dots);
    if (params && params.openNew) { params.openNew = false; leadForm(); }
    // a deep link from Samples & Quotations lands on the lead's drawer
    if (params && params.open) { const id = params.open; params.open = null; leadDetail(id); }

    /* --- which slide is centred, and how the carousel is driven --- */
    // start on the first stage that actually holds leads — the one being worked
    let active = Math.max(0, slides.findIndex((s) => s.col.count > 0));
    let raf = 0;

    function slideStep() {
      if (slides.length < 2) return 0;
      return slides[1].slide.offsetLeft - slides[0].slide.offsetLeft;   // width + gap
    }
    function centreOf(i) {
      const s = slides[i] && slides[i].slide;
      if (!s) return 0;
      return s.offsetLeft - (view.clientWidth - s.offsetWidth) / 2;
    }
    // someone who has asked for less motion gets the jump, not the glide
    const calm = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    function goTo(i, smooth) {
      i = Math.max(0, Math.min(slides.length - 1, i));
      view.scrollTo({ left: centreOf(i), behavior: (smooth === false || calm) ? "auto" : "smooth" });
      mark(i);
    }
    /* the slide nearest the middle of the view wins — driven by the scroll
       position itself, so a swipe lights up the right dot exactly like the
       arrows do */
    function nearest() {
      const mid = view.scrollLeft + view.clientWidth / 2;
      let best = 0, bestD = Infinity;
      slides.forEach((s, i) => {
        const c = s.slide.offsetLeft + s.slide.offsetWidth / 2;
        const d = Math.abs(c - mid);
        if (d < bestD) { bestD = d; best = i; }
      });
      return best;
    }
    function mark(i) {
      active = i;
      slides.forEach((s, k) => {
        const near = Math.abs(k - i) === 1;
        s.slide.classList.toggle("is-active", k === i);
        s.slide.classList.toggle("is-near", near);
        s.slide.setAttribute("aria-hidden", k === i ? "false" : "true");
        s.dot.classList.toggle("on", k === i);
        s.dot.setAttribute("aria-selected", k === i ? "true" : "false");
      });
      prev.disabled = i === 0;
      next.disabled = i === slides.length - 1;
    }
    view.addEventListener("scroll", () => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; const i = nearest(); if (i !== active) mark(i); });
    }, { passive: true });
    prev.onclick = () => goTo(active - 1);
    next.onclick = () => goTo(active + 1);
    // arrow keys move the carousel while it has focus
    view.tabIndex = 0;
    view.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight") { e.preventDefault(); goTo(active + 1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); goTo(active - 1); }
      else if (e.key === "Home") { e.preventDefault(); goTo(0); }
      else if (e.key === "End") { e.preventDefault(); goTo(slides.length - 1); }
    });
    // a horizontal wheel/trackpad gesture scrolls the rail natively; keep the
    // page from also scrolling sideways when the rail has nowhere left to go
    view.addEventListener("wheel", (e) => {
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) e.stopPropagation();
    }, { passive: true });

    /* the spacers depend on the view width, so they are set after layout and
       kept right when the window resizes */
    function fit() {
      const gutter = Math.max(0, (view.clientWidth - (slides[0] ? slides[0].slide.offsetWidth : 0)) / 2);
      padA.style.flexBasis = gutter + "px";
      padB.style.flexBasis = gutter + "px";
      // only a stage that actually overflows gets the bottom fade
      slides.forEach((s) => {
        const b = s.slide.querySelector(".crm-car-body");
        if (b) b.classList.toggle("is-scrollable", b.scrollHeight > b.clientHeight + 2);
      });
      goTo(active, false);
    }
    /* Do this synchronously: the slides are already in the document, and a
       rAF that never runs (a background tab, a throttled frame) would leave
       the board with no stage brought forward at all. The extra pass after
       the next frame just re-centres once fonts and scrollbars have settled. */
    mark(active);
    fit();
    requestAnimationFrame(fit);
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(() => fit());
      ro.observe(view);
      // stop watching once this render is replaced
      const stop = new MutationObserver(() => { if (!document.body.contains(view)) { ro.disconnect(); stop.disconnect(); } });
      stop.observe(document.body, { childList: true, subtree: true });
    }
    void slideStep;   // kept for readability of the step maths above

    /* a single lead card: initial avatar (stage-tinted), value, product, follow-up */
    function leadCard(l, meta) {
      const overdue = l.nextFollowUp && l.nextFollowUp < todayISO() && l.stage !== "Won" && l.stage !== "Lost";
      const initial = (String(l.company || "?").trim().charAt(0) || "?").toUpperCase();
      // stamped like a table row, so a calendar chase-date can highlight this
      // exact lead on the board — see App.flashRow()
      return h("div", { class: "crm-lead", "data-row-id": String(l.id), style: "--sc:" + meta.color,
        onclick: () => leadDetail(l.id) }, [
        h("div", { class: "crm-lead-top" }, [
          h("div", { class: "crm-lead-ava", text: initial }),
          h("div", { class: "crm-lead-id" }, [
            h("div", { class: "crm-lead-co", text: trim(l.company, 26) }),
            h("div", { class: "crm-lead-val", text: money(l.value) }),
          ]),
        ]),
        h("div", { class: "crm-lead-prod", text: trim((l.productName || l.product || "—"), 34) }),
        h("div", { class: "crm-lead-foot" }, [
          h("span", { class: "crm-lead-who", text: trim(l.contact || "—", 18) }),
          l.nextFollowUp
            ? h("span", { class: "crm-lead-due" + (overdue ? " late" : ""),
                html: (overdue ? "⏰ " : "📅 ") + l.nextFollowUp.slice(5) })
            : h("span", { class: "muted", text: l.stage === "Won" ? "✓ closed" : l.stage === "Lost" ? "lost" : "" }),
        ]),
      ]);
    }
  }};

  /* ============================================================
     LEAD DETAIL — info, activity timeline, actions
     ============================================================ */
  function leadDetail(id) {
    const l = ENG.leads().find((x) => x.id === id);
    if (!l) { toast("Lead not found", { type: "danger" }); return; }
    const meta = STAGE_META[l.stage] || {};
    const acts = (l.activities || []).slice().sort((a, b) => (a.date < b.date ? 1 : -1));

    const body = h("div", {}, [
      /* stage + quick move */
      h("div", { class: "flex between aic wrap gap", style: "margin-bottom:16px" }, [
        h("div", { class: "flex aic gap" }, [
          h("span", { html: badge(stageBadge(l.stage), (meta.ic || "") + " " + l.stage) }),
          l.value ? h("span", { class: "chip", html: "💰 " + money(l.value) }) : null,
          l.quotedValue ? h("span", { class: "chip", html: "📄 Quoted " + money(l.quotedValue) }) : null,
        ]),
        (l.stage !== "Won" && l.stage !== "Lost")
          ? h("div", { class: "flex gap" }, [
              // one tap from the drawer to the despatch, without going via
              // Move stage — sending a sample is the common next move here
              !l.sample ? h("button", { class: "btn sm", onclick: () => sampleForm(l), html: "📦 Send sample" }) : null,
              l.phone ? h("button", { class: "btn sm", onclick: () => whatsappForm(l), html: "💬 WhatsApp" }) : null,
              // the document that follows the sample: opens the quotation form
              // with this lead's customer and product already on it
              h("button", { class: "btn sm", onclick: () => quoteFromLead(l), html: "📄 Create quotation" }),
              h("button", { class: "btn sm", onclick: () => moveStage(l), html: "➜ Move stage" }),
              h("button", { class: "btn sm primary", onclick: () => logActivity(l), html: "＋ Log activity" }),
            ].filter(Boolean))
          : null,
      ]),

      MW.dl([
        ["Contact", l.contact || "—"],
        ["Phone", MW.phoneCell(l.phone)],
        ["Email", MW.emailLink(l.email, { mode: "compose" })],
        ["City", l.city || "—"],
        ["Product Interest", l.productName || l.product || "—"],
        ["Source", l.source || "—"],
        ["Owner", l.owner || "—"],
        ["Created", l.created || "—"],
        ["Next Follow-up", l.nextFollowUp || "—"],
        ["Expected Close", l.expectedClose || "—"],
        l.lostReason ? ["Lost Reason", normaliseReason(l.lostReason)] : null,
        l.lostTo ? ["Lost To", l.lostTo] : null,
        l.lostNote ? ["Their Price", l.lostNote] : null,
        l.customerId ? ["Linked Customer", ENG.custName(l.customerId)] : null,
        l.salesOrderId ? ["Sales Order", l.salesOrderId + " →"] : null,
      ].filter(Boolean)),

      // one line each; the records themselves live on Samples & Quotations
      sampleStrip(l),
      quoteStrip(l),

      l.notes ? h("div", { class: "card", style: "margin-top:14px;box-shadow:none;background:var(--panel-2)" },
        [h("div", { class: "muted", style: "font-size:11px;font-weight:700;text-transform:uppercase;margin-bottom:4px", text: "Notes" }),
         h("div", { style: "font-size:13px;line-height:1.5", text: l.notes })]) : null,

      /* activity timeline */
      h("h3", { style: "margin:18px 0 10px;font-size:14px", text: "Activity Timeline (" + acts.length + ")" }),
      acts.length
        ? h("div", { class: "timeline" }, acts.map((a) => h("div", { class: "tl-item" }, [
            h("div", { class: "tt", html: actIcon(a.type) + " " + esc(a.type) + " <span class='muted' style='font-weight:500'>· " + a.date + "</span>" }),
            h("div", { class: "td", text: a.note || "" }),
            a.by ? h("div", { class: "muted", style: "font-size:11px;margin-top:2px", text: "by " + a.by }) : null,
          ])))
        : h("div", { class: "empty", style: "padding:20px" }, [h("div", { class: "big", text: "📭" }), h("div", { text: "No activities logged yet" })]),
    ]);

    const foot = [
      h("button", { class: "btn ghost", onclick: () => leadForm(l), text: "✎ Edit" }),
      (l.stage !== "Won" && l.stage !== "Lost")
        ? h("button", { class: "btn", style: "color:var(--danger)", onclick: () => closeLead(l, "Lost"), html: "✕ Mark Lost" })
        : null,
      (l.stage !== "Won")
        ? h("button", { class: "btn primary", style: "background:linear-gradient(135deg,var(--ok),#0f8a3c)", onclick: () => closeLead(l, "Won"), html: "🏆 Mark Won" })
        : null,
    ].filter(Boolean);

    modal({ title: l.company, sub: l.id + " · " + (l.productName || ""), wide: true, body, foot });
  }

  /* ---- move to next stage ---- */
  function moveStage(l) {
    const body = h("div", { class: "flex wrap gap" }, ENG.STAGES.map((st) => {
      const m = STAGE_META[st] || {};
      return h("button", { class: "btn" + (st === l.stage ? " primary" : ""),
        onclick: () => { applyStage(l, st); mo.close(); },
        html: (m.ic || "") + " " + st });
    }));
    const mo = modal({ title: "Move " + l.company, sub: "Current: " + l.stage, body });
  }
  function applyStage(l, st) {
    // Sample is the one stage that carries a physical despatch, so the move
    // asks what went out instead of leaving it to be remembered later
    if (st === "Sample") { sampleForm(l); return; }
    l.stage = st;
    if (st === "Won" || st === "Lost") l.nextFollowUp = null;
    else if (!l.nextFollowUp || l.nextFollowUp < todayISO()) l.nextFollowUp = DB.helpers.daysAhead(3);
    toast(l.company + " → " + st, { type: "ok" });
    UI.$("#modalHost").hidden = true;
    App.saveDelta(() => DB.leads.update(l.id, { stage: l.stage, nextFollowUp: l.nextFollowUp }));
  }

  /* ---- mark won / lost ----
     Marking a lead WON closes the CRM→ERP loop:
       1. ensure the company exists as a Customer (create if new)
       2. offer to raise a Sales Order from the lead's product + value
     so a won enquiry actually flows into Sales → Production → Dispatch
     instead of dead-ending in the CRM. */
  async function closeLead(l, outcome) {
    if (outcome === "Lost") {
      const out = await lostForm(l);
      if (out === null) return;
      Object.assign(l, out, { stage: "Lost", nextFollowUp: null });
      UI.$("#modalHost").hidden = true;
      toast(l.company + " marked Lost — " + l.lostReason, { type: "warn" });
      App.saveDelta(() => DB.leads.update(l.id, { stage: "Lost", lostReason: l.lostReason,
        lostTo: l.lostTo, lostNote: l.lostNote, nextFollowUp: null }));
      return;
    }

    // ----- WON -----
    l.stage = "Won";
    l.nextFollowUp = null;

    // 1) ensure a Customer record exists for this company
    const { cust, created: createdCustomer } = ensureCustomerFor(l);

    // 2) ask whether to raise a Sales Order from this won lead
    UI.$("#modalHost").hidden = true;
    const makeSO = await confirm(
      `🏆 ${l.company} marked WON!\n\n` +
      (createdCustomer ? `• New customer "${cust.name}" added to your customer list.\n` : `• Linked to existing customer ${cust.name}.\n`) +
      `\nRaise a Sales Order now for ${l.productName || l.product}?\n` +
      `This pushes the deal into your order book → production → dispatch.`,
      { title: "Convert Won lead to order?" });

    if (makeSO) {
      try {
        await App.saveDelta(async () => {
          if (createdCustomer) await DB.customers.upsert(cust);
          await DB.leads.update(l.id, { stage: "Won", customerId: cust.id, nextFollowUp: null });
        });
      } catch (e) { return; }
      // a price won on Samples & Quotations goes onto the line; otherwise the
      // list price, with the quantity derived from the deal value as before
      const wq = quotes().filter((x) => x.leadId === l.id && x.status === "Won").sort(newestFirst)[0];
      await raiseOrderFor({ customerId: cust.id, itemId: l.product, leadId: l.id,
        price: wq ? (wq.finalPrice || wq.price) : 0, qty: wq ? wq.qty : 0, uom: wq ? wq.uom : "",
        quoteId: wq ? wq.id : "", value: l.value || 0 });
      return;
    }

    toast(l.company + " marked Won", { type: "ok" });
    App.saveDelta(async () => {
      if (createdCustomer) await DB.customers.upsert(cust);
      await DB.leads.update(l.id, { stage: "Won", customerId: cust.id, nextFollowUp: null });
    });
    App.go("crm");
  }

  function nextCustomerId() {
    const ids = (ENG.data.customers || []).map((c) => +(String(c.id).replace(/\D/g, "")) || 0);
    const n = (ids.length ? Math.max(...ids) : 0) + 1;
    return "CUS-" + String(n).padStart(2, "0");
  }

  /* ---- the customer record behind a lead ----
     A lead is a company name until something is raised against it, and both
     a won order and a quotation need a customer the server knows. Found by
     name (case-insensitive) or created on the spot and pushed into the
     dataset; the CALLER persists it (DB.customers.upsert) inside its own
     save so the customer and the record that needs it land together.
     Returns { cust, created }. */
  function ensureCustomerFor(l) {
    let cust = ENG.data.customers.find((c) => c.name.toLowerCase() === (l.company || "").toLowerCase());
    let created = false;
    if (!cust) {
      cust = {
        id: nextCustomerId(),
        name: l.company,
        city: l.city || "—",
        gst: "—",
        segment: "Cable Tapes",
        rating: "B",
        terms: "30 days",
        contact: l.contact || "—",
        phone: l.phone || "—",
        email: l.email || "—",
        since: String(DB.helpers.today().getFullYear()),
        /* A lead carries a city but never a country, so a converted client
           starts domestic and is invoiced in rupees. Stamped rather than left
           blank so the exported sheet says what the screen says; the customer
           master re-derives the currency the moment someone sets a country. */
        country: "India", countryCode: "IN", currency: "INR",
      };
      ENG.data.customers.push(cust);
      created = true;
    }
    l.customerId = cust.id;
    return { cust, created };
  }

  /* ---- from the drawer straight to a quotation ----
     The quotation form wants a customer the server can look up, so the same
     step Mark Won takes runs first and is SAVED before leaving the page —
     a form that opened on a customer only this browser knew about would be
     refused at the end. The lead keeps the link, and the form opens with
     the lead's product already on the first line. */
  async function quoteFromLead(l) {
    const { cust, created } = ensureCustomerFor(l);
    UI.$("#modalHost").hidden = true;
    try {
      await App.saveDelta(async () => {
        if (created) await DB.customers.upsert(cust);
        await DB.leads.update(l.id, { customerId: cust.id });
      });
    } catch (e) { return; }   // saveDelta has already said so and reloaded
    App.go("quotations", { tab: "quotations", openNew: true, fromLead: l.id, customerId: cust.id });
  }

  /* ---- log an activity ---- */
  function logActivity(l) {
    const body = h("div", { class: "form-grid" }, [
      field("Type", selectHTML("a_type", ACT_TYPES.map((t) => ({ v: t, l: t })), "Call")),
      field("Date", `<input class="input" id="a_date" type="date" value="${todayISO()}">`),
      field("Note", `<textarea class="input" id="a_note" placeholder="What happened on this touchpoint?"></textarea>`, "full"),
      field("Next follow-up", `<input class="input" id="a_next" type="date" value="${DB.helpers.daysAhead(3)}">`),
    ]);
    const mo = modal({ title: "Log Activity", sub: l.company, body,
      foot: [
        h("button", { class: "btn ghost", onclick: () => mo.close(), text: "Cancel" }),
        h("button", { class: "btn primary", onclick: save, text: "Save Activity" }),
      ] });
    function save() {
      const type = UI.$("#a_type").value, date = UI.$("#a_date").value, note = UI.$("#a_note").value.trim();
      if (!note) { toast("Add a short note", { type: "warn" }); return; }
      l.activities = l.activities || [];
      l.activities.push({ date, type, note, by: l.owner || "Sales Desk" });
      const next = UI.$("#a_next").value;
      if (next) l.nextFollowUp = next;
      // logging contact on a New lead auto-advances it to Contacted
      if (l.stage === "New") l.stage = "Contacted";
      App.saveDelta(() => DB.leads.update(l.id, { activities: l.activities, nextFollowUp: l.nextFollowUp, stage: l.stage }));
      mo.close();
      toast("Activity logged", { type: "ok" });
      leadDetail(l.id);
    }
  }

  /* ============================================================
     SAMPLE — the reel that goes out BEFORE any price does
     A cable maker will not price our tape until they have run it on
     their own line, so the sample despatch is its own pipeline stage.
     Recording it here means the chasing call has the product, the
     quantity, the courier and the date to hand, and the verdict that
     comes back decides whether the lead earns a quotation.
     ============================================================ */
  function sampleForm(l) {
    const s = l.sample || {};
    const fgs = ENG.data.items.filter((i) => i.cat === "FG");
    const already = !!l.sample;
    const chosen = s.product || l.product || (fgs[0] && fgs[0].id);
    const uomOf = (id) => (ENG.item(id) || {}).uom || "kg";
    /* the jobs that made this product, newest first — a reel is cut from one
       of them, and naming it is what lets a verdict be answered with the lab
       reading for that very batch */
    const batchOpts = (pid) => [{ v: "", l: "— none —" }].concat(
      (ENG.data.workorders || []).filter((w) => w.itemId === pid)
        .sort((a, b) => (a.id < b.id ? 1 : -1))
        .map((w) => ({ v: w.id, l: w.id + " · " + ENG.qtyText(ENG.item(w.itemId), w.qty) + " · " + (w.status || "") })));

    const body = h("div", { class: "form-grid" }, [
      field("Sample Product *", selectHTML("s_product",
        fgs.map((i) => ({ v: i.id, l: i.name + (i.thicknessMM != null ? " · " + i.thicknessMM + " mm" : "") + " — " + (i.typeCode || i.id) })),
        chosen)),
      field("Batch (work order)", selectHTML("s_batch", batchOpts(chosen), s.batch || "")),
      field("Quantity", `<div class="flex aic gap"><input class="input" id="s_qty" type="number" step="0.01" min="0" value="${s.qty != null ? s.qty : 1}">`
        + `<span class="chip" id="s_uom">${esc(uomOf(chosen))}</span></div>`),
      field("Sent On", `<input class="input" id="s_sent" type="date" value="${s.sentDate || todayISO()}">`),
      field("Courier / Carrier", `<input class="input" id="s_courier" value="${esc(s.courier || "")}" placeholder="e.g. Blue Dart / hand delivered">`),
      field("Docket / AWB No.", `<input class="input" id="s_awb" value="${esc(s.awb || "")}" placeholder="Tracking reference">`),
      field("Verdict", selectHTML("s_verdict", SAMPLE_VERDICTS.map((v) => ({ v, l: v })), s.verdict || "Awaiting feedback")),
      field("Chase feedback on", `<input class="input" id="s_next" type="date" value="${(already && l.nextFollowUp) || DB.helpers.daysAhead(7)}">`),
      field("Remarks", `<textarea class="input" id="s_note" placeholder="Width / thickness asked for, trial line, who is testing it…">${esc(s.note || "")}</textarea>`, "full"),
    ]);

    const mo = modal({ title: already ? "Sample Despatch" : "Send Sample", sub: l.company, body,
      foot: [
        h("button", { class: "btn ghost", onclick: () => mo.close(), text: "Cancel" }),
        h("button", { class: "btn primary", onclick: save, text: already ? "Save Sample" : "Record Sample & Move" }),
      ] });

    // the unit and the batch list belong to the product, so both follow the picker
    const prodSel = UI.$("#s_product");
    if (prodSel) prodSel.onchange = () => {
      const u = UI.$("#s_uom"); if (u) u.textContent = uomOf(prodSel.value);
      const b = UI.$("#s_batch");
      if (b) b.innerHTML = batchOpts(prodSel.value).map((o) => `<option value="${esc(o.v)}">${esc(o.l)}</option>`).join("");
    };

    function save() {
      const pid = UI.$("#s_product").value;
      const fg = ENG.item(pid) || {};
      const sentDate = UI.$("#s_sent").value || todayISO();
      const sample = {
        product: pid, productName: fg.name || "", qty: +UI.$("#s_qty").value || 0,
        uom: fg.uom || "kg", sentDate,
        batch: UI.$("#s_batch").value,
        courier: UI.$("#s_courier").value.trim(), awb: UI.$("#s_awb").value.trim(),
        verdict: UI.$("#s_verdict").value, note: UI.$("#s_note").value.trim(),
      };
      // only the first despatch writes a timeline entry; later edits just
      // correct the record instead of stacking up duplicate "Sample Sent" rows
      const first = !l.sample;
      l.sample = sample;
      l.stage = "Sample";
      l.nextFollowUp = UI.$("#s_next").value || DB.helpers.daysAhead(7);
      if (first) {
        l.activities = l.activities || [];
        l.activities.push({ date: sentDate, type: "Sample Sent",
          note: [ENG.num(sample.qty) + " " + sample.uom, sample.productName].filter(Boolean).join(" — ")
            + (sample.batch ? " · batch " + sample.batch : "")
            + (sample.courier ? " · via " + sample.courier : "")
            + (sample.awb ? " (" + sample.awb + ")" : ""),
          by: l.owner || "Sales Desk" });
      }
      mo.close();
      toast(first ? l.company + " → Sample" : "Sample details updated", { type: "ok" });
      // no page change: the save re-renders whichever screen this was opened
      // from — the lead drawer on the CRM, or the Samples tab
      App.saveDelta(() => DB.leads.update(l.id, { stage: "Sample", sample,
        nextFollowUp: l.nextFollowUp, activities: l.activities }));
    }
  }

  /* ---- what the lab measured on the batch the sample was cut from ----
     "Your sample failed on our line" is answered with the certificate for
     that reel, not with a promise to look into it. The reading is fetched
     live through the same call the complaint screen makes (nothing about it
     is stored on the lead) and drawn into the card when it lands, so the
     drawer opens without waiting on the server. */
  function labReadingCard(batch) {
    const head = (rep) => h("div", { class: "flex between aic wrap gap", style: "margin-bottom:8px" }, [
      h("div", { class: "muted", style: "font-size:11px;font-weight:700;text-transform:uppercase", text: "🧪 What the lab measured on " + batch }),
      rep ? h("span", { html: badge(String(rep.labResult || rep.result || "").toLowerCase() === "pass" ? "ok" : "danger", rep.labResult || rep.result || "—") }) : null,
    ].filter(Boolean));
    const card = h("div", { class: "card", style: "margin-top:10px;box-shadow:none;background:var(--panel-2)" }, [
      head(null),
      h("div", { class: "muted", style: "font-size:13px", text: "Reading the lab record…" }),
    ]);
    DB.complaints.spread(batch).then((sp) => {
      const params = (M["lab-reports"] && M["lab-reports"].PARAMS) || [];
      const rep = sp && sp.report;
      const vals = rep ? (rep.labValues || rep.values || {}) : {};
      const res = rep ? (rep.labResults || rep.results || {}) : {};
      const labRows = params.filter((p) => vals[p.key] != null).map((p) => {
        const r = String(res[p.key] || "").toLowerCase();
        return `<tr><td>${esc(p.label)}</td><td class="num mono">${esc(String(vals[p.key]))} <span class="muted">${esc(p.unit)}</span></td>`
          + `<td class="num">${r ? badge(r === "pass" ? "ok" : "danger", r === "pass" ? "✓ pass" : "✗ fail") : '<span class="muted">—</span>'}</td></tr>`;
      }).join("");
      const failed = Object.entries(res).filter(([, v]) => String(v).toLowerCase() === "fail")
        .map(([k]) => (params.find((p) => p.key === k) || { label: k }).label);
      card.innerHTML = "";
      card.appendChild(head(rep));
      card.appendChild(rep
        ? h("div", { class: "table-wrap" }, h("table", { class: "tbl", html: '<thead><tr><th>Parameter</th><th class="num">Reading</th><th class="num">Spec</th></tr></thead><tbody>'
            + (labRows || '<tr><td colspan="3" class="muted">No readings recorded</td></tr>') + "</tbody>" }))
        : h("div", { class: "muted", style: "font-size:13px", text: "No lab report found for this batch." }));
      // the verdict line is what a rejected sample is answered with
      if (rep && failed.length) card.appendChild(h("div", { style: "margin-top:8px", html: badge("danger", "The batch failed " + failed.join(", ") + " — the reel went out below spec") }));
      else if (rep && labRows) card.appendChild(h("div", { style: "margin-top:8px", html: badge("ok", "The batch passed every test — the reel went out to spec") }));
    }).catch(() => {
      card.lastChild.textContent = "The lab record could not be read — the server did not answer.";
    });
    return card;
  }

  /* ============================================================
     SAMPLES & QUOTATIONS — the road from a reel to an order
     One page, two tabs, one flow: a sample goes out, a verdict comes
     back, a price is offered, the number moves round by round, and the
     quote closes won or lost. Samples live on their leads (one reel per
     enquiry) and are only LISTED here; quotations are records of their
     own. The tab rides in App.params because every save re-renders the
     module from scratch, and a save must land back on the tab it left.
     ============================================================ */
  const QTN_UOMS = ["KG", "SQM", "MTR"];
  const STALE_QUOTE_DAYS = 7;   // an open price with no word back this long is a chase
  const quotes = () => ENG.data.quotations || [];
  /* A quotation is the SERVER's record — it assigns the id, the value and the
     history line, so the client cannot mutate ENG.data optimistically the way
     the lead editors do. App.saveDelta only reloads on failure; a quotation
     write must reload on SUCCESS too, or the list, the pill and the reopened
     detail keep showing the price from before the change until the next poll.
     Every quotation verb goes through here. Returns the server's record. */
  async function qtnSave(fn, okMsg) {
    let out;
    try { out = await fn(); }
    catch (e) { toast(e.message || "Could not save the quotation", { type: "danger" }); throw e; }
    await App.reloadState();
    if (okMsg) toast(okMsg, { type: "ok" });
    return out;
  }
  const leadById = (id) => (ENG.data.leads || []).find((l) => l.id === id) || null;
  const uomOfQuote = (q) => String(q.uom || "KG").toLowerCase();
  const rs = (n) => "₹" + ENG.num(n, 2);
  /* a quote in one breath: ₹940.00/kg */
  const priceText = (q, p) => rs(p != null ? p : q.price) + "/" + uomOfQuote(q);
  const quoteValueOf = (p, qty) => (qty > 0 ? Math.round(p * qty * 100) / 100 : p);
  const isOpenSample = (l) => !!l.sample && (!l.sample.verdict || l.sample.verdict === "Awaiting feedback") && l.stage !== "Won" && l.stage !== "Lost";
  /* an approved sample with no price on the table yet — money left lying */
  const needsQuote = (l) => !!l.sample && l.sample.verdict === "Approved" && l.stage !== "Won" && l.stage !== "Lost"
    && !quotes().some((q) => q.leadId === l.id && q.status !== "Lost");
  const quoteDays = (q) => daysBetween(q.lastUpdated || q.date, todayISO());
  /* open quotes the customer has gone quiet on, longest first */
  function staleQuotes() {
    return quotes().filter((q) => q.status === "Open" && quoteDays(q) >= STALE_QUOTE_DAYS)
      .map((q) => ({ q, days: quoteDays(q) })).sort((a, b) => b.days - a.days);
  }
  function quoteBadge(q) {
    if (q.status === "Won") return badge("ok", "Won · " + priceText(q, q.finalPrice != null ? q.finalPrice : q.price));
    if (q.status === "Lost") return badge("danger", "Lost" + (q.counterPrice > 0 ? " · " + priceText(q, q.counterPrice) : "") + " · " + normaliseReason(q.lostReason));
    const d = quoteDays(q);
    return d >= STALE_QUOTE_DAYS ? badge("warn", "Open · " + d + " d silent") : badge("info", "Open");
  }
  const vTone = (v) => ({ Approved: "ok", Rejected: "danger", "Rework needed": "warn" }[v] || "info");
  const chipN = (n) => (n ? ' <span class="chip" style="margin-left:6px">' + n + "</span>" : "");
  const newestFirst = (a, b) => String(b.lastUpdated || b.date || "").localeCompare(String(a.lastUpdated || a.date || ""));

  M.quotations = { title: "Samples & Quotations", sub: "Samples out, prices offered, and what came of them", render(root, params) {
    let tab = (params && params.tab) || "quotations";
    let q = "";
    const allLeads = ENG.leads();
    const sampled = allLeads.filter((l) => l.sample && l.sample.sentDate);
    const waiting = openSamples(allLeads);
    const toQuote = sampled.filter(needsQuote);
    const open = quotes().filter((x) => x.status === "Open");

    root.appendChild(pageHead("Samples & Quotations", "Every reel that went out, every price offered, and what came of them", [
      MW.excelMenu("quotations"),
      h("button", { class: "btn ghost", onclick: () => pickLeadForSample(), html: "📦 Send sample" }),
      h("button", { class: "btn primary", onclick: () => quoteForm(null, {}), html: "＋ New quotation" }),
    ]));
    const seg = h("div", { class: "seg", style: "margin-bottom:12px" }, [
      h("button", { class: tab === "samples" ? "on" : "", html: "📦 Samples" + chipN(waiting.length), onclick: (e) => setTab("samples", e.currentTarget) }),
      h("button", { class: tab === "quotations" ? "on" : "", html: "📄 Quotations" + chipN(open.length), onclick: (e) => setTab("quotations", e.currentTarget) }),
    ]);
    root.appendChild(seg);
    function setTab(t, btn) {
      tab = t; App.params = Object.assign({}, App.params || {}, { tab: t });
      [...seg.children].forEach((c) => c.classList.remove("on")); btn.classList.add("on"); draw();
    }
    root.appendChild(h("div", { class: "toolbar" }, [
      MW.searchInput("Search customer, product, batch, note…", (v) => { q = v.toLowerCase().trim(); draw(); }),
      h("div", { style: "margin-left:auto" }, h("span", { class: "chip", id: "sqCount" })),
    ]));
    const host = h("div"); root.appendChild(host);
    /* delegated, because UI.table rebuilds its rows on every sort */
    host.onclick = (e) => {
      const b = e.target.closest && e.target.closest("[data-sample],[data-quote]");
      if (!b) return;
      if (b.dataset.sample) { const l = leadById(b.dataset.sample); if (l) sampleDetail(l); }
      else { const x = quotes().find((z) => z.id === b.dataset.quote); if (x) quoteDetail(x); }
    };
    draw();
    /* one-shot commands, cleared so the 15 s refresh does not reopen them */
    if (params && params.openNew) {
      const seed = { leadId: params.fromLead, customerId: params.customerId };
      params.openNew = false; params.fromLead = null; params.customerId = null;
      quoteForm(null, seed);
    }
    if (params && params.open) { const x = quotes().find((z) => z.id === params.open); params.open = null; if (x) quoteDetail(x); }

    function draw() { if (tab === "samples") drawSamples(); else drawQuotes(); }

    function drawSamples() {
      const rows = sampled.map((l) => ({ id: l.id, lead: l, s: l.sample, open: isOpenSample(l), age: sampleAge(l) || 0 }))
        .filter((r) => !q || [r.lead.company, r.lead.contact, r.s.productName, r.s.batch, r.s.awb, r.s.verdict, r.s.note].join(" ").toLowerCase().includes(q))
        .sort((a, b) => (a.open !== b.open) ? (a.open ? -1 : 1) : (b.age - a.age));
      const c = UI.$("#sqCount"); if (c) c.textContent = rows.length + (rows.length === 1 ? " sample" : " samples");
      const oldest = waiting.length ? waiting[0].age : 0;
      host.innerHTML = "";
      host.appendChild(h("div", { class: "muted", style: "font-size:12.5px;margin-bottom:10px",
        text: waiting.length + " awaiting a verdict" + (waiting.length ? " · oldest " + oldest + (oldest === 1 ? " day" : " days") : "")
          + (toQuote.length ? " · " + toQuote.length + " approved and not yet quoted" : "") }));
      if (!rows.length) {
        host.appendChild(h("div", { class: "empty" }, [h("div", { class: "big", text: "📦" }),
          h("div", { text: sampled.length ? "No sample matches that search" : "No sample has gone out yet — send one from a lead" })]));
        return;
      }
      host.appendChild(table(rows, [
        { key: "customer", label: "Customer", sort: (r) => r.lead.company,
          render: (r) => `<b>${esc(r.lead.company)}</b><div class="muted" style="font-size:11.5px">${esc(r.lead.contact || "—")} · ${esc(r.lead.id)}</div>` },
        { key: "product", label: "Product · batch", sort: (r) => r.s.productName || "",
          render: (r) => esc((r.s.productName || r.s.product || "—") + (r.s.batch ? " · " + r.s.batch : ""))
            + (r.s.awb ? `<div class="muted" style="font-size:11.5px">${esc((r.s.courier ? r.s.courier + " · " : "") + "AWB " + r.s.awb)}</div>` : "") },
        { key: "qty", label: "Qty", num: true, sort: (r) => +r.s.qty || 0, render: (r) => (r.s.qty ? ENG.num(r.s.qty) + " " + esc(r.s.uom || "") : "—") },
        { key: "sent", label: "Sent", sort: (r) => r.s.sentDate, render: (r) => esc(r.s.sentDate) },
        // the tone only means something while the verdict is still owed
        { key: "age", label: "Age", num: true, sort: (r) => r.age, render: (r) => badge(r.open ? ageTone(r.age) : "mut", r.age + (r.age === 1 ? " day" : " days")) },
        { key: "verdict", label: "Verdict", sort: (r) => r.s.verdict || "",
          render: (r) => badge(vTone(r.s.verdict), r.s.verdict || "Awaiting feedback") + (needsQuote(r.lead) ? " " + badge("warn", "quote it") : "") },
        { key: "go", label: "", noSort: true, render: (r) => `<button class="btn sm" data-sample="${esc(r.id)}">Open</button>` },
      ], { empty: "No sample has gone out yet" }));
    }

    function drawQuotes() {
      const rank = { Open: 0, Won: 1, Lost: 2 };
      const rows = quotes().filter((x) => !q || [x.id, x.company, x.productName, x.itemId, x.note, x.status, x.lostTo].join(" ").toLowerCase().includes(q))
        .sort((a, b) => (rank[a.status] - rank[b.status]) || newestFirst(a, b));
      const c = UI.$("#sqCount"); if (c) c.textContent = rows.length + (rows.length === 1 ? " quotation" : " quotations");
      const decided = quotes().filter((x) => x.status !== "Open");
      const won = decided.filter((x) => x.status === "Won");
      const rounds = decided.length ? decided.reduce((s, x) => s + (+x.rounds || 1), 0) / decided.length : 0;
      host.innerHTML = "";
      host.appendChild(h("div", { class: "muted", style: "font-size:12.5px;margin-bottom:10px",
        text: open.length + " open" + (decided.length ? " · won " + Math.round(won.length / decided.length * 100) + "% of " + decided.length + " decided · " + rounds.toFixed(1) + " rounds to close" : "") }));
      if (!rows.length) {
        host.appendChild(h("div", { class: "empty" }, [h("div", { class: "big", text: "📄" }),
          h("div", { text: quotes().length ? "No quotation matches that search" : "No price has been quoted yet" })]));
        return;
      }
      host.appendChild(table(rows, [
        { key: "id", label: "Quote", sort: (r) => r.id, render: (r) => `<b class="mono">${esc(r.id)}</b><div class="muted" style="font-size:11.5px">${esc(r.date || "")}</div>` },
        { key: "company", label: "Customer", sort: (r) => r.company || "",
          render: (r) => `<b>${esc(r.company || ENG.custName(r.customerId))}</b>` + (r.leadId ? `<div class="muted" style="font-size:11.5px">${esc(r.leadId)}</div>` : "") },
        { key: "product", label: "Product", sort: (r) => r.productName || "", render: (r) => esc(r.productName || r.itemId || "—") },
        { key: "uom", label: "Unit", sort: (r) => r.uom || "", render: (r) => esc(uomOfQuote(r)) },
        { key: "price", label: "Price", num: true, sort: (r) => +r.price || 0,
          render: (r) => `<b>${esc(priceText(r))}</b>`
            + (r.status === "Won" && r.finalPrice !== r.price ? `<div class="muted" style="font-size:11px">final ${esc(priceText(r, r.finalPrice))}</div>` : "")
            + (r.status === "Lost" && r.counterPrice > 0 ? `<div class="muted" style="font-size:11px">counter ${esc(priceText(r, r.counterPrice))}</div>` : "") },
        { key: "qty", label: "Qty → Value", num: true, sort: (r) => +r.value || 0,
          render: (r) => (r.qty > 0 ? ENG.num(r.qty) + " " + esc(uomOfQuote(r)) + " → " + money(r.value) : '<span class="muted">—</span>') },
        { key: "rounds", label: "Rounds", num: true, sort: (r) => +r.rounds || 1, render: (r) => String(r.rounds || 1) },
        { key: "upd", label: "Updated", sort: (r) => r.lastUpdated || r.date, render: (r) => esc(r.lastUpdated || r.date || "") },
        { key: "status", label: "Status", sort: (r) => rank[r.status], render: (r) => quoteBadge(r) },
        { key: "go", label: "", noSort: true, render: (r) => `<button class="btn sm" data-quote="${esc(r.id)}">Open</button>` },
      ], { empty: "No price has been quoted yet" }));
    }
  }};

  /* ---- a reel goes out against an enquiry; pick which one ---- */
  function pickLeadForSample() {
    const cands = ENG.leads().filter((l) => l.stage !== "Won" && l.stage !== "Lost" && !l.sample);
    if (!cands.length) { toast("Every open lead already has a sample out — open the lead to update it", { type: "warn" }); return; }
    const body = h("div", { class: "form-grid" }, [
      field("Lead (enquiry) *", selectHTML("ps_lead", cands.map((l) => ({ v: l.id, l: l.company + " · " + (l.productName || l.product || "") + " · " + l.id })), cands[0].id), "full"),
    ]);
    const mo = modal({ title: "Send a sample", sub: "Which enquiry is the reel for?", body, foot: [
      h("button", { class: "btn ghost", onclick: () => mo.close(), text: "Cancel" }),
      h("button", { class: "btn primary", text: "Next →", onclick: () => { const l = leadById(UI.$("#ps_lead").value); mo.close(); if (l) sampleForm(l); } }),
    ] });
  }

  /* ---- the sample's own record: what went out, what came back, what the lab saw ---- */
  function sampleDetail(l) {
    const s = l.sample; if (!s) return;
    const age = sampleAge(l);
    const body = h("div", {}, [
      MW.dl([
        ["Customer", l.company], ["Contact", l.contact || "—"],
        ["Product", s.productName || s.product || "—"],
        ["Quantity", s.qty ? ENG.num(s.qty) + " " + (s.uom || "") : "—"],
        ["Sent", (s.sentDate || "—") + (age != null ? " · " + age + (age === 1 ? " day ago" : " days ago") : "")],
        ["Batch", s.batch || "—"], ["Courier", s.courier || "—"], ["Docket / AWB", s.awb || "—"],
        ["Verdict", h("span", { html: badge(vTone(s.verdict), s.verdict || "Awaiting feedback") })],
        ["Lead stage", h("span", { html: badge(stageBadge(l.stage), l.stage) })],
      ]),
      s.note ? h("div", { class: "card", style: "margin-top:12px;box-shadow:none;background:var(--panel-2)" }, [
        h("div", { class: "muted", style: "font-size:11px;font-weight:700;text-transform:uppercase;margin-bottom:4px", text: "Remarks" }),
        h("div", { style: "font-size:13px;line-height:1.5", text: s.note })]) : null,
      s.batch ? labReadingCard(s.batch) : null,
    ]);
    modal({ title: "📦 Sample · " + l.company, sub: l.id + " · " + (s.productName || ""), wide: true, body, foot: [
      h("button", { class: "btn ghost", onclick: () => { UI.$("#modalHost").hidden = true; leadDetail(l.id); }, text: "🎯 Lead" }),
      h("button", { class: "btn", onclick: () => sampleForm(l), text: "✎ Update verdict" }),
      needsQuote(l) ? h("button", { class: "btn primary", text: "📄 Quote it",
        onclick: () => { UI.$("#modalHost").hidden = true; quoteForm(null, { leadId: l.id, customerId: l.customerId }); } }) : null,
    ].filter(Boolean) });
  }

  /* ---- raise or edit a quotation ----
     The entries are deliberately few: who, which product, in which unit,
     at what price. The customer follows the lead, the unit follows the
     product, and the price is the only number the desk has to think about. */
  function quoteForm(edit, seed) {
    seed = seed || {};
    const q0 = edit || {};
    const lead = leadById(q0.leadId || seed.leadId);
    const openLeads = ENG.leads().filter((l) => (l.stage !== "Won" && l.stage !== "Lost") || (lead && l.id === lead.id));
    const fgs = ENG.data.items.filter((i) => i.cat === "FG");
    const custs = ENG.data.customers.slice().sort((a, b) => a.name.localeCompare(b.name));
    const item0 = q0.itemId || seed.itemId || (lead && lead.product) || (fgs[0] && fgs[0].id);
    const uomOf = (id) => { const u = String((ENG.item(id) || {}).uom || "KG").toUpperCase(); return QTN_UOMS.includes(u) ? u : "KG"; };
    const custOpts = [{ v: "", l: "— none —" }].concat(custs.map((c) => ({ v: c.id, l: c.name })));
    const body = h("div", { class: "form-grid" }, [
      field("Lead (enquiry)", edit
        ? `<input class="input" value="${esc(lead ? lead.company + " · " + lead.id : "— none —")}" disabled>`
        : selectHTML("q_lead", [{ v: "", l: "— none, quote a customer directly —" }].concat(openLeads.map((l) => ({ v: l.id, l: l.company + " · " + l.id }))), (lead && lead.id) || "")),
      field("Customer", selectHTML("q_cust", custOpts, q0.customerId || seed.customerId || (lead && lead.customerId) || "")),
      field("Product *", selectHTML("q_item", fgs.map((i) => ({ v: i.id, l: i.name + (i.thicknessMM != null ? " · " + i.thicknessMM + " mm" : "") + " — " + (i.typeCode || i.id) })), item0)),
      field("Unit *", selectHTML("q_uom", QTN_UOMS.map((u) => ({ v: u, l: "per " + u.toLowerCase() })), q0.uom || seed.uom || uomOf(item0))),
      field("Price per unit (₹) *", `<input class="input" id="q_price" type="number" step="0.01" min="0" value="${q0.price != null ? q0.price : (seed.price || "")}" placeholder="the number offered">`),
      field("Quantity (optional)", `<input class="input" id="q_qty" type="number" step="0.01" min="0" value="${q0.qty || seed.qty || ""}" placeholder="expected order, in the unit above">`),
      field("Note", `<textarea class="input" id="q_note" placeholder="What was discussed — width, delivery, payment…">${esc(q0.note || "")}</textarea>`, "full"),
    ]);
    const mo = modal({ title: edit ? "Edit " + q0.id : "New quotation", sub: edit ? (q0.company || "") : "The price you are putting on the table", body, foot: [
      h("button", { class: "btn ghost", onclick: () => mo.close(), text: "Cancel" }),
      h("button", { class: "btn primary", onclick: save, text: edit ? "Save" : "Raise quotation" }),
    ] });
    // the customer and the product follow the lead; the unit follows the product
    const leadSel = UI.$("#q_lead");
    if (leadSel) leadSel.onchange = () => {
      const l = leadById(leadSel.value);
      if (!l) return;
      const cs = UI.$("#q_cust"); if (cs && l.customerId) cs.value = l.customerId;
      const it = UI.$("#q_item"); if (it && l.product) { it.value = l.product; const u = UI.$("#q_uom"); if (u) u.value = uomOf(l.product); }
    };
    const itemSel = UI.$("#q_item");
    if (itemSel) itemSel.onchange = () => { const u = UI.$("#q_uom"); if (u) u.value = uomOf(itemSel.value); };

    async function save() {
      const leadId = edit ? (q0.leadId || "") : UI.$("#q_lead").value;
      const customerId = UI.$("#q_cust").value;
      const itemId = UI.$("#q_item").value, uom = UI.$("#q_uom").value;
      const price = +UI.$("#q_price").value || 0, qty = +UI.$("#q_qty").value || 0, note = UI.$("#q_note").value.trim();
      if (!leadId && !customerId) { toast("Pick the lead or the customer being quoted", { type: "warn" }); return; }
      if (!itemId) { toast("Pick the product", { type: "warn" }); return; }
      if (!(price > 0)) { toast("Enter the price per " + uom.toLowerCase(), { type: "warn" }); return; }
      mo.close();
      App.params = Object.assign({}, App.params || {}, { tab: "quotations" });
      try {
        await qtnSave(() => edit
          ? DB.quotations.update(q0.id, { itemId, uom, qty, note, price, customerId })
          : DB.quotations.create({ leadId, customerId, itemId, uom, price, qty, note }),
          edit ? q0.id + " saved" : "Quotation raised" + (leadId ? " — lead moved to Quoted" : ""));
      } catch (e) { /* qtnSave already toasted */ }
    }
  }

  /* ---- one quotation: the price now, the road to it, and what to do next ---- */
  function quoteDetail(q) {
    const lead = leadById(q.leadId);
    const it = ENG.item(q.itemId) || {};
    const kindLabel = { quoted: "opened at", updated: "updated to", won: "won at", lost: "lost against", reopened: "reopened" };
    const hist = (q.history || []).slice().reverse();
    const body = h("div", {}, [
      MW.dl([
        ["Product", q.productName || it.name || q.itemId],
        ["Unit", uomOfQuote(q)],
        ["Current price", h("b", { text: priceText(q) })],
        ["Quantity", q.qty > 0 ? ENG.num(q.qty) + " " + uomOfQuote(q) : "—"],
        ["Value", q.qty > 0 ? money(q.value) : "—"],
        ["Status", h("span", { html: quoteBadge(q) })],
        ["Rounds", String(q.rounds || 1)],
        ["Opened", q.date || "—"],
        ["Last update", q.lastUpdated || q.date || "—"],
        lead ? ["Lead", h("a", { href: "#", class: "a-link", text: lead.company + " · " + lead.id,
          onclick: (e) => { e.preventDefault(); UI.$("#modalHost").hidden = true; App.go("crm", { open: lead.id }); } })] : null,
        q.customerId ? ["Customer", ENG.custName(q.customerId)] : null,
        q.status === "Won" ? ["Final price", priceText(q, q.finalPrice)] : null,
        q.status === "Lost" ? ["Counter price", q.counterPrice > 0 ? priceText(q, q.counterPrice) : "—"] : null,
        q.status === "Lost" ? ["Lost to", q.lostTo || "—"] : null,
      ].filter(Boolean)),
      q.note ? h("div", { class: "card", style: "margin-top:12px;box-shadow:none;background:var(--panel-2)" }, [
        h("div", { class: "muted", style: "font-size:11px;font-weight:700;text-transform:uppercase;margin-bottom:4px", text: "Note" }),
        h("div", { style: "font-size:13px;line-height:1.5;white-space:pre-wrap", text: q.note })]) : null,
      h("div", { class: "card", style: "margin-top:14px;box-shadow:none;background:var(--panel-2)" }, [
        h("div", { class: "muted", style: "font-size:11px;font-weight:700;text-transform:uppercase;margin-bottom:6px", text: "Price history — " + hist.length + (hist.length === 1 ? " entry" : " entries") }),
        h("div", {}, hist.map((x) => h("div", { class: "flex aic wrap gap", style: "padding:6px 0;border-top:1px solid var(--line);font-size:13px" }, [
          h("span", { class: "muted mono", style: "font-size:11.5px", text: String(x.at || "").slice(0, 10) }),
          h("span", { class: "muted", text: kindLabel[x.kind] || x.kind }),
          h("b", { text: x.price > 0 ? priceText(q, x.price) : "—" }),
          x.qty > 0 ? h("span", { class: "muted", text: "× " + ENG.num(x.qty) + " " + uomOfQuote(q) }) : null,
          x.note ? h("span", { text: "— " + x.note }) : null,
          x.by ? h("span", { class: "muted", style: "margin-left:auto;font-size:11.5px", text: x.by }) : null,
        ].filter(Boolean)))),
      ]),
      lead && lead.sample ? h("div", { class: "flex aic wrap gap", style: "margin-top:12px;font-size:12.5px" }, [
        h("span", { text: "📦 Sample " + (lead.sample.productName || "") + " · sent " + (lead.sample.sentDate || "—") }),
        h("span", { html: badge(vTone(lead.sample.verdict), lead.sample.verdict || "Awaiting feedback") }),
        h("button", { class: "btn sm ghost", text: "Open sample", onclick: () => { UI.$("#modalHost").hidden = true; sampleDetail(lead); } }),
      ]) : null,
    ]);
    const isOpen = q.status === "Open";
    modal({ title: q.id + " · " + (q.company || ENG.custName(q.customerId)), sub: (q.productName || q.itemId) + " · " + priceText(q), wide: true, body,
      foot: [
        window._erpUtil && window._erpUtil.printQuote ? h("button", { class: "btn ghost", onclick: () => window._erpUtil.printQuote(q), text: "🖨 Print" }) : null,
        q.status !== "Won" ? h("button", { class: "btn danger", text: "🗑 Delete", onclick: async () => {
          if (!await confirm("Delete " + q.id + "?", { title: "Delete quotation", danger: true })) return;
          UI.$("#modalHost").hidden = true;
          try { await qtnSave(() => DB.quotations.remove(q.id), q.id + " deleted"); } catch (e) {}
        } }) : null,
        isOpen ? h("button", { class: "btn ghost", onclick: () => { UI.$("#modalHost").hidden = true; quoteForm(q); }, text: "✎ Edit" }) : null,
        !isOpen ? h("button", { class: "btn ghost", text: "↺ Reopen", onclick: async () => {
          UI.$("#modalHost").hidden = true;
          try { await qtnSave(() => DB.quotations.reopen(q.id), q.id + " reopened"); const fr = quotes().find((x) => x.id === q.id); if (fr) quoteDetail(fr); } catch (e) {}
        } }) : null,
        isOpen ? h("button", { class: "btn", onclick: () => repriceForm(q), html: "↻ Update price" }) : null,
        isOpen ? h("button", { class: "btn", style: "color:var(--danger)", onclick: () => loseForm(q), html: "✕ Lost" }) : null,
        isOpen ? h("button", { class: "btn primary", style: "background:linear-gradient(135deg,var(--ok),#0f8a3c)", onclick: () => winForm(q), html: "🏆 Won" }) : null,
      ].filter(Boolean) });
  }

  /* ---- a new number in the same conversation ---- */
  function repriceForm(q) {
    const body = h("div", { class: "form-grid" }, [
      field("New price per " + uomOfQuote(q) + " (₹) *", `<input class="input" id="rp_price" type="number" step="0.01" min="0" value="${q.price}">`),
      field("Quantity (" + uomOfQuote(q) + ")", `<input class="input" id="rp_qty" type="number" step="0.01" min="0" value="${q.qty || ""}">`),
      field("What moved it", `<textarea class="input" id="rp_note" placeholder="e.g. customer countered at ₹880; matched the competitor on width…"></textarea>`, "full"),
    ]);
    const mo = modal({ title: "↻ Update the price — " + (q.company || ""), sub: q.id + " · now " + priceText(q) + " · round " + (q.rounds || 1), body, foot: [
      h("button", { class: "btn ghost", onclick: () => mo.close(), text: "Cancel" }),
      h("button", { class: "btn primary", text: "Record new price", onclick: async () => {
        const price = +UI.$("#rp_price").value || 0, qty = +UI.$("#rp_qty").value || 0, note = UI.$("#rp_note").value.trim();
        if (!(price > 0)) { toast("Enter the new price", { type: "warn" }); return; }
        mo.close();
        try {
          await qtnSave(() => DB.quotations.reprice(q.id, { price, qty, note }), q.id + " → " + priceText(q, price));
          const fresh = quotes().find((x) => x.id === q.id); if (fresh) quoteDetail(fresh);
        } catch (e) {}
      } }),
    ] });
  }

  /* ---- closing won: the final price, then the order ---- */
  function winForm(q) {
    const body = h("div", { class: "form-grid" }, [
      field("Final price per " + uomOfQuote(q) + " (₹) *", `<input class="input" id="w_price" type="number" step="0.01" min="0" value="${q.price}">`),
      field("Quantity (" + uomOfQuote(q) + ")", `<input class="input" id="w_qty" type="number" step="0.01" min="0" value="${q.qty || ""}" placeholder="for the order">`),
      field("Note", `<textarea class="input" id="w_note" placeholder="What closed it — payment terms, delivery…"></textarea>`, "full"),
    ]);
    const mo = modal({ title: "🏆 Won — " + (q.company || ""), sub: q.id + " · " + (q.productName || ""), body, foot: [
      h("button", { class: "btn ghost", onclick: () => mo.close(), text: "Cancel" }),
      h("button", { class: "btn primary", style: "background:linear-gradient(135deg,var(--ok),#0f8a3c)", text: "Mark Won", onclick: save }),
    ] });
    async function save() {
      const finalPrice = +UI.$("#w_price").value || 0;
      if (!(finalPrice > 0)) { toast("Enter the final price", { type: "warn" }); return; }
      const qty = +UI.$("#w_qty").value || 0, note = UI.$("#w_note").value.trim();
      // the order needs a customer the server knows; a lead becomes one here
      const lead = leadById(q.leadId);
      let cust = null, created = false;
      if (lead) { const r = ensureCustomerFor(lead); cust = r.cust; created = r.created; }
      const customerId = cust ? cust.id : q.customerId;
      mo.close();
      try {
        await qtnSave(async () => {
          if (created) await DB.customers.upsert(cust);
          await DB.quotations.win(q.id, { finalPrice, qty, note, customerId });
        }, (q.company || "Quote") + " won at " + priceText(q, finalPrice));
      } catch (e) { return; }
      if (!customerId) return;
      const yes = await confirm(`🏆 ${q.company || ENG.custName(customerId)} won at ${priceText(q, finalPrice)}.\n\nRaise a sales order now for ${q.productName || q.itemId}?\nThis pushes the deal into your order book → production → dispatch.`,
        { title: "Raise the order?" });
      if (yes) await raiseOrderFor({ customerId, itemId: q.itemId, price: finalPrice, qty, uom: q.uom, leadId: q.leadId, quoteId: q.id, value: quoteValueOf(finalPrice, qty) });
    }
  }

  /* ---- closing lost: the counter price is the honest input to "were we too dear" ---- */
  function loseForm(q) {
    let picked = "";
    const chips = h("div", { class: "flex wrap gap", style: "margin-bottom:4px" }, LOST_REASONS.map((r) => {
      const b = h("button", { class: "btn sm", text: r, onclick: () => { picked = r; [...chips.children].forEach((c) => c.classList.remove("primary")); b.classList.add("primary"); } });
      return b;
    }));
    // field() sets innerHTML from a string; the chips are live nodes with
    // click handlers, so they are placed in their own field by hand
    const reasonField = h("div", { class: "field full" }, [h("label", { text: "Reason *" }), chips]);
    const body = h("div", { class: "form-grid" }, [
      reasonField,
      field("Their counter price per " + uomOfQuote(q) + " (₹)", `<input class="input" id="lz_price" type="number" step="0.01" min="0" placeholder="what they would have paid, or the rival's price">`),
      field("Lost to", `<input class="input" id="lz_to" placeholder="competitor or existing supplier">`),
      field("Note", `<textarea class="input" id="lz_note" placeholder="anything worth remembering next time"></textarea>`, "full"),
    ]);
    const mo = modal({ title: "✕ Lost — " + (q.company || ""), sub: q.id + " · our last price " + priceText(q), body, foot: [
      h("button", { class: "btn ghost", onclick: () => mo.close(), text: "Cancel" }),
      h("button", { class: "btn danger", text: "Mark Lost", onclick: async () => {
        if (!picked) { toast("Pick a reason", { type: "warn" }); return; }
        const counterPrice = +UI.$("#lz_price").value || 0, lostTo = UI.$("#lz_to").value.trim(), note = UI.$("#lz_note").value.trim();
        mo.close();
        try {
          await qtnSave(() => DB.quotations.lose(q.id, { counterPrice, lostReason: picked, lostTo, note }));
          toast(q.id + " lost — " + picked, { type: "warn" });
        } catch (e) {}
      } }),
    ] });
  }

  /* ---- the order a won price becomes ----
     Shared by Mark Won on a lead and Won on a quotation. The agreed price
     goes on the line only when it was talked in the product's own unit; a
     sqm price for a kg-stocked tape cannot be typed onto the line honestly,
     so the line takes the list price and the desk is told to correct it. */
  async function raiseOrderFor({ customerId, itemId, price, qty, uom, leadId, quoteId, value }) {
    const fg = ENG.item(itemId) || {};
    const own = String(fg.uom || "KG").toUpperCase();
    const sameUnit = !uom || String(uom).toUpperCase() === own;
    const rate = (sameUnit && price > 0) ? price : (fg.price || price || 0);
    if (!sameUnit) toast("Quoted per " + String(uom).toLowerCase() + " but the tape is stocked in " + own.toLowerCase() + " — the line carries the list price; correct it on the order", { type: "warn" });
    const n = qty > 0 ? qty : (rate > 0 && value > 0 ? Math.max(1, Math.round(value / rate)) : 1);
    const so = {
      id: window._erpUtil.nextSeqId(ENG.data.salesorders, "SO-"),
      date: todayISO(), customerId,
      // no invented width: it is set from the work order the line is filled
      // from, and until then the invoice simply prints the thickness
      lines: [{ itemId, qty: n, rate, width: (fg.widthMM ? fg.widthMM[0] : null) }],
      status: "Confirmed", promised: DB.helpers.daysAhead(14), priority: "Normal",
      value: Math.round(n * rate),
      fromLead: leadId || "",     // traceability back to the CRM lead
      fromQuote: quoteId || "",   // …and to the price it was won at
    };
    // the SO is pushed optimistically so it shows at once; the lead's back-link
    // is the server's to write, so we reload after to reflect it (and the quote
    // the win already closed) rather than leave it for the 15 s poll
    ENG.data.salesorders.push(so);
    try {
      await App.saveDelta(async () => {
        await DB.sales.create(so);
        if (leadId) await DB.leads.update(leadId, { salesOrderId: so.id });
      });
      await App.reloadState();
    } catch (e) { return null; }
    toast(so.id + " created", { type: "ok", title: "Order raised" });
    App.go("sales");
    return so;
  }

  /* ---- the drawer's one-line view of the sample and the quote ----
     The records live on the Samples & Quotations page; the drawer shows
     the state in one breath and an arrow to the record. */
  function sampleStrip(l) {
    const s = l.sample; if (!s) return null;
    const age = sampleAge(l);
    return h("div", { class: "card", style: "margin-top:14px;box-shadow:none;background:var(--panel-2);padding:10px 14px" },
      h("div", { class: "flex between aic wrap gap" }, [
        h("div", { class: "flex aic wrap gap", style: "font-size:13px" }, [
          h("span", { text: "📦" }), h("b", { text: "Sample" }),
          h("span", { text: (s.productName || s.product || "—") + (s.batch ? " · " + s.batch : "") }),
          h("span", { class: "muted", text: "sent " + (s.sentDate || "—") + (age != null ? " · " + age + (age === 1 ? " day" : " days") : "") }),
          h("span", { html: badge(vTone(s.verdict), s.verdict || "Awaiting feedback") }),
          needsQuote(l) ? h("span", { html: badge("warn", "quote it") }) : null,
        ].filter(Boolean)),
        h("div", { class: "flex gap" }, [
          h("button", { class: "btn sm ghost", title: "Update the sample or its verdict", onclick: () => sampleForm(l), text: "✎" }),
          h("button", { class: "btn sm", title: "Open on Samples & Quotations",
            onclick: () => { UI.$("#modalHost").hidden = true; App.go("quotations", { tab: "samples", highlight: l.id }); }, text: "→" }),
        ]),
      ]));
  }
  function quoteStrip(l) {
    const qs = quotes().filter((x) => x.leadId === l.id).sort(newestFirst);
    if (!qs.length) return null;
    const x = qs[0];
    return h("div", { class: "card", style: "margin-top:10px;box-shadow:none;background:var(--panel-2);padding:10px 14px" },
      h("div", { class: "flex between aic wrap gap" }, [
        h("div", { class: "flex aic wrap gap", style: "font-size:13px" }, [
          h("span", { text: "📄" }), h("b", { text: "Quote" }), h("span", { class: "mono", text: x.id }),
          h("span", { text: priceText(x) + (x.qty > 0 ? " × " + ENG.num(x.qty) + " " + uomOfQuote(x) : "") }),
          h("span", { class: "muted", text: (x.rounds || 1) + ((x.rounds || 1) === 1 ? " round" : " rounds") + (qs.length > 1 ? " · " + qs.length + " quotes" : "") }),
          h("span", { html: quoteBadge(x) }),
        ]),
        h("div", { class: "flex gap" }, [
          x.status === "Open" ? h("button", { class: "btn sm ghost", title: "Update the price", onclick: () => repriceForm(x), text: "↻" }) : null,
          h("button", { class: "btn sm", title: "Open on Samples & Quotations",
            onclick: () => { UI.$("#modalHost").hidden = true; App.go("quotations", { tab: "quotations", open: x.id }); }, text: "→" }),
        ].filter(Boolean)),
      ]));
  }

  /* ============================================================
     CREATE / EDIT LEAD
     ============================================================ */
  function leadForm(existing) {
    const edit = !!existing;
    const l = existing || { stage: "New" };
    const fgs = ENG.data.items.filter((i) => i.cat === "FG");
    const f = (k, d) => (l[k] != null ? l[k] : d);

    const body = h("div", { class: "form-grid" }, [
      field("Company *", `<input class="input" id="l_company" value="${esc(f("company", ""))}" placeholder="Customer / prospect company">`),
      field("Contact Person", `<input class="input" id="l_contact" value="${esc(f("contact", ""))}" placeholder="Name">`),
      field("Phone", `<input class="input" id="l_phone" value="${esc(f("phone", ""))}">`),
      field("Email", `<input class="input" id="l_email" value="${esc(f("email", ""))}">`),
      field("City", `<input class="input" id="l_city" value="${esc(f("city", ""))}">`),
      field("Product Interest", selectHTML("l_product", fgs.map((i) => ({ v: i.id, l: i.name + (i.thicknessMM != null ? " · " + i.thicknessMM + " mm" : "") + " — " + (i.typeCode || i.id) })), f("product", fgs[0] && fgs[0].id))),
      field("Estimated Value (₹)", `<input class="input" id="l_value" type="number" value="${f("value", 0)}">`),
      field("Source", selectHTML("l_source", SOURCES.map((s) => ({ v: s, l: s })), f("source", "Website Enquiry"))),
      field("Owner", `<input class="input" id="l_owner" value="${esc(f("owner", "Sales Desk"))}">`),
      field("Next Follow-up", `<input class="input" id="l_next" type="date" value="${f("nextFollowUp", DB.helpers.daysAhead(3)) || DB.helpers.daysAhead(3)}">`),
      field("Notes", `<textarea class="input" id="l_notes" placeholder="Requirement, volumes, remarks…">${esc(f("notes", ""))}</textarea>`, "full"),
    ]);

    const mo = modal({ title: edit ? "Edit Lead" : "New Lead", sub: edit ? l.id : "Capture a sales enquiry", body,
      foot: [
        h("button", { class: "btn ghost", onclick: () => mo.close(), text: "Cancel" }),
        h("button", { class: "btn primary", onclick: save, text: edit ? "Save Changes" : "Create Lead" }),
      ] });

    function save() {
      const company = UI.$("#l_company").value.trim();
      if (!company) { toast("Company is required", { type: "warn" }); return; }
      const productId = UI.$("#l_product").value;
      const fg = ENG.item(productId);
      const obj = edit ? l : { id: nextLeadId(), stage: "New", created: todayISO(), activities: [] };
      Object.assign(obj, {
        company,
        contact: UI.$("#l_contact").value.trim(),
        phone: UI.$("#l_phone").value.trim(),
        email: UI.$("#l_email").value.trim(),
        city: UI.$("#l_city").value.trim(),
        product: productId,
        productName: fg ? fg.name : "",
        value: +UI.$("#l_value").value || 0,
        source: UI.$("#l_source").value,
        owner: UI.$("#l_owner").value.trim() || "Sales Desk",
        nextFollowUp: (obj.stage === "Won" || obj.stage === "Lost") ? null : UI.$("#l_next").value,
        notes: UI.$("#l_notes").value.trim(),
      });
      if (!edit) ENG.data.leads.push(obj);
      mo.close();
      toast(edit ? "Lead updated" : "Lead created", { type: "ok" });
      App.saveDelta(() => edit ? DB.leads.update(obj.id, obj) : DB.leads.create(obj));
      App.go("crm");
    }
  }

  function nextLeadId() {
    const ids = (ENG.data.leads || []).map((l) => +(String(l.id).replace(/\D/g, "")) || 0);
    const n = (ids.length ? Math.max(...ids) : 0) + 1;
    return "LD-" + String(n).padStart(4, "0");
  }

  /* ============================================================
     dashboard helpers
     ============================================================ */
  function cssv(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }

  /* ---- PRIORITY BLOCK: today's follow-ups ---- */
  function followUpBlock(due, overdueList, todayList, staleSamples) {
    staleSamples = staleSamples || [];
    // a price on the table with no word back is a chase as much as a call is
    const staleQ = staleQuotes();
    if (!due.length && !staleSamples.length && !staleQ.length) {
      return h("div", { class: "card crm-fu calm" }, [
        h("div", { class: "crm-fu-empty" }, [
          h("div", { class: "crm-fu-ic", text: "✓" }),
          h("div", {}, [
            h("div", { class: "crm-fu-title", text: "No follow-ups due" }),
            h("div", { class: "crm-fu-sub", text: "Nothing needs chasing today. Open a lead to schedule the next touchpoint." }),
          ]),
        ]),
      ]);
    }
    const tally = [];
    if (overdueList.length) tally.push(h("span", { class: "crm-delta down", text: overdueList.length + " overdue" }));
    if (todayList.length) tally.push(h("span", { class: "crm-delta flat", text: todayList.length + " due today" }));
    // the sample and quote tallies are a way in: they open Samples & Quotations
    if (staleSamples.length) tally.push(h("button", { class: "crm-delta down", type: "button", style: "border:0;cursor:pointer",
      title: "Every sample that has gone out", onclick: () => App.go("quotations", { tab: "samples" }),
      text: staleSamples.length + " sample" + (staleSamples.length === 1 ? "" : "s") + " silent" }));
    if (staleQ.length) tally.push(h("button", { class: "crm-delta down", type: "button", style: "border:0;cursor:pointer",
      title: "Every price on the table", onclick: () => App.go("quotations", { tab: "quotations" }),
      text: staleQ.length + " quote" + (staleQ.length === 1 ? "" : "s") + " silent" }));

    return h("div", { class: "card crm-fu" }, [
      h("div", { class: "crm-fu-head" }, [
        h("div", { class: "crm-fu-ic", text: "⏰" }),
        h("div", {}, [
          h("div", { class: "crm-fu-title", text: "Chase these first" }),
          h("div", { class: "crm-fu-sub", text: (due.length + staleSamples.length + staleQ.length) + " thing"
            + (due.length + staleSamples.length + staleQ.length === 1 ? " is" : "s are") + " waiting on you" }),
        ]),
        h("div", { class: "crm-fu-tally" }, tally),
      ]),
      h("div", { class: "crm-fu-rows" }, due.slice(0, 6).map((l) => {
        const over = l.nextFollowUp < todayISO();
        const late = over ? daysBetween(l.nextFollowUp, todayISO()) : 0;
        return h("button", { class: "crm-fu-row", onclick: () => leadDetail(l.id) }, [
          h("span", { class: "crm-fu-dot" + (over ? " over" : "") }),
          h("span", { class: "crm-fu-co", text: l.company }),
          h("span", { class: "crm-fu-meta", text: l.stage + " · " + trim(l.contact || "—", 14) }),
          h("span", { class: "crm-fu-val", text: money(l.value) }),
          h("span", { class: "crm-fu-when " + (over ? "over" : "today"),
            text: over ? (late === 1 ? "1 day late" : late + " days late") : "today" }),
        ]);
      }).concat(staleSamples.slice(0, 4).map(({ lead: l, age }) =>
        h("button", { class: "crm-fu-row", onclick: () => leadDetail(l.id) }, [
          h("span", { class: "crm-fu-dot over" }),
          h("span", { class: "crm-fu-co", text: l.company }),
          h("span", { class: "crm-fu-meta", text: "Sample · " + trim((l.sample && (l.sample.productName || l.sample.product)) || "—", 16) }),
          h("span", { class: "crm-fu-val", text: money(l.value) }),
          h("span", { class: "crm-fu-when over", text: age + " d no verdict" }),
        ])).concat(staleQ.slice(0, 4).map(({ q, days }) =>
        h("button", { class: "crm-fu-row", onclick: () => quoteDetail(q) }, [
          h("span", { class: "crm-fu-dot over" }),
          h("span", { class: "crm-fu-co", text: q.company || ENG.custName(q.customerId) }),
          h("span", { class: "crm-fu-meta", text: "Quote · " + priceText(q) + " · " + trim(q.productName || q.itemId || "—", 14) }),
          h("span", { class: "crm-fu-val", text: q.qty > 0 ? money(q.value) : "—" }),
          h("span", { class: "crm-fu-when over", text: days + " d no answer" }),
        ]))))),
    ]);
  }
  function daysBetween(a, b) {
    const d = Math.round((new Date(b + "T00:00:00") - new Date(a + "T00:00:00")) / 86400000);
    return isNaN(d) ? 0 : Math.max(0, d);
  }

  /* ---- drill-downs: every headline opens the detail behind it ---- */
  function leadRows(items, subFor) {
    if (!items.length) return h("div", { class: "crm-none", text: "No leads here yet" });
    return h("div", {}, items.slice().sort((a, b) => (b.value || 0) - (a.value || 0)).map((l) =>
      h("div", { class: "crm-drill-row", onclick: () => { UI.$("#modalHost").hidden = true; leadDetail(l.id); } }, [
        h("div", { class: "crm-ava", style: "--sc:" + (STAGE_META[l.stage] || {}).color,
          text: (String(l.company || "?").trim().charAt(0) || "?").toUpperCase() }),
        h("div", { style: "flex:1;min-width:0" }, [
          h("div", { class: "crm-drill-co", text: l.company }),
          h("div", { class: "crm-drill-sub", text: subFor ? subFor(l) : (l.productName || l.product || "—") }),
        ]),
        h("div", { class: "crm-card-val", text: money(l.value) }),
      ])));
  }

  /* weighted pipeline → how each stage contributes, with the funnel on top */
  function weightedDrill(byStage, stats) {
    // every open stage, in pipeline order — otherwise the segments shown stop
    // adding up to the weighted total in the title
    const open = ENG.STAGES.filter((s) => s !== "Won" && s !== "Lost");
    const funnel = h("div", { class: "crm-funnel" });
    open.forEach((st, i) => {
      const col = byStage[st] || { count: 0, value: 0, items: [] };
      const m = STAGE_META[st];
      const age = avgAge(col.items || []);
      funnel.appendChild(h("div", { class: "crm-fseg", style: "--sc:" + m.color + ";flex-grow:" + Math.max(1, col.value || 0) }, [
        h("div", { class: "crm-fseg-stage", html: m.ic + " " + st }),
        h("div", { class: "crm-fseg-val", text: money(col.value || 0) }),
        h("div", { class: "crm-fseg-count", text: (col.count || 0) + (col.count === 1 ? " lead" : " leads") }),
        age != null ? h("div", { class: "crm-fseg-age", text: "sitting " + age + " days" }) : null,
        h("div", { class: "crm-fbar" }),
      ]));
      funnel.appendChild(h("div", { class: "crm-fchev", text: i < open.length - 1 ? "›" : "→" }));
    });
    funnel.appendChild(h("div", { class: "crm-fout" }, [
      h("div", { class: "crm-fseg-stage", style: "color:var(--ok)", html: "🏆 Won" }),
      h("div", { class: "crm-fseg-val", text: money(stats.wonValue || 0) }),
      h("div", { class: "crm-fseg-count", text: (stats.won || 0) + " closed" }),
    ]));

    const rows = open.map((st) => {
      const col = byStage[st] || { count: 0, value: 0 };
      const p = ((ENG.STAGE_PROB || {})[st]) || { New: 0.15, Contacted: 0.35, Sample: 0.45, Quoted: 0.6 }[st] || 0;
      return h("div", { class: "crm-drill-row", style: "cursor:default" }, [
        h("span", { class: "d", style: "width:9px;height:9px;border-radius:50%;background:" + STAGE_META[st].color }),
        h("div", { style: "flex:1;min-width:0" }, [
          h("div", { class: "crm-drill-co", text: st }),
          h("div", { class: "crm-drill-sub", text: col.count + " open · " + money(col.value) + " × " + Math.round(p * 100) + "% likely" }),
        ]),
        h("div", { class: "crm-card-val", text: money((col.value || 0) * p) }),
      ]);
    });

    modal({ title: "Weighted pipeline · " + money(stats.weighted), wide: true,
      sub: "Each open stage discounted by how often deals at that stage actually close",
      body: h("div", {}, [
        funnel,
        h("h3", { style: "margin:18px 0 6px;font-size:13px", text: "How it adds up" }),
        h("div", {}, rows),
        h("div", { class: "crm-drill-row", style: "cursor:default;border-top:1px solid var(--line-strong)" }, [
          h("div", { style: "flex:1;font-weight:800;font-size:13px" }, "Weighted total"),
          h("div", { class: "crm-card-val", style: "font-size:14px", text: money(stats.weighted) }),
        ]),
      ]) });
  }

  /* open leads → where they came from */
  function sourceDrill(allLeads, stats) {
    const data = bySource(allLeads);
    const cv = h("canvas", { "data-h": 180 });
    const body = h("div", {}, [
      data.length
        ? h("div", { class: "crm-split" }, [
            h("div", { class: "chart-box" }, cv),
            h("div", { class: "crm-legend" }, data.map((d, i) => h("div", { class: "crm-leg-row" }, [
              h("span", { class: "d", style: "background:var(--c" + ((i % 8) + 1) + ")" }),
              h("span", { class: "crm-leg-nm", title: d.name, text: d.name }),
              h("span", { class: "crm-leg-n", text: d.count + (d.count === 1 ? " lead" : " leads") }),
              h("span", { class: "crm-leg-v", text: money(d.value) }),
            ]))),
          ])
        : h("div", { class: "crm-none", text: "No leads captured yet" }),
      h("h3", { style: "margin:18px 0 6px;font-size:13px", text: "Open leads" }),
      leadRows(allLeads.filter((l) => l.stage !== "Won" && l.stage !== "Lost"),
        (l) => l.stage + " · " + (l.source || "source not set")),
    ]);
    modal({ title: "Open leads · " + stats.open, sub: "Every live enquiry and the channel it came from", wide: true, body });
    if (data.length) requestAnimationFrame(() => Charts.donut(cv, {
      data: data.map((d) => ({ name: d.name, value: d.value })), center: String(stats.total), centerSub: "leads" }));
  }

  /* win rate → what was won, what was lost and why */
  function winDrill(allLeads, stats) {
    const won = allLeads.filter((l) => l.stage === "Won");
    const lost = allLeads.filter((l) => l.stage === "Lost");
    const reasons = {};
    // normalised, so a free-text "price too high" from before the list joins the Price row
    lost.forEach((l) => { const k = normaliseReason(l.lostReason); reasons[k] = (reasons[k] || 0) + 1; });
    const lostTo = {};
    lost.forEach((l) => { if (l.lostTo) lostTo[l.lostTo] = (lostTo[l.lostTo] || 0) + 1; });
    const rivalRows = Object.entries(lostTo).sort((a, b) => b[1] - a[1]);
    const reasonRows = Object.entries(reasons).sort((a, b) => b[1] - a[1]);
    modal({ title: "Win rate · " + stats.winRate + "%", wide: true,
      sub: stats.won + " won and " + stats.lost + " lost out of " + (stats.won + stats.lost) + " decided enquiries",
      body: h("div", {}, [
        reasonRows.length ? h("div", {}, [
          h("h3", { style: "margin:0 0 6px;font-size:13px", text: "Why deals were lost" }),
          h("div", {}, reasonRows.map(([r, n]) => h("div", { class: "crm-drill-row", style: "cursor:default" }, [
            h("div", { style: "flex:1;min-width:0" }, [h("div", { class: "crm-drill-co", text: r })]),
            h("span", { class: "crm-delta down", text: n + (n === 1 ? " deal" : " deals") }),
          ]))),
        ]) : null,
        rivalRows.length ? h("div", { style: "margin-top:18px" }, [
          h("h3", { style: "margin:0 0 6px;font-size:13px", text: "Who we lost them to" }),
          h("div", {}, rivalRows.map(([r, n]) => h("div", { class: "crm-drill-row", style: "cursor:default" }, [
            h("div", { style: "flex:1;min-width:0" }, [h("div", { class: "crm-drill-co", text: r })]),
            h("span", { class: "crm-delta down", text: n + (n === 1 ? " deal" : " deals") }),
          ]))),
        ]) : null,
        h("h3", { style: "margin:18px 0 6px;font-size:13px", text: "Won (" + won.length + ")" }),
        leadRows(won, (l) => "closed · " + (l.productName || l.product || "—")),
        h("h3", { style: "margin:18px 0 6px;font-size:13px", text: "Lost (" + lost.length + ")" }),
        leadRows(lost, (l) => normaliseReason(l.lostReason) + (l.lostTo ? " · to " + l.lostTo : "")),
      ]) });
  }

  /* a board column header → that stage in full */
  function stageDrill(col) {
    const m = STAGE_META[col.stage] || {};
    const age = avgAge(col.items || []);
    const avgVal = col.count ? (col.value || 0) / col.count : 0;
    modal({ title: (m.ic || "") + " " + col.stage + " · " + col.count + (col.count === 1 ? " lead" : " leads"),
      sub: money(col.value) + " total · " + money(avgVal) + " average" + (age != null ? " · sitting " + age + " days on average" : ""),
      wide: true,
      body: h("div", {}, [leadRows(col.items || [], (l) =>
        (l.nextFollowUp ? "follow up " + l.nextFollowUp : "no follow-up set") + " · " + (l.productName || l.product || "—"))]) });
  }

  /* every touchpoint, newest first */
  function activityDrill(allLeads) {
    const feed = recentActivity(allLeads, 40);
    modal({ title: "Recent activity", sub: "Latest touchpoints across every lead", wide: true,
      body: feed.length
        ? h("div", { class: "crm-feed" }, feed.map((a) => h("div", { class: "crm-feed-row",
            onclick: () => { UI.$("#modalHost").hidden = true; leadDetail(a.leadId); } }, [
            h("div", { class: "crm-feed-ic", text: actIcon(a.type) }),
            h("div", { class: "crm-feed-tx" }, [
              h("div", { class: "crm-feed-t", text: a.type + " · " + trim(a.company, 30) }),
              h("div", { class: "crm-feed-d", title: a.note, text: a.note || "—" }),
            ]),
            h("div", { class: "crm-feed-when", text: ago(a.date) }),
          ])))
        : h("div", { class: "crm-none", text: "Log a call or meeting and it shows up here" }) });
  }

  /* KPI card: label + big number + optional delta pill + micro-visual */
  function kpiCard({ cls, ic, label, value, delta, foot, vis, onClick }) {
    const visBox = h("div", { class: "crm-kpi-vis" });
    const card = h("div", { class: "card crm-kpi " + (cls || "") + (onClick ? " crm-click" : "") }, [
      h("div", { class: "crm-kpi-top" }, [
        h("span", { class: "crm-kpi-ic", text: ic }),
        h("span", { class: "crm-kpi-lab", text: label }),
        onClick ? h("span", { class: "crm-kpi-more", "aria-hidden": "true", text: "›" }) : null,
      ].filter(Boolean)),
      h("div", { class: "crm-kpi-val", text: value }),
      visBox,
      h("div", { class: "crm-kpi-foot" }, [
        ...(foot || []),
        delta ? h("span", { class: "crm-delta " + delta.type, style: "margin-left:auto",
          text: (delta.type === "up" ? "▲ " : delta.type === "down" ? "▼ " : "") + delta.text }) : null,
      ].filter(Boolean)),
    ]);
    if (vis) vis(visBox);
    if (onClick) {
      card.onclick = onClick;
      card.tabIndex = 0;
      card.setAttribute("role", "button");
      card.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } };
    }
    return card;
  }

  /* month buckets (oldest→newest) of lead value, for the sparklines */
  function monthKeys(n) {
    const out = [], d = DB.helpers.today();
    for (let i = n - 1; i >= 0; i--) {
      const t = new Date(d.getFullYear(), d.getMonth() - i, 1);
      out.push(t.getFullYear() + "-" + String(t.getMonth() + 1).padStart(2, "0"));
    }
    return out;
  }
  function monthlyValue(leads, n) {
    const keys = monthKeys(n), map = {};
    keys.forEach((k) => { map[k] = 0; });
    (leads || []).forEach((l) => {
      const k = String(l.created || "").slice(0, 7);
      if (k in map) map[k] += l.value || 0;
    });
    return { keys, values: keys.map((k) => map[k]) };
  }
  /* running win-rate per month — a flat line when nothing closed that month */
  function winTrend(leads, n) {
    const keys = monthKeys(n);
    return keys.map((k) => {
      const upto = (leads || []).filter((l) => String(l.created || "").slice(0, 7) <= k);
      const w = upto.filter((l) => l.stage === "Won").length;
      const d = w + upto.filter((l) => l.stage === "Lost").length;
      return d ? Math.round((w / d) * 100) : 0;
    });
  }
  /* lead value grouped by source, biggest first (top 5 + Other) */
  function bySource(leads) {
    const map = {};
    (leads || []).forEach((l) => {
      const k = l.source || "Unspecified";
      if (!map[k]) map[k] = { name: k, value: 0, count: 0 };
      map[k].value += l.value || 0; map[k].count++;
    });
    const arr = Object.values(map).sort((a, b) => b.value - a.value);
    if (arr.length <= 6) return arr;
    const head = arr.slice(0, 5);
    const rest = arr.slice(5).reduce((s, d) => ({ name: "Other", value: s.value + d.value, count: s.count + d.count }),
      { name: "Other", value: 0, count: 0 });
    return head.concat(rest);
  }
  /* newest activities across all leads */
  function recentActivity(leads, n) {
    const out = [];
    (leads || []).forEach((l) => (l.activities || []).forEach((a) =>
      out.push({ leadId: l.id, company: l.company, type: a.type, note: a.note, date: a.date })));
    return out.sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, n);
  }
  /* average days a stage's leads have been open (null when the stage is empty) */
  function avgAge(items) {
    const now = DB.helpers.today();
    const ds = (items || []).map((l) => {
      if (!l.created) return null;
      const d = Math.round((now - new Date(l.created + "T00:00:00")) / 86400000);
      return isNaN(d) ? null : Math.max(0, d);
    }).filter((d) => d != null);
    return ds.length ? Math.round(ds.reduce((s, d) => s + d, 0) / ds.length) : null;
  }

  /* compact relative time, e.g. "3d ago" */
  function ago(iso) {
    if (!iso) return "";
    const then = new Date(iso + "T00:00:00"), now = DB.helpers.today();
    const days = Math.round((now - then) / 86400000);
    if (isNaN(days)) return iso;
    if (days <= 0) return "today";
    if (days === 1) return "yesterday";
    if (days < 30) return days + "d ago";
    if (days < 365) return Math.round(days / 30) + "mo ago";
    return Math.round(days / 365) + "y ago";
  }

  /* ============================================================
     small shared helpers
     ============================================================ */
  function field(label, inner, cls) {
    return h("div", { class: "field" + (cls === "full" ? " full" : "") }, [h("label", { text: label }), h("div", { html: inner })]);
  }
  function selectHTML(id, opts, sel) {
    return `<select class="select" id="${id}">` +
      opts.map((o) => `<option value="${esc(o.v)}" ${o.v === sel ? "selected" : ""}>${esc(o.l)}</option>`).join("") +
      `</select>`;
  }
  function stageBadge(st) {
    return { New: "info", Contacted: "warn", Sample: "info", Quoted: "violet", Won: "ok", Lost: "danger" }[st] || "mut";
  }
  function actIcon(t) {
    return { Call: "📞", Email: "✉️", WhatsApp: "💬", Meeting: "🤝", "Sample Sent": "📦", "Quotation Sent": "📄", "Site Visit": "🏭", Note: "📝" }[t] || "•";
  }

  /* ============================================================
     WHATSAPP FOLLOW-UP — the message this trade actually sends
     The app could already open wa.me from a phone number. What it could
     not do was write the message, or remember that it went. Two gaps:

       1. The text is drafted from the deal — company, product, sample
          courier and AWB, the last "Quotation Sent" entry — so nothing
          is retyped and the product code is never wrong.
       2. Pressing Send logs a WhatsApp activity on the lead in the same
          moment, so the timeline stays true without a second step.

     Nothing is sent by this app. wa.me only opens WhatsApp with the text
     pre-filled; the person still presses send there. That is deliberate:
     an ERP must never message a customer on its own.
     ============================================================ */
  const WA_TEMPLATES = [
    { k: "follow",  l: "General follow-up",
      t: (l) => `Hello ${who(l)}, following up on our discussion about ${prod(l)}. Do let me know if you need anything further from our side.` },
    { k: "sample",  l: "Sample — chase feedback",
      t: (l) => { const s = l.sample || {};
        return `Hello ${who(l)}, checking whether the trial on the ${s.productName || prod(l)} sample${s.awb ? " (AWB " + s.awb + ")" : ""} has been run. Happy to send a further reel if it would help.`; } },
    { k: "sampled", l: "Sample despatched",
      t: (l) => { const s = l.sample || {};
        return `Hello ${who(l)}, your sample of ${s.productName || prod(l)}${s.qty ? " (" + ENG.num(s.qty) + " " + (s.uom || "") + ")" : ""} was sent on ${s.sentDate || todayISO()}${s.courier ? " by " + s.courier : ""}${s.awb ? ", AWB " + s.awb : ""}. Please let me know once it reaches you.`; } },
    { k: "quote",   l: "Quote follow-up",
      t: (l) => { const q = quotes().filter((x) => x.leadId === l.id && x.status === "Open").sort(newestFirst)[0];
        // the price on the table when one was quoted — the number and the unit
        // the customer is weighing; the old activity-date wording otherwise
        if (q) return `Hello ${who(l)}, following up on our quotation of ${priceText(q)} for ${q.productName || prod(l)}${q.qty > 0 ? " (" + ENG.num(q.qty) + " " + uomOfQuote(q) + ")" : ""}. Happy to discuss if the quantity or schedule has changed.`;
        const a = lastActivity(l, "Quotation Sent");
        return `Hello ${who(l)}, following up on our quotation${a ? " sent on " + a.date : ""} for ${prod(l)}. Happy to revise if the schedule or quantity has changed.`; } },
    { k: "thanks",  l: "Thank you for the enquiry",
      t: (l) => `Hello ${who(l)}, thank you for your enquiry about ${prod(l)}. I will revert with details shortly.` },
  ];
  /* "H. Desai" must greet as Desai, not "H.": an initial is not a name.
     First word if it is a real word, otherwise the last one; nothing at all
     falls back to a neutral form of address. */
  const who = (l) => {
    const parts = String(l.contact || "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "Sir/Madam";
    const first = parts[0];
    return (/^[A-Za-z]\.?$/.test(first) && parts.length > 1) ? parts[parts.length - 1] : first;
  };
  const prod = (l) => l.productName || l.product || "our tape";
  function lastActivity(l, type) {
    const a = (l.activities || []).filter((x) => x.type === type).sort((x, y) => (x.date < y.date ? 1 : -1));
    return a[0] || null;
  }
  /* which template fits the stage the lead is in — the desk can still pick another */
  function suggestTemplate(l) {
    if (l.stage === "Sample") return (l.sample && l.sample.verdict === "Awaiting feedback" && sampleAge(l) >= 7) ? "sample" : "sampled";
    if (l.stage === "Quoted") return "quote";
    if (l.stage === "New") return "thanks";
    return "follow";
  }

  function whatsappForm(l) {
    const digits = MW.phoneDigits(l.phone);
    if (!digits) { toast("This lead has no phone number", { type: "warn" }); return; }
    let key = suggestTemplate(l);
    const sel = selectHTML("wa_tpl", WA_TEMPLATES.map((t) => ({ v: t.k, l: t.l })), key);
    const body = h("div", { class: "form-grid" }, [
      field("Template", sel, "full"),
      field("Message", '<textarea class="input" id="wa_text" rows="5" style="min-height:110px"></textarea>', "full"),
      h("div", { class: "muted", style: "grid-column:1/-1;font-size:12px" },
        [h("span", { text: "Opens WhatsApp (or your mail) with this text ready. Nothing is sent until you press send there. " }),
         h("b", { text: "Logged on the lead as a WhatsApp or Email activity when you open it." })]),
    ]);
    const ta = () => UI.$("#wa_text");
    const tplOf = () => WA_TEMPLATES.find((x) => x.k === key) || WA_TEMPLATES[0];
    const fill = () => { if (ta()) ta().value = tplOf().t(l); };

    const mo = modal({ title: "💬 Follow up on WhatsApp", sub: l.company + " · " + (l.contact || "") + " · " + l.phone, body,
      foot: [
        h("button", { class: "btn ghost", onclick: () => mo.close(), text: "Cancel" }),
        // the same words by mail, for the contact who answers email and not WhatsApp
        h("button", { class: "btn", text: "✉️ Email instead", onclick: (e) => emailInstead(e.currentTarget) }),
        h("button", { class: "btn primary", text: "Open WhatsApp", onclick: send }),
      ] });
    // the modal has mounted the HTML by now, so the textarea exists to fill
    fill();
    const tpl = UI.$("#wa_tpl");
    if (tpl) tpl.onchange = () => { key = tpl.value; fill(); };

    function send() {
      const text = (ta() ? ta().value : "").trim();
      if (!text) { toast("The message is empty", { type: "warn" }); return; }
      /* log first, then open: if the tab is blocked by a popup rule the
         record still shows the attempt, which is the honest state */
      l.activities = l.activities || [];
      l.activities.push({ date: todayISO(), type: "WhatsApp", note: trim(text, 140), by: l.owner || "Sales Desk" });
      // a follow-up that just went out earns a new chase date
      if (l.stage !== "Won" && l.stage !== "Lost") l.nextFollowUp = DB.helpers.daysAhead(3);
      mo.close();
      window.open("https://wa.me/" + digits + "?text=" + encodeURIComponent(text), "_blank", "noopener");
      toast("WhatsApp opened — logged on " + l.company, { type: "ok" });
      App.saveDelta(() => DB.leads.update(l.id, { activities: l.activities, nextFollowUp: l.nextFollowUp }));
      leadDetail(l.id);
    }
    /* Same message, composed in the user's own webmail through the shared
       chooser. Logged only once a mail client is actually picked — dismissing
       the chooser must not leave a phantom Email on the timeline. */
    function emailInstead(anchor) {
      const text = (ta() ? ta().value : "").trim();
      if (!text) { toast("The message is empty", { type: "warn" }); return; }
      if (!l.email) { toast("This lead has no email address — add one on ✎ Edit", { type: "warn" }); return; }
      MW.mailChooser(anchor, l.email, { subject: l.company + " — " + tplOf().l, body: text,
        onOpen: () => {
          l.activities = l.activities || [];
          l.activities.push({ date: todayISO(), type: "Email", note: trim(text, 140), by: l.owner || "Sales Desk" });
          if (l.stage !== "Won" && l.stage !== "Lost") l.nextFollowUp = DB.helpers.daysAhead(3);
          mo.close();
          toast("Email opened — logged on " + l.company, { type: "ok" });
          App.saveDelta(() => DB.leads.update(l.id, { activities: l.activities, nextFollowUp: l.nextFollowUp }));
          leadDetail(l.id);
        } });
    }
  }
  /* tiny text prompt built on the modal system */
  /* ---- why a lead was lost ----
     This used to be a free-text box, so "Price too high", "price" and "rate
     issue" landed as three separate rows in the breakdown below and the report
     said nothing. The reason is now picked from a fixed list; the free text
     survives as a note beside it, and the competitor gets a field of its own
     because "we lose to one firm, always on price" is the finding worth having.
     Historic free-text reasons are mapped onto the list at read time by
     normaliseReason() so old leads still group. */
  function lostForm(l) {
    return new Promise((res) => {
      let picked = LOST_REASONS.includes(l.lostReason) ? l.lostReason : "";
      const chips = h("div", { class: "flex wrap gap", style: "margin-bottom:4px" },
        LOST_REASONS.map((r) => {
          const b = h("button", { class: "btn sm" + (picked === r ? " primary" : ""), text: r,
            onclick: () => {
              picked = r;
              [...chips.children].forEach((c) => c.classList.remove("primary"));
              b.classList.add("primary");
            } });
          return b;
        }));
      const body = h("div", { class: "form-grid" }, [
        field("Reason *", chips, "full"),
        field("Lost to (optional)", `<input class="input" id="lz_to" value="${esc(l.lostTo || "")}" placeholder="Competitor or existing supplier">`),
        field("Their price (optional)", `<input class="input" id="lz_note" value="${esc(l.lostNote || "")}" placeholder="e.g. ₹9.80/m against our ₹11.20">`),
      ]);
      const mo = modal({ title: "Why was this lost?", sub: l.company + " · " + money(l.value || 0), body,
        foot: [
          h("button", { class: "btn ghost", onclick: () => { mo.close(); res(null); }, text: "Cancel" }),
          h("button", { class: "btn danger", text: "Mark Lost", onclick: () => {
            if (!picked) { toast("Pick a reason", { type: "warn" }); return; }
            mo.close();
            res({ lostReason: picked, lostTo: UI.$("#lz_to").value.trim(), lostNote: UI.$("#lz_note").value.trim() });
          } }),
        ] });
    });
  }

  function promptText(title, ph) {
    return new Promise((res) => {
      const body = h("div", {}, [h("textarea", { class: "input", id: "pt_in", placeholder: ph || "" })]);
      const mo = modal({ title, body,
        foot: [
          h("button", { class: "btn ghost", onclick: () => { mo.close(); res(null); }, text: "Cancel" }),
          h("button", { class: "btn primary", onclick: () => { const v = UI.$("#pt_in").value.trim(); mo.close(); res(v); }, text: "OK" }),
        ] });
    });
  }

  // register the ⌘K quick action for CRM
  window.ERPActions = Object.assign(window.ERPActions || {}, {
    newLead: { mod: "crm", create: true, ic: "🎯", label: "New Lead", run: () => App.go("crm", { openNew: true }) },
    samplesOut: { ic: "📦", label: "Samples out — every reel that has gone out", run: () => App.go("quotations", { tab: "samples" }) },
  });
})();
