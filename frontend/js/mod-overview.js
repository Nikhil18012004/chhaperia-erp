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
        h("button",{class:"btn primary",onclick:()=>App.go("production"),html:"⚙️ New Work Order"})
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
    const flow=chartCard("Production · Sales · Receipts","Last 30 days (kg)",[
      legendDot("var(--c1)","Produced"), legendDot("var(--c3)","Sold"), legendDot("var(--c2)","Received")
    ],260);
    flow.classList.add("span-8");
    row1.appendChild(flow);

    const catData=ENG.stockByCategory();
    const dn=donutCard("Stock Value by Category", catData, ENG.money(catData.reduce((s,d)=>s+d.value,0)), "total");
    dn.classList.add("span-4");
    row1.appendChild(dn);
    root.appendChild(row1);
    requestAnimationFrame(()=>Charts.line(flow._canvas,{labels:ser.labels, series:[
      {name:"Produced", data:ser.prod, color:cssv("--c1")},
      {name:"Sold", data:ser.sold, color:cssv("--c3")},
      {name:"Received", data:ser.recv, color:cssv("--c2")},
    ]}));

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
      h("div",{class:"barlist"}, watch.map(x=>h("div",{style:"display:grid;grid-template-columns:1fr auto;gap:6px;font-size:12.5px;padding:7px 0;border-bottom:1px solid var(--line)"},[
        h("div",{},[ h("div",{class:"strong",style:"font-weight:700",text:trim(x.it.name,26)}),
          h("div",{class:"muted",style:"font-size:11px",text:x.it.id}) ]),
        h("div",{class:"right"},[
          h("div",{html:`<span class="badge-s s-ok">▲ ${ENG.num(x.st.pIn)}</span> <span class="badge-s s-warn">▼ ${ENG.num(x.st.pOut)}</span>`}),
          h("div",{class:"muted",style:"font-size:10.5px;margin-top:3px",text:"ATP "+ENG.num(x.st.atp)+" "+x.it.uom})
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
            h("div",{class:"right muted",style:"font-size:11px;margin-top:4px",text:w.progress+"% · "+ENG.num(w.qty)+" "+it.uom})
          ]);
        }))
      ]);
      root.appendChild(woCard);
    }
  }};

  /* ============== ANALYTICS ============== */
  M.analytics = { title:"Analytics", sub:"Deep insights & forecasting", render(root){
    root.appendChild(pageHead("Analytics & Insights","Trends, ABC classification and demand forecasting",[
      h("button",{class:"btn",onclick:()=>App.go("reports"),text:"📄 Export Reports"})
    ]));

    /* trend selector */
    const ser90=ENG.dailySeries(90);
    const trend=chartCard("90-Day Movement Trend","Production, sales & receipts (kg/day)",[
      legendDot("var(--c1)","Produced"), legendDot("var(--c3)","Sold"), legendDot("var(--c2)","Received")
    ],280);
    root.appendChild(trend);
    requestAnimationFrame(()=>Charts.line(trend._canvas,{labels:ser90.labels,series:[
      {name:"Produced",data:ser90.prod,color:cssv("--c1")},
      {name:"Sold",data:ser90.sold,color:cssv("--c3")},
      {name:"Received",data:ser90.recv,color:cssv("--c2")},
    ]}));

    const row=h("div",{class:"grid cols-12",style:"margin-top:16px"});

    /* sales by product bars */
    const sp=ENG.salesByProduct(90);
    const spCard=chartCard("Revenue by Product","Last 90 days",null,260); spCard.classList.add("span-7");
    row.appendChild(spCard);
    requestAnimationFrame(()=>Charts.bars(spCard._canvas,{labels:sp.map(s=>trim(s.name,10)),series:[
      {name:"Revenue",data:sp.map(s=>s.value),color:cssv("--accent")}],fmt:v=>ENG.money(v)}));

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
        h("div",{class:"sub",text:"Pareto by annualised consumption value"})]),
        h("div",{class:"flex gap"},[
          h("span",{class:"chip",html:`<span class="d" style="background:var(--danger)"></span>A · ${counts.A}`}),
          h("span",{class:"chip",html:`<span class="d" style="background:var(--warn)"></span>B · ${counts.B}`}),
          h("span",{class:"chip",html:`<span class="d" style="background:var(--ok)"></span>C · ${counts.C}`}),
        ])]),
      /* full table — laptops & tablets (hidden on phones via CSS) */
      abcTableWrap(table(abc, [
        {key:"name", label:"Item", render:r=>`<div class="cell-main">${esc(trim(r.it.name,40))}</div><div class="cell-sub">${r.it.id}</div>`, sort:r=>r.it.name},
        {key:"class", label:"Class", render:r=>badge(r.class==="A"?"danger":r.class==="B"?"warn":"ok", "Class "+r.class), sort:r=>r.class},
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
          ["Annual Consumption Value", ENG.money(r.annualVal)],
          ["On-hand Value", ENG.money(r.onHandVal)],
          ["On-hand Qty", ENG.num(st.onHand,2)+" "+(it.uom||"")],
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
      const fcCard=chartCard(`Demand Forecast — ${trim(it.name,28)}`,`Projected next 30 days · avg ${ENG.num(fc.avg,1)} ${it.uom}/day · total ${ENG.num(fc.projTotal)} ${it.uom}`,null,240);
      fcCard.style.marginTop="16px";
      root.appendChild(fcCard);
      requestAnimationFrame(()=>Charts.line(fcCard._canvas,{labels:fcLabels,series:[
        {name:"Forecast",data:fc.projected,color:cssv("--violet")}],fmt:v=>ENG.num(v,1)}));
    }
  }};

  /* helpers */
  function cssv(v){ return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }
  function abcTableWrap(tbl){ tbl.classList.add("abc-full"); return tbl; }
  function catLabel(id){ return (ENG.data.categories.find(c=>c.id===id)||{}).name||id; }
  function legendDot(c,t){ return h("span",{class:"chip",html:`<span class="d" style="background:${c}"></span>${esc(t)}`}); }
  function trim(s,n){ s=String(s||""); return s.length>n?s.slice(0,n-1)+"…":s; }
  function sevStyle(s){ const m={danger:"background:var(--danger-soft);color:var(--danger)",warn:"background:var(--warn-soft);color:var(--warn)",info:"background:var(--info-soft);color:var(--info)"}; return m[s]||m.info; }
})();
