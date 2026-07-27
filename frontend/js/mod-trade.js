/* ============================================================
   CHHAPERIA ERP — PROCUREMENT, SALES, SUPPLIERS, CUSTOMERS
   ============================================================ */
(function () {
  "use strict";
  const {h, esc, table, badge, meter, toast, modal, confirm} = UI;
  const {pageHead, kpi} = MW;
  const U = window._erpUtil;

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
      const body=h("div",{},[
        MW.dl([["Supplier",ENG.sup(po.supplierId)],["Status",badge(po.status==="Received"?"ok":"info",po.status)],["Ordered",po.date],["ETA",po.eta],["Total Value",ENG.money(po.value)]]),
        h("h3",{style:"margin:18px 0 10px;font-size:14px",text:"Order Lines"}),
        table(po.lines,[
          {key:"item",label:"Item",render:r=>{const it=ENG.item(r.itemId)||{};return `<div class="cell-main">${esc(it.name||r.itemId)}</div><div class="cell-sub">${r.itemId}</div>`;},noSort:true},
          {key:"qty",label:"Ordered",num:true,render:r=>ENG.num(r.qty),noSort:true},
          {key:"recd",label:"Received",num:true,render:r=>ENG.num(r.recd||0),noSort:true},
          {key:"pend",label:"Pending",num:true,render:r=>{const p=r.qty-(r.recd||0);return p>0?`<span class="badge-s s-warn">${ENG.num(p)}</span>`:'<span class="muted">—</span>';},noSort:true},
          {key:"rate",label:"Rate",num:true,render:r=>"₹"+ENG.num(r.rate,2),noSort:true},
          {key:"amt",label:"Amount",num:true,render:r=>ENG.money(r.qty*r.rate),noSort:true},
        ],{empty:"No lines"})
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
          lines:items.map(x=>({itemId:x.it.id, qty:x.st.suggest, rate:x.it.cost, recd:0})),
          status:"Open", eta:DB.helpers.daysAhead(Math.max(...items.map(x=>x.it.lead))),
          value:items.reduce((s,x)=>s+x.st.suggest*x.it.cost,0)};
        ENG.data.purchaseorders.push(po); created.push(po);
      });
      tab="open"; toast(`${created.length} purchase order(s) created from suggestions`,{type:"ok",title:"POs raised"});
      App.saveDelta(async()=>{ for(const po of created) await DB.purchase.create(po); });
    }

    function poForm(arg){
      const editPo=(arg && typeof arg==="object" && arg.id)?arg:null;
      const presetItem=(typeof arg==="string")?arg:null;
      const sups=ENG.data.suppliers;
      let lines=[];
      const body=h("div",{},[
        h("div",{class:"form-grid"},[
          U.field("Supplier",U.searchSelect("po_sup",sups.map(s=>({v:s.id,l:s.name})),editPo?editPo.supplierId:sups[0].id,"Search supplier…")),
          U.field("Expected ETA",`<input class="input" id="po_eta" type="date" value="${editPo?editPo.eta:DB.helpers.daysAhead(14)}">`),
        ]),
        h("h3",{style:"margin:16px 0 8px;font-size:13px",text:"Lines"}),
        h("div",{id:"po_lines"}),
        h("button",{class:"btn sm",style:"margin-top:8px",onclick:()=>addLine(),html:"＋ Add line"})
      ]);
      const mo=modal({title:editPo?("Edit "+editPo.id):"New Purchase Order", sub:editPo?"Update this purchase order":"Raise a PO to a supplier", wide:true, body,
        foot:[h("button",{class:"btn ghost",onclick:()=>mo.close(),text:"Cancel"}),
          h("button",{class:"btn",onclick:printDraft,html:PRINT_IC+" Print"}),
          h("button",{class:"btn primary",onclick:save,text:editPo?"Save Changes":"Create PO"})]});
      function collect(){ const out=[];
        lines.forEach((_,i)=>{ if(!lines[i]) return; const iEl=UI.$("#pl_item_"+i); if(!iEl) return;
          const id=iEl.value, qty=+UI.$("#pl_qty_"+i).value, rate=+UI.$("#pl_rate_"+i).value;
          if(id&&qty>0) out.push({itemId:id, qty, rate:rate||ENG.item(id).cost, recd:0}); });
        return out; }
      function printDraft(){
        const out=collect();
        if(!out.length){ toast("Add at least one line with qty to print",{type:"warn"}); return; }
        printDoc("po",{ id:editPo?editPo.id:U.nextSeqId(ENG.data.purchaseorders,"PO-"),
          date:DB.helpers.iso(DB.helpers.today()), supplierId:UI.$("#po_sup").value, lines:out,
          status:editPo?editPo.status:"Draft — not saved", eta:UI.$("#po_eta").value,
          value:out.reduce((s,l)=>s+l.qty*l.rate,0) });
      }
      function addLine(seed){
        const rms=ENG.data.items.filter(i=>i.cat!=="FG");
        const idx=lines.length; lines.push({});
        const itemId=seed?(seed.itemId||seed):(rms[0]&&rms[0].id);
        const qtyVal=(seed&&seed.qty!=null)?seed.qty:(typeof seed==="string"?ENG.status(seed).suggest:"");
        const rateVal=(seed&&seed.rate!=null)?seed.rate:(typeof seed==="string"?ENG.item(seed).cost:"");
        const row=h("div",{class:"flex gap",style:"margin-bottom:8px;align-items:center"},[
          h("div",{html:U.searchSelect("pl_item_"+idx,rms.map(i=>({v:i.id,l:i.id+" — "+i.name})),itemId,"Search material…"),style:"flex:2"}),
          h("input",{class:"input",id:"pl_qty_"+idx,type:"number",placeholder:"Qty",style:"flex:1",value:qtyVal}),
          h("input",{class:"input",id:"pl_rate_"+idx,type:"number",placeholder:"Rate",style:"flex:1",value:rateVal}),
          h("button",{class:"btn sm ghost",title:"Remove line",onclick:e=>{e.preventDefault();e.target.closest(".flex.gap").remove();lines[idx]=null;},text:"✕"})
        ]);
        UI.$("#po_lines").appendChild(row);
      }
      if(editPo) editPo.lines.forEach(l=>addLine(l)); else addLine(presetItem);
      function save(){
        const sup=UI.$("#po_sup").value; const out=collect();
        if(!out.length){ toast("Add at least one line with qty",{type:"warn"}); return; }
        const eta=UI.$("#po_eta").value, value=out.reduce((s,l)=>s+l.qty*l.rate,0);
        if(editPo){
          editPo.supplierId=sup; editPo.eta=eta; editPo.lines=out; editPo.value=value; editPo.status="Open";
          mo.close(); toast(editPo.id+" updated",{type:"ok"});
          App.saveDelta(()=>DB.purchase.update(editPo.id,{supplierId:sup, eta, lines:out, value, status:"Open"}));
        } else {
          const po={id:U.nextSeqId(ENG.data.purchaseorders,"PO-"), date:DB.helpers.iso(DB.helpers.today()), supplierId:sup, lines:out,
            status:"Open", eta, value};
          ENG.data.purchaseorders.push(po);
          mo.close(); tab="open"; toast(po.id+" created",{type:"ok"});
          App.saveDelta(()=>DB.purchase.create(po));
        }
      }
    }
  }};

  /* ============== SALES ============== */
  M.sales = { title:"Sales Orders", sub:"Demand & dispatch", render(root, params){
    let tab="open";
    let filter={from:"", to:""};
    root.appendChild(pageHead("Sales Orders","Customer demand, ATP checks and dispatches that deduct finished goods automatically",[
      h("button",{class:"btn primary",onclick:soForm,html:"＋ New Sales Order"})
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
      const body=h("div",{},[
        MW.dl([["Customer",ENG.custName(so.customerId)],["Status",badge(so.status==="Dispatched"?"ok":"info",so.status)],["Priority",so.priority],["Order Date",so.date],["Promised",so.promised],["Total",ENG.money(so.value)]].concat(so.fromLead?[["From CRM Lead","🎯 "+so.fromLead]]:[])),
        h("h3",{style:"margin:18px 0 10px;font-size:14px",text:"Order Lines"}),
        table(so.lines,[
          {key:"item",label:"Item",render:r=>{const it=ENG.item(r.itemId)||{};return `<div class="cell-main">${esc(U.trim(it.name||r.itemId,30))}</div><div class="cell-sub">${r.itemId} · ${r.width||"-"}mm</div>`;},noSort:true},
          {key:"qty",label:"Qty",num:true,render:r=>ENG.num(r.qty)+" kg",noSort:true},
          {key:"stock",label:"In Stock",num:true,render:r=>{const h2=ENG.stock(r.itemId).onHand;return `<span style="color:${h2>=r.qty?'var(--ok)':'var(--danger)'}">${ENG.num(h2,1)}</span>`;},noSort:true},
          {key:"rate",label:"Rate",num:true,render:r=>"₹"+ENG.num(r.rate),noSort:true},
          {key:"amt",label:"Amount",num:true,render:r=>ENG.money(r.qty*r.rate),noSort:true},
        ],{empty:"No lines"})
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
    function soForm(arg){
      const editSo=(arg && typeof arg==="object" && arg.id)?arg:null;
      const custs=ENG.data.customers; const fgs=ENG.data.items.filter(i=>i.cat==="FG");
      let lines=[];
      const body=h("div",{},[
        h("div",{class:"form-grid"},[
          U.field("Customer",U.searchSelect("so_cust",custs.map(c=>({v:c.id,l:c.name})),editSo?editSo.customerId:custs[0].id,"Search customer…")),
          U.field("Priority",U.selectHTML("so_prio",[{v:"Normal",l:"Normal"},{v:"High",l:"High"},{v:"Urgent",l:"Urgent"}],editSo?editSo.priority:"Normal")),
          U.field("Promised Date",`<input class="input" id="so_prom" type="date" value="${editSo?editSo.promised:DB.helpers.daysAhead(10)}">`),
        ]),
        h("h3",{style:"margin:16px 0 8px;font-size:13px",text:"Lines"}),
        h("div",{id:"so_lines"}),
        h("button",{class:"btn sm",style:"margin-top:8px",onclick:()=>addLine(),html:"＋ Add line"})
      ]);
      const mo=modal({title:editSo?("Edit "+editSo.id):"New Sales Order", sub:editSo?"Update this sales order":"Capture customer demand", wide:true, body,
        foot:[h("button",{class:"btn ghost",onclick:()=>mo.close(),text:"Cancel"}),
          h("button",{class:"btn",onclick:printDraft,html:PRINT_IC+" Print"}),
          h("button",{class:"btn primary",onclick:save,text:editSo?"Save Changes":"Create Order"})]});
      function collect(){ const out=[];
        lines.forEach((_,i)=>{ if(!lines[i]) return; const iEl=UI.$("#sl_item_"+i); if(!iEl) return;
          const id=iEl.value, qty=+UI.$("#sl_qty_"+i).value, rate=+UI.$("#sl_rate_"+i).value;
          if(id&&qty>0) out.push({itemId:id, qty, rate:rate||ENG.item(id).price, width:(ENG.item(id).widthMM||[25])[0]}); });
        return out; }
      function printDraft(){
        const out=collect();
        if(!out.length){ toast("Add at least one line with qty to print",{type:"warn"}); return; }
        printDoc("so",{ id:editSo?editSo.id:U.nextSeqId(ENG.data.salesorders,"SO-"),
          date:DB.helpers.iso(DB.helpers.today()), customerId:UI.$("#so_cust").value, lines:out,
          status:editSo?editSo.status:"Draft — not saved", promised:UI.$("#so_prom").value,
          priority:UI.$("#so_prio").value, value:out.reduce((s,l)=>s+l.qty*l.rate,0) });
      }
      function addLine(seed){ const idx=lines.length; lines.push({});
        const itemId=seed?seed.itemId:(fgs[0]&&fgs[0].id);
        const qtyVal=(seed&&seed.qty!=null)?seed.qty:"";
        const rateVal=(seed&&seed.rate!=null)?seed.rate:(fgs[0]&&fgs[0].price);
        const row=h("div",{class:"flex gap",style:"margin-bottom:8px;align-items:center"},[
          h("div",{html:U.searchSelect("sl_item_"+idx,fgs.map(i=>({v:i.id,l:U.trim(i.name,30)})),itemId,"Search product…"),style:"flex:2"}),
          h("input",{class:"input",id:"sl_qty_"+idx,type:"number",placeholder:"Qty (kg)",style:"flex:1",value:qtyVal}),
          h("input",{class:"input",id:"sl_rate_"+idx,type:"number",placeholder:"Rate",style:"flex:1",value:rateVal}),
          h("button",{class:"btn sm ghost",title:"Remove line",onclick:e=>{e.preventDefault();e.target.closest(".flex.gap").remove();lines[idx]=null;},text:"✕"})
        ]); UI.$("#so_lines").appendChild(row); }
      if(editSo) editSo.lines.forEach(l=>addLine(l)); else addLine();
      function save(){
        const cust=UI.$("#so_cust").value; const out=collect();
        if(!out.length){ toast("Add at least one line",{type:"warn"}); return; }
        const value=out.reduce((s,l)=>s+l.qty*l.rate,0);
        if(editSo){
          const prio=UI.$("#so_prio").value, prom=UI.$("#so_prom").value;
          editSo.customerId=cust; editSo.priority=prio; editSo.promised=prom; editSo.lines=out; editSo.value=value;
          mo.close(); toast(editSo.id+" updated",{type:"ok"});
          App.saveDelta(()=>DB.sales.update(editSo.id,{customerId:cust, priority:prio, promised:prom, lines:out, value}));
        } else {
          const so={id:U.nextSeqId(ENG.data.salesorders,"SO-"), date:DB.helpers.iso(DB.helpers.today()), customerId:cust, lines:out,
            status:"Confirmed", promised:UI.$("#so_prom").value, priority:UI.$("#so_prio").value, value};
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
          h("div",{},[h("h3",{style:"font-size:15px",text:s.name}),h("div",{class:"muted",style:"font-size:12px",text:s.city+", "+s.country+" · "+s.category})]),
          h("div",{class:"avatar",style:"background:linear-gradient(135deg,var(--c"+((ENG.data.suppliers.indexOf(s)%8)+1)+"),var(--accent-600))",text:s.name.slice(0,2).toUpperCase()})
        ]),
        h("div",{class:"grid cols-3",style:"margin:14px 0;gap:8px"},[
          stat("Rating","★ "+s.rating), stat("On-Time",s.onTime+"%"), stat("Terms",s.terms),
        ]),
        h("div",{style:"margin-bottom:10px"},[ h("div",{class:"flex between",style:"font-size:11px;margin-bottom:4px"},[h("span",{class:"muted",text:"On-time delivery"}),h("span",{class:"muted",text:s.onTime+"%"})]), h("div",{html:meter(s.onTime,s.onTime>92?"ok":s.onTime>85?"warn":"danger")}) ]),
        h("div",{class:"flex between",style:"font-size:12.5px;padding-top:10px;border-top:1px solid var(--line)"},[
          h("span",{class:"muted",text:items.length+" items supplied"}),
          h("span",{class:"strong",text:ENG.money(spendMap[s.id]||0)+" / yr"})
        ]),
        h("div",{class:"contact-line",style:"font-size:11.5px;margin-top:8px"},[
          "👤 "+(s.contact||"—")+" · ", MW.phoneCell(s.phone),
          ...(s.email ? [" · ", MW.emailLink(s.email,{mode:"compose"})] : []),
        ])
      ]));
    });
    root.appendChild(grid);
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
          h("div",{},[h("h3",{style:"font-size:15px",text:c.name}),h("div",{class:"muted",style:"font-size:12px",text:c.city+" · "+c.segment})]),
          h("span",{html:badge(c.rating==="A"?"ok":c.rating==="B"?"warn":"mut","Grade "+c.rating)})
        ]),
        h("div",{class:"grid cols-3",style:"margin:14px 0;gap:8px"},[
          stat("Orders",orders.length), stat("Open",open), stat("Since",c.since),
        ]),
        h("div",{class:"flex between",style:"font-size:12.5px;padding-top:10px;border-top:1px solid var(--line)"},[
          h("span",{class:"muted",text:"Lifetime value"}), h("span",{class:"strong",text:ENG.money(total)})
        ]),
        h("div",{class:"contact-line",style:"font-size:11.5px;margin-top:8px"},[
          "👤 "+(c.contact||"—")+" · ", MW.phoneCell(c.phone),
          ...(c.email ? [" · ", MW.emailLink(c.email,{mode:"compose"})] : []),
          " · "+c.terms,
        ])
      ]));
    });
    root.appendChild(grid);
  }};

  function stat(label,val){ return h("div",{},[h("div",{class:"muted",style:"font-size:10.5px;font-weight:700;text-transform:uppercase",text:label}),h("div",{style:"font-weight:700;font-size:15px;margin-top:2px",text:val})]); }

  /* ----- New Supplier / New Customer ----- */
  function supplierForm(){
    const body=h("div",{class:"form-grid"},[
      U.field("Supplier Name *",`<input class="input" id="sp_name" placeholder="e.g. Axar Mica Industries">`,"full"),
      U.field("Category",`<input class="input" id="sp_cat" placeholder="e.g. Mica / Adhesives / Fabric">`),
      U.field("GSTIN",`<input class="input" id="sp_gst" placeholder="e.g. 29ABCDE1234F1Z5">`),
      U.field("City",`<input class="input" id="sp_city">`),
      U.field("Country",`<input class="input" id="sp_country" value="India">`),
      U.field("Contact Person",`<input class="input" id="sp_contact">`),
      U.field("Phone",`<input class="input" id="sp_phone" placeholder="+91…">`),
      U.field("Email",`<input class="input" id="sp_email" type="email">`),
      U.field("Payment Terms",`<input class="input" id="sp_terms" value="30 days">`),
    ]);
    const mo=modal({title:"＋ New Supplier", sub:"Add a vendor to the supplier master", body,
      foot:[h("button",{class:"btn ghost",onclick:()=>mo.close(),text:"Cancel"}),
        h("button",{class:"btn primary",onclick:save,text:"Add Supplier"})]});
    function save(){
      const name=UI.$("#sp_name").value.trim();
      if(!name){ toast("Supplier name is required",{type:"warn"}); return; }
      ENG.data.suppliers.push({ id:U.nextSeqId(ENG.data.suppliers,"SUP-"), name,
        category:UI.$("#sp_cat").value.trim()||"General", gst:UI.$("#sp_gst").value.trim(),
        city:UI.$("#sp_city").value.trim(), country:UI.$("#sp_country").value.trim()||"India",
        contact:UI.$("#sp_contact").value.trim(), phone:UI.$("#sp_phone").value.trim(),
        email:UI.$("#sp_email").value.trim(), terms:UI.$("#sp_terms").value.trim()||"30 days",
        rating:4.0, onTime:95 });
      mo.close(); toast(name+" added to suppliers",{type:"ok"});
      App.persistAndRefresh();
    }
  }
  function customerForm(){
    const yr=String(DB.helpers.today().getFullYear());
    const body=h("div",{class:"form-grid"},[
      U.field("Customer Name *",`<input class="input" id="cu_name" placeholder="e.g. Apar Industries Ltd.">`,"full"),
      U.field("Segment",`<input class="input" id="cu_seg" value="HT Cables">`),
      U.field("GSTIN",`<input class="input" id="cu_gst" placeholder="e.g. 27ABCDE1234F1Z5">`),
      U.field("City",`<input class="input" id="cu_city">`),
      U.field("Grade",U.selectHTML("cu_rating",[{v:"A",l:"A — key account"},{v:"B",l:"B — regular"},{v:"C",l:"C — occasional"}],"B")),
      U.field("Contact Person",`<input class="input" id="cu_contact">`),
      U.field("Phone",`<input class="input" id="cu_phone" placeholder="+91…">`),
      U.field("Email",`<input class="input" id="cu_email" type="email">`),
      U.field("Payment Terms",`<input class="input" id="cu_terms" value="30 days">`),
      U.field("Customer Since",`<input class="input" id="cu_since" value="${yr}">`),
    ]);
    const mo=modal({title:"＋ New Customer", sub:"Add a client to the customer master", body,
      foot:[h("button",{class:"btn ghost",onclick:()=>mo.close(),text:"Cancel"}),
        h("button",{class:"btn primary",onclick:save,text:"Add Customer"})]});
    function save(){
      const name=UI.$("#cu_name").value.trim();
      if(!name){ toast("Customer name is required",{type:"warn"}); return; }
      ENG.data.customers.push({ id:U.nextSeqId(ENG.data.customers,"CUS-"), name,
        segment:UI.$("#cu_seg").value.trim()||"HT Cables", gst:UI.$("#cu_gst").value.trim(),
        city:UI.$("#cu_city").value.trim(), rating:UI.$("#cu_rating").value,
        contact:UI.$("#cu_contact").value.trim(), phone:UI.$("#cu_phone").value.trim(),
        email:UI.$("#cu_email").value.trim(), terms:UI.$("#cu_terms").value.trim()||"30 days",
        since:UI.$("#cu_since").value.trim()||yr });
      mo.close(); toast(name+" added to customers",{type:"ok"});
      App.persistAndRefresh();
    }
  }

  /* ----- printable document (PO / SO invoice) -----
     Basic default layout with company details; a user-configurable
     invoice layout designer is on the backlog and will replace the
     styling below as the template for every downloaded document. */
  function printDoc(kind, o){
    const org=ENG.data.org||{};
    const isPO=kind==="po";
    const party=isPO ? (ENG.data.suppliers.find(s=>s.id===o.supplierId)||{name:o.supplierId})
                     : (ENG.data.customers.find(c=>c.id===o.customerId)||{name:o.customerId});
    const total=o.lines.reduce((s,l)=>s+l.qty*l.rate,0);
    const rows=o.lines.map((l,i)=>{ const it=ENG.item(l.itemId)||{};
      return `<tr><td>${i+1}</td><td>${esc(it.name||l.itemId)}<div class="sub">${esc(l.itemId)}${it.hsn?" · HSN "+esc(it.hsn):""}</div></td>`+
        `<td class="r">${ENG.num(l.qty,2)}</td><td>${esc(it.uom||"KG")}</td>`+
        `<td class="r">${(+l.rate).toLocaleString("en-IN",{minimumFractionDigits:2})}</td>`+
        `<td class="r">${(l.qty*l.rate).toLocaleString("en-IN",{minimumFractionDigits:2})}</td></tr>`; }).join("");
    const html=`<!doctype html><html><head><meta charset="utf-8"><title>${isPO?"Purchase Order":"Invoice"} ${esc(o.id)}</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box} body{font:13px/1.5 "Segoe UI",Arial,sans-serif;color:#111;padding:28px;max-width:820px;margin:0 auto}
  .head{display:flex;justify-content:space-between;gap:16px;border-bottom:3px solid #F06820;padding-bottom:14px;margin-bottom:16px}
  .co h1{font-size:20px;color:#F06820} .co div{font-size:11.5px;color:#444;margin-top:2px}
  .doc{text-align:right} .doc .t{font-size:22px;font-weight:800;letter-spacing:1px} .doc div{font-size:12px;margin-top:2px}
  .parties{display:flex;gap:16px;margin-bottom:16px} .party{flex:1;border:1px solid #ddd;border-radius:8px;padding:10px 12px}
  .party .lbl{font-size:10.5px;font-weight:700;text-transform:uppercase;color:#888;margin-bottom:4px}
  .party .nm{font-weight:700;font-size:14px}.party div{font-size:12px;color:#333}
  table{width:100%;border-collapse:collapse;margin-bottom:14px} th{background:#f5f5f5;font-size:11px;text-transform:uppercase;letter-spacing:.4px}
  th,td{border:1px solid #ddd;padding:7px 9px;text-align:left;vertical-align:top} td.r,th.r{text-align:right}
  td .sub{font-size:10.5px;color:#777} .tot td{font-weight:800;font-size:14px;background:#fafafa}
  .foot{display:flex;justify-content:space-between;margin-top:34px;font-size:11.5px;color:#555}
  .sig{text-align:center} .sig .ln{border-top:1px solid #999;margin-top:44px;padding-top:4px;min-width:180px}
  .note{margin-top:16px;font-size:10.5px;color:#999;text-align:center}
  @media print{ body{padding:8mm} .note{display:none} }
</style></head><body>
  <div class="head">
    <div class="co"><h1>${esc(org.name||"")}</h1>
      <div>${esc(org.address||"")}</div>
      <div>GSTIN: ${esc(org.gst||"—")} · ${esc(org.iso||"")}</div>
      <div>${esc(org.phone||"")} · ${esc(org.email||"")} · ${esc(org.website||"")}</div></div>
    <div class="doc"><div class="t">${isPO?"PURCHASE ORDER":"INVOICE"}</div>
      <div><b>${esc(o.id)}</b></div><div>Date: ${esc(o.date||"")}</div>
      <div>${isPO?("ETA: "+esc(o.eta||"—")):("Promised: "+esc(o.promised||"—"))}</div>
      <div>Status: ${esc(o.status||"")}</div></div>
  </div>
  <div class="parties">
    <div class="party"><div class="lbl">${isPO?"Supplier / Vendor":"Bill To / Ship To"}</div>
      <div class="nm">${esc(party.name||"")}</div>
      <div>${esc([party.city,party.country].filter(Boolean).join(", "))}</div>
      ${party.gst?`<div>GSTIN: ${esc(party.gst)}</div>`:""}
      <div>${esc([party.contact,party.phone].filter(Boolean).join(" · "))}</div>
      ${party.email?`<div>${esc(party.email)}</div>`:""}
      ${party.terms?`<div>Terms: ${esc(party.terms)}</div>`:""}</div>
    <div class="party"><div class="lbl">${isPO?"Deliver To":"From"}</div>
      <div class="nm">${esc(org.name||"")}</div><div>${esc(org.address||"")}</div>
      <div>GSTIN: ${esc(org.gst||"—")}</div></div>
  </div>
  <table><thead><tr><th>#</th><th>Item Description</th><th class="r">Qty</th><th>UoM</th><th class="r">Rate (₹)</th><th class="r">Amount (₹)</th></tr></thead>
  <tbody>${rows}
    <tr class="tot"><td colspan="5" class="r">TOTAL</td><td class="r">₹ ${total.toLocaleString("en-IN",{minimumFractionDigits:2})}</td></tr>
  </tbody></table>
  <div class="foot">
    <div>Payment terms: ${esc(party.terms||"as agreed")}<br>Subject to Bangalore jurisdiction.</div>
    <div class="sig">For ${esc(org.name||"")}<div class="ln">Authorised Signatory</div></div>
  </div>
  <div class="note">Computer-generated document · default layout (custom invoice designer pending) · use your browser's "Save as PDF" to download</div>
  <script>window.onload=function(){window.print();}</script>
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
