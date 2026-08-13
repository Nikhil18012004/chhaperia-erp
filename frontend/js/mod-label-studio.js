/* ============================================================
   CHHAPERIA ERP — LABEL STUDIO   (Inventory ▸ Label Studio)

   The module is deliberately thin. Everything the designer does —
   the symbologies, the document model, the canvas, the print
   run — is in labelstudio.js, which is loaded before this file
   and exposes LabelStudio.mount(host). This is the ERP-side
   wrapper: the page head, and somewhere to put it.

   The section used to be an empty placeholder while the designer
   was a dialog opened from Procurement. The designer moved here;
   the button in Procurement is gone.
   ============================================================ */
(function () {
  "use strict";
  const {h} = UI;
  const {pageHead} = MW;

  M["label-studio"] = { title:"Label Studio", sub:"Design & print your own labels", render(root){
    root.appendChild(pageHead("Label Studio",
      "Design your own labels — text, barcodes, QR codes and pictures — and print them by the sheet or the roll",[]));

    /* Loaded as a separate <script>, so a stale cached index.html could in
       principle render this page against a version that has not got it. Say so
       plainly rather than throwing into an empty view. */
    if(!window.LabelStudio){
      root.appendChild(h("div",{class:"empty"},[
        h("div",{class:"big","aria-hidden":"true",text:"🖨️"}),
        h("div",{text:"The label designer did not load."}),
        h("div",{class:"muted",style:"font-size:12.5px;margin:8px auto 0;max-width:520px",
          text:"Refresh the page. If it keeps happening, the browser is holding an old copy of the app — clear the site's cache."}),
      ]));
      return;
    }
    LabelStudio.mount(root);
  }};
})(window);
