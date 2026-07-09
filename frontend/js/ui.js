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
  function modal({title, sub, body, foot, wide}){
    const host=$("#modalHost"); host.hidden=false; host.innerHTML="";
    const prevFocus=document.activeElement;   // restore focus on close (a11y)
    const m=h("div",{class:"modal",role:"dialog","aria-modal":"true","aria-label":title||"Dialog",style:wide?"width:min(960px,96vw)":""},[
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
      if(prevFocus && prevFocus.focus) try{ prevFocus.focus(); }catch{} }
    return {close, el:m};
  }

  /* ---------- confirm ---------- */
  function confirm(msg, {title="Confirm", danger}={}){
    return new Promise(res=>{
      const mo=modal({title, body:h("p",{class:"dim",style:"line-height:1.6",text:msg}),
        foot:[
          h("button",{class:"btn ghost",onclick:()=>{mo.close();res(false);},text:"Cancel"}),
          h("button",{class:"btn "+(danger?"primary":"primary"),style:danger?"background:linear-gradient(135deg,var(--danger),#b02418)":"",onclick:()=>{mo.close();res(true);},text:"Confirm"})
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
        const tr=h("tr",{class:opts.onRow?"row-click":""});
        if(opts.onRow) tr.onclick=(e)=>{ if(e.target.closest("button,a,input,select")) return; opts.onRow(r); };
        cols.forEach(c=>{
          const td=h("td",{class:(c.num?"num ":"")+(c.cls||"")});
          const content=c.render?c.render(r):r[c.key];
          if(content instanceof Node) td.appendChild(content);
          else td.innerHTML=content==null?"—":content;
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
      // update header arrows
      $$("th",thead).forEach((th,i)=>{ const c=cols[i]; th.className=(c.num?"num ":"")+(state.sort===c.key?"sorted":"");
        const arr=th.querySelector(".arr"); if(arr) arr.textContent= state.sort===c.key?(state.dir>0?"▲":"▼"):"⇅"; });
    }
    render();
    wrap._refresh = (newRows)=>{ if(newRows) rows=newRows; render(); };
    return wrap;
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
    {sec:"Overview"},
    {id:"dashboard", icon:"▦", label:"Dashboard", accent:"orange"},
    {id:"analytics", icon:"📈", label:"Analytics", accent:"violet"},
    {sec:"Inventory"},
    {id:"inventory", icon:"📦", label:"Stock Items", accent:"blue"},
    {id:"ledger", icon:"📒", label:"Stock Ledger", accent:"teal"},
    {id:"warehouses", icon:"🏬", label:"Warehouses", accent:"teal"},
    {sec:"Operations"},
    {id:"production", icon:"⚙️", label:"Production", accent:"amber"},
    {id:"bom", icon:"🧬", label:"Products & BOM", accent:"green"},
    {sec:"Sales & CRM"},
    {id:"crm", icon:"🎯", label:"CRM Pipeline", accent:"pink", pillKey:"openLeads"},
    {sec:"Trade"},
    {id:"purchase", icon:"🛒", label:"Procurement", accent:"blue", pillKey:"openPO"},
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
    {sec:"System"},
    {id:"reports", icon:"📊", label:"Reports", accent:"green"},
    {id:"users", icon:"👥", label:"Users & Access", accent:"red", adminOnly:true},
    {id:"settings", icon:"⚙", label:"Settings", accent:"orange"},
  ];

  global.UI = { $, $$, h, esc, toast, modal, confirm, table, badge, meter, sparkEl, NAV };
})(window);
