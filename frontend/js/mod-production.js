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
  /* `rmprod` is the RM-production stage — the coating floor. Its stage NAME
     carries whose line it is ("RM Production — Gautam Saw"), which is not what
     belongs on a button; without an entry here every label fell through to the
     bare word "stage". */
  const STAGE_LABEL={coating:"Coating",rmprod:"Coating",slitting:"Slitting",packing:"Packing",production:"Production",weaving:"Weaving",wbcoat:"WB Coating",fiberglass:"Fiber-Glass"};
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
    try{ lines=BOMCALC.toLegacy(bom,BOMCALC.metaFromItem(ENG.item(itemId)||{}),null,ENG.item); }
    catch(e){ return true; }
    const Y=bom.yield||1;
    return lines.every(([rid,per])=>{
      const need=per*(+qty||0)/Y;
      const have=(ENG.stock(rid)||{}).onHand||0;
      return have+1e-6>=need;
    });
  }
  /* Mirrors stageService.routeStagesFor: WHO MAKES IT decides the route, not
     what is in the store. Raw material on the shelf is what lets the coating
     floor run — it is not a coated web, so it never shortens the route. Only
     a half-made coated jumbo skips coating, and that is the netting panel's
     job. `stocked` is still reported so the form can say whether the run can
     start immediately or is waiting on material. */
  function routeFor(itemId, qty, line){
    const owner=productOwner(itemId);
    const stocked=materialInStore(itemId,qty);
    /* THE OFFICE NAMED THE LINE — the route starts there (mirrors
       stageService.stagesFromLine): an RM line is that person's floor, the
       fibre-glass line weaves first and then the product's own coating floor
       if it has one, a slitting line is slit-and-pack only. `coats` says
       whether a coating stage runs at all, which decides whether half-made
       stock can join at slitting. */
    const asked=String(line||"").trim();
    if(asked){
      const o=Object.keys(OWNERS).map(k=>OWNERS[k]).find(x=>x.line===asked)||null;
      if(o&&o.area==="coating")
        return { stages:[o.label,"Slitting","Packing"], area:"coating", line:o.line, owner:o, ready:false, bought:false, stocked, chosen:true, coats:true };
      if(o&&o.area==="fiberglass"){
        const coats=!!(owner&&owner.area==="coating");
        const stages=[OWNERS.fibre.label]; if(coats) stages.push(owner.label); stages.push("Slitting","Packing");
        return { stages, area:"fiberglass", line:o.line, owner:o, ready:false, bought:false, stocked, chosen:true, coats };
      }
      return { stages:["Slitting","Packing"], area:"slitting", line:asked, owner:null, ready:true, bought:!owner, stocked, chosen:true, coats:false };
    }
    if(!owner)
      return { stages:["Slitting","Packing"], area:"slitting", ready:true, bought:true, stocked, owner:null, coats:false };
    const stages=[];
    const fibreFirst=FIBRE_FIRST.some(p=>famMatches(famOf(itemId),p));
    if(fibreFirst) stages.push(OWNERS.fibre.label);
    stages.push(owner.label);
    stages.push("Slitting","Packing");
    const first=fibreFirst?OWNERS.fibre:owner;
    return { stages, area:first.area, line:first.line, owner:first, ready:false, bought:false, stocked, coats:true };
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
  /* A thickness worked out in binary floating point carries a tail
     ("0.14000000000000001"). Twelve significant digits is beyond anything a
     spec sheet states, so trimming there prints 0.14 without touching a real
     figure. Non-numeric values pass through untouched. */
  function trimNum(v){ const x=+v; return Number.isFinite(x)? String(+x.toPrecision(12)) : String(v); }
  function matLineSpec(l){ const bits=[];
    if(l.rmThk) bits.push(trimNum(l.rmThk)+" mm"); if(l.rmGsm) bits.push(trimNum(l.rmGsm)+" g/m²");
    return bits.join(" · "); }

  /* ---- WHICH STORE A LINE COMES OUT OF -------------------------------------
     A job draws three different things and they do not all live in the same
     place: the raw materials sit in whichever store took the delivery, the
     half-made rolls sit on the production floor, and the finished rolls sit in
     the finished bay. The planner was never told which, and once the order was
     raised the job sheet did not say either — the store only appeared later,
     on the stock ledger. Both now state it.

     issuingWh mirrors stageService.stageMovements' whFor on the server exactly,
     so what the New Work Order form predicts is what the issue actually posts:
     anything half-made leaves WH-WIP, everything else leaves whichever store
     holds the most of it, falling back to the main stores. */
  function whName(id){ return ((ENG.data.warehouses||[]).find(w=>w.id===id)||{}).name || id || ""; }
  /* Stores an issue may NOT be posted against — quarantine, holding lots that
     failed their incoming test. Same rule as grnTestService.heldWarehouseIds on
     the server, so the picker never offers a store the server would refuse. */
  function heldWhIds(){
    return (ENG.data.warehouses||[])
      .filter(w=>/quarantine|qc.?hold|reject/i.test(String(w.type||"")+" "+String(w.name||"")))
      .map(w=>w.id);
  }
  /* Every store that actually holds this material, biggest pile first — the
     list the office picks from when a material sits in more than one. */
  function whChoicesFor(rid){
    if(!rid) return [];
    const it=ENG.item(rid)||{};
    if(it.cat==="WIP"||/^WIP-/.test(String(rid))) return [];
    const held=new Set(heldWhIds());
    const byWh=(ENG.stock(rid)||{}).byWh||{};
    return Object.keys(byWh)
      .filter(wh=>!held.has(wh) && byWh[wh]>0.0001)
      .sort((a,b)=>byWh[b]-byWh[a])
      .map(wh=>({wh, qty:byWh[wh]}));
  }
  function issuingWh(rid, need){
    if(!rid) return null;
    const it=ENG.item(rid)||{};
    if(it.cat==="WIP"||/^WIP-/.test(String(rid))) return "WH-WIP";
    /* exactly issuingWarehouse's rule: given a quantity, the TIGHTEST store
       that still covers it — the big pile is left whole for the job that needs
       it — and otherwise the biggest pile, quarantine excluded, picking a store
       even where every figure is negative. */
    const held=new Set(heldWhIds());
    const byWh=(ENG.stock(rid)||{}).byWh||{};
    const whs=Object.keys(byWh).filter(wh=>!held.has(wh));
    if(need>0){
      let covers=null;
      whs.forEach(wh=>{ if(byWh[wh]+1e-9<need) return;
        if(covers==null||byWh[wh]<byWh[covers]) covers=wh; });
      if(covers) return covers;
    }
    let best=null;
    whs.forEach(wh=>{ if(best==null||byWh[wh]>byWh[best]) best=wh; });
    return best||"WH-PNY";
  }
  /* ---- HOW MUCH COMES OUT OF WHICH STORE ---------------------------------
     Mirrors stageService.drawPlan, the function the server posts the issue
     with — the leading store (the one the office named, else the standing
     rule) gives what it has and the balance comes off the others, biggest pile
     first. So what a screen tells the storeman is what the ledger will do.
     Hands back [{wh, qty}] adding up to `need` exactly; [] for nothing to draw. */
  function drawSharesFor(rid, need, chosenWh){
    need=Math.abs(+need||0);
    if(!rid || !need) return [];
    const held=new Set(heldWhIds());
    const lead=(chosenWh && !held.has(chosenWh)) ? chosenWh : issuingWh(rid, need);
    const it=ENG.item(rid)||{};
    if(it.cat==="WIP"||/^WIP-/.test(String(rid))) return [{wh:lead, qty:need}];
    const byWh=(ENG.stock(rid)||{}).byWh||{};
    const order=Object.keys(byWh).filter(wh=>!held.has(wh) && wh!==lead && byWh[wh]>1e-9)
      .sort((a,b)=>byWh[b]-byWh[a]);
    order.unshift(lead);
    const out=[]; let left=need;
    order.forEach(wh=>{
      if(left<=1e-9) return;
      const have=byWh[wh]||0; if(have<=1e-9) return;
      const take=Math.min(left,have);
      out.push({wh, qty:take}); left-=take;
    });
    // short everywhere: the shortfall stays on the leading store, as it will
    // on the issue — the ledger has to balance either way
    if(left>1e-9){ const f=out.find(o=>o.wh===lead); if(f) f.qty+=left; else out.push({wh:lead, qty:left}); }
    const q6=n=>Math.round(n*1e6)/1e6;
    const sh=out.map(o=>({wh:o.wh, qty:q6(o.qty)}));
    if(sh.length) sh[0].qty=q6(sh[0].qty+(need-sh.reduce((n,o)=>n+o.qty,0)));
    return sh.filter(o=>Math.abs(o.qty)>1e-9);
  }
  /* Where a RAISED order actually drew each item from. The store written on the
     issue posted against the work order is a fact, not a forecast, and it can
     differ from issuingWh once stock has moved since — so a raised order reads
     its movements and only falls back to the prediction for a pending balance
     that has not been issued yet. A resumed order issues again when the balance
     is released and can take the second lot out of a different store, so every
     distinct store is kept rather than only the first. */
  function drawnWhFor(woId){
    const by={};
    (ENG.data.movements||[]).forEach(m=>{
      if(m.ref!==woId || !m.wh || (+m.qty||0)>=0) return;
      const seen=by[m.itemId]=by[m.itemId]||[];
      const row=seen.find(x=>x.wh===m.wh);
      // how much each store actually gave, not merely that it gave something
      if(row) row.qty+=Math.abs(+m.qty||0);
      else seen.push({wh:m.wh, qty:Math.abs(+m.qty||0)});
    });
    return by;
  }
  /* WHO A WORK ORDER IS FOR — the client the office named when it raised the
     job, and nothing else. viewService has a fallback for the supervisor's
     board that guesses from open sales orders; the office side never guesses,
     because a job made to stock genuinely has no customer and saying it has
     one is worse than saying nothing. */
  function woCustomer(wo){
    const id=wo&&wo.customerId; if(!id) return null;
    return (ENG.data.customers||[]).find(c=>c.id===id)||null;
  }
  function woCustomerName(wo){ const c=woCustomer(wo); return c?(c.name||c.id):null; }

  /* the one label for a store, so every place that names one reads alike */
  function whChip(whId){
    if(!whId) return null;
    return h("span",{class:"muted",style:"font-size:11px;white-space:nowrap",text:"🏬 "+whName(whId)});
  }
  /* THE STORE AND WHAT COMES OUT OF IT. Naming the store was only half the
     answer wherever a draw is split across two: the storeman has to know how
     much to take off each shelf, so the quantity rides on the chip.
     `sources` is [{wh, qty}] — drawSharesFor's shape, and the server's. */
  function whQtyChip(src, it, opts){
    opts=opts||{};
    const q=it?ENG.qtyText(it,src.qty,2):ENG.num(src.qty,2);
    return h("span",{class:"wo-src-wh"+(opts.done?" is-done":""),
      title:(opts.done?"Already issued from ":"To be drawn from ")+whName(src.wh),
      text:"🏬 "+whName(src.wh)+" · "+q});
  }
  function whQtyChips(sources, it, opts){
    const list=(sources||[]).filter(s=>s&&s.wh&&Math.abs(+s.qty||0)>1e-9);
    if(!list.length) return [];
    const row=list.map(s=>whQtyChip(s,it,opts));
    /* a split draw is worth saying out loud — two chips against one material
       read like a double issue otherwise */
    if(list.length>1) row.push(h("span",{class:"muted",style:"font-size:10.5px",
      text:"across "+list.length+" stores"}));
    return row;
  }
  /* the store the coating floor put the coated roll down in, recorded on the
     stage that made it as that stage was closed. Not stock — a location. */
  function coatedRollAt(wo){
    const s=(wo&&wo.route||[]).find(r=>r.area==="coating"&&r.outWh);
    return s?s.outWh:null;
  }

  /* what a material DOES in the process — mirrors the backend's
     stageService.materialRole, so "what coating consumes" means the same
     thing on screen as it does when the stock is actually issued */
  function materialRole(id){
    const s=String(id||"").toUpperCase();
    if(s.startsWith("PKG-")||s.includes("CORE")) return "pack";
    if(/MICA|SAP|CARBON|SILICONE|ACRYLIC|ADH|INORGANIC|SOLVENT|RESIN|BINDER|PASTE/.test(s)) return "paste";
    return "base";
  }

  /* ---- OPTIONAL MATERIALS (ink on an aluminium tape) --------------------
     Part of the recipe, not of every run: some customers want the print,
     some do not. Nothing is assigned until it is TICKED here; the tick is
     stored as "use:<line index>" in the same choices object as the ranged
     picks, so it reaches the server on the work order and the stage issues
     exactly what this screen showed. */
  function optionalPicker(host, bom, choices, qty, redraw){
    const norm=BOMCALC.normalize(bom.lines);
    const opts=norm.map((l,i)=>({l,i})).filter(x=>x.l.optional);
    if(!opts.length) return;
    host.appendChild(h("div",{class:"muted",style:"font-size:11px;font-weight:700;text-transform:uppercase;margin:14px 0 8px",
      text:"\u2661 Optional materials \u2014 tick what this run should use"}));
    const cc=BOMCALC.compute({lines:norm},null);
    opts.forEach(({l,i})=>{
      const key="use:"+i, on=!!choices[key];
      const mat=l.id?ENG.item(l.id):null;
      const box=h("input",{type:"checkbox",style:"width:16px;height:16px;accent-color:var(--accent)"});
      box.checked=on;
      box.addEventListener("change",()=>{ if(box.checked) choices[key]=true; else delete choices[key]; redraw(); });
      const nm=(mat&&mat.name)||l.rm||l.id||"?";
      const have=l.id?((ENG.stock(l.id)||{}).onHand||0):0;
      host.appendChild(h("label",{class:"flex aic",style:"gap:10px;padding:6px 0;border-bottom:1px solid var(--line);cursor:pointer;font-size:13px"},[
        box,
        h("span",{style:"font-weight:600",text:nm}),
        l.id?h("span",{class:"muted mono",style:"font-size:11px",text:l.id}):null,
        h("span",{class:"muted",style:"margin-left:auto;white-space:nowrap",
          text:ENG.num(l.qty,2)+" "+(l.unit||"")+" per batch \u00b7 in store "+(mat?ENG.qtyText(mat,have,1):ENG.num(have,1))}),
      ]));
    });
  }

  /* ---- THE materials list, used everywhere a recipe is previewed ----------
     New Work Order and both Add-to-Finished-Stock forms render the same
     thing: a layer heading where the product has layers, then one row per
     material carrying its live need / in-store / short figures.
     `groups` is [{ label, lines:[{ name, code, spec, need, have, uom, agg, wh }] }]
     — `agg` is the need across ALL layers when a material appears in more
     than one, since the store is shared between them, and `wh` is the store
     the line is issued from, shown only where the caller knows it.
     A line may instead carry `sources` — [{wh, qty}], how much comes off EACH
     store — and then the row says so shelf by shelf rather than naming one
     store for a draw that will actually be split.
     `opts.whPick(line)` may return a node to render IN PLACE of that chip — New
     Work Order and both Add-to-Finished-Stock forms hand over a store picker
     for a material that sits in several, so the store is chosen where it is
     read rather than on a separate screen. */
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
        /* Which material this line is. Callers disagree on the key — New Work
           Order sets `id`, the floor's Add-to-Stock sets `code` — and one of
           them may name a material that no longer exists. Without the item
           there is no geometry to weigh with, so such a line keeps the unit
           the caller handed over rather than losing its unit altogether. */
        const li=ENG.item(l.id)||ENG.item(l.code)||null;
        const q=(n,dp)=>li?ENG.qtyText(li,n,dp):ENG.num(n,dp)+" "+(l.uom||"");
        const sfx=(n)=>li?ENG.kgSuffix(li,n):"";
        const plain=(n)=>li?ENG.dispQty(li,n):n;
        host.appendChild(h("div",{class:"flex between aic",
          style:"gap:10px;font-size:13px;padding:6px 0;border-bottom:1px solid var(--line)"+(multi?";padding-left:14px;border-left:2px solid var(--line);margin-left:2px":"")},[
          h("div",{style:"min-width:0"},[
            h("div",{class:"flex aic",style:"gap:8px"},[
              h("span",{style:"font-weight:600",text:l.name}),
              l.code?h("span",{class:"muted mono",style:"font-size:11px",text:l.code}):null
            ]),
            l.spec?h("div",{class:"muted mono",style:"font-size:11px",text:l.spec}):null,
            /* WHERE THIS ONE COMES FROM. A picker where the caller offers
               one; otherwise the split — store by store, with the quantity off
               each — falling back to the plain chip for a caller that only
               knows the store, and to nothing at all for one that knows
               neither, so those forms render exactly as before. */
            (opts.whPick && opts.whPick(l))
              || ((l.sources||[]).length
                    ? h("div",{class:"wo-src-whs"}, whQtyChips(l.sources, li, {done:l.issued}))
                    : (l.wh?whChip(l.wh):null))
          ]),
          h("div",{class:"flex aic",style:"gap:10px;flex:0 0 auto;white-space:nowrap"},[
            h("span",{class:"muted",text:"Need "},[h("b",{class:"mono",style:"color:var(--text)",text:q(l.need,2)+sfx(l.need)})]),
            h("span",{class:"muted",text:"In store "},[h("b",{class:"mono",style:"color:"+(ok?"var(--text)":"var(--danger)"),text:q(have,1)+sfx(have)})]),
            h("span",{html:badge(ok?"ok":"danger",ok?"OK":"Short by "+ENG.num(plain(agg-have),2))})
          ])
        ]));
      });
    });

    /* ---- DOES THIS RECIPE WEIGH? ----------------------------------------
       Material cannot be made on the floor. Coating adds mass and is a line of
       its own; slitting and packing cannot add a gram. So a recipe that issues
       LESS weight than the run produces is not a clever yield — it is a wrong
       figure, and the run will under-issue by exactly the difference.
       It is almost always a GSM: the finished tape and the material it is cut
       from are recorded at different grammages for the same thickness.
       Until the metre figures were restated as kilograms this was invisible —
       "609.76 MTR" and "100 kg" are not numbers anyone can compare. */
    if(opts.outputKg > 0){
      let inKg=0, known=true;
      groups.forEach(g=>(g.lines||[]).forEach(l=>{
        const li=ENG.item(l.id)||ENG.item(l.code);
        const w=li?ENG.kg(li,l.need):null;
        if(w==null) known=false; else inKg+=w;
      }));
      if(known && inKg>0 && inKg < opts.outputKg-0.005){
        host.appendChild(h("div",{class:"qc-note bad",
          style:"font-size:12px;margin-top:10px;line-height:1.55;padding:8px 10px"},[
          h("div",{style:"font-weight:700",text:"⚠ This recipe issues "+ENG.num(inKg,2)
            +" kg to produce "+ENG.num(opts.outputKg,2)+" kg."}),
          h("div",{text:"Material cannot be made on the floor, so one of the figures is wrong — check the GSM on the product and on the material it is cut from. As it stands the run will draw "
            +ENG.num(opts.outputKg-inKg,2)+" kg less than it makes."}),
        ]));
      }
    }
  }

  /* The layer build-up — the recipe as the floor reads it: each layer, the
     materials in it, and how much of each.
     `opts.qtyOf(line)` overrides the printed quantity, so a work order can
     show what THIS run consumes instead of the BOM's per-batch figures;
     `opts.choices` resolves ranged lines to the material actually picked;
     `opts.always` keeps the panel for a single-layer product, which the BOM
     view suppresses (there is no layer story) but a work order still needs;
     `opts.srcOf(line)` returns where a material comes from and HOW MUCH off
     each — [{wh, qty}], a list because a draw one store cannot cover is split
     across several — which a raised work order wants on the job sheet and the
     BOM view has no use for; `opts.issuedOf(line)` says whether that is the
     ledger's record or still a forecast. */
  /* ---- typing into a box that redraws the form around it -------------------
     The "take from stock" quantities re-run the whole calculation on every
     keystroke, which rebuilds the panel and destroys the input being typed
     into. These two keep that usable:
       numish   — strips anything that is not a digit or a point, so a stray
                  character cannot poison the figure;
       keepCaret— notes which of these boxes has focus and where the caret is,
                  runs the rebuild, then puts both back. Without it the field
                  loses focus after a single character. */
  const numish=s=>String(s==null?"":s).replace(/[^\d.]/g,"");
  function keepCaret(fn){
    const a=document.activeElement;
    const id=a&&a.id&&/^net_|^fssrc_/.test(a.id)?a.id:null;
    const pos=id?a.selectionStart:null;
    fn();
    if(!id) return;
    const el=UI.$("#"+id);
    if(!el) return;
    el.focus();
    try{ el.setSelectionRange(pos,pos); }catch(e){ /* not a caret-bearing field */ }
  }

  /* ---- QC on a coated batch ------------------------------------------------
     A job sitting on the coating floor cannot be completed until the batch has
     been measured. `labPending` is worked out server-side (labService), so the
     office, the floor and the lab all read one list rather than three
     calculations that can disagree.
     Returns the outstanding row, or null when nothing is owed. */
  function labOwedBy(w){
    const cur=curStage(w);
    if(!cur || cur.area!=="coating" || cur.status==="Completed") return null;
    const row=(ENG.data.labPending||[]).find(p=>p.woId===w.id);
    if(!row || !row.coating || row.prodComplete) return null;
    return row;
  }

  /* The office's copy of the floor's reading sheet. Same endpoint, same rules —
     the parameters come from the product's entry under Lab Reports → Products
     and the spec limits never leave the server. */
  async function woLabForm(wo){
    let sheet;
    try{ sheet=await DB.production.labSheet(wo.id); }
    catch(e){ toast(e.message||String(e),{type:"danger"}); return; }
    if(!sheet.product){ toast("No lab product is linked to this item",{type:"warn"}); return; }
    if(!(sheet.params||[]).length){ toast("No test parameters are set for this product yet",{type:"warn"}); return; }

    const grid=h("div",{class:"form-grid"});
    sheet.params.forEach(p=>{
      const v=(sheet.prodValues||{})[p.key];
      grid.insertAdjacentHTML("beforeend",
        `<div class="field"><label>${esc(p.label)} <span class="muted" style="font-weight:500">(${esc(p.unit||"")})</span></label>`
        +`<div><input class="input" id="wolv_${esc(p.key)}" type="number" step="any" value="${v==null?"":esc(String(v))}"></div></div>`);
    });
    const remarks=h("div",{class:"form-grid"},[U.field("Remarks",`<input class="input" id="wolv_rem" placeholder="Optional — anything odd about this batch">`,"full")]);
    const saveBtn=h("button",{class:"btn primary",text:"Save reading"});
    const mo=modal({title:"🧪 Lab report — batch "+sheet.batchNo, wide:true,
      sub:(sheet.product.code||"")+" · "+sheet.product.name,
      body:h("div",{},[
        h("div",{class:"muted",style:"font-size:12px;margin-bottom:12px;line-height:1.6",
          text:"Every reading is needed before coating can be completed. Values are graded against this product's TDS spec on save; the lab incharge adds their own measurement to the same certificate after slitting."}),
        grid, remarks,
      ]),
      foot:[h("button",{class:"btn ghost",onclick:()=>mo.close(),text:"Cancel"}), saveBtn]});

    saveBtn.onclick=async()=>{
      const values={}; const missing=[];
      sheet.params.forEach(p=>{ const el=UI.$("#wolv_"+p.key); const raw=el?el.value.trim():"";
        if(raw===""||isNaN(+raw)) missing.push(p.label); else values[p.key]=+raw; });
      if(missing.length){ toast("Still to measure: "+missing.join(", "),{type:"warn"}); return; }
      saveBtn.disabled=true; saveBtn.textContent="Saving…";
      try{
        await DB.production.saveLab(wo.id,{values, remarks:(UI.$("#wolv_rem").value||"").trim()});
        mo.close();
        toast("Lab reading saved for batch "+sheet.batchNo,{type:"ok"});
        await reloadState(); App.go("production");
      }catch(e){
        toast(e.message||String(e),{type:"danger"});
        saveBtn.disabled=false; saveBtn.textContent="Save reading";
      }
    };
  }

  function layerPanel(fg, rawLines, opts){
    opts=opts||{};
    if(!fg || !rawLines) return null;
    const lines=opts.choices
      ? BOMCALC.resolve({lines:rawLines}, opts.choices)
      : BOMCALC.normalize(rawLines);
    if(!lines.length) return null;
    const groups=layerGroups(lines);
    if(groups.length<2 && !opts.always) return null;   // no layer story to tell
    const box=h("div",{class:"card",style:"box-shadow:none;background:var(--panel-2);padding:10px 14px;margin-bottom:12px"});
    box.appendChild(h("div",{class:"muted",style:"font-size:11px;font-weight:700;text-transform:uppercase;margin-bottom:4px",
      text: opts.title || ("≡ Layer build-up · "+groups.length+" layer"+(groups.length===1?"":"s"))}));
    if(opts.note) box.appendChild(h("div",{class:"muted",style:"font-size:11px;margin-bottom:2px",text:opts.note}));
    groups.forEach((g,gi)=>{
      const many=groups.length>1;
      if(many) box.appendChild(h("div",{style:"font-weight:800;font-size:12px;text-transform:uppercase;letter-spacing:.4px;margin:"+(gi?12:6)+"px 0 4px;color:var(--accent)",
        text:g.label||("LAYER "+(gi+1))}));
      g.lines.forEach(l=>{
        const q=opts.qtyOf?opts.qtyOf(l):l.qty;
        const li=l.id?ENG.item(l.id):null;
        const unit=li?ENG.dispUom(li):(l.unit||"");
        const qShown=li?ENG.dispQty(li,q):q;
        // the stores this line comes out of, with what comes off each
        const whs=opts.srcOf
          ? whQtyChips(opts.srcOf(l), li, {done: opts.issuedOf ? opts.issuedOf(l) : false})
          : [];
        box.appendChild(h("div",{class:"flex aic wrap lp-row"+(whs.length?" lp-row-wh":""),style:"gap:8px;padding:3px 0 3px "+(many?"14px":"0")+";font-size:13px;"+(many?"border-left:2px solid var(--line);margin-left:2px":"")},[
          h("span",{style:"font-weight:600",text:matLineName(l)}),
          matLineCode(l)?h("span",{class:"muted mono",style:"font-size:11px",text:matLineCode(l)}):null,
          matLineSpec(l)?h("span",{class:"muted mono",style:"font-size:12px",text:matLineSpec(l)}):null,
          ...whs,
          h("span",{class:"mono lp-qty",style:"font-size:12px;flex:0 0 auto;font-weight:700",
            text:ENG.num(qShown,2)+" "+unit})
        ]));
      });
    });
    return box;
  }

  /* ---- THE STORE PICKER, LENT TO EVERY FORM THAT DRAWS MATERIAL ----------
     A material held in ONE store needs no decision — the row names the store
     and the quantity coming off it. Held in SEVERAL, the store becomes a
     choice: whoever raises the run picks where it draws from, with what each
     store holds shown against it, and that choice travels onto the issue.

     Either way the SPLIT is spelled out underneath — how much comes off each
     shelf — because a draw one store cannot cover is spread across the rest,
     and the storeman is the person who has to walk to them. The figures come
     from drawSharesFor, which mirrors the server's drawPlan, so what is shown
     here is what the ledger will post.

     `store` is the caller's own rid -> warehouse map: the pick is written
     straight into it and the caller sends it to the server as
     materialWarehouses. New Work Order and both Add-to-Finished-Stock forms
     share this one control. */
  function storePicker(store){
    return function whPick(l){
      const rid=l.id;
      if(!rid) return null;
      const choices=whChoicesFor(rid);
      if(choices.length<2) return null;
      const it=ENG.item(rid)||{};
      /* What this run draws of it. A material that appears in two layers is
         drawn once against a shared pile, so the AGGREGATE need is what a
         store has to cover — the same figure the row's own Short badge uses. */
      const need=(l.agg!=null?l.agg:l.need)||0;
      if(store[rid]==null){
        const std=issuingWh(rid,need);
        store[rid]=choices.some(c=>c.wh===std)?std:choices[0].wh;
      }
      const covers=c=>c.qty+1e-6>=need;
      const split=h("div",{class:"wo-src-whs"});
      const short=h("div",{class:"wo-wh-short"});
      const paint=()=>{
        const cur=choices.find(c=>c.wh===store[rid]);
        split.innerHTML=""; short.innerHTML="";
        if(!cur||!(need>0)) return;
        // WHAT COMES OFF EACH SHELF — the answer, whether or not it is split
        whQtyChips(drawSharesFor(rid,need,cur.wh), it).forEach(n=>split.appendChild(n));
        if(covers(cur)) return;
        /* A CHOICE THAT CANNOT COVER THE DRAW IS NO LONGER A STORE DRIVEN
           BELOW ZERO. The issue is spread: this store gives what it has and
           the balance comes off the others, biggest pile first. Only where the
           stores together still fall short does anything go negative, and that
           is said as the different thing it is. */
        const pool=choices.reduce((n,c)=>n+c.qty,0);
        short.appendChild(h("span",{
          text:"⚠ "+whName(cur.wh)+" holds "+ENG.qtyText(it,cur.qty,2)
            +" of the "+ENG.qtyText(it,need,2)+" this run draws."}));
        short.appendChild(h("span",{class:"wo-wh-alt",
          text: pool+1e-6>=need
            ? " The balance of "+ENG.qtyText(it,need-cur.qty,2)+" comes off the stores above."
            : " Every store together holds only "+ENG.qtyText(it,pool,2)
              +" — "+whName(cur.wh)+" carries the "+ENG.qtyText(it,need-pool,2)
              +" still missing and goes below zero."}));
        const better=choices.filter(c=>c.wh!==cur.wh&&covers(c));
        if(better.length) short.appendChild(h("span",{class:"wo-wh-alt",
          text:" ("+better.map(c=>whName(c.wh)).join(" or ")+" could cover the whole run on its own.)"}));
      };
      const sel=h("select",{class:"select wo-wh-pick",title:"Which store this run draws this material from",
        onchange:e=>{ store[rid]=e.target.value; paint(); }},
        choices.map(c=>h("option",{value:c.wh,selected:store[rid]===c.wh,
          // each store says whether it can actually cover this run, not just what it holds
          text:"🏬 "+whName(c.wh)+" · "+ENG.qtyText(it,c.qty,1)+ENG.kgSuffix(it,c.qty)
            +(need>0?(covers(c)?" · covers this run":" · short by "+ENG.qtyText(it,need-c.qty,2)):"")})));
      paint();
      return h("div",{},[
        h("div",{class:"wo-wh-wrap"},[
          h("span",{class:"wo-wh-lbl",text:"Draw from"}), sel,
          h("span",{class:"muted",style:"font-size:10.5px",text:"in "+choices.length+" stores"})]),
        split, short]);
    };
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
    const hid=h("input",{type:"hidden",id,value:init?init.id:"",required:""});   // required: what Enter reads (ui.js)
    const thkHost=h("div");
    const wrap=h("div",{style:"display:contents"},[
      hid,
      h("div",{class:"field full"},[h("label",{text:"Product *"}),
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
    if(w.dispatched) return `<span class="chip" style="color:var(--ok);border-color:var(--ok)" title="${UI.esc((w.dispatchedTo?w.dispatchedTo+(w.dispatchedCustomer?" → "+w.dispatchedCustomer:""):"Dispatched"))}">🚚 Dispatched${w.dispatchedTo?" · "+UI.esc(w.dispatchedTo):""}</span>`;
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
        style:`display:inline-flex;align-items:center;gap:6px;padding:5px 12px;border-radius:999px;font-size:13px;font-weight:600;border:1.5px solid ${c};color:${c};`+(cur?`box-shadow:0 0 0 3px color-mix(in srgb,${c} 20%,transparent)`:``),
        html:`${mark} ${esc(STAGE_LABEL[s.key]||s.name||s.key)}`}));
    });
    if(wo.dispatched) row.appendChild(h("span",{style:"font-weight:700;color:var(--ok);font-size:13px",text:"🚚 Dispatched"}));
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
  // a span of milliseconds as "3h 20m" — the one place durations are worded
  function durMs(ms){
    if(!isFinite(ms)||ms<0) return "—";
    const mins=Math.round(ms/60000), hh=Math.floor(mins/60), mm=mins%60;
    if(mins<1) return "<1m";
    return hh? (hh+"h "+mm+"m") : (mm+"m");
  }
  function durBetween(a,b){
    if(!a||!b||String(a).indexOf("T")<0||String(b).indexOf("T")<0) return "—";
    const ms=new Date(b)-new Date(a); if(isNaN(ms)||ms<0) return "—";
    return durMs(ms);
  }
  // per-stage timing table shown under the "Time Status" tab of a work order
  function stageTimeStatus(wo){
    const rt=wo.route||[];
    const wrap=h("div",{style:"margin-top:4px"});
    // work order creation — the origin of the production timeline
    const createdAt=wo.createdAt||wo.date;
    wrap.appendChild(h("div",{class:"flex between aic",style:"padding:9px 12px;border:1px solid var(--line);border-radius:8px;margin-bottom:14px"},[
      h("div",{},[h("div",{style:"font-weight:700;font-size:13px",text:"🗓 Work Order Created"}), wo.createdBy?h("div",{class:"muted",style:"font-size:11px",text:"by "+wo.createdBy}):null]),
      h("div",{class:"mono",style:"font-size:13px;font-weight:600",text:fmtDT(createdAt)})
    ]));
    if(!rt.length){ wrap.appendChild(h("div",{class:"muted",style:"font-size:12px",text:"No routing — legacy work order (no per-stage timing captured)."})); return wrap; }
    const nowISO=new Date().toISOString();
    const rows=rt.map((s,i)=>{
      const started=s.startedAt, done=s.doneAt;
      let duration;
      if(done) duration=durBetween(started,done);
      else if(s.status==="In Production" && started) duration="⏱ "+durBetween(started,nowISO);
      else duration="—";
      /* A batched order runs the same stages over and over. This run's time is
         only part of the story, so the time banked from earlier batches is
         added in and the total for the stage is what is reported. */
      const prior=+s.priorMs||0;
      let thisMs=0;
      if(done&&started) thisMs=Math.max(0,Date.parse(done)-Date.parse(started));
      else if(s.status==="In Production"&&started) thisMs=Math.max(0,Date.now()-Date.parse(started));
      const runs=(+s.runs||0)+(done?1:0);
      const totalMs=prior+thisMs;
      return { stage:STAGE_LABEL[s.key]||s.name||s.key, status:s.status,
        started:fmtDT(s.firstStartedAt||started), completed:fmtDT(done), duration,
        runs, prior, totalMs,
        total: totalMs>0 ? (prior>0?durMs(totalMs):duration) : "—",
        by:s.doneBy||s.startedBy||"—",
        cur:(i===(wo.stageIdx||0))&&!wo.dispatched&&s.status!=="Completed" };
    });
    const anyRepeat=rows.some(r=>r.runs>1||r.prior>0);
    wrap.appendChild(table(rows,[
      {key:"stage",label:"Stage",cls:"ctr",noSort:true,render:r=>`<span class="cell-main">${esc(r.stage)}</span>${r.cur?' <span class="chip" style="color:var(--info);border-color:var(--info)">current</span>':''}`},
      {key:"status",label:"Status",noSort:true,render:r=>badge(r.status==="Completed"?"ok":r.status==="In Production"?"info":"warn",r.status)},
      {key:"started",label:"Started",noSort:true,render:r=>esc(r.started)},
      {key:"completed",label:"Completed",noSort:true,render:r=>esc(r.completed)},
      {key:"duration",label:anyRepeat?"This batch":"Duration",noSort:true,render:r=>`<span class="mono">${esc(r.duration)}</span>`},
      // only worth a column when the order has actually been run more than once
      ...(anyRepeat?[{key:"total",label:"Total (all batches)",noSort:true,render:r=>
        `<span class="mono strong">${esc(r.total)}</span>`
        +(r.runs>1?`<div class="cell-sub">${r.runs} runs</div>`:"")}]:[]),
      {key:"by",label:"By",noSort:true,render:r=>esc(r.by)},
    ],{empty:"No stages"}));
    // summary: total lead time + dispatch
    const starts=rt.map(s=>s.startedAt).filter(x=>x&&String(x).indexOf("T")>=0).sort();
    const lastDone=wo.dispatchedAt||wo.packedAt||rt.map(s=>s.doneAt).filter(x=>x&&String(x).indexOf("T")>=0).sort().slice(-1)[0];
    const parts=[];
    if(starts[0]&&lastDone) parts.push("Total lead time: "+durBetween(starts[0],lastDone));
    /* On a batched order the useful figure is the time actually spent on the
       machines across every run — the lead time above includes the waiting. */
    if(anyRepeat){
      const worked=rows.reduce((n,r)=>n+(r.totalMs||0),0);
      if(worked>0) parts.push("Time on the machines, all batches: "+durMs(worked));
      const batches=rows.reduce((n,r)=>Math.max(n,r.runs||0),0);
      if(batches>1) parts.push(batches+" production batches");
    }
    /* A run shipped against a sales order is recorded HERE and nowhere else —
       it never became stock, so the ledger has nothing to show for it. Naming
       the order and the customer is what lets a packed job be traced. */
    if(wo.dispatchedAt) parts.push("Dispatched: "+fmtDT(wo.dispatchedAt)
      +((+wo.dispatchedQty)?(" · "+ENG.num(wo.dispatchedQty,2)+" kg"):"")
      +(wo.dispatchedTo?(" · "+wo.dispatchedTo):"")
      +(wo.dispatchedCustomer?(" → "+wo.dispatchedCustomer):"")
      +(wo.dispatchedBy?(" · by "+wo.dispatchedBy):""));
    if(parts.length) wrap.appendChild(h("div",{class:"muted",style:"font-size:12px;margin-top:12px",text:parts.join("    ·    ")}));
    return wrap;
  }

  M.production = { title:"Production", sub:"Work orders & material consumption", render(root, params){
    let tab=App.viewState("tab",()=>(params&&params.tab)||"active");
    let filter=App.viewState("filter",()=>({from:"", to:"", q:"", qRaw:""}));
    root.appendChild(pageHead("Production Control","Each stage consumes its materials and hands the job to the next stage; nothing is booked into store on the way",[
      // the floor has this in its own panel — office/admin get it here too
      h("button",{class:"btn",onclick:()=>finishedStockForm(),html:"➕ Add to Finished Stock"}),
      h("button",{class:"btn primary",onclick:()=>woForm(),html:"＋ New Work Order"})
    ]));

    /* "Partial" is deliberately NOT done: an order still owing quantity stays
       in Active / Released, at 100% for the run that WAS made, until the whole
       ordered quantity has been produced. */
    const isDone=w=>(w.status==="Completed"||w.status==="Dispatched") && !((+w.pendingQty||0)>1e-6);
    const isPending=w=>(+w.pendingQty||0)>1e-6 && !w.dispatched;
    /* The tab lists are read FRESH on every draw — patchWO swaps the row's
       object in ENG.data.workorders, so a list captured at render time would
       keep showing the pre-resume figures. */
    function listFor(){
      const all=ENG.data.workorders;
      if(tab==="active") return all.filter(w=>!isDone(w));
      if(tab==="done") return all.filter(isDone);
      if(tab==="pending") return all.filter(isPending);
      return all;
    }
    const wos=ENG.data.workorders;
    const active=wos.filter(w=>!isDone(w));
    const done=wos.filter(isDone);
    const pendingList=wos.filter(isPending);
    const pendKg=pendingList.reduce((a,w)=>a+(+w.pendingQty||0),0);
    const out30=ENG.dailySeries(30).prod.reduce((a,b)=>a+b,0);
    // five tiles on this board — a slightly tighter minimum keeps one row
    root.appendChild(h("div",{class:"grid kpi-grid",style:"margin-bottom:16px;grid-template-columns:repeat(auto-fit,minmax(196px,1fr))"},[
      kpi({icon:"⚙️",label:"Active Work Orders",value:ENG.num(active.length)}),
      kpi({icon:"⏸",label:"Pending Material",value:ENG.num(pendingList.length),
        delta:pendingList.length?ENG.num(pendKg)+" kg waiting":"nothing waiting",
        deltaType:pendingList.length?"down":"flat",
        onClick:()=>setTab("pending")}),
      kpi({icon:"✅",label:"Completed",value:ENG.num(done.length)}),
      kpi({icon:"📦",label:"Output (30d)",value:ENG.num(out30)+" kg"}),
      kpi({icon:"🏭",label:"Production Lines",value:"4",delta:"2 running",deltaType:"up"}),
    ]));

    const seg=h("div",{class:"seg",style:"margin-bottom:16px"},[
      segBtn("Active / Released","active"),
      segBtn("Pending"+(pendingList.length?" ("+pendingList.length+")":""),"pending"),
      segBtn("Completed","done"), segBtn("All","all")
    ]);
    root.appendChild(seg);
    function setTab(key){ tab=App.setViewState("tab",key); [...seg.children].forEach(c=>c.classList.toggle("on",c.getAttribute("data-tab")===key)); draw(); }
    root.appendChild(h("div",{class:"toolbar"},[
      MW.searchInput("Search WO no., product, code, customer, stage, line…", v=>{filter.qRaw=v;filter.q=v.toLowerCase().trim();draw();}, filter.qRaw),
      MW.dateRange(filter, draw, {label:"Start Date"}),
      h("div",{style:"margin-left:auto"},h("span",{class:"chip",id:"prodCount"}))
    ]));
    const host=h("div"); root.appendChild(host);

    function segBtn(label,key){ const b=h("button",{class:tab===key?"on":"","data-tab":key,text:label,onclick:()=>setTab(key)}); return b; }

    /* The floor calls a job by its number, the office by the product, and a
       supervisor by the line or the stage it is sitting on — one box takes all
       three, plus the family code the shop drawings carry. */
    function woMatch(w){
      if(!filter.q) return true;
      const it=ENG.item(w.itemId)||{};
      // the stage the row SHOWS, not a raw key — "slitting" has to match what
      // the Stage column reads
      const cur=curStage(w)||{};
      const hay=[w.id, it.name, w.itemId, it.typeCode, U.familyCode(it.typeCode,it.thicknessMM),
        STAGE_LABEL[cur.key]||cur.name, w.status, w.line, w.date, w.due,
        // the floor and the office both look a job up by who it is for
        woCustomerName(w)];
      return hay.filter(Boolean).join(" ").toLowerCase().includes(filter.q);
    }

    /* how much of the order is actually MADE — the formula every reader of
       completedQty must use (engine.readyBatches, the dispatch cap): the
       current run only counts once its route is fully Completed. */
    function madeOf(w){
      const routeDone=(w.route||[]).length>0 && (w.route||[]).every(s=>s.status==="Completed");
      return (+w.completedQty||0) + (routeDone ? (+w.runQty||0) : 0);
    }
    function draw(){
      let data = listFor();
      data=data.filter(w=>woMatch(w)&&MW.inDateRange(w.date, filter));
      data=data.slice().sort((a,b)=>a.date<b.date?1:-1);
      const c=UI.$("#prodCount"); if(c) c.textContent=data.length+" work orders";
      host.innerHTML="";
      if(tab==="pending"){ drawPending(data); return; }
      host.appendChild(table(data,[
        {key:"id",label:"WO #",render:r=>`<span class="mono strong">${r.id}</span>`,sort:r=>r.id},
        /* Who it is for sits UNDER the product name rather than in a column of
           its own: a Customer column carries .cell-main, which the table gives a
           150px minimum, and a twelfth column of that width pushed the board
           into a sideways scroll. A job made to stock says nothing extra — the
           line is there to name a client, not to label every other row. */
        {key:"item",label:"Product",render:r=>{
          const nm=(ENG.item(r.itemId)||{}).name||r.itemId, c=woCustomerName(r);
          return `<div class="cell-main">${esc(nm)}</div>`
            +(c?`<div class="cell-sub">for ${esc(c)}</div>`:"");},
          sort:r=>(ENG.item(r.itemId)||{}).name||r.itemId},
        {key:"code",label:"Code",render:r=>{const it=ENG.item(r.itemId)||{};return `<span class="mono muted">${esc(U.familyCode(it.typeCode,it.thicknessMM)||it.typeCode||r.itemId)}</span>`;},sort:r=>r.itemId},
        {key:"thk",label:"Thickness",num:true,render:r=>{const t=(ENG.item(r.itemId)||{}).thicknessMM; return t!=null?`<span class="mono">${ENG.num(t,3)}</span> <span class="muted">mm</span>`:'<span class="muted">—</span>';},sort:r=>(ENG.item(r.itemId)||{}).thicknessMM||0},
        /* On a partial order the ordered quantity alone is misleading — the
           split into made / on the floor / still waiting is the whole point. */
        {key:"qty",label:"Qty",num:true,sort:r=>r.qty,render:r=>{
          const pend=+r.pendingQty||0, doneQ=+r.completedQty||0;
          const head=`<span class="strong">${ENG.num(r.qty)}</span> <span class="muted">kg</span>`;
          if(pend<=0 && doneQ<=0) return head;
          /* stacked, never side by side — the column stays narrow and each
             figure is read on its own line */
          const bits=[];
          if(doneQ>0) bits.push(`${ENG.num(doneQ)} done`);
          if((+r.runQty||0)>0) bits.push(`${ENG.num(r.runQty)} on floor`);
          if(pend>0) bits.push(`<span style="color:var(--danger);font-weight:700">${ENG.num(pend)} pending</span>`);
          return head+bits.map(b=>`<div class="cell-sub">${b}</div>`).join("");
        }},
        {key:"date",label:"Start",render:r=>`<span style="white-space:nowrap">${r.date||"—"}</span>`,sort:r=>r.date||""},
        // the stage stays the stage — the pending warning has its own line below
        {key:"stage",label:"Stage",cls:"ctr",render:r=>stageCell(r),sort:r=>(r.stageIdx||0)},
        {key:"line",label:"Line",render:r=>`<span class="chip">${esc(r.line)}</span>`,sort:r=>r.line},
        {key:"due",label:"Due",render:r=>`<span style="white-space:nowrap">${r.due||"—"}</span>`,sort:r=>r.due},
        // progress + status share one column, stacked one over the other, so
        // the action buttons pull further left and the board fits a single view
        {key:"progress",label:"Progress",render:r=>`<div style="min-width:86px;display:flex;flex-direction:column;gap:6px;align-items:flex-start"><div style="width:100%">${meter(r.progress, r.progress>66?"ok":r.progress>33?"warn":"danger")}<div class="muted" style="font-size:11px;margin-top:3px">${r.progress}%</div></div>${badge((r.status==="Completed"||r.status==="Dispatched")?"ok":r.status==="In Production"||r.status==="In Progress"?"info":"warn",r.status)}</div>`,sort:r=>r.progress},
        {key:"act",label:"",noSort:true,render:r=>woActions(r)},
      ],{onRow:r=>woDetail(r),empty:filter.q?"No work order matches that search":"No work orders",
        /* the whole row goes light red while material is owed, so a pending
           order cannot be mistaken for one that is simply in progress */
        rowClass:r=>((+r.pendingQty||0)>0 ? "wo-pending" : ""),
        /* The warning runs the full width UNDER the row rather than inside the
           Stage cell, which was widening the table and forcing a sideways
           scroll to read it. */
        rowAfter:r=>{
          const pend=+r.pendingQty||0;
          if(pend<=0) return null;
          const madeQ=(+r.completedQty||0)+(+r.runQty||0);
          /* Name the exact material and code it is waiting on — "waiting for
             material" sends people to the store to add the wrong one. */
          const short=(r.shortage||[]).map(s=>`${esc(s.name)} (${esc(s.id)})`).join(", ");
          const sent=+r.dispatchedQty||0;
          return `<div class="wo-pending-note">`
            +`<span class="wo-pending-tag">⏸ PENDING · ${ENG.num(pend)} kg</span>`
            +`<span>${ENG.num(r.qty)} kg ordered</span>`
            +`<span>${ENG.num(madeQ)} kg produced</span>`
            +(sent>0?`<span>🚚 ${ENG.num(sent)} kg dispatched</span>`:"")
            +`<span class="strong">${ENG.num(pend)} kg awaiting raw material</span>`
            +(short?`<span>needs ${short}</span>`:"")
            +`</div>`;
        }}));
    }

    /* ---- the Pending tab: every order still owing quantity, with the three
       figures side by side — ordered, produced, pending — and Resume. ---- */
    function drawPending(data){
      host.appendChild(table(data,[
        {key:"id",label:"WO #",render:r=>`<span class="mono strong">${r.id}</span>`,sort:r=>r.id},
        {key:"item",label:"Product",render:r=>`<div class="cell-main">${esc((ENG.item(r.itemId)||{}).name||r.itemId)}</div>`,sort:r=>(ENG.item(r.itemId)||{}).name||r.itemId},
        {key:"code",label:"Code",render:r=>{const it=ENG.item(r.itemId)||{};return `<span class="mono muted">${esc(U.familyCode(it.typeCode,it.thicknessMM)||it.typeCode||r.itemId)}</span>`;},sort:r=>r.itemId},
        {key:"qty",label:"Ordered",num:true,sort:r=>+r.qty||0,
          render:r=>`<span class="strong">${ENG.num(r.qty)}</span> <span class="muted">kg</span>`},
        {key:"made",label:"Produced",num:true,sort:r=>madeOf(r),render:r=>{
          const made=madeOf(r), run=+r.runQty||0, onFloor=made<(+r.completedQty||0)+run;
          return `<span class="strong">${ENG.num(made)}</span> <span class="muted">kg</span>`
            +(onFloor&&run>0?`<div class="cell-sub">${ENG.num(run)} kg on the floor</div>`:"");
        }},
        {key:"pend",label:"Pending",num:true,sort:r=>+r.pendingQty||0,
          render:r=>`<span class="strong" style="color:var(--danger)">${ENG.num(r.pendingQty)}</span> <span class="muted">kg</span>`},
        {key:"since",label:"Pending Since",render:r=>`<span style="white-space:nowrap">${r.pendingSince||"—"}</span>`,sort:r=>r.pendingSince||""},
        {key:"await",label:"Awaiting Material",render:r=>{
          const s=(r.shortage||[]);
          if(!s.length) return `<span class="muted">store can cover it — resume when ready</span>`;
          return s.map(x=>`<div style="line-height:1.4">${esc(x.name)} <span class="mono muted" style="font-size:11px">${esc(x.id||"")}</span>`
            +` <span class="mono" style="color:var(--danger)">−${ENG.num(ENG.dispQty(ENG.item(x.id),x.short),2)}</span></div>`).join("");
        },noSort:true},
        {key:"status",label:"Status",cls:"ctr",render:r=>badge(r.status==="Partial"?"warn":r.status==="In Production"?"info":"warn",r.status),sort:r=>r.status},
        {key:"act",label:"",noSort:true,render:r=>{
          const wrap=h("div",{style:"display:flex;flex-direction:column;gap:5px;align-items:stretch;min-width:120px"});
          const routeDone=(r.route||[]).length>0 && (r.route||[]).every(s=>s.status==="Completed");
          if(routeDone && canPlan()){
            wrap.appendChild(h("button",{class:"btn sm primary",onclick:e=>{e.stopPropagation();resumeWO(r);},
              text:"▶ Resume "+ENG.num(r.pendingQty)+" kg"}));
          } else if(!routeDone){
            wrap.appendChild(h("span",{class:"muted",style:"font-size:11px;line-height:1.4",
              text:"finish the run on the floor first"}));
          }
          wrap.appendChild(h("button",{class:"btn sm ghost",onclick:e=>{e.stopPropagation();woDetail(r);},text:"View"}));
          return wrap;
        }},
      ],{onRow:r=>woDetail(r),
        empty:filter.q?"No pending order matches that search":"Nothing is pending — every order is fully covered"}));
    }
    draw();
    if(params&&params.openNew){ params.openNew=false; woForm(); }
    if(params&&params.open){ const w=(ENG.data.workorders||[]).find(x=>x.id===params.open); params.open=null; if(w) woDetail(w); }

    function canPlan(){ return ["admin","office"].includes((App.user&&App.user.role)||""); }
    function woActions(r){
      // stack the actions vertically so the column stays narrow (two buttons
      // side by side were the widest cell and forced the board to scroll)
      const wrap=h("div",{style:"display:flex;flex-direction:column;gap:5px;align-items:stretch;min-width:104px"});
      const finished=r.status==="Completed"||r.status==="Dispatched";
      // Stage-determining actions (Start / Finish / Complete all) are for
      // supervisors + admin only. Office plans work orders but does not drive
      // process stages, so it just gets a read-only View.
      const pend=+r.pendingQty||0;
      const routeDone=(r.route||[]).length>0 && (r.route||[]).every(s=>s.status==="Completed");
      /* A pending balance is the office's to release, not the floor's — and
         only once what is already out there has been finished. */
      if(pend>0 && routeDone && !r.dispatched && canPlan()){
        wrap.appendChild(h("button",{class:"btn sm primary",onclick:e=>{e.stopPropagation();resumeWO(r);},
          text:"▶ Resume "+ENG.num(pend)+" kg"}));
        wrap.appendChild(h("button",{class:"btn sm ghost",onclick:e=>{e.stopPropagation();woDetail(r);},text:"View"}));
        return wrap;
      }
      if(!finished && App.isAdmin()){
        const cur=curStage(r);
        const label=(cur&&STAGE_LABEL[cur.key])||"stage";
        /* ONE BUTTON, ONE NEXT STEP — the same sequence the floor sees:
           Start Coating → Enter Lab Report → Complete Coating. The office
           drives stages too, so it cannot be shown a Complete button the
           server is going to refuse. */
        const owes=labOwedBy(r);
        if(cur&&cur.status==="Pending"){
          wrap.appendChild(h("button",{class:"btn sm",onclick:e=>{e.stopPropagation();advanceStage(r,cur);},text:"▶ Start "+label}));
        } else if(owes){
          wrap.appendChild(h("button",{class:"btn sm primary",onclick:e=>{e.stopPropagation();woLabForm(r);},
            title:"Batch "+owes.batchNo+" — "+(owes.missingProd.length||owes.params.length)+" reading(s) to record",
            text:"🧪 Enter Lab Report"}));
        } else {
          wrap.appendChild(h("button",{class:"btn sm",onclick:e=>{e.stopPropagation();advanceStage(r,cur);},text:"✓ Complete "+label}));
        }
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
      // the lines the factory runs, as the New Work Order form offers them
      const LINES=[{v:"",l:"Auto — as per the product's rules"},{v:"RM Production 1",l:"RM Production 1 — Gautam Saw"},{v:"RM Production 2",l:"RM Production 2 — Ganesh"},{v:"Fibre-Glass Line 1",l:"Fibre-Glass Line 1"},{v:"Slitting A",l:"Slitting A"},{v:"Slitting B",l:"Slitting B"}];
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
          /* the line fixes where the job started and what each stage drew, so
             a released order (its stock is issued on release) keeps it */
          started
            ? U.field("Production Line",`<input class="input is-locked" readonly value="${esc(wo.line||"")}">`)
            : U.field("Production Line",U.selectHTML("we_line",LINES,wo.startLine||"")),
          U.field("Due Date",`<input class="input" id="we_due" type="date" value="${wo.due||""}">`),
          U.field("Priority",U.selectHTML("we_prio",[{v:"Normal",l:"Normal"},{v:"High",l:"High"},{v:"Urgent",l:"Urgent"}],wo.priority||"Normal")),
          /* Who it is for drives labelling, not the route, so it stays editable
             right up to dispatch — including being cleared back to a stock run. */
          U.field("Customer",
            U.searchSelect("we_cust", [{v:"",l:"— no customer · made to stock —"}]
              .concat((ENG.data.customers||[]).slice()
                .sort((a,b)=>String(a.name||"").localeCompare(String(b.name||"")))
                .map(c=>({v:c.id,l:c.name}))), wo.customerId||"", "Search customer, or leave blank…"),"full"),
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
          widthMM:UI.$("#we_width").value===""?null:+UI.$("#we_width").value,
          // sent even when empty — that is how a customer is cleared
          customerId:(UI.$("#we_cust")||{}).value||"" };
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
    /* ---- shortage warning -------------------------------------------------
       The order is NOT refused. This states plainly what the store is short
       of, how much can go to the floor today and how much will wait, and asks
       whether to raise it anyway. Nothing is reserved by saying yes — the
       pending balance only takes material when the office resumes it. */
    function shortageConfirm(e, qty){
      /* The CODE is shown under the name on purpose: CP25G and CM25G read
         almost identically but are different mica entirely, and stocking the
         wrong one looks like the order refusing to move. */
      const rows=(e.shortage||[]).map(s=>h("tr",{},[
        h("td",{style:"padding:4px 8px"},[h("div",{text:s.name}),
          h("div",{class:"cell-sub mono",text:s.id||""})]),
        h("td",{class:"num",style:"padding:4px 8px;text-align:right",text:ENG.qtyText(ENG.item(s.id),s.need,2)}),
        h("td",{class:"num",style:"padding:4px 8px;text-align:right",text:ENG.num(ENG.dispQty(ENG.item(s.id),s.have),2)}),
        h("td",{class:"num",style:"padding:4px 8px;text-align:right;color:var(--danger);font-weight:700",
          text:"−"+ENG.num(ENG.dispQty(ENG.item(s.id),s.short),2)}),
      ]));
      const tbl=h("table",{class:"tbl",style:"width:100%;margin:10px 0"});
      tbl.appendChild(h("thead",{},h("tr",{},["Material","Required","In store","Short"].map((t,i)=>
        h("th",{style:"font-size:11px;padding:4px 8px;"+(i?"text-align:right":"")  ,text:t})))));
      tbl.appendChild(h("tbody",{},rows));
      const body=h("div",{},[
        h("div",{style:"font-weight:700;margin-bottom:6px",text:"The store cannot cover this order in full."}),
        h("div",{class:"muted",style:"font-size:13px;line-height:1.6"},
          `Of ${ENG.num(qty)} kg, ${ENG.num(e.canMake||0)} kg can be made now and `
          +`${ENG.num(e.pendingQty||0)} kg will be held as pending until the material arrives.`),
        tbl,
        h("div",{class:"muted",style:"font-size:12px;line-height:1.6"},
          "The pending quantity reserves nothing. Material that arrives stays free for any order "
          +"until somebody in the office resumes this one, which issues it there and then."),
      ]);
      return new Promise(resolve=>{
        const mo2=modal({title:"⚠ Shortage of raw material", sub:"Raise the order anyway?", wide:true, body,
          foot:[h("button",{class:"btn ghost",onclick:()=>{mo2.close();resolve(false);},text:"Cancel"}),
            h("button",{class:"btn primary",onclick:()=>{mo2.close();resolve(true);},
              html:"Create with "+ENG.num(e.pendingQty||0)+" kg pending"})]});
      });
    }

    /* ---- put a pending balance back on the floor --------------------------
       The dialog runs the SAME stock-availability check the New Work Order
       form runs — the recipe expanded for the release quantity, each material's
       need against what the store holds, the issuing warehouse named — live,
       as the quantity is typed. The server re-checks atomically on release
       (pending material is never reserved, so the truth is decided there). */
    async function resumeWO(wo){
      const pend=+wo.pendingQty||0;
      if(!(pend>0)) return;
      const it=ENG.item(wo.itemId)||{};
      const made=(+wo.completedQty||0)+(((wo.route||[]).length>0&&(wo.route||[]).every(s=>s.status==="Completed"))?(+wo.runQty||0):0);
      const sent=+wo.dispatchedQty||0;
      const bom=ENG.data.boms[wo.itemId];

      const stat=(lab,val,color)=>h("div",{style:"flex:1;min-width:110px;background:var(--panel-2);border:1px solid var(--line);border-radius:10px;padding:10px 12px"},[
        h("div",{class:"muted",style:"font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em",text:lab}),
        h("div",{class:"mono",style:"font-size:17px;font-weight:800;margin-top:2px"+(color?";color:"+color:""),text:val}),
      ]);
      const inp=h("input",{class:"input",id:"rs_qty",type:"number",min:"0",step:"any",
        value:String(pend),style:"max-width:180px"});
      const matHost=h("div");
      const releaseBtn=h("button",{class:"btn primary",text:"▶ Release to the floor",onclick:doRelease});

      const body=h("div",{},[
        h("div",{style:"font-weight:700;margin-bottom:2px",text:(it.name||wo.itemId)}),
        h("div",{class:"muted mono",style:"font-size:11px;margin-bottom:12px",text:U.familyCode(it.typeCode,it.thicknessMM)||it.typeCode||""}),
        h("div",{class:"flex wrap",style:"gap:10px;margin-bottom:14px"},[
          stat("Ordered",ENG.num(wo.qty)+" kg",null),
          stat("Produced",ENG.num(made)+" kg","var(--ok)"),
          sent>0?stat("Dispatched",ENG.num(sent)+" kg",null):null,
          stat("Pending",ENG.num(pend)+" kg","var(--danger)"),
        ]),
        h("div",{class:"field"},[h("label",{text:"Release now (kg)"}),h("div",{},inp)]),
        h("div",{class:"muted",style:"font-size:12px;margin-top:6px;line-height:1.6"},
          "Release the whole balance, or just the batch to run now — the rest stays pending and can be "
          +"resumed again later. Raw material is issued from the store the moment it is released."),
        matHost,
      ]);

      function recalcResume(){
        matHost.innerHTML="";
        releaseBtn.disabled=true;
        const q=+inp.value||0;
        if(!(q>0)) return;
        if(q>pend+1e-6){
          matHost.appendChild(h("div",{style:"margin-top:10px;padding:9px 12px;border:1.5px solid var(--warn);border-radius:8px;color:var(--warn);font-size:13px;font-weight:600",
            text:"Only "+ENG.num(pend)+" kg is pending on this order."}));
          return;
        }
        if(!bom){
          matHost.appendChild(h("div",{class:"muted",style:"font-size:12px;margin-top:12px",
            text:"No recipe on file for this product — there is no material list to check."}));
          releaseBtn.disabled=false;
          return;
        }
        /* the same construction as the New Work Order form: the recipe
           resolved with THIS order's material choices, expanded per kg of
           output, aggregated where one material sits in two layers */
        const resolved=BOMCALC.resolve(bom, wo.materialChoices||{});
        const cc=BOMCALC.compute({lines:resolved}, BOMCALC.metaFromItem(it));
        const perOf=l=>cc.fgKgPerBatch? l.qty/cc.fgKgPerBatch : l.qty;
        const needBy={};
        resolved.forEach(l=>{ if(l.id) needBy[l.id]=(needBy[l.id]||0)+perOf(l)*q/bom.yield; });
        materialsList(matHost, layerGroups(resolved).map(grp=>({
          label: grp.label,
          lines: grp.lines.map(l=>{
            const rid=l.id, r=rid?(ENG.item(rid)||{}):{};
            return { id: rid, name: matLineName(l), code: matLineCode(l), spec: matLineSpec(l),
              need: perOf(l)*q/bom.yield,
              have: rid?(ENG.stock(rid).onHand||0):0,
              agg: rid?needBy[rid]:undefined,
              // where the balance being released will actually be drawn from
              sources: rid?drawSharesFor(rid, perOf(l)*q/bom.yield, (wo.materialWarehouses||{})[rid]):[],
              uom: r.uom||l.unit||"" };
          }),
        })), {outputKg:q, title:"Stock availability — the same check as a new work order"});
        const noneAtAll=Object.entries(needBy)
          .filter(([rid,n])=>n>1e-9 && (ENG.stock(rid).onHand||0)<=1e-9)
          .map(([rid])=>{const r=ENG.item(rid)||{};return r.id?U.matDisplay(r):rid;});
        const short=Object.entries(needBy)
          .filter(([rid,n])=>((ENG.stock(rid).onHand||0)+1e-6)<n)
          .map(([rid])=>{const r=ENG.item(rid)||{};return r.id?U.matDisplay(r):rid;});
        if(noneAtAll.length){
          matHost.appendChild(h("div",{style:"margin-top:10px;padding:9px 12px;border:1.5px solid var(--danger);border-radius:8px;color:var(--danger);font-size:13px;font-weight:600"},[
            h("div",{text:"⛔ The store has NONE of: "+noneAtAll.join(", ")}),
            h("div",{style:"font-weight:500;margin-top:3px;font-size:12px",
              text:"Nothing can be released until that material is received — raise a purchase order first."}),
          ]));
          return;
        }
        if(short.length){
          matHost.appendChild(h("div",{style:"margin-top:10px;padding:9px 12px;border:1.5px solid var(--warn);border-radius:8px;color:var(--warn);font-size:13px;font-weight:600"},[
            h("div",{text:"⚠ Short of: "+short.join(", ")}),
            h("div",{style:"font-weight:500;margin-top:3px;font-size:12px",
              text:"What the store covers goes to the floor now; the balance stays pending until the material arrives."}),
          ]));
        }
        releaseBtn.disabled=false;
      }

      async function doRelease(){
        const q=+inp.value;
        if(!(q>0)){ toast("Enter a quantity to release",{type:"warn"}); return; }
        if(q>pend+1e-6){ toast(`Only ${ENG.num(pend)} kg is pending`,{type:"warn"}); return; }
        releaseBtn.disabled=true;
        try{
          const fresh=await DB.production.resume(wo.id,q);
          mo.close();
          patchWO(fresh); draw();
          const left=+fresh.pendingQty||0;
          toast(left>0
            ? `${wo.id} — ${ENG.num(fresh.runQty)} kg released, ${ENG.num(left)} kg still pending`
            : `${wo.id} resumed — ${ENG.num(fresh.runQty)} kg released, nothing left pending`,
            {type:left>0?"warn":"ok",title:"Back on the floor"});
        }catch(e){
          releaseBtn.disabled=false;
          if(e.status===409 && e.shortage){
            toast(`The store still has nothing this job can be made from — ${ENG.num(pend)} kg stays pending`,
              {type:"warn",title:"No material yet"});
            return;
          }
          toast("Resume failed: "+e.message,{type:"danger"});
        }
      }

      const mo=modal({title:"▶ Resume "+wo.id, sub:"Put the pending quantity back on the floor", wide:true, body,
        foot:[h("button",{class:"btn ghost",onclick:()=>mo.close(),text:"Cancel"}), releaseBtn]});
      inp.addEventListener("input",recalcResume);
      recalcResume();
    }

    /* A stage action used to be followed by a full reload of the entire
       dataset — 448 KB, re-indexed and re-alerted — before ANYTHING appeared
       on screen. The server already hands back the updated work order, so the
       row is patched and redrawn at once and nothing else is fetched.
       Stock and movements, which this board does not show, are picked up by
       the 15-second poll that is already running (App.startAutoRefresh).
       Timings go to the browser console so a slow click can be pinned to a
       step instead of guessed at — open DevTools and look for "[prod]". */
    const nowMs=()=>{ try{ return performance.now(); }catch(e){ return Date.now(); } };
    const perf=(label,t0)=>{ try{ console.log("[prod] "+label+": "+Math.round(nowMs()-t0)+" ms"); }catch(e){} };
    function patchWO(fresh){
      if(!fresh || !fresh.id) return;
      const list = ENG.data.workorders || [];
      const i = list.findIndex(w => w.id === fresh.id);
      if(i >= 0) list[i] = Object.assign({}, list[i], fresh);
    }
    async function advanceStage(wo, cur){
      if(!cur) return;
      const action = cur.status==="Pending" ? "start" : "complete";
      const t0=nowMs();
      try{
        const fresh = await DB.production.advance(wo.id, action);
        perf("advance request", t0);
        const t1=nowMs();
        patchWO(fresh); draw();
        perf("redraw", t1); perf("total", t0);
        toast(`${wo.id}: ${STAGE_LABEL[cur.key]||cur.key} ${action==="start"?"started":"completed"}`,{type:"ok"});
      }
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
      const t0=nowMs();
      try{
        // one request runs every remaining stage — this used to be a POST per
        // stage, so six round trips before anything appeared on screen
        const fresh = await DB.production.advanceAll(wo.id);
        perf("complete-all request", t0);
        const t1=nowMs();
        patchWO(fresh); draw();
        perf("redraw", t1); perf("total", t0);
        toast(`${wo.id} completed — ${ENG.num(wo.qty)} kg of ${it?it.name:wo.itemId} added to finished goods`,{type:"ok",title:"Production posted"});
      }catch(e){ toast("Complete failed: "+e.message,{type:"danger"}); }
    }

    function woDetail(wo){
      const it=ENG.item(wo.itemId); const bom=ENG.data.boms[wo.itemId];

      /* ---- WHAT THIS JOB DRAWS FROM THE STORE -----------------------------
         The same list New Work Order showed when the job was raised, sized the
         same way — because it is the same calculation, run over what the order
         actually recorded. The old table disagreed with the form the planner
         filled in on two counts:
           • it costed the WHOLE ordered quantity. A run part-served from
             finished or half-made stock only draws raw material for the part
             being MADE, which is what wo.plan stores and what the server
             issues (stageService.computeStagePlan sizes on net.makeQty).
           • it read the BOM raw, ignoring the ranged-material picks saved on
             the order — so it could name a different material than the one
             that will be issued.
         Both are read off the work order here, so the detail, the creation
         form and the movements can no longer tell three different stories. */
      const net = wo.plan || null;
      const makeQty = net && net.makeQty != null ? +net.makeQty : (+wo.qty || 0);
      const resolved = bom ? BOMCALC.resolve(bom, wo.materialChoices || {}) : [];
      const cc = bom ? BOMCALC.compute({lines:resolved}, BOMCALC.metaFromItem(it)) : null;
      const perOf = l => (cc && cc.fgKgPerBatch) ? l.qty/cc.fgKgPerBatch : l.qty;
      const needOf = l => bom ? perOf(l)*makeQty/bom.yield : 0;
      const needBy = {};   // a fabric can sit in two layers — the store is shared
      resolved.forEach(l=>{ if(l.id) needBy[l.id]=(needBy[l.id]||0)+needOf(l); });

      /* One list, in the layer build-up the floor already reads — the recipe
         with the quantity THIS run consumes, rather than the BOM's per-batch
         figures, and each line naming the store it leaves. */
      const uomIt=ENG.dispUom(it)||"kg";
      const fgQty=+(net&&net.fgQty)||0, wipQty=+(net&&net.wipQty)||0;
      const took=[];
      if(fgQty>0.001) took.push(ENG.num(fgQty,2)+" "+uomIt+" from finished stock");
      if(wipQty>0.001) took.push(ENG.num(wipQty,2)+" "+uomIt+" from half-made stock");
      const note = took.length
        ? "For the "+ENG.num(makeQty,2)+" "+uomIt+" being made — "+took.join(" and ")+" needs no raw material."
        : "For the "+ENG.num(makeQty,2)+" "+uomIt+" this order produces.";
      /* WHERE THIS ORDER TAKES EACH MATERIAL FROM, AND HOW MUCH OFF EACH
         SHELF. Naming the store was only half of it: an issue is split across
         stores whenever one cannot cover the draw, so the job sheet the office
         reads — and hands the floor — says how much comes out of each.
         The issues POSTED against the work order are the record and are read
         first, each store with what it actually gave. A balance not yet issued
         is forecast by drawSharesFor, which mirrors the server's own drawPlan,
         led by the store the office chose when it raised the order. */
      const drawn = drawnWhFor(wo.id);
      const chosenWh = (wo.materialWarehouses)||{};
      const srcOf = l => {
        const id=l&&l.id; if(!id) return [];
        const done=drawn[id];
        if(done && done.length) return done;
        return drawSharesFor(id, needOf(l), chosenWh[id]);
      };
      const matHost = bom
        ? (layerPanel(it, bom.lines, { choices: wo.materialChoices || {}, qtyOf: needOf,
            srcOf, issuedOf: l => !!(l&&l.id&&(drawn[l.id]||[]).length),
            note, always: true, title: "Materials for this order" })
           || h("div",{class:"muted",style:"font-size:12px",text:"No materials on this recipe"}))
        : h("div",{class:"muted",style:"font-size:12px",text:"No BOM for this product"});

      /* ---- THE STOCK THIS ORDER TOOK OFF THE SHELF -------------------------
         The finished and half-made rolls the planner netted the order against
         were only ever a sentence here; which roll, how much of it, and which
         store it came out of was visible while raising the order and then lost.
         The floor is being sent to fetch it, so the job sheet says so. */
      const drawRow=(icon,label,dest,qty,sources)=>{
        const list=(sources||[]).filter(s=>(+s.qty||0)>0.001);
        return h("div",{style:"padding:7px 0;border-bottom:1px solid var(--line)"},[
          h("div",{class:"flex between aic",style:"gap:12px;font-size:13px"},[
            h("span",{text:icon+" "+label}),
            h("span",{class:"mono",style:"font-weight:700;flex:0 0 auto",text:ENG.num(qty,2)+" "+uomIt}),
          ]),
          h("div",{class:"muted",style:"font-size:11px;margin-top:1px",text:dest}),
          ...list.map(s=>h("div",{class:"flex aic wrap wo-src",style:"gap:8px;margin-top:3px;font-size:12px"},[
            h("span",{class:"wo-src-nm",text:s.name||s.id}),
            h("span",{class:"mono muted",text:ENG.num(s.qty,2)+" "+uomIt}),
            ...whQtyChips(
              (drawn[s.id]||[]).length ? drawn[s.id] : drawSharesFor(s.id, s.qty, chosenWh[s.id]),
              ENG.item(s.id), {done: !!(drawn[s.id]||[]).length}),
          ])),
        ]);
      };
      const stockPanel = (fgQty>0.001 || wipQty>0.001)
        ? h("div",{class:"card",style:"box-shadow:none;background:var(--panel-2);padding:10px 14px;margin-bottom:12px"},[
            h("div",{class:"muted",style:"font-size:11px;font-weight:700;text-transform:uppercase;margin-bottom:2px",
              text:"⇥ Taken from stock for this order"}),
            fgQty>0.001? drawRow("📦","Finished stock","Goes straight to packing — no production",fgQty,net&&net.fgSources):null,
            wipQty>0.001? drawRow("🧵","Half-made stock","Joins the run at slitting — skips coating",wipQty,net&&net.wipSources):null,
          ].filter(Boolean))
        : null;
      // ---- Details pane ----
      const detailsPane=h("div",{},[
        MW.dl([["Product",it.name],["Code",U.familyCode(it.typeCode,it.thicknessMM)||it.typeCode||wo.itemId],
          ["Customer", woCustomerName(wo)||'<span class="muted">To stock — no customer named</span>'],
          ...(it.thicknessMM!=null?[["Thickness",it.thicknessMM+" mm"]]:[]),
          ...(wo.widthMM?[["Tape Width",wo.widthMM+" mm"]]:[]),
          ...(it.thicknessMM!=null&&wo.widthMM?[["Size",it.thicknessMM+" × "+wo.widthMM+" mm"]]:[]),
          ["Ordered",ENG.num(wo.qty)+" kg"],
          /* On a partial order the ordered figure alone says nothing about
             where the job actually stands — what has been made and what is
             still waiting on material belong beside it. */
          ...((+wo.pendingQty||0)>0?[
            ["Produced",`<span class="strong">${ENG.num((+wo.completedQty||0)+(+wo.runQty||0))}</span> kg`],
            ["Pending",`<span class="strong" style="color:var(--danger)">${ENG.num(wo.pendingQty)}</span> kg awaiting material`],
          ]:[]),
          ["Line",wo.line],
          /* The coated jumbo is never booked into a store — so the store the
             coating floor named as it closed the stage is the only record of
             where the roll physically is. The office reads the same fact the
             slitting board is sent to. */
          ...(coatedRollAt(wo)?[["Coated roll at","🏬 "+esc(whName(coatedRollAt(wo)))]]:[]),
          ["Status",badge(wo.status==="Completed"||wo.status==="Dispatched"?"ok":wo.status==="Partial"?"danger":"info",wo.status)],
          ["Start",wo.date],["Due",wo.due],["Yield",bom?(bom.yield*100).toFixed(0)+"%":"—"],["Progress",wo.progress+"%"]]),
        stageTimeline(wo),
        h("div",{style:"margin-top:14px"},[stockPanel,matHost].filter(Boolean)),
      ].filter(Boolean));
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
      /* Nothing goes into a store unmeasured — the readings for this batch are
         taken here, and the server refuses the booking without them. The
         parameters come from the product's entry under Lab Reports → Products;
         the limits stay on the server, so a reading cannot be nudged until it
         passes. */
      const labHost=h("div",{style:"grid-column:1/-1"});
      let labParams=[];          // what this product is tested on
      let labFor=null;           // the item the sheet was fetched for
      /* Sourcing part of a run from stock already on the shelf is an ADMIN
         control — the floor books what it made, it does not decide what the
         run is built from. */
      const canSource=((App.user||{}).role==="admin");
      // *Wanted = the number in play; *Typed = the raw string being typed, kept
      // so a redraw never overwrites a half-entered figure (null = untouched)
      let fsFgWanted=0, fsWipWanted=0, fsFgTyped=null, fsWipTyped=null;
      let fsChoices={};   // ranged BOM line index -> the stock item chosen
      let fsShort=[];     // materials short of stock — blocks the booking
      /* WHICH STORE EACH MATERIAL COMES OUT OF — the same control a work order
         has. Booking production deducts exactly as a work order's stage does,
         so it earns the same say over where the stock is taken from: the pick
         travels to the server as materialWarehouses and leads the draw there.
         Empty means every material sits in one store and there was nothing to
         choose. */
      const fsWhs={};
      const fsWhPick=storePicker(fsWhs);
      const body=h("div",{class:"form-grid"},[
        U.field("Category",U.selectHTML("fs_cat",[{v:"FG",l:"Finished Goods"},{v:"WIP",l:"Work in Process"}],"FG")),
        pickHost,
        gsmField,
        U.field("Quantity produced *",`<input class="input" id="fs_qty" type="number" min="0" step="any" placeholder="0">`),
        uomField,
        tapeField,
        U.field("Store it in",U.selectHTML("fs_wh",whs.map(w=>({v:w.id,l:w.name+(w.type?" · "+w.type:"")})),fgStore)),
        U.field("Batch / lot no",`<input class="input" id="fs_batch" placeholder="e.g. 0042"><div class="muted" style="font-size:11px;margin-top:3px">The lab report is filed against this number</div>`),
        convHint,
        labHost,
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
      /* what a roll IS — half-made stock is only ever the COATED JUMBO */
      const wipStage=()=>"Coated Jumbo Roll";
      const prodOf=i=>{
        if(i.cat!=="WIP") return i.productName||i.name||i.id;
        const p=parentOf(i);
        return p.productName||p.name
          ||String(i.name||i.id).replace(/\s*—\s*Coated Jumbo\s*\(WIP\)\s*$/i,"");
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
        const hid=h("input",{type:"hidden",id:"fs_item",value:"",required:""});   // required: what Enter reads (ui.js)
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
        drawLab(it.id);
        calc();
      }

      /* the QC block: one field per parameter the Products master states a
         limit for. Asked of the server so a half-made roll picks up its
         PARENT's spec, and so no limit is ever sent to the browser. */
      async function drawLab(itemId){
        if(!itemId || itemId===labFor) return;
        labFor=itemId; labParams=[];
        labHost.innerHTML="";
        let sheet=null;
        try{ sheet=await DB.production.finishedLabSheet(itemId); }
        catch(e){ labHost.appendChild(h("div",{class:"muted",style:"font-size:12px",text:"Could not load the test parameters — "+(e.message||e)})); return; }
        if(labFor!==itemId) return;                       // the picker moved on
        if(!sheet || !sheet.required){
          labHost.appendChild(h("div",{class:"muted",style:"font-size:12px;padding:8px 0",
            text:"No lab parameters are set for this product — nothing to measure before booking."}));
          return;
        }
        labParams=sheet.params||[];
        labHost.appendChild(h("div",{class:"muted",style:"font-size:11px;font-weight:700;text-transform:uppercase;margin:6px 0 2px",
          text:"🧪 Lab report — required before this stock can be booked"}));
        labHost.appendChild(h("div",{class:"muted",style:"font-size:11px;margin-bottom:8px",
          text:"Graded against "+((sheet.product||{}).code||"the product")+"'s spec on submit. The lab incharge adds their own reading to the same certificate later."}));
        const grid=h("div",{class:"form-grid",style:"margin:0"});
        labParams.forEach(p=>{
          grid.insertAdjacentHTML("beforeend",
            `<div class="field"><label>${esc(p.label)} <span class="muted" style="font-weight:500">(${esc(p.unit||"")})</span></label><div><input class="input" id="fslv_${esc(p.key)}" type="number" step="any"></div></div>`);
        });
        labHost.appendChild(grid);
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
        // the redraw is what the stock boxes trigger on every keystroke —
        // keep the caret in whichever one is being typed into
        keepCaret(drawMaterials);
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
        /* Same three typing fixes as New Work Order's panel: the box keeps
           what was TYPED while it has focus (so a capped figure never
           overwrites a half-typed number), it is a text field with a decimal
           keypad (a number field rejects ENG.num's thousands separator), and
           the caret is restored after the redraw each keystroke triggers. */
        const row=(id,icon,label,typed,drawn,max,onInput)=>{
          const differs=typed!=null && Math.abs((+typed||0)-drawn)>0.005;
          return h("div",{class:"flex between aic",
              style:"gap:12px;font-size:13px;padding:7px 0;border-bottom:1px solid var(--line)"},[
            h("div",{style:"min-width:0"},[h("div",{text:icon+" "+label}),
              h("div",{class:"muted",style:"font-size:11px",
                text:ENG.num(max,2)+" "+(uom||"")+" available"+(differs?"  ·  taking "+ENG.num(drawn,2):"")})]),
            h("input",{class:"input",id:id,type:"text",inputmode:"decimal",autocomplete:"off",
              value: typed!=null? typed : String(Math.round(drawn*100)/100),
              style:"width:110px;text-align:right;flex:0 0 auto",oninput:e=>onInput(e.target.value)}),
          ]);
        };
        srcHost.appendChild(h("div",{style:"margin:12px 0;padding:10px 12px;border:1.5px solid var(--ok);border-radius:10px"},[
          h("div",{class:"muted",style:"font-size:11px;font-weight:700;text-transform:uppercase;margin-bottom:4px",
            text:"Build from stock — the rest is made from raw materials"}),
          s.fgAvail>0? row("fssrc_fg","📦","Finished stock",fsFgTyped,fgQty,s.fgAvail,
            v=>{ const c=numish(v); fsFgTyped=c===""?null:c; fsFgWanted=+c||0; calc(); }):null,
          s.wipAvail>0? row("fssrc_wip","🧵","Half-made stock",fsWipTyped,wipQty,s.wipAvail,
            v=>{ const c=numish(v); fsWipTyped=c===""?null:c; fsWipWanted=+c||0; calc(); }):null,
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
        optionalPicker(matHost, bom, fsChoices, qty, drawMaterials);
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
                text:(c.item.id?U.matDisplay(c.item):c.id)+" · "+ENG.qtyText(c.item,c.have,1)+ENG.kgSuffix(c.item,c.have)+" in store"})));
            matHost.appendChild(h("div",{style:"margin-bottom:8px"},[
              h("div",{class:"muted",style:"font-size:12px;margin-bottom:3px",
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
            return { id: rid, name: matLineName(l), code: matLineCode(l), spec: matLineSpec(l),
              need: perOf(l)*qty/bom.yield,
              have: rid?(ENG.stock(rid).onHand||0):0,
              agg: rid?needBy[rid]:undefined,
              // one store, and how much off it; several, and the picker says
              sources: rid?drawSharesFor(rid, perOf(l)*qty/bom.yield, fsWhs[rid]):[],
              uom: r.uom||l.unit||"" };
          }),
        })), {title:"Raw materials to be deducted from store", outputKg:ENG.kg(owner,qty),
          whPick: fsWhPick});

        /* ---- a short material blocks the booking, exactly as it blocks a
           work order: stock cannot be issued that is not there ---- */
        fsShort=Object.entries(needBy)
          .filter(([rid,n])=>((ENG.stock(rid).onHand||0)+1e-6)<n)
          .map(([rid])=>{const r=ENG.item(rid)||{};return r.id?U.matDisplay(r):rid;});
        if(qty>0 && fsShort.length){
          matHost.appendChild(h("div",{style:"margin-top:10px;padding:9px 12px;border:1.5px solid var(--danger);border-radius:8px;color:var(--danger);font-size:13px;font-weight:600",
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

      const batchNow=()=>((UI.$("#fs_batch")||{}).value||"").trim();
      const labValuesNow=()=>{ const o={};
        labParams.forEach(p=>{ const e=UI.$("#fslv_"+p.key); const v=e?e.value.trim():"";
          if(v!==""&&!isNaN(+v)) o[p.key]=+v; });
        return o; };

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
        /* the batch has to be named and measured before it can go into a store.
           Checked here so the floor is told what is missing rather than being
           bounced by the server; the server refuses it either way. */
        if(labParams.length){
          if(!batchNow()){ toast("Enter the batch / lot no — the lab report is filed against it",{type:"warn"}); return; }
          const miss=labParams.filter(p=>{const e=UI.$("#fslv_"+p.key); const v=e?e.value.trim():"";
            return v===""||isNaN(+v);}).map(p=>p.label);
          if(miss.length){ toast("Enter every lab reading first — missing: "+miss.join(", "),
            {type:"warn",title:"Lab report required"}); return; }
        }
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
            // the batch this run is booked as, and its measured values — the
            // server refuses the booking without a complete set
            labParams.length?{refNo:batchNow(), labValues:labValuesNow()}:{},
            // which material was picked for each ranged BOM line — so the issue
            // posts the material actually chosen, exactly as a work order does
            Object.keys(fsChoices).length?{materialChoices:fsChoices}:{},
            /* and which STORE each of them comes out of. Only the ones that
               were actually a choice: a material sitting in one store has none,
               and freezing its store here would stop the standing rule
               following the stock if it moves before this is saved. */
            (function(){
              const picked={};
              Object.keys(fsWhs).forEach(rid=>{ if(whChoicesFor(rid).length>1) picked[rid]=fsWhs[rid]; });
              return Object.keys(picked).length?{materialWarehouses:picked}:{};
            })(),
            // admin-only: how much of this run comes off the shelf instead of
            // being made from the recipe (the server enforces the role too)
            canSource?{fgQty:fsFgWanted, wipQty:fsWipWanted}:{}));
          mo.close();
          const used=(r&&r.consumed||[]).length;
          /* A reading outside its limits books the stock all the same, and is
             told apart from a good one NOWHERE here (ruled 2026-08-27): the
             same "booked" message either way. The verdict lives on the batch's
             certificate, reachable from the ledger row's details. */
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
      /* The number this order WILL get, worked out exactly the way the server
         works it out (highest existing number + 1, four digits) and shown in
         the dialog's title, so the office can write it on the job sheet while
         the form is still open. The server still assigns the real one on
         Create; the toast names it. */
      const woNo=(()=>{ let max=0; (ENG.data.workorders||[]).forEach(w=>{ const m=/(\d+)/.exec(w.id||""); if(m) max=Math.max(max,+m[1]); });
        return "WO-"+String(max+1).padStart(4,"0"); })();
      /* WHO THE RUN IS FOR. Optional — a great many runs are made to stock —
         but naming it here is what puts the client's name on the slitting
         floor's job card and on the label, instead of the guess the supervisor
         view otherwise falls back to (the first open order wanting the same
         product, which is very often somebody else). */
      const custs=(ENG.data.customers||[]).slice().sort((a,b)=>String(a.name||"").localeCompare(String(b.name||"")));
      const body=h("div",{class:"form-grid"},[
        fgPicker("w_item", fgs, fgs[0]&&fgs[0].id),
        U.field("Quantity *",`<div class="flex" style="gap:6px"><input class="input" id="w_qty" type="number" min="0" value="100" style="flex:1"><select class="select" id="w_unit" style="width:92px" title="Enter the run size in kilograms or square metres"><option value="KG">kg</option><option value="SQM">sqm</option></select></div><div class="muted" id="w_conv" style="font-size:11px;margin-top:3px"></div>`),
        /* Width is a per-ORDER parameter, not a product one: the same tape is
           slit to whatever width the customer ordered, so it is captured on the
           run and travels with the batch onto the invoice. */
        /* Full width, and on its own row. fgPicker lays down Product across
           both columns and Thickness in the first, so a half-width customer box
           landed beside Thickness — an odd pair, and its hint line made the two
           different heights. Client names are long; give it the room. */
        U.field("Customer",
          U.searchSelect("w_cust", [{v:"",l:"— no customer · made to stock —"}]
            .concat(custs.map(c=>({v:c.id,l:c.name}))), "", "Search customer, or leave blank…")
          +`<div class="muted" style="font-size:11px;margin-top:4px">Optional — shown on the job card, the label and the production board</div>`,"full"),
        U.field("Tape Width (mm)",`<input class="input" id="w_width" type="number" min="0" step="0.5" placeholder="e.g. 25"><div class="muted" id="w_wnote" style="font-size:11px;margin-top:3px"></div>`),
        /* The width of the ROLL being fed is not asked for. It is a property of
           the material the store issues, not a decision the office makes when
           the order is raised, and the two widths sitting side by side were
           read as one another. Only the TAPE width — what the customer ordered
           — is captured here. */
        /* WHERE THE JOB STARTS. Left on Auto, the product's standing rules
           decide (who makes that family); picked by hand, the route starts on
           that line — the other RM floor, the fibre-glass line, or straight to
           slitting when the material was bought in this time. The pick is the
           office's and is never overwritten by a recalculation. */
        U.field("Production Line",U.selectHTML("w_line",[{v:"",l:"Auto — as per the product's rules"},{v:"RM Production 1",l:"RM Production 1 — Gautam Saw"},{v:"RM Production 2",l:"RM Production 2 — Ganesh"},{v:"Fibre-Glass Line 1",l:"Fibre-Glass Line 1"},{v:"Slitting A",l:"Slitting A"},{v:"Slitting B",l:"Slitting B"}],"")
          +`<div class="muted" id="w_lnote" style="font-size:11px;margin-top:3px"></div>`),
        /* A large order is often run in batches. Blank means release the lot;
           a smaller figure puts that much on the machines now and carries the
           rest as pending, to be resumed batch by batch. */
        U.field("Release Now (kg)",`<input class="input" id="w_release" type="number" min="0" step="any" placeholder="whole quantity"><div class="muted" style="font-size:11px;margin-top:3px">Leave blank to release the whole order</div>`),
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
      let matWhs={};            // raw item id -> the store to issue it from
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
          hasCoating:!!hasCoating, fgAvailable:0, wipAvailable:0, fgRows:[], wipRows:[]};
        if(!(qty>0)) { plan.makeQty=0; return plan; }
        /* FINISHED STOCK, STORE BY STORE. The same product may sit in the
           finished bay and in the main store at once; each store is listed
           with what it holds (never the quarantine store) and the office says
           how much comes out of each. Mirrors stageService.finishedStockByStore. */
        const fgRows=ENG.data.items.filter(i=>i.cat==="FG")
          .filter(i=>nameKey(i)===nameKey(fg))
          .filter(i=>sameThk(i.thicknessMM,fg.thicknessMM))
          .filter(i=>want==null?true:sameThk(i.tapeWidthMM,want))
          .map(i=>{ const stores=whChoicesFor(i.id); return {id:i.id,name:i.name||i.id,stores,have:stores.reduce((n,s)=>n+s.qty,0)}; })
          .filter(r=>r.have>0);
        plan.fgAvailable=fgRows.reduce((n,r)=>n+r.have,0);
        plan.fgRows=fgRows;
        /* what was typed against each store — capped at what that store holds
           and at what the order still needs; an empty box takes nothing */
        let left=qty; const used=[];
        fgRows.forEach(r=>r.stores.forEach(s=>{
          if(left<=1e-9) return;
          const typed=fgTyped[r.id+"|"+s.wh];
          const wantQ=(typed==null||typed==="")?0:(+typed||0);
          const take=Math.max(0,Math.min(wantQ,s.qty,left));
          if(take>1e-9){ used.push({id:r.id,name:r.name,wh:s.wh,qty:take}); left-=take; }
        }));
        plan.fgQty=qty-left; plan.fgSources=used;
        const afterFg=qty-plan.fgQty;
        // only the COATED JUMBO can join at slitting — anything already slit
        // would be cut twice. No slit-roll item exists now; the guard mirrors
        // the server so the two never disagree about what is drawable.
        const isSlit=i=>/-S$/.test(String(i.id||""))||/slit/i.test(String(i.name||""));
        const wipRows=ENG.data.items.filter(i=>i.cat==="WIP").filter(i=>!isSlit(i))
          .filter(i=>i.stageOf? i.stageOf===id : (nameKey(i)===nameKey(fg)&&sameThk(i.thicknessMM,fg.thicknessMM)))
          .map(i=>({id:i.id,name:i.name||i.id,have:onHandOf(i.id)}))
          .filter(r=>r.have>0);
        plan.wipAvailable=wipRows.reduce((n,r)=>n+r.have,0);
        plan.wipRows=wipRows;
        if(hasCoating && afterFg>0){
          // an empty box takes nothing — the half-made pile is used only when asked for
          const wipDraw=drawFrom(wipRows, cap(wipWanted==null?0:wipWanted, plan.wipAvailable, afterFg));
          plan.wipQty=wipDraw.taken; plan.wipSources=wipDraw.used;
        }
        plan.makeQty=afterFg-plan.wipQty;
        return plan;
      }
      /* How much comes off the shelf is the PLANNER'S choice, entered STORE BY
         STORE: every store the product sits in is listed with what it holds
         and an EMPTY box beside it. Nothing is taken until a figure is typed
         (ruled 2026-09-02 — the box used to be pre-filled with the whole
         shelf, and with the product in two stores the office could not say
         which one). Typing survives the re-render each keystroke triggers
         (keepCaret, keyed on the box id), the box shows exactly what was
         typed, and the effective figure — capped at the store and at the
         order — is stated beside it. Text inputs with a decimal keypad hint:
         type=number rejects the thousands separator ENG.num puts in. */
      const fgTyped={};                    // "itemId|wh" -> what the box holds
      let wipWanted=null, wipTyped=null;   // the one half-made pile (always WH-WIP)
      let lastPlan=null;                   // the plan the form last showed — what Create sends
      const fgDrawsNow=()=>((lastPlan&&lastPlan.fgSources)||[]).map(u=>({id:u.id, wh:u.wh, qty:u.qty}));
      function netPanel(plan, uom){
        const avFg=plan.fgAvailable||0, avWip=plan.wipAvailable||0;
        if(!(avFg>0 || (avWip>0&&plan.hasCoating))) return null;
        const line=(key,icon,label,sub,typed,dest,onInput)=>h("div",{class:"flex between aic",
            style:"gap:12px;font-size:13px;padding:7px 0;border-bottom:1px solid var(--line)"},[
          h("div",{style:"min-width:0"},[
            h("div",{text:icon+" "+label}),
            h("div",{class:"muted",style:"font-size:11px",text:sub}),
          ]),
          h("div",{class:"flex aic",style:"gap:8px;flex:0 0 auto"},[
            h("input",{class:"input",id:key,type:"text",inputmode:"decimal",autocomplete:"off",placeholder:"0",
              value: typed==null? "" : typed, style:"width:110px;text-align:right",oninput:e=>onInput(e.target.value)}),
            h("div",{class:"muted",style:"font-size:11px;white-space:nowrap;min-width:96px",text:dest}),
          ]),
        ]);
        const kids=[
          h("div",{class:"muted",style:"font-size:11px;font-weight:700;text-transform:uppercase;margin-bottom:4px",
            text:"Take from stock — the rest is made from raw materials"}),
          h("div",{class:"muted",style:"font-size:11.5px;margin-bottom:6px",
            text:"Every store this product sits in is listed with what it holds. Enter how much to take from each; an empty box takes nothing from that store."}),
        ];
        if(avFg>0){
          plan.fgRows.forEach(r=>r.stores.forEach(s=>{
            const key=r.id+"|"+s.wh, typed=fgTyped[key];
            const drawn=(plan.fgSources.find(u=>u.id===r.id&&u.wh===s.wh)||{}).qty||0;
            const it=ENG.item(r.id)||{};
            const asked=(typed==null||typed==="")?0:(+typed||0);
            // what is actually drawn can differ from what was typed (capped at
            // the store, or at what is still outstanding) — say so rather than
            // overwriting the box
            const differs=asked>0 && Math.abs(asked-drawn)>0.005;
            kids.push(line("net_fg_"+key.replace(/[^A-Za-z0-9_-]/g,"_"), "📦", r.name,
              "🏬 "+whName(s.wh)+" · "+ENG.qtyText(it,s.qty,2)+" available"
                +(differs? "  ·  taking "+ENG.qtyText(it,drawn,2) : ""),
              typed, "→ packing", v=>{ fgTyped[key]=numish(v); recalc(); }));
          }));
        }
        if(avWip>0 && plan.hasCoating){
          const src=plan.wipRows||[];
          const asked=wipWanted==null?0:wipWanted;
          const differs=asked>0 && Math.abs(asked-plan.wipQty)>0.005;
          kids.push(line("net_wip","🧵","Half-made stock",
            "🏬 "+whName("WH-WIP")+" · "+src.map(s=>s.name+" · "+ENG.num(s.have,2)).join(" · ")
              +"  ·  "+ENG.num(avWip,2)+" "+(uom||"")+" available"
              +(differs? "  ·  taking "+ENG.num(plan.wipQty,2) : ""),
            wipTyped, "→ slitting", v=>{ const c=numish(v); wipTyped=c; wipWanted=c===""?0:(+c||0); recalc(); }));
        }
        kids.push(h("div",{class:"flex between aic",style:"gap:12px;font-size:13px;padding:8px 0 0;font-weight:800"},[
          h("span",{text:"To manufacture from raw materials"}),
          h("span",{text:ENG.num(plan.makeQty,2)+" "+(uom||"")}),
        ]));
        return h("div",{style:"margin:12px 0;padding:10px 12px;border:1.5px solid var(--ok);border-radius:10px"},kids);
      }

      // every rebuild goes through keepCaret, so typing in the stock boxes above
      // survives the re-render it triggers
      const recalc=()=>keepCaret(recalcNow);
      const whPicker = storePicker(matWhs);

      const recalcNow=()=>{ const id=UI.$("#w_item").value; convHint(); widthHint(); const qty=qtyKg()||0; const bom=ENG.data.boms[id];
        /* the stages this product will actually run. The line is the OFFICE'S
           choice: left on Auto the family rules decide and the note says which
           line that is; picked by hand the route starts there \u2014 and the pick
           is never overwritten here (it used to be, on every keystroke). */
        const lineSel=UI.$("#w_line"), asked=lineSel?String(lineSel.value||""):"";
        const rt=routeFor(id,qty,asked);
        const lnote=UI.$("#w_lnote");
        if(lnote) lnote.textContent = asked
          ? "Starts on "+asked+" \u2014 your choice. Auto would be "+(routeFor(id,qty).line||"a slitting line")+"."
          : "Auto: "+(rt.line||(LINES_BY_AREA[rt.area]||[])[0]||"a slitting line")+" \u2014 as per the product's rules";
        routeHost.innerHTML="";
        routeHost.appendChild(h("div",{class:"wo-route"},[
          h("span",{class:"wo-route-lbl",text:"Route"}),
          h("span",{class:"wo-route-path",text:rt.stages.join("  \u2192  ")}),
          rt.chosen
            ? h("span",{class:"chip",style:"font-size:11px;border-color:var(--accent);color:var(--accent)",text:"line chosen by you"})
            : rt.bought
            ? h("span",{class:"chip",style:"font-size:11px",text:"bought in \u2014 slit & pack"})
            : rt.stocked
              ? h("span",{class:"chip",style:"font-size:11px",
                  text:rt.owner.person+" produces it \u2014 material in store"})
              : h("span",{class:"chip",style:"font-size:11px;border-color:var(--warn);color:var(--warn)",
                  text:"material short \u2014 only part of the run can start"}),
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
        // a half-made jumbo can join at slitting only when the route COATS —
        // which the chosen line decides as much as the product does
        const plan=netPlan(id, qty, widthNow, !!rt.coats);
        lastPlan=plan;
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
        optionalPicker(matHost, bom, matChoices, qty, recalc);
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
                text:(c.item.id?U.matDisplay(c.item):c.id)+" · "+ENG.qtyText(c.item,c.have,1)+ENG.kgSuffix(c.item,c.have)+" in store"})));
            matHost.appendChild(h("div",{style:"margin-bottom:8px"},[
              h("div",{class:"muted",style:"font-size:12px;margin-bottom:3px",
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
        /* WHICH STORE EACH MATERIAL COMES OUT OF — said out loud, above the list.
           A picker only appears on a material that is actually IN more than one
           store, and in this plant almost everything sits in one, so the control
           was there but effectively invisible: the office had no way of knowing
           the choice existed, or why it was not being offered. This line answers
           both, every time, from what the recipe in front of it actually uses. */
        const drawIds=[...new Set(resolved.map(l=>l.id).filter(Boolean))];
        const choosable=drawIds.filter(rid=>whChoicesFor(rid).length>1);
        matHost.appendChild(h("div",{class:"wo-store-note"+(choosable.length?" pick":"")},[
          h("span",{class:"wo-store-ic",text:"🏬"}),
          h("div",{},[
            h("div",{style:"font-weight:700;font-size:12px",
              text: !choosable.length ? "Store to draw from"
                : "Store to draw from — "+(
                    choosable.length===drawIds.length
                      ? (drawIds.length===1 ? "this material sits" : "all "+drawIds.length+" materials sit")
                      : choosable.length+" of "+drawIds.length+" materials sit"
                  )+" in more than one store"}),
            h("div",{class:"muted",style:"font-size:11.5px;margin-top:2px",
              text: choosable.length
                ? ("Pick the store below. "+(choosable.length===drawIds.length ? ""
                    : "The rest are in one store only, named beside them.")).trim()
                : (drawIds.length
                    ? "Every material on this recipe is held in a single store, shown beside it below — there is nothing to choose."
                    : "No material is drawn from the store for this run.")}),
          ]),
        ]));
        // the shared renderer — the Add to Finished Stock forms show the very
        // same list, built the same way, so the two can never drift apart
        materialsList(matHost, layerGroups(resolved).map(grp=>({
          label: grp.label,
          lines: grp.lines.map(l=>{
            const rid=l.id, r=rid?(ENG.item(rid)||{}):{};
            return { id: rid, name: matLineName(l), code: matLineCode(l), spec: matLineSpec(l),
              need: perOf(l)*makeQty/bom.yield,
              have: rid?(ENG.stock(rid).onHand||0):0,
              agg: rid?needBy[rid]:undefined,
              /* which store this line comes out of and how much off it — by
                 the same rule the server uses when it posts the issue. A
                 material in several stores gets the picker instead, which
                 spells out the split against the store chosen there. */
              sources: rid?drawSharesFor(rid, perOf(l)*makeQty/bom.yield, matWhs[rid]):[],
              uom: r.uom||l.unit||"" };
          }),
        })), {outputKg: makeQty, whPick: whPicker});
        /* A SHORT material does not block the order — what the store covers
           runs, the balance pends, the office confirms. A material at ZERO is
           different (ruled 2026-08-22): nothing can start, so the order cannot
           be raised at all. Products we make in-house are exempt, exactly as
           on the server — their material comes off our own line, not a truck. */
        shortages=Object.entries(needBy)
          .filter(([rid,n])=>((ENG.stock(rid).onHand||0)+1e-6)<n)
          .map(([rid])=>{const r=ENG.item(rid)||{};return r.id?U.matDisplay(r):rid;});
        const noneAtAll = Object.entries(needBy)
          .filter(([rid,n])=>n>1e-9 && (ENG.stock(rid).onHand||0)<=1e-9)
          .map(([rid])=>{const r=ENG.item(rid)||{};return r.id?U.matDisplay(r):rid;});
        if(makeQty>0 && noneAtAll.length){
          matHost.appendChild(h("div",{style:"margin-top:10px;padding:9px 12px;border:1.5px solid var(--danger);border-radius:8px;color:var(--danger);font-size:13px;font-weight:600"},[
            h("div",{text:"⛔ The store has NONE of: "+noneAtAll.join(", ")}),
            h("div",{style:"font-weight:500;margin-top:3px;font-size:12px",
              text:"This order cannot be raised until the material is received — raise a purchase order first."}),
          ]));
        } else if(makeQty>0 && shortages.length){
          matHost.appendChild(h("div",{style:"margin-top:10px;padding:9px 12px;border:1.5px solid var(--warn);border-radius:8px;color:var(--warn);font-size:13px;font-weight:600"},[
            h("div",{text:"⚠ Short of: "+shortages.join(", ")}),
            h("div",{style:"font-weight:500;margin-top:3px;font-size:12px",
              text:"The order can still be raised — what the store covers goes to the floor and the balance is held as pending until the material arrives."}),
          ]));
        }
        if(createBtn) createBtn.disabled = makeQty>0 && noneAtAll.length>0;
      };
      const createBtn=h("button",{class:"btn primary",onclick:save,text:"Create Work Order"});
      const mo=modal({title:"New Work Order · "+woNo, sub:"Plan a production run", body,
        foot:[h("button",{class:"btn ghost",onclick:()=>mo.close(),text:"Cancel"}), createBtn]});
      setTimeout(()=>{ UI.$("#w_item").addEventListener("change",recalc); UI.$("#w_qty").addEventListener("input",recalc); UI.$("#w_unit").addEventListener("change",recalc); /* the width decides WHICH finished stock can be used, so it re-nets the
   whole plan rather than just refreshing its own hint */
UI.$("#w_width").addEventListener("input",recalc);
// the line decides the route (and whether half-made stock can join it)
UI.$("#w_line").addEventListener("change",recalc);
recalc(); },50);
      async function save(){
        const itemId=UI.$("#w_item").value, qty=qtyKg();
        if(qty==null){ toast("This product has no GSM — enter the quantity in kg",{type:"warn"}); return; }
        if(!qty||qty<=0){ toast("Enter a valid quantity",{type:"warn"}); return; }
        // a shortage is not a stop — the server prices it and the office confirms
        const payload={itemId, qty, due:UI.$("#w_due").value, priority:UI.$("#w_prio").value};
        // the line only when the office chose one — blank leaves it to the rules
        const lineV=String((UI.$("#w_line")||{}).value||"").trim(); if(lineV) payload.line=lineV;
        const relEl=UI.$("#w_release");
        if(relEl && relEl.value!==""){
          const rel=+relEl.value;
          if(!(rel>0)){ toast("Enter a valid quantity to release",{type:"warn"}); return; }
          if(rel>qty+1e-6){ toast("Cannot release more than the order quantity",{type:"warn"}); return; }
          if(rel<qty-1e-6) payload.releaseQty=rel;
        }
        const wmm=+UI.$("#w_width").value; if(wmm>0) payload.widthMM=wmm;
        /* how much comes off the shelf, STORE BY STORE, exactly as typed — an
           empty list included, so the server draws nothing the office did not
           ask for. The half-made pile likewise: blank means none. */
        payload.fgDraws=fgDrawsNow();
        payload.wipQty=wipWanted==null?0:wipWanted;
        // which material was picked for each ranged BOM line — travels with the
        // work order so the issue posts the material actually chosen
        if(Object.keys(matChoices).length) payload.materialChoices=matChoices;
        const cust=(UI.$("#w_cust")||{}).value||"";
        if(cust) payload.customerId=cust;
        /* Only the stores that were actually a CHOICE. A material in one store
           has none, and sending its store anyway would freeze a decision the
           office never made — the standing rule should keep following the
           stock if it moves before the job is issued. */
        const whPicked={};
        Object.keys(matWhs).forEach(rid=>{ if(whChoicesFor(rid).length>1) whPicked[rid]=matWhs[rid]; });
        if(Object.keys(whPicked).length) payload.materialWarehouses=whPicked;
        const spec=ORDER_SPEC[itemId], specEl=UI.$("#w_spec");
        if(spec && specEl && specEl.value!=="") payload[spec.key]=+specEl.value;
        createBtn.disabled=true; createBtn.textContent="Creating…";
        const land=(res)=>{
          const flow=(res.route||[]).map(r=>STAGE_LABEL[r.key]||r.name).join(" → ");
          mo.close();
          if((res.pendingQty||0)>0){
            toast(`${res.id} created — ${ENG.num(res.runQty)} kg released, `
              +`${ENG.num(res.pendingQty)} kg pending material`,{type:"warn",title:"Partial work order"});
          } else toast((res.id||"Work order")+" created — "+flow,{type:"ok"});
        };
        try{
          land(await DB.production.create(payload));
          await reloadState(); tab=App.setViewState("tab","active"); draw();
        }catch(e){
          /* The store cannot cover the whole order. Rather than refuse it — the
             floor runs what it can and waits for the rest — say exactly what is
             short and let the office raise it with a pending balance. */
          if(e.status===409 && e.shortage){
            createBtn.disabled=false; createBtn.textContent="Create Work Order";
            if(!await shortageConfirm(e, +UI.$("#w_qty").value||0)) return;
            createBtn.disabled=true; createBtn.textContent="Creating…";
            try{
              payload.allowShortage=true;
              land(await DB.production.create(payload));
              await reloadState(); tab=App.setViewState("tab","active"); draw();
            }catch(e2){ toast("Create failed: "+e2.message,{type:"danger"});
              createBtn.disabled=false; createBtn.textContent="Create Work Order"; }
            return;
          }
          toast("Create failed: "+e.message,{type:"danger"});
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
    /* the lab may PROPOSE a recipe (pageHead hides its actions for a
       read-only role) — it lands once an admin approves it */
    if(App.isLab&&App.isLab()) root.appendChild(h("div",{class:"flex aic",style:"gap:8px;margin:-6px 0 14px"},[
      h("button",{class:"btn primary",onclick:()=>bomForm(null,{propose:true}),html:"＋ Propose BOM"}),
      h("span",{class:"muted",style:"font-size:12px",text:"A recipe you propose reaches the catalogue once an admin approves it."}),
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
          h("span",{class:"muted",style:"font-size:13px",text:"· "+g.sub}),
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
        const rows=BOMCALC.toLegacy(bom,BOMCALC.metaFromItem(fg),null,ENG.item).map(([rid,per])=>{ const need=per*qty/bom.yield; const st=ENG.stock(rid)||{}; const have=st.onHand||0;
          const r=ENG.item(rid)||{}; return {rid, name:r.name||rid, uom:r.uom||"", per, need, have, short:Math.max(0,need-have), avgCost:st.avgCost||r.cost||0}; });
        const totCost=rows.reduce((s,x)=>s+x.need*x.avgCost,0);
        out.appendChild(h("div",{class:"flex between aic wrap",style:"margin-bottom:10px;gap:8px"},[
          h("div",{style:"font-weight:700",text:fg.name+" · "+(unit==="SQM"? ENG.num(raw,0)+" sqm ("+ENG.num(qty,1)+" kg)" : ENG.num(qty,1)+" kg")+" @ "+Math.round(bom.yield*100)+"% yield"}),
          h("span",{class:"chip",text:rows.length+" materials · est. ₹"+ENG.num(totCost,0)})
        ]));
        out.appendChild(table(rows,[
          {key:"name",label:"Raw Material",cls:"nm",render:r=>esc(r.name)},
          {key:"per",label:"Per kg",num:true,render:r=>ENG.num(r.per,3)+" "+esc(r.uom),sort:r=>r.per},
          {key:"need",label:"Required",num:true,render:r=>"<b>"+ENG.num(ENG.dispQty(ENG.item(r.rid),r.need),2)+"</b> "+esc(ENG.dispUom(ENG.item(r.rid))||r.uom),sort:r=>r.need},
          /* "Required (kg)" only says something when the column beside it is
             NOT already a weight — web reads in kilograms on its own now */
          {key:"needKg",label:"Required (kg)",num:true,render:r=>{const it=ENG.item(r.rid);if(ENG.readsAsKg(it))return '<span class="muted">—</span>';const w=ENG.kg(it,r.need);return w==null?'<span class="muted">—</span>':"<b>"+ENG.num(w,2)+"</b> kg";},sort:r=>ENG.kg(ENG.item(r.rid),r.need)||0},
          {key:"have",label:"In Stock",num:true,render:r=>ENG.num(ENG.dispQty(ENG.item(r.rid),r.have),1)+" "+esc(ENG.dispUom(ENG.item(r.rid))||r.uom)+ENG.kgSuffix(ENG.item(r.rid),r.have),sort:r=>r.have},
          {key:"short",label:"Shortfall",num:true,render:r=> r.short>0? badge("danger",ENG.num(ENG.dispQty(ENG.item(r.rid),r.short),2)+" "+(ENG.dispUom(ENG.item(r.rid))||r.uom)): badge("ok","OK"),sort:r=>r.short},
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
      if(bom) BOMCALC.toLegacy(bom,BOMCALC.metaFromItem(fg),null,ENG.item).forEach(([rid,per])=>{ c+=per*ENG.stock(rid).avgCost/bom.yield; });
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
        /* No copy icon on the row. Copying a recipe is a thing you decide
           having LOOKED at it — and the recipe itself carries "⧉ Copy BOM" in
           its footer, so the row icon was a second door to the same place,
           sitting in a column of its own on every line of a hundred-product
           table. Open the product, read the recipe, copy it from there. */
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
          // prints the recipe that is on screen, alternate variant included
          h("button",{class:"btn",onclick:()=>printBomCosting(fgId,altIdx),html:"🖨 Print Cost of Material"}),
          /* Copy BOM — this recipe as the starting point for a NEW product.
             Takes the variant that is on screen, and changes nothing here.
             Gated on canWrite rather than isAdmin because it CREATES, and
             creating is what the page's own "＋ Create BOM" already allows;
             the lab, which may read this page, gets neither. */
          App.canWrite("bom")?h("button",{class:"btn",title:"Start a new product from this recipe",
            onclick:()=>{mo.close();bomForm(null,{copyFrom:fgId,altIdx});},html:"⧉ Copy BOM"}):null,
          App.isAdmin()?h("button",{class:"btn primary",onclick:()=>{mo.close();bomForm(fgId);},html:"✎ Edit BOM"}):null,
          // the lab proposes a change; the admin rules on it (2026-09-02)
          (App.isLab&&App.isLab())?h("button",{class:"btn primary",onclick:()=>{mo.close();bomForm(fgId,{propose:true});},html:"✎ Propose change"}):null]});

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
              style:"font-weight:800;font-size:12px;text-transform:uppercase;letter-spacing:.4px;color:var(--accent);padding:11px 8px 4px",
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
          style:"padding:5px 0;border-bottom:1px solid var(--line);font-size:13px"+(strong?";font-weight:800":"")},[
          h("span",{class:strong?"":"muted",text:label}), h("span",{class:"mono",text:val})]);
        const box=h("div",{class:"card",style:"background:var(--panel-2);box-shadow:none;padding:12px"});
        box.appendChild(h("div",{class:"muted",style:"font-size:11px;font-weight:700;text-transform:uppercase;margin-bottom:6px",text:"Batch totals"}));
        box.appendChild(row("Total qty used (batch, mass basis)", n(c.totalQtyKg,2)+" kg"));
        box.appendChild(row("Total pickup qty", c.totalPickupQty==null?"— set pickup %":n(c.totalPickupQty,2)+" kg"));
        box.appendChild(row("Total pickup — per kg of FG", c.totalPickupPerKg==null?"—":n(c.totalPickupPerKg,4)));
        box.appendChild(row("Total pickup — per sqm", c.totalPickupPerSqm==null?"—":n(c.totalPickupPerSqm,4)+" kg/sqm"));
        box.appendChild(row(`Fabric GSM${c.fabricCount?" ("+c.fabricCount+" layer"+(c.fabricCount>1?"s":"")+")":""}`,
          c.fabricGsm==null?"—":n(c.fabricGsm,1)+" g/m²"));
        box.appendChild(row("Pickup GSM  (FG − fabric)", c.pickupGsm==null?"—":n(c.pickupGsm,1)+" g/m²"));
        box.appendChild(row("TOTAL PRODUCTION", c.totalProductionSqm==null?"—":n(c.totalProductionSqm,0)+" sqm", true));
        let cost=0; BOMCALC.toLegacy({lines:src.lines},meta,null,ENG.item).forEach(([rid,per])=>{ cost+=per*(ENG.stock(rid).avgCost||0)/bom.yield; });
        box.appendChild(row("Est. material cost — per kg of FG","₹"+n(cost,2)));
        totHost.appendChild(box);
      }
      draw();
    }

    /* ----- printable COST OF MATERIAL sheet ---------------------------------
       What a batch of this product costs in materials: each material once,
       what it needs, its rate and the money that comes to, then the batch
       total and the cost per kg of finished tape.
       This sheet is meant to leave the building, so it states quantities and
       money but NOT how the product is put together — no layer structure, and
       a material used in more than one place is shown once with its
       quantities added. The on-screen BOM still shows the full recipe.
       The per-kg figure is derived FROM the batch total the same way the
       on-screen roll-up derives it, so paper and screen can never disagree.
       A line whose material is not linked to a stock item has no rate to cost
       against; it prints with a dash rather than a fabricated zero. */
    function printBomCosting(fgId, altIdx){
      const fg=ENG.item(fgId)||{id:fgId,name:fgId};
      const bom=ENG.data.boms[fgId];
      if(!bom){ toast("No BOM for this product",{type:"warn"}); return; }
      const src=(bom.alternates && bom.alternates[altIdx||0])||bom;
      const meta=BOMCALC.metaFromItem(fg);
      const c=BOMCALC.compute({lines:BOMCALC.normalize(src.lines)},meta);
      const yld=bom.yield||1;
      const IN=(v,d)=>(+v||0).toLocaleString("en-IN",{minimumFractionDigits:d==null?2:d,maximumFractionDigits:d==null?2:d});
      const org=ENG.data.org||{};
      const co=(org.companies&&org.companies[0])||{name:org.name||"Chhaperia"};

      /* This sheet leaves the building, so it must not give the recipe away.
         The layer structure is not shown, and a material used on more than one
         layer appears ONCE with its quantities added up — 10 kg of SAP on top
         and 10 on the bottom reads as 20 kg. What the sheet still tells the
         truth about is the total material and what it costs. */
      const rowsSrc=c.lines.map(cl=>({layer:"",cl}));

      /* Cost first, render second — the share-of-cost column needs the batch
         total before a single row can be written. */
      /* A BOM line is written in whatever unit the recipe sheet used, but the
         RATE is per the material's STOCKING unit. 500 g of a resin bought by
         the kilo costs ₹1,262 — not ₹12.6 lakh. Convert before costing, and
         where the two units differ print the converted figure too, so
         qty × rate visibly equals the amount. Units that cannot be reconciled
         are left uncosted rather than guessed at. */
      const blankU=(u)=>{ const s=BOMCALC.normUnit(u); return !s||s==="-"||s==="--"; };
      function inStockUnit(qty,lineUnit,stockUnit){
        if(blankU(lineUnit)||blankU(stockUnit)) return qty;   // nothing to reconcile
        const a=BOMCALC.normUnit(lineUnit), b=BOMCALC.normUnit(stockUnit);
        if(a===b) return qty;
        const ka=BOMCALC.toKg(qty,a), kb=BOMCALC.toKg(1,b);
        return (ka!=null&&kb)?ka/kb:null;
      }
      let batchTotal=0, unpriced=0, converted=0;
      const rows=rowsSrc.map(({layer,cl})=>{
        const r=cl.id?ENG.item(cl.id):null;
        const rate=r?(((ENG.stock(cl.id)||{}).avgCost)||r.cost||0):0;
        const qty=+cl.qty||0;
        const stockU=r?(r.uom||""):"";
        const cq=r?inStockUnit(qty,cl.unit,stockU):null;
        const priced=!!(cl.id&&rate&&cq!=null);
        const amt=priced?cq*rate:null;
        const shifted=priced&&cq!==qty;
        return {layer, cl, r, rate, qty, amt, cq, stockU, shifted,
          // carried per row so repeats can be added together
          consSqm:cl.consumptionPerSqm, consKg:cl.consumptionPerKg,
          name:r?(r.material||r.name||cl.id):(cl.rm||cl.id||"—"),
          grade:r?(r.grade||r.id||"—"):(cl.rmType||"—")};
      });

      /* Fold repeats together. Keyed on the stock item where there is one, so
         the same material bought under one code merges however many places the
         recipe uses it; unlinked lines fall back to name + grade. Quantities,
         consumption and money add; the rate does not. */
      const byMat={}, merged=[];
      rows.forEach(d=>{
        const key=d.cl.id||("~"+d.name+"|"+d.grade+"|"+(d.cl.unit||""));
        const at=byMat[key];
        if(!at){ byMat[key]=d; d.mergedFrom=1; merged.push(d); return; }
        at.mergedFrom++;
        at.qty+=d.qty;
        if(at.cq!=null&&d.cq!=null) at.cq+=d.cq; else at.cq=null;
        if(at.amt!=null&&d.amt!=null) at.amt+=d.amt; else at.amt=null;
        if(at.consSqm!=null&&d.consSqm!=null) at.consSqm+=d.consSqm; else at.consSqm=null;
        if(at.consKg!=null&&d.consKg!=null) at.consKg+=d.consKg; else at.consKg=null;
        at.shifted=at.shifted||d.shifted;
        // a line unit that differs between repeats can no longer be stated
        if(BOMCALC.normUnit(at.cl.unit)!==BOMCALC.normUnit(d.cl.unit)) at.mixedUnit=true;
      });
      /* Carbon is bought under several GRADES — CLOFT 908, HS150, 250 R — and a
         recipe may draw on more than one, typically a different grade per layer
         (FG-CHDSW-25 puts CLOFT 908 on the top and HS150 on the bottom). They
         are consumed together, not chosen between. This sheet deliberately
         prints no grade, so two of them would otherwise appear as two identical
         "CARBON PASTE" rows a reader cannot tell apart. Fold them into ONE line
         at the combined quantity and combined cost, and restate the rate as
         what the blend actually costs per unit consumed. Paste and powder stay
         apart — those are different materials, not two grades of one. The BOM
         screen is untouched: it still shows every grade exactly as entered. */
      const carbonKind=(d)=>{
        const n=String(d.name||"").toUpperCase();
        if(!/CARBON/.test(n)) return null;
        return /POWDER/.test(n)?"CARBON POWDER":"CARBON PASTE";
      };
      const carbonAt={}, folded=[];
      merged.forEach(d=>{
        const kind=carbonKind(d);
        if(!kind){ folded.push(d); return; }
        // every grade is a mass, so kilos are the one unit they all share
        const kg=(d.cq!=null)?BOMCALC.toKg(d.cq,d.stockU||"KG"):null;
        const at=carbonAt[kind];
        if(!at){
          d.name=kind; d.carbonKg=kg; d.carbonGrades=1;
          d.carbonUnpriced=(d.amt==null)?1:0;
          d.carbonUnits=new Set([BOMCALC.normUnit(d.stockU||"KG")]);
          d.carbonLineUnits=new Set([BOMCALC.normUnit(d.cl.unit)]);
          carbonAt[kind]=d; folded.push(d); return;
        }
        at.carbonGrades++;
        at.mergedFrom=(at.mergedFrom||1)+1;
        at.qty+=d.qty;
        at.carbonUnits.add(BOMCALC.normUnit(d.stockU||"KG"));
        at.carbonLineUnits.add(BOMCALC.normUnit(d.cl.unit));
        if(at.carbonKg!=null&&kg!=null) at.carbonKg+=kg; else at.carbonKg=null;
        /* Keep the money we DO know. A grade with no rate in the item master
           cannot be costed, but that is no reason to throw away the cost of the
           grade beside it — the missing rate is reported under the table. */
        if(d.amt!=null) at.amt=(at.amt||0)+d.amt; else at.carbonUnpriced++;
        if(at.consSqm!=null&&d.consSqm!=null) at.consSqm+=d.consSqm; else at.consSqm=null;
        if(at.consKg!=null&&d.consKg!=null) at.consKg+=d.consKg; else at.consKg=null;
        at.shifted=at.shifted||d.shifted;
      });
      Object.keys(carbonAt).forEach(k=>{
        const at=carbonAt[k];
        if(at.carbonGrades<2) return;          // a single grade prints as it always did
        at.cq=at.carbonKg;
        // where the grades were not all stocked alike, kilos are the honest unit
        if(!(at.carbonUnits.size===1&&at.carbonUnits.has("KG"))){ at.stockU="KG"; at.mixedUnit=true; }
        if(at.carbonLineUnits.size>1) at.mixedUnit=true;
        at.rate=(at.amt!=null&&at.cq)?at.amt/at.cq:0;
      });

      /* Read the sheet the way the tape is built: the fabric it is carried on
         first, then the carbon that coats it, then everything else. Within a
         group the dearest lines lead, so the money is at the top of each. */
      const rank=(d)=>d.cl.fabric?0:(/CARBON/i.test(d.name)?1:2);
      const data=folded.slice().sort((a,b)=>
        (rank(a)-rank(b)) || ((b.amt||0)-(a.amt||0)));
      data.forEach(d=>{
        // a folded carbon line reports the grades inside it that carry no rate
        if(d.amt!=null) batchTotal+=d.amt; else if(!d.carbonUnpriced) unpriced++;
        if(d.carbonUnpriced) unpriced+=d.carbonUnpriced;
        if(d.shifted) converted++;
        /* Consumption per line is in that line's own unit, so where repeats
           used different units their figures cannot simply be added either —
           restate it from the converted quantity, in the stocking unit. */
        if(d.mixedUnit&&d.cq!=null){
          d.consKg=c.fgKgPerBatch?d.cq/c.fgKgPerBatch:null;
          d.consSqm=c.batchSqm?d.cq/c.batchSqm:null;
        }
      });


      /* Same document furniture as the purchase order and the invoice — logo
         band, orange rule, barred title, info panel, dark-headed table, notes
         beside a totals block, dark footer strip — so the three read as one
         family. What changes is what a costing sheet needs and they do not:
         the two party panels become PRODUCT and BASIS, the table carries layer
         sections and a share-of-cost column, and the grand total is the cost
         per kilo rather than money owed. */
      // needed by the per-kg basis inside the row loop, so declared before it
      const fgKg=c.fgKgPerBatch;
      const perKg=fgKg?batchTotal/(fgKg*yld):null;
      const maxPct = data.reduce((m,d)=>
        (d.amt!=null&&batchTotal>0)? Math.max(m, d.amt/batchTotal*100) : m, 0);
      let rowN=0;
      const trs=data.map(d=>{
        const out="";
        rowN++;
        const pct=(d.amt!=null&&batchTotal>0)?(d.amt/batchTotal*100):null;
        const barW=(pct!=null&&maxPct>0)?Math.max(3,Math.round(pct/maxPct*46)):0;
        /* A fabric is the SUBSTRATE — it is laid down by area, so it is bought,
           planned and costed by the square metre. Everything else (pastes,
           resins, chemicals) ends up inside the tape by weight, so it is costed
           against a kilogram of finished goods. Showing each on the basis the
           floor actually uses beats forcing both onto one. */
        const fab=!!d.cl.fabric;
        const cons=fab?d.consSqm:d.consKg;
        const per=fab?"sqm":"kg";
        const denom=fab?c.batchSqm:(fgKg?fgKg*yld:null);
        const costPer=(d.amt!=null&&denom)?d.amt/denom:null;
        return out+"<tr>"
          +'<td class="c">'+rowN+"</td>"
          /* No grade and no GSM on any line. Which grade of a material we buy,
             and at what weight, is ours — this sheet leaves the building. The
             fabric tag stays: it says nothing about the recipe, it explains why
             that row is costed per square metre rather than per kilo. */
          +"<td><b>"+esc(d.name)+"</b>"
            +(fab?'<span class="fab">fabric</span>':"")+"</td>"
          /* Adding 8 kg to 500 g gives 508 of nothing. Where repeats were
             written in different units the quantity is stated in the material's
             own stocking unit, which is the only one they all convert to. */
          +'<td class="r">'+(d.mixedUnit&&d.cq!=null? IN(d.cq,4)
            : IN(d.qty,3)+(d.shifted?'<div class="sub">= '+IN(d.cq,4)+" "+esc(BOMCALC.normUnit(d.stockU))+"</div>":""))+"</td>"
          +'<td class="c">'+esc(d.mixedUnit?(BOMCALC.normUnit(d.stockU)||"—"):(d.cl.unit||"—"))+"</td>"
          +'<td class="r">'+(cons==null?"—":IN(cons,4)+' <span class="per">/'+per+"</span>")+"</td>"
          +'<td class="r">'+(d.rate?IN(d.rate):"—")+"</td>"
          +'<td class="r"><b>'+(costPer==null?"—":IN(costPer,2))+"</b>"
            +'<div class="per">₹ / '+per+"</div></td>"
          +'<td class="r"><b>'+(d.amt!=null?IN(d.amt):"—")+"</b>"
            +(pct==null?"":'<div class="sub">'
              +'<span class="shw"><span class="shb" style="width:'+barW+'px"></span></span> '+pct.toFixed(1)+"%</div>")+"</td>"
          +"</tr>";
      }).join("");

      const code=U.familyCode(fg.typeCode,fg.thicknessMM)||fg.typeCode||fg.id;
      const today=DB.helpers.iso(DB.helpers.today());
      const variant=(bom.alternates&&bom.alternates.length>1)
        ? (src.label||("Variant "+((altIdx||0)+1))) : "";
      const logo=location.origin+"/assets/logo-invoice.png";
      const ip=(k,v)=>'<div class="ip"><span>'+esc(k)+"</span><b>"+v+"</b></div>";
      /* Only what would MISLEAD if left unsaid. The explanatory notes went with
         the panel they lived in; these are the ones that change how a figure
         should be read, so they survive as one line under the table. */
      const warn=[];
      if(converted) warn.push(converted+" line"+(converted>1?"s are":" is")+" priced in a different unit from the one entered — the converted quantity is shown beneath it and the amount follows that figure.");
      // "material", not "line" — a folded carbon line can hide an uncosted grade
      if(unpriced) warn.push(unpriced+" material"+(unpriced>1?"s have":" has")+" no rate and "+(unpriced>1?"are":"is")+" left out of the totals.");
      if(perKg==null) warn.push("The per-kg figures need this product's FG GSM to be set.");
      if(c.rangedLines) warn.push("A ranged line is costed at the material named here; the one used is chosen against live stock at issue.");

      const html='<!doctype html><html><head><meta charset="utf-8">'
        +"<title>Cost of Material "+esc(code)+"</title><style>"
        +"@page{size:A4;margin:8mm}"
        +"*{margin:0;padding:0;box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}"
        +'body{font:12px/1.38 "Segoe UI",Arial,sans-serif;color:#1a1c1e;max-width:860px;margin:0 auto;padding:0 20px 20px}'
        /* The logo carries its own white background, so it is set ON white at
           full size rather than plated onto a dark band — which is what made it
           look stuck on. The charcoal and orange stay, as the rule under it. */
        +".mast{display:flex;align-items:center;justify-content:space-between;gap:26px;padding:2px 0 11px}"
        +".mast .lg img{height:92px;width:auto;max-width:350px;object-fit:contain;display:block}"
        +".mast .who{text-align:right;color:#3a3f44;font-size:11px;line-height:1.55;max-width:330px}"
        +".conm{font-size:13px;font-weight:800;color:#26282b;letter-spacing:.2px}"
        +".co-ids{margin-top:4px;color:#26282b;font-weight:700}"
        +".co-ids span{color:#F06820;font-weight:800}"
        +".rule{height:3px;background:linear-gradient(90deg,#F06820 0 62%,#26282b 62% 100%);margin:0 -20px}"
        // the document name, plainly: black, bold, centred, nothing around it
        +".titlebar{text-align:center;margin:11px 0 10px}"
        +".titlebar .t{font-size:19px;font-weight:800;letter-spacing:3.5px;text-transform:uppercase;color:#000}"
        +".info{display:grid;grid-template-columns:repeat(3,1fr);gap:2px 24px;border:1px solid #d8dbde;border-radius:9px;background:#fafbfc;padding:7px 14px;margin-bottom:8px}"
        +".ip{display:flex;justify-content:space-between;gap:8px;font-size:11px}"
        +".ip span{color:#767c82;text-transform:uppercase;font-size:10px;font-weight:700;letter-spacing:.3px;padding-top:1px}"
        // full-width product band — the loudest thing on the page after the title
        +".prod{border:1px solid #e0c4ac;border-left:5px solid #F06820;background:#fff8f3;"
        +"border-radius:0 8px 8px 0;padding:9px 14px;margin-bottom:8px}"
        +".pnm{font-weight:800;font-size:15px;line-height:1.25;color:#26282b}"
        +".pmeta{margin-top:5px;display:flex;flex-wrap:wrap;gap:6px 8px;font-size:11px;color:#6d5544}"
        +".pmeta span{background:#fff;border:1px solid #ecd6c4;border-radius:3px;padding:1px 8px}"
        +".pmeta .pc{background:#F06820;border-color:#F06820;color:#fff;font-weight:800;letter-spacing:.5px}"
        +".warn{margin:0 0 8px;font-size:10px;line-height:1.5;color:#8a6d3b}"
        +"table.items{width:100%;border-collapse:collapse;margin-bottom:8px}"
        +"table.items th{background:#26282b;color:#fff;font-size:10px;text-transform:uppercase;letter-spacing:.5px;"
        +"padding:5.5px 7px;border:1px solid #26282b;border-top:3px solid #F06820}"
        +"table.items td{border:1px solid #d8dbde;padding:4px 7px;font-size:12px;vertical-align:top}"
        +"table.items tbody tr:nth-child(even) td{background:#f6f7f8}"
        +"td.r,th.r{text-align:right} td.c,th.c{text-align:center}"
        +"td .sub{font-size:10px;color:#777}"
        +".rng{font-size:9px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;color:#8a6d3b;"
        +"background:#fcf3dc;border:1px solid #e6d4a8;border-radius:3px;padding:0 4px;margin-left:5px}"
        +".shw{display:inline-block;width:46px;height:5px;background:#e9ecef;border-radius:3px;vertical-align:middle;overflow:hidden}"
        +".shb{display:block;height:5px;background:#F06820;border-radius:3px}"
        +".per{font-size:9px;color:#8a9096;font-weight:600;letter-spacing:.2px}"
        +".fab{display:inline-block;margin-left:5px;font-size:9px;font-weight:700;letter-spacing:.4px;"
        +"text-transform:uppercase;color:#1f6f8b;background:#e8f3f7;border:1px solid #b9d9e5;border-radius:3px;padding:0 4px}"
        +".bottom{display:flex;justify-content:flex-end;margin-bottom:6px}"
        +".br{width:340px}"
        +"table.tot{width:100%;border-collapse:collapse;height:fit-content}"
        +"table.tot td{border:1px solid #d8dbde;padding:5px 12px;font-size:12px}"
        +"table.tot td:first-child{color:#555}"
        +"table.tot td:last-child{text-align:right;font-weight:700}"
        +"table.tot tr:nth-child(even) td{background:#f6f7f8}"
        +"table.tot tr.g td{background:#F06820;color:#fff;font-weight:800;font-size:15px;border-color:#F06820}"
        +".sign{display:flex;justify-content:space-between;align-items:flex-end;margin-top:8px;font-size:11px;color:#777}"
        +".sig{text-align:center;color:#1a1c1e}"
        +".sig .ln{border-top:1.5px solid #555;margin-top:24px;padding-top:5px;min-width:210px;font-weight:700}"
        +".strip{display:flex;justify-content:space-between;background:#26282b;color:#fff;font-size:11px;"
        +"padding:6px 14px;border-radius:6px;margin-top:14px}.strip b{color:#F58024}"
        +"</style></head><body>"
        +'<div class="mast"><div class="lg"><img src="'+logo+'" alt=""></div>'
        +'<div class="who"><div class="conm">'+esc(co.name||"Chhaperia")+"</div>"
        +(co.address?"<div>"+esc(co.address)+"</div>":"")
        +(co.gstin?'<div class="co-ids"><span>GSTIN</span> '+esc(co.gstin)+"</div>":"")
        +"</div></div><div class=\"rule\"></div>"
        +'<div class="titlebar"><span class="t">Cost of Material</span></div>'
        /* The product runs the full width and is the loudest thing under the
           masthead — it is what the sheet is about. The figures that used to
           sit in a second panel are folded into the strip below it, so nothing
           needed to read the per-sqm and per-kg columns is lost. */
        +'<div class="prod"><div class="pnm">'+esc(fg.name||fg.id)+"</div>"
        +'<div class="pmeta"><span class="pc">'+esc(code)+"</span>"
        +(fg.thicknessMM!=null?"<span>"+esc(fg.thicknessMM)+" mm</span>":"")
        // no recipe name and no layer count — neither is ours to hand out
        +"</div></div>"
        +'<div class="info">'
        +ip("Costing Ref",esc(code)+"/"+esc(String(today).slice(0,7)))
        +ip("Date",esc(today))
        +ip("Yield",(yld*100).toFixed(0)+"%")
        // the batch reads as the whole equation on one line
        +ip("Batch",esc(meta.batchWidthMM)+" mm × "+esc(meta.batchLengthM)+" mtr = "+IN(c.batchSqm,0)+" sqm")
        +ip("FG GSM",c.fgGsm!=null?IN(c.fgGsm,0)+" g/m²":"not set")
        +ip("Finished / batch",fgKg?IN(fgKg,1)+" kg":"—")
        +ip("Components",String(data.length))
        +ip("Costed",(data.length-unpriced)+" of "+data.length)
        +"</div>"
        +'<table class="items"><thead><tr>'
        +'<th class="c" style="width:24px">Sl.</th><th>Raw Material</th>'
        +'<th class="r" style="width:76px">Qty / Batch</th><th class="c" style="width:40px">Unit</th>'
        +'<th class="r" style="width:84px">Consumption</th><th class="r" style="width:70px">Rate (₹)</th>'
        +'<th class="r" style="width:76px">Cost</th>'
        +'<th class="r" style="width:92px">Amount (₹)</th>'
        +"</tr></thead><tbody>"
        +(trs||'<tr><td colspan="8" class="c">No components</td></tr>')+"</tbody></table>"
        /* The bordered notes panel is gone. Anything that would MISLEAD if left
           unsaid — a converted unit, an uncosted line, a missing GSM — still
           has to be said, so it runs as one quiet line under the table instead
           of a boxed block. With nothing to warn about, nothing prints. */
        +(warn.length?'<div class="warn">'+warn.map(t=>esc(t)).join(" ")+"</div>":"")
        +'<div class="bottom"><div class="br"><table class="tot">'
        +"<tr><td>Total material cost — per batch</td><td>₹ "+IN(batchTotal)+"</td></tr>"
        +"<tr><td>Finished output — per batch</td><td>"+(fgKg?IN(fgKg,1)+" kg":"—")+"</td></tr>"
        +'<tr class="g"><td>Cost per kg of FG</td><td>'+(perKg==null?"—":"₹ "+IN(perKg))+"</td></tr>"
        +"</table></div></div>"
        +'<div class="sign"><div>Costing prepared from the approved bill of materials.</div>'
        +'<div class="sig"><div>For '+esc(co.name||"Chhaperia")+'</div><div class="ln">Authorised Signatory</div></div></div>'
        +'<div class="strip"><span>'+esc(co.name||"Chhaperia")+" — <b>Cost of Material</b></span>"
        +"<span>"+esc(code)+" · "+esc(today)+"</span></div>"
        +"</body></html>";

      const w=window.open("","_blank");
      if(!w){ toast("Popup blocked — allow popups for this site to print",{type:"warn"}); return; }
      w.document.write(html); w.document.close();
    }

    /* ----- create / edit / delete a product's BOM -------------------------
       Quantities are PER BATCH (the standard 1000 mm x 1000 m = 1000 sqm run),
       exactly as the source data records them. Each line carries a pickup % —
       the share of that material that actually ends up in the finished good —
       and from those two numbers everything else is derived:
         consumption/kg, consumption/sqm, pickup qty, and total production.
       All the arithmetic lives in bomcalc.js, shared with the server. */
    /* `opts.copyFrom` — COPY BOM. The form opens on the new-product fields,
       pre-filled from that product and carrying its recipe, with nothing
       locked: code, name, spec, yield and every component line are edited
       before Create BOM writes it as a NEW product. The source is never
       touched. `opts.altIdx` is whichever approved recipe was on screen when
       Copy was pressed — that is the one that gets copied. */
    function bomForm(fgId, opts){
      opts = opts || {};
      const copySrcId = opts.copyFrom || null;
      const copySrc = copySrcId ? ENG.item(copySrcId) : null;
      const copying = !!(copySrc && ENG.data.boms[copySrcId]);
      const copyName = copying ? (copySrc.productName||copySrc.name||copySrcId) : "";
      const fgs=ENG.data.items.filter(i=>i.cat==="FG");
      // components a person picks by hand — WIP is inserted by the stage engine
      const rms=ENG.data.items.filter(i=>i.cat==="RM"||i.cat==="PKG"||i.cat==="CON");
      /* A copy parks on the SOURCE so loadLines() below picks up its recipe.
         The product being defined is the draft, not this row. */
      let curFg = fgId || copySrcId || (fgs[0] && fgs[0].id) || "";
      const existing = fgId? ENG.data.boms[fgId] : null;
      const editing = !!existing;
      /* A recipe for a product that does not exist YET used to be impossible
         here: the picker offered the catalogue and nothing else, so a new tape
         had to be created over in Stock Items and the recipe written on a
         second trip. The product can be defined in this form now. With an
         empty catalogue it opens straight in that mode — there is nothing to
         pick — which is also why the old "create a product first" refusal is
         gone. */
      /* "Create BOM" MEANS a new product. Pressed from the page header (or the
         ⌘K action) the form opens straight on the new-product fields — that is
         what the button is for; writing a recipe for something already in the
         catalogue is the exception, and it is one click away on
         "↩ Pick an existing product".
         Opened WITH a product (`fgId` — a catalogue row that has no recipe yet,
         or Edit BOM) it stays on that product: the operator already said which
         one they meant. */
      let newMode = !editing && !fgId;
      /* A copy opens with the source's own figures already in the fields. The
         CODE is the exception: it is what makes the new product a different
         product, so it is left empty to be typed rather than guessed at with
         a "-COPY" suffix that would end up in the catalogue for good. */
      const draft = copying
        ? { id:"FG-", name:copyName, group:copySrc.group||"",
            thicknessMM:copySrc.thicknessMM!=null?copySrc.thicknessMM:null,
            gsm:copySrc.gsm!=null?copySrc.gsm:null, uom:copySrc.uom||"KG",
            cost:copySrc.cost||0, price:copySrc.price||0, hsn:copySrc.hsn||"" }
        : { id:"FG-", name:"", group:"", thicknessMM:null, gsm:null,
            uom:"KG", cost:0, price:0, hsn:"" };
      /* the roll-up reads GSM and thickness off the product; in new-product
         mode that product is the half-typed draft, not a catalogue row */
      const fgItem = () => newMode
        ? { id:draft.id, name:draft.name, productName:draft.name, cat:"FG", uom:draft.uom,
            typeCode:draft.id.replace(/^FG-/,""), group:draft.group,
            thicknessMM:draft.thicknessMM, gsm:draft.gsm,
            cost:draft.cost, price:draft.price, hsn:draft.hsn }
        : (ENG.item(curFg)||{});
      // copying takes the variant that was on screen when Copy was pressed
      let altIdx = copying ? (+opts.altIdx || 0) : 0;
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
      /* The catalogue product's components, PARKED while a new product is being
         defined. Without this, looking at the new-product fields and changing
         your mind emptied the recipe you already had on screen, and the form
         came back blank — which reads as "this can only make new products". */
      let parkedLines = null;
      /* Opened as "Create BOM" the components start EMPTY — a new product must
         not inherit whichever catalogue product the picker happened to default
         to. Its recipe is parked, so switching over to it costs nothing. */
      /* A copy is the exception: arriving with the source's components already
         on the table is the whole point, so they are NOT cleared. Parking a
         duplicate means "↩ Pick an existing product" keeps the recipe too. */
      if(newMode && copying) parkedLines = lines.map(l=>Object.assign({},l,{_k:++seq}));
      else if(newMode){ parkedLines = lines; lines = [blank()]; }

      const basisHost=h("div",{class:"muted",style:"font-size:12px;margin:2px 0 12px"});
      const altHost=h("div",{style:"margin-bottom:10px"});
      const tblHost=h("div",{class:"bom-edit-wrap"});
      const totHost=h("div",{style:"margin-top:14px"});

      const curItem=ENG.item(curFg)||{};
      const lockedLabel=(U.familyCode(curItem.typeCode,curItem.thicknessMM)||curItem.typeCode||curFg)
        +" — "+(curItem.productName||curItem.name||curFg)
        +(curItem.thicknessMM!=null?" · "+curItem.thicknessMM+" mm":"");
      /* The copied recipe brings its yield with it — a recipe without the
         yield it was costed at is a different recipe. */
      const srcBom = copying ? ENG.data.boms[copySrcId] : null;
      const initYieldPct = existing ? Math.round(existing.yield*100)
        : srcBom ? Math.round((srcBom.yield||1)*100) : 100;
      const prodHost=h("div",{style:"display:contents"});
      /* bound ONCE on the host, not per render — re-rendering the row inside
         it would otherwise stack a fresh listener on every toggle. GSM and
         thickness feed the roll-up, so the totals follow what is typed. */
      prodHost.addEventListener("input",()=>{ if(newMode){ syncDraft(); draw(); } });
      const body=h("div",{},[
        h("div",{class:"form-grid"},[
          prodHost,
          U.field("Yield (%)", `<input class="input" id="bm_yield" type="number" step="1" min="1" max="100" value="${initYieldPct}">`),
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
      const mo=modal({
        title: editing ? ("Edit BOM · "+curFg)
          : copying ? ("Copy BOM · "+(U.familyCode(copySrc.typeCode,copySrc.thicknessMM)||copySrc.typeCode||copySrcId))
          : "Create BOM",
        // xwide: the components table needs the room, else it side-scrolls
        sub: copying ? ("Copied from "+copyName+" — change anything, then Create BOM adds it as a new product")
          : "Material recipe, pickup % and production roll-up",
        xwide:true, body, foot});
      drawProduct();

      /* The product row: a locked label when editing, otherwise either the
         catalogue picker or the fields that define a product that does not
         exist yet. Switching between the two re-renders only this row, so
         nothing typed into the components table below is lost. */
      function drawProduct(){
        prodHost.innerHTML="";
        if(editing){
          prodHost.appendChild(U.field("Product (Finished Good)",
            `<input type="hidden" id="bm_fg" value="${esc(curFg)}"><input class="input is-locked" readonly value="${esc(lockedLabel)}">`,"full"));
          return;
        }
        if(newMode){
          const series=[...new Set(ENG.data.items.filter(i=>i.cat==="FG"&&i.group).map(i=>i.group))].sort();
          prodHost.appendChild(U.field("Product Code *",
            `<input class="input" id="bm_np_id" value="${esc(draft.id)}" placeholder="FG-CCM25GE-10">`));
          prodHost.appendChild(U.field("Product Name *",
            `<input class="input" id="bm_np_name" value="${esc(draft.name)}" placeholder="Name as it reads on the label">`));
          prodHost.appendChild(U.field("Series",
            `<input class="input" id="bm_np_group" list="bm_np_series" value="${esc(draft.group)}" placeholder="e.g. MICA SERIES">`
            +`<datalist id="bm_np_series">${series.map(s=>`<option value="${esc(s)}"></option>`).join("")}</datalist>`));
          prodHost.appendChild(U.field("Thickness (mm)",
            `<input class="input" id="bm_np_thk" type="number" step="0.001" min="0" value="${draft.thicknessMM==null?"":draft.thicknessMM}" placeholder="0.100">`));
          prodHost.appendChild(U.field("GSM",
            `<input class="input" id="bm_np_gsm" type="number" step="1" min="0" value="${draft.gsm==null?"":draft.gsm}" placeholder="finished weight per m²">`));
          prodHost.appendChild(U.field("Unit", U.selectHTML("bm_np_uom",
            [{v:"KG",l:"Kilogram (kg)"},{v:"SQM",l:"Square Meter (sqm)"},{v:"MTR",l:"Meter (m)"}], draft.uom)));
          prodHost.appendChild(U.field("Cost / unit (₹)",
            `<input class="input" id="bm_np_cost" type="number" step="0.01" min="0" value="${draft.cost||0}">`));
          prodHost.appendChild(U.field("Selling Price (₹)",
            `<input class="input" id="bm_np_price" type="number" step="0.01" min="0" value="${draft.price||0}">`));
          prodHost.appendChild(U.field("HSN",
            `<input class="input" id="bm_np_hsn" value="${esc(draft.hsn)}" placeholder="optional">`));
          prodHost.appendChild(h("div",{class:"field full"},[
            h("div",{class:"flex aic gap"},[
              h("span",{class:"muted",style:"font-size:12px",
                text: copying
                  ? ("Give it a code of its own — everything else came from "+copyName+" and is yours to change. Create BOM adds it to the catalogue with this recipe.")
                  : "The product is created with this recipe when you press Create BOM."}),
              h("button",{class:"btn sm ghost",style:"margin-left:auto",
                onclick:()=>{ newMode=false;
                  if(parkedLines){ lines=parkedLines; parkedLines=null; } else loadLines();
                  drawProduct(); draw(); },
                text:"↩ Pick an existing product"})])]));
          return;
        }
        prodHost.appendChild(fgPicker("bm_fg", fgs, curFg));
        const fgHid=UI.$("#bm_fg");
        if(fgHid) fgHid.addEventListener("change",()=>{ const v=fgHid.value; if(v&&v!==curFg){ curFg=v; altIdx=0; loadLines(); draw(); } });
        prodHost.appendChild(h("div",{class:"field full"},[
          h("div",{class:"flex aic gap"},[
            h("span",{class:"muted",style:"font-size:12px",text:"Making something new? Define the product here instead of creating it first."}),
            h("button",{class:"btn sm",style:"margin-left:auto",
              onclick:()=>{ newMode=true; altIdx=0;
                parkedLines=lines; lines=[blank()];
                drawProduct(); draw(); },
              html:"＋ New product"})])]));
      }
      function syncDraft(){
        const g=id=>{ const el=UI.$("#"+id); return el?el.value:""; };
        draft.id=g("bm_np_id").trim().toUpperCase();
        draft.name=g("bm_np_name").trim();
        draft.group=g("bm_np_group").trim();
        draft.thicknessMM=g("bm_np_thk")===""?null:+g("bm_np_thk");
        draft.gsm=g("bm_np_gsm")===""?null:+g("bm_np_gsm");
        draft.uom=g("bm_np_uom")||"KG";
        draft.cost=+g("bm_np_cost")||0;
        draft.price=+g("bm_np_price")||0;
        draft.hsn=g("bm_np_hsn").trim();
      }

      const n=(v,d)=> v==null||isNaN(v) ? "—" : ENG.num(v,d);

      function draw(){
        const fg=fgItem();
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
            /* while copying these are the SOURCE's variants: pick the one to
               copy. Only that one travels — a new product does not inherit
               approvals it never went through. */
            h("span",{class:"muted",style:"font-size:12px;font-weight:700",
              text: copying?"Copy which recipe:":"Approved recipe:"}),
            ...bom.alternates.map((a,i)=>h("button",{
              class:"btn sm"+(i===altIdx?" primary":" ghost"),
              onclick:()=>{ altIdx=i; loadLines(); draw(); },
              text:a.label||("Variant "+(i+1))
            }))
          ]));
        }

        /* ---- component rows ---- */
        tblHost.innerHTML="";
        const head=["Raw material","Qty / batch","Opt?","Unit","GSM (g/m²)","Pickup %","Consumption / kg","Consumption / sqm",""];
        const tbl=h("table",{class:"tbl bom-edit-tbl"});
        tbl.appendChild(h("thead",{},[h("tr",{},head.map((t,i)=>
          h("th",{style:"font-size:11px;"+(i>=1&&i<=7?"text-align:right":""),text:t,
            title:t==="Opt?"?"Optional — each work order chooses whether to use this line":null})))]));
        const tb=h("tbody");
        /* layer names render as heading rows inside the editable table; a
           single-layer product gets the same heading so it reads like a
           multi-layer one */
        const grpIdx=layerGroups(lines.map((l,i)=>Object.assign({_i:i},l)));
        const heads={};
        grpIdx.forEach((g,gi)=>{ if(g.lines.length) heads[g.lines[0]._i]=g.label||(grpIdx.length>1?"LAYER "+(gi+1):"LAYER 1"); });
        c.lines.forEach((cl,i)=>{
          const l=lines[i];
          if(heads[i]!=null) tb.appendChild(h("tr",{},[h("td",{colspan:"9",
            style:"font-weight:800;font-size:12px;text-transform:uppercase;letter-spacing:.4px;color:var(--accent);padding:11px 8px 4px",
            text:heads[i]})]));
          const nameCell=h("td",{class:"nm bom-nm"});
          if(l.ranged){
            // A ranged line has no single material yet — the real one is chosen
            // against live store stock when the work order is issued.
            nameCell.appendChild(h("div",{},[
              h("div",{style:"font-weight:700;font-size:13px",text:(l.rm||"—")+(l.rmType?" — "+l.rmType:"")}),
              h("span",{class:"chip",style:"font-size:10px",title:"Resolved against live store stock at work-order issue",text:"⟡ ranged — picked at issue"})
            ]));
          } else {
            nameCell.appendChild(h("div",{html:U.searchSelect("bl_rid_"+l._k,
              matOptions(l.id), l.id, "Search material…")}));
            if(l.rm) nameCell.appendChild(h("div",{class:"muted",style:"font-size:11px;margin-top:2px",
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
          /* optional = offered per order, never assumed. The ink lines on the
             aluminium tapes are the reason this exists. */
          const optIn=h("input",{type:"checkbox",title:"Optional \u2014 each work order chooses whether to use this line",
            style:"width:15px;height:15px;accent-color:var(--accent)"});
          optIn.checked=!!l.optional;
          optIn.addEventListener("change",()=>{ l.optional=optIn.checked||undefined; });
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
            h("td",{style:"text-align:right",title:"Optional per order"},[optIn]),
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
        const fg=fgItem();
        const c=BOMCALC.compute({lines}, BOMCALC.metaFromItem(fg));
        c.lines.forEach((cl,i)=>{
          const l=lines[i]; if(!l||!l._cKg) return;
          l._cKg.textContent = cl.consumptionPerKg==null?"—":ENG.num(cl.consumptionPerKg,3);
          l._cSq.textContent = cl.consumptionPerSqm==null?"—":ENG.num(cl.consumptionPerSqm,4);
        });

        totHost.innerHTML="";
        const row=(label,val,strong)=>h("div",{class:"flex between",
          style:"padding:5px 0;border-bottom:1px solid var(--line);font-size:13px"+(strong?";font-weight:800":"")},[
          h("span",{class:strong?"":"muted",text:label}), h("span",{class:"mono",text:val})]);

        const box=h("div",{class:"card",style:"background:var(--panel-2);box-shadow:none;padding:12px"});
        box.appendChild(h("div",{class:"muted",style:"font-size:11px;font-weight:700;text-transform:uppercase;margin-bottom:6px",text:"Batch totals"}));
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
          totHost.appendChild(h("div",{class:"muted",style:"font-size:12px;margin-top:6px",
            text:"Total production unavailable: "+why+"."}));
        }
      }
      draw();

      const clone = v => v==null ? v : JSON.parse(JSON.stringify(v));
      /* A copied test spec is RE-CENTRED on the new product's own thickness and
         GSM: the nominal moves, and min/max move with it wherever the parameter
         carries a tolerance. Without this a 0.100 mm copy of a 0.125 mm tape
         would go into the catalogue claiming the source's 0.11–0.14 limits.
         A parameter with no tolerance to re-derive from loses its limits rather
         than keeping ones that no longer describe anything. */
      function respec(spec, thk, gsm){
        if(!spec || typeof spec!=="object") return spec;
        const out=clone(spec);
        const centre=(key,val)=>{
          const sp=out[key];
          if(!sp || typeof sp!=="object") return;
          if(val==null || isNaN(val) || +sp.nominal===+val) return;
          sp.nominal=+val;
          if(sp.tol!=null){ sp.min=+(val-sp.tol).toFixed(6); sp.max=+(val+sp.tol).toFixed(6); }
          else { delete sp.min; delete sp.max; }
        };
        centre("thickness",thk); centre("massPerArea",gsm);
        return out;
      }

      function save(){
        if(newMode) syncDraft();
        const fg2 = newMode ? draft.id : (UI.$("#bm_fg").value || curFg);
        if(newMode){
          if(!fg2 || fg2==="FG-"){ toast("The new product needs a code",{type:"warn"}); return; }
          if(!draft.name){ toast("The new product needs a name",{type:"warn"}); return; }
          if(ENG.item(fg2)){ toast(fg2+" already exists — pick it from the product list instead",{type:"danger"}); return; }
        }
        const yld=Math.min(100,Math.max(1,+UI.$("#bm_yield").value||100))/100;
        // pull the material picker back for non-ranged rows, keep every other
        // field (rm/type/thickness/GSM/options) exactly as loaded
        const out=lines.map(l=>{
          const sel=l.ranged?null:UI.$("#bl_rid_"+l._k);
          const o={ id: l.ranged? (l.id||null) : ((sel&&sel.value)||l.id||null),
            rm:l.rm, rmType:l.rmType, rmThk:l.rmThk, rmGsm:l.rmGsm,
            qty:+l.qty||0, unit:l.unit||"KG",
            pickupPct: l.pickupPct==null?null:+l.pickupPct,
            optional: l.optional?true:undefined,
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
        /* THE LAB PROPOSES. Nothing of theirs lands until an admin approves
           (ruled 2026-09-02): the same recipe — and the new product, when it
           is one — goes to the approval queue instead of the catalogue. */
        if(opts.propose || (App.isLab&&App.isLab())){
          const payload={ itemId:fg2, bom:next };
          if(newMode) payload.newItem={ name:draft.name, productName:draft.name, uom:draft.uom||"KG", group:draft.group||null,
            typeCode:fg2.replace(/^FG-/,""), thicknessMM:draft.thicknessMM, gsm:draft.gsm, cost:draft.cost, price:draft.price, hsn:draft.hsn };
          mo.close();
          DB.approvals.propose("bom", payload)
            .then(async ap=>{ toast("Sent to the admin for approval — "+ap.id, {type:"ok",title:"Proposal sent",dur:6000}); await App.reloadState(); })
            .catch(e=>toast(e.message||"Could not send the proposal",{type:"danger"}));
          return;
        }
        /* The product is written BEFORE its recipe — a BOM whose finished good
           does not exist is a row nothing can render. Both go out in the one
           saveDelta, so a failure reloads the server's truth and neither is
           left behind on its own. */
        let newItem=null, openMove=null;
        if(newMode){
          /* A copy carries the source's PHYSICAL description as well as its
             recipe — batch size, layer count, tape width, the test spec —
             because those are what make the roll-up, the job sheet and the
             label read the same. Identity and provenance never travel: code,
             name, barcode and the import's own source/row belong to the new
             product alone. */
          const carried={};
          if(copying){
            const own={ id:1, name:1, productName:1, typeCode:1, group:1, series:1,
              thicknessMM:1, gsm:1, cost:1, price:1, hsn:1, uom:1, cat:1,
              barcode:1, source:1, sourceRow:1, supplierId:1 };
            Object.keys(copySrc).forEach(k=>{ if(!own[k]) carried[k]=clone(copySrc[k]); });
            carried.spec=respec(carried.spec, draft.thicknessMM, draft.gsm);
          }
          newItem=Object.assign(carried,{ id:fg2, name:draft.name, productName:draft.name, cat:"FG",
            uom:draft.uom||"KG", group:draft.group||null,
            typeCode:fg2.replace(/^FG-/,""), thicknessMM:draft.thicknessMM, gsm:draft.gsm,
            cost:draft.cost, price:draft.price, hsn:draft.hsn,
            reorder:0, safety:0, lead:7, abc:"B", moq:0, active:true,
            barcode:"890"+Math.floor(Math.random()*1e7) });
          // the imported catalogue keeps the series under `series` too
          if(copying) newItem.series=draft.group||null;
          ENG.data.items.push(newItem);
          openMove={ id:U.genMoveId(), date:DB.helpers.iso(DB.helpers.today()), itemId:fg2,
            wh:"WH-FG", type:"OPEN", qty:0, rate:newItem.cost, ref:"NEW",
            note: copying ? ("Product created by copying the BOM of "+copySrcId)
                          : "Product created with its BOM" };
          ENG.data.movements.push(openMove);
        }
        ENG.data.boms[fg2]=next;
        mo.close();
        toast(editing ? ("BOM updated for "+fg2)
          : newMode ? (draft.name+(copying?(" created — a copy of "+copyName):" created with its BOM"))
          : ("BOM created for "+fg2),
          {type:"ok",title:newMode?(copying?"Product copied":"New product"):undefined});
        App.saveDelta(async()=>{
          if(newItem){ await DB.items.put(newItem); await DB.movements.add(openMove); }
          await DB.boms.save(fg2,next);
        });
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
    newWO:  { mod:"production", create:true, ic:"⚙️", label:"New Work Order", run:()=>App.go("production",{openNew:true}) },
    newBOM: { mod:"bom", create:true, ic:"🧬", label:"Create BOM",     run:()=>App.go("bom",{openNew:true}) },
  });
})();
