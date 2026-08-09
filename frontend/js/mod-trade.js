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
    let tab="open";
    let filter={from:"", to:"", q:""};
    root.appendChild(pageHead("Procurement","Auto-suggested reorders, open POs and goods receipts that post straight to stock",[
      h("button",{class:"btn",onclick:reorderWizard,html:"🪄 Reorder Suggestions"}),
      h("button",{class:"btn primary",onclick:()=>poForm(params&&params.create),html:"＋ New PO"})
    ]));
    const pos=ENG.data.purchaseorders;
    const open=pos.filter(p=>p.status!=="Received");
    const pendVal=open.reduce((s,p)=>s+p.lines.reduce((a,l)=>a+(l.qty-(l.recd||0))*l.rate,0),0);
    const overdue=open.filter(p=>p.eta<DB.helpers.iso(DB.helpers.today())).length;
    root.appendChild(h("div",{class:"grid kpi-grid",style:"margin-bottom:16px"},[
      kpi({icon:"🛒",label:"Open Purchase Orders",value:ENG.num(open.length)}),
      kpi({icon:"💵",label:"Pending Inbound Value",value:ENG.money(pendVal)}),
      kpi({icon:"⏰",label:"Overdue POs",value:ENG.num(overdue),delta:overdue?"Follow up":"On track",deltaType:overdue?"down":"up"}),
      kpi({icon:"📥",label:"Received (total)",value:ENG.num(pos.filter(p=>p.status==="Received").length)}),
    ]));
    const seg=h("div",{class:"seg",style:"margin-bottom:14px"},[segBtn("Open / Partial","open"),segBtn("Received","done"),segBtn("All","all")]);
    root.appendChild(seg);
    root.appendChild(h("div",{class:"toolbar"},[
      MW.searchInput("Search PO no., supplier, item, status…", v=>{filter.q=v.toLowerCase().trim();draw();}),
      MW.dateRange(filter, draw, {label:"Order Date"}),
      h("div",{style:"margin-left:auto"},h("span",{class:"chip",id:"poCount"}))
    ]));
    const host=h("div"); root.appendChild(host);
    function segBtn(l,k){ const b=h("button",{class:tab===k?"on":"",text:l,onclick:()=>{tab=k;[...seg.children].forEach(c=>c.classList.remove("on"));b.classList.add("on");draw();}}); return b; }
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
        {key:"value",label:"Value",num:true,render:r=>ENG.money(r.value),sort:r=>r.value},
        {key:"recd",label:"Received",render:r=>{const tot=r.lines.reduce((a,l)=>a+l.qty,0),rec=r.lines.reduce((a,l)=>a+(l.recd||0),0);const p=tot?Math.round(rec/tot*100):0;return `<div style="min-width:110px">${meter(p,p===100?"ok":p>0?"warn":"danger")}<div class="muted" style="font-size:11px;margin-top:3px">${p}%</div></div>`;},sort:r=>{const tot=r.lines.reduce((a,l)=>a+l.qty,0);return tot?r.lines.reduce((a,l)=>a+(l.recd||0),0)/tot:0;}},
        {key:"date",label:"Ordered",render:r=>r.date,sort:r=>r.date},
        {key:"eta",label:"ETA",render:r=>{const late=r.status!=="Received"&&r.eta<DB.helpers.iso(DB.helpers.today());return `<span style="color:${late?'var(--danger)':'inherit'}">${r.eta}${late?" ⏰":""}</span>`;},sort:r=>r.eta},
        {key:"status",label:"Status",render:r=>badge(r.status==="Received"?"ok":r.status==="Partially Received"?"warn":"info",r.status),sort:r=>r.status},
        {key:"act",label:"",noSort:true,render:r=>h("div",{class:"flex gap aic",style:"gap:6px;justify-content:flex-end"},[
          printBtn("po",r),
          r.status!=="Received"?h("button",{class:"btn sm primary",onclick:e=>{e.stopPropagation();receivePO(r);},text:"Receive"}):h("span",{class:"muted",text:"✓"})
        ])},
      ],{onRow:r=>poDetail(r),empty:filter.q?"No purchase order matches that search":"No purchase orders"}));
    }
    draw();
    // ⌘K "New Purchase Order" lands here with openNew; consume the flag so a
    // later re-render (saveDelta) doesn't reopen the form.
    if(params&&params.openNew){ params.openNew=false; poForm(); }

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
      const body=h("div",{},[
        MW.dl([["Supplier",ENG.sup(po.supplierId)],["Billing Entity",companyByKey(po.company).name],
          ["Status",badge(po.status==="Received"?"ok":"info",po.status)],["Ordered",po.date],["ETA",po.eta]]
          .concat(po.refNo?[["Ref / Quote",po.refNo]]:[])),
        h("h3",{style:"margin:18px 0 10px;font-size:14px",text:"Order Lines"}),
        table(po.lines,[
          {key:"item",label:"Item",render:r=>{const it=ENG.item(r.itemId)||{};return `<div class="cell-main">${esc(it.name||r.itemId)}</div><div class="cell-sub">${r.itemId}</div>`;},noSort:true},
          {key:"hsn",label:"HSN",render:r=>{const it=ENG.item(r.itemId)||{};return esc(r.hsn||it.hsn||"—");},noSort:true},
          {key:"qty",label:"Ordered",num:true,render:r=>ENG.num(r.qty),noSort:true},
          {key:"recd",label:"Received",num:true,render:r=>ENG.num(r.recd||0),noSort:true},
          {key:"pend",label:"Pending",num:true,render:r=>{const p=r.qty-(r.recd||0);return p>0?`<span class="badge-s s-warn">${ENG.num(p)}</span>`:'<span class="muted">—</span>';},noSort:true},
          {key:"rate",label:"Rate",num:true,render:r=>"₹"+ENG.num(r.rate,2),noSort:true},
          {key:"gst",label:"GST %",num:true,render:r=>lineGstPct(r,ENG.item(r.itemId)),noSort:true},
          {key:"amt",label:"Amount",num:true,render:r=>ENG.money(r.qty*r.rate*(1-(r.discPct||0)/100)),noSort:true},
        ],{empty:"No lines"}),
        h("h3",{style:"margin:18px 0 10px;font-size:14px",text:"Tax Summary"}),
        MW.dl([["Taxable",ENG.money(calc.taxable)]].concat(gstPairs).concat([
          ["Freight",ENG.money(calc.freight)],["Grand Total",ENG.money(calc.grandTotal)]])),
        h("h3",{style:"margin:18px 0 10px;font-size:14px",text:"Goods Receipts"}),
        poGrns.length?table(poGrns,[
          {key:"id",label:"GRN No",render:g=>`<b>${esc(g.id)}</b>`+(g.status==="Cancelled"?' <span class="badge-s s-warn">Cancelled</span>':""),noSort:true},
          {key:"date",label:"Date",render:g=>esc(g.date||"—"),noSort:true},
          {key:"inv",label:"Supplier Inv.",render:g=>esc(g.invNo||"—"),noSort:true},
          {key:"acc",label:"Accepted",num:true,render:g=>ENG.num((g.lines||[]).reduce((s,x)=>s+(+x.accepted||0),0),2),noSort:true},
          {key:"rej",label:"Rejected",num:true,render:g=>{const r=(g.lines||[]).reduce((s,x)=>s+(+x.rejected||0),0);
            return r>0?`<span class="badge-s s-warn">${ENG.num(r,2)}</span>`:'<span class="muted">—</span>';},noSort:true},
          {key:"val",label:"Value",num:true,render:g=>ENG.money((g.lines||[]).reduce((s,x)=>s+(+x.accepted||0)*(+x.rate||0),0)),noSort:true},
          {key:"by",label:"By",render:g=>esc(g.by||"—"),noSort:true},
          {key:"act",label:"",render:g=>h("button",{class:"btn sm",onclick:e=>{e.stopPropagation();printGrn(g);},html:PRINT_IC+" GRN"}),noSort:true},
        ],{empty:"No goods receipt notes"}):
        h("div",{class:"muted",style:"font-size:12.5px",text:"No goods receipt notes yet — press Receive Goods to post one."}),
      ]);
      const anyRecd=po.lines.some(l=>(l.recd||0)>0);
      const foot=[h("button",{class:"btn danger",onclick:()=>deletePO(po),text:"🗑 Delete"}),
        h("button",{class:"btn",onclick:()=>printDoc("po",po),html:PRINT_IC+" Print"}),
        h("button",{class:"btn",onclick:()=>stickersPO(po),text:"🏷 Labels"}),
        h("button",{class:"btn",title:"Download the label rows as CSV for the BarTender label template",
          onclick:()=>bartenderPO(po),text:"⤓ BarTender"})];
      if(!anyRecd) foot.push(h("button",{class:"btn ghost",onclick:()=>{UI.$("#modalHost").hidden=true;poForm(po);},text:"✎ Edit"}));
      if(po.status!=="Received") foot.push(h("button",{class:"btn primary",onclick:()=>{UI.$("#modalHost").hidden=true;receivePO(po);},text:"Receive Goods"}));
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
      const STEPS=["Fields & Data","Layout","Preview & Print"];
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
        step=Math.max(0,Math.min(2,i)); render();
      }

      function render(){
        rail.innerHTML="";
        STEPS.forEach((t,i)=>rail.appendChild(h("button",{
          class:"wz-step"+(i===step?" on":"")+(i<step?" done":""), onclick:()=>go(i)},
          [h("span",{class:"n",text:i<step?"✓":String(i+1)}),h("span",{text:t})])));
        pane.innerHTML="";
        [stepFields,stepLayout,stepPreview][step]();
        foot.innerHTML="";
        foot.appendChild(h("button",{class:"btn ghost",onclick:()=>mo.close(),text:"Cancel"}));
        foot.appendChild(h("div",{style:"flex:1"}));
        if(step>0) foot.appendChild(h("button",{class:"btn",onclick:()=>go(step-1),text:"← Back"}));
        if(step<2) foot.appendChild(h("button",{class:"btn primary",onclick:()=>go(step+1),
          text:(step===0?"Layout":"Preview")+" →"}));
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
            row.appendChild(h("div",{class:"wz-fldact"},[
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
          html:"The field list, the title, the paragraph and the layout are saved for everyone, and shape the printed label <b>and</b> the BarTender file. Edited <b>values</b> apply to this print run only — they are never written back to the purchase order."}));
      }

      /* ============ STEP 2 — how they sit on the sheet ============ */
      function stepLayout(){
        const diag=h("div",{class:"wz-diag"});
        const dims=h("div",{class:"wz-dim"});
        const alert=h("div",{});
        const lwEl=h("input",{class:"input",id:"stk_lw",type:"number",step:stp(),min:"5"});
        const lhEl=h("input",{class:"input",id:"stk_lh",type:"number",step:stp(),min:"5"});

        /* Only the readouts redraw as the operator types — re-rendering the
           whole step would take the focus out of the box mid-keystroke. */
        function refresh(){
          const g=stickerGeom(cfg);
          if(cfg.autoSize){ lwEl.value=toU(g.labelW); lhEl.value=toU(g.labelH); }
          lwEl.disabled=lhEl.disabled=cfg.autoSize;
          diag.innerHTML=""; diag.appendChild(diagram(g)); diag.appendChild(dims);
          const total=vals.length*Math.max(1,cfg.copies||1);
          const sheets=Math.max(1,Math.ceil(total/g.perPage));
          dims.innerHTML=`Sheet <b>${fmm(g.pgW)} × ${fmm(g.pgH)} mm</b><br>`+
            `Label <b>${fmm(g.labelW)} × ${fmm(g.labelH)} mm</b><br>`+
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

        /* -- margins -- */
        left.appendChild(h("div",{class:"wz-sec",text:"Margins"}));
        left.appendChild(grid(4,[
          fld(`Top (${u})`,numIn("mTop",0,200)),      fld(`Bottom (${u})`,numIn("mBottom",0,200)),
          fld(`Left (${u})`,numIn("mLeft",0,200)),    fld(`Right (${u})`,numIn("mRight",0,200))]));

        /* -- grid -- */
        left.appendChild(h("div",{class:"wz-sec",text:"Labels per sheet"}));
        left.appendChild(grid(2,[
          fld("Rows",numIn("rows",1,50,true)), fld("Columns",numIn("cols",1,20,true))]));

        /* -- label size -- */
        const auto=h("input",{type:"checkbox"}); auto.checked=cfg.autoSize;
        auto.addEventListener("change",()=>{ cfg.autoSize=auto.checked;
          if(!cfg.autoSize){ const g=stickerGeom(cfg); cfg.labelW=g.labelW; cfg.labelH=g.labelH; }
          refresh(); });
        left.appendChild(h("div",{class:"wz-sec",style:"display:flex;align-items:center;gap:14px"},[
          h("span",{text:"Label size"}),
          h("label",{class:"wz-auto"},[auto,h("span",{text:"Auto-fit to the layout"})])]));
        left.appendChild(grid(2,[fld(`Width (${u})`,lwEl),fld(`Height (${u})`,lhEl)]));

        /* -- gaps -- */
        left.appendChild(h("div",{class:"wz-sec",text:"Gap between labels"}));
        left.appendChild(grid(2,[
          fld(`Horizontal (${u})`,numIn("gapX",0,100)),fld(`Vertical (${u})`,numIn("gapY",0,100))]));

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
        for(let i=0;i<max;i++){
          const r=Math.floor(i/cfg.cols), c=i%cfg.cols;
          const x=cfg.mLeft+c*(g.labelW+cfg.gapX), y=cfg.mTop+r*(g.labelH+cfg.gapY);
          const bad=(x+g.labelW>g.pgW-cfg.mRight+0.15)||(y+g.labelH>g.pgH-cfg.mBottom+0.15);
          page.appendChild(h("div",{class:"wz-lab"+(bad?" bad":""),
            style:`left:${(x*s).toFixed(1)}px;top:${(y*s).toFixed(1)}px;`+
              `width:${Math.max(1,g.labelW*s).toFixed(1)}px;height:${Math.max(1,g.labelH*s).toFixed(1)}px`}));
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
      function stepPreview(){
        const g=stickerGeom(cfg), m=labelMetrics(cfg,g,vals);
        // sheet count lives in paintSheet(), which owns the pager

        const frame=(html,wMM,hMM,boxW,boxH)=>{
          const s=Math.min(boxW/(wMM*PX_MM),boxH/(hMM*PX_MM));
          return h("div",{class:"wz-frame",
            style:`width:${(wMM*PX_MM*s).toFixed(1)}px;height:${(hMM*PX_MM*s).toFixed(1)}px`},
            h("iframe",{srcdoc:html,scrolling:"no","aria-hidden":"true",
              style:`width:${wMM}mm;height:${hMM}mm;transform:scale(${s.toFixed(4)});transform-origin:top left`}));
        };

        /* -- left: one label, as designed -- */
        const one=h("div",{class:"wz-pv"},[h("h4",{text:"Label design"})]);
        one.appendChild(frame(labelOneHtml(cfg,vals[Math.min(cur,vals.length-1)],vals),
          g.labelW,g.labelH,440,420));
        if(vals.length>1) one.appendChild(h("div",{class:"wz-nav"},[
          h("button",{class:"btn sm",onclick:()=>{cur=(cur-1+vals.length)%vals.length;render();},text:"◀"}),
          h("span",{text:`Label ${cur+1} of ${vals.length}`}),
          h("button",{class:"btn sm",onclick:()=>{cur=(cur+1)%vals.length;render();},text:"▶"})]));
        one.appendChild(h("div",{class:"wz-dim",html:
          `<b>${fmm(g.labelW)} × ${fmm(g.labelH)} mm</b><br>`+
          (m.big?"Wordmark on top + watermark behind — at least "+STICKER_BIG_W+" mm wide and "
                 +STICKER_BIG_H+" mm tall"
               :"Watermark only — under "+STICKER_BIG_W+" mm wide or "+STICKER_BIG_H
                 +" mm tall, too small for the wordmark")+
          (m.k<.55?`<br><span style="color:var(--warn)">Type is scaled to ${Math.round(m.k*100)}% — `+
            `untick a field or use a bigger label for larger print.</span>`:"")}));

        /* -- right: the sheet as it will print --
           Repainted on its own rather than through render(), so changing the
           copy count updates the sheet and its pager without taking the focus
           out of the box the operator is still typing in. */
        const sheet=h("div",{class:"wz-pv"},[h("h4",{text:"Sheet layout"})]);
        const sheetSlot=h("div"), sheetNav=h("div",{class:"wz-nav"});
        sheet.appendChild(sheetSlot); sheet.appendChild(sheetNav);
        function paintSheet(){
          const sh=Math.max(1,Math.ceil(vals.length*Math.max(1,cfg.copies||1)/g.perPage));
          pvPage=Math.min(Math.max(0,pvPage),sh-1);
          sheetSlot.innerHTML="";
          sheetSlot.appendChild(frame(labelSheetHtml(po,cfg,vals,{onlyPage:pvPage}),
            g.pgW,g.pgH,440,420));
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

        pane.appendChild(h("div",{class:"wz-split"},[one,sheet]));

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
        pane.appendChild(h("div",{class:"wz-copies"},[
          h("div",{class:"field",style:"flex:0 0 auto"},
            [h("label",{text:"No. of labels (copies of each)"}),copyIn]),
          tally]));

        pane.appendChild(h("div",{class:"muted",style:"margin-top:14px;font-size:12px;line-height:1.65",
          html:"<b>Print Labels</b> opens the sheet in a new tab and raises your printer dialog — pick the label printer or the tray there. Set the printer's paper size to match the sheet above and its scaling to 100% (never “fit to page”), or the millimetres will not come out true. This dialog stays open behind it, so you come back exactly where you left off."}));
      }

      render();
    }
    function bartenderPO(po){ sendToBartender(po); }

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
          {key:"onHand",label:"On Hand",num:true,render:r=>ENG.num(r.st.onHand,1),noSort:true},
          {key:"reorder",label:"Reorder Pt",num:true,render:r=>ENG.num(r.it.reorder),noSort:true},
          {key:"suggest",label:"Suggested",num:true,render:r=>`<span class="strong" style="color:var(--accent)">${ENG.num(r.st.suggest)} ${r.it.uom}</span><span class="muted">${esc(ENG.kgSuffix(r.it,r.st.suggest))}</span>`,noSort:true},
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
          U.field("Supplier",U.searchSelect("po_sup",sups.map(s=>({v:s.id,l:s.name})),editPo?editPo.supplierId:(sups[0]&&sups[0].id),"Search supplier…")),
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
      function addLine(seed){
        const rms=ENG.data.items.filter(i=>i.cat!=="FG");
        const idx=lines.length; lines.push({});
        const itemId=seed?(seed.itemId||seed):(rms[0]&&rms[0].id);
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
          if(vis) vis.value=pick.name+" — "+pick.id;   // keep the search box honest
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
          style:"font-size:10.5px;margin-top:3px;display:none"});
        const qtyEl=h("input",{class:"input",id:"pl_qty_"+idx,type:"number",placeholder:"0",value:qtyVal});
        /* Suppliers quote tape either way round, so whichever unit is typed the
           other is shown beside it — with the width and GSM it was worked out
           from, so the figure can be checked rather than trusted. */
        const convEl=h("div",{class:"muted",id:"pl_conv_"+idx,style:"font-size:10.5px;margin-top:3px"});
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
          h("div",{html:U.searchSelect("pl_item_"+idx,rms.map(i=>({v:i.id,l:i.name+" — "+i.id})),itemId,"Search material…")}),
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
        if(hid) hid.addEventListener("change",()=>{ const ni=ENG.item(hid.value)||{};
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
        <div class="muted" style="font-size:10.5px;font-weight:700;text-transform:uppercase;margin-bottom:6px">Export supply — commercial invoice, GST not added</div>
        ${calc.discount?row("Discount","− "+f2(calc.discount)):""}
        ${row("Sub Total",f2(sub))}
        ${inpRow("Freight ("+opts.exportCcy+")",opts.freightId,frVal)}
        ${opts.insuranceId?inpRow("Insurance ("+opts.exportCcy+")",opts.insuranceId,insVal):""}
        ${row("Total ("+opts.exportCcy+")",f2(tot),true)}
      </div>`;
      return;
    }
    box.innerHTML=`<div style="min-width:300px;background:var(--panel-2);border:1px solid var(--line);border-radius:10px;padding:12px 14px">
      <div class="muted" style="font-size:10.5px;font-weight:700;text-transform:uppercase;margin-bottom:6px">
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
    let tab="open";
    let filter={from:"", to:"", q:""};
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
      MW.searchInput("Search SO no., customer, item, batch, invoice…", v=>{filter.q=v.toLowerCase().trim();draw();}),
      MW.dateRange(filter, draw, {label:"Order Date"}),
      h("div",{style:"margin-left:auto"},h("span",{class:"chip",id:"soCount"}))
    ]));
    const host=h("div"); root.appendChild(host);
    function segBtn(l,k){ const b=h("button",{class:tab===k?"on":"",text:l,onclick:()=>{tab=k;[...seg.children].forEach(c=>c.classList.remove("on"));b.classList.add("on");draw();}}); return b; }
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

    function fulfillBadge(so){
      const ok=so.lines.every(l=>ENG.stock(l.itemId).onHand>=l.qty);
      const some=so.lines.some(l=>ENG.stock(l.itemId).onHand>0);
      return badge(ok?"ok":some?"warn":"danger", ok?"In stock":some?"Partial":"Make to order");
    }
    async function dispatchSO(so){
      const short=so.lines.filter(l=>ENG.stock(l.itemId).onHand<l.qty)
        .map(l=>`${ENG.item(l.itemId).name}: need ${ENG.num(l.qty)}, have ${ENG.num(ENG.stock(l.itemId).onHand,1)}`);
      const msg=short.length?`⚠ Insufficient finished goods:\n\n${short.join("\n")}\n\nDispatch anyway (stock goes negative)?`
        :`Dispatch ${so.id} to ${ENG.custName(so.customerId)}? Finished goods will be deducted from stock.`;
      if(!await confirm(msg,{title:"Dispatch Order",danger:short.length>0})) return;
      const date=DB.helpers.iso(DB.helpers.today());
      so.lines.forEach(l=>{ ENG.data.movements.push({id:U.genMoveId()+"-"+l.itemId, date, itemId:l.itemId, wh:"WH-FG", type:"SALE",
        qty:-l.qty, rate:l.rate, ref:so.id, note:"Dispatch to "+ENG.custName(so.customerId), by:(App.user&&App.user.username)||"sales"}); });
      so.status="Dispatched";
      toast(`${so.id} dispatched — stock deducted`,{type:"ok",title:"Dispatch posted"});
      App.saveDelta(()=>DB.sales.dispatch(so.id,{date}));  // server posts the SALE movements + sets status atomically
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
        {key:"qty",label:"Qty",num:true,render:r=>ENG.num(r.qty)+" "+((ENG.item(r.itemId)||{}).uom||"kg")+ENG.kgSuffix(ENG.item(r.itemId),r.qty),noSort:true},
        {key:"stock",label:"In Stock",num:true,render:r=>{const h2=ENG.stock(r.itemId).onHand;const u=(ENG.item(r.itemId)||{}).uom||"kg";
          return `<span style="color:${h2>=r.qty?'var(--ok)':'var(--danger)'}">${ENG.num(h2,1)} ${esc(u)}${esc(ENG.kgSuffix(ENG.item(r.itemId),h2))}</span>`;},noSort:true},
        {key:"rate",label:"Rate",num:true,render:r=>"₹"+ENG.num(r.rate),noSort:true},
        {key:"gst",label:"GST %",num:true,render:r=>lineGstPct(r,ENG.item(r.itemId)),noSort:true},
        {key:"amt",label:"Amount",num:true,render:r=>ENG.money(r.qty*r.rate*(1-(r.discPct||0)/100)),noSort:true});
      const body=h("div",{},[
        MW.dl([["Customer",ENG.custName(so.customerId)],["Billing Entity",companyByKey(so.company).name],
          ["Status",badge(so.status==="Dispatched"?"ok":"info",so.status)],["Priority",so.priority],
          ["Order Date",so.date],["Promised",so.promised]]
          .concat(so.invoiceNo&&so.invoiceNo!==so.id?[["Invoice No.",so.invoiceNo]]:[])
          .concat(so.custPoNo?[["Customer PO",so.custPoNo]]:[])
          .concat(so.placeOfSupply?[["Place of Supply",so.placeOfSupply+" — "+GST.stateName(so.placeOfSupply)]]:[])
          .concat(so.transportMode?[["Transport",[so.transportMode,so.vehicleNo].filter(Boolean).join(" · ")]]:[])
          .concat(so.ewayBill?[["E-Way Bill",so.ewayBill]]:[])
          .concat(so.fromLead?[["From CRM Lead","🎯 "+so.fromLead]]:[])),
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
          U.field("Customer (Bill To)",U.searchSelect("so_cust",custs.map(c=>({v:c.id,l:c.name})),editSo?editSo.customerId:(cust0&&cust0.id),"Search customer…")),
          U.field("Place of Supply",U.selectHTML("so_pos",stateOpts(),
            (editSo&&editSo.placeOfSupply)||partyStateCode(cust0)||"29")),
          U.field("Ship To (delivery address)",`<textarea class="input" id="so_ship" rows="2" placeholder="same as billing">${esc(editSo?(editSo.shipTo||""):(cust0&&(cust0.shipTo||cust0.address)||""))}</textarea>`,"full"),
        ]),
        sec("Invoice Details"),
        h("div",{class:"form-grid g3"},[
          U.field("Invoice Type",U.selectHTML("so_itype",[{v:"domestic",l:"Domestic — GST Tax Invoice"},{v:"export",l:"Export — Commercial Invoice"}],editSo?(editSo.invoiceType||"domestic"):"domestic")),
          U.field("Currency",U.selectHTML("so_ccy",[{v:"INR",l:"INR ₹"},{v:"USD",l:"USD $"},{v:"EUR",l:"EUR €"},{v:"GBP",l:"GBP £"},{v:"AED",l:"AED"},{v:"SAR",l:"SAR"}],editSo?(editSo.currency||"INR"):"INR")),
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
        if(ex&&UI.$("#so_ccy").value==="INR") UI.$("#so_ccy").value="USD";
        recalc();
      });
      // customer switch refreshes place of supply, ship-to + payment terms
      const custHid=UI.$("#so_cust");
      if(custHid) custHid.addEventListener("change",()=>{
        const c=custs.find(x=>x.id===custHid.value); if(!c) return;
        const posEl=UI.$("#so_pos"); const sc=partyStateCode(c); if(posEl&&sc) posEl.value=sc;
        const shipEl=UI.$("#so_ship"); if(shipEl) shipEl.value=c.shipTo||c.address||"";
        const tEl=UI.$("#so_terms"); if(tEl&&c.terms) tEl.value=c.terms;
        recalc();
      });
      /* Batch = the work order this line is served from. Only FINISHED jobs
         appear, each with the quantity still unclaimed, so an order is filled
         from what the floor has actually produced. */
      function batchOpts(itemId){
        const ready=ENG.readyBatches(itemId);
        const uom=(ENG.item(itemId)||{}).uom||"kg";
        // the batch reads as its plain number, carrying the run's size and the
        // quantity still free, so the operator picks the right ready stock
        const opts=ready.map(b=>{
          const size=lineSize({itemId:b.itemId,width:b.widthMM});
          /* The same three figures the hint below uses, so the two agree. The
             unit is stated once, on the first figure — the desk was reading
             bare numbers and could not tell kg from metres. */
          return {v:b.id, l:batchNo(b.id)+(size?" · "+size:"")
            +" · "+ENG.num(b.ordered,1)+" "+uom+" ordered · "+ENG.num(b.made,1)+" produced · "
            +ENG.num(b.pending,1)+" pending"};
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
        const ready=ENG.readyBatches(itemId);
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
        const sConvEl=h("div",{class:"muted",id:"sl_conv_"+idx,style:"font-size:10.5px;margin-top:3px"});
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
    let q="";
    root.appendChild(h("div",{class:"toolbar"},[
      MW.searchInput("Search supplier, city, category, GSTIN, contact, item…", v=>{q=v.toLowerCase().trim();draw();}),
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
          s.gst?h("div",{class:"muted",style:"font-size:11.5px;margin-bottom:8px",text:"GSTIN "+s.gst+(partyStateCode(s)?" · "+GST.stateName(partyStateCode(s)):"")}):null,
          h("div",{style:"margin-bottom:10px"},[ h("div",{class:"flex between",style:"font-size:11px;margin-bottom:4px"},[h("span",{class:"muted",text:"On-time delivery"}),h("span",{class:"muted",text:s.onTime+"%"})]), h("div",{html:meter(s.onTime,s.onTime>92?"ok":s.onTime>85?"warn":"danger")}) ]),
          h("div",{class:"flex between",style:"font-size:12.5px;padding-top:10px;border-top:1px solid var(--line)"},[
            h("span",{class:"muted",text:items.length+" items supplied"}),
            h("span",{class:"strong",text:ENG.money(spendMap[s.id]||0)+" / yr"})
          ]),
          h("div",{class:"contact-line",style:"font-size:11.5px;margin-top:8px"},[
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
  M.customers = { title:"Customers", sub:"Client master & orders", render(root){
    root.appendChild(pageHead("Customers","HT cable manufacturers and order history",[
      MW.excelMenu("customers"),
      h("button",{class:"btn primary",onclick:()=>customerForm(),html:"＋ New Customer"})
    ]));
    let q="";
    root.appendChild(h("div",{class:"toolbar"},[
      MW.searchInput("Search customer, city, segment, GSTIN, contact…", v=>{q=v.toLowerCase().trim();draw();}),
      h("div",{style:"margin-left:auto"},h("span",{class:"chip",id:"custCount"}))
    ]));
    const host=h("div"); root.appendChild(host);
    /* Grade and SO number are in here too: "grade a" narrows to the key
       accounts, and pasting an SO number finds whose order it is. */
    function custMatch(c){
      if(!q) return true;
      const hay=[c.name, c.city, c.segment, c.gst, c.contact, c.phone, c.email, c.terms, c.since,
        c.rating?"grade "+c.rating:null]
        .concat(ENG.data.salesorders.filter(s=>s.customerId===c.id).map(s=>s.id));
      return hay.filter(Boolean).join(" ").toLowerCase().includes(q);
    }
    function draw(){
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
        grid.appendChild(h("div",{class:"card hover"},[
          h("div",{class:"flex between aic"},[
            h("div",{},[h("h3",{style:"font-size:15px",text:c.name}),h("div",{class:"muted",style:"font-size:12px",text:[c.city,c.segment].filter(Boolean).join(" · ")})]),
            h("span",{html:badge(c.rating==="A"?"ok":c.rating==="B"?"warn":"mut","Grade "+c.rating)})
          ]),
          // statgrid-3: three tiny figures — they stay side by side on a phone
          h("div",{class:"grid cols-3 statgrid-3",style:"margin:14px 0;gap:8px"},[
            stat("Orders",orders.length), stat("Open",open), stat("Since",c.since),
          ]),
          c.gst?h("div",{class:"muted",style:"font-size:11.5px;margin-bottom:8px",text:"GSTIN "+c.gst+(partyStateCode(c)?" · "+GST.stateName(partyStateCode(c)):"")}):null,
          h("div",{class:"flex between",style:"font-size:12.5px;padding-top:10px;border-top:1px solid var(--line)"},[
            h("span",{class:"muted",text:"Lifetime value"}), h("span",{class:"strong",text:ENG.money(total)})
          ]),
          h("div",{class:"contact-line",style:"font-size:11.5px;margin-top:8px"},[
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

  function stat(label,val){ return h("div",{},[h("div",{class:"muted",style:"font-size:10.5px;font-weight:700;text-transform:uppercase",text:label}),h("div",{style:"font-weight:700;font-size:15px;margin-top:2px",text:val})]); }

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
  function customerForm(edit){
    const yr=String(DB.helpers.today().getFullYear());
    const v=k=>esc(edit?(edit[k]||""):"");
    const body=h("div",{class:"form-grid"},[
      U.field("Customer Name *",`<input class="input" id="cu_name" value="${v("name")}" placeholder="e.g. Apar Industries Ltd.">`,"full"),
      U.field("Segment",`<input class="input" id="cu_seg" value="${esc(edit?(edit.segment||"HT Cables"):"HT Cables")}">`),
      U.field("GSTIN",`<input class="input" id="cu_gst" value="${v("gst")}" placeholder="e.g. 27ABCDE1234F1Z5" style="text-transform:uppercase">`),
      U.field("State",U.selectHTML("cu_state",stateOpts(),(edit&&partyStateCode(edit))||"29")),
      U.field("Billing Address",`<textarea class="input" id="cu_addr" rows="2">${v("address")}</textarea>`,"full"),
      U.field("Ship-To Address",`<textarea class="input" id="cu_ship" rows="2" placeholder="leave blank if same as billing">${v("shipTo")}</textarea>`,"full"),
      U.field("City",`<input class="input" id="cu_city" value="${v("city")}">`),
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
    function save(){
      const name=UI.$("#cu_name").value.trim();
      if(!name){ toast("Customer name is required",{type:"warn"}); return; }
      const gst=UI.$("#cu_gst").value.trim().toUpperCase();
      if(gst&&!GST.validGSTIN(gst)){ toast("That GSTIN doesn't look valid (15 chars, e.g. 27ABCDE1234F1Z5)",{type:"warn"}); return; }
      const doc={ name, segment:UI.$("#cu_seg").value.trim()||"HT Cables", gst,
        state:GST.stateName(UI.$("#cu_state").value), stateCode:UI.$("#cu_state").value,
        address:UI.$("#cu_addr").value.trim(), shipTo:UI.$("#cu_ship").value.trim(),
        city:UI.$("#cu_city").value.trim(), rating:UI.$("#cu_rating").value,
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
    const html = kind==="po" ? domesticHtml(o, true)
               : (o.invoiceType==="export" ? exportHtml(o) : domesticHtml(o));
    const w=window.open("","_blank");
    if(!w){ toast("Popup blocked — allow popups for this site to print",{type:"warn"}); return; }
    w.document.write(html); w.document.close();
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
    // kept in step with `order` so the BarTender CSV still reads one flag per field
    const fields={}; all.forEach(f=>{ fields[f.k]=order.indexOf(f.k)>=0; });
    /* dim() accepts 0 — a zero margin or gap is a real choice, unlike a zero
       page or label size, which pick() rejects in favour of the default. */
    const dim=(v,d,lo,hi)=>{ v=+v; return isNaN(v)?d:Math.min(hi,Math.max(lo,v)); };
    const pick=(v,d,lo,hi)=>{ v=+v; return isNaN(v)||v<=0?d:Math.min(hi,Math.max(lo,v)); };
    const int=(v,d,lo,hi)=>{ v=Math.round(+v); return isNaN(v)?d:Math.min(hi,Math.max(lo,v)); };
    const txt=(v,d,max)=>{ v=(v==null?d:String(v)); return v.slice(0,max); };
    return {
      fields, order, custom,
      /* The heading is no longer welded to "RAW MATERIAL" — it is text like
         any other, and the type scale accounts for however long it runs. */
      title: txt(s.title,"RAW MATERIAL",120),
      para:  txt(s.para,"",1200),           // free paragraph printed under the fields
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
      autoSize: s.autoSize!==false,
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
     With auto-size on, the label is whatever is left once the margins and the
     gaps are taken out of the page — so it always fits by construction; with
     it off the operator's own size is used and `fits` reports the truth. */
  function stickerGeom(cfg){
    const pg=pageMM(cfg);
    const innerW=pg.w-cfg.mLeft-cfg.mRight, innerH=pg.h-cfg.mTop-cfg.mBottom;
    let lw=cfg.labelW, lh=cfg.labelH;
    /* An unset size (0) falls back to the layout too, so a config that has
       never had a label size typed into it still has one to print. */
    if(cfg.autoSize||!(lw>0)||!(lh>0)){
      lw=(innerW-(cfg.cols-1)*cfg.gapX)/cfg.cols;
      lh=(innerH-(cfg.rows-1)*cfg.gapY)/cfg.rows;
    }
    lw=Math.round(lw*10)/10; lh=Math.round(lh*10)/10;
    const needW=cfg.cols*lw+(cfg.cols-1)*cfg.gapX, needH=cfg.rows*lh+(cfg.rows-1)*cfg.gapY;
    const EPS=0.15;                       // a rounded 0.1mm must not read as overflow
    return { pgW:pg.w, pgH:pg.h, innerW, innerH, labelW:lw, labelH:lh, needW, needH,
      overW:needW-innerW, overH:needH-innerH,
      fitsW: lw>=5 && needW<=innerW+EPS, fitsH: lh>=5 && needH<=innerH+EPS,
      fits: lw>=5 && lh>=5 && needW<=innerW+EPS && needH<=innerH+EPS,
      perPage: Math.max(1,cfg.rows*cfg.cols) };
  }

  /* ---- How one label is composed at the chosen size -------------------
     THE LOGO RULE, exactly as specified: a label at least 100 mm wide AND at
     least 50 mm tall carries the full Chhaperia wordmark across the top. Below
     either of those, the wordmark is dropped. The centred mark stays in both
     cases as a watermark at 10% visibility — that never changes, only the
     wordmark comes and goes.

     Type then scales to whatever room is left: the 100 × 150 mm label is the
     reference design (k = 1) and k shrinks until the ticked rows fit the
     label's height, so untick a field and everything else prints bigger. */
  const STICKER_BIG_W=100, STICKER_BIG_H=50;
  function labelMetrics(cfg,geom,list){
    const lw=geom.labelW, lh=geom.labelH;
    const big=lw>=STICKER_BIG_W&&lh>=STICKER_BIG_H;
    const added=addedDefs(cfg);
    const rows=added.filter(x=>x.row);
    const head=added.some(x=>x.head), status=added.some(x=>x.boxes);
    const plain=cfg.layout==="plain";
    const padY=Math.max(1.2,lh*.035), padX=Math.max(1.2,lw*.045);
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
    function needAt(k){
      const font=3*k, cellPad=plain?1.4*k:3.8*k;
      const capW=inner*.47-cellPad, valW=inner*.53-cellPad;
      const rowExtra=plain?(1.6*k):(3*k+0.3*k);           // padding (+ border in table mode)
      let hgt=(big?16.2*k:0);
      if(cfg.title) hgt+=linesOf(cfg.title,inner,4.6*k)*4.6*k*1.35+3.2*k;
      if(head) hgt+=worst(v=>"PRODUCT: "+(v.product||""),inner,3.8*k)*3.8*k*1.35+4.2*k;
      rows.forEach(x=>{
        hgt+=Math.max(linesOf(x.cap,capW,font),worst(v=>v[x.k],valW,font))*font*1.35+rowExtra;
      });
      if(status) hgt+=3*font*1.45+rowExtra;
      if(cfg.para) hgt+=linesOf(cfg.para,inner,2.7*k)*2.7*k*1.35+3*k;
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
    return {big,rows,head,status,plain,padY,padX,k};
  }

  const STICKER_STATUS_PLAIN=`<div>[&nbsp;&nbsp;&nbsp;&nbsp;] UNDER TEST</div>`
    +`<div>[&nbsp;&nbsp;&nbsp;&nbsp;] APPROVED</div>`
    +`<div>[&nbsp;&nbsp;&nbsp;&nbsp;] REJECTED</div>`;
  const STICKER_STATUS_TR=`<tr><th>STATUS</th><td class="st">${STICKER_STATUS_PLAIN}</td></tr>`;

  /* Sizes are in mm, not px: a millimetre means the same thing to the printer
     as it does on screen, so the preview and the sheet cannot drift apart. */
  function labelCss(geom,m){
    const u=(n)=>(n*m.k).toFixed(2)+"mm";
    return `
  .lb{position:relative;width:${geom.labelW}mm;height:${geom.labelH}mm;overflow:hidden;background:#fff;
    font:${u(3.2)}/1.35 "Times New Roman",Georgia,serif;color:#000}
  .lb .wm{position:absolute;z-index:0;left:50%;top:50%;transform:translate(-50%,-50%);
    width:62%;opacity:.10;pointer-events:none}
  .lb .in{position:relative;z-index:1;height:100%;box-sizing:border-box;
    padding:${m.padY.toFixed(2)}mm ${m.padX.toFixed(2)}mm;display:flex;flex-direction:column}
  .lb .lg{text-align:center;margin-bottom:${u(3.2)}}
  .lb .lg img{height:${u(13)};max-width:92%;object-fit:contain}
  .lb .ttl{text-align:center;font-size:${u(4.6)};font-weight:700;letter-spacing:.02em;margin-bottom:${u(3.2)}}
  .lb .prod{font-size:${u(3.8)};font-weight:700;margin:0 0 ${u(4.2)};white-space:pre-wrap}
  /* flex:1 hands the field block whatever height the header did not use, and
     the rows share it out — so the fields fill the label instead of stranding
     a band of blank paper under the last row. */
  .lb table{width:100%;border-collapse:collapse;table-layout:fixed;flex:1 1 auto}
  .lb th,.lb td{border:${Math.max(.15,.25*m.k).toFixed(2)}mm solid #000;padding:${u(1.5)} ${u(1.9)};
    font-size:${u(3.0)};font-weight:400;text-align:left;vertical-align:middle;
    overflow-wrap:anywhere;white-space:pre-wrap}
  .lb th{width:47%}
  .lb td{font-weight:700}
  .lb td.st{font-weight:400;line-height:1.45;white-space:nowrap}
  /* Non-table layout: the SAME two columns and the same alignment, with the
     rules simply not drawn. */
  .lb .pl{flex:1 1 auto;display:flex;flex-direction:column;justify-content:space-between}
  .lb .pr{display:flex;align-items:baseline;gap:${u(1.4)};padding:${u(.8)} 0}
  .lb .pk{width:47%;flex:0 0 47%;font-size:${u(3.0)};font-weight:400}
  .lb .pv{flex:1 1 auto;font-size:${u(3.0)};font-weight:700;
    overflow-wrap:anywhere;white-space:pre-wrap}
  .lb .pv.st{font-weight:400;line-height:1.45;white-space:nowrap}
  /* the free paragraph, set smaller than the fields so it reads as a note */
  .lb .para{margin-top:${u(3)};font-size:${u(2.7)};line-height:1.35;
    white-space:pre-wrap;overflow-wrap:anywhere;flex:0 0 auto}
  /* an unknown field prints as clear space the store writes on by hand */
  .lb .wr{display:block;height:${u(3.0)}}`;
  }

  function labelHtml(v,cfg,m){
    /* logo-full is the dark-background lockup — its lettering is pure white and
       would print invisibly here, so the label uses the print-safe twin with
       that same artwork darkened. */
    const logo=location.origin+"/assets/logo-full-print.png";
    const mark=location.origin+"/assets/mark.png";
    const BLANK='<span class="wr"></span>';
    const cell=(x)=>x?esc(x):BLANK;
    const body=m.plain
      ? `<div class="pl">${m.rows.map(x=>
          `<div class="pr"><span class="pk">${esc(x.cap)}</span><span class="pv">${cell(v[x.k])}</span></div>`).join("")}${
          m.status?`<div class="pr"><span class="pk">STATUS</span><span class="pv st">${STICKER_STATUS_PLAIN}</span></div>`:""}</div>`
      : `<table><tbody>${m.rows.map(x=>
          `<tr><th>${esc(x.cap)}</th><td>${cell(v[x.k])}</td></tr>`).join("")}${
          m.status?STICKER_STATUS_TR:""}</tbody></table>`;
    return `<div class="lb"><img class="wm" src="${mark}" alt="">
      <div class="in">
        ${m.big?`<div class="lg"><img src="${logo}" alt="Chhaperia"></div>`:""}
        ${cfg.title?`<div class="ttl">${esc(cfg.title)}</div>`:""}
        ${m.head?`<div class="prod">PRODUCT: <b>${cell(v.product)}</b></div>`:""}
        ${body}
        ${cfg.para?`<div class="para">${esc(cfg.para)}</div>`:""}
      </div></div>`;
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
    grid-auto-rows:${geom.labelH}mm;column-gap:${cfg.gapX}mm;row-gap:${cfg.gapY}mm;
    align-content:start;justify-content:start;
    page-break-after:always;break-after:page}
  .pg:last-child{page-break-after:auto;break-after:auto}
  ${labelCss(geom,m)}
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
  ${labelCss(geom,m)}
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

  /* The BarTender bridge: the same label rows as a CSV the .btw template
     binds to as its data source. Columns come off STICKER_FIELDS, so adding a
     field adds its column here too; an unticked field ships empty rather than
     vanishing, so an existing .btw keeps finding every column it expects. */
  function stickerCsv(po,list){
    const rows=list||stickerValues(po);
    if(!rows.length) return null;
    const cfg=stickerCfg(), f=cfg.fields;
    /* Built-in columns always ship, in their fixed order, so an existing .btw
       keeps finding every column it was designed against; invented fields are
       appended after them. An unticked field ships empty rather than vanishing. */
    const cols=STICKER_FIELDS.concat(cfg.custom||[]);
    const q=(v)=>`"${String(v==null?"":v).replace(/"/g,'""')}"`;
    // UTF-8 BOM, so Excel and BarTender read g/m² correctly
    return "﻿"+[
      ["PONo"].concat(cols.map(x=>x.csv)).map(q).join(","),
      ...rows.map(v=>[po.id].concat(cols.map(x=>
        (x.boxes||!f[x.k])?"":(v[x.k]||""))).map(q).join(",")),
    ].join("\r\n");
  }

  /* Pressing ⤓ BarTender asks the SERVER to write the rows and start the
     BarTender app on its machine — the browser cannot start desktop programs.
     When the app is not installed there, the operator still gets the file:
     it downloads locally instead, with the server's explanation. */
  async function sendToBartender(po){
    const csv=stickerCsv(po);
    if(!csv){ toast("This purchase order has no lines to label",{type:"warn"}); return; }
    try{
      const r=await DB.bartender.stickers(po.id,csv);
      if(r.launched&&r.templateFound){ toast(r.message,{type:"ok",title:"BarTender"}); return; }
      if(r.launched){ toast(r.message,{title:"BarTender — one-time setup"}); return; }
      U.downloadCSV(`${po.id}-stickers.csv`,csv);
      toast(r.message+" The file was also downloaded here.",{type:"warn",title:"BarTender not started"});
    }catch(e){
      U.downloadCSV(`${po.id}-stickers.csv`,csv);
      toast((e.message||"The server could not hand off to BarTender.")+" The label file was downloaded instead.",
        {type:"warn",title:"BarTender"});
    }
  }

  /* ============================================================
     GOODS RECEIPT NOTE — the numbered receipt document, printed
     from the frozen GRN record the server issued (never recomputed
     from live stock, so a reprint always matches the original).
     Same press as the PO print: header band, info grid, party
     blocks, dark item table, signature strip.
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

    const infoPairs=[
      ["GRN No.",g.id],["GRN Date",fmtD(g.date)],["Warehouse",whName],
      ["Against PO",g.poId||"—"],["PO Date",fmtD(g.poDate)],["Received By",g.by||"—"],
      ["Supplier Inv. No.",g.invNo||"—"],["Invoice Date",fmtD(g.invDate)],["Vehicle No.",g.vehicle||"—"],
    ].concat(g.lrNo?[["LR / Docket No.",g.lrNo],["",""],["",""]]:[]);
    const infoCells=infoPairs.map(([k,vv])=>k?`<div class="ip"><span>${k}</span><b>${esc(String(vv))}</b></div>`:'<div class="ip"></div>').join("");

    const rows=lines.map((x,i)=>`<tr><td class="c">${i+1}</td>`+
      `<td>${esc(x.name||x.itemId)}<div class="sub">${esc(x.itemId)}</div></td>`+
      `<td class="c">${esc(x.hsn||"—")}</td><td class="c">${esc(x.uom||"—")}</td>`+
      `<td class="r">${ENG.num(x.ordered,2)}</td><td class="r">${ENG.num(x.qty,2)}</td>`+
      `<td class="r">${ENG.num(x.accepted,2)}</td>`+
      `<td class="r">${(+x.rejected||0)>0?`<span class="rej">${ENG.num(x.rejected,2)}</span>`:"—"}</td>`+
      `<td class="r">${IN(x.rate)}</td><td class="r">${IN((+x.accepted||0)*(+x.rate||0))}</td></tr>`).join("");
    let filler="";
    for(let i=0;i<2;i++) filler+=`<tr class="fill">${'<td>&nbsp;</td>'.repeat(10)}</tr>`;

    const html=`<!doctype html><html><head><meta charset="utf-8"><title>Goods Receipt Note ${esc(g.id)}</title>
<style>
  @page{size:A4;margin:8mm}
  *{margin:0;padding:0;box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  body{font:12px/1.38 "Segoe UI",Arial,sans-serif;color:#1a1c1e;max-width:860px;margin:0 auto;padding:0 20px 20px}
  .band{display:flex;align-items:stretch;gap:0;margin:0 -20px 0;min-height:96px}
  .logo-side{flex:1.05;display:flex;align-items:center;padding:5px 0 5px 16px}
  .logo-side img{width:100%;max-height:92px;object-fit:contain;object-position:left center}
  .co-block{flex:1;background:#26282b;color:#cfd4d8;clip-path:polygon(9% 0,100% 0,100% 100%,0 100%);
    padding:12px 20px 10px 58px;text-align:right;font-size:10.5px;line-height:1.6;display:flex;flex-direction:column;justify-content:center}
  .conm{font-size:14.5px;font-weight:800;color:#F58024;text-transform:uppercase;letter-spacing:.4px}
  .co-ids{margin-top:6px;padding-top:5px;border-top:1px solid rgba(255,255,255,.22);color:#fff;font-weight:600;font-size:10.5px}
  .co-ids span{color:#F58024;font-weight:800}
  .rule{height:3px;background:linear-gradient(90deg,#F06820 0 62%,#26282b 62% 100%);margin:0 -20px 12px}
  .title-row{display:flex;justify-content:space-between;align-items:center;margin:0 0 10px}
  .title{font-size:20px;font-weight:800;letter-spacing:4px;color:#26282b;border-left:6px solid #F06820;padding-left:12px}
  .copy{font-size:9px;font-weight:700;letter-spacing:1px;color:#888;border:1px solid #ccc;border-radius:4px;padding:3px 9px;text-transform:uppercase}
  .info{display:grid;grid-template-columns:repeat(3,1fr);gap:2px 24px;border:1px solid #d8dbde;border-radius:9px;background:#fafbfc;padding:7px 14px;margin-bottom:8px}
  .ip{display:flex;justify-content:space-between;gap:8px;font-size:11px;min-height:15px}
  .ip span{color:#767c82;text-transform:uppercase;font-size:9.5px;font-weight:700;letter-spacing:.3px;padding-top:1px}
  .parties{display:flex;gap:12px;margin:18px 0 8px}
  .party{flex:1;border:1px solid #d8dbde;border-top:3px solid #F06820;border-radius:0 0 9px 9px;padding:7px 12px;font-size:11.5px;line-height:1.45}
  .plbl{display:inline-block;background:#F06820;color:#fff;font-size:9px;font-weight:800;letter-spacing:1px;padding:2.5px 10px;border-radius:3px;margin:-18px 0 5px;box-shadow:0 1px 0 rgba(0,0,0,.15)}
  .pnm{font-weight:800;font-size:13px}.paddr{color:#333;white-space:pre-line}
  table.items{width:100%;border-collapse:collapse;margin-bottom:8px}
  table.items th{background:#26282b;color:#fff;font-size:10px;text-transform:uppercase;letter-spacing:.5px;padding:5.5px 7px;border:1px solid #26282b;border-top:3px solid #F06820}
  table.items td{border:1px solid #d8dbde;padding:4px 7px;font-size:11.5px;vertical-align:top}
  table.items tbody tr:nth-child(even) td{background:#f6f7f8}
  tr.fill td{height:15px;background:#fff !important}
  td.r,th.r{text-align:right} td.c,th.c{text-align:center}
  td .sub{font-size:9.5px;color:#777}
  .rej{color:#b02a2a;font-weight:700}
  .bottom{display:flex;gap:12px;align-items:flex-start;margin-bottom:8px}
  .rem{flex:1.4;border:1px solid #d8dbde;border-left:3px solid #F06820;border-radius:0 9px 9px 0;padding:5px 12px;font-size:11px;line-height:1.45}
  .lbl{font-size:9px;font-weight:800;letter-spacing:1px;color:#F06820;text-transform:uppercase}
  .br{flex:1;display:flex;flex-direction:column;gap:6px}
  table.tot{width:100%;border-collapse:collapse}
  table.tot td{border:1px solid #d8dbde;padding:5px 12px;font-size:12px}
  table.tot td:first-child{color:#555}
  table.tot tr.g td{background:#F06820;color:#fff;font-weight:800;font-size:14.5px;border-color:#F06820}
  .words{border:1px solid #d8dbde;border-left:3px solid #F06820;border-radius:0 9px 9px 0;padding:5px 12px;font-size:11px;line-height:1.45}
  .words b{display:block;margin-top:2px;font-size:11.5px}
  .sign{display:flex;gap:12px;margin-top:26px}
  .sig{flex:1;border-top:1.5px solid #555;padding-top:5px;text-align:center;font-size:10px;font-weight:700;letter-spacing:.5px;color:#333;text-transform:uppercase}
  .strip{display:flex;justify-content:space-between;background:#26282b;color:#fff;font-size:10.5px;padding:6px 14px;border-radius:6px;margin-top:14px}
  .strip b{color:#F58024}
  .note{margin-top:8px;font-size:9.5px;color:#999;text-align:center}
  .cancel{position:fixed;top:40%;left:50%;transform:translate(-50%,-50%) rotate(-24deg);
    font-size:64px;font-weight:900;letter-spacing:8px;color:rgba(176,42,42,.18);
    border:6px solid rgba(176,42,42,.18);border-radius:12px;padding:6px 30px;pointer-events:none}
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
  <div class="title-row"><span class="title">GOODS RECEIPT NOTE</span><span class="copy">Store Copy</span></div>
  <div class="info">${infoCells}</div>
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
  <table class="items"><thead><tr>
    <th class="c">Sl.</th><th>Item Description</th><th class="c">HSN</th><th class="c">Unit</th>
    <th class="r">Ordered</th><th class="r">Received</th><th class="r">Accepted</th><th class="r">Rejected</th>
    <th class="r">Rate (₹)</th><th class="r">Amount (₹)</th>
  </tr></thead><tbody>${rows}${filler}</tbody></table>
  <div class="bottom">
    <div class="rem"><span class="lbl">REMARKS / QC</span>
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
  <div class="sign">
    <div class="sig">Prepared By (Store)</div>
    <div class="sig">Inspected By (QC / Lab)</div>
    <div class="sig">For <b>${esc(co.name)}</b> — Authorised Signatory</div>
  </div>
  <div class="strip"><span>${esc(co.tagline||"Material Science Meets Global Demand")}</span><b>This is a computer generated goods receipt note · ${esc(g.id)}</b></div>
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
  function domesticHtml(o, asPO){
    const kind=asPO?"po":"so", isPO=!!asPO;
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
    const title=isPO?poTitle:(o.status==="Dispatched"?"TAX INVOICE":"PROFORMA / TAX INVOICE");
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
      const lc=GST.calcLine({qty:l.qty,rate:l.rate,discPct:l.discPct||0,gstPct:lineGstPct(l,it)},interState);
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
        `<td class="r">${ENG.num(l.qty,2)}</td><td class="c">${esc(isPO?(l.uom||it.uom||"KG"):(it.uom||"KG"))}</td>`+
        `<td class="r">${IN(l.rate)}</td>`+
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
    const rightParty=isPO
      ? partyBlock("DELIVER TO",co.name,co.address,`<div>GSTIN : <b>${esc(co.gstin||"—")}</b></div>`)
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
  body{font:12px/1.38 "Segoe UI",Arial,sans-serif;color:#1a1c1e;max-width:860px;margin:0 auto;padding:0 20px 20px}
  .band{display:flex;align-items:stretch;gap:0;margin:0 -20px 0;min-height:96px}
  .logo-side{flex:1.05;display:flex;align-items:center;padding:5px 0 5px 16px}
  .logo-side img{width:100%;max-height:92px;object-fit:contain;object-position:left center}
  .co-block{flex:1;background:#26282b;color:#cfd4d8;clip-path:polygon(9% 0,100% 0,100% 100%,0 100%);
    padding:12px 20px 10px 58px;text-align:right;font-size:10.5px;line-height:1.6;display:flex;flex-direction:column;justify-content:center}
  .conm{font-size:14.5px;font-weight:800;color:#F58024;text-transform:uppercase;letter-spacing:.4px}
  .co-ids{margin-top:6px;padding-top:5px;border-top:1px solid rgba(255,255,255,.22);color:#fff;font-weight:600;font-size:10.5px}
  .co-ids span{color:#F58024;font-weight:800}
  .rule{height:3px;background:linear-gradient(90deg,#F06820 0 62%,#26282b 62% 100%);margin:0 -20px 12px}
  .title-row{display:flex;justify-content:space-between;align-items:center;margin:0 0 10px}
  .title{font-size:20px;font-weight:800;letter-spacing:4px;color:#26282b;border-left:6px solid #F06820;padding-left:12px}
  .copy{font-size:9px;font-weight:700;letter-spacing:1px;color:#888;border:1px solid #ccc;border-radius:4px;padding:3px 9px;text-transform:uppercase}
  .info{display:grid;grid-template-columns:repeat(3,1fr);gap:2px 24px;border:1px solid #d8dbde;border-radius:9px;background:#fafbfc;padding:7px 14px;margin-bottom:8px}
  .ip{display:flex;justify-content:space-between;gap:8px;font-size:11px}.ip span{color:#767c82;text-transform:uppercase;font-size:9.5px;font-weight:700;letter-spacing:.3px;padding-top:1px}
  .parties{display:flex;gap:12px;margin-bottom:8px}
  .party{flex:1;border:1px solid #d8dbde;border-top:3px solid #F06820;border-radius:0 0 9px 9px;padding:7px 12px;font-size:11.5px;line-height:1.45}
  .plbl{display:inline-block;background:#F06820;color:#fff;font-size:9px;font-weight:800;letter-spacing:1px;padding:2.5px 10px;border-radius:3px;margin:-18px 0 5px;box-shadow:0 1px 0 rgba(0,0,0,.15)}
  .pnm{font-weight:800;font-size:13px}.paddr{color:#333;white-space:pre-line}
  table.items{width:100%;border-collapse:collapse;margin-bottom:8px}
  table.items th{background:#26282b;color:#fff;font-size:10px;text-transform:uppercase;letter-spacing:.5px;padding:5.5px 7px;border:1px solid #26282b;border-top:3px solid #F06820}
  table.items td{border:1px solid #d8dbde;padding:4px 7px;font-size:11.5px;vertical-align:top}
  table.items tbody tr:nth-child(even) td{background:#f6f7f8}
  tr.fill td{height:15px;background:#fff !important}
  td.r,th.r{text-align:right} td.c,th.c{text-align:center}
  td .sub{font-size:9.5px;color:#777}
  /* The totals column used to leave a tall blank beside the stacked notes.
     The amount in words now sits directly under the grand total it restates,
     which reads better AND balances the two columns onto one page. */
  .bottom{display:flex;gap:12px;align-items:flex-start;margin-bottom:8px}
  .bl{flex:1.4;display:flex;flex-direction:column;gap:6px}
  .br{flex:1;display:flex;flex-direction:column;gap:6px}
  .words,.bank,.notes{border:1px solid #d8dbde;border-left:3px solid #F06820;border-radius:0 9px 9px 0;padding:5px 12px;font-size:11px;line-height:1.45}
  .words b{display:block;margin-top:2px;font-size:11.5px}
  .lbl{font-size:9px;font-weight:800;letter-spacing:1px;color:#F06820;text-transform:uppercase}
  table.tot{width:100%;border-collapse:collapse;height:fit-content}
  table.tot td{border:1px solid #d8dbde;padding:5px 12px;font-size:12px}
  table.tot td:first-child{color:#555}
  table.tot tr:nth-child(even) td{background:#f6f7f8}
  table.tot tr.g td{background:#F06820;color:#fff;font-weight:800;font-size:14.5px;border-color:#F06820}
  .sign{display:flex;justify-content:space-between;align-items:flex-end;margin-top:8px;font-size:10.5px;color:#777}
  .sig{text-align:center;color:#1a1c1e}.sig .ln{border-top:1.5px solid #555;margin-top:24px;padding-top:5px;min-width:210px;font-weight:700}
  .strip{display:flex;justify-content:space-between;background:#26282b;color:#fff;font-size:10.5px;padding:6px 14px;border-radius:6px;margin-top:14px}
  .strip b{color:#F58024}
  .greet{font-size:11.5px;margin:-4px 0 9px;color:#444}
  .note{margin-top:8px;font-size:9.5px;color:#999;text-align:center}
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
    <div class="muted" style="color:#777">${interState?"Inter-state supply — IGST charged.":"Intra-state supply — CGST + SGST charged."}${isPO?"":" Whether tax is payable on reverse charge : No."}</div>
    <div class="sig">For <b>${esc(co.name)}</b><div class="ln">Authorised Signatory</div></div>
  </div>
  </td></tr></tbody></table>
  <div class="pgfoot">
    <div class="strip"><span>${esc(co.tagline||"Material Science Meets Global Demand")}</span><b>${isPO?"Thank you for your partnership!":"Thank you for your business!"}</b></div>
    <div class="strip" style="background:none;color:#888;border:none;padding:2px 12px"><span></span><span>This is a computer generated ${isPO?"purchase order":"invoice"}.</span></div>
  </div>
  <div class="note">Use your browser's "Save as PDF" to download</div>
  <script>window.onload=function(){window.print();}<\/script>
</body></html>`;
    return html;
  }

  /* ---- Export commercial invoice (per the approved sample PDF): IEC code,
     consignee / notify party, bank with SWIFT, shipment grid, currency
     amounts with no GST added, net/gross weight, India-origin certificate. ---- */
  function exportHtml(o){
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
    return `<!doctype html><html><head><meta charset="utf-8"><title>Commercial Invoice ${esc(o.invoiceNo||o.id)}</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  body{font:11.5px/1.5 "Segoe UI",Arial,sans-serif;color:#111;max-width:860px;margin:0 auto;padding:16px 22px}
  .title{text-align:center;font-size:14px;font-weight:800;letter-spacing:.5px;margin-bottom:4px}
  .iec{font-weight:800;font-size:11.5px;margin-bottom:2px}
  table.g{width:100%;border-collapse:collapse}
  table.g td{border:1.2px solid #222;padding:5px 9px;vertical-align:top;font-size:11px;line-height:1.55}
  .conm{font-weight:800;font-size:12.5px}
  .k{font-weight:700}
  table.items{width:100%;border-collapse:collapse}
  table.items th{border:1.2px solid #222;padding:5px 8px;font-size:10.5px;line-height:1.3}
  table.items td{border-left:1.2px solid #222;border-right:1.2px solid #222;padding:4px 8px;font-size:11.5px;vertical-align:top}
  td.r,th.r{text-align:right} .c{text-align:center}
  td .sub{font-size:9.8px;color:#444;font-weight:400}
  td.marks{font-size:11px;width:17%}
  tr.meta td{font-weight:700;padding-top:8px}
  tr.tot td{border:1.2px solid #222;font-weight:800;font-size:12.5px;padding:6px 8px}
  .words{border:1.2px solid #222;border-top:0;padding:6px 10px;font-size:11px}
  .words b{display:block;font-size:11.5px}
  .signrow{display:flex;justify-content:flex-end;margin-top:6px}
  .sig{border:1.2px solid #222;padding:8px 14px 6px;min-width:300px;font-size:11.5px}
  .sig .ln{margin-top:44px;font-weight:700}
  .cert{font-size:10.5px;margin-top:8px}
  .note{margin-top:8px;font-size:9.5px;color:#999;text-align:center}
  @media print{ body{padding:6mm} .note{display:none} }
</style></head><body>
  <div class="title">COMMERCIAL INVOICE</div>
  <div class="iec">I.E.C Code: ${esc(co.iec||"—")}</div>
  <table class="g">
    <tr><td style="width:52%"><span class="conm">${esc(co.name.toUpperCase())}</span><br>${esc(co.address||"")}<br>GSTN/Unique ID: ${esc(co.gstin||"—")}<br>email : ${esc(co.email||"")}</td>
        <td style="width:48%"><span class="k">Invoice No. &amp; Date</span><br>${esc(o.invoiceNo||o.id)} &nbsp; DT.${fmtD(o.date)}<br>
          <span class="k">CUSTOMER PO No. &amp; Date</span><br>${esc(o.custPoNo||"—")}${o.custPoDate?" DT."+fmtD(o.custPoDate):""}<br>
          <span class="k">Other Reference:</span> ${esc(o.otherRef||"")}</td></tr>
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

  // register ⌘K quick actions for Procurement & Sales
  window.ERPActions = Object.assign(window.ERPActions||{}, {
    newPO: { mod:"purchase", create:true, ic:"🛒", label:"New Purchase Order", run:()=>App.go("purchase",{openNew:true}) },
    newSO: { mod:"sales", create:true, ic:"🧾", label:"New Sales Order",    run:()=>App.go("sales",{openNew:true}) },
  });
})();
