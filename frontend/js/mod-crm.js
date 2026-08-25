/* ============================================================
   CHHAPERIA ERP — CRM PIPELINE MODULE  (frontend / presentation)
   A simple, efficient B2B sales CRM:
     • KPI strip  (open leads, weighted pipeline, win rate, won value)
     • Follow-up reminders (due today / overdue)
     • Pipedrive-style pipeline board (New→Contacted→Quoted→Won/Lost)
     • Lead detail drawer: info, activity timeline, log activity,
       move stage, edit, convert-to-customer
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
  const ACT_TYPES = ["Call", "Email", "Meeting", "Sample Sent", "Quotation Sent", "Site Visit", "Note"];
  // how a sample lands once the customer has run it — drives the next move
  const SAMPLE_VERDICTS = ["Awaiting feedback", "Approved", "Rejected", "Rework needed"];
  const SOURCES = ["Exhibition (Wire India)", "Website Enquiry", "Referral", "Cold Call", "Existing Customer", "Trade Directory"];
  /* A fixed list, so the lost-reason breakdown can actually add up. */
  const LOST_REASONS = ["Price", "Lead time", "Quality / spec", "No response", "Budget dropped", "Existing supplier", "Other"];
  /* Leads closed before the list existed carry free text. Fold the common
     phrasings onto the list at READ time — the stored value is never rewritten,
     so nothing is lost if this mapping is ever wrong. */
  function normaliseReason(raw) {
    const s = String(raw || "").trim();
    if (!s) return "Not specified";
    if (LOST_REASONS.includes(s)) return s;
    const t = s.toLowerCase();
    if (/price|cost|rate|expensive|costly/.test(t)) return "Price";
    if (/lead ?time|deliver|late|schedule/.test(t)) return "Lead time";
    if (/qualit|spec|reject|fail|sample/.test(t)) return "Quality / spec";
    if (/no response|not respond|silent|unreach|no reply/.test(t)) return "No response";
    if (/budget|postpon|defer|hold/.test(t)) return "Budget dropped";
    if (/existing|already|current supplier|loyal/.test(t)) return "Existing supplier";
    return "Other";
  }
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

      l.sample ? sampleBlock(l) : null,

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
    let cust = ENG.data.customers.find((c) => c.name.toLowerCase() === (l.company || "").toLowerCase());
    let createdCustomer = false;
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
      createdCustomer = true;
    }
    l.customerId = cust.id;

    // 2) ask whether to raise a Sales Order from this won lead
    UI.$("#modalHost").hidden = true;
    const makeSO = await confirm(
      `🏆 ${l.company} marked WON!\n\n` +
      (createdCustomer ? `• New customer "${cust.name}" added to your customer list.\n` : `• Linked to existing customer ${cust.name}.\n`) +
      `\nRaise a Sales Order now for ${l.productName || l.product}?\n` +
      `This pushes the deal into your order book → production → dispatch.`,
      { title: "Convert Won lead to order?" });

    if (makeSO) {
      const fg = ENG.item(l.product);
      const price = (fg && fg.price) || 0;
      // derive a sensible quantity from the deal value (value ÷ unit price);
      // always carry at least one line so the granular SO endpoint accepts it
      const qty = price > 0 ? Math.max(1, Math.round((l.value || 0) / price)) : 1;
      const rate = price || (l.value || 0);
      const so = {
        id: window._erpUtil.nextSeqId(ENG.data.salesorders, "SO-"),
        date: DB.helpers.iso(DB.helpers.today()),
        customerId: cust.id,
        // no invented width: it is set from the work order the line is filled
        // from, and until then the invoice simply prints the thickness
        lines: [{ itemId: l.product, qty, rate, width: (fg && fg.widthMM ? fg.widthMM[0] : null) }],
        status: "Confirmed",
        promised: DB.helpers.daysAhead(14),
        priority: "Normal",
        value: l.value || 0,
        fromLead: l.id, // traceability back to the CRM lead
      };
      ENG.data.salesorders.push(so);
      l.salesOrderId = so.id; // traceability forward to the order
      toast(`${so.id} created from ${l.company}`, { type: "ok", title: "Lead converted to order" });
      App.saveDelta(async () => {
        if (createdCustomer) await DB.customers.upsert(cust);
        await DB.sales.create(so);
        await DB.leads.update(l.id, { stage: "Won", customerId: cust.id, salesOrderId: so.id, nextFollowUp: null });
      });
      App.go("sales");
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

    const body = h("div", { class: "form-grid" }, [
      field("Sample Product *", selectHTML("s_product",
        fgs.map((i) => ({ v: i.id, l: i.name + (i.thicknessMM != null ? " · " + i.thicknessMM + " mm" : "") + " — " + (i.typeCode || i.id) })),
        chosen)),
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

    // the unit belongs to the product, so it follows the product picker
    const prodSel = UI.$("#s_product");
    if (prodSel) prodSel.onchange = () => { const u = UI.$("#s_uom"); if (u) u.textContent = uomOf(prodSel.value); };

    function save() {
      const pid = UI.$("#s_product").value;
      const fg = ENG.item(pid) || {};
      const sentDate = UI.$("#s_sent").value || todayISO();
      const sample = {
        product: pid, productName: fg.name || "", qty: +UI.$("#s_qty").value || 0,
        uom: fg.uom || "kg", sentDate,
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
            + (sample.courier ? " · via " + sample.courier : "")
            + (sample.awb ? " (" + sample.awb + ")" : ""),
          by: l.owner || "Sales Desk" });
      }
      mo.close();
      toast(first ? l.company + " → Sample" : "Sample details updated", { type: "ok" });
      App.saveDelta(() => DB.leads.update(l.id, { stage: "Sample", sample,
        nextFollowUp: l.nextFollowUp, activities: l.activities }));
      App.go("crm");
    }
  }

  /* the sample card inside the lead drawer — what went out and how it landed */
  function sampleBlock(l) {
    const s = l.sample;
    const tone = { Approved: "ok", Rejected: "danger", "Rework needed": "warn" }[s.verdict] || "info";
    const age = sampleAge(l);
    const open = !s.verdict || s.verdict === "Awaiting feedback";
    return h("div", { class: "card", style: "margin-top:14px;box-shadow:none;background:var(--panel-2)" }, [
      h("div", { class: "flex between aic wrap gap", style: "margin-bottom:8px" }, [
        h("div", { class: "muted", style: "font-size:11px;font-weight:700;text-transform:uppercase", text: "📦 Sample Despatch" }),
        h("div", { class: "flex aic gap" }, [
          // an open sample carries its age, because "how long has this been
          // out?" is the question the chasing call actually turns on
          (age != null && open) ? h("span", { html: badge(ageTone(age), age + (age === 1 ? " day out" : " days out")) }) : null,
          h("span", { html: badge(tone, s.verdict || "Awaiting feedback") }),
          h("button", { class: "btn sm ghost", onclick: () => sampleForm(l), text: "✎ Update" }),
        ].filter(Boolean)),
      ]),
      MW.dl([
        ["Product", s.productName || s.product || "—"],
        ["Quantity", s.qty ? ENG.num(s.qty) + " " + (s.uom || "kg") : "—"],
        ["Sent On", (s.sentDate || "—") + (age != null ? "  ·  " + age + (age === 1 ? " day ago" : " days ago") : "")],
        ["Courier", s.courier || "—"],
        ["Docket / AWB", s.awb || "—"],
      ]),
      s.note ? h("div", { style: "font-size:13px;line-height:1.5;margin-top:10px", text: s.note }) : null,
    ]);
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
    if (!due.length && !staleSamples.length) {
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
    if (staleSamples.length) tally.push(h("span", { class: "crm-delta down", text: staleSamples.length + " sample" + (staleSamples.length === 1 ? "" : "s") + " silent" }));

    return h("div", { class: "card crm-fu" }, [
      h("div", { class: "crm-fu-head" }, [
        h("div", { class: "crm-fu-ic", text: "⏰" }),
        h("div", {}, [
          h("div", { class: "crm-fu-title", text: "Chase these first" }),
          h("div", { class: "crm-fu-sub", text: (due.length + staleSamples.length) + " thing"
            + (due.length + staleSamples.length === 1 ? " is" : "s are") + " waiting on you" }),
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
        ])))),
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
    return { Call: "📞", Email: "✉️", Meeting: "🤝", "Sample Sent": "📦", "Quotation Sent": "📄", "Site Visit": "🏭", Note: "📝" }[t] || "•";
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
  });
})();
