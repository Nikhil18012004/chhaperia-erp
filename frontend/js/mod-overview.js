/* ============================================================
   CHHAPERIA ERP — DASHBOARD & ANALYTICS
   ============================================================ */
(function () {
  "use strict";
  const {h, esc, table, badge, meter} = UI;
  const {pageHead, kpi, chartCard, barList, donutCard, dl} = MW;

  /* ============== DASHBOARD ============== */
  M.dashboard = { title:"Dashboard", sub:"Live operational overview", render(root){
    const k = ENG.kpis();
    const ser = ENG.dailySeries(30);
    root.appendChild(pageHead("Dashboard",
      `Welcome back — here's Chhaperia's plant status for ${ENG.data.org.fyStart? "FY 2026-27":""} · ${new Date().toDateString()}`,
      [
        h("button",{class:"btn",onclick:()=>App.go("reports"),text:"📊 Reports"}),
        /* the button names the form, so it opens the form — landing on the
           Production list and leaving the operator to find the button again
           was a step this promised to skip. `openNew` is the one-shot the
           Production page already reads (and app.js drops after the render),
           the same way the ⌘K action reaches it. */
        h("button",{class:"btn primary",onclick:()=>App.go("production",{openNew:true}),html:"⚙️ New Work Order"})
      ]));

    /* KPI row */
    const kpis=h("div",{class:"grid kpi-grid compact",style:"margin-bottom:16px"},[
      kpi({icon:"💰", label:"Inventory Value", value:ENG.money(k.invValue),
        delta:"FG "+ENG.money(k.fgValue), deltaType:"flat", spark:ser.prod, sparkColor:"var(--accent)"}),
      kpi({icon:"🏬", label:"Active Warehouses", value:ENG.num(k.whActive),
        delta:(k.whActive<k.whTotal? (k.whTotal-k.whActive)+" empty of "+k.whTotal : "all "+k.whTotal+" stocked"),
        deltaType:(k.whActive<k.whTotal?"down":"up"), onClick:()=>App.go("warehouses")}),
      kpi({icon:"🛒", label:"Open Purchase Orders", value:ENG.num(k.openPO),
        delta:ENG.money(k.poValue)+" pending in", deltaType:"flat", onClick:()=>App.go("purchase")}),
      kpi({icon:"🧾", label:"Open Sales Orders", value:ENG.num(k.openSO),
        delta:ENG.money(k.soValue)+" backlog", deltaType:"up", onClick:()=>App.go("sales")}),
      kpi({icon:"⚙️", label:"Active Work Orders", value:ENG.num(k.activeWO),
        delta:ENG.num(k.prod30)+" kg made (30d)", deltaType:"up", spark:ser.sold, sparkColor:"var(--c3)", onClick:()=>App.go("production")}),
      kpi({icon:"🚨", label:"Stock Alerts", value:ENG.num(k.lowStock),
        delta:k.lowStock?"Action required":"All healthy", deltaType:k.lowStock?"down":"up", onClick:()=>App.openAlerts()}),
    ]);
    root.appendChild(kpis);

    /* main charts row */
    const row1=h("div",{class:"grid cols-12",style:"margin-bottom:16px"});
    const flowLegend=()=>h("div",{class:"chart-legend-row"},[
      legendDot("var(--c1)","Production"), legendDot("var(--c3)","Sales"), legendDot("var(--c2)","Receipts")
    ]);
    const flowSeries=()=>[
      {name:"Production", data:ser.prod, color:cssv("--c1")},
      {name:"Sales", data:ser.sold, color:cssv("--c3")},
      {name:"Receipts", data:ser.recv, color:cssv("--c2")},
    ];
    const flow=chartCard("Movements","Last 30 days (kg)",[
      h("button",{class:"btn sm ghost",title:"Expand chart",onclick:expandFlow,text:"⤢"})
    ],260);
    flow.insertBefore(flowLegend(), flow._canvas.parentElement);
    flow.classList.add("span-4");
    row1.appendChild(flow);

    function expandFlow(){
      const cv=h("canvas",{"data-h":400});
      const body=h("div",{},[
        h("div",{style:"margin-bottom:12px"},flowLegend()),
        h("div",{class:"chart-box"},cv)
      ]);
      const mo=UI.modal({title:"Movements", sub:"Production · Sales · Receipts — last 30 days (kg)", body, wide:true,
        foot:[h("button",{class:"btn ghost",onclick:()=>mo.close(),text:"Close"})]});
      Charts.soon(()=>Charts.line(cv,{labels:ser.labels, series:flowSeries()}));
    }

    const fx=fxCard();
    fx.classList.add("span-4");
    row1.appendChild(fx);

    const catData=ENG.stockByCategory();
    const dn=donutCard("Stock Value by Category", catData, ENG.money(catData.reduce((s,d)=>s+d.value,0)), "total");
    dn.classList.add("span-4");
    row1.appendChild(dn);
    root.appendChild(row1);
    Charts.soon(()=>Charts.line(flow._canvas,{labels:ser.labels, series:flowSeries()}));

    /* row 2: top products + alerts + pending */
    const row2=h("div",{class:"grid cols-12"});

    const topProd=ENG.salesByProduct(90).slice(0,6);
    const tp=h("div",{class:"card span-4"},[
      h("div",{class:"card-head"},[h("div",{},[h("h3",{text:"Top Products"}),h("div",{class:"sub",text:"Revenue · last 90 days"})])]),
      barList(topProd,{fmt:v=>ENG.money(v)})
    ]);
    row2.appendChild(tp);

    /* pending / ATP watch */
    const watch = ENG.data.items.map(it=>({it, st:ENG.status(it.id)}))
      .filter(x=>x.st.pIn>0 || x.st.pOut>0).sort((a,b)=>b.st.pOut-a.st.pOut).slice(0,7);
    const pendCard=h("div",{class:"card span-4"},[
      h("div",{class:"card-head"},[h("div",{},[h("h3",{text:"Pending Movements"}),h("div",{class:"sub",text:"Inbound (PO) vs Outbound (demand)"})])]),
      h("div",{class:"barlist"}, watch.map(x=>h("div",{style:"display:grid;grid-template-columns:1fr auto;gap:6px;font-size:13px;padding:7px 0;border-bottom:1px solid var(--line)"},[
        h("div",{},[ h("div",{class:"strong",style:"font-weight:700",text:trim(x.it.name,26)}),
          h("div",{class:"muted",style:"font-size:11px",text:x.it.id}) ]),
        h("div",{class:"right"},[
          h("div",{html:`<span class="badge-s s-ok">▲ ${ENG.num(x.st.pIn)}</span> <span class="badge-s s-warn">▼ ${ENG.num(x.st.pOut)}</span>`}),
          h("div",{class:"muted",style:"font-size:11px;margin-top:3px",text:"ATP "+ENG.qtyText(x.it,x.st.atp,0)})
        ])
      ])))
    ]);
    row2.appendChild(pendCard);

    /* alerts mini */
    const al=ENG.alerts().slice(0,6);
    const alCard=h("div",{class:"card span-4"},[
      h("div",{class:"card-head"},[h("div",{},[h("h3",{text:"Priority Alerts"}),h("div",{class:"sub",text:al.length+" items"})]),
        h("button",{class:"btn sm ghost",style:"margin-left:auto",onclick:()=>App.openAlerts(),text:"View all"})]),
      al.length?h("div",{}, al.map(a=>h("div",{class:"alert-item",style:"margin-bottom:8px",onclick:()=>a.itemId&&App.go("inventory")},[
        h("div",{class:"alert-ic sev-"+a.sev,style:sevStyle(a.sev),text:a.ic}),
        h("div",{style:"flex:1;min-width:0"},[ h("div",{class:"t",text:trim(a.title,30)}), h("div",{class:"d",text:a.desc}) ])
      ]))):h("div",{class:"empty"},[h("div",{class:"big",text:"✓"}),h("div",{text:"No active alerts"})])
    ]);
    row2.appendChild(alCard);

    root.appendChild(row2);

    /* row 3: open work orders progress */
    const wos=ENG.data.workorders.filter(w=>w.status!=="Completed"&&w.status!=="Dispatched").slice(0,6);
    if(wos.length){
      const woCard=h("div",{class:"card",style:"margin-top:16px"},[
        h("div",{class:"card-head"},[h("div",{},[h("h3",{text:"Work Orders in Progress"}),h("div",{class:"sub",text:"Live production floor"})]),
          h("button",{class:"btn sm ghost",style:"margin-left:auto",onclick:()=>App.go("production"),text:"Open Production"})]),
        h("div",{class:"grid cols-3"}, wos.map(w=>{
          const it=ENG.item(w.itemId);
          return h("div",{class:"card hover",style:"box-shadow:none;background:var(--panel-2)"},[
            h("div",{class:"flex between aic"},[ h("div",{class:"strong",style:"font-weight:700",text:w.id}),
              h("span",{html:badge(w.status==="In Progress"||w.status==="In Production"?"info":"warn", w.status)}) ]),
            h("div",{class:"muted",style:"font-size:12px;margin:6px 0",text:trim(it.name,34)}),
            h("div",{class:"flex between",style:"font-size:11px;margin-bottom:6px"},[
              h("span",{class:"muted",text:w.line}), h("span",{class:"muted",text:"Due "+w.due}) ]),
            h("div",{html:meter(w.progress, w.progress>66?"ok":w.progress>33?"warn":"danger")}),
            h("div",{class:"right muted",style:"font-size:11px;margin-top:4px",text:w.progress+"% · "+ENG.qtyText(it,w.qty,0)})
          ]);
        }))
      ]);
      root.appendChild(woCard);
    }
  }};

  /* ============== ANALYTICS ============== */
  M.analytics = { title:"Analytics", sub:"Deep insights & forecasting", render(root){
    root.appendChild(pageHead("Analytics & Insights","Trends, ABC classification and demand forecasting",[
      h("button",{class:"btn",onclick:()=>App.go("reports"),text:"📄 Reports"})
    ]));

    /* trend selector */
    const ser90=ENG.dailySeries(90);
    const trend=chartCard("90-Day Movement Trend","Production, sales & receipts (kg/day)",[
      legendDot("var(--c1)","Produced"), legendDot("var(--c3)","Sold"), legendDot("var(--c2)","Received")
    ],280);
    root.appendChild(trend);
    Charts.soon(()=>Charts.line(trend._canvas,{labels:ser90.labels,series:[
      {name:"Produced",data:ser90.prod,color:cssv("--c1")},
      {name:"Sold",data:ser90.sold,color:cssv("--c3")},
      {name:"Received",data:ser90.recv,color:cssv("--c2")},
    ]}));

    const row=h("div",{class:"grid cols-12",style:"margin-top:16px"});

    /* sales by product — ranked bar list (DOM, not canvas). Each product
       is its own row so the full name can wrap and stays readable on
       every device; the bar shows revenue relative to the top seller. */
    const sp=ENG.salesByProduct(90).slice(0,10);
    const spMax=Math.max(...sp.map(s=>s.value),1);
    const spTotal=sp.reduce((a,x)=>a+x.value,0)||1;
    const spCard=h("div",{class:"card span-7"},[
      h("div",{class:"card-head"},[h("div",{},[h("h3",{text:"Revenue by Product"}),
        h("div",{class:"sub",text:"Top "+sp.length+" · last 90 days"})])]),
      sp.length? h("div",{class:"rankbars"}, sp.map((s,i)=>{
        const fill=h("span",{class:"rankbar-fill"});
        requestAnimationFrame(()=>{ fill.style.width=(s.value/spMax*100).toFixed(1)+"%"; });
        return h("div",{class:"rankbar"},[
          h("div",{class:"rankbar-top"},[
            h("span",{class:"rankbar-rank",text:"#"+(i+1)}),
            h("span",{class:"rankbar-name",text:s.name}),
            h("span",{class:"rankbar-val"},[ document.createTextNode(ENG.money(s.value)),
              h("span",{class:"sh",text:(s.value/spTotal*100).toFixed(0)+"%"}) ])
          ]),
          h("div",{class:"rankbar-track"}, fill)
        ]);
      })) : h("div",{class:"empty"},[h("div",{class:"big",text:"∅"}),h("div",{text:"No sales in range"})])
    ]);
    row.appendChild(spCard);

    /* supplier spend donut */
    const ps=ENG.purchaseBySupplier(120).slice(0,6);
    const psCard=donutCard("Supplier Spend (120d)", ps, ENG.money(ps.reduce((s,d)=>s+d.value,0)), "spend");
    psCard.classList.add("span-5");
    row.appendChild(psCard);
    root.appendChild(row);

    /* ABC analysis */
    const abc=ENG.abcAnalysis();
    const counts={A:0,B:0,C:0}; abc.forEach(r=>counts[r.class]++);
    const abcCard=h("div",{class:"card",style:"margin-top:16px"},[
      h("div",{class:"card-head"},[h("div",{},[h("h3",{text:"ABC Inventory Classification"}),
        h("div",{class:"sub",text:"Pareto by purchase + sales volume · re-ranks automatically as entries are recorded"})]),
        h("div",{class:"flex gap"},[
          h("span",{class:"chip",html:`<span class="d" style="background:var(--danger)"></span>A · ${counts.A}`}),
          h("span",{class:"chip",html:`<span class="d" style="background:var(--warn)"></span>B · ${counts.B}`}),
          h("span",{class:"chip",html:`<span class="d" style="background:var(--ok)"></span>C · ${counts.C}`}),
        ])]),
      /* full table — laptops & tablets (hidden on phones via CSS) */
      abcTableWrap(table(abc, [
        {key:"name", label:"Item", render:r=>`<div class="cell-main">${esc(trim(r.it.name,40))}</div><div class="cell-sub">${r.it.id}</div>`, sort:r=>r.it.name},
        {key:"class", label:"Class", render:r=>badge(r.class==="A"?"danger":r.class==="B"?"warn":"ok", "Class "+r.class), sort:r=>r.class},
        {key:"vol90", label:"90d Volume", num:true, render:r=>esc(ENG.qtyText(r.it,r.vol90,1)), sort:r=>r.vol90},
        {key:"annualVal", label:"Annual Value", num:true, render:r=>ENG.money(r.annualVal), sort:r=>r.annualVal},
        {key:"onHandVal", label:"On-hand Value", num:true, render:r=>ENG.money(r.onHandVal), sort:r=>r.onHandVal},
        {key:"cumPct", label:"Cumulative %", num:true, render:r=>r.cumPct.toFixed(1)+"%", sort:r=>r.cumPct},
      ], {empty:"No data"})),
      /* phones — compact class + name list; tap a row for full details */
      abc.length ? h("div",{class:"abc-mobile"}, abc.map(r=>
        h("button",{class:"abc-row",onclick:()=>abcDetail(r)},[
          h("span",{class:"abc-cls abc-"+r.class,text:r.class}),
          h("span",{class:"abc-nm"},[
            h("span",{class:"cell-main",text:trim(r.it.name,40)}),
            h("span",{class:"cell-sub",text:r.it.id})
          ]),
          h("span",{class:"abc-chev","aria-hidden":"true",text:"›"})
        ])
      )) : h("div",{class:"abc-mobile empty",text:"No data"})
    ]);
    root.appendChild(abcCard);

    /* details popup for a single ABC material (phone list) */
    function abcDetail(r){
      const it=r.it, st=ENG.stock(it.id);
      const clsName={A:"Class A — high value",B:"Class B — moderate",C:"Class C — low value"}[r.class];
      const body=h("div",{},[
        h("div",{style:"margin-bottom:16px"},
          h("span",{html:badge(r.class==="A"?"danger":r.class==="B"?"warn":"ok","Class "+r.class)})),
        dl([
          ["Item Code", it.id],
          ["Category", catLabel(it.cat)],
          ["Classification", clsName],
          ["90d Purchase + Sales Volume", ENG.qtyText(it,r.vol90,1)],
          ["Annualised Activity Value", ENG.money(r.annualVal)],
          ["On-hand Value", ENG.money(r.onHandVal)],
          ["On-hand Qty", ENG.qtyText(it,st.onHand,2)],
          ["Cumulative %", r.cumPct.toFixed(1)+"%"],
          ["Unit Cost", ENG.money(it.cost||0)],
        ])
      ]);
      const mo=UI.modal({title:it.name, sub:"ABC Inventory Classification", body,
        foot:[h("button",{class:"btn ghost",onclick:()=>mo.close(),text:"Close"}),
          h("button",{class:"btn primary",onclick:()=>{mo.close();App.go("inventory");},text:"Open in Stock Items"})]});
    }

    /* forecast for top item */
    const topItem=sp[0]; if(topItem){
      const it=ENG.item(topItem.id); const fc=ENG.forecast(it.id,30);
      const fcLabels=[]; const base=DB.helpers.today().getTime();
      for(let i=1;i<=30;i++) fcLabels.push(DB.helpers.iso(base+i*DB.helpers.DAY));
      const fcCard=chartCard(`Demand Forecast — ${trim(it.name,28)}`,`Projected next 30 days · avg ${ENG.qtyText(it,fc.avg,1)}/day · total ${ENG.qtyText(it,fc.projTotal,0)}`,null,240);
      fcCard.style.marginTop="16px";
      root.appendChild(fcCard);
      Charts.soon(()=>Charts.line(fcCard._canvas,{labels:fcLabels,series:[
        {name:"Forecast",data:fc.projected,color:cssv("--violet")}],fmt:v=>ENG.num(v,1)}));
    }
  }};

  /* ----- live currency exchange (INR base) ----- */
  /* ---- national flags ----------------------------------------------------
     Drawn as inline SVG, not emoji: Windows ships no flag glyph, so 🇺🇸 comes
     out as bare "US" letters in Chrome and Edge. Each is deliberately
     simplified — at 21×14 px the fine detail is invisible anyway — but reads
     correctly at a glance. All share a 30×20 viewBox so the column lines up.
     The Union Jack skips the saltire counterchange for the same reason. */
  const STAR="M 0,-1 L .225,-.309 L .951,-.309 L .363,.118 L .588,.809 "+
             "L 0,.382 L -.588,.809 L -.363,.118 L -.951,-.309 L -.225,-.309 Z";
  const star=(x,y,r)=>`<path d="${STAR}" transform="translate(${x} ${y}) scale(${r})"/>`;
  const FLAG_SVG={
    US:(()=>{                                   // 13 stripes + starred canton
      let s='<rect width="30" height="20" fill="#fff"/>';
      for(let i=0;i<13;i+=2)
        s+=`<rect y="${(i*20/13).toFixed(2)}" width="30" height="${(20/13).toFixed(2)}" fill="#b22234"/>`;
      s+='<rect width="12" height="10.77" fill="#3c3b6e"/>';
      let st="";
      for(let r=0;r<5;r++) for(let c=0;c<(r%2?5:6);c++)
        st+=star(1.1+c*2+(r%2?1:0), 1.15+r*2.15, .6);
      return s+`<g fill="#fff">${st}</g>`;
    })(),
    EU:(()=>{                                   // 12 gold stars on a circle
      let st="";
      for(let i=0;i<12;i++){
        const a=i*Math.PI/6;
        st+=star(15+Math.sin(a)*6, 10-Math.cos(a)*6, 1.05);
      }
      return `<rect width="30" height="20" fill="#039"/><g fill="#fc0">${st}</g>`;
    })(),
    GB:'<rect width="30" height="20" fill="#012169"/>'+
       '<path d="M0,0 30,20 M30,0 0,20" stroke="#fff" stroke-width="4.2"/>'+
       '<path d="M0,0 30,20 M30,0 0,20" stroke="#c8102e" stroke-width="2"/>'+
       '<path d="M15,0 V20 M0,10 H30" stroke="#fff" stroke-width="6.6"/>'+
       '<path d="M15,0 V20 M0,10 H30" stroke="#c8102e" stroke-width="3.9"/>',
    AE:'<rect width="30" height="20" fill="#00732f"/>'+
       '<rect y="6.67" width="30" height="6.67" fill="#fff"/>'+
       '<rect y="13.34" width="30" height="6.66" fill="#000"/>'+
       '<rect width="7.5" height="20" fill="#f00"/>',
    CN:'<rect width="30" height="20" fill="#de2910"/><g fill="#fd0">'+
       star(5.4,5.2,2.7)+star(10.4,2,.85)+star(12.3,4.1,.85)+
       star(12.3,6.7,.85)+star(10.4,8.7,.85)+'</g>',
    JP:'<rect width="30" height="20" fill="#fff"/>'+
       '<circle cx="15" cy="10" r="6" fill="#bc002d"/>',
    IN:'<rect width="30" height="20" fill="#f93"/>'+
       '<rect y="6.67" width="30" height="6.67" fill="#fff"/>'+
       '<rect y="13.34" width="30" height="6.66" fill="#128807"/>'+
       '<g fill="none" stroke="#008" stroke-width=".45">'+
       '<circle cx="15" cy="10" r="2.6"/>'+
       '<path d="M15,7.4 V12.6 M12.4,10 H17.6 M13.16,8.16 16.84,11.84 M16.84,8.16 13.16,11.84"/></g>'+
       '<circle cx="15" cy="10" r=".55" fill="#008"/>',
  };
  /* the flag cell — falls back to the country code if we have no artwork */
  function flagEl(cc,name){
    const svg=FLAG_SVG[cc];
    return h("span",{class:"fx-flag"+(svg?"":" txt"),role:"img",
      "aria-label":(name||cc)+" flag",title:name||cc},
      svg?[h("span",{class:"fx-flag-svg",html:`<svg viewBox="0 0 30 20">${svg}</svg>`})]:cc);
  }

  // `name` is the currency (shown in the row); `country` only labels the flag
  const FX_LIST=[
    {code:"USD", name:"US Dollar",      cc:"US", country:"United States"},
    {code:"EUR", name:"Euro",           cc:"EU", country:"European Union"},
    {code:"GBP", name:"British Pound",  cc:"GB", country:"United Kingdom"},
    {code:"AED", name:"UAE Dirham",     cc:"AE", country:"United Arab Emirates"},
    {code:"CNY", name:"Chinese Yuan",   cc:"CN", country:"China"},
    {code:"JPY", name:"Japanese Yen",   cc:"JP", country:"Japan"},
  ];
  /* Currency names and symbols moved to ccy.js when the customer master began
     deriving a client's billing currency from their country — one table, so a
     name can never read one way here and another on an invoice. What the
     converter OFFERS is unchanged: CCY.CONVERTER_CODES is the same set of real
     currencies this card has always listed, which keeps the crypto and obscure
     feeds in the /api/fx payload out of the pickers. */
  const ccySym  =c=>CCY.sym(c);
  // collapsed picker = "USD $"; each row of the open list adds the full name
  const ccyShort =c=>CCY.short(c);
  const ccyFull  =c=>CCY.full(c);
  /* ---- currency picker ---------------------------------------------------
     A native <select> hands its popup to the OS to draw, and on Windows that
     renderer has no colour-emoji support — the flags simply never appeared in
     the From/To lists even though they show fine in the rate list below. So
     the pickers are plain HTML listboxes instead. They expose the slice of the
     <select> API the converter uses (.value, .codes, .setCodes, and a "change"
     event, so `picker.onchange = fn` keeps working). */
  let fxOpenPick=null;                        // at most one popup open at a time
  let fxPickWired=false;
  function fxWirePick(){
    if(fxPickWired||typeof document==="undefined") return; fxPickWired=true;
    document.addEventListener("mousedown",e=>{
      if(!fxOpenPick) return;
      const inside=e.target.closest&&e.target.closest(".fx-pick");
      if(inside!==fxOpenPick) fxOpenPick.closePick();
    });
    const reflow=()=>{ if(fxOpenPick) fxOpenPick.reposition(); };
    window.addEventListener("scroll",reflow,true);   // capture → catches inner scrollers
    window.addEventListener("resize",reflow);
  }
  function ccyPicker(label){
    fxWirePick();
    const cur=h("span",{class:"fx-pick-cur",text:"—"});
    const btn=h("button",{class:"select fx-sel fx-pick-btn",type:"button",role:"combobox",
      "aria-haspopup":"listbox","aria-expanded":"false","aria-label":label},
      [cur, h("span",{class:"fx-pick-caret",text:"▾"})]);
    const pop=h("div",{class:"fx-pick-pop",role:"listbox","aria-label":label,hidden:true});
    const wrap=h("div",{class:"fx-pick"},[btn,pop]);
    let codes=[], value="";

    function paintOpts(){
      pop.innerHTML="";
      codes.forEach(c=>{
        pop.appendChild(h("div",{class:"fx-opt",role:"option","aria-selected":"false","data-code":c,
          onclick:()=>{ setValue(c,true); closePick(true); }},[
          h("span",{class:"fx-code",text:c}),
          h("span",{class:"fx-opt-sym",text:ccySym(c)}),
          h("span",{class:"fx-name",text:CCY.name(c)}),
        ]));
      });
      mark();
    }
    function mark(){
      pop.querySelectorAll(".fx-opt").forEach(o=>{
        const on=o.getAttribute("data-code")===value;
        o.classList.toggle("sel",on); o.setAttribute("aria-selected",on?"true":"false");
      });
    }
    function setValue(c,fire){
      if(!c||!CCY.known(c)) return;
      value=c; cur.textContent=ccyShort(c); mark();
      if(fire) wrap.dispatchEvent(new Event("change"));
    }
    function setActive(el){
      pop.querySelectorAll(".fx-opt.act").forEach(o=>o.classList.remove("act"));
      if(el){ el.classList.add("act"); el.scrollIntoView({block:"nearest"}); }
    }
    function reposition(){
      if(pop.hidden) return;
      const r=btn.getBoundingClientRect();
      const popH=Math.min(272, pop.scrollHeight||272);
      const below=window.innerHeight-r.bottom;
      // the picker is the row's right-hand column, so the wider popup grows leftwards
      pop.style.left="auto"; pop.style.right=(window.innerWidth-r.right)+"px";
      if(below<popH+8 && r.top>below){ pop.style.top="auto"; pop.style.bottom=(window.innerHeight-r.top+4)+"px"; }
      else { pop.style.bottom="auto"; pop.style.top=(r.bottom+4)+"px"; }
    }
    function openPick(){
      if(fxOpenPick&&fxOpenPick!==wrap) fxOpenPick.closePick();
      pop.hidden=false; btn.setAttribute("aria-expanded","true"); fxOpenPick=wrap;
      reposition();
      setActive(pop.querySelector(".fx-opt.sel")||pop.firstElementChild);
    }
    function closePick(refocus){
      pop.hidden=true; btn.setAttribute("aria-expanded","false");
      if(fxOpenPick===wrap) fxOpenPick=null;
      if(refocus) btn.focus();
    }

    // type-ahead: the one <select> habit worth keeping — "e","u" jumps to EUR
    let taBuf="", taAt=0;
    function typeAhead(e){
      if(e.key.length!==1||e.ctrlKey||e.metaKey||e.altKey) return;
      const now=Date.now();
      taBuf=(now-taAt>900?"":taBuf)+e.key; taAt=now;
      const q=taBuf.toUpperCase();
      const hit=codes.find(c=>c.startsWith(q))
             || codes.find(c=>CCY.name(c).toUpperCase().startsWith(q));
      if(!hit) return;
      e.preventDefault();
      if(pop.hidden) setValue(hit,true);
      else setActive(pop.querySelector('.fx-opt[data-code="'+hit+'"]'));
    }
    btn.addEventListener("click",()=>{ pop.hidden?openPick():closePick(); });
    btn.addEventListener("keydown",e=>{
      if(e.key==="Escape"){ if(!pop.hidden){ e.preventDefault(); closePick(true); } return; }
      if(pop.hidden){
        if(e.key==="ArrowDown"||e.key==="ArrowUp"||e.key==="Enter"||e.key===" "){ e.preventDefault(); openPick(); }
        else typeAhead(e);
        return;
      }
      const items=[...pop.querySelectorAll(".fx-opt")]; if(!items.length) return;
      const i=items.findIndex(o=>o.classList.contains("act"));
      if(e.key==="ArrowDown"){ e.preventDefault(); setActive(items[Math.min(items.length-1,i+1)]); }
      else if(e.key==="ArrowUp"){ e.preventDefault(); setActive(items[Math.max(0,(i<0?0:i-1))]); }
      else if(e.key==="Home"){ e.preventDefault(); setActive(items[0]); }
      else if(e.key==="End"){ e.preventDefault(); setActive(items[items.length-1]); }
      else if(e.key==="Enter"||e.key===" "){
        e.preventDefault();
        if(i>=0){ setValue(items[i].getAttribute("data-code"),true); closePick(true); }
      }
      else typeAhead(e);
    });

    wrap.setCodes=cs=>{ codes=cs.slice(); paintOpts(); };
    wrap.closePick=closePick; wrap.reposition=reposition;
    Object.defineProperty(wrap,"codes",{get:()=>codes});
    Object.defineProperty(wrap,"value",{get:()=>value, set:v=>setValue(v,false)});
    return wrap;
  }

  const FX_POLL_MS=60000;
  // fxRates = ₹ per 1 unit of each currency; fxShown = the exact digits Google
  // prints, rendered verbatim so the card reads the same as a Google search.
  // Google is the only source — a currency Google can't be read for shows "—"
  // rather than a number from anywhere else.
  let fxRates=null, fxShown=null, fxAsOf=null, fxChange=null,
      fxUnavailable=[], fxFetchedAt=0, fxStale=false;

  function fxCard(){
    const stamp=h("div",{class:"sub",text:"Fetching live rates…"});
    const list=h("div",{class:"fx-list"});

    /* converter — labelled From row (amount + currency), ⇅, To row (result +
       currency), then the unit rate the result was computed from */
    const amt=h("input",{class:"input fx-amt",type:"number",value:"1",min:"0",step:"any","aria-label":"Amount"});
    // Native <select> popups are drawn by the OS on Windows, which silently
    // drops colour emoji — the flags vanished there. These are HTML listboxes
    // so the flag renders in the picker exactly as it does in the rate list.
    const selFrom=ccyPicker("From currency"), selTo=ccyPicker("To currency");
    const out=h("div",{class:"fx-out",text:"—"});
    const rate=h("div",{class:"fx-rate",text:""});
    const field=(lbl,ctl)=>h("div",{class:"fx-field"},[h("span",{class:"fx-lbl",text:lbl}),ctl]);
    const conv=h("div",{class:"fx-conv"},[
      h("div",{class:"fx-conv-row"},[field("Amount",amt), field("From",selFrom)]),
      h("div",{class:"fx-swap-wrap"},[
        h("button",{class:"icon-btn fx-swap",title:"Swap currencies","aria-label":"Swap currencies",onclick:()=>{
          const a=selFrom.value; selFrom.value=selTo.value; selTo.value=a;
          convert();
        },text:"⇅"})
      ]),
      h("div",{class:"fx-conv-row"},[field("Converted",out), field("To",selTo)]),
      rate,
    ]);
    amt.oninput=convert; selFrom.onchange=convert; selTo.onchange=convert;

    function fillSelects(){
      if(selFrom.codes.length) return;                 // populate once
      // the converter's own set, listed "CODE SYM — Full Name". The list is
      // not limited to what the payload carries: the card fetches only the
      // six it displays, and any other pair is pulled from Google on demand.
      // Sorted by the NAME, not the code: the name is what you read down the
      // list, and code order scatters it (AED "UAE Dirham" would lead, CHF
      // "Swiss Franc" would sit between Canadian and Chinese).
      const codes=CCY.sortedByName(CCY.CONVERTER_CODES);
      selFrom.setCodes(codes); selTo.setCodes(codes);
      selFrom.value="USD"; selTo.value="INR";
    }

    /* The unit rate for any pair, as Google quotes that pair. Deriving USD→EUR
       by dividing two INR quotes would NOT equal Google's own USD-EUR figure,
       so anything that isn't already on the card is fetched directly. */
    const pairCache=new Map();                       // "USD-EUR" -> {rate,shown,at}
    async function unitRate(from,to){
      if(from===to) return {rate:1,shown:"1"};
      // X→INR is already on the card, and that value IS Google's X-INR quote
      if(to==="INR"&&fxRates&&fxRates[from]) return {rate:fxRates[from],shown:fxShown[from]};
      const key=from+"-"+to, hit=pairCache.get(key);
      if(hit&&Date.now()-hit.at<FX_POLL_MS) return hit;
      const res=await fetch(`/api/fx/pair?from=${from}&to=${to}`);
      if(!res.ok) throw new Error("HTTP "+res.status);
      const j=await res.json();
      if(!(j.rate>0)) throw new Error("no rate");
      const rec={rate:j.rate,shown:j.shown,at:Date.now()};
      pairCache.set(key,rec);
      return rec;
    }

    let convSeq=0;                                   // ignore out-of-order replies
    async function convert(){
      const seq=++convSeq;
      const v=parseFloat(amt.value), from=selFrom.value, to=selTo.value;
      if(!isFinite(v)){ out.textContent="—"; rate.textContent=""; return; }
      try{
        const u=await unitRate(from,to);
        if(seq!==convSeq) return;                    // a newer request has taken over
        const fmt=n=>n.toLocaleString("en-IN",{maximumFractionDigits:n<1?6:2});
        out.textContent=fmt(v*u.rate);               // bare number — the To picker names the currency
        rate.textContent=`1 ${from} = ${u.shown} ${to}`;   // Google's own digits
        out.title=rate.textContent;
      }catch(e){
        if(seq!==convSeq) return;
        out.textContent="—";
        rate.textContent=`Google has no rate for ${from}/${to}`;
      }
    }

    const card=h("div",{class:"card"},[
      h("div",{class:"card-head"},[h("div",{},[h("h3",{text:"Currency Exchange"}), stamp])]),
      conv,
      h("div",{class:"fx-divider"}),
      list
    ]);

    function paint(){
      list.innerHTML="";
      FX_LIST.forEach(c=>{
        // Google's printed digits, verbatim — NOT re-rounded. Re-rounding to 2dp
        // is what used to make the card read ₹95.42 while Google showed 95.4276.
        const txt=fxShown&&fxShown[c.code];
        const chg=fxChange&&fxChange[c.code];              // Google's own "today" move
        const dir=!chg?0:(/^\+/.test(chg)?1:/^-/.test(chg)?-1:0);
        const asOf=fxAsOf&&fxAsOf[c.code];
        const row=h("div",{class:"fx-row"},[
          flagEl(c.cc,c.country),
          h("span",{class:"fx-code",text:c.code}),
          h("span",{class:"fx-name",text:c.name}),
          txt
            ? h("span",{class:"fx-val"},[
                document.createTextNode("₹"+txt),
                h("span",{class:"fx-dir "+(dir>0?"up":dir<0?"down":"flat"),
                  text:dir>0?"▲":dir<0?"▼":"–"})
              ])
            : h("span",{class:"fx-val fx-na",text:"—"})
        ]);
        /* Click a row to open the very page this figure was read from. The
           office used to check against the Google SEARCH box, which quotes a
           different feed (Morningstar) and always disagreed by a few paise —
           this puts the matching page one click away. */
        const url="https://www.google.com/finance/quote/"+c.code+"-INR";
        row.title=txt
          ? `Google Finance: 1 ${c.code} = ₹${txt}${asOf?"  ·  as of "+asOf:""}`
            +`${chg?"  ·  "+chg+" today":""}\nClick to open this rate on Google Finance`
          : `Google's rate for ${c.code} could not be read — no other source is used`;
        row.style.cursor="pointer";
        row.onclick=()=>window.open(url,"_blank","noopener");
        list.appendChild(row);
      });
      const na=fxUnavailable.length?" · "+fxUnavailable.join(", ")+" unavailable":"";
      stamp.textContent="Source: Google Finance"+na+
        (fxStale?" · STALE, Google unreachable":"")+
        " · fetched "+new Date(fxFetchedAt).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});
      stamp.title="Every figure here is Google Finance's own published number, shown to "+
        "the same digits Google shows. Click any row to open that rate on Google Finance "+
        "and compare. Note: Google's SEARCH box quotes a different feed (Morningstar) and "+
        "will read a few paise apart — that is two Google feeds disagreeing, not an error here.";
      fillSelects(); convert();
    }

    async function load(force){
      if(!force && fxRates && Date.now()-fxFetchedAt<FX_POLL_MS){ paint(); return; }
      try{
        const res=await fetch("/api/fx");
        if(!res.ok) throw new Error("HTTP "+res.status);
        const j=await res.json();
        if(!j.rates||!j.shown) throw new Error("bad response");
        fxRates=j.rates; fxShown=j.shown; fxAsOf=j.asOf||{}; fxChange=j.change||{};
        fxUnavailable=j.unavailable||[]; fxStale=!!j.stale;
        fxFetchedAt=j.fetchedAt||Date.now();
        paint();
      }catch(e){
        if(fxRates){ paint(); stamp.textContent+=" · refresh failed, showing last rates"; }
        else stamp.textContent="Live rates unavailable — retrying…";
      }
    }

    load(false);
    const t=setInterval(()=>{
      if(!card.isConnected){ clearInterval(t); return; }
      load(true);
    }, FX_POLL_MS);
    return card;
  }

  /* helpers */
  function cssv(v){ return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }
  function abcTableWrap(tbl){ tbl.classList.add("abc-full"); return tbl; }
  function catLabel(id){ return (ENG.data.categories.find(c=>c.id===id)||{}).name||id; }
  function legendDot(c,t){ return h("span",{class:"chip",html:`<span class="d" style="background:${c}"></span>${esc(t)}`}); }
  function trim(s,n){ s=String(s||""); return s.length>n?s.slice(0,n-1)+"…":s; }
  function sevStyle(s){ const m={danger:"background:var(--danger-soft);color:var(--danger)",warn:"background:var(--warn-soft);color:var(--warn)",info:"background:var(--info-soft);color:var(--info)"}; return m[s]||m.info; }
})();
