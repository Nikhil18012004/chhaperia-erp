/* ============================================================
   CHHAPERIA ERP — LABEL STUDIO   (Inventory ▸ Label Studio)

   A PLACEHOLDER, deliberately. The menu entry exists so the
   section has somewhere to live; what goes inside it has not
   been specified yet.

   NOTE FOR WHOEVER FILLS THIS IN: printing labels for a purchase
   order is NOT it. That stayed where it has always been — the
   🏷 Labels button inside a purchase order (Procurement ▸ open a
   PO ▸ Labels, `stickersPO` in mod-trade.js). A screen was built
   here that listed every ordered product and the user reversed
   it: labels are printed from the order they belong to, and the
   printer icon belongs to an individual label, not to a menu.
   Build the NEW thing here; do not move the PO wizard back.
   ============================================================ */
(function () {
  "use strict";
  const {h} = UI;
  const {pageHead} = MW;

  M["label-studio"] = { title:"Label Studio", sub:"Label design & templates", render(root){
    root.appendChild(pageHead("Label Studio",
      "Design and manage label templates",[]));
    /* An honest empty state rather than a blank page: a screen that renders
       nothing reads as broken, and someone would file it as a bug. */
    root.appendChild(h("div",{class:"empty"},[
      h("div",{class:"big","aria-hidden":"true",text:"🖨️"}),
      h("div",{text:"Nothing here yet."}),
      /* .empty only sets text-align:center, so a width-capped block needs its
         own auto margins or it hangs off to the left of the icon above it */
      h("div",{class:"muted",style:"font-size:12.5px;margin:8px auto 0;line-height:1.7;max-width:520px",
        html:"This section is reserved for what is being added next.<br>"+
             "To print labels for a purchase order, open the order in "+
             "<b>Procurement</b> and press <b>🏷 Labels</b>."}),
    ]));
  }};
})(window);
