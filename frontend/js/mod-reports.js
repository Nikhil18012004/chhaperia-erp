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

    /* CSV import / export */
    root.appendChild(h("div",{class:"card",style:"margin-top:16px"},[
      h("div",{class:"card-head"},h("h3",{text:"📑 CSV Import / Export"})),
      h("p",{class:"dim",style:"font-size:13px;margin-bottom:14px;line-height:1.6",text:"Export any table to a spreadsheet-friendly CSV, edit it, and import it back. Imports show a preview (new / updated) before anything is saved — nothing is deleted. Imported work orders are automatically routed through Coating → Slitting → Packing."}),
      h("div",{class:"muted",style:"font-size:11px;font-weight:700;text-transform:uppercase;margin-bottom:8px",text:"Export a table"}),
      h("div",{class:"flex gap wrap",style:"margin-bottom:16px"}, Object.keys(CSVIO.ENTITIES).map(k=>
        h("button",{class:"btn sm",onclick:()=>{ const n=CSVIO.exportEntity(k); toast(CSVIO.ENTITIES[k].label+" exported ("+n+" rows)",{type:"ok",title:"Download started"}); },html:"⬇ "+CSVIO.ENTITIES[k].label}))),
      h("div",{style:"border-top:1px solid var(--line);padding-top:14px"},[
        h("div",{class:"muted",style:"font-size:11px;font-weight:700;text-transform:uppercase;margin-bottom:8px",text:"Import a CSV"}),
        h("button",{class:"btn primary",onclick:csvImport,html:"⬆ Import CSV…"}),
      ])
    ]));

    function csvImport(){
      const inp=h("input",{type:"file",accept:".csv,text/csv",style:"display:none"});
      inp.onchange=e=>{ const f=e.target.files[0]; if(!f) return; const r=new FileReader();
        r.onload=()=>{ try{
            const parsed=CSVIO.parse(r.result);
            if(parsed.length<1){ toast("Empty CSV file",{type:"warn"}); return; }
            const detected=CSVIO.detect(parsed[0].map(x=>x.trim()));
            if(!detected){ toast("Could not recognise this CSV. Export a table first to get the right columns.",{type:"danger"}); return; }
            showImportPreview(detected, parsed);
          }catch(err){ toast("Import failed: "+err.message,{type:"danger"}); } };
        r.readAsText(f); };
      document.body.appendChild(inp); inp.click(); inp.remove();
    }

    function statPill(txt,col){ return h("span",{style:`padding:6px 12px;border-radius:999px;border:1.5px solid ${col};color:${col};font-weight:700;font-size:13px`,text:txt}); }
    function previewVal(o,col){ const v=o[col.k]; if(Array.isArray(v)) return v.join("|"); if(v&&typeof v==="object") return JSON.stringify(v); return v==null?"":v; }

    function showImportPreview(key, parsed){
      let curKey=key;
      const host=h("div");
      const mo=modal({title:"Import CSV", sub:"Review changes before saving", wide:true, body:host,
        foot:[ h("button",{class:"btn ghost",onclick:()=>mo.close(),text:"Cancel"}),
               h("button",{class:"btn primary",id:"csvApplyBtn",text:"Apply Import"}) ]});
      const sel=h("select",{class:"select",style:"max-width:240px"}, Object.keys(CSVIO.ENTITIES).map(k=>{
        const o=h("option",{value:k,text:CSVIO.ENTITIES[k].label}); if(k===curKey)o.selected=true; return o; }));
      sel.onchange=()=>{ curKey=sel.value; render(); };

      function render(){
        host.innerHTML="";
        host.appendChild(h("div",{class:"flex gap aic",style:"margin-bottom:12px"},[
          h("span",{class:"muted",style:"font-size:12px",text:"Import this file as:"}), sel ]));
        let diff;
        try{ diff=CSVIO.buildDiff(curKey, parsed); }
        catch(err){ host.appendChild(h("div",{class:"muted",text:"Cannot map this file to "+CSVIO.ENTITIES[curKey].label+"."})); return; }
        host.appendChild(h("div",{class:"flex gap wrap",style:"margin-bottom:14px"},[
          statPill("＋ "+diff.add.length+" new","var(--ok)"),
          statPill("~ "+diff.update.length+" updated","var(--info)"),
          statPill("= "+diff.unchanged.length+" unchanged","var(--text-mut)"),
          diff.errors.length?statPill("⚠ "+diff.errors.length+" skipped","var(--danger)"):null,
        ].filter(Boolean)));

        const changed=diff.add.map(x=>({kind:"New",o:x.after})).concat(diff.update.map(x=>({kind:"Updated",o:x.after})));
        const cols0=CSVIO.ENTITIES[curKey].cols.slice(0,6);
        const rows=changed.slice(0,120).map(c=>{ const o={_k:c.kind}; cols0.forEach(col=>o[col.k]=previewVal(c.o,col)); return o; });
        const tcols=[{key:"_k",label:"Change",noSort:true,render:r=>badge(r._k==="New"?"ok":"info",r._k)}].concat(
          cols0.map(col=>({key:col.k,label:col.k,noSort:true,render:r=>esc(String(r[col.k]==null?"":r[col.k])).slice(0,44)})));
        host.appendChild(table(rows,tcols,{empty:"No new or changed rows in this file"}));
        if(changed.length>120) host.appendChild(h("div",{class:"muted",style:"font-size:11px;margin-top:8px",text:"Showing first 120 of "+changed.length+" changed rows — all will be applied."}));

        const applyBtn=UI.$("#csvApplyBtn"); const total=diff.add.length+diff.update.length;
        if(applyBtn){
          applyBtn.textContent=total?"Apply Import ("+total+")":"Nothing to import";
          applyBtn.disabled=!total;
          applyBtn.onclick=async ()=>{ applyBtn.disabled=true; applyBtn.textContent="Saving…";
            try{ CSVIO.apply(diff); await DB.save(ENG.data);
              const fresh=await DB.loadAsync(); ENG.init(fresh); App.buildNav(); App.refreshAlerts();
              mo.close(); toast(CSVIO.ENTITIES[curKey].label+" imported — "+total+" rows saved",{type:"ok",title:"Import complete"});
              App.go("settings");
            }catch(err){ toast("Save failed: "+err.message,{type:"danger"}); applyBtn.disabled=false; applyBtn.textContent="Apply Import"; } };
        }
      }
      render();
    }

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
