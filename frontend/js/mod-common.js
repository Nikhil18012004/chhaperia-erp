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

  /* ============================================================
     CLICKABLE CONTACTS — call / WhatsApp / webmail
     Phone → tap-to-call (tel:) + a WhatsApp action (wa.me).
     Email → a small "Gmail / Outlook / default app" chooser so each
     user opens mail in their own webmail. Client emails compose a new
     message (To = client, account = ours); the company address opens
     the inbox instead. Rendered as a lightweight body-level popover so
     it works even when invoked from inside a modal (e.g. lead detail).
     ============================================================ */
  // Our own address (used as the Gmail sending account for client compose).
  function ourEmail(){ try{ return (global.ENG && ENG.data && ENG.data.org && ENG.data.org.email) || ""; }catch(e){ return ""; } }
  // International digit string for wa.me / tel (assume +91 when no country code).
  function phoneDigits(raw){
    let d = String(raw==null?"":raw).replace(/\D/g, "");
    if(!d) return "";
    if(d.length === 10) d = "91" + d;                 // bare 10-digit Indian mobile
    else if(d.length === 11 && d[0] === "0") d = "91" + d.slice(1);
    return d;
  }
  function qs(o){ return Object.entries(o).filter(([,v]) => v != null && v !== "").map(([k,v]) => k + "=" + encodeURIComponent(v)).join("&"); }

  function mailUrls(address, opts){
    opts = opts || {};
    const inbox = opts.mode === "inbox";
    const from = opts.from || ourEmail();
    const su = opts.subject || "", bd = opts.body || "";
    return {
      gmail: inbox ? "https://mail.google.com/mail/u/0/#inbox"
                   : "https://mail.google.com/mail/?" + qs({ view:"cm", fs:1, to:address, su, body:bd, authuser:from }),
      outlook: inbox ? "https://outlook.office.com/mail/"
                     : "https://outlook.office.com/mail/deeplink/compose?" + qs({ to:address, subject:su, body:bd }),
      mailto: inbox ? "mailto:" + address
                    : "mailto:" + address + (su || bd ? "?" + qs({ subject:su, body:bd }) : ""),
    };
  }

  let _openPop = null;
  function closePop(){ if(_openPop){ _openPop.remove(); _openPop = null; document.removeEventListener("mousedown", _onDoc, true); document.removeEventListener("keydown", _onKey, true); window.removeEventListener("resize", closePop); window.removeEventListener("scroll", closePop, true); } }
  function _onDoc(e){ if(_openPop && !_openPop.contains(e.target)) closePop(); }
  function _onKey(e){ if(e.key === "Escape") closePop(); }

  function mailChooser(anchor, address, opts){
    closePop();
    opts = opts || {};
    const inbox = opts.mode === "inbox";
    const u = mailUrls(address, opts);
    const open = (url, web) => { closePop(); if(web) window.open(url, "_blank", "noopener,noreferrer"); else window.location.href = url; };
    const row = (icon, label, meta, fn) => h("button", { class:"mail-opt", onclick: fn }, [
      h("span", { class:"mail-opt-ic", text: icon }),
      h("span", { class:"mail-opt-tx" }, [ h("b", { text: label }), h("span", { class:"muted", text: meta }) ]),
    ]);
    const pop = h("div", { class:"contact-pop", role:"menu" }, [
      h("div", { class:"contact-pop-head", text: (inbox ? "Open mailbox · " : "New email · ") + address }),
      row("✉️", "Gmail", inbox ? "Open inbox" : "Compose in browser", () => open(u.gmail, true)),
      row("📧", "Outlook", inbox ? "Open inbox" : "Compose in browser", () => open(u.outlook, true)),
      row("💻", "Default mail app", inbox ? address : "New message", () => open(u.mailto, false)),
    ]);
    document.body.appendChild(pop);
    _openPop = pop;
    // position under the anchor, clamped to the viewport
    const r = anchor.getBoundingClientRect();
    const pw = pop.offsetWidth || 240;
    let left = r.left; if(left + pw > document.documentElement.clientWidth - 8) left = document.documentElement.clientWidth - pw - 8;
    pop.style.left = Math.max(8, left) + window.scrollX + "px";
    pop.style.top = (r.bottom + 6) + window.scrollY + "px";
    setTimeout(() => { document.addEventListener("mousedown", _onDoc, true); document.addEventListener("keydown", _onKey, true);
      window.addEventListener("resize", closePop); window.addEventListener("scroll", closePop, true); }, 0);
  }

  // <a> that opens the mail chooser. opts.mode: "compose" (default) | "inbox".
  function emailLink(address, opts){
    if(!address) return "—";
    return h("a", { href:"#", class:"a-link", role:"button", onclick:(e) => { e.preventDefault(); mailChooser(e.currentTarget, address, opts); }, text: address });
  }
  // <a> that opens a website (adds https:// when the stored value has no scheme).
  function webLink(url){
    if(!url) return "—";
    const href = /^https?:\/\//i.test(url) ? url : "https://" + url;
    return h("a", { href, target:"_blank", rel:"noopener noreferrer", class:"a-link", text: url });
  }
  // number as tap-to-call, plus a WhatsApp button (opts.wa:false to hide WhatsApp).
  function phoneCell(raw, opts){
    if(!raw) return "—";
    opts = opts || {};
    const cell = h("span", { class:"contact-cell" }, [
      h("a", { href:"tel:" + String(raw).replace(/[^\d+]/g, ""), class:"a-link", text: String(raw) }),
    ]);
    const d = phoneDigits(raw);
    if(opts.wa !== false && d) cell.appendChild(
      h("a", { href:"https://wa.me/" + d, target:"_blank", rel:"noopener noreferrer", class:"wa-btn", title:"Message on WhatsApp", "aria-label":"Message on WhatsApp", text:"💬" })
    );
    return cell;
  }

  global.M = M;
  global.MW = { pageHead, kpi, chartCard, barList, donutCard, searchInput, select, dateRange, inDateRange, dl, emailLink, webLink, phoneCell };
})(window);
