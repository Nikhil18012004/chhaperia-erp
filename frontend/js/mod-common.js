/* ============================================================
   CHHAPERIA ERP — MODULE COMMON
   Shared registry + reusable widgets used by every module.
   ============================================================ */
(function (global) {
  "use strict";
  const {h, esc} = UI;

  // module registry: id -> {render(root), title, sub}
  const M = {};

  /* ----- page header ----- */
  function pageHead(title, sub, actions){
    return h("div",{class:"page-head"},[
      h("div",{},[
        h("div",{class:"page-title"},[ h("span",{class:"dot"}), title ]),
        sub?h("div",{class:"page-sub",text:sub}):null
      ]),
      actions?h("div",{class:"actions"}, actions):null
    ]);
  }

  /* ----- KPI card ----- */
  function kpi({icon, label, value, delta, deltaType, spark, sparkColor, onClick}){
    const card=h("div",{class:"kpi"+(onClick?" hover":""), style:onClick?"cursor:pointer":""},[
      h("div",{class:"kpi-top"},[
        h("div",{class:"kpi-ic",text:icon}),
        spark?UI.sparkEl(spark, sparkColor, 80, 34):null
      ]),
      h("div",{class:"kpi-val",text:value}),
      h("div",{class:"kpi-label",text:label}),
      delta!=null?h("div",{class:"kpi-delta "+(deltaType||"flat")},[
        h("span",{text: deltaType==="up"?"▲":deltaType==="down"?"▼":"●"}), " "+delta
      ]):null
    ]);
    if(onClick) card.onclick=onClick;
    return card;
  }

  /* ----- chart card wrapper ----- */
  function chartCard(title, sub, tools, hgt=240){
    const cv=h("canvas",{"data-h":hgt});
    const box=h("div",{class:"chart-box"},cv);
    const card=h("div",{class:"card"},[
      h("div",{class:"card-head"},[
        h("div",{},[ h("h3",{text:title}), sub?h("div",{class:"sub",text:sub}):null ]),
        tools?h("div",{class:"tools"},tools):null
      ]),
      box
    ]);
    card._canvas=cv;
    return card;
  }

  /* ----- simple bar list (horizontal) ----- */
  function barList(items, opts={}){
    const max=Math.max(...items.map(i=>i.value),1);
    const fmt=opts.fmt||(v=>ENG.num(v));
    return h("div",{class:"barlist"}, items.map((it,idx)=>{
      const color=`var(--c${(idx%8)+1})`;
      return h("div",{class:"row"},[
        h("div",{class:"lab",title:it.name,text:it.name}),
        h("div",{class:"meter"},h("span",{style:`width:${it.value/max*100}%;background:linear-gradient(90deg,${color},${color})`})),
        h("div",{class:"val",text:fmt(it.value)})
      ]);
    }));
  }

  /* ----- donut + legend combo ----- */
  function donutCard(title, data, centerVal, centerSub, fmt){
    fmt=fmt||(v=>ENG.money(v));
    const cv=h("canvas",{"data-h":200});
    const box=h("div",{class:"chart-box",style:"flex:0 0 200px"},cv);
    const total=data.reduce((s,d)=>s+d.value,0)||1;
    const legend=h("div",{class:"legend",style:"flex:1"}, data.map((d,i)=>h("div",{class:"li"},[
      h("span",{class:"d",style:`background:var(--c${(i%8)+1})`}),
      h("span",{text:d.name}),
      h("span",{class:"v",text: fmt(d.value)})
    ])));
    const card=h("div",{class:"card"},[
      h("div",{class:"card-head"},h("h3",{text:title})),
      h("div",{class:"flex aic",style:"gap:18px;flex-wrap:wrap"},[ box, legend ])
    ]);
    requestAnimationFrame(()=>Charts.donut(cv,{data, center:centerVal, centerSub}));
    return card;
  }

  /* ----- toolbar with search ----- */
  function searchInput(ph, onInput){
    let t; // debounce so filtering doesn't recompute on every keystroke
    const inp=h("input",{class:"input search",placeholder:ph||"Search…",oninput:e=>{
      const v=e.target.value; clearTimeout(t); t=setTimeout(()=>onInput(v),150);
    }});
    return inp;
  }
  function select(options, onChange, val){
    const s=h("select",{class:"select",onchange:e=>onChange(e.target.value)});
    options.forEach(o=>{ const opt=h("option",{value:o.value??o},o.label??o); if((o.value??o)===val) opt.selected=true; s.appendChild(opt); });
    return s;
  }

  /* ----- date range filter ----- */
  function inDateRange(date, range){
    if(!date) return !(range && (range.from || range.to));
    const d=String(date).slice(0,10);
    if(range && range.from && d < range.from) return false;
    if(range && range.to && d > range.to) return false;
    return true;
  }
  function dateRange(range, onChange, opts={}){
    const today = DB.helpers.iso(DB.helpers.today());
    const presets=[
      {value:"all",label:"All Dates",from:"",to:""},
      {value:"7",label:"Last 7d",from:DB.helpers.daysAgo(7),to:today},
      {value:"30",label:"Last 30d",from:DB.helpers.daysAgo(30),to:today},
      {value:"90",label:"Last 90d",from:DB.helpers.daysAgo(90),to:today},
      {value:"custom",label:"Custom",from:range.from||"",to:range.to||""},
    ];
    const preset=select(presets, v=>{
      const p=presets.find(x=>x.value===v)||presets[0];
      if(v!=="custom"){ range.from=p.from; range.to=p.to; from.value=range.from; to.value=range.to; onChange(range); }
    }, opts.defaultPreset||"all");
    const from=h("input",{class:"input date-input",type:"date",value:range.from||"",onchange:e=>{range.from=e.target.value; preset.value="custom"; onChange(range);}});
    const to=h("input",{class:"input date-input",type:"date",value:range.to||"",onchange:e=>{range.to=e.target.value; preset.value="custom"; onChange(range);}});
    return h("div",{class:"date-range"},[
      h("span",{class:"date-label",text:opts.label||"Date"}),
      preset,
      from,
      h("span",{class:"range-sep",text:"to"}),
      to,
      h("button",{class:"btn sm ghost",onclick:()=>{range.from=""; range.to=""; from.value=""; to.value=""; preset.value="all"; onChange(range);},text:"Clear"})
    ]);
  }

  /* ----- detail row helper ----- */
  function dl(pairs){
    return h("div",{class:"grid",style:"grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px"},
      pairs.map(([k,v])=>h("div",{},[
        h("div",{class:"muted",style:"font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em",text:k}),
        h("div",{style:"font-size:14px;font-weight:600;margin-top:3px"}, v instanceof Node?v:h("span",{html:String(v==null?"—":v)}))
      ])));
  }

  global.M = M;
  global.MW = { pageHead, kpi, chartCard, barList, donutCard, searchInput, select, dateRange, inDateRange, dl };
})(window);
