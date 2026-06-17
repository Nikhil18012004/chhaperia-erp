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
  M.production = { title:"Production", sub:"Work orders & material consumption", render(root){
    let tab="active";
    root.appendChild(pageHead("Production Control","Work orders auto-consume raw materials per BOM and post finished goods to stock",[
      h("button",{class:"btn primary",onclick:()=>woForm(),html:"＋ New Work Order"})
    ]));

    const wos=ENG.data.workorders;
    const active=wos.filter(w=>w.status!=="Completed");
    const done=wos.filter(w=>w.status==="Completed");
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
    const host=h("div"); root.appendChild(host);

    function segBtn(label,key){ const b=h("button",{class:tab===key?"on":"",text:label,onclick:()=>{tab=key;[...seg.children].forEach(c=>c.classList.remove("on"));b.classList.add("on");draw();}}); return b; }

    function draw(){
      let data = tab==="active"?active : tab==="done"?done : wos;
      data=data.slice().sort((a,b)=>a.date<b.date?1:-1);
      host.innerHTML="";
      host.appendChild(table(data,[
        {key:"id",label:"WO #",render:r=>`<span class="mono strong">${r.id}</span>`,sort:r=>r.id},
        {key:"item",label:"Product",render:r=>{const it=ENG.item(r.itemId);return `<div class="cell-main">${esc(U.trim(it.name,34))}</div><div class="cell-sub">${r.itemId}</div>`;},sort:r=>r.itemId},
        {key:"qty",label:"Qty",num:true,render:r=>`<span class="strong">${ENG.num(r.qty)}</span> <span class="muted">kg</span>`,sort:r=>r.qty},
        {key:"line",label:"Line",render:r=>`<span class="chip">${esc(r.line)}</span>`,sort:r=>r.line},
        {key:"date",label:"Start",render:r=>r.date,sort:r=>r.date},
        {key:"due",label:"Due",render:r=>r.due,sort:r=>r.due},
        {key:"progress",label:"Progress",render:r=>`<div style="min-width:120px">${meter(r.progress, r.progress>66?"ok":r.progress>33?"warn":"danger")}<div class="muted" style="font-size:11px;margin-top:3px">${r.progress}%</div></div>`,sort:r=>r.progress},
        {key:"status",label:"Status",render:r=>badge(r.status==="Completed"?"ok":r.status==="In Progress"?"info":"warn",r.status),sort:r=>r.status},
        {key:"act",label:"",noSort:true,render:r=>woActions(r)},
      ],{onRow:r=>woDetail(r),empty:"No work orders"}));
    }
    draw();

    function woActions(r){
      const wrap=h("div",{class:"flex gap"});
      if(r.status!=="Completed"){
        wrap.appendChild(h("button",{class:"btn sm primary",onclick:e=>{e.stopPropagation();completeWO(r);},text:"Complete"}));
      } else {
        wrap.appendChild(h("button",{class:"btn sm ghost",onclick:e=>{e.stopPropagation();woDetail(r);},text:"View"}));
      }
      return wrap;
    }

    async function completeWO(wo){
      const it=ENG.item(wo.itemId); const bom=ENG.data.boms[wo.itemId];
      if(!bom){ toast("No BOM defined for this product",{type:"danger"}); return; }
      // check material availability
      const shortages=[];
      bom.lines.forEach(([rid,per])=>{ const need=per*wo.qty/bom.yield; const have=ENG.stock(rid).onHand;
        if(have<need) shortages.push(`${ENG.item(rid).name}: need ${ENG.num(need,1)}, have ${ENG.num(have,1)}`); });
      const msg = shortages.length
        ? `⚠ Material shortage detected:\n\n${shortages.join("\n")}\n\nComplete anyway (stock will go negative)?`
        : `Complete ${wo.id}? This will auto-issue ${bom.lines.length} raw materials and add ${ENG.num(wo.qty)} kg of ${it.name} to finished goods.`;
      if(!await confirm(msg,{title:"Complete Work Order", danger:shortages.length>0})) return;
      const date=DB.helpers.iso(DB.helpers.today());
      // remove any prior partial issues for this WO progress? keep simple: issue remaining proportion
      const remainFactor = 1 - (wo.progress||0)/100;
      bom.lines.forEach(([rid,per])=>{ const need=per*wo.qty/bom.yield*Math.max(remainFactor,0.0001);
        if(need>0) ENG.data.movements.push({id:"MV-"+Date.now()+"-"+rid, date, itemId:rid, wh:"WH-WIP", type:"ISSUE",
          qty:-+need.toFixed(2), rate:ENG.item(rid).cost, ref:wo.id, note:"Auto-issue on completion", by:"prod"}); });
      ENG.data.movements.push({id:"MV-"+Date.now()+"-OUT", date, itemId:wo.itemId, wh:"WH-FG", type:"PROD",
        qty:wo.qty, rate:it.cost, ref:wo.id, note:"Production output", by:"prod"});
      wo.status="Completed"; wo.progress=100;
      App.persistAndRefresh(); draw(); toast(`${wo.id} completed — materials consumed & ${ENG.num(wo.qty)} kg added`,{type:"ok",title:"Production posted"});
    }

    function woDetail(wo){
      const it=ENG.item(wo.itemId); const bom=ENG.data.boms[wo.itemId];
      const rows = bom? bom.lines.map(([rid,per])=>{ const need=per*wo.qty/bom.yield; const st=ENG.stock(rid);
        return {rid, name:ENG.item(rid).name, per, need, have:st.onHand, ok:st.onHand>=need, uom:ENG.item(rid).uom}; }):[];
      const body=h("div",{},[
        MW.dl([["Product",it.name],["Quantity",ENG.num(wo.qty)+" kg"],["Line",wo.line],["Status",badge(wo.status==="Completed"?"ok":"info",wo.status)],
          ["Start",wo.date],["Due",wo.due],["Yield",bom?(bom.yield*100).toFixed(0)+"%":"—"],["Progress",wo.progress+"%"]]),
        h("h3",{style:"margin:18px 0 10px;font-size:14px",text:"Material Requirements (auto from BOM)"}),
        table(rows,[
          {key:"name",label:"Component",render:r=>`<div class="cell-main">${esc(U.trim(r.name,34))}</div><div class="cell-sub">${r.rid}</div>`,noSort:true},
          {key:"per",label:"Per kg",num:true,render:r=>ENG.num(r.per,3),noSort:true},
          {key:"need",label:"Required",num:true,render:r=>`<span class="strong">${ENG.num(r.need,2)}</span> ${r.uom}`,noSort:true},
          {key:"have",label:"In Stock",num:true,render:r=>ENG.num(r.have,1),noSort:true},
          {key:"ok",label:"",noSort:true,render:r=>badge(r.ok?"ok":"danger",r.ok?"Available":"Short")},
        ],{empty:"No BOM"})
      ]);
      modal({title:wo.id, sub:it.name, wide:true, body,
        foot:[ wo.status!=="Completed"?h("button",{class:"btn primary",onclick:()=>{UI.$("#modalHost").hidden=true;completeWO(wo);},text:"Complete & Post"}):null ]});
    }

    function woForm(){
      const fgs=ENG.data.items.filter(i=>i.cat==="FG");
      const body=h("div",{class:"form-grid"},[
        U.field("Product",U.selectHTML("w_item",fgs.map(i=>({v:i.id,l:U.trim(i.name,36)})),fgs[0].id),"full"),
        U.field("Quantity (kg)",`<input class="input" id="w_qty" type="number" value="100">`),
        U.field("Production Line",U.selectHTML("w_line",[{v:"Coating Line 1",l:"Coating Line 1"},{v:"Coating Line 2",l:"Coating Line 2"},{v:"Slitting A",l:"Slitting A"},{v:"Slitting B",l:"Slitting B"}],"Coating Line 1")),
        U.field("Due Date",`<input class="input" id="w_due" type="date" value="${DB.helpers.daysAhead(7)}">`),
        U.field("Priority",U.selectHTML("w_prio",[{v:"Normal",l:"Normal"},{v:"High",l:"High"},{v:"Urgent",l:"Urgent"}],"Normal")),
      ]);
      const matHost=h("div",{style:"margin-top:16px"});
      body.appendChild(matHost);
      const recalc=()=>{ const id=UI.$("#w_item").value, qty=+UI.$("#w_qty").value||0; const bom=ENG.data.boms[id];
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
      function save(){
        const id=UI.$("#w_item").value, qty=+UI.$("#w_qty").value;
        if(!qty||qty<=0){ toast("Enter a valid quantity",{type:"warn"}); return; }
        const woId="WO-"+String(1000+ENG.data.workorders.length+1).slice(1);
        ENG.data.workorders.push({id:woId, date:DB.helpers.iso(DB.helpers.today()), itemId:id, qty, status:"Released",
          due:UI.$("#w_due").value, line:UI.$("#w_line").value, progress:0, priority:UI.$("#w_prio").value});
        App.persistAndRefresh(); mo.close(); toast(woId+" created",{type:"ok"}); tab="active"; draw();
      }
    }
  }};

  /* ============== PRODUCTS & BOM ============== */
  M.bom = { title:"Products & BOM", sub:"Recipes & cost roll-up", render(root){
    root.appendChild(pageHead("Products & Bill of Materials","Chhaperia cable-tape range with live material cost roll-up, margin analysis & specifications"));
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
              h("span",{text:U.trim(r.name,30)}), h("span",{class:"mono muted",text:ENG.num(per,3)+" "+r.uom+"/kg"})
            ]); }))
        ]):h("div",{class:"muted",style:"font-size:12px",text:"No BOM defined"})
      ]);
    }
  }};

  function stat(label,val){ return h("div",{},[h("div",{class:"muted",style:"font-size:10.5px;font-weight:700;text-transform:uppercase",text:label}),h("div",{style:"font-weight:700;font-size:15px;margin-top:2px",text:val})]); }
})();
