/* ============================================================
   CHHAPERIA ERP — INVENTORY, LEDGER, WAREHOUSES
   ============================================================ */
(function () {
  "use strict";
  const {h, esc, table, badge, meter, toast, modal} = UI;
  const {pageHead, kpi} = MW;

  /* ============== STOCK ITEMS ============== */
  M.inventory = { title:"Stock Items", sub:"Auto-calculated inventory", render(root){
    let filter={q:"", cat:"all", state:"all"};
    root.appendChild(pageHead("Stock Items","On-hand, usage, pending & valuation — all computed live from the ledger",[
      h("button",{class:"btn",onclick:exportCSV,html:"⬇ Export CSV"}),
      h("button",{class:"btn primary",onclick:()=>itemForm(),html:"＋ New Item"})
    ]));

    /* summary strip */
    const inv=ENG.inventoryValue();
    const low=ENG.data.items.filter(it=>["warn","danger"].includes(ENG.status(it.id).state));
    root.appendChild(h("div",{class:"grid kpi-grid",style:"margin-bottom:16px"},[
      kpi({icon:"💰",label:"Total Inventory Value",value:ENG.money(inv.total)}),
      kpi({icon:"🧱",label:"Raw Material Value",value:ENG.money(inv.rm)}),
      kpi({icon:"🎁",label:"Finished Goods Value",value:ENG.money(inv.fg)}),
      kpi({icon:"⚠️",label:"Items Below Reorder",value:ENG.num(low.length),delta:low.length?"Needs procurement":"Healthy",deltaType:low.length?"down":"up"}),
    ]));

    /* toolbar */
    const tableHost=h("div");
    const bar=h("div",{class:"toolbar"},[
      MW.searchInput("Search items, codes, HSN…", v=>{filter.q=v.toLowerCase();draw();}),
      MW.select([{value:"all",label:"All Categories"},...ENG.data.categories.map(c=>({value:c.id,label:c.name}))], v=>{filter.cat=v;draw();}),
      MW.select([{value:"all",label:"All Status"},{value:"danger",label:"Critical / Out"},{value:"warn",label:"Reorder"},{value:"ok",label:"Healthy"},{value:"info",label:"Overstock"}], v=>{filter.state=v;draw();}),
      h("div",{style:"margin-left:auto"},h("span",{class:"chip",id:"invCount"}))
    ]);
    root.appendChild(bar);
    root.appendChild(tableHost);

    function rows(){
      return ENG.data.items.map(it=>{
        const st=ENG.status(it.id), u=ENG.usage(it.id);
        return {it, st, u};
      }).filter(r=>{
        if(filter.cat!=="all" && r.it.cat!==filter.cat) return false;
        if(filter.state!=="all" && r.st.state!==filter.state) return false;
        if(filter.q){ const s=(r.it.name+" "+r.it.id+" "+(r.it.hsn||"")+" "+r.it.cat).toLowerCase(); if(!s.includes(filter.q)) return false; }
        return true;
      });
    }
    function draw(){
      const data=rows();
      UI.$("#invCount").textContent=data.length+" items";
      tableHost.innerHTML="";
      tableHost.appendChild(table(data,[
        {key:"name",label:"Item",render:r=>`<div class="cell-main">${esc(r.it.name)}</div><div class="cell-sub">${r.it.id} · ${catName(r.it.cat)} · HSN ${r.it.hsn||"—"}</div>`,sort:r=>r.it.name},
        {key:"onHand",label:"On Hand",num:true,render:r=>`<span class="strong">${ENG.num(r.st.onHand,2)}</span> <span class="muted">${r.it.uom}</span>`,sort:r=>r.st.onHand},
        {key:"pIn",label:"Pending In",num:true,render:r=>r.st.pIn?`<span class="badge-s s-ok">▲ ${ENG.num(r.st.pIn)}</span>`:'<span class="muted">—</span>',sort:r=>r.st.pIn},
        {key:"pOut",label:"Pending Out",num:true,render:r=>r.st.pOut?`<span class="badge-s s-warn">▼ ${ENG.num(r.st.pOut)}</span>`:'<span class="muted">—</span>',sort:r=>r.st.pOut},
        {key:"atp",label:"ATP / Net",num:true,render:r=>`<span class="mono ${r.st.atp<0?'':''}" style="color:${r.st.atp<0?'var(--danger)':'var(--text)'}">${ENG.num(r.st.atp,1)}</span>`,sort:r=>r.st.atp},
        {key:"usage",label:"Used 30d",num:true,render:r=>`<span class="mono">${ENG.num(r.it.cat==="FG"?r.u.sold90/3:r.u.used30,1)}</span>`,sort:r=>r.it.cat==="FG"?r.u.sold90:r.u.used30},
        {key:"cover",label:"Cover",num:true,render:r=>coverBadge(r.st.cover),sort:r=>r.st.cover},
        {key:"value",label:"Value",num:true,render:r=>`<span class="strong">${ENG.money(r.st.value)}</span>`,sort:r=>r.st.value},
        {key:"state",label:"Status",render:r=>statusCell(r),sort:r=>({danger:0,warn:1,ok:2,info:3})[r.st.state]},
      ],{onRow:r=>itemDetail(r.it.id),empty:"No items match your filters"}));
    }
    draw();

    function exportCSV(){
      const data=rows();
      const head=["Code","Name","Category","UoM","OnHand","PendingIn","PendingOut","ATP","ReorderPt","Safety","AvgCost","Value","Status"];
      const lines=[head.join(",")].concat(data.map(r=>[
        r.it.id, '"'+r.it.name+'"', r.it.cat, r.it.uom, r.st.onHand.toFixed(2), r.st.pIn, r.st.pOut, r.st.atp,
        r.it.reorder, r.it.safety, r.st.avgCost.toFixed(2), r.st.value.toFixed(0), r.st.label
      ].join(",")));
      downloadCSV("chhaperia_inventory.csv", lines.join("\n"));
      toast("Inventory exported to CSV","",{type:"ok",title:"Export complete"});
    }
  }};

  /* ----- item detail drawer/modal ----- */
  function itemDetail(id){
    const it=ENG.item(id), st=ENG.status(id), u=ENG.usage(id), s=ENG.stock(id);
    const led=ENG.ledger(id).slice(-12).reverse();
    const ser = last30Series(id);
    const body=h("div",{},[
      h("div",{class:"grid cols-3",style:"margin-bottom:16px"},[
        miniStat("On Hand", ENG.num(st.onHand,2)+" "+it.uom, st.state),
        miniStat("Pending In", ENG.num(st.pIn)+" "+it.uom, "ok"),
        miniStat("Pending Out", ENG.num(st.pOut)+" "+it.uom, "warn"),
        miniStat("Available (ATP)", ENG.num(st.atp,1)+" "+it.uom, st.atp<0?"danger":"info"),
        miniStat("Avg Cost", "₹"+ENG.num(st.avgCost,2), "mut"),
        miniStat("Stock Value", ENG.money(st.value), "mut"),
      ]),
      MW.dl([
        ["Category", catName(it.cat)],["UoM", it.uom],["HSN", it.hsn||"—"],
        ["Reorder Point", ENG.num(it.reorder)+" "+it.uom],["Safety Stock", ENG.num(it.safety)+" "+it.uom],
        ["Lead Time", it.lead+" days"],["ABC Class", it.abc],["Days Cover", st.cover>900?"∞":st.cover+" days"],
        ["Suggested Order", st.suggest? ENG.num(st.suggest)+" "+it.uom : "—"],
      ]),
      h("div",{class:"card",style:"margin-top:16px;box-shadow:none;background:var(--panel-2)"},[
        h("div",{class:"card-head"},h("h3",{text:"30-Day Movement"})),
        (()=>{ const cv=h("canvas",{"data-h":140}); const box=h("div",{class:"chart-box"},cv);
          requestAnimationFrame(()=>Charts.line(cv,{labels:ser.labels,series:[{name:"Balance",data:ser.bal,color:cssv("--accent")}],fmt:v=>ENG.num(v)})); return box; })()
      ]),
      h("h3",{style:"margin:18px 0 10px;font-size:14px",text:"Recent Ledger"}),
      table(led,[
        {key:"date",label:"Date",render:r=>r.date,noSort:true},
        {key:"type",label:"Type",render:r=>moveBadge(r.type),noSort:true},
        {key:"ref",label:"Reference",render:r=>`<span class="mono">${esc(r.ref||"—")}</span>`,noSort:true},
        {key:"qty",label:"Qty",num:true,render:r=>`<span style="color:${r.qty<0?'var(--danger)':'var(--ok)'}">${r.qty>0?"+":""}${ENG.num(r.qty,2)}</span>`,noSort:true},
        {key:"balance",label:"Balance",num:true,render:r=>`<span class="strong mono">${ENG.num(r.balance,2)}</span>`,noSort:true},
      ],{empty:"No movements"})
    ]);
    modal({title:it.name, sub:it.id+" · "+catName(it.cat), wide:true, body,
      foot:[
        h("button",{class:"btn",onclick:()=>{App.go("ledger",{item:id});UI.$("#modalHost").hidden=true;},text:"📒 Full Ledger"}),
        st.suggest?h("button",{class:"btn primary",onclick:()=>{App.go("purchase",{create:id});UI.$("#modalHost").hidden=true;},html:`🛒 Raise PO (${ENG.num(st.suggest)} ${it.uom})`}):null,
        h("button",{class:"btn ghost",onclick:()=>itemForm(it),text:"✎ Edit"})
      ]});
  }

  /* ----- item create/edit form ----- */
  function itemForm(it){
    const edit=!!it; it=it||{cat:"RM",uom:"KG",abc:"B",lead:7};
    const f=(k,v)=>it[k]!=null?it[k]:v;
    const body=h("div",{class:"form-grid"},[
      field("Item Code",`<input class="input" id="f_id" value="${esc(f('id',''))}" ${edit?'disabled':''} placeholder="e.g. RM-XYZ">`),
      field("Item Name",`<input class="input" id="f_name" value="${esc(f('name',''))}" placeholder="Descriptive name">`),
      field("Category",selectHTML("f_cat",ENG.data.categories.map(c=>({v:c.id,l:c.name})),it.cat)),
      field("Unit of Measure",`<input class="input" id="f_uom" value="${esc(f('uom','KG'))}">`),
      field("Reorder Point",`<input class="input" id="f_reorder" type="number" value="${f('reorder',0)}">`),
      field("Safety Stock",`<input class="input" id="f_safety" type="number" value="${f('safety',0)}">`),
      field("Lead Time (days)",`<input class="input" id="f_lead" type="number" value="${f('lead',7)}">`),
      field("Std Cost (₹)",`<input class="input" id="f_cost" type="number" value="${f('cost',0)}">`),
      field("Selling Price (₹)",`<input class="input" id="f_price" type="number" value="${f('price',0)}">`),
      field("HSN Code",`<input class="input" id="f_hsn" value="${esc(f('hsn',''))}">`),
    ]);
    const mo=modal({title:edit?"Edit Item":"New Item", sub:edit?it.id:"Create a stock item", body,
      foot:[ h("button",{class:"btn ghost",onclick:()=>mo.close(),text:"Cancel"}),
        h("button",{class:"btn primary",onclick:save,text:edit?"Save Changes":"Create Item"}) ]});
    function save(){
      const g=id=>UI.$("#"+id).value;
      const code=g("f_id").trim().toUpperCase();
      if(!code||!g("f_name").trim()){ toast("Code and name are required",{type:"warn"}); return; }
      if(!edit && ENG.item(code)){ toast("Item code already exists",{type:"danger"}); return; }
      const obj=edit?it:{barcode:"890"+Math.floor(Math.random()*1e7), active:true, moq:0};
      Object.assign(obj,{ id:code, name:g("f_name").trim(), cat:g("f_cat"), uom:g("f_uom"),
        reorder:+g("f_reorder")||0, safety:+g("f_safety")||0, lead:+g("f_lead")||7,
        cost:+g("f_cost")||0, price:+g("f_price")||0, hsn:g("f_hsn") });
      if(!edit){ ENG.data.items.push(obj);
        ENG.data.movements.push({id:"MV-"+Date.now(), date:DB.helpers.iso(DB.helpers.today()), itemId:code, wh:obj.cat==="FG"?"WH-FG":"WH-PNY", type:"OPEN", qty:0, rate:obj.cost, ref:"NEW", note:"Item created"});
      }
      App.persistAndRefresh();
      mo.close(); toast(edit?"Item updated":"Item created",{type:"ok"});
    }
  }

  /* ============== STOCK LEDGER ============== */
  M.ledger = { title:"Stock Ledger", sub:"Every movement, running balance", render(root, params){
    let filter={q:params&&params.item?params.item:"", type:"all", wh:"all"};
    root.appendChild(pageHead("Stock Ledger","Complete audit trail — receipts, issues, production, sales & adjustments with auto running balance",[
      h("button",{class:"btn",onclick:()=>adjForm(),html:"⚖ Stock Adjustment"}),
    ]));
    const tableHost=h("div");
    const bar=h("div",{class:"toolbar"},[
      MW.searchInput("Search item, reference…", v=>{filter.q=v.toLowerCase();draw();}),
      MW.select([{value:"all",label:"All Types"},...["OPEN","GRN","ISSUE","PROD","SALE","ADJ","RET","SCRAP"].map(t=>({value:t,label:typeLabel(t)}))], v=>{filter.type=v;draw();}),
      MW.select([{value:"all",label:"All Warehouses"},...ENG.data.warehouses.map(w=>({value:w.id,label:w.name}))], v=>{filter.wh=v;draw();}),
      h("div",{style:"margin-left:auto"},h("span",{class:"chip",id:"ledCount"}))
    ]);
    if(filter.q){ bar.querySelector("input").value=filter.q; }
    root.appendChild(bar); root.appendChild(tableHost);

    function draw(){
      let data=ENG.data.movements.slice().reverse();
      data=data.filter(m=>{
        if(filter.type!=="all"&&m.type!==filter.type) return false;
        if(filter.wh!=="all"&&m.wh!==filter.wh) return false;
        if(filter.q){ const it=ENG.item(m.itemId)||{}; const s=(m.itemId+" "+(it.name||"")+" "+(m.ref||"")+" "+(m.note||"")).toLowerCase(); if(!s.includes(filter.q)) return false; }
        return true;
      }).slice(0,400);
      UI.$("#ledCount").textContent=data.length+" entries";
      tableHost.innerHTML="";
      tableHost.appendChild(table(data,[
        {key:"date",label:"Date",render:r=>r.date,sort:r=>r.date},
        {key:"item",label:"Item",render:r=>{const it=ENG.item(r.itemId)||{};return `<div class="cell-main">${esc(trim(it.name||r.itemId,32))}</div><div class="cell-sub">${r.itemId}</div>`;},sort:r=>r.itemId},
        {key:"type",label:"Type",render:r=>moveBadge(r.type),sort:r=>r.type},
        {key:"wh",label:"Warehouse",render:r=>`<span class="muted">${whName(r.wh)}</span>`,sort:r=>r.wh},
        {key:"ref",label:"Reference",render:r=>`<span class="mono">${esc(r.ref||"—")}</span>`,sort:r=>r.ref},
        {key:"qty",label:"Qty",num:true,render:r=>{const it=ENG.item(r.itemId)||{};return `<span style="color:${r.qty<0?'var(--danger)':'var(--ok)'};font-weight:700">${r.qty>0?"+":""}${ENG.num(r.qty,2)}</span> <span class="muted">${it.uom||""}</span>`;},sort:r=>r.qty},
        {key:"rate",label:"Rate",num:true,render:r=>r.rate?"₹"+ENG.num(r.rate,2):"—",sort:r=>r.rate||0},
        {key:"value",label:"Value",num:true,render:r=>r.rate?ENG.money(Math.abs(r.qty*r.rate)):"—",sort:r=>Math.abs(r.qty*(r.rate||0))},
      ],{empty:"No movements match"}));
    }
    draw();

    function adjForm(){
      const items=ENG.data.items;
      const body=h("div",{class:"form-grid"},[
        field("Item",selectHTML("a_item",items.map(i=>({v:i.id,l:i.id+" — "+trim(i.name,30)})),items[0].id)),
        field("Warehouse",selectHTML("a_wh",ENG.data.warehouses.map(w=>({v:w.id,l:w.name})),"WH-PNY")),
        field("Adjustment Type",selectHTML("a_type",[{v:"ADJ",l:"Adjustment (+/-)"},{v:"SCRAP",l:"Scrap (-)"} ,{v:"RET",l:"Return (+)"}],"ADJ")),
        field("Quantity (use - to reduce)",`<input class="input" id="a_qty" type="number" value="0">`),
        field("Reason / Note",`<input class="input" id="a_note" placeholder="e.g. Cycle count variance">`,"full"),
      ]);
      const mo=modal({title:"Stock Adjustment", sub:"Posts an audited ledger entry", body,
        foot:[h("button",{class:"btn ghost",onclick:()=>mo.close(),text:"Cancel"}),
          h("button",{class:"btn primary",onclick:save,text:"Post Entry"})]});
      async function save(){
        const id=UI.$("#a_item").value, qty=+UI.$("#a_qty").value;
        if(!qty || isNaN(qty)){ toast("Enter a non-zero quantity",{type:"warn"}); return; }
        const it=ENG.item(id);
        const onHand=ENG.stock(id).onHand;
        // Negative-stock guard: a reduction that pushes on-hand below zero
        // is blocked by default, but can be overridden deliberately.
        if(qty<0 && (onHand+qty) < -0.0001){
          const after=onHand+qty;
          const ok=await confirm(
            `⚠ This will take ${it.name} below zero.\n\n`+
            `On hand: ${ENG.num(onHand,2)} ${it.uom}\n`+
            `Change : ${ENG.num(qty,2)} ${it.uom}\n`+
            `Result : ${ENG.num(after,2)} ${it.uom}\n\n`+
            `Negative stock usually means a receipt (GRN) wasn't entered yet. `+
            `Post anyway?`,
            {title:"Stock would go negative", danger:true});
          if(!ok) return;
        }
        ENG.data.movements.push({id:"MV-"+Date.now(), date:DB.helpers.iso(DB.helpers.today()), itemId:id,
          wh:UI.$("#a_wh").value, type:UI.$("#a_type").value, qty, rate:it.cost,
          ref:UI.$("#a_type").value+"-"+Math.floor(Math.random()*9000+1000), note:UI.$("#a_note").value||"Manual adjustment", by:"user"});
        App.persistAndRefresh(); mo.close(); toast("Ledger entry posted",{type:"ok"}); draw();
      }
    }
  }};

  /* ============== WAREHOUSES ============== */
  M.warehouses = { title:"Warehouses", sub:"Stock by location", render(root){
    root.appendChild(pageHead("Warehouses","Stock distribution across plant locations"));
    const grid=h("div",{class:"grid cols-2"});
    ENG.data.warehouses.forEach(w=>{
      let val=0, items=0;
      ENG.data.items.forEach(it=>{ const q=ENG.stock(it.id).byWh[w.id]||0; if(q>0.001){ val+=q*ENG.stock(it.id).avgCost; items++; } });
      const top=ENG.data.items.map(it=>({it,q:ENG.stock(it.id).byWh[w.id]||0})).filter(x=>x.q>0.001).sort((a,b)=>b.q-a.q).slice(0,5);
      grid.appendChild(h("div",{class:"card hover"},[
        h("div",{class:"flex between aic"},[
          h("div",{},[h("h3",{style:"font-size:16px",text:w.name}),h("div",{class:"muted",style:"font-size:12px",text:w.city+" · "+w.type})]),
          h("div",{class:"kpi-ic",text:whIcon(w.type)})
        ]),
        h("div",{class:"flex between",style:"margin:16px 0;padding:14px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)"},[
          stat("Stock Value",ENG.money(val)), stat("Active Items",ENG.num(items)), stat("Type",w.type)
        ]),
        h("div",{class:"muted",style:"font-size:11px;font-weight:700;text-transform:uppercase;margin-bottom:8px",text:"Top items"}),
        h("div",{class:"barlist"}, top.length?top.map(x=>h("div",{class:"flex between",style:"font-size:12.5px;padding:4px 0"},[
          h("span",{text:trim(x.it.name,30)}), h("span",{class:"mono muted",text:ENG.num(x.q,1)+" "+x.it.uom})
        ])):[h("div",{class:"muted",text:"Empty"})])
      ]));
    });
    root.appendChild(grid);
  }};

  /* ---------- shared helpers ---------- */
  function field(label, inner, cls){ return h("div",{class:"field"+(cls==="full"?" full":"")},[h("label",{text:label}),h("div",{html:inner})]); }
  function selectHTML(id,opts,sel){ return `<select class="select" id="${id}">`+opts.map(o=>`<option value="${o.v}" ${o.v===sel?"selected":""}>${esc(o.l)}</option>`).join("")+`</select>`; }
  function miniStat(label,val,state){ const c={danger:"var(--danger)",warn:"var(--warn)",ok:"var(--ok)",info:"var(--info)",mut:"var(--text)"}[state]||"var(--text)";
    return h("div",{class:"card",style:"box-shadow:none;background:var(--panel-2);padding:13px"},[
      h("div",{class:"muted",style:"font-size:11px;font-weight:700;text-transform:uppercase",text:label}),
      h("div",{style:`font-size:19px;font-weight:800;margin-top:4px;color:${c}`,text:val})]); }
  function stat(label,val){ return h("div",{},[h("div",{class:"muted",style:"font-size:11px",text:label}),h("div",{style:"font-weight:700;font-size:15px;margin-top:2px",text:val})]); }
  function statusCell(r){ const dot={danger:"var(--danger)",warn:"var(--warn)",ok:"var(--ok)",info:"var(--info)"}[r.st.state];
    return `<span class="badge-s ${ {danger:'s-danger',warn:'s-warn',ok:'s-ok',info:'s-info'}[r.st.state] }">${esc(r.st.label)}</span>`; }
  function coverBadge(d){ if(d>900) return '<span class="muted">∞</span>';
    const cls=d<14?"s-danger":d<30?"s-warn":"s-ok"; return `<span class="badge-s ${cls}">${d}d</span>`; }
  function moveBadge(t){ const m={OPEN:"s-mut",GRN:"s-ok",ISSUE:"s-warn",PROD:"s-info",SALE:"s-violet",ADJ:"s-mut",RET:"s-ok",SCRAP:"s-danger"};
    return `<span class="badge-s ${m[t]||"s-mut"}">${esc(typeLabel(t))}</span>`; }
  function typeLabel(t){ return {OPEN:"Opening",GRN:"Receipt",ISSUE:"Issue",PROD:"Production",SALE:"Sale",ADJ:"Adjust",RET:"Return",SCRAP:"Scrap"}[t]||t; }
  function catName(id){ return (ENG.data.categories.find(c=>c.id===id)||{}).name||id; }
  function whName(id){ return (ENG.data.warehouses.find(w=>w.id===id)||{}).name||id; }
  function whIcon(t){ return {"Raw Material":"🧱","WIP":"⚙️","Finished Goods":"🎁","Quarantine":"🔬"}[t]||"🏬"; }
  function trim(s,n){ s=String(s||""); return s.length>n?s.slice(0,n-1)+"…":s; }
  function cssv(v){ return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }
  function last30Series(id){ const t=DB.helpers.today().getTime(); const labels=[],bal=[];
    const led=ENG.ledger(id); 
    for(let i=29;i>=0;i--){ const d=DB.helpers.iso(t-i*DB.helpers.DAY); labels.push(d);
      let b=0; for(const m of led){ if(m.date<=d) b=m.balance; else break; } bal.push(+b.toFixed(2)); }
    return {labels,bal}; }
  function downloadCSV(name,content){ const blob=new Blob([content],{type:"text/csv"}); const url=URL.createObjectURL(blob);
    const a=document.createElement("a"); a.href=url; a.download=name; a.click(); URL.revokeObjectURL(url); }
  // expose for other modules
  window._erpUtil = Object.assign(window._erpUtil||{}, {field, selectHTML, downloadCSV, trim, catName, moveBadge});
})();
