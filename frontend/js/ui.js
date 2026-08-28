/* ============================================================
   CHHAPERIA ERP — UI TOOLKIT
   DOM helpers, toasts, modals, sortable tables, command palette,
   and the navigation manifest.
   ============================================================ */
(function (global) {
  "use strict";

  /* ---------- DOM helpers ---------- */
  const $ = (s,el=document)=>el.querySelector(s);
  const $$ = (s,el=document)=>[...el.querySelectorAll(s)];
  function h(tag, attrs={}, children){
    const e=document.createElement(tag);
    for(const k in attrs){
      const v=attrs[k];
      if(k==="class") e.className=v;
      else if(k==="html") e.innerHTML=v;
      else if(k==="text") e.textContent=v;
      else if(k.startsWith("on")&&typeof v==="function") e.addEventListener(k.slice(2),v);
      else if(v!=null&&v!==false) e.setAttribute(k,v);
    }
    if(children!=null){ (Array.isArray(children)?children:[children]).forEach(c=>{
      if(c==null||c===false) return;
      e.appendChild(typeof c==="string"?document.createTextNode(c):c);
    });}
    return e;
  }
  const esc = s => String(s==null?"":s).replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

  /* ---------- toasts ---------- */
  function toast(msg, opts={}){
    const {type="info", title, dur=3200}=opts;
    const ic={ok:"✓",warn:"⚠",danger:"✕",info:"ℹ"}[type]||"ℹ";
    const host=$("#toasts");
    // announce toasts to assistive tech (set once on the container)
    if(host && !host.hasAttribute("aria-live")){ host.setAttribute("aria-live","polite"); host.setAttribute("aria-atomic","false"); }
    const t=h("div",{class:"toast "+type,role:type==="danger"?"alert":"status"},[
      h("div",{class:"ic","aria-hidden":"true",text:ic}),
      h("div",{},[ title?h("div",{class:"t",text:title}):null, h("div",{class:"d",text:msg}) ])
    ]);
    host.appendChild(t);
    setTimeout(()=>{ t.classList.add("out"); setTimeout(()=>t.remove(),320); }, dur);
  }

  /* ---------- modal ---------- */
  /* wide  = 960px  (tables, detail views)
     xwide = 1240px (document forms: PO / SO carry a header block AND line items) */
  function modal({title, sub, body, foot, wide, xwide, onClose}){
    const host=$("#modalHost"); host.hidden=false; host.innerHTML="";
    const prevFocus=document.activeElement;   // restore focus on close (a11y)
    const width=xwide?"width:min(1240px,96vw)":(wide?"width:min(960px,96vw)":"");
    const m=h("div",{class:"modal",role:"dialog","aria-modal":"true","aria-label":title||"Dialog",style:width},[
      h("div",{class:"modal-head"},[
        h("div",{},[ h("h3",{text:title||""}), sub?h("div",{class:"sub",text:sub}):null ]),
        h("button",{class:"icon-btn","aria-label":"Close dialog",style:"margin-left:auto",onclick:close,text:"✕"})
      ]),
      h("div",{class:"modal-body"}, typeof body==="string"?h("div",{html:body}):body),
      foot?h("div",{class:"modal-foot"},foot):null
    ]);
    host.appendChild(m);
    // move focus into the dialog for keyboard/screen-reader users
    requestAnimationFrame(()=>{ const f=m.querySelector('input:not([disabled]),select:not([disabled]),textarea:not([disabled]),button.primary,button'); if(f) try{f.focus();}catch{} });
    function focusables(){ return [...m.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')].filter(el=>el.offsetParent!==null); }
    function onKey(e){
      if(e.key==="Escape"){ close(); return; }
      if(e.key==="Tab"){                       // simple focus trap
        const f=focusables(); if(!f.length) return;
        const first=f[0], last=f[f.length-1];
        if(e.shiftKey && document.activeElement===first){ e.preventDefault(); last.focus(); }
        else if(!e.shiftKey && document.activeElement===last){ e.preventDefault(); first.focus(); }
      }
    }
    document.addEventListener("keydown",onKey);
    host.onclick=e=>{ if(e.target===host) close(); };
    function close(){ host.hidden=true; host.innerHTML=""; document.removeEventListener("keydown",onKey);
      if(prevFocus && prevFocus.focus) try{ prevFocus.focus(); }catch{}
      /* Escape, the X and the backdrop all land here. A dialog that answers a
         question has to settle its promise on those paths too, or the caller
         waits for ever. Buttons answer first, and a promise ignores the
         second answer. */
      if(typeof onClose==="function") try{ onClose(); }catch{} }
    return {close, el:m};
  }

  /* ---------- confirm ---------- */
  function confirm(msg, {title="Confirm", danger}={}){
    return new Promise(res=>{
      const mo=modal({title, onClose:()=>res(false),
        body:h("p",{class:"dim",style:"line-height:1.6",text:msg}),
        foot:[
          h("button",{class:"btn ghost",onclick:()=>{res(false);mo.close();},text:"Cancel"}),
          h("button",{class:"btn "+(danger?"primary":"primary"),style:danger?"background:linear-gradient(135deg,var(--danger),#b02418)":"",onclick:()=>{res(true);mo.close();},text:"Confirm"})
        ]});
    });
  }

  /* THREE ANSWERS, not two. "You have unsaved work" is not a yes/no question:
     the operator wants to keep the work, or to throw it away on purpose, or to
     stay where they are. A two-button confirm forces the first and third
     together and makes losing the work the only way forward. */
  function confirmSave(msg, {title="Unsaved changes", saveText="Save", discardText="Don't save"}={}){
    return new Promise(res=>{
      const done=(v)=>{ res(v); mo.close(); };
      const mo=modal({title, onClose:()=>res("cancel"),
        body:h("p",{class:"dim",style:"line-height:1.6",text:msg}),
        foot:[
          h("button",{class:"btn ghost",onclick:()=>done("cancel"),text:"Cancel"}),
          h("button",{class:"btn ghost ls-discard",
            onclick:()=>done("discard"),text:discardText}),
          h("button",{class:"btn primary",onclick:()=>done("save"),text:saveText}),
        ]});
    });
  }

  /* ---------- sortable / filterable table ----------
     cols: [{key,label,num,render(row),sort(row),width,cls}]
  */
  function table(rows, cols, opts={}){
    const state={ sort:opts.sort||null, dir:opts.dir||1 };
    const wrap=h("div",{class:"table-wrap"});
    const tbl=h("table",{class:"tbl"});
    const thead=h("thead"); const trh=h("tr");
    cols.forEach(c=>{
      const th=h("th",{class:(c.num?"num ":"")+(state.sort===c.key?"sorted":""), style:c.width?`width:${c.width}`:""},
        h("span",{class:"sortable"},[ c.label, c.noSort?null:h("span",{class:"arr",text: state.sort===c.key?(state.dir>0?"▲":"▼"):"⇅"}) ]));
      if(!c.noSort) th.onclick=()=>{ if(state.sort===c.key) state.dir*=-1; else {state.sort=c.key;state.dir=1;} render(); };
      trh.appendChild(th);
    });
    thead.appendChild(trh); tbl.appendChild(thead);
    const tbody=h("tbody"); tbl.appendChild(tbody);
    wrap.appendChild(tbl);

    /* ---- phone-only compact cards (tap a row → full details) ----
       Every section flows through here, so on phones each row collapses
       to its key parameters — the name/id, an identity line, and the most
       telling value + status fields — then tapping opens the record's own
       detail view (opts.onRow) or a generated field list. Skipped for the
       Operations section (keeps its stacked-field cards) and tiny tables. */
    const useCards = opts.mobileCards!==false && cols.length>=3
      && sectionOfView(curView())!=="Operations";
    /* A table that keeps the stacked label:value card on phones (Operations,
       and anything that opted out) packs those pairs TWO to a row — see
       .tbl-stack in app.css. One pair per row turned a work order into a
       screen-and-a-half of scrolling. Only worth it once there are enough
       columns; a 2–3 column table reads better one pair per line. */
    if(!useCards && cols.length>=4) wrap.classList.add("tbl-stack");
    let cards=null, summary=null;
    if(useCards){
      wrap.classList.add("tbl-compact");
      cards=h("div",{class:"tbl-cards"});
      wrap.appendChild(cards);
      summary = summaryFor(cols, opts);
    }

    function renderVal(c,r){ return c.render?c.render(r):r[c.key]; }
    function putVal(node,v){ if(v instanceof Node) node.appendChild(v); else node.innerHTML=v==null?"—":v; }
    function firstColText(r){
      const c=cols[0]; const content=renderVal(c,r);
      let el;
      if(content instanceof Node){ el=content; }
      else { el=document.createElement("div"); el.innerHTML=content==null?"":String(content); }
      const main=el.querySelector?el.querySelector(".cell-main"):null;   // prefer the primary name line
      return ((main?main.textContent:el.textContent)||"").trim();
    }
    function buildCard(r){
      const row=h("button",{class:"tbl-card-row",onclick:()=>openCard(r)});
      if(r&&r.id!=null) row.setAttribute("data-row-id",String(r.id));   // phones highlight too
      const main=h("div",{class:"tbl-card-main"});
      const head=h("div",{class:"tbl-card-head"}); putVal(head, renderVal(cols[0],r)); main.appendChild(head);
      const hasMain=!!head.querySelector(".cell-main");
      // identity line (e.g. Supplier / Customer) when the first column is only a code
      if(!hasMain && summary.subIdx>=0){
        const sub=h("div",{class:"tbl-card-sub"}); putVal(sub, renderVal(cols[summary.subIdx],r)); main.appendChild(sub);
      }
      // key parameters (value + status)
      if(summary.chips.length){
        const params=h("div",{class:"tbl-card-params"});
        summary.chips.forEach(i=>{
          const c=cols[i]; const chip=h("span",{class:"tcp"});
          if(i!==summary.statusIdx){ chip.appendChild(h("span",{class:"tcp-k",text:typeof c.label==="string"?c.label:""})); }
          const val=h("span",{class:"tcp-v"}); putVal(val, renderVal(c,r)); chip.appendChild(val);
          params.appendChild(chip);
        });
        main.appendChild(params);
      }
      row.appendChild(main);
      row.appendChild(h("span",{class:"tbl-card-chev","aria-hidden":"true",text:"›"}));
      return row;
    }
    function openCard(r){
      if(opts.onRow){ opts.onRow(r); return; }                 // reuse the table's own detail view
      const body=h("div",{class:"tbl-card-dl"}, cols.map(c=>{
        const label=typeof c.label==="string"?c.label:"";
        const v=h("div",{class:"tcd-v"}); putVal(v, renderVal(c,r));
        return h("div",{class:"tcd-row"+(label?"":" nolabel")},[ label?h("div",{class:"tcd-k",text:label}):null, v ].filter(Boolean));
      }));
      const mo=modal({title:firstColText(r)||"Details", sub:opts.cardSub||null, body,
        foot:[h("button",{class:"btn ghost",onclick:()=>mo.close(),text:"Close"})]});
    }

    function render(){
      let data=rows.slice();
      if(state.sort){
        const col=cols.find(c=>c.key===state.sort);
        const get = col.sort||(r=>{const v=r[state.sort]; return v;});
        data.sort((a,b)=>{ let va=get(a),vb=get(b);
          if(typeof va==="string"&&typeof vb==="string") return va.localeCompare(vb)*state.dir;
          return ((va>vb)-(va<vb))*state.dir; });
      }
      tbody.innerHTML="";
      if(!data.length){ tbody.appendChild(h("tr",{},h("td",{colspan:cols.length},h("div",{class:"empty"},[h("div",{class:"big",text:"∅"}),h("div",{text:opts.empty||"No records found"})])))); }
      data.forEach(r=>{
        // opts.rowClass lets a section flag whole rows (e.g. a work order that
        // is still waiting on raw material)
        const extra=opts.rowClass?(opts.rowClass(r)||""):"";
        const tr=h("tr",{class:((opts.onRow?"row-click":"")+" "+extra).trim()});
        /* Stamp the record's own id on the row so anything that navigates HERE
           can point at the exact line it meant — App.go({highlight:id}) finds
           it, scrolls to it and flashes it. Costs one attribute per row. */
        if(r&&r.id!=null) tr.setAttribute("data-row-id",String(r.id));
        if(opts.onRow) tr.onclick=(e)=>{ if(e.target.closest("button,a,input,select")) return; opts.onRow(r); };
        cols.forEach(c=>{
          // data-label drives the stacked "card" table layout on phones
          // (see .table-wrap in app.css) — it shows the column name beside
          // each value so no horizontal scrolling is needed on narrow screens.
          const td=h("td",{class:(c.num?"num ":"")+(c.cls||""),"data-label":typeof c.label==="string"?c.label:""});
          const content=c.render?c.render(r):r[c.key];
          if(content instanceof Node) td.appendChild(content);
          else td.innerHTML=content==null?"—":content;
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
        /* opts.rowAfter lets a section hang a full-width note under a row —
           a warning that would otherwise have to squeeze into one cell and
           push the whole table sideways. */
        if(opts.rowAfter){
          const extra=opts.rowAfter(r);
          if(extra){
            const td=h("td",{colspan:cols.length,class:"row-after-cell"});
            if(extra instanceof Node) td.appendChild(extra); else td.innerHTML=extra;
            const xtr=h("tr",{class:"row-after"+(opts.rowClass?" "+(opts.rowClass(r)||""):"")});
            xtr.appendChild(td);
            tbody.appendChild(xtr);
          }
        }
      });
      // phone compact cards mirror the (sorted) data order
      if(cards){
        cards.innerHTML="";
        if(!data.length){ cards.appendChild(h("div",{class:"tbl-cards-empty",text:opts.empty||"No records found"})); }
        else data.forEach(r=>cards.appendChild(buildCard(r)));
      }
      // update header arrows
      $$("th",thead).forEach((th,i)=>{ const c=cols[i]; th.className=(c.num?"num ":"")+(state.sort===c.key?"sorted":"");
        const arr=th.querySelector(".arr"); if(arr) arr.textContent= state.sort===c.key?(state.dir>0?"▲":"▼"):"⇅"; });
    }
    render();
    wrap._refresh = (newRows)=>{ if(newRows) rows=newRows; render(); };
    return wrap;
  }

  /* the view id currently shown (drives per-section mobile behaviour) */
  function curView(){ return (global.App && global.App.current) || ""; }
  /* which NAV section a view belongs to (walks the manifest's section headers) */
  function sectionOfView(viewId){
    let sec=null;
    for(const n of NAV){ if(n.sec){ sec=n.sec; } else if(n.id===viewId){ return sec; } }
    return null;
  }
  /* Pick the KEY parameters to surface on a phone card. A caller can be
     explicit via opts.cardCols (column keys) + opts.cardSubKey; otherwise
     we choose the most telling status + value columns semantically so the
     card reads like the ABC list (identity + a couple of numbers/badges). */
  const STATUS_RE=/status|state|result|stage/i;
  const CLASS_RE =/\b(class|grade|priority|rating|risk|type|tier)\b/i;
  const VALUE_RE =/value|amount|amt|total|on.?hand|balance|net|pay|salary|wage|qty|stock|suggest|due|count|days|hours|leaves|present|score/i;
  const IDENT_RE =/supplier|customer|name|item|worker|employee|party|agency|transporter|lead|contact|product/i;
  function summaryFor(cols, opts){
    const lab=c=>typeof c.label==="string"?c.label:"";
    const hay=c=>((c.key||"")+" "+lab(c));
    const idxOf=k=>cols.findIndex(c=>c.key===k);
    if(opts.cardCols && opts.cardCols.length){
      const chips=opts.cardCols.map(idxOf).filter(i=>i>0);
      const statusIdx=chips.find(i=>STATUS_RE.test(hay(cols[i]))||CLASS_RE.test(hay(cols[i])));
      return { chips, statusIdx: statusIdx==null?-1:statusIdx, subIdx: opts.cardSubKey?idxOf(opts.cardSubKey):-1 };
    }
    const find=(pred,skip)=>{ for(let i=1;i<cols.length;i++){ if(i===skip) continue; if(pred(cols[i],i)) return i; } return -1; };
    let statusIdx=find(c=>STATUS_RE.test(hay(c)));
    if(statusIdx<0) statusIdx=find(c=>CLASS_RE.test(hay(c)));
    let valueIdx=find(c=>VALUE_RE.test(hay(c)), statusIdx);          // semantic value first…
    if(valueIdx<0) valueIdx=find(c=>c.num===true, statusIdx);        // …then any numeric column
    const identIdx=find(c=>IDENT_RE.test(hay(c)));
    const chips=[valueIdx,statusIdx].filter((i,n,a)=>i>=0 && a.indexOf(i)===n);
    return { chips, statusIdx, subIdx: identIdx };
  }

  /* ---------- status badge ---------- */
  function badge(state, label){
    const map={ok:"s-ok",warn:"s-warn",danger:"s-danger",info:"s-info",mut:"s-mut",violet:"s-violet"};
    return `<span class="badge-s ${map[state]||"s-mut"}">${esc(label)}</span>`;
  }

  /* ---------- meter ---------- */
  function meter(pct, cls=""){
    return `<div class="meter ${cls}"><span style="width:${Math.max(0,Math.min(100,pct))}%"></span></div>`;
  }

  /* ---------- sparkline element ---------- */
  function sparkEl(data, color, w=90, hgt=30){
    const box=h("div",{class:"chart-box",style:`width:${w}px`});
    const cv=h("canvas",{"data-h":hgt}); box.appendChild(cv);
    requestAnimationFrame(()=>Charts.spark(cv,data,color));
    return box;
  }

  /* ---------- NAV MANIFEST ---------- */
  const NAV = [
    {sec:"Overview", adminOnly:true},
    {id:"dashboard", icon:"▦", label:"Dashboard", accent:"orange", adminOnly:true},
    {id:"analytics", icon:"📈", label:"Analytics", accent:"violet", adminOnly:true},
    {sec:"Inventory", labOk:true},
    {id:"inventory", icon:"📦", label:"Stock Items", accent:"blue", labOk:true},
    {id:"ledger", icon:"📒", label:"Stock Ledger", accent:"teal"},
    {id:"warehouses", icon:"🏬", label:"Warehouses", accent:"teal", labOk:true},
    /* The label designer — text, barcodes, QR codes, pictures — and the print
       run for whatever it draws. Deliberately NOT labOk: it was reached from a
       purchase order before, and that route was already hidden from the lab
       incharge, so giving the feature its own screen must not quietly hand
       them access they never had. Printing a purchase order's OWN stickers is
       still not here: that is the 🏷 Labels button inside the order itself,
       in Procurement, because those labels belong to that order.
       ⚠ The glyph needs its variation selector (U+1F5A8 U+FE0F). U+1F5A8 is
       Emoji_Presentation=No, so bare it renders as a flat monochrome outline
       that looks broken beside 📦 and 🏬 — with VS16 it comes out in colour. */
    {id:"label-studio", icon:"🖨️", label:"Label Studio", accent:"amber"},
    {sec:"Operations", labOk:true},
    {id:"production", icon:"⚙️", label:"Production", accent:"amber", labOk:true},
    {id:"bom", icon:"🧬", label:"Products & BOM", accent:"green", labOk:true},
    {id:"lab-reports", icon:"🧪", label:"Lab Reports", accent:"teal", labOk:true, labWrite:true, pillKey:"labPending"},
    {sec:"Sales & CRM"},
    {id:"crm", icon:"🎯", label:"CRM Pipeline", accent:"pink", pillKey:"openLeads"},
    // the road from a reel to an order: every sample sent and every price
    // offered, on one page — the pill counts the quotes still open
    {id:"quotations", icon:"📄", label:"Samples & Quotations", accent:"pink", pillKey:"openQuotes"},
    /* Procurement is open to the lab incharge (labOk) but NOT writable by them
       (no labWrite): they go there to test what a goods receipt brought in, so
       they read the orders and the receipts and file readings — they never
       raise, edit or receive an order. The GRN test button is the one action
       exempted from the read-only rule, in mod-trade. */
    {sec:"Trade", labOk:true},
    {id:"purchase", icon:"🛒", label:"Procurement", accent:"blue", pillKey:"openPO", labOk:true},
    {id:"sales", icon:"🧾", label:"Sales Orders", accent:"orange", pillKey:"openSO"},
    {id:"suppliers", icon:"🏭", label:"Suppliers", accent:"violet"},
    {id:"customers", icon:"🤝", label:"Customers", accent:"pink"},
    {id:"dispatch", icon:"🚚", label:"Dispatch", accent:"amber"},
    {sec:"HR & Payroll"},
    {id:"hr", icon:"▦", label:"Overview", accent:"teal"},
    {id:"hr-workers", icon:"👷", label:"Workers", accent:"teal"},
    {id:"hr-attendance", icon:"🕒", label:"Attendance", accent:"teal"},
    {id:"hr-leave", icon:"🌴", label:"Leave", accent:"teal", pillKey:"hrPendingLeaves"},
    {id:"hr-payroll", icon:"💰", label:"Payroll", accent:"teal"},
    {id:"hr-settings", icon:"⚙", label:"Settings", accent:"teal"},
    {sec:"System", adminOnly:true},
    {id:"reports", icon:"📊", label:"Reports", accent:"green", adminOnly:true},
    {id:"users", icon:"👥", label:"Users & Access", accent:"red", adminOnly:true},
    {id:"settings", icon:"⚙", label:"Settings", accent:"orange", adminOnly:true},
  ];

  global.UI = { $, $$, h, esc, toast, modal, confirm, confirmSave, table, badge, meter, sparkEl, NAV };
})(window);
