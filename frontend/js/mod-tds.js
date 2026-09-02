/* ============================================================
   CHHAPERIA ERP — TECHNICAL DATA SHEETS (the TDS booklet)
   One page for every login: the compiled product data sheets,
   read inside the working area. The document comes from the
   server (GET /api/tds/file) — the bundled booklet until admin
   uploads a newer one, then that. Admin replaces it from here
   with a PDF or a Word document; a Word file is converted to a
   PDF where the server can (the plant laptop has Word), and is
   offered as a download either way.

   `static: true` — a background refresh never rebuilds this
   page: rebuilding it would reload the document and lose the
   reader's place in it.
   `searchOnly: true` — deliberately NOT in the menu (re-ruled
   2026-09-02): it is reached by searching (⌘K), the same way in
   every login — office, admin, lab, and the floor panel, which
   has its own search box for exactly this.
   ============================================================ */
(function () {
  "use strict";
  const { h, toast, modal } = UI;
  const { pageHead } = MW;

  const TITLE = "Technical Data Sheets";
  const FILE = "/api/tds/file";

  M.tds = { title: TITLE, sub: "Product TDS booklet", static: true, searchOnly: true, render(root) {
    const admin = !!(window.App && App.isAdmin && App.isAdmin());
    const actions = [
      h("a", { class: "btn", href: FILE, target: "_blank", rel: "noopener", title: "Open the booklet in its own tab", text: "Open in new tab" }),
      h("a", { class: "btn primary", href: FILE + "?dl=1", title: "Save a copy of the booklet", text: "Download" }),
    ];
    // replacing the booklet is admin's alone — the server enforces it too
    if (admin) actions.unshift(h("button", { class: "btn", onclick: () => updateForm(load), html: "⬆ Update TDS" }));
    root.appendChild(pageHead(TITLE,
      "The compiled technical data sheets for the products we manufacture and supply.", actions));

    const meta = h("div", { class: "muted", style: "font-size:12px;margin:-6px 0 12px" });
    const shell = h("div", { class: "doc-shell" });
    root.appendChild(meta);
    root.appendChild(shell);

    function paint(info) {
      const when = info.updatedAt ? String(info.updatedAt).slice(0, 10) : "";
      meta.textContent = info.source === "uploaded"
        ? (info.name || "TDS") + " · updated " + when + (info.updatedBy ? " by " + info.updatedBy : "")
          + (info.kind !== "pdf" ? (info.converted ? " · Word document, shown as PDF" : " · Word document") : "")
        : "Bundled booklet" + (when ? " · " + when : "");
      shell.innerHTML = "";
      if (!info.present) {
        shell.appendChild(h("div", { class: "empty", style: "padding:60px 20px" }, [
          h("div", { class: "big", text: "📄" }),
          h("div", { style: "font-weight:700", text: "The TDS booklet is not on the server" }),
          h("div", { class: "muted", style: "margin-top:6px;font-size:13px", text: admin ? "Upload it with Update TDS." : "Ask the admin to upload it." }),
        ]));
        return;
      }
      if (info.viewable) {
        // the version rides in the query so a replaced booklet is never read from cache
        shell.appendChild(h("iframe", { class: "doc-frame", src: FILE + "?v=" + encodeURIComponent(info.updatedAt || "") + "#view=FitH", title: TITLE }));
        return;
      }
      shell.appendChild(h("div", { class: "empty", style: "padding:60px 20px" }, [
        h("div", { class: "big", text: "📄" }),
        h("div", { style: "font-weight:700", text: "The TDS is a Word document" }),
        h("div", { class: "muted", style: "margin-top:6px;font-size:13px", text: info.convertError
          ? "It could not be converted to a PDF on this server (" + info.convertError + "), so it cannot be shown here — download it to read it."
          : "Download it to read it." }),
        h("div", { style: "margin-top:14px" }, h("a", { class: "btn primary", href: FILE + "?dl=1", text: "Download " + (info.name || "TDS") })),
      ]));
    }
    async function load() {
      try { paint(await DB.tds.info()); }
      catch (err) { shell.innerHTML = ""; shell.appendChild(MW.loadError("the TDS booklet", err, load)); }
    }
    load();
  }};

  /* Admin's upload: pick a PDF or Word document, it travels base64 in a JSON
     body (the way every file reaches this server), and the page reloads the
     viewer from what the server now holds. */
  function updateForm(after) {
    const file = h("input", { class: "input", type: "file", accept: ".pdf,.docx,.doc,application/pdf" });
    const note = h("div", { class: "muted", style: "font-size:12px;margin-top:8px" });
    const go = h("button", { class: "btn primary", text: "Upload and publish", onclick: async () => {
      const f = file.files && file.files[0];
      if (!f) { toast("Choose a PDF or Word document first", { type: "warn" }); return; }
      if (f.size > 40 * 1024 * 1024) { toast("That file is larger than 40 MB", { type: "warn" }); return; }
      go.disabled = true; go.textContent = "Uploading…";
      try {
        const data = await new Promise((res, rej) => {
          const rd = new FileReader();
          rd.onload = () => res(String(rd.result).replace(/^data:[^,]*,/, ""));
          rd.onerror = () => rej(new Error("Could not read the file"));
          rd.readAsDataURL(f);
        });
        const info = await DB.tds.put(f.name, data);
        mo.close();
        if (info.kind !== "pdf" && !info.converted) {
          toast("Published as a Word document — it could not be converted to a PDF here"
            + (info.convertError ? " (" + info.convertError + ")" : "") + ", so readers will download it.",
            { type: "warn", title: "TDS updated", dur: 9000 });
        } else toast("The TDS booklet is updated for every login", { type: "ok", title: "TDS updated" });
        if (after) after();
      } catch (err) {
        toast(err.message || "Upload failed", { type: "danger" });
        go.disabled = false; go.textContent = "Upload and publish";
      }
    } });
    const restore = h("button", { class: "btn ghost", text: "Restore the bundled booklet", onclick: async () => {
      if (!await UI.confirm("Put the booklet that ships with the ERP back in place of the uploaded one?", { title: "Restore bundled TDS" })) return;
      try { await DB.tds.reset(); mo.close(); toast("The bundled booklet is back", { type: "ok" }); if (after) after(); }
      catch (err) { toast(err.message || "Could not restore", { type: "danger" }); }
    } });
    const mo = modal({ title: "⬆ Update the TDS booklet", sub: "Replaces the booklet for every login",
      body: h("div", {}, [
        h("div", { class: "field full" }, [h("label", { text: "New booklet (PDF or Word)" }), file]),
        h("div", { class: "muted", style: "font-size:12px;margin-top:8px", html:
          "A <b>PDF</b> is shown in the page as it is. A <b>Word</b> document is converted to a PDF on the server where Word is installed; "
          + "if it cannot be, it is offered as a download. Up to 40 MB." }),
        note,
      ]),
      foot: [h("button", { class: "btn ghost", onclick: () => mo.close(), text: "Cancel" }), restore, go] });
  }

  /* The way in: searching. Actions are listed for every login, and the page
     itself admits every login (App.canAccess honours searchOnly). */
  window.ERPActions = Object.assign(window.ERPActions || {}, {
    tds: { ic: "📘", label: "TDS — Technical Data Sheets (product brochure)", run: () => App.go("tds") },
  });
})();
