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

  function rebuild(){
    // keep the item index in sync with the dataset so newly added /
    // removed items are resolvable immediately (no full reload needed)
    for(const k in idx) delete idx[k];
    D.items.forEach(it => idx[it.id] = it);
    STOCK = {}; LEDGER = {}; USAGE = {};
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
      po.lines.forEach(l=>{ if(l.itemId===itemId) q += (l.qty - (l.recd||0)); });
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
      bom.lines.forEach(([rid,per])=>{
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
  function inventoryValue(filterFn){
    let total=0, items=0, fg=0, rm=0;
    D.items.forEach(it=>{ if(filterFn && !filterFn(it)) return;
      const v = STOCK[it.id].value; total+=v; items++;
      if(it.cat==="FG") fg+=v; else rm+=v;
    });
    return {total, items, fg, rm};
  }

  function alerts(){
    const out=[];
    D.items.forEach(it=>{
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
      if(m.type==="PROD") buckets[m.date].prod += m.qty;
      if(m.type==="SALE") buckets[m.date].sold += -m.qty;
      if(m.type==="GRN")  buckets[m.date].recv += m.qty;
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
    D.items.forEach(it=>{ map[it.cat]=(map[it.cat]||0)+STOCK[it.id].value; });
    const catName = id => (D.categories.find(c=>c.id===id)||{}).name||id;
    return Object.entries(map).filter(([,v])=>v>0).map(([id,v])=>({id, name:catName(id), value:v})).sort((a,b)=>b.value-a.value);
  }

  /* ABC analysis by annualised consumption value */
  function abcAnalysis(){
    const rows = D.items.map(it=>{
      const u=USAGE[it.id];
      const annual = (it.cat==="FG"? u.sold90 : u.used90)*(365/90);
      return {it, annualVal: annual*(it.cost||0), onHandVal:STOCK[it.id].value};
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
  const STAGES = ["New","Contacted","Quoted","Won","Lost"];
  // probability each open stage eventually closes (for weighted forecast)
  const STAGE_PROB = { New:0.15, Contacted:0.35, Quoted:0.6, Won:1, Lost:0 };

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

  /* KPIs for dashboard cards */
  function kpis(){
    const inv = inventoryValue();
    const openPO = D.purchaseorders.filter(p=>p.status!=="Received");
    const openSO = D.salesorders.filter(s=>s.status!=="Dispatched");
    const poValue = openPO.reduce((s,p)=> s + p.lines.reduce((a,l)=>a+(l.qty-(l.recd||0))*l.rate,0),0);
    const soValue = openSO.reduce((s,o)=>s+o.value,0);
    const low = D.items.filter(it=>["warn","danger"].includes(status(it.id).state)).length;
    const ser = dailySeries(30);
    const prod30 = ser.prod.reduce((a,b)=>a+b,0);
    const sold30 = ser.sold.reduce((a,b)=>a+b,0);
    const activeWO = D.workorders.filter(w=>w.status!=="Completed"&&w.status!=="Dispatched").length;
    const crm = crmStats();
    return { invValue:inv.total, fgValue:inv.fg, rmValue:inv.rm, skuCount:inv.items,
      openPO:openPO.length, poValue, openSO:openSO.length, soValue, lowStock:low,
      prod30, sold30, activeWO, alertCount: alerts().length,
      openLeads:crm.open, crmWeighted:crm.weighted, crmWinRate:crm.winRate,
      hrPendingLeaves:(D.hrLeaves||[]).filter(l=>l.status==="Pending").length };
  }

  const E = {
    init, rebuild,
    money, moneyFull, num, item,
    get data(){return D;},
    stock:(id)=>STOCK[id], usage:(id)=>USAGE[id], ledger:(id)=>LEDGER[id],
    status, pendingIn, pendingOut, wipRawDemand,
    inventoryValue, alerts, dailySeries, salesByProduct, purchaseBySupplier,
    stockByCategory, abcAnalysis, forecast, kpis, sup, custName,
    leads, crmStats, pipelineByStage, dueFollowUps, STAGES, STAGE_PROB
  };
  global.ENG = E;
})(window);
