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
  /* The source sheet's LAYERS column ("TOP LAYER", "DIP COAT", "DOUBLE BLADE
     DOUBLE SIDE"…) travels on the FG item as layersText, alongside the layer
     count derived from the recipe's GSM-bearing fabric lines.
     Single-layer products show NOTHING — the layer story only appears when
     the product actually stacks more than one web. */
  function layersLabel(fg){
    if(!fg) return null;
    const n=fg.layerCount||0;
    if(n<2 && !fg.layersText) return null;
    const bits=[];
    if(fg.layersText) bits.push(fg.layersText);
    if(n>1) bits.push(n+" layers");
    return bits.length? bits.join(" · ") : null;
  }

  /* ---- layer build-up panel ----
     Format: the LAYER NAME as a heading, and beneath it every raw material
     that belongs to that layer; then the next layer's heading, and so on.
     Real layer names come from the sheet's LAYERS column carried on each
     BOM line (line.layer — "TOP LAYER", "BOTTOM LAYER", …). Where a product
     has no layer labels, each metre-measured (fabric/tape) line starts a
     new "LAYER n" group and the chemicals after it belong to that layer.
     Products that don't stack more than one layer show no layer UI at all. */
  /* group normalized BOM lines into layer sections: real labels from the
     sheet when present; otherwise each metre-measured line starts a
     "LAYER n" group; a recipe with no fabric at all = one unlabeled group */
  function layerGroups(lines){
    const groups=[];
    if(!lines.length) return groups;
    if(lines.some(l=>l.layer)){
      let g=null;
      lines.forEach(l=>{
        if(l.layer && (!g || g.label!==l.layer)){ g={label:l.layer, lines:[]}; groups.push(g); }
        if(!g){ g={label:null, lines:[]}; groups.push(g); }
        g.lines.push(l);
      });
    } else {
      const mtrCount=lines.filter(l=>BOMCALC.normUnit(l.unit)==="MTR").length;
      if(mtrCount<2){ groups.push({label:null, lines:lines.slice()}); return groups; }
      const pre=[]; let g=null, n=0;
      lines.forEach(l=>{
        if(BOMCALC.normUnit(l.unit)==="MTR"){ n++; g={label:"LAYER "+n, lines:[]}; groups.push(g); }
        if(g) g.lines.push(l); else pre.push(l);
      });
      if(pre.length && groups.length) groups[0].lines=pre.concat(groups[0].lines);
    }
    return groups;
  }
  function matLineName(l){ const it=l.id?ENG.item(l.id):null;
    if(it) return U.matDisplay(it);
    return l.rmType? l.rmType+" — "+(l.rm||"") : (l.rm||"—"); }
  function matLineSpec(l){ const bits=[];
    if(l.rmThk) bits.push(l.rmThk+" mm"); if(l.rmGsm) bits.push(l.rmGsm+" g/m²");
    return bits.join(" · "); }

  function layerPanel(fg, rawLines){
    if(!fg || !rawLines) return null;
    const lines=BOMCALC.normalize(rawLines);
    if(!lines.length) return null;
    const groups=layerGroups(lines);
    if(groups.length<2) return null;   // no layer story to tell
    const nameOf=matLineName, specOf=matLineSpec;
    const box=h("div",{class:"card",style:"box-shadow:none;background:var(--panel-2);padding:10px 14px;margin-bottom:12px"});
    box.appendChild(h("div",{class:"muted",style:"font-size:10.5px;font-weight:700;text-transform:uppercase;margin-bottom:4px",
      text:"≡ Layer build-up · "+groups.length+" layers"}));
    groups.forEach((g,gi)=>{
      box.appendChild(h("div",{style:"font-weight:800;font-size:12px;text-transform:uppercase;letter-spacing:.4px;margin:"+(gi?12:6)+"px 0 4px;color:var(--accent)",
        text:g.label||("LAYER "+(gi+1))}));
      g.lines.forEach(l=>{
        box.appendChild(h("div",{class:"flex aic",style:"gap:8px;padding:3px 0 3px 14px;font-size:12.5px;border-left:2px solid var(--line);margin-left:2px"},[
          h("span",{style:"font-weight:600",text:nameOf(l)}),
          specOf(l)?h("span",{class:"muted mono",style:"font-size:11.5px",text:specOf(l)}):null,
          h("span",{class:"muted mono",style:"margin-left:auto;font-size:11px;flex:0 0 auto",text:ENG.num(l.qty,2)+" "+(l.unit||"")})
        ]));
      });
    });
    return box;
  }

  /* ---- two-step product picker: NAME first, then THICKNESS ----
     The trailing number in a product code is its thickness, so one product
     name usually exists in several thicknesses. Pick the product, then the
     thickness variant. A hidden input #<id> holds the chosen item id and
     fires "change" exactly like the old single select — existing listeners
     and UI.$("#id").value reads keep working untouched. */
  function fgPicker(id, fgList, selId){
    /* one picker entry per FAMILY — name + family code — so e.g. the
       SEMI CONDUCTIVE WOVEN TAPE range splits into CHNWS / CHNTDM /
       CHNTDMS, each with only its own thicknesses */
    const famOf=f=>U.familyCode(f.typeCode, f.thicknessMM)||U.baseCode(f.typeCode||"")||"";
    const keyOf=f=>famOf(f)+"|"+(f.productName||f.name);
    const byName={};
    fgList.forEach(f=>{ (byName[keyOf(f)]=byName[keyOf(f)]||[]).push(f); });
    Object.values(byName).forEach(a=>a.sort((x,y)=>(x.thicknessMM||0)-(y.thicknessMM||0)));
    const names=Object.keys(byName).sort();
    const init=fgList.find(f=>f.id===selId)||fgList[0];
    let curName=init?keyOf(init):names[0];
    /* option label: family code FIRST, then the product name */
    const nameLabel=key=>{
      const fam=key.split("|")[0], nm=key.split("|").slice(1).join("|");
      return (fam? fam+" — ":"")+nm;
    };
    const hid=h("input",{type:"hidden",id,value:init?init.id:""});
    const thkHost=h("div");
    const wrap=h("div",{style:"display:contents"},[
      hid,
      h("div",{class:"field full"},[h("label",{text:"Product"}),
        h("div",{html:U.searchSelect(id+"_nm", names.map(nm=>({v:nm,l:nameLabel(nm)})), curName, "Search product…")})]),
      h("div",{class:"field"},[h("label",{text:"Thickness"}), thkHost]),
    ]);
    function buildThk(keepId, silent){
      const list=byName[curName]||[];
      const cur=list.find(f=>f.id===keepId)||list[0];
      const sel=h("select",{class:"select",onchange:e=>{ hid.value=e.target.value;
        hid.dispatchEvent(new Event("change",{bubbles:true})); }},
        list.map(f=>h("option",{value:f.id,selected:cur&&f.id===cur.id?"selected":null,
          text:(f.thicknessMM!=null? f.thicknessMM+" mm":(f.typeCode||f.id))})));
      thkHost.innerHTML=""; thkHost.appendChild(sel);
      hid.value=cur?cur.id:"";
      if(!silent) hid.dispatchEvent(new Event("change",{bubbles:true}));
    }
    buildThk(init?init.id:null, true);
    const nmHid=wrap.querySelector('input[id="'+id+'_nm"]');
    if(nmHid) nmHid.addEventListener("change",()=>{ if(nmHid.value && nmHid.value!==curName){ curName=nmHid.value; buildThk(); } });
    return wrap;
  }
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

  /* ---- time-status helpers (per-stage timing for the detail modal) ---- */
  function fmtDT(s){
    if(!s) return "—";
    if(typeof s==="string" && s.indexOf("T")>=0){
      const d=new Date(s); if(isNaN(d.getTime())) return s;
      return d.toLocaleString(undefined,{day:"2-digit",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit"});
    }
    return s; // date-only (legacy work orders)
  }
  function durBetween(a,b){
    if(!a||!b||String(a).indexOf("T")<0||String(b).indexOf("T")<0) return "—";
    const ms=new Date(b)-new Date(a); if(isNaN(ms)||ms<0) return "—";
    const mins=Math.round(ms/60000), hh=Math.floor(mins/60), mm=mins%60;
    if(mins<1) return "<1m";
    return hh? (hh+"h "+mm+"m") : (mm+"m");
  }
  // per-stage timing table shown under the "Time Status" tab of a work order
  function stageTimeStatus(wo){
    const rt=wo.route||[];
    const wrap=h("div",{style:"margin-top:4px"});
    // work order creation — the origin of the production timeline
    const createdAt=wo.createdAt||wo.date;
    wrap.appendChild(h("div",{class:"flex between aic",style:"padding:9px 12px;border:1px solid var(--line);border-radius:8px;margin-bottom:14px"},[
      h("div",{},[h("div",{style:"font-weight:700;font-size:12.5px",text:"🗓 Work Order Created"}), wo.createdBy?h("div",{class:"muted",style:"font-size:11px",text:"by "+wo.createdBy}):null]),
      h("div",{class:"mono",style:"font-size:12.5px;font-weight:600",text:fmtDT(createdAt)})
    ]));
    if(!rt.length){ wrap.appendChild(h("div",{class:"muted",style:"font-size:12px",text:"No routing — legacy work order (no per-stage timing captured)."})); return wrap; }
    const nowISO=new Date().toISOString();
    const rows=rt.map((s,i)=>{
      const started=s.startedAt, done=s.doneAt;
      let duration;
      if(done) duration=durBetween(started,done);
      else if(s.status==="In Production" && started) duration="⏱ "+durBetween(started,nowISO);
      else duration="—";
      return { stage:STAGE_LABEL[s.key]||s.name||s.key, status:s.status,
        started:fmtDT(started), completed:fmtDT(done), duration, by:s.doneBy||s.startedBy||"—",
        cur:(i===(wo.stageIdx||0))&&!wo.dispatched&&s.status!=="Completed" };
    });
    wrap.appendChild(table(rows,[
      {key:"stage",label:"Stage",noSort:true,render:r=>`<span class="cell-main">${esc(r.stage)}</span>${r.cur?' <span class="chip" style="color:var(--info);border-color:var(--info)">current</span>':''}`},
      {key:"status",label:"Status",noSort:true,render:r=>badge(r.status==="Completed"?"ok":r.status==="In Production"?"info":"warn",r.status)},
      {key:"started",label:"Started",noSort:true,render:r=>esc(r.started)},
      {key:"completed",label:"Completed",noSort:true,render:r=>esc(r.completed)},
      {key:"duration",label:"Duration",noSort:true,render:r=>`<span class="mono">${esc(r.duration)}</span>`},
      {key:"by",label:"By",noSort:true,render:r=>esc(r.by)},
    ],{empty:"No stages"}));
    // summary: total lead time + dispatch
    const starts=rt.map(s=>s.startedAt).filter(x=>x&&String(x).indexOf("T")>=0).sort();
    const lastDone=wo.dispatchedAt||wo.packedAt||rt.map(s=>s.doneAt).filter(x=>x&&String(x).indexOf("T")>=0).sort().slice(-1)[0];
    const parts=[];
    if(starts[0]&&lastDone) parts.push("Total lead time: "+durBetween(starts[0],lastDone));
    if(wo.dispatched&&wo.dispatchedAt) parts.push("Dispatched: "+fmtDT(wo.dispatchedAt)+(wo.dispatchedBy?(" · by "+wo.dispatchedBy):""));
    if(parts.length) wrap.appendChild(h("div",{class:"muted",style:"font-size:12px;margin-top:12px",text:parts.join("    ·    ")}));
    return wrap;
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
        {key:"item",label:"Product",render:r=>`<div class="cell-main">${esc((ENG.item(r.itemId)||{}).name||r.itemId)}</div>`,sort:r=>(ENG.item(r.itemId)||{}).name||r.itemId},
        {key:"code",label:"Code",render:r=>{const it=ENG.item(r.itemId)||{};return `<span class="mono muted">${esc(U.familyCode(it.typeCode,it.thicknessMM)||it.typeCode||r.itemId)}</span>`;},sort:r=>r.itemId},
        {key:"thk",label:"Thickness",num:true,render:r=>{const t=(ENG.item(r.itemId)||{}).thicknessMM; return t!=null?`<span class="mono">${ENG.num(t,3)}</span> <span class="muted">mm</span>`:'<span class="muted">—</span>';},sort:r=>(ENG.item(r.itemId)||{}).thicknessMM||0},
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
      // Stage-determining actions (Start / Finish / Complete all) are for
      // supervisors + admin only. Office plans work orders but does not drive
      // process stages, so it just gets a read-only View.
      if(!finished && App.isAdmin()){
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
      const rows = bom? BOMCALC.toLegacy(bom,BOMCALC.metaFromItem(it)).map(([rid,per])=>{ const need=per*wo.qty/bom.yield; const st=ENG.stock(rid); const r=ENG.item(rid)||{};
        return {rid, name:r.id?U.matDisplay(r):rid, per, need, have:st.onHand, ok:st.onHand>=need, uom:r.uom||""}; }):[];
      // ---- Details pane ----
      const detailsPane=h("div",{},[
        MW.dl([["Product",it.name],["Code",U.familyCode(it.typeCode,it.thicknessMM)||it.typeCode||wo.itemId],
          ...(it.thicknessMM!=null?[["Thickness",it.thicknessMM+" mm"]]:[]),
          ["Quantity",ENG.num(wo.qty)+" kg"],["Line",wo.line],["Status",badge((wo.status==="Completed"||wo.status==="Dispatched")?"ok":"info",wo.status)],
          ["Start",wo.date],["Due",wo.due],["Yield",bom?(bom.yield*100).toFixed(0)+"%":"—"],["Progress",wo.progress+"%"]]),
        stageTimeline(wo),
        (()=>{ const lp=bom?layerPanel(it,bom.lines):null; return lp?h("div",{style:"margin-top:14px"},lp):h("span"); })(),
        h("h3",{style:"margin:18px 0 10px;font-size:14px",text:"Material Requirements (auto from BOM)"}),
        table(rows,[
          {key:"name",label:"Component",render:r=>`<div class="cell-main">${esc(r.name)}</div>`,noSort:true},
          {key:"code",label:"Code",render:r=>`<span class="mono muted">${esc(r.rid)}</span>`,noSort:true},
          {key:"per",label:"Per kg",num:true,render:r=>ENG.num(r.per,3),noSort:true},
          {key:"need",label:"Required",num:true,render:r=>`<span class="strong">${ENG.num(r.need,2)}</span> ${r.uom}`,noSort:true},
          {key:"have",label:"In Stock",num:true,render:r=>ENG.num(r.have,1),noSort:true},
          {key:"ok",label:"",noSort:true,render:r=>badge(r.ok?"ok":"danger",r.ok?"Available":"Short")},
        ],{empty:"No BOM"})
      ]);
      // ---- Time Status pane (per-stage timing of the production route) ----
      const timePane=stageTimeStatus(wo); timePane.hidden=true;
      // ---- tab bar ----
      const tabs=h("div",{class:"seg",style:"margin-bottom:16px"});
      const tabD=h("button",{class:"on",text:"Details"});
      const tabT=h("button",{text:"⏱ Time Status"});
      const sel=(showD)=>{ detailsPane.hidden=!showD; timePane.hidden=showD; tabD.classList.toggle("on",showD); tabT.classList.toggle("on",!showD); };
      tabD.onclick=()=>sel(true); tabT.onclick=()=>sel(false);
      tabs.appendChild(tabD); tabs.appendChild(tabT);
      const body=h("div",{},[tabs,detailsPane,timePane]);
      const finished=wo.status==="Completed"||wo.status==="Dispatched";
      modal({title:wo.id, sub:it.name, wide:true, body,
        foot:[ (finished||!App.isAdmin())?null:h("button",{class:"btn primary",onclick:()=>{UI.$("#modalHost").hidden=true;completeWO(wo);},text:"Complete all stages"}) ]});
    }

    function woForm(){
      const fgs=ENG.data.items.filter(i=>i.cat==="FG");
      const body=h("div",{class:"form-grid"},[
        fgPicker("w_item", fgs, fgs[0]&&fgs[0].id),
        U.field("Quantity",`<div class="flex" style="gap:6px"><input class="input" id="w_qty" type="number" min="0" value="100" style="flex:1"><select class="select" id="w_unit" style="width:92px" title="Enter the run size in kilograms or square metres"><option value="KG">kg</option><option value="SQM">sqm</option></select></div><div class="muted" id="w_conv" style="font-size:11px;margin-top:3px"></div>`),
        U.field("Production Line",U.selectHTML("w_line",[{v:"Coating Line 1",l:"Coating Line 1"},{v:"Coating Line 2",l:"Coating Line 2"},{v:"Fibre-Glass Line 1",l:"Fibre-Glass Line 1"},{v:"Fibre-Glass Line 2",l:"Fibre-Glass Line 2"},{v:"Slitting A",l:"Slitting A"},{v:"Slitting B",l:"Slitting B"}],"Coating Line 1")),
        U.field("Due Date",`<input class="input" id="w_due" type="date" value="${DB.helpers.daysAhead(7)}">`),
        U.field("Priority",U.selectHTML("w_prio",[{v:"Normal",l:"Normal"},{v:"High",l:"High"},{v:"Urgent",l:"Urgent"}],"Normal")),
      ]);
      // the form body is a 2-column grid — without an explicit span these
      // hosts land in ONE column and the materials list gets half the modal
      const specHost=h("div",{style:"margin-top:4px;grid-column:1/-1"});
      body.appendChild(specHost);
      const matHost=h("div",{style:"margin-top:4px;grid-column:1/-1"});
      body.appendChild(matHost);
      let matChoices={};        // ranged line index -> chosen stock item id
      /* The run size can be entered in kg or sqm; the engine (and the server)
         work in kg, so a sqm entry is converted through the FG's GSM
         (kg = sqm × g/m² / 1000). Returns null when sqm is chosen but the
         product has no GSM to convert with. */
      const qtyKg=()=>{ const q=+UI.$("#w_qty").value||0;
        if((UI.$("#w_unit")||{}).value!=="SQM") return q;
        const gsm=BOMCALC.metaFromItem(ENG.item(UI.$("#w_item").value)||{}).fgGsm;
        return gsm? q*gsm/1000 : null; };
      const convHint=()=>{ const el=UI.$("#w_conv"); if(!el) return;
        const q=+UI.$("#w_qty").value||0, unit=UI.$("#w_unit").value;
        const gsm=BOMCALC.metaFromItem(ENG.item(UI.$("#w_item").value)||{}).fgGsm;
        if(!gsm){ el.textContent = unit==="SQM" ? "This product has no GSM — cannot convert sqm to kg. Enter the quantity in kg." : ""; el.style.color=unit==="SQM"?"var(--danger)":""; return; }
        el.style.color="";
        el.textContent = unit==="SQM" ? ("= "+ENG.num(q*gsm/1000,1)+" kg · FG "+gsm+" g/m²")
                                      : ("= "+ENG.num(q*1000/gsm,0)+" sqm · FG "+gsm+" g/m²"); };
      const recalc=()=>{ const id=UI.$("#w_item").value; convHint(); const qty=qtyKg()||0; const bom=ENG.data.boms[id];
        // per-order production spec (e.g. copper-wire count) for products that need it
        specHost.innerHTML="";
        const spec=ORDER_SPEC[id];
        if(spec){ specHost.appendChild(U.field(spec.label,`<input class="input" id="w_spec" type="number" min="0" placeholder="as per order">`)); }
        matHost.innerHTML=""; if(!bom) return;

        // the layer layout below carries the materials AND their live
        // need / in-store figures — no separate consumption list

        /* ---- ranged materials: pick the real one from what the store holds ----
           The BOM records a choice ("CLOFT 912 / CLOFT 913") or a span
           ("0.08-0.10") rather than one material. Which is actually issued is
           decided here, against live stock. */
        const norm=BOMCALC.normalize(bom.lines);
        const ranged=norm.map((l,i)=>({l,i})).filter(x=>x.l.ranged);
        if(ranged.length){
          matHost.appendChild(h("div",{class:"muted",style:"font-size:11px;font-weight:700;text-transform:uppercase;margin-bottom:8px",text:"⟡ Choose material to issue"}));
          ranged.forEach(({l,i})=>{
            const cands=BOMCALC.candidatesFor(l,ENG.data.items)
              .map(cid=>({id:cid,item:ENG.item(cid)||{},have:(ENG.stock(cid)||{}).onHand||0}))
              .sort((a,b)=>b.have-a.have);
            const inStock=cands.filter(c=>c.have>0);
            const usable=inStock.length?inStock:cands;
            if(matChoices[i]==null && usable.length) matChoices[i]=usable[0].id;
            const sel=h("select",{class:"select",style:"max-width:340px",
              onchange:e=>{ matChoices[i]=e.target.value; recalc(); }},
              usable.map(c=>h("option",{value:c.id,selected:matChoices[i]===c.id,
                text:(c.item.id?U.matDisplay(c.item):c.id)+" · "+ENG.num(c.have,1)+" "+(c.item.uom||"")+" in store"})));
            matHost.appendChild(h("div",{style:"margin-bottom:8px"},[
              h("div",{class:"muted",style:"font-size:11.5px;margin-bottom:3px",
                text:(l.rmType? l.rmType+" — ":"")+(l.rm||"")+(l.rmThk?" · "+l.rmThk+" mm":"")+(l.rmGsm?" · "+l.rmGsm+" g/m²":"")}),
              usable.length? sel : h("div",{class:"muted",style:"font-size:12px;color:var(--danger)",text:"No matching material found in the store"})
            ]));
          });
        }

        /* ---- materials grouped by layer — the ONE list for every product:
           the layer name as a heading, that layer's materials beneath it,
           each row carrying its live need / in-store / short figures.
           Single-layer and no-layer products use the exact same row
           layout, just without layer headings. ---- */
        const fgIt=ENG.item(id);
        const resolved=BOMCALC.resolve(bom, matChoices);
        const cc=BOMCALC.compute({lines:resolved}, BOMCALC.metaFromItem(fgIt));
        const perOf=l=> cc.fgKgPerBatch? l.qty/cc.fgKgPerBatch : l.qty;
        const needBy={};             // a fabric can sit in two layers — stock is shared
        resolved.forEach(l=>{ if(l.id) needBy[l.id]=(needBy[l.id]||0)+perOf(l)*qty/bom.yield; });
        const groups=layerGroups(resolved);
        const multi=groups.length>1;
        matHost.appendChild(h("div",{class:"muted",style:"font-size:11px;font-weight:700;text-transform:uppercase;margin:14px 0 8px",
          text: multi? "≡ Materials by layer · "+groups.length+" layers" : "Materials to be consumed"}));
        groups.forEach((grp,gi)=>{
          if(multi) matHost.appendChild(h("div",{style:"font-weight:800;font-size:12px;text-transform:uppercase;letter-spacing:.4px;margin:"+(gi?12:2)+"px 0 4px;color:var(--accent)",
            text:grp.label||("LAYER "+(gi+1))}));
          grp.lines.forEach(l=>{
            const rid=l.id;
            const need=perOf(l)*qty/bom.yield;
            const r=rid?(ENG.item(rid)||{}):{};
            const have=rid?(ENG.stock(rid).onHand||0):0;
            const agg=rid?needBy[rid]:need;
            const ok=have>=agg-1e-9;
            const spec=matLineSpec(l);
            matHost.appendChild(h("div",{class:"flex between aic",
              style:"gap:10px;font-size:12.5px;padding:6px 0;border-bottom:1px solid var(--line)"+(multi?";padding-left:14px;border-left:2px solid var(--line);margin-left:2px":"")},[
              h("div",{style:"min-width:0"},[
                h("div",{style:"font-weight:600",text:matLineName(l)}),
                spec?h("div",{class:"muted mono",style:"font-size:11px",text:spec}):null
              ]),
              h("div",{class:"flex aic",style:"gap:10px;flex:0 0 auto;white-space:nowrap"},[
                h("span",{class:"muted",text:"Need "},[h("b",{class:"mono",style:"color:var(--text)",text:ENG.num(need,2)+" "+(r.uom||l.unit||"")})]),
                h("span",{class:"muted",text:"In store "},[h("b",{class:"mono",style:"color:"+(ok?"var(--text)":"var(--danger)"),text:ENG.num(have,1)+" "+(r.uom||l.unit||"")})]),
                h("span",{html:badge(ok?"ok":"danger",ok?"OK":"Short by "+ENG.num(agg-have,2))})
              ])
            ]));
          });
        });
      };
      const mo=modal({title:"New Work Order", sub:"Plan a production run", body,
        foot:[h("button",{class:"btn ghost",onclick:()=>mo.close(),text:"Cancel"}),
          h("button",{class:"btn primary",onclick:save,text:"Create Work Order"})]});
      setTimeout(()=>{ UI.$("#w_item").addEventListener("change",recalc); UI.$("#w_qty").addEventListener("input",recalc); UI.$("#w_unit").addEventListener("change",recalc); recalc(); },50);
      async function save(){
        const itemId=UI.$("#w_item").value, qty=qtyKg();
        if(qty==null){ toast("This product has no GSM — enter the quantity in kg",{type:"warn"}); return; }
        if(!qty||qty<=0){ toast("Enter a valid quantity",{type:"warn"}); return; }
        const payload={itemId, qty, line:UI.$("#w_line").value, due:UI.$("#w_due").value, priority:UI.$("#w_prio").value};
        // which material was picked for each ranged BOM line — travels with the
        // work order so the issue posts the material actually chosen
        if(Object.keys(matChoices).length) payload.materialChoices=matChoices;
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
      h("button",{class:"btn",onclick:()=>bomCalc(),html:"🧮 BOM Calculator"}),
      h("button",{class:"btn primary",onclick:()=>bomForm(),html:"＋ Create BOM"})
    ]));
    const fgs=ENG.data.items.filter(i=>i.cat==="FG");
    /* Grouping is DATA-DRIVEN: whatever `group` values actually exist get a
       section, known keys in a preferred order and anything else appended.
       A hardcoded list would silently hide every product whose series isn't
       on it — which is exactly what happened when the real catalogue landed
       with series names instead of the old MICA/WBT/SCT/OCT codes. */
    const GROUP_META={
      MICA:{label:"🔥 Mica Tapes", sub:"Fire-survival / high-voltage insulation"},
      WBT:{label:"💧 Water Blocking Tapes", sub:"Power & optical cable moisture barrier"},
      SCT:{label:"⚡ Semi-Conducting Tapes", sub:"Conductor & insulation screens"},
      OCT:{label:"🎞️ Other Cable Tapes", sub:"Shielding, binding & specialty"},
      "MICA SERIES":{label:"🔥 Mica Series", sub:"Fire-survival / high-voltage insulation"},
      "WATER BLOCKING SERIES":{label:"💧 Water Blocking Series", sub:"Power & optical cable moisture barrier"},
      "OTHER TAPE SERIES":{label:"🎞️ Other Tape Series", sub:"Semi-conducting, shielding, binding & specialty"},
    };
    const PREFERRED=["MICA","MICA SERIES","WBT","WATER BLOCKING SERIES","SCT","OCT","OTHER TAPE SERIES"];
    const present=[...new Set(fgs.map(f=>f.group||"—"))];
    const groups=[
      ...PREFERRED.filter(k=>present.includes(k)),
      ...present.filter(k=>!PREFERRED.includes(k)).sort(),
    ].map(k=>Object.assign({key:k, label:k==="—"?"Ungrouped":k, sub:""}, GROUP_META[k]));

    /* search across every series — no scrolling needed to find a product */
    let bomQ="";
    root.appendChild(h("div",{class:"toolbar"},[
      MW.searchInput("Search products by name, code, series or thickness…", v=>{bomQ=v.toLowerCase().trim(); drawGroups();}),
      h("div",{style:"margin-left:auto"},h("span",{class:"chip",id:"bomCount"}))
    ]));
    const groupHost=h("div");
    root.appendChild(groupHost);
    function drawGroups(){
      groupHost.innerHTML="";
      const match=fgs.filter(f=>!bomQ ||
        (f.name+" "+f.id+" "+(f.group||"")+" "+(f.typeCode||"")+" "+(f.hsn||"")).toLowerCase().includes(bomQ));
      const cnt=UI.$("#bomCount"); if(cnt) cnt.textContent=match.length+" of "+fgs.length+" products";
      groups.forEach(g=>{
        const list=match.filter(f=>(f.group||"—")===g.key);
        if(!list.length) return;
        groupHost.appendChild(h("div",{class:"flex aic gap",style:"margin:20px 0 12px"},[
          h("h2",{style:"font-size:17px;font-weight:800",text:g.label}),
          h("span",{class:"muted",style:"font-size:12.5px",text:"· "+g.sub}),
          h("span",{class:"chip",style:"margin-left:auto",text:list.length+" products"})
        ]));
        groupHost.appendChild(productTable(list));
      });
      if(!match.length) groupHost.appendChild(h("div",{class:"empty"},[
        h("div",{class:"big",text:"∅"}),h("div",{text:"No products match “"+bomQ+"”"})]));
    }
    drawGroups();
    if(params&&params.openNew){ params.openNew=false; bomForm(); }

    /* ----- BOM Calculator: material requirement for a production run ----- */
    function bomCalc(){
      const withBom=ENG.data.items.filter(i=>i.cat==="FG" && ENG.data.boms[i.id]);
      if(!withBom.length){ toast("No product has a BOM yet — create one first",{type:"warn"}); return; }
      const body=h("div",{},[
        h("p",{class:"dim",style:"margin-bottom:12px",text:"Pick a finished product and a target production quantity to see the raw materials required (per the current BOM), with available stock and any shortfall."}),
        h("div",{class:"form-grid"},[
          fgPicker("bc_fg", withBom, withBom[0].id),
          U.field("Quantity to produce", `<div class="flex" style="gap:6px"><input class="input" id="bc_qty" type="number" step="0.1" min="0" value="100" style="flex:1"><select class="select" id="bc_unit" style="width:92px" title="Enter the run size in kilograms or square metres"><option value="KG">kg</option><option value="SQM">sqm</option></select></div><div class="muted" id="bc_conv" style="font-size:11px;margin-top:3px"></div>`),
        ]),
        h("div",{id:"bc_out",style:"margin-top:14px"})
      ]);
      const mo=modal({title:"🧮 BOM Calculator", sub:"Material requirement for a production run — uses the current BOM", wide:true, body,
        foot:[h("button",{class:"btn primary",onclick:()=>mo.close(),text:"Close"})]});
      function recalc(){
        const id=UI.$("#bc_fg").value, raw=+UI.$("#bc_qty").value||0, unit=UI.$("#bc_unit").value;
        const bom=ENG.data.boms[id], out=UI.$("#bc_out"); if(!out) return; out.innerHTML="";
        if(!bom){ out.appendChild(h("div",{class:"muted",text:"No BOM for this product."})); return; }
        const fg=ENG.item(id)||{name:id};
        // the engine works in kg; a sqm entry converts through the FG's GSM
        const gsm=BOMCALC.metaFromItem(fg).fgGsm;
        const conv=UI.$("#bc_conv");
        if(unit==="SQM" && !gsm){
          if(conv){ conv.textContent="This product has no GSM — cannot convert sqm to kg. Enter the quantity in kg."; conv.style.color="var(--danger)"; }
          out.appendChild(h("div",{class:"muted",text:"Pick kg, or set the product's GSM to calculate from sqm."})); return;
        }
        if(conv){ conv.style.color="";
          conv.textContent = !gsm ? "" : unit==="SQM" ? ("= "+ENG.num(raw*gsm/1000,1)+" kg · FG "+gsm+" g/m²")
                                                      : ("= "+ENG.num(raw*1000/gsm,0)+" sqm · FG "+gsm+" g/m²"); }
        const qty = unit==="SQM" ? raw*gsm/1000 : raw;
        const rows=BOMCALC.toLegacy(bom,BOMCALC.metaFromItem(fg)).map(([rid,per])=>{ const need=per*qty/bom.yield; const st=ENG.stock(rid)||{}; const have=st.onHand||0;
          const r=ENG.item(rid)||{}; return {rid, name:r.name||rid, uom:r.uom||"", per, need, have, short:Math.max(0,need-have), avgCost:st.avgCost||r.cost||0}; });
        const totCost=rows.reduce((s,x)=>s+x.need*x.avgCost,0);
        out.appendChild(h("div",{class:"flex between aic wrap",style:"margin-bottom:10px;gap:8px"},[
          h("div",{style:"font-weight:700",text:fg.name+" · "+(unit==="SQM"? ENG.num(raw,0)+" sqm ("+ENG.num(qty,1)+" kg)" : ENG.num(qty,1)+" kg")+" @ "+Math.round(bom.yield*100)+"% yield"}),
          h("span",{class:"chip",text:rows.length+" materials · est. ₹"+ENG.num(totCost,0)})
        ]));
        out.appendChild(table(rows,[
          {key:"name",label:"Raw Material",render:r=>esc(r.name)},
          {key:"per",label:"Per kg",num:true,render:r=>ENG.num(r.per,3)+" "+esc(r.uom),sort:r=>r.per},
          {key:"need",label:"Required",num:true,render:r=>"<b>"+ENG.num(r.need,2)+"</b> "+esc(r.uom),sort:r=>r.need},
          {key:"have",label:"In Stock",num:true,render:r=>ENG.num(r.have,1)+" "+esc(r.uom),sort:r=>r.have},
          {key:"short",label:"Shortfall",num:true,render:r=> r.short>0? badge("danger",ENG.num(r.short,2)+" "+r.uom): badge("ok","OK"),sort:r=>r.short},
        ],{empty:"No components"}));
      }
      setTimeout(()=>{ const s=UI.$("#bc_fg"); if(s) s.addEventListener("change",recalc); const q=UI.$("#bc_qty"); if(q) q.addEventListener("input",recalc); const u=UI.$("#bc_unit"); if(u) u.addEventListener("change",recalc); recalc(); },50);
    }

    /* ----- Table View (clean & structured) --------------------------------
       One sortable row per product: cost roll-up, margin, yield and the BOM
       at a glance. Clicking a row opens the full BOM details; the pencil
       edits (or adds) the recipe. */
    function matCostOf(fg){
      const bom=ENG.data.boms[fg.id]; let c=0;
      if(bom) BOMCALC.toLegacy(bom,BOMCALC.metaFromItem(fg)).forEach(([rid,per])=>{ c+=per*ENG.stock(rid).avgCost/bom.yield; });
      return c;
    }
    function marginOf(fg){ return fg.price? ((fg.price-fg.cost)/fg.price*100):0; }
    function productTable(list){
      return table(list,[
        {key:"product",label:"Product",render:fg=>`<div class="cell-main">${esc(fg.name)}</div>`,sort:fg=>fg.name},
        {key:"code",label:"Code",render:fg=>`<span class="chip"><b>${esc(U.familyCode(fg.typeCode,fg.thicknessMM)||fg.typeCode||fg.id)}</b></span>`,sort:fg=>fg.typeCode||fg.id},
        {key:"thk",label:"Thickness",num:true,render:fg=>fg.thicknessMM!=null?`<span class="mono">${ENG.num(fg.thicknessMM,3)}</span> <span class="muted">mm</span>`:'<span class="muted">—</span>',sort:fg=>fg.thicknessMM||0},
        {key:"layers",label:"Layers",num:true,render:fg=>(fg.layerCount||0)>1?`<span class="chip" style="font-size:11px">≡ ${fg.layerCount}</span>`:'<span class="muted">—</span>',sort:fg=>fg.layerCount||0},
        {key:"mat",label:"Material Cost",num:true,render:fg=>"₹"+ENG.num(matCostOf(fg),0),sort:matCostOf},
        {key:"cost",label:"Std Cost",num:true,render:fg=>"₹"+ENG.num(fg.cost,0),sort:fg=>fg.cost},
        {key:"price",label:"Price",num:true,render:fg=>"₹"+ENG.num(fg.price,0),sort:fg=>fg.price},
        {key:"margin",label:"Gross Margin",num:true,render:fg=>{const m=marginOf(fg);return badge(m>30?"ok":m>15?"warn":"danger",m.toFixed(1)+"%");},sort:marginOf},
        {key:"yield",label:"Yield",num:true,render:fg=>{const b=ENG.data.boms[fg.id];
          return b?`<span style="color:var(--ok);font-weight:700">${(b.yield*100).toFixed(0)}%</span>`:'<span class="muted">—</span>';},
          sort:fg=>(ENG.data.boms[fg.id]||{}).yield||0},
        {key:"bom",label:"BOM",render:fg=>{const b=ENG.data.boms[fg.id];
          return b?`<span style="color:var(--accent);font-weight:600;font-size:12px">${BOMCALC.normalize(b.lines).length} components ›</span>`:'<span class="muted">No BOM</span>';},noSort:true},
        {key:"act",label:"",noSort:true,render:fg=>{const b=ENG.data.boms[fg.id];
          return h("button",{class:"btn sm ghost",title:b?"Edit this BOM":"Add a BOM",onclick:()=>bomForm(fg.id),html:b?"✎":"＋"});}},
      ],{empty:"No products in this series",
         onRow:fg=>{ if(ENG.data.boms[fg.id]) bomView(fg.id); else bomForm(fg.id); }});
    }

    /* ----- read-only BOM details ------------------------------------------
       Everything Edit BOM derives, without the inputs: per-component qty,
       GSM, pickup %, consumption per kg / per sqm, and the batch totals —
       switchable between alternate approved recipes. */
    function bomView(fgId){
      const fg=ENG.item(fgId)||{id:fgId,name:fgId};
      const bom=ENG.data.boms[fgId];
      if(!bom){ toast("No BOM for this product",{type:"warn"}); return; }
      const meta=BOMCALC.metaFromItem(fg);
      const n=(v,d)=> v==null||isNaN(v) ? "—" : ENG.num(v,d);
      let altIdx=0;
      const basisHost=h("div",{class:"muted",style:"font-size:12px;margin-bottom:10px"});
      const layHost=h("div");
      const altHost=h("div",{style:"margin-bottom:10px"});
      const tblHost=h("div",{style:"overflow-x:auto"});
      const totHost=h("div",{style:"margin-top:14px"});
      const body=h("div",{},[basisHost,layHost,altHost,
        h("h3",{style:"margin:4px 0 8px;font-size:13px",text:"Components (quantity per batch)"}),
        tblHost,totHost]);
      const mo=modal({title:"BOM · "+(U.familyCode(fg.typeCode,fg.thicknessMM)||fg.typeCode||fgId), sub:fg.name+(fg.thicknessMM!=null?" · "+fg.thicknessMM+" mm":""), wide:true, body,
        foot:[h("button",{class:"btn ghost",onclick:()=>mo.close(),text:"Close"}),
          App.isAdmin()?h("button",{class:"btn primary",onclick:()=>{mo.close();bomForm(fgId);},html:"✎ Edit BOM"}):null]});

      function draw(){
        const src=(bom.alternates && bom.alternates[altIdx])||bom;
        const c=BOMCALC.compute({lines:BOMCALC.normalize(src.lines)}, meta);

        const lay=layersLabel(fg);
        basisHost.textContent=`Batch ${meta.batchWidthMM} mm × ${meta.batchLengthM} m = ${n(c.batchSqm,0)} sqm`
          +(c.fgGsm!=null?` · FG ${n(c.fgGsm,0)} g/m² → ${n(c.fgKgPerBatch,1)} kg per batch`:" · FG GSM not set")
          +` · yield ${(bom.yield*100).toFixed(0)}%`
          +(lay?` · Layers: ${lay}`:"");
        layHost.innerHTML="";
        const lp=layerPanel(fg, src.lines);
        if(lp) layHost.appendChild(lp);

        altHost.innerHTML="";
        if(bom.alternates && bom.alternates.length>1){
          altHost.appendChild(h("div",{class:"flex aic gap wrap"},[
            h("span",{class:"muted",style:"font-size:12px;font-weight:700",text:"Approved recipe:"}),
            ...bom.alternates.map((a,i)=>h("button",{
              class:"btn sm"+(i===altIdx?" primary":" ghost"),
              onclick:()=>{ altIdx=i; draw(); },
              text:a.label||("Variant "+(i+1))
            }))
          ]));
        }

        tblHost.innerHTML="";
        const tbl=h("table",{class:"tbl",style:"width:100%;min-width:820px"});
        tbl.appendChild(h("thead",{},[h("tr",{},
          ["Raw material","Code","Qty / batch","Unit","GSM (g/m²)","Pickup %","Consumption / kg","Consumption / sqm"].map((t,i)=>
            h("th",{style:"font-size:11px;"+(i>=2?"text-align:right":""),text:t})))]));
        const tb=h("tbody");
        c.lines.forEach(cl=>{
          const r=cl.id?ENG.item(cl.id):null;
          const label=r? U.matDisplay(r) : (cl.rmType? cl.rmType+" — "+(cl.rm||"") : (cl.rm||cl.id||"—"));
          tb.appendChild(h("tr",{},[
            h("td",{style:"min-width:200px"},[
              h("div",{class:"flex aic",style:"gap:6px"},[
                h("span",{style:"font-weight:600",text:label}),
                cl.ranged?h("span",{class:"chip",style:"font-size:10px",title:"Resolved against live store stock at work-order issue",text:"⟡ ranged"}):null
              ])
            ]),
            h("td",{class:"mono muted",style:"font-size:11px",text:cl.id||[cl.rm,cl.rmType].filter(Boolean).join(" · ")||"—"}),
            h("td",{class:"mono",style:"text-align:right",text:n(cl.qty,3)}),
            h("td",{style:"text-align:right",text:cl.unit||"—"}),
            h("td",{class:"mono",style:"text-align:right",text:cl.rmGsm!=null?cl.rmGsm:"—"}),
            h("td",{class:"mono",style:"text-align:right",text:cl.fabric?"substrate":(cl.pickupPct!=null?cl.pickupPct+"%":"—")}),
            h("td",{class:"mono",style:"text-align:right",text:cl.consumptionPerKg==null?"—":n(cl.consumptionPerKg,3)}),
            h("td",{class:"mono",style:"text-align:right",text:cl.consumptionPerSqm==null?"—":n(cl.consumptionPerSqm,4)})
          ]));
        });
        tbl.appendChild(tb);
        tblHost.appendChild(tbl);

        totHost.innerHTML="";
        const row=(label,val,strong)=>h("div",{class:"flex between",
          style:"padding:5px 0;border-bottom:1px solid var(--line);font-size:12.5px"+(strong?";font-weight:800":"")},[
          h("span",{class:strong?"":"muted",text:label}), h("span",{class:"mono",text:val})]);
        const box=h("div",{class:"card",style:"background:var(--panel-2);box-shadow:none;padding:12px"});
        box.appendChild(h("div",{class:"muted",style:"font-size:10.5px;font-weight:700;text-transform:uppercase;margin-bottom:6px",text:"Batch totals"}));
        box.appendChild(row("Total qty used (batch, mass basis)", n(c.totalQtyKg,2)+" kg"));
        box.appendChild(row("Total pickup qty", c.totalPickupQty==null?"— set pickup %":n(c.totalPickupQty,2)+" kg"));
        box.appendChild(row("Total pickup — per kg of FG", c.totalPickupPerKg==null?"—":n(c.totalPickupPerKg,4)));
        box.appendChild(row("Total pickup — per sqm", c.totalPickupPerSqm==null?"—":n(c.totalPickupPerSqm,4)+" kg/sqm"));
        box.appendChild(row(`Fabric GSM${c.fabricCount?" ("+c.fabricCount+" layer"+(c.fabricCount>1?"s":"")+")":""}`,
          c.fabricGsm==null?"—":n(c.fabricGsm,1)+" g/m²"));
        box.appendChild(row("Pickup GSM  (FG − fabric)", c.pickupGsm==null?"—":n(c.pickupGsm,1)+" g/m²"));
        box.appendChild(row("TOTAL PRODUCTION", c.totalProductionSqm==null?"—":n(c.totalProductionSqm,0)+" sqm", true));
        let cost=0; BOMCALC.toLegacy({lines:src.lines},meta).forEach(([rid,per])=>{ cost+=per*(ENG.stock(rid).avgCost||0)/bom.yield; });
        box.appendChild(row("Est. material cost — per kg of FG","₹"+n(cost,2)));
        totHost.appendChild(box);
      }
      draw();
    }

    /* ----- create / edit / delete a product's BOM -------------------------
       Quantities are PER BATCH (the standard 1000 mm x 1000 m = 1000 sqm run),
       exactly as the source data records them. Each line carries a pickup % —
       the share of that material that actually ends up in the finished good —
       and from those two numbers everything else is derived:
         consumption/kg, consumption/sqm, pickup qty, and total production.
       All the arithmetic lives in bomcalc.js, shared with the server. */
    function bomForm(fgId){
      const fgs=ENG.data.items.filter(i=>i.cat==="FG");
      // components a person picks by hand — WIP is inserted by the stage engine
      const rms=ENG.data.items.filter(i=>i.cat==="RM"||i.cat==="PKG"||i.cat==="CON");
      if(!fgs.length){ toast("Create a finished-good product first",{type:"warn"}); return; }
      let curFg = fgId || fgs[0].id;
      const existing = fgId? ENG.data.boms[fgId] : null;
      const editing = !!existing;
      let altIdx = 0;                 // which alternate approved recipe is open
      let lines = [];
      let seq = 0;                    // stable per-row id for the material picker

      const blank = () => ({ _k:++seq, id:(rms[0]&&rms[0].id)||null, rm:null, rmType:null,
        rmThk:null, rmGsm:null, qty:0, unit:"KG", pickupPct:null, ranged:false, options:[] });

      function loadLines(){
        const bom = ENG.data.boms[curFg];
        const src = (bom && bom.alternates && bom.alternates[altIdx]) ? bom.alternates[altIdx] : bom;
        lines = BOMCALC.normalize(src && src.lines).map(l=>Object.assign({_k:++seq}, l));
        if(!lines.length) lines=[blank()];
      }
      loadLines();

      const basisHost=h("div",{class:"muted",style:"font-size:12px;margin:2px 0 12px"});
      const layHost=h("div");
      const altHost=h("div",{style:"margin-bottom:10px"});
      const tblHost=h("div",{style:"overflow-x:auto"});
      const totHost=h("div",{style:"margin-top:14px"});

      const curItem=ENG.item(curFg)||{};
      const lockedLabel=(U.familyCode(curItem.typeCode,curItem.thicknessMM)||curItem.typeCode||curFg)
        +" — "+(curItem.productName||curItem.name||curFg)
        +(curItem.thicknessMM!=null?" · "+curItem.thicknessMM+" mm":"");
      const body=h("div",{},[
        h("div",{class:"form-grid"},[
          editing
            ? U.field("Product (Finished Good)",
                `<input type="hidden" id="bm_fg" value="${esc(curFg)}"><input class="input is-locked" readonly value="${esc(lockedLabel)}">`,"full")
            : fgPicker("bm_fg", fgs, curFg),
          U.field("Yield (%)", `<input class="input" id="bm_yield" type="number" step="1" min="1" max="100" value="${existing?Math.round(existing.yield*100):100}">`),
        ]),
        basisHost, layHost, altHost,
        h("h3",{style:"margin:14px 0 8px;font-size:13px",text:"Components (quantity per batch)"}),
        tblHost,
        h("button",{class:"btn sm",style:"margin-top:8px",onclick:()=>{lines.push(blank());draw();},html:"＋ Add component"}),
        totHost,
      ]);

      const foot=[h("button",{class:"btn ghost",onclick:()=>mo.close(),text:"Cancel"})];
      if(editing) foot.push(h("button",{class:"btn danger",onclick:()=>delBom(),text:"🗑 Delete BOM"}));
      foot.push(h("button",{class:"btn primary",onclick:save,text:editing?"Save BOM":"Create BOM"}));
      const mo=modal({title: editing?("Edit BOM · "+curFg):"Create BOM",
        sub:"Material recipe, pickup % and production roll-up", wide:true, body, foot});
      if(!editing){ const fgHid=UI.$("#bm_fg");
        if(fgHid) fgHid.addEventListener("change",()=>{ const v=fgHid.value; if(v&&v!==curFg){ curFg=v; altIdx=0; loadLines(); draw(); } }); }

      const n=(v,d)=> v==null||isNaN(v) ? "—" : ENG.num(v,d);

      function draw(){
        const fg=ENG.item(curFg)||{};
        const meta=BOMCALC.metaFromItem(fg);
        const c=BOMCALC.compute({lines}, meta);

        /* ---- batch basis banner ---- */
        basisHost.innerHTML="";
        const lay=layersLabel(fg);
        basisHost.appendChild(h("span",{text:
          `Batch ${meta.batchWidthMM} mm × ${meta.batchLengthM} m = ${n(c.batchSqm,0)} sqm`
          + (c.fgGsm!=null ? ` · FG ${n(c.fgGsm,0)} g/m² → ${n(c.fgKgPerBatch,1)} kg per batch` : " · FG GSM not set — per-kg figures unavailable")
          + (lay ? ` · Layers: ${lay}` : "")
        }));
        layHost.innerHTML="";
        const lp=layerPanel(fg, lines);
        if(lp) layHost.appendChild(lp);

        /* ---- alternate approved recipes ---- */
        altHost.innerHTML="";
        const bom=ENG.data.boms[curFg];
        if(bom && bom.alternates && bom.alternates.length>1){
          altHost.appendChild(h("div",{class:"flex aic gap wrap"},[
            h("span",{class:"muted",style:"font-size:12px;font-weight:700",text:"Approved recipe:"}),
            ...bom.alternates.map((a,i)=>h("button",{
              class:"btn sm"+(i===altIdx?" primary":" ghost"),
              onclick:()=>{ altIdx=i; loadLines(); draw(); },
              text:a.label||("Variant "+(i+1))
            }))
          ]));
        }

        /* ---- component rows ---- */
        tblHost.innerHTML="";
        const head=["Raw material","Qty / batch","Unit","GSM (g/m²)","Pickup %","Consumption / kg","Consumption / sqm",""];
        const tbl=h("table",{class:"tbl",style:"width:100%;min-width:820px"});
        tbl.appendChild(h("thead",{},[h("tr",{},head.map((t,i)=>
          h("th",{style:"font-size:11px;"+(i>=1&&i<=6?"text-align:right":""),text:t})))]));
        const tb=h("tbody");
        c.lines.forEach((cl,i)=>{
          const l=lines[i];
          const nameCell=h("td",{style:"min-width:250px"});
          if(l.ranged){
            // A ranged line has no single material yet — the real one is chosen
            // against live store stock when the work order is issued.
            nameCell.appendChild(h("div",{},[
              h("div",{style:"font-weight:700;font-size:12.5px",text:(l.rmType? l.rmType+" — ":"")+(l.rm||"—")}),
              h("span",{class:"chip",style:"font-size:10px",title:"Resolved against live store stock at work-order issue",text:"⟡ ranged — picked at issue"})
            ]));
          } else {
            nameCell.appendChild(h("div",{html:U.searchSelect("bl_rid_"+l._k,
              matOptions(l.id), l.id, "Search material…")}));
            if(l.rm) nameCell.appendChild(h("div",{class:"muted",style:"font-size:10.5px;margin-top:2px",
              text:(l.rmType? l.rmType+" — ":"")+l.rm+(l.rmGsm?" · "+l.rmGsm+" g/m²":"")+(l.rmThk?" · "+l.rmThk+" mm":"")}));
          }
          const qtyIn=h("input",{class:"input",type:"number",step:"0.001",value:l.qty,
            style:"width:100px;text-align:right",oninput:e=>{ l.qty=+e.target.value||0; refresh(); }});
          // Unit and GSM together decide whether a line is a fabric (a layer).
          // Redraw only when that flips — otherwise just recompute, so typing
          // never loses the caret.
          const reclass=(fn)=>(e)=>{ const before=BOMCALC.isFabric(l); fn(e);
            if(BOMCALC.isFabric(l)!==before) draw(); else refresh(); };
          // The GSM cell only exists on MTR lines, so a unit edit that crosses
          // the MTR boundary needs a redraw even before a GSM makes it a fabric.
          const unitIn=h("input",{class:"input",value:l.unit||"KG",style:"width:74px",
            oninput:e=>{ const wasMtr=(BOMCALC.normUnit(l.unit)==="MTR"), wasFab=BOMCALC.isFabric(l);
              l.unit=e.target.value.toUpperCase();
              if((BOMCALC.normUnit(l.unit)==="MTR")!==wasMtr || BOMCALC.isFabric(l)!==wasFab) draw(); else refresh(); }});
          // A fabric IS the substrate, and its GSM is what pickup GSM is measured
          // against — so it has to be typeable, not just whatever the import found.
          // Entering a GSM on an MTR line is what makes it count as a layer.
          // Only fabrics and tapes are metre-measured, so only MTR lines get the
          // input at all — a GSM is meaningless on a chemical.
          const isMtr=(BOMCALC.normUnit(l.unit)==="MTR");
          const gsmIn=h("input",{class:"input",type:"number",step:"0.1",min:"0",
            value:(l.rmGsm==null?"":l.rmGsm), placeholder:"g/m²",
            style:"width:96px;text-align:right",
            oninput:reclass(e=>{ const v=e.target.value.trim(); l.rmGsm = v===""?null:v; })});
          gsmIn.title="Give a fabric its GSM (with unit MTR) to count it as a layer in the pickup-GSM calculation";
          const pickIn=h("input",{class:"input",type:"number",step:"1",min:"0",max:"100",
            value:(l.pickupPct==null?"":l.pickupPct), placeholder:cl.fabric?"n/a":"set",
            style:"width:84px;text-align:right",
            oninput:e=>{ const v=e.target.value; l.pickupPct = v===""?null:Math.max(0,Math.min(100,+v||0)); refresh(); }});
          if(cl.fabric){ pickIn.disabled=true; pickIn.title="Fabric is the substrate — it is accounted for by pickup GSM, not as pickup mass"; }

          const cKg=h("td",{class:"mono",style:"text-align:right"});
          const cSq=h("td",{class:"mono",style:"text-align:right"});
          tb.appendChild(h("tr",{},[
            nameCell,
            h("td",{style:"text-align:right"},[qtyIn]),
            h("td",{style:"text-align:right"},[unitIn]),
            h("td",{style:"text-align:right"}, isMtr?[gsmIn]:[h("span",{class:"muted",title:"GSM applies only to fabrics and tapes (unit MTR)",text:"—"})]),
            h("td",{style:"text-align:right"},[pickIn]),
            cKg, cSq,
            h("td",{},[h("button",{class:"btn sm ghost",title:"Remove component",
              onclick:e=>{ e.preventDefault(); lines.splice(i,1); if(!lines.length) lines.push(blank()); draw(); },text:"✕"})])
          ]));
          l._cKg=cKg; l._cSq=cSq;
        });
        tbl.appendChild(tb);
        tblHost.appendChild(tbl);

        // The material picker writes to a hidden input, so pick it up here and
        // carry the chosen material's own spec onto the line — otherwise a new
        // fabric row would have no GSM and silently not count as a layer.
        lines.forEach(l=>{
          if(l.ranged) return;
          const hid=UI.$("#bl_rid_"+l._k); if(!hid) return;
          hid.addEventListener("change",()=>{
            const it=ENG.item(hid.value); if(!it) { l.id=hid.value; return; }
            l.id=it.id;
            l.rm = it.material || it.name || l.rm;
            l.rmType = it.grade != null ? it.grade : l.rmType;
            if(it.thicknessMM!=null) l.rmThk=String(it.thicknessMM);
            if(it.gsm!=null) l.rmGsm=String(it.gsm);
            if(it.uom) l.unit=BOMCALC.normUnit(it.uom);
            if(l.pickupPct==null) l.pickupPct=BOMCALC.defaultPickup(l.rm);
            draw();
          });
        });
        refresh();
      }

      /* Options for the component picker.
         The label leads with the NAME (which already carries the grade) plus
         whatever distinguishes it — thickness and GSM. It used to lead with the
         item id and was trimmed, so "RM-COTTON-FABRIC-DEVESH / …DOLLAR
         / …DOLLER" all rendered as an identical "COTTON FABR…" and looked like the
         same material three times over. Never truncate a material label — shown
         in full. The id stays searchable (searchSelect matches on value as well
         as label).
         WIP items are excluded: the stage engine inserts those itself, and 204
         auto-generated ones drown the list. Any WIP already on a line is kept. */
      function matLabel(i){
        // type/code first, then the material; thickness + GSM only belong
        // to fabrics and tapes (metre-measured), never to chemicals
        const bits=[U.matDisplay(i)];
        if(i.fabric || BOMCALC.normUnit(i.uom)==="MTR"){
          if(i.thicknessMM!=null) bits.push(i.thicknessMM+" mm");
          if(i.gsm!=null) bits.push(i.gsm+" g/m²");
        }
        return bits.join(" · ");
      }
      function matOptions(currentId){
        return ENG.data.items
          .filter(i=> i.cat!=="FG" && (i.cat!=="WIP" || i.id===currentId))
          .sort((a,b)=>String(a.name||"").localeCompare(String(b.name||"")))
          .map(i=>({v:i.id, l:matLabel(i)}));
      }

      /* Recompute derived cells + totals in place (no re-render, so typing
         never loses focus). */
      function refresh(){
        const fg=ENG.item(curFg)||{};
        const c=BOMCALC.compute({lines}, BOMCALC.metaFromItem(fg));
        c.lines.forEach((cl,i)=>{
          const l=lines[i]; if(!l||!l._cKg) return;
          l._cKg.textContent = cl.consumptionPerKg==null?"—":ENG.num(cl.consumptionPerKg,3);
          l._cSq.textContent = cl.consumptionPerSqm==null?"—":ENG.num(cl.consumptionPerSqm,4);
        });

        totHost.innerHTML="";
        const row=(label,val,strong)=>h("div",{class:"flex between",
          style:"padding:5px 0;border-bottom:1px solid var(--line);font-size:12.5px"+(strong?";font-weight:800":"")},[
          h("span",{class:strong?"":"muted",text:label}), h("span",{class:"mono",text:val})]);

        const box=h("div",{class:"card",style:"background:var(--panel-2);box-shadow:none;padding:12px"});
        box.appendChild(h("div",{class:"muted",style:"font-size:10.5px;font-weight:700;text-transform:uppercase;margin-bottom:6px",text:"Batch totals"}));
        box.appendChild(row("Total qty used (batch, mass basis)", n(c.totalQtyKg,2)+" kg"));
        box.appendChild(row("Total pickup qty", c.totalPickupQty==null?"— set pickup %":n(c.totalPickupQty,2)+" kg"));
        box.appendChild(row("Total pickup — per kg of FG", c.totalPickupPerKg==null?"—":n(c.totalPickupPerKg,4)));
        box.appendChild(row("Total pickup — per sqm", c.totalPickupPerSqm==null?"—":n(c.totalPickupPerSqm,4)+" kg/sqm"));
        box.appendChild(row(`Fabric GSM${c.fabricCount?" ("+c.fabricCount+" layer"+(c.fabricCount>1?"s":"")+")":""}`,
          c.fabricGsm==null?"—":n(c.fabricGsm,1)+" g/m²"));
        box.appendChild(row("Pickup GSM  (FG − fabric)", c.pickupGsm==null?"—":n(c.pickupGsm,1)+" g/m²"));
        box.appendChild(row("TOTAL PRODUCTION", c.totalProductionSqm==null?"—":n(c.totalProductionSqm,0)+" sqm", true));
        totHost.appendChild(box);

        // Explain a missing total instead of just showing a dash.
        if(c.totalProductionSqm==null){
          const why = c.fgGsm==null ? "the finished good has no GSM on record"
            : !c.fabricCount ? "no fabric line carries a GSM, so pickup GSM cannot be derived"
            : (c.pickupGsm!=null && c.pickupGsm<=0) ? `fabric GSM (${n(c.fabricGsm,1)}) is not below FG GSM (${n(c.fgGsm,1)}) — this reads as a conversion/slitting product, not a coated one`
            : "no pickup % has been set on any component";
          totHost.appendChild(h("div",{class:"muted",style:"font-size:11.5px;margin-top:6px",
            text:"Total production unavailable: "+why+"."}));
        }
      }
      draw();

      function save(){
        const fg2=UI.$("#bm_fg").value || curFg;
        const yld=Math.min(100,Math.max(1,+UI.$("#bm_yield").value||100))/100;
        // pull the material picker back for non-ranged rows, keep every other
        // field (rm/type/thickness/GSM/options) exactly as loaded
        const out=lines.map(l=>{
          const sel=l.ranged?null:UI.$("#bl_rid_"+l._k);
          const o={ id: l.ranged? (l.id||null) : ((sel&&sel.value)||l.id||null),
            rm:l.rm, rmType:l.rmType, rmThk:l.rmThk, rmGsm:l.rmGsm,
            qty:+l.qty||0, unit:l.unit||"KG",
            pickupPct: l.pickupPct==null?null:+l.pickupPct,
            ranged:!!l.ranged, options:l.options||[], layer:l.layer||null };
          return o;
        }).filter(l=>(l.id||l.options.length) && l.qty>0);
        if(!out.length){ toast("Add at least one component with a quantity",{type:"warn"}); return; }

        const prev=ENG.data.boms[fg2];
        const next={ yield:yld, lines:out };
        // keep the other approved recipes; replace only the one being edited
        if(prev && prev.alternates && prev.alternates.length){
          next.alternates=prev.alternates.map((a,i)=> i===altIdx? {label:a.label, lines:out} : a);
        }
        ENG.data.boms[fg2]=next;
        mo.close(); toast(editing?("BOM updated for "+fg2):("BOM created for "+fg2),{type:"ok"});
        App.saveDelta(()=>DB.boms.save(fg2,next));
      }
      async function delBom(){
        if(!await confirm(`Delete the BOM for ${curFg}? The product stays — only its recipe is removed.`,{title:"Delete BOM",danger:true})) return;
        delete ENG.data.boms[curFg];
        mo.close(); toast("BOM deleted",{type:"ok"});
        App.saveDelta(()=>DB.boms.remove(curFg));
      }
    }
  }};


  // register ⌘K quick actions for Production & BOM
  window.ERPActions = Object.assign(window.ERPActions||{}, {
    newWO:  { ic:"⚙️", label:"New Work Order", run:()=>App.go("production",{openNew:true}) },
    newBOM: { ic:"🧬", label:"Create BOM",     run:()=>App.go("bom",{openNew:true}) },
  });
})();
