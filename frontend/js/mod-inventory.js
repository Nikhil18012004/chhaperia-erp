/* ============================================================
   CHHAPERIA ERP — INVENTORY, LEDGER, WAREHOUSES
   ============================================================ */
(function () {
  "use strict";
  const {h, esc, table, badge, meter, toast, modal} = UI;
  const {pageHead, kpi} = MW;

  /* ============== STOCK ITEMS ============== */
  M.inventory = { title:"Stock Items", sub:"Auto-calculated inventory", render(root){
    let filter={q:"", cat:"all", state:"all", from:"", to:""};
    root.appendChild(pageHead("Stock Items","On-hand, usage, pending & valuation — all computed live from the ledger",[
      h("button",{class:"btn",onclick:exportCSV,html:"⬇ Export CSV"}),
      newItemMenu()
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
      MW.select([{value:"all",label:"All Status"},{value:"instock",label:"In Stock"},{value:"low",label:"Low Stock"},{value:"out",label:"Out of Stock"}], v=>{filter.state=v;draw();}),
      MW.dateRange(filter, draw, {label:"Last Movement"}),
      h("div",{style:"margin-left:auto"},h("span",{class:"chip",id:"invCount"}))
    ]);
    root.appendChild(bar);
    root.appendChild(tableHost);

    /* three-way stock bucket for the status filter */
    function stockClass(st){
      if(st.onHand<=0) return "out";
      if(st.onHand<=(st.reorder||0)) return "low";
      return "instock";
    }
    function rows(){
      return ENG.data.items.map(it=>{
        const st=ENG.status(it.id), u=ENG.usage(it.id), stock=ENG.stock(it.id);
        return {it, st, u, stock};
      }).filter(r=>{
        if(filter.cat!=="all" && r.it.cat!==filter.cat) return false;
        if(filter.state!=="all" && stockClass(r.st)!==filter.state) return false;
        if(!MW.inDateRange(r.stock.lastMove, filter)) return false;
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
        {key:"lastMove",label:"Last Move",render:r=>r.stock.lastMove||"—",sort:r=>r.stock.lastMove||""},
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
      const head=["Code","Name","Category","UoM","LastMove","OnHand","PendingIn","PendingOut","ATP","ReorderPt","Safety","AvgCost","Value","Status"];
      const lines=[head.join(",")].concat(data.map(r=>[
        r.it.id, '"'+r.it.name+'"', r.it.cat, r.it.uom, r.stock.lastMove||"", r.st.onHand.toFixed(2), r.st.pIn, r.st.pOut, r.st.atp,
        r.it.reorder, r.it.safety, r.st.avgCost.toFixed(2), r.st.value.toFixed(0), r.st.label
      ].join(",")));
      downloadCSV("chhaperia_inventory.csv", lines.join("\n"));
      toast("Inventory exported to CSV",{type:"ok",title:"Export complete"});
    }
  }};

  /* ----- "New Item" split-button: create / receive via PO / add stock ----- */
  function newItemMenu(){
    const menu=h("div",{class:"ni-menu",hidden:true},[
      h("button",{class:"ni-opt",onclick:()=>{close();addStockForm();},html:"📦 Add Stock"}),
      h("button",{class:"ni-opt",onclick:()=>{close();receiveStockForm();},html:"🚚 Receive via PO"}),
    ]);
    const trigger=h("button",{class:"btn primary",html:"＋ New Item <span class=\"caret\">▾</span>"});
    const wrap=h("div",{class:"ni-drop"},[trigger,menu]);
    function onDoc(e){ if(!wrap.contains(e.target)) close(); }
    function close(){ menu.hidden=true; trigger.classList.remove("open"); document.removeEventListener("click",onDoc); }
    trigger.addEventListener("click",e=>{
      e.stopPropagation();
      if(menu.hidden){ menu.hidden=false; trigger.classList.add("open"); setTimeout(()=>document.addEventListener("click",onDoc),0); }
      else close();
    });
    return wrap;
  }

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
        ...(it.thickness?[["Thickness", it.thickness+" mm"]]:[]),
        ...(it.width?[["Width", it.width+" mm"]]:[]),
        ...(it.length?[["Length", it.length+" m"]]:[]),
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
      field("Barcode",`<input class="input" id="f_barcode" value="${esc(f('barcode',''))}" placeholder="Scan/enter, or leave blank to auto-generate">`),
    ]);
    const mo=modal({title:edit?"Edit Item":"New Item", sub:edit?it.id:"Create a stock item", body,
      foot:[ h("button",{class:"btn ghost",onclick:()=>mo.close(),text:"Cancel"}),
        h("button",{class:"btn primary",onclick:save,text:edit?"Save Changes":"Create Item"}) ]});
    function save(){
      const g=id=>UI.$("#"+id).value;
      const code=g("f_id").trim().toUpperCase();
      if(!code||!g("f_name").trim()){ toast("Code and name are required",{type:"warn"}); return; }
      if(!edit && ENG.item(code)){ toast("Item code already exists",{type:"danger"}); return; }
      const obj=edit?it:{active:true, moq:0};
      const barcode=g("f_barcode").trim() || obj.barcode || ("890"+Math.floor(Math.random()*1e7));
      Object.assign(obj,{ id:code, name:g("f_name").trim(), cat:g("f_cat"), uom:g("f_uom"),
        reorder:+g("f_reorder")||0, safety:+g("f_safety")||0, lead:+g("f_lead")||7,
        cost:+g("f_cost")||0, price:+g("f_price")||0, hsn:g("f_hsn"), barcode });
      let openMove=null;
      if(!edit){ ENG.data.items.push(obj);
        openMove={id:genMoveId(), date:DB.helpers.iso(DB.helpers.today()), itemId:code, wh:obj.cat==="FG"?"WH-FG":"WH-PNY", type:"OPEN", qty:0, rate:obj.cost, ref:"NEW", note:"Item created"};
        ENG.data.movements.push(openMove);
      }
      mo.close(); toast(edit?"Item updated":"Item created",{type:"ok"});
      App.saveDelta(async()=>{ await DB.items.put(obj); if(openMove) await DB.movements.add(openMove); });
    }
  }

  /* ----- units of measure offered for manual stock intake ----- */
  const UNITS=[
    {v:"M",l:"Meter (m)"}, {v:"KG",l:"Kilogram (kg)"}, {v:"PCS",l:"Pieces (pcs)"},
    {v:"SQM",l:"Square Meter (sqm)"}, {v:"ROLL",l:"Rolls"}
  ];

  /* generate a fresh, unique item code within a category (e.g. RM-001) */
  function genItemId(cat){
    const base=(cat||"IT").toUpperCase();
    let n=ENG.data.items.filter(i=>String(i.id).startsWith(base+"-")).length+1, id;
    do{ id=base+"-"+String(1000+n).slice(1); n++; } while(ENG.item(id));
    return id;
  }

  /* ----- FEATURE 1: add stock to inventory against a PO number ----- */
  function receiveStockForm(){
    const openPOs=ENG.data.purchaseorders.filter(p=>p.status!=="Received");
    if(!openPOs.length){
      modal({title:"Receive via PO", sub:"Goods receipt",
        body:h("div",{class:"empty"},[h("div",{class:"big",text:"📦"}),
          h("div",{style:"font-weight:700",text:"No open purchase orders"}),
          h("div",{class:"muted",style:"margin-top:6px",text:"Raise a purchase order in Procurement first, then receive it here."})]),
        foot:[h("button",{class:"btn primary",onclick:()=>{UI.$("#modalHost").hidden=true;App.go("purchase");},text:"Go to Procurement"})]});
      return;
    }
    const body=h("div",{},[
      h("div",{class:"form-grid"},[
        field("Scan / Barcode",`<input class="input" id="r_scan" placeholder="Scan a received item to jump to its line">`,"full"),
        field("Purchase Order", selectHTML("r_po", openPOs.map(p=>({v:p.id, l:p.id+" — "+trim(ENG.sup(p.supplierId),24)})), openPOs[0].id)),
        field("Receive into Warehouse", selectHTML("r_wh", ENG.data.warehouses.map(w=>({v:w.id,l:w.name})), "WH-PNY")),
      ]),
      h("h3",{style:"margin:16px 0 8px;font-size:13px",text:"Lines to receive (edit qty as needed)"}),
      h("div",{id:"r_lines"})
    ]);
    const mo=modal({title:"Receive Stock against PO", sub:"Posts a goods receipt (GRN) straight to stock", wide:true, body,
      foot:[h("button",{class:"btn ghost",onclick:()=>mo.close(),text:"Cancel"}),
        h("button",{class:"btn primary",onclick:save,text:"Receive Goods"})]});
    const poSel=UI.$("#r_po");
    // scanning a received item jumps to its line on the current PO
    attachScan(UI.$("#r_scan"), (found)=>{
      const po=ENG.data.purchaseorders.find(p=>p.id===poSel.value);
      const idx=(po.lines||[]).findIndex(l=>l.itemId===found.id);
      if(idx<0){ toast(found.name+" is not on "+po.id,{type:"warn"}); return; }
      const q=UI.$("#r_qty_"+idx); if(q){ q.focus(); if(q.select) q.select(); }
    });
    function renderLines(){
      const po=ENG.data.purchaseorders.find(p=>p.id===poSel.value);
      const host=UI.$("#r_lines"); host.innerHTML="";
      po.lines.forEach((l,idx)=>{
        const pend=+(l.qty-(l.recd||0)).toFixed(3), it=ENG.item(l.itemId)||{};
        host.appendChild(h("div",{class:"flex gap",style:"margin-bottom:8px;align-items:center"+(pend<=0?";opacity:.5":"")},[
          h("div",{style:"flex:2;min-width:0"},[
            h("div",{class:"cell-main",text:trim(it.name||l.itemId,30)}),
            h("div",{class:"cell-sub",text:l.itemId+" · ordered "+ENG.num(l.qty)+", pending "+ENG.num(pend)}),
          ]),
          h("input",{class:"input",id:"r_qty_"+idx,type:"number",step:"0.001",style:"flex:1",value:pend>0?pend:0}),
          h("div",{class:"muted",style:"flex:1;font-size:12px",text:"@ ₹"+ENG.num(l.rate,2)+" / "+(it.uom||"")})
        ]));
      });
    }
    poSel.onchange=renderLines; renderLines();
    function save(){
      const po=ENG.data.purchaseorders.find(p=>p.id===poSel.value);
      const wh=UI.$("#r_wh").value, date=DB.helpers.iso(DB.helpers.today());
      const recvLines=[]; let posted=0;
      po.lines.forEach((l,idx)=>{
        const el=UI.$("#r_qty_"+idx); let rq=+((el&&el.value)||0);
        const pend=l.qty-(l.recd||0);
        if(rq>pend) rq=pend;
        if(rq>0){
          recvLines.push({i:idx, qty:rq});
          ENG.data.movements.push({id:genMoveId()+"-"+l.itemId, date, itemId:l.itemId, wh, type:"GRN",
            qty:rq, rate:l.rate, ref:po.id, note:"Goods receipt vs PO", supplierId:po.supplierId, by:(App.user&&App.user.username)||"user"});
          l.recd=+((l.recd||0)+rq).toFixed(3); posted++;
        }
      });
      if(!posted){ toast("Enter a quantity to receive on at least one line",{type:"warn"}); return; }
      po.status = po.lines.every(l=>(l.recd||0) >= l.qty-0.0001) ? "Received" : "Partially Received";
      mo.close();
      toast(`${po.id} — goods received, stock updated`,{type:"ok",title:"GRN posted"});
      App.saveDelta(()=>DB.purchase.receive(po.id,{wh, date, lines:recvLines}));
    }
  }

  /* ----- FEATURE 2: add stock manually (existing item OR create new) ----- */
  function addStockForm(){
    const items=ENG.data.items, whs=ENG.data.warehouses;
    const body=h("div",{},[
      h("p",{class:"dim",style:"margin-bottom:12px",text:"Scan a barcode or pick an item (or create a new one), review or edit its parameters, then enter the quantity to receive. The parameters are saved to the item; the quantity posts to the ledger."}),
      h("div",{class:"form-grid"},[
        field("Scan / Barcode",`<input class="input" id="s_scan" placeholder="Scan or type barcode / item code, then press Enter">`,"full"),
        field("Item", selectHTML("s_item",[{v:"__new",l:"➕ Create new item…"}].concat(items.map(i=>({v:i.id,l:trim(i.id+" — "+i.name,40)}))),"__new")),
      ]),
      h("h3",{style:"margin:14px 0 8px;font-size:13px",text:"Item parameters"}),
      h("div",{id:"s_newblock"},[
        h("div",{class:"form-grid"},[
          field("Item Code",`<input class="input" id="s_code" placeholder="Auto if left blank (e.g. RM-1001)">`),
          field("Item Name",`<input class="input" id="s_name" placeholder="e.g. Copper Foil 0.05mm">`),
          field("Category",selectHTML("s_cat",ENG.data.categories.map(c=>({v:c.id,l:c.name})),"RM")),
          field("Unit (per)",selectHTML("s_uom",UNITS,"KG")),
          field("Thickness (mm)",`<input class="input" id="s_thk" type="number" step="0.001" placeholder="e.g. 0.05">`),
          field("Width (mm)",`<input class="input" id="s_wid" type="number" step="0.1" placeholder="e.g. 25">`),
          field("Length (m)",`<input class="input" id="s_len" type="number" step="0.1" placeholder="e.g. 1000">`),
          field("Reorder Point",`<input class="input" id="s_reorder" type="number" value="0">`),
          field("Safety Stock",`<input class="input" id="s_safety" type="number" value="0">`),
          field("Lead Time (days)",`<input class="input" id="s_lead" type="number" value="7">`),
          field("Std Cost (₹)",`<input class="input" id="s_cost" type="number" disabled placeholder="= Rate (set automatically)">`),
          field("Selling Price (₹)",`<input class="input" id="s_price" type="number" value="0">`),
          field("HSN Code",`<input class="input" id="s_hsn" placeholder="e.g. 74102100">`),
        ])
      ]),
      h("h3",{style:"margin:16px 0 8px;font-size:13px",text:"Stock to receive"}),
      h("div",{class:"form-grid",style:"margin-top:4px"},[
        field("Quantity",`<input class="input" id="s_qty" type="number" step="0.001" placeholder="0">`),
        field("Rate (₹ per unit)",`<input class="input" id="s_rate" type="number" step="0.01" placeholder="0">`),
        field("Warehouse",selectHTML("s_wh",whs.map(w=>({v:w.id,l:w.name})),whs[0]&&whs[0].id)),
      ])
    ]);
    const mo=modal({title:"Add Stock", sub:"Add / update an item and post a receipt", wide:true, body,
      foot:[h("button",{class:"btn ghost",onclick:()=>mo.close(),text:"Cancel"}),
        h("button",{class:"btn primary",onclick:save,text:"Add to Inventory"})]});
    const sel=UI.$("#s_item");
    const setVal=(id,v)=>{const el=UI.$("#"+id); if(el) el.value=v;};
    const setSel=(id,v)=>{const el=UI.$("#"+id); if(!el) return;
      if(v!=null && ![...el.options].some(o=>o.value===String(v))) el.appendChild(new Option(String(v),String(v)));
      el.value=v;};
    /* show the full parameter set for BOTH new and existing items;
       pre-fill from the selected item so any material can be edited here */
    function fillParams(){
      const code=UI.$("#s_code"), catEl=UI.$("#s_cat");
      if(sel.value==="__new"){
        code.disabled=false; code.placeholder="Auto if left blank (e.g. RM-1001)";
        if(catEl) catEl.disabled=false;   // category editable only while creating
        setVal("s_code",""); setVal("s_name",""); setSel("s_cat","RM"); setSel("s_uom","KG");
        setVal("s_thk",""); setVal("s_wid",""); setVal("s_len","");
        setVal("s_reorder","0"); setVal("s_safety","0"); setVal("s_lead","7");
        setVal("s_cost",""); setVal("s_price","0"); setVal("s_hsn","");
      } else {
        const it=ENG.item(sel.value)||{};
        code.disabled=true; setVal("s_code",it.id||"");
        if(catEl) catEl.disabled=true;    // locked once the item exists
        setVal("s_name",it.name||""); setSel("s_cat",it.cat||"RM"); setSel("s_uom",it.uom||"KG");
        setVal("s_thk",it.thickness!=null?it.thickness:""); setVal("s_wid",it.width!=null?it.width:""); setVal("s_len",it.length!=null?it.length:"");
        setVal("s_reorder",it.reorder!=null?it.reorder:"0"); setVal("s_safety",it.safety!=null?it.safety:"0"); setVal("s_lead",it.lead!=null?it.lead:"7");
        setVal("s_cost",it.cost!=null?it.cost:""); setVal("s_price",it.price!=null?it.price:"0"); setVal("s_hsn",it.hsn||"");
      }
    }
    sel.onchange=fillParams; fillParams();
    /* Std Cost always tracks the entered Rate (rate drives cost) */
    const rateEl=UI.$("#s_rate"), costEl=UI.$("#s_cost");
    if(rateEl&&costEl) rateEl.addEventListener("input",()=>{ costEl.value=rateEl.value; });
    /* barcode scan: match by barcode or item code, select it, jump to qty */
    attachScan(UI.$("#s_scan"), (found)=>{ setSel("s_item",found.id); fillParams(); const q=UI.$("#s_qty"); if(q) q.focus(); });
    function save(){
      const g=id=>{const el=UI.$("#"+id); return el?el.value:"";};
      const qty=+g("s_qty"), rate=+g("s_rate")||0, wh=g("s_wh");
      if(!qty || isNaN(qty) || qty<=0){ toast("Enter a quantity greater than zero",{type:"warn"}); return; }
      let itemId=sel.value, it;
      if(itemId==="__new"){
        const name=g("s_name").trim();
        if(!name){ toast("Item name is required for a new item",{type:"warn"}); return; }
        const cat=g("s_cat");
        let code=g("s_code").trim().toUpperCase();
        if(code && ENG.item(code)){ toast("Item code already exists — choose another",{type:"danger"}); return; }
        itemId=code||genItemId(cat);
        it={ id:itemId, name, cat, uom:g("s_uom"),
          thickness:+g("s_thk")||null, width:+g("s_wid")||null, length:+g("s_len")||null,
          reorder:+g("s_reorder")||0, safety:+g("s_safety")||0, lead:+g("s_lead")||7,
          cost:rate||+g("s_cost")||0, price:+g("s_price")||0, hsn:g("s_hsn").trim(), abc:"C", moq:0, active:true,
          barcode:"890"+Math.floor(Math.random()*1e7) };
        ENG.data.items.push(it);
      } else {
        it=ENG.item(itemId);
        /* apply edited parameters back to the existing item (category stays locked) */
        it.name=g("s_name").trim()||it.name;
        it.uom=g("s_uom")||it.uom;
        it.thickness=+g("s_thk")||null; it.width=+g("s_wid")||null; it.length=+g("s_len")||null;
        it.reorder=+g("s_reorder")||0; it.safety=+g("s_safety")||0; it.lead=+g("s_lead")||7;
        it.cost=rate||it.cost||0; it.price=+g("s_price")||0; it.hsn=g("s_hsn").trim();
      }
      const move={ id:genMoveId(), date:DB.helpers.iso(DB.helpers.today()),
        itemId, wh, type:"GRN", qty, rate, ref:"MANUAL-"+Math.floor(Math.random()*9000+1000),
        note:"Manual stock addition", by:(App.user&&App.user.username)||"user" };
      ENG.data.movements.push(move);
      mo.close();
      toast(`${ENG.num(qty,2)} ${it.uom} added to ${it.name}`,{type:"ok",title:"Stock added"});
      App.saveDelta(async()=>{ await DB.items.put(it); await DB.movements.add(move); });
    }
  }

  /* ============== STOCK LEDGER ============== */
  M.ledger = { title:"Stock Ledger", sub:"Every movement, running balance", render(root, params){
    let filter={q:params&&params.item?params.item:"", type:"all", wh:"all", from:"", to:""};
    root.appendChild(pageHead("Stock Ledger","Complete audit trail — receipts, issues, production, sales & adjustments with auto running balance",[
      h("button",{class:"btn",onclick:()=>adjForm(),html:"⚖ Stock Adjustment"}),
    ]));
    const tableHost=h("div");
    const bar=h("div",{class:"toolbar"},[
      MW.searchInput("Search item, reference…", v=>{filter.q=v.toLowerCase();draw();}),
      MW.select([{value:"all",label:"All Types"},...["OPEN","GRN","ISSUE","PROD","SALE","ADJ","RET","SCRAP","XFER"].map(t=>({value:t,label:typeLabel(t)}))], v=>{filter.type=v;draw();}),
      MW.select([{value:"all",label:"All Warehouses"},...ENG.data.warehouses.map(w=>({value:w.id,label:w.name}))], v=>{filter.wh=v;draw();}),
      MW.dateRange(filter, draw, {label:"Movement Date"}),
      h("div",{style:"margin-left:auto"},h("span",{class:"chip",id:"ledCount"}))
    ]);
    if(filter.q){ bar.querySelector("input").value=filter.q; }
    root.appendChild(bar); root.appendChild(tableHost);

    function draw(){
      let data=ENG.data.movements.slice().reverse();
      data=data.filter(m=>{
        if(filter.type!=="all"&&m.type!==filter.type) return false;
        if(filter.wh!=="all"&&m.wh!==filter.wh) return false;
        if(!MW.inDateRange(m.date, filter)) return false;
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
        field("Scan / Barcode",`<input class="input" id="a_scan" placeholder="Scan or type barcode / item code, then press Enter">`,"full"),
        field("Item",selectHTML("a_item",items.map(i=>({v:i.id,l:i.id+" — "+trim(i.name,30)})),items[0].id)),
        field("Warehouse",selectHTML("a_wh",ENG.data.warehouses.map(w=>({v:w.id,l:w.name})),"WH-PNY")),
        field("Adjustment Type",selectHTML("a_type",[{v:"ADJ",l:"Adjustment (+/-)"},{v:"SCRAP",l:"Scrap (-)"} ,{v:"RET",l:"Return (+)"}],"ADJ")),
        field("Quantity (use - to reduce)",`<input class="input" id="a_qty" type="number" value="0">`),
        field("Reason / Note",`<input class="input" id="a_note" placeholder="e.g. Cycle count variance">`,"full"),
      ]);
      const mo=modal({title:"Stock Adjustment", sub:"Posts an audited ledger entry", body,
        foot:[h("button",{class:"btn ghost",onclick:()=>mo.close(),text:"Cancel"}),
          h("button",{class:"btn primary",onclick:save,text:"Post Entry"})]});
      attachScan(UI.$("#a_scan"), (found)=>{ selectSet("a_item",found.id); const q=UI.$("#a_qty"); if(q) q.focus(); });
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
        const move={id:genMoveId(), date:DB.helpers.iso(DB.helpers.today()), itemId:id,
          wh:UI.$("#a_wh").value, type:UI.$("#a_type").value, qty, rate:it.cost,
          ref:UI.$("#a_type").value+"-"+Math.floor(Math.random()*9000+1000), note:UI.$("#a_note").value||"Manual adjustment", by:(App.user&&App.user.username)||"user"};
        ENG.data.movements.push(move);
        mo.close(); toast("Ledger entry posted",{type:"ok"});
        App.saveDelta(()=>DB.movements.add(move));
      }
    }
  }};

  /* ============== WAREHOUSES ============== */
  M.warehouses = { title:"Warehouses", sub:"Stock by location", render(root){
    root.appendChild(pageHead("Warehouses","Stock distribution across plant locations",[
      h("button",{class:"btn primary",onclick:()=>transferForm(),html:"🔀 Move Stock"})
    ]));
    const grid=h("div",{class:"grid cols-2"});
    ENG.data.warehouses.forEach(w=>{
      let val=0, items=0;
      ENG.data.items.forEach(it=>{ const q=ENG.stock(it.id).byWh[w.id]||0; if(q>0.001){ val+=q*ENG.stock(it.id).avgCost; items++; } });
      const top=ENG.data.items.map(it=>({it,q:ENG.stock(it.id).byWh[w.id]||0})).filter(x=>x.q>0.001).sort((a,b)=>b.q-a.q).slice(0,5);
      grid.appendChild(h("div",{class:"card hover",style:"cursor:pointer",onclick:()=>whDetail(w),title:"Click to view all materials in "+w.name},[
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
        ])):[h("div",{class:"muted",text:"Empty"})]),
        h("div",{class:"muted",style:"font-size:11.5px;margin-top:10px;text-align:right",text:"View all materials →"})
      ]));
    });
    root.appendChild(grid);

    /* drill-down: every material held in this warehouse */
    function whDetail(w){
      const rows=ENG.data.items.map(it=>{
        const st=ENG.stock(it.id), q=st.byWh[w.id]||0;
        return {it, q, cost:st.avgCost, val:q*st.avgCost};
      }).filter(r=>r.q>0.001).sort((a,b)=>b.val-a.val);
      const totalVal=rows.reduce((s,r)=>s+r.val,0);

      let q="";
      const tableHost=h("div",{style:"max-height:56vh;overflow:auto"});
      const countChip=h("span",{class:"chip"});
      function draw(){
        const data=q?rows.filter(r=>(r.it.name+" "+r.it.id+" "+r.it.cat).toLowerCase().includes(q)):rows;
        countChip.textContent=data.length+" materials · "+ENG.money(totalVal)+" total";
        tableHost.innerHTML="";
        tableHost.appendChild(table(data,[
          {key:"item",label:"Material",render:r=>`<div class="cell-main">${esc(trim(r.it.name,36))}</div><div class="cell-sub">${r.it.id}</div>`,sort:r=>r.it.name},
          {key:"cat",label:"Category",render:r=>`<span class="muted">${esc(catName(r.it.cat))}</span>`,sort:r=>r.it.cat},
          {key:"qty",label:"Quantity",num:true,render:r=>`<span style="font-weight:700">${ENG.num(r.q,2)}</span> <span class="muted">${esc(r.it.uom||"")}</span>`,sort:r=>r.q},
          {key:"cost",label:"Avg Cost",num:true,render:r=>"₹"+ENG.num(r.cost,2),sort:r=>r.cost},
          {key:"val",label:"Value",num:true,render:r=>ENG.money(r.val),sort:r=>r.val},
          {key:"share",label:"Share",num:true,render:r=>totalVal>0?ENG.num(r.val/totalVal*100,1)+"%":"—",sort:r=>r.val},
        ],{empty:q?"No materials match":"No stock in this warehouse"}));
      }
      const body=h("div",{},[
        h("div",{class:"toolbar",style:"margin-bottom:10px"},[
          MW.searchInput("Search material, code, category…", v=>{q=v.toLowerCase();draw();}),
          h("div",{style:"margin-left:auto"},countChip)
        ]),
        tableHost
      ]);
      const mo=modal({title:whIcon(w.type)+" "+w.name, sub:w.city+" · "+w.type+" — all materials on hand", body,
        foot:[h("button",{class:"btn ghost",onclick:()=>mo.close(),text:"Close"})]});
      draw();
    }

    /* move stock from one warehouse to another (posts a linked out/in pair) */
    function transferForm(){
      const whs=ENG.data.warehouses;
      if(whs.length<2){ toast("Need at least two warehouses to move stock",{type:"warn"}); return; }
      const items=ENG.data.items;
      const itemOpts=items.map(i=>({v:i.id,l:i.id+" — "+trim(i.name,34)}));
      const body=h("div",{},[
        h("div",{class:"form-grid"},[
          field("From Warehouse", selectHTML("t_from", whs.map(w=>({v:w.id,l:w.name})), whs[0].id)),
          field("To Warehouse", selectHTML("t_to", whs.map(w=>({v:w.id,l:w.name})), whs[1].id)),
          field("Material", searchSelect("t_item", itemOpts, items[0]&&items[0].id, "Search material / code…"), "full"),
          field("Quantity to move", `<input class="input" id="t_qty" type="number" step="0.001" min="0" value="0">`),
          field("Note (optional)", `<input class="input" id="t_note" placeholder="e.g. Rebalancing stock">`),
        ]),
        h("div",{id:"t_avail",class:"muted",style:"margin-top:2px;font-size:12.5px"})
      ]);
      const mo=modal({title:"Move Stock Between Warehouses", sub:"Transfers on-hand quantity — total stock & valuation stay the same", body,
        foot:[h("button",{class:"btn ghost",onclick:()=>mo.close(),text:"Cancel"}),
          h("button",{class:"btn primary",onclick:save,text:"Move Stock"})]});
      function avail(){
        const id=UI.$("#t_item").value, from=UI.$("#t_from").value, it=ENG.item(id)||{};
        const q=((ENG.stock(id)||{byWh:{}}).byWh[from])||0;
        UI.$("#t_avail").innerHTML = id ? `Available in <b>${esc(whName(from))}</b>: <b>${ENG.num(q,2)} ${esc(it.uom||"")}</b>` : "";
      }
      UI.$("#t_from").onchange=avail; UI.$("#t_item").onchange=avail; avail();
      function save(){
        const from=UI.$("#t_from").value, to=UI.$("#t_to").value, id=UI.$("#t_item").value;
        const qty=+UI.$("#t_qty").value, note=UI.$("#t_note").value.trim();
        if(from===to){ toast("Source and destination must be different",{type:"warn"}); return; }
        if(!id){ toast("Pick a material to move",{type:"warn"}); return; }
        if(!qty || isNaN(qty) || qty<=0){ toast("Enter a quantity greater than zero",{type:"warn"}); return; }
        const it=ENG.item(id), have=((ENG.stock(id)||{byWh:{}}).byWh[from])||0;
        if(qty > have+0.0001){ toast(`Only ${ENG.num(have,2)} ${it.uom||""} available in ${whName(from)}`,{type:"warn",title:"Not enough stock"}); return; }
        const date=DB.helpers.iso(DB.helpers.today()), ref="TRF-"+Math.floor(Math.random()*9000+1000);
        const cost=ENG.stock(id).avgCost, by=(App.user&&App.user.username)||"user";
        const outMove={id:genMoveId()+"-O", date, itemId:id, wh:from, type:"XFER", qty:-qty, rate:cost, ref, note:"Transfer → "+whName(to)+(note?" · "+note:""), by};
        const inMove ={id:genMoveId()+"-I", date, itemId:id, wh:to,   type:"XFER", qty: qty, rate:cost, ref, note:"Transfer ← "+whName(from)+(note?" · "+note:""), by};
        ENG.data.movements.push(outMove, inMove);
        mo.close();
        toast(`Moved ${ENG.num(qty,2)} ${it.uom||""}: ${whName(from)} → ${whName(to)}`,{type:"ok",title:"Stock transferred"});
        App.saveDelta(async()=>{ await DB.movements.add(outMove); await DB.movements.add(inMove); });
      }
    }
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
  function moveBadge(t){ const m={OPEN:"s-mut",GRN:"s-ok",ISSUE:"s-warn",PROD:"s-info",SALE:"s-violet",ADJ:"s-mut",RET:"s-ok",SCRAP:"s-danger",XFER:"s-info"};
    return `<span class="badge-s ${m[t]||"s-mut"}">${esc(typeLabel(t))}</span>`; }
  function typeLabel(t){ return {OPEN:"Opening",GRN:"Receipt",ISSUE:"Issue",PROD:"Production",SALE:"Sale",ADJ:"Adjust",RET:"Return",SCRAP:"Scrap",XFER:"Transfer"}[t]||t; }
  function catName(id){ return (ENG.data.categories.find(c=>c.id===id)||{}).name||id; }
  function whName(id){ return (ENG.data.warehouses.find(w=>w.id===id)||{}).name||id; }
  function whIcon(t){ return {"Raw Material":"🧱","WIP":"⚙️","Finished Goods":"🎁","Quarantine":"🔬"}[t]||"🏬"; }
  function trim(s,n){ s=String(s||""); return s.length>n?s.slice(0,n-1)+"…":s; }
  /* collision-free sequential id: take the highest numeric suffix already in
     use (NOT list.length, which drops after a delete and reuses live ids) and
     add 1, preserving the widest zero-pad width seen. */
  function nextSeqId(list, prefix){
    let max=0, width=3;
    (list||[]).forEach(x=>{ const m=/(\d+)\s*$/.exec(String((x&&x.id)||"")); if(m){ max=Math.max(max,+m[1]); width=Math.max(width,m[1].length); } });
    return prefix+String(max+1).padStart(width,"0");
  }
  /* unique ledger movement id (Date.now alone collides within a millisecond) */
  function genMoveId(){ return "MV-"+Date.now()+"-"+Math.floor(Math.random()*1e4); }
  /* shared barcode-scan handler: on Enter, match a scanned string against an
     item's barcode or code, clear the field and hand the item to onMatch.
     Used by Add Stock, Receive-via-PO and Stock Adjustment. */
  function attachScan(scanEl, onMatch){
    if(!scanEl) return;
    scanEl.addEventListener("keydown",e=>{
      if(e.key!=="Enter") return; e.preventDefault();
      const raw=scanEl.value.trim(); if(!raw) return;
      const v=raw.toLowerCase();
      const found=ENG.data.items.find(i=>String(i.barcode||"").toLowerCase()===v || String(i.id).toLowerCase()===v);
      if(found){ scanEl.value=""; onMatch(found); toast("Matched "+found.name,{type:"ok"}); }
      else toast("No item matches “"+raw+"”",{type:"warn"});
    });
    setTimeout(()=>{ try{ scanEl.focus(); }catch{} },40);
  }
  /* set a <select> to a value, adding the option if it isn't listed */
  function selectSet(id,v){ const el=UI.$("#"+id); if(!el) return;
    if(v!=null && ![...el.options].some(o=>o.value===String(v))) el.appendChild(new Option(String(v),String(v)));
    el.value=v; }
  function cssv(v){ return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }
  function last30Series(id){ const t=DB.helpers.today().getTime(); const labels=[],bal=[];
    const led=ENG.ledger(id); 
    for(let i=29;i>=0;i--){ const d=DB.helpers.iso(t-i*DB.helpers.DAY); labels.push(d);
      let b=0; for(const m of led){ if(m.date<=d) b=m.balance; else break; } bal.push(+b.toFixed(2)); }
    return {labels,bal}; }
  function downloadCSV(name,content){ const blob=new Blob([content],{type:"text/csv"}); const url=URL.createObjectURL(blob);
    const a=document.createElement("a"); a.href=url; a.download=name; a.click(); URL.revokeObjectURL(url); }

  /* ---------- searchable select (drop-in replacement for selectHTML) ----------
     Renders a type-to-filter combobox. A hidden <input id="ID"> holds the
     selected VALUE (so existing `UI.$("#ID").value` reads + "change" listeners
     keep working); a visible text box (#ID_s) filters the options. One delegated
     controller (installed once) drives every widget. The popup is position:fixed
     so it escapes the modal's overflow:auto clipping. */
  const _ssOpts = new Map();   // id -> [{v,l}]
  function searchSelect(id, opts, sel, placeholder){
    opts = (opts||[]).map(o=>({v:String(o.v), l:String(o.l)}));
    _ssOpts.set(id, opts);
    const selStr = sel==null ? "" : String(sel);
    const cur = opts.find(o=>o.v===selStr);
    return `<div class="ss" data-ss="${esc(id)}">`
      + `<input type="hidden" id="${esc(id)}" value="${esc(selStr)}">`
      + `<input type="text" class="input ss-input" id="${esc(id)}_s" autocomplete="off" spellcheck="false"`
      + ` role="combobox" aria-autocomplete="list" aria-expanded="false"`
      + ` placeholder="${esc(placeholder||"Search…")}" value="${esc(cur?cur.l:"")}">`
      + `<div class="ss-pop" hidden></div></div>`;
  }
  function ssHidden(wrap){ return wrap.querySelector('input[type="hidden"]'); }
  function ssInput(wrap){ return wrap.querySelector(".ss-input"); }
  function ssPosition(wrap){
    const inp=ssInput(wrap), pop=wrap.querySelector(".ss-pop");
    if(!inp||!pop||pop.hidden) return;
    const r=inp.getBoundingClientRect();
    const popH=Math.min(240, pop.scrollHeight||240);
    const below=window.innerHeight-r.bottom;
    pop.style.width=r.width+"px"; pop.style.left=r.left+"px";
    if(below < popH+8 && r.top > below){ pop.style.top="auto"; pop.style.bottom=(window.innerHeight-r.top+4)+"px"; }
    else { pop.style.bottom="auto"; pop.style.top=(r.bottom+4)+"px"; }
  }
  function ssOpen(wrap, filter){
    const opts=_ssOpts.get(wrap.getAttribute("data-ss"))||[];
    const pop=wrap.querySelector(".ss-pop"), hid=ssHidden(wrap);
    const q=String(filter||"").toLowerCase().trim();
    const list=q ? opts.filter(o=>o.l.toLowerCase().includes(q)||o.v.toLowerCase().includes(q)) : opts;
    pop.innerHTML = list.length
      ? list.slice(0,300).map(o=>`<div class="ss-opt${o.v===hid.value?" sel":""}" data-v="${esc(o.v)}">${esc(o.l)}</div>`).join("")
      : `<div class="ss-empty">No match</div>`;
    pop.hidden=false; ssInput(wrap).setAttribute("aria-expanded","true"); ssPosition(wrap);
  }
  function ssClose(wrap, reconcile){
    const pop=wrap.querySelector(".ss-pop"); if(pop) pop.hidden=true;
    const inp=ssInput(wrap); if(inp) inp.setAttribute("aria-expanded","false");
    if(reconcile!==false){ // restore the search box text to the selected value's label
      const cur=(_ssOpts.get(wrap.getAttribute("data-ss"))||[]).find(o=>o.v===ssHidden(wrap).value);
      if(inp) inp.value=cur?cur.l:"";
    }
  }
  function ssPick(wrap, v){
    const hid=ssHidden(wrap), inp=ssInput(wrap);
    const cur=(_ssOpts.get(wrap.getAttribute("data-ss"))||[]).find(o=>o.v===String(v));
    hid.value=String(v); if(inp) inp.value=cur?cur.l:"";
    ssClose(wrap, false);
    hid.dispatchEvent(new Event("change",{bubbles:true}));  // keep existing change listeners working
  }
  let _ssWired=false;
  function ssWire(){
    if(_ssWired||typeof document==="undefined") return; _ssWired=true;
    document.addEventListener("input", e=>{ const inp=e.target.closest&&e.target.closest(".ss-input"); if(inp) ssOpen(inp.closest(".ss"), inp.value); });
    document.addEventListener("focusin", e=>{ const inp=e.target.closest&&e.target.closest(".ss-input"); if(inp){ try{inp.select();}catch{} ssOpen(inp.closest(".ss"), ""); } });
    document.addEventListener("mousedown", e=>{
      const opt=e.target.closest&&e.target.closest(".ss-opt");
      if(opt){ e.preventDefault(); ssPick(opt.closest(".ss"), opt.getAttribute("data-v")); return; }
      const inside=e.target.closest&&e.target.closest(".ss");
      document.querySelectorAll(".ss").forEach(w=>{ if(w!==inside){ const p=w.querySelector(".ss-pop"); if(p&&!p.hidden) ssClose(w); } });
    });
    document.addEventListener("keydown", e=>{
      const inp=e.target.closest&&e.target.closest(".ss-input"); if(!inp) return;
      const wrap=inp.closest(".ss"), pop=wrap.querySelector(".ss-pop");
      if(e.key==="Escape"){ ssClose(wrap); return; }
      if(pop.hidden && (e.key==="ArrowDown"||e.key==="ArrowUp")){ ssOpen(wrap, inp.value); return; }
      if(pop.hidden) return;
      const items=[...pop.querySelectorAll(".ss-opt")]; if(!items.length) return;
      let i=items.findIndex(o=>o.classList.contains("act"));
      if(e.key==="ArrowDown"){ e.preventDefault(); i=Math.min(items.length-1,i+1); }
      else if(e.key==="ArrowUp"){ e.preventDefault(); i=Math.max(0,i<0?0:i-1); }
      else if(e.key==="Enter"){ if(i>=0){ e.preventDefault(); ssPick(wrap, items[i].getAttribute("data-v")); } return; }
      else return;
      items.forEach(o=>o.classList.remove("act")); if(items[i]){ items[i].classList.add("act"); items[i].scrollIntoView({block:"nearest"}); }
    });
    const reflow=()=>document.querySelectorAll(".ss").forEach(w=>{ const p=w.querySelector(".ss-pop"); if(p&&!p.hidden) ssPosition(w); });
    window.addEventListener("scroll", reflow, true);  // capture → catches modal-body scroll
    window.addEventListener("resize", reflow);
  }
  ssWire();

  // expose for other modules
  window._erpUtil = Object.assign(window._erpUtil||{}, {field, selectHTML, searchSelect, downloadCSV, trim, catName, moveBadge, nextSeqId, genMoveId});

  // register quick actions for the ⌘K command palette
  window.ERPActions = Object.assign(window.ERPActions||{}, {
    addStock:    { ic:"📦", label:"Add Stock",             run:()=>addStockForm() },
    receivePO:   { ic:"🚚", label:"Receive via PO",        run:()=>receiveStockForm() },
    newItem:     { ic:"＋", label:"New Item",               run:()=>itemForm() },
  });
})();
