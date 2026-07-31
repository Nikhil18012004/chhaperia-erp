/* ============================================================
   CHHAPERIA ERP — PRODUCTION & PRODUCTS / BOM
   Completing a stage posts ISSUE lines for the materials that stage
   consumes. Nothing is received back — a finished job is held ready
   for a sales order instead, and finished stock is only ever created
   by the explicit "Add to Finished Stock" action.
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
  /* WHO MAKES WHAT + WHERE A JOB STARTS — mirrors the server
     (backend/src/services/stageService.js). The store decides: if the material
     this product is made from is already there in the quantity needed, the job
     starts at SLITTING; if it is not, it starts at the RM PRODUCTION stage of
     whoever makes that family (and at fibre-glass weaving before it for the
     copper-woven tape). Anything we buy ready-made has no production stage. */
  const OWNERS={
    gautam:{ user:"coating1", area:"coating", line:"RM Production 1",
             label:"RM Production — Gautam Saw", person:"Gautam Saw" },
    ganesh:{ user:"coating2", area:"coating", line:"RM Production 2",
             label:"RM Production 2 — Ganesh", person:"Ganesh" },
    fibre:{  user:"fiberglass", area:"fiberglass", line:"Fibre-Glass Line 1",
             label:"Copper-Wire Weaving", person:"Fibre-glass team" },
  };
  const GANESH_FAMILIES=["CHN-","CHSCWWBT","CHCWSCWBT","CP25GE","CCM25GE","CH-LSZH","CH-FSZH",
    "CH-FGT","CH-ALPET","CH-ALPFT","CH-CUPET","CH-PFGT","CH-NW-B","CH-PT","CH-CT","CH-RCT",
    "CH-RPST","CH-BCT"];
  const FIBRE_FIRST=["CHCWSCWBT"];
  function famMatches(fam,p){
    p=String(p).toUpperCase();
    if(fam===p) return true;
    if(fam.indexOf(p)!==0) return false;
    if(/[^A-Z0-9]$/.test(p)) return true;
    const nx=fam.charAt(p.length);
    return nx==="" || /[^A-Z0-9]/.test(nx);
  }
  function famOf(itemId){ const it=ENG.item(itemId)||{}; return String(it.typeCode||itemId||"").toUpperCase().trim(); }
  function productOwner(itemId){
    const fam=famOf(itemId), it=ENG.item(itemId)||{};
    if(GANESH_FAMILIES.some(p=>famMatches(fam,p))) return OWNERS.ganesh;
    if(String(it.group||"").toUpperCase().indexOf("WATER BLOCKING")===0) return OWNERS.gautam;
    return null;
  }
  /* is every material of the recipe already in the store for this quantity? */
  function materialInStore(itemId, qty){
    const bom=(ENG.data.boms||{})[itemId];
    if(!bom) return true;
    let lines=[];
    try{ lines=BOMCALC.toLegacy(bom,BOMCALC.metaFromItem(ENG.item(itemId)||{})); }
    catch(e){ return true; }
    const Y=bom.yield||1;
    return lines.every(([rid,per])=>{
      const need=per*(+qty||0)/Y;
      const have=(ENG.stock(rid)||{}).onHand||0;
      return have+1e-6>=need;
    });
  }
  function routeFor(itemId, qty){
    const owner=productOwner(itemId);
    if(materialInStore(itemId,qty) || !owner)
      return { stages:["Slitting","Packing & Dispatch"], area:"slitting", ready:true, owner:null };
    const stages=[];
    const fibreFirst=FIBRE_FIRST.some(p=>famMatches(famOf(itemId),p));
    if(fibreFirst) stages.push(OWNERS.fibre.label);
    stages.push(owner.label);
    stages.push("Slitting","Packing & Dispatch");
    const first=fibreFirst?OWNERS.fibre:owner;
    return { stages, area:first.area, line:first.line, owner:first, ready:false };
  }
  const LINES_BY_AREA={ coating:["RM Production 1","RM Production 2"],
    slitting:["Slitting A","Slitting B"],
    fiberglass:["Fibre-Glass Line 1"] };
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
  /* raw materials show their NAME and their CODE as separate things:
     name = the material itself (MICA TAPE), code = its grade/type (CP25G) */
  function matLineName(l){ const it=l.id?ENG.item(l.id):null;
    if(it) return it.material||it.name||l.rm||"—";
    return l.rm||"—"; }
  function matLineCode(l){ const it=l.id?ENG.item(l.id):null;
    if(it) return it.grade||"";
    return l.rmType||""; }
  function matLineSpec(l){ const bits=[];
    if(l.rmThk) bits.push(l.rmThk+" mm"); if(l.rmGsm) bits.push(l.rmGsm+" g/m²");
    return bits.join(" · "); }

  /* what a material DOES in the process — mirrors the backend's
     stageService.materialRole, so "what coating consumes" means the same
     thing on screen as it does when the stock is actually issued */
  function materialRole(id){
    const s=String(id||"").toUpperCase();
    if(s.startsWith("PKG-")||s.includes("CORE")) return "pack";
    if(/MICA|SAP|CARBON|SILICONE|ACRYLIC|ADH|INORGANIC|SOLVENT|RESIN|BINDER|PASTE/.test(s)) return "paste";
    return "base";
  }

  /* ---- THE materials list, used everywhere a recipe is previewed ----------
     New Work Order and both Add-to-Finished-Stock forms render the same
     thing: a layer heading where the product has layers, then one row per
     material carrying its live need / in-store / short figures.
     `groups` is [{ label, lines:[{ name, code, spec, need, have, uom, agg }] }]
     — `agg` is the need across ALL layers when a material appears in more
     than one, since the store is shared between them. */
  function materialsList(host, groups, opts){
    opts=opts||{};
    groups=(groups||[]).filter(g=>g&&(g.lines||[]).length);
    if(!groups.length) return;
    const multi=groups.length>1;
    host.appendChild(h("div",{class:"muted",style:"font-size:11px;font-weight:700;text-transform:uppercase;margin:14px 0 8px",
      text: opts.title || (multi? "≡ Materials by layer · "+groups.length+" layers" : "Materials to be consumed")}));
    groups.forEach((grp,gi)=>{
      if(multi) host.appendChild(h("div",{style:"font-weight:800;font-size:12px;text-transform:uppercase;letter-spacing:.4px;margin:"+(gi?12:2)+"px 0 4px;color:var(--accent)",
        text:grp.label||("LAYER "+(gi+1))}));
      (grp.lines||[]).forEach(l=>{
        const have=+l.have||0, agg=(l.agg!=null?l.agg:l.need)||0;
        const ok=have>=agg-1e-9;
        host.appendChild(h("div",{class:"flex between aic",
          style:"gap:10px;font-size:12.5px;padding:6px 0;border-bottom:1px solid var(--line)"+(multi?";padding-left:14px;border-left:2px solid var(--line);margin-left:2px":"")},[
          h("div",{style:"min-width:0"},[
            h("div",{class:"flex aic",style:"gap:8px"},[
              h("span",{style:"font-weight:600",text:l.name}),
              l.code?h("span",{class:"muted mono",style:"font-size:11px",text:l.code}):null
            ]),
            l.spec?h("div",{class:"muted mono",style:"font-size:11px",text:l.spec}):null
          ]),
          h("div",{class:"flex aic",style:"gap:10px;flex:0 0 auto;white-space:nowrap"},[
            h("span",{class:"muted",text:"Need "},[h("b",{class:"mono",style:"color:var(--text)",text:ENG.num(l.need,2)+" "+(l.uom||"")})]),
            h("span",{class:"muted",text:"In store "},[h("b",{class:"mono",style:"color:"+(ok?"var(--text)":"var(--danger)"),text:ENG.num(have,1)+" "+(l.uom||"")})]),
            h("span",{html:badge(ok?"ok":"danger",ok?"OK":"Short by "+ENG.num(agg-have,2))})
          ])
        ]));
      });
    });
  }

  function layerPanel(fg, rawLines){
    if(!fg || !rawLines) return null;
    const lines=BOMCALC.normalize(rawLines);
    if(!lines.length) return null;
    const groups=layerGroups(lines);
    if(groups.length<2) return null;   // no layer story to tell
    const box=h("div",{class:"card",style:"box-shadow:none;background:var(--panel-2);padding:10px 14px;margin-bottom:12px"});
    box.appendChild(h("div",{class:"muted",style:"font-size:10.5px;font-weight:700;text-transform:uppercase;margin-bottom:4px",
      text:"≡ Layer build-up · "+groups.length+" layers"}));
    groups.forEach((g,gi)=>{
      box.appendChild(h("div",{style:"font-weight:800;font-size:12px;text-transform:uppercase;letter-spacing:.4px;margin:"+(gi?12:6)+"px 0 4px;color:var(--accent)",
        text:g.label||("LAYER "+(gi+1))}));
      g.lines.forEach(l=>{
        box.appendChild(h("div",{class:"flex aic",style:"gap:8px;padding:3px 0 3px 14px;font-size:12.5px;border-left:2px solid var(--line);margin-left:2px"},[
          h("span",{style:"font-weight:600",text:matLineName(l)}),
          matLineCode(l)?h("span",{class:"muted mono",style:"font-size:11px",text:matLineCode(l)}):null,
          matLineSpec(l)?h("span",{class:"muted mono",style:"font-size:11.5px",text:matLineSpec(l)}):null,
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
        /* the item CODE rides along with the thickness, so the picker always
           names the exact stock item being chosen and not just its size */
        list.map(f=>h("option",{value:f.id,selected:cur&&f.id===cur.id?"selected":null,
          text:(f.thicknessMM!=null? f.thicknessMM+" mm":(f.typeCode||f.id))+" · "+f.id})));
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
      {key:"stage",label:"Stage",cls:"ctr",noSort:true,render:r=>`<span class="cell-main">${esc(r.stage)}</span>${r.cur?' <span class="chip" style="color:var(--info);border-color:var(--info)">current</span>':''}`},
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
    root.appendChild(pageHead("Production Control","Each stage consumes its materials and hands the job to the next stage; nothing is booked into store on the way",[
      // the floor has this in its own panel — office/admin get it here too
      h("button",{class:"btn",onclick:()=>finishedStockForm(),html:"➕ Add to Finished Stock"}),
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
        {key:"date",label:"Start",render:r=>`<span style="white-space:nowrap">${r.date||"—"}</span>`,sort:r=>r.date||""},
        {key:"stage",label:"Stage",cls:"ctr",render:r=>stageCell(r),sort:r=>(r.stageIdx||0)},
        {key:"line",label:"Line",render:r=>`<span class="chip">${esc(r.line)}</span>`,sort:r=>r.line},
        {key:"due",label:"Due",render:r=>`<span style="white-space:nowrap">${r.due||"—"}</span>`,sort:r=>r.due},
        // progress + status share one column, stacked one over the other, so
        // the action buttons pull further left and the board fits a single view
        {key:"progress",label:"Progress",render:r=>`<div style="min-width:86px;display:flex;flex-direction:column;gap:6px;align-items:flex-start"><div style="width:100%">${meter(r.progress, r.progress>66?"ok":r.progress>33?"warn":"danger")}<div class="muted" style="font-size:11px;margin-top:3px">${r.progress}%</div></div>${badge((r.status==="Completed"||r.status==="Dispatched")?"ok":r.status==="In Production"||r.status==="In Progress"?"info":"warn",r.status)}</div>`,sort:r=>r.progress},
        {key:"act",label:"",noSort:true,render:r=>woActions(r)},
      ],{onRow:r=>woDetail(r),empty:"No work orders"}));
    }
    draw();
    if(params&&params.openNew){ params.openNew=false; woForm(); }

    function canPlan(){ return ["admin","office"].includes((App.user&&App.user.role)||""); }
    function woActions(r){
      // stack the actions vertically so the column stays narrow (two buttons
      // side by side were the widest cell and forced the board to scroll)
      const wrap=h("div",{style:"display:flex;flex-direction:column;gap:5px;align-items:stretch;min-width:104px"});
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

    /* ---- edit a planned work order (delete lives here too) ----
       Reachable from the WO detail modal. The WO number is renamable any
       time before dispatch; product (name → code → thickness) and quantity
       and line only while nothing has started. */
    function woEditForm(wo){
      const it=ENG.item(wo.itemId)||{};
      const started=(wo.route||[]).some(s=>s.posted||s.status!=="Pending");
      const fgs=ENG.data.items.filter(i=>i.cat==="FG");
      const LINES=["Coating Line 1","Coating Line 2","Fibre-Glass Line 1","Slitting A","Slitting B"];
      const lockedLabel=(U.familyCode(it.typeCode,it.thicknessMM)||it.typeCode||wo.itemId)
        +" — "+(it.productName||it.name||wo.itemId)
        +(it.thicknessMM!=null?" · "+it.thicknessMM+" mm":"");
      const body=h("div",{},[
        started?h("p",{class:"dim",style:"margin-bottom:10px",text:"Production has started — product, quantity and line are locked; the W.O. number, due date and priority can still change."}):null,
        h("div",{class:"form-grid"},[
          U.field("W.O. Number",`<input class="input" id="we_id" value="${esc(wo.id)}">`),
          U.field("Quantity (kg)",`<input class="input" id="we_qty" type="number" min="0" step="0.1" value="${wo.qty}" ${started?"disabled":""}>`),
          started
            ? U.field("Product",`<input type="hidden" id="we_item" value="${esc(wo.itemId)}"><input class="input is-locked" readonly value="${esc(lockedLabel)}">`,"full")
            : fgPicker("we_item", fgs, wo.itemId),
          // width is a slitting parameter, not a material one — it can still be
          // corrected after the run has started, right up to dispatch
          U.field("Tape Width (mm)",`<input class="input" id="we_width" type="number" min="0" step="0.5" placeholder="e.g. 25" value="${wo.widthMM!=null?wo.widthMM:""}">`),
          U.field("Production Line",U.selectHTML("we_line",LINES.map(l=>({v:l,l})),wo.line)),
          U.field("Due Date",`<input class="input" id="we_due" type="date" value="${wo.due||""}">`),
          U.field("Priority",U.selectHTML("we_prio",[{v:"Normal",l:"Normal"},{v:"High",l:"High"},{v:"Urgent",l:"Urgent"}],wo.priority||"Normal")),
        ])
      ]);
      if(started){ setTimeout(()=>{ const l=UI.$("#we_line"); if(l) l.disabled=true; },0); }
      const saveBtn=h("button",{class:"btn primary",onclick:save,text:"Save Changes"});
      const mo=modal({title:"Edit "+wo.id, sub:it.name||wo.itemId, wide:true, body,
        foot:[h("button",{class:"btn ghost",onclick:()=>mo.close(),text:"Cancel"}),
          h("button",{class:"btn danger",onclick:del,html:"🗑 Delete WO"}),
          saveBtn]});
      async function save(){
        const patch={ id:UI.$("#we_id").value.trim(), due:UI.$("#we_due").value, priority:UI.$("#we_prio").value,
          widthMM:UI.$("#we_width").value===""?null:+UI.$("#we_width").value };
        if(!patch.id){ toast("Enter a work order number",{type:"warn"}); return; }
        if(!started){
          patch.qty=+UI.$("#we_qty").value;
          patch.line=UI.$("#we_line").value;
          const itEl=UI.$("#we_item"); if(itEl && itEl.value) patch.itemId=itEl.value;
        }
        saveBtn.disabled=true; saveBtn.textContent="Saving…";
        try{ await DB.production.update(wo.id, patch);
          mo.close(); toast((patch.id||wo.id)+" updated",{type:"ok"});
          await reloadState(); draw();
        }catch(e){ toast("Update failed: "+e.message,{type:"danger"});
          saveBtn.disabled=false; saveBtn.textContent="Save Changes"; }
      }
      async function del(){
        const warn=started
          ? wo.id+" has posted production movements — deleting it also rolls those stock postings back.\n\nDelete this work order?"
          : "Delete "+wo.id+"? This cannot be undone.";
        if(!await confirm(warn,{title:"Delete Work Order",danger:true})) return;
        try{ await DB.production.remove(wo.id);
          mo.close(); toast(wo.id+" deleted",{type:"ok",title:"Removed"});
          await reloadState(); draw();
        }catch(e){ toast("Delete failed: "+e.message,{type:"danger"}); }
      }
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
        return {rid, name:r.id?(r.material||r.name):rid, code:r.id?(r.grade||"—"):"—", per, need, have:st.onHand, ok:st.onHand>=need, uom:r.uom||""}; }):[];
      // ---- Details pane ----
      const detailsPane=h("div",{},[
        MW.dl([["Product",it.name],["Code",U.familyCode(it.typeCode,it.thicknessMM)||it.typeCode||wo.itemId],
          ...(it.thicknessMM!=null?[["Thickness",it.thicknessMM+" mm"]]:[]),
          ...(wo.widthMM?[["Width",wo.widthMM+" mm"]]:[]),
          ...(it.thicknessMM!=null&&wo.widthMM?[["Size",it.thicknessMM+" × "+wo.widthMM+" mm"]]:[]),
          ["Quantity",ENG.num(wo.qty)+" kg"],["Line",wo.line],["Status",badge((wo.status==="Completed"||wo.status==="Dispatched")?"ok":"info",wo.status)],
          ["Start",wo.date],["Due",wo.due],["Yield",bom?(bom.yield*100).toFixed(0)+"%":"—"],["Progress",wo.progress+"%"]]),
        stageTimeline(wo),
        (()=>{ const lp=bom?layerPanel(it,bom.lines):null; return lp?h("div",{style:"margin-top:14px"},lp):h("span"); })(),
        h("h3",{style:"margin:18px 0 10px;font-size:14px",text:"Material Requirements (auto from BOM)"}),
        table(rows,[
          {key:"name",label:"Component",render:r=>`<div class="cell-main">${esc(r.name)}</div>`,noSort:true},
          {key:"code",label:"Code",render:r=>`<span class="mono muted">${esc(r.code)}</span>`,noSort:true},
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
        foot:[
          (!wo.dispatched && canPlan())?h("button",{class:"btn ghost",onclick:()=>{UI.$("#modalHost").hidden=true;woEditForm(wo);},html:"✎ Edit"}):null,
          (finished||!App.isAdmin())?null:h("button",{class:"btn primary",onclick:()=>{UI.$("#modalHost").hidden=true;completeWO(wo);},text:"Complete all stages"}) ]});
    }

    /* ---- Add to Finished Stock (office / admin) ----------------------------
       The floor books finished goods from its own panel; this is the same
       action for the office. It deducts the raw materials per the product's
       BOM and receives the produced quantity into the store you choose — the
       one and only way finished stock is created, since a production stage
       never books anything in. */
    function finishedStockForm(){
      /* Output can be booked as a FINISHED GOOD or as WORK IN PROCESS — a
         coated jumbo that has not been slit yet is real stock, and a work
         order can now start from it, so it has to be bookable. */
      const fgs=ENG.data.items.filter(i=>i.cat==="FG");
      const wips=ENG.data.items.filter(i=>i.cat==="WIP");
      const whs=ENG.data.warehouses||[];
      if(!fgs.length||!whs.length){ toast("No finished products or stores set up yet",{type:"warn"}); return; }
      const fgStore=(whs.find(w=>w.id==="WH-FG")||whs.find(w=>w.id!=="WH-WIP")||whs[0]).id;
      const isMtr=u=>["M","MTR","METER"].includes(String(u||"").toUpperCase());

      const pickHost=h("div",{style:"display:contents"});
      /* U.field takes an HTML string, so the unit select gets a host div it can
         be re-rendered into — finished goods are counted in kg or sqm only,
         while a jumbo roll is also meaningfully measured in metres */
      const uomField=U.field("Unit of Quantity",`<div id="fs_uomhost"></div>`);
      const gsmField=U.field("GSM (g/m²)",`<input class="input" id="fs_gsm" type="number" step="0.1" placeholder="e.g. 110">`);
      const tapeField=U.field("Tape Width (mm)",`<input class="input" id="fs_tapewid" type="number" step="0.5" placeholder="e.g. 25">`);
      const convHint=h("div",{class:"muted",style:"grid-column:1/-1;font-size:11px;margin-top:-6px",id:"fs_conv"});
      const matHost=h("div",{style:"grid-column:1/-1"});
      const srcHost=h("div",{style:"grid-column:1/-1"});
      /* Sourcing part of a run from stock already on the shelf is an ADMIN
         control — the floor books what it made, it does not decide what the
         run is built from. */
      const canSource=((App.user||{}).role==="admin");
      let fsFgWanted=0, fsWipWanted=0;
      let fsChoices={};   // ranged BOM line index -> the stock item chosen
      let fsShort=[];     // materials short of stock — blocks the booking
      const body=h("div",{class:"form-grid"},[
        U.field("Category",U.selectHTML("fs_cat",[{v:"FG",l:"Finished Goods"},{v:"WIP",l:"Work in Process"}],"FG")),
        pickHost,
        gsmField,
        U.field("Quantity produced",`<input class="input" id="fs_qty" type="number" min="0" step="any" placeholder="0">`),
        uomField,
        tapeField,
        U.field("Store it in",U.selectHTML("fs_wh",whs.map(w=>({v:w.id,l:w.name+(w.type?" · "+w.type:"")})),fgStore)),
        convHint,
        srcHost,
        matHost,
      ]);
      const saveBtn=h("button",{class:"btn primary",onclick:e=>save(e.currentTarget),text:"Add to Finished Stock"});
      const mo=UI.modal({title:"➕ Add to Finished Stock", sub:"Book finished goods or work in process into a store", body,
        foot:[h("button",{class:"btn ghost",onclick:()=>mo.close(),text:"Cancel"}), saveBtn]});

      /* ---- product → thickness, the same two-step as New Work Order --------
         The PRODUCT is chosen first (its name led by the code), then the
         THICKNESS of that product, because one product exists at several
         thicknesses and each is its own stock item. Work in process behaves
         identically: its size lives on the finished product it came from, so
         a jumbo is picked by product and thickness just the same. */
      const parentOf=i=>(i.stageOf && ENG.item(i.stageOf)) || {};
      /* what a roll IS — the half-made stock a work order can start from is the
         COATED JUMBO; rolls already slit say so rather than being mislabelled */
      const wipStage=i=>(/-S$/.test(i.id) || /slit/i.test(i.name||"")) ? "Slit Rolls" : "Coated Jumbo Roll";
      const prodOf=i=>{
        if(i.cat!=="WIP") return i.productName||i.name||i.id;
        const p=parentOf(i);
        return p.productName||p.name
          ||String(i.name||i.id).replace(/\s*—\s*(Coated Jumbo|Slit Rolls)\s*\(WIP\)\s*$/i,"");
      };
      const thkOf=i=>{ if(i.thicknessMM!=null) return i.thicknessMM;
        const p=parentOf(i); return p.thicknessMM!=null?p.thicknessMM:null; };
      /* the family code, thickness stripped out — "FG-CP25G" / "WIP-CP25G" */
      const famOf=i=>{
        const src=i.cat==="WIP"?parentOf(i):i;
        const fam=U.familyCode(src.typeCode, src.thicknessMM)||U.baseCode(src.typeCode||"")||"";
        return (i.cat==="WIP"?"WIP-":"FG-")+fam;
      };
      /* one picker entry per product: code first, then the name, and for a
         half-made roll what it actually is */
      const keyOf=i=>famOf(i)+"|"+prodOf(i)+"|"+(i.cat==="WIP"?wipStage(i):"");
      const nameLabel=k=>{ const p=k.split("|"); return p[0]+" — "+p[1]+(p[2]?" — "+p[2]:""); };

      let catNow="FG";
      function buildPicker(){
        catNow=UI.$("#fs_cat").value;
        pickHost.innerHTML="";
        const isFg=catNow==="FG";
        const list=isFg?fgs:wips;
        // group the items by product, each group ordered by thickness
        const byName={};
        list.forEach(i=>{ (byName[keyOf(i)]=byName[keyOf(i)]||[]).push(i); });
        Object.values(byName).forEach(a=>a.sort((x,y)=>(thkOf(x)||0)-(thkOf(y)||0)));
        const names=Object.keys(byName).sort();
        const hid=h("input",{type:"hidden",id:"fs_item",value:""});
        const thkHost=h("div");
        pickHost.appendChild(hid);
        pickHost.appendChild(h("div",{class:"field full"},[
          h("label",{text:isFg?"Product":"Work in process item"}),
          h("div",{html:names.length
            ? U.searchSelect("fs_nm", names.map(n=>({v:n,l:nameLabel(n)})), names[0],
                isFg?"Search product…":"Search work in process…")
            : `<input class="input" value="" placeholder="no items in this category yet" disabled>`}),
        ]));
        pickHost.appendChild(h("div",{class:"field"},[h("label",{text:"Thickness (mm)"}), thkHost]));
        let curName=names[0];
        function buildThk(){
          const group=byName[curName]||[];
          const sel=h("select",{class:"select",onchange:e=>{ hid.value=e.target.value;
            hid.dispatchEvent(new Event("change",{bubbles:true})); }},
            group.map(i=>h("option",{value:i.id,
              text:(thkOf(i)!=null? thkOf(i)+" mm" : (i.typeCode||i.id))+" · "+i.id})));
          thkHost.innerHTML=""; thkHost.appendChild(sel);
          hid.value=group.length?group[0].id:"";
          fillParams();
        }
        const nmHid=pickHost.querySelector('input[id="fs_nm"]');
        if(nmHid) nmHid.addEventListener("change",()=>{
          if(nmHid.value && nmHid.value!==curName){ curName=nmHid.value; buildThk(); } });
        if(names.length) buildThk();
        // finished goods are never counted in running metres — a slit roll is
        // sold by weight or area, so metres is offered on WIP jumbos only
        const host=UI.$("#fs_uomhost");
        if(host){
          const units=[{v:"KG",l:"Kilogram (kg)"},{v:"SQM",l:"Square Meter (sqm)"}];
          if(!isFg) units.push({v:"MTR",l:"Meter (m)"});
          host.innerHTML=U.selectHTML("fs_uom",units,"KG");
          const u=UI.$("#fs_uom"); if(u) u.addEventListener("change",calc);
        }
        const sel=UI.$("#fs_item");
        if(sel) sel.addEventListener("change",fillParams);
        tapeField.style.display=isFg?"":"none";
        fillParams();
      }
      function fillParams(){
        const el=UI.$("#fs_item"); const it=(el&&ENG.item(el.value))||{};
        /* a half-made roll carries no size of its own — its thickness and GSM
           are the finished product's, so they are read off the parent */
        const parent=(it.stageOf && ENG.item(it.stageOf)) || {};
        const pick=(k)=>(it[k]!=null?it[k]:(parent[k]!=null?parent[k]:""));
        const set=(id,v)=>{const e=UI.$("#"+id); if(e) e.value=(v==null?"":v);};
        set("fs_gsm",pick("gsm"));
        if(catNow==="FG") set("fs_tapewid",it.tapeWidthMM!=null?it.tapeWidthMM:"");
        calc();
      }
      /* kg ⇄ sqm ⇄ metres across the GSM and the width being produced */
      function width(){
        if(catNow==="FG"){ const t=+((UI.$("#fs_tapewid")||{}).value)||0; if(t>0) return t; }
        const el=UI.$("#fs_item"); const it=(el&&ENG.item(el.value))||{};
        return +it.width||1000;
      }
      function derive(){
        const q=+((UI.$("#fs_qty")||{}).value)||0, unit=(UI.$("#fs_uom")||{}).value;
        const gsm=+((UI.$("#fs_gsm")||{}).value)||0, w=width()/1000;
        if(!q) return null;
        let kg=null,sqm=null,len=null;
        if(unit==="KG"){ kg=q; if(gsm){ sqm=kg*1000/gsm; len=sqm/w; } }
        else if(unit==="SQM"){ sqm=q; len=sqm/w; if(gsm) kg=sqm*gsm/1000; }
        else { len=q; sqm=len*w; if(gsm) kg=sqm*gsm/1000; }
        return {kg,sqm,len,wid:width()};
      }
      function calc(){
        const el=UI.$("#fs_conv");
        const c=derive();
        if(el){
          if(!c) el.textContent="";
          else {
            const bits=[];
            if(c.sqm!=null) bits.push(ENG.num(c.sqm,1)+" sqm");
            if(c.len!=null) bits.push(ENG.num(c.len,1)+" m @ "+c.wid+" mm");
            if(c.kg!=null) bits.push(ENG.num(c.kg,2)+" kg");
            el.textContent=bits.length?"= "+bits.join(" · "):"Enter the GSM to convert between kg, sqm and metres";
          }
        }
        drawMaterials();
      }
      /* the SAME list New Work Order shows — layer headings, and every row
         carrying its live need / in-store / short figures. A half-made roll
         draws only what its coating stage consumes, exactly as the server
         issues it, so the packaging lines are left out. */
      /* what is on the shelf that this run could be built from — the item
         being booked is never a source for itself */
      function sourceRows(ownerId, itemId){
        const owner=ENG.item(ownerId)||{};
        const key=i=>String((i.productName||i.name)||"").trim().toUpperCase();
        const same=(a,b)=>{const x=a==null?null:+a,y=b==null?null:+b;
          if(x==null||y==null) return x==null&&y==null; return Math.abs(x-y)<1e-6;};
        const on=id=>((ENG.stock(id)||{}).onHand)||0;
        const wantW=+((UI.$("#fs_tapewid")||{}).value)||null;
        const isSlit=i=>/-S$/.test(String(i.id||""))||/slit/i.test(String(i.name||""));
        const fg=ENG.data.items.filter(i=>i.cat==="FG"&&i.id!==itemId)
          .filter(i=>key(i)===key(owner)&&same(i.thicknessMM,owner.thicknessMM))
          .filter(i=>wantW==null?true:same(i.tapeWidthMM,wantW))
          .map(i=>({id:i.id,name:i.name||i.id,have:on(i.id)})).filter(r=>r.have>0);
        const wip=ENG.data.items.filter(i=>i.cat==="WIP"&&i.id!==itemId&&!isSlit(i))
          .filter(i=>i.stageOf? i.stageOf===ownerId : (key(i)===key(owner)&&same(i.thicknessMM,owner.thicknessMM)))
          .map(i=>({id:i.id,name:i.name||i.id,have:on(i.id)})).filter(r=>r.have>0);
        return {fg, wip, fgAvail:fg.reduce((n,r)=>n+r.have,0), wipAvail:wip.reduce((n,r)=>n+r.have,0)};
      }
      function drawSources(ownerId, itemId, qty, uom){
        srcHost.innerHTML="";
        if(!canSource||!ownerId||!(qty>0)) return {fgQty:0,wipQty:0,makeQty:qty||0};
        const s=sourceRows(ownerId,itemId);
        const fgQty=Math.max(0,Math.min(fsFgWanted,s.fgAvail,qty));
        const wipQty=Math.max(0,Math.min(fsWipWanted,s.wipAvail,qty-fgQty));
        const makeQty=qty-fgQty-wipQty;
        if(!(s.fgAvail>0||s.wipAvail>0)) return {fgQty:0,wipQty:0,makeQty:qty};
        const row=(icon,label,val,max,onInput)=>h("div",{class:"flex between aic",
            style:"gap:12px;font-size:12.5px;padding:7px 0;border-bottom:1px solid var(--line)"},[
          h("div",{style:"min-width:0"},[h("div",{text:icon+" "+label}),
            h("div",{class:"muted",style:"font-size:11px",text:ENG.num(max,2)+" "+(uom||"")+" available"})]),
          h("input",{class:"input",type:"number",min:"0",step:"any",value:ENG.num(val,2),
            style:"width:110px;text-align:right;flex:0 0 auto",oninput:e=>onInput(e.target.value)}),
        ]);
        srcHost.appendChild(h("div",{style:"margin:12px 0;padding:10px 12px;border:1.5px solid var(--ok);border-radius:10px"},[
          h("div",{class:"muted",style:"font-size:11px;font-weight:700;text-transform:uppercase;margin-bottom:4px",
            text:"Build from stock — the rest is made from raw materials"}),
          s.fgAvail>0? row("📦","Finished stock",fgQty,s.fgAvail,
            v=>{ fsFgWanted=Math.max(0,+v||0); calc(); }):null,
          s.wipAvail>0? row("🧵","Half-made stock",wipQty,s.wipAvail,
            v=>{ fsWipWanted=Math.max(0,+v||0); calc(); }):null,
          h("div",{class:"flex between aic",style:"gap:12px;font-size:13px;padding:8px 0 0;font-weight:800"},[
            h("span",{text:"To make from raw materials"}),
            h("span",{text:ENG.num(makeQty,2)+" "+(uom||"")}),
          ]),
        ]));
        return {fgQty, wipQty, makeQty};
      }
      function drawMaterials(){
        matHost.innerHTML="";
        const el=UI.$("#fs_item"); const it=(el&&ENG.item(el.value))||null;
        if(!it){ srcHost.innerHTML=""; return; }
        const isWip=catNow==="WIP";
        const ownerId=isWip?(it.stageOf||""):it.id;
        const owner=ENG.item(ownerId); const bom=ENG.data.boms[ownerId];
        if(!owner||!bom||!(bom.lines||[]).length){
          matHost.appendChild(h("div",{class:"muted",style:"font-size:12px;margin-top:12px",
            text:"No BOM recipe for this product — no materials will be deducted."}));
          return;
        }
        // whatever is taken off the shelf draws no recipe at all
        const src=drawSources(ownerId, it.id, postQty()||0, it.uom||"");
        const qty=src.makeQty;

        /* ---- ranged materials: pick the real one from what the store holds ----
           Identical to New Work Order. The BOM records a choice ("CLOFT 912 /
           CLOFT 913") or a span ("0.08-0.10") rather than one material; which
           is actually issued is decided here, against live stock, and travels
           to the server so the issue posts the material that was chosen. */
        const norm=BOMCALC.normalize(bom.lines);
        const ranged=norm.map((l,i)=>({l,i})).filter(x=>x.l.ranged);
        if(ranged.length){
          matHost.appendChild(h("div",{class:"muted",style:"font-size:11px;font-weight:700;text-transform:uppercase;margin:14px 0 8px",text:"⟡ Choose material to issue"}));
          ranged.forEach(({l,i})=>{
            const cands=BOMCALC.candidatesFor(l,ENG.data.items)
              .map(cid=>({id:cid,item:ENG.item(cid)||{},have:(ENG.stock(cid)||{}).onHand||0}))
              .sort((a,b)=>b.have-a.have);
            const inStock=cands.filter(c=>c.have>0);
            const usable=inStock.length?inStock:cands;
            if(fsChoices[i]==null && usable.length) fsChoices[i]=usable[0].id;
            const sel=h("select",{class:"select",style:"max-width:340px",
              onchange:e=>{ fsChoices[i]=e.target.value; drawMaterials(); }},
              usable.map(c=>h("option",{value:c.id,selected:fsChoices[i]===c.id,
                text:(c.item.id?U.matDisplay(c.item):c.id)+" · "+ENG.num(c.have,1)+" "+(c.item.uom||"")+" in store"})));
            matHost.appendChild(h("div",{style:"margin-bottom:8px"},[
              h("div",{class:"muted",style:"font-size:11.5px;margin-bottom:3px",
                text:(l.rm||"")+(l.rmType?" — "+l.rmType:"")+(l.rmThk?" · "+l.rmThk+" mm":"")+(l.rmGsm?" · "+l.rmGsm+" g/m²":"")}),
              usable.length? sel : h("div",{class:"muted",style:"font-size:12px;color:var(--danger)",text:"No matching material found in the store"})
            ]));
          });
        }

        const resolved=BOMCALC.resolve(bom,fsChoices);
        const cc=BOMCALC.compute({lines:resolved},BOMCALC.metaFromItem(owner));
        const perOf=l=> cc.fgKgPerBatch? l.qty/cc.fgKgPerBatch : l.qty;
        const keep=l=>!isWip||["base","paste"].includes(materialRole(l.id));
        const needBy={};   // a fabric can sit in two layers — the store is shared
        resolved.forEach(l=>{ if(l.id&&keep(l)) needBy[l.id]=(needBy[l.id]||0)+perOf(l)*qty/bom.yield; });
        materialsList(matHost, layerGroups(resolved).map(grp=>({
          label: grp.label,
          lines: grp.lines.filter(keep).map(l=>{
            const rid=l.id, r=rid?(ENG.item(rid)||{}):{};
            return { name: matLineName(l), code: matLineCode(l), spec: matLineSpec(l),
              need: perOf(l)*qty/bom.yield,
              have: rid?(ENG.stock(rid).onHand||0):0,
              agg: rid?needBy[rid]:undefined,
              uom: r.uom||l.unit||"" };
          }),
        })), {title:"Raw materials to be deducted from store"});

        /* ---- a short material blocks the booking, exactly as it blocks a
           work order: stock cannot be issued that is not there ---- */
        fsShort=Object.entries(needBy)
          .filter(([rid,n])=>((ENG.stock(rid).onHand||0)+1e-6)<n)
          .map(([rid])=>{const r=ENG.item(rid)||{};return r.id?U.matDisplay(r):rid;});
        if(qty>0 && fsShort.length){
          matHost.appendChild(h("div",{style:"margin-top:10px;padding:9px 12px;border:1.5px solid var(--danger);border-radius:8px;color:var(--danger);font-size:12.5px;font-weight:600",
            text:"⛔ Cannot book this production — short of: "+fsShort.join(", ")+". Add the stock first."}));
        }
        if(saveBtn) saveBtn.disabled=(qty>0 && fsShort.length>0);
      }
      /* what actually posts: the item's OWN unit, whatever it was counted in */
      function postQty(){
        const el=UI.$("#fs_item"); const it=(el&&ENG.item(el.value))||null;
        if(!it) return null;
        const c=derive(); if(!c) return null;
        const uom=String(it.uom||"KG").toUpperCase();
        if(isMtr(uom)) return c.len;
        if(uom==="SQM") return c.sqm;
        return c.kg==null?null:c.kg*({KG:1,GRAM:1000,MG:1e6}[uom]||1);
      }
      UI.$("#fs_cat").addEventListener("change",buildPicker);
      ["fs_qty","fs_gsm","fs_tapewid"].forEach(id=>{ const e=UI.$("#"+id); if(e) e.addEventListener("input",calc); });
      buildPicker();   // also renders the unit select and binds its change

      async function save(btn){
        const el=UI.$("#fs_item");
        const itemId=el?el.value:"";
        if(!itemId){ toast("Pick a product",{type:"warn"}); return; }
        const it=ENG.item(itemId)||{};
        const entered=+UI.$("#fs_qty").value, wh=UI.$("#fs_wh").value;
        if(!entered||entered<=0){ toast("Enter the quantity produced",{type:"warn"}); return; }
        if(fsShort.length){ toast("Materials are short — cannot book this production: "+fsShort.join(", "),
          {type:"danger",title:"Insufficient stock"}); return; }
        const tapeWidthMM=catNow==="FG"?(+UI.$("#fs_tapewid").value||null):null;
        if(catNow==="FG" && !tapeWidthMM){ toast("Enter the tape width for a finished good",{type:"warn"}); return; }
        /* book the output in the ITEM's own unit, whatever it was counted in —
           the same conversion the materials preview above is sized by */
        const postUom=String(it.uom||"KG").toUpperCase();
        let qty=postQty();
        if(qty==null||!(qty>0)){ toast("Enter the GSM so the quantity can be converted to "+postUom,{type:"warn"}); return; }
        qty=+qty.toFixed(3);
        btn.disabled=true; btn.textContent="Saving…";
        try{
          /* thickness is no longer sent: it is a property of the stock item
             that was PICKED, not something typed here, so there is nothing to
             write back. GSM stays editable and does get saved. */
          const r=await DB.production.addFinishedStock(Object.assign(
            {itemId, qty, wh, tapeWidthMM, gsm:+UI.$("#fs_gsm").value||null},
            // which material was picked for each ranged BOM line — so the issue
            // posts the material actually chosen, exactly as a work order does
            Object.keys(fsChoices).length?{materialChoices:fsChoices}:{},
            // admin-only: how much of this run comes off the shelf instead of
            // being made from the recipe (the server enforces the role too)
            canSource?{fgQty:fsFgWanted, wipQty:fsWipWanted}:{}));
          mo.close();
          const used=(r&&r.consumed||[]).length;
          toast(ENG.num(qty,2)+" "+postUom+" added"+(used?" · "+used+" material(s) issued":""),
            {type:"ok",title:(catNow==="FG"?"Finished stock booked":"Work in process booked")});
          await App.reloadState();
        }catch(err){
          toast(err.message||"Could not add finished stock",{type:"danger"});
          btn.disabled=false; btn.textContent="Add to Finished Stock";
        }
      }
    }

    function woForm(){
      const fgs=ENG.data.items.filter(i=>i.cat==="FG");
      const body=h("div",{class:"form-grid"},[
        fgPicker("w_item", fgs, fgs[0]&&fgs[0].id),
        U.field("Quantity",`<div class="flex" style="gap:6px"><input class="input" id="w_qty" type="number" min="0" value="100" style="flex:1"><select class="select" id="w_unit" style="width:92px" title="Enter the run size in kilograms or square metres"><option value="KG">kg</option><option value="SQM">sqm</option></select></div><div class="muted" id="w_conv" style="font-size:11px;margin-top:3px"></div>`),
        /* Width is a per-ORDER parameter, not a product one: the same tape is
           slit to whatever width the customer ordered, so it is captured on the
           run and travels with the batch onto the invoice. */
        U.field("Tape Width (mm)",`<input class="input" id="w_width" type="number" min="0" step="0.5" placeholder="e.g. 25"><div class="muted" id="w_wnote" style="font-size:11px;margin-top:3px"></div>`),
        U.field("Production Line",U.selectHTML("w_line",[{v:"RM Production 1",l:"RM Production 1 — Gautam Saw"},{v:"RM Production 2",l:"RM Production 2 — Ganesh"},{v:"Fibre-Glass Line 1",l:"Fibre-Glass Line 1"},{v:"Slitting A",l:"Slitting A"},{v:"Slitting B",l:"Slitting B"}],"Slitting A")),
        U.field("Due Date",`<input class="input" id="w_due" type="date" value="${DB.helpers.daysAhead(7)}">`),
        U.field("Priority",U.selectHTML("w_prio",[{v:"Normal",l:"Normal"},{v:"High",l:"High"},{v:"Urgent",l:"Urgent"}],"Normal")),
      ]);
      // the form body is a 2-column grid — without an explicit span these
      // hosts land in ONE column and the materials list gets half the modal
      const routeHost=h("div",{style:"grid-column:1/-1"});
      body.appendChild(routeHost);
      const specHost=h("div",{style:"margin-top:4px;grid-column:1/-1"});
      body.appendChild(specHost);
      const matHost=h("div",{style:"margin-top:4px;grid-column:1/-1"});
      body.appendChild(matHost);
      let matChoices={};        // ranged line index -> chosen stock item id
      let shortages=[];         // materials short of stock — blocks creation
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
      /* thickness comes from the product, width from this order — shown
         together so the size on the invoice is obvious while planning */
      const widthHint=()=>{ const el=UI.$("#w_wnote"); if(!el) return;
        const thk=(ENG.item(UI.$("#w_item").value)||{}).thicknessMM;
        const w=+UI.$("#w_width").value||0;
        el.textContent = thk==null ? (w?"Size "+w+" mm wide":"")
          : (w? "Size "+thk+" × "+w+" mm" : "Thickness "+thk+" mm — enter the width this run is slit to"); };
      /* ---- netting the requirement against stock already on the shelf -------
         Mirrors the server (stageService.planForRequirement) so the planner
         sees the same answer before pressing Create: finished goods of the
         same product, thickness and TAPE WIDTH go straight to packing;
         half-made rolls of the same product and thickness skip coating and
         join at slitting; only what is left is actually made. */
      const nameKey=i=>String((i&&(i.productName||i.name))||"").trim().toUpperCase();
      const sameThk=(a,b)=>{ const x=a==null?null:+a, y=b==null?null:+b;
        if(x==null||y==null) return x==null&&y==null; return Math.abs(x-y)<1e-6; };
      const onHandOf=id=>((ENG.stock(id)||{}).onHand)||0;
      const drawFrom=(rows,want)=>{ const used=[]; let left=+want||0;
        rows.forEach(r=>{ if(left<=1e-9) return; const take=Math.min(left,r.have);
          if(take>1e-9){ used.push({id:r.id,name:r.name,qty:take}); left-=take; } });
        return {used, taken:(+want||0)-left}; };
      const cap=(want,avail,left)=>Math.max(0,Math.min(+want||0,avail,left));
      function netPlan(id, qty, widthMM, hasCoating){
        const fg=ENG.item(id)||{};
        const want=(widthMM==null||widthMM==="")?null:+widthMM;
        const plan={qty, fgQty:0, wipQty:0, makeQty:qty, fgSources:[], wipSources:[],
          hasCoating:!!hasCoating, fgAvailable:0, wipAvailable:0};
        if(!(qty>0)) { plan.makeQty=0; return plan; }
        const fgRows=ENG.data.items.filter(i=>i.cat==="FG")
          .filter(i=>nameKey(i)===nameKey(fg))
          .filter(i=>sameThk(i.thicknessMM,fg.thicknessMM))
          .filter(i=>want==null?true:sameThk(i.tapeWidthMM,want))
          .map(i=>({id:i.id,name:i.name||i.id,have:onHandOf(i.id)}))
          .filter(r=>r.have>0);
        plan.fgAvailable=fgRows.reduce((n,r)=>n+r.have,0);
        // a typed amount wins; otherwise take as much as the shelf allows
        const fgDraw=drawFrom(fgRows, fgWanted==null? Math.min(plan.fgAvailable,qty)
          : cap(fgWanted, plan.fgAvailable, qty));
        plan.fgQty=fgDraw.taken; plan.fgSources=fgDraw.used;
        const afterFg=qty-plan.fgQty;
        // only the COATED JUMBO can join at slitting — rolls that have
        // already been slit would be cut twice (mirrors the server)
        const isSlit=i=>/-S$/.test(String(i.id||""))||/slit/i.test(String(i.name||""));
        const wipRows=ENG.data.items.filter(i=>i.cat==="WIP").filter(i=>!isSlit(i))
          .filter(i=>i.stageOf? i.stageOf===id : (nameKey(i)===nameKey(fg)&&sameThk(i.thicknessMM,fg.thicknessMM)))
          .map(i=>({id:i.id,name:i.name||i.id,have:onHandOf(i.id)}))
          .filter(r=>r.have>0);
        plan.wipAvailable=wipRows.reduce((n,r)=>n+r.have,0);
        if(hasCoating && afterFg>0){
          const wipDraw=drawFrom(wipRows, wipWanted==null? Math.min(plan.wipAvailable,afterFg)
            : cap(wipWanted, plan.wipAvailable, afterFg));
          plan.wipQty=wipDraw.taken; plan.wipSources=wipDraw.used;
        }
        plan.makeQty=afterFg-plan.wipQty;
        return plan;
      }
      /* How much comes off the shelf is the PLANNER'S choice, not a fixed
         calculation: each source gets an editable quantity, capped at what is
         actually there, and whatever is left over is manufactured. */
      let fgWanted=null, wipWanted=null;   // null = "take whatever is available"
      function netPanel(plan, uom){
        const avFg=plan.fgAvailable||0, avWip=plan.wipAvailable||0;
        if(!(avFg>0 || avWip>0)) return null;
        const row=(icon,label,val,max,dest,src,onInput)=>h("div",{class:"flex between aic",
            style:"gap:12px;font-size:12.5px;padding:7px 0;border-bottom:1px solid var(--line)"},[
          h("div",{style:"min-width:0"},[
            h("div",{text:icon+" "+label}),
            h("div",{class:"muted",style:"font-size:11px",
              text:(src&&src.length? src.map(s=>s.name+" · "+ENG.num(s.qty,2)).join(" · ")+"  ·  " : "")
                +ENG.num(max,2)+" "+(uom||"")+" available"}),
          ]),
          h("div",{class:"flex aic",style:"gap:8px;flex:0 0 auto"},[
            h("input",{class:"input",type:"number",min:"0",step:"any",value:ENG.num(val,2),
              style:"width:110px;text-align:right",oninput:e=>onInput(e.target.value)}),
            h("div",{class:"muted",style:"font-size:11px;white-space:nowrap;min-width:96px",text:dest}),
          ]),
        ]);
        return h("div",{style:"margin:12px 0;padding:10px 12px;border:1.5px solid var(--ok);border-radius:10px"},[
          h("div",{class:"muted",style:"font-size:11px;font-weight:700;text-transform:uppercase;margin-bottom:4px",
            text:"Take from stock — the rest is made from raw materials"}),
          avFg>0? row("📦","Finished stock",plan.fgQty,avFg,"→ packing",plan.fgSources,
            v=>{ fgWanted=v===""?null:Math.max(0,+v||0); recalc(); }):null,
          (avWip>0&&plan.hasCoating)? row("🧵","Half-made stock",plan.wipQty,avWip,"→ slitting",plan.wipSources,
            v=>{ wipWanted=v===""?null:Math.max(0,+v||0); recalc(); }):null,
          h("div",{class:"flex between aic",style:"gap:12px;font-size:13px;padding:8px 0 0;font-weight:800"},[
            h("span",{text:"To manufacture from raw materials"}),
            h("span",{text:ENG.num(plan.makeQty,2)+" "+(uom||"")}),
          ]),
        ]);
      }

      const recalc=()=>{ const id=UI.$("#w_item").value; convHint(); widthHint(); const qty=qtyKg()||0; const bom=ENG.data.boms[id];
        // show the stages this product will actually run, and keep the line in
        // the area that starts it (a one-material product never enters coating)
        const rt=routeFor(id,qty), lineSel=UI.$("#w_line"), pool=LINES_BY_AREA[rt.area]||[];
        if(lineSel && pool.length) lineSel.value=rt.line||pool[0];
        const own=productOwner(id);
        routeHost.innerHTML="";
        routeHost.appendChild(h("div",{class:"wo-route"},[
          h("span",{class:"wo-route-lbl",text:"Route"}),
          h("span",{class:"wo-route-path",text:rt.stages.join("  \u2192  ")}),
          rt.ready
            ? h("span",{class:"chip",style:"font-size:10.5px",
                text:own?"material in store \u2014 straight to slitting":"bought in \u2014 slit & pack"})
            : h("span",{class:"chip",style:"font-size:10.5px;border-color:var(--warn);color:var(--warn)",
                text:"material short \u2014 "+rt.owner.person+" produces it first"}),
        ]));
        // per-order production spec (e.g. copper-wire count) for products that need it
        specHost.innerHTML="";
        const spec=ORDER_SPEC[id];
        if(spec){ specHost.appendChild(U.field(spec.label,`<input class="input" id="w_spec" type="number" min="0" placeholder="as per order">`)); }
        matHost.innerHTML="";
        shortages=[]; if(createBtn) createBtn.disabled=false;
        /* net the requirement before anything else is worked out — the
           materials list below sizes itself to what is actually MADE */
        const widthNow=(UI.$("#w_width")||{}).value;
        const plan=netPlan(id, qty, widthNow, !rt.ready && !!own);
        const uomNow=(ENG.item(id)||{}).uom||"";
        const panel=netPanel(plan, uomNow);
        if(panel) matHost.appendChild(panel);
        const makeQty=plan.makeQty;
        if(!bom) return;

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
                text:(l.rm||"")+(l.rmType?" — "+l.rmType:"")+(l.rmThk?" · "+l.rmThk+" mm":"")+(l.rmGsm?" · "+l.rmGsm+" g/m²":"")}),
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
        // only the manufactured remainder draws raw material from the store
        resolved.forEach(l=>{ if(l.id) needBy[l.id]=(needBy[l.id]||0)+perOf(l)*makeQty/bom.yield; });
        // the shared renderer — the Add to Finished Stock forms show the very
        // same list, built the same way, so the two can never drift apart
        materialsList(matHost, layerGroups(resolved).map(grp=>({
          label: grp.label,
          lines: grp.lines.map(l=>{
            const rid=l.id, r=rid?(ENG.item(rid)||{}):{};
            return { name: matLineName(l), code: matLineCode(l), spec: matLineSpec(l),
              need: perOf(l)*makeQty/bom.yield,
              have: rid?(ENG.stock(rid).onHand||0):0,
              agg: rid?needBy[rid]:undefined,
              uom: r.uom||l.unit||"" };
          }),
        })));
        /* a short material blocks creation outright — the run cannot start
           without the stock to make it */
        shortages=Object.entries(needBy)
          .filter(([rid,n])=>((ENG.stock(rid).onHand||0)+1e-6)<n)
          .map(([rid])=>{const r=ENG.item(rid)||{};return r.id?U.matDisplay(r):rid;});
        if(makeQty>0 && shortages.length){
          matHost.appendChild(h("div",{style:"margin-top:10px;padding:9px 12px;border:1.5px solid var(--danger);border-radius:8px;color:var(--danger);font-size:12.5px;font-weight:600",
            text:"⛔ Cannot create this work order — short of: "+shortages.join(", ")+". Add the stock first."}));
          if(createBtn) createBtn.disabled=true;
        }
      };
      const createBtn=h("button",{class:"btn primary",onclick:save,text:"Create Work Order"});
      const mo=modal({title:"New Work Order", sub:"Plan a production run", body,
        foot:[h("button",{class:"btn ghost",onclick:()=>mo.close(),text:"Cancel"}), createBtn]});
      setTimeout(()=>{ UI.$("#w_item").addEventListener("change",recalc); UI.$("#w_qty").addEventListener("input",recalc); UI.$("#w_unit").addEventListener("change",recalc); /* the width decides WHICH finished stock can be used, so it re-nets the
   whole plan rather than just refreshing its own hint */
UI.$("#w_width").addEventListener("input",recalc); recalc(); },50);
      async function save(){
        const itemId=UI.$("#w_item").value, qty=qtyKg();
        if(qty==null){ toast("This product has no GSM — enter the quantity in kg",{type:"warn"}); return; }
        if(!qty||qty<=0){ toast("Enter a valid quantity",{type:"warn"}); return; }
        if(shortages.length){ toast("Materials are short — cannot create this work order: "+shortages.join(", "),{type:"danger",title:"Insufficient stock"}); return; }
        const payload={itemId, qty, line:UI.$("#w_line").value, due:UI.$("#w_due").value, priority:UI.$("#w_prio").value};
        const wmm=+UI.$("#w_width").value; if(wmm>0) payload.widthMM=wmm;
        /* how much to take off the shelf — sent explicitly (0 included, which
           is why this is not a truthiness check) so the server draws exactly
           what the planner chose rather than as much as it can */
        if(fgWanted!=null) payload.fgQty=fgWanted;
        if(wipWanted!=null) payload.wipQty=wipWanted;
        // which material was picked for each ranged BOM line — travels with the
        // work order so the issue posts the material actually chosen
        if(Object.keys(matChoices).length) payload.materialChoices=matChoices;
        const spec=ORDER_SPEC[itemId], specEl=UI.$("#w_spec");
        if(spec && specEl && specEl.value!=="") payload[spec.key]=+specEl.value;
        createBtn.disabled=true; createBtn.textContent="Creating…";
        try{
          const res=await DB.production.create(payload);
          const flow=(res.route||[]).map(r=>STAGE_LABEL[r.key]||r.name).join(" → ");
          mo.close(); toast((res.id||"Work order")+" created — "+flow,{type:"ok"});
          await reloadState(); tab="active"; draw();
        }catch(e){ toast("Create failed: "+e.message,{type:"danger"});
          createBtn.disabled=false; createBtn.textContent="Create Work Order"; }
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
          {key:"name",label:"Raw Material",cls:"nm",render:r=>esc(r.name)},
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
      const altHost=h("div",{style:"margin-bottom:10px"});
      const tblHost=h("div",{class:"bom-edit-wrap"});
      const totHost=h("div",{style:"margin-top:14px"});
      const body=h("div",{},[basisHost,altHost,
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
        const tbl=h("table",{class:"tbl",style:"width:100%"});
        tbl.appendChild(h("thead",{},[h("tr",{},
          ["Raw material","Code","Qty / batch","Unit","GSM (g/m²)","Pickup %","Consumption / kg","Consumption / sqm"].map((t,i)=>
            h("th",{style:"font-size:11px;"+(i>=2?"text-align:right":""),text:t})))]));
        const tb=h("tbody");
        /* the LAYERS live inside this table: each layer name is a heading
           row, and its materials sit beneath it. Single-layer products get
           the same heading row as multi-layer ones so the two read alike. */
        const idxLines=BOMCALC.normalize(src.lines).map((l,i)=>Object.assign({_i:i},l));
        const grps=layerGroups(idxLines);
        const ordered=[];
        grps.forEach((grp,gi)=>{
          ordered.push({_head:grp.label||(grps.length>1?"LAYER "+(gi+1):"LAYER 1")});
          grp.lines.forEach(l=>ordered.push(c.lines[l._i]));
        });
        (ordered.length?ordered:c.lines).forEach(cl=>{
          if(cl && cl._head!=null){
            tb.appendChild(h("tr",{},[h("td",{colspan:"8",
              style:"font-weight:800;font-size:11.5px;text-transform:uppercase;letter-spacing:.4px;color:var(--accent);padding:11px 8px 4px",
              text:cl._head})]));
            return;
          }
          const r=cl.id?ENG.item(cl.id):null;
          // name cell carries ONLY the material name; the code column ONLY its code
          const label=r? (r.material||r.name||"—") : (cl.rm||cl.id||"—");
          const codeTxt=r? (r.grade||"—") : (cl.rmType||"—");
          tb.appendChild(h("tr",{},[
            h("td",{class:"nm",style:"min-width:130px"},[
              h("div",{class:"flex aic",style:"gap:6px"},[
                h("span",{style:"font-weight:600",text:label}),
                cl.ranged?h("span",{class:"chip",style:"font-size:10px",title:"Resolved against live store stock at work-order issue",text:"⟡ ranged"}):null
              ])
            ]),
            h("td",{class:"mono muted",style:"font-size:11px",text:codeTxt}),
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
      const altHost=h("div",{style:"margin-bottom:10px"});
      const tblHost=h("div",{class:"bom-edit-wrap"});
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
        basisHost, altHost,
        h("h3",{style:"margin:14px 0 8px;font-size:13px",text:"Components (quantity per batch)"}),
        tblHost,
        h("button",{class:"btn sm",style:"margin-top:8px",onclick:()=>{lines.push(blank());draw();},html:"＋ Add component"}),
        totHost,
      ]);

      const foot=[h("button",{class:"btn ghost",onclick:()=>mo.close(),text:"Cancel"})];
      if(editing) foot.push(h("button",{class:"btn danger",onclick:()=>delBom(),text:"🗑 Delete BOM"}));
      foot.push(h("button",{class:"btn primary",onclick:save,text:editing?"Save BOM":"Create BOM"}));
      const mo=modal({title: editing?("Edit BOM · "+curFg):"Create BOM",
        // xwide: the components table needs the room, else it side-scrolls
        sub:"Material recipe, pickup % and production roll-up", xwide:true, body, foot});
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
        const tbl=h("table",{class:"tbl bom-edit-tbl"});
        tbl.appendChild(h("thead",{},[h("tr",{},head.map((t,i)=>
          h("th",{style:"font-size:11px;"+(i>=1&&i<=6?"text-align:right":""),text:t})))]));
        const tb=h("tbody");
        /* layer names render as heading rows inside the editable table; a
           single-layer product gets the same heading so it reads like a
           multi-layer one */
        const grpIdx=layerGroups(lines.map((l,i)=>Object.assign({_i:i},l)));
        const heads={};
        grpIdx.forEach((g,gi)=>{ if(g.lines.length) heads[g.lines[0]._i]=g.label||(grpIdx.length>1?"LAYER "+(gi+1):"LAYER 1"); });
        c.lines.forEach((cl,i)=>{
          const l=lines[i];
          if(heads[i]!=null) tb.appendChild(h("tr",{},[h("td",{colspan:"8",
            style:"font-weight:800;font-size:11.5px;text-transform:uppercase;letter-spacing:.4px;color:var(--accent);padding:11px 8px 4px",
            text:heads[i]})]));
          const nameCell=h("td",{class:"nm bom-nm"});
          if(l.ranged){
            // A ranged line has no single material yet — the real one is chosen
            // against live store stock when the work order is issued.
            nameCell.appendChild(h("div",{},[
              h("div",{style:"font-weight:700;font-size:12.5px",text:(l.rm||"—")+(l.rmType?" — "+l.rmType:"")}),
              h("span",{class:"chip",style:"font-size:10px",title:"Resolved against live store stock at work-order issue",text:"⟡ ranged — picked at issue"})
            ]));
          } else {
            nameCell.appendChild(h("div",{html:U.searchSelect("bl_rid_"+l._k,
              matOptions(l.id), l.id, "Search material…")}));
            if(l.rm) nameCell.appendChild(h("div",{class:"muted",style:"font-size:10.5px;margin-top:2px",
              text:l.rm+(l.rmType?" — "+l.rmType:"")+(l.rmGsm?" · "+l.rmGsm+" g/m²":"")+(l.rmThk?" · "+l.rmThk+" mm":"")}));
          }
          const qtyIn=h("input",{class:"input bom-num",type:"number",step:"0.001",value:l.qty,
            style:"text-align:right",oninput:e=>{ l.qty=+e.target.value||0; refresh(); }});
          // Unit and GSM together decide whether a line is a fabric (a layer).
          // Redraw only when that flips — otherwise just recompute, so typing
          // never loses the caret.
          const reclass=(fn)=>(e)=>{ const before=BOMCALC.isFabric(l); fn(e);
            if(BOMCALC.isFabric(l)!==before) draw(); else refresh(); };
          // The GSM cell only exists on MTR lines, so a unit edit that crosses
          // the MTR boundary needs a redraw even before a GSM makes it a fabric.
          const unitIn=h("input",{class:"input bom-unit",value:l.unit||"KG",
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
  /* the supervisor panel renders the same Add to Finished Stock form, so it
     shares this module's materials list rather than growing a second one */
  window._erpUtil = Object.assign(window._erpUtil||{}, { materialsList, materialRole });

  window.ERPActions = Object.assign(window.ERPActions||{}, {
    newWO:  { ic:"⚙️", label:"New Work Order", run:()=>App.go("production",{openNew:true}) },
    newBOM: { ic:"🧬", label:"Create BOM",     run:()=>App.go("bom",{openNew:true}) },
  });
})();
