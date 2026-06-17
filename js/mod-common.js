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
    const inp=h("input",{class:"input search",placeholder:ph||"Search…",oninput:e=>onInput(e.target.value)});
    return inp;
  }
  function select(options, onChange, val){
    const s=h("select",{class:"select",onchange:e=>onChange(e.target.value)});
    options.forEach(o=>{ const opt=h("option",{value:o.value??o},o.label??o); if((o.value??o)===val) opt.selected=true; s.appendChild(opt); });
    return s;
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
  global.MW = { pageHead, kpi, chartCard, barList, donutCard, searchInput, select, dl };
})(window);
