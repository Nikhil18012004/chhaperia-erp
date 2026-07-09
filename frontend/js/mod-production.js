/* ============================================================
   CHHAPERIA ERP — PRODUCTION & PRODUCTS / BOM
   Auto material consumption: completing a work order posts
   ISSUE lines for every BOM component + a PROD line for the FG.
   ============================================================ */
(function () {
  "use strict";
  const {h, esc, table, badge, meter, toast, modal, confirm} = UI;
  const {pageHead, kpi} = MW;
  const U = window._erpUtil;

  /* ============== PRODUCTION ============== */
  const STAGE_LABEL={coating:"Coating",slitting:"Slitting",packing:"Packing",production:"Production",weaving:"Weaving",wbcoat:"WB Coating",fiberglass:"Fiber-Glass"};
  // products that carry a per-order production spec (mirrors backend stageService)
  const ORDER_SPEC={ "FG-CU-WBT": { key:"copperWires", label:"Copper wires (per tape)" } };
  function curStage(w){ const rt=w.route; if(!rt||!rt.length) return null; const i=Math.min(Math.max(w.stageIdx||0,0),rt.length-1); return rt[i]; }
  function stageCell(w){
    if(w.dispatched) return `<span class="chip" style="color:var(--ok);border-color:var(--ok)">🚚 Dispatched</span>`;
    const rt=w.route||[]; if(!rt.length) return `<span class="muted">—</span>`;
    const doneN=rt.filter(s=>s.status==="Completed").length;
    const cur=curStage(w);
    const label = w.status==="Completed" ? "Packed" : (STAGE_LABEL[cur.key]||cur.name||"—");
    const dots = rt.map(s=>{ const c=s.status==="Completed"?"var(--ok)":s.status==="In Production"?"var(--info)":"var(--line)";
      return `<span style="width:8px;height:8px;border-radius:50%;background:${c};display:inline-block"></span>`; }).join(" ");
    return `<div class="cell-main">${esc(label)}</div><div class="cell-sub" style="display:flex;align-items:center;gap:4px">${dots}<span class="muted" style="margin-left:4px">${doneN}/${rt.length}</span></div>`;
  }
  async function reloadState(){ const fresh=await DB.loadAsync(); ENG.init(fresh); App.buildNav(); App.refreshAlerts(); }
  function stageTimeline(wo){
    const rt=wo.route||[];
    if(!rt.length) return h("div",{class:"muted",style:"margin:14px 0;font-size:12px",text:"No routing — legacy work order."});
    const box=h("div",{style:"margin:16px 0"});
    box.appendChild(h("div",{class:"muted",style:"font-size:11px;font-weight:700;text-transform:uppercase;margin-bottom:8px",text:"Production Route"}));
    const row=h("div",{style:"display:flex;align-items:center;gap:8px;flex-wrap:wrap"});
    rt.forEach((s,i)=>{
      if(i>0) row.appendChild(h("span",{style:"color:var(--text-mut)",text:"→"}));
      const c=s.status==="Completed"?"var(--ok)":s.status==="In Production"?"var(--info)":"var(--text-mut)";
      const mark=s.status==="Completed"?"✓":s.status==="In Production"?"▶":"•";
      const cur=(i===(wo.stageIdx||0))&&!wo.dispatched;
      row.appendChild(h("span",{title:(s.doneBy?"by "+s.doneBy+(s.doneAt?" · "+s.doneAt.slice(0,10):""):s.status),
        style:`display:inline-flex;align-items:center;gap:6px;padding:5px 12px;border-radius:999px;font-size:12.5px;font-weight:600;border:1.5px solid ${c};color:${c};`+(cur?`box-shadow:0 0 0 3px color-mix(in srgb,${c} 20%,transparent)`:``),
        html:`${mark} ${esc(STAGE_LABEL[s.key]||s.name||s.key)}`}));
    });
    if(wo.dispatched) row.appendChild(h("span",{style:"font-weight:700;color:var(--ok);font-size:12.5px",text:"🚚 Dispatched"}));
    box.appendChild(row);
    return box;
  }

  M.production = { title:"Production", sub:"Work orders & material consumption", render(root, params){
    let tab="active";
    let filter={from:"", to:""};
    root.appendChild(pageHead("Production Control","Jobs flow Coating → Slitting → Packing; each stage consumes materials and posts WIP / finished goods automatically",[
      h("button",{class:"btn primary",onclick:()=>woForm(),html:"＋ New Work Order"})
    ]));

    const wos=ENG.data.workorders;
    const isDone=w=>w.status==="Completed"||w.status==="Dispatched";
    const active=wos.filter(w=>!isDone(w));
    const done=wos.filter(isDone);
    const out30=ENG.dailySeries(30).prod.reduce((a,b)=>a+b,0);
    root.appendChild(h("div",{class:"grid kpi-grid",style:"margin-bottom:16px"},[
      kpi({icon:"⚙️",label:"Active Work Orders",value:ENG.num(active.length)}),
      kpi({icon:"✅",label:"Completed",value:ENG.num(done.length)}),
      kpi({icon:"📦",label:"Output (30d)",value:ENG.num(out30)+" kg"}),
      kpi({icon:"🏭",label:"Production Lines",value:"4",delta:"2 running",deltaType:"up"}),
    ]));

    const seg=h("div",{class:"seg",style:"margin-bottom:14px"},[
      segBtn("Active / Released","active"), segBtn("Completed","done"), segBtn("All","all")
    ]);
    root.appendChild(seg);
    root.appendChild(h("div",{class:"toolbar"},[
      MW.dateRange(filter, draw, {label:"Start Date"}),
      h("div",{style:"margin-left:auto"},h("span",{class:"chip",id:"prodCount"}))
    ]));
    const host=h("div"); root.appendChild(host);

    function segBtn(label,key){ const b=h("button",{class:tab===key?"on":"",text:label,onclick:()=>{tab=key;[...seg.children].forEach(c=>c.classList.remove("on"));b.classList.add("on");draw();}}); return b; }

    function draw(){
      let data = tab==="active"?active : tab==="done"?done : wos;
      data=data.filter(w=>MW.inDateRange(w.date, filter));
      data=data.slice().sort((a,b)=>a.date<b.date?1:-1);
      const c=UI.$("#prodCount"); if(c) c.textContent=data.length+" work orders";
      host.innerHTML="";
      host.appendChild(table(data,[
        {key:"id",label:"WO #",render:r=>`<span class="mono strong">${r.id}</span>`,sort:r=>r.id},
        {key:"item",label:"Product",render:r=>{const it=ENG.item(r.itemId);return `<div class="cell-main">${esc(U.trim(it.name,34))}</div><div class="cell-sub">${r.itemId}</div>`;},sort:r=>r.itemId},
        {key:"qty",label:"Qty",num:true,render:r=>`<span class="strong">${ENG.num(r.qty)}</span> <span class="muted">kg</span>`,sort:r=>r.qty},
        {key:"date",label:"Start",render:r=>r.date||"—",sort:r=>r.date||""},
        {key:"stage",label:"Stage",render:r=>stageCell(r),sort:r=>(r.stageIdx||0)},
        {key:"line",label:"Line",render:r=>`<span class="chip">${esc(r.line)}</span>`,sort:r=>r.line},
        {key:"due",label:"Due",render:r=>r.due,sort:r=>r.due},
        {key:"progress",label:"Progress",render:r=>`<div style="min-width:120px">${meter(r.progress, r.progress>66?"ok":r.progress>33?"warn":"danger")}<div class="muted" style="font-size:11px;margin-top:3px">${r.progress}%</div></div>`,sort:r=>r.progress},
        {key:"status",label:"Status",render:r=>badge((r.status==="Completed"||r.status==="Dispatched")?"ok":r.status==="In Production"||r.status==="In Progress"?"info":"warn",r.status),sort:r=>r.status},
        {key:"act",label:"",noSort:true,render:r=>woActions(r)},
      ],{onRow:r=>woDetail(r),empty:"No work orders"}));
    }
    draw();
    if(params&&params.openNew){ params.openNew=false; woForm(); }

    function woActions(r){
      const wrap=h("div",{class:"flex gap"});
      const finished=r.status==="Completed"||r.status==="Dispatched";
      if(!finished){
        const cur=curStage(r);
        wrap.appendChild(h("button",{class:"btn sm",onclick:e=>{e.stopPropagation();advanceStage(r,cur);},text:cur&&cur.status==="Pending"?"Start "+(STAGE_LABEL[cur.key]||"stage"):"Finish "+(STAGE_LABEL[cur.key]||"stage")}));
        wrap.appendChild(h("button",{class:"btn sm primary",onclick:e=>{e.stopPropagation();completeWO(r);},text:"Complete all"}));
      } else {
        wrap.appendChild(h("button",{class:"btn sm ghost",onclick:e=>{e.stopPropagation();woDetail(r);},text:"View"}));
      }
      return wrap;
    }

    // advance one stage (start pending / finish active) via the backend engine
    async function advanceStage(wo, cur){
      if(!cur) return;
      const action = cur.status==="Pending" ? "start" : "complete";
      try{ await DB.production.advance(wo.id, action); await reloadState(); draw();
        toast(`${wo.id}: ${STAGE_LABEL[cur.key]||cur.key} ${action==="start"?"started":"completed"}`,{type:"ok"}); }
      catch(e){ toast(e.message,{type:"danger"}); }
    }

    // complete a work order all the way through its remaining stages (backend posts each)
    async function completeWO(wo){
      const it=ENG.item(wo.itemId);
      const rt=wo.route||[]; const remaining=rt.filter(s=>s.status!=="Completed").map(s=>STAGE_LABEL[s.key]||s.key);
      const msg = remaining.length
        ? `Complete ${wo.id} through all remaining stages (${remaining.join(" → ")})?\n\nEach stage will consume its materials and post WIP / finished goods automatically.`
        : `Mark ${wo.id} as completed?`;
      if(!await confirm(msg,{title:"Complete Work Order"})) return;
      try{
        let res=null;
        for(let i=0;i<6;i++){ res=await DB.production.advance(wo.id,"complete"); if(res.status==="Completed"||res.status==="Dispatched") break; }
        await reloadState(); draw();
        toast(`${wo.id} completed — ${ENG.num(wo.qty)} kg of ${it?it.name:wo.itemId} added to finished goods`,{type:"ok",title:"Production posted"});
      }catch(e){ toast("Complete failed: "+e.message,{type:"danger"}); }
    }

    function woDetail(wo){
      const it=ENG.item(wo.itemId); const bom=ENG.data.boms[wo.itemId];
      const rows = bom? bom.lines.map(([rid,per])=>{ const need=per*wo.qty/bom.yield; const st=ENG.stock(rid);
        return {rid, name:ENG.item(rid).name, per, need, have:st.onHand, ok:st.onHand>=need, uom:ENG.item(rid).uom}; }):[];
      const body=h("div",{},[
        MW.dl([["Product",it.name],["Quantity",ENG.num(wo.qty)+" kg"],["Line",wo.line],["Status",badge((wo.status==="Completed"||wo.status==="Dispatched")?"ok":"info",wo.status)],
          ["Start",wo.date],["Due",wo.due],["Yield",bom?(bom.yield*100).toFixed(0)+"%":"—"],["Progress",wo.progress+"%"]]),
        stageTimeline(wo),
        h("h3",{style:"margin:18px 0 10px;font-size:14px",text:"Material Requirements (auto from BOM)"}),
        table(rows,[
          {key:"name",label:"Component",render:r=>`<div class="cell-main">${esc(U.trim(r.name,34))}</div><div class="cell-sub">${r.rid}</div>`,noSort:true},
          {key:"per",label:"Per kg",num:true,render:r=>ENG.num(r.per,3),noSort:true},
          {key:"need",label:"Required",num:true,render:r=>`<span class="strong">${ENG.num(r.need,2)}</span> ${r.uom}`,noSort:true},
          {key:"have",label:"In Stock",num:true,render:r=>ENG.num(r.have,1),noSort:true},
          {key:"ok",label:"",noSort:true,render:r=>badge(r.ok?"ok":"danger",r.ok?"Available":"Short")},
        ],{empty:"No BOM"})
      ]);
      const finished=wo.status==="Completed"||wo.status==="Dispatched";
      modal({title:wo.id, sub:it.name, wide:true, body,
        foot:[ finished?null:h("button",{class:"btn primary",onclick:()=>{UI.$("#modalHost").hidden=true;completeWO(wo);},text:"Complete all stages"}) ]});
    }

    function woForm(){
      const fgs=ENG.data.items.filter(i=>i.cat==="FG");
      const body=h("div",{class:"form-grid"},[
        U.field("Product",U.selectHTML("w_item",fgs.map(i=>({v:i.id,l:U.trim(i.name,36)})),fgs[0].id),"full"),
        U.field("Quantity (kg)",`<input class="input" id="w_qty" type="number" value="100">`),
        U.field("Production Line",U.selectHTML("w_line",[{v:"Coating Line 1",l:"Coating Line 1"},{v:"Coating Line 2",l:"Coating Line 2"},{v:"Fibre-Glass Line 1",l:"Fibre-Glass Line 1"},{v:"Fibre-Glass Line 2",l:"Fibre-Glass Line 2"},{v:"Slitting A",l:"Slitting A"},{v:"Slitting B",l:"Slitting B"}],"Coating Line 1")),
        U.field("Due Date",`<input class="input" id="w_due" type="date" value="${DB.helpers.daysAhead(7)}">`),
        U.field("Priority",U.selectHTML("w_prio",[{v:"Normal",l:"Normal"},{v:"High",l:"High"},{v:"Urgent",l:"Urgent"}],"Normal")),
      ]);
      const specHost=h("div",{style:"margin-top:4px"});
      body.appendChild(specHost);
      const matHost=h("div",{style:"margin-top:16px"});
      body.appendChild(matHost);
      const recalc=()=>{ const id=UI.$("#w_item").value, qty=+UI.$("#w_qty").value||0; const bom=ENG.data.boms[id];
        // per-order production spec (e.g. copper-wire count) for products that need it
        specHost.innerHTML="";
        const spec=ORDER_SPEC[id];
        if(spec){ specHost.appendChild(U.field(spec.label,`<input class="input" id="w_spec" type="number" min="0" placeholder="as per order">`)); }
        matHost.innerHTML=""; if(!bom) return;
        matHost.appendChild(h("div",{class:"muted",style:"font-size:11px;font-weight:700;text-transform:uppercase;margin-bottom:8px",text:"Materials to be consumed"}));
        bom.lines.forEach(([rid,per])=>{ const need=per*qty/bom.yield; const have=ENG.stock(rid).onHand; const ok=have>=need;
          matHost.appendChild(h("div",{class:"flex between",style:"font-size:12.5px;padding:6px 0;border-bottom:1px solid var(--line)"},[
            h("span",{text:U.trim(ENG.item(rid).name,32)}),
            h("span",{html:`<span class="mono ${ok?'':''}" style="color:${ok?'var(--text)':'var(--danger)'}">${ENG.num(need,2)} / ${ENG.num(have,1)}</span> ${badge(ok?"ok":"danger",ok?"OK":"Short")}`})
          ])); });
      };
      const mo=modal({title:"New Work Order", sub:"Plan a production run", body,
        foot:[h("button",{class:"btn ghost",onclick:()=>mo.close(),text:"Cancel"}),
          h("button",{class:"btn primary",onclick:save,text:"Create Work Order"})]});
      setTimeout(()=>{ UI.$("#w_item").addEventListener("change",recalc); UI.$("#w_qty").addEventListener("input",recalc); recalc(); },50);
      async function save(){
        const itemId=UI.$("#w_item").value, qty=+UI.$("#w_qty").value;
        if(!qty||qty<=0){ toast("Enter a valid quantity",{type:"warn"}); return; }
        const payload={itemId, qty, line:UI.$("#w_line").value, due:UI.$("#w_due").value, priority:UI.$("#w_prio").value};
        const spec=ORDER_SPEC[itemId], specEl=UI.$("#w_spec");
        if(spec && specEl && specEl.value!=="") payload[spec.key]=+specEl.value;
        try{
          const res=await DB.production.create(payload);
          const flow=(res.route||[]).map(r=>STAGE_LABEL[r.key]||r.name).join(" → ");
          await reloadState(); mo.close(); toast((res.id||"Work order")+" created — "+flow,{type:"ok"}); tab="active"; draw();
        }catch(e){ toast("Create failed: "+e.message,{type:"danger"}); }
      }
    }
  }};

  /* ============== PRODUCTS & BOM ============== */
  M.bom = { title:"Products & BOM", sub:"Recipes & cost roll-up", render(root, params){
    root.appendChild(pageHead("Products & Bill of Materials","Chhaperia cable-tape range with live material cost roll-up, margin analysis & specifications",[
      h("button",{class:"btn primary",onclick:()=>bomForm(),html:"＋ Create BOM"})
    ]));
    const fgs=ENG.data.items.filter(i=>i.cat==="FG");
    const groups=[
      {key:"MICA", label:"🔥 Mica Tapes", sub:"Fire-survival / high-voltage insulation"},
      {key:"WBT",  label:"💧 Water Blocking Tapes", sub:"Power & optical cable moisture barrier"},
      {key:"SCT",  label:"⚡ Semi-Conducting Tapes", sub:"Conductor & insulation screens"},
      {key:"OCT",  label:"🎞️ Other Cable Tapes", sub:"Shielding, binding & specialty"},
    ];
    groups.forEach(g=>{
      const list=fgs.filter(f=>f.group===g.key);
      if(!list.length) return;
      root.appendChild(h("div",{class:"flex aic gap",style:"margin:20px 0 12px"},[
        h("h2",{style:"font-size:17px;font-weight:800",text:g.label}),
        h("span",{class:"muted",style:"font-size:12.5px",text:"· "+g.sub}),
        h("span",{class:"chip",style:"margin-left:auto",text:list.length+" products"})
      ]));
      const grid=h("div",{class:"grid cols-2"});
      list.forEach(fg=> grid.appendChild(productCard(fg)));
      root.appendChild(grid);
    });
    if(params&&params.openNew){ params.openNew=false; bomForm(); }

    function productCard(fg){
      const bom=ENG.data.boms[fg.id];
      let matCost=0; if(bom) bom.lines.forEach(([rid,per])=>{ matCost+=per*ENG.stock(rid).avgCost/bom.yield; });
      const margin = fg.price? ((fg.price-fg.cost)/fg.price*100):0;
      const specChips=[];
      if(fg.typeCode) specChips.push(`<span class="chip"><b>${esc(fg.typeCode)}</b></span>`);
      if(fg.flameC) specChips.push(`<span class="chip" style="color:var(--danger)">🔥 ${fg.flameC}°C</span>`);
      if(fg.widthMM && fg.widthMM[0]) specChips.push(`<span class="chip">↔ ${fg.widthMM.join("/")} mm</span>`);
      return h("div",{class:"card hover"},[
        h("div",{class:"flex between aic"},[
          h("div",{},[h("h3",{style:"font-size:15px",text:fg.name}),h("div",{class:"muted",style:"font-size:11.5px",text:fg.id+" · HSN "+(fg.hsn||"—")})]),
          h("div",{class:"kpi-ic",text:"🎞️"})
        ]),
        specChips.length?h("div",{class:"flex gap wrap",style:"margin-top:10px",html:specChips.join("")}):null,
        fg.std?h("div",{class:"muted",style:"font-size:11px;margin-top:8px",text:"Standard: "+fg.std}):null,
        h("div",{class:"grid cols-3",style:"margin:14px 0;gap:8px"},[
          stat("Material Cost","₹"+ENG.num(matCost,0)),
          stat("Std Cost","₹"+ENG.num(fg.cost,0)),
          stat("Price","₹"+ENG.num(fg.price,0)),
        ]),
        h("div",{class:"flex between aic",style:"margin-bottom:10px"},[
          h("span",{class:"muted",style:"font-size:12px",text:"Gross Margin"}),
          h("span",{html:badge(margin>30?"ok":margin>15?"warn":"danger",margin.toFixed(1)+"%")})
        ]),
        bom?h("details",{},[
          h("summary",{style:"cursor:pointer;font-size:12.5px;font-weight:700;color:var(--accent)",text:`Recipe · ${bom.lines.length} components · ${(bom.yield*100).toFixed(0)}% yield`}),
          h("div",{style:"margin-top:10px"}, bom.lines.map(([rid,per])=>{ const r=ENG.item(rid);
            return h("div",{class:"flex between",style:"font-size:12px;padding:5px 0;border-bottom:1px solid var(--line)"},[
              h("span",{text:U.trim((r||{}).name||rid,30)}), h("span",{class:"mono muted",text:ENG.num(per,3)+" "+((r||{}).uom||"")+"/kg"})
            ]); }))
        ]):h("div",{class:"muted",style:"font-size:12px",text:"No BOM defined"}),
        h("div",{class:"flex",style:"justify-content:flex-end;margin-top:12px;padding-top:10px;border-top:1px solid var(--line)"},[
          h("button",{class:"btn sm ghost",title:bom?"Edit this BOM":"Add a BOM",onclick:()=>bomForm(fg.id),html:bom?"✎ Edit BOM":"＋ Add BOM"})
        ])
      ]);
    }

    /* ----- create / edit / delete a product's BOM ----- */
    function bomForm(fgId){
      const fgs=ENG.data.items.filter(i=>i.cat==="FG");
      const rms=ENG.data.items.filter(i=>i.cat!=="FG");   // raw materials + WIP usable as components
      if(!fgs.length){ toast("Create a finished-good product first",{type:"warn"}); return; }
      const existing = fgId? ENG.data.boms[fgId] : null;
      const editing = !!existing;
      let lines=[];
      const body=h("div",{},[
        h("div",{class:"form-grid"},[
          U.field("Product (Finished Good)", U.selectHTML("bm_fg", fgs.map(f=>({v:f.id,l:U.trim(f.id+" — "+f.name,42)})), fgId||fgs[0].id)),
          U.field("Yield (%)", `<input class="input" id="bm_yield" type="number" step="1" min="1" max="100" value="${existing?Math.round(existing.yield*100):100}">`),
        ]),
        h("h3",{style:"margin:16px 0 8px;font-size:13px",text:"Components (quantity per kg of finished good)"}),
        h("div",{id:"bm_lines"}),
        h("button",{class:"btn sm",style:"margin-top:8px",onclick:()=>addLine(),html:"＋ Add component"})
      ]);
      const foot=[h("button",{class:"btn ghost",onclick:()=>mo.close(),text:"Cancel"})];
      if(editing) foot.push(h("button",{class:"btn danger",onclick:()=>delBom(),text:"🗑 Delete BOM"}));
      foot.push(h("button",{class:"btn primary",onclick:save,text:editing?"Save BOM":"Create BOM"}));
      const mo=modal({title: editing?("Edit BOM · "+fgId):"Create BOM", sub:"Define the material recipe", wide:true, body, foot});
      const fgSel=UI.$("#bm_fg"); if(editing && fgSel) fgSel.disabled=true;   // lock product when editing its recipe
      function addLine(seed){
        const idx=lines.length; lines.push({});
        const rid = seed? seed[0] : (rms[0]&&rms[0].id);
        const per = seed? seed[1] : "";
        const row=h("div",{class:"flex gap",style:"margin-bottom:8px;align-items:center"},[
          h("div",{html:U.selectHTML("bl_rid_"+idx, rms.map(i=>({v:i.id,l:U.trim(i.id+" — "+i.name,34)})), rid), style:"flex:2"}),
          h("input",{class:"input",id:"bl_per_"+idx,type:"number",step:"0.001",placeholder:"Qty / kg",style:"flex:1",value:per}),
          h("button",{class:"btn sm ghost",title:"Remove component",onclick:e=>{e.preventDefault();e.target.closest(".flex.gap").remove();lines[idx]=null;},text:"✕"})
        ]);
        UI.$("#bm_lines").appendChild(row);
      }
      if(existing && existing.lines.length) existing.lines.forEach(l=>addLine(l)); else addLine();
      function save(){
        const fg2=UI.$("#bm_fg").value;
        const yld=Math.min(100,Math.max(1,+UI.$("#bm_yield").value||100))/100;
        const out=[];
        lines.forEach((_,i)=>{ if(!lines[i]) return; const rEl=UI.$("#bl_rid_"+i), pEl=UI.$("#bl_per_"+i); if(!rEl||!pEl) return;
          const rid=rEl.value, per=+pEl.value; if(rid && per>0) out.push([rid, per]); });
        if(!out.length){ toast("Add at least one component with a quantity",{type:"warn"}); return; }
        ENG.data.boms[fg2] = { yield:yld, lines:out };
        mo.close(); toast(editing?("BOM updated for "+fg2):("BOM created for "+fg2),{type:"ok"});
        App.saveDelta(()=>DB.boms.save(fg2,{yield:yld, lines:out}));
      }
      async function delBom(){
        if(!await confirm(`Delete the BOM for ${fgId}? The product stays — only its recipe is removed.`,{title:"Delete BOM",danger:true})) return;
        delete ENG.data.boms[fgId];
        mo.close(); toast("BOM deleted",{type:"ok"});
        App.saveDelta(()=>DB.boms.remove(fgId));
      }
    }
  }};

  function stat(label,val){ return h("div",{},[h("div",{class:"muted",style:"font-size:10.5px;font-weight:700;text-transform:uppercase",text:label}),h("div",{style:"font-weight:700;font-size:15px;margin-top:2px",text:val})]); }

  // register ⌘K quick actions for Production & BOM
  window.ERPActions = Object.assign(window.ERPActions||{}, {
    newWO:  { ic:"⚙️", label:"New Work Order", run:()=>App.go("production",{openNew:true}) },
    newBOM: { ic:"🧬", label:"Create BOM",     run:()=>App.go("bom",{openNew:true}) },
  });
})();
