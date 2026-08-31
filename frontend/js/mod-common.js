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
  /* VIEW-ONLY SECTIONS
     A role may be allowed to LOOK at a section without being allowed to change
     it — the lab incharge reads Stock Items, Warehouses, Production and
     Products & BOM, and writes only lab reports. Every page puts its primary
     controls in the head, so they are dropped here rather than in each module:
     nobody is handed a "＋ New …" button that the server will refuse at the
     end of the form. The server enforces the same split independently. */
  function readOnlyHere(){
    return !!(global.App && App.canWrite && !App.canWrite());
  }
  function pageHead(title, sub, actions){
    const ro = readOnlyHere();
    return h("div",{class:"page-head"},[
      h("div",{},[
        h("div",{class:"page-title"},[ h("span",{class:"dot"}), title,
          ro?h("span",{class:"chip",style:"margin-left:10px;font-size:11px;font-weight:700",text:"VIEW ONLY"}):null ]),
        sub?h("div",{class:"page-sub",text:sub}):null
      ]),
      (actions && !ro)?h("div",{class:"actions"}, actions):null
    ]);
  }

  /* ----- a fetch that failed, and the way back -----
     Most pages read from the dataset ENG holds in memory, so they keep
     drawing even when the server has stopped. The handful that fetch on
     every render — HR Settings, Users & Access — have nothing to draw, and
     a one-line grey message on an otherwise empty page reads as "the page
     went black". Say plainly what happened and offer the retry, so a
     dropped connection or an expired session does not need a page reload. */
  function loadError(what, err, retry){
    const msg = (err && err.message) || String(err || "");
    const offline = /failed to fetch|networkerror|load failed/i.test(msg);
    const expired = /401|unauthor|session/i.test(msg);
    return h("div",{class:"empty",style:"padding:40px 20px"},[
      h("div",{class:"big",text: offline ? "🔌" : expired ? "🔒" : "⚠"}),
      h("div",{style:"font-weight:700",text:"Could not load " + what}),
      h("div",{class:"muted",style:"margin-top:6px;font-size:13px",
        text: offline ? "The server is not responding — it may have stopped. Start it again, then retry."
            : expired ? "Your session has expired. Sign in again."
            : msg}),
      retry ? h("div",{style:"margin-top:14px"},
        h("button",{class:"btn",onclick:retry,html:"↻ Retry"})) : null,
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

  // opts.onOpen(url) fires once a mail client has actually been picked — a
  // caller that wants to log "email sent" hooks in here rather than on the
  // button that merely opened the chooser, which can still be dismissed.
  function mailChooser(anchor, address, opts){
    closePop();
    opts = opts || {};
    const inbox = opts.mode === "inbox";
    const u = mailUrls(address, opts);
    const open = (url, web) => { closePop(); if(typeof opts.onOpen === "function") opts.onOpen(url); if(web) window.open(url, "_blank", "noopener,noreferrer"); else window.location.href = url; };
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

  /* ----- data preview: every "Export" action shows the table FIRST; the
     actual .xlsx download happens from the preview's Download button ----- */
  /* ---- THE PREVIEW EVERY EXPORT GOES THROUGH ------------------------------
     Reports, each section's Excel ▾, Stock Items and the payroll run all land
     here, so this is the one place worth teaching to ask HOW MUCH.
     It used to show every row and download every row: the only way to send
     somebody last month's ledger was to export the whole thing and cut it up in
     Excel afterwards. The sheet is SCOPED before it leaves now — by text, by
     date, by how many rows, and by which columns — and Download and Print both
     write exactly what is on screen, never more.
     All of it is optional: open the preview, press Download, and you get the
     whole table exactly as before. */
  function dataPreview(opts){
    const head=opts.head||[], rows=opts.rows||[];
    /* Which column holds a date, if any. Detected from the DATA, not from the
       heading, so it works on a sheet whose date column is called "Promised" or
       "Report Date" as readily as one called "Date". */
    const isDate=v=>typeof v==="string" && /^\d{4}-\d{2}-\d{2}/.test(v.trim());
    let dateIdx=-1;
    for(let i=0;i<head.length && dateIdx<0;i++){
      const seen=rows.slice(0,40).map(r=>r[i]).filter(v=>v!=null&&v!=="");
      if(seen.length && seen.every(isDate)) dateIdx=i;
    }
    // qRaw keeps the operator's own typing for the printed masthead; q is the
    // folded copy the matching runs on
    const state={ q:"", qRaw:"", range:{from:"",to:""}, limit:0, cols:head.map(()=>true) };

    const countChip=h("span",{class:"chip"});
    const tableHost=h("div");
    let colChip=null;
    const LIMITS=[{value:"0",label:"All rows"},{value:"25",label:"First 25"},{value:"50",label:"First 50"},
      {value:"100",label:"First 100"},{value:"250",label:"First 250"},{value:"500",label:"First 500"},
      {value:"1000",label:"First 1000"}];

    /* The rows this export will actually carry, in this order: text, then date,
       then the row cap. Columns are dropped last, so a column can be kept out of
       the sheet while still being searched on. */
    function scoped(){
      let out=rows;
      if(state.q){ const q=state.q;
        out=out.filter(r=>r.some(v=>String(v==null?"":v).toLowerCase().includes(q))); }
      if(dateIdx>=0 && (state.range.from||state.range.to))
        out=out.filter(r=>inDateRange(r[dateIdx], state.range));
      if(state.limit>0) out=out.slice(0,state.limit);
      return out;
    }
    const keptIdx=()=>head.map((_,i)=>i).filter(i=>state.cols[i]);
    const outHead=()=>keptIdx().map(i=>head[i]);
    const outRows=()=>{ const k=keptIdx(); return scoped().map(r=>k.map(i=>r[i])); };

    function draw(){
      const k=keptIdx(), body=scoped();
      const cols=k.map(i=>({key:"c"+i,label:head[i],
        num:i>0&&!isNaN(parseFloat(rows[0]&&rows[0][i])),
        render:r=>UI.esc(String(r["c"+i]==null||r["c"+i]===""?"—":r["c"+i])),sort:r=>r["c"+i]}));
      const data=body.map(r=>{const o={};head.forEach((_,i)=>o["c"+i]=r[i]);return o;});
      tableHost.innerHTML="";
      tableHost.appendChild(UI.table(data,cols,{empty:"Nothing matches this selection"}));
      countChip.textContent = body.length===rows.length
        ? rows.length+" row"+(rows.length===1?"":"s")
        : body.length+" of "+rows.length+" rows";
      if(colChip) colChip.textContent = k.length===head.length
        ? "All "+head.length+" columns" : k.length+" of "+head.length+" columns";
    }

    /* the columns picker: one tick per column, in a small popover */
    function columnsControl(){
      const list=h("div",{class:"ni-menu dp-cols",hidden:true},
        head.map((hd,i)=>{
          const box=h("input",{type:"checkbox",style:"width:14px;height:14px;accent-color:var(--accent)"});
          box.checked=state.cols[i];
          box.addEventListener("change",()=>{
            // a sheet with no columns is not a sheet — always leave one standing
            if(!box.checked && keptIdx().length<=1){ box.checked=true; return; }
            state.cols[i]=box.checked; draw();
          });
          return h("label",{class:"ni-opt dp-col"},[box,h("span",{text:hd||("Column "+(i+1))})]);
        }));
      const all=h("button",{class:"ni-opt dp-col-all",text:"Select all",onclick:e=>{e.stopPropagation();
        state.cols=head.map(()=>true);
        list.querySelectorAll("input").forEach(b=>{b.checked=true;}); draw();}});
      list.insertBefore(all,list.firstChild);
      colChip=h("span",{});
      const trig=h("button",{class:"btn sm"},[colChip,h("span",{class:"caret",text:" ▾"})]);
      const wrap=h("div",{class:"ni-drop"},[trig,list]);
      const onDoc=e=>{ if(!wrap.contains(e.target)){ list.hidden=true; document.removeEventListener("click",onDoc); } };
      trig.addEventListener("click",e=>{ e.stopPropagation();
        if(list.hidden){ list.hidden=false; setTimeout(()=>document.addEventListener("click",onDoc),0); }
        else { list.hidden=true; document.removeEventListener("click",onDoc); } });
      return wrap;
    }

    const bar=h("div",{class:"dp-bar"},[
      searchInput("Filter rows…", v=>{ state.qRaw=String(v||"").trim();
        state.q=state.qRaw.toLowerCase(); draw(); }),
      dateIdx>=0 ? dateRange(state.range, ()=>draw(), {label:head[dateIdx]||"Date"}) : null,
      select(LIMITS, v=>{ state.limit=+v||0; draw(); }, "0"),
      columnsControl(),
      h("div",{style:"margin-left:auto"},countChip),
    ].filter(Boolean));

    const body=h("div",{},[bar,tableHost]);
    draw();

    /* PRINT — the same scoped table on paper.
       A report read at a desk and a report signed off in a meeting are the same
       figures; only the medium differs, so print takes its rows from where the
       download takes them rather than from the full set.

       LAYING OUT AN ARBITRARY TABLE is the whole problem here: these sheets run
       from 6 columns (Reorder) to 19 (Production Pending), and one fixed layout
       cannot serve both. So the sheet is MEASURED before it is written:

         · each column is sized from the widest thing actually in it, so a
           19-character product name gets room and a 3-character code does not
           take the same slice — the table then fills the paper edge to edge
           instead of leaving a third of it white;
         · the page turns to landscape only when portrait genuinely cannot hold
           the measured width, not merely because there are many columns;
         · the type is the LARGEST that still fits, found by measurement rather
           than by a fixed ladder, so a narrow sheet is never needlessly tiny;
         · the header repeats on every sheet and no row is split by a page break.

       Numeric columns are right-aligned and never wrap, so figures stay in a
       column the eye can run down; text wraps instead of forcing the table
       wider than the paper. */
    function printScoped(){
      const hd=outHead(), bd=outRows(), k=keptIdx();
      if(!bd.length){ UI.toast("Nothing to print in this selection",{type:"warn"}); return; }
      const w=window.open("","_blank");
      if(!w){ UI.toast("Popup blocked — allow popups for this site to print",{type:"warn"}); return; }
      const esc=UI.esc, org=(ENG.data.org||{});

      /* A column is numeric when every value that is present reads as a number.
         Sampled across the sheet rather than taken from the first row, which is
         blank often enough to mis-classify a whole column. */
      const numeric=k.map(i=>{
        const seen=rows.slice(0,60).map(r=>r[i]).filter(v=>v!=null&&String(v).trim()!=="");
        return seen.length>0 && seen.every(v=>!isNaN(parseFloat(String(v).replace(/[,%₹\s]/g,""))));
      });

      /* ---- MEASURE ----
         The widest content in each column, in characters. A heading is part of
         the measurement (it has to fit too), and a runaway text column is capped
         so one long remark cannot starve every other column of width. */
      const FLOOR=4;
      // the true widest, measured once; the cap is applied over it below
      const raw=hd.map((label,j)=>{
        let m=String(label==null?"":label).length;
        for(let i=0;i<bd.length && i<400;i++){
          const L=String(bd[i][j]==null?"":bd[i][j]).length;
          if(L>m) m=L;
        }
        return Math.max(FLOOR, m);
      });

      /* ---- FIT ----
         A4 at an 8mm margin leaves 194mm across in portrait and 281mm in
         landscape. A character of Segoe UI at f px is about 0.5f px wide, and
         1px is 0.2646mm; each column also spends ~3mm on its padding and rules.
         Solve that for the largest type that still fits, and only turn the page
         when portrait cannot hold a readable size. */
      const MM_PER_PX=0.2646, CHAR=0.5, GUTTER=3;
      const fitFont=(usableMM,total)=>{
        const forText=usableMM-(hd.length*GUTTER);
        if(forText<=0) return 0;
        return forText/(total*CHAR*MM_PER_PX);
      };
      /* Cap how much width any ONE column may claim, and tighten that cap until
         the type is readable. A long remark wrapping over three lines costs far
         less than every figure on the sheet shrinking to fit it on one — so on a
         wide sheet the text columns give up width to buy legible type for all
         nineteen. The first cap that clears 8.4px wins; if none does, the
         tightest is used. */
      const CAPS=[34,26,20,16,13];
      let chars=null, totalChars=0, fs=0, wide=false;
      for(let ci=0; ci<CAPS.length; ci++){
        const cap=CAPS[ci];
        const c=raw.map(x=>Math.min(cap,x));
        const tot=c.reduce((a,b)=>a+b,0);
        const pf=fitFont(194,tot), lf=fitFont(281,tot);
        // portrait is preferred — it is the paper everything else in this
        // office is filed on — and given up only when it cannot stay legible
        const land = pf<8.2 && lf>pf;
        const f = Math.max(6.8, Math.min(11, land?lf:pf));
        chars=c; totalChars=tot; fs=f; wide=land;
        if(f>=8.4) break;
      }
      const pad = fs>=9.5 ? "4px 6px" : fs>=8 ? "3px 5px" : "2.5px 4px";
      const page = wide ? "A4 landscape" : "A4 portrait";
      // every column gets the share of the paper its own content asks for
      const widths=chars.map(c=>(c/totalChars*100).toFixed(3)+"%");

      const css=[
        "@page{size:"+page+";margin:8mm}",
        "*{box-sizing:border-box}",
        'body{font:12px/1.4 "Segoe UI",Arial,sans-serif;color:#111;margin:0;padding:0}',
        /* masthead — the same shape as the quotation and GRN sheets, so a
           report filed beside them reads as the same company's paper */
        ".hd{display:flex;justify-content:space-between;align-items:flex-start;"
          +"border-bottom:2px solid #111;padding-bottom:6px;margin-bottom:8px}",
        ".co{font-size:15px;font-weight:800;letter-spacing:.2px;line-height:1.2}",
        ".tag{font-size:9.5px;color:#555;margin-top:1px}",
        ".ids{font-size:9px;color:#444;margin-top:2px}",
        ".tt{text-align:right;flex:0 0 auto;padding-left:14px}",
        ".tt h1{font-size:13.5px;margin:0 0 2px;letter-spacing:1.2px;text-transform:uppercase}",
        ".tt .kv{font-size:9px;color:#444;line-height:1.5}",
        ".tt .kv b{color:#666;font-weight:600}",
        /* the scope, stated once, so a filtered sheet can never be mistaken
           for the complete one */
        ".scope{font-size:9px;color:#333;background:#f3f4f6;border-left:3px solid #111;"
          +"padding:4px 8px;margin-bottom:7px;line-height:1.45}",
        ".scope b{color:#111}",
        /* fixed layout + the measured colgroup below is what makes the table
           fill the paper in the proportions the CONTENT asks for */
        "table{width:100%;border-collapse:collapse;table-layout:fixed}",
        "th,td{border:1px solid #c8ccd0;padding:"+pad+";font-size:"+fs.toFixed(2)+"px;"
          +"line-height:1.3;text-align:left;vertical-align:top;"
          +"overflow-wrap:break-word;word-break:break-word}",
        "th{background:#eceef1;font-weight:800;text-transform:uppercase;"
          +"letter-spacing:.2px;font-size:"+Math.max(6.4,fs-0.6).toFixed(2)+"px}",
        "td.r,th.r{text-align:right;word-break:normal;overflow-wrap:normal}",
        "tbody tr:nth-child(even){background:#fafbfc}",
        /* the header repeats on every sheet and no row is torn in half */
        "thead{display:table-header-group}",
        "tr{page-break-inside:avoid;break-inside:avoid}",
        ".foot{margin-top:8px;border-top:1px solid #ddd;padding-top:4px;"
          +"font-size:8.5px;color:#777;display:flex;justify-content:space-between}",
        "@media print{.noprint{display:none}}",
        ".noprint{margin:0 0 9px;text-align:right}",
        '.noprint button{font:600 12px/1 "Segoe UI",Arial;padding:8px 16px;border:1px solid #111;'
          +"background:#111;color:#fff;border-radius:5px;cursor:pointer}",
      ].join("\n");

      const scope=[];
      if(state.q) scope.push("matching “"+state.qRaw+"”");
      if(dateIdx>=0&&(state.range.from||state.range.to))
        scope.push((head[dateIdx]||"Date")+" "+(state.range.from||"the start")+" to "+(state.range.to||"today"));
      if(state.limit>0) scope.push("first "+state.limit+" rows");
      if(k.length<head.length) scope.push(k.length+" of "+head.length+" columns");

      const printedOn=DB.helpers.iso(DB.helpers.today());
      const html='<!doctype html><html><head><meta charset="utf-8">'
        +"<title>"+esc(opts.title||"Report")+"</title><style>"+css+"</style></head><body>"
        +'<div class="noprint"><button onclick="window.print()">Print this report</button></div>'
        +'<div class="hd">'
          +'<div><div class="co">'+esc(org.name||"")+"</div>"
          +(org.tagline?'<div class="tag">'+esc(org.tagline)+"</div>":"")
          +'<div class="ids">'+esc([org.address,org.gst?"GSTIN "+org.gst:""].filter(Boolean).join("  ·  "))+"</div></div>"
          +'<div class="tt"><h1>'+esc(opts.title||"Report")+"</h1>"
          +'<div class="kv"><b>Rows</b> '+bd.length+(bd.length===rows.length?"":" of "+rows.length)+"</div>"
          +'<div class="kv"><b>Printed</b> '+esc(printedOn)+"</div></div>"
        +"</div>"
        +(scope.length?'<div class="scope"><b>This sheet is a selection:</b> '+esc(scope.join("  ·  "))+"</div>":"")
        +"<table><colgroup>"+widths.map(x=>'<col style="width:'+x+'">').join("")+"</colgroup>"
        +"<thead><tr>"
        +hd.map((x,j)=>"<th"+(numeric[j]?' class="r"':"")+">"+esc(String(x==null?"":x))+"</th>").join("")
        +"</tr></thead><tbody>"
        +bd.map(r=>"<tr>"+r.map((v,j)=>"<td"+(numeric[j]?' class="r"':"")+">"
            +esc(String(v==null||v===""?"—":v))+"</td>").join("")+"</tr>").join("")
        +"</tbody></table>"
        +'<div class="foot"><span>'+esc(org.name||"")+" · "+esc(opts.title||"Report")+"</span>"
        +"<span>"+bd.length+" row"+(bd.length===1?"":"s")+" · "+esc(printedOn)+"</span></div>"
        +"</body></html>";
      w.document.write(html);
      w.document.close();
      setTimeout(function(){ try{ w.focus(); w.print(); }catch(e){} },300);
    }
    UI.modal({title:opts.title,
      sub:"Narrow it down before you take it away — Download and Print both carry exactly what is on screen",
      wide:true, body,
      foot:[
        UI.h("button",{class:"btn",onclick:printScoped,html:"🖨 Print"}),
        UI.h("button",{class:"btn primary",onclick:()=>{
          const bd=outRows();
          if(!bd.length){ UI.toast("Nothing to download in this selection",{type:"warn"}); return; }
          CSVIO.downloadXLSX(opts.name||"data.xlsx", outHead(), bd, opts.sheet||opts.title);
          UI.toast(bd.length+" row"+(bd.length===1?"":"s")+" downloaded",{type:"ok",title:opts.title});
        },html:"⬇ Download"})]});
  }
  /* ----- Excel split-button: hover (or tap) → Import / Export ----- */
  // onExport: opens the data preview (download lives inside it). opts.onImport
  // overrides the generic auto-detecting import dialog (CSVImportUI); opts.entity
  // pre-selects which section an import lands in (e.g. "suppliers").
  function csvMenu(onExport, opts){
    opts = opts || {};
    const menu = h("div",{class:"ni-menu csv-drop",hidden:true},[
      h("button",{class:"ni-opt",onclick:e=>{e.stopPropagation();close();
        (opts.onImport || (window.CSVImportUI ? ()=>CSVImportUI.open(opts.entity)
          : ()=>UI.toast("Import unavailable",{type:"warn"})))();},html:"⬆ Import…"}),
      h("button",{class:"ni-opt",onclick:e=>{e.stopPropagation();close();onExport&&onExport();},html:"⬇ Export"}),
    ]);
    const trigger = h("button",{class:"btn"+(opts.small?" sm":"")+(opts.primary?" primary":""),
      html:"🗎 "+(opts.label||"DATA")+' <span class="caret">▾</span>'});
    const wrap = h("div",{class:"ni-drop csv-menu"},[trigger,menu]);
    function onDoc(e){ if(!wrap.contains(e.target)) close(); }
    function close(){ menu.hidden=true; trigger.classList.remove("open"); document.removeEventListener("click",onDoc); }
    function open(){ if(!menu.hidden) return; menu.hidden=false; trigger.classList.add("open"); setTimeout(()=>document.addEventListener("click",onDoc),0); }
    trigger.addEventListener("click",e=>{ e.stopPropagation(); menu.hidden?open():close(); });
    return wrap;
  }

  /* ----- one-liner Excel ▾ for a section -----
     Export → previews that section's table (the .xlsx download sits inside the
     preview); Import → the shared dialog with this section pre-selected. */
  function excelMenu(entity, opts){
    return csvMenu(()=>{
      const t = CSVIO.entityTable(entity);
      if(!t){ UI.toast("Nothing to export",{type:"warn"}); return; }
      dataPreview({title:t.label, head:t.header, rows:t.rows,
        name:"chhaperia_"+entity+".xlsx", sheet:t.label});
    }, Object.assign({entity:entity}, opts||{}));
  }

  global.M = M;
  /* phoneDigits is exported so the CRM's WhatsApp follow-up dials the same
     number this popover does. Two copies of the "assume +91" rule would
     eventually disagree, and the one that is wrong sends the message nowhere.
     mailUrls / mailChooser go out for the same reason: the CRM's "Email
     instead" composes through this chooser, so every user opens mail in the
     webmail they picked here and not in a second, differently-built one. */
  global.MW = { pageHead, readOnlyHere, loadError, kpi, chartCard, barList, donutCard, searchInput, select, dateRange, inDateRange, dl, emailLink, webLink, phoneCell, phoneDigits, mailUrls, mailChooser, csvMenu, dataPreview, excelMenu };
})(window);
