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

  /* ============================================================
     WHAT A LABEL MAY READ OUT OF THE ERP

     This is the whole of the ERP's knowledge in the label designer.
     labelstudio.js deliberately knows nothing about tapes, work
     orders or suppliers — it knows that a field may carry a binding
     like "product.name", and it asks this for the list and for the
     record. Everything plant-specific is here, on purpose: the
     designer stays a designer, and a new bindable field is one line
     in this file rather than a change to the canvas.

     ⚠ THE LEAF NAMES BELOW ARE THE CONTRACT. `record()` returns a
     FLAT object whose keys are exactly the leaves advertised in
     `groups()`. It is not the raw ERP row — a work order stores
     `itemId`, and a label wants the product's NAME — so the mapping
     is done once, here, and a saved template keeps working when the
     row underneath it changes shape.

     A binding is stored as a string in the template. Renaming a leaf
     silently breaks every saved label that used it; add rather than
     rename.
     ============================================================ */
  const D = () => (window.ENG && ENG.data) || {};
  const s = (v) => (v == null || v === "") ? "" : String(v);
  const itemById = (id) => (D().items || []).find(i => i.id === id) || null;

  /* mm values are stored as bare numbers; a label wants the unit on it */
  const mm = (v) => (v == null || v === "" || isNaN(+v)) ? "" : (+v) + " mm";
  const dmy = (iso) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s(iso));
    return m ? (m[3] + "." + m[2] + "." + m[1]) : s(iso);
  };

  const GROUPS = [
    {
      root: "product", label: "Product",
      /* every stock item — a label is printed for raw material as often
         as for finished goods, so this is not filtered to one category */
      list: () => (D().items || []).map(i => ({ id: i.id, label: i.name + "  ·  " + i.id })),
      of: (id) => {
        const i = itemById(id); if (!i) return null;
        return {
          name: s(i.name), code: s(i.id), grade: s(i.grade), category: s(i.cat),
          uom: s(i.uom), hsn: s(i.hsn),
          width: mm(i.width != null && i.width !== "" ? i.width : i.tapeWidthMM),
          length: s(i.length), thickness: mm(i.thicknessMM != null ? i.thicknessMM : i.thickness),
          gsm: s(i.gsm), fabric: s(i.fabric),
        };
      },
      fields: [
        { v: "product.name",      l: "Name",            ex: "PVC Electrical Tape" },
        { v: "product.code",      l: "Code",            ex: "FG-TAPE-18" },
        { v: "product.grade",     l: "Grade",           ex: "A" },
        { v: "product.category",  l: "Category",        ex: "Finished Goods" },
        { v: "product.uom",       l: "Unit",            ex: "ROLL" },
        { v: "product.width",     l: "Width",           ex: "18 mm" },
        { v: "product.length",    l: "Roll length",     ex: "20" },
        { v: "product.thickness", l: "Thickness",       ex: "0.125 mm" },
        { v: "product.gsm",       l: "GSM",             ex: "60" },
        { v: "product.hsn",       l: "HSN code",        ex: "39191000" },
        { v: "product.fabric",    l: "Fabric",          ex: "Cotton" },
      ],
    },
    {
      root: "batch", label: "Batch / Work order",
      /* The plant's batch number IS the work order number — the same rule
         the GST invoice prints under "Batch No." */
      list: () => (D().workorders || []).map(w => {
        const i = itemById(w.itemId);
        return { id: w.id, label: w.id + "  ·  " + (i ? i.name : s(w.itemId)) };
      }),
      of: (id) => {
        const w = (D().workorders || []).find(x => x.id === id); if (!w) return null;
        const i = itemById(w.itemId);
        return {
          number: s(w.id), product: s(i && i.name), code: s(w.itemId),
          qty: s(w.qty), made: dmy(w.date), due: dmy(w.due),
          status: s(w.status), width: mm(w.widthMM), line: s(w.line),
          completed: s(w.completedQty),
        };
      },
      fields: [
        { v: "batch.number",    l: "Batch No.",          ex: "WO-0142" },
        { v: "batch.product",   l: "Product made",       ex: "PVC Electrical Tape" },
        { v: "batch.qty",       l: "Quantity ordered",   ex: "500" },
        { v: "batch.completed", l: "Quantity made",      ex: "500" },
        { v: "batch.made",      l: "Manufacturing date", ex: "17.08.2026" },
        { v: "batch.due",       l: "Due date",           ex: "24.08.2026" },
        { v: "batch.width",     l: "Width run",          ex: "18 mm" },
        { v: "batch.line",      l: "Line",               ex: "Line 2" },
        { v: "batch.status",    l: "Status",             ex: "Completed" },
      ],
    },
    {
      root: "supplier", label: "Supplier",
      list: () => (D().suppliers || []).map(x => ({ id: x.id, label: s(x.name) })),
      of: (id) => {
        const x = (D().suppliers || []).find(y => y.id === id); if (!x) return null;
        return { name: s(x.name), code: s(x.id), gstin: s(x.gst), email: s(x.email) };
      },
      fields: [
        { v: "supplier.name",  l: "Name",  ex: "Shree Polymers" },
        { v: "supplier.code",  l: "Code",  ex: "SUP-004" },
        { v: "supplier.gstin", l: "GSTIN", ex: "29AAICC5462H1ZE" },
      ],
    },
    {
      root: "customer", label: "Customer",
      list: () => (D().customers || []).map(x => ({ id: x.id, label: s(x.name) })),
      of: (id) => {
        const x = (D().customers || []).find(y => y.id === id); if (!x) return null;
        return { name: s(x.name), code: s(x.id), gstin: s(x.gst), email: s(x.email) };
      },
      fields: [
        { v: "customer.name",  l: "Name",  ex: "Bharat Cables Ltd" },
        { v: "customer.code",  l: "Code",  ex: "CUS-011" },
        { v: "customer.gstin", l: "GSTIN", ex: "29ABIPC4133H1ZV" },
      ],
    },
  ];

  const LABEL_DATA = {
    groups: () => GROUPS.map(g => ({ root: g.root, label: g.label, fields: g.fields })),
    records: (root) => {
      const g = GROUPS.find(x => x.root === root);
      if (!g) return [];
      try { return g.list().filter(r => r && r.id); } catch (e) { return []; }
    },
    record: (root, id) => {
      const g = GROUPS.find(x => x.root === root);
      if (!g || !id) return null;
      try { return g.of(id); } catch (e) { return null; }
    },
  };

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
    LabelStudio.mount(root,{data:LABEL_DATA});
  }};
})(window);
