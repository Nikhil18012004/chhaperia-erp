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
    let filter={from:"", to:""};
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
      MW.dateRange(filter, draw, {label:"Order Date"}),
      h("div",{style:"margin-left:auto"},h("span",{class:"chip",id:"poCount"}))
    ]));
    const host=h("div"); root.appendChild(host);
    function segBtn(l,k){ const b=h("button",{class:tab===k?"on":"",text:l,onclick:()=>{tab=k;[...seg.children].forEach(c=>c.classList.remove("on"));b.classList.add("on");draw();}}); return b; }
    function draw(){
      let data = tab==="open"?open : tab==="done"?pos.filter(p=>p.status==="Received") : pos;
      data=data.filter(p=>MW.inDateRange(p.date, filter));
      data=data.slice().sort((a,b)=>a.date<b.date?1:-1);
      const c=UI.$("#poCount"); if(c) c.textContent=data.length+" purchase orders";
      host.innerHTML="";
      host.appendChild(table(data,[
        {key:"id",label:"PO #",render:r=>`<span class="mono strong">${r.id}</span>`,sort:r=>r.id},
        {key:"supplier",label:"Supplier",render:r=>esc(U.trim(ENG.sup(r.supplierId),28)),sort:r=>ENG.sup(r.supplierId)},
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
      ],{onRow:r=>poDetail(r),empty:"No purchase orders"}));
    }
    draw();
    // ⌘K "New Purchase Order" lands here with openNew; consume the flag so a
    // later re-render (saveDelta) doesn't reopen the form.
    if(params&&params.openNew){ params.openNew=false; poForm(); }

    /* Receive all pending lines through the granular server endpoint (same
       path as Inventory → Receive via PO), so the receipt logic + GRN posting
       lives in one place on the server instead of being hand-built client-side
       and clobbered via a full-state save. */
    async function receivePO(po){
      if(!await confirm(`Receive all pending items on ${po.id}? Goods will be posted to stock (GRN) at PO rates.`,{title:"Goods Receipt"})) return;
      const wh="WH-PNY", date=DB.helpers.iso(DB.helpers.today());
      const by=(App.user&&App.user.username)||"user";
      const recvLines=[];
      po.lines.forEach((l,i)=>{ const pend=+(l.qty-(l.recd||0)).toFixed(3); if(pend>0){
        recvLines.push({i, qty:pend});
        ENG.data.movements.push({id:U.genMoveId()+"-"+l.itemId, date, itemId:l.itemId, wh, type:"GRN",
          qty:pend, rate:l.rate, ref:po.id, note:"Goods receipt vs PO", supplierId:po.supplierId, by});
        l.recd=+((l.recd||0)+pend).toFixed(3); }});
      if(!recvLines.length){ toast("Nothing pending to receive",{type:"warn"}); return; }
      po.status = po.lines.every(l=>(l.recd||0)>=l.qty-0.0001) ? "Received" : "Partially Received";
      toast(`${po.id} received — stock updated`,{type:"ok",title:"GRN posted"});
      App.saveDelta(()=>DB.purchase.receive(po.id,{wh, date, lines:recvLines}));
    }

    function poDetail(po){
      const {calc, interState}=docCalc("po",po);
      const gstPairs = interState
        ? [["IGST",ENG.money(calc.igst)]]
        : [["CGST",ENG.money(calc.cgst)],["SGST",ENG.money(calc.sgst)]];
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
      ]);
      const anyRecd=po.lines.some(l=>(l.recd||0)>0);
      const foot=[h("button",{class:"btn danger",onclick:()=>deletePO(po),text:"🗑 Delete"}),
        h("button",{class:"btn",onclick:()=>printDoc("po",po),html:PRINT_IC+" Print"})];
      if(!anyRecd) foot.push(h("button",{class:"btn ghost",onclick:()=>{UI.$("#modalHost").hidden=true;poForm(po);},text:"✎ Edit"}));
      if(po.status!=="Received") foot.push(h("button",{class:"btn primary",onclick:()=>{UI.$("#modalHost").hidden=true;receivePO(po);},text:"Receive Goods"}));
      modal({title:po.id, sub:ENG.sup(po.supplierId), wide:true, body, foot});
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
          {key:"item",label:"Item",render:r=>`<div class="cell-main">${esc(r.it.name)}</div><div class="cell-sub">${r.it.id} · ${ENG.sup(r.it.supplierId)}</div>`,noSort:true},
          {key:"onHand",label:"On Hand",num:true,render:r=>ENG.num(r.st.onHand,1),noSort:true},
          {key:"reorder",label:"Reorder Pt",num:true,render:r=>ENG.num(r.it.reorder),noSort:true},
          {key:"suggest",label:"Suggested",num:true,render:r=>`<span class="strong" style="color:var(--accent)">${ENG.num(r.st.suggest)} ${r.it.uom}</span>`,noSort:true},
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
      const body=h("div",{},[
        h("div",{class:"form-grid"},[
          U.field("Billing Company (invoice under) *",U.selectHTML("po_co",companyOpts(),editPo?editPo.company:companies()[0].key)),
          U.field("Supplier",U.searchSelect("po_sup",sups.map(s=>({v:s.id,l:s.name})),editPo?editPo.supplierId:(sups[0]&&sups[0].id),"Search supplier…")),
          U.field("PO Date",`<input class="input" id="po_date" type="date" value="${editPo?(editPo.date||""):DB.helpers.iso(DB.helpers.today())}">`),
          U.field("Expected ETA",`<input class="input" id="po_eta" type="date" value="${editPo?editPo.eta:DB.helpers.daysAhead(14)}">`),
          U.field("Ref / Quotation No.",`<input class="input" id="po_ref" value="${esc(editPo?(editPo.refNo||""):"")}" placeholder="optional">`),
        ]),
        h("h3",{style:"margin:16px 0 8px;font-size:13px",text:"Lines"}),
        lineHead(false),
        h("div",{id:"po_lines"}),
        h("button",{class:"btn sm",style:"margin-top:8px",onclick:()=>addLine(),html:"＋ Add line"}),
        h("div",{class:"flex",style:"justify-content:flex-end;margin-top:14px"},totBox),
      ]);
      const mo=modal({title:editPo?("Edit "+editPo.id):"New Purchase Order", sub:editPo?"Update this purchase order":"Raise a PO to a supplier", wide:true, body,
        foot:[h("button",{class:"btn ghost",onclick:()=>mo.close(),text:"Cancel"}),
          h("button",{class:"btn",onclick:printDraft,html:PRINT_IC+" Print"}),
          h("button",{class:"btn primary",onclick:save,text:editPo?"Save Changes":"Create PO"})]});
      body.addEventListener("input",recalc);
      body.addEventListener("change",recalc);
      function collect(){ const out=[];
        lines.forEach((_,i)=>{ if(!lines[i]) return; const iEl=UI.$("#pl_item_"+i); if(!iEl) return;
          const id=iEl.value, qty=+UI.$("#pl_qty_"+i).value, rate=+UI.$("#pl_rate_"+i).value;
          if(id&&qty>0) out.push({itemId:id, qty, rate:rate||ENG.item(id).cost, recd:0,
            hsn:(UI.$("#pl_hsn_"+i).value||"").trim(),
            discPct:+UI.$("#pl_disc_"+i).value||0, gstPct:+UI.$("#pl_gst_"+i).value||0}); });
        return out; }
      function draft(){
        const out=collect();
        const o={ id:editPo?editPo.id:U.nextSeqId(ENG.data.purchaseorders,"PO-"),
          date:UI.$("#po_date").value||DB.helpers.iso(DB.helpers.today()),
          supplierId:UI.$("#po_sup").value, company:UI.$("#po_co").value,
          refNo:UI.$("#po_ref").value.trim(), lines:out,
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
      function addLine(seed){
        const rms=ENG.data.items.filter(i=>i.cat!=="FG");
        const idx=lines.length; lines.push({});
        const itemId=seed?(seed.itemId||seed):(rms[0]&&rms[0].id);
        const it=ENG.item(itemId)||{};
        const qtyVal=(seed&&seed.qty!=null)?seed.qty:(typeof seed==="string"?ENG.status(seed).suggest:"");
        const rateVal=(seed&&seed.rate!=null)?seed.rate:(typeof seed==="string"?ENG.item(seed).cost:"");
        const row=h("div",{class:"inv-line",style:LINE_GRID(false)},[
          h("div",{html:U.searchSelect("pl_item_"+idx,rms.map(i=>({v:i.id,l:i.id+" — "+i.name})),itemId,"Search material…")}),
          h("input",{class:"input",id:"pl_hsn_"+idx,placeholder:"HSN",value:(seed&&seed.hsn)||it.hsn||""}),
          h("input",{class:"input",id:"pl_qty_"+idx,type:"number",placeholder:"Qty",value:qtyVal}),
          h("input",{class:"input",id:"pl_rate_"+idx,type:"number",placeholder:"Rate",value:rateVal}),
          h("input",{class:"input",id:"pl_disc_"+idx,type:"number",placeholder:"0",value:(seed&&seed.discPct)||""}),
          h("input",{class:"input",id:"pl_gst_"+idx,type:"number",placeholder:"18",value:(seed&&seed.gstPct!=null)?seed.gstPct:lineGstPct(seed,it)}),
          h("button",{class:"btn sm ghost",title:"Remove line",onclick:e=>{e.preventDefault();e.target.closest(".inv-line").remove();lines[idx]=null;recalc();},text:"✕"})
        ]);
        UI.$("#po_lines").appendChild(row);
        // picking a material refreshes its HSN + GST defaults
        const hid=UI.$("#pl_item_"+idx);
        if(hid) hid.addEventListener("change",()=>{ const ni=ENG.item(hid.value)||{};
          UI.$("#pl_hsn_"+idx).value=ni.hsn||""; UI.$("#pl_gst_"+idx).value=lineGstPct(null,ni);
          if(!UI.$("#pl_rate_"+idx).value) UI.$("#pl_rate_"+idx).value=ni.cost||""; recalc(); });
      }
      if(editPo) editPo.lines.forEach(l=>addLine(l)); else addLine(presetItem);
      recalc();
      function save(){
        const o=draft();
        if(!o.lines.length){ toast("Add at least one line with qty",{type:"warn"}); return; }
        if(editPo){
          Object.assign(editPo,{supplierId:o.supplierId, company:o.company, refNo:o.refNo, date:o.date,
            eta:o.eta, lines:o.lines, freight:o.freight, value:o.value, status:"Open"});
          mo.close(); toast(editPo.id+" updated",{type:"ok"});
          App.saveDelta(()=>DB.purchase.update(editPo.id,{supplierId:o.supplierId, company:o.company, refNo:o.refNo,
            date:o.date, eta:o.eta, lines:o.lines, freight:o.freight, value:o.value, status:"Open"}));
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
  function LINE_GRID(withBatch){
    return "display:grid;gap:6px;margin-bottom:8px;align-items:center;grid-template-columns:"+
      (withBatch?"2fr .9fr .9fr .7fr .8fr .6fr .6fr 30px":"2fr .9fr .7fr .8fr .6fr .6fr 30px");
  }
  function lineHead(withBatch){
    const lab=t=>h("div",{class:"muted",style:"font-size:10.5px;font-weight:700;text-transform:uppercase",text:t});
    const cols=withBatch
      ? ["Item","HSN","Batch (WO)","Qty","Rate (₹)","Disc %","GST %",""]
      : ["Item","HSN","Qty","Rate (₹)","Disc %","GST %",""];
    return h("div",{style:LINE_GRID(withBatch)+";margin-bottom:4px"},cols.map(lab));
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
    let filter={from:"", to:""};
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
      MW.dateRange(filter, draw, {label:"Order Date"}),
      h("div",{style:"margin-left:auto"},h("span",{class:"chip",id:"soCount"}))
    ]));
    const host=h("div"); root.appendChild(host);
    function segBtn(l,k){ const b=h("button",{class:tab===k?"on":"",text:l,onclick:()=>{tab=k;[...seg.children].forEach(c=>c.classList.remove("on"));b.classList.add("on");draw();}}); return b; }
    function draw(){
      let data = tab==="open"?open : tab==="done"?sos.filter(s=>s.status==="Dispatched") : sos;
      data=data.filter(s=>MW.inDateRange(s.date, filter));
      data=data.slice().sort((a,b)=>a.date<b.date?1:-1);
      const c=UI.$("#soCount"); if(c) c.textContent=data.length+" sales orders";
      host.innerHTML="";
      host.appendChild(table(data,[
        {key:"id",label:"SO #",render:r=>`<span class="mono strong">${r.id}</span>`,sort:r=>r.id},
        {key:"cust",label:"Customer",render:r=>esc(U.trim(ENG.custName(r.customerId),26)),sort:r=>ENG.custName(r.customerId)},
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
      ],{onRow:r=>soDetail(r),empty:"No sales orders"}));
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
        {key:"item",label:"Item",render:r=>{const it=ENG.item(r.itemId)||{};return `<div class="cell-main">${esc(U.trim(it.name||r.itemId,30))}</div><div class="cell-sub">${r.itemId} · ${r.width||"-"}mm</div>`;},noSort:true}];
      if(anyBatch) cols.push({key:"batch",label:"Batch No.",render:r=>r.batch?`<span class="mono">${esc(r.batch)}</span>`:'<span class="muted">—</span>',noSort:true});
      cols.push(
        {key:"qty",label:"Qty",num:true,render:r=>ENG.num(r.qty)+" kg",noSort:true},
        {key:"stock",label:"In Stock",num:true,render:r=>{const h2=ENG.stock(r.itemId).onHand;return `<span style="color:${h2>=r.qty?'var(--ok)':'var(--danger)'}">${ENG.num(h2,1)}</span>`;},noSort:true},
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
      const sec=t=>h("h3",{style:"margin:16px 0 8px;font-size:13px;color:var(--accent)",text:t});
      const body=h("div",{},[
        sec("Parties"),
        h("div",{class:"form-grid"},[
          U.field("Billing Company (invoice under) *",U.selectHTML("so_co",companyOpts(),editSo?editSo.company:companies()[0].key)),
          U.field("Customer (Bill To)",U.searchSelect("so_cust",custs.map(c=>({v:c.id,l:c.name})),editSo?editSo.customerId:(cust0&&cust0.id),"Search customer…")),
          U.field("Place of Supply",U.selectHTML("so_pos",stateOpts(),
            (editSo&&editSo.placeOfSupply)||partyStateCode(cust0)||"29")),
          U.field("Ship To (delivery address)",`<textarea class="input" id="so_ship" rows="2" placeholder="same as billing">${esc(editSo?(editSo.shipTo||""):(cust0&&(cust0.shipTo||cust0.address)||""))}</textarea>`,"full"),
        ]),
        sec("Invoice Details"),
        h("div",{class:"form-grid"},[
          U.field("Invoice No.",`<input class="input" id="so_inv" value="${esc(editSo?(editSo.invoiceNo||editSo.id):soId)}">`),
          U.field("Order Date",`<input class="input" id="so_date" type="date" value="${editSo?(editSo.date||""):DB.helpers.iso(DB.helpers.today())}">`),
          U.field("Promised / Due Date",`<input class="input" id="so_prom" type="date" value="${editSo?editSo.promised:DB.helpers.daysAhead(10)}">`),
          U.field("Priority",U.selectHTML("so_prio",[{v:"Normal",l:"Normal"},{v:"High",l:"High"},{v:"Urgent",l:"Urgent"}],editSo?editSo.priority:"Normal")),
          U.field("Customer PO No.",`<input class="input" id="so_cpo" value="${esc(editSo?(editSo.custPoNo||""):"")}" placeholder="optional">`),
          U.field("Customer PO Date",`<input class="input" id="so_cpod" type="date" value="${editSo?(editSo.custPoDate||""):""}">`),
        ]),
        sec("Transport & Dispatch"),
        h("div",{class:"form-grid"},[
          U.field("Transport Mode",U.selectHTML("so_tmode",TRANSPORT_MODES,editSo?(editSo.transportMode||""):"")),
          U.field("Transporter",U.selectHTML("so_transp",[{v:"",l:"—"}].concat((ENG.data.transporters||[]).filter(t=>t.active!==false).map(t=>({v:t.id,l:t.name}))),editSo?(editSo.transporterId||""):"")),
          U.field("Vehicle No.",`<input class="input" id="so_veh" value="${esc(editSo?(editSo.vehicleNo||""):"")}" placeholder="e.g. KA 52 AB 1234">`),
          U.field("E-Way Bill No.",`<input class="input" id="so_eway" value="${esc(editSo?(editSo.ewayBill||""):"")}" placeholder="optional">`),
          U.field("LR / RR No.",`<input class="input" id="so_lr" value="${esc(editSo?(editSo.lrNo||""):"")}" placeholder="optional">`),
          U.field("Dispatch Date",`<input class="input" id="so_ddate" type="date" value="${esc(editSo?(editSo.dispatchDate||""):"")}">`),
        ]),
        sec("Lines"),
        lineHead(true),
        h("div",{id:"so_lines"}),
        h("button",{class:"btn sm",style:"margin-top:8px",onclick:()=>addLine(),html:"＋ Add line"}),
        h("div",{class:"form-grid",style:"margin-top:14px"},[
          U.field("Payment Terms",`<input class="input" id="so_terms" value="${esc(editSo?(editSo.payTerms||""):(cust0&&cust0.terms||"30 days"))}">`),
          U.field("Notes",`<input class="input" id="so_notes" value="${esc(editSo?(editSo.notes||""):"")}" placeholder="shown on the invoice">`),
        ]),
        h("div",{class:"flex",style:"justify-content:flex-end;margin-top:10px"},totBox),
      ]);
      const mo=modal({title:editSo?("Edit "+editSo.id):"New Sales Order", sub:editSo?"Update this sales order":"Everything here flows straight onto the tax invoice", wide:true, body,
        foot:[h("button",{class:"btn ghost",onclick:()=>mo.close(),text:"Cancel"}),
          h("button",{class:"btn",onclick:printDraft,html:PRINT_IC+" Print"}),
          h("button",{class:"btn primary",onclick:save,text:editSo?"Save Changes":"Create Order"})]});
      body.addEventListener("input",recalc);
      body.addEventListener("change",recalc);
      // customer switch refreshes place of supply, ship-to + payment terms
      const custHid=UI.$("#so_cust");
      if(custHid) custHid.addEventListener("change",()=>{
        const c=custs.find(x=>x.id===custHid.value); if(!c) return;
        const posEl=UI.$("#so_pos"); const sc=partyStateCode(c); if(posEl&&sc) posEl.value=sc;
        const shipEl=UI.$("#so_ship"); if(shipEl) shipEl.value=c.shipTo||c.address||"";
        const tEl=UI.$("#so_terms"); if(tEl&&c.terms) tEl.value=c.terms;
        recalc();
      });
      function batchOpts(itemId){
        const wos=(ENG.data.workorders||[]).filter(w=>w.itemId===itemId)
          .slice().sort((a,b)=>a.id<b.id?1:-1);
        return [{v:"",l:"—"}].concat(wos.map(w=>({v:w.id,l:w.id})));
      }
      function collect(){ const out=[];
        lines.forEach((_,i)=>{ if(!lines[i]) return; const iEl=UI.$("#sl_item_"+i); if(!iEl) return;
          const id=iEl.value, qty=+UI.$("#sl_qty_"+i).value, rate=+UI.$("#sl_rate_"+i).value;
          if(id&&qty>0) out.push({itemId:id, qty, rate:rate||ENG.item(id).price, width:(ENG.item(id).widthMM||[25])[0],
            hsn:(UI.$("#sl_hsn_"+i).value||"").trim(), batch:UI.$("#sl_batch_"+i).value||"",
            discPct:+UI.$("#sl_disc_"+i).value||0, gstPct:+UI.$("#sl_gst_"+i).value||0}); });
        return out; }
      function draft(){
        const o={ id:soId, date:UI.$("#so_date").value||DB.helpers.iso(DB.helpers.today()),
          customerId:UI.$("#so_cust").value, company:UI.$("#so_co").value,
          invoiceNo:UI.$("#so_inv").value.trim()||soId,
          placeOfSupply:UI.$("#so_pos").value, shipTo:UI.$("#so_ship").value.trim(),
          custPoNo:UI.$("#so_cpo").value.trim(), custPoDate:UI.$("#so_cpod").value,
          transportMode:UI.$("#so_tmode").value, transporterId:UI.$("#so_transp").value,
          vehicleNo:UI.$("#so_veh").value.trim(), ewayBill:UI.$("#so_eway").value.trim(),
          lrNo:UI.$("#so_lr").value.trim(), dispatchDate:UI.$("#so_ddate").value,
          payTerms:UI.$("#so_terms").value.trim(), notes:UI.$("#so_notes").value.trim(),
          lines:collect(),
          freight:+(UI.$("#so_fr")&&UI.$("#so_fr").value)||0,
          insurance:+(UI.$("#so_ins")&&UI.$("#so_ins").value)||0,
          status:editSo?editSo.status:"Confirmed",
          promised:UI.$("#so_prom").value, priority:UI.$("#so_prio").value };
        o.value=docCalc("so",o).calc.grandTotal;
        return o;
      }
      function recalc(){
        const o=draft();
        renderTotals(totBox, docCalc("so",o),
          {freightId:"so_fr", freight:o.freight, insuranceId:"so_ins", insurance:o.insurance});
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
        const row=h("div",{class:"inv-line",style:LINE_GRID(true)},[
          h("div",{html:U.searchSelect("sl_item_"+idx,fgs.map(i=>({v:i.id,l:i.name+(i.thicknessMM!=null?" · "+i.thicknessMM+" mm":"")+" — "+(i.typeCode||i.id)})),itemId,"Search product…")}),
          h("input",{class:"input",id:"sl_hsn_"+idx,placeholder:"HSN",value:(seed&&seed.hsn)||it.hsn||""}),
          h("div",{html:U.selectHTML("sl_batch_"+idx,batchOpts(itemId),(seed&&seed.batch)||"")}),
          h("input",{class:"input",id:"sl_qty_"+idx,type:"number",placeholder:"Qty (kg)",value:qtyVal}),
          h("input",{class:"input",id:"sl_rate_"+idx,type:"number",placeholder:"Rate",value:rateVal}),
          h("input",{class:"input",id:"sl_disc_"+idx,type:"number",placeholder:"0",value:(seed&&seed.discPct)||""}),
          h("input",{class:"input",id:"sl_gst_"+idx,type:"number",placeholder:"18",value:(seed&&seed.gstPct!=null)?seed.gstPct:lineGstPct(seed,it)}),
          h("button",{class:"btn sm ghost",title:"Remove line",onclick:e=>{e.preventDefault();e.target.closest(".inv-line").remove();lines[idx]=null;recalc();},text:"✕"})
        ]);
        UI.$("#so_lines").appendChild(row);
        // picking a product refreshes HSN, GST, rate default + its batch (WO) list
        const hid=UI.$("#sl_item_"+idx);
        if(hid) hid.addEventListener("change",()=>{ const ni=ENG.item(hid.value)||{};
          UI.$("#sl_hsn_"+idx).value=ni.hsn||""; UI.$("#sl_gst_"+idx).value=lineGstPct(null,ni);
          if(!UI.$("#sl_rate_"+idx).value) UI.$("#sl_rate_"+idx).value=ni.price||"";
          const bSel=UI.$("#sl_batch_"+idx);
          if(bSel){ bSel.innerHTML=batchOpts(hid.value).map(o=>`<option value="${esc(o.v)}">${esc(o.l)}</option>`).join(""); }
          recalc(); });
      }
      if(editSo) editSo.lines.forEach(l=>addLine(l)); else addLine();
      recalc();
      function save(){
        const o=draft();
        if(!o.lines.length){ toast("Add at least one line",{type:"warn"}); return; }
        if(editSo){
          const patch={customerId:o.customerId, company:o.company, invoiceNo:o.invoiceNo,
            placeOfSupply:o.placeOfSupply, shipTo:o.shipTo, custPoNo:o.custPoNo, custPoDate:o.custPoDate,
            transportMode:o.transportMode, transporterId:o.transporterId, vehicleNo:o.vehicleNo,
            ewayBill:o.ewayBill, lrNo:o.lrNo, dispatchDate:o.dispatchDate, payTerms:o.payTerms,
            notes:o.notes, priority:o.priority, promised:o.promised, date:o.date,
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
      h("button",{class:"btn primary",onclick:()=>supplierForm(),html:"＋ New Supplier"})
    ]));
    const spend=ENG.purchaseBySupplier(365);
    const spendMap={}; spend.forEach(s=>spendMap[s.id]=s.value);
    const grid=h("div",{class:"grid cols-2"});
    ENG.data.suppliers.forEach(s=>{
      const items=ENG.data.items.filter(i=>i.supplierId===s.id);
      grid.appendChild(h("div",{class:"card hover"},[
        h("div",{class:"flex between aic"},[
          h("div",{},[h("h3",{style:"font-size:15px",text:s.name}),h("div",{class:"muted",style:"font-size:12px",text:[s.city,s.country].filter(Boolean).join(", ")+" · "+(s.category||"General")})]),
          h("div",{class:"avatar",style:"background:linear-gradient(135deg,var(--c"+((ENG.data.suppliers.indexOf(s)%8)+1)+"),var(--accent-600))",text:s.name.slice(0,2).toUpperCase()})
        ]),
        h("div",{class:"grid cols-3",style:"margin:14px 0;gap:8px"},[
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
          h("button",{class:"btn sm ghost",onclick:()=>supplierForm(s),text:"✎ Edit"}),
          h("button",{class:"btn sm danger",onclick:()=>deleteSupplier(s),text:"🗑 Delete"}),
        ])
      ]));
    });
    root.appendChild(grid);

    async function deleteSupplier(s){
      if(!await confirm(`Delete supplier ${s.name}? This cannot be undone.`,{title:"Delete Supplier",danger:true})) return;
      try{
        await DB.suppliers.remove(s.id);   // server refuses while POs/items still reference it
        ENG.data.suppliers=ENG.data.suppliers.filter(x=>x.id!==s.id);
        toast(s.name+" deleted",{type:"ok",title:"Removed"});
        App.saveDelta(()=>Promise.resolve());
      }catch(e){ toast(e.message,{type:"danger",title:"Cannot delete"}); }
    }
  }};

  /* ============== CUSTOMERS ============== */
  M.customers = { title:"Customers", sub:"Client master & orders", render(root){
    root.appendChild(pageHead("Customers","HT cable manufacturers and order history",[
      h("button",{class:"btn primary",onclick:()=>customerForm(),html:"＋ New Customer"})
    ]));
    const grid=h("div",{class:"grid cols-2"});
    ENG.data.customers.forEach(c=>{
      const orders=ENG.data.salesorders.filter(s=>s.customerId===c.id);
      const total=orders.reduce((s,o)=>s+o.value,0);
      const open=orders.filter(o=>o.status!=="Dispatched").length;
      grid.appendChild(h("div",{class:"card hover"},[
        h("div",{class:"flex between aic"},[
          h("div",{},[h("h3",{style:"font-size:15px",text:c.name}),h("div",{class:"muted",style:"font-size:12px",text:[c.city,c.segment].filter(Boolean).join(" · ")})]),
          h("span",{html:badge(c.rating==="A"?"ok":c.rating==="B"?"warn":"mut","Grade "+c.rating)})
        ]),
        h("div",{class:"grid cols-3",style:"margin:14px 0;gap:8px"},[
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
          h("button",{class:"btn sm ghost",onclick:()=>customerForm(c),text:"✎ Edit"}),
          h("button",{class:"btn sm danger",onclick:()=>deleteCustomer(c),text:"🗑 Delete"}),
        ])
      ]));
    });
    root.appendChild(grid);

    async function deleteCustomer(c){
      if(!await confirm(`Delete customer ${c.name}? This cannot be undone.`,{title:"Delete Customer",danger:true})) return;
      try{
        await DB.customers.remove(c.id);   // server refuses while SOs/leads still reference it
        ENG.data.customers=ENG.data.customers.filter(x=>x.id!==c.id);
        toast(c.name+" deleted",{type:"ok",title:"Removed"});
        App.saveDelta(()=>Promise.resolve());
      }catch(e){ toast(e.message,{type:"danger",title:"Cannot delete"}); }
    }
  }};

  function stat(label,val){ return h("div",{},[h("div",{class:"muted",style:"font-size:10.5px;font-weight:700;text-transform:uppercase",text:label}),h("div",{style:"font-weight:700;font-size:15px;margin-top:2px",text:val})]); }

  /* ----- Supplier / Customer forms (create + edit) -----
     Carry every field the tax invoice needs: GSTIN, state (auto-
     derived from the GSTIN prefix), full address, ship-to. */
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
      foot:[h("button",{class:"btn ghost",onclick:()=>mo.close(),text:"Cancel"}),
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
      foot:[h("button",{class:"btn ghost",onclick:()=>mo.close(),text:"Cancel"}),
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
     with tagline, GSTIN/CIN/PAN strip, Bill To / Ship To, HSN
     item table with per-line GST, CGST/SGST/IGST summary, amount
     in words, bank details, terms and signatory. Work-order
     traceability appears ONLY as "Batch No." here.
     ============================================================ */
  const IN=v=>(+v||0).toLocaleString("en-IN",{minimumFractionDigits:2,maximumFractionDigits:2});
  function printDoc(kind, o){
    const isPO=kind==="po";
    const dc=docCalc(kind,o);
    const {co, party, calc, interState, pos}=dc;
    const p=party||{name:isPO?o.supplierId:o.customerId};
    const partyCode=partyStateCode(p);
    const anyBatch=!isPO&&(o.lines||[]).some(l=>l.batch);
    const anyDisc=(o.lines||[]).some(l=>l.discPct>0);
    const uniformPct=[...new Set(gstLinesOf(o).map(l=>l.gstPct))];
    const pctSuffix=uniformPct.length===1?` @ ${uniformPct[0]/(interState?1:2)}%`:"";
    const igstSuffix=uniformPct.length===1?` @ ${uniformPct[0]}%`:"";
    const title=isPO?"PURCHASE ORDER":(o.status==="Dispatched"?"TAX INVOICE":"PROFORMA / TAX INVOICE");
    const logo=location.origin+"/assets/logo-tagline.jpeg";
    const bank=co.bank||{};
    const hasBank=bank.name||bank.acNo||bank.ifsc;
    const terms=(co.terms&&co.terms.length)?co.terms:[
      "Goods once sold will not be taken back or exchanged.",
      "Interest @ 18% p.a. will be charged on delayed payments.",
      "All payments by A/c Payee Cheque / DD / NEFT / RTGS only.",
      "Subject to Bangalore Jurisdiction.",
    ];

    const rows=(o.lines||[]).map((l,i)=>{ const it=ENG.item(l.itemId)||{};
      const lc=GST.calcLine({qty:l.qty,rate:l.rate,discPct:l.discPct||0,gstPct:lineGstPct(l,it)},interState);
      return `<tr><td class="c">${i+1}</td>`+
        `<td>${esc(it.name||l.itemId)}<div class="sub">${esc(l.itemId)}${it.thicknessMM!=null?" · "+it.thicknessMM+" mm":""}</div></td>`+
        `<td class="c">${esc(l.hsn||it.hsn||"—")}</td>`+
        (anyBatch?`<td class="c">${esc(l.batch||"—")}</td>`:"")+
        `<td class="r">${ENG.num(l.qty,2)}</td><td class="c">${esc(isPO?(it.uom||"KG"):"KG")}</td>`+
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
      ["PO No.",o.id],["PO Date",o.date||"—"],["Expected Delivery",o.eta||"—"],
      ["Ref / Quotation",o.refNo||"—"],["Status",o.status||""],["Place of Supply",(co.stateCode||"")+" — "+(GST.stateName(co.stateCode)||"")],
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

    const colCount=7+(anyBatch?1:0)+(anyDisc?1:0);
    const html=`<!doctype html><html><head><meta charset="utf-8"><title>${title} ${esc(o.invoiceNo||o.id)}</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font:12px/1.45 "Segoe UI",Arial,sans-serif;color:#111;max-width:860px;margin:0 auto;padding:20px}
  .band{display:flex;justify-content:space-between;align-items:center;gap:18px;border-bottom:3px solid #F06820;padding-bottom:10px}
  .band img{max-height:74px;max-width:390px;object-fit:contain}
  .co-i{text-align:right;font-size:11px;color:#333;line-height:1.55}
  .co-i .conm{font-size:15px;font-weight:800;color:#F06820;text-transform:uppercase}
  .ids{display:flex;justify-content:center;gap:26px;font-size:11.5px;padding:6px 0;border-bottom:1.5px solid #222;font-weight:600}
  .title{text-align:center;font-size:19px;font-weight:800;letter-spacing:3px;color:#F06820;margin:10px 0 8px}
  .info{display:grid;grid-template-columns:repeat(3,1fr);gap:4px 22px;border:1px solid #ccc;border-radius:8px;padding:9px 12px;margin-bottom:10px}
  .ip{display:flex;justify-content:space-between;gap:8px;font-size:11.5px}.ip span{color:#666}
  .parties{display:flex;gap:12px;margin-bottom:10px}
  .party{flex:1;border:1px solid #ccc;border-radius:8px;padding:9px 12px;font-size:11.5px;line-height:1.55}
  .plbl{font-size:10px;font-weight:800;letter-spacing:.8px;color:#F06820;border-bottom:1px solid #eee;padding-bottom:3px;margin-bottom:5px}
  .pnm{font-weight:800;font-size:13px}.paddr{color:#333;white-space:pre-line}
  table.items{width:100%;border-collapse:collapse;margin-bottom:10px}
  table.items th{background:#26282b;color:#fff;font-size:10.5px;text-transform:uppercase;letter-spacing:.4px;padding:6px 7px;border:1px solid #26282b}
  table.items td{border:1px solid #ccc;padding:5.5px 7px;font-size:11.5px;vertical-align:top}
  td.r,th.r{text-align:right} td.c,th.c{text-align:center}
  td .sub{font-size:9.5px;color:#777}
  .bottom{display:flex;gap:12px;align-items:stretch;margin-bottom:10px}
  .bl{flex:1.4;display:flex;flex-direction:column;gap:8px}
  .words,.bank,.notes{border:1px solid #ccc;border-radius:8px;padding:8px 12px;font-size:11.5px}
  .words b{display:block;margin-top:2px}
  .lbl{font-size:10px;font-weight:800;letter-spacing:.8px;color:#F06820}
  table.tot{flex:1;border-collapse:collapse;height:fit-content}
  table.tot td{border:1px solid #ccc;padding:6px 10px;font-size:12px}
  table.tot tr.g td{background:#F06820;color:#fff;font-weight:800;font-size:14px}
  .sign{display:flex;justify-content:space-between;align-items:flex-end;margin-top:14px;font-size:11.5px}
  .sig{text-align:center}.sig .ln{border-top:1px solid #555;margin-top:52px;padding-top:4px;min-width:200px;font-weight:700}
  .strip{display:flex;justify-content:space-between;background:#26282b;color:#fff;font-size:10.5px;padding:5px 12px;border-radius:6px;margin-top:14px}
  .strip b{color:#F58024}
  .note{margin-top:8px;font-size:9.5px;color:#999;text-align:center}
  @media print{ body{padding:6mm} .note{display:none} }
</style></head><body>
  <div class="band">
    <img src="${logo}" alt="${esc(co.name)}">
    <div class="co-i">
      <div class="conm">${esc(co.name)}</div>
      <div>${esc(co.address||"")}</div>
      <div>${esc([co.phone,co.email,co.website].filter(Boolean).join(" · "))}</div>
    </div>
  </div>
  <div class="ids">
    <span>GSTIN : <b>${esc(co.gstin||"—")}</b></span>
    ${co.cin?`<span>CIN : <b>${esc(co.cin)}</b></span>`:""}
    ${co.pan?`<span>PAN : <b>${esc(co.pan)}</b></span>`:""}
  </div>
  <div class="title">${title}</div>
  <div class="info">${infoCells}</div>
  <div class="parties">${leftParty}${rightParty}</div>
  <table class="items"><thead><tr>
    <th class="c">Sl.</th><th>Description of Goods</th><th class="c">HSN / SAC</th>
    ${anyBatch?'<th class="c">Batch No.</th>':""}
    <th class="r">Qty</th><th class="c">Unit</th><th class="r">Rate (₹)</th>
    ${anyDisc?'<th class="r">Disc.</th>':""}
    <th class="r">GST %</th><th class="r">Amount (₹)</th>
  </tr></thead><tbody>${rows}</tbody></table>
  <div class="bottom">
    <div class="bl">
      <div class="words"><span class="lbl">AMOUNT IN WORDS</span><b>${esc(GST.amountInWords(calc.grandTotal))}</b></div>
      ${hasBank?`<div class="bank"><span class="lbl">BANK DETAILS</span>
        ${bank.name?`<div>Bank : <b>${esc(bank.name)}</b>${bank.branch?" · "+esc(bank.branch):""}</div>`:""}
        ${bank.acName?`<div>A/c Name : ${esc(bank.acName)}</div>`:""}
        ${bank.acNo?`<div>A/c No : <b>${esc(bank.acNo)}</b></div>`:""}
        ${bank.ifsc?`<div>IFSC : <b>${esc(bank.ifsc)}</b></div>`:""}
        ${bank.upi?`<div>UPI : ${esc(bank.upi)}</div>`:""}</div>`:""}
      <div class="notes"><span class="lbl">${isPO?"NOTES / INSTRUCTIONS":"TERMS & CONDITIONS"}</span>
        ${o.notes?`<div>${esc(o.notes)}</div>`:""}
        ${isPO?`<div>Please confirm acceptance, quote ${esc(o.id)} on all documents and share the e-invoice / delivery schedule.</div>
                <div>Payment terms : ${esc(p.terms||"as agreed")}.</div>`
             :terms.map((t,i)=>`<div>${i+1}. ${esc(t)}</div>`).join("")}
      </div>
    </div>
    <table class="tot"><tbody>
      ${totalsRows}
      <tr class="g"><td>GRAND TOTAL (₹)</td><td class="r">${IN(calc.grandTotal)}</td></tr>
    </tbody></table>
  </div>
  <div class="sign">
    <div class="muted" style="color:#777">${interState?"Inter-state supply — IGST charged.":"Intra-state supply — CGST + SGST charged."}${isPO?"":" Whether tax is payable on reverse charge : No."}</div>
    <div class="sig">For <b>${esc(co.name)}</b><div class="ln">Authorised Signatory</div></div>
  </div>
  <div class="strip"><span>${esc(co.tagline||"Material Science Meets Global Demand")}</span><b>${isPO?"Thank you for your partnership!":"Thank you for your business!"}</b></div>
  <div class="strip" style="background:none;color:#888;border:none;padding:2px 12px"><span></span><span>This is a computer generated ${isPO?"purchase order":"invoice"}.</span></div>
  <div class="note">Use your browser's "Save as PDF" to download</div>
  <script>window.onload=function(){window.print();}<\/script>
</body></html>`;
    const w=window.open("","_blank");
    if(!w){ toast("Popup blocked — allow popups for this site to print",{type:"warn"}); return; }
    w.document.write(html); w.document.close();
  }
  const PRINT_IC='<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1.5px" aria-hidden="true"><path d="M6 9V3h12v6"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="15" width="12" height="7" rx="1"/></svg>';
  function printBtn(kind,r){ return h("button",{class:"btn sm ghost",title:(kind==="po"?"Print / download PO":"Print / download invoice"),
    onclick:e=>{e.stopPropagation();printDoc(kind,r);},html:PRINT_IC}); }

  // register ⌘K quick actions for Procurement & Sales
  window.ERPActions = Object.assign(window.ERPActions||{}, {
    newPO: { ic:"🛒", label:"New Purchase Order", run:()=>App.go("purchase",{openNew:true}) },
    newSO: { ic:"🧾", label:"New Sales Order",    run:()=>App.go("sales",{openNew:true}) },
  });
})();
