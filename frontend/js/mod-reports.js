/* ============================================================
   CHHAPERIA ERP — REPORTS & SETTINGS
   ============================================================ */
(function () {
  "use strict";
  const {h, esc, table, badge, toast, modal, confirm} = UI;
  const {pageHead, kpi} = MW;
  const U = window._erpUtil;

  /* ============== REPORTS ============== */
  M.reports = { title:"Reports", sub:"Exportable business reports", render(root){
    root.appendChild(pageHead("Reports & Exports",
      "Every report and sheet the system can produce, in one place — each opens on screen first, and downloads as .xlsx from there"));

    const reports=[
      {ic:"📦",name:"Stock Valuation Report",desc:"On-hand qty, avg cost & total value per item",accent:"--c1",fn:repStock},
      {ic:"🔻",name:"Reorder / Low-Stock Report",desc:"Items below reorder with suggested order qty",accent:"--c6",fn:repReorder},
      {ic:"📒",name:"Stock Movement Ledger",desc:"Full transaction history with running balance",accent:"--c7",fn:repLedger},
      {ic:"🛒",name:"Open Purchase Orders",desc:"Orders still owing goods, soonest ETA first",accent:"--c2",fn:repPO},
      {ic:"📑",name:"Purchase Order Register",desc:"Every order raised — what, from whom, for how much, landed or not",accent:"--c2",fn:repPoRegister},
      {ic:"🧾",name:"Purchase Order Lines",desc:"One row per material ordered, with rate, value and what is still due",accent:"--c7",fn:repPoLines},
      {ic:"🧾",name:"Sales Order Backlog",desc:"Open demand, promised dates & fulfillability",accent:"--c8",fn:repSO},
      {ic:"🧬",name:"BOM Cost Roll-up",desc:"Material cost & margin for each finished tape",accent:"--c3",fn:repBOM},
      {ic:"📊",name:"ABC Classification",desc:"Pareto inventory ranking by consumption value",accent:"--c5",fn:repABC},
      {ic:"⚙️",name:"Production Output Report",desc:"Work orders, output & yield over time",accent:"--c4",fn:repProd},
      /* THE REST OF THE BUSINESS. Stock, buying, selling and making each had a
         report here; the lab, the CRM, the quote desk, the dispatch gate and
         the question "where is it actually kept" had none, and were reachable
         only from their own page — so this section was never the one place to
         come for a figure. */
      {ic:"🏬",name:"Stock by Warehouse",desc:"What each store holds, item by item, with value",accent:"--c2",fn:repByWh},
      {ic:"🧪",name:"Lab Test Reports",desc:"Every test filed, its readings and pass / fail",accent:"--c7",fn:repLab},
      {ic:"📄",name:"Quotation Pipeline",desc:"Quotes raised, rounds, status and value",accent:"--c8",fn:repQuotes},
      {ic:"🎯",name:"CRM Lead Pipeline",desc:"Leads by stage, owner and expected value",accent:"--c5",fn:repLeads},
      {ic:"🚚",name:"Dispatch Register",desc:"What went out, to whom, on which vehicle",accent:"--c4",fn:repDispatch},
      {ic:"⏸",name:"Orders Awaiting Material",desc:"Work orders held short, and what each is waiting on",accent:"--c6",fn:repPending},
      {ic:"📋",name:"Production Pending",desc:"Every run not yet finished — stage, balance and how late",accent:"--c1",fn:repProdPending},
    ];
    const grid=h("div",{class:"grid cols-3"});
    reports.forEach(r=>{
      grid.appendChild(h("div",{class:"card hover",style:"cursor:pointer",onclick:r.fn},[
        h("div",{class:"kpi-ic",style:`background:color-mix(in srgb, var(${r.accent}) 16%, transparent);color:var(${r.accent})`,text:r.ic}),
        h("h3",{style:"font-size:14.5px;margin-top:12px",text:r.name}),
        h("div",{class:"muted",style:"font-size:12px;margin-top:4px;line-height:1.5",text:r.desc}),
        h("div",{class:"flex gap",style:"margin-top:14px",onclick:e=>e.stopPropagation()},[
          h("button",{class:"btn sm primary",onclick:e=>{e.stopPropagation();r.fn();},html:"⬇ Export"})
        ])
      ]));
    });
    root.appendChild(grid);


    /* data preview engine — the table shows first; the .xlsx download
       happens from the preview's Download button */
    function show(title, head, rows, csvName){
      const xlsxName=String(csvName||"report.csv").replace(/\.csv$/i,"")+".xlsx";
      MW.dataPreview({title, head, rows, name:xlsxName, sheet:title});
      return ()=>{}; // legacy direct-download hook — everything previews now
    }
    /* the sheet carries what the screen shows — web in kilograms — so a
       printed stock report and Stock Items cannot disagree */
    function repStock(dl){ const rows=ENG.data.items.map(it=>{const s=ENG.stock(it.id);return [it.id,it.name,it.thicknessMM!=null?it.thicknessMM:"",U.catName(it.cat),ENG.dispUom(it),(+ENG.dispQty(it,s.onHand)).toFixed(2),(+ENG.dispRate(it,s.avgCost)).toFixed(2),s.value.toFixed(0)];});
      const c=show("Stock Valuation Report",["Code","Name","Thickness (mm)","Category","UoM","OnHand","AvgCost","Value"],rows,"stock_valuation.csv"); if(dl===true)c(); }
    function repReorder(dl){ const rows=ENG.data.items.map(it=>({it,st:ENG.status(it.id)})).filter(x=>x.st.suggest>0||["warn","danger"].includes(x.st.state))
        .map(x=>[x.it.id,x.it.name,x.st.onHand.toFixed(1),x.it.reorder,x.it.safety,x.st.suggest,x.st.label,ENG.sup(x.it.supplierId)]);
      const c=show("Reorder / Low-Stock Report",["Code","Name","OnHand","ReorderPt","Safety","Suggested","Status","Supplier"],rows,"reorder_report.csv"); if(dl===true)c(); }
    function repLedger(dl){ const rows=ENG.data.movements.slice(-300).reverse().map(m=>{const it=ENG.item(m.itemId)||{};return [m.date,m.itemId,(it.name||"").slice(0,30),m.type,m.ref||"",m.qty,m.balance!=null?m.balance:""];});
      const c=show("Stock Movement Ledger",["Date","Code","Name","Type","Ref","Qty","Balance"],rows,"stock_ledger.csv"); if(dl===true)c(); }
    function repSO(dl){ const rows=ENG.data.salesorders.filter(s=>s.status!=="Dispatched").map(s=>[s.id,ENG.custName(s.customerId),s.lines.length,s.value.toFixed(0),s.priority,s.promised,s.status]);
      const c=show("Sales Order Backlog",["SO","Customer","Lines","Value","Priority","Promised","Status"],rows,"so_backlog.csv"); if(dl===true)c(); }
    function repBOM(dl){ const rows=ENG.data.items.filter(i=>i.cat==="FG").map(fg=>{const bom=ENG.data.boms[fg.id];let mc=0;if(bom)BOMCALC.toLegacy(bom,BOMCALC.metaFromItem(fg),null,ENG.item).forEach(([rid,per])=>mc+=per*ENG.stock(rid).avgCost/bom.yield);
        const margin=fg.price?((fg.price-fg.cost)/fg.price*100).toFixed(1):"0";return [fg.id,fg.name,fg.thicknessMM!=null?fg.thicknessMM:"",mc.toFixed(0),fg.cost,fg.price,margin+"%"];});
      const c=show("BOM Cost Roll-up",["Code","Product","Thickness (mm)","MaterialCost","StdCost","Price","Margin"],rows,"bom_costing.csv"); if(dl===true)c(); }
    function repABC(dl){ const rows=ENG.abcAnalysis().map(r=>[r.it.id,r.it.name,r.class,r.annualVal.toFixed(0),r.onHandVal.toFixed(0),r.cumPct.toFixed(1)+"%"]);
      const c=show("ABC Classification",["Code","Name","Class","AnnualValue","OnHandValue","CumulativePct"],rows,"abc_analysis.csv"); if(dl===true)c(); }
    function repProd(dl){ const rows=ENG.data.workorders.slice().reverse().map(w=>{const it=ENG.item(w.itemId)||{};return [w.id,it.name||"",it.thicknessMM!=null?it.thicknessMM:"",w.qty,w.line,w.date,w.due,w.status,w.progress+"%"];});
      const c=show("Production Output Report",["WO","Product","Thickness (mm)","Qty","Line","Start","Due","Status","Progress"],rows,"production_output.csv"); if(dl===true)c(); }

    /* ---- PURCHASE ORDERS ON PAPER -------------------------------------------
       Printing the orders used to mean one of two sheets, and neither could be
       read: "Open Purchase Orders" shows only what is still outstanding, so on a
       day when everything has been received it prints nothing at all; and the
       Purchase Orders DATA SHEET carries its line items as a raw JSON blob
       ([{"qty":51136,"rate":65,"itemId":"RM-…"}, …]) because that is the shape an
       import expects back — honest for a machine, unreadable on paper.
       So there are two proper sheets now. The REGISTER is one row per order —
       what was bought, from whom, for how much, and whether it has landed. The
       LINES sheet is one row per material, which is what a buyer actually chases
       and what replaces reading that JSON. */
    const rupee=v=>(+v||0).toLocaleString("en-IN",{minimumFractionDigits:2,maximumFractionDigits:2});
    const poLines=p=>(p.lines||[]);
    const poQty=p=>poLines(p).reduce((s,l)=>s+(+l.qty||0),0);
    const poRecd=p=>poLines(p).reduce((s,l)=>s+(+l.recd||0),0);
    /* Days past the promised date. Only meaningful on an order still owed —
       one fully received is not late whatever its ETA said. */
    function poOverdue(p){
      if(!p.eta) return "";
      if(poRecd(p)+1e-6>=poQty(p)) return "";
      const days=Math.round((new Date(DB.helpers.iso(DB.helpers.today()))-new Date(p.eta))/86400000);
      return days>0 ? days+" days late" : (days===0 ? "due today" : Math.abs(days)+" days left");
    }
    /* The materials on an order, named. A count ("6 lines") tells a reader
       nothing they can act on; the first material plus how many others follow
       fits a column and says what the order is FOR. */
    function poWhat(p){
      const ls=poLines(p);
      if(!ls.length) return "—";
      const first=(ENG.item(ls[0].itemId)||{}).name||ls[0].itemId||"—";
      return ls.length===1 ? first : first+"  + "+(ls.length-1)+" more";
    }

    /* one row per ORDER */
    function poRegisterRows(list){
      return list.map(p=>{
        const q=poQty(p), r=poRecd(p);
        return [p.id, p.date||"", ENG.sup(p.supplierId), p.supplierId||"",
          poWhat(p), poLines(p).length,
          q.toFixed(2), r.toFixed(2), Math.max(0,q-r).toFixed(2),
          rupee(p.value), p.eta||"", p.status||"", poOverdue(p), p.notes||""];
      });
    }
    const PO_REG_HEAD=["P.O. No.","Ordered On","Supplier","Supplier Code","Material Ordered",
      "Lines","Qty Ordered","Qty Received","Still Due","Order Value (₹)","ETA","Status","Delivery","Notes"];

    function repPoRegister(){
      const list=(ENG.data.purchaseorders||[]).slice()
        .sort((a,b)=>String(b.date||"").localeCompare(String(a.date||"")));
      show("Purchase Order Register", PO_REG_HEAD, poRegisterRows(list), "po_register.csv");
    }

    /* Still outstanding — the chase list. An order counts as open when quantity
       is still owed on it, not merely because its status string says so: a
       part-received order is exactly what a buyer needs to see. */
    function repPO(){
      const list=(ENG.data.purchaseorders||[])
        .filter(p=>p.status!=="Received" || poRecd(p)+1e-6 < poQty(p))
        .sort((a,b)=>String(a.eta||"9999-12-31").localeCompare(String(b.eta||"9999-12-31")));
      if(!list.length){
        toast("Every purchase order has been received in full — nothing is outstanding. Print the Purchase Order Register for all orders.",
          {type:"ok",title:"Nothing on order"});
        return;
      }
      show("Open Purchase Orders", PO_REG_HEAD, poRegisterRows(list), "open_po.csv");
    }

    /* one row per MATERIAL ordered — the sheet that replaces reading the JSON */
    function repPoLines(){
      const rows=[];
      (ENG.data.purchaseorders||[]).slice()
        .sort((a,b)=>String(b.date||"").localeCompare(String(a.date||"")))
        .forEach(p=>{
          poLines(p).forEach((l,i)=>{
            const it=ENG.item(l.itemId)||{};
            const q=+l.qty||0, r=+l.recd||0;
            rows.push([p.id, p.date||"", ENG.sup(p.supplierId), i+1,
              it.name||l.itemId||"—", l.itemId||"", U.catName(it.cat)||"",
              q.toFixed(2), it.uom||"", rupee(l.rate), rupee(q*(+l.rate||0)),
              r.toFixed(2), Math.max(0,q-r).toFixed(2),
              p.eta||"", p.status||"", l.note||""]);
          });
        });
      show("Purchase Order Lines",
        ["P.O. No.","Ordered On","Supplier","#","Material","Code","Category",
         "Qty Ordered","Unit","Rate (₹)","Line Value (₹)","Received","Still Due","ETA","Status","Note"],
        rows,"po_lines.csv");
    }

    /* ---- the six that had no report anywhere ---- */
    const whNameOf=id=>((ENG.data.warehouses||[]).find(w=>w.id===id)||{}).name||id||"";
    const custNameOf=id=>{const c=(ENG.data.customers||[]).find(x=>x.id===id);return c?(c.name||c.id):"";};

    /* One row per item PER STORE — the only place that answers "where is it
       actually kept", which the valuation report cannot: that one sums every
       store into a single figure. */
    function repByWh(){
      const rows=[];
      ENG.data.items.forEach(it=>{
        const by=(ENG.stock(it.id)||{}).byWh||{};
        Object.keys(by).forEach(wh=>{
          const q=by[wh]; if(!(Math.abs(q)>0.001)) return;
          const cost=(ENG.stock(it.id)||{}).avgCost||0;
          rows.push([whNameOf(wh), it.id, it.name, U.catName(it.cat), it.uom||"",
            (+q).toFixed(2), ENG.kg(it,q)==null?"":(+ENG.kg(it,q)).toFixed(2),
            (+cost).toFixed(2), (q*cost).toFixed(0)]);
        });
      });
      rows.sort((a,b)=>a[0].localeCompare(b[0])||a[2].localeCompare(b[2]));
      show("Stock by Warehouse",["Warehouse","Code","Material","Category","UoM","Quantity","Weight (kg)","AvgCost","Value"],rows,"stock_by_warehouse.csv");
    }
    function repLab(){
      const prods=ENG.data.labProducts||[];
      const rows=(ENG.data.labReports||[]).slice().reverse().map(r=>{
        const p=prods.find(x=>x.id===r.productId)||{};
        return [r.id, r.reportDate||"", p.code||r.productCode||"", p.name||r.productName||"",
          r.refNo||"", r.woId||"", r.result||"", r.testedBy||r.labBy||"", r.remarks||""];
      });
      show("Lab Test Reports",["Report","Date","Product Code","Product","Batch / Lot","Work Order","Result","Tested By","Remarks"],rows,"lab_reports.csv");
    }
    function repQuotes(){
      const rows=(ENG.data.quotations||[]).slice().reverse().map(q=>[
        q.id, q.date||"", q.company||custNameOf(q.customerId)||q.leadId||"", q.productName||q.itemId||"",
        (+q.qty||0), (+q.price||0).toFixed(2), q.uom||"", (+q.value||0).toFixed(0),
        q.status||"", (+q.rounds||0), q.lastUpdated||"", q.lostReason||"", q.lostTo||""]);
      show("Quotation Pipeline",["Quote","Opened","Customer / Lead","Product","Qty","Price","UoM","Value","Status","Rounds","Last Update","Lost Reason","Lost To"],rows,"quotation_pipeline.csv");
    }
    function repLeads(){
      const rows=(ENG.data.leads||[]).slice().map(l=>[
        l.id, l.date||l.created||"", l.company||l.name||"", l.contact||"", l.phone||"", l.email||"",
        l.stage||l.status||"", l.owner||"", (+l.value||0).toFixed(0), l.source||"", l.note||""]);
      show("CRM Lead Pipeline",["Lead","Opened","Company","Contact","Phone","Email","Stage","Owner","Value","Source","Note"],rows,"crm_leads.csv");
    }
    /* Dispatched sales orders, one row per order — the gate register the
       Dispatch page shows on screen but never let anyone take away. */
    function repDispatch(){
      const trans=ENG.data.transporters||[];
      const rows=(ENG.data.salesorders||[]).filter(so=>so.status==="Dispatched"||so.dispatchDate)
        .slice().reverse().map(so=>[
          so.id, so.dispatchDate||so.dispatchedOn||"", custNameOf(so.customerId),
          (so.lines||[]).length, (+so.value||0).toFixed(0),
          so.invoiceNo||"", (trans.find(t=>t.id===so.transporterId)||{}).name||"",
          so.vehicleNo||"", so.lrNo||"", so.ewayBill||"", so.status||""]);
      show("Dispatch Register",["SO","Dispatched","Customer","Lines","Value","Invoice No.","Transporter","Vehicle","LR / RR","E-Way Bill","Status"],rows,"dispatch_register.csv");
    }
    /* Work orders held short, and the material each is waiting on — the list
       the office works from to chase a purchase order. */
    function repPending(){
      const rows=(ENG.data.workorders||[]).filter(w=>(+w.pendingQty||0)>0.001).map(w=>{
        const it=ENG.item(w.itemId)||{};
        const short=(w.shortage||[]).map(x=>(x.name||x.id)+" ("+(x.id||"")+")").join("; ");
        return [w.id, it.name||w.itemId, custNameOf(w.customerId), (+w.qty||0),
          ((+w.completedQty||0)+(+w.runQty||0)).toFixed(2), (+w.pendingQty||0).toFixed(2),
          w.line||"", w.date||"", w.due||"", short];
      });
      show("Orders Awaiting Material",["WO","Product","Customer","Ordered","Produced","Pending","Line","Start","Due","Waiting On"],rows,"pending_material.csv");
    }

    /* ---- PRODUCTION PENDING — the shop-floor chase list ---------------------
       Every run that is NOT finished, in the order it is due, with the stage it
       is sitting on, what is still to make, and how many days late it is. The
       Production Output report lists everything ever run; this one is the sheet
       the office carries into the morning meeting, so it prints only what is
       still owed and puts the oldest promise at the top.
       "Not completed" is the SAME test the production board uses: an order that
       still owes a quantity is not finished even when its route has closed. */
    const STAGE_LBL={coating:"Coating",rmprod:"Coating",slitting:"Slitting",packing:"Packing",
      production:"Production",weaving:"Weaving",wbcoat:"WB Coating",fiberglass:"Fiber-Glass"};
    function repProdPending(){
      const today=DB.helpers.iso(DB.helpers.today());
      const custOf=id=>{const c=(ENG.data.customers||[]).find(x=>x.id===id);return c?(c.name||c.id):"";};
      const open=(ENG.data.workorders||[]).filter(w=>
        !((w.status==="Completed"||w.status==="Dispatched") && !((+w.pendingQty||0)>1e-6)));
      const rows=open.map(w=>{
        const it=ENG.item(w.itemId)||{};
        const rt=w.route||[];
        const cur=rt.length?rt[Math.min(Math.max(w.stageIdx||0,0),rt.length-1)]:null;
        const doneN=rt.filter(x=>x.status==="Completed").length;
        const made=(+w.completedQty||0)+(+w.runQty||0);
        const left=Math.max(0,(+w.qty||0)-(+w.completedQty||0));
        // days late is only meaningful against a due date that exists
        const late=w.due? Math.round((new Date(today)-new Date(w.due))/86400000) : null;
        return [w.id, w.date||"", it.name||w.itemId,
          U.familyCode(it.typeCode,it.thicknessMM)||it.typeCode||"",
          it.thicknessMM!=null?it.thicknessMM:"", w.widthMM!=null?w.widthMM:"",
          custOf(w.customerId), (+w.qty||0), (+w.completedQty||0).toFixed(2), left.toFixed(2),
          (+w.pendingQty||0).toFixed(2),
          cur?(STAGE_LBL[cur.key]||cur.name||""):"", rt.length?(doneN+" / "+rt.length):"",
          (w.progress||0)+"%", w.line||"", w.priority||"Normal", w.status||"",
          w.due||"", late==null?"":(late>0?late+" days late":(late===0?"due today":Math.abs(late)+" days left"))];
      });
      // oldest promise first; an order with no due date sorts to the end
      rows.sort((a,b)=>(a[17]||"9999-12-31").localeCompare(b[17]||"9999-12-31"));
      show("Production Pending",
        ["WO","Started","Product","Code","Thickness (mm)","Width (mm)","Customer","Ordered",
         "Completed","Still To Make","Awaiting Material","Stage","Stages Done","Progress",
         "Line","Priority","Status","Due","Overdue"],
        rows,"production_pending.csv");
    }
  }};

  /* ============== SETTINGS ============== */
  M.settings = { title:"Settings", sub:"Company & preferences", render(root){
    const org=ENG.data.org;
    root.appendChild(pageHead("Settings","Company profile, appearance and data management"));

    const grid=h("div",{class:"grid cols-2"});

    /* company */
    grid.appendChild(h("div",{class:"card"},[
      h("div",{class:"card-head"},h("h3",{text:"🏭 Company Profile"})),
      MW.dl([
        ["Legal Name",org.name],["Group",org.group||org.short],["Established",org.estd||"—"],
        ["GSTIN",org.gst],["Certification",org.iso],["Website",MW.webLink(org.website)],
        ["Phone",MW.phoneCell(org.phone,{wa:false})],["Email",MW.emailLink(org.email,{mode:"inbox"})],
      ]),
      h("div",{style:"margin-top:14px;padding-top:14px;border-top:1px solid var(--line)"},[
        h("div",{class:"muted",style:"font-size:11px;font-weight:700;text-transform:uppercase;margin-bottom:6px",text:"Registered Address"}),
        h("div",{style:"font-size:13px;line-height:1.6",text:org.address}),
      ]),
      h("div",{style:"margin-top:14px;padding-top:14px;border-top:1px solid var(--line)"},[
        h("div",{class:"muted",style:"font-size:11px;font-weight:700;text-transform:uppercase;margin-bottom:8px",text:"Key Contacts"}),
        ...org.contacts.map(c=>h("div",{class:"flex between",style:"font-size:13px;padding:5px 0"},[
          h("span",{},[h("b",{text:c.name})," · "+c.role]), h("span",{class:"muted",text:c.phone})
        ]))
      ])
    ]));

    /* invoice companies (billing entities used by PO/SO + printed invoices) */
    const invCard=h("div",{class:"card"},[
      h("div",{class:"card-head"},h("h3",{text:"🧾 Invoice Companies"})),
      h("p",{class:"dim",style:"font-size:12.5px;margin-bottom:12px;line-height:1.5",
        text:"Every PO / SO is billed under one of these entities. Its GSTIN, address, bank details and terms flow straight onto the printed invoice."}),
      ...(org.companies||[]).map((c,i)=>h("div",{style:"border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin-bottom:10px"},[
        h("div",{class:"flex between aic"},[
          h("div",{},[h("b",{style:"font-size:13.5px",text:c.name}),
            h("div",{class:"muted",style:"font-size:11.5px;margin-top:2px",
              html:(c.gstin?("GSTIN <b>"+esc(c.gstin)+"</b>"):'<span style="color:var(--warn)">GSTIN pending — add it before invoicing</span>')
                +(c.pan?" · PAN "+esc(c.pan):"")+(c.cin?" · CIN "+esc(c.cin):"")}),
            h("div",{class:"muted",style:"font-size:11.5px;margin-top:2px",
              text:(c.bank&&c.bank.name)?("Bank: "+c.bank.name+(c.bank.acNo?" · A/c "+c.bank.acNo:"")):"Bank details not set"})]),
          h("button",{class:"btn sm ghost",onclick:()=>companyEditForm(i),text:"✎ Edit"})
        ])
      ])),
      (org.companies&&org.companies.length)?null:h("div",{class:"muted",style:"font-size:12px",text:"No billing entities configured yet — they are created automatically on first run."}),
    ]);
    grid.appendChild(invCard);

    function companyEditForm(idx){
      const cs=(org.companies||[]).map(c=>Object.assign({},c,{bank:Object.assign({},c.bank||{})}));
      const c=cs[idx];
      const F=window._erpUtil.field, SEL=window._erpUtil.selectHTML;
      const sv=x=>esc(x==null?"":x);
      const states=GST.STATES.map(([cd,n])=>({v:cd,l:cd+" — "+n}));
      const body=h("div",{class:"form-grid"},[
        F("Company Name *",`<input class="input" id="co_name" value="${sv(c.name)}">`,"full"),
        F("GSTIN",`<input class="input" id="co_gstin" value="${sv(c.gstin)}" placeholder="e.g. 29AAICC5462H1ZE" style="text-transform:uppercase">`),
        F("State",SEL("co_state",states,c.stateCode||"29")),
        F("PAN",`<input class="input" id="co_pan" value="${sv(c.pan)}" style="text-transform:uppercase">`),
        F("CIN",`<input class="input" id="co_cin" value="${sv(c.cin)}" style="text-transform:uppercase">`),
        F("I.E.C Code (exports)",`<input class="input" id="co_iec" value="${sv(c.iec)}" style="text-transform:uppercase">`),
        F("Registered Address",`<textarea class="input" id="co_addr" rows="2">${sv(c.address)}</textarea>`,"full"),
        F("Phone",`<input class="input" id="co_phone" value="${sv(c.phone)}">`),
        F("Email",`<input class="input" id="co_email" value="${sv(c.email)}">`),
        F("Website",`<input class="input" id="co_web" value="${sv(c.website)}">`),
        F("Tagline",`<input class="input" id="co_tag" value="${sv(c.tagline)}">`),
        F("Bank Name",`<input class="input" id="co_bnk" value="${sv(c.bank.name)}">`),
        F("Branch",`<input class="input" id="co_brn" value="${sv(c.bank.branch)}">`),
        F("A/c Holder Name",`<input class="input" id="co_acn" value="${sv(c.bank.acName)}">`),
        F("A/c Number",`<input class="input" id="co_acc" value="${sv(c.bank.acNo)}">`),
        F("IFSC Code",`<input class="input" id="co_ifsc" value="${sv(c.bank.ifsc)}" style="text-transform:uppercase">`),
        F("UPI ID",`<input class="input" id="co_upi" value="${sv(c.bank.upi)}">`),
        F("SWIFT Code (exports)",`<input class="input" id="co_swift" value="${sv(c.bank.swift)}" style="text-transform:uppercase">`),
        F("Bank Address",`<input class="input" id="co_baddr" value="${sv(c.bank.address)}">`),
        F("Invoice Terms & Conditions (one per line)",`<textarea class="input" id="co_terms" rows="4">${sv((c.terms||[]).join("\n"))}</textarea>`,"full"),
      ]);
      const mo=UI.modal({title:"✎ "+c.name, sub:"Billing entity — details printed on every invoice", wide:true, body,
        foot:[h("button",{class:"btn ghost",onclick:()=>mo.close(),text:"Cancel"}),
          h("button",{class:"btn primary",onclick:save,text:"Save Company"})]});
      const gEl=UI.$("#co_gstin");
      if(gEl) gEl.addEventListener("input",()=>{ const sc=GST.stateFromGSTIN(gEl.value); if(sc) UI.$("#co_state").value=sc; });
      async function save(){
        const g=id=>UI.$("#"+id).value.trim();
        if(!g("co_name")){ toast("Company name is required",{type:"warn"}); return; }
        const gstin=g("co_gstin").toUpperCase();
        if(gstin&&!GST.validGSTIN(gstin)){ toast("That GSTIN doesn't look valid (15 chars)",{type:"warn"}); return; }
        Object.assign(c,{ name:g("co_name"), gstin, pan:g("co_pan").toUpperCase(), cin:g("co_cin").toUpperCase(),
          iec:g("co_iec").toUpperCase(),
          address:g("co_addr"), stateCode:UI.$("#co_state").value, state:GST.stateName(UI.$("#co_state").value),
          phone:g("co_phone"), email:g("co_email"), website:g("co_web"), tagline:g("co_tag"),
          bank:{ name:g("co_bnk"), branch:g("co_brn"), acName:g("co_acn"), acNo:g("co_acc"),
            ifsc:g("co_ifsc").toUpperCase(), upi:g("co_upi"),
            swift:g("co_swift").toUpperCase(), address:g("co_baddr") },
          terms:g("co_terms").split("\n").map(s=>s.trim()).filter(Boolean) });
        try{
          const fresh=await DB.org.update({companies:cs});
          ENG.data.org=fresh;
          mo.close(); toast(c.name+" saved",{type:"ok"});
          App.refreshView();
        }catch(e){ toast("Save failed: "+e.message,{type:"danger"}); }
      }
    }

    /* appearance */
    const accents=["orange","red","blue","teal","violet","green","pink","amber"];
    grid.appendChild(h("div",{class:"card"},[
      h("div",{class:"card-head"},h("h3",{text:"🎨 Appearance"})),
      h("div",{class:"field",style:"margin-bottom:16px"},[
        h("label",{text:"Theme"}),
        h("div",{class:"seg"},[
          h("button",{class:App.theme==="dark"?"on":"",text:"🌙 Dark",onclick:e=>{App.setTheme("dark");refreshSeg(e);}}),
          h("button",{class:App.theme==="light"?"on":"",text:"☀️ Light",onclick:e=>{App.setTheme("light");refreshSeg(e);}}),
        ])
      ]),
      h("div",{class:"field"},[
        h("label",{text:"Accent Colour"}),
        h("div",{class:"swatches",style:"grid-template-columns:repeat(8,1fr)"}, accents.map(a=>{
          const sw=h("div",{class:"swatch"+(App.accent===a?" sel":""),onclick:()=>{App.setAccent(a);[...sw.parentElement.children].forEach(c=>c.classList.remove("sel"));sw.classList.add("sel");}});
          sw.style.setProperty("--x",a); sw.style.background=accentHex(a); return sw;
        }))
      ]),
      h("label",{class:"auto-accent",style:"margin-top:16px"},[
        h("input",{type:"checkbox",checked:App.autoAccent?"checked":null,onchange:e=>App.setAutoAccent(e.target.checked)}),
        " Auto-cycle accent colour per module"
      ]),
      h("div",{class:"muted",style:"font-size:12px;margin-top:8px;line-height:1.5",text:"When enabled, each module adopts its own signature colour for a more dynamic, context-aware interface."})
    ]));
    root.appendChild(grid);

    /* data management */
    root.appendChild(h("div",{class:"card",style:"margin-top:16px"},[
      h("div",{class:"card-head"},h("h3",{text:"💾 Data Management"})),
      h("p",{class:"dim",style:"font-size:13px;margin-bottom:14px;line-height:1.6",text:"All data is stored locally in your browser (offline-ready). You can back it up, restore it, or reset to the seeded demo dataset."}),
      h("div",{class:"flex gap wrap"},[
        h("button",{class:"btn",onclick:backup,html:"⬇ Export Backup (JSON)"}),
        h("button",{class:"btn",onclick:restore,html:"⬆ Restore Backup"}),
        h("button",{class:"btn danger",onclick:reset,html:"↺ Reset to Demo Data"}),
      ])
    ]));

    /* Excel import / export lives on each section's own DATA button, not here. */

    function refreshSeg(e){ [...e.target.parentElement.children].forEach(c=>c.classList.remove("on")); e.target.classList.add("on"); }
    function accentHex(a){ const map={orange:"#F06820",red:"#E84820",blue:"#2f7fe0",teal:"#0fb5ae",violet:"#7c5cff",green:"#16a34a",pink:"#ec4899",amber:"#e0a000"}; return map[a]; }
    function backup(){ const blob=new Blob([JSON.stringify(ENG.data,null,2)],{type:"application/json"});
      const a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download="chhaperia_erp_backup_"+DB.helpers.iso(DB.helpers.today())+".json"; a.click();
      toast("Backup exported",{type:"ok"}); }
    function restore(){ const inp=h("input",{type:"file",accept:".json",style:"display:none"});
      inp.onchange=e=>{ const f=e.target.files[0]; if(!f)return; const r=new FileReader();
        r.onload=async ()=>{ try{ const d=JSON.parse(r.result); if(!d.items||!d.movements) throw 0;
          await DB.save(d); toast("Backup restored — reloading",{type:"ok"}); setTimeout(()=>location.reload(),800);
        }catch(_){ toast("Invalid backup file",{type:"danger"}); } };
        r.readAsText(f); };
      document.body.appendChild(inp); inp.click(); inp.remove(); }
    async function reset(){ if(await confirm("Reset all data to the seeded demo dataset? Your current changes will be lost.",{title:"Reset Data",danger:true})){
      toast("Resetting…",{type:"info"});
      try{ await DB.reset(); setTimeout(()=>location.reload(),500); }
      catch(e){ toast("Reset failed: "+e.message,{type:"danger"}); } } }
  }};

  /* ============== SHARED EXCEL IMPORT (any page's Excel ▾ menu) ==============
     Reads EVERY sheet of the workbook, so the multi-section import template
     (one sheet per section) can be dropped in as-is. `want` is the section the
     user started from — its sheet is opened first when the file has several. */
  function csvImport(want){
      const inp=h("input",{type:"file",accept:".xlsx,.xls",style:"display:none"});
      inp.onchange=e=>{ const f=e.target.files[0]; if(!f) return;
        if(!/\.xlsx?$/i.test(f.name)){ toast("Only Excel files (.xlsx) are supported — export a table first, or use the import template.",{type:"warn"}); return; }
        const r=new FileReader();
        r.onload=()=>{ try{
            const sheets=CSVIO.parseWorkbook(r.result);
            // sheets with a recognised header AND at least one data row
            const usable=sheets.filter(s=>s.key && s.rows.length>1);
            if(!usable.length){
              const named=sheets.filter(s=>s.key).map(s=>s.name);
              toast(named.length
                ? "Recognised "+named.join(", ")+" but every sheet is empty — fill in at least one row."
                : "Could not recognise any sheet in this file. Export a section first, or use the import template, to get the right column names.",
                {type:"danger",title:"Nothing to import"});
              return;
            }
            const first=usable.find(s=>s.key===want)||usable[0];
            showImportPreview(first.key, first.rows, usable, first);
          }catch(err){ toast("Import failed: "+err.message,{type:"danger"}); } };
        r.readAsArrayBuffer(f); };
      document.body.appendChild(inp); inp.click(); inp.remove();
  }

  function statPill(txt,col){ return h("span",{style:`padding:6px 12px;border-radius:999px;border:1.5px solid ${col};color:${col};font-weight:700;font-size:13px`,text:txt}); }
  function previewVal(o,col){ const v=o[col.k]; if(Array.isArray(v)) return v.join("|"); if(v&&typeof v==="object") return JSON.stringify(v); return v==null?"":v; }

  function showImportPreview(key, parsed, sheets, curSheet){
      let curKey=key, rows=parsed;
      const host=h("div");
      const mo=modal({title:"Import Excel", sub:"Review changes before saving", wide:true, body:host,
        foot:[ h("button",{class:"btn ghost",onclick:()=>mo.close(),text:"Cancel"}),
               h("button",{class:"btn primary",id:"csvApplyBtn",text:"Apply Import"}) ]});
      const sel=h("select",{class:"select",style:"max-width:240px"}, Object.keys(CSVIO.ENTITIES).map(k=>{
        const o=h("option",{value:k,text:CSVIO.ENTITIES[k].label}); if(k===curKey)o.selected=true; return o; }));
      sel.onchange=()=>{ curKey=sel.value; render(); };
      /* a workbook can hold one sheet per section — pick which one to import */
      const multi=(sheets||[]).length>1;
      const shSel=multi? h("select",{class:"select",style:"max-width:230px"},(sheets||[]).map(s=>{
        const o=h("option",{value:s.name,text:s.name+"  ("+(s.rows.length-1)+" rows)"});
        if(curSheet&&s.name===curSheet.name)o.selected=true; return o; })) : null;
      if(shSel) shSel.onchange=()=>{
        const s=sheets.find(x=>x.name===shSel.value);
        if(!s) return;
        rows=s.rows; curKey=s.key||curKey; sel.value=curKey; render();
      };

      function render(){
        host.innerHTML="";
        if(shSel) host.appendChild(h("div",{class:"flex gap aic wrap",style:"margin-bottom:10px"},[
          h("span",{class:"muted",style:"font-size:12px",text:"Sheet:"}), shSel,
          h("span",{class:"muted",style:"font-size:11.5px",text:sheets.length+" importable sheets in this file — one section at a time"}) ]));
        host.appendChild(h("div",{class:"flex gap aic",style:"margin-bottom:12px"},[
          h("span",{class:"muted",style:"font-size:12px",text:"Import this sheet as:"}), sel ]));
        let diff;
        try{ diff=CSVIO.buildDiff(curKey, rows); }
        catch(err){
          /* Say WHY. This used to report "cannot map" for any failure, which sent a
             real crash in here looking like a bad spreadsheet. A header mismatch is
             the file's fault; anything else is ours, so print it. */
          const headerIssue=/header|column|match|map/i.test(err&&err.message||"");
          host.appendChild(h("div",{class:"muted",text:headerIssue
            ? "Cannot map this file to "+CSVIO.ENTITIES[curKey].label+" — "+err.message
            : "Cannot map this file to "+CSVIO.ENTITIES[curKey].label+"."}));
          if(!headerIssue){
            console.error("Import preview failed:",err);
            host.appendChild(h("div",{class:"muted",style:"font-size:11.5px;margin-top:6px",
              text:"The file was read, but the preview failed: "+(err&&err.message||err)+". This is a fault in the app, not your sheet — please report it."}));
          }
          return;
        }
        /* ---- STOCK TAKE: the sheet's On Hand column vs the ledger ----
           The figure is in the unit the screen shows (kg for weighable web),
           so it converts back through the item's own geometry before the
           delta is measured. Only a real difference becomes an adjustment —
           the exported figures round-trip as "unchanged". */
        let adjs=[];
        if(curKey==="items" && Array.isArray(diff.qty)){
          diff.qty.forEach(q=>{
            const it=ENG.item(q.id)
              || (diff.add.find(a=>a.id===q.id)||{}).after;   // a brand-new row
            if(!it) return;
            const cur=ENG.item(q.id)?(ENG.status(q.id).onHand||0):0;
            const curShown=Math.round(ENG.dispQty(it,cur)*100)/100;
            if(Math.abs(q.shown-curShown)<=0.005) return;
            const per=(ENG.readsAsKg(it)&&ENG.kgPerUnit(it))||1;
            const target=q.shown/per;
            const delta=Math.round((target-cur)*1000)/1000;
            if(!delta) return;
            adjs.push({ id:q.id, name:it.name||q.id, delta,
              from:curShown, to:q.shown, uom:ENG.dispUom(it)||it.uom||"",
              isNew:!ENG.item(q.id) });
          });
        }
        host.appendChild(h("div",{class:"flex gap wrap",style:"margin-bottom:14px"},[
          statPill("＋ "+diff.add.length+" new","var(--ok)"),
          statPill("~ "+diff.update.length+" updated","var(--info)"),
          adjs.length?statPill("◆ "+adjs.length+" stock adjustments","var(--warn)"):null,
          statPill("= "+diff.unchanged.length+" unchanged","var(--text-mut)"),
          diff.errors.length?statPill("⚠ "+diff.errors.length+" skipped","var(--danger)"):null,
        ].filter(Boolean)));
        if(adjs.length){
          host.appendChild(h("div",{class:"muted",style:"font-size:11px;font-weight:700;text-transform:uppercase;margin:2px 0 6px",
            text:"Stock adjustments from the On Hand column"}));
          host.appendChild(table(adjs.slice(0,120),[
            {key:"name",label:"Material",cls:"nm",noSort:true,render:r=>esc(String(r.name)).slice(0,44)+(r.isNew?' <span class="muted">(new item — opening stock)</span>':"")},
            {key:"from",label:"Ledger says",noSort:true,render:r=>ENG.num(r.from,2)+" "+esc(r.uom)},
            {key:"to",label:"Sheet says",noSort:true,render:r=>"<b>"+ENG.num(r.to,2)+"</b> "+esc(r.uom)},
            {key:"delta",label:"Adjustment",noSort:true,render:r=>{
              const shown=ENG.dispQty(ENG.item(r.id)||{},r.delta);
              return '<span style="color:'+(r.delta<0?'var(--danger)':'var(--ok)')+';font-weight:700">'
                +(r.delta>0?"+":"")+ENG.num(shown,2)+'</span> <span class="muted">'+esc(r.uom)+"</span>";}},
          ],{empty:""}));
          host.appendChild(h("div",{class:"muted",style:"font-size:11.5px;margin:6px 0 12px",
            text:"Each row posts one ADJ movement bringing the store to the sheet's figure — the audit trail keeps both numbers."}));
        }

        const changed=diff.add.map(x=>({kind:"New",o:x.after})).concat(diff.update.map(x=>({kind:"Updated",o:x.after})));
        const cols0=CSVIO.ENTITIES[curKey].cols.slice(0,6);
        /* NOT `rows` — that name belongs to the sheet being imported, read above by
           buildDiff. Shadowing it here put that read in the temporal dead zone, so
           every import threw and the catch reported "Cannot map this file". */
        const preview=changed.slice(0,120).map(c=>{ const o={_k:c.kind}; cols0.forEach(col=>o[col.k]=previewVal(c.o,col)); return o; });
        const tcols=[{key:"_k",label:"Change",noSort:true,render:r=>badge(r._k==="New"?"ok":"info",r._k)}].concat(
          cols0.map(col=>({key:col.k,label:col.label||col.k,noSort:true,render:r=>esc(String(r[col.k]==null?"":r[col.k])).slice(0,44)})));
        host.appendChild(table(preview,tcols,{empty:"No new or changed rows in this file"}));
        if(changed.length>120) host.appendChild(h("div",{class:"muted",style:"font-size:11px;margin-top:8px",text:"Showing first 120 of "+changed.length+" changed rows — all will be applied."}));

        const applyBtn=UI.$("#csvApplyBtn"); const total=diff.add.length+diff.update.length+adjs.length;
        if(applyBtn){
          applyBtn.textContent=total?"Apply Import ("+total+")":"Nothing to import";
          applyBtn.disabled=!total;
          applyBtn.onclick=async ()=>{ applyBtn.disabled=true; applyBtn.textContent="Saving…";
            try{ CSVIO.apply(diff);
              /* stock adjustments ride the same save: one ADJ per row, valued
                 at the item's average cost so the books move with the goods */
              const U2=window._erpUtil||{};
              adjs.forEach(a=>{
                const st=ENG.item(a.id)?ENG.status(a.id):null;
                const it2=ENG.item(a.id)||{};
                const byWh=(ENG.stock(a.id)||{}).byWh||{};
                const wh=Object.keys(byWh).sort((x,y)=>(byWh[y]||0)-(byWh[x]||0))[0]
                  || (String(it2.cat||((diff.add.find(x=>x.id===a.id)||{}).after||{}).cat)==="FG"?"WH-FG":"WH-PNY");
                ENG.data.movements.push({ id:(U2.genMoveId?U2.genMoveId():"MV-IMP-"+Date.now())+"-"+a.id,
                  date:DB.helpers.iso(DB.helpers.today()), itemId:a.id, wh,
                  type: a.isNew?"OPEN":"ADJ", qty:a.delta,
                  rate:(st&&st.avgCost)||it2.cost||0, ref:"IMPORT",
                  note:"Stock take import — sheet said "+a.to+" "+a.uom,
                  by:(App.user&&App.user.username)||"import" });
              });
              await DB.save(ENG.data);
              const fresh=await DB.loadAsync(); ENG.init(fresh); App.buildNav(); App.refreshAlerts();
              mo.close(); toast(CSVIO.ENTITIES[curKey].label+" imported — "+total+" rows saved",{type:"ok",title:"Import complete"});
              App.refreshView();
            }catch(err){ toast("Save failed: "+err.message,{type:"danger"}); applyBtn.disabled=false; applyBtn.textContent="Apply Import"; } };
        }
      }
      render();
  }

  window.CSVImportUI = { open: csvImport };
})();
