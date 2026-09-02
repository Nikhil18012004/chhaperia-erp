/* ============================================================
   CHHAPERIA ERP — PROCUREMENT, SALES, SUPPLIERS, CUSTOMERS
   Tally-style entry: the PO/SO forms capture every field the
   printed tax invoice needs (GST split, transport, batch nos),
   so nothing has to be re-keyed at billing time.
   ============================================================ */
(function () {
  "use strict";
  const {h, esc, table, badge, meter, toast, modal, confirm} = UI;
  const {pageHead, kpi} = MW;
  const U = window._erpUtil;

  /* ============== INVOICE COMPANY ENTITIES ==============
     Two billing entities (Cable Material / International) live in
     org.companies[]; a legacy org doc without them still prints. */
  function companies(){
    const org=ENG.data.org||{};
    if(org.companies&&org.companies.length) return org.companies;
    return [{ key:"CO", name:org.name||"", tagline:org.tagline||"", gstin:org.gst||"",
      pan:org.pan||"", cin:org.cin||"", address:org.address||"",
      stateCode:GST.stateFromGSTIN(org.gst)||"29", phone:org.phone||"", email:org.email||"",
      website:org.website||"", bank:{}, terms:[] }];
  }
  function companyByKey(k){ const cs=companies(); return cs.find(c=>c.key===k)||cs[0]; }
  // the entity choice is mandatory on every PO/SO — the label carries the
  // GSTIN so there is never doubt which registration the invoice bills under
  function companyOpts(){ return companies().map(c=>({v:c.key,l:c.name+" — "+(c.gstin?("GSTIN "+c.gstin):"GSTIN pending")})); }
  function partyStateCode(p){ return (p&&p.stateCode)||GST.stateFromGSTIN(p&&p.gst)||null; }
  function stateOpts(){ return GST.STATES.map(([c,n])=>({v:c,l:c+" — "+n})); }
  function lineGstPct(l,it){ if(l&&l.gstPct!=null&&l.gstPct!=="") return +l.gstPct;
    if(it&&it.gstRate!=null&&it.gstRate!=="") return +it.gstRate; return 18; }
  const TRANSPORT_MODES=[{v:"",l:"—"},{v:"Road",l:"Road"},{v:"Rail",l:"Rail"},{v:"Air",l:"Air"},{v:"Courier",l:"Courier"},{v:"Ship",l:"Ship"}];

  /* ---- Batch = the work order a sales line is served from -------------------
     The line STORES the work-order id (WO-0011) so the claim against that run
     still matches, but everyone reads a batch as the plain run number — 0011.
     Only the label changes; never the stored value. */
  function batchNo(woId){ return String(woId||"").replace(/^WO[\s-]*/i,"")||String(woId||""); }
  function woById(id){ return (ENG.data.workorders||[]).find(w=>w.id===id)||null; }
  /* Width is decided per work order (the run is slit to the ordered width), so
     the printed size comes from the batch first, then whatever the line itself
     was saved with, and only then the product's own width. */
  function lineWidth(l){
    if(!l) return null;
    const wo=l.batch?woById(l.batch):null;
    if(wo&&wo.widthMM) return +wo.widthMM;
    if(l.width) return +l.width;
    const iw=(ENG.item(l.itemId)||{}).widthMM;
    if(Array.isArray(iw)) return iw.length?+iw[0]:null;
    return iw?+iw:null;
  }
  /* "0.05 × 25 mm" — thickness × width, the size a customer orders by. */
  /* Trim the tail a binary float leaves behind (0.14000000000000001 -> 0.14).
     Twelve significant digits is beyond anything a spec sheet states. */
  const trimNum=(v)=>{ const x=+v; return Number.isFinite(x)?String(+x.toPrecision(12)):String(v); };
  function lineSize(l,it){
    it=it||ENG.item(l.itemId)||{};
    /* A thickness set ON THE ORDER wins over the material's own: sheet goods
       are bought to the thickness this order needs, which is not always the
       one the item master happens to carry. */
    const t=(l&&l.thicknessMM!=null)?l.thicknessMM:it.thicknessMM;
    const w=lineWidth(l);
    if(t!=null&&w) return trimNum(t)+" × "+w+" mm";
    if(t!=null) return trimNum(t)+" mm thick";
    if(w) return w+" mm wide";
    return "";
  }

  /* Build GST.calcDoc() input from document lines. */
  function gstLinesOf(o){
    return (o.lines||[]).map(l=>{ const it=ENG.item(l.itemId)||{};
      return {qty:l.qty, rate:l.rate, discPct:l.discPct||0, gstPct:lineGstPct(l,it)}; });
  }
  function docCalc(kind,o){
    const co=companyByKey(o.company);
    const party = kind==="po" ? ENG.data.suppliers.find(s=>s.id===o.supplierId)
                              : ENG.data.customers.find(c=>c.id===o.customerId);
    const partyCode=partyStateCode(party);
    // purchases: place of supply is OUR state; sales: the chosen/derived buyer state
    const pos = kind==="po" ? (co.stateCode||"29") : (o.placeOfSupply||partyCode||co.stateCode||"29");
    const interState = kind==="po" ? !!(partyCode && partyCode!==(co.stateCode||"29"))
                                   : pos!==(co.stateCode||"29");
    return { co, party, pos, interState,
      calc: GST.calcDoc({lines:gstLinesOf(o), interState, freight:o.freight, insurance:o.insurance}) };
  }

  /* ============== PROCUREMENT ============== */
  M.purchase = { title:"Procurement", sub:"Purchase orders & receipts", render(root, params){
    /* The lab incharge comes to this screen for one reason — to test what a
       delivery brought in — so it opens on RECEIVED orders rather than on the
       buyer's open-order list, which holds nothing for them. */
    const qcOnly=App.isLab();
    let tab=App.viewState("tab",()=>qcOnly?"done":"open");
    let filter=App.viewState("filter",()=>({from:"", to:"", q:"", qRaw:""}));
    root.appendChild(pageHead("Procurement",
      qcOnly?"Goods receipts awaiting an incoming-material test"
            :"Auto-suggested reorders, open POs and goods receipts that post straight to stock",[
      h("button",{class:"btn",onclick:reorderWizard,html:"🪄 Reorder Suggestions"}),
      h("button",{class:"btn primary",onclick:()=>poForm(params&&params.create),html:"＋ New PO"})
    ]));
    const pos=ENG.data.purchaseorders;
    const open=pos.filter(p=>p.status!=="Received");
    const pendVal=open.reduce((s,p)=>s+p.lines.reduce((a,l)=>a+Math.max(0,l.qty-(l.recd||0))*l.rate,0),0);
    const overdue=open.filter(p=>p.eta<DB.helpers.iso(DB.helpers.today())).length;
    /* QC's headline is its own worklist, not the buyer's money. Rates and order
       values are withheld from this role throughout the screen — they are here
       to measure material, and a price is no part of that job. */
    const qcPend=(ENG.data.grnTestPending||[]).length;
    const qcRulings=(ENG.data.grnQcDecisions||[]).length;
    root.appendChild(h("div",{class:"grid kpi-grid",style:"margin-bottom:16px"},qcOnly?[
      kpi({icon:"🧪",label:"Materials Awaiting Test",value:ENG.num(qcPend),
        delta:qcPend?"Action needed":"All clear",deltaType:qcPend?"down":"up"}),
      kpi({icon:"📥",label:"Goods Receipts",value:ENG.num((ENG.data.grns||[]).filter(g=>g.status!=="Cancelled").length)}),
      kpi({icon:"✓",label:"Orders Received",value:ENG.num(pos.filter(p=>p.status==="Received").length)}),
      kpi({icon:"🛒",label:"Orders In Transit",value:ENG.num(open.length)}),
    ]:[
      kpi({icon:"🛒",label:"Open Purchase Orders",value:ENG.num(open.length)}),
      kpi({icon:"💵",label:"Pending Inbound Value",value:ENG.money(pendVal)}),
      /* A failed lot waiting on a ruling displaces the overdue-PO tile: a late
         delivery is a chase, an unruled failure is material the factory may be
         about to use. The tile is a button straight into the queue. */
      qcRulings
        ? (()=>{ const c=kpi({icon:"⛔",label:"Failed Lots — Ruling Due",value:ENG.num(qcRulings),
              delta:"Decide now",deltaType:"down"});
            c.style.cursor="pointer"; c.setAttribute("role","button"); c.tabIndex=0;
            c.onclick=qcDecisionQueue;
            c.onkeydown=e=>{ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); qcDecisionQueue(); } };
            return c; })()
        : kpi({icon:"⏰",label:"Overdue POs",value:ENG.num(overdue),delta:overdue?"Follow up":"On track",deltaType:overdue?"down":"up"}),
      qcPend
        ? kpi({icon:"🧪",label:"Incoming Tests Due",value:ENG.num(qcPend),
            delta:"Awaiting the lab",deltaType:"down"})
        : kpi({icon:"📥",label:"Received (total)",value:ENG.num(pos.filter(p=>p.status==="Received").length)}),
    ]));
    /* WHO MAY DO WHAT HERE. Presentation only — the server enforces the same
       split independently (routes: receive is admin/office, GRN testing adds
       the lab role). The point is that nobody is handed a button the server
       will refuse at the end of the form. */
    const mayReceive=!qcOnly;
    const seg=h("div",{class:"seg",style:"margin-bottom:14px"},[segBtn("Open / Partial","open"),segBtn("Received","done"),segBtn("All","all")]);
    root.appendChild(seg);
    root.appendChild(h("div",{class:"toolbar"},[
      MW.searchInput("Search PO no., supplier, item, status…", v=>{filter.qRaw=v;filter.q=v.toLowerCase().trim();draw();}, filter.qRaw),
      MW.dateRange(filter, draw, {label:"Order Date"}),
      h("div",{style:"margin-left:auto"},h("span",{class:"chip",id:"poCount"}))
    ]));
    const host=h("div"); root.appendChild(host);
    function segBtn(l,k){ const b=h("button",{class:tab===k?"on":"",text:l,onclick:()=>{tab=App.setViewState("tab",k);[...seg.children].forEach(c=>c.classList.remove("on"));b.classList.add("on");draw();}}); return b; }
    /* One box across everything a buyer looks a PO up by: the number, the
       supplier, the status, the dates, and the items sitting on the order —
       so "mica" finds the POs carrying mica without knowing their numbers. */
    function poMatch(p){
      if(!filter.q) return true;
      const hay=[p.id, ENG.sup(p.supplierId), p.status, p.refNo, p.date, p.eta]
        .concat(p.lines.map(l=>l.itemId))
        .concat(p.lines.map(l=>(ENG.item(l.itemId)||{}).name));
      return hay.filter(Boolean).join(" ").toLowerCase().includes(filter.q);
    }
    function draw(){
      let data = tab==="open"?open : tab==="done"?pos.filter(p=>p.status==="Received") : pos;
      data=data.filter(p=>poMatch(p)&&MW.inDateRange(p.date, filter));
      data=data.slice().sort((a,b)=>a.date<b.date?1:-1);
      const c=UI.$("#poCount"); if(c) c.textContent=data.length+" purchase orders";
      host.innerHTML="";
      host.appendChild(table(data,[
        {key:"id",label:"PO #",render:r=>`<span class="mono strong">${r.id}</span>`,sort:r=>r.id},
        {key:"supplier",label:"Supplier",cls:"nm",render:r=>esc(U.trim(ENG.sup(r.supplierId),28)),sort:r=>ENG.sup(r.supplierId)},
        {key:"lines",label:"Items",num:true,render:r=>r.lines.length,sort:r=>r.lines.length},
        qcOnly?null:{key:"value",label:"Value",num:true,render:r=>ENG.money(r.value),sort:r=>r.value},
        {key:"recd",label:"Received",render:r=>{const tot=r.lines.reduce((a,l)=>a+l.qty,0),rec=r.lines.reduce((a,l)=>a+(l.recd||0),0);const p=tot?Math.round(rec/tot*100):0;return `<div style="min-width:110px">${meter(p,p===100?"ok":p>0?"warn":"danger")}<div class="muted" style="font-size:11px;margin-top:3px">${p}%</div></div>`;},sort:r=>{const tot=r.lines.reduce((a,l)=>a+l.qty,0);return tot?r.lines.reduce((a,l)=>a+(l.recd||0),0)/tot:0;}},
        {key:"date",label:"Ordered",render:r=>r.date,sort:r=>r.date},
        {key:"eta",label:"ETA",render:r=>{const late=r.status!=="Received"&&r.eta<DB.helpers.iso(DB.helpers.today());return `<span style="color:${late?'var(--danger)':'inherit'}">${r.eta}${late?" ⏰":""}</span>`;},sort:r=>r.eta},
        {key:"status",label:"Status",render:r=>badge(r.status==="Received"?"ok":r.status==="Partially Received"?"warn":"info",r.status),sort:r=>r.status},
        /* QC of what actually arrived. Only ever populated once something has
           been received, so an order still on the water reads "—" rather than
           an alarming "Test due". */
        {key:"qc",label:"QC",render:r=>qcBadge(qcForPo(r)),sort:r=>{const q=qcForPo(r);return !q?3:q.fail?0:q.pending?1:2;}},
        /* ONE action on the row, and it is the one the buyer presses all day.
           Printing and testing both live inside the order — open the row and
           they are there, alongside the receipt they belong to. Crowding them
           into the list gave three buttons per row and, worse, made testing
           look like something done to an ORDER when it is done to a DELIVERY. */
        {key:"act",label:"",noSort:true,render:r=>h("div",{class:"flex gap aic",style:"gap:6px;justify-content:flex-end"},[
          mayReceive
            ? (r.status!=="Received"?h("button",{class:"btn sm primary",onclick:e=>{e.stopPropagation();receivePO(r);},text:"Receive"}):h("span",{class:"muted",text:"✓"}))
            : null
        ].filter(Boolean))},
      ].filter(Boolean),{onRow:r=>poDetail(r),empty:filter.q?"No purchase order matches that search":"No purchase orders"}));
    }
    draw();
    // ⌘K "New Purchase Order" lands here with openNew; consume the flag so a
    // later re-render (saveDelta) doesn't reopen the form.
    if(params&&params.openNew){ params.openNew=false; poForm(); }
    /* arriving from a ledger row (or anywhere else) with a document named */
    if(params&&params.open){ const po=pos.find(p=>p.id===params.open); params.open=null; if(po) poDetail(po); }

    /* Receiving goes through the shared goods-receipt form (the Inventory
       module owns it): per-line accepted/rejected, the supplier's invoice and
       vehicle — everything the numbered GRN the server issues has to record.
       One form, one endpoint, whichever screen the receipt starts from. */
    function receivePO(po){
      UI.$("#modalHost").hidden=true;
      window._erpUtil.receiveStockForm(po.id);
    }

    function poDetail(po){
      const {calc, interState}=docCalc("po",po);
      const gstPairs = interState
        ? [["IGST",ENG.money(calc.igst)]]
        : [["CGST",ENG.money(calc.cgst)],["SGST",ENG.money(calc.sgst)]];
      const poGrns=(ENG.data.grns||[]).filter(g=>g.poId===po.id);
      const poQc=qcForPo(po);
      const body=h("div",{},[
        MW.dl([["Supplier",ENG.sup(po.supplierId)],["Billing Entity",companyByKey(po.company).name],
          ["Status",badge(po.status==="Received"?"ok":"info",po.status)],["Ordered",po.date],["ETA",po.eta]]
          .concat(po.refNo?[["Ref / Quote",po.refNo]]:[])
          // the QC verdict belongs with the order's own facts, not buried below
          .concat(poQc?[["Incoming QC",qcBadge(poQc)]]:[])),
        /* A FAILED LOT SAYS SO AT THE TOP. The goods were booked into stock when
           the receipt was posted, so the office has to see this without opening
           anything: it is their decision to raise a debit note or send it back
           through the rejection path the receipt form already has. */
        poQc&&poQc.awaiting?h("div",{class:"qc-note bad",style:"margin:14px 0 0;font-size:13px"},[
          h("div",{text:"A material on this order FAILED its incoming test and is waiting on an admin's ruling. The stock was booked in when the receipt was posted, so production can still draw it until the rejection is approved."}),
          (App.isAdmin&&App.isAdmin())?h("button",{class:"btn sm danger",style:"margin-top:9px",
            onclick:()=>{UI.$("#modalHost").hidden=true;qcDecisionQueue();},text:"Rule on it now"}):null,
        ]):poQc&&poQc.quarantined?h("div",{class:"qc-note bad",style:"margin:14px 0 0;font-size:13px",
          text:poQc.quarantined+(poQc.quarantined===1?" material":" materials")+" from this order failed and "
            +(poQc.quarantined===1?"is":"are")+" quarantined — held in the QC store, out of reach of production. Returning it to the supplier is a separate debit note."}):
        poQc&&poQc.fail?h("div",{class:"qc-note",style:"margin:14px 0 0;font-size:13px",
          text:"A material on this order failed its incoming test, and an admin declined the rejection — the lot stands as good stock."}):null,
        h("h3",{style:"margin:18px 0 10px;font-size:14px",text:"Order Lines"}),
        table(po.lines,[
          {key:"item",label:"Item",render:r=>{const it=ENG.item(r.itemId)||{};return `<div class="cell-main">${esc(it.name||r.itemId)}</div><div class="cell-sub">${r.itemId}</div>`;},noSort:true},
          {key:"hsn",label:"HSN",render:r=>{const it=ENG.item(r.itemId)||{};return esc(r.hsn||it.hsn||"—");},noSort:true},
          {key:"qty",label:"Ordered",num:true,render:r=>ENG.num(r.qty),noSort:true},
          {key:"recd",label:"Received",num:true,render:r=>ENG.num(r.recd||0),noSort:true},
          /* Over-received lines read "+44 over", not a blank: taking more than
             the order asked for is the one thing on this row worth a second
             look, and a dash would hide it. */
          {key:"pend",label:"Pending",num:true,render:r=>{const p=+(r.qty-(r.recd||0)).toFixed(3);
            if(p>0) return `<span class="badge-s s-warn">${ENG.num(p)}</span>`;
            if(p<0) return `<span class="badge-s s-violet">+${ENG.num(-p)} over</span>`;
            return '<span class="muted">—</span>';},noSort:true},
          qcOnly?null:{key:"rate",label:"Rate",num:true,render:r=>"₹"+ENG.num(r.rate,2),noSort:true},
          qcOnly?null:{key:"gst",label:"GST %",num:true,render:r=>lineGstPct(r,ENG.item(r.itemId)),noSort:true},
          qcOnly?null:{key:"amt",label:"Amount",num:true,render:r=>ENG.money(r.qty*r.rate*(1-(r.discPct||0)/100)),noSort:true},
        ].filter(Boolean),{empty:"No lines"}),
        qcOnly?null:h("h3",{style:"margin:18px 0 10px;font-size:14px",text:"Tax Summary"}),
        qcOnly?null:MW.dl([["Taxable",ENG.money(calc.taxable)]].concat(gstPairs).concat([
          ["Freight",ENG.money(calc.freight)],["Grand Total",ENG.money(calc.grandTotal)]])),
        h("h3",{style:"margin:18px 0 10px;font-size:14px",text:"Goods Receipts"}),
        poGrns.length?table(poGrns,[
          {key:"id",label:"GRN No",render:g=>`<b>${esc(g.id)}</b>`+(g.status==="Cancelled"?' <span class="badge-s s-warn">Cancelled</span>':""),noSort:true},
          {key:"date",label:"Date",render:g=>esc(g.date||"—"),noSort:true},
          {key:"inv",label:"Supplier Inv.",render:g=>esc(g.invNo||"—"),noSort:true},
          {key:"acc",label:"Accepted",num:true,render:g=>ENG.num((g.lines||[]).reduce((s,x)=>s+(+x.accepted||0),0),2),noSort:true},
          {key:"rej",label:"Rejected",num:true,render:g=>{const r=(g.lines||[]).reduce((s,x)=>s+(+x.rejected||0),0);
            return r>0?`<span class="badge-s s-warn">${ENG.num(r,2)}</span>`:'<span class="muted">—</span>';},noSort:true},
          qcOnly?null:{key:"val",label:"Value",num:true,render:g=>ENG.money((g.lines||[]).reduce((s,x)=>s+(+x.accepted||0)*(+x.rate||0),0)),noSort:true},
          // the test state of THIS delivery — a cancelled note has nothing to test
          {key:"qc",label:"QC",render:g=>g.status==="Cancelled"?'<span class="muted">—</span>':qcBadge(qcForGrn(g)),noSort:true},
          {key:"by",label:"By",render:g=>esc(g.by||"—"),noSort:true},
          /* ONE button per receipt, and it follows the work: while readings are
             owed it MAKES the report, and once every material has been measured
             the only thing left to do with it is PRINT it. Two buttons sitting
             side by side asked the user to know which one they wanted; one
             button that changes with the state does not.
             (The plain receipt is still printable from inside the report panel,
             so an untested delivery is not stranded.) */
          {key:"act",label:"",render:g=>{
            if(g.status==="Cancelled") return '<span class="muted">—</span>';
            const q=qcForGrn(g);
            return q.pending
              ? h("button",{class:"btn sm primary",
                  title:"Enter the incoming-material test readings for this receipt",
                  onclick:e=>{e.stopPropagation();UI.$("#modalHost").hidden=true;makeGrnTestReport(g);},
                  text:"🧪 Make GRN Test Report"})
              : h("button",{class:"btn sm",
                  title:"Print the goods receipt note cum test report for this delivery",
                  onclick:e=>{e.stopPropagation();printGrn(g);},
                  html:PRINT_IC+" Print GRN Test Report"});
          },noSort:true},
        ].filter(Boolean),{empty:"No goods receipt notes"}):
        h("div",{class:"muted",style:"font-size:13px",
          text:qcOnly?"No goods receipt notes yet — nothing to test on this order."
                     :"No goods receipt notes yet — press Receive Goods to post one."}),
      ]);
      const anyRecd=po.lines.some(l=>(l.recd||0)>0);
      /* The incharge's footer holds no order paperwork — they neither raise nor
         bill an order. Testing is reached from the receipt rows above. */
      const foot=qcOnly?[]:[h("button",{class:"btn danger",onclick:()=>deletePO(po),text:"🗑 Delete"}),
        h("button",{class:"btn",onclick:()=>printDoc("po",po),html:PRINT_IC+" Print"}),
        h("button",{class:"btn",onclick:()=>stickersPO(po),text:"🏷 Labels"})];
      if(!qcOnly&&!anyRecd) foot.push(h("button",{class:"btn ghost",onclick:()=>{UI.$("#modalHost").hidden=true;poForm(po);},text:"✎ Edit"}));
      if(!qcOnly&&po.status!=="Received") foot.push(h("button",{class:"btn primary",onclick:()=>{UI.$("#modalHost").hidden=true;receivePO(po);},text:"Receive Goods"}));
      modal({title:po.id, sub:ENG.sup(po.supplierId), wide:true, body, foot});
    }

    /* ---- Why a placeholder, not a guess: these fields are genuinely absent
       from a purchase order, so the box explains what to type instead of
       inventing a value. ---- */
    const STICKER_HINTS={
      invoiceNo:"arrives with the goods — type it in",
      inspectedBy:"type the inspector's name",
      dateOfReceipt:"fills in once the goods are received",
      grnNo:"fills in once the goods are received",
    };
    /* Values that belong to the whole order rather than to one line, so
       "copy to all" can move them without overwriting each label's identity. */
    const STICKER_SHARED=["supplier","dateOfReceipt","invoiceNo","inspectedBy"];
    const PX_MM=96/25.4;                   // CSS millimetre, for preview scaling

    /* One raw-material identification label per ordered line, on the company's
       own template. A three-step dialog: tick and edit the fields, lay the
       labels out on any sheet size, then approve the preview and print. The
       layout is remembered in settings for every browser; the BarTender file
       carries the same rows for label-printer runs. */
    function stickersPO(po){
      const cfg=stickerCfg();
      const vals=stickerValues(po,cfg);
      if(!vals.length){ toast("This purchase order has no lines to label",{type:"warn"}); return; }
      const STEPS=["Fields & Data","Layout","Design","Print"];
      let step=0, cur=0, pvPage=0;

      const rail=h("div",{class:"wz-rail"});
      const pane=h("div",{class:"wz-pane"});
      const mo=modal({title:"Print Labels", sub:po.id+" — "+ENG.sup(po.supplierId),
        xwide:true, body:h("div",{},[rail,pane]), foot:[h("span")]});
      const foot=mo.el.querySelector(".modal-foot");

      /* Saved for everyone, exactly like the old field ticks were. A role that
         may not write settings still gets to print — the label just is not
         remembered, which is better than blocking the print. */
      const persist=()=>{
        ENG.data.settings=Object.assign({},ENG.data.settings,{sticker:cfg});
        try{ const p=DB.saveSettings({sticker:cfg}); if(p&&p.catch) p.catch(()=>{}); }catch(e){}
      };

      /* ---- unit-aware number entry: the config is always millimetres, the
         boxes show whatever unit the operator picked ---- */
      const toU=(mm)=>cfg.unit==="cm"?+(mm/10).toFixed(2):+(+mm).toFixed(1);
      const frU=(v)=>{ v=+v; return isNaN(v)?0:(cfg.unit==="cm"?v*10:v); };
      const stp=()=>cfg.unit==="cm"?"0.05":"0.5";
      const fmm=(n)=>(Math.round(n*10)/10).toFixed(1);
      const fld=(label,el,hint)=>h("div",{class:"field"},
        [h("label",{text:label}),el,hint?h("div",{class:"hint",text:hint}):null]);
      const grid=(n,kids)=>h("div",{style:`display:grid;grid-template-columns:repeat(${n},1fr);gap:12px`},kids);
      /* A print document at true mm size, scaled to fit a preview box — used
         by the design canvas and the sheet pane alike. */
      const frame=(html,wMM,hMM,boxW,boxH)=>{
        const s=Math.min(boxW/(wMM*PX_MM),boxH/(hMM*PX_MM));
        return h("div",{class:"wz-frame",
          style:`width:${(wMM*PX_MM*s).toFixed(1)}px;height:${(hMM*PX_MM*s).toFixed(1)}px`},
          h("iframe",{srcdoc:html,scrolling:"no","aria-hidden":"true",
            style:`width:${wMM}mm;height:${hMM}mm;transform:scale(${s.toFixed(4)});transform-origin:top left`}));
      };

      /* Every box that holds label text is multi-line: Enter starts a new line
         and the box grows to show it, because a value like an address or a
         two-line remark has to be typed as it will print. */
      function ta(value,onInput,placeholder,max){
        const el=h("textarea",{class:"wz-ta",rows:"1",placeholder:placeholder||"",
          maxlength:String(max||400)});
        el.value=value==null?"":String(value);
        const grow=()=>{ el.style.height="auto";
          el.style.height=Math.min(260,Math.max(36,el.scrollHeight+2))+"px"; };
        el.addEventListener("input",()=>{ onInput(el.value); grow(); });
        requestAnimationFrame(grow);
        return el;
      }
      /* cfg.fields mirrors cfg.order — the BarTender CSV still reads one flag
         per field, so the two must never drift apart. */
      const syncFields=()=>{ const all=fieldDefs(cfg); cfg.fields={};
        all.forEach(f=>{ cfg.fields[f.k]=cfg.order.indexOf(f.k)>=0; }); };

      function go(i){
        if(i>step) persist();
        if(i>1&&!stickerGeom(cfg).fits){
          toast("The labels do not fit the sheet — fix the sizes before previewing",{type:"warn"});
          step=1; render(); return;
        }
        step=Math.max(0,Math.min(3,i)); render();
      }

      function render(){
        rail.innerHTML="";
        STEPS.forEach((t,i)=>rail.appendChild(h("button",{
          class:"wz-step"+(i===step?" on":"")+(i<step?" done":""), onclick:()=>go(i)},
          [h("span",{class:"n",text:i<step?"✓":String(i+1)}),h("span",{text:t})])));
        pane.innerHTML="";
        [stepFields,stepLayout,stepDesign,stepPrint][step]();
        foot.innerHTML="";
        foot.appendChild(h("button",{class:"btn ghost",onclick:()=>mo.close(),text:"Cancel"}));
        foot.appendChild(h("div",{style:"flex:1"}));
        if(step>0) foot.appendChild(h("button",{class:"btn",onclick:()=>go(step-1),text:"← Back"}));
        if(step<3) foot.appendChild(h("button",{class:"btn primary",onclick:()=>go(step+1),
          text:["Layout","Design","Print"][step]+" →"}));
        /* The dialog deliberately STAYS OPEN across a print: closing it dropped
           the operator back at the purchase-order list, losing the place they
           were at just to run one sheet. */
        else foot.appendChild(h("button",{class:"btn primary",
          onclick:()=>{ persist(); printLabels(po,cfg,vals); },text:"🖨 Print Labels"}));
      }

      /* ============ STEP 1 — what the label says ============
         Every tick carries the value beside it, fetched from the order and
         editable, so the operator corrects a label here instead of by hand
         after it is printed. */
      function stepFields(){
        if(vals.length>1){
          pane.appendChild(h("div",{class:"wz-nav",style:"margin-bottom:16px;flex-wrap:wrap"},[
            h("button",{class:"btn sm",title:"Previous label",
              onclick:()=>{cur=(cur-1+vals.length)%vals.length;render();},text:"◀"}),
            h("span",{style:"color:var(--text)",text:`Label ${cur+1} of ${vals.length}`}),
            h("span",{class:"muted",style:"font-weight:600",text:"— "+(vals[cur].product||"(no product)")}),
            h("button",{class:"btn sm",title:"Next label",
              onclick:()=>{cur=(cur+1)%vals.length;render();},text:"▶"}),
            h("button",{class:"btn sm ghost",style:"margin-left:auto",
              title:"Copy supplier, date, invoice no and inspector onto every label — the per-line product, grade and quantity stay as they are",
              onclick:()=>{
                STICKER_SHARED.forEach(k=>vals.forEach((v,i)=>{ if(i!==cur) v[k]=vals[cur][k]; }));
                toast(`Supplier, date, invoice no and inspector copied to all ${vals.length} labels`,{type:"ok"});
              },text:"⇊ Copy shared values to all"}),
          ]));
        }
        /* ---- heading ---- */
        pane.appendChild(h("div",{class:"wz-sec",text:"Heading"}));
        pane.appendChild(fld("Title across the top",
          ta(cfg.title,v=>{cfg.title=v;},"e.g. RAW MATERIAL — leave empty for no title",120),
          "The type scale adjusts to however long this runs, so the title, the product line and the fields keep their proportions."));

        /* ---- the field catalogue: nothing prints until it is added ---- */
        pane.appendChild(h("div",{class:"wz-sec",text:"Fields on the label"}));
        const search=h("input",{class:"input",type:"search",placeholder:"Search fields to add…"});
        const createBtn=h("button",{class:"btn sm",text:"✚ Create field"});
        pane.appendChild(h("div",{class:"wz-pickbar"},[search,createBtn]));

        /* "Create" opens inline rather than as a second dialog stacked on this
           one — a modal over a modal is a trap to escape from. */
        const nameIn=h("input",{class:"input",type:"text",placeholder:"Name of the new field",maxlength:"44"});
        const createRow=h("div",{class:"wz-createrow",hidden:"hidden"});
        const doCreate=()=>{
          const label=nameIn.value.trim();
          if(!label){ nameIn.focus(); return; }
          const all=fieldDefs(cfg);
          if(all.some(f=>f.label.toLowerCase()===label.toLowerCase())){
            toast("A field called “"+label+"” already exists",{type:"warn"}); return; }
          const clean=label.replace(/[^A-Za-z0-9]/g,"").slice(0,18)||"Field";
          let k="cx"+clean, n=2;
          while(all.some(f=>f.k===k)) k="cx"+clean.slice(0,17)+(n++);
          cfg.custom=(cfg.custom||[]).concat([{k,label,cap:label.toUpperCase(),
            csv:k,row:true,custom:true}]);
          cfg.order.push(k); syncFields();
          vals.forEach(v=>{ if(v[k]==null) v[k]=""; });   // the new field starts empty on every label
          nameIn.value=""; createRow.hidden=true;
          paint(); toast("“"+label+"” added to the label",{type:"ok"});
        };
        nameIn.addEventListener("keydown",e=>{ if(e.key==="Enter"){ e.preventDefault(); doCreate(); } });
        createRow.appendChild(nameIn);
        createRow.appendChild(h("button",{class:"btn sm primary",onclick:doCreate,text:"Add to list"}));
        createRow.appendChild(h("button",{class:"btn sm ghost",text:"Cancel",
          onclick:()=>{ createRow.hidden=true; nameIn.value=""; }}));
        createBtn.addEventListener("click",()=>{ createRow.hidden=!createRow.hidden;
          if(!createRow.hidden) nameIn.focus(); });
        pane.appendChild(createRow);

        const availBox=h("div",{class:"wz-avail"});
        const addedBox=h("div",{});
        pane.appendChild(availBox);
        pane.appendChild(h("div",{class:"wz-sec",text:"On the label — in print order"}));
        pane.appendChild(addedBox);

        /* Redraws only the two lists, so the search box keeps its text and
           its focus while the operator is still typing in it. */
        function paint(){
          const q=search.value.trim().toLowerCase();
          const all=fieldDefs(cfg);
          const free=all.filter(f=>cfg.order.indexOf(f.k)<0
            &&(!q||f.label.toLowerCase().indexOf(q)>=0));
          availBox.innerHTML="";
          if(!free.length){
            availBox.appendChild(h("div",{class:"muted",style:"font-size:12px;padding:8px 2px",
              text:q?"No field matches “"+search.value.trim()+"” — use Create field to add it.":
                     "Every field is already on the label."}));
          } else free.forEach(f=>{
            availBox.appendChild(h("div",{class:"wz-av"},[
              h("span",{text:f.label}),
              f.custom?h("span",{class:"badge-s s-info",style:"margin-left:6px",text:"custom"}):null,
              h("button",{class:"wz-plus",title:"Add "+f.label+" to the label",text:"+",
                onclick:()=>{ cfg.order.push(f.k); syncFields(); paint(); }}),
            ]));
          });

          addedBox.innerHTML="";
          if(!cfg.order.length){
            addedBox.appendChild(h("div",{class:"muted",style:"font-size:12px;padding:10px 2px",
              text:"Nothing on the label yet — add fields from the list above."}));
          }
          addedDefs(cfg).forEach((f,i)=>{
            const row=h("div",{class:"wz-fld"});
            row.appendChild(h("div",{class:"wz-fldname"},[
              h("span",{text:f.label}),
              f.custom?h("span",{class:"badge-s s-info",text:"custom"}):null]));
            if(f.boxes){
              row.appendChild(h("div",{class:"muted",style:"font-size:12px",
                text:"Prints three empty boxes: UNDER TEST · APPROVED · REJECTED"}));
            }else{
              row.appendChild(ta(vals[cur][f.k],v=>{ vals[cur][f.k]=v; },
                STICKER_HINTS[f.k]||"— prints blank —"));
            }
            /* each field's text gets its own ink — the dot writes cfg.fieldC,
               and the design pane's global inks stay the default for the rest */
            const dot=f.boxes?null:h("input",{type:"color",class:"wz-dot",
              title:"Text colour for this field",
              value:(cfg.fieldC&&cfg.fieldC[f.k])||"#000000"});
            if(dot) dot.addEventListener("input",()=>{
              cfg.fieldC=cfg.fieldC||{}; cfg.fieldC[f.k]=dot.value.toLowerCase(); });
            row.appendChild(h("div",{class:"wz-fldact"},[
              dot,
              h("button",{class:"wz-mini",title:"Move up",disabled:i===0?"disabled":null,text:"↑",
                onclick:()=>{ const o=cfg.order; [o[i-1],o[i]]=[o[i],o[i-1]]; paint(); }}),
              h("button",{class:"wz-mini",title:"Move down",
                disabled:i===cfg.order.length-1?"disabled":null,text:"↓",
                onclick:()=>{ const o=cfg.order; [o[i+1],o[i]]=[o[i],o[i+1]]; paint(); }}),
              h("button",{class:"wz-mini danger",title:"Remove from the label",text:"✕",
                onclick:()=>{ cfg.order.splice(i,1); syncFields(); paint(); }}),
            ]));
            addedBox.appendChild(row);
          });
          if(cfg.order.length&&Object.keys(cfg.fieldC||{}).length){
            addedBox.appendChild(h("button",{class:"btn sm ghost",style:"margin-top:8px",
              text:"↺ Reset field colours",title:"Every field goes back to the default ink",
              onclick:()=>{ cfg.fieldC={}; paint(); }}));
          }
        }
        search.addEventListener("input",paint);
        paint();

        /* ---- how the added fields are set out ---- */
        pane.appendChild(h("div",{class:"wz-sec",text:"How the content is set out"}));
        const modeBox=h("div",{class:"wz-modes"});
        [["table","Table content","Every field in a ruled table — captions in one column, values in the other."],
         ["plain","Non-table content","The same two columns and the same alignment, with no table lines drawn."]]
          .forEach(([v,label,note])=>{
            const cb=h("input",{type:"checkbox"}); cb.checked=cfg.layout===v;
            /* Two boxes, one answer — ticking either sets the mode and clears
               the other, so the label can never be asked to be both. */
            cb.addEventListener("change",()=>{ cfg.layout=v; paintModes(); });
            modeBox.appendChild(h("label",{class:"wz-mode"+(cfg.layout===v?" on":"")},
              [cb,h("div",{},[h("div",{class:"t",text:label}),h("div",{class:"n",text:note})])]));
          });
        function paintModes(){
          [...modeBox.querySelectorAll(".wz-mode")].forEach((el,i)=>{
            const on=cfg.layout===(i===0?"table":"plain");
            el.classList.toggle("on",on); el.querySelector("input").checked=on;
          });
        }
        pane.appendChild(modeBox);

        /* ---- the free paragraph ---- */
        pane.appendChild(h("div",{class:"wz-sec",text:"Custom text"}));
        pane.appendChild(fld("Paragraph printed under the fields",
          ta(cfg.para,v=>{cfg.para=v;},
            "Any note, instruction or handling text — as many lines as you like. Leave empty to print none.",1200),
          "Set smaller than the fields so it reads as a note. It counts towards the fit, so a long paragraph shrinks the rest."));

        pane.appendChild(h("div",{class:"muted",style:"margin-top:18px;font-size:12px;line-height:1.65",
          html:"The field list, the title, the paragraph and the layout are saved for everyone, and shape the printed label. Edited <b>values</b> apply to this print run only — they are never written back to the purchase order."}));
      }

      /* ============ STEP 2 — how they sit on the sheet ============ */
      function stepLayout(){
        // repaint hooks the colour/picture/symbol blocks register as they are
        // built; refresh() runs once before any of them exist, so it walks a list
        const paints=[];
        const diag=h("div",{class:"wz-diag"});
        const dims=h("div",{class:"wz-dim"});
        const alert=h("div",{});
        const isRound=()=>cfg.shape==="circle"||cfg.shape==="disc";
        const lwEl=h("input",{class:"input",id:"stk_lw",type:"number",step:stp(),min:"5"});
        const lhEl=h("input",{class:"input",id:"stk_lh",type:"number",step:stp(),min:"5"});
        const diaEl=h("input",{class:"input",id:"stk_dia",type:"number",step:stp(),min:"5"});
        const gxEl=h("input",{class:"input",type:"number",step:stp(),min:"0"});
        const gyEl=h("input",{class:"input",type:"number",step:stp(),min:"0"});

        /* Only the readouts redraw as the operator types — re-rendering the
           whole step would take the focus out of the box mid-keystroke. Every
           box mirrors the EFFECTIVE geometry (a solved gap, a derived size),
           skipping only the box being typed in. */
        function refresh(){
          const g=stickerGeom(cfg);
          paints.forEach(f=>f());
          const setBox=(el,v)=>{ if(document.activeElement!==el) el.value=String(v); };
          setBox(lwEl,toU(g.labelW)); setBox(lhEl,toU(g.labelH)); setBox(diaEl,toU(g.labelW));
          lwEl.disabled=lhEl.disabled=diaEl.disabled=cfg.autoFit==="size";
          setBox(gxEl,toU(g.gapX)); setBox(gyEl,toU(g.gapY));
          gxEl.disabled=gyEl.disabled=cfg.autoFit==="gaps";
          diag.innerHTML=""; diag.appendChild(diagram(g)); diag.appendChild(dims);
          const total=vals.length*Math.max(1,cfg.copies||1);
          const sheets=Math.max(1,Math.ceil(total/g.perPage));
          dims.innerHTML=`Sheet <b>${fmm(g.pgW)} × ${fmm(g.pgH)} mm</b><br>`+
            `Label <b>${isRound()?"⌀ "+fmm(g.labelW):fmm(g.labelW)+" × "+fmm(g.labelH)} mm</b><br>`+
            `${cfg.cols} × ${cfg.rows} = <b>${g.perPage}</b> per sheet · `+
            `${total} label${total>1?"s":""} on <b>${sheets}</b> sheet${sheets>1?"s":""}`;
          alert.innerHTML=""; alert.appendChild(alertFor(g));
        }
        /* A dimension box bound to one config key. min/max are millimetres, so
           the bounds hold whichever unit is on screen. */
        function numIn(key,min,max,isInt){
          const el=h("input",{class:"input",type:"number",min:String(isInt?min:toU(min)),
            step:isInt?"1":stp(), value:String(isInt?cfg[key]:toU(cfg[key]))});
          el.addEventListener("input",()=>{
            if(el.value==="") return;                       // mid-typing, not yet a number
            const raw=isInt?Math.round(+el.value||0):frU(el.value);
            cfg[key]=Math.min(max,Math.max(min,isNaN(raw)?min:raw));
            refresh();
          });
          el.addEventListener("blur",()=>{ el.value=String(isInt?cfg[key]:toU(cfg[key])); });
          return el;
        }
        lwEl.addEventListener("input",()=>{ if(lwEl.value==="")return;
          cfg.labelW=Math.min(1000,Math.max(5,frU(lwEl.value))); refresh(); });
        lhEl.addEventListener("input",()=>{ if(lhEl.value==="")return;
          cfg.labelH=Math.min(1000,Math.max(5,frU(lhEl.value))); refresh(); });
        // a circle has one dimension: the diameter box writes both
        diaEl.addEventListener("input",()=>{ if(diaEl.value==="")return;
          cfg.labelW=cfg.labelH=Math.min(1000,Math.max(5,frU(diaEl.value))); refresh(); });
        gxEl.addEventListener("input",()=>{ if(gxEl.value==="")return;
          cfg.gapX=Math.min(100,Math.max(0,frU(gxEl.value))); refresh(); });
        gyEl.addEventListener("input",()=>{ if(gyEl.value==="")return;
          cfg.gapY=Math.min(100,Math.max(0,frU(gyEl.value))); refresh(); });
        [lwEl,lhEl,diaEl,gxEl,gyEl].forEach(el=>el.addEventListener("blur",refresh));

        const u=cfg.unit;
        const left=h("div",{});

        /* -- layout size -- */
        left.appendChild(h("div",{class:"wz-sec",text:"Layout size"}));
        const pageSel=h("select",{class:"select"},PAGE_SIZES.map(p=>h("option",{value:p.v},p.l)));
        pageSel.value=cfg.page;
        pageSel.addEventListener("change",()=>{ cfg.page=pageSel.value; render(); });
        const orient=h("div",{class:"seg"},[
          h("button",{class:cfg.landscape?"":"on",onclick:()=>{cfg.landscape=false;render();},text:"Portrait"}),
          h("button",{class:cfg.landscape?"on":"",onclick:()=>{cfg.landscape=true;render();},text:"Landscape"})]);
        const units=h("div",{class:"seg"},[
          h("button",{class:u==="mm"?"on":"",onclick:()=>{cfg.unit="mm";render();},text:"mm"}),
          h("button",{class:u==="cm"?"on":"",onclick:()=>{cfg.unit="cm";render();},text:"cm"})]);
        left.appendChild(grid(3,[fld("Sheet size",pageSel),fld("Orientation",orient),fld("Units",units)]));
        if(cfg.page==="custom")
          left.appendChild(h("div",{style:"margin-top:12px"},grid(2,[
            fld(`Sheet width (${u})`,numIn("pageW",20,1000)),
            fld(`Sheet height (${u})`,numIn("pageH",20,1000))])));

        /* -- label shape --
           The outline the label is cut to. Picking a shape swaps the size boxes
           it needs (a circle has one diameter, not a width and a height), so a
           change re-renders the whole step. */
        left.appendChild(h("div",{class:"wz-sec",text:"Label shape"}));
        const shapes=h("div",{class:"wz-shapes"});
        [["rect","Rectangle","Square corners"],
         ["round","Rounded","Rectangle with rounded corners"],
         ["ellipse","Ellipse","Oval — the width and height are its two axes"],
         ["circle","Circle","One diameter"],
         ["disc","Disc","Circle with a punched centre hole"]]
          .forEach(([v,l,tip])=>{
            shapes.appendChild(h("button",{class:"wz-shp"+(cfg.shape===v?" on":""),
              title:tip,"aria-label":l+" — "+tip,
              onclick:()=>{ if(cfg.shape===v) return;
                cfg.shape=v;
                // entering a one-diameter shape collapses the size to it
                if((v==="circle"||v==="disc")&&cfg.labelW>0&&cfg.labelH>0)
                  cfg.labelW=cfg.labelH=Math.min(cfg.labelW,cfg.labelH);
                render(); }},
              [h("i",{class:"s-"+v}),h("span",{text:l})]));
          });
        left.appendChild(shapes);

        /* -- margins -- */
        left.appendChild(h("div",{class:"wz-sec",text:"Margins"}));
        left.appendChild(grid(4,[
          fld(`Top (${u})`,numIn("mTop",0,200)),      fld(`Bottom (${u})`,numIn("mBottom",0,200)),
          fld(`Left (${u})`,numIn("mLeft",0,200)),    fld(`Right (${u})`,numIn("mRight",0,200))]));

        /* -- grid -- */
        left.appendChild(h("div",{class:"wz-sec",text:"Labels per sheet"}));
        left.appendChild(grid(2,[
          fld("Rows",numIn("rows",1,50,true)), fld("Columns",numIn("cols",1,20,true))]));

        /* -- label size + gaps --
           The two auto-fits solve opposite sides of the same equation — fix
           the gaps and derive the size, or fix the size and stretch the gaps
           across the margins — so they can never both be on. Turning one OFF
           freezes the numbers it was computing, so nothing jumps. */
        const sizeAuto=h("input",{type:"checkbox"}); sizeAuto.checked=cfg.autoFit==="size";
        const gapAuto=h("input",{type:"checkbox"});  gapAuto.checked=cfg.autoFit==="gaps";
        sizeAuto.addEventListener("change",()=>{
          const g=stickerGeom(cfg);
          if(sizeAuto.checked) cfg.autoFit="size";
          else { cfg.labelW=g.labelW; cfg.labelH=g.labelH; cfg.autoFit="none"; }
          render();
        });
        gapAuto.addEventListener("change",()=>{
          const g=stickerGeom(cfg);
          if(gapAuto.checked){ cfg.labelW=g.labelW; cfg.labelH=g.labelH; cfg.autoFit="gaps"; }
          else { cfg.gapX=g.gapX; cfg.gapY=g.gapY; cfg.autoFit="none"; }
          render();
        });
        left.appendChild(h("div",{class:"wz-sec",style:"display:flex;align-items:center;gap:14px"},[
          h("span",{text:"Label size"}),
          h("label",{class:"wz-auto"},[sizeAuto,h("span",{text:"Auto-fit — fill the layout"})])]));
        if(isRound()){
          const kids=[fld(`Diameter (${u})`,diaEl)];
          if(cfg.shape==="disc") kids.push(fld(`Hole diameter (${u})`,numIn("holeDia",0,1000)));
          left.appendChild(grid(2,kids));
        }else{
          const kids=[fld(`Width (${u})`,lwEl),fld(`Height (${u})`,lhEl)];
          if(cfg.shape==="round") kids.push(fld(`Corner radius (${u})`,numIn("radius",0,100)));
          left.appendChild(grid(kids.length,kids));
        }

        left.appendChild(h("div",{class:"wz-sec",style:"display:flex;align-items:center;gap:14px"},[
          h("span",{text:"Gap between labels"}),
          h("label",{class:"wz-auto"},[gapAuto,h("span",{text:"Auto-fit — spread to the margins"})])]));
        left.appendChild(grid(2,[
          fld(`Horizontal (${u})`,gxEl),fld(`Vertical (${u})`,gyEl)]));

        // colour, picture, text and symbols now live in step 3 — the design pane


        left.appendChild(alert);
        pane.appendChild(h("div",{class:"wz-cols"},[left,diag]));
        refresh();
      }

      /* The sheet drawn to scale, every label in its real place. Labels that
         run off the sheet are drawn red AND outside the paper edge, so an
         overflow is visible rather than merely described. */
      function diagram(g){
        const s=Math.min(252/g.pgW,336/g.pgH);
        const page=h("div",{class:"wz-page",
          style:`width:${(g.pgW*s).toFixed(1)}px;height:${(g.pgH*s).toFixed(1)}px`});
        const max=Math.min(cfg.rows*cfg.cols,400);
        /* the same outline the label will be cut to, so a circle reads as a
           circle here and not as the square that would waste the corners */
        const curved=cfg.shape==="ellipse"||cfg.shape==="circle"||cfg.shape==="disc";
        const rad=curved?"50%":cfg.shape==="round"?Math.max(1,cfg.radius*s).toFixed(1)+"px":"0";
        for(let i=0;i<max;i++){
          const r=Math.floor(i/cfg.cols), c=i%cfg.cols;
          // g.gapX/gapY, never cfg's — auto-fit gaps solves them per layout
          const x=cfg.mLeft+c*(g.labelW+g.gapX), y=cfg.mTop+r*(g.labelH+g.gapY);
          const bad=(x+g.labelW>g.pgW-cfg.mRight+0.15)||(y+g.labelH>g.pgH-cfg.mBottom+0.15);
          page.appendChild(h("div",{class:"wz-lab"+(bad?" bad":""),
            style:`left:${(x*s).toFixed(1)}px;top:${(y*s).toFixed(1)}px;`+
              `width:${Math.max(1,g.labelW*s).toFixed(1)}px;height:${Math.max(1,g.labelH*s).toFixed(1)}px;`+
              `border-radius:${rad}`}));
        }
        return page;
      }

      function alertFor(g){
        if(g.fits) return h("div",{class:"wz-alert ok"},[h("span",{class:"ic",text:"✓"}),
          h("div",{html:`<b>The layout fits.</b> ${g.perPage} label${g.perPage>1?"s":""} of `+
            `${fmm(g.labelW)} × ${fmm(g.labelH)} mm sit inside the margins with `+
            `${fmm(g.innerW-g.needW)} mm across and ${fmm(g.innerH-g.needH)} mm down to spare.`})]);
        const why=[];
        if(!g.fitsW) why.push(`<b>${fmm(g.overW)} mm too wide</b>`);
        if(!g.fitsH) why.push(`<b>${fmm(g.overH)} mm too tall</b>`);
        const tiny=(g.labelW<5||g.labelH<5)
          ? " The margins and gaps leave no room for a label at all." : "";
        return h("div",{class:"wz-alert"},[h("span",{class:"ic",text:"⚠"}),
          h("div",{html:`<b>These labels do not fit the sheet.</b> ${cfg.cols} × ${cfg.rows} labels of `+
            `${fmm(g.labelW)} × ${fmm(g.labelH)} mm need ${fmm(g.needW)} × ${fmm(g.needH)} mm, but only `+
            `${fmm(g.innerW)} × ${fmm(g.innerH)} mm is left inside the margins — ${why.join(" and ")}.${tiny}`+
            ` Reduce the label size, the rows and columns, the gaps or the margins — or tick Auto-fit.`})]);
      }

      /* ============ STEP 3 — the label, the sheet, the printer ============
         Both panes render the SAME document the printer gets, so what is
         approved here is what comes out of the tray. */
      /* ============ STEP 3 — the design pane, the sheet, the printer ============
         The big label IS the editor: the title, the product line, the field
         block, the paragraph, every symbol and the background picture all drag
         with the mouse, snapping to dotted guides at the label's centre, the
         padding box and the other objects — the way one arranges things in
         Word. The document in the pane is byte-for-byte what the printer gets;
         handles and guides are bound from outside it and never print. */
      function stepDesign(){
        const g=stickerGeom(cfg);
        let m=labelMetrics(cfg,g,vals);
        let sel=null;                 // {t:"sym",i} | {t:"img"} | {t:"blk",k}
        let confirmDel=null;          // a content-block delete awaiting its warning

        /* Deleting the selection — the ✕ badge, the inspector button and the
           Delete key all land here. A symbol or the picture goes at once; a
           content block (title, product, fields, paragraph) is data fetched or
           typed in step 1, so it warns first and the inspector holds the
           confirmation — a modal here would replace the whole wizard. */
        function requestDelete(){
          if(!sel) return;
          if(sel.t==="sym"){ cfg.syms.splice(sel.i,1); sel=null; paintCanvas(); return; }
          if(sel.t==="img"){ cfg.bgImg=""; sel=null; paintTools(); paintCanvas(); return; }
          confirmDel=sel.k; paintInsp();
        }
        function doDelete(k){
          if(k==="title") cfg.title="";
          else if(k==="para") cfg.para="";
          else if(k==="prod"){ cfg.order=cfg.order.filter(x=>x!=="product"); syncFields(); }
          else if(k==="body"){
            /* the whole ruled block: every row field and the status boxes go;
               the product headline is its own block and stays */
            const defs=fieldDefs(cfg);
            cfg.order=cfg.order.filter(x=>{ const f=defs.find(d=>d.k===x); return f&&f.head; });
            syncFields();
          }
          if(cfg.pos) delete cfg.pos[k];
          confirmDel=null; sel=null;
          paintCanvas();
        }

        /* -- the label, live -- */
        const one=h("div",{class:"wz-pv"},[h("h4",{text:"Label design — click to style, drag to place"})]);
        const insp=h("div",{class:"wz-insp"});
        const canvasSlot=h("div",{class:"wz-canvas"});
        const dimNote=h("div",{class:"wz-dim"});
        /* Delete / Backspace removes the selection — but never while the
           operator is typing in a box, and only on this step. */
        pane.onkeydown=(e)=>{
          if(step!==2) return;
          if(e.key!=="Delete"&&e.key!=="Backspace") return;
          if(e.target.closest&&e.target.closest("input,textarea,select")) return;
          if(!sel) return;
          e.preventDefault(); requestDelete();
        };
        one.appendChild(insp);
        one.appendChild(canvasSlot);
        if(vals.length>1) one.appendChild(h("div",{class:"wz-nav"},[
          h("button",{class:"btn sm",onclick:()=>{cur=(cur-1+vals.length)%vals.length;render();},text:"◀"}),
          h("span",{text:`Label ${cur+1} of ${vals.length}`}),
          h("button",{class:"btn sm",onclick:()=>{cur=(cur+1)%vals.length;render();},text:"▶"})]));
        one.appendChild(dimNote);

        function paintCanvas(skipInsp){
          m=labelMetrics(cfg,g,vals);
          canvasSlot.innerHTML="";
          const fr=frame(labelOneHtml(cfg,vals[Math.min(cur,vals.length-1)],vals),
            g.labelW,g.labelH,640,470);
          canvasSlot.appendChild(fr);
          const ifr=fr.querySelector("iframe");
          ifr.addEventListener("load",()=>bindCanvas(ifr));
          dimNote.innerHTML=
            `<b>${(cfg.shape==="circle"||cfg.shape==="disc")
              ?"⌀ "+fmm(g.labelW):fmm(g.labelW)+" × "+fmm(g.labelH)} mm</b> — `+
            "prints exactly as arranged here; nothing is added"+
            (m.k<.55?`<br><span style="color:var(--warn)">Type is scaled to ${Math.round(m.k*100)}% — `+
              `untick a field, move blocks around or use a bigger label for larger print.</span>`:"");
          if(!skipInsp) paintInsp();
        }

        /* Debounced canvas repaint, so inspector typing keeps its focus. The
           sheet lives in the Print tab now and rebuilds from cfg on entry. */
        let cvTmr=null;
        const canvasSoon=()=>{ clearTimeout(cvTmr); cvTmr=setTimeout(()=>paintCanvas(true),260); };

        /* ---- the editor bound onto the print document ---- */
        function bindCanvas(ifr){
          const doc=ifr.contentDocument; if(!doc||!doc.body) return;
          const lb=doc.querySelector(".lb"); if(!lb) return;
          const mmOf=(px)=>px/PX_MM;
          const st=doc.createElement("style");
          st.textContent=`[data-drag]{cursor:move;pointer-events:auto!important}
            .sel-ring{outline:.45mm dashed #2196f3;outline-offset:.4mm}
            .gd{position:absolute;z-index:11;pointer-events:none}
            .gd-v{top:0;height:100%;width:0;border-left:.3mm dashed #e91e63}
            .gd-h{left:0;width:100%;height:0;border-top:.3mm dashed #e91e63}
            .delx{position:absolute;z-index:12;width:4.4mm;height:4.4mm;border-radius:50%;
              border:.3mm solid #fff;background:#e53935;color:#fff;cursor:pointer;padding:0;
              font:700 2.5mm/4mm Arial,sans-serif;text-align:center;
              box-shadow:0 .4mm 1mm rgba(0,0,0,.35)}`;
          doc.head.appendChild(st);
          const selEl=()=>{
            if(!sel) return null;
            if(sel.t==="sym") return doc.querySelector(`[data-drag="sym:${sel.i}"]`);
            if(sel.t==="img") return doc.querySelector('[data-drag="img"]');
            return doc.querySelector(`[data-drag="${sel.k}"]`);
          };
          /* the ✕ badge rides the selection's top-right corner; clicking it —
             or pressing Delete — removes the object (blocks warn first) */
          const xBtn=doc.createElement("button");
          xBtn.className="delx"; xBtn.textContent="✕"; xBtn.title="Delete (Del key works too)";
          xBtn.addEventListener("pointerdown",(e)=>{ e.stopPropagation(); e.preventDefault(); });
          xBtn.addEventListener("click",(e)=>{ e.stopPropagation(); requestDelete(); });
          const mmClamp=(v,lo,hi)=>Math.min(hi,Math.max(lo,v));
          const ringSel=()=>{
            doc.querySelectorAll(".sel-ring").forEach(e=>e.classList.remove("sel-ring"));
            xBtn.remove();
            const el=selEl(); if(!el) return;
            el.classList.add("sel-ring");
            const r=el.getBoundingClientRect();
            xBtn.style.left=mmClamp(mmOf(r.right)-1,1,g.labelW-5.5)+"mm";
            xBtn.style.top =mmClamp(mmOf(r.top)-2.2,1,g.labelH-5.5)+"mm";
            lb.appendChild(xBtn);
          };
          ringSel();
          doc.addEventListener("keydown",(e)=>{
            if((e.key==="Delete"||e.key==="Backspace")&&sel){ e.preventDefault(); requestDelete(); }
          });
          const guides=[];
          const clearGuides=()=>{ guides.splice(0).forEach(e=>e.remove()); };
          const guide=(axis,at)=>{
            const e=doc.createElement("div");
            e.className="gd "+(axis==="v"?"gd-v":"gd-h");
            e.style[axis==="v"?"left":"top"]=at.toFixed(2)+"mm";
            lb.appendChild(e); guides.push(e);
          };
          const rectMM=(el)=>{ const r=el.getBoundingClientRect();
            return {x:mmOf(r.left),y:mmOf(r.top),w:mmOf(r.width),h:mmOf(r.height)}; };

          doc.addEventListener("pointerdown",(ev)=>{
            const el=ev.target.closest&&ev.target.closest("[data-drag]");
            confirmDel=null;                      // touching the canvas withdraws a pending warning
            if(!el){ if(sel){ sel=null; ringSel(); } paintInsp(); return; }
            const kind=el.getAttribute("data-drag");
            sel=kind.indexOf("sym:")===0?{t:"sym",i:+kind.slice(4)}
              :kind==="img"?{t:"img"}:{t:"blk",k:kind};
            ringSel(); paintInsp();
            ev.preventDefault();
            try{ el.setPointerCapture(ev.pointerId); }catch(e){}
            const sx=ev.clientX, sy=ev.clientY, r0=rectMM(el);
            const centred=sel.t==="sym"||sel.t==="img";   // these carry translate(-50%,-50%)
            let moved=false, fx=0, fy=0;
            /* Guide candidates: the label's centre, the padding box, every
               other object's centre — and the midpoint between every pair of
               other objects, so "halfway between these two" is a line too. */
            const others=[...doc.querySelectorAll("[data-drag]")].filter(x=>x!==el).map(rectMM);
            const vs=[g.labelW/2,m.padX,g.labelW-m.padX];
            const hs=[g.labelH/2,m.padY,g.labelH-m.padY];
            others.forEach(t=>{ vs.push(t.x+t.w/2); hs.push(t.y+t.h/2); });
            for(let a=0;a<others.length;a++)for(let b=a+1;b<others.length;b++){
              vs.push((others[a].x+others[a].w/2+others[b].x+others[b].w/2)/2);
              hs.push((others[a].y+others[a].h/2+others[b].y+others[b].h/2)/2);
            }
            const move=(e2)=>{
              let dx=mmOf(e2.clientX-sx), dy=mmOf(e2.clientY-sy);
              if(!moved&&Math.abs(dx)<.25&&Math.abs(dy)<.25) return;
              moved=true;
              xBtn.remove();                      // the badge would trail a stale corner
              const cx=r0.x+r0.w/2+dx, cy=r0.y+r0.h/2+dy;
              clearGuides();
              const TH=1.1;
              let bx=null,by=null;
              vs.forEach(x=>{ if(Math.abs(cx-x)<TH&&(bx==null||Math.abs(cx-x)<Math.abs(cx-bx))) bx=x; });
              hs.forEach(y=>{ if(Math.abs(cy-y)<TH&&(by==null||Math.abs(cy-y)<Math.abs(cy-by))) by=y; });
              if(bx!=null){ dx+=bx-cx; guide("v",bx); }
              if(by!=null){ dy+=by-cy; guide("h",by); }
              fx=dx; fy=dy;
              el.style.transform=(centred?"translate(-50%,-50%) ":"")+
                `translate(${(dx*PX_MM).toFixed(1)}px,${(dy*PX_MM).toFixed(1)}px)`;
            };
            const up=()=>{
              doc.removeEventListener("pointermove",move);
              doc.removeEventListener("pointerup",up);
              clearGuides();
              if(!moved) return;                       // a plain click only selects
              el.style.transform="";
              const rd=(n)=>Math.round(n*10)/10;
              if(sel.t==="sym"){
                const o=cfg.syms[sel.i];
                if(o){ o.x=rd(Math.min(1000,Math.max(0,r0.x+r0.w/2+fx)));
                       o.y=rd(Math.min(1000,Math.max(0,r0.y+r0.h/2+fy))); }
              }else if(sel.t==="img"){
                cfg.bgImgX=rd(Math.min(300,Math.max(-300,r0.x+r0.w/2+fx-g.labelW/2)));
                cfg.bgImgY=rd(Math.min(300,Math.max(-300,r0.y+r0.h/2+fy-g.labelH/2)));
              }else{
                cfg.pos=cfg.pos||{};
                cfg.pos[sel.k]={x:rd(Math.max(-g.labelW,Math.min(g.labelW-2,r0.x+fx))),
                                y:rd(Math.max(-g.labelH,Math.min(g.labelH-2,r0.y+fy)))};
              }
              paintCanvas();
            };
            doc.addEventListener("pointermove",move);
            doc.addEventListener("pointerup",up);
          });
        }

        /* ---- the inspector: whatever is selected, its own knobs ---- */
        function paintInsp(){
          insp.innerHTML="";
          if(confirmDel){
            /* the warning for content blocks: this is data fetched from the
               system or typed in step 1, so deleting asks first */
            const names={title:"the title",prod:"the product line — data fetched from the order",
              body:"the whole fields block — the data fetched from the system",
              para:"the paragraph"};
            insp.appendChild(h("span",{class:"wz-insplbl",style:"color:var(--danger)",
              text:"⚠ Remove "+(names[confirmDel]||confirmDel)+"?"}));
            insp.appendChild(h("span",{class:"muted",style:"font-size:12px",
              text:"It comes off the label now — add it back any time from step 1, Fields & Data."}));
            insp.appendChild(h("button",{class:"btn sm",
              style:"background:var(--danger);border-color:var(--danger);color:#fff",
              text:"🗑 Delete",onclick:()=>doDelete(confirmDel)}));
            insp.appendChild(h("button",{class:"btn sm ghost",text:"Cancel",
              onclick:()=>{ confirmDel=null; paintInsp(); }}));
            return;
          }
          if(!sel){
            insp.appendChild(h("span",{class:"muted",style:"font-size:12px",
              text:"Click anything on the label to style it, drag it to move it — dotted lines appear when it lines up with the centre, the margins or another object. ✕ or the Delete key removes it."}));
            return;
          }
          const numB=(label,get,set,lo,hi,stp2)=>{
            const el=h("input",{class:"input",type:"number",min:String(lo),max:String(hi),
              step:String(stp2||1),value:String(get()),style:"width:88px"});
            el.addEventListener("input",()=>{ if(el.value==="")return;
              const v=+el.value; if(isNaN(v))return;
              set(Math.min(hi,Math.max(lo,v))); canvasSoon(); });
            el.addEventListener("blur",()=>{ el.value=String(get()); });
            return h("label",{class:"wz-inspfld"},[h("span",{text:label}),el]);
          };
          const dial=(get,set,label)=>{
            const d=h("input",{type:"color",class:"wz-dial",title:label,"aria-label":label});
            d.value=get()||labelInk(cfg.bg);
            d.addEventListener("input",()=>{ set(d.value.toLowerCase()); canvasSoon(); });
            const a=h("button",{class:"btn sm ghost",text:get()?"Auto":"Auto ✓",
              title:"Follow the background automatically",
              onclick:()=>{ set(""); paintInsp(); paintCanvas(true); }});
            return h("span",{style:"display:inline-flex;align-items:center;gap:6px"},[d,a]);
          };
          if(sel.t==="sym"){
            const o=cfg.syms[sel.i];
            if(!o){ sel=null; return paintInsp(); }
            insp.appendChild(h("span",{class:"wz-insplbl",text:"Symbol  "+o.g}));
            insp.appendChild(numB("Size (mm)",()=>o.s,v=>{o.s=v;},2,200,1));
            insp.appendChild(h("button",{class:"btn sm ghost",text:"✕ Remove",
              title:"Or press Delete",onclick:requestDelete}));
          }else if(sel.t==="img"){
            insp.appendChild(h("span",{class:"wz-insplbl",text:"Background picture"}));
            insp.appendChild(h("span",{class:"muted",style:"font-size:12px",
              text:"Drag to place it — transparency and fit are in the tools →"}));
            insp.appendChild(h("button",{class:"btn sm ghost",text:"✕ Remove",
              title:"Or press Delete",onclick:requestDelete}));
          }else{
            const names={title:"Title",prod:"Product line",body:"Fields block",para:"Paragraph"};
            insp.appendChild(h("span",{class:"wz-insplbl",text:names[sel.k]||sel.k}));
            insp.appendChild(numB("Size mm (0 = auto)",()=>cfg.fs[sel.k]||0,v=>{cfg.fs[sel.k]=v;},0,60,.5));
            if(sel.k!=="body"){
              const key={title:"titleC",prod:"prodC",para:"paraC"}[sel.k];
              insp.appendChild(dial(()=>cfg[key],v=>{cfg[key]=v;},"Text colour"));
            }else{
              insp.appendChild(h("span",{class:"muted",style:"font-size:12px",
                text:"Field colours are set per field in step 1"}));
            }
            if(cfg.pos&&cfg.pos[sel.k])
              insp.appendChild(h("button",{class:"btn sm ghost",text:"↩ Back into the flow",
                title:"Return this block to the automatic stacked layout",
                onclick:()=>{ delete cfg.pos[sel.k]; paintCanvas(); }}));
            insp.appendChild(h("button",{class:"btn sm ghost",text:"🗑 Remove from label",
              title:"Takes it off the label after a confirmation — or press Delete",
              onclick:requestDelete}));
          }
        }

        /* ---- right rail: the design tools ---- */
        const tools=h("div",{class:"wz-pv wz-tools"},[h("h4",{text:"Design tools"})]);
        const toolPaints=[];
        const paintTools=()=>toolPaints.forEach(f=>f());
        /* full-width rail: three columns — colour & picture · symbols · text */
        const colA=h('div'),colB=h('div'),colC=h('div');
        tools.appendChild(h('div',{class:'wz-toolgrid'},[colA,colB,colC]));

        // background colour
        colA.appendChild(h("div",{class:"wz-sec",text:"Background"}));
        const dial=h("input",{type:"color",class:"wz-dial",value:cfg.bg,
          title:"Any colour — opens the full colour picker","aria-label":"Label background colour"});
        const hexIn=h("input",{class:"input wz-hex",value:cfg.bg,maxlength:"7","aria-label":"Colour hex code"});
        const swatches=h("div",{class:"wz-sw"});
        toolPaints.push(()=>{
          dial.value=cfg.bg;
          if(document.activeElement!==hexIn) hexIn.value=cfg.bg;
          swatches.querySelectorAll(".wz-chip").forEach(c=>
            c.classList.toggle("on",c.getAttribute("data-c")===cfg.bg));
        });
        const setColour=(hx)=>{ cfg.bg=String(hx).toLowerCase(); paintTools(); paintCanvas(true); };
        STICKER_COLOURS.forEach(c=>{
          swatches.appendChild(h("button",{class:"wz-chip","data-c":c.v,title:c.l,"aria-label":c.l,
            style:`background:${c.v}`,onclick:()=>setColour(c.v)}));
        });
        dial.addEventListener("input",()=>setColour(dial.value));
        hexIn.addEventListener("input",()=>{
          const t=hexIn.value.trim();
          if(/^#[0-9a-fA-F]{6}$/.test(t)) setColour(t);
        });
        hexIn.addEventListener("blur",()=>{ hexIn.value=cfg.bg; });
        colA.appendChild(h("div",{class:"wz-colrow"},[dial,hexIn]));
        colA.appendChild(swatches);

        // background picture — the operator's own watermark/logo
        const fileIn=h("input",{type:"file",accept:"image/png,image/jpeg,image/webp,image/gif"});
        fileIn.hidden=true;
        const opIn=h("input",{class:"input",type:"number",min:"0",max:"95",step:"5"});
        opIn.addEventListener("input",()=>{ if(opIn.value==="")return;
          cfg.bgImgOp=Math.min(95,Math.max(0,Math.round(+opIn.value||0))); canvasSoon(); });
        opIn.addEventListener("blur",()=>{ opIn.value=String(cfg.bgImgOp); });
        const fitSeg=h("div",{class:"seg"},[
          h("button",{text:"To width",title:"Scale the picture to the label's width",
            onclick:()=>{ cfg.bgImgFit="w"; paintTools(); paintCanvas(true); }}),
          h("button",{text:"To height",title:"Scale the picture to the label's height",
            onclick:()=>{ cfg.bgImgFit="h"; paintTools(); paintCanvas(true); }})]);
        const picCtl=h("div",{class:"wz-picwrap"},[
          grid(2,[fld("Transparency (%)",opIn),fld("Adjust the picture",fitSeg)]),
          h("div",{class:"hint",style:"margin-top:6px",
            text:"Drag the picture on the label to place it. High transparency turns it into a watermark."}),
        ]);
        toolPaints.push(()=>{
          picCtl.hidden=!cfg.bgImg;
          if(document.activeElement!==opIn) opIn.value=String(cfg.bgImgOp);
          [...fitSeg.children].forEach((b,i)=>
            b.classList.toggle("on",(i===0)===(cfg.bgImgFit!=="h")));
        });
        fileIn.addEventListener("change",()=>{
          const f=fileIn.files&&fileIn.files[0]; fileIn.value="";
          if(!f) return;
          if(!/^image\/(png|jpeg|webp|gif)$/.test(f.type)){
            toast("Pick a PNG, JPEG, WebP or GIF picture",{type:"warn"}); return; }
          const rd=new FileReader();
          rd.onload=()=>{
            const url=String(rd.result||"");
            const use=(v)=>{ cfg.bgImg=v; paintTools(); paintCanvas(true); };
            if(url.length<=750000) return use(url);
            /* over the server's 750 kB cap: redraw it smaller before keeping
               it, or it would be silently dropped on save */
            const im=new Image();
            im.onload=()=>{
              for(let cap=1400,q=.85;cap>=350;cap-=350,q=Math.max(.5,q-.12)){
                const sc=Math.min(1,cap/Math.max(im.naturalWidth,im.naturalHeight));
                const cv=document.createElement("canvas");
                cv.width=Math.max(1,Math.round(im.naturalWidth*sc));
                cv.height=Math.max(1,Math.round(im.naturalHeight*sc));
                cv.getContext("2d").drawImage(im,0,0,cv.width,cv.height);
                let out=f.type==="image/png"?cv.toDataURL("image/png"):cv.toDataURL("image/jpeg",q);
                if(out.length>750000&&f.type==="image/png") out=cv.toDataURL("image/jpeg",q);
                if(out.length<=750000) return use(out);
              }
              toast("That picture is too detailed to store — use a simpler one",{type:"warn"});
            };
            im.onerror=()=>toast("That file could not be read as a picture",{type:"warn"});
            im.src=url;
          };
          rd.readAsDataURL(f);
        });
        /* the chosen picture shows beside the chooser with its own ✕, so
           removing it never means hunting for it on the label first */
        const picThumb=h("img",{class:"wz-thumb",alt:"Selected picture"});
        const picX=h("button",{class:"wz-mini danger",title:"Remove the selected picture",text:"✕",
          onclick:()=>{ cfg.bgImg=""; if(sel&&sel.t==="img") sel=null;
            paintTools(); paintCanvas(); }});
        toolPaints.push(()=>{
          const on=!!cfg.bgImg;
          picThumb.hidden=picX.hidden=!on;
          if(on&&picThumb.getAttribute("src")!==cfg.bgImg) picThumb.src=cfg.bgImg;
        });
        colA.appendChild(h("div",{class:"wz-picchip",style:"margin-top:10px"},[
          h("button",{class:"btn sm",text:"🖼 Picture from this device…",
            title:"A logo or pattern for the background — drag it into place on the label",
            onclick:()=>fileIn.click()}),
          picThumb,picX,fileIn]));
        colA.appendChild(picCtl);

        // symbols — click to place, then drag on the label
        colB.appendChild(h("div",{class:"wz-sec",text:"Symbols"}));
        const symPal=h("div",{class:"wz-sw"});
        STICKER_SYMBOLS.forEach(s=>{
          symPal.appendChild(h("button",{class:"wz-symb",title:s.l,"aria-label":"Place "+s.l,
            text:s.v,onclick:()=>{
              if((cfg.syms||[]).length>=12){
                toast("Up to 12 symbols fit on one label",{type:"warn"}); return; }
              (cfg.syms=cfg.syms||[]).push({g:s.v,
                x:Math.round(g.labelW/2),y:Math.round(g.labelH/2),s:8});
              sel={t:"sym",i:cfg.syms.length-1};
              paintCanvas();
            }}));
        });
        colB.appendChild(symPal);
        colB.appendChild(h("div",{class:"hint",style:"margin-top:6px",
          text:"A placed symbol lands mid-label — drag it where you want it, click it to size or remove it."}));

        // text: the face and the default inks
        colC.appendChild(h("div",{class:"wz-sec",text:"Text"}));
        const fontSel=h("select",{class:"select"},STICKER_FONTS.map(f=>h("option",{value:f.v},f.l)));
        fontSel.value=cfg.font;
        fontSel.addEventListener("change",()=>{ cfg.font=fontSel.value; paintCanvas(true); });
        colC.appendChild(fld("Font",fontSel));
        const inkPair=(key,label)=>{
          const d=h("input",{type:"color",class:"wz-dial",title:label+" colour",
            "aria-label":label+" colour"});
          const autoB=h("button",{class:"btn sm ghost",
            title:"Follow the background automatically"});
          d.addEventListener("input",()=>{ cfg[key]=d.value.toLowerCase(); paintTools(); paintCanvas(true); });
          autoB.addEventListener("click",()=>{ cfg[key]=""; paintTools(); paintCanvas(true); });
          toolPaints.push(()=>{ d.value=cfg[key]||labelInk(cfg.bg);
            autoB.textContent=cfg[key]?"Auto":"Auto ✓"; });
          return h("div",{style:"display:flex;align-items:center;gap:8px"},[d,autoB]);
        };
        colC.appendChild(h("div",{style:"margin-top:10px"},grid(2,[
          fld("Captions",inkPair("capC","Caption")),fld("Values",inkPair("valC","Value"))])));
        colC.appendChild(h("div",{class:"hint",
          text:"Defaults for every caption and value — step 1 colours single fields, and clicking a block on the label colours just that block."}));

        // start over on the arrangement without losing content
        colC.appendChild(h("div",{style:"margin-top:14px"},[
          h("button",{class:"btn sm ghost",text:"↺ Reset arrangement",
            title:"Every block returns to the automatic flow and its automatic size — colours, symbols and the picture stay",
            onclick:()=>{ cfg.pos={}; cfg.fs={title:0,prod:0,body:0,para:0};
              sel=null; paintCanvas(); }})]));

        paintTools();
        paintCanvas();

        /* Design tab: the label on top, the tools beneath it — both running
           the full width of the dialog. */
        pane.appendChild(one);
        pane.appendChild(tools);
      }

      /* ============ STEP 4 — the sheet and the printer ============
         The printing half of what used to share a screen with the designer:
         the sheet as it will come off the tray, then the size of the run. */
      function stepPrint(){
        const g=stickerGeom(cfg);
        const sheet=h("div",{class:"wz-pv"},[h("h4",{text:"Sheet layout"})]);
        const sheetSlot=h("div"), sheetNav=h("div",{class:"wz-nav"});
        sheet.appendChild(sheetSlot); sheet.appendChild(sheetNav);
        function paintSheet(){
          const sh=Math.max(1,Math.ceil(vals.length*Math.max(1,cfg.copies||1)/g.perPage));
          pvPage=Math.min(Math.max(0,pvPage),sh-1);
          sheetSlot.innerHTML="";
          sheetSlot.appendChild(frame(labelSheetHtml(po,cfg,vals,{onlyPage:pvPage}),
            g.pgW,g.pgH,620,540));
          sheetNav.innerHTML="";
          sheetNav.appendChild(h("button",{class:"btn sm",disabled:sh<2?"disabled":null,
            onclick:()=>{pvPage=(pvPage-1+sh)%sh;paintSheet();},text:"◀"}));
          sheetNav.appendChild(h("span",{text:`Sheet ${pvPage+1} of ${sh}`}));
          sheetNav.appendChild(h("button",{class:"btn sm",disabled:sh<2?"disabled":null,
            onclick:()=>{pvPage=(pvPage+1)%sh;paintSheet();},text:"▶"}));
        }
        paintSheet();
        sheet.appendChild(h("div",{class:"wz-dim",html:
          `<b>${(PAGE_SIZES.find(p=>p.v===cfg.page)||{}).l||"Custom"}</b>`+
          (cfg.landscape?" · landscape":"")+`<br>${fmm(g.pgW)} × ${fmm(g.pgH)} mm · `+
          `${g.perPage} per sheet`}));
        pane.appendChild(sheet);

        /* How many of each label to run off in one go. Copies of the same
           label stay adjacent, so the two stickers for one drum come off the
           sheet side by side rather than a sheet apart. */
        const copyIn=h("input",{class:"input",type:"number",min:"1",max:"500",step:"1",
          value:String(cfg.copies||1),style:"max-width:130px"});
        const tally=h("div",{class:"wz-tally"});
        const retally=()=>{
          const n=Math.max(1,Math.min(500,Math.round(+copyIn.value||1)));
          const t=vals.length*n, sh=Math.max(1,Math.ceil(t/g.perPage));
          tally.innerHTML=`<b>${vals.length}</b> label${vals.length>1?"s":""} × <b>${n}</b> `+
            `cop${n>1?"ies":"y"} = <b>${t}</b> to print, on <b>${sh}</b> sheet${sh>1?"s":""} `+
            `of ${g.perPage} per sheet.`;
        };
        let copyTmr=null;
        copyIn.addEventListener("input",()=>{
          if(copyIn.value==="") { retally(); return; }
          cfg.copies=Math.max(1,Math.min(500,Math.round(+copyIn.value||1)));
          retally();
          // redraw the sheet a beat later, so the pager can never claim
          // one sheet while the tally underneath says two
          clearTimeout(copyTmr); copyTmr=setTimeout(paintSheet,320);
        });
        copyIn.addEventListener("blur",()=>{ copyIn.value=String(cfg.copies||1);
          clearTimeout(copyTmr); paintSheet(); });
        retally();
        pane.appendChild(h("div",{class:"wz-copies",style:"margin-top:18px"},[
          h("div",{class:"field",style:"flex:0 0 auto"},
            [h("label",{text:"No. of labels (copies of each)"}),copyIn]),
          tally]));
        pane.appendChild(h("div",{class:"muted",style:"margin-top:14px;font-size:12px;line-height:1.65",
          html:"<b>Print Labels</b> opens the sheet in a new tab and raises your printer dialog — pick the label printer or the tray there. Set the printer's paper size to match the sheet above and its scaling to 100% (never “fit to page”), or the millimetres will not come out true. This dialog stays open behind it, so you come back exactly where you left off."}));
      }

      render();
    }
    async function deletePO(po){
      const grn=ENG.data.movements.filter(m=>m.ref===po.id);
      const msg=grn.length
        ? `Delete ${po.id}? This also removes ${grn.length} stock receipt(s) posted against it, reversing that stock.`
        : `Delete ${po.id}? This purchase order will be permanently removed.`;
      if(!await confirm(msg,{title:"Delete Purchase Order",danger:true})) return;
      ENG.data.purchaseorders=ENG.data.purchaseorders.filter(p=>p.id!==po.id);
      if(grn.length) ENG.data.movements=ENG.data.movements.filter(m=>m.ref!==po.id);
      UI.$("#modalHost").hidden=true;
      toast(`${po.id} deleted`,{type:"ok",title:"Removed"});
      App.saveDelta(()=>DB.purchase.remove(po.id));  // server also reverses its GRN movements
    }

    function reorderWizard(){
      const sugg=ENG.data.items.map(it=>({it,st:ENG.status(it.id)})).filter(x=>x.st.suggest>0)
        .sort((a,b)=>({A:0,B:1,C:2}[a.it.abc]-({A:0,B:1,C:2}[b.it.abc])));
      const body = sugg.length? h("div",{},[
        h("p",{class:"dim",style:"margin-bottom:14px",text:`${sugg.length} item(s) are at or below their reorder point. Suggested quantities account for current stock + pending POs against target levels.`}),
        table(sugg,[
          // code and supplier stack, so neither is truncated by the other
          {key:"item",label:"Item",render:r=>`<div class="cell-main">${esc(r.it.name)}</div>`
            +`<div class="cell-sub">${r.it.id}</div>`
            +`<div class="cell-sub">${ENG.sup(r.it.supplierId)}</div>`,noSort:true},
          {key:"onHand",label:"On Hand",num:true,render:r=>ENG.num(ENG.dispQty(r.it,r.st.onHand),1),noSort:true},
          {key:"reorder",label:"Reorder Pt",num:true,render:r=>ENG.num(ENG.dispQty(r.it,r.it.reorder)),noSort:true},
          {key:"suggest",label:"Suggested",num:true,render:r=>`<span class="strong" style="color:var(--accent)">${esc(ENG.qtyText(r.it,r.st.suggest,0))}</span><span class="muted">${esc(ENG.kgSuffix(r.it,r.st.suggest))}</span>`,noSort:true},
          {key:"abc",label:"Class",render:r=>badge(r.it.abc==="A"?"danger":r.it.abc==="B"?"warn":"ok","Class "+r.it.abc),noSort:true},
        ],{empty:"All stocked"})
      ]) : h("div",{class:"empty"},[h("div",{class:"big",text:"✓"}),h("div",{text:"Everything is above reorder level — no action needed."})]);
      const mo=modal({title:"Smart Reorder Suggestions", sub:"Auto-calculated from stock, pending & targets", wide:true, body,
        foot: sugg.length?[h("button",{class:"btn ghost",onclick:()=>mo.close(),text:"Close"}),
          h("button",{class:"btn primary",onclick:()=>{createPOsFromSuggestions(sugg);mo.close();},text:"Create Grouped POs"})]:[h("button",{class:"btn primary",onclick:()=>mo.close(),text:"Done"})]});
    }
    function createPOsFromSuggestions(sugg){
      const bySup={}; sugg.forEach(x=>{ const s=x.it.supplierId||"SUP-09"; (bySup[s]=bySup[s]||[]).push(x); });
      const created=[]; Object.entries(bySup).forEach(([sid,items])=>{
        const po={id:U.nextSeqId(ENG.data.purchaseorders,"PO-"), date:DB.helpers.iso(DB.helpers.today()), supplierId:sid,
          company:companies()[0].key,
          lines:items.map(x=>({itemId:x.it.id, qty:x.st.suggest, rate:x.it.cost, recd:0})),
          status:"Open", eta:DB.helpers.daysAhead(Math.max(...items.map(x=>x.it.lead))),
          value:items.reduce((s,x)=>s+x.st.suggest*x.it.cost,0)};
        ENG.data.purchaseorders.push(po); created.push(po);
      });
      tab="open"; toast(`${created.length} purchase order(s) created from suggestions`,{type:"ok",title:"POs raised"});
      App.saveDelta(async()=>{ for(const po of created) await DB.purchase.create(po); });
    }

    /* ---- Tally-style PO entry: everything the printed PO needs ---- */
    function poForm(arg){
      const editPo=(arg && typeof arg==="object" && arg.id)?arg:null;
      const presetItem=(typeof arg==="string")?arg:null;
      const sups=ENG.data.suppliers;
      let lines=[];
      const totBox=h("div");
      const ev=k=>esc(editPo?(editPo[k]||""):"");
      const body=h("div",{},[
        docSec("Who & when"),
        h("div",{class:"form-grid g3"},[
          U.field("Billing Company (invoice under) *",U.selectHTML("po_co",companyOpts(),editPo?editPo.company:companies()[0].key)),
          /* what the printed document calls itself — the order, or a proforma
             raised against it. Stored on the PO so a reprint never changes. */
          U.field("Document Type",U.selectHTML("po_dtype",[
            {v:"po",l:"Purchase Order"},{v:"proforma",l:"Proforma Invoice"}],
            editPo?(editPo.docType||"po"):"po")),
          U.field("Supplier *",U.searchSelect("po_sup",sups.map(s=>({v:s.id,l:s.name})),editPo?editPo.supplierId:(sups[0]&&sups[0].id),"Search supplier…")),
          U.field("PO Date",`<input class="input" id="po_date" type="date" value="${editPo?(editPo.date||""):DB.helpers.iso(DB.helpers.today())}">`),
          U.field("Expected ETA",`<input class="input" id="po_eta" type="date" value="${editPo?editPo.eta:DB.helpers.daysAhead(14)}">`),
          U.field("Valid Upto",`<input class="input" id="po_valid" type="date" value="${ev("validUpto")}">`),
          U.field("Quotation Ref.",`<input class="input" id="po_ref" value="${ev("refNo")}" placeholder="e.g. Verbal / QTN-77">`),
        ]),
        docSec("Contacts"),
        h("div",{class:"form-grid g3"},[
          U.field("Vendor Code",`<input class="input" id="po_vcode" value="${ev("vendorCode")}" placeholder="optional">`),
          U.field("Attn (vendor contact)",`<input class="input" id="po_attn" value="${ev("attn")}" placeholder="e.g. Mr. S. Saravanan">`),
          U.field("Our Contact (CTC Person)",`<input class="input" id="po_ctc" value="${ev("ctcPerson")}" placeholder="e.g. Mr. Neelmani">`),
        ]),
        docSec("Terms printed on the PO"),
        h("div",{class:"form-grid g3"},[
          U.field("GST",U.selectHTML("po_gstmode",[{v:"As Applicable",l:"As Applicable"},{v:"Included",l:"Included"},{v:"Extra",l:"Extra"}],editPo?(editPo.gstMode||"As Applicable"):"As Applicable")),
          U.field("Packing",`<input class="input" id="po_pack" value="${ev("packing")}" placeholder="e.g. Non-returnable barrels">`),
          U.field("Delivery",`<input class="input" id="po_deliv" value="${esc(editPo?(editPo.deliveryNote||""):"immediate")}" placeholder="e.g. immediate / ASAP">`),
          U.field("Destination",`<input class="input" id="po_dest" value="${esc(editPo?(editPo.destination||""):"to our works")}">`),
          U.field("Notes / Instructions",`<textarea class="input" id="po_notes" rows="2" placeholder="e.g. Kindly attach Test Report along with material">${ev("notes")}</textarea>`,"full"),
        ]),
        docSec("Materials ordered"),
        h("div",{id:"po_lines",class:"doc-lines"}),
        h("button",{class:"btn sm doc-add",onclick:()=>addLine(),html:"＋ Add line"}),
        h("div",{class:"doc-tot"},totBox),
      ]);
      const mo=modal({title:editPo?("Edit "+editPo.id):"New Purchase Order", sub:editPo?"Update this purchase order":"Raise a PO to a supplier", xwide:true, body,
        foot:[h("button",{class:"btn ghost",onclick:()=>mo.close(),text:"Cancel"}),
          h("button",{class:"btn",onclick:printDraft,html:PRINT_IC+" Print"}),
          h("button",{class:"btn primary",onclick:save,text:editPo?"Save Changes":"Create PO"})]});
      body.addEventListener("input",recalc);
      body.addEventListener("change",recalc);
      function collect(){ const out=[];
        lines.forEach((_,i)=>{ if(!lines[i]) return; const iEl=UI.$("#pl_item_"+i); if(!iEl) return;
          const id=iEl.value, qty=+UI.$("#pl_qty_"+i).value, rate=+UI.$("#pl_rate_"+i).value;
          // the thickness now comes FROM the chosen item, never typed beside it
          const thk=id?((ENG.item(id)||{}).thicknessMM):null;
          const uEl=UI.$("#pl_uom_"+i);
          const uom=uEl?String(uEl.value||"").toUpperCase():"";
          if(id&&qty>0) out.push(Object.assign({itemId:id, qty, rate:rate||ENG.item(id).cost, recd:0,
            hsn:(UI.$("#pl_hsn_"+i).value||"").trim(),
            discPct:+UI.$("#pl_disc_"+i).value||0, gstPct:+UI.$("#pl_gst_"+i).value||0},
            // the thickness the supplier must deliver to, for sheet goods only
            (thk!=null&&isFinite(thk)&&thk>0)?{thicknessMM:thk}:{},
            // the unit this order is placed in
            uom?{uom}:{})); });
        return out; }
      function draft(){
        const out=collect();
        const o={ id:editPo?editPo.id:U.nextSeqId(ENG.data.purchaseorders,"PO-"),
          date:UI.$("#po_date").value||DB.helpers.iso(DB.helpers.today()),
          supplierId:UI.$("#po_sup").value, company:UI.$("#po_co").value,
          refNo:UI.$("#po_ref").value.trim(), lines:out,
          docType:UI.$("#po_dtype").value,
          validUpto:UI.$("#po_valid").value, vendorCode:UI.$("#po_vcode").value.trim(),
          attn:UI.$("#po_attn").value.trim(), ctcPerson:UI.$("#po_ctc").value.trim(),
          gstMode:UI.$("#po_gstmode").value, packing:UI.$("#po_pack").value.trim(),
          deliveryNote:UI.$("#po_deliv").value.trim(), destination:UI.$("#po_dest").value.trim(),
          notes:UI.$("#po_notes").value.trim(),
          freight:+UI.$("#po_fr")?.value||0,
          status:editPo?editPo.status:"Draft — not saved", eta:UI.$("#po_eta").value };
        o.value=docCalc("po",o).calc.grandTotal;
        return o;
      }
      function recalc(){
        const o=draft();
        renderTotals(totBox, docCalc("po",o), {freightId:"po_fr", freight:o.freight});
      }
      function printDraft(){
        const o=draft();
        if(!o.lines.length){ toast("Add at least one line with qty to print",{type:"warn"}); return; }
        printDoc("po",o);
      }
      /* Units a PO can be raised in. Built from what the catalogue actually
         uses, so the list never offers a unit this factory does not buy in. */
      const UOMS=(()=>{
        const s=new Set(["KG","MTR","PCS"]);
        ENG.data.items.forEach(i=>{ const u=String(i.uom||"").trim().toUpperCase(); if(u&&u!=="-") s.add(u); });
        return [...s].sort();
      })();
      /* A purchase order buys RAW MATERIAL. Work-in-process is made here, not
         bought, and the 102 WIP entries were burying the materials that can
         actually be ordered. A line already carrying something else — an older
         order raised before this rule — keeps its own item in the list, so
         editing that order never silently swaps what was bought. */
      const NEW_MAT="__new_material__";
      function rmOptions(keepId){
        const list=ENG.data.items.filter(i=>i.cat==="RM");
        const kept=keepId&&!list.some(i=>i.id===keepId)?ENG.item(keepId):null;
        return (kept?[kept]:[]).concat(list);
      }
      /* The code IS the name here — HARDNER LX 75 H is RM-HARDNER-LX-75-H — so
         printing both put the same words on the row twice. The code alone is
         what the store and the supplier's challan use. Searching still matches
         the name, because the name is inside the code. */
      function rmLabel(i){ return i.id; }
      /* ---- creating a material without leaving the order ----
         UI.modal() empties its host, so opening the Stock Items dialog from
         here would take the half-typed order down with it. This panel opens
         INSIDE the line instead: the few things a purchase order actually
         needs to know about a material, and — for anything bought by the
         metre — the width and GSM, without which the new material would be
         the only one in the catalogue that could not be read in kilograms. */
      function openNewMaterial(row, idx, typedName, onCancel){
        const old=row.querySelector(".pl-newmat"); if(old) old.remove();
        const inp=(id,ph,type)=>h("input",{class:"input",id:"nm_"+id+"_"+idx,placeholder:ph||"",type:type||"text"});
        const nameEl=inp("name","e.g. HARDNER LX 90 K");
        const codeEl=inp("code","RM-…");
        const uomEl=h("select",{class:"select",id:"nm_uom_"+idx},
          UOMS.map(u=>h("option",{value:u,text:u,selected:u==="KG"?"selected":null})));
        const gsmEl=inp("gsm","g/m²","number"), widEl=inp("wid","mm across the web","number");
        const hsnEl=inp("hsn","HSN"), gstEl=inp("gst","18","number"), costEl=inp("cost","0.00","number");
        nameEl.value=typedName||"";

        /* the code is the name in capitals behind RM-, the way every code in
           this catalogue was built — until somebody types their own */
        let auto=true;
        const suggest=()=>{ if(!auto) return;
          const stem=String(nameEl.value||"").toUpperCase().replace(/[^A-Z0-9]+/g,"-").replace(/^-+|-+$/g,"");
          codeEl.value=stem?"RM-"+stem:""; };
        codeEl.addEventListener("input",()=>{auto=false;});
        nameEl.addEventListener("input",suggest);
        suggest();

        /* width and GSM are asked for only when they mean something */
        const geo=h("div",{class:"doc-line-fields",style:"margin-top:6px"},[
          h("div",{class:"doc-line-f"},[h("label",{text:"GSM (g/m²)"}),gsmEl]),
          h("div",{class:"doc-line-f"},[h("label",{text:"Roll width (mm)"}),widEl]),
        ]);
        const syncGeo=()=>{ const len=["MTR","MTRS","M","METER","SQM"].includes(String(uomEl.value).toUpperCase());
          geo.hidden=!len; if(len&&!widEl.value) widEl.value="1000"; };
        uomEl.addEventListener("change",syncGeo);

        const msg=h("div",{class:"muted",style:"font-size:11px;margin-top:6px"});
        const panel=h("div",{class:"pl-newmat",style:"margin:8px 0 4px;padding:10px 12px;border:1px solid var(--accent);border-radius:8px;background:var(--bg-soft,rgba(127,127,127,.06))"},[
          h("div",{style:"font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:.4px;color:var(--accent);margin-bottom:8px",text:"New raw material"}),
          h("div",{class:"doc-line-fields"},[
            h("div",{class:"doc-line-f"},[h("label",{text:"Material name *"}),nameEl]),
            h("div",{class:"doc-line-f"},[h("label",{text:"Item code *"}),codeEl]),
            h("div",{class:"doc-line-f"},[h("label",{text:"Bought / stocked in"}),uomEl]),
            h("div",{class:"doc-line-f"},[h("label",{text:"HSN"}),hsnEl]),
            h("div",{class:"doc-line-f"},[h("label",{text:"GST %"}),gstEl]),
            h("div",{class:"doc-line-f"},[h("label",{text:"Std cost (₹)"}),costEl]),
          ]),
          geo, msg,
          h("div",{style:"display:flex;gap:8px;margin-top:10px"},[
            h("button",{class:"btn sm primary",onclick:e=>{e.preventDefault();create();},text:"Create & use"}),
            h("button",{class:"btn sm ghost",onclick:e=>{e.preventDefault();panel.remove();if(onCancel)onCancel();},text:"Cancel"}),
          ]),
        ]);
        syncGeo();
        row.insertBefore(panel, row.querySelector(".doc-line-fields"));
        setTimeout(()=>{ try{nameEl.focus();}catch{} },20);

        function create(){
          const name=(nameEl.value||"").trim();
          const code=(codeEl.value||"").trim().toUpperCase();
          if(!name||!code){ msg.textContent="A name and a code are both needed."; msg.style.color="var(--danger)"; return; }
          if(ENG.item(code)){ msg.textContent=code+" already exists — pick it from the list instead."; msg.style.color="var(--danger)"; return; }
          const uom=String(uomEl.value||"KG").toUpperCase();
          const obj={ id:code, name, cat:"RM", uom, active:true, moq:0,
            reorder:0, safety:0, lead:7, abc:"B",
            cost:+costEl.value||0, price:0, hsn:(hsnEl.value||"").trim(),
            gstRate:gstEl.value===""?18:+gstEl.value,
            barcode:"890"+Math.floor(Math.random()*1e7) };
          if(!geo.hidden){ if(+gsmEl.value) obj.gsm=+gsmEl.value; if(+widEl.value) obj.width=+widEl.value; }
          /* the same opening movement Stock Items writes, so the material has a
             ledger from the moment it exists rather than from its first receipt */
          const openMove={ id:U.genMoveId(), date:DB.helpers.iso(DB.helpers.today()), itemId:code,
            wh:"WH-PNY", type:"OPEN", qty:0, rate:obj.cost, ref:"NEW", note:"Created from a purchase order" };
          ENG.data.items.push(obj); ENG.data.movements.push(openMove);
          App.saveDelta(async()=>{ await DB.items.put(obj); await DB.movements.add(openMove); });
          U.ssAddOption("pl_item_",{v:obj.id,l:rmLabel(obj)});
          panel.remove();
          U.ssSet("pl_item_"+idx, obj.id);
          toast(code+" created",{type:"ok",title:"New material"});
        }
      }
      function addLine(seed){
        const idx=lines.length; lines.push({});
        const seedId=seed?(seed.itemId||seed):null;
        const rms=rmOptions(seedId);
        const itemId=seedId||(rms[0]&&rms[0].id);
        const it=ENG.item(itemId)||{};
        const qtyVal=(seed&&seed.qty!=null)?seed.qty:(typeof seed==="string"?ENG.status(seed).suggest:"");
        const rateVal=(seed&&seed.rate!=null)?seed.rate:(typeof seed==="string"?ENG.item(seed).cost:"");
        /* THICKNESS IS THE IDENTITY of a sheet material — every thickness of a
           tape is its own stock item, with its own GSM and its own stock. So
           this PICKS the item; it is not a number to type. A free box allowed
           an order for 0.14 mm to be placed against the 0.08 mm item, which is
           exactly what went wrong on PO-025/026/027. */
        const familyOf=(x)=>{
          if(!x||!x.material) return [];
          return ENG.data.items.filter(i=>i.cat!=="FG" && i.material===x.material
              && String(i.grade||"")===String(x.grade||"") && i.thicknessMM!=null)
            .sort((a,b)=>(+a.thicknessMM||0)-(+b.thicknessMM||0));
        };
        const thkEl=h("select",{class:"select",id:"pl_thk_"+idx});
        const fillThk=(x)=>{
          const fam=familyOf(x);
          thkEl.innerHTML="";
          fam.forEach(f=>thkEl.appendChild(h("option",{value:f.id,
            text:BOMCALC.thk3(f.thicknessMM)+" mm",selected:f.id===x.id?"selected":null})));
          return fam;
        };
        // shown only when the material genuinely comes in more than one thickness
        const syncThk=(x)=>{ const f=thkEl.closest(".doc-line-f"); if(!f) return;
          const fam=fillThk(x);
          f.hidden=!(isSheetGoods(x)&&fam.length>1);
        };
        thkEl.addEventListener("change",()=>{
          const pick=ENG.item(thkEl.value); if(!pick) return;
          const hid=UI.$("#pl_item_"+idx), vis=UI.$("#pl_item_"+idx+"_s");
          if(!hid) return;
          hid.value=pick.id;
          if(vis) vis.value=rmLabel(pick);   // keep the search box honest
          hid.dispatchEvent(new Event("change",{bubbles:true}));
        });

        /* The unit this order is placed in. It defaults to how the material is
           STOCKED, which is what a receipt posts against — choosing a different
           one is allowed (a supplier may quote in rolls or metres) but the
           warning below says plainly that the receipt will not convert it. */
        const stockUom=String(it.uom||"").trim().toUpperCase();
        const seedUom=(seed&&seed.uom)?String(seed.uom).toUpperCase():"";
        const uomEl=h("select",{class:"select",id:"pl_uom_"+idx},
          UOMS.map(u=>h("option",{value:u,text:u,selected:(seedUom||stockUom)===u?"selected":null})));
        const uomWarn=h("div",{class:"muted",id:"pl_uomw_"+idx,
          style:"font-size:11px;margin-top:3px;display:none"});
        const qtyEl=h("input",{class:"input",id:"pl_qty_"+idx,type:"number",placeholder:"0",value:qtyVal});
        /* Suppliers quote tape either way round, so whichever unit is typed the
           other is shown beside it — with the width and GSM it was worked out
           from, so the figure can be checked rather than trusted. */
        const convEl=h("div",{class:"muted",id:"pl_conv_"+idx,style:"font-size:11px;margin-top:3px"});
        const syncConv=(x)=>{
          const kpm=kgPerMetre(x), q=+qtyEl.value||0;
          const u=String(uomEl.value||"").toUpperCase();
          if(!kpm||!(q>0)||(u!=="KG"&&u!=="MTR")){ convEl.textContent=""; return; }
          const basis=" ("+ENG.num(x.gsm,0)+" g/m² × "+ENG.num(x.width,0)+" mm)";
          convEl.textContent = u==="KG" ? "= "+ENG.num(q/kpm,1)+" MTR"+basis
                                        : "= "+ENG.num(q*kpm,2)+" kg"+basis;
        };
        /* Ordering in a different unit from the one a material is stocked in is
           normal — a roll is quoted by length or by weight depending on the
           supplier. The receipt converts it, so this states what will land in
           stock rather than warning against it. It only objects when the two
           units genuinely cannot be reconciled. */
        const syncUom=(x)=>{
          const su=String((x&&x.uom)||"").trim().toUpperCase();
          const u=String(uomEl.value||"").toUpperCase();
          if(!su || u===su){ uomWarn.style.display="none"; uomWarn.textContent=""; return; }
          const one=BOMCALC.convertQty(1,u,su,x);
          uomWarn.style.display="";
          if(one==null){
            uomWarn.style.color="var(--danger)";
            uomWarn.textContent="Stocked in "+su+" and this cannot be converted — set the material's width and GSM, or order in "+su+".";
          }else{
            uomWarn.style.color="";
            uomWarn.textContent="Stocked in "+su+" — the receipt converts it (1 "+u+" = "+ENG.num(one,4)+" "+su+").";
          }
        };
        const row=docLine(idx + 1,
          h("div",{html:U.searchSelect("pl_item_"+idx,
            [{v:NEW_MAT,l:"＋ Add a new raw material…"}].concat(rmOptions(itemId).map(i=>({v:i.id,l:rmLabel(i)}))),
            itemId,"Search material…")}),
          [
            ["HSN",      h("input",{class:"input",id:"pl_hsn_"+idx,placeholder:"HSN",value:(seed&&seed.hsn)||it.hsn||""})],
            ["Thk (mm)", thkEl],
            ["Qty",      qtyEl],
            ["UOM",      uomEl],
            ["Rate (₹)", h("input",{class:"input",id:"pl_rate_"+idx,type:"number",placeholder:"0.00",value:rateVal})],
            ["Disc %",   h("input",{class:"input",id:"pl_disc_"+idx,type:"number",placeholder:"0",value:(seed&&seed.discPct)||""})],
            ["GST %",    h("input",{class:"input",id:"pl_gst_"+idx,type:"number",placeholder:"18",value:(seed&&seed.gstPct!=null)?seed.gstPct:lineGstPct(seed,it)})],
          ],
          el=>{ el.remove(); lines[idx]=null; recalc(); });
        UI.$("#po_lines").appendChild(row);
        // each note belongs under the field it is about
        const uomCell=uomEl.closest(".doc-line-f"); if(uomCell) uomCell.appendChild(uomWarn);
        const qtyCell=qtyEl.closest(".doc-line-f"); if(qtyCell) qtyCell.appendChild(convEl);
        const cur=()=>ENG.item(UI.$("#pl_item_"+idx).value)||{};
        syncThk(it); syncUom(it); syncConv(it);
        qtyEl.addEventListener("input",()=>syncConv(cur()));
        uomEl.addEventListener("change",()=>{ syncUom(cur()); syncConv(cur()); });
        // picking a material refreshes its HSN + GST defaults
        const hid=UI.$("#pl_item_"+idx);
        /* Materials turn up on a delivery that the catalogue has never seen, and
           making the office abandon a half-typed order to go and create one is
           how orders get raised against the wrong item. So the picker creates it
           in place: the form opens on Raw Material with the name already typed,
           and the new code drops into every line's list at once. */
        /* what the line was on before "add a new material" was chosen, so a
           cancelled panel puts it back where it was and not where it started */
        let lastPick=it.id||"";
        if(hid) hid.addEventListener("change",()=>{
          if(hid.value!==NEW_MAT){ lastPick=hid.value; return; }
          const typed=(UI.$("#pl_item_"+idx+"_s")||{}).value||"";
          openNewMaterial(row, idx, typed==="＋ Add a new raw material…"?"":typed.trim(),
            ()=>U.ssSet("pl_item_"+idx, lastPick));
        });
        if(hid) hid.addEventListener("change",()=>{ if(hid.value===NEW_MAT) return; const ni=ENG.item(hid.value)||{};
          UI.$("#pl_hsn_"+idx).value=ni.hsn||""; UI.$("#pl_gst_"+idx).value=lineGstPct(null,ni);
          syncThk(ni);
          const nu=String(ni.uom||"").trim().toUpperCase(); if(nu) uomEl.value=nu; syncUom(ni); syncConv(ni);
          if(!UI.$("#pl_rate_"+idx).value) UI.$("#pl_rate_"+idx).value=ni.cost||""; recalc(); });
      }
      if(editPo) editPo.lines.forEach(l=>addLine(l)); else addLine(presetItem);
      recalc();
      function save(){
        const o=draft();
        if(!o.lines.length){ toast("Add at least one line with qty",{type:"warn"}); return; }
        const patch={supplierId:o.supplierId, company:o.company, refNo:o.refNo, date:o.date,
          docType:o.docType,
          validUpto:o.validUpto, vendorCode:o.vendorCode, attn:o.attn, ctcPerson:o.ctcPerson,
          gstMode:o.gstMode, packing:o.packing, deliveryNote:o.deliveryNote, destination:o.destination,
          notes:o.notes, eta:o.eta, lines:o.lines, freight:o.freight, value:o.value, status:"Open"};
        if(editPo){
          Object.assign(editPo,patch);
          mo.close(); toast(editPo.id+" updated",{type:"ok"});
          App.saveDelta(()=>DB.purchase.update(editPo.id,patch));
        } else {
          const po=Object.assign(o,{status:"Open"});
          ENG.data.purchaseorders.push(po);
          mo.close(); tab="open"; toast(po.id+" created",{type:"ok"});
          App.saveDelta(()=>DB.purchase.create(po));
        }
      }
    }
  }};

  /* ---- shared line-grid pieces (PO + SO forms) ---- */
  /* ---- document form building blocks (PO / SO) ----
     A section rule, and a LINE as a small card: the item picker gets a whole
     row (so a long product name stays readable) and its numbers sit beneath in
     a grid that reflows — nothing is ever clipped or side-scrolled, at any
     width. `fields` is [[label, node], …]; every input keeps its original id so
     the collect/save logic is untouched. */
  function docSec(title){
    return h("div",{class:"doc-sec"},[h("span",{class:"doc-sec-t",text:title}), h("span",{class:"doc-sec-l"})]);
  }
  /* ---- how a line PRINTS ----
     Web that the plant weighs is printed in kilograms even when the order was
     placed by the metre. The quantity and the rate are restated together, so
     quantity x rate is the same money it always was — the tax figures are
     still computed from the STORED pair, never from these, so nothing about
     what the document is worth can drift.
     A line already placed in kilograms, or a material with no width and GSM
     to convert through, prints exactly as it was entered. */
  function lineAsKg(l, it){
    const qty=+l.qty||0, rate=+l.rate||0;
    const uom=String(l.uom||(it&&it.uom)||"KG").trim().toUpperCase();
    const per=ENG.readsAsKg(it)&&ENG.isLen({uom})?ENG.kgPerUnit(it):null;
    return per ? {qty:qty*per, rate:rate/per, uom:"KG"} : {qty, rate, uom};
  }
  /* Sheet goods — fabric, film, mica tape, anything supplied as a roll or a
     sheet — are bought to a THICKNESS, and a supplier cannot fill the order
     without being told which. Powders, pastes and liquids have no thickness.
     A material already carrying one, or measured by length or area, is sheet
     goods; the office can still correct the figure per order. */
  function isSheetGoods(it){
    if(!it) return false;
    if(it.thicknessMM!=null) return true;
    if(it.fabric===true) return true;
    return ["MTR","M","METER","MTRS","SQM","ROLL"].includes(String(it.uom||"").toUpperCase());
  }

  /* Tape and sheet are quoted by length OR by weight depending on the supplier,
     and the two convert through the roll's own width and GSM:
         kg = metres × widthMM × gsm ÷ 1,000,000
     Returns kg per metre, or null when the material does not carry both
     figures — in which case nothing is shown rather than a made-up number. */
  // the roll geometry lives in bomcalc, shared with the server that posts the
  // receipt — so the figure on screen is the one that reaches stock
  const kgPerMetre=(it)=>BOMCALC.kgPerMetre(it);
  function docLine(no, itemNode, fields, onRemove){
    return h("div",{class:"doc-line"},[
      h("div",{class:"doc-line-top"},[
        h("div",{class:"doc-line-no",text:String(no)}),
        h("div",{class:"doc-line-item"},[itemNode]),
        h("button",{class:"btn sm ghost doc-line-x",title:"Remove this line",
          onclick:e=>{ e.preventDefault(); onRemove(e.target.closest(".doc-line")); },text:"✕"}),
      ]),
      h("div",{class:"doc-line-fields"}, fields.map(([lab,node])=>
        h("div",{class:"doc-line-f"},[h("label",{text:lab}), node]))),
    ]);
  }
  /* Live totals panel: taxable → CGST/SGST or IGST → freight/insurance →
     round off → grand total. Freight/insurance are editable inputs INSIDE
     the panel so the figure updates as you type. */
  function renderTotals(box, dc, opts){
    opts=opts||{};
    const {calc, interState, co, pos}=dc;
    const keep=id=>{ const el=box.querySelector("#"+id); return el?el.value:null; };
    const frVal = keep(opts.freightId)!=null?keep(opts.freightId):(opts.freight||"");
    const insVal= opts.insuranceId ? (keep(opts.insuranceId)!=null?keep(opts.insuranceId):(opts.insurance||"")) : null;
    const row=(l,v,strong)=>`<div style="display:flex;justify-content:space-between;gap:24px;padding:3px 0${strong?";font-weight:800;font-size:15px;border-top:1px solid var(--line);margin-top:4px;padding-top:8px":""}"><span class="${strong?"":"muted"}">${l}</span><span>${v}</span></div>`;
    const inpRow=(l,id,v)=>`<div style="display:flex;justify-content:space-between;align-items:center;gap:24px;padding:3px 0"><span class="muted">${l}</span><input class="input" id="${id}" type="number" step="0.01" style="width:110px;text-align:right;padding:4px 8px" value="${v==null?"":v}"></div>`;
    if(opts.exportCcy){
      // export supply: line values only — no GST added; IGST note prints on the invoice
      const S=GST.ccySign(opts.exportCcy), f2=v=>S+(+v||0).toLocaleString("en-IN",{minimumFractionDigits:2,maximumFractionDigits:2});
      const sub=calc.taxable, tot=+(sub+(+frVal||0)+(+insVal||0)).toFixed(2);
      box.innerHTML=`<div style="min-width:300px;background:var(--panel-2);border:1px solid var(--line);border-radius:10px;padding:12px 14px">
        <div class="muted" style="font-size:11px;font-weight:700;text-transform:uppercase;margin-bottom:6px">Export supply — commercial invoice, GST not added</div>
        ${calc.discount?row("Discount","− "+f2(calc.discount)):""}
        ${row("Sub Total",f2(sub))}
        ${inpRow("Freight ("+opts.exportCcy+")",opts.freightId,frVal)}
        ${opts.insuranceId?inpRow("Insurance ("+opts.exportCcy+")",opts.insuranceId,insVal):""}
        ${row("Total ("+opts.exportCcy+")",f2(tot),true)}
      </div>`;
      return;
    }
    box.innerHTML=`<div style="min-width:300px;background:var(--panel-2);border:1px solid var(--line);border-radius:10px;padding:12px 14px">
      <div class="muted" style="font-size:11px;font-weight:700;text-transform:uppercase;margin-bottom:6px">
        ${interState?("Inter-state supply → IGST"):("Intra-state ("+(GST.stateName(co.stateCode)||"")+") → CGST + SGST")}
      </div>
      ${calc.discount?row("Discount","− "+ENG.money(calc.discount)):""}
      ${row("Taxable Value",ENG.money(calc.taxable))}
      ${interState?row("IGST",ENG.money(calc.igst)):(row("CGST",ENG.money(calc.cgst))+row("SGST",ENG.money(calc.sgst)))}
      ${inpRow("Freight / Transport (₹)",opts.freightId,frVal)}
      ${opts.insuranceId?inpRow("Insurance (₹)",opts.insuranceId,insVal):""}
      ${row("Round Off",(calc.roundOff>=0?"+ ":"− ")+Math.abs(calc.roundOff).toFixed(2))}
      ${row("Grand Total",ENG.money(calc.grandTotal),true)}
    </div>`;
  }

  /* ============== SALES ============== */
  M.sales = { title:"Sales Orders", sub:"Demand & dispatch", render(root, params){
    let tab=App.viewState("tab",()=>"open");
    let filter=App.viewState("filter",()=>({from:"", to:"", q:"", qRaw:""}));
    root.appendChild(pageHead("Sales Orders","Customer demand, ATP checks and dispatches that deduct finished goods automatically",[
      h("button",{class:"btn primary",onclick:()=>soForm(),html:"＋ New Sales Order"})
    ]));
    const sos=ENG.data.salesorders;
    const open=sos.filter(s=>s.status!=="Dispatched");
    const backlog=open.reduce((s,o)=>s+o.value,0);
    const urgent=open.filter(o=>o.priority==="Urgent"||o.promised<DB.helpers.iso(DB.helpers.today())).length;
    root.appendChild(h("div",{class:"grid kpi-grid",style:"margin-bottom:16px"},[
      kpi({icon:"🧾",label:"Open Orders",value:ENG.num(open.length)}),
      kpi({icon:"💰",label:"Order Backlog",value:ENG.money(backlog)}),
      kpi({icon:"🔥",label:"Urgent / Overdue",value:ENG.num(urgent),delta:urgent?"Prioritise":"Clear",deltaType:urgent?"down":"up"}),
      kpi({icon:"🚚",label:"Dispatched (total)",value:ENG.num(sos.filter(s=>s.status==="Dispatched").length)}),
    ]));
    const seg=h("div",{class:"seg",style:"margin-bottom:14px"},[segBtn("Open","open"),segBtn("Dispatched","done"),segBtn("All","all")]);
    root.appendChild(seg);
    root.appendChild(h("div",{class:"toolbar"},[
      MW.searchInput("Search SO no., customer, item, batch, invoice…", v=>{filter.qRaw=v;filter.q=v.toLowerCase().trim();draw();}, filter.qRaw),
      MW.dateRange(filter, draw, {label:"Order Date"}),
      h("div",{style:"margin-left:auto"},h("span",{class:"chip",id:"soCount"}))
    ]));
    const host=h("div"); root.appendChild(host);
    function segBtn(l,k){ const b=h("button",{class:tab===k?"on":"",text:l,onclick:()=>{tab=App.setViewState("tab",k);[...seg.children].forEach(c=>c.classList.remove("on"));b.classList.add("on");draw();}}); return b; }
    /* Sales looks an order up by whatever the caller quotes on the phone: the
       SO number, the customer, their own PO number, the invoice, or the batch
       running against it — so all of them feed the one box. */
    function soMatch(s){
      if(!filter.q) return true;
      const hay=[s.id, ENG.custName(s.customerId), s.status, s.priority, s.invoiceNo, s.custPoNo, s.date, s.promised]
        .concat(s.lines.map(l=>l.itemId))
        .concat(s.lines.map(l=>(ENG.item(l.itemId)||{}).name))
        .concat(s.lines.map(l=>l.batch?batchNo(l.batch):null));
      return hay.filter(Boolean).join(" ").toLowerCase().includes(filter.q);
    }
    function draw(){
      let data = tab==="open"?open : tab==="done"?sos.filter(s=>s.status==="Dispatched") : sos;
      data=data.filter(s=>soMatch(s)&&MW.inDateRange(s.date, filter));
      data=data.slice().sort((a,b)=>a.date<b.date?1:-1);
      const c=UI.$("#soCount"); if(c) c.textContent=data.length+" sales orders";
      host.innerHTML="";
      host.appendChild(table(data,[
        {key:"id",label:"SO #",render:r=>`<span class="mono strong">${r.id}</span>`,sort:r=>r.id},
        {key:"cust",label:"Customer",cls:"nm",render:r=>esc(U.trim(ENG.custName(r.customerId),26)),sort:r=>ENG.custName(r.customerId)},
        {key:"lines",label:"Items",num:true,render:r=>r.lines.length,sort:r=>r.lines.length},
        {key:"value",label:"Value",num:true,render:r=>ENG.money(r.value),sort:r=>r.value},
        {key:"date",label:"Order Date",render:r=>r.date||"—",sort:r=>r.date||""},
        {key:"prio",label:"Priority",render:r=>badge(r.priority==="Urgent"?"danger":r.priority==="High"?"warn":"mut",r.priority),sort:r=>({Urgent:0,High:1,Normal:2}[r.priority])},
        {key:"promised",label:"Promised",render:r=>{const late=r.status!=="Dispatched"&&r.promised<DB.helpers.iso(DB.helpers.today());return `<span style="color:${late?'var(--danger)':'inherit'}">${r.promised}${late?" ⏰":""}</span>`;},sort:r=>r.promised},
        {key:"atp",label:"Fulfillable",render:r=>fulfillBadge(r),noSort:true},
        {key:"status",label:"Status",render:r=>badge(r.status==="Dispatched"?"ok":r.status==="In Production"?"info":"warn",r.status),sort:r=>r.status},
        {key:"act",label:"",noSort:true,render:r=>h("div",{class:"flex gap aic",style:"gap:6px;justify-content:flex-end"},[
          printBtn("so",r),
          r.status!=="Dispatched"?h("button",{class:"btn sm primary",onclick:e=>{e.stopPropagation();dispatchSO(r);},text:"Dispatch"}):h("span",{class:"muted",text:"✓"})
        ])},
      ],{onRow:r=>soDetail(r),empty:filter.q?"No sales order matches that search":"No sales orders"}));
    }
    draw();
    if(params&&params.openNew){ params.openNew=false; soForm(); }
    if(params&&params.open){ const so=sos.find(x=>x.id===params.open); params.open=null; if(so) soDetail(so); }

    function fulfillBadge(so){
      const ok=so.lines.every(l=>ENG.stock(l.itemId).onHand>=l.qty);
      const some=so.lines.some(l=>ENG.stock(l.itemId).onHand>0);
      return badge(ok?"ok":some?"warn":"danger", ok?"In stock":some?"Partial":"Make to order");
    }
    /* A line carrying a BATCH ships that work order — recorded against the run
       in Production Control, and nothing leaves the store, because nothing was
       ever booked into it. Only a line without a batch comes out of finished
       stock, and if it is not there the dispatch is refused rather than posted
       into the negative. The server enforces both; this is what says so. */
    async function dispatchSO(so){
      const fromStock=so.lines.filter(l=>!l.batch&&+l.qty>0);
      const fromBatch=so.lines.filter(l=>l.batch&&+l.qty>0);
      const short=fromStock.filter(l=>ENG.stock(l.itemId).onHand+1e-6<l.qty).map(l=>{
        const it=ENG.item(l.itemId)||{};
        return (it.name||l.itemId)+": need "+ENG.qtyText(it,l.qty,0)
             +", in store "+ENG.qtyText(it,ENG.stock(l.itemId).onHand,1);
      });
      if(short.length){
        const mo=modal({title:"Cannot dispatch "+so.id, sub:"Nothing has been posted",
          body:h("div",{},[
            h("div",{class:"qc-note bad",style:"font-size:13px;line-height:1.55"},[
              h("div",{style:"font-weight:700;margin-bottom:6px",text:"There is not enough finished stock for these lines:"}),
              h("ul",{style:"margin:0;padding-left:18px"},short.map(s=>h("li",{text:s}))),
            ]),
            h("p",{class:"muted",style:"font-size:13px;line-height:1.6;margin-top:14px",
              text:"Two ways forward. Either add the finished stock first, or open the order and give each line the batch — the work order number — it ships from. A batch ships the run itself, so it takes nothing out of the store and shows up on that job in Production Control."}),
          ]),
          foot:[h("button",{class:"btn primary",onclick:()=>mo.close(),text:"Close"})]});
        return;
      }
      const how=[ fromBatch.length?fromBatch.length+" line"+(fromBatch.length>1?"s":"")+" shipped from their batch — the store is not touched":null,
                  fromStock.length?fromStock.length+" line"+(fromStock.length>1?"s":"")+" deducted from finished stock":null
                ].filter(Boolean).join("\n");
      if(!await confirm("Dispatch "+so.id+" to "+ENG.custName(so.customerId)+"?\n\n"+how,{title:"Dispatch Order"})) return;
      const date=DB.helpers.iso(DB.helpers.today());
      /* mirror what the server is about to do, so the screen is right before
         the next state reload rather than a second behind it */
      fromStock.forEach(l=>{ ENG.data.movements.push({id:U.genMoveId()+"-"+l.itemId, date, itemId:l.itemId, wh:"WH-FG", type:"SALE",
        qty:-l.qty, rate:l.rate, ref:so.id, note:"Dispatch to "+ENG.custName(so.customerId), by:(App.user&&App.user.username)||"sales"}); });
      fromBatch.forEach(l=>{ const w=(ENG.data.workorders||[]).find(x=>x.id===l.batch); if(!w) return;
        const partial=(w.runQty!=null||w.completedQty!=null||w.pendingQty!=null);
        const made=partial?Math.round(((+w.completedQty||0)+(+w.runQty||0))*1000)/1000:(+w.qty||0);
        w.dispatchedQty=Math.min(made, Math.round(((+w.dispatchedQty||0)+(+l.qty||0))*1000)/1000);
        w.dispatchedAt=new Date().toISOString(); w.dispatchedBy=(App.user&&App.user.username)||"sales";
        w.dispatchedTo=so.id; w.dispatchedCustomer=ENG.custName(so.customerId);
        if((+w.pendingQty||0)<=1e-6) w.dispatched=true; });
      so.status="Dispatched";
      toast(so.id+" dispatched"+(fromBatch.length?" — "+fromBatch.length+" batch"+(fromBatch.length>1?"es":"")+" released, store untouched":" — stock deducted"),
        {type:"ok",title:"Dispatch posted"});
      App.saveDelta(()=>DB.sales.dispatch(so.id,{date}));  // the server is the authority; this only mirrored it
    }
    function soDetail(so){
      const {calc, interState}=docCalc("so",so);
      const gstPairs = interState
        ? [["IGST",ENG.money(calc.igst)]]
        : [["CGST",ENG.money(calc.cgst)],["SGST",ENG.money(calc.sgst)]];
      const anyBatch=so.lines.some(l=>l.batch);
      const cols=[
        {key:"item",label:"Item",render:r=>{const it=ENG.item(r.itemId)||{};const sz=lineSize(r,it);
          return `<div class="cell-main">${esc(U.trim(it.name||r.itemId,30))}</div><div class="cell-sub">${esc(sz||r.itemId)}</div>`;},noSort:true}];
      if(anyBatch) cols.push({key:"batch",label:"Batch No.",render:r=>r.batch?`<span class="mono">${esc(batchNo(r.batch))}</span>`:'<span class="muted">—</span>',noSort:true});
      cols.push(
        // the quantity is in the product's own unit — never assume kg
        {key:"qty",label:"Qty",num:true,render:r=>{const it=ENG.item(r.itemId);return it?ENG.qtyText(it,r.qty,0)+ENG.kgSuffix(it,r.qty):ENG.num(r.qty)+" kg";},noSort:true},
        {key:"stock",label:"In Stock",num:true,render:r=>{const it=ENG.item(r.itemId)||{};const h2=ENG.stock(r.itemId).onHand;const u=ENG.dispUom(it)||"kg";
          return `<span style="color:${h2>=r.qty?'var(--ok)':'var(--danger)'}">${ENG.num(ENG.dispQty(it,h2),1)} ${esc(u)}${esc(ENG.kgSuffix(it,h2))}</span>`;},noSort:true},
        {key:"rate",label:"Rate",num:true,render:r=>"₹"+ENG.num(r.rate),noSort:true},
        {key:"gst",label:"GST %",num:true,render:r=>lineGstPct(r,ENG.item(r.itemId)),noSort:true},
        {key:"amt",label:"Amount",num:true,render:r=>ENG.money(r.qty*r.rate*(1-(r.discPct||0)/100)),noSort:true});
      const body=h("div",{},[
        MW.dl([["Customer",ENG.custName(so.customerId)],["Billing Entity",companyByKey(so.company).name],
          ["Status",badge(so.status==="Dispatched"?"ok":"info",so.status)],["Priority",so.priority],
          ["Order Date",so.date],["Promised",so.promised]]
          .concat(so.invoiceNo&&so.invoiceNo!==so.id?[["Invoice No.",so.invoiceNo]]:[])
          // only worth a row when it isn't rupees — every domestic order is
          .concat(so.currency&&so.currency!=="INR"?[["Currency",CCY.full(so.currency)]]:[])
          .concat(so.custPoNo?[["Customer PO",so.custPoNo]]:[])
          .concat(so.placeOfSupply?[["Place of Supply",so.placeOfSupply+" — "+GST.stateName(so.placeOfSupply)]]:[])
          .concat(so.transportMode?[["Transport",[so.transportMode,so.vehicleNo].filter(Boolean).join(" · ")]]:[])
          .concat(so.ewayBill?[["E-Way Bill",so.ewayBill]]:[])
          .concat(so.fromLead?[["From CRM Lead","🎯 "+so.fromLead]]:[])
          // the quote this order was accepted from — one click back to what was offered
          .concat(so.fromQuote?[["From Quotation",h("a",{href:"#",class:"a-link",title:"Open "+so.fromQuote,
            onclick:e=>{ e.preventDefault(); UI.$("#modalHost").hidden=true; App.go("quotations",{tab:"quotations",open:so.fromQuote}); },text:so.fromQuote+" →"})]]:[])),
        h("h3",{style:"margin:18px 0 10px;font-size:14px",text:"Order Lines"}),
        table(so.lines,cols,{empty:"No lines"}),
        h("h3",{style:"margin:18px 0 10px;font-size:14px",text:"Tax Summary"}),
        MW.dl([["Taxable",ENG.money(calc.taxable)]].concat(gstPairs).concat([
          ["Freight",ENG.money(calc.freight)],["Insurance",ENG.money(calc.insurance)],
          ["Round Off",calc.roundOff.toFixed(2)],["Grand Total",ENG.money(calc.grandTotal)]])),
      ]);
      const foot=[h("button",{class:"btn danger",onclick:()=>deleteSO(so),text:"🗑 Delete"}),
        h("button",{class:"btn",onclick:()=>printDoc("so",so),html:PRINT_IC+" Print Invoice"})];
      if(so.status!=="Dispatched"){
        foot.push(h("button",{class:"btn ghost",onclick:()=>{UI.$("#modalHost").hidden=true;soForm(so);},text:"✎ Edit"}));
        foot.push(h("button",{class:"btn primary",onclick:()=>{UI.$("#modalHost").hidden=true;dispatchSO(so);},text:"Dispatch"}));
      }
      modal({title:so.id, sub:ENG.custName(so.customerId), wide:true, body, foot});
    }

    async function deleteSO(so){
      const sale=ENG.data.movements.filter(m=>m.ref===so.id);
      const msg=sale.length
        ? `Delete ${so.id}? This also removes ${sale.length} dispatch movement(s), returning that stock.`
        : `Delete ${so.id}? This sales order will be permanently removed.`;
      if(!await confirm(msg,{title:"Delete Sales Order",danger:true})) return;
      ENG.data.salesorders=ENG.data.salesorders.filter(s=>s.id!==so.id);
      if(sale.length) ENG.data.movements=ENG.data.movements.filter(m=>m.ref!==so.id);
      UI.$("#modalHost").hidden=true;
      toast(`${so.id} deleted`,{type:"ok",title:"Removed"});
      App.saveDelta(()=>DB.sales.remove(so.id));  // server also reverses its SALE movements
    }

    /* ---- Tally-style SO entry: mirrors the tax invoice field-for-field ---- */
    function soForm(arg){
      const editSo=(arg && typeof arg==="object" && arg.id)?arg:null;
      const custs=ENG.data.customers; const fgs=ENG.data.items.filter(i=>i.cat==="FG");
      const soId=editSo?editSo.id:U.nextSeqId(ENG.data.salesorders,"SO-");
      let lines=[];
      const totBox=h("div");
      const cust0=editSo?custs.find(c=>c.id===editSo.customerId):custs[0];
      const sec=docSec;
      const body=h("div",{},[
        sec("Parties"),
        h("div",{class:"form-grid g3"},[
          U.field("Billing Company (invoice under) *",U.selectHTML("so_co",companyOpts(),editSo?editSo.company:companies()[0].key)),
          U.field("Customer (Bill To) *",U.searchSelect("so_cust",custs.map(c=>({v:c.id,l:c.name})),editSo?editSo.customerId:(cust0&&cust0.id),"Search customer…")),
          U.field("Place of Supply",U.selectHTML("so_pos",stateOpts(),
            (editSo&&editSo.placeOfSupply)||partyStateCode(cust0)||"29")),
          U.field("Ship To (delivery address)",`<textarea class="input" id="so_ship" rows="2" placeholder="same as billing">${esc(editSo?(editSo.shipTo||""):(cust0&&(cust0.shipTo||cust0.address)||""))}</textarea>`,"full"),
        ]),
        sec("Invoice Details"),
        h("div",{class:"form-grid g3"},[
          U.field("Invoice Type",U.selectHTML("so_itype",[{v:"domestic",l:"Domestic — GST Tax Invoice"},{v:"export",l:"Export — Commercial Invoice"}],editSo?(editSo.invoiceType||"domestic"):"domestic")),
          /* A new order opens in the CUSTOMER'S currency — the one their master
             record carries, derived from their country. Every currency is on
             offer, not the old six, because a client can be anywhere; the live
             rate under the box is Google's, for the desk's own sanity check. */
          U.field("Currency",
            U.searchSelect("so_ccy",CCY.options(),editSo?(editSo.currency||"INR"):custCcy(cust0),"Search currency…")
            +`<div class="muted" id="so_rate" style="font-size:11px;margin-top:5px;line-height:1.4"></div>`),
          U.field("Invoice No.",`<input class="input" id="so_inv" value="${esc(editSo?(editSo.invoiceNo||editSo.id):soId)}">`),
          U.field("Order Date",`<input class="input" id="so_date" type="date" value="${editSo?(editSo.date||""):DB.helpers.iso(DB.helpers.today())}">`),
          U.field("Promised / Due Date",`<input class="input" id="so_prom" type="date" value="${editSo?editSo.promised:DB.helpers.daysAhead(10)}">`),
          U.field("Priority",U.selectHTML("so_prio",[{v:"Normal",l:"Normal"},{v:"High",l:"High"},{v:"Urgent",l:"Urgent"}],editSo?editSo.priority:"Normal")),
          U.field("Customer PO No.",`<input class="input" id="so_cpo" value="${esc(editSo?(editSo.custPoNo||""):"")}" placeholder="optional">`),
          U.field("Customer PO Date",`<input class="input" id="so_cpod" type="date" value="${editSo?(editSo.custPoDate||""):""}">`),
        ]),
        sec("Transport & Dispatch"),
        h("div",{class:"form-grid g3"},[
          U.field("Transport Mode",U.selectHTML("so_tmode",TRANSPORT_MODES,editSo?(editSo.transportMode||""):"")),
          U.field("Transporter",U.selectHTML("so_transp",[{v:"",l:"—"}].concat((ENG.data.transporters||[]).filter(t=>t.active!==false).map(t=>({v:t.id,l:t.name}))),editSo?(editSo.transporterId||""):"")),
          U.field("Vehicle No.",`<input class="input" id="so_veh" value="${esc(editSo?(editSo.vehicleNo||""):"")}" placeholder="e.g. KA 52 AB 1234">`),
          U.field("E-Way Bill No.",`<input class="input" id="so_eway" value="${esc(editSo?(editSo.ewayBill||""):"")}" placeholder="optional">`),
          U.field("LR / RR No.",`<input class="input" id="so_lr" value="${esc(editSo?(editSo.lrNo||""):"")}" placeholder="optional">`),
          U.field("Dispatch Date",`<input class="input" id="so_ddate" type="date" value="${esc(editSo?(editSo.dispatchDate||""):"")}">`),
        ]),
        h("div",{id:"so_export",hidden:!(editSo&&editSo.invoiceType==="export")},[
          sec("Export / Shipment (Commercial Invoice)"),
          h("div",{class:"form-grid g3"},[
            U.field("Other Reference",`<input class="input" id="so_oref" value="${esc(editSo?(editSo.otherRef||""):"")}">`),
            U.field("Consignee",`<input class="input" id="so_consignee" value="${esc(editSo?(editSo.consignee||"TO THE ORDER"):"TO THE ORDER")}">`),
            U.field("Notify Party",`<textarea class="input" id="so_notify" rows="2" placeholder="buyer name, address, phone, e-mail">${esc(editSo?(editSo.notifyParty||""):"")}</textarea>`,"full"),
            U.field("Pre-Carriage By",`<input class="input" id="so_precar" value="${esc(editSo?(editSo.preCarriage||""):"")}">`),
            U.field("Place of Receipt",`<input class="input" id="so_prcpt" value="${esc(editSo?(editSo.placeReceipt||"Bangalore"):"Bangalore")}">`),
            U.field("Vessel / Flight No.",`<input class="input" id="so_vessel" value="${esc(editSo?(editSo.vessel||"By Sea"):"By Sea")}">`),
            U.field("Port of Loading",`<input class="input" id="so_pload" value="${esc(editSo?(editSo.portLoading||"Nhava Sheva, Mumbai, India"):"Nhava Sheva, Mumbai, India")}">`),
            U.field("Port of Discharge",`<input class="input" id="so_pdis" value="${esc(editSo?(editSo.portDischarge||""):"")}">`),
            U.field("Final Destination",`<input class="input" id="so_fdest" value="${esc(editSo?(editSo.finalDest||""):"")}">`),
            U.field("Country of Final Destination",`<input class="input" id="so_cdest" value="${esc(editSo?(editSo.countryDest||""):"")}">`),
            U.field("Terms of Delivery",`<input class="input" id="so_dterms" value="${esc(editSo?(editSo.deliveryTerms||""):"")}" placeholder="e.g. CIF King Abdulla port">`),
            U.field("Marks & Nos / Kind of Pkgs",`<input class="input" id="so_marks" value="${esc(editSo?(editSo.marksPkgs||""):"")}" placeholder="e.g. (14) Pallets containing">`),
            U.field("Net Weight (kgs)",`<input class="input" id="so_netwt" value="${esc(editSo?(editSo.netWt||""):"")}">`),
            U.field("Gross Weight (kgs)",`<input class="input" id="so_grosswt" value="${esc(editSo?(editSo.grossWt||""):"")}">`),
            U.field("Export Note (printed bold on the invoice)",`<textarea class="input" id="so_exnote" rows="2">${esc(editSo?(editSo.exportNote!=null?editSo.exportNote:"SUPPLY MEANT FOR EXPORT UNDER PAYMENT OF IGST @ 18%\nEXPORT UNDER DRAWBACK"):"SUPPLY MEANT FOR EXPORT UNDER PAYMENT OF IGST @ 18%\nEXPORT UNDER DRAWBACK")}</textarea>`,"full"),
          ]),
        ]),
        sec("Goods sold"),
        h("div",{id:"so_lines",class:"doc-lines"}),
        h("button",{class:"btn sm doc-add",onclick:()=>addLine(),html:"＋ Add line"}),
        sec("Payment & notes"),
        h("div",{class:"form-grid g3"},[
          U.field("Payment Terms",`<input class="input" id="so_terms" value="${esc(editSo?(editSo.payTerms||""):(cust0&&cust0.terms||"30 days"))}">`),
          U.field("Notes",`<input class="input" id="so_notes" value="${esc(editSo?(editSo.notes||""):"")}" placeholder="shown on the invoice">`,"full"),
        ]),
        h("div",{class:"doc-tot"},totBox),
      ]);
      const mo=modal({title:editSo?("Edit "+editSo.id):"New Sales Order", sub:editSo?"Update this sales order":"Everything here flows straight onto the tax invoice", xwide:true, wide:true, body,
        foot:[h("button",{class:"btn ghost",onclick:()=>mo.close(),text:"Cancel"}),
          h("button",{class:"btn",onclick:printDraft,html:PRINT_IC+" Print"}),
          h("button",{class:"btn primary",onclick:save,text:editSo?"Save Changes":"Create Order"})]});
      body.addEventListener("input",recalc);
      body.addEventListener("change",recalc);
      // invoice-type switch shows/hides the export section; notify party
      // defaults to the buyer's block the first time export is chosen
      const itypeEl=UI.$("#so_itype");
      if(itypeEl) itypeEl.addEventListener("change",()=>{
        const ex=itypeEl.value==="export";
        UI.$("#so_export").hidden=!ex;
        if(ex&&!UI.$("#so_notify").value){
          const c=custs.find(x=>x.id===UI.$("#so_cust").value)||{};
          UI.$("#so_notify").value=[c.name,c.address||c.city,c.phone,c.email].filter(Boolean).join("\n");
        }
        /* Switching to an export invoice off rupees: take the buyer's own
           currency if their master record names one, and only fall back to
           dollars when it doesn't (an Indian party invoiced for export). */
        if(ex&&UI.$("#so_ccy").value==="INR"){
          const c=custs.find(x=>x.id===UI.$("#so_cust").value);
          const want=custCcy(c);
          U.ssSet("so_ccy", want==="INR"?"USD":want);
        }
        recalc();
      });
      // customer switch refreshes place of supply, ship-to, payment terms and
      // the currency their invoice is raised in
      const custHid=UI.$("#so_cust");
      if(custHid) custHid.addEventListener("change",()=>{
        const c=custs.find(x=>x.id===custHid.value); if(!c) return;
        const posEl=UI.$("#so_pos"); const sc=partyStateCode(c); if(posEl&&sc) posEl.value=sc;
        const shipEl=UI.$("#so_ship"); if(shipEl) shipEl.value=c.shipTo||c.address||"";
        const tEl=UI.$("#so_terms"); if(tEl&&c.terms) tEl.value=c.terms;
        const want=custCcy(c);
        if(UI.$("#so_ccy") && UI.$("#so_ccy").value!==want) U.ssSet("so_ccy",want);
        // the commercial invoice asks for the destination country; the client's
        // own country is the answer unless the desk has already typed one
        const cdEl=UI.$("#so_cdest");
        if(cdEl && !cdEl.value.trim() && custCountry(c)!=="India") cdEl.value=custCountry(c);
        recalc();
      });
      // the live Google rate under the currency box, kept in step with it
      const soCcyEl=UI.$("#so_ccy"), soRateEl=UI.$("#so_rate");
      if(soCcyEl) soCcyEl.addEventListener("change",()=>ccyRateLine(soRateEl,soCcyEl.value));
      ccyRateLine(soRateEl, soCcyEl?soCcyEl.value:"INR");
      /* Batch = the work order this line is served from. Only FINISHED jobs
         appear, each with the quantity still unclaimed, so an order is filled
         from what the floor has actually produced. */
      function batchOpts(itemId){
        /* A JOB ALREADY ON AN ORDER IS NOT ON OFFER — whatever quantity that
           order was for. The batch says which goods this line is served from,
           so it belongs to one order; the quantity is the customer's business
           and may be far larger than the run (the balance is made to order).
           Filtering on what is left over would keep a batch on the list after
           a small order had taken it, which is the thing being fixed. The
           server refuses a second claim as well; this keeps the desk from
           reaching for something already spoken for. */
        const ready=ENG.readyBatches(itemId).filter(b=>!(b.claimed>0.0001));
        const uom=(ENG.item(itemId)||{}).uom||"kg";
        // the batch reads as its plain number, carrying the run's size and the
        // quantity still free, so the operator picks the right ready stock
        const custName=id=>{ const c=(ENG.data.customers||[]).find(x=>x.id===id); return c?(c.name||c.id):null; };
        const opts=ready.map(b=>{
          const size=lineSize({itemId:b.itemId,width:b.widthMM});
          /* Who the run was made FOR, where the office named someone. A batch
             run for this very customer is the one the desk wants, and a batch
             run for a DIFFERENT one is worth seeing before it is claimed. */
          const forWhom=custName(b.customerId);
          /* The same three figures the hint below uses, so the two agree. The
             unit is stated once, on the first figure — the desk was reading
             bare numbers and could not tell kg from metres. */
          return {v:b.id, l:batchNo(b.id)+(size?" · "+size:"")
            +" · "+ENG.num(b.ordered,1)+" "+uom+" ordered · "+ENG.num(b.made,1)+" produced"
            +(b.pending>0.001?" · "+ENG.num(b.pending,1)+" pending":"")
            +(forWhom?" · for "+forWhom:"")};
        });
        // keep a batch that is already on this order even once fully claimed
        (editSo&&editSo.lines||[]).forEach(l=>{
          if(l.batch && l.itemId===itemId && !opts.some(o=>o.v===l.batch)) opts.push({v:l.batch,l:batchNo(l.batch)});
        });
        return [{v:"",l:ready.length?"— pick a finished job —":"— nothing finished yet —"}].concat(opts);
      }
      /* a line-level note: what is standing ready for the product picked */
      /* What is genuinely available against each finished job. A work order
         that is still owing quantity has produced only part of it, so the
         order is broken out — total, made, pending — rather than quoting the
         ordered figure as if it were all standing ready. */
      function readyHint(itemId){
        /* the same list the picker offers — a job already on an order is not
           standing ready for anybody, so quoting it would contradict the box */
        const ready=ENG.readyBatches(itemId).filter(b=>!(b.claimed>0.0001));
        const uom=(ENG.item(itemId)||{}).uom||"kg";
        if(!ready.length) return "No finished job for this product yet — it can still be ordered and made to order.";
        /* One wording for every job, part-made or complete — a finished order
           simply reads 0 still pending. The desk should not have to decode two
           different formats to answer the same question. */
        const many=ready.length>1;
        const each=ready.slice(0,3).map(b=>{
          let s=(many?batchNo(b.id)+" — ":"")
            +ENG.num(b.ordered,1)+" "+uom+" ordered · "+ENG.num(b.made,1)+" produced · "
            +ENG.num(b.pending,1)+" still pending";
          // only worth saying when some of what was made is no longer available
          if(Math.abs(b.free-b.made)>0.001) s+=" · "+ENG.num(b.free,1)+" free to sell";
          return s;
        });
        return each.join("    ·    ")+(ready.length>3?" …":"");
      }
      function collect(){ const out=[];
        lines.forEach((_,i)=>{ if(!lines[i]) return; const iEl=UI.$("#sl_item_"+i); if(!iEl) return;
          const id=iEl.value, qty=+UI.$("#sl_qty_"+i).value, rate=+UI.$("#sl_rate_"+i).value;
          const batch=UI.$("#sl_batch_"+i).value||"";
          // the width is the one the batch was slit to — never an assumed default
          if(id&&qty>0) out.push({itemId:id, qty, rate:rate||ENG.item(id).price,
            width:lineWidth({itemId:id, batch})||null,
            hsn:(UI.$("#sl_hsn_"+i).value||"").trim(), batch,
            discPct:+UI.$("#sl_disc_"+i).value||0, gstPct:+UI.$("#sl_gst_"+i).value||0}); });
        return out; }
      function draft(){
        const g=id=>{const el=UI.$("#"+id);return el?el.value:"";};
        const o={ id:soId, date:g("so_date")||DB.helpers.iso(DB.helpers.today()),
          customerId:g("so_cust"), company:g("so_co"),
          invoiceType:g("so_itype"), currency:g("so_ccy"),
          invoiceNo:g("so_inv").trim()||soId,
          placeOfSupply:g("so_pos"), shipTo:g("so_ship").trim(),
          custPoNo:g("so_cpo").trim(), custPoDate:g("so_cpod"),
          transportMode:g("so_tmode"), transporterId:g("so_transp"),
          vehicleNo:g("so_veh").trim(), ewayBill:g("so_eway").trim(),
          lrNo:g("so_lr").trim(), dispatchDate:g("so_ddate"),
          payTerms:g("so_terms").trim(), notes:g("so_notes").trim(),
          otherRef:g("so_oref").trim(), consignee:g("so_consignee").trim(),
          notifyParty:g("so_notify").trim(), preCarriage:g("so_precar").trim(),
          placeReceipt:g("so_prcpt").trim(), vessel:g("so_vessel").trim(),
          portLoading:g("so_pload").trim(), portDischarge:g("so_pdis").trim(),
          finalDest:g("so_fdest").trim(), countryDest:g("so_cdest").trim(),
          deliveryTerms:g("so_dterms").trim(), marksPkgs:g("so_marks").trim(),
          netWt:g("so_netwt").trim(), grossWt:g("so_grosswt").trim(),
          exportNote:g("so_exnote").trim(),
          lines:collect(),
          freight:+(UI.$("#so_fr")&&UI.$("#so_fr").value)||0,
          insurance:+(UI.$("#so_ins")&&UI.$("#so_ins").value)||0,
          status:editSo?editSo.status:"Confirmed",
          promised:g("so_prom"), priority:g("so_prio") };
        if(o.invoiceType==="export"){
          // export supply: line values only, no GST added on top (IGST note prints instead)
          const sub=o.lines.reduce((s,l)=>s+l.qty*l.rate*(1-(l.discPct||0)/100),0);
          o.value=+(sub+o.freight+o.insurance).toFixed(2);
        } else {
          o.value=docCalc("so",o).calc.grandTotal;
        }
        return o;
      }
      function recalc(){
        const o=draft();
        renderTotals(totBox, docCalc("so",o),
          {freightId:"so_fr", freight:o.freight, insuranceId:"so_ins", insurance:o.insurance,
           exportCcy:o.invoiceType==="export"?o.currency:null});
      }
      function printDraft(){
        const o=draft();
        if(!o.lines.length){ toast("Add at least one line with qty to print",{type:"warn"}); return; }
        printDoc("so",Object.assign({},o,{status:editSo?editSo.status:"Draft — not saved"}));
      }
      function addLine(seed){ const idx=lines.length; lines.push({});
        const itemId=seed?seed.itemId:(fgs[0]&&fgs[0].id);
        const it=ENG.item(itemId)||{};
        const qtyVal=(seed&&seed.qty!=null)?seed.qty:"";
        const rateVal=(seed&&seed.rate!=null)?seed.rate:(it.price||"");
        /* A sales line is in the PRODUCT'S OWN unit — that is the unit the
           dispatch movement is posted in, and mica tape is stocked in metres,
           not kg. The label says which, and the other unit is shown beside it
           purely so the desk can talk to a customer who orders the other way.
           The equivalent is a working aid only and never reaches the invoice. */
        const sQtyEl=h("input",{class:"input",id:"sl_qty_"+idx,type:"number",placeholder:"0",value:qtyVal});
        const sConvEl=h("div",{class:"muted",id:"sl_conv_"+idx,style:"font-size:11px;margin-top:3px"});
        const sSyncConv=(x)=>{
          const kpm=kgPerMetre(x), q=+sQtyEl.value||0;
          const u=BOMCALC.normUnit((x&&x.uom)||"KG");
          if(!kpm||!(q>0)||(u!=="KG"&&u!=="MTR")){ sConvEl.textContent=""; return; }
          const basis=" ("+ENG.num(x.gsm,0)+" g/m² × "+ENG.num(x.width,0)+" mm)";
          sConvEl.textContent=u==="MTR"
            ? "= "+ENG.num(q*kpm,1)+" KG"+basis
            : "= "+ENG.num(q/kpm,1)+" MTR"+basis;
        };
        const row=docLine(idx + 1,
          h("div",{html:U.searchSelect("sl_item_"+idx,fgs.map(i=>({v:i.id,l:i.name+(i.thicknessMM!=null?" · "+i.thicknessMM+" mm":"")+" — "+(i.typeCode||i.id)})),itemId,"Search product…")}),
          [
            ["HSN",         h("input",{class:"input",id:"sl_hsn_"+idx,placeholder:"HSN",value:(seed&&seed.hsn)||it.hsn||""})],
            ["Batch (W.O.)",h("div",{html:U.selectHTML("sl_batch_"+idx,batchOpts(itemId),(seed&&seed.batch)||"")})],
            ["Qty ("+((it.uom||"kg"))+")", sQtyEl],
            ["Rate",        h("input",{class:"input",id:"sl_rate_"+idx,type:"number",placeholder:"0.00",value:rateVal})],
            ["Disc %",      h("input",{class:"input",id:"sl_disc_"+idx,type:"number",placeholder:"0",value:(seed&&seed.discPct)||""})],
            ["GST %",       h("input",{class:"input",id:"sl_gst_"+idx,type:"number",placeholder:"18",value:(seed&&seed.gstPct!=null)?seed.gstPct:lineGstPct(seed,it)})],
          ],
          el=>{ el.remove(); lines[idx]=null; recalc(); });
        // what the floor already has finished and reserved for this product
        row.appendChild(h("div",{class:"so-ready",id:"sl_ready_"+idx,text:readyHint(itemId)}));
        UI.$("#so_lines").appendChild(row);
        const sQtyCell=sQtyEl.closest(".doc-line-f"); if(sQtyCell) sQtyCell.appendChild(sConvEl);
        // the label carries the product's unit, so it has to move with the product
        const sQtyLab=sQtyCell&&sQtyCell.querySelector("label");
        const sSyncUom=(x)=>{ if(sQtyLab) sQtyLab.textContent="Qty ("+((x&&x.uom)||"kg")+")"; };
        sSyncConv(it);
        sQtyEl.addEventListener("input",()=>sSyncConv(ENG.item(UI.$("#sl_item_"+idx).value)||{}));
        // picking a product refreshes HSN, GST, rate default + its batch (WO) list
        const hid=UI.$("#sl_item_"+idx);
        if(hid) hid.addEventListener("change",()=>{ const ni=ENG.item(hid.value)||{}; sSyncConv(ni); sSyncUom(ni);
          UI.$("#sl_hsn_"+idx).value=ni.hsn||""; UI.$("#sl_gst_"+idx).value=lineGstPct(null,ni);
          if(!UI.$("#sl_rate_"+idx).value) UI.$("#sl_rate_"+idx).value=ni.price||"";
          const bSel=UI.$("#sl_batch_"+idx);
          if(bSel){ bSel.innerHTML=batchOpts(hid.value).map(o=>`<option value="${esc(o.v)}">${esc(o.l)}</option>`).join(""); }
          const rEl=UI.$("#sl_ready_"+idx);
          if(rEl) rEl.textContent=readyHint(hid.value);
          recalc(); });
      }
      if(editSo) editSo.lines.forEach(l=>addLine(l)); else addLine();
      recalc();
      function save(){
        const o=draft();
        if(!o.lines.length){ toast("Add at least one line",{type:"warn"}); return; }
        if(editSo){
          const patch={customerId:o.customerId, company:o.company, invoiceNo:o.invoiceNo,
            invoiceType:o.invoiceType, currency:o.currency,
            placeOfSupply:o.placeOfSupply, shipTo:o.shipTo, custPoNo:o.custPoNo, custPoDate:o.custPoDate,
            transportMode:o.transportMode, transporterId:o.transporterId, vehicleNo:o.vehicleNo,
            ewayBill:o.ewayBill, lrNo:o.lrNo, dispatchDate:o.dispatchDate, payTerms:o.payTerms,
            notes:o.notes, priority:o.priority, promised:o.promised, date:o.date,
            otherRef:o.otherRef, consignee:o.consignee, notifyParty:o.notifyParty,
            preCarriage:o.preCarriage, placeReceipt:o.placeReceipt, vessel:o.vessel,
            portLoading:o.portLoading, portDischarge:o.portDischarge, finalDest:o.finalDest,
            countryDest:o.countryDest, deliveryTerms:o.deliveryTerms, marksPkgs:o.marksPkgs,
            netWt:o.netWt, grossWt:o.grossWt, exportNote:o.exportNote,
            lines:o.lines, freight:o.freight, insurance:o.insurance, value:o.value};
          Object.assign(editSo,patch);
          mo.close(); toast(editSo.id+" updated",{type:"ok"});
          App.saveDelta(()=>DB.sales.update(editSo.id,patch));
        } else {
          const so=o;
          ENG.data.salesorders.push(so);
          mo.close(); tab="open"; toast(so.id+" created",{type:"ok"});
          App.saveDelta(()=>DB.sales.create(so));
        }
      }
    }
  }};

  /* ============== SUPPLIERS ============== */
  M.suppliers = { title:"Suppliers", sub:"Vendor master & performance", render(root){
    root.appendChild(pageHead("Suppliers","Vendor performance, spend and supplied items",[
      MW.excelMenu("suppliers"),
      h("button",{class:"btn primary",onclick:()=>supplierForm(),html:"＋ New Supplier"})
    ]));
    const spend=ENG.purchaseBySupplier(365);
    const spendMap={}; spend.forEach(s=>spendMap[s.id]=s.value);
    const sf=App.viewState("filter",()=>({q:"",qRaw:""}));   // the search survives a quiet refresh
    let q=sf.q;
    root.appendChild(h("div",{class:"toolbar"},[
      MW.searchInput("Search supplier, city, category, GSTIN, contact, item…", v=>{sf.qRaw=v;q=sf.q=v.toLowerCase().trim();draw();}, sf.qRaw),
      h("div",{style:"margin-left:auto"},h("span",{class:"chip",id:"supCount"}))
    ]));
    const host=h("div"); root.appendChild(host);
    /* A vendor is looked up by name, but just as often by what they supply
       ("who sells us mica?") or by where they are — so the items they feed us
       are part of the haystack, not just the card's own fields. */
    function supMatch(s){
      if(!q) return true;
      const hay=[s.name, s.city, s.country, s.category, s.gst, s.contact, s.phone, s.email, s.terms, s.rating]
        .concat(ENG.data.items.filter(i=>i.supplierId===s.id).map(i=>i.name+" "+i.id));
      return hay.filter(Boolean).join(" ").toLowerCase().includes(q);
    }
    function draw(){
      const list=ENG.data.suppliers.filter(supMatch);
      const cnt=UI.$("#supCount"); if(cnt) cnt.textContent=list.length+(list.length===1?" supplier":" suppliers");
      host.innerHTML="";
      if(!list.length){
        host.appendChild(h("div",{class:"empty"},[h("div",{class:"big",text:"🔍"}),h("div",{text:"No supplier matches that search"})]));
        return;
      }
      const grid=h("div",{class:"grid cols-2"});
      list.forEach(s=>{
        const items=ENG.data.items.filter(i=>i.supplierId===s.id);
        grid.appendChild(h("div",{class:"card hover"},[
          h("div",{class:"flex between aic"},[
            h("div",{},[h("h3",{style:"font-size:15px",text:s.name}),h("div",{class:"muted",style:"font-size:12px",text:[s.city,s.country].filter(Boolean).join(", ")+" · "+(s.category||"General")})]),
            h("div",{class:"avatar",style:"background:linear-gradient(135deg,var(--c"+((ENG.data.suppliers.indexOf(s)%8)+1)+"),var(--accent-600))",text:s.name.slice(0,2).toUpperCase()})
          ]),
          // statgrid-3: three tiny figures — they stay side by side on a phone
          h("div",{class:"grid cols-3 statgrid-3",style:"margin:14px 0;gap:8px"},[
            stat("Rating","★ "+s.rating), stat("On-Time",s.onTime+"%"), stat("Terms",s.terms),
          ]),
          s.gst?h("div",{class:"muted",style:"font-size:12px;margin-bottom:8px",text:"GSTIN "+s.gst+(partyStateCode(s)?" · "+GST.stateName(partyStateCode(s)):"")}):null,
          h("div",{style:"margin-bottom:10px"},[ h("div",{class:"flex between",style:"font-size:11px;margin-bottom:4px"},[h("span",{class:"muted",text:"On-time delivery"}),h("span",{class:"muted",text:s.onTime+"%"})]), h("div",{html:meter(s.onTime,s.onTime>92?"ok":s.onTime>85?"warn":"danger")}) ]),
          h("div",{class:"flex between",style:"font-size:13px;padding-top:10px;border-top:1px solid var(--line)"},[
            h("span",{class:"muted",text:items.length+" items supplied"}),
            h("span",{class:"strong",text:ENG.money(spendMap[s.id]||0)+" / yr"})
          ]),
          h("div",{class:"contact-line",style:"font-size:12px;margin-top:8px"},[
            "👤 "+(s.contact||"—")+" · ", MW.phoneCell(s.phone),
            ...(s.email ? [" · ", MW.emailLink(s.email,{mode:"compose"})] : []),
          ]),
          h("div",{class:"flex gap",style:"margin-top:12px;padding-top:10px;border-top:1px solid var(--line);justify-content:flex-end"},[
            // delete lives inside the Edit dialog, not on the card
            h("button",{class:"btn sm ghost",onclick:()=>supplierForm(s),text:"✎ Edit"}),
          ])
        ]));
      });
      host.appendChild(grid);
    }
    draw();
  }};

  /* ============== CUSTOMERS ============== */
  /* Where the client is, and what their invoice is raised in. A record saved
     before these fields existed falls back through its country to India/INR,
     so nothing in the list reads as blank or broken.
     Module level, NOT inside a render closure: the sales order form reads them
     too, and losing them is what made "＋ New Sales Order" throw
     "custCcy is not defined" and open nothing at all. */
  function custCountry(c){ const k=CCY.country(c&&c.country); return k?k.name:((c&&c.country)||"India"); }
  function custCcy(c){ return String((c&&c.currency)||CCY.forCountry(c&&c.country)||"INR").toUpperCase(); }

  M.customers = { title:"Customers", sub:"Client master & orders", render(root,params){
    root.appendChild(pageHead("Customers","HT cable manufacturers and order history",[
      MW.excelMenu("customers"),
      h("button",{class:"btn primary",onclick:()=>customerForm(),html:"＋ New Customer"})
    ]));
    /* The tab lives in App.params, not a local, because every save goes
       through reloadState → refreshView, which re-renders this module from
       scratch. Without this, raising a complaint snapped the page back to
       "All customers" and the row you had just created was out of sight. */
    const cf=App.viewState("filter",()=>({q:"",qRaw:""}));   // the search survives a quiet refresh
    let q=cf.q, tab=(params&&params.tab)||"all";
    /* Two views of the same list. "Gone quiet" is not a filter on a field —
       it is worked out from each client's own ordering rhythm (ENG.dormantCustomers),
       so it can only be a tab, not a search term. */
    const quiet=ENG.dormantCustomers();
    const openCmp=(ENG.data.complaints||[]).filter(c=>c.status==="Open"||c.status==="Investigating").length;
    const seg=h("div",{class:"seg",style:"margin-bottom:12px"},[
      h("button",{class:tab==="all"?"on":"",text:"All customers",onclick:e=>setTab("all",e.currentTarget)}),
      h("button",{class:tab==="quiet"?"on":"",html:"Gone quiet"+(quiet.length?' <span class="chip" style="margin-left:6px">'+quiet.length+"</span>":""),
        onclick:e=>setTab("quiet",e.currentTarget)}),
      h("button",{class:tab==="complaints"?"on":"",html:"Complaints"+(openCmp?' <span class="chip" style="margin-left:6px;color:var(--danger)">'+openCmp+"</span>":""),
        onclick:e=>setTab("complaints",e.currentTarget)})
    ]);
    root.appendChild(seg);
    function setTab(t,btn){
      tab=t; App.params=Object.assign({},App.params||{},{tab:t});
      [...seg.children].forEach(c=>c.classList.remove("on")); btn.classList.add("on"); draw();
    }
    root.appendChild(h("div",{class:"toolbar"},[
      MW.searchInput("Search customer, city, country, currency, GSTIN, contact…", v=>{cf.qRaw=v;q=cf.q=v.toLowerCase().trim();draw();}, cf.qRaw),
      h("div",{style:"margin-left:auto"},h("span",{class:"chip",id:"custCount"}))
    ]));
    const host=h("div"); root.appendChild(host);
    /* Grade and SO number are in here too: "grade a" narrows to the key
       accounts, and pasting an SO number finds whose order it is. Country and
       currency match on the code, the symbol-less short form AND the full name,
       so "usd", "dollar" and "united states" all find the same accounts. */
    /* the complaint register: open first, then by date */
    function drawComplaints(){
      const all=(ENG.data.complaints||[]).slice();
      const rank={Open:0,Investigating:1,Resolved:2,Rejected:3};
      const rows=all.filter(c=>!q || [c.id,ENG.custName(c.customerId),c.batch,c.claim,c.status].join(" ").toLowerCase().includes(q))
        .sort((a,b)=>(rank[a.status]-rank[b.status]) || (a.raised<b.raised?1:-1));
      const cnt=UI.$("#custCount"); if(cnt) cnt.textContent=rows.length+(rows.length===1?" complaint":" complaints");
      host.innerHTML="";
      host.appendChild(h("div",{class:"flex between aic wrap gap",style:"margin-bottom:10px"},[
        h("div",{class:"muted",style:"font-size:13px",
          text:"A complaint is tied to the batch it came from, so the lab reading settles it and every other customer holding that batch is one click away."}),
        h("button",{class:"btn primary sm",onclick:()=>complaintForm(),html:"＋ Raise complaint"})
      ]));
      if(!rows.length){
        host.appendChild(h("div",{class:"empty"},[h("div",{class:"big",text:"✓"}),
          h("div",{text:all.length?"No complaint matches that search":"No complaints on record"})]));
        return;
      }
      const tone=s=>s==="Open"?"danger":s==="Investigating"?"warn":s==="Resolved"?"ok":"mut";
      host.appendChild(table(rows,[
        {key:"id",label:"Complaint",render:r=>`<b>${esc(r.id)}</b><div class="muted" style="font-size:12px">${esc(r.raised||"")}${r.via?" · via "+esc(r.via):""}</div>`,sort:r=>r.id},
        {key:"customer",label:"Customer",render:r=>esc(ENG.custName(r.customerId)),sort:r=>ENG.custName(r.customerId)},
        {key:"batch",label:"Batch",render:r=>r.batch?`<span class="mono">${esc(r.batch)}</span>`:'<span class="muted">—</span>',sort:r=>r.batch||""},
        {key:"claim",label:"Claim",render:r=>esc(String(r.claim||"").slice(0,90))+(String(r.claim||"").length>90?"…":""),noSort:true},
        {key:"status",label:"Status",render:r=>badge(tone(r.status),r.status),sort:r=>rank[r.status]},
        {key:"go",label:"",noSort:true,render:r=>`<button class="btn sm" data-cmp="${esc(r.id)}">Open</button>`}
      ]));
      /* delegated for the same reason as the quiet list: table() rebuilds
         its tbody on every sort and would drop per-row handlers */
      host.onclick=(e)=>{
        const b=e.target.closest && e.target.closest("[data-cmp]");
        if(!b) return;
        const c=(ENG.data.complaints||[]).find(x=>x.id===b.dataset.cmp);
        if(c) complaintDetail(c);
      };
    }

    /* the quiet list: who has broken their own ordering rhythm */
    function drawQuiet(){
      const rows=quiet.filter(r=>!q || (r.name||"").toLowerCase().includes(q));
      const cnt=UI.$("#custCount"); if(cnt) cnt.textContent=rows.length+(rows.length===1?" gone quiet":" gone quiet");
      host.innerHTML="";
      if(!rows.length){
        host.appendChild(h("div",{class:"empty"},[h("div",{class:"big",text:"✓"}),
          h("div",{text:quiet.length?"No match in the quiet list":"Everybody who buys regularly has ordered recently"}),
          h("div",{class:"muted",style:"font-size:13px;margin-top:6px",
            text:"A customer needs three past orders before a rhythm can be read from them."})]));
        return;
      }
      /* the nudge: one WhatsApp per quiet account, drafted from their own last
         order, so the desk never types a customer's history from memory */
      const custOf=(r)=>ENG.data.customers.find(x=>x.id===r.id)||{};
      const quietText=(r)=>{
        const c=custOf(r);
        const so=(ENG.data.salesorders||[]).find(s=>s.id===r.lastSO);
        const it=so&&so.lines&&so.lines[0]?ENG.item(so.lines[0].itemId):null;
        return "Hello "+waWho(c.contact)+", it has been a while since your last order ("+(r.lastSO||"—")+", "+(r.lastDate||"—")+"). Do let me know if you need "+((it&&it.name)||"our tapes")+" again — happy to hold the same rates for you.";
      };
      const chase=rows.filter(r=>r.level==="chase"&&MW.phoneDigits(custOf(r).phone));
      host.appendChild(h("div",{class:"flex between aic wrap gap",style:"margin-bottom:10px"},[
        h("div",{class:"muted",style:"font-size:13px;flex:1 1 360px",
          text:"Worked out from each client's own order history — how often they normally buy, against how long it has been. Nothing here is typed in."}),
        chase.length?h("button",{class:"btn primary sm",html:"💬 Message "+chase.length+" on WhatsApp",
          onclick:()=>waListModal({title:"Message "+chase.length+" quiet account"+(chase.length===1?"":"s"),
            sub:"One tap each — a popup blocker would swallow them all at once",
            rows:chase.map(r=>{ const c=custOf(r); return {name:r.name, meta:ENG.num(r.silent)+" d silent · "+(c.contact||"")+" · "+(c.phone||""),
              digits:MW.phoneDigits(c.phone), text:quietText(r)}; })})}):null,
      ]));
      const wrap=h("div",{style:"display:flex;flex-wrap:wrap;gap:14px;align-items:flex-start"});
      const tblHost=h("div",{style:"flex:1 1 520px;min-width:0"});
      tblHost.appendChild(table(rows,[
        {key:"name",label:"Customer",render:r=>`<b>${esc(r.name)}</b><div class="muted" style="font-size:12px">${r.orders} orders · last ${esc(r.lastSO||"—")}, ${esc(r.lastDate)}</div>`,sort:r=>r.name},
        {key:"usual",label:"Usual gap",num:true,render:r=>ENG.num(r.usual)+" d",sort:r=>r.usual},
        {key:"silent",label:"Silent",num:true,render:r=>`<span style="color:var(--${r.level==="chase"?"danger":"warn"});font-weight:700">${ENG.num(r.silent)} d</span>`,sort:r=>r.silent},
        {key:"atRisk",label:"At risk",num:true,render:r=>ENG.money(r.atRisk),sort:r=>r.atRisk},
        {key:"level",label:"Action",render:r=>badge(r.level==="chase"?"danger":"warn",r.level),sort:r=>r.level},
        {key:"go",label:"",noSort:true,render:r=>`<button class="btn sm" data-quiet="${esc(r.id)}">Open</button>`
          +(MW.phoneDigits(custOf(r).phone)?` <button class="btn sm ghost" data-quiet-wa="${esc(r.id)}" title="Message on WhatsApp">💬</button>`:"")}
      ]));
      wrap.appendChild(tblHost);
      wrap.appendChild(whyLostCard());
      host.appendChild(wrap);
      /* delegated, not bound per button: table() empties its own tbody every
         time a column header is clicked, so handlers attached to the rows
         would stop working after the first sort */
      host.onclick=(e)=>{
        const w=e.target.closest && e.target.closest("[data-quiet-wa]");
        if(w){
          const r=rows.find(x=>x.id===w.dataset.quietWa); const c=r?custOf(r):null;
          if(r&&c) waMessageModal({title:"💬 Nudge "+r.name, sub:(c.contact||"")+" · "+(c.phone||""), digits:MW.phoneDigits(c.phone), text:quietText(r)});
          return;
        }
        const b=e.target.closest && e.target.closest("[data-quiet]");
        if(!b) return;
        const c=ENG.data.customers.find(x=>x.id===b.dataset.quiet);
        if(c) customerForm(c);
      };
    }
    /* Why we lost — the reasons the CRM's lost leads carry, folded onto the
       one fixed list, so the quiet list sits beside the pattern behind it. A
       lead is dated by its creation or its last activity; only when nothing
       in the last year is dated does the card fall back to every lost lead. */
    function whyLostCard(){
      const lost=ENG.leads().filter(l=>l.stage==="Lost");
      const when=(l)=>{ const ds=[l.created].concat((l.activities||[]).map(a=>a&&a.date)).filter(Boolean).sort(); return ds.length?ds[ds.length-1]:null; };
      const dayMs=86400000, today=new Date(DB.helpers.iso(DB.helpers.today())+"T00:00:00");
      const recent=lost.filter(l=>{ const d=when(l); return d && (today-new Date(d+"T00:00:00"))/dayMs<=365; });
      const pool=recent.length?recent:lost;
      const by={}; pool.forEach(l=>{ const r=ENG.normaliseReason(l.lostReason); by[r]=(by[r]||0)+1; });
      const items=Object.entries(by).sort((a,b)=>b[1]-a[1]).map(([name,value])=>({name,value}));
      const rivals={}; pool.forEach(l=>{ if(l.lostTo) rivals[l.lostTo]=(rivals[l.lostTo]||0)+1; });
      const rl=Object.entries(rivals).sort((a,b)=>b[1]-a[1]).slice(0,3);
      return h("div",{class:"card",style:"flex:0 1 300px;min-width:250px"},[
        h("h3",{style:"font-size:14px",text:"Why we lost · last 12 months"}),
        h("div",{class:"muted",style:"font-size:12px;margin-bottom:8px",
          text:pool.length?pool.length+" lost lead"+(pool.length===1?"":"s")+(recent.length?"":" — none dated, so all time"):"No lost leads on record"}),
        items.length?MW.barList(items):null,
        rl.length?h("div",{style:"font-size:13px;margin-top:10px;padding-top:8px;border-top:1px solid var(--line)"},
          rl.map(([n,c])=>h("div",{text:"Lost to "+n+" "+c+" time"+(c===1?"":"s")}))):null,
      ]);
    }

    function custMatch(c){
      if(!q) return true;
      const ccy=custCcy(c);
      const hay=[c.name, c.city, c.segment, c.gst, c.contact, c.phone, c.email, c.terms, c.since,
        custCountry(c), ccy, CCY.name(ccy),
        c.rating?"grade "+c.rating:null]
        .concat(ENG.data.salesorders.filter(s=>s.customerId===c.id).map(s=>s.id));
      return hay.filter(Boolean).join(" ").toLowerCase().includes(q);
    }
    function draw(){
      if(tab==="quiet"){ drawQuiet(); return; }
      if(tab==="complaints"){ drawComplaints(); return; }
      const list=ENG.data.customers.filter(custMatch);
      const cnt=UI.$("#custCount"); if(cnt) cnt.textContent=list.length+(list.length===1?" customer":" customers");
      host.innerHTML="";
      if(!list.length){
        host.appendChild(h("div",{class:"empty"},[h("div",{class:"big",text:"🔍"}),h("div",{text:"No customer matches that search"})]));
        return;
      }
      const grid=h("div",{class:"grid cols-2"});
      list.forEach(c=>{
        const orders=ENG.data.salesorders.filter(s=>s.customerId===c.id);
        const total=orders.reduce((s,o)=>s+o.value,0);
        const open=orders.filter(o=>o.status!=="Dispatched").length;
        const ccy=custCcy(c), ctry=custCountry(c);
        grid.appendChild(h("div",{class:"card hover"},[
          h("div",{class:"flex between aic"},[
            // the country only earns a line when it isn't home — every other
            // client on the page would otherwise repeat "India"
            h("div",{},[h("h3",{style:"font-size:15px",text:c.name}),
              h("div",{class:"muted",style:"font-size:12px",
                text:[c.city, ctry==="India"?null:ctry, c.segment].filter(Boolean).join(" · ")})]),
            h("div",{class:"flex gap aic",style:"gap:6px"},[
              h("span",{class:"chip",style:"font-size:11px;font-weight:700",
                title:"Invoices for this client are raised in "+CCY.name(ccy),text:CCY.short(ccy)}),
              h("span",{html:badge(c.rating==="A"?"ok":c.rating==="B"?"warn":"mut","Grade "+c.rating)})
            ])
          ]),
          // statgrid-3: three tiny figures — they stay side by side on a phone
          h("div",{class:"grid cols-3 statgrid-3",style:"margin:14px 0;gap:8px"},[
            stat("Orders",orders.length), stat("Open",open), stat("Since",c.since),
          ]),
          c.gst?h("div",{class:"muted",style:"font-size:12px;margin-bottom:8px",text:"GSTIN "+c.gst+(partyStateCode(c)?" · "+GST.stateName(partyStateCode(c)):"")}):null,
          h("div",{class:"flex between",style:"font-size:13px;padding-top:10px;border-top:1px solid var(--line)"},[
            h("span",{class:"muted",text:"Lifetime value"}), h("span",{class:"strong",text:ENG.money(total)})
          ]),
          h("div",{class:"contact-line",style:"font-size:12px;margin-top:8px"},[
            "👤 "+(c.contact||"—")+" · ", MW.phoneCell(c.phone),
            ...(c.email ? [" · ", MW.emailLink(c.email,{mode:"compose"})] : []),
            " · "+c.terms,
          ]),
          h("div",{class:"flex gap",style:"margin-top:12px;padding-top:10px;border-top:1px solid var(--line);justify-content:flex-end"},[
            // delete lives inside the Edit dialog, not on the card
            h("button",{class:"btn sm ghost",onclick:()=>customerForm(c),text:"✎ Edit"}),
          ])
        ]));
      });
      host.appendChild(grid);
    }
    draw();
  }};

  function stat(label,val){ return h("div",{},[h("div",{class:"muted",style:"font-size:11px;font-weight:700;text-transform:uppercase",text:label}),h("div",{style:"font-weight:700;font-size:15px;margin-top:2px",text:val})]); }

  /* ----- Supplier / Customer delete -----
     Reached from the Edit dialog (there is no delete on the card), so the user
     sees the full record before removing it. The server refuses while other
     documents still reference the party. */
  async function deleteSupplier(s, done){
    if(!await confirm(`Delete supplier ${s.name}? This cannot be undone.`,{title:"Delete Supplier",danger:true})) return;
    try{
      await DB.suppliers.remove(s.id);
      ENG.data.suppliers=ENG.data.suppliers.filter(x=>x.id!==s.id);
      if(done) done();
      toast(s.name+" deleted",{type:"ok",title:"Removed"});
      App.saveDelta(()=>Promise.resolve());
    }catch(e){ toast(e.message,{type:"danger",title:"Cannot delete"}); }
  }
  async function deleteCustomer(c, done){
    if(!await confirm(`Delete customer ${c.name}? This cannot be undone.`,{title:"Delete Customer",danger:true})) return;
    try{
      await DB.customers.remove(c.id);
      ENG.data.customers=ENG.data.customers.filter(x=>x.id!==c.id);
      if(done) done();
      toast(c.name+" deleted",{type:"ok",title:"Removed"});
      App.saveDelta(()=>Promise.resolve());
    }catch(e){ toast(e.message,{type:"danger",title:"Cannot delete"}); }
  }

  /* ----- Supplier / Customer forms (create + edit) -----
     Carry every field the tax invoice needs: GSTIN, state (auto-
     derived from the GSTIN prefix), full address, ship-to.
     When editing, the footer also holds 🗑 Delete. */
  function supplierForm(edit){
    const v=k=>esc(edit?(edit[k]||""):"");
    const body=h("div",{class:"form-grid"},[
      U.field("Supplier Name *",`<input class="input" id="sp_name" value="${v("name")}" placeholder="e.g. Axar Mica Industries">`,"full"),
      U.field("Category",`<input class="input" id="sp_cat" value="${v("category")}" placeholder="e.g. Mica / Adhesives / Fabric">`),
      U.field("GSTIN",`<input class="input" id="sp_gst" value="${v("gst")}" placeholder="e.g. 29ABCDE1234F1Z5" style="text-transform:uppercase">`),
      U.field("State",U.selectHTML("sp_state",stateOpts(),(edit&&partyStateCode(edit))||"29")),
      U.field("Address",`<textarea class="input" id="sp_addr" rows="2">${v("address")}</textarea>`,"full"),
      U.field("City",`<input class="input" id="sp_city" value="${v("city")}">`),
      U.field("Country",`<input class="input" id="sp_country" value="${esc(edit?(edit.country||"India"):"India")}">`),
      U.field("Contact Person",`<input class="input" id="sp_contact" value="${v("contact")}">`),
      U.field("Phone",`<input class="input" id="sp_phone" value="${v("phone")}" placeholder="+91…">`),
      U.field("Email",`<input class="input" id="sp_email" type="email" value="${v("email")}">`),
      U.field("Payment Terms",`<input class="input" id="sp_terms" value="${esc(edit?(edit.terms||"30 days"):"30 days")}">`),
    ]);
    const mo=modal({title:edit?("✎ "+edit.name):"＋ New Supplier",
      sub:edit?"Update this vendor's master record":"Add a vendor to the supplier master", body,
      foot:[
        edit? h("button",{class:"btn danger",style:"margin-right:auto",
          onclick:()=>deleteSupplier(edit,()=>mo.close()),text:"🗑 Delete"}) : null,
        h("button",{class:"btn ghost",onclick:()=>mo.close(),text:"Cancel"}),
        h("button",{class:"btn primary",onclick:save,text:edit?"Save Changes":"Add Supplier"})]});
    const gstEl=UI.$("#sp_gst");
    if(gstEl) gstEl.addEventListener("input",()=>{ const sc=GST.stateFromGSTIN(gstEl.value); if(sc) UI.$("#sp_state").value=sc; });
    function save(){
      const name=UI.$("#sp_name").value.trim();
      if(!name){ toast("Supplier name is required",{type:"warn"}); return; }
      const gst=UI.$("#sp_gst").value.trim().toUpperCase();
      if(gst&&!GST.validGSTIN(gst)){ toast("That GSTIN doesn't look valid (15 chars, e.g. 29ABCDE1234F1Z5)",{type:"warn"}); return; }
      const doc={ name, category:UI.$("#sp_cat").value.trim()||"General", gst,
        state:GST.stateName(UI.$("#sp_state").value), stateCode:UI.$("#sp_state").value,
        address:UI.$("#sp_addr").value.trim(),
        city:UI.$("#sp_city").value.trim(), country:UI.$("#sp_country").value.trim()||"India",
        contact:UI.$("#sp_contact").value.trim(), phone:UI.$("#sp_phone").value.trim(),
        email:UI.$("#sp_email").value.trim(), terms:UI.$("#sp_terms").value.trim()||"30 days" };
      if(edit){
        Object.assign(edit,doc);
        mo.close(); toast(name+" updated",{type:"ok"});
        App.saveDelta(()=>DB.suppliers.update(edit.id,doc));
      }else{
        const s=Object.assign({id:U.nextSeqId(ENG.data.suppliers,"SUP-"), rating:4.0, onTime:95},doc);
        ENG.data.suppliers.push(s);
        mo.close(); toast(name+" added to suppliers",{type:"ok"});
        App.saveDelta(()=>DB.suppliers.create(s));
      }
    }
  }
  /* ---- the live line under a currency picker: "1 USD = ₹95.4283" ------------
     Google's own printed digits, from the same feed the dashboard reads. A pair
     Google cannot quote says so plainly instead of showing a number from
     somewhere else — see backend/src/services/fxService.js for why there is no
     second source. Rupees need no line; they are the books' own currency. */
  function ccyRateLine(el, code){
    if(!el) return;
    const c=String(code||"").toUpperCase();
    // a stale reply from a currency the user has already moved off must not win
    const seq=(el._rateSeq=(el._rateSeq||0)+1);
    if(!c){ el.textContent=""; return; }
    if(c==="INR"){ el.textContent="Invoiced in rupees — the books' own currency."; return; }
    el.textContent="Fetching Google's rate for "+c+"…";
    CCY.rate(c,"INR").then(r=>{
      if(el._rateSeq!==seq) return;
      el.textContent = r
        ? "1 "+c+" = ₹"+r.shown+"  ·  Google Finance"+(r.asOf?", "+r.asOf:"")
        : "Google has no rate for "+c+"/INR — the invoice still prints in "+c+".";
    });
  }

  /* ============================================================
     COMPLAINTS — a customer's problem, tied to the batch it came from
     ============================================================ */
  const CMP_STATUS=["Open","Investigating","Resolved","Rejected"];
  const CMP_VIA=["Phone","WhatsApp","Email","Site visit","Letter"];
  const cmpTone=s=>s==="Open"?"danger":s==="Investigating"?"warn":s==="Resolved"?"ok":"mut";

  /* ---- WhatsApp nudges from the customer screens ----
     Nothing is sent by this app: wa.me opens WhatsApp with the text ready and
     the person presses send there — the same rule the CRM follows. A list of
     accounts gets ONE link per row, never a window.open in a loop: a popup
     blocker swallows every tab after the first and the desk would not know. */
  /* "H. Desai" greets as Desai, not "H." — an initial is not a name */
  function waWho(contact){
    const parts=String(contact||"").trim().split(/\s+/).filter(Boolean);
    if(!parts.length) return "Sir/Madam";
    const first=parts[0];
    return (/^[A-Za-z]\.?$/.test(first)&&parts.length>1)?parts[parts.length-1]:first;
  }
  function waMessageModal({title, sub, digits, text, onBack}){
    if(!digits){ toast("No phone number on this customer's record",{type:"warn"}); return; }
    const body=h("div",{class:"form-grid"},[
      U.field("Message",'<textarea class="input" id="wa_text" rows="5" style="min-height:110px"></textarea>',"full"),
      h("div",{class:"muted",style:"grid-column:1/-1;font-size:12px",text:"Opens WhatsApp with this text ready. Nothing is sent until you press send there."}),
    ]);
    const mo=modal({title, sub, body, onClose:onBack,
      foot:[h("button",{class:"btn ghost",onclick:()=>mo.close(),text:"Cancel"}),
            h("button",{class:"btn primary",text:"Open WhatsApp",onclick:()=>{
              const t=(UI.$("#wa_text")?UI.$("#wa_text").value:"").trim();
              if(!t){ toast("The message is empty",{type:"warn"}); return; }
              window.open("https://wa.me/"+digits+"?text="+encodeURIComponent(t),"_blank","noopener");
              mo.close();
            }})]});
    const ta=UI.$("#wa_text"); if(ta) ta.value=text||"";
  }
  function waListModal({title, sub, rows, onBack}){
    const list=(rows||[]).filter(r=>r.digits);
    const body=h("div",{},[
      list.length?h("div",{},list.map(r=>h("div",{class:"flex between aic gap",style:"padding:8px 0;border-bottom:1px solid var(--line)"},[
        h("div",{style:"min-width:0"},[h("div",{style:"font-weight:700",text:r.name}), h("div",{class:"muted",style:"font-size:12px",text:r.meta||""})]),
        h("a",{class:"btn sm primary",href:"https://wa.me/"+r.digits+"?text="+encodeURIComponent(r.text||""),target:"_blank",rel:"noopener noreferrer",text:"Open WhatsApp"}),
      ]))):h("div",{class:"muted",text:"Nobody here has a phone number on record."}),
      h("div",{class:"muted",style:"font-size:12px;margin-top:10px",text:"Each button opens one WhatsApp chat with the message ready; nothing is sent until you press send there."}),
    ]);
    const mo=modal({title, sub, body, onClose:onBack, foot:[h("button",{class:"btn primary",onclick:()=>mo.close(),text:"Done"})]});
  }

  /* the batches a customer actually received — every SO line with a batch
     number, most recent first — so the picker offers what they hold, not
     every work order the plant has ever run */
  function batchesFor(customerId){
    const seen=new Map();
    (ENG.data.salesorders||[]).filter(s=>s.customerId===customerId).forEach(so=>{
      (so.lines||[]).forEach(l=>{ if(l&&l.batch&&!seen.has(l.batch)) seen.set(l.batch,{batch:l.batch,so:so.id,date:so.date,itemId:l.itemId}); });
    });
    return [...seen.values()].sort((a,b)=>a.date<b.date?1:-1);
  }

  function complaintForm(edit){
    const c=edit||{};
    const custs=ENG.data.customers.slice().sort((a,b)=>a.name.localeCompare(b.name));
    const cust0=edit?edit.customerId:(custs[0]&&custs[0].id);
    const batchOpts=(cid)=>[{v:"",l:"— not tied to a batch —"}].concat(batchesFor(cid).map(b=>({v:b.batch,
      l:b.batch+" · "+(ENG.item(b.itemId)||{}).name+" · "+b.so+" · "+b.date})));
    const body=h("div",{class:"form-grid"},[
      U.field("Customer *",U.searchSelect("cm_cust",custs.map(x=>({v:x.id,l:x.name})),cust0,"Search customer…")),
      U.field("Batch (work order)",U.selectHTML("cm_batch",batchOpts(cust0),c.batch||"")),
      U.field("Raised on",`<input class="input" id="cm_raised" type="date" value="${c.raised||DB.helpers.iso(DB.helpers.today())}">`),
      U.field("Came in via",U.selectHTML("cm_via",CMP_VIA.map(v=>({v,l:v})),c.via||"Phone")),
      U.field("Raised by (their side)",`<input class="input" id="cm_by" value="${esc(c.raisedByName||"")}" placeholder="e.g. G. Rane, QA">`),
      edit?U.field("Status",U.selectHTML("cm_status",CMP_STATUS.map(v=>({v,l:v})),c.status||"Open")):null,
      U.field("What they said *",`<textarea class="input" id="cm_claim" placeholder="In their words — which product, which reels, what is wrong">${esc(c.claim||"")}</textarea>`,"full"),
      edit?U.field("Resolution / notes",`<textarea class="input" id="cm_res" placeholder="What was done, what was replaced, what the plant found">${esc(c.resolution||"")}</textarea>`,"full"):null,
    ].filter(Boolean));
    const mo=modal({title:edit?"Edit "+c.id:"Raise a complaint",sub:edit?ENG.custName(c.customerId):"Tie it to the batch and the lab report settles it",body,
      foot:[h("button",{class:"btn ghost",onclick:()=>mo.close(),text:"Cancel"}),
            h("button",{class:"btn primary",onclick:save,text:edit?"Save":"Raise complaint"})]});
    // the batch list belongs to the customer, so it follows the customer picker
    const custSel=UI.$("#cm_cust");
    if(custSel) custSel.addEventListener("change",()=>{ const b=UI.$("#cm_batch"); if(b) b.innerHTML=batchOpts(custSel.value).map(o=>`<option value="${esc(o.v)}">${esc(o.l)}</option>`).join(""); });
    async function save(){
      const customerId=UI.$("#cm_cust").value, claim=UI.$("#cm_claim").value.trim();
      if(!customerId){ toast("Pick a customer",{type:"warn"}); return; }
      if(!claim){ toast("Write down what they said",{type:"warn"}); return; }
      const batch=UI.$("#cm_batch").value;
      const b=batchesFor(customerId).find(x=>x.batch===batch);
      const patch={customerId, batch, raised:UI.$("#cm_raised").value, via:UI.$("#cm_via").value,
        raisedByName:UI.$("#cm_by").value.trim(), claim,
        salesOrderId:b?b.so:(c.salesOrderId||""), itemId:b?b.itemId:(c.itemId||"")};
      if(edit){ patch.status=UI.$("#cm_status").value; patch.resolution=UI.$("#cm_res").value.trim(); }
      mo.close();
      try{
        if(edit) await App.saveDelta(()=>DB.complaints.update(c.id,patch));
        else await App.saveDelta(()=>DB.complaints.create(patch));
        toast(edit?c.id+" saved":"Complaint raised",{type:"ok"});
      }catch(e){ toast(e.message||"Could not save the complaint",{type:"danger"}); }
    }
  }

  async function complaintDetail(c){
    const cust=ENG.data.customers.find(x=>x.id===c.customerId)||{};
    // the spread and the lab reading are read live from the server — they are
    // derived from dispatches and reports, never stored on the complaint
    let sp=null;
    if(c.batch){ try{ sp=await DB.complaints.spread(c.batch); }catch(e){ sp=null; } }
    const params=(M["lab-reports"]&&M["lab-reports"].PARAMS)||[];
    const rep=sp&&sp.report;
    const vals=rep?(rep.labValues||rep.values||{}):{};
    const res=rep?(rep.labResults||rep.results||{}):{};
    const labRows=params.filter(p=>vals[p.key]!=null).map(p=>{
      const r=String(res[p.key]||"").toLowerCase();
      return `<tr><td>${esc(p.label)}</td><td class="num mono">${esc(String(vals[p.key]))} <span class="muted">${esc(p.unit)}</span></td>`+
        `<td class="num">${r?badge(r==="pass"?"ok":"danger",r==="pass"?"✓ pass":"✗ fail"):'<span class="muted">—</span>'}</td></tr>`;
    }).join("");
    const failed=Object.entries(res).filter(([,v])=>String(v).toLowerCase()==="fail").map(([k])=>(params.find(p=>p.key===k)||{label:k}).label);
    const others=sp?sp.orders.filter(o=>o.customerId!==c.customerId):[];
    /* the warning to everyone else holding the batch — drafted from the
       complaint itself so the batch, product and order are never mistyped */
    const custById=(id)=>ENG.data.customers.find(x=>x.id===id)||{};
    const prodName=c.itemId?((ENG.item(c.itemId)||{}).name||c.itemId)
      :(sp&&sp.workOrder&&((ENG.item(sp.workOrder.itemId)||{}).name||sp.workOrder.itemId))||"the product";
    const warnText=(o)=>"Hello "+waWho(custById(o.customerId).contact)+", a quality concern has been raised on batch "+c.batch+" of "+prodName+" supplied on "+o.soId+". Please hold the reels; we will replace whatever is affected and confirm the lab finding shortly.";
    const warnable=others.filter(o=>MW.phoneDigits(custById(o.customerId).phone));

    const body=h("div",{},[
      MW.dl([
        ["Customer",cust.name||c.customerId],["Batch",c.batch||"—"],["Against order",c.salesOrderId||"—"],
        ["Product",c.itemId?((ENG.item(c.itemId)||{}).name||c.itemId):"—"],
        ["Raised",(c.raised||"—")+(c.via?" · via "+c.via:"")],["Raised by",c.raisedByName||"—"],
        ["Status",h("span",{html:badge(cmpTone(c.status),c.status)})],
        c.closed?["Closed",c.closed]:null,
      ].filter(Boolean)),
      h("div",{class:"card",style:"margin-top:14px;box-shadow:none;background:var(--panel-2)"},[
        h("div",{class:"muted",style:"font-size:11px;font-weight:700;text-transform:uppercase;margin-bottom:4px",text:"What they said"}),
        h("div",{style:"font-size:13px;line-height:1.5;white-space:pre-wrap",text:c.claim||"—"})]),
      c.resolution?h("div",{class:"card",style:"margin-top:10px;box-shadow:none;background:var(--panel-2)"},[
        h("div",{class:"muted",style:"font-size:11px;font-weight:700;text-transform:uppercase;margin-bottom:4px",text:"Resolution"}),
        h("div",{style:"font-size:13px;line-height:1.5;white-space:pre-wrap",text:c.resolution})]):null,

      c.batch?h("div",{class:"card",style:"margin-top:14px"},[
        h("div",{class:"flex between aic wrap gap",style:"margin-bottom:8px"},[
          h("div",{class:"muted",style:"font-size:11px;font-weight:700;text-transform:uppercase",text:"🧪 What the lab measured on "+c.batch}),
          rep?h("span",{html:badge(String(rep.labResult||rep.result||"").toLowerCase()==="pass"?"ok":"danger",rep.labResult||rep.result||"—")}):null
        ]),
        rep?h("div",{class:"table-wrap"},h("table",{class:"tbl",html:'<thead><tr><th>Parameter</th><th class="num">Reading</th><th class="num">Spec</th></tr></thead><tbody>'+(labRows||'<tr><td colspan="3" class="muted">No readings recorded</td></tr>')+'</tbody>'}))
           :h("div",{class:"muted",style:"font-size:13px",text:"No lab report found for this batch."}),
        rep&&failed.length?h("div",{style:"margin-top:8px",html:badge("danger","The complaint is right — this batch failed "+failed.join(", "))}):null,
        rep&&!failed.length&&labRows?h("div",{style:"margin-top:8px",html:badge("ok","The batch passed every test — the fault is not in the lab record")}):null,
      ]):null,

      c.batch?h("div",{class:"card",style:"margin-top:14px"},[
        h("div",{class:"flex between aic wrap gap",style:"margin-bottom:8px"},[
          h("div",{class:"muted",style:"font-size:11px;font-weight:700;text-transform:uppercase;color:var(--accent)",
            text:"Who else received batch "+c.batch}),
          warnable.length?h("button",{class:"btn sm",html:"💬 Warn all on WhatsApp",
            onclick:()=>waListModal({title:"Warn "+warnable.length+" customer"+(warnable.length===1?"":"s")+" holding "+c.batch,
              sub:"Calling them first is the difference between a recall and a reputation",
              rows:warnable.map(o=>({name:o.customer, meta:o.soId+" · "+ENG.num(o.qty)+" · "+(custById(o.customerId).contact||""), digits:MW.phoneDigits(custById(o.customerId).phone), text:warnText(o)})),
              onBack:()=>complaintDetail(c)})}):null,
        ]),
        sp&&sp.orders.length?h("div",{class:"table-wrap"},h("table",{class:"tbl",html:
          `<thead><tr><th>Customer</th><th>Order</th><th class="num">Qty</th><th>Dispatched</th><th></th></tr></thead><tbody>`+
          sp.orders.map(o=>{
            const mine=o.customerId===c.customerId;
            const hasCmp=(sp.complaints||[]).some(x=>x.customerId===o.customerId);
            // the warning is one tap when the customer has a number on record
            const canWa=!mine&&MW.phoneDigits(custById(o.customerId).phone);
            return `<tr><td><b>${esc(o.customer)}</b></td><td class="mono">${esc(o.soId)}</td><td class="num mono">${ENG.num(o.qty)}</td><td>${esc(o.dispatchedOn||o.date||"—")}</td>`+
              `<td>${mine?badge("danger","complained"):hasCmp?badge("danger","also complained"):badge("warn","warn them")}`+
              `${canWa?` <button class="btn sm ghost" data-warn="${esc(o.soId)}" title="Message on WhatsApp">💬 Warn</button>`:""}</td></tr>`;
          }).join("")+`</tbody>`}))
          :h("div",{class:"muted",style:"font-size:13px",text:"No dispatched order carries this batch number."}),
        others.length?h("div",{class:"muted",style:"font-size:13px;margin-top:8px",
          text:others.length+" other customer"+(others.length===1?" holds":"s hold")+" this batch and "+(others.length===1?"has":"have")+" not called. Calling them first is the difference between a recall and a reputation."}):null,
      ]):null,

      (c.history||[]).length?h("div",{style:"margin-top:14px"},[
        h("div",{class:"muted",style:"font-size:11px;font-weight:700;text-transform:uppercase;margin-bottom:6px",text:"History"}),
        h("div",{},(c.history||[]).slice().reverse().map(x=>h("div",{class:"muted",style:"font-size:13px;padding:3px 0",
          text:String(x.at||"").slice(0,10)+" · "+(x.status||"")+(x.by?" · "+x.by:"")+(x.note&&x.note!=="Raised"?" — "+x.note:"")})))
      ]):null,
    ]);
    /* delegated: the spread table is one HTML string, so its Warn buttons
       have no handlers of their own */
    body.onclick=(e)=>{
      const b=e.target.closest&&e.target.closest("[data-warn]");
      if(!b||!sp) return;
      const o=sp.orders.find(x=>x.soId===b.dataset.warn); if(!o) return;
      const cc=custById(o.customerId);
      waMessageModal({title:"💬 Warn "+o.customer, sub:(cc.contact||"")+" · "+(cc.phone||""), digits:MW.phoneDigits(cc.phone), text:warnText(o), onBack:()=>complaintDetail(c)});
    };
    const isOpen=c.status==="Open"||c.status==="Investigating";
    modal({title:c.id+" · "+(cust.name||""),sub:c.batch?"Batch "+c.batch:"Not tied to a batch",wide:true,body,
      foot:[
        h("button",{class:"btn danger",onclick:async()=>{ if(!await confirm("Delete "+c.id+"?",{title:"Delete complaint",danger:true})) return;
          UI.$("#modalHost").hidden=true; await App.saveDelta(()=>DB.complaints.remove(c.id)); toast(c.id+" deleted",{type:"ok"}); },text:"🗑 Delete"}),
        h("button",{class:"btn ghost",onclick:()=>{ UI.$("#modalHost").hidden=true; complaintForm(c); },text:"✎ Edit"}),
        /* the certificate is the answer to the complaint — send the batch's
           lab report; greyed rather than hidden when there is none, so the
           desk learns the batch was never tested instead of hunting for it */
        c.batch?h("button",{class:"btn ghost",style:rep&&rep.id?"":"opacity:.55","aria-disabled":rep&&rep.id?"false":"true",
          onclick:()=>{ if(!(rep&&rep.id)){ toast("No lab report on file for "+c.batch+" — nothing to send",{type:"warn"}); return; }
            UI.$("#modalHost").hidden=true; App.go("lab-reports",{open:rep.id}); },html:"📜 Send test certificate"}):null,
        /* hand it to the floor: the complaint moves to Investigating with the
           note on record, then the work order itself opens */
        c.batch&&isOpen?h("button",{class:"btn",onclick:async()=>{ UI.$("#modalHost").hidden=true;
          try{ await App.saveDelta(()=>DB.complaints.update(c.id,{status:"Investigating",resolution:"Raised to plant"})); await App.reloadState(); }
          catch(e){ toast(e.message||"Could not update the complaint",{type:"danger"}); return; }
          toast(c.id+" raised to plant",{type:"ok"}); App.go("production",{open:c.batch}); },html:"🏭 Raise to plant"}):null,
        isOpen?h("button",{class:"btn",onclick:async()=>{ UI.$("#modalHost").hidden=true;
          await App.saveDelta(()=>DB.complaints.update(c.id,{status:c.status==="Open"?"Investigating":"Resolved"}));
          toast(c.id+(c.status==="Open"?" → Investigating":" → Resolved"),{type:"ok"}); },
          text:c.status==="Open"?"Start investigating":"Mark resolved"}):null,
      ].filter(Boolean)});
  }

  /* ---- CUSTOMER MASTER: country decides the currency ------------------------
     The desk types where the client IS; the money their invoice is raised in
     follows from that (ccy.js holds the table). It is a DEFAULT, not a lock —
     the picker stays open, because a buyer in Vietnam or Nigeria very often
     settles an export in dollars whatever is legal tender at home. Whatever
     ends up here is what a sales order for this client opens in. */
  function customerForm(edit){
    const yr=String(DB.helpers.today().getFullYear());
    const v=k=>esc(edit?(edit[k]||""):"");
    // a record saved before this field existed is an Indian client — the same
    // assumption the supplier form has always made
    const ctry0=CCY.country(edit&&edit.country)||CCY.country("India");
    const ccy0=(edit&&edit.currency)||ctry0.ccy;
    const body=h("div",{class:"form-grid"},[
      U.field("Customer Name *",`<input class="input" id="cu_name" value="${v("name")}" placeholder="e.g. Apar Industries Ltd.">`,"full"),
      U.field("Segment",`<input class="input" id="cu_seg" value="${esc(edit?(edit.segment||"HT Cables"):"HT Cables")}">`),
      U.field("GSTIN",`<input class="input" id="cu_gst" value="${v("gst")}" placeholder="e.g. 27ABCDE1234F1Z5" style="text-transform:uppercase">`),
      U.field("State",U.selectHTML("cu_state",stateOpts(),(edit&&partyStateCode(edit))||"29")),
      U.field("Billing Address",`<textarea class="input" id="cu_addr" rows="2">${v("address")}</textarea>`,"full"),
      U.field("Ship-To Address",`<textarea class="input" id="cu_ship" rows="2" placeholder="leave blank if same as billing">${v("shipTo")}</textarea>`,"full"),
      U.field("City",`<input class="input" id="cu_city" value="${v("city")}">`),
      U.field("Country",U.searchSelect("cu_country",CCY.countryOptions(),ctry0.name,"Search country…")),
      U.field("Currency (invoiced in)",
        U.searchSelect("cu_ccy",CCY.options(),ccy0,"Search currency…")
        +`<div class="muted" id="cu_rate" style="font-size:12px;margin-top:5px;line-height:1.4"></div>`,"full"),
      U.field("Grade",U.selectHTML("cu_rating",[{v:"A",l:"A — key account"},{v:"B",l:"B — regular"},{v:"C",l:"C — occasional"}],edit?(edit.rating||"B"):"B")),
      U.field("Contact Person",`<input class="input" id="cu_contact" value="${v("contact")}">`),
      U.field("Phone",`<input class="input" id="cu_phone" value="${v("phone")}" placeholder="+91…">`),
      U.field("Email",`<input class="input" id="cu_email" type="email" value="${v("email")}">`),
      U.field("Payment Terms",`<input class="input" id="cu_terms" value="${esc(edit?(edit.terms||"30 days"):"30 days")}">`),
      U.field("Customer Since",`<input class="input" id="cu_since" value="${esc(edit?(edit.since||yr):yr)}">`),
    ]);
    const mo=modal({title:edit?("✎ "+edit.name):"＋ New Customer",
      sub:edit?"Update this client's master record":"Add a client to the customer master", body,
      foot:[
        edit? h("button",{class:"btn danger",style:"margin-right:auto",
          onclick:()=>deleteCustomer(edit,()=>mo.close()),text:"🗑 Delete"}) : null,
        h("button",{class:"btn ghost",onclick:()=>mo.close(),text:"Cancel"}),
        h("button",{class:"btn primary",onclick:save,text:edit?"Save Changes":"Add Customer"})]});
    const gstEl=UI.$("#cu_gst");
    if(gstEl) gstEl.addEventListener("input",()=>{ const sc=GST.stateFromGSTIN(gstEl.value); if(sc) UI.$("#cu_state").value=sc; });
    /* Pick a country and the currency follows; pick a currency and the rate
       under it refreshes. Editing an existing client only re-derives when the
       country actually MOVES, so a deliberate override (a Nigerian buyer set to
       USD) survives re-opening the dialog. */
    const ctryEl=UI.$("#cu_country"), ccyEl=UI.$("#cu_ccy"), rateEl=UI.$("#cu_rate");
    if(ctryEl) ctryEl.addEventListener("change",()=>{
      const c=CCY.forCountry(ctryEl.value);
      if(c && ccyEl && ccyEl.value!==c) U.ssSet("cu_ccy",c);
    });
    if(ccyEl) ccyEl.addEventListener("change",()=>ccyRateLine(rateEl,ccyEl.value));
    ccyRateLine(rateEl,ccy0);
    function save(){
      const name=UI.$("#cu_name").value.trim();
      if(!name){ toast("Customer name is required",{type:"warn"}); return; }
      const gst=UI.$("#cu_gst").value.trim().toUpperCase();
      if(gst&&!GST.validGSTIN(gst)){ toast("That GSTIN doesn't look valid (15 chars, e.g. 27ABCDE1234F1Z5)",{type:"warn"}); return; }
      // the picker hands back a canonical name, but a hand-typed "usa" still
      // resolves — store the canonical spelling plus its ISO code either way
      const ctry=CCY.country(ctryEl&&ctryEl.value)||CCY.country("India");
      const doc={ name, segment:UI.$("#cu_seg").value.trim()||"HT Cables", gst,
        state:GST.stateName(UI.$("#cu_state").value), stateCode:UI.$("#cu_state").value,
        address:UI.$("#cu_addr").value.trim(), shipTo:UI.$("#cu_ship").value.trim(),
        city:UI.$("#cu_city").value.trim(),
        country:ctry.name, countryCode:ctry.cc,
        currency:((ccyEl&&ccyEl.value)||ctry.ccy).toUpperCase(),
        rating:UI.$("#cu_rating").value,
        contact:UI.$("#cu_contact").value.trim(), phone:UI.$("#cu_phone").value.trim(),
        email:UI.$("#cu_email").value.trim(), terms:UI.$("#cu_terms").value.trim()||"30 days",
        since:UI.$("#cu_since").value.trim()||yr };
      if(edit){
        Object.assign(edit,doc);
        mo.close(); toast(name+" updated",{type:"ok"});
        App.saveDelta(()=>DB.customers.update(edit.id,doc));
      }else{
        const c=Object.assign({id:U.nextSeqId(ENG.data.customers,"CUS-")},doc);
        ENG.data.customers.push(c);
        mo.close(); toast(name+" added to customers",{type:"ok"});
        App.saveDelta(()=>DB.customers.upsert(c));
      }
    }
  }

  /* ============================================================
     PRINTED DOCUMENT — GST tax invoice / purchase order
     Layout modelled on the approved sample templates: logo band
     with tagline, GSTIN/PAN strip, Bill To / Ship To, HSN
     item table with per-line GST, CGST/SGST/IGST summary, amount
     in words, bank details, terms and signatory. Work-order
     traceability appears ONLY as "Batch No." here.
     ============================================================ */
  const IN=v=>(+v||0).toLocaleString("en-IN",{minimumFractionDigits:2,maximumFractionDigits:2});
  const fmtD=d=>{ if(!d) return "—"; const m=String(d).match(/^(\d{4})-(\d{2})-(\d{2})/); return m?`${m[3]}.${m[2]}.${m[1]}`:String(d); };
  function printDoc(kind, o){
    /* a quotation prints on the same two sheets the invoice does — the styled
       GST sheet in rupees, the export grid in any other currency — so what
       the customer accepts looks like what they will be billed */
    const html = kind==="po" ? domesticHtml(o, true)
               : kind==="quote" ? (String(o.currency||"INR").toUpperCase()==="INR"
                                    ? domesticHtml(o, false, {quote:true})
                                    : exportHtml(o, {title:"QUOTATION", validUntil:o.validUntil}))
               : (o.invoiceType==="export" ? exportHtml(o) : domesticHtml(o));
    const w=window.open("","_blank");
    if(!w){ toast("Popup blocked — allow popups for this site to print",{type:"warn"}); return; }
    w.document.write(html); w.document.close();
  }
  /* ---- a quotation on paper ----
     The Samples & Quotations page keeps a quote as one product, one unit,
     one price. Printing it borrows the invoice sheet headed QUOTATION, so
     the customer sees the layout they will later be billed on. The sheet's
     rate is per the product's OWN stocking unit; a price talked in another
     unit is not restated behind the desk's back — the desk is told instead. */
  function printQuote(q){
    const it=ENG.item(q.itemId)||{};
    const own=String(it.uom||"KG").toUpperCase();
    if(String(q.uom||own).toUpperCase()!==own){
      toast("This quote is per "+String(q.uom).toLowerCase()+", but "+(it.name||q.itemId)+" is priced per "+own.toLowerCase()+" on paper. Quote it per "+own.toLowerCase()+" to print.",{type:"warn"}); return;
    }
    const cust=ENG.data.customers.find(c=>c.id===q.customerId);
    if(!cust){ toast("Link the quote to a customer first — a lead alone cannot be printed",{type:"warn"}); return; }
    const price=(q.status==="Won"&&q.finalPrice>0)?q.finalPrice:q.price;
    // currency follows the customer; custCcy lives in a render closure, so read it plainly here
    const ccy=String((cust.currency)||"INR").toUpperCase();
    printDoc("quote",{ id:q.id, rev:1, date:q.date, validUntil:DB.helpers.daysAhead(30), customerId:q.customerId,
      company:companies()[0].key, currency:ccy, placeOfSupply:partyStateCode(cust)||"29",
      lines:[{ itemId:q.itemId, qty:q.qty>0?q.qty:1, rate:price, discPct:0, gstPct:lineGstPct({},it) }],
      freight:0, insurance:0, payTerms:cust.terms||"", notes:q.note||"", leadId:q.leadId||"" });
  }

  /* ============================================================
     RAW-MATERIAL IDENTIFICATION LABELS — one per ordered line,
     laid out on any sheet the operator defines in the print dialog.

     Only what the purchase order actually knows is printed:
     product, grade, quantity and — for sheet goods — thickness
     and GSM, plus the receipt date and GRN number once the goods
     have been received against this PO. Everything the order
     cannot know (supplier invoice number, inspector, test status)
     prints as a ruled blank for the store to complete by hand,
     because a sticker that guesses is worse than one left open.
     ============================================================ */
  /* One record per ordered line — only what the PO and its goods receipt
     actually know; every unknown stays "" so it renders as a blank to fill.
     Shared by the printed label sheet and the BarTender export, so the
     label a machine prints can never disagree with the one printed here. */
  function stickerData(po){
    return ((po&&po.lines)||[]).map((l)=>{
      const it=ENG.item(l.itemId)||{};
      /* The goods receipt posted against this PO is where the lot identity and
         the date on the drum come from; before receiving, both stay blank. */
      const grn=(ENG.data.movements||[]).filter(m=>m.ref===po.id&&m.type==="GRN"&&m.itemId===l.itemId)
        .sort((a,b)=>String(b.date||"").localeCompare(String(a.date||"")))[0];
      /* The issued goods receipt note is the lot's identity. Receipts posted
         before GRN documents existed have no note, so those fall back to the
         movement id (stripped of its "-<item id>" tail) rather than go blank. */
      const gdoc=(ENG.data.grns||[]).filter(g=>g.poId===po.id&&g.status!=="Cancelled"
        &&(g.lines||[]).some(x=>x.itemId===l.itemId&&x.accepted>0))
        .sort((a,b)=>String(b.id).localeCompare(String(a.id)))[0];
      const grnNo=gdoc?gdoc.id:(grn&&grn.id?String(grn.id).replace("-"+l.itemId,""):"");
      const sheet=isSheetGoods(it);
      const qty=(+l.recd>0)?+l.recd:+l.qty;
      const uom=l.uom||it.uom||"";
      return {
        product: it.name||it.material||l.itemId||"",
        supplier: ENG.sup(po.supplierId)||"",
        grade: it.grade||it.typeCode||l.itemId||"",
        dateOfReceipt: grn&&grn.date?fmtD(grn.date):"",
        grnNo,
        qtyUom: qty>0?`${ENG.num(qty,2)} ${uom}`.trim():"",
        thickness: sheet&&it.thicknessMM!=null?`${BOMCALC.thk3(it.thicknessMM)} mm`:"",
        gsm: sheet&&it.gsm?`${ENG.num(it.gsm,0)} g/m²`:"",
      };
    });
  }

  /* ---- ONE list drives everything a label can carry: the tick-list in the
     dialog, the editable value box beside each tick, the printed row and the
     BarTender CSV column. TO ADD A FIELD: add an entry here AND add the same
     key to the whitelist in backend/src/services/erpService.js →
     updateSettings(), or the choice will not survive a save. Nothing else.
       k     settings key + CSV value source (src overrides the source)
       cap   the caption printed on the label
       row   renders as a table row · head = the headline · boxes = tick-boxes
     A field left unticked disappears from the label AND the CSV alike, so no
     format can quietly disagree with another. ---- */
  const STICKER_FIELDS=[
    {k:"product",      label:"Product",            cap:"PRODUCT",               csv:"Product",       head:true},
    {k:"supplier",     label:"Supplier",           cap:"SUPPLIER",              csv:"SupplierName",  row:true},
    {k:"grade",        label:"Grade / Type",       cap:"GRADE/TYPE",            csv:"GradeType",     row:true},
    {k:"dateOfReceipt",label:"Date of Receipt",    cap:"DATE OF RECEIPT",       csv:"DateOfReceipt", row:true},
    {k:"grnNo",        label:"GRN / Lot No",       cap:"GRN/LOT NO",            csv:"GRNLotNo",      row:true},
    {k:"invoiceNo",    label:"Invoice No",         cap:"INVOICE NO",            csv:"InvoiceNo",     row:true},
    {k:"qty",          label:"Qty & UOM",          cap:"QTY & UOM",             csv:"QtyAndUom",     row:true, src:"qtyUom"},
    {k:"thickness",    label:"Thickness (fabric)", cap:"THICKNESS (if fabric)", csv:"Thickness",     row:true},
    {k:"gsm",          label:"GSM (fabric)",       cap:"GSM (if fabric)",       csv:"GSM",           row:true},
    {k:"inspectedBy",  label:"Inspected By",       cap:"INSPECTED BY",          csv:"InspectedBy",   row:true},
    {k:"status",       label:"Status tick-boxes",  cap:"STATUS",                csv:"Status",        boxes:true},
  ];

  /* The standard colour set beside the dial. Deliberately pale: a label is
     read, written on by hand and photocopied, so these are stock-paper tints
     rather than saturated ink. The dial covers everything else. */
  const STICKER_COLOURS=[
    {v:"#ffffff",l:"White"},      {v:"#f2f2f2",l:"Light grey"},
    {v:"#fff9c4",l:"Yellow"},     {v:"#ffe0b2",l:"Orange"},
    {v:"#ffcdd2",l:"Red"},        {v:"#f8bbd0",l:"Pink"},
    {v:"#e1bee7",l:"Purple"},     {v:"#c5cae9",l:"Indigo"},
    {v:"#bbdefb",l:"Blue"},       {v:"#b2ebf2",l:"Cyan"},
    {v:"#c8e6c9",l:"Green"},      {v:"#dcedc8",l:"Lime"},
    {v:"#d7ccc8",l:"Brown"},      {v:"#cfd8dc",l:"Blue grey"},
    {v:"#424242",l:"Charcoal"},   {v:"#000000",l:"Black"},
  ];

  /* The symbol palette — the Word-style pre-given set. Kept to glyphs that
     carry meaning on a materials sticker — status, handling, hazard, plus the
     general marks Word's own Symbol dialog leads with — and that render the
     same on every machine, so a printed label cannot come out as a blank box.
     Clicking one PLACES it (cfg.syms), at any position and size. */
  const STICKER_SYMBOLS=[
    {v:"✓", l:"Tick — approved"},   {v:"✗", l:"Cross — rejected"},
    {v:"☑", l:"Boxed tick"},        {v:"☒", l:"Boxed cross"},
    {v:"☐", l:"Empty box"},         {v:"⚠", l:"Warning"},
    {v:"⏳",l:"Under test"},         {v:"⚗", l:"Lab / testing"},
    {v:"🔥",l:"Flammable"},          {v:"☣", l:"Biohazard"},
    {v:"☢", l:"Radioactive"},       {v:"⚡", l:"Electrical"},
    {v:"❄", l:"Keep cold"},          {v:"☂", l:"Keep dry"},
    {v:"☀", l:"Keep off sunlight"},  {v:"🍷",l:"Fragile"},
    {v:"↑", l:"This way up"},       {v:"→", l:"Arrow right"},
    {v:"←", l:"Arrow left"},        {v:"↓", l:"Arrow down"},
    {v:"♲", l:"Recyclable"},        {v:"⚖", l:"Weight / check"},
    {v:"⚙", l:"Machine part"},      {v:"✂", l:"Cut here"},
    {v:"☎", l:"Telephone"},         {v:"✉", l:"Post / enquiry"},
    {v:"☞", l:"Pointing hand"},     {v:"⚑", l:"Flag"},
    {v:"★", l:"Star — priority"},   {v:"✦", l:"Sparkle"},
    {v:"●", l:"Filled circle"},     {v:"■", l:"Filled square"},
    {v:"▲", l:"Triangle"},          {v:"❖", l:"Diamond"},
    {v:"©", l:"Copyright"},         {v:"®", l:"Registered"},
    {v:"™", l:"Trade mark"},        {v:"№", l:"Numero"},
    {v:"§", l:"Section"},           {v:"°", l:"Degree"},
    {v:"±", l:"Plus-minus"},        {v:"⌀", l:"Diameter"},
  ];

  /* Fonts a label may set — stocks every Windows machine and printer carries,
     so the design pane and the printed sheet cannot disagree about a face. */
  const STICKER_FONTS=[
    {v:"times",  l:"Times New Roman", css:'"Times New Roman",Georgia,serif'},
    {v:"georgia",l:"Georgia",         css:'Georgia,"Times New Roman",serif'},
    {v:"cambria",l:"Cambria",         css:'Cambria,Georgia,serif'},
    {v:"arial",  l:"Arial",           css:'Arial,Helvetica,sans-serif'},
    {v:"calibri",l:"Calibri",         css:'Calibri,"Segoe UI",sans-serif'},
    {v:"courier",l:"Courier New",     css:'"Courier New",Courier,monospace'},
  ];
  const fontCss=(v)=>(STICKER_FONTS.find(f=>f.v===v)||STICKER_FONTS[0]).css;
  /* The blocks that can be dragged free of the flow in the design pane. */
  const STICKER_FREE=["title","prod","body","para"];

  /* Sheet sizes the layout step offers — the standard papers plus a custom
     size. There is deliberately NO preset label here: the label is whatever
     the operator's own sheet, margins and grid leave, or whatever size they
     type. Feeding a label roll just means entering the roll as a custom
     sheet and using a single row and column. */
  const PAGE_SIZES=[
    {v:"A3",    l:"A3 — 297 × 420 mm",     w:297,   h:420},
    {v:"A4",    l:"A4 — 210 × 297 mm",     w:210,   h:297},
    {v:"A5",    l:"A5 — 148 × 210 mm",     w:148,   h:210},
    {v:"A6",    l:"A6 — 105 × 148 mm",     w:105,   h:148},
    {v:"Letter",l:"Letter — 216 × 279 mm", w:215.9, h:279.4},
    {v:"Legal", l:"Legal — 216 × 356 mm",  w:215.9, h:355.6},
    {v:"custom",l:"Custom size…",          w:0,     h:0},
  ];

  /* The whole print definition — fields, page, margins, grid, label size and
     gaps — saved in settings so every browser prints the same label. Legacy
     configs stored only the roll size as w/h; those still open correctly. */
  /* Fields the operator invented in the dialog, stored beside the built-ins so
     a label can carry anything this list never thought of. Kept to a sane
     count and a strict key shape — the key becomes a settings key and a CSV
     column name, so it cannot be arbitrary text. */
  function customFields(s){
    return (Array.isArray(s&&s.custom)?s.custom:[]).slice(0,40)
      .map(c=>({ k:String((c&&c.k)||""), label:String((c&&c.label)||"").slice(0,44) }))
      .filter(c=>/^cx[A-Za-z0-9]{1,20}$/.test(c.k)&&c.label)
      .map(c=>({ k:c.k, label:c.label, cap:c.label.toUpperCase(), csv:c.k, row:true, custom:true }));
  }
  /* Every field the picker can offer = the built-ins plus the invented ones. */
  function fieldDefs(cfg){ return STICKER_FIELDS.concat((cfg&&cfg.custom)||[]); }
  /* The fields actually ADDED to the label, in the order they print. */
  function addedDefs(cfg){
    const all=fieldDefs(cfg);
    return (cfg.order||[]).map(k=>all.find(f=>f.k===k)).filter(Boolean);
  }

  function stickerCfg(){
    const s=(ENG.data.settings&&ENG.data.settings.sticker)||{};
    const custom=customFields(s);
    const all=STICKER_FIELDS.concat(custom);
    /* `order` is the source of truth for what prints, and in what sequence.
       A config saved before the picker existed has none, so it falls back to
       whatever the old tick-map had on — the previous all-on behaviour. */
    let order=Array.isArray(s.order)?s.order.map(String).filter(k=>all.some(f=>f.k===k)):null;
    if(!order||!order.length) order=all.filter(f=>!s.fields||s.fields[f.k]!==false).map(f=>f.k);
    order=order.filter((k,i)=>order.indexOf(k)===i);
    // kept in step with `order`: one flag per field
    const fields={}; all.forEach(f=>{ fields[f.k]=order.indexOf(f.k)>=0; });
    /* dim() accepts 0 — a zero margin or gap is a real choice, unlike a zero
       page or label size, which pick() rejects in favour of the default. */
    const dim=(v,d,lo,hi)=>{ v=+v; return isNaN(v)?d:Math.min(hi,Math.max(lo,v)); };
    const pick=(v,d,lo,hi)=>{ v=+v; return isNaN(v)||v<=0?d:Math.min(hi,Math.max(lo,v)); };
    const int=(v,d,lo,hi)=>{ v=Math.round(+v); return isNaN(v)?d:Math.min(hi,Math.max(lo,v)); };
    const txt=(v,d,max)=>{ v=(v==null?d:String(v)); return v.slice(0,max); };
    const hex6=(v,d)=>/^#[0-9a-fA-F]{6}$/.test(String(v||""))?String(v).toLowerCase():d;
    return {
      fields, order, custom,
      /* The heading is no longer welded to "RAW MATERIAL" — it is text like
         any other, and the type scale accounts for however long it runs. */
      title: txt(s.title,"RAW MATERIAL",120),
      para:  txt(s.para,"",1200),           // free paragraph printed under the fields
      /* Colours are only ever #rrggbb literals because they are written into
         the print stylesheet; the picture is only ever a raster data URL (no
         SVG — it can carry script). The server enforces the same shapes. */
      bg: hex6(s.bg,"#ffffff"),
      capC: hex6(s.capC,""), valC: hex6(s.valC,""),      // "" = the auto ink
      font: STICKER_FONTS.some(f=>f.v===s.font)?s.font:"times",
      titleC: hex6(s.titleC,""), prodC: hex6(s.prodC,""), paraC: hex6(s.paraC,""),
      /* one colour per field row, keyed like fields; absent = the global ink */
      fieldC: (()=>{ const o={}; all.forEach(f=>{ const v=s.fieldC&&s.fieldC[f.k];
        if(/^#[0-9a-fA-F]{6}$/.test(String(v||""))) o[f.k]=String(v).toLowerCase(); }); return o; })(),
      /* per-block font size in mm; 0 = the auto type scale */
      fs: (()=>{ const src=s.fs||{}, o={}; STICKER_FREE.forEach(k=>{ o[k]=dim(src[k],0,0,60); }); return o; })(),
      /* free positions: a block with an entry here leaves the flow and sits at
         (x,y) mm from the label's top-left; absent = the normal stacked flow */
      pos: (()=>{ const src=s.pos||{}, o={}; STICKER_FREE.forEach(k=>{ const p=src[k];
        if(p&&typeof p==="object"&&isFinite(+p.x)&&isFinite(+p.y))
          o[k]={x:dim(p.x,0,-500,1000),y:dim(p.y,0,-500,1000)}; }); return o; })(),
      shape: ["rect","round","ellipse","circle","disc"].indexOf(s.shape)>=0?s.shape:"rect",
      radius: dim(s.radius,4,0,100),
      holeDia: dim(s.holeDia,15,0,1000),
      autoFit: ["gaps","size","none"].indexOf(s.autoFit)>=0?s.autoFit
        :(s.autoSize===false?"none":"gaps"),
      bgImg: (typeof s.bgImg==="string"&&s.bgImg.length<=750000
        &&/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(s.bgImg))?s.bgImg:"",
      bgImgOp: int(s.bgImgOp,70,0,95),
      bgImgFit: s.bgImgFit==="h"?"h":"w",
      bgImgX: dim(s.bgImgX,0,-300,300), bgImgY: dim(s.bgImgY,0,-300,300),
      syms: (Array.isArray(s.syms)?s.syms:[]).slice(0,12).map(o=>{
        const g=String((o&&o.g)||"").trim();
        if(!g||[...g].length>2) return null;
        return {g, x:dim(o&&o.x,0,0,1000), y:dim(o&&o.y,0,0,1000), s:dim(o&&o.s,8,2,200)};
      }).filter(Boolean),
      layout: s.layout==="plain"?"plain":"table",
      copies: int(s.copies,1,1,500),
      page: PAGE_SIZES.some(p=>p.v===s.page)?s.page:"A4",
      pageW: pick(s.pageW,210,20,1000), pageH: pick(s.pageH,297,20,1000),
      landscape: !!s.landscape,
      unit: s.unit==="cm"?"cm":"mm",
      mTop: dim(s.mTop,10,0,200),  mBottom: dim(s.mBottom,10,0,200),
      mLeft: dim(s.mLeft,8,0,200), mRight: dim(s.mRight,8,0,200),
      rows: int(s.rows,2,1,50),    cols: int(s.cols,2,1,20),
      /* No preset label size: 0 means "never set", and the layout decides.
         The legacy roll w/h is deliberately NOT read across — it would put
         a 100 × 150 default back on labels nobody asked for. */
      labelW: dim(s.labelW,0,0,1000), labelH: dim(s.labelH,0,0,1000),
      gapX: dim(s.gapX,3,0,100),   gapY: dim(s.gapY,3,0,100),
    };
  }

  /* Page in mm after the orientation swap. */
  function pageMM(cfg){
    const p=PAGE_SIZES.find(x=>x.v===cfg.page)||PAGE_SIZES[1];
    const w=p.v==="custom"?cfg.pageW:p.w, hh=p.v==="custom"?cfg.pageH:p.h;
    return cfg.landscape?{w:hh,h:w}:{w:w,h:hh};
  }

  /* Everything the layout step, the diagram and the printer need to agree on.
     Auto-fit solves ONE side of the geometry from the rest:
       "size"  — the label is whatever the margins, grid and gaps leave over
       "gaps"  — the label size is the operator's; the gaps stretch so the run
                 of labels spans margin to margin on both axes
       "none"  — everything is the operator's, and `fits` reports the truth.
     A circle or disc has one diameter, so both dimensions collapse to it.
     The EFFECTIVE gaps live in the result (gapX/gapY) — the diagram and the
     printed sheet must read them from here, never from cfg. */
  function stickerGeom(cfg){
    const pg=pageMM(cfg);
    const innerW=pg.w-cfg.mLeft-cfg.mRight, innerH=pg.h-cfg.mTop-cfg.mBottom;
    const round=cfg.shape==="circle"||cfg.shape==="disc";
    let lw=cfg.labelW, lh=cfg.labelH, gx=cfg.gapX, gy=cfg.gapY;
    if(round&&lw>0&&lh>0){ const d=Math.min(lw,lh); lw=lh=d; }
    /* An unset size (0) always derives from the layout, whatever the mode, so
       a config that has never had a size typed into it still has one to print. */
    if(cfg.autoFit==="size"||!(lw>0)||!(lh>0)){
      lw=(innerW-(cfg.cols-1)*gx)/cfg.cols;
      lh=(innerH-(cfg.rows-1)*gy)/cfg.rows;
      if(round){ const d=Math.min(lw,lh); lw=lh=d; }
    }else if(cfg.autoFit==="gaps"){
      gx=cfg.cols>1?(innerW-cfg.cols*lw)/(cfg.cols-1):0;
      gy=cfg.rows>1?(innerH-cfg.rows*lh)/(cfg.rows-1):0;
      gx=Math.max(0,Math.round(gx*10)/10);      // labels wider than the sheet
      gy=Math.max(0,Math.round(gy*10)/10);      // clamp to 0 and read as overflow
    }
    lw=Math.round(lw*10)/10; lh=Math.round(lh*10)/10;
    const needW=cfg.cols*lw+(cfg.cols-1)*gx, needH=cfg.rows*lh+(cfg.rows-1)*gy;
    const EPS=0.15;                       // a rounded 0.1mm must not read as overflow
    return { pgW:pg.w, pgH:pg.h, innerW, innerH, labelW:lw, labelH:lh, gapX:gx, gapY:gy,
      needW, needH, overW:needW-innerW, overH:needH-innerH,
      fitsW: lw>=5 && needW<=innerW+EPS, fitsH: lh>=5 && needH<=innerH+EPS,
      fits: lw>=5 && lh>=5 && needW<=innerW+EPS && needH<=innerH+EPS,
      perPage: Math.max(1,cfg.rows*cfg.cols) };
  }

  /* ---- How one label is composed at the chosen size -------------------
     NO AUTOMATIC BRANDING — the user ruled it out (2026-08-11): no wordmark
     on top, no watermark behind, on any size or colour of label. A logo is
     something the operator PLACES, through the background-picture option,
     wherever and as faint as they want it.

     Type scales to the room there is: the 100 × 150 mm label is the
     reference design (k = 1) and k shrinks until the ticked rows fit the
     label's height, so untick a field and everything else prints bigger. */
  const STICKER_BIG_W=100;
  function labelMetrics(cfg,geom,list){
    const lw=geom.labelW, lh=geom.labelH;
    const added=addedDefs(cfg);
    const rows=added.filter(x=>x.row);
    const head=added.some(x=>x.head), status=added.some(x=>x.boxes);
    const plain=cfg.layout==="plain";
    /* Text inside a curved outline must keep off the curve: the inscribed
       rectangle of an ellipse insets each side by (1−1/√2)/2 ≈ 14.6% of the
       full dimension, so curved shapes take that on top of the base padding. */
    const curved=cfg.shape==="ellipse"||cfg.shape==="circle"||cfg.shape==="disc";
    const padY=Math.max(1.2,lh*.035)+(curved?lh*.1464:0);
    const padX=Math.max(1.2,lw*.045)+(curved?lw*.1464:0);
    const avail=lh-2*padY, inner=Math.max(lw-2*padX,1);

    /* The longest text that will actually print, across EVERY label in the
       run — one label's long product name must not overflow a size chosen
       from a shorter one, since all of them share the one stylesheet. */
    const all=(list&&list.length)?list:[{}];

    /* Lines a string occupies at a given width — counting BOTH the newlines
       the operator typed (every value box is multi-line now) and the wraps a
       long line makes on its own. Times New Roman averages about 0.48 em per
       character, which is close enough to choose a type size by. */
    const linesOf=(t,wMM,fontMM)=>String(t==null?"":t).split("\n")
      .reduce((n,seg)=>n+Math.max(1,Math.ceil(seg.length*fontMM*.48/Math.max(wMM,.1))),0);
    const worst=(pick,wMM,fontMM)=>all.reduce((n,v)=>Math.max(n,linesOf(pick(v),wMM,fontMM)),1);

    /* How tall the composition stands at scale k. Assuming one line per row is
       what used to push the status boxes off a small label and let
       overflow:hidden quietly cut them away. */
    /* A block the operator dragged free of the flow (cfg.pos) takes no flow
       height; a block with its own font size (cfg.fs, mm) keeps that size at
       every k instead of riding the scale. */
    const posOf=(q)=>cfg.pos&&cfg.pos[q];
    const fsOr=(q,d)=>(cfg.fs&&cfg.fs[q]>0)?cfg.fs[q]:d;
    function needAt(k){
      const font=fsOr("body",3*k), cellPad=plain?1.4*k:3.8*k;
      const capW=inner*.47-cellPad, valW=inner*.53-cellPad;
      const rowExtra=plain?(1.6*k):(3*k+0.3*k);           // padding (+ border in table mode)
      let hgt=0;
      const tF=fsOr("title",4.6*k), pF=fsOr("prod",3.8*k), gF=fsOr("para",2.7*k);
      if(cfg.title&&!posOf("title")) hgt+=linesOf(cfg.title,inner,tF)*tF*1.35+3.2*k;
      if(head&&!posOf("prod")) hgt+=worst(v=>"PRODUCT: "+(v.product||""),inner,pF)*pF*1.35+4.2*k;
      if(!posOf("body")){
        rows.forEach(x=>{
          hgt+=Math.max(linesOf(x.cap,capW,font),worst(v=>v[x.k],valW,font))*font*1.35+rowExtra;
        });
        if(status) hgt+=3*font*1.45+rowExtra;
      }
      if(cfg.para&&!posOf("para")) hgt+=linesOf(cfg.para,inner,gF)*gF*1.35+3*k;
      return hgt;
    }
    /* The largest scale that still fits. needAt() only steps upward with k, so
       a bisection lands on it; the width cap keeps long type off the edges.
       It aims at 94% of the height rather than 100%: the estimate carries a
       few percent of error, and erring high CLIPS the label — overflow is
       hidden, so a status box simply disappears. Erring low costs nothing,
       because the table then flex-grows into whatever slack is left. */
    const fitH=avail*.94;
    let k=Math.min(2.5,Math.max(lw/STICKER_BIG_W,.18));
    if(needAt(k)>fitH){
      let lo=.12, hi=k;
      for(let i=0;i<26;i++){ const mid=(lo+hi)/2; if(needAt(mid)<=fitH) lo=mid; else hi=mid; }
      k=Math.max(.12,lo);
    }
    return {rows,head,status,plain,padY,padX,k};
  }

  const STICKER_STATUS_PLAIN=`<div>[&nbsp;&nbsp;&nbsp;&nbsp;] UNDER TEST</div>`
    +`<div>[&nbsp;&nbsp;&nbsp;&nbsp;] APPROVED</div>`
    +`<div>[&nbsp;&nbsp;&nbsp;&nbsp;] REJECTED</div>`;
  const STICKER_STATUS_TR=`<tr><th>STATUS</th><td class="st">${STICKER_STATUS_PLAIN}</td></tr>`;

  /* Sizes are in mm, not px: a millimetre means the same thing to the printer
     as it does on screen, so the preview and the sheet cannot drift apart. */
  /* Ink that stays readable on whatever background was chosen: a dark label
     with black rules and black type prints as a solid block. Luminance decides,
     so the operator picks a colour and the label keeps working. */
  function labelInk(bg){
    const m=/^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(String(bg||"#ffffff"));
    if(!m) return "#000";
    const lin=(c)=>{ c=parseInt(c,16)/255; return c<=.03928?c/12.92:Math.pow((c+.055)/1.055,2.4); };
    const L=.2126*lin(m[1])+.7152*lin(m[2])+.0722*lin(m[3]);
    return L>.42?"#000":"#fff";      // same threshold the preview swatch uses
  }
  function labelCss(geom,m,cfg){
    const u=(n)=>(n*m.k).toFixed(2)+"mm";
    const bg=(cfg&&cfg.bg)||"#ffffff", ink=labelInk(bg);
    // the operator's own inks when set; the luminance-picked one otherwise
    const capC=(cfg&&cfg.capC)||ink, valC=(cfg&&cfg.valC)||ink;
    const shape=(cfg&&cfg.shape)||"rect";
    const rad=shape==="round"?`${cfg.radius||0}mm`
      :(shape==="ellipse"||shape==="circle"||shape==="disc")?"50%":"0";
    /* A shaped label cut from white stock is invisible without its cut line;
       on a coloured or pictured ground the shape shows itself. */
    const guide=(shape!=="rect"&&bg==="#ffffff")?`box-shadow:inset 0 0 0 .15mm #999;`:"";
    return `
  .lb{position:relative;width:${geom.labelW}mm;height:${geom.labelH}mm;overflow:hidden;background:${bg};
    border-radius:${rad};${guide}
    font:${u(3.2)}/1.35 ${fontCss(cfg&&cfg.font)};color:${ink};
    -webkit-print-color-adjust:exact;print-color-adjust:exact}
  /* the operator's background picture: scaled to one side of the label,
     faded by the transparency dial, nudged by the offsets */
  .lb .bgi{position:absolute;z-index:0;pointer-events:none;
    left:calc(50% + ${(cfg&&cfg.bgImgX)||0}mm);top:calc(50% + ${(cfg&&cfg.bgImgY)||0}mm);
    transform:translate(-50%,-50%);${(cfg&&cfg.bgImgFit)==="h"?"height":"width"}:100%;
    opacity:${((100-((cfg&&cfg.bgImgOp!=null)?cfg.bgImgOp:70))/100).toFixed(2)}}
  /* placed symbols ride above the content, each at its own spot and size */
  .lb .sy{position:absolute;z-index:2;line-height:1;transform:translate(-50%,-50%);
    color:${ink};pointer-events:none}
  /* the free layer: blocks the operator dragged out of the flow sit here, at
     absolute mm positions measured from the label's top-left corner */
  .lb .fl{position:absolute;inset:0;z-index:1;pointer-events:none}
  .lb .fl>*{position:absolute;max-width:96%}
  .lb .fl>table{width:${Math.max(geom.labelW-2*m.padX,10).toFixed(2)}mm;flex:none}
  .lb .fl>.pl{flex:none}
  /* the disc's punched hole: paper shows through, with its own cut line */
  .lb .hole{position:absolute;z-index:3;left:50%;top:50%;transform:translate(-50%,-50%);
    width:${(cfg&&cfg.holeDia)||0}mm;height:${(cfg&&cfg.holeDia)||0}mm;border-radius:50%;
    background:#fff;box-shadow:inset 0 0 0 .15mm #999}
  .lb .in{position:relative;z-index:1;height:100%;box-sizing:border-box;
    padding:${m.padY.toFixed(2)}mm ${m.padX.toFixed(2)}mm;display:flex;flex-direction:column}
  .lb .ttl{text-align:center;font-size:${u(4.6)};font-weight:700;letter-spacing:.02em;margin-bottom:${u(3.2)}}
  .lb .prod{font-size:${u(3.8)};font-weight:700;margin:0 0 ${u(4.2)};white-space:pre-wrap}
  /* flex:1 hands the field block whatever height the header did not use, and
     the rows share it out — so the fields fill the label instead of stranding
     a band of blank paper under the last row. */
  .lb table{width:100%;border-collapse:collapse;table-layout:fixed;flex:1 1 auto}
  .lb th,.lb td{border:${Math.max(.15,.25*m.k).toFixed(2)}mm solid ${ink};padding:${u(1.5)} ${u(1.9)};
    font-size:var(--bfs,${u(3.0)});font-weight:400;text-align:left;vertical-align:middle;
    overflow-wrap:anywhere;white-space:pre-wrap}
  .lb th{width:47%;color:${capC}}
  .lb td{font-weight:700;color:${valC}}
  .lb td.st{font-weight:400;line-height:1.45;white-space:nowrap}
  /* Non-table layout: the SAME two columns and the same alignment, with the
     rules simply not drawn. */
  .lb .pl{flex:1 1 auto;display:flex;flex-direction:column;justify-content:space-between}
  .lb .pr{display:flex;align-items:baseline;gap:${u(1.4)};padding:${u(.8)} 0}
  .lb .pk{width:47%;flex:0 0 47%;font-size:var(--bfs,${u(3.0)});font-weight:400;color:${capC}}
  .lb .pv{flex:1 1 auto;font-size:var(--bfs,${u(3.0)});font-weight:700;color:${valC};
    overflow-wrap:anywhere;white-space:pre-wrap}
  .lb .pv.st{font-weight:400;line-height:1.45;white-space:nowrap}
  /* the free paragraph, set smaller than the fields so it reads as a note */
  .lb .para{margin-top:${u(3)};font-size:${u(2.7)};line-height:1.35;
    white-space:pre-wrap;overflow-wrap:anywhere;flex:0 0 auto}
  /* an unknown field prints as clear space the store writes on by hand */
  .lb .wr{display:block;height:${u(3.0)}}`;
  }

  function labelHtml(v,cfg,m){
    const BLANK='<span class="wr"></span>';
    const cell=(x)=>x?esc(x):BLANK;
    /* Every block carries a data-drag handle (the design pane binds to it; the
       printed page simply ignores it) and its own inline ink, size and — when
       the operator dragged it free of the flow — position. */
    const posOf=(k)=>cfg.pos&&cfg.pos[k];
    const bstyle=(k,color)=>{
      const bits=[];
      if(color) bits.push("color:"+color);
      if(cfg.fs&&cfg.fs[k]>0) bits.push((k==="body"?"--bfs:":"font-size:")+cfg.fs[k]+"mm");
      const p=posOf(k);
      if(p) bits.push("left:"+p.x+"mm","top:"+p.y+"mm");
      return bits.length?` style="${bits.join(";")}"`:"";
    };
    const rc=(k)=>cfg.fieldC&&cfg.fieldC[k]?` style="color:${cfg.fieldC[k]}"`:"";
    const blocks={};
    blocks.title=cfg.title?`<div class="ttl" data-drag="title"${bstyle("title",cfg.titleC)}>${esc(cfg.title)}</div>`:"";
    blocks.prod=m.head?`<div class="prod" data-drag="prod"${bstyle("prod",cfg.prodC)}>PRODUCT: <b>${cell(v.product)}</b></div>`:"";
    blocks.body=(m.rows.length||m.status)?(m.plain
      ? `<div class="pl" data-drag="body"${bstyle("body","")}>${m.rows.map(x=>
          `<div class="pr"><span class="pk"${rc(x.k)}>${esc(x.cap)}</span><span class="pv"${rc(x.k)}>${cell(v[x.k])}</span></div>`).join("")}${
          m.status?`<div class="pr"><span class="pk">STATUS</span><span class="pv st">${STICKER_STATUS_PLAIN}</span></div>`:""}</div>`
      : `<table data-drag="body"${bstyle("body","")}><tbody>${m.rows.map(x=>
          `<tr><th${rc(x.k)}>${esc(x.cap)}</th><td${rc(x.k)}>${cell(v[x.k])}</td></tr>`).join("")}${
          m.status?STICKER_STATUS_TR:""}</tbody></table>`):"";
    blocks.para=cfg.para?`<div class="para" data-drag="para"${bstyle("para",cfg.paraC)}>${esc(cfg.para)}</div>`:"";
    const flow=STICKER_FREE.filter(k=>!posOf(k)).map(k=>blocks[k]||"").join("");
    const free=STICKER_FREE.filter(k=>posOf(k)&&blocks[k]).map(k=>blocks[k]).join("");
    /* Decoration around the content: the operator's own picture (their only
       watermark — the label carries no branding of its own), the placed
       symbols, and the disc's punched hole on top of everything. */
    const deco=(cfg.bgImg?`<img class="bgi" data-drag="img" src="${cfg.bgImg}" alt="">`:"")
      +(cfg.syms||[]).map((o,i)=>`<span class="sy" data-drag="sym:${i}" style="left:${o.x}mm;top:${o.y}mm;`+
        `font-size:${o.s}mm">${esc(o.g)}</span>`).join("")
      +(cfg.shape==="disc"&&cfg.holeDia>0?`<div class="hole"></div>`:"");
    return `<div class="lb">${deco}
      <div class="in">${flow}</div>
      ${free?`<div class="fl">${free}</div>`:""}</div>`;
  }

  /* THE one document behind both the preview and the printer, so what the
     operator approves in step 3 is byte-for-byte what comes out of the tray.
     opts.print  adds the auto-print script (the browser's printer dialog)
     opts.onlyPage renders a single page — the preview pane's pager */
  /* Each label repeated `copies` times, kept together so the two stickers for
     one drum come off the sheet side by side rather than a sheet apart. */
  function expandCopies(cfg,list){
    const n=Math.max(1,Math.min(500,+cfg.copies||1));
    if(n===1) return list.slice();
    const out=[];
    list.forEach(v=>{ for(let i=0;i<n;i++) out.push(v); });
    return out;
  }

  function labelSheetHtml(po,cfg,rawList,opts){
    opts=opts||{};
    const list=expandCopies(cfg,rawList);
    const geom=stickerGeom(cfg), m=labelMetrics(cfg,geom,list);
    const chunks=[];
    for(let i=0;i<list.length;i+=geom.perPage) chunks.push(list.slice(i,i+geom.perPage));
    if(!chunks.length) chunks.push([]);
    const use=opts.onlyPage!=null?[chunks[Math.min(opts.onlyPage,chunks.length-1)]||[]]:chunks;
    const pages=use.map(c=>`<div class="pg">${c.map(v=>labelHtml(v,cfg,m)).join("")}</div>`).join("");
    return `<!doctype html><html><head><meta charset="utf-8">
<title>Raw Material Labels — ${esc(po.id)}</title>
<style>
  /* Declare the sheet size or the browser falls back to its own default
     (US Letter), which clips the last column off every page. */
  @page{size:${geom.pgW}mm ${geom.pgH}mm;margin:0}
  *{margin:0;padding:0;box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  html,body{background:#fff}
  .pg{width:${geom.pgW}mm;height:${geom.pgH}mm;overflow:hidden;background:#fff;
    padding:${cfg.mTop}mm ${cfg.mRight}mm ${cfg.mBottom}mm ${cfg.mLeft}mm;
    display:grid;grid-template-columns:repeat(${cfg.cols},${geom.labelW}mm);
    grid-auto-rows:${geom.labelH}mm;column-gap:${geom.gapX}mm;row-gap:${geom.gapY}mm;
    align-content:start;justify-content:start;
    page-break-after:always;break-after:page}
  .pg:last-child{page-break-after:auto;break-after:auto}
  ${labelCss(geom,m,cfg)}
</style></head>
<body>${pages}${opts.print?`
<script>window.onload=function(){setTimeout(function(){window.print();},350);};<\/script>`:""}
</body></html>`;
  }

  /* One label on its own, for the design half of the preview. The whole run
     is still passed in, so this previews at the SAME scale the sheet prints
     at rather than at one sized to this label's own text. */
  function labelOneHtml(cfg,v,list){
    const geom=stickerGeom(cfg), m=labelMetrics(cfg,geom,list||[v]);
    return `<!doctype html><html><head><meta charset="utf-8"><style>
  *{margin:0;padding:0;box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  html,body{background:#fff}
  ${labelCss(geom,m,cfg)}
</style></head><body>${labelHtml(v,cfg,m)}</body></html>`;
  }

  function printLabels(po,cfg,list){
    const w=window.open("","_blank");
    if(!w){ toast("Popup blocked — allow popups for this site to print",{type:"warn"}); return; }
    w.document.write(labelSheetHtml(po,cfg,list,{print:true})); w.document.close();
  }

  /* One editable value bag per ordered line, keyed the way STICKER_FIELDS is.
     What the PO knows arrives filled in; what it cannot know (the supplier's
     own invoice number, the inspector) arrives empty for the operator to type
     in the dialog — those used to print as a blank nobody could fill here. */
  function stickerValues(po,cfg){
    const defs=cfg?fieldDefs(cfg):STICKER_FIELDS;
    return stickerData(po).map(r=>{
      const v={};
      // an invented field has no source on the order, so it starts empty
      defs.forEach(f=>{ if(!f.boxes) v[f.k]=r[f.src||f.k]||""; });
      return v;
    });
  }

  /* ============================================================
     INCOMING-MATERIAL TESTING ("GRN testing")
     A purchase order is received, the server issues a numbered GRN,
     and the material then has to be checked before anyone trusts
     it. The lab incharge opens the receipt from here, enters the
     readings for each material, and the verdict comes back onto the
     purchase order.

     WHAT THIS SIDE MAY KNOW: the limits a reading is graded against
     never leave the server, and the lab role is not sent the verdict
     either (backend grnTestService + viewService explain why). So
     `test.result` is simply ABSENT for the incharge, and every badge
     here falls back to "measured / not measured" rather than
     inventing a grade. Grading is the server's job, always.
     ============================================================ */
  const qcTests = () => ENG.data.grnTests || [];
  const qcTestFor = (grnId,itemId) => qcTests().find(t=>t.grnId===grnId&&t.itemId===itemId) || null;
  /** Per-line state for one receipt + the receipt's own roll-up. */
  function qcForGrn(g){
    const lines=(g.lines||[]).map(l=>{
      const t=qcTestFor(g.id,l.itemId);
      return {itemId:l.itemId, name:l.name||l.itemId, test:t, tested:!!(t&&t.complete),
        // a failed lot with no ruling yet is the state that needs a human
        awaiting:!!(t&&t.result==="Fail"&&!t.decision),
        decision:(t&&t.decision)||""};
    });
    const done=lines.filter(l=>l.tested).length;
    return {lines, total:lines.length, tested:done, pending:lines.length-done,
      fail:lines.some(l=>l.test&&l.test.result==="Fail"),
      awaiting:lines.filter(l=>l.awaiting).length,
      quarantined:lines.filter(l=>l.decision==="quarantined").length,
      released:lines.filter(l=>l.decision==="released").length,
      pass:done===lines.length&&lines.length>0&&lines.some(l=>l.test&&l.test.result==="Pass")};
  }
  /** Roll every receipt of one order into a single verdict for the PO list. */
  function qcForPo(po){
    const gs=(ENG.data.grns||[]).filter(g=>g.poId===po.id&&g.status!=="Cancelled");
    if(!gs.length) return null;
    const each=gs.map(qcForGrn);
    const pending=each.reduce((s,x)=>s+x.pending,0);
    const total=each.reduce((s,x)=>s+x.total,0);
    return {pending, total, tested:total-pending,
      fail:each.some(x=>x.fail),
      awaiting:each.reduce((s,x)=>s+x.awaiting,0),
      quarantined:each.reduce((s,x)=>s+x.quarantined,0),
      released:each.reduce((s,x)=>s+x.released,0),
      pass:!pending&&each.some(x=>x.pass)};
  }
  /* One badge, several audiences and several states. Order matters: an
     UNRULED FAILURE outranks everything, because the lot is sitting in the
     store and drawable until somebody decides. Then the settled outcomes
     (quarantined / released), then testing progress, then the verdict.
     Never render a grade the payload did not carry — for the lab incharge the
     verdict is absent by design, and an absent verdict is a redaction, not a
     pass. */
  function qcBadge(st){
    if(!st) return '<span class="muted">—</span>';
    if(st.awaiting) return badge("danger","⛔ Approval due");
    if(st.quarantined) return badge("danger","Quarantined");
    if(st.fail) return badge("warn","✗ Failed · released");
    if(st.pending) return badge("warn",st.tested?`Testing ${st.tested}/${st.total}`:"Test due");
    if(App.isLab()) return badge("ok","✓ Tested");
    return st.pass?badge("ok","✓ QC Pass"):badge("info","Recorded");
  }
  function qcLineBadge(l){
    if(!l.tested) return badge("warn","Test due");
    if(l.awaiting) return badge("danger","⛔ Approval due");
    if(l.decision==="quarantined") return badge("danger","Quarantined");
    if(l.decision==="released") return badge("warn","Failed · released");
    if(l.test&&l.test.result==="Fail") return badge("danger","✗ Fail");
    if(App.isLab()||!l.test||!l.test.result) return badge("ok","✓ Tested");
    return l.test.result==="Pass"?badge("ok","✓ Pass"):badge("info",l.test.result);
  }

  /* ============================================================
     THE ADMIN'S RULING ON A FAILED LOT
     The lab has failed a material. The goods were booked into the store when
     the receipt was posted, so the failure did not move anything — it put the
     lot here. Approving the rejection transfers it to the quarantine store,
     where production cannot draw it. Declining it leaves the lot exactly where
     it is, as good stock. Both are recorded against the test report with who
     ruled and when, because this is the decision that says whether the factory
     may use the material.
     ============================================================ */
  function qcDecisionForm(q, after){
    const sup=(ENG.data.suppliers||[]).find(s=>s.id===q.supplierId);
    const wh=(ENG.data.warehouses||[]).find(w=>w.id===q.wh);
    const hold=(ENG.data.warehouses||[]).find(w=>/quarantine|qc.?hold|reject/i.test(String(w.type||"")+" "+String(w.name||"")));
    const body=h("div",{},[
      h("div",{class:"qc-note bad",style:"font-size:13px;margin-bottom:16px",
        text:q.itemName+" failed its incoming test on "+((q.failed||[]).join(", ")||"a measured parameter")
          +". The lot is in "+((wh&&wh.name)||q.wh||"the store")+" now and production can still draw it until you decide."}),
      MW.dl([["Material",q.itemName],["Code",q.itemId],
        ["Quantity in question",ENG.qtyText(ENG.item(q.itemId),q.acceptedQty,3)||ENG.num(q.acceptedQty,3)+" "+(q.uom||"")],
        ["Goods Receipt",q.grnId],["Purchase Order",q.poId||"—"],
        ["Supplier",(sup&&sup.name)||q.supplierId||"—"],
        ["Out of limit",(q.failed||[]).join(", ")||"—"],
        ["Tested by",(q.testedBy||"—")+(q.testedAt?" on "+String(q.testedAt).slice(0,10):"")]]),
      h("div",{class:"field full",style:"margin-top:16px"},[
        h("label",{text:"Note (kept on the test report)"}),
        h("textarea",{class:"input",id:"qcdNote",rows:"2",maxlength:"500",
          placeholder:"why you are approving or declining the rejection"}),
      ]),
      h("div",{class:"qc-note",style:"font-size:12px;margin-top:14px",
        text:"Approve → the lot moves to "+((hold&&hold.name)||"the quarantine store")
          +" and no work order can draw it. Decline → the lot stays where it is and counts as good stock. "
          +"Neither writes the material off; returning it to the supplier is a separate debit note."}),
    ]);
    const mo=modal({title:"⛔ Failed lot — your ruling", sub:q.grnId+" · "+q.itemName, wide:true, body,
      foot:[h("button",{class:"btn ghost",onclick:()=>mo.close(),text:"Decide later"}),
        h("button",{class:"btn",id:"qcdNo",onclick:()=>go(false),text:"Decline — keep as stock"}),
        h("button",{class:"btn danger",id:"qcdYes",onclick:()=>go(true),text:"Approve — quarantine the lot"})]});
    async function go(approve){
      const y=UI.$("#qcdYes"), n=UI.$("#qcdNo");
      y.disabled=n.disabled=true; (approve?y:n).textContent="Saving…";
      try{
        const r=await DB.grnTests.decide(q.id,approve,UI.$("#qcdNote").value);
        mo.close();
        toast(approve
          ? (r.moved?`Quarantined — ${ENG.num(r.moved.qty,3)} ${q.uom||""} moved out of reach of production`
                    :"Quarantined — the lot is marked and cannot be drawn")
          : "Rejection declined — the lot stands as good stock",
          {type:approve?"warn":"ok",title:"Failed lot"});
        // same reason as the reading save: the ruling has to be back in
        // ENG.data before `after` re-renders anything that reads it
        await App.reloadState();
        if(after) after();
      }catch(e){
        toast(e.message||"Could not record the ruling",{type:"danger"});
        y.disabled=n.disabled=false; y.textContent="Approve — quarantine the lot"; n.textContent="Decline — keep as stock";
      }
    }
  }

  /* Every failed lot still waiting on a ruling, in one place — reached from the
     Procurement KPI and from the alerts drawer. */
  function qcDecisionQueue(){
    const list=ENG.data.grnQcDecisions||[];
    if(!list.length){ toast("No failed lots are waiting on a decision.",{type:"ok"}); return; }
    const admin=App.isAdmin&&App.isAdmin();
    const body=h("div",{},[
      h("div",{class:"qc-note bad",style:"font-size:13px;margin-bottom:14px",
        text:list.length+(list.length===1?" lot has":" lots have")+" failed an incoming test and "
          +(admin?"needs your ruling":"is waiting on an admin's ruling")
          +". Until then the material stays in the store and production can draw it."}),
      table(list,[
        {key:"item",label:"Material",cls:"nm",render:q=>`<div class="cell-main">${esc(q.itemName)}</div><div class="cell-sub">${esc(q.itemId)}</div>`,noSort:true},
        {key:"qty",label:"Quantity",num:true,render:q=>{const it=ENG.item(q.itemId);return it?esc(ENG.qtyText(it,q.acceptedQty,3)):ENG.num(q.acceptedQty,3)+" "+esc(q.uom||"");},noSort:true},
        {key:"failed",label:"Out of limit",render:q=>esc((q.failed||[]).join(", ")||"—"),noSort:true},
        {key:"grn",label:"Receipt",render:q=>`<span class="mono">${esc(q.grnId)}</span>`,noSort:true},
        {key:"po",label:"Order",render:q=>esc(q.poId||"—"),noSort:true},
        {key:"by",label:"Tested By",render:q=>esc(q.testedBy||"—"),noSort:true},
        {key:"act",label:"",noSort:true,render:q=>admin
          ? h("button",{class:"btn sm danger",onclick:e=>{e.stopPropagation();UI.$("#modalHost").hidden=true;qcDecisionForm(q,qcDecisionQueue);},text:"Rule on it"})
          : h("span",{class:"muted",text:"admin only"})},
      ],{empty:"Nothing waiting"}),
    ]);
    modal({title:"⛔ Failed lots awaiting a ruling", sub:list.length+" pending", wide:true, body});
  }

  /* The entry form. Parameters and any readings already filed are FETCHED
     rather than read out of state: the parameter list belongs to the material
     master and is the one thing the client must not guess at, or a report ends
     up graded on a parameter the form never asked for. */
  async function grnTestForm(grnId,itemId,after){
    let f;
    try{ f=await DB.grnTests.form(grnId,itemId); }
    catch(e){ toast(e.message||"Could not open the test form",{type:"danger"}); return; }
    const sup=ENG.data.suppliers.find(s=>s.id===f.grn.supplierId);
    const vals=Object.assign({},f.values||{});
    const rows=(f.params||[]).map(p=>{
      const id="qc_"+p.key;
      const cur=vals[p.key]!=null?String(vals[p.key]):"";
      return h("div",{class:"field"},[
        h("label",{text:p.label+(p.unit?" ("+p.unit+")":"")}),
        p.type==="text"
          ? h("input",{class:"input",id,value:cur,placeholder:"as received",maxlength:"200"})
          : h("input",{class:"input",id,type:"number",step:"any",value:cur,placeholder:"measured value"}),
      ]);
    });
    const body=h("div",{},[
      MW.dl([["Material",f.item.name],["Code",f.item.id],
        ["Received",ENG.qtyText(f.item,f.line.accepted,3)],
        ["Goods Receipt",f.grn.id],["Purchase Order",f.grn.poId||"—"],
        ["Supplier",(sup&&sup.name)||f.grn.supplierId||"—"],
        ["Supplier Inv.",f.grn.invNo||"—"]]),
      /* SAMPLING + TRACEABILITY. A reading without a sample size is an
         anecdote — "0.081 mm" means one thing if three rolls of 200 were
         checked and another if all 200 were. And a failure cannot be pinned on
         the supplier without their own identity for the lot. All optional: the
         form asks, it does not invent. */
      h("h3",{style:"margin:18px 0 10px;font-size:14px",text:"Sampling & Traceability"}),
      h("div",{class:"form-grid"},[
        h("div",{class:"field"},[
          h("label",{text:"Sample size ("+(f.item.uom||"units")+" checked)"}),
          h("input",{class:"input",id:"qc_sample",type:"number",step:"any",min:"0",
            value:f.sampleSize!=null?String(f.sampleSize):"",
            placeholder:"of "+ENG.num(f.line.accepted,3)+" received"}),
        ]),
        h("div",{class:"field"},[
          h("label",{text:"Supplier batch / heat no."}),
          h("input",{class:"input",id:"qc_batch",maxlength:"60",value:f.supplierBatch||"",
            placeholder:"as marked on the bale / drum"}),
        ]),
        h("div",{class:"field"},[
          h("label",{text:"Supplier test certificate ref."}),
          h("input",{class:"input",id:"qc_cert",maxlength:"60",value:f.certRef||"",
            placeholder:"their COA / mill cert no."}),
        ]),
      ]),
      /* Say plainly when a material is running on the derived default list — it
         is the difference between "these are the checks we agreed" and "these
         are the fields the master happens to record". */
      !f.configured?h("div",{class:"qc-note",style:"margin:14px 0 0;font-size:12px",
        text:"No parameter list has been set for this material yet, so it is being checked on what the item master records. An admin can change the parameters and their limits from Stock Items."}):null,
      !f.specSet?h("div",{class:"qc-note",style:"margin:10px 0 0;font-size:12px",
        text:"No pass/fail limits are set for this material, so the readings are recorded but not graded."}):null,
      /* THE PARAMETER LIST IS EDITABLE FROM HERE. The person who notices a
         missing parameter is the one standing at the delivery with the
         micrometer, so they do not have to leave the report, find the material
         in Stock Items and come back. Lab incharge and admin both. */
      h("div",{class:"flex aic",style:"margin:18px 0 10px;gap:10px;flex-wrap:wrap"},[
        h("h3",{style:"margin:0;font-size:14px",text:"Test Readings"}),
        (App.isLab()||App.isAdmin())?h("button",{class:"btn sm ghost",
          title:"Add or remove the parameters this material is tested on",
          onclick:()=>editParams(),text:"✎ Edit parameters"}):null,
      ].filter(Boolean)),
      h("div",{class:"form-grid"},rows),
      h("div",{class:"field full",style:"margin-top:6px"},[
        h("label",{text:"Remarks"}),
        h("textarea",{class:"input",id:"qc_remarks",rows:"2",maxlength:"500",text:f.remarks||""}),
      ]),
      f.testedAt?h("div",{class:"muted",style:"font-size:12px;margin-top:10px",
        text:"Last filed by "+(f.testedBy||"—")+" on "+String(f.testedAt).slice(0,10)+" — saving again replaces that reading."}):null,
    ]);
    const mo=modal({title:"🧪 GRN Testing — "+f.item.name, sub:f.grn.id+(f.grn.poId?" · "+f.grn.poId:""),
      wide:true, body,
      foot:[h("button",{class:"btn ghost",onclick:()=>mo.close(),text:"Cancel"}),
        h("button",{class:"btn primary",id:"qcSave",onclick:save,text:"Save Test Report"})]});
    /* Reopen the reading form once the parameter list changes, so the parameter
       just added is immediately a field to fill in rather than something the
       user has to go and find again. */
    function editParams(){
      const it=ENG.item(itemId);
      const edit=(window._erpUtil||{}).qcForm;
      if(!it||!edit){ toast("The material master is not loaded — try again.",{type:"warn"}); return; }
      mo.close();
      edit(it,()=>grnTestForm(grnId,itemId,after));
    }
    async function save(){
      const out={};
      (f.params||[]).forEach(p=>{ const el=UI.$("#qc_"+p.key); if(el) out[p.key]=el.value; });
      const btn=UI.$("#qcSave"); btn.disabled=true; btn.textContent="Saving…";
      try{
        await DB.grnTests.submit(grnId,{itemId, values:out,
          remarks:UI.$("#qc_remarks").value,
          sampleSize:UI.$("#qc_sample").value,
          supplierBatch:UI.$("#qc_batch").value,
          certRef:UI.$("#qc_cert").value});
        mo.close();
        /* The incharge is told it was filed, not how it graded — the office
           reads the verdict. Saying "Pass" here would defeat the redaction. */
        toast(App.isLab()?"Reading filed for "+f.item.name:"Test report saved for "+f.item.name,
          {type:"ok",title:"GRN testing"});
        /* reloadState, NOT refreshView: refreshView only re-renders from the
           dataset already in memory, so the reading we just filed was still
           missing from ENG.data.grnTests and the report panel reopened saying
           "0 tested / Test due" on a receipt the server had stored complete. */
        await App.reloadState();
        if(after) after();
      }catch(e){
        toast(e.message||"Could not save the test report",{type:"danger"});
        btn.disabled=false; btn.textContent="Save Test Report";
      }
    }
  }

  /* Every material on one receipt, so the incharge can work down a delivery
     instead of hunting line by line from the order screen. */
  function grnTestPanel(g){
    const st=qcForGrn(g);
    const body=h("div",{},[
      MW.dl([["Goods Receipt",g.id],["Date",g.date||"—"],
        ["Purchase Order",g.poId||"—"],["Supplier Inv.",g.invNo||"—"],
        ["Materials",st.total+" · "+st.tested+" tested"]]),
      h("h3",{style:"margin:18px 0 10px;font-size:14px",text:"Materials Received"}),
      table(st.lines,[
        {key:"item",label:"Material",cls:"nm",render:l=>`<div class="cell-main">${esc(l.name)}</div><div class="cell-sub">${esc(l.itemId)}</div>`,noSort:true},
        {key:"qc",label:"QC",render:l=>qcLineBadge(l),noSort:true},
        {key:"by",label:"Tested By",render:l=>esc((l.test&&l.test.testedBy)||"—"),noSort:true},
        {key:"act",label:"",noSort:true,render:l=>h("div",{class:"flex gap aic",style:"gap:6px;justify-content:flex-end"},[
          /* A lot that failed and is waiting on a ruling puts the ruling first —
             re-testing it is not the next step, deciding is. */
          (l.awaiting&&App.isAdmin&&App.isAdmin())?h("button",{class:"btn sm danger",
            onclick:e=>{e.stopPropagation();
              const q=(ENG.data.grnQcDecisions||[]).find(x=>x.grnId===g.id&&x.itemId===l.itemId);
              UI.$("#modalHost").hidden=true;
              if(q) qcDecisionForm(q,()=>grnTestPanel(g)); else qcDecisionQueue();},
            text:"Rule on it"}):null,
          h("button",{class:"btn sm "+(l.tested?"":"primary"),
            onclick:e=>{e.stopPropagation();UI.$("#modalHost").hidden=true;grnTestForm(g.id,l.itemId,()=>grnTestPanel(g));},
            text:l.tested?"✎ Re-test":"🧪 Test"}),
        ].filter(Boolean))},
      ],{empty:"This receipt has no lines"}),
      st.awaiting?h("div",{class:"qc-note bad",style:"margin-top:14px;font-size:12px",
        text:st.awaiting+(st.awaiting===1?" lot has":" lots have")+" failed and "+(st.awaiting===1?"is":"are")
          +" waiting on an admin's ruling. Until the rejection is approved the material stays in the store and production can draw it."}):null,
    ]);
    /* The footer print follows the same rule as the row button: once every
       material is measured this document IS the test report, so say so; while
       readings are owed it is still only the goods receipt note. */
    modal({title:"🧪 GRN Test Report", sub:g.id, wide:true, body,
      foot:[h("button",{class:"btn",onclick:()=>printGrn(g),
        html:PRINT_IC+(st.pending?" Print Goods Receipt":" Print GRN Test Report")})]});
  }

  /* "Make GRN Test Report" goes STRAIGHT to the readings — no menu in between.
     Almost every delivery is one or two materials, and asking the user to pick
     one off a list before typing a number is a click that buys nothing.
     On a multi-material receipt it walks the delivery: save one material and
     the next untested one opens itself, until none are left and the finished
     report is shown. `seen` guards the walk — a material that is saved but
     still reads untested (nothing was entered, or a save was refused) must not
     be reopened for ever. */
  function makeGrnTestReport(g, seen){
    const walked=!!seen;              // set only when we got here after a save
    seen=seen||{};
    const fresh=(ENG.data.grns||[]).find(x=>x.id===g.id)||g;
    const st=qcForGrn(fresh);
    const next=st.lines.find(l=>!l.tested&&!seen[l.itemId]);
    if(!next){
      /* Filing the last reading ENDS the job. Re-opening the report here read
         as "the submit didn't go through" — the operator submits and expects
         to be done, not handed the document back. The finished report is still
         one click away from the receipt row when they want to print it. */
      if(walked){
        UI.$("#modalHost").hidden=true;
        if(st.total>1&&!st.pending)
          toast("GRN test report submitted — all "+st.total+" materials filed for "+fresh.id,
            {type:"ok",title:"GRN testing"});
        return;
      }
      grnTestPanel(fresh);
      return;
    }
    seen[next.itemId]=true;
    grnTestForm(fresh.id,next.itemId,()=>makeGrnTestReport(fresh,seen));
  }

  /* Kept for a part-delivered order: several receipts, each tested on its own,
     so they are listed rather than merged — a reading belongs to the lot that
     arrived, not to the order. */
  function openPoTesting(po){
    const gs=(ENG.data.grns||[]).filter(g=>g.poId===po.id&&g.status!=="Cancelled");
    if(!gs.length){ toast("Nothing has been received against "+po.id+" yet.",{type:"warn"}); return; }
    if(gs.length===1){ grnTestPanel(gs[0]); return; }
    const body=h("div",{},[
      h("div",{class:"muted",style:"font-size:13px;margin-bottom:12px",
        text:"This order was delivered in "+gs.length+" parts. Each receipt is tested separately."}),
      table(gs,[
        {key:"id",label:"GRN No",render:g=>`<b>${esc(g.id)}</b>`,noSort:true},
        {key:"date",label:"Date",render:g=>esc(g.date||"—"),noSort:true},
        {key:"inv",label:"Supplier Inv.",render:g=>esc(g.invNo||"—"),noSort:true},
        {key:"qc",label:"QC",render:g=>qcBadge(qcForGrn(g)),noSort:true},
        {key:"act",label:"",noSort:true,render:g=>h("button",{class:"btn sm"+(qcForGrn(g).pending?" primary":""),
          onclick:e=>{e.stopPropagation();UI.$("#modalHost").hidden=true;grnTestPanel(g);},
          text:qcForGrn(g).pending?"🧪 Test":"🧪 View"})},
      ],{empty:"No receipts"}),
    ]);
    modal({title:"🧪 GRN Testing", sub:po.id+" · "+ENG.sup(po.supplierId), wide:true, body});
  }

  /* ============================================================
     THE TEST REPORT IS PART OF THE GRN DOCUMENT
     The incoming readings are not a separate certificate: the goods
     receipt note IS the test report for that delivery, so the two
     print as one numbered document (the sheet already carried a
     "REMARKS / QC" box and an "Inspected By (QC / Lab)" signature
     line — this fills them in with the real readings).

     WHAT PRINTS DEPENDS ON WHO PRINTS, for the same reason the
     screens differ: the limits are admin's and the verdict is
     withheld from the person who took the reading. So the SPECIFIED
     column appears only when the payload actually carries limits
     (admin), and a lab-incharge copy shows the readings marked
     "Measured" rather than an invented Pass. A document must never
     print a grade the payload did not contain.
     ============================================================ */
  /* ONE numbered section heading, used by every block on the sheet. The document
     reads as a sequence a storekeeper and an auditor can both follow —
     information, parties, what arrived, what was tested, what was decided, who
     signed — instead of a stack of unlabelled tables where you have to infer
     what each one is. `extra` carries a right-hand chip (the overall stamp). */
  function sec(n,label,extra){
    return `<div class="sec"><span class="sec-n">${n}</span><span class="sec-t">${label}</span>`
      +(extra||"")+`</div>`;
  }
  function grnTestHtml(g,secNo){
    const st=qcForGrn(g);
    const done=st.lines.filter(l=>l.test);
    if(!done.length) return "";
    const RES={pass:['#1c7a3e','PASS'],fail:['#b02a2a','FAIL'],na:['#767c82','RECORDED']};
    /* THE SECTION READS AS A TEST REPORT IN ITS OWN RIGHT — it carries its own
       header line (who tested, when, against which receipt) and its own overall
       verdict, so the page can be handed to a customer's auditor as the
       inspection record for that delivery rather than looking like a footnote
       on a stores document. */
    const graded1=done.some(l=>l.test&&l.test.results);
    const anyFail=done.some(l=>l.test&&l.test.result==="Fail");
    /* ACCEPTED needs one thing to have actually been graded and nothing to have
       failed. A material with no limits grades "Pending" — it is recorded, not
       judged — and that must neither block the stamp nor be counted as a pass:
       the per-material blocks still read RECORDED, and the note under the
       section says so, so the page never overclaims at the line level. */
    const anyPass=done.some(l=>l.test&&l.test.result==="Pass");
    const stamp=!graded1?['#767c82','MEASURED']:anyFail?['#b02a2a','REJECTED']
      :anyPass?['#1c7a3e','ACCEPTED']:['#767c82','RECORDED'];
    const testers=[...new Set(done.map(l=>(l.test&&l.test.testedBy)||"").filter(Boolean))].join(", ");
    const dates=[...new Set(done.map(l=>(l.test&&l.test.date)||"").filter(Boolean))].map(fmtD);
    /* ONE TABLE for the whole delivery, so the Specified-Limit column is decided
       ONCE — per material it would give rows of differing widths under a single
       header. Present when any material on the receipt has limits (and never for
       a role that was not sent them); a material without limits prints "—". */
    const specOf1=(iid)=>{ const it=ENG.item(iid)||{};
      return (it.qcSpec&&typeof it.qcSpec==="object"&&Object.keys(it.qcSpec).length)?it.qcSpec:null; };
    const anySpec=done.some(l=>!!specOf1(l.itemId));
    const NC=anySpec?6:5;   // colspan for the full-width grouping / footer rows
    /* ONE TEST REPORT PER RECEIPT, and it is numbered by the receipt.
       A delivery is tested once; the materials on it are SECTIONS of that one
       report, not separate certificates. Giving each material its own report
       number made a single delivery look like several test reports, which is
       exactly what the user did not want on a purchase order. */
    const metaCells=[
      ["Test Report No.",g.id],
      ["Test Date",dates.join(" · ")||"—"],
      ["Tested By",testers||"—"],
      ["Materials Tested",done.length+" of "+st.total],
      ["Supplier Inv. No.",g.invNo||"—"],
      ["Overall Result",stamp[1]],
    ].map(([k,v])=>`<div class="ip"><span>${k}</span><b>${esc(String(v))}</b></div>`).join("");
    const blocks=done.map(l=>{
      const t=l.test;
      const it=ENG.item(l.itemId)||{};
      const spec=specOf1(l.itemId);   // admin only — null for every other role
      const graded=!!t.results;       // absent for the lab role — see above
      const rows=(t.params||[]).map((p,pi)=>{
        const v=(t.values||{})[p.key];
        const r=graded?(t.results[p.key]||"—"):null;
        const sp=spec?(spec[p.key]||null):null;
        const lim=!sp?"—":[sp.min!=null?"min "+sp.min:null,sp.max!=null?"max "+sp.max:null].filter(Boolean).join(" · ");
        const rc=graded&&RES[r]?RES[r]:null;
        return `<tr><td class="c">${pi+1}</td><td>${esc(p.label)}</td><td class="c">${esc(p.unit||"—")}</td>`+
          (anySpec?`<td class="c">${esc(lim)}</td>`:"")+
          `<td class="r"><b>${esc(v==null?"—":String(v))}</b></td>`+
          `<td class="c">${rc?`<span style="color:${rc[0]};font-weight:800">${rc[1]}</span>`
            :'<span style="color:#767c82;font-weight:700">MEASURED</span>'}</td></tr>`;
      }).join("");
      const overall=graded?(t.result==="Fail"?['#b02a2a','FAILED']:t.result==="Pass"?['#1c7a3e','PASSED']:['#767c82','RECORDED'])
        :['#767c82','MEASURED'];
      /* WHAT WAS DECIDED ABOUT A FAILED LOT belongs on the document as much as
         the readings do — the paper has to say whether the material was held or
         let through, and on whose authority. */
      const dec=t.decision==="quarantined"
        ? `<div class="tr-dec bad">QUARANTINED on ${esc(t.decidedBy||"admin")}'s approval${t.decidedAt?" ("+esc(String(t.decidedAt).slice(0,10))+")":""} — held in the QC store, not available to production.${t.decisionNote?" "+esc(t.decisionNote):""}</div>`
        : t.decision==="released"
        ? `<div class="tr-dec">Rejection DECLINED by ${esc(t.decidedBy||"admin")}${t.decidedAt?" ("+esc(String(t.decidedAt).slice(0,10))+")":""} — the lot stands as good stock.${t.decisionNote?" "+esc(t.decisionNote):""}</div>`
        : (graded&&t.result==="Fail")
        ? '<div class="tr-dec bad">AWAITING ADMIN RULING — the lot is in the store pending a decision to quarantine or release.</div>'
        : "";
      const qty=(g.lines||[]).find(x=>x.itemId===l.itemId)||{};
      /* SAMPLING LINE — lot size vs sample size, plus the supplier's own
         identity for the lot. This is what turns a reading into evidence: a
         figure taken from 3 of 200 rolls says something different from one
         taken across the whole delivery, and a failure is only chargeable to a
         supplier if their batch number is on the paper. Each part is printed
         only when it is actually known. */
      const lotIt=ENG.item(t.itemId||qty.itemId);
      const lot=qty.accepted!=null?(lotIt?ENG.qtyText(lotIt,qty.accepted,2):ENG.num(qty.accepted,2)+" "+(t.uom||qty.uom||"")):null;
      const samp=[
        lot?`Lot size <b>${esc(lot)}</b>`:null,
        t.sampleSize!=null?`Sample <b>${ENG.num(t.sampleSize,2)} ${esc(t.uom||qty.uom||"")}</b>`:null,
        t.supplierBatch?`Supplier batch <b>${esc(t.supplierBatch)}</b>`:null,
        t.certRef?`Supplier cert <b>${esc(t.certRef)}</b>`:null,
      ].filter(Boolean).join(" &nbsp;·&nbsp; ");
      return `<tr class="tr-grp"><td colspan="${NC}">
          <span class="tr-nm">${esc(t.itemName||l.name)}<span class="tr-cd">${esc(l.itemId)}</span></span>
          <span class="tr-res" style="color:${overall[0]};border-color:${overall[0]}">${overall[1]}</span>
          ${samp?`<div class="tr-samp">${samp}</div>`:""}
        </td></tr>${rows}${dec?`<tr class="tr-decr"><td colspan="${NC}">${dec}</td></tr>`:""}
        <tr class="tr-ftr"><td colspan="${NC}">Tested by <b>${esc(t.testedBy||"—")}</b>${
          t.date?" on <b>"+esc(fmtD(t.date))+"</b>":""}${
          t.remarks?' &nbsp;·&nbsp; Remarks: '+esc(t.remarks):""}</td></tr>`;
    }).join("");
    const untested=st.pending;
    /* THE DISPOSITION, in the three states a real inspection report has to
       distinguish — and which "Pass / Fail" alone cannot express:
         ACCEPTED               nothing failed
         REJECTED               failed, and the rejection was approved (held)
         CONDITIONALLY ACCEPTED failed, and an admin took it into stock anyway
       That last one is a CONCESSION — the material is being used despite a
       failed reading, on a named person's authority. It is the single most
       important line on the page for an auditor, and calling it "released"
       buried it. */
    const anyHeld=done.some(l=>l.test&&l.test.decision==="quarantined");
    const anyConcession=done.some(l=>l.test&&l.test.decision==="released");
    const anyUnruled=done.some(l=>l.test&&l.test.result==="Fail"&&!l.test.decision);
    const disp=!graded1?null
      :anyUnruled?['#b02a2a','PENDING DISPOSITION','A material failed. The lot is in the store awaiting an authorised decision to reject or accept it under concession.']
      :anyHeld&&anyConcession?['#b02a2a','PART REJECTED','One material was rejected and held; another was accepted under concession. See each material above.']
      :anyHeld?['#b02a2a','REJECTED','The failed lot is held in the quarantine store and is not available to production.']
      :anyConcession?['#c07a1a','CONDITIONALLY ACCEPTED','A material failed its specification and was accepted under concession on the authority named above.']
      :anyFail?null
      :['#1c7a3e','ACCEPTED','The material conforms to the specification and has been taken into stock.'];
    /* Signatures: the person who MEASURED and the person who RULED are
       different people, and on a failed lot the second signature is the one
       that matters. Blank when nobody has ruled — never a pre-filled name. */
    const ruler=[...new Set(done.map(l=>(l.test&&l.test.decidedBy)||"").filter(Boolean))].join(", ");
    const n=secNo||4;
    return `<div class="tr-wrap">
      ${sec(n,"INCOMING MATERIAL TESTING",
        `<span class="tr-stamp" style="color:${stamp[0]};border-color:${stamp[0]}">${stamp[1]}</span>`)}
      <div class="tr-meta">${metaCells}</div>
      ${untested?`<div class="tr-pend">${untested} material${untested===1?"":"s"} on this receipt ${untested===1?"has":"have"} not been tested yet — this report covers only the ${done.length} listed below.</div>`:""}
      <table class="tr-tbl tr-one"><thead><tr><th class="c">Sl.</th><th>Test Parameter</th><th class="c">Unit</th>`+
        (anySpec?'<th class="c">Specified Limit</th>':"")+
        `<th class="r">Observed Value</th><th class="c">Result</th></tr></thead><tbody>${blocks}</tbody></table>
      ${!graded1?'<div class="tr-note">Readings are recorded for the record. No pass/fail limits are set for these materials, so no material has been graded.</div>':""}
      ${disp?`${sec(n+1,"DISPOSITION")}
        <div class="tr-disp">
          <span class="tr-disp-v" style="color:${disp[0]};border-color:${disp[0]}">${disp[1]}</span>
          <span class="tr-disp-n">${esc(disp[2])}</span></div>`:""}
    </div>`;
  }
  /* WHO SIGNS, once. The inspector and the reviewer are part of the document's
     ONE signature strip at the foot rather than a second strip mid-page —
     signing twice on the same sheet reads as two documents stapled together,
     which is the opposite of what this page is for. Returns the extra cells the
     strip grows by when a test report is present. */
  function grnTestSigners(g){
    const done=qcForGrn(g).lines.filter(l=>l.test);
    if(!done.length) return null;
    const uniq=(k)=>[...new Set(done.map(l=>(l.test&&l.test[k])||"").filter(Boolean))].join(", ");
    return { inspector: uniq("testedBy"), reviewer: uniq("decidedBy") };
  }

  /* ============================================================
     GOODS RECEIPT NOTE — the numbered receipt document, printed
     from the frozen GRN record the server issued (never recomputed
     from live stock, so a reprint always matches the original).
     Same press as the PO print: header band, info grid, party
     blocks, dark item table, signature strip — plus the incoming
     test report above, when the delivery has been measured.
     ============================================================ */
  function printGrn(g){
    const co=companyByKey(g.company);
    const p=ENG.data.suppliers.find(s=>s.id===g.supplierId)||{name:g.supplierId||"—"};
    const pCode=partyStateCode(p);
    const whName=(ENG.data.warehouses.find(w=>w.id===g.wh)||{}).name||g.wh||"—";
    const logo=location.origin+"/assets/logo-invoice.png";
    const cancelled=g.status==="Cancelled";
    const lines=g.lines||[];
    const recdVal=lines.reduce((s,x)=>s+(+x.qty||0)*(+x.rate||0),0);
    const rejVal=lines.reduce((s,x)=>s+(+x.rejected||0)*(+x.rate||0),0);
    const accVal=recdVal-rejVal;
    const anyRej=lines.some(x=>(+x.rejected||0)>0);

    /* THE TEST REPORT IS PART OF THIS DOCUMENT, so the sheet says so in its
       title once readings exist: one page is both the stores receipt and the
       incoming-inspection record for that delivery. Before anything is tested
       it is still just a goods receipt note, and claiming otherwise on paper
       would be a lie. */
    const qcSt=qcForGrn(g);
    const tested=qcSt.lines.filter(l=>l.test).length;
    const signers=grnTestSigners(g);   // extra signature cells, or null
    const docTitle=tested?"GOODS RECEIPT NOTE CUM TEST REPORT":"GOODS RECEIPT NOTE";
    const qcVerdict=!tested?null
      :qcSt.fail?(qcSt.quarantined?"Failed — quarantined":qcSt.awaiting?"Failed — awaiting ruling":"Failed — released")
      :qcSt.pending?"Part tested":App.isLab()?"Tested":qcSt.pass?"Passed":"Recorded";

    const infoPairs=[
      ["GRN No.",g.id],["GRN Date",fmtD(g.date)],["Warehouse",whName],
      ["Against PO",g.poId||"—"],["PO Date",fmtD(g.poDate)],["Received By",g.by||"—"],
      ["Supplier Inv. No.",g.invNo||"—"],["Invoice Date",fmtD(g.invDate)],["Vehicle No.",g.vehicle||"—"],
    ].concat(g.lrNo?[["LR / Docket No.",g.lrNo]]:[]);
    /* No "Incoming QC" row here. The verdict is stated by the test report's own
       stamp and, in words, by its DISPOSITION line — saying it a third time in
       the receipt header was noise, and three copies of one fact is how they
       start disagreeing. */
    while(infoPairs.length%3) infoPairs.push(["",""]);
    const infoCells=infoPairs.map(([k,vv])=>k?`<div class="ip"><span>${k}</span><b>${esc(String(vv))}</b></div>`:'<div class="ip"></div>').join("");

    const rows=lines.map((x,i)=>`<tr><td class="c">${i+1}</td>`+
      `<td>${esc(x.name||x.itemId)}<div class="sub">${esc(x.itemId)}</div></td>`+
      `<td class="c">${esc(x.hsn||"—")}</td><td class="c">${esc(x.uom||"—")}</td>`+
      `<td class="r">${ENG.num(x.ordered,2)}</td><td class="r">${ENG.num(x.qty,2)}</td>`+
      `<td class="r">${ENG.num(x.accepted,2)}</td>`+
      `<td class="r">${(+x.rejected||0)>0?`<span class="rej">${ENG.num(x.rejected,2)}</span>`:"—"}</td>`+
      `<td class="r">${IN(x.rate)}</td><td class="r">${IN((+x.accepted||0)*(+x.rate||0))}</td></tr>`).join("");
    /* Filler rows pad a short receipt so the table does not look truncated. A
       receipt that carries a test report below it needs no padding — the page is
       already full, and two blank rows between the goods and their test results
       just push them apart. */
    let filler="";
    if(!tested) for(let i=0;i<2;i++) filler+=`<tr class="fill">${'<td>&nbsp;</td>'.repeat(10)}</tr>`;

    const html=`<!doctype html><html><head><meta charset="utf-8"><title>${esc(docTitle==="GOODS RECEIPT NOTE"?"Goods Receipt Note":"Goods Receipt Note cum Test Report")} ${esc(g.id)}</title>
<style>
  @page{size:A4;margin:8mm}
  *{margin:0;padding:0;box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  /* An explicit WHITE ground. These sheets are dark text on mostly unstyled
     rows, so a browser in dark mode paints its own dark background behind them
     and every un-zebra'd row goes dark-on-dark — in the on-screen preview, and
     on paper whenever "background graphics" is switched off. Paper is white;
     the document should say so rather than inherit whatever the viewer prefers. */
  html,body{background:#fff}
  body{font:12px/1.38 "Segoe UI",Arial,sans-serif;color:#1a1c1e;max-width:860px;margin:0 auto;padding:0 20px 20px}
  .band{display:flex;align-items:stretch;gap:0;margin:0 -20px 0;min-height:96px}
  .logo-side{flex:1.05;display:flex;align-items:center;padding:5px 0 5px 16px}
  .logo-side img{width:100%;max-height:92px;object-fit:contain;object-position:left center}
  .co-block{flex:1;background:#26282b;color:#cfd4d8;clip-path:polygon(9% 0,100% 0,100% 100%,0 100%);
    padding:12px 20px 10px 58px;text-align:right;font-size:11px;line-height:1.6;display:flex;flex-direction:column;justify-content:center}
  .conm{font-size:15px;font-weight:800;color:#F58024;text-transform:uppercase;letter-spacing:.4px}
  .co-ids{margin-top:6px;padding-top:5px;border-top:1px solid rgba(255,255,255,.22);color:#fff;font-weight:600;font-size:11px}
  .co-ids span{color:#F58024;font-weight:800}
  .rule{height:3px;background:linear-gradient(90deg,#F06820 0 62%,#26282b 62% 100%);margin:0 -20px 12px}
  .title-row{display:flex;justify-content:space-between;align-items:center;margin:0 0 10px}
  .title{font-size:20px;font-weight:800;letter-spacing:4px;color:#26282b;border-left:6px solid #F06820;padding-left:12px}
  .copy{font-size:9px;font-weight:700;letter-spacing:1px;color:#888;border:1px solid #ccc;border-radius:4px;padding:3px 9px;text-transform:uppercase}
  .info{display:grid;grid-template-columns:repeat(3,1fr);gap:2px 24px;border:1px solid #d8dbde;border-radius:9px;background:#fafbfc;padding:7px 14px;margin-bottom:8px}
  .ip{display:flex;justify-content:space-between;gap:8px;font-size:11px;min-height:15px}
  .ip span{color:#767c82;text-transform:uppercase;font-size:10px;font-weight:700;letter-spacing:.3px;padding-top:1px}
  .parties{display:flex;gap:12px;margin:18px 0 8px}
  .party{flex:1;border:1px solid #d8dbde;border-top:3px solid #F06820;border-radius:0 0 9px 9px;padding:7px 12px;font-size:12px;line-height:1.45}
  .plbl{display:inline-block;background:#F06820;color:#fff;font-size:9px;font-weight:800;letter-spacing:1px;padding:2.5px 10px;border-radius:3px;margin:-18px 0 5px;box-shadow:0 1px 0 rgba(0,0,0,.15)}
  .pnm{font-weight:800;font-size:13px}.paddr{color:#333;white-space:pre-line}
  table.items{width:100%;border-collapse:collapse;margin-bottom:8px}
  table.items th{background:#26282b;color:#fff;font-size:10px;text-transform:uppercase;letter-spacing:.5px;padding:5.5px 7px;border:1px solid #26282b;border-top:3px solid #F06820}
  table.items td{border:1px solid #d8dbde;padding:4px 7px;font-size:12px;vertical-align:top}
  table.items tbody tr:nth-child(even) td{background:#f6f7f8}
  tr.fill td{height:15px;background:#fff !important}
  td.r,th.r{text-align:right} td.c,th.c{text-align:center}
  td .sub{font-size:10px;color:#777}
  .rej{color:#b02a2a;font-weight:700}
  /* "GOODS RECEIPT NOTE CUM TEST REPORT" is nearly twice as long as the plain
     title — at 20px/4px it runs into the copy chip, so the combined form gets
     its own tighter setting rather than being allowed to overflow. */
  .title.long{font-size:15px;letter-spacing:2px}
  .bottom{display:flex;gap:12px;align-items:flex-start;margin-bottom:8px}
  .rem{flex:1.4;border:1px solid #d8dbde;border-left:3px solid #F06820;border-radius:0 9px 9px 0;padding:5px 12px;font-size:11px;line-height:1.45}
  .lbl{font-size:9px;font-weight:800;letter-spacing:1px;color:#F06820;text-transform:uppercase}
  .br{flex:1;display:flex;flex-direction:column;gap:6px}
  table.tot{width:100%;border-collapse:collapse}
  table.tot td{border:1px solid #d8dbde;padding:5px 12px;font-size:12px}
  table.tot td:first-child{color:#555}
  table.tot tr.g td{background:#F06820;color:#fff;font-weight:800;font-size:15px;border-color:#F06820}
  .words{border:1px solid #d8dbde;border-left:3px solid #F06820;border-radius:0 9px 9px 0;padding:5px 12px;font-size:11px;line-height:1.45}
  .words b{display:block;margin-top:2px;font-size:12px}
  .sign{display:flex;gap:12px;margin-top:26px}
  .sig{flex:1;border-top:1.5px solid #555;padding-top:5px;text-align:center;font-size:10px;font-weight:700;letter-spacing:.5px;color:#333;text-transform:uppercase}
  /* who actually did it, under the role — the receipt records real people */
  .sig-nm{font-size:10px;font-weight:600;letter-spacing:0;color:#767c82;text-transform:none;margin-top:2px}
  .strip{display:flex;justify-content:space-between;background:#26282b;color:#fff;font-size:11px;padding:6px 14px;border-radius:6px;margin-top:14px}
  .strip b{color:#F58024}
  .note{margin-top:8px;font-size:10px;color:#999;text-align:center}
  .cancel{position:fixed;top:40%;left:50%;transform:translate(-50%,-50%) rotate(-24deg);
    font-size:64px;font-weight:900;letter-spacing:8px;color:rgba(176,42,42,.18);
    border:6px solid rgba(176,42,42,.18);border-radius:12px;padding:6px 30px;pointer-events:none}
  /* the incoming test report, printed as part of this same document */
  /* NUMBERED SECTION HEADINGS. Every block on the sheet gets one, so the page
     reads as a sequence — information, parties, what arrived, what was tested,
     what was decided, who signed — instead of a stack of unlabelled tables. */
  .sec{display:flex;align-items:center;gap:9px;margin:13px 0 7px}
  .sec-n{flex:0 0 auto;width:16px;height:16px;border-radius:50%;background:#F06820;color:#fff;
    font-size:10px;font-weight:800;display:flex;align-items:center;justify-content:center}
  .sec-t{font-size:11px;font-weight:800;letter-spacing:1.5px;color:#26282b;text-transform:uppercase}
  .sec::after{content:"";flex:1;height:1px;background:#dfe2e5}
  .sec .tr-stamp{flex:0 0 auto;order:3}
  .tr-wrap{break-inside:avoid}
  .tr-stamp{font-size:11px;font-weight:900;letter-spacing:2px;border:2px solid;border-radius:4px;
    padding:3px 12px;white-space:nowrap}
  .tr-meta{display:grid;grid-template-columns:repeat(3,1fr);gap:2px 24px;border:1px solid #d8dbde;
    border-radius:9px;background:#fafbfc;padding:7px 14px;margin-bottom:9px}
  .tr-pend{font-size:10px;font-weight:700;color:#b02a2a;border:1px solid #e3b7b7;
    background:#fdf3f3;border-radius:4px;padding:4px 10px;margin-bottom:8px}
  .tr-note{font-size:10px;color:#767c82;font-style:italic;margin-top:4px}
  .tr-sub{font-size:10px;color:#767c82;margin:-2px 0 5px}
  .tr-sub b{color:#333}
  /* ONE table for the whole delivery: each material is a full-width grouping
     row rather than its own bordered card. Half the vertical space, and a
     multi-material receipt still fits one page — the same idiom the BOM
     components table already uses for layer headings. */
  .tr-nm{font-size:12px;font-weight:800;color:#26282b}
  .tr-cd{font-size:10px;font-weight:600;color:#777;margin-left:7px}
  .tr-res{font-size:9px;font-weight:800;letter-spacing:1px;border:1.5px solid;border-radius:3px;
    padding:1px 8px;white-space:nowrap;float:right}
  .tr-samp{font-size:10px;color:#767c82;font-weight:500;margin-top:2px;clear:both}
  .tr-samp b{color:#333}
  table.tr-tbl{width:100%;border-collapse:collapse}
  table.tr-tbl th{background:#26282b;color:#fff;font-size:9px;text-transform:uppercase;letter-spacing:.4px;
    padding:4px 7px;border:1px solid #26282b;font-weight:800}
  table.tr-tbl td{border:1px solid #e3e6e8;padding:3.5px 7px;font-size:11px}
  tr.tr-grp > td{background:#eef0f2;border-top:1.5px solid #b9bec3;padding:5px 8px 4px}
  tr.tr-ftr > td{font-size:10px;color:#767c82;background:#fafbfc;padding:3px 8px}
  tr.tr-ftr b{color:#333}
  tr.tr-decr > td{padding:0;border:0}
  .tr-dec{font-size:10px;line-height:1.5;padding:4px 8px;background:#f6f7f8;
    border-left:3px solid #767c82;color:#4a5057;font-weight:600}
  .tr-dec.bad{background:#fdf3f3;border-left-color:#b02a2a;color:#b02a2a;font-weight:700}
  /* the disposition: the one line an auditor reads first */
  .tr-disp{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:7px 12px;
    border:1px solid #d8dbde;border-left:4px solid #26282b;border-radius:0 8px 8px 0;background:#fafbfc}
  .tr-disp-v{font-size:12px;font-weight:900;letter-spacing:1.4px;border:2px solid;border-radius:4px;padding:2px 11px}
  .tr-disp-n{font-size:10px;color:#4a5057;flex:1;min-width:180px;line-height:1.5}
  @media print{body{padding:0 6mm 0}.band{margin:0 -6mm}.rule{margin:0 -6mm 12px}.note{display:none}}
</style></head><body>
  ${cancelled?'<div class="cancel">CANCELLED</div>':""}
  <div class="band">
    <div class="logo-side"><img src="${logo}" alt="${esc(co.name)}"></div>
    <div class="co-block">
      <div class="conm">${esc(co.name)}</div>
      <div>${esc(co.address||"")}</div>
      <div>${esc([co.phone,co.email,co.website].filter(Boolean).join("  ·  "))}</div>
      <div class="co-ids"><span>GSTIN</span> ${esc(co.gstin||"—")}${co.pan?`&nbsp; <span>PAN</span> ${esc(co.pan)}`:""}</div>
    </div>
  </div>
  <div class="rule"></div>
  <div class="title-row"><span class="title${tested?" long":""}">${esc(docTitle)}</span><span class="copy">${tested?"Store &amp; QC Copy":"Store Copy"}</span></div>
  ${sec(1,"RECEIPT INFORMATION")}
  <div class="info">${infoCells}</div>
  ${sec(2,"SUPPLIER &amp; RECEIVING STORE")}
  <div class="parties">
    <div class="party"><div class="plbl">SUPPLIER / VENDOR</div>
      <div class="pnm">${esc(p.name||"")}</div>
      ${p.address||p.city?`<div class="paddr">${esc(p.address||[p.city,p.country].filter(Boolean).join(", "))}</div>`:""}
      ${p.gst?`<div>GSTIN : <b>${esc(p.gst)}</b></div>`:""}
      ${pCode?`<div>State : ${esc(GST.stateName(pCode))} (Code ${pCode})</div>`:""}
    </div>
    <div class="party"><div class="plbl">RECEIVED AT</div>
      <div class="pnm">${esc(co.name)}</div>
      <div class="paddr">${esc(co.address||"")}</div>
      <div>GSTIN : <b>${esc(co.gstin||"—")}</b></div>
      <div>Store : ${esc(whName)}</div>
    </div>
  </div>
  ${sec(3,"MATERIAL RECEIVED")}
  <table class="items"><thead><tr>
    <th class="c">Sl.</th><th>Item Description</th><th class="c">HSN</th><th class="c">Unit</th>
    <th class="r">Ordered</th><th class="r">Received</th><th class="r">Accepted</th><th class="r">Rejected</th>
    <th class="r">Rate (₹)</th><th class="r">Amount (₹)</th>
  </tr></thead><tbody>${rows}${filler}</tbody></table>
  <div class="bottom">
    <div class="rem"><span class="lbl">${tested?"STORE REMARKS":"REMARKS / QC"}</span>
      ${g.remarks?`<div>${esc(g.remarks)}</div>`:'<div class="sub" style="color:#777">—</div>'}
      <div>Accepted quantities are posted to stock at PO rates${anyRej?"; rejected material returns to the supplier and is quoted on the debit note":""}.</div>
    </div>
    <div class="br">
      <table class="tot"><tbody>
        <tr><td>Received Value</td><td class="r">${IN(recdVal)}</td></tr>
        ${anyRej?`<tr><td>Rejected Value</td><td class="r">− ${IN(rejVal)}</td></tr>`:""}
        <tr class="g"><td>ACCEPTED VALUE (₹)</td><td class="r">${IN(accVal)}</td></tr>
      </tbody></table>
      <div class="words"><span class="lbl">AMOUNT IN WORDS</span><b>${esc(GST.amountInWords(accVal))}</b></div>
    </div>
  </div>
  ${grnTestHtml(g,4)}
  ${sec(tested?6:4,"SIGN-OFF")}
  <div class="sign">
    <div class="sig">Prepared By (Store)${g.by?`<div class="sig-nm">${esc(g.by)}</div>`:""}</div>
    <div class="sig">Inspected By (QC / Lab)${signers&&signers.inspector?`<div class="sig-nm">${esc(signers.inspector)}</div>`:""}</div>
    ${signers?`<div class="sig">Reviewed &amp; Approved By${signers.reviewer?`<div class="sig-nm">${esc(signers.reviewer)}</div>`:""}</div>`:""}
    <div class="sig">${signers?"Authorised Signatory":`For <b>${esc(co.name)}</b> — Authorised Signatory`}${
      signers?`<div class="sig-nm">for ${esc(co.name)}</div>`:""}</div>
  </div>
  <div class="strip"><span>${esc(co.tagline||"Material Science Meets Global Demand")}</span><b>This is a computer generated ${tested?"goods receipt note cum test report":"goods receipt note"} · ${esc(g.id)}</b></div>
  <div class="note">Use your browser's "Save as PDF" to download</div>
  <script>window.onload=function(){window.print();}<\/script>
</body></html>`;
    const w=window.open("","_blank");
    if(!w){ toast("Popup blocked — allow popups for this site to print",{type:"warn"}); return; }
    w.document.write(html); w.document.close();
  }

  /* ---- The styled document sheet, used for BOTH the domestic GST tax invoice
     and the purchase order: same header band, info grid, item table, totals
     block, signature and footer strip — only the wording and the fields that
     belong to each document differ (see the isPO branches below). ---- */
  function domesticHtml(o, asPO, opts){
    opts=opts||{};
    /* opts.quote: the same sheet as a QUOTATION — customer branch of the tax
       maths, but none of the cells an invoice earns only once goods move
       (invoice no., e-way bill, LR, vehicle, dispatch date, ship-to). */
    const isQuote=!asPO&&!!opts.quote;
    const kind=asPO?"po":(isQuote?"quote":"so"), isPO=!!asPO;
    const dc=docCalc(kind,o);
    const {co, party, calc, interState, pos}=dc;
    const p=party||{name:isPO?o.supplierId:o.customerId};
    const partyCode=partyStateCode(p);
    const anyBatch=!isPO&&(o.lines||[]).some(l=>l.batch);
    const anyDisc=(o.lines||[]).some(l=>l.discPct>0);
    const uniformPct=[...new Set(gstLinesOf(o).map(l=>l.gstPct))];
    const pctSuffix=uniformPct.length===1?` @ ${uniformPct[0]/(interState?1:2)}%`:"";
    const igstSuffix=uniformPct.length===1?` @ ${uniformPct[0]}%`:"";
    /* A purchase document prints either as the order itself or as a proforma
       — chosen on the PO form and stored on the order, so re-printing gives
       the same document every time. */
    const poTitle=String(o.docType||"").toLowerCase()==="proforma"
      ? "PROFORMA INVOICE" : "PURCHASE ORDER";
    const title=isPO?poTitle
      :isQuote?("QUOTATION"+(o.rev>1?" · Rev "+o.rev:""))
      :(o.status==="Dispatched"?"TAX INVOICE":"PROFORMA / TAX INVOICE");
    const logo=location.origin+"/assets/logo-invoice.png";
    const bank=co.bank||{};
    const hasBank=!isPO&&(bank.name||bank.acNo||bank.ifsc);
    const terms=(co.terms&&co.terms.length)?co.terms:[
      "Goods once sold will not be taken back or exchanged.",
      "Interest @ 18% p.a. will be charged on delayed payments.",
      "All payments by A/c Payee Cheque / DD / NEFT / RTGS only.",
      "Subject to Bangalore Jurisdiction.",
    ];

    const rows=(o.lines||[]).map((l,i)=>{ const it=ENG.item(l.itemId)||{};
      /* the money is calculated from the STORED quantity and rate; pk only
         changes how the same amount is written down */
      const lc=GST.calcLine({qty:l.qty,rate:l.rate,discPct:l.discPct||0,gstPct:lineGstPct(l,it)},interState);
      const pk=lineAsKg(l,it);
      // the size a customer orders by — thickness × width, the width taken from
      // the work order this line is served from
      const size=lineSize(l,it);
      return `<tr><td class="c">${i+1}</td>`+
        `<td>${esc(it.name||l.itemId)}<div class="sub">${esc(size||l.itemId)}</div></td>`+
        `<td class="c">${esc(l.hsn||it.hsn||"—")}</td>`+
        (anyBatch?`<td class="c">${esc(l.batch?batchNo(l.batch):"—")}</td>`:"")+
        /* A PO prints the unit it was PLACED in. A sales line has no unit of
           its own — it is in the product's stocking unit, which is what the
           dispatch movement posts, so mica tape invoices in MTR and printing
           a flat "KG" here mis-stated the consignment. */
        `<td class="r">${ENG.num(pk.qty,2)}</td><td class="c">${esc(isPO?pk.uom:(ENG.dispUom(it)||"KG").toUpperCase())}</td>`+
        `<td class="r">${IN(isPO?pk.rate:ENG.dispRate(it,l.rate))}</td>`+
        (anyDisc?`<td class="r">${l.discPct?l.discPct+"%":"—"}</td>`:"")+
        `<td class="r">${lc.gstPct}%</td>`+
        `<td class="r">${IN(lc.taxable)}</td></tr>`; }).join("");

    const totalsRows=[
      ["Sub Total",IN(calc.taxable+calc.discount)],
      calc.discount?["Discount","− "+IN(calc.discount)]:null,
      calc.discount?["Taxable Value",IN(calc.taxable)]:null,
      ...(interState?[["IGST"+igstSuffix,IN(calc.igst)]]
                    :[["CGST"+pctSuffix,IN(calc.cgst)],["SGST"+pctSuffix,IN(calc.sgst)]]),
      calc.freight?["Freight / Transport",IN(calc.freight)]:null,
      calc.insurance?["Insurance",IN(calc.insurance)]:null,
      ["Round Off",(calc.roundOff>=0?"+ ":"− ")+Math.abs(calc.roundOff).toFixed(2)],
    ].filter(Boolean).map(([l,v])=>`<tr><td>${l}</td><td class="r">${v}</td></tr>`).join("");

    const infoPairs=isPO?[
      ["PO No.",o.id],["PO Date",o.date||"—"],["Valid Upto",o.validUpto||"—"],
      ["Expected Delivery",o.eta||"—"],["Ref / Quotation",o.refNo||"—"],["Vendor Code",o.vendorCode||"—"],
      ["Kind Attn.",o.attn||"—"],["Our Contact",o.ctcPerson||"—"],["GST",o.gstMode||"As Applicable"],
      ["Packing",o.packing||"—"],["Delivery",o.deliveryNote||"—"],["Destination",o.destination||"—"],
    ]:isQuote?[
      ["Quotation No.",o.id],["Date",o.date||"—"],["Valid Until",o.validUntil||"—"],
      ["Reference",o.leadId||"—"],["Payment Terms",o.payTerms||p.terms||"—"],["Delivery",o.deliveryTerms||"—"],
    ]:[
      ["Invoice No.",o.invoiceNo||o.id],["Invoice Date",o.date||"—"],["Due Date",o.promised||"—"],
      ["Customer PO No.",o.custPoNo||"—"],["Customer PO Date",o.custPoDate||"—"],
      ["Place of Supply",pos+" — "+(GST.stateName(pos)||"")],
      ["Transport Mode",o.transportMode||"—"],["Vehicle No.",o.vehicleNo||"—"],
      ["E-Way Bill No.",o.ewayBill||"—"],["LR / RR No.",o.lrNo||"—"],
      ["Dispatch Date",o.dispatchDate||"—"],["Payment Terms",o.payTerms||p.terms||"—"],
    ];
    const infoCells=infoPairs.map(([k,vv])=>`<div class="ip"><span>${k}</span><b>${esc(String(vv))}</b></div>`).join("");

    const partyBlock=(lbl,nm,addr,extra)=>`<div class="party"><div class="plbl">${lbl}</div>
      <div class="pnm">${esc(nm||"")}</div>
      ${addr?`<div class="paddr">${esc(addr)}</div>`:""}${extra}</div>`;
    const partyExtra=`${p.gst?`<div>GSTIN : <b>${esc(p.gst)}</b></div>`:""}
      ${partyCode?`<div>State : ${esc(GST.stateName(partyCode))} (Code ${partyCode})</div>`:""}
      ${p.contact||p.phone?`<div>${esc([p.contact,p.phone].filter(Boolean).join(" · "))}</div>`:""}
      ${p.email?`<div>${esc(p.email)}</div>`:""}`;
    const leftParty=isPO
      ? partyBlock("SUPPLIER / VENDOR",p.name,p.address||[p.city,p.country].filter(Boolean).join(", "),partyExtra)
      : partyBlock("BILL TO",p.name,p.address||p.city||"",partyExtra);
    // a quotation has no delivery address yet — only the party it is made out to
    const rightParty=isPO
      ? partyBlock("DELIVER TO",co.name,co.address,`<div>GSTIN : <b>${esc(co.gstin||"—")}</b></div>`)
      : isQuote ? ""
      : partyBlock("SHIP TO (Delivery Address)",p.name,(o.shipTo||p.shipTo||p.address||p.city||""),
          `${p.gst?`<div>GSTIN : <b>${esc(p.gst)}</b></div>`:""}`);

    const totalCols=8+(anyBatch?1:0)+(anyDisc?1:0);
    // two blank rows after the data — room to add a line by hand, nothing more
    let filler="";
    for(let i=0;i<2;i++) filler+=`<tr class="fill">${'<td>&nbsp;</td>'.repeat(totalCols)}</tr>`;
    const html=`<!doctype html><html><head><meta charset="utf-8"><title>${title} ${esc(o.invoiceNo||o.id)}</title>
<style>
  /* A4 is what these documents are printed on — say so, or the browser falls
     back to its own default (US Letter is 18mm shorter and cost a whole extra
     page). The 8mm page margin plus the body's 6mm gives a 14mm side margin. */
  @page{size:A4;margin:8mm}
  *{margin:0;padding:0;box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  /* An explicit WHITE ground. These sheets are dark text on mostly unstyled
     rows, so a browser in dark mode paints its own dark background behind them
     and every un-zebra'd row goes dark-on-dark — in the on-screen preview, and
     on paper whenever "background graphics" is switched off. Paper is white;
     the document should say so rather than inherit whatever the viewer prefers. */
  html,body{background:#fff}
  body{font:12px/1.38 "Segoe UI",Arial,sans-serif;color:#1a1c1e;max-width:860px;margin:0 auto;padding:0 20px 20px}
  .band{display:flex;align-items:stretch;gap:0;margin:0 -20px 0;min-height:96px}
  .logo-side{flex:1.05;display:flex;align-items:center;padding:5px 0 5px 16px}
  .logo-side img{width:100%;max-height:92px;object-fit:contain;object-position:left center}
  .co-block{flex:1;background:#26282b;color:#cfd4d8;clip-path:polygon(9% 0,100% 0,100% 100%,0 100%);
    padding:12px 20px 10px 58px;text-align:right;font-size:11px;line-height:1.6;display:flex;flex-direction:column;justify-content:center}
  .conm{font-size:15px;font-weight:800;color:#F58024;text-transform:uppercase;letter-spacing:.4px}
  .co-ids{margin-top:6px;padding-top:5px;border-top:1px solid rgba(255,255,255,.22);color:#fff;font-weight:600;font-size:11px}
  .co-ids span{color:#F58024;font-weight:800}
  .rule{height:3px;background:linear-gradient(90deg,#F06820 0 62%,#26282b 62% 100%);margin:0 -20px 12px}
  .title-row{display:flex;justify-content:space-between;align-items:center;margin:0 0 10px}
  .title{font-size:20px;font-weight:800;letter-spacing:4px;color:#26282b;border-left:6px solid #F06820;padding-left:12px}
  .copy{font-size:9px;font-weight:700;letter-spacing:1px;color:#888;border:1px solid #ccc;border-radius:4px;padding:3px 9px;text-transform:uppercase}
  .info{display:grid;grid-template-columns:repeat(3,1fr);gap:2px 24px;border:1px solid #d8dbde;border-radius:9px;background:#fafbfc;padding:7px 14px;margin-bottom:8px}
  .ip{display:flex;justify-content:space-between;gap:8px;font-size:11px}.ip span{color:#767c82;text-transform:uppercase;font-size:10px;font-weight:700;letter-spacing:.3px;padding-top:1px}
  .parties{display:flex;gap:12px;margin-bottom:8px}
  .party{flex:1;border:1px solid #d8dbde;border-top:3px solid #F06820;border-radius:0 0 9px 9px;padding:7px 12px;font-size:12px;line-height:1.45}
  .plbl{display:inline-block;background:#F06820;color:#fff;font-size:9px;font-weight:800;letter-spacing:1px;padding:2.5px 10px;border-radius:3px;margin:-18px 0 5px;box-shadow:0 1px 0 rgba(0,0,0,.15)}
  .pnm{font-weight:800;font-size:13px}.paddr{color:#333;white-space:pre-line}
  table.items{width:100%;border-collapse:collapse;margin-bottom:8px}
  table.items th{background:#26282b;color:#fff;font-size:10px;text-transform:uppercase;letter-spacing:.5px;padding:5.5px 7px;border:1px solid #26282b;border-top:3px solid #F06820}
  table.items td{border:1px solid #d8dbde;padding:4px 7px;font-size:12px;vertical-align:top}
  table.items tbody tr:nth-child(even) td{background:#f6f7f8}
  tr.fill td{height:15px;background:#fff !important}
  td.r,th.r{text-align:right} td.c,th.c{text-align:center}
  td .sub{font-size:10px;color:#777}
  /* The totals column used to leave a tall blank beside the stacked notes.
     The amount in words now sits directly under the grand total it restates,
     which reads better AND balances the two columns onto one page. */
  .bottom{display:flex;gap:12px;align-items:flex-start;margin-bottom:8px}
  .bl{flex:1.4;display:flex;flex-direction:column;gap:6px}
  .br{flex:1;display:flex;flex-direction:column;gap:6px}
  .words,.bank,.notes{border:1px solid #d8dbde;border-left:3px solid #F06820;border-radius:0 9px 9px 0;padding:5px 12px;font-size:11px;line-height:1.45}
  .words b{display:block;margin-top:2px;font-size:12px}
  .lbl{font-size:9px;font-weight:800;letter-spacing:1px;color:#F06820;text-transform:uppercase}
  table.tot{width:100%;border-collapse:collapse;height:fit-content}
  table.tot td{border:1px solid #d8dbde;padding:5px 12px;font-size:12px}
  table.tot td:first-child{color:#555}
  table.tot tr:nth-child(even) td{background:#f6f7f8}
  table.tot tr.g td{background:#F06820;color:#fff;font-weight:800;font-size:15px;border-color:#F06820}
  .sign{display:flex;justify-content:space-between;align-items:flex-end;margin-top:8px;font-size:11px;color:#777}
  .sig{text-align:center;color:#1a1c1e}.sig .ln{border-top:1.5px solid #555;margin-top:24px;padding-top:5px;min-width:210px;font-weight:700}
  .strip{display:flex;justify-content:space-between;background:#26282b;color:#fff;font-size:11px;padding:6px 14px;border-radius:6px;margin-top:14px}
  .strip b{color:#F58024}
  .greet{font-size:12px;margin:-4px 0 9px;color:#444}
  .note{margin-top:8px;font-size:10px;color:#999;text-align:center}
  /* ---- running footer: the company tab and the thank-you line must sit at the
     foot of EVERY printed page, not only the last one. The whole document is
     laid out in one table so its <tfoot> spacer reserves the same strip of room
     on every page; the footer itself is then painted there by a fixed block,
     which the browser repeats page after page. On screen nothing is fixed —
     the spacer collapses and the footer simply follows the content. ---- */
  .sheet{width:100%;border-collapse:collapse}
  .sheet>tbody>tr>td,.sheet>tfoot>tr>td{padding:0;border:0}
  .foot-space{height:0}
  @media print{
    /* no padding at the foot: the running footer is fixed, so the page's own
       bottom margin is all the room the flow needs */
    body{padding:0 6mm 0} .band{margin:0 -6mm} .rule{margin:0 -6mm 12px} .note{display:none}
    /* the two strips measure ~13mm; 16mm leaves the footer room to grow a line
       (a longer tagline) without the table ever running underneath it */
    .foot-space{height:16mm}
    .pgfoot{position:fixed;left:0;right:0;bottom:0;margin:0;padding:0 6mm;background:#fff}
    .pgfoot .strip{margin-top:0}
    .pgfoot .strip+.strip{margin-top:2px}
  }
</style></head><body>
  <table class="sheet"><tfoot><tr><td><div class="foot-space"></div></td></tr></tfoot>
  <tbody><tr><td>
  <div class="band">
    <div class="logo-side"><img src="${logo}" alt="${esc(co.name)}"></div>
    <div class="co-block">
      <div class="conm">${esc(co.name)}</div>
      <div>${esc(co.address||"")}</div>
      <div>${esc([co.phone,co.email,co.website].filter(Boolean).join("  ·  "))}</div>
      <div class="co-ids"><span>GSTIN</span> ${esc(co.gstin||"—")}${co.pan?`&nbsp; <span>PAN</span> ${esc(co.pan)}`:""}</div>
    </div>
  </div>
  <div class="rule"></div>
  <div class="title-row"><span class="title">${title}</span>${isPO
      ?'<span class="copy">For Supplier</span>'
      :isQuote?''
      :'<span class="copy">Original for Recipient</span>'}</div>
  ${isPO?'<div class="greet">Dear Sir / Madam,&nbsp; kindly supply the material as under.</div>':""}
  <div class="info">${infoCells}</div>
  <div class="parties">${leftParty}${rightParty}</div>
  <table class="items"><thead><tr>
    <th class="c">Sl.</th><th>Description of Goods</th><th class="c">HSN / SAC</th>
    ${anyBatch?'<th class="c">Batch No.</th>':""}
    <th class="r">Qty</th><th class="c">Unit</th><th class="r">Rate (₹)</th>
    ${anyDisc?'<th class="r">Disc.</th>':""}
    <th class="r">GST %</th><th class="r">Amount (₹)</th>
  </tr></thead><tbody>${rows}${filler}</tbody></table>
  <div class="bottom">
    <div class="bl">
      ${hasBank?`<div class="bank"><span class="lbl">BANK DETAILS</span>
        ${bank.name?`<div>Bank : <b>${esc(bank.name)}</b>${bank.branch?" · "+esc(bank.branch):""}</div>`:""}
        ${bank.acName?`<div>A/c Name : ${esc(bank.acName)}</div>`:""}
        ${bank.acNo?`<div>A/c No : <b>${esc(bank.acNo)}</b></div>`:""}
        ${bank.ifsc?`<div>IFSC : <b>${esc(bank.ifsc)}</b></div>`:""}
        ${bank.upi?`<div>UPI : ${esc(bank.upi)}</div>`:""}</div>`:""}
      <div class="notes"><span class="lbl">${isPO?"NOTES / INSTRUCTIONS":"TERMS & CONDITIONS"}</span>
        ${o.notes?`<div>${esc(o.notes)}</div>`:""}
        ${isPO?`<div>1. Please supply the material as per the specification, quantity and rate stated above.</div>
                <div>2. Quote our PO No. <b>${esc(o.id)}</b> on the invoice, packing list and test report.</div>
                <div>3. Material must reach ${esc(o.destination||"our works")} on or before the expected delivery date;
                     kindly attach the Test / Inspection Report with the consignment.</div>
                <div>4. Payment terms : ${esc(p.terms||"as agreed")}. GST : ${esc(o.gstMode||"As Applicable")}.</div>
                <div>5. Any dispute is subject to Bangalore jurisdiction.</div>`
             :terms.map((t,i)=>`<div>${i+1}. ${esc(t)}</div>`).join("")}
      </div>
    </div>
    <div class="br">
      <table class="tot"><tbody>
        ${totalsRows}
        <tr class="g"><td>GRAND TOTAL (₹)</td><td class="r">${IN(calc.grandTotal)}</td></tr>
      </tbody></table>
      <div class="words"><span class="lbl">AMOUNT IN WORDS</span><b>${esc(GST.amountInWords(calc.grandTotal))}</b></div>
    </div>
  </div>
  <div class="sign">
    <div class="muted" style="color:#777">${interState?"Inter-state supply — IGST charged.":"Intra-state supply — CGST + SGST charged."}${isPO||isQuote?"":" Whether tax is payable on reverse charge : No."}</div>
    <div class="sig">For <b>${esc(co.name)}</b><div class="ln">Authorised Signatory</div></div>
  </div>
  </td></tr></tbody></table>
  <div class="pgfoot">
    <div class="strip"><span>${esc(co.tagline||"Material Science Meets Global Demand")}</span><b>${isPO?"Thank you for your partnership!":isQuote?"We look forward to your order!":"Thank you for your business!"}</b></div>
    <div class="strip" style="background:none;color:#888;border:none;padding:2px 12px"><span></span><span>${isQuote
      ?`This quotation is valid until ${esc(o.validUntil||"—")}. Prices are exclusive of freight unless stated. E. &amp; O.E.`
      :`This is a computer generated ${isPO?"purchase order":"invoice"}.`}</span></div>
  </div>
  <div class="note">Use your browser's "Save as PDF" to download</div>
  <script>window.onload=function(){window.print();}<\/script>
</body></html>`;
    return html;
  }

  /* ---- Export commercial invoice (per the approved sample PDF): IEC code,
     consignee / notify party, bank with SWIFT, shipment grid, currency
     amounts with no GST added, net/gross weight, India-origin certificate. ---- */
  function exportHtml(o, opts){
    opts=opts||{};
    /* opts.title / opts.validUntil: the same grid headed QUOTATION for a
       foreign-currency quote — the number cell then carries the validity
       instead of a customer PO, and the reference is the lead */
    const isQuote=!!opts.title&&/quot/i.test(opts.title);
    const docTitle=opts.title||"COMMERCIAL INVOICE";
    const co=companyByKey(o.company);
    const p=ENG.data.customers.find(c=>c.id===o.customerId)||{name:o.customerId};
    const ccy=(o.currency||"USD").toUpperCase();
    const F2=v=>(+v||0).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});
    const sub=(o.lines||[]).reduce((s,l)=>s+l.qty*l.rate*(1-(l.discPct||0)/100),0);
    const total=+(sub+(+o.freight||0)+(+o.insurance||0)).toFixed(2);
    const hsns=[...new Set((o.lines||[]).map(l=>l.hsn||(ENG.item(l.itemId)||{}).hsn).filter(Boolean))];
    const bank=co.bank||{};
    const rows=(o.lines||[]).map((l,i)=>{ const it=ENG.item(l.itemId)||{};
      const size=lineSize(l,it);
      return `<tr>${i===0?`<td rowspan="${(o.lines||[]).length}" class="marks">${esc(o.marksPkgs||"")}</td>`:""}`+
        `<td><b>${esc(it.name||l.itemId)}</b><div class="sub">${size?"SIZE: "+esc(size):esc(l.itemId)}${l.batch?" · Batch No. "+esc(batchNo(l.batch)):""}${l.discPct?" · disc "+l.discPct+"%":""}</div></td>`+
        `<td class="r">${ENG.num(l.qty,2)}</td><td class="r">${F2(l.rate)}</td><td class="r">${F2(l.qty*l.rate*(1-(l.discPct||0)/100))}</td></tr>`; }).join("");
    const exNote=(o.exportNote||"").split("\n").map(s=>s.trim()).filter(Boolean);
    const words=GST.amountInWordsCcy(total, ccy).toUpperCase();
    return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(isQuote?"Quotation":"Commercial Invoice")} ${esc(o.invoiceNo||o.id)}</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  body{font:11.5px/1.5 "Segoe UI",Arial,sans-serif;color:#111;max-width:860px;margin:0 auto;padding:16px 22px}
  .title{text-align:center;font-size:14px;font-weight:800;letter-spacing:.5px;margin-bottom:4px}
  .iec{font-weight:800;font-size:12px;margin-bottom:2px}
  table.g{width:100%;border-collapse:collapse}
  table.g td{border:1.2px solid #222;padding:5px 9px;vertical-align:top;font-size:11px;line-height:1.55}
  .conm{font-weight:800;font-size:13px}
  .k{font-weight:700}
  table.items{width:100%;border-collapse:collapse}
  table.items th{border:1.2px solid #222;padding:5px 8px;font-size:11px;line-height:1.3}
  table.items td{border-left:1.2px solid #222;border-right:1.2px solid #222;padding:4px 8px;font-size:12px;vertical-align:top}
  td.r,th.r{text-align:right} .c{text-align:center}
  td .sub{font-size:9.8px;color:#444;font-weight:400}
  td.marks{font-size:11px;width:17%}
  tr.meta td{font-weight:700;padding-top:8px}
  tr.tot td{border:1.2px solid #222;font-weight:800;font-size:13px;padding:6px 8px}
  .words{border:1.2px solid #222;border-top:0;padding:6px 10px;font-size:11px}
  .words b{display:block;font-size:12px}
  .signrow{display:flex;justify-content:flex-end;margin-top:6px}
  .sig{border:1.2px solid #222;padding:8px 14px 6px;min-width:300px;font-size:12px}
  .sig .ln{margin-top:44px;font-weight:700}
  .cert{font-size:11px;margin-top:8px}
  .note{margin-top:8px;font-size:10px;color:#999;text-align:center}
  @media print{ body{padding:6mm} .note{display:none} }
</style></head><body>
  <div class="title">${esc(docTitle)}${isQuote&&o.rev>1?" · REV "+esc(String(o.rev)):""}</div>
  <div class="iec">I.E.C Code: ${esc(co.iec||"—")}</div>
  <table class="g">
    <tr><td style="width:52%"><span class="conm">${esc(co.name.toUpperCase())}</span><br>${esc(co.address||"")}<br>GSTN/Unique ID: ${esc(co.gstin||"—")}<br>email : ${esc(co.email||"")}</td>
        ${isQuote
          ?`<td style="width:48%"><span class="k">Quotation No. &amp; Date</span><br>${esc(o.id)} &nbsp; DT.${fmtD(o.date)}<br>
          <span class="k">Valid Until</span><br>${fmtD(opts.validUntil||o.validUntil)}<br>
          <span class="k">Reference:</span> ${esc(o.leadId||o.otherRef||"—")}</td>`
          :`<td style="width:48%"><span class="k">Invoice No. &amp; Date</span><br>${esc(o.invoiceNo||o.id)} &nbsp; DT.${fmtD(o.date)}<br>
          <span class="k">CUSTOMER PO No. &amp; Date</span><br>${esc(o.custPoNo||"—")}${o.custPoDate?" DT."+fmtD(o.custPoDate):""}<br>
          <span class="k">Other Reference:</span> ${esc(o.otherRef||"")}</td>`}</tr>
    <tr><td><span class="k">Consignee :</span><br><b>${esc(o.consignee||"TO THE ORDER")}</b><br><br>
          <span class="k">Notify Party:</span><br><b>${esc(o.notifyParty||p.name||"")}</b></td>
        <td><span class="k">Bank:</span> ${esc(bank.name||"—")}<br><span class="k">Address:</span> ${esc(bank.address||"—")}<br><br>
          <span class="k">Swift:</span> ${esc(bank.swift||"—")}<br>
          <span class="k">Beneficiary a/c no (${esc(ccy)}):</span> ${esc(bank.acNo||"—")}<br>
          <span class="k">Beneficiary name:</span> ${esc(bank.acName||co.name)}</td></tr>
  </table>
  <table class="g" style="border-top:0">
    <tr><td style="width:20%"><span class="k">Pre-Carriage by</span><br>${esc(o.preCarriage||"")}</td>
        <td style="width:26%"><span class="k">Place of Receipt by Per-carrier</span><br>${esc(o.placeReceipt||"")}</td>
        <td style="width:26%"><span class="k">Country of origin of Goods</span><br class=""><span class="c" style="display:block">INDIA</span></td>
        <td style="width:28%"><span class="k">Country of Final Destination</span><br>${esc(o.countryDest||"")}</td></tr>
    <tr><td><span class="k">Vessel/Flight No.</span><br>${esc(o.vessel||"")}</td>
        <td><span class="k">Port of Loading</span><br>${esc(o.portLoading||"")}</td>
        <td colspan="2" rowspan="2"><span class="k">Terms of Delivery &amp; Payment</span><br>
          Delivery: ${esc(o.deliveryTerms||"—")}<br>Payment: ${esc(o.payTerms||"—")}</td></tr>
    <tr><td><span class="k">Port of Discharge</span><br>${esc(o.portDischarge||"")}</td>
        <td><span class="k">Final Destination</span><br>${esc(o.finalDest||"")}</td></tr>
  </table>
  <table class="items">
    <thead><tr>
      <th style="width:17%">Marks &amp; Nos/<br>Nos. &amp; Kind of Pkgs.</th><th>Description of Goods</th>
      <th class="r" style="width:12%">Quantity<br>Kg</th><th class="r" style="width:12%">Rate<br>${esc(ccy)}/Kg</th>
      <th class="r" style="width:14%">Amount<br>${esc(ccy)}</th>
    </tr></thead>
    <tbody>
      ${rows}
      <tr class="meta"><td></td><td>${hsns.length?"HSN CODE: "+esc(hsns.join(", ")):""}</td><td></td><td></td><td></td></tr>
      <tr class="meta"><td></td><td>${o.netWt?"Net Weight : "+esc(o.netWt)+" kgs":""}${o.grossWt?"<br>Gross Weight : "+esc(o.grossWt)+" kgs":""}</td><td></td><td></td><td></td></tr>
      <tr class="meta"><td style="border-bottom:1.2px solid #222"></td><td style="border-bottom:1.2px solid #222">${exNote.map((n,i)=>`${i===0?"NOTE : ":""}${esc(n)}`).join("<br>")}${o.freight?`<br>FREIGHT : ${esc(ccy)} ${F2(o.freight)}`:""}${o.insurance?`<br>INSURANCE : ${esc(ccy)} ${F2(o.insurance)}`:""}</td><td style="border-bottom:1.2px solid #222"></td><td style="border-bottom:1.2px solid #222"></td><td style="border-bottom:1.2px solid #222"></td></tr>
      <tr class="tot"><td colspan="4" class="r">Total (${esc(ccy)}):</td><td class="r">${F2(total)}</td></tr>
    </tbody>
  </table>
  <div class="words">Amount Chargeable (In Words) :<b>${esc(words)}</b></div>
  <div class="signrow"><div class="sig">Signature &amp; Date<br>For <b>${esc(co.name)}</b><div class="ln">Authorised Signatory</div></div></div>
  <div class="cert">It is hereby certified that to the best of our Knowledge &amp; belief the above mentioned goods are of India origin.</div>
  <div class="note">Computer generated commercial invoice · use your browser's "Save as PDF" to download</div>
  <script>window.onload=function(){window.print();}<\/script>
</body></html>`;
  }
  const PRINT_IC='<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1.5px" aria-hidden="true"><path d="M6 9V3h12v6"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="15" width="12" height="7" rx="1"/></svg>';
  function printBtn(kind,r){ return h("button",{class:"btn sm ghost",title:(kind==="po"?"Print / download PO":"Print / download invoice"),
    onclick:e=>{e.stopPropagation();printDoc(kind,r);},html:PRINT_IC}); }

  /* The incoming-test form is reached from two places — the receipt rows here,
     and the lab incharge's own worklist on the Lab Reports page — so it is
     shared the same way the goods-receipt form is (see _erpUtil.receiveStockForm).
     One form, one endpoint, whichever screen the work starts from. */
  window._erpUtil = Object.assign(window._erpUtil||{}, { grnTestForm, grnTestPanel, qcDecisionQueue, printGrn });

  // register ⌘K quick actions for Procurement & Sales
  window.ERPActions = Object.assign(window.ERPActions||{}, {
    newPO: { mod:"purchase", create:true, ic:"🛒", label:"New Purchase Order", run:()=>App.go("purchase",{openNew:true}) },
    newSO: { mod:"sales", create:true, ic:"🧾", label:"New Sales Order",    run:()=>App.go("sales",{openNew:true}) },
    newQuotation: { mod:"quotations", create:true, ic:"📄", label:"New Quotation", run:()=>App.go("quotations",{tab:"quotations",openNew:true}) },
    newComplaint: { mod:"customers", create:true, ic:"⚠️", label:"Raise a Complaint", run:()=>{ App.go("customers"); setTimeout(()=>complaintForm(),150); } },
  });
  // the Samples & Quotations page lives in mod-crm.js; the sheet it prints on lives here
  window._erpUtil = Object.assign(window._erpUtil||{}, { printQuote });
})();
