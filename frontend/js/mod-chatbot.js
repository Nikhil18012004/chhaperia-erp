/* ============================================================
   CHHAPERIA ERP — CHATBOT WIDGET (bottom-right, every role)
   A floating assistant that answers from the LIVE dataset:
   every question is answered server-side at ask-time through the
   asker's own role-filtered view, and a minute-tick refresh keeps
   the header stats current even while idle.
   Mounted on document.body (NOT #view — that container is wiped
   by navigation and the 15s auto-refresh). CHAT.mount(user) is
   called from App.boot for every role incl. supervisors; login
   screens call CHAT.unmount().
   Admin/office also get a ⚙ Train tab: paste or upload Q&A
   (JSON / CSV) into the knowledge base the bot answers from.
   ============================================================ */
(function (global) {
  "use strict";

  const CHAT = {};
  let root = null, user = null, open = false, tab = "chat", busy = false;
  let pollTimer = null, log = [];   // {who:"me"|"bot", text, src?} — session only

  const POLL_MS = 60 * 1000;        // "each and every minute" — live stats refresh
  const h = (...a) => UI.h(...a);

  const canTrain = () => user && (user.role === "admin" || user.role === "office");
  const hhmm = (iso) => { try { const d = iso ? new Date(iso) : new Date(); return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); } catch { return ""; } };

  const CHIPS = {
    supervisor: ["My jobs", "Low stock", "Pending lab tests", "Help"],
    lab: ["Pending lab tests", "Production today", "Stock", "Help"],
    office: ["Low stock", "Production today", "Open sales orders", "Purchase orders pending"],
    admin: ["Low stock", "Production today", "Open sales orders", "Help"],
  };

  /* ---------------- mount / unmount ---------------- */
  CHAT.mount = function (me) {
    CHAT.unmount();
    user = me;
    root = h("div", { class: "chat-widget", id: "chatWidget" }, [
      buildPanel(),
      h("button", {
        class: "chat-fab", id: "chatFab", "aria-label": "Open ERP assistant",
        title: "ERP Assistant", onclick: toggle,
      }, [h("span", { class: "chat-fab-ic", text: "💬" })]),
    ]);
    document.body.appendChild(root);
    document.addEventListener("keydown", onKey);
    startPoll();
  };

  CHAT.unmount = function () {
    stopPoll();
    document.removeEventListener("keydown", onKey);
    if (root) root.remove();
    root = null; user = null; open = false; tab = "chat"; log = [];
  };

  /* Escape belongs to whatever is stacked ON TOP of us. A confirm dialog or the
     command palette opens above the panel; closing those used to slam the whole
     assistant shut as well, dumping the user out of the Train tab. */
  function onKey(e) {
    if (e.key !== "Escape" || !open) return;
    const mh = document.querySelector("#modalHost"); if (mh && !mh.hidden) return;
    const ck = document.querySelector("#cmdk"); if (ck && !ck.hidden) return;
    toggle(false);
  }

  /* ---------------- live minute refresh ---------------- */
  function startPoll() {
    stopPoll();
    refreshSnapshot();
    pollTimer = setInterval(() => {
      if (!root || !root.isConnected) { stopPoll(); return; }   // self-cleanup
      if (document.hidden) return;
      refreshSnapshot();
    }, POLL_MS);
  }
  function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

  async function refreshSnapshot() {
    try {
      const s = await DB.chat.snapshot();
      const stamp = root && root.querySelector("#chatLive");
      if (stamp) stamp.textContent = "Live · " + hhmm(s.asOf);
      const facts = root && root.querySelector("#chatFacts");
      if (facts) {
        facts.innerHTML = "";
        (s.facts || []).forEach((f) => facts.appendChild(
          h("span", { class: "chat-fact" }, [h("b", { text: String(f.v) }), " " + f.k])));
      }
    } catch (e) { /* transient blip — the next minute tick retries */ }
  }

  /* ---------------- panel ---------------- */
  function buildPanel() {
    const panel = h("div", { class: "chat-panel", id: "chatPanel", hidden: "hidden", role: "dialog", "aria-label": "ERP assistant" }, [
      h("div", { class: "chat-head" }, [
        h("div", {}, [
          h("div", { class: "chat-title", text: "ERP Assistant" }),
          h("div", { class: "chat-sub" }, [h("span", { class: "chat-dot" }), h("span", { id: "chatLive", text: "Live" })]),
        ]),
        canTrain() ? h("button", { class: "icon-btn chat-tab-btn", title: "Train the assistant", "aria-label": "Train the assistant", onclick: () => switchTab(tab === "train" ? "chat" : "train"), text: "⚙" }) : null,
        h("button", { class: "icon-btn", "aria-label": "Close assistant", onclick: () => toggle(false), text: "✕" }),
      ]),
      h("div", { class: "chat-facts", id: "chatFacts" }),
      h("div", { class: "chat-body", id: "chatBody" }),
    ]);
    return panel;
  }

  function toggle(force) {
    open = force != null ? !!force : !open;
    const panel = root.querySelector("#chatPanel");
    const fab = root.querySelector("#chatFab");
    panel.hidden = !open;
    fab.classList.toggle("open", open);
    if (open) { switchTab("chat"); refreshSnapshot(); }
  }

  function switchTab(t) {
    tab = t;
    const body = root.querySelector("#chatBody");
    body.innerHTML = "";
    if (t === "train") drawTrain(body); else drawChat(body);
  }

  /* ---------------- chat tab ---------------- */
  function drawChat(body) {
    const msgs = h("div", { class: "chat-msgs", id: "chatMsgs" });
    if (!log.length) {
      log.push({ who: "bot", text: "Hi " + ((user && user.name) || "") + "! Ask me about stock, production, orders or lab work — I read the live data every time you ask." });
    }
    log.forEach((m) => msgs.appendChild(bubble(m)));

    const chips = h("div", { class: "chat-chips" },
      (CHIPS[user && user.role] || CHIPS.admin).map((c) =>
        h("button", { class: "chat-chip", type: "button", text: c, onclick: () => send(c) })));

    const input = h("input", { class: "input chat-input", type: "text", placeholder: "Ask about stock, orders, jobs…", "aria-label": "Ask the assistant" });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); send(input.value); input.value = ""; } });
    const form = h("div", { class: "chat-form" }, [
      input,
      h("button", { class: "btn primary sm", type: "button", text: "Send", onclick: () => { send(input.value); input.value = ""; input.focus(); } }),
    ]);

    body.appendChild(msgs); body.appendChild(chips); body.appendChild(form);
    scrollDown();
    setTimeout(() => { try { input.focus(); } catch {} }, 60);
  }

  function bubble(m) {
    return h("div", { class: "chat-msg " + (m.who === "me" ? "me" : "bot") }, [
      h("div", { class: "chat-bubble", text: m.text }),
      m.src === "kb" ? h("div", { class: "chat-src", text: "from training" }) : null,
    ]);
  }

  function scrollDown() {
    const msgs = root && root.querySelector("#chatMsgs");
    if (msgs) msgs.scrollTop = msgs.scrollHeight;
  }

  /* Land the reply even if the body was redrawn while it was in flight (a tab
     switch, or close-and-reopen). The typing bubble is detached by that redraw,
     and replaceWith() on a detached node is a silent no-op — the answer used to
     vanish until the next redraw replayed the log, so it looked as though the
     bot had answered a question nobody asked. */
  function settle(typing, m) {
    if (typing && typing.isConnected) { typing.replaceWith(bubble(m)); return; }
    const msgs = root && root.querySelector("#chatMsgs");
    if (msgs) { msgs.appendChild(bubble(m)); }
  }

  async function send(text) {
    text = String(text || "").trim();
    if (!text || busy) return;
    const msgs = root.querySelector("#chatMsgs");
    if (!msgs) return;
    log.push({ who: "me", text });
    msgs.appendChild(bubble({ who: "me", text }));
    const typing = h("div", { class: "chat-msg bot" }, [h("div", { class: "chat-bubble chat-typing" }, [h("i"), h("i"), h("i")])]);
    msgs.appendChild(typing); scrollDown();
    busy = true;
    try {
      const r = await DB.chat.ask(text);
      const m = { who: "bot", text: r.answer, src: r.source };
      log.push(m);
      settle(typing, m);
      const stamp = root && root.querySelector("#chatLive");
      if (stamp && r.asOf) stamp.textContent = "Live · " + hhmm(r.asOf);
    } catch (e) {
      const m = { who: "bot", text: "⚠ " + (e.message || "Something went wrong — try again.") };
      log.push(m);
      settle(typing, m);
    } finally { busy = false; scrollDown(); }
  }

  /* ---------------- train tab (admin/office) ---------------- */
  function drawTrain(body) {
    const list = h("div", { class: "chat-kb-list", id: "chatKbList" }, [h("div", { class: "chat-kb-empty", text: "Loading…" })]);

    const ta = h("textarea", { class: "input chat-kb-ta", rows: "5", placeholder: 'Paste training data:\n• JSON  [{"question":"…","answer":"…","keywords":"a,b"}]\n• CSV   question,answer,keywords\n• or one per line:  question | answer' });
    const file = h("input", { type: "file", accept: ".json,.csv,.txt", class: "chat-kb-file", "aria-label": "Upload training file" });
    file.addEventListener("change", () => {
      const f = file.files && file.files[0];
      if (!f) return;
      const rd = new FileReader();
      rd.onload = () => { ta.value = String(rd.result || ""); };
      rd.readAsText(f);
    });

    const upload = h("button", {
      class: "btn primary sm", type: "button", text: "Add to training",
      onclick: async () => {
        let entries;
        try { entries = parseTraining(ta.value); }
        catch (e) { UI.toast(e.message, { type: "danger", title: "Can't read that" }); return; }
        if (!entries.length) { UI.toast("Nothing to add — paste Q&A first.", { type: "warn" }); return; }
        try {
          const r = await DB.chat.knowledge.add(entries);
          UI.toast("Trained " + r.added + " answer(s).", { type: "ok", title: "Assistant updated" });
          ta.value = ""; file.value = "";
          loadKb();
        } catch (e) { UI.toast(e.message || "Upload failed", { type: "danger" }); }
      },
    });

    body.appendChild(h("div", { class: "chat-kb" }, [
      h("div", { class: "chat-kb-head", text: "Teach the assistant" }),
      h("div", { class: "chat-kb-hint", text: "Trained answers are matched to questions by wording and keywords, and win over live-data answers when the match is close. Training survives demo resets." }),
      ta,
      h("div", { class: "chat-kb-row" }, [file, upload]),
      h("div", { class: "chat-kb-head", text: "Current training" }),
      list,
    ]));
    loadKb();

    async function loadKb() {
      try {
        const rows = await DB.chat.knowledge.list();
        list.innerHTML = "";
        if (!rows.length) { list.appendChild(h("div", { class: "chat-kb-empty", text: "No training yet — the bot answers from live ERP data only." })); return; }
        rows.forEach((k) => list.appendChild(h("div", { class: "chat-kb-item" }, [
          h("div", { class: "chat-kb-q" }, [
            h("div", { class: "q", text: k.question }),
            h("div", { class: "a", text: k.answer }),
            (k.keywords || []).length ? h("div", { class: "kw", text: "keywords: " + k.keywords.join(", ") }) : null,
          ]),
          h("button", {
            class: "icon-btn", "aria-label": "Delete training entry", text: "🗑",
            onclick: async () => {
              if (!(await UI.confirm("Delete this trained answer?", { title: "Remove training" }))) return;
              try { await DB.chat.knowledge.remove(k.id); loadKb(); }
              catch (e) { UI.toast(e.message || "Delete failed", { type: "danger" }); }
            },
          }),
        ])));
      } catch (e) {
        list.innerHTML = "";
        list.appendChild(h("div", { class: "chat-kb-empty", text: "Couldn't load training: " + (e.message || "error") }));
      }
    }
  }

  /* Accepts JSON array, CSV with a question,answer[,keywords] header, or
     "question | answer" lines. Returns [{question,answer,keywords}]. */
  function parseTraining(text) {
    text = String(text || "").trim();
    if (!text) return [];
    if (text[0] === "[" || text[0] === "{") {
      let j;
      try { j = JSON.parse(text); } catch { throw new Error("That JSON doesn't parse — check for a missing bracket or comma."); }
      const arr = Array.isArray(j) ? j : [j];
      return arr.map((e) => ({ question: e.question, answer: e.answer, keywords: e.keywords, tags: e.tags }));
    }
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    // pipe format: question | answer
    if (lines.every((l) => l.includes("|"))) {
      return lines.map((l) => {
        const i = l.indexOf("|");
        return { question: l.slice(0, i).trim(), answer: l.slice(i + 1).trim() };
      });
    }
    // CSV with header — parsed off the WHOLE text, not line by line
    const rows = csvRows(text);
    if (!rows.length) return [];
    const head = rows[0].map((c) => c.toLowerCase().trim());
    const qi = head.indexOf("question"), ai = head.indexOf("answer"), ki = head.indexOf("keywords");
    if (qi < 0 || ai < 0) throw new Error('CSV needs a header row with "question" and "answer" columns.');
    return rows.slice(1).filter((r) => r.length > Math.max(qi, ai))
      .map((r) => ({ question: r[qi], answer: r[ai], keywords: ki >= 0 ? r[ki] : "" }));
  }
  /* A CSV field may legally contain commas AND newlines when it is quoted — which
     is exactly what Excel writes for a multi-step answer. Splitting the text into
     lines first cut those answers off at the first newline, and a continuation
     line containing a comma became its own junk entry, all under a success toast.
     So scan the whole text once and let the quote state decide what ends a row. */
  function csvRows(text) {
    const rows = []; let row = [], field = "", inQ = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQ) {
        if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
        else if (c === '"') inQ = false;
        else field += c;
      } else if (c === '"') inQ = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); field = ""; rows.push(row); row = []; }
      else if (c !== "\r") field += c;
    }
    row.push(field); rows.push(row);
    return rows.map((r) => r.map((s) => s.trim())).filter((r) => r.some((s) => s !== ""));
  }

  global.CHAT = CHAT;
})(window);
