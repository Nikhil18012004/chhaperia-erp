/* ============================================================
   CHHAPERIA ERP — TDS BROCHURE (Technical Data Sheets)

   The compiled TDS booklet for everything the company produces
   and supplies, read INSIDE the app: it opens in the working
   area with the menu still on the left, not in a browser tab.

   Deliberately NOT in UI.NAV, so it adds no icon and no menu
   entry. It is reached only by searching for it (⌘K / the search
   box) — the action registered at the bottom of this file is what
   puts it in the results. App.canAccess() allows any module that
   has no nav entry, so App.go("tds") works from there.
   ============================================================ */
(function () {
  "use strict";
  const { h, esc, toast } = UI;
  const { pageHead } = MW;

  const DOC = "assets/docs/tds-brochure.pdf";
  const TITLE = "Technical Data Sheets";

  M.tds = { title: TITLE, sub: "Product TDS booklet", render(root) {
    root.appendChild(pageHead(TITLE,
      "The compiled technical data sheets for the products we manufacture and supply.", [
        h("a", { class: "btn", href: DOC, target: "_blank", rel: "noopener",
          title: "Open the booklet in its own browser tab", text: "Open in new tab" }),
        h("a", { class: "btn primary", href: DOC, download: "Chhaperia — Technical Data Sheets.pdf",
          title: "Save a copy", text: "Download" }),
      ]));

    /* The viewer fills whatever height the working area has left, so the
       booklet is read in place rather than in a letterbox. */
    const frame = h("iframe", { class: "doc-frame", src: DOC + "#view=FitH",
      title: TITLE, loading: "lazy" });
    const shell = h("div", { class: "doc-shell" }, [frame]);
    root.appendChild(shell);

    /* A missing file would otherwise show as a silent blank panel — say so,
       and keep the page usable. */
    fetch(DOC, { method: "HEAD" }).then((r) => {
      if (r.ok) return;
      shell.innerHTML = "";
      shell.appendChild(h("div", { class: "empty", style: "padding:60px 20px" }, [
        h("div", { class: "big", text: "📄" }),
        h("div", { style: "font-weight:700", text: "The TDS booklet is not on the server" }),
        h("div", { class: "muted", style: "margin-top:6px",
          text: "Expected at " + DOC + " — re-upload it and refresh." }),
      ]));
    }).catch(() => { /* offline: let the frame try on its own */ });
  }};

  /* The ONLY way in: searching. No icon — but the palette substitutes "⚡"
     for an EMPTY ic, so this carries a blank space instead of "". The label
     holds the words someone would actually type, because the search matches
     on the label alone. */
  window.ERPActions = Object.assign(window.ERPActions || {}, {
    tds: { ic: " ", label: "TDS — Technical Data Sheets (product brochure)",
      run: () => App.go("tds") },
  });
})();
