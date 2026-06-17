/* ============================================================
   CHHAPERIA ERP — REPORTS & SETTINGS
   ============================================================ */
(function () {
  "use strict";
  const {h, esc, table, badge, toast, modal, confirm} = UI;
  const {pageHead, kpi} = MW;
  const U = window._erpUtil;

  /* ============== REPORTS ============== */
  M.reports = { title:"Reports", sub:"Exportable business reports", render(root){
    root.appendChild(pageHead("Reports & Exports","Generate and download key operational reports"));

    const reports=[
      {ic:"📦",name:"Stock Valuation Report",desc:"On-hand qty, avg cost & total value per item",accent:"--c1",fn:repStock},
      {ic:"🔻",name:"Reorder / Low-Stock Report",desc:"Items below reorder with suggested order qty",accent:"--c6",fn:repReorder},
      {ic:"📒",name:"Stock Movement Ledger",desc:"Full transaction history with running balance",accent:"--c7",fn:repLedger},
      {ic:"🛒",name:"Open Purchase Orders",desc:"Pending inbound goods & values by supplier",accent:"--c2",fn:repPO},
      {ic:"🧾",name:"Sales Order Backlog",desc:"Open demand, promised dates & fulfillability",accent:"--c8",fn:repSO},
      {ic:"🧬",name:"BOM Cost Roll-up",desc:"Material cost & margin for each finished tape",accent:"--c3",fn:repBOM},
      {ic:"📊",name:"ABC Classification",desc:"Pareto inventory ranking by consumption value",accent:"--c5",fn:repABC},
      {ic:"⚙️",name:"Production Output Report",desc:"Work orders, output & yield over time",accent:"--c4",fn:repProd},
    ];
    const grid=h("div",{class:"grid cols-3"});
    reports.forEach(r=>{
      grid.appendChild(h("div",{class:"card hover",style:"cursor:pointer",onclick:r.fn},[
        h("div",{class:"kpi-ic",style:`background:color-mix(in srgb, var(${r.accent}) 16%, transparent);color:var(${r.accent})`,text:r.ic}),
        h("h3",{style:"font-size:14.5px;margin-top:12px",text:r.name}),
        h("div",{class:"muted",style:"font-size:12px;margin-top:4px;line-height:1.5",text:r.desc}),
        h("div",{class:"flex gap",style:"margin-top:14px"},[
          h("button",{class:"btn sm",onclick:e=>{e.stopPropagation();r.fn();},html:"👁 Preview"}),
          h("button",{class:"btn sm primary",onclick:e=>{e.stopPropagation();r.fn(true);},html:"⬇ CSV"})
        ])
      ]));
    });
    root.appendChild(grid);

    /* preview / export engine */
    function show(title, head, rows, csvName){
      const csv=()=>{ const c=[head.join(",")].concat(rows.map(r=>r.map(x=>typeof x==="string"&&x.includes(",")?'"'+x+'"':x).join(","))).join("\n");
        U.downloadCSV(csvName, c); toast(title+" exported",{type:"ok",title:"Download started"}); };
      const cols=head.map((hd,i)=>({key:"c"+i,label:hd,num:i>0&&!isNaN(parseFloat(rows[0]&&rows[0][i])),render:r=>esc(String(r["c"+i]==null?"—":r["c"+i])),noSort:false,sort:r=>r["c"+i]}));
      const data=rows.map(r=>{const o={};head.forEach((_,i)=>o["c"+i]=r[i]);return o;});
      modal({title, sub:rows.length+" rows", wide:true,
        body:table(data,cols,{empty:"No data"}),
        foot:[h("button",{class:"btn primary",onclick:csv,html:"⬇ Download CSV"})]});
      return csv;
    }
    function repStock(dl){ const rows=ENG.data.items.map(it=>{const s=ENG.stock(it.id);return [it.id,it.name,U.catName(it.cat),it.uom,s.onHand.toFixed(2),s.avgCost.toFixed(2),s.value.toFixed(0)];});
      const c=show("Stock Valuation Report",["Code","Name","Category","UoM","OnHand","AvgCost","Value"],rows,"stock_valuation.csv"); if(dl===true)c(); }
    function repReorder(dl){ const rows=ENG.data.items.map(it=>({it,st:ENG.status(it.id)})).filter(x=>x.st.suggest>0||["warn","danger"].includes(x.st.state))
        .map(x=>[x.it.id,x.it.name,x.st.onHand.toFixed(1),x.it.reorder,x.it.safety,x.st.suggest,x.st.label,ENG.sup(x.it.supplierId)]);
      const c=show("Reorder / Low-Stock Report",["Code","Name","OnHand","ReorderPt","Safety","Suggested","Status","Supplier"],rows,"reorder_report.csv"); if(dl===true)c(); }
    function repLedger(dl){ const rows=ENG.data.movements.slice(-300).reverse().map(m=>{const it=ENG.item(m.itemId)||{};return [m.date,m.itemId,(it.name||"").slice(0,30),m.type,m.ref||"",m.qty,m.balance!=null?m.balance:""];});
      const c=show("Stock Movement Ledger",["Date","Code","Name","Type","Ref","Qty","Balance"],rows,"stock_ledger.csv"); if(dl===true)c(); }
    function repPO(dl){ const rows=ENG.data.purchaseorders.filter(p=>p.status!=="Received").map(p=>[p.id,ENG.sup(p.supplierId),p.lines.length,p.value.toFixed(0),p.date,p.eta,p.status]);
      const c=show("Open Purchase Orders",["PO","Supplier","Lines","Value","Ordered","ETA","Status"],rows,"open_po.csv"); if(dl===true)c(); }
    function repSO(dl){ const rows=ENG.data.salesorders.filter(s=>s.status!=="Dispatched").map(s=>[s.id,ENG.custName(s.customerId),s.lines.length,s.value.toFixed(0),s.priority,s.promised,s.status]);
      const c=show("Sales Order Backlog",["SO","Customer","Lines","Value","Priority","Promised","Status"],rows,"so_backlog.csv"); if(dl===true)c(); }
    function repBOM(dl){ const rows=ENG.data.items.filter(i=>i.cat==="FG").map(fg=>{const bom=ENG.data.boms[fg.id];let mc=0;if(bom)bom.lines.forEach(([rid,per])=>mc+=per*ENG.stock(rid).avgCost/bom.yield);
        const margin=fg.price?((fg.price-fg.cost)/fg.price*100).toFixed(1):"0";return [fg.id,fg.name,mc.toFixed(0),fg.cost,fg.price,margin+"%"];});
      const c=show("BOM Cost Roll-up",["Code","Product","MaterialCost","StdCost","Price","Margin"],rows,"bom_costing.csv"); if(dl===true)c(); }
    function repABC(dl){ const rows=ENG.abcAnalysis().map(r=>[r.it.id,r.it.name,r.class,r.annualVal.toFixed(0),r.onHandVal.toFixed(0),r.cumPct.toFixed(1)+"%"]);
      const c=show("ABC Classification",["Code","Name","Class","AnnualValue","OnHandValue","CumulativePct"],rows,"abc_analysis.csv"); if(dl===true)c(); }
    function repProd(dl){ const rows=ENG.data.workorders.slice().reverse().map(w=>{const it=ENG.item(w.itemId)||{};return [w.id,(it.name||"").slice(0,30),w.qty,w.line,w.date,w.due,w.status,w.progress+"%"];});
      const c=show("Production Output Report",["WO","Product","Qty","Line","Start","Due","Status","Progress"],rows,"production_output.csv"); if(dl===true)c(); }
  }};

  /* ============== SETTINGS ============== */
  M.settings = { title:"Settings", sub:"Company & preferences", render(root){
    const org=ENG.data.org;
    root.appendChild(pageHead("Settings","Company profile, appearance and data management"));

    const grid=h("div",{class:"grid cols-2"});

    /* company */
    grid.appendChild(h("div",{class:"card"},[
      h("div",{class:"card-head"},h("h3",{text:"🏭 Company Profile"})),
      MW.dl([
        ["Legal Name",org.name],["Group",org.group||org.short],["Established",org.estd||"—"],
        ["GSTIN",org.gst],["Certification",org.iso],["Website",org.website||"—"],
        ["Phone",org.phone],["Email",org.email],
      ]),
      h("div",{style:"margin-top:14px;padding-top:14px;border-top:1px solid var(--line)"},[
        h("div",{class:"muted",style:"font-size:11px;font-weight:700;text-transform:uppercase;margin-bottom:6px",text:"Registered Address"}),
        h("div",{style:"font-size:13px;line-height:1.6",text:org.address}),
      ]),
      h("div",{style:"margin-top:14px;padding-top:14px;border-top:1px solid var(--line)"},[
        h("div",{class:"muted",style:"font-size:11px;font-weight:700;text-transform:uppercase;margin-bottom:8px",text:"Key Contacts"}),
        ...org.contacts.map(c=>h("div",{class:"flex between",style:"font-size:13px;padding:5px 0"},[
          h("span",{},[h("b",{text:c.name})," · "+c.role]), h("span",{class:"muted",text:c.phone})
        ]))
      ])
    ]));

    /* appearance */
    const accents=["orange","red","blue","teal","violet","green","pink","amber"];
    grid.appendChild(h("div",{class:"card"},[
      h("div",{class:"card-head"},h("h3",{text:"🎨 Appearance"})),
      h("div",{class:"field",style:"margin-bottom:16px"},[
        h("label",{text:"Theme"}),
        h("div",{class:"seg"},[
          h("button",{class:App.theme==="dark"?"on":"",text:"🌙 Dark",onclick:e=>{App.setTheme("dark");refreshSeg(e);}}),
          h("button",{class:App.theme==="light"?"on":"",text:"☀️ Light",onclick:e=>{App.setTheme("light");refreshSeg(e);}}),
        ])
      ]),
      h("div",{class:"field"},[
        h("label",{text:"Accent Colour"}),
        h("div",{class:"swatches",style:"grid-template-columns:repeat(8,1fr)"}, accents.map(a=>{
          const sw=h("div",{class:"swatch"+(App.accent===a?" sel":""),style:`background:var(--${swColor(a)})`,onclick:()=>{App.setAccent(a);[...sw.parentElement.children].forEach(c=>c.classList.remove("sel"));sw.classList.add("sel");}});
          sw.style.setProperty("--x",a); sw.style.background=accentHex(a); return sw;
        }))
      ]),
      h("label",{class:"auto-accent",style:"margin-top:16px"},[
        h("input",{type:"checkbox",checked:App.autoAccent?"checked":null,onchange:e=>App.setAutoAccent(e.target.checked)}),
        " Auto-cycle accent colour per module"
      ]),
      h("div",{class:"muted",style:"font-size:12px;margin-top:8px;line-height:1.5",text:"When enabled, each module adopts its own signature colour for a more dynamic, context-aware interface."})
    ]));
    root.appendChild(grid);

    /* data management */
    root.appendChild(h("div",{class:"card",style:"margin-top:16px"},[
      h("div",{class:"card-head"},h("h3",{text:"💾 Data Management"})),
      h("p",{class:"dim",style:"font-size:13px;margin-bottom:14px;line-height:1.6",text:"All data is stored locally in your browser (offline-ready). You can back it up, restore it, or reset to the seeded demo dataset."}),
      h("div",{class:"flex gap wrap"},[
        h("button",{class:"btn",onclick:backup,html:"⬇ Export Backup (JSON)"}),
        h("button",{class:"btn",onclick:restore,html:"⬆ Restore Backup"}),
        h("button",{class:"btn danger",onclick:reset,html:"↺ Reset to Demo Data"}),
      ])
    ]));

    function refreshSeg(e){ [...e.target.parentElement.children].forEach(c=>c.classList.remove("on")); e.target.classList.add("on"); }
    function swColor(a){ return "accent"; }
    function accentHex(a){ const map={orange:"#F06820",red:"#E84820",blue:"#2f7fe0",teal:"#0fb5ae",violet:"#7c5cff",green:"#16a34a",pink:"#ec4899",amber:"#e0a000"}; return map[a]; }
    function backup(){ const blob=new Blob([JSON.stringify(ENG.data,null,2)],{type:"application/json"});
      const a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download="chhaperia_erp_backup_"+DB.helpers.iso(DB.helpers.today())+".json"; a.click();
      toast("Backup exported",{type:"ok"}); }
    function restore(){ const inp=h("input",{type:"file",accept:".json",style:"display:none"});
      inp.onchange=e=>{ const f=e.target.files[0]; if(!f)return; const r=new FileReader();
        r.onload=async ()=>{ try{ const d=JSON.parse(r.result); if(!d.items||!d.movements) throw 0;
          await DB.save(d); toast("Backup restored — reloading",{type:"ok"}); setTimeout(()=>location.reload(),800);
        }catch(_){ toast("Invalid backup file",{type:"danger"}); } };
        r.readAsText(f); };
      document.body.appendChild(inp); inp.click(); inp.remove(); }
    async function reset(){ if(await confirm("Reset all data to the seeded demo dataset? Your current changes will be lost.",{title:"Reset Data",danger:true})){
      toast("Resetting…",{type:"info"});
      try{ await DB.reset(); setTimeout(()=>location.reload(),500); }
      catch(e){ toast("Reset failed: "+e.message,{type:"danger"}); } } }
  }};
})();
