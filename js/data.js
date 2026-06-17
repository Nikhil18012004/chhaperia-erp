/* ============================================================
   CHHAPERIA ERP — DATA LAYER
   Realistic, deterministic seed data for a tape / insulation
   manufacturer supplying the HT (high-tension) cable industry.
   Persisted to localStorage; reseeds on demand.
   ============================================================ */
(function (global) {
  "use strict";

  const KEY = "chhaperia_erp_v1";

  /* ---- deterministic PRNG so demo data is stable across reloads ---- */
  function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
  let RND = mulberry32(20260617);
  const rnd = () => RND();
  const ri = (a,b)=>Math.floor(rnd()*(b-a+1))+a;
  const rf = (a,b,d=2)=>+(rnd()*(b-a)+a).toFixed(d);
  const pick = arr => arr[Math.floor(rnd()*arr.length)];
  const chance = p => rnd() < p;

  const DAY = 86400000;
  const today = new Date("2026-06-17T00:00:00");
  const iso = d => new Date(d).toISOString().slice(0,10);
  const daysAgo = n => iso(today.getTime() - n*DAY);
  const daysAhead = n => iso(today.getTime() + n*DAY);

  /* ============================================================
     MASTER: WAREHOUSES
     ============================================================ */
  const warehouses = [
    { id:"WH-PNY", name:"Doddaballapur Main Stores", type:"Raw Material", city:"Doddaballapur" },
    { id:"WH-WIP", name:"Production Floor WIP", type:"WIP", city:"Doddaballapur" },
    { id:"WH-FG",  name:"Finished Goods Bay",  type:"Finished Goods", city:"Doddaballapur" },
    { id:"WH-QC",  name:"QC / Quarantine",     type:"Quarantine", city:"Doddaballapur" },
  ];

  /* ============================================================
     MASTER: UoM & CATEGORIES
     ============================================================ */
  const categories = [
    { id:"RM",  name:"Raw Material",   kind:"raw" },
    { id:"PKG", name:"Packaging",      kind:"raw" },
    { id:"CON", name:"Consumables",    kind:"raw" },
    { id:"WIP", name:"Work in Process",kind:"wip" },
    { id:"FG",  name:"Finished Goods", kind:"fg" },
    { id:"SPR", name:"Spares / MRO",   kind:"raw" },
  ];

  /* ============================================================
     ITEM MASTER
     Tape products for HT cables + raw materials & BOM links.
     uom for tapes is KG (mfg) but tracked also in metres.
     ============================================================ */
  let items = [];
  const mk = (o)=>{ items.push(Object.assign({
    reorder:0, safety:0, lead:7, abc:"B", hsn:"", barcode:"", active:true,
    moq:0, shelfLifeDays:0, location:"", supplierId:null
  }, o)); return o.id; };

  /* ---- RAW MATERIALS ---- */
  mk({id:"RM-MICA-PHL", name:"Phlogopite Mica Paste", cat:"RM", uom:"KG", cost:255, reorder:1400, safety:450, lead:21, abc:"A", hsn:"2525", supplierId:"SUP-01", grade:"Phlogopite", note:"Calcined mica for CP-series tapes (up to 1000°C)"});
  mk({id:"RM-MICA-MUS", name:"Muscovite Mica Paste", cat:"RM", uom:"KG", cost:230, reorder:1100, safety:350, lead:18, abc:"A", hsn:"2525", supplierId:"SUP-01", grade:"Muscovite", note:"For CM-series mica tapes"});
  mk({id:"RM-GLASS-CLOTH", name:"E-Glass Fabric (woven) 0.06mm", cat:"RM", uom:"SQM", cost:58, reorder:9000, safety:2500, lead:14, abc:"A", hsn:"7019", supplierId:"SUP-02", note:"Reinforcement backing for mica/glass tapes"});
  mk({id:"RM-GLASS-YARN", name:"Glass Fibre Yarn EC9", cat:"RM", uom:"KG", cost:142, reorder:700, safety:220, lead:14, abc:"B", hsn:"7019", supplierId:"SUP-02"});
  mk({id:"RM-PET-FILM", name:"Polyester (PET) Film 25µm", cat:"RM", uom:"KG", cost:188, reorder:1200, safety:350, lead:18, abc:"A", hsn:"3920", supplierId:"SUP-03"});
  mk({id:"RM-PE-FILM", name:"Polyethylene (PE) Film 30µm", cat:"RM", uom:"KG", cost:132, reorder:500, safety:150, lead:14, abc:"B", hsn:"3920", supplierId:"SUP-03", note:"Backing for CP 25 H"});
  mk({id:"RM-NONWOVEN", name:"Non-Woven PET Substrate", cat:"RM", uom:"KG", cost:176, reorder:900, safety:280, lead:15, abc:"B", hsn:"5603", supplierId:"SUP-03"});
  mk({id:"RM-SAP", name:"Super-Absorbent Polymer (SAP) Powder", cat:"RM", uom:"KG", cost:295, reorder:600, safety:180, lead:20, abc:"A", hsn:"3906", supplierId:"SUP-04", note:"Swelling agent for water-blocking tapes"});
  mk({id:"RM-CARBON", name:"Conductive Carbon Black", cat:"RM", uom:"KG", cost:210, reorder:300, safety:90, lead:18, abc:"B", hsn:"2803", supplierId:"SUP-06", note:"Semi-conductive coating"});
  mk({id:"RM-SILICONE", name:"Silicone / Organic Binder", cat:"RM", uom:"KG", cost:480, reorder:600, safety:180, lead:15, abc:"B", hsn:"3910", supplierId:"SUP-05"});
  mk({id:"RM-INORGANIC", name:"Inorganic Bonding Layer", cat:"RM", uom:"KG", cost:560, reorder:250, safety:80, lead:18, abc:"B", hsn:"3824", supplierId:"SUP-05", note:"For CP 25 GE inorganic-layer tape"});
  mk({id:"RM-ACRYLIC-ADH", name:"Acrylic Adhesive Compound", cat:"RM", uom:"KG", cost:320, reorder:700, safety:200, lead:10, abc:"B", hsn:"3506", supplierId:"SUP-06"});
  mk({id:"RM-SOLVENT", name:"Solvent (Industrial)", cat:"CON", uom:"LTR", cost:92, reorder:1000, safety:300, lead:7, abc:"C", hsn:"2902", supplierId:"SUP-07"});
  mk({id:"RM-COPPER-WIRE", name:"Copper Wire 0.05mm (for woven tape)", cat:"RM", uom:"KG", cost:880, reorder:200, safety:60, lead:22, abc:"A", hsn:"7408", supplierId:"SUP-08"});
  mk({id:"RM-AL-FOIL", name:"Aluminium Foil 9µm", cat:"RM", uom:"KG", cost:340, reorder:400, safety:120, lead:18, abc:"B", hsn:"7607", supplierId:"SUP-08", note:"Aluminium-mylar laminate"});
  mk({id:"RM-COTTON", name:"Cotton Fabric (rubberised base)", cat:"RM", uom:"SQM", cost:34, reorder:4000, safety:1200, lead:12, abc:"C", hsn:"5208", supplierId:"SUP-02"});
  mk({id:"RM-PP-FOAM", name:"Foamed Polypropylene Sheet", cat:"RM", uom:"KG", cost:165, reorder:400, safety:120, lead:16, abc:"C", hsn:"3920", supplierId:"SUP-03"});
  mk({id:"RM-CORE", name:"Paper Core Tube 76mm ID", cat:"PKG", uom:"NOS", cost:16, reorder:6000, safety:1500, lead:7, abc:"C", hsn:"4822", supplierId:"SUP-09"});

  /* ---- PACKAGING ---- */
  mk({id:"PKG-CARTON", name:"5-Ply Export Carton", cat:"PKG", uom:"NOS", cost:40, reorder:3000, safety:800, lead:7, abc:"C", hsn:"4819", supplierId:"SUP-09"});
  mk({id:"PKG-STRETCH", name:"Stretch Wrap Film", cat:"PKG", uom:"KG", cost:150, reorder:350, safety:100, lead:7, abc:"C", hsn:"3920", supplierId:"SUP-09"});
  mk({id:"PKG-LABEL", name:"Barcode Label Roll", cat:"PKG", uom:"ROLL", cost:230, reorder:150, safety:50, lead:5, abc:"C", hsn:"4821", supplierId:"SUP-09"});

  /* ---- FINISHED GOODS — real Chhaperia cable-tape range ----
     group: MICA | WBT | SCT | OCT   (used for product families)        */
  /* Mica Tapes (fire-survival / HV insulation) */
  mk({id:"FG-CM25G",  name:"Muscovite Mica Glass-Backed Tape", cat:"FG", group:"MICA", typeCode:"CM 25 G", std:"IEC 60331-2, BS 6387 CWZ, EN50200", flameC:1000, uom:"KG", cost:560, price:880, reorder:300, safety:90, lead:5, abc:"A", hsn:"8546", widthMM:[8,12,18,23,25]});
  mk({id:"FG-CM25DG", name:"Muscovite Mica Double-Glass Tape", cat:"FG", group:"MICA", typeCode:"CM 25 DG", std:"IEC 60331-2, BS 6387 CWZ", flameC:1000, uom:"KG", cost:640, price:990, reorder:220, safety:70, lead:5, abc:"A", hsn:"8546", widthMM:[12,18,25]});
  mk({id:"FG-CP25G",  name:"Phlogopite Mica Glass-Backed Tape", cat:"FG", group:"MICA", typeCode:"CP 25 G", std:"IEC 60331-2, BS 6387 CWZ", flameC:950, uom:"KG", cost:600, price:940, reorder:300, safety:90, lead:5, abc:"A", hsn:"8546", widthMM:[8,12,18,25]});
  mk({id:"FG-CP25GE", name:"Phlogopite Mica Inorganic-Layer Tape", cat:"FG", group:"MICA", typeCode:"CP 25 GE", std:"IEC 60331-2", flameC:950, uom:"KG", cost:720, price:1120, reorder:160, safety:50, lead:6, abc:"A", hsn:"8546", widthMM:[12,18,25]});
  mk({id:"FG-CP25GH", name:"Phlogopite Mica Glass+Film Tape", cat:"FG", group:"MICA", typeCode:"CP 25 GH", std:"IEC 60331-2", flameC:950, uom:"KG", cost:660, price:1030, reorder:150, safety:45, lead:6, abc:"B", hsn:"8546", widthMM:[12,25]});
  mk({id:"FG-CP25H",  name:"Phlogopite Mica PE-Backed Tape", cat:"FG", group:"MICA", typeCode:"CP 25 H", std:"IEC 60331-2", flameC:800, uom:"KG", cost:520, price:820, reorder:140, safety:45, lead:5, abc:"B", hsn:"8546", widthMM:[12,18,25]});
  /* Water Blocking Tapes */
  mk({id:"FG-WBT-NC",  name:"Non-Conductive Water-Blocking Tape", cat:"FG", group:"WBT", typeCode:"WBT-NC", std:"For power & optical cable", uom:"KG", cost:300, price:480, reorder:280, safety:80, lead:4, abc:"A", hsn:"5911", widthMM:[20,25,40,60]});
  mk({id:"FG-WBT-SC",  name:"Semi-Conductive Water-Blocking Tape", cat:"FG", group:"WBT", typeCode:"WBT-SC", std:"For MV/HV power cable", uom:"KG", cost:360, price:560, reorder:240, safety:70, lead:5, abc:"A", hsn:"5911", widthMM:[20,25,40]});
  mk({id:"FG-WBT-FOAM",name:"Semi-Conductive WB Foam Tape (Bulky)", cat:"FG", group:"WBT", typeCode:"WBT-SCF", std:"Bulky swelling foam", uom:"KG", cost:420, price:660, reorder:120, safety:35, lead:6, abc:"B", hsn:"5911", widthMM:[25,40]});
  mk({id:"FG-WBT-PL",  name:"Polyester-Laminated WB Tape", cat:"FG", group:"WBT", typeCode:"WBT-PL", std:"Aluminium-PET backed", uom:"KG", cost:340, price:540, reorder:140, safety:45, lead:5, abc:"B", hsn:"5911", widthMM:[20,25,40]});
  mk({id:"FG-WB-YARN", name:"Water-Blocking Yarn", cat:"FG", group:"WBT", typeCode:"WB-Y", std:"Swelling yarn", uom:"KG", cost:380, price:600, reorder:90, safety:30, lead:5, abc:"C", hsn:"5911", widthMM:[0]});
  mk({id:"FG-CU-WBT",  name:"Copper-Wire Woven Semi-Cond. WB Tape", cat:"FG", group:"WBT", typeCode:"CU-WBT", std:"Conductive + water block", uom:"KG", cost:980, price:1490, reorder:70, safety:20, lead:9, abc:"A", hsn:"5911", widthMM:[20,25]});
  /* Semi-Conducting Tapes */
  mk({id:"FG-SC-WOVEN",name:"Semi-Conducting Woven Tape", cat:"FG", group:"SCT", typeCode:"SC-W", std:"Conductor/insulation screen", uom:"KG", cost:520, price:820, reorder:130, safety:40, lead:6, abc:"B", hsn:"5911", widthMM:[20,25,40]});
  mk({id:"FG-SC-NW",   name:"Semi-Conducting Non-Woven Tape", cat:"FG", group:"SCT", typeCode:"SC-NW", std:"Conductor/insulation screen", uom:"KG", cost:470, price:740, reorder:140, safety:45, lead:5, abc:"B", hsn:"5911", widthMM:[20,25,40]});
  /* Other Cable Tapes */
  mk({id:"FG-FG-TAPE", name:"Fibre Glass Tape", cat:"FG", group:"OCT", typeCode:"FG-T", std:"Binding / heat barrier", uom:"KG", cost:280, price:450, reorder:200, safety:60, lead:4, abc:"B", hsn:"7019", widthMM:[10,15,20,25]});
  mk({id:"FG-CU-PET",  name:"Copper Polyester Tape", cat:"FG", group:"OCT", typeCode:"CU-PET", std:"Shielding", uom:"KG", cost:720, price:1120, reorder:120, safety:35, lead:8, abc:"A", hsn:"7410", widthMM:[20,25,30]});
  mk({id:"FG-AL-MYLAR",name:"Aluminium Mylar Tape", cat:"FG", group:"OCT", typeCode:"AL-MYL", std:"EMI shield / moisture barrier", uom:"KG", cost:300, price:480, reorder:180, safety:55, lead:6, abc:"B", hsn:"7607", widthMM:[15,20,25,40]});
  mk({id:"FG-PET-FILM",name:"Polyester Film Tape", cat:"FG", group:"OCT", typeCode:"PET-F", std:"Core wrap / insulation", uom:"KG", cost:240, price:390, reorder:160, safety:50, lead:4, abc:"C", hsn:"3920", widthMM:[12,20,25]});
  mk({id:"FG-NW-TAPE", name:"Non-Woven Binder Tape", cat:"FG", group:"OCT", typeCode:"NW-T", std:"Core binding", uom:"KG", cost:200, price:330, reorder:170, safety:50, lead:4, abc:"C", hsn:"5603", widthMM:[15,25,40]});
  mk({id:"FG-PP-FOAM", name:"Foamed Polypropylene (PP) Tape", cat:"FG", group:"OCT", typeCode:"PP-F", std:"Cushioning / separation", uom:"KG", cost:260, price:420, reorder:110, safety:35, lead:5, abc:"C", hsn:"3920", widthMM:[20,25,40]});
  mk({id:"FG-RUB-COT", name:"Rubberised Cotton Tape", cat:"FG", group:"OCT", typeCode:"RC-T", std:"Protective wrap", uom:"KG", cost:180, price:300, reorder:120, safety:40, lead:4, abc:"C", hsn:"5906", widthMM:[15,20,25]});

  /* assign barcodes + ABC fill */
  items.forEach((it,i)=>{ it.barcode = "890" + String(100000+i*37).slice(0,6) + String(i%10); });

  /* item index for fast lookup during simulation */
  const idMap = {}; items.forEach(it=>{ idMap[it.id]=it; });

  /* ============================================================
     BILL OF MATERIALS (per 1 KG of finished tape)
     ============================================================ */
  const boms = {
    /* Mica tapes */
    "FG-CM25G":   { yield:0.94, lines:[["RM-MICA-MUS",0.52],["RM-GLASS-CLOTH",2.0],["RM-SILICONE",0.16],["RM-SOLVENT",0.18],["RM-CORE",0.10]] },
    "FG-CM25DG":  { yield:0.93, lines:[["RM-MICA-MUS",0.50],["RM-GLASS-CLOTH",3.0],["RM-SILICONE",0.18],["RM-SOLVENT",0.20],["RM-CORE",0.10]] },
    "FG-CP25G":   { yield:0.94, lines:[["RM-MICA-PHL",0.55],["RM-GLASS-CLOTH",2.0],["RM-SILICONE",0.16],["RM-SOLVENT",0.18],["RM-CORE",0.10]] },
    "FG-CP25GE":  { yield:0.92, lines:[["RM-MICA-PHL",0.54],["RM-GLASS-CLOTH",2.0],["RM-INORGANIC",0.22],["RM-SOLVENT",0.16],["RM-CORE",0.10]] },
    "FG-CP25GH":  { yield:0.93, lines:[["RM-MICA-PHL",0.50],["RM-GLASS-CLOTH",1.6],["RM-PET-FILM",0.30],["RM-SILICONE",0.14],["RM-CORE",0.10]] },
    "FG-CP25H":   { yield:0.95, lines:[["RM-MICA-PHL",0.50],["RM-PE-FILM",0.40],["RM-ACRYLIC-ADH",0.12],["RM-SOLVENT",0.12],["RM-CORE",0.10]] },
    /* Water blocking tapes */
    "FG-WBT-NC":  { yield:0.95, lines:[["RM-NONWOVEN",0.55],["RM-SAP",0.40],["RM-ACRYLIC-ADH",0.12],["RM-CORE",0.12]] },
    "FG-WBT-SC":  { yield:0.95, lines:[["RM-NONWOVEN",0.52],["RM-SAP",0.36],["RM-CARBON",0.14],["RM-ACRYLIC-ADH",0.10],["RM-CORE",0.12]] },
    "FG-WBT-FOAM":{ yield:0.93, lines:[["RM-PP-FOAM",0.45],["RM-SAP",0.42],["RM-CARBON",0.12],["RM-ACRYLIC-ADH",0.10],["RM-CORE",0.12]] },
    "FG-WBT-PL":  { yield:0.95, lines:[["RM-NONWOVEN",0.40],["RM-AL-FOIL",0.20],["RM-PET-FILM",0.20],["RM-SAP",0.25],["RM-CORE",0.12]] },
    "FG-WB-YARN": { yield:0.96, lines:[["RM-GLASS-YARN",0.55],["RM-SAP",0.48],["RM-CORE",0.06]] },
    "FG-CU-WBT":  { yield:0.94, lines:[["RM-COPPER-WIRE",0.55],["RM-NONWOVEN",0.30],["RM-SAP",0.22],["RM-CARBON",0.08],["RM-CORE",0.10]] },
    /* Semi-conducting tapes */
    "FG-SC-WOVEN":{ yield:0.95, lines:[["RM-GLASS-YARN",0.45],["RM-CARBON",0.18],["RM-ACRYLIC-ADH",0.20],["RM-CORE",0.12]] },
    "FG-SC-NW":   { yield:0.96, lines:[["RM-NONWOVEN",0.55],["RM-CARBON",0.18],["RM-ACRYLIC-ADH",0.18],["RM-CORE",0.12]] },
    /* Other cable tapes */
    "FG-FG-TAPE": { yield:0.96, lines:[["RM-GLASS-CLOTH",2.6],["RM-ACRYLIC-ADH",0.10],["RM-CORE",0.12]] },
    "FG-CU-PET":  { yield:0.96, lines:[["RM-COPPER-WIRE",0.40],["RM-PET-FILM",0.42],["RM-ACRYLIC-ADH",0.12],["RM-CORE",0.10]] },
    "FG-AL-MYLAR":{ yield:0.96, lines:[["RM-AL-FOIL",0.45],["RM-PET-FILM",0.45],["RM-ACRYLIC-ADH",0.10],["RM-CORE",0.10]] },
    "FG-PET-FILM":{ yield:0.97, lines:[["RM-PET-FILM",0.92],["RM-ACRYLIC-ADH",0.06],["RM-CORE",0.10]] },
    "FG-NW-TAPE": { yield:0.97, lines:[["RM-NONWOVEN",0.80],["RM-ACRYLIC-ADH",0.16],["RM-CORE",0.12]] },
    "FG-PP-FOAM": { yield:0.95, lines:[["RM-PP-FOAM",0.88],["RM-ACRYLIC-ADH",0.08],["RM-CORE",0.10]] },
    "FG-RUB-COT": { yield:0.96, lines:[["RM-COTTON",3.2],["RM-SILICONE",0.18],["RM-CORE",0.12]] },
  };

  /* ============================================================
     SUPPLIERS
     ============================================================ */
  const suppliers = [
    {id:"SUP-01", name:"Bihar Mica Exports", city:"Koderma, Jharkhand", country:"India", gst:"20BMICA1234F1Z5", rating:4.6, onTime:94, terms:"45 days", contact:"R. Prasad", phone:"+91 98350 11223", email:"sales@biharmica.in", category:"Mica"},
    {id:"SUP-02", name:"Saint-Glass Fibre Pvt Ltd", city:"Mumbai", country:"India", gst:"27PQRSX9876L1Z2", rating:4.4, onTime:91, terms:"30 days", contact:"M. Iyer", phone:"+91 98200 44556", email:"order@saintglass.co.in", category:"Glass"},
    {id:"SUP-03", name:"Polyplex Films Ltd", city:"Noida", country:"India", gst:"09LMNOP4567Q1Z8", rating:4.5, onTime:96, terms:"30 days", contact:"A. Khanna", phone:"+91 98110 77889", email:"b2b@polyplex.com", category:"Film"},
    {id:"SUP-04", name:"AquaBlock Polymers Pvt Ltd", city:"Vadodara, Gujarat", country:"India", gst:"24AQUAB4567Q1Z8", rating:4.5, onTime:90, terms:"45 days", contact:"S. Patel", phone:"+91 99780 33221", email:"sales@aquablockpoly.in", category:"Polymer / SAP"},
    {id:"SUP-05", name:"Aditya Resins & Polymers", city:"Ahmedabad", country:"India", gst:"24RESIN1234A1Z9", rating:4.2, onTime:89, terms:"30 days", contact:"P. Shah", phone:"+91 99250 33445", email:"sales@adityaresins.in", category:"Resin"},
    {id:"SUP-06", name:"Bond-Tech Adhesives", city:"Pune", country:"India", gst:"27BONDT5678H1Z1", rating:4.0, onTime:85, terms:"30 days", contact:"S. Deshmukh", phone:"+91 98220 66778", email:"info@bondtech.in", category:"Adhesive"},
    {id:"SUP-07", name:"Karnataka Solvents Co.", city:"Bangalore", country:"India", gst:"29SOLVE2345K1Z4", rating:4.3, onTime:97, terms:"15 days", contact:"V. Rao", phone:"+91 99450 88990", email:"supply@ksolvents.in", category:"Chemical"},
    {id:"SUP-08", name:"Bharat Copper Industries", city:"Jaipur", country:"India", gst:"08COPPR6789B1Z6", rating:4.1, onTime:83, terms:"30 days", contact:"N. Agarwal", phone:"+91 98290 22334", email:"sales@bharatcopper.in", category:"Metal"},
    {id:"SUP-09", name:"Doddaballapur Packaging Solutions", city:"Bangalore", country:"India", gst:"29PACKG3456P1Z7", rating:4.5, onTime:98, terms:"15 days", contact:"K. Murthy", phone:"+91 99450 55667", email:"orders@dbpack.in", category:"Packaging"},
  ];

  /* ============================================================
     CUSTOMERS — HT cable & wire manufacturers
     ============================================================ */
  const customers = [
    {id:"CUS-01", name:"Polycab India Ltd", city:"Halol, Gujarat", gst:"24POLYC1234B1Z3", segment:"HT Cables", rating:"A", terms:"45 days", contact:"D. Mehta", phone:"+91 98250 10101", email:"procure@polycab.com", since:"2019"},
    {id:"CUS-02", name:"KEI Industries Ltd", city:"Bhiwadi, Rajasthan", gst:"08KEIIN5678C1Z9", segment:"HT/EHV Cables", rating:"A", terms:"45 days", contact:"R. Sharma", phone:"+91 98290 20202", email:"sourcing@kei-ind.com", since:"2018"},
    {id:"CUS-03", name:"Finolex Cables Ltd", city:"Pune, Maharashtra", gst:"27FINOL9012D1Z5", segment:"Power Cables", rating:"A", terms:"30 days", contact:"A. Joshi", phone:"+91 98220 30303", email:"buy@finolex.com", since:"2020"},
    {id:"CUS-04", name:"Havells India Ltd", city:"Alwar, Rajasthan", gst:"08HAVEL3456E1Z1", segment:"Wires & Cables", rating:"A", terms:"45 days", contact:"S. Gupta", phone:"+91 98290 40404", email:"vendor@havells.com", since:"2021"},
    {id:"CUS-05", name:"RR Kabel Ltd", city:"Silvassa, DNH", gst:"26RRKAB7890F1Z7", segment:"HT Cables", rating:"B", terms:"30 days", contact:"M. Patel", phone:"+91 98240 50505", email:"po@rrkabel.com", since:"2022"},
    {id:"CUS-06", name:"Apar Industries (Cables)", city:"Umbergaon, Gujarat", gst:"24APARI2345G1Z2", segment:"EHV Cables", rating:"B", terms:"45 days", contact:"H. Desai", phone:"+91 98250 60606", email:"cables@apar.com", since:"2021"},
    {id:"CUS-07", name:"Universal Cables Ltd", city:"Satna, MP", gst:"23UNIVC6789H1Z8", segment:"HT/EHV Cables", rating:"B", terms:"60 days", contact:"P. Tiwari", phone:"+91 98260 70707", email:"materials@unistar.co.in", since:"2020"},
    {id:"CUS-08", name:"Gupta Power Infrastructure", city:"Cuttack, Odisha", gst:"21GUPTA1234J1Z4", segment:"Power Cables", rating:"C", terms:"30 days", contact:"B. Nayak", phone:"+91 98610 80808", email:"purchase@guptapower.com", since:"2023"},
    {id:"CUS-09", name:"Dynamic Cables Ltd", city:"Reengus, Rajasthan", gst:"08DYNAM5678K1Z6", segment:"HT Cables", rating:"C", terms:"30 days", contact:"L. Saini", phone:"+91 98290 90909", email:"store@dynamiccables.in", since:"2023"},
    {id:"CUS-10", name:"Bahra Cables Co.", city:"Sangrur, Punjab", gst:"03BAHRA9012L1Z3", segment:"LV/HT Cables", rating:"C", terms:"45 days", contact:"G. Singh", phone:"+91 98140 11122", email:"info@bahracables.com", since:"2022"},
  ];

  /* ============================================================
     OPENING STOCK + STOCK MOVEMENTS (ledger)
     Movement types: OPEN, GRN (receipt), ISSUE (to production),
     PROD (finished output), SALE (dispatch), ADJ (adjustment),
     RET (return), SCRAP
     ============================================================ */
  let movements = [];
  let mvSeq = 1;
  const addMove = (o)=>{ movements.push(Object.assign({
    id:"MV-"+String(mvSeq++).padStart(5,"0"), ref:"", note:"", by:"system"
  }, o)); };

  /* ------------------------------------------------------------
     BALANCED DAY-STEPPED SIMULATION
     A proper min/max inventory simulation so stock stays realistic:
       • opening balances near target levels
       • demand-driven sales consume finished goods
       • production replenishes FG below reorder (consuming raws via BOM)
       • procurement replenishes raws below reorder (GRN / open POs)
     This keeps balances oscillating around reorder points instead of
     drifting negative or ballooning.
     ------------------------------------------------------------ */
  let workorders = [], salesorders = [], purchaseorders = [];
  let woSeq=1, soSeq=1, poSeq=1;
  const bal = {};                       // running balance during sim
  const fgItems = items.filter(i=>i.cat==="FG");
  const rawItems = items.filter(i=>i.cat!=="FG");

  function shuffle(arr){ const a=arr.slice(); for(let i=a.length-1;i>0;i--){ const j=Math.floor(rnd()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; }

  // Opening balances ~120 days ago — near healthy target
  const openDay = daysAgo(120);
  items.forEach(it=>{
    const q = Math.round(it.cat==="FG" ? ri(it.reorder*1.4, it.reorder*1.9)
                                       : ri(it.reorder*1.3, it.reorder*1.7));
    bal[it.id] = q;
    addMove({date:openDay, itemId:it.id, wh: it.cat==="FG"?"WH-FG":"WH-PNY", type:"OPEN", qty:q, rate:it.cost, ref:"OB-2026", note:"Opening balance"});
  });

  // per-FG average daily demand (kg/day): consume ~1 reorder qty every 11-16 days (modest, keeps stock healthy)
  const demandRate = {}; fgItems.forEach(fg=>{ demandRate[fg.id] = fg.reorder/ri(11,16); });
  const pendDemand = {}; fgItems.forEach(fg=>{ pendDemand[fg.id]=0; });
  const incoming = {}; items.forEach(it=>{ incoming[it.id]=0; });   // qty on not-yet-received POs
  const openSOs = [];   // sales orders awaiting dispatch (retry each day)

  function tryDispatch(so, date){
    if(so.lines.every(l=>bal[l.itemId] >= l.qty)){
      so.lines.forEach(l=>{ bal[l.itemId]-=l.qty;
        addMove({date, itemId:l.itemId, wh:"WH-FG", type:"SALE", qty:-l.qty, rate:l.rate, ref:so.id, note:"Dispatch to "+custName(so.customerId), by:"sales"}); });
      so.status="Dispatched"; so.dispatchedOn=date;
      return true;
    }
    return false;
  }
  function custName(id){ const c=customers.find(x=>x.id===id); return c?c.name:id; }

  // Simulate day by day (oldest -> newest)
  for(let d=119; d>=0; d--){
    const date = daysAgo(d);

    /* 1) RAW PROCUREMENT — replenish raws whose (stock + incoming) <= reorder */
    const lowRaws = rawItems.filter(rm=> (bal[rm.id] + incoming[rm.id]) <= rm.reorder);
    if(lowRaws.length){
      // group by supplier
      const bySup={}; lowRaws.forEach(rm=>{ const s=rm.supplierId||"SUP-09"; (bySup[s]=bySup[s]||[]).push(rm); });
      Object.entries(bySup).forEach(([sid,rms])=>{
        const lines = rms.map(rm=>{ const target=rm.reorder*1.7;
          const qty=Math.max(rm.moq||50, Math.round(target-bal[rm.id]-incoming[rm.id]));
          return {itemId:rm.id, qty, rate:+(rm.cost*rf(0.97,1.04)).toFixed(2), recd:0}; });
        const poId="PO-"+String(poSeq++).padStart(4,"0");
        const lead = Math.max(...rms.map(r=>r.lead));
        // received if order is old enough that lead time has elapsed before today
        const received = d > lead+2;
        const partial  = !received && d > Math.floor(lead/2) && chance(0.45);
        lines.forEach(l=>{
          if(received){ l.recd=l.qty; bal[l.itemId]+=l.qty;
            addMove({date:daysAgo(Math.max(d-lead,0)), itemId:l.itemId, wh:"WH-PNY", type:"GRN", qty:l.qty, rate:l.rate, ref:poId, note:"Goods receipt", supplierId:sid}); }
          else if(partial){ l.recd=Math.round(l.qty*rf(0.3,0.6)); bal[l.itemId]+=l.recd;
            incoming[l.itemId]+=(l.qty-l.recd);
            addMove({date:daysAgo(Math.max(d-Math.floor(lead/2),0)), itemId:l.itemId, wh:"WH-PNY", type:"GRN", qty:l.recd, rate:l.rate, ref:poId, note:"Partial receipt", supplierId:sid}); }
          else { incoming[l.itemId]+=l.qty; }
        });
        purchaseorders.push({id:poId, date, supplierId:sid, lines,
          status: received?"Received":(partial?"Partially Received":"Open"),
          eta: daysAhead(received? -ri(0,6) : Math.max(1, lead-d)), // future eta for pending
          value: lines.reduce((s,l)=>s+l.qty*l.rate,0)});
      });
    }

    /* 2) PRODUCTION — replenish FG at/below reorder, consuming raws.
          Near "today" (d<=6) leave some orders in-progress for a live floor. */
    fgItems.forEach(fg=>{
      if(bal[fg.id] > fg.reorder*1.15) return;
      if(!chance(0.7)) return;
      const bom=boms[fg.id]; if(!bom) return;
      const target=fg.reorder*1.85;
      const outQty=Math.max(40, Math.round(target-bal[fg.id]));
      const woId="WO-"+String(woSeq++).padStart(4,"0");
      const completed = d>6;
      const inProgress = !completed && chance(0.8);
      const progress = completed?100:(inProgress?ri(30,85):0);
      if(completed){
        bom.lines.forEach(([rid,per])=>{ const need=+(per*outQty/bom.yield).toFixed(2);
          bal[rid]=+(bal[rid]-need).toFixed(2);
          addMove({date, itemId:rid, wh:"WH-WIP", type:"ISSUE", qty:-need, rate:(idMap[rid]||{}).cost||0, ref:woId, note:"Issue to "+fg.id, by:"prod"}); });
        bal[fg.id]+=outQty;
        addMove({date, itemId:fg.id, wh:"WH-FG", type:"PROD", qty:outQty, rate:fg.cost, ref:woId, note:"Production output", by:"prod"});
      } else if(inProgress){
        // issue proportional raws already consumed
        bom.lines.forEach(([rid,per])=>{ const need=+(per*outQty/bom.yield*progress/100).toFixed(2);
          bal[rid]=+(bal[rid]-need).toFixed(2);
          addMove({date, itemId:rid, wh:"WH-WIP", type:"ISSUE", qty:-need, rate:(idMap[rid]||{}).cost||0, ref:woId, note:"WIP issue "+fg.id, by:"prod"}); });
      }
      workorders.push({id:woId, date, itemId:fg.id, qty:outQty, status: completed?"Completed":(inProgress?"In Progress":"Released"),
        due: daysAhead(completed?-ri(0,4):ri(1,7)),
        line: pick(["Coating Line 1","Coating Line 2","Slitting A","Slitting B"]),
        progress, priority: pick(["Normal","Normal","High"])});
    });

    /* 3a) DISPATCH BACKLOG — retry shipping open orders now that stock may have arrived (FIFO) */
    for(const so of openSOs){ if(so.status!=="Dispatched") tryDispatch(so, date); }

    /* 3b) NEW SALES — accrue demand, emit orders, ship immediately if stock allows */
    fgItems.forEach(fg=>{ pendDemand[fg.id]+= demandRate[fg.id]*rf(0.5,1.5); });
    if(chance(0.55)){
      const cust=pick(customers);
      const chosen=shuffle(fgItems).slice(0, ri(1,3));
      const lines=[];
      chosen.forEach(fg=>{
        const want=Math.round(pendDemand[fg.id]*rf(0.6,1.0));
        if(want<15) return;
        lines.push({itemId:fg.id, qty:want, width:pick(fg.widthMM||[25]), rate:Math.round(fg.price*rf(0.96,1.04))});
        pendDemand[fg.id]=Math.max(0,pendDemand[fg.id]-want);
      });
      if(lines.length){
        const soId="SO-"+String(soSeq++).padStart(4,"0");
        const so={id:soId, date, customerId:cust.id, lines, status:"Confirmed",
          promised: daysAhead(ri(2,14)),
          priority: pick(["Normal","Normal","Normal","High","Urgent"]),
          value: lines.reduce((s,l)=>s+l.qty*l.rate,0)};
        salesorders.push(so); openSOs.push(so);
        if(!tryDispatch(so, date)){ so.status = "In Production"; }
      }
    }

    /* 4) occasional QC scrap / cycle-count adjustment */
    if(chance(0.12)){
      const it=pick(items); const t=chance(0.6)?"SCRAP":"ADJ";
      const q = t==="SCRAP"? -ri(2,Math.max(3,Math.round((bal[it.id]||50)*0.01))) : (chance(0.5)?1:-1)*ri(2,20);
      bal[it.id]=Math.max(0,(bal[it.id]||0)+q);
      addMove({date, itemId:it.id, wh: it.cat==="FG"?"WH-FG":"WH-PNY", type:t, qty:q, rate:it.cost,
        ref:t+"-"+ri(1000,9999), note: t==="SCRAP"?"QC rejection / scrap":"Cycle-count adjustment", by:"qc"});
    }
  }

  movements.sort((a,b)=> a.date<b.date?-1: a.date>b.date?1: a.id<b.id?-1:1);

  /* ============================================================
     SETTINGS / ORG
     ============================================================ */
  const org = {
    name:"Chhaperia Cable Material Pvt. Ltd.",
    short:"Chhaperia International",
    group:"Chhaperia Group",
    tagline:"A Revolutionary & Innovative Manufacturer of Cable Tapes",
    estd:1959,
    address:"Sy. No. 18, K.G. Kuntanahalli, Kasaba Hobli, Doddaballapur, Bangalore - 561203, Karnataka, INDIA",
    iso:"ISO 9001 Certified",
    gst:"29CHCMP1959C1Z0",
    phone:"+91 98454 93493",
    email:"info@micagroup.net",
    website:"www.chhaperiatapes.com",
    contacts:[
      {name:"Sales Desk", role:"Sales & Marketing", phone:"+91 98863 26886", email:"sales@micagroup.net"},
      {name:"Marketing Desk", role:"Marketing", phone:"+91 99646 90949", email:"marketing@micagroup.net"},
    ],
    currency:"₹",
    fyStart:"2026-04-01",
  };

  /* ============================================================
     ASSEMBLE + PERSIST
     ============================================================ */
  function freshData(){
    return {
      version:1, seededAt:new Date().toISOString(),
      org, warehouses, categories, items, boms, suppliers, customers,
      movements, workorders, salesorders, purchaseorders,
      settings:{ theme:"dark", accent:"orange", autoAccent:false, lowStockOnly:false }
    };
  }

  function load(){
    try{
      const raw = localStorage.getItem(KEY);
      if(raw){ const d = JSON.parse(raw); if(d && d.version===1) return d; }
    }catch(e){ console.warn("load failed", e); }
    const d = freshData();
    save(d);
    return d;
  }
  function save(d){ try{ localStorage.setItem(KEY, JSON.stringify(d)); }catch(e){ console.warn("save failed",e);} }
  function reseed(){ RND = mulberry32(20260617); localStorage.removeItem(KEY);
    // rebuild module-scope arrays fresh
    location.reload(); }

  global.DB = {
    KEY, load, save, reseed, freshData,
    helpers:{ daysAgo, daysAhead, iso, today:()=>today, DAY }
  };
})(window);
