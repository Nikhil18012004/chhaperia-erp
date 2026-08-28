/* ============================================================
   CHHAPERIA ERP — CALCULATION ENGINE
   The "auto" brain: derives stock, usage, pending, valuation,
   reorder status, ATP and forecasts from raw transactions.
   Everything here is computed — never manually keyed.
   ============================================================ */
(function (global) {
  "use strict";

  const H = global.DB.helpers;
  let D = null;                 // active dataset
  const idx = {};               // item index

  function init(data){
    D = data;
    D.items.forEach(it => idx[it.id] = it);
    rebuild();
    return E;
  }

  /* ---------- formatting (all money is ₹ / INR) ---------- */
  function money(n){ if(n==null||isNaN(n)) return "—"; const neg=n<0; n=Math.abs(n);
    let s; if(n>=1e7) s=(n/1e7).toFixed(2)+" Cr"; else if(n>=1e5) s=(n/1e5).toFixed(2)+" L"; else s=Math.round(n).toLocaleString("en-IN");
    return (neg?"-":"")+"₹"+s; }
  function moneyFull(n){ if(n==null||isNaN(n)) return "—"; return "₹"+Math.round(n).toLocaleString("en-IN"); }
  function num(n,d=0){ if(n==null||isNaN(n)) return "—"; return (+n).toLocaleString("en-IN",{maximumFractionDigits:d,minimumFractionDigits:0}); }
  function item(id){ return idx[id]; }

  /* ============================================================
     CORE: stock state derived from the movement ledger.
     For each item we compute on-hand, value (moving avg),
     and per-type aggregates over a trailing window.
     ============================================================ */
  let STOCK = {};       // itemId -> {onHand, value, avgCost, byWh:{}, lastMove}
  let LEDGER = {};      // itemId -> [movements with running balance]
  let USAGE = {};       // itemId -> {used30, used90, recv90, prod90, sold90, avgDailyUse}
  /* Derived-on-demand answers, remembered until the next rebuild.
     `status()` walks every purchase order, sales order and work order to
     work one item's position out, and `kpis()` calls it for all of them —
     so the screens that ask repeatedly (the inventory table asks once per
     row, the nav bar asked SEVEN times for its pills) were paying for the
     same arithmetic over and over. Nothing here can go stale behind the
     app's back: every path that changes the data calls rebuild() or init()
     before anything is drawn from it, and both empty these. */
  let STATUS = {};      // itemId -> status(), memoised
  let KPIS = null;      // kpis(), memoised

  function rebuild(){
    // keep the item index in sync with the dataset so newly added /
    // removed items are resolvable immediately (no full reload needed)
    for(const k in idx) delete idx[k];
    D.items.forEach(it => idx[it.id] = it);
    STOCK = {}; LEDGER = {}; USAGE = {}; STATUS = {}; KPIS = null;
    const moves = D.movements.slice().sort((a,b)=> a.date<b.date?-1:a.date>b.date?1:(a.id<b.id?-1:1));

    D.items.forEach(it=>{
      STOCK[it.id] = {onHand:0, value:0, avgCost:it.cost||0, byWh:{}, lastMove:null};
      LEDGER[it.id] = [];
    });

    moves.forEach(m=>{
      const s = STOCK[m.itemId]; if(!s) return;
      const q = m.qty;
      // moving average valuation on inbound
      if(q>0){
        const newVal = s.value + q*(m.rate ?? s.avgCost);
        const newQty = s.onHand + q;
        s.avgCost = newQty>0 ? newVal/newQty : s.avgCost;
        s.value = newVal;
      } else {
        s.value += q * s.avgCost;   // outbound at avg cost
      }
      s.onHand += q;
      if(s.onHand<0.0001 && s.onHand>-0.0001) s.onHand=0;
      s.byWh[m.wh] = (s.byWh[m.wh]||0) + q;
      s.lastMove = m.date;
      LEDGER[m.itemId].push({ ...m, balance:+s.onHand.toFixed(3) });
    });

    // usage windows
    const t = H.today().getTime();
    D.items.forEach(it=>{
      const L = LEDGER[it.id];
      let used30=0, used90=0, recv90=0, prod90=0, sold90=0, scrap90=0;
      L.forEach(m=>{
        const age = (t - new Date(m.date).getTime())/H.DAY;
        if(m.type==="ISSUE"){ if(age<=30) used30+=-m.qty; if(age<=90) used90+=-m.qty; }
        if(m.type==="GRN"  && age<=90) recv90+=m.qty;
        if(m.type==="PROD" && age<=90) prod90+=m.qty;
        if(m.type==="SALE" && age<=90) sold90+=-m.qty;
        if(m.type==="SCRAP"&& age<=90) scrap90+=-m.qty;
      });
      const consumption = it.cat==="FG" ? sold90 : used90;
      USAGE[it.id] = { used30, used90, recv90, prod90, sold90, scrap90,
        avgDailyUse: +(consumption/90).toFixed(3) };
    });
  }

  /* ============================================================
     PENDING calculations (the "pending" the user asked for)
     - pendingIn  : qty on open/partial POs not yet received
     - pendingOut : qty on open SOs not yet dispatched (demand)
     - wipDemand  : raw demand from released/in-progress WOs
     ============================================================ */
  function pendingIn(itemId){
    let q=0;
    D.purchaseorders.forEach(po=>{
      if(po.status==="Received") return;
      /* A line can be OVER-received (the truck brought more than the order
         asked for), and a negative outstanding on one line must not cancel
         out a real one still owed on another order. Nothing is owed below
         zero, so each line is floored there. */
      po.lines.forEach(l=>{ if(l.itemId===itemId) q += Math.max(0, l.qty - (l.recd||0)); });
    });
    return Math.max(0,q);
  }
  function pendingOut(itemId){
    let q=0;
    D.salesorders.forEach(so=>{
      if(so.status==="Dispatched") return;
      so.lines.forEach(l=>{ if(l.itemId===itemId) q += l.qty; });
    });
    return q;
  }
  function wipRawDemand(itemId){
    let q=0;
    D.workorders.forEach(wo=>{
      if(wo.status==="Completed"||wo.status==="Dispatched") return;
      const bom = D.boms[wo.itemId]; if(!bom) return;
      // BOM lines may be legacy tuples or rich imported objects — toLegacy
      // flattens both to [rawId, perUnitOfFG].
      BOMCALC.toLegacy(bom, BOMCALC.metaFromItem(item(wo.itemId)), null, item).forEach(([rid,per])=>{
        if(rid===itemId){
          const remaining = wo.qty * (1 - (wo.progress||0)/100);
          q += per*remaining/bom.yield;
        }
      });
    });
    return +q.toFixed(2);
  }

  /* ============================================================
     Available To Promise & reorder logic
     ============================================================ */
  function status(itemId){
    const memo = STATUS[itemId];
    return memo !== undefined ? memo : (STATUS[itemId] = computeStatus(itemId));
  }
  function computeStatus(itemId){
    const it = idx[itemId]; const s = STOCK[itemId]; const u = USAGE[itemId];
    const onHand = s.onHand;
    const pIn = pendingIn(itemId);
    const pOut = (it.cat==="FG") ? pendingOut(itemId) : wipRawDemand(itemId);
    const atp = onHand + pIn - pOut;        // available to promise / net
    const reorder = it.reorder||0, safety = it.safety||0;
    // three unified buckets: In Stock / Low Stock / Out of Stock
    let state = "ok", label="In Stock";
    if(onHand<=0){ state="danger"; label="Out of Stock"; }
    else if(onHand<=reorder){ state="warn"; label="Low Stock"; }
    // days of cover
    const dailyDemand = it.cat==="FG" ? (u.sold90/90) : Math.max(u.used90/90, wipRawDemand(itemId)/Math.max(it.lead,1));
    const cover = dailyDemand>0 ? onHand/dailyDemand : 999;
    // suggested order
    const target = reorder + safety;
    const suggest = (onHand+pIn) < reorder ? Math.max(it.moq||0, Math.ceil((target - (onHand+pIn))/10)*10) : 0;
    return { onHand:+onHand.toFixed(2), value:s.value, avgCost:s.avgCost, pIn:+pIn.toFixed(2), pOut:+pOut.toFixed(2),
      atp:+atp.toFixed(2), state, label, cover:Math.round(cover), suggest, reorder, safety,
      fillPct: reorder? Math.min(100, Math.round(onHand/(reorder*2)*100)) : 60 };
  }

  /* ============================================================
     Aggregations for dashboards
     ============================================================ */
  /* WIP is not stocked: a production stage hands its output straight to the
     next stage, so nothing is ever booked as work-in-process. The leftover
     WIP items from the old stage engine are excluded everywhere. */
  const stocked = it => it && it.cat!=="WIP";

  function inventoryValue(filterFn){
    let total=0, items=0, fg=0, rm=0;
    D.items.forEach(it=>{ if(!stocked(it)) return; if(filterFn && !filterFn(it)) return;
      const v = STOCK[it.id].value; total+=v; items++;
      if(it.cat==="FG") fg+=v; else rm+=v;
    });
    return {total, items, fg, rm};
  }

  function alerts(){
    const out=[];
    D.items.forEach(it=>{
      if(!stocked(it)) return;
      const st = status(it.id);
      if(st.state==="danger") out.push({sev:"danger", ic: st.onHand<=0?"⛔":"🔻",
        title:`${it.name}`, desc:`${st.label} — ${num(st.onHand)} ${it.uom} on hand (safety ${num(it.safety)})`,
        kind:"stock", itemId:it.id, ts:0});
      else if(st.state==="warn") out.push({sev:"warn", ic:"⚠️",
        title:`${it.name}`, desc:`Below reorder point — suggest order ${num(st.suggest)} ${it.uom}`,
        kind:"stock", itemId:it.id, ts:1});
    });
    // overdue POs
    const tISO = H.iso(H.today());
    D.purchaseorders.forEach(po=>{
      if(po.status!=="Received" && po.eta < tISO){
        out.push({sev:"warn", ic:"🚚", title:`PO ${po.id} overdue`,
          desc:`${sup(po.supplierId)} — ETA was ${po.eta}`, kind:"po", id:po.id, ts:2});
      }
    });
    // urgent open SOs
    D.salesorders.forEach(so=>{
      if(so.status!=="Dispatched" && (so.priority==="Urgent"||so.promised<tISO)){
        out.push({sev: so.promised<tISO?"danger":"info", ic:"📦",
          title:`SO ${so.id} ${so.promised<tISO?"overdue":"urgent"}`,
          desc:`${custName(so.customerId)} — promised ${so.promised}`, kind:"so", id:so.id, ts:3});
      }
    });
    // CRM follow-ups due / overdue
    (D.leads||[]).forEach(l=>{
      if(l.stage!=="Won" && l.stage!=="Lost" && l.nextFollowUp && l.nextFollowUp<=tISO){
        const overdue = l.nextFollowUp < tISO;
        out.push({sev: overdue?"warn":"info", ic:"🎯",
          title:`Follow up: ${l.company}`,
          desc:`${l.stage} lead — ${overdue?"overdue since":"due"} ${l.nextFollowUp}`,
          kind:"lead", id:l.id, ts:4});
      }
    });
    /* MATERIAL THAT FAILED ITS INCOMING TEST AND IS WAITING ON A RULING.
       This is the loudest thing in the list on purpose: the lot is sitting in
       the store, drawable by the next work order, until an admin either
       approves the rejection (it goes to quarantine) or declines it (it stands
       as good stock). The list comes from the server (grnTestService
       .pendingDecisions) so the badge and the page cannot disagree. */
    (D.grnQcDecisions||[]).forEach(q=>{
      out.push({sev:"danger", ic:"⛔",
        title:`${q.itemName} failed incoming test`,
        desc:`${q.grnId}${q.poId?" · "+q.poId:""} — ${q.failed&&q.failed.length?q.failed.join(", ")+" out of limit":"out of limit"}`
          +` · ${num(q.acceptedQty)} ${q.uom||""} awaiting your approval to quarantine`,
        kind:"qcDecision", id:q.id, ts:-1});
    });
    return out.sort((a,b)=> ({danger:0,warn:1,info:2})[a.sev]-({danger:0,warn:1,info:2})[b.sev]);
  }

  /* ---------- name helpers ---------- */
  function sup(id){ const s=D.suppliers.find(x=>x.id===id); return s?s.name:id; }
  function custName(id){ const c=D.customers.find(x=>x.id===id); return c?c.name:id; }

  /* ============================================================
     Time series for charts
     ============================================================ */
  function dailySeries(days=30){
    const labels=[], prod=[], sold=[], recv=[];
    const t = H.today().getTime();
    const buckets={};
    for(let i=days-1;i>=0;i--){ const d=H.iso(t-i*H.DAY); buckets[d]={prod:0,sold:0,recv:0}; labels.push(d); }
    D.movements.forEach(m=>{
      if(!(m.date in buckets)) return;
      if(m.type==="SALE") buckets[m.date].sold += -m.qty;
      if(m.type==="GRN")  buckets[m.date].recv += m.qty;
    });
    /* Production output comes from FINISHED WORK ORDERS, not from stock
       receipts: a completed job is never booked into a store (see the stage
       service), so the ledger has nothing to count. A job counts on the day
       its last stage was completed. */
    (D.workorders||[]).forEach(w=>{
      const last=(w.route||[]).slice(-1)[0]||{};
      const done=w.packedAt || last.doneAt || null;
      const d=done? String(done).slice(0,10) : null;
      if(d && (d in buckets)) buckets[d].prod += (+w.qty||0);
    });
    labels.forEach(d=>{ prod.push(+buckets[d].prod.toFixed(1)); sold.push(+buckets[d].sold.toFixed(1)); recv.push(+buckets[d].recv.toFixed(1)); });
    return {labels, prod, sold, recv};
  }

  function salesByProduct(days=90){
    const t=H.today().getTime(); const map={};
    D.movements.forEach(m=>{
      if(m.type!=="SALE") return;
      if((t-new Date(m.date).getTime())/H.DAY>days) return;
      const it=idx[m.itemId];
      map[m.itemId] = (map[m.itemId]||0) + (-m.qty)*(it.price||it.cost);
    });
    return Object.entries(map).map(([id,v])=>({id, name:idx[id].name, value:v}))
      .sort((a,b)=>b.value-a.value);
  }

  function purchaseBySupplier(days=120){
    const t=H.today().getTime(); const map={};
    D.movements.forEach(m=>{
      if(m.type!=="GRN") return;
      if((t-new Date(m.date).getTime())/H.DAY>days) return;
      const sid = m.supplierId || (idx[m.itemId]||{}).supplierId; if(!sid) return;
      map[sid]=(map[sid]||0)+m.qty*(m.rate||0);
    });
    return Object.entries(map).map(([id,v])=>({id, name:sup(id), value:v})).sort((a,b)=>b.value-a.value);
  }

  function stockByCategory(){
    const map={};
    D.items.forEach(it=>{ if(!stocked(it)) return; map[it.cat]=(map[it.cat]||0)+STOCK[it.id].value; });
    const catName = id => (D.categories.find(c=>c.id===id)||{}).name||id;
    return Object.entries(map).filter(([,v])=>v>0).map(([id,v])=>({id, name:catName(id), value:v})).sort((a,b)=>b.value-a.value);
  }

  /* ABC analysis by annualised transaction value. Purchases (GRN),
     sales (SALE) and production issues (ISSUE) all count, so the moment
     a new entry is saved (every save path calls rebuild()) the volumes
     change and items re-rank across A/B/C automatically. */
  function abcAnalysis(){
    const rows = D.items.filter(stocked).map(it=>{
      const u=USAGE[it.id];
      const vol90 = u.recv90 + u.sold90 + u.used90;   // purchase + sales + consumption volume
      const annual = vol90*(365/90);
      return {it, vol90, annualVal: annual*(it.cost||0), onHandVal:STOCK[it.id].value};
    }).sort((a,b)=>b.annualVal-a.annualVal);
    const tot = rows.reduce((s,r)=>s+r.annualVal,0)||1;
    let cum=0;
    rows.forEach(r=>{ cum+=r.annualVal; r.cumPct=cum/tot*100;
      r.class = r.cumPct<=70?"A":r.cumPct<=90?"B":"C"; });
    return rows;
  }

  /* simple demand forecast (moving avg + slope) for next N days */
  function forecast(itemId, days=30){
    const t=H.today().getTime(); const series=[];
    for(let i=89;i>=0;i--){ series.push(0); }
    D.movements.forEach(m=>{
      const age = Math.floor((t-new Date(m.date).getTime())/H.DAY);
      if(age<0||age>89) return;
      const it=idx[itemId];
      const relevant = it.cat==="FG"? m.type==="SALE" : m.type==="ISSUE";
      if(m.itemId===itemId && relevant) series[89-age]+= Math.abs(m.qty);
    });
    const avg = series.reduce((a,b)=>a+b,0)/series.length;
    // linear slope
    const n=series.length; let sx=0,sy=0,sxy=0,sxx=0;
    series.forEach((y,x)=>{sx+=x;sy+=y;sxy+=x*y;sxx+=x*x;});
    const slope=(n*sxy-sx*sy)/(n*sxx-sx*sx||1);
    const fc=[]; for(let i=1;i<=days;i++){ fc.push(Math.max(0, avg + slope*(n+i-n/2))); }
    return {avg, slope, projected:fc, projTotal:fc.reduce((a,b)=>a+b,0)};
  }

  /* ============================================================
     CRM — pipeline analytics, weighted forecast, follow-up reminders
     ============================================================ */
  /* "Sample" sits between Contacted and Quoted: a cable-tape buyer almost
     never takes a price before running our tape on their line, so the sample
     that goes out ahead of the quotation is its own step of the pipeline. */
  const STAGES = ["New","Contacted","Sample","Quoted","Won","Lost"];
  // probability each open stage eventually closes (for weighted forecast)
  // a lead that asked for and received a sample is warmer than one merely
  // contacted, but colder than one already holding a price
  const STAGE_PROB = { New:0.15, Contacted:0.35, Sample:0.45, Quoted:0.6, Won:1, Lost:0 };

  function leads(){ return D.leads || []; }

  function crmStats(){
    const ls = leads();
    const open = ls.filter(l=>l.stage!=="Won" && l.stage!=="Lost");
    const won = ls.filter(l=>l.stage==="Won");
    const lost = ls.filter(l=>l.stage==="Lost");
    const openValue = open.reduce((s,l)=>s+(l.value||0),0);
    const wonValue = won.reduce((s,l)=>s+(l.quotedValue||l.value||0),0);
    // weighted pipeline = sum(value * stage probability) over open leads
    const weighted = open.reduce((s,l)=>s+(l.value||0)*(STAGE_PROB[l.stage]||0),0);
    const decided = won.length + lost.length;
    const winRate = decided ? Math.round(won.length/decided*100) : 0;
    return { total:ls.length, open:open.length, won:won.length, lost:lost.length,
      openValue, wonValue, weighted, winRate };
  }

  function pipelineByStage(){
    const ls = leads();
    return STAGES.map(st=>{
      const items = ls.filter(l=>l.stage===st);
      return { stage:st, count:items.length, value:items.reduce((s,l)=>s+(l.value||0),0), items };
    });
  }

  /* follow-ups due today or overdue (open leads only) */
  function dueFollowUps(){
    const t = H.iso(H.today());
    return leads().filter(l=> l.stage!=="Won" && l.stage!=="Lost" && l.nextFollowUp && l.nextFollowUp <= t)
      .sort((a,b)=> (a.nextFollowUp<b.nextFollowUp?-1:1));
  }

  /* ---- why a lead was lost ----
     One fixed list, shared by the CRM (the Mark Lost form), the Customers
     screen (the "Why we lost" card) and the quotation's Mark Lost, so every
     screen groups the same way. Leads closed before the list existed carry
     free text; normaliseReason() folds the common phrasings onto the list at
     READ time — the stored value is never rewritten, so nothing is lost if
     this mapping is ever wrong. */
  const LOST_REASONS = ["Price", "Lead time", "Quality / spec", "No response", "Budget dropped", "Existing supplier", "Other"];
  function normaliseReason(raw){
    const s = String(raw || "").trim();
    if(!s) return "Not specified";
    if(LOST_REASONS.includes(s)) return s;
    const t = s.toLowerCase();
    if(/price|cost|rate|expensive|costly/.test(t)) return "Price";
    if(/lead ?time|deliver|late|schedule/.test(t)) return "Lead time";
    if(/qualit|spec|reject|fail|sample/.test(t)) return "Quality / spec";
    if(/no response|not respond|silent|unreach|no reply/.test(t)) return "No response";
    if(/budget|postpon|defer|hold/.test(t)) return "Budget dropped";
    if(/existing|already|current supplier|loyal/.test(t)) return "Existing supplier";
    return "Other";
  }

  /* ---- days between an ISO date and today (negative = in the future) ---- */
  function daysSince(iso){
    if(!iso) return null;
    const d = Math.round((H.today() - new Date(String(iso).slice(0,10)+"T00:00:00"))/86400000);
    return isNaN(d) ? null : d;
  }

  /* ============================================================
     DEAL ROT — how long a lead has sat untouched.
     Every CRM worth using flags the deal nobody has rung in a
     fortnight, because a pipeline's real enemy is not the lost
     deal, it is the one quietly going stale. The tolerance differs
     by stage: a brand-new enquiry left a week is already neglect,
     while a lead waiting on a customer's own trial line reasonably
     takes longer, so Sample is given the longest leash.
     ============================================================ */
  const ROT_DAYS = { New:7, Contacted:10, Sample:21, Quoted:14 };

  /** Last time anyone actually touched this lead — newest activity,
      else the day it was created. */
  function lastTouch(l){
    const acts = (l && l.activities) || [];
    let newest = null;
    acts.forEach(a=>{ const d=String(a.date||"").slice(0,10); if(d && (!newest || d>newest)) newest=d; });
    return newest || (l && l.created) || null;
  }

  /** { idle, limit, rotting, ratio } — null for closed leads, which cannot rot. */
  function leadRot(l){
    if(!l || l.stage==="Won" || l.stage==="Lost") return null;
    const limit = ROT_DAYS[l.stage] || 14;
    const idle = daysSince(lastTouch(l));
    if(idle==null) return null;
    return { idle, limit, rotting: idle > limit, ratio: Math.min(2, idle/limit) };
  }

  /* ============================================================
     LEAD SCORE — one 0-100 number for "who do I ring first?".
     Deliberately explainable rather than clever: the sales desk
     has to trust it, so every point is traceable to a reason it
     can see on the lead. Four inputs, each capped so no single
     one can carry a weak lead:
       value    how big the deal is, against the current book
       stage    how far it has actually travelled
       warmth   how recently anyone touched it (decays)
       signal   sample verdict + source quality — the real intent
     ============================================================ */
  const SOURCE_WEIGHT = {
    "Existing Customer":10, "Referral":9, "Exhibition (Wire India)":8,
    "Website Enquiry":6, "Trade Directory":4, "Cold Call":3,
  };

  function leadScore(l){
    if(!l) return { score:0, parts:[] };
    const parts = [];

    // --- deal size, relative to the biggest open lead on the book (max 30)
    const open = leads().filter(x=>x.stage!=="Won"&&x.stage!=="Lost");
    const top = Math.max(1, ...open.map(x=>x.value||0));
    const vPts = Math.round(Math.min(1,(l.value||0)/top)*30);
    parts.push({ k:"Deal size", pts:vPts, max:30, why: money(l.value||0)+" of "+money(top)+" top open" });

    // --- how far down the pipeline it has come (max 25)
    const sPts = Math.round((STAGE_PROB[l.stage]||0)*25/0.6);
    parts.push({ k:"Stage", pts:Math.min(25,sPts), max:25, why:l.stage+" · "+Math.round((STAGE_PROB[l.stage]||0)*100)+"% typical close" });

    // --- warmth: touched today is full marks, decaying to nothing at 30 days (max 25)
    const idle = daysSince(lastTouch(l));
    const wPts = idle==null ? 0 : Math.round(Math.max(0,1-idle/30)*25);
    parts.push({ k:"Warmth", pts:wPts, max:25,
      why: idle==null ? "never touched" : idle<=0 ? "touched today" : idle+" days since contact" });

    // --- intent signal: what the sample said, and where it came from (max 20)
    let iPts = SOURCE_WEIGHT[l.source] || 3;
    let iWhy = l.source || "source not set";
    const verdict = l.sample && l.sample.verdict;
    if(verdict==="Approved"){ iPts = 20; iWhy = "sample APPROVED"; }
    else if(verdict==="Rework needed"){ iPts = Math.max(iPts,8); iWhy = "sample needs rework"; }
    else if(verdict==="Rejected"){ iPts = 1; iWhy = "sample rejected"; }
    parts.push({ k:"Intent", pts:Math.min(20,iPts), max:20, why:iWhy });

    const score = parts.reduce((s,p)=>s+p.pts,0);
    return { score:Math.max(0,Math.min(100,score)), parts,
      band: score>=70 ? "hot" : score>=45 ? "warm" : "cold" };
  }

  /* ============================================================
     STAGE CONVERSION — of every lead that ever reached this stage,
     how many went on to the next one, and how long they sat there.
     A lead that is Won reached every open stage on the way, so
     progress is measured by pipeline ORDER, not by where the lead
     happens to be parked today. Without that, a healthy pipeline
     that closes fast would report 0% conversion everywhere.
     ============================================================ */
  function stageConversion(){
    const ls = leads();
    const open = STAGES.filter(s=>s!=="Won"&&s!=="Lost");
    const rank = {}; open.forEach((s,i)=>{ rank[s]=i; });
    // where each lead got to: Won counts as having cleared every open stage
    const reached = (l) => l.stage==="Won" ? open.length
                        : l.stage==="Lost" ? (rank[l.lostAtStage]!=null?rank[l.lostAtStage]:0)
                        : (rank[l.stage]!=null?rank[l.stage]:0);
    return open.map((st,i)=>{
      const got  = ls.filter(l=>reached(l)>=i);
      const next = ls.filter(l=>reached(l)>=i+1);
      const here = ls.filter(l=>l.stage===st);
      const ages = here.map(l=>daysSince(l.created)).filter(d=>d!=null);
      return { stage:st, reached:got.length, advanced:next.length,
        rate: got.length ? Math.round(next.length/got.length*100) : 0,
        avgDays: ages.length ? Math.round(ages.reduce((a,b)=>a+b,0)/ages.length) : null };
    });
  }

  /** Average days from creation to close, over decided leads. */
  function salesCycleDays(){
    const done = leads().filter(l=>l.stage==="Won"||l.stage==="Lost");
    const ds = done.map(l=>{
      const end = lastTouch(l), start = l.created;
      if(!end||!start) return null;
      const d = Math.round((new Date(end+"T00:00:00")-new Date(start+"T00:00:00"))/86400000);
      return isNaN(d)||d<0 ? null : d;
    }).filter(d=>d!=null);
    return ds.length ? Math.round(ds.reduce((a,b)=>a+b,0)/ds.length) : null;
  }

  /* ============================================================
     FORECAST — open leads bucketed by the month they are expected
     to close, split into what is already committed (Quoted, a price
     is on the table) and the rest of the weighted pipeline.
     A lead with no expected-close date is not guessed at; it is
     reported separately so the number stays honest.
     ============================================================ */
  function forecastByMonth(n){
    n = n || 6;
    const t = H.today();
    const keys = [];
    for(let i=0;i<n;i++){
      const d = new Date(t.getFullYear(), t.getMonth()+i, 1);
      keys.push(d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0"));
    }
    const map = {}; keys.forEach(k=>{ map[k]={ key:k, commit:0, weighted:0, count:0, items:[] }; });
    const bucket = () => ({ count:0, weighted:0, items:[] });
    /* A close date that has already been and gone is NOT a distant deal — it
       is a deal that slipped. Reporting it as "beyond the window" would flatter
       the forecast and hide exactly the leads that need re-dating today. */
    let undated = bucket(), beyond = bucket(), overdue = bucket();
    leads().filter(l=>l.stage!=="Won"&&l.stage!=="Lost").forEach(l=>{
      const w = (l.value||0)*(STAGE_PROB[l.stage]||0);
      const k = String(l.expectedClose||"").slice(0,7);
      const put = (b)=>{ b.count++; b.weighted+=w; b.items.push(l); };
      if(!k){ put(undated); return; }
      if(k < keys[0]){ put(overdue); return; }
      if(!map[k]){ put(beyond); return; }
      map[k].count++; map[k].weighted+=w; map[k].items.push(l);
      if(l.stage==="Quoted") map[k].commit += (l.quotedValue||l.value||0);
    });
    return { months:keys.map(k=>map[k]), undated, beyond, overdue };
  }

  /* KPIs for dashboard cards */
  function kpis(){
    return KPIS || (KPIS = computeKpis());
  }
  function computeKpis(){
    const inv = inventoryValue();
    const openPO = D.purchaseorders.filter(p=>p.status!=="Received");
    const openSO = D.salesorders.filter(s=>s.status!=="Dispatched");
    const poValue = openPO.reduce((s,p)=> s + p.lines.reduce((a,l)=>a+Math.max(0,l.qty-(l.recd||0))*l.rate,0),0);
    const soValue = openSO.reduce((s,o)=>s+o.value,0);
    const low = D.items.filter(it=>["warn","danger"].includes(status(it.id).state)).length;
    const ser = dailySeries(30);
    const prod30 = ser.prod.reduce((a,b)=>a+b,0);
    const sold30 = ser.sold.reduce((a,b)=>a+b,0);
    const activeWO = D.workorders.filter(w=>w.status!=="Completed"&&w.status!=="Dispatched").length;
    const crm = crmStats();
    const whList = D.warehouses||[];
    const whActive = whList.filter(w=> D.items.some(it=> (((STOCK[it.id]||{}).byWh||{})[w.id]||0) > 0.001)).length;
    return { invValue:inv.total, fgValue:inv.fg, rmValue:inv.rm, skuCount:inv.items,
      whTotal:whList.length, whActive,
      openPO:openPO.length, poValue, openSO:openSO.length, soValue, lowStock:low,
      prod30, sold30, activeWO, alertCount: alerts().length,
      openLeads:crm.open, crmWeighted:crm.weighted, crmWinRate:crm.winRate,
      /* Batches still owing a QC reading — the server works the list out
         (labService.pendingLabWork); this is only its count, for the nav pill.
         Every role counts the same batches, because the lab incharge works
         the same list the office sees. */
      // the Lab Reports badge: batches awaiting a certificate PLUS received
      // PO lines awaiting an incoming test — both worklists live on that page
      labPending:(D.labPending||[]).length+(D.grnTestPending||[]).length,
      /* Two separate counts on the Procurement pill's behalf: materials the
         lab still has to measure, and failed lots waiting on an admin ruling.
         A ruling is the more urgent of the two — the stock is live meanwhile. */
      grnTestPending:(D.grnTestPending||[]).length,
      grnQcDecisions:(D.grnQcDecisions||[]).length,
      /* Quotations still open — a price on the table with no yes or no yet */
      openQuotes:(D.quotations||[]).filter(q=>q.status==="Open").length,
      hrPendingLeaves:(D.hrLeaves||[]).filter(l=>l.status==="Pending").length };
  }

  /* ============================================================
     CUSTOMERS WHO HAVE GONE QUIET
     The CRM watches prospects closely and forgets the people who already
     buy — yet winning a lapsed customer back is far cheaper than any lead.
     Silence is the only warning you get: nobody sends a note saying they
     have stopped ordering.

     Their own order history states the rhythm, so this needs no new data
     and nothing to maintain. The gap used is the MEDIAN, not the mean, so
     one freak rush order cannot make a steady customer look erratic, and
     THREE orders are required before a rhythm is claimed at all — two
     orders give exactly one gap, which is a coincidence, not a pattern.
     ============================================================ */
  function daysApart(a, b){
    return Math.round((new Date(b+"T00:00:00") - new Date(a+"T00:00:00")) / H.DAY);
  }
  function dormantCustomers(){
    const t = H.iso(H.today());
    const out = [];
    (D.customers||[]).forEach(c=>{
      const mine = (D.salesorders||[]).filter(s=>s.customerId===c.id && s.date);
      if(mine.length < 3) return;
      const dates = mine.map(s=>s.date).sort();
      const gaps = [];
      for(let i=1;i<dates.length;i++) gaps.push(daysApart(dates[i-1], dates[i]));
      gaps.sort((a,b)=>a-b);
      const usual = gaps[Math.floor(gaps.length/2)];
      if(!(usual > 0)) return;
      const lastDate = dates[dates.length-1];
      const silent = daysApart(lastDate, t);
      // 1.5x the usual gap is late; anything under that is just this month
      if(silent <= usual * 1.5) return;
      const value = mine.reduce((a,s)=>a+(+s.value||0),0);
      const avg = value / mine.length;
      const missed = Math.max(1, Math.floor(silent / usual) - 1);
      const lastSO = mine.filter(s=>s.date===lastDate).map(s=>s.id)[0] || "";
      out.push({ id:c.id, name:c.name, orders:mine.length, usual, silent, lastDate, lastSO,
        atRisk: Math.round(avg * missed),
        level: silent > usual * 3 ? "chase" : "watch" });
    });
    // worst offender first, measured against their OWN rhythm rather than in
    // raw days — 60 days quiet is alarming for a monthly buyer and normal for
    // one who orders twice a year
    return out.sort((a,b)=> (b.silent/b.usual) - (a.silent/a.usual));
  }


  /* ============================================================
     READY TO SELL — finished work orders held for a sales order.
     A production stage never books stock in, so a job that has run all the way
     through (slitting, packing) is not inventory: it is a quantity standing
     ready. It stays reserved against its work order until a sales order line
     claims it (the line's Batch = the W.O. number), and what a line claims is
     deducted here, so the same run can never be sold twice.
     ============================================================ */
  function readyBatches(itemId){
    const wos=(D.workorders||[]).filter(w=>
      (!itemId || w.itemId===itemId) && !w.dispatched &&
      (w.route||[]).length && (w.route||[]).every(r=>r.status==="Completed"));
    // what each work order has already been claimed for, across all open orders
    const claimed={};
    (D.salesorders||[]).forEach(so=>{
      if(so.status==="Cancelled") return;
      (so.lines||[]).forEach(l=>{ if(l.batch) claimed[l.batch]=(claimed[l.batch]||0)+(+l.qty||0); });
    });
    return wos.map(w=>{
      const used=claimed[w.id]||0;
      /* What is sellable is what has actually been PRODUCED, less anything
         already shipped — not what was ordered. An order still owing material
         has made only part of its quantity, and selling the rest of it would
         promise goods that do not exist. A work order with no partial fields
         (every ordinary one) falls back to its ordered quantity and behaves
         exactly as before. */
      const ordered=+w.qty||0;
      const partial=(w.runQty!=null||w.completedQty!=null||w.pendingQty!=null);
      const made=partial
        ? Math.round(((+w.completedQty||0)+(+w.runQty||0))*1000)/1000
        : ordered;
      const sent=+w.dispatchedQty||0;
      const sellable=Math.max(0, made-sent);
      return { id:w.id, itemId:w.itemId,
               ordered, made, sent, pending:+w.pendingQty||0,
               claimed:used,
               free:Math.max(0, sellable-used),
               // the width this run was slit to — travels with the batch so a
               // sales order shows the dimensions of the stock it is claiming
               widthMM:(w.widthMM!=null&&w.widthMM!=="")?+w.widthMM:null,
               doneAt:w.packedAt||((w.route||[]).slice(-1)[0]||{}).doneAt||w.date||"" };
    }).sort((a,b)=>(a.doneAt<b.doneAt?1:-1));
  }
  /* free-to-sell quantity for a product (0 when nothing has finished) */
  function readyQty(itemId){
    return readyBatches(itemId).reduce((n,b)=>n+b.free,0);
  }

  /* ============================================================
     WEIGHT — every raw material read in kilograms.
     The factory buys sheet goods by the metre and pastes by the
     kilo, but thinks about all of it by weight. These turn an
     item's own unit into kg where the item carries enough data
     to say so, and return null where it does not — a missing
     figure must read as "not known", never as 0 kg.

       MTR   metres of web:  m × (width mm ÷ 1000) × gsm ÷ 1000
       SQM   area:           m² × gsm ÷ 1000
       GRAM / MG            arithmetic
       ROLL / PLT / BOX     only via an explicit kg-per-unit on the
                            item (kgPerUnit); nothing to derive from.
     ============================================================ */
  const KG_PER = { KG: 1, KGS: 1, KILOGRAM: 1, GRAM: 1e-3, GM: 1e-3, G: 1e-3, MG: 1e-6, TON: 1000, MT: 1000 };
  const pos = (v) => { const n = +v; return isFinite(n) && n > 0 ? n : null; };

  /** kg for ONE unit of this item, or null when the data does not exist yet. */
  function kgPerUnit(it){
    if(!it) return null;
    const u = String(it.uom||"").trim().toUpperCase();
    if(KG_PER[u] != null) return KG_PER[u];
    const explicit = pos(it.kgPerUnit);      // set per item once its weight is known
    if(explicit) return explicit;
    const gsm = pos(it.gsm);                 // g/m²
    if(u === "SQM") return gsm ? gsm/1000 : null;
    if(u === "MTR" || u === "MTRS" || u === "M"){
      const width = pos(it.width);           // mm across the web
      return (gsm && width) ? (width/1000) * (gsm/1000) : null;
    }
    return null;                             // ROLL / PLT / BOX and anything unrecognised
  }
  /** qty of `it` expressed in kg, or null when it cannot be known. */
  function kg(it, qty){
    const per = kgPerUnit(it);
    if(per == null) return null;
    const q = +qty; if(!isFinite(q)) return null;
    return q * per;
  }
  /** true when the item is already carried in kilograms (no second figure needed) */
  function isKg(it){ return String((it&&it.uom)||"").trim().toUpperCase() === "KG"; }
  /** " · 24 kg" to append after a quantity, or "" when kg adds nothing */
  function kgSuffix(it, qty){
    /* Nothing to append when the figure in front of it is ALREADY a weight —
       whether the material is kept in kilograms or is web read as kilograms
       by qtyText() below. "204 kg · 204 kg" helps nobody. */
    if(isKg(it) || readsAsKg(it)) return "";
    const w = kg(it, qty);
    return w == null ? "" : " · " + num(w, w < 10 ? 2 : 0) + " kg";
  }

  /* ============================================================
     HOW A QUANTITY IS READ

     The factory buys web by the metre and stocks it that way, but
     everyone who handles it — the store, the floor, the office —
     thinks in kilograms. So a length is RESTATED as a weight
     wherever a quantity is shown: screens and printed documents
     alike. What is stored never changes; only what is read.

     Only LENGTH is restated. A material kept in rolls, pallets,
     boxes, grams or millilitres keeps its own unit, because that
     is how the floor counts it.

     A metre-stocked material carrying no width or GSM cannot be
     weighed, so it goes on reading in metres. An honest metre
     beats an invented kilogram.
     ============================================================ */
  const LEN_UNITS = { MTR:1, MTRS:1, M:1, METER:1, METERS:1, METRE:1, METRES:1 };
  /** true when the item is stocked by length */
  function isLen(it){ return LEN_UNITS[String((it&&it.uom)||"").trim().toUpperCase()] === 1; }
  /** true when a length-stocked item carries enough geometry to be weighed */
  function readsAsKg(it){ return isLen(it) && kgPerUnit(it) != null; }
  /** the unit a quantity of `it` is SHOWN in.
     Kilograms are written "kg" whether the material is KEPT in kilograms or is
     web restated into them — a ledger printing "-2 KG" on one row and
     "-9.45 kg" on the next reads as two different units to the person checking
     it. Everything else keeps the unit as the catalogue spells it.
     Printed documents upper-case this themselves; they are a different
     register from the screen. */
  function dispUom(it){ return (readsAsKg(it) || isKg(it)) ? "kg" : ((it && it.uom) || ""); }
  /** `qty` restated into the unit dispUom() names; unchanged when it cannot be */
  function dispQty(it, qty){
    if(!readsAsKg(it)) return +qty;
    const w = kg(it, qty);
    return w == null ? +qty : w;
  }
  /** a rate per metre restated per kilogram, so qty × rate is unchanged */
  function dispRate(it, rate, uom){
    const u = String(uom || (it&&it.uom) || "").trim().toUpperCase();
    if(!readsAsKg(it) || LEN_UNITS[u] !== 1) return +rate;
    const per = kgPerUnit(it);
    return per ? (+rate) / per : +rate;
  }
  /** "204.00 kg" — a quantity written with the unit it is read in */
  function qtyText(it, qty, dp){
    const u = dispUom(it);
    return num(dispQty(it, qty), dp == null ? 2 : dp) + (u ? " " + u : "");
  }

  const E = {
    init, rebuild,
    money, moneyFull, num, item,
    kg, kgPerUnit, kgSuffix, isKg,
    isLen, readsAsKg, dispUom, dispQty, dispRate, qtyText,
    get data(){return D;},
    stock:(id)=>STOCK[id], usage:(id)=>USAGE[id], ledger:(id)=>LEDGER[id],
    status, pendingIn, pendingOut, wipRawDemand, readyBatches, readyQty,
    inventoryValue, alerts, dailySeries, salesByProduct, purchaseBySupplier,
    stockByCategory, abcAnalysis, forecast, kpis, sup, custName,
    leads, crmStats, pipelineByStage, dueFollowUps, dormantCustomers, STAGES, STAGE_PROB,
    LOST_REASONS, normaliseReason,
    leadScore, leadRot, lastTouch, stageConversion, salesCycleDays, forecastByMonth, ROT_DAYS
  };
  global.ENG = E;
})(window);
