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
      requestAnimationFrame(()=>Charts.line(cv,{labels:ser.labels, series:flowSeries()}));
    }

    const fx=fxCard();
    fx.classList.add("span-4");
    row1.appendChild(fx);

    const catData=ENG.stockByCategory();
    const dn=donutCard("Stock Value by Category", catData, ENG.money(catData.reduce((s,d)=>s+d.value,0)), "total");
    dn.classList.add("span-4");
    row1.appendChild(dn);
    root.appendChild(row1);
    requestAnimationFrame(()=>Charts.line(flow._canvas,{labels:ser.labels, series:flowSeries()}));

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
      h("button",{class:"btn",onclick:()=>App.go("reports"),text:"📄 Reports"})
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
        {key:"vol90", label:"90d Volume", num:true, render:r=>ENG.num(r.vol90,1)+" "+(r.it.uom||""), sort:r=>r.vol90},
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
          ["90d Purchase + Sales Volume", ENG.num(r.vol90,1)+" "+(it.uom||"")],
          ["Annualised Activity Value", ENG.money(r.annualVal)],
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

  /* ----- live currency exchange (INR base) ----- */
  const FX_LIST=[
    {code:"USD", name:"US Dollar",      flag:"🇺🇸"},
    {code:"EUR", name:"Euro",           flag:"🇪🇺"},
    {code:"GBP", name:"British Pound",  flag:"🇬🇧"},
    {code:"AED", name:"UAE Dirham",     flag:"🇦🇪"},
    {code:"CNY", name:"Chinese Yuan",   flag:"🇨🇳"},
    {code:"JPY", name:"Japanese Yen",   flag:"🇯🇵"},
  ];
  // Real currencies for the converter dropdowns: code → [full name, symbol].
  // Only codes listed here appear in the pickers, which also keeps the crypto
  // and obscure feeds out of the /api/fx payload from cluttering the list.
  // Gulf/Arabic currencies use their common Latin symbols (Dh, SR, KD …) — the
  // native RTL glyphs (د.إ) reorder unpredictably inside a Latin option label.
  const CCY_META={
    INR:["Indian Rupee","₹"],        USD:["US Dollar","$"],
    EUR:["Euro","€"],                GBP:["British Pound","£"],
    AED:["UAE Dirham","Dh"],         SAR:["Saudi Riyal","SR"],
    JPY:["Japanese Yen","¥"],        CNY:["Chinese Yuan","CN¥"],
    SGD:["Singapore Dollar","S$"],   AUD:["Australian Dollar","A$"],
    CAD:["Canadian Dollar","C$"],    CHF:["Swiss Franc","Fr"],
    HKD:["Hong Kong Dollar","HK$"],  NZD:["New Zealand Dollar","NZ$"],
    SEK:["Swedish Krona","kr"],      NOK:["Norwegian Krone","kr"],
    DKK:["Danish Krone","kr"],       ZAR:["South African Rand","R"],
    THB:["Thai Baht","฿"],           MYR:["Malaysian Ringgit","RM"],
    IDR:["Indonesian Rupiah","Rp"],  PHP:["Philippine Peso","₱"],
    KRW:["South Korean Won","₩"],    TRY:["Turkish Lira","₺"],
    RUB:["Russian Ruble","₽"],       BRL:["Brazilian Real","R$"],
    MXN:["Mexican Peso","Mex$"],     PLN:["Polish Zloty","zł"],
    CZK:["Czech Koruna","Kč"],       HUF:["Hungarian Forint","Ft"],
    ILS:["Israeli Shekel","₪"],      KWD:["Kuwaiti Dinar","KD"],
    BHD:["Bahraini Dinar","BD"],     OMR:["Omani Rial","RO"],
    QAR:["Qatari Riyal","QR"],       LKR:["Sri Lankan Rupee","Rs"],
    BDT:["Bangladeshi Taka","৳"],    NPR:["Nepalese Rupee","रू"],
    PKR:["Pakistani Rupee","₨"],     EGP:["Egyptian Pound","E£"],
    VND:["Vietnamese Dong","₫"],     TWD:["Taiwan Dollar","NT$"],
  };
  const ccySym  =c=>(CCY_META[c]||[])[1]||"";
  // collapsed picker = code + symbol ("USD $"); open list = the full name too
  const ccyShort =c=>c+" "+ccySym(c);
  const ccyFull  =c=>c+" "+ccySym(c)+" — "+(CCY_META[c]||[])[0];
  const FX_POLL_MS=60000;
  // fxRates = ₹ per 1 unit of each currency, served by our backend which
  // cross-verifies a LIVE market feed against 3 independent daily sources
  let fxRates=null, fxPrev=null, fxFetchedAt=0, fxInfo="";

  function fxCard(){
    const stamp=h("div",{class:"sub",text:"Fetching live rates…"});
    const list=h("div",{class:"fx-list"});

    /* converter — labelled From row (amount + currency), ⇅, To row (result +
       currency), then the unit rate the result was computed from */
    const amt=h("input",{class:"input fx-amt",type:"number",value:"1",min:"0",step:"any","aria-label":"Amount"});
    const selFrom=h("select",{class:"select fx-sel","aria-label":"From currency"});
    const selTo=h("select",{class:"select fx-sel","aria-label":"To currency"});
    const out=h("div",{class:"fx-out",text:"—"});
    const rate=h("div",{class:"fx-rate",text:""});
    const field=(lbl,ctl)=>h("div",{class:"fx-field"},[h("span",{class:"fx-lbl",text:lbl}),ctl]);
    const conv=h("div",{class:"fx-conv"},[
      h("div",{class:"fx-conv-row"},[field("Amount",amt), field("From",selFrom)]),
      h("div",{class:"fx-swap-wrap"},[
        h("button",{class:"icon-btn fx-swap",title:"Swap currencies","aria-label":"Swap currencies",onclick:()=>{
          const a=selFrom.value; selFrom.value=selTo.value; selTo.value=a;
          shrink(selFrom); shrink(selTo); convert();
        },text:"⇅"})
      ]),
      h("div",{class:"fx-conv-row"},[field("Converted",out), field("To",selTo)]),
      rate,
    ]);
    amt.oninput=convert; selFrom.onchange=convert; selTo.onchange=convert;

    // A <select> can only display its selected option's text, so we rewrite the
    // labels around the popup: full names while the list is open, code+symbol
    // once it closes.
    function expand(sel){ for(const o of sel.options) o.textContent=ccyFull(o.value); }
    function shrink(sel){
      expand(sel);                                     // every other row stays full
      const o=sel.selectedOptions[0];
      if(o) o.textContent=ccyShort(o.value);
    }
    [selFrom,selTo].forEach(sel=>{
      ["mousedown","focus","keydown"].forEach(e=>sel.addEventListener(e,()=>expand(sel)));
      ["change","blur"].forEach(e=>sel.addEventListener(e,()=>shrink(sel)));
    });

    function fillSelects(){
      if(selFrom.options.length) return;               // populate once
      // only real currencies we can name, listed "CODE SYM — Full Name"
      Object.keys(fxRates).filter(c=>CCY_META[c]).sort().forEach(c=>{
        selFrom.appendChild(h("option",{value:c,text:ccyFull(c)}));
        selTo.appendChild(h("option",{value:c,text:ccyFull(c)}));
      });
      selFrom.value="USD"; selTo.value="INR";
      shrink(selFrom); shrink(selTo);
    }
    function convert(){
      if(!fxRates){ out.textContent="—"; rate.textContent=""; return; }
      const v=parseFloat(amt.value);
      const rf=fxRates[selFrom.value], rt=fxRates[selTo.value];   // ₹ per unit
      if(!isFinite(v)||!rf||!rt){ out.textContent="—"; rate.textContent=""; return; }
      const res=v*rf/rt, unit=rf/rt;
      const fmt=n=>n.toLocaleString("en-IN",{maximumFractionDigits:n<1?6:2});
      out.textContent=(ccySym(selTo.value)||"")+" "+fmt(res);
      rate.textContent=`1 ${selFrom.value} = ${fmt(unit)} ${selTo.value}`;
      out.title=rate.textContent;
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
        const perUnit=fxRates[c.code];                       // ₹ per 1 unit of foreign currency
        if(!perUnit) return;
        const prev=fxPrev? fxPrev[c.code] : null;
        const dir=prev==null||Math.abs(perUnit-prev)<1e-6 ? 0 : (perUnit>prev?1:-1);
        list.appendChild(h("div",{class:"fx-row"},[
          h("span",{class:"fx-flag",text:c.flag}),
          h("span",{class:"fx-code",text:c.code}),
          h("span",{class:"fx-name",text:c.name}),
          h("span",{class:"fx-val"},[
            document.createTextNode("₹"+perUnit.toFixed(perUnit<1?4:2)),
            h("span",{class:"fx-dir "+(dir>0?"up":dir<0?"down":"flat"),
              text:dir>0?"▲":dir<0?"▼":"–"})
          ])
        ]));
      });
      stamp.textContent=fxInfo+" · updated "+
        new Date(fxFetchedAt).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});
      fillSelects(); convert();
    }

    async function load(force){
      if(!force && fxRates && Date.now()-fxFetchedAt<FX_POLL_MS){ paint(); return; }
      try{
        const res=await fetch("/api/fx");
        if(!res.ok) throw new Error("HTTP "+res.status);
        const j=await res.json();
        if(!j.rates||!j.rates.USD) throw new Error("bad response");
        fxPrev=fxRates; fxRates=j.rates; fxFetchedAt=j.fetchedAt||Date.now();
        fxInfo=(j.liveCount?"✓ live market rate ("+j.liveCount+" pairs)":"daily reference rate")+
          " · verified vs "+(j.dailySources||[]).length+" sources"+(j.stale?" · STALE":"");
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
