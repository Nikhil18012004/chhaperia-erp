/* ============================================================
   CHHAPERIA ERP — TEMPORARY DEMO DATA · CATALOGUE
   ------------------------------------------------------------
   EVERY figure the demo loader writes is declared here, in one
   readable table, so it can be audited before it is loaded and
   removed exactly afterwards.

   Sources (physical store counts supplied by the user):
     • U2 ground store data.xlsx      → new-building ground-floor store
     • Chemical_store data.xlsx       → chemical store
     • SUBU MICA(AutoRecovered).xlsx  → mica store (2 sheets)
     • fabric stock.xlsx              → fabric store (roll counts)
     • U2 BASEMENT STOCK.xlsx         → basement store (roll/pallet counts)

   Everything lands in WH-PNY ("main store.") as a goods receipt
   against a purchase order raised 7–10 days earlier, so every
   kilo in the store is traceable to a supplier and a PO.

   UNITS — two rules, applied consistently:
     • MICA TAPE is held in the item master in MTR at a known GSM.
       The sheets count kilos, so kg → MTR = kg × 1000 / gsm. That is
       the plant's own conversion (a 1000 mm × 1000 m batch = 1000 m²)
       and matches the receipts already in the database.
     • Everything the sheets count as ROLLS / PALLETS / BOXES stays
       in rolls, pallets and boxes — nothing is invented. Those lines
       become their own store items and are visible as stock, but a
       BOM cannot consume them (a recipe needs metres or kilos).
   ============================================================ */
"use strict";

const TAG = "TEMP-DEMO-2026-07-31";

/* ============================================================
   1. SUPPLIERS named by the sheets that are not yet on file
   ============================================================ */
const NEW_SUPPLIERS = [
  { id: "SUP-10", name: "Dollar Industries (Fabrics)", city: "Ahmedabad, Gujarat",
    contact: "Purchase Desk", terms: "30 days", category: "Fabric", lead: 21,
    notes: "Woven polyester / cotton fabric — named on the fabric store sheet." },
  { id: "SUP-11", name: "Jiangsu Textile Imports (China)", city: "Jiangsu, China",
    contact: "Export Desk", terms: "LC at sight", category: "Fabric", lead: 45,
    notes: "PWF series fabric + TB — named on the fabric and basement sheets." },
  { id: "SUP-12", name: "Kusumgar Corporates", city: "Vapi, Gujarat",
    contact: "Sales Desk", terms: "45 days", category: "Fabric", lead: 25,
    notes: "PWPP coated fabric — named on the fabric store sheet." },
];

/* ============================================================
   2. STORE ITEMS the sheets name that the item master does not
      have yet. Created as raw-material items in the unit the
      sheet actually counts in.
   ============================================================ */
const NEW_ITEMS = [
  /* ---- mica tape thicknesses not yet in the master (MTR @ gsm) ---- */
  { id: "RM-MICA-TAPE-CP25G-90MIC", name: "MICA TAPE CP25G 0.09MM", group: "MICA", uom: "MTR",
    gsm: 125, thicknessMM: 0.09, supplierId: "SUP-01", cost: 65.0 },
  { id: "RM-MICA-TAPE-CP25H-120MIC", name: "MICA TAPE CP25H 0.12MM", group: "MICA", uom: "MTR",
    gsm: 170, thicknessMM: 0.12, supplierId: "SUP-01", cost: 91.8 },
  { id: "RM-MICA-TAPE-CP25H-130MIC", name: "MICA TAPE CP25H 0.13MM", group: "MICA", uom: "MTR",
    gsm: 185, thicknessMM: 0.13, supplierId: "SUP-01", cost: 99.9 },
  { id: "RM-MICA-TAPE-CCM25G-120MIC", name: "MICA TAPE CCM25G 0.12MM", group: "MICA", uom: "MTR",
    gsm: 155, thicknessMM: 0.12, supplierId: "SUP-01", cost: 108.5 },
  { id: "RM-MICA-TAPE-CM25DG-125MIC", name: "MICA TAPE CM25 DG 0.125MM", group: "MICA", uom: "MTR",
    gsm: 164, thicknessMM: 0.125, supplierId: "SUP-01", cost: 111.5 },
  { id: "RM-MICA-PAPER-100GSM", name: "MICA PAPER 100 GSM", group: "MICA", uom: "PLT",
    supplierId: "SUP-01", cost: 78000 },
  { id: "RM-MICA-PAPER-120GSM", name: "MICA PAPER 120 GSM", group: "MICA", uom: "PLT",
    supplierId: "SUP-01", cost: 82000 },

  /* ---- yarns and powders (kg) ---- */
  { id: "RM-FIBER-GLASS-YARN-150-1-0-33TEX", name: "FIBER GLASS YARN 150 1/0 (33 TEX)",
    group: "YARN", uom: "KG", supplierId: "SUP-02", cost: 215 },
  { id: "RM-FIBER-GLASS-YARN-150-1-2-68TEX", name: "FIBER GLASS YARN 150 1/2 (68 TEX)",
    group: "YARN", uom: "KG", supplierId: "SUP-02", cost: 208 },
  { id: "RM-WATER-BLOCKING-YARN-2000D", name: "WATER BLOCKING YARN 2000 DENIER",
    group: "YARN", uom: "KG", supplierId: "SUP-04", cost: 340 },
  { id: "RM-WATER-BLOCKING-YARN-1000D", name: "WATER BLOCKING YARN 1000 DENIER",
    group: "YARN", uom: "KG", supplierId: "SUP-04", cost: 365 },
  { id: "RM-PP-FILLER-YARN-3", name: "PP FILLER YARN 3", group: "YARN", uom: "KG",
    supplierId: "SUP-03", cost: 148 },
  { id: "RM-WATER-BLOCKING-POWDER-GREEN", name: "WATER BLOCKING POWDER (GREEN BAG)",
    group: "CHEMICAL", uom: "KG", supplierId: "SUP-04", cost: 290 },

  /* ---- chemicals the chemical store holds that were not on file ---- */
  { id: "RM-HEXA-BOUND-GL-75HL", name: "HEXA BOUND GL-75HL", group: "CHEMICAL", uom: "KG",
    supplierId: "SUP-06", cost: 520 },
  { id: "RM-LOCTITE-CAC1511", name: "LOCTITE CAC1511", group: "CHEMICAL", uom: "KG",
    supplierId: "SUP-06", cost: 610 },
  { id: "RM-EPOXY-EPOFINE-RESIN", name: "EPOXY EPOFINE RESIN", group: "CHEMICAL", uom: "KG",
    supplierId: "SUP-05", cost: 385 },
  { id: "RM-GR-PETLAM-WHITE", name: "GR PETLAM WHITE", group: "CHEMICAL", uom: "KG",
    supplierId: "SUP-05", cost: 268 },
  { id: "RM-GR-PETLAM-BLACK", name: "GR PETLAM BLACK", group: "CHEMICAL", uom: "KG",
    supplierId: "SUP-05", cost: 268 },
  { id: "RM-ACRYLIC-RESIN", name: "ACRYLIC RESIN", group: "CHEMICAL", uom: "KG",
    supplierId: "SUP-05", cost: 210 },
  { id: "RM-MF1310", name: "MF1310", group: "CHEMICAL", uom: "KG",
    supplierId: "SUP-05", cost: 340 },
  { id: "RM-ADHESIVE-MOMENTIVE-PSA-6573A05G", name: "MOMENTIVE PSA 6573A05G (JOINT RESIN)",
    group: "CHEMICAL", uom: "KG", supplierId: "SUP-06", cost: 1180 },
  { id: "RM-EOXPAL-7063-0643", name: "EOXPAL 7063.0643", group: "CHEMICAL", uom: "KG",
    supplierId: "SUP-05", cost: 355 },
  { id: "RM-DOWSIL-Q27406", name: "DOWSIL Q2-7406", group: "CHEMICAL", uom: "KG",
    supplierId: "SUP-06", cost: 980 },

  /* ---- fabric store: counted in ROLLS ---- */
  { id: "RM-FAB-DOLLAR-013T-65GSM", name: "FABRIC 0.13T - 65 GSM (Dollar)", group: "FABRIC",
    uom: "ROLL", supplierId: "SUP-10", cost: 8200 },
  { id: "RM-FAB-DOLLAR-014T-100GSM", name: "FABRIC 0.14T - 100 GSM (Dollar)", group: "FABRIC",
    uom: "ROLL", supplierId: "SUP-10", cost: 10400 },
  { id: "RM-FAB-DOLLAR-016T-90GSM", name: "FABRIC 0.16T - 90 GSM (Dollar)", group: "FABRIC",
    uom: "ROLL", supplierId: "SUP-10", cost: 9800 },
  { id: "RM-FAB-DOLLAR-020T-120GSM", name: "FABRIC 0.20T - 120 GSM (Dollar)", group: "FABRIC",
    uom: "ROLL", supplierId: "SUP-10", cost: 12600 },
  { id: "RM-FAB-DOLLAR-VHT-020T", name: "HIGH TENSILE FABRIC VHT - 0.20T (Dollar)", group: "FABRIC",
    uom: "ROLL", supplierId: "SUP-10", cost: 13500 },
  { id: "RM-FAB-PWF-11C", name: "FABRIC PWF-11C (China)", group: "FABRIC",
    uom: "ROLL", supplierId: "SUP-11", cost: 9200 },
  { id: "RM-FAB-PWF-16C", name: "FABRIC PWF-16C (China)", group: "FABRIC",
    uom: "ROLL", supplierId: "SUP-11", cost: 9800 },
  { id: "RM-FAB-PWF-22C", name: "FABRIC PWF-22C (China)", group: "FABRIC",
    uom: "ROLL", supplierId: "SUP-11", cost: 11200 },
  { id: "RM-FAB-PWPP9416-012T", name: "FABRIC PWPP9416 - 0.12T (Kusumgar)", group: "FABRIC",
    uom: "ROLL", supplierId: "SUP-12", cost: 10600 },
  { id: "RM-FAB-PWPP9758-020T", name: "FABRIC PWPP9758 - 0.20T (Kusumgar)", group: "FABRIC",
    uom: "ROLL", supplierId: "SUP-12", cost: 12400 },

  /* ---- ground-floor store ---- */
  { id: "RM-NON-WOVEN-WHITE-016-980MM", name: "NON WOVEN WHITE COLOR 0.16MM × 980MM",
    group: "FABRIC", uom: "KG", supplierId: "SUP-03", cost: 165 },

  /* ---- basement store: counted in ROLLS / PALLETS ---- */
  { id: "RM-HF72", name: "HF72", group: "FABRIC", uom: "ROLL", supplierId: "SUP-03", cost: 7600 },
  { id: "RM-PP-TAPE-015-ROLL", name: "PP TAPE 0.15", group: "FABRIC", uom: "ROLL",
    supplierId: "SUP-03", cost: 6900 },
  { id: "RM-PP-TAPE-020-ROLL", name: "PP TAPE 0.20", group: "FABRIC", uom: "ROLL",
    supplierId: "SUP-03", cost: 8400 },
  { id: "RM-JAPAN-POWDER-180N", name: "JAPAN POWDER 180N (SAP)", group: "CHEMICAL", uom: "PLT",
    supplierId: "SUP-04", cost: 145000 },
  { id: "RM-REINFORCE", name: "REINFORCE", group: "FABRIC", uom: "ROLL",
    supplierId: "SUP-03", cost: 5200 },
  { id: "RM-LSZH-018-ROLL", name: "LSZH 0.18", group: "FABRIC", uom: "ROLL",
    supplierId: "SUP-03", cost: 9800 },
  { id: "RM-TB-CHINA", name: "TB CHINA", group: "FABRIC", uom: "PLT",
    supplierId: "SUP-11", cost: 98000 },

  /* ---- mica store, second sheet: bought-in / semi-finished tape held in store ---- */
  { id: "RM-RCT-020-JUMBO", name: "RCT 0.2 (jumbo roll)", group: "TAPE STOCK", uom: "ROLL",
    supplierId: "SUP-03", cost: 12500 },
  { id: "RM-RCT-030-JUMBO", name: "RCT 0.3 (jumbo roll)", group: "TAPE STOCK", uom: "ROLL",
    supplierId: "SUP-03", cost: 15800 },
  { id: "RM-SC-WOVEN-WBT-020-40MM", name: "SEMI-CONDUCTING WOVEN WBT 0.20 × 40MM",
    group: "TAPE STOCK", uom: "SQM", supplierId: "SUP-11", cost: 310 },
  { id: "RM-CHDSW-030-60MM", name: "CHDSW 0.30 × 60MM", group: "TAPE STOCK", uom: "KG",
    supplierId: "SUP-11", cost: 340 },
  { id: "RM-CHDNW-030-65MM", name: "CHDNW 0.30 × 65MM", group: "TAPE STOCK", uom: "SQM",
    supplierId: "SUP-11", cost: 275 },
  { id: "RM-CHDNW-030-50MM", name: "CHDNW 0.30 × 50MM", group: "TAPE STOCK", uom: "KG",
    supplierId: "SUP-11", cost: 300 },
  { id: "RM-CHSNW-015-50MM", name: "CHSNW 0.15 × 50MM", group: "TAPE STOCK", uom: "MTR",
    supplierId: "SUP-11", cost: 42 },
  { id: "RM-CHSNW-015-60MM", name: "CHSNW 0.15 × 60MM", group: "TAPE STOCK", uom: "BOX",
    supplierId: "SUP-11", cost: 28000 },
  { id: "RM-NCWBT-030-16MM", name: "NCWBT 0.30 × 16MM (spool roll)", group: "TAPE STOCK",
    uom: "KG", supplierId: "SUP-11", cost: 380 },
  { id: "RM-PP-TAPE-010", name: "PP TAPE 0.1", group: "TAPE STOCK", uom: "KG",
    supplierId: "SUP-03", cost: 158 },
];

/* ============================================================
   3. PURCHASE ORDERS — one per supplier consignment.
      `recv` is the day the goods were physically taken into the
      main store; `date` is 7–10 days earlier, as instructed.
      Every line becomes a goods receipt into WH-PNY on `recv`.
   ============================================================ */
const PURCHASE_ORDERS = [
  /* ---------- MICA STORE (SUBU MICA sheet "Table 1") ---------- */
  { key: "MICA-1", supplierId: "SUP-01", date: "2026-06-03", recv: "2026-06-12", gap: 9,
    note: "Phlogopite mica tape — lots 729 / 744 / 722 / 537(Korea)",
    lines: [
      { itemId: "RM-MICA-TAPE-CP25G-90MIC", kg: 6392, gsm: 125, rate: 65.0, lot: "729" },
      { itemId: "RM-MICA-TAPE-CP25G-120MIC", kg: 5952, gsm: 170, rate: 88.4, lot: "744" },
      { itemId: "RM-MICA-TAPE-CP25G-140MIC", kg: 192.4, gsm: 200, rate: 104.0, lot: "722" },
      { itemId: "RM-MICA-TAPE-CP25G-100MIC", kg: 1141, gsm: 140, rate: 72.8, lot: "537 (KOREA)" },
      { itemId: "RM-MICA-TAPE-CP25H-120MIC", kg: 120.4, gsm: 170, rate: 91.8, lot: "—" },
      { itemId: "RM-MICA-TAPE-CP25H-130MIC", kg: 428, gsm: 185, rate: 99.9, lot: "—" },
    ] },
  { key: "MICA-2", supplierId: "SUP-01", date: "2026-06-30", recv: "2026-07-08", gap: 8,
    note: "Muscovite / double-glass / inorganic mica tape — lots 745 / 613 / 611 / 615 / 610",
    lines: [
      { itemId: "RM-MICA-TAPE-CM25G-130MIC", kg: 2682, gsm: 170, rate: 103.7, lot: "745" },
      { itemId: "RM-MICA-TAPE-CM25G-140MIC", kg: 14150, gsm: 190, rate: 115.9, lot: "613" },
      { itemId: "RM-MICA-TAPE-CM25DG-125MIC", kg: 1130, gsm: 164, rate: 111.5, lot: "611" },
      { itemId: "RM-MICA-TAPE-CM25DG-125MIC", kg: 13560, gsm: 164, rate: 111.5, lot: "615" },
      { itemId: "RM-MICA-TAPE-CCM25G-120MIC", kg: 14424, gsm: 155, rate: 108.5, lot: "610" },
      { itemId: "RM-MICA-PAPER-100GSM", qty: 2, uom: "PLT", rate: 78000, lot: "—" },
      { itemId: "RM-MICA-PAPER-120GSM", qty: 3, uom: "PLT", rate: 82000, lot: "—" },
    ] },

  /* ---------- CHEMICAL STORE ---------- */
  { key: "CHEM-SOLVENT", supplierId: "SUP-07", date: "2026-06-10", recv: "2026-06-18", gap: 8,
    note: "Solvents & thinners — chemical store drum count",
    lines: [
      { itemId: "RM-TOLUENE", qty: 2420, uom: "KG", rate: 96,
        drums: "5 × 190 kg + 7 × 210 kg" },
      { itemId: "RM-ETHYLE-ACETATE", qty: 1935, uom: "KG", rate: 104, drums: "9 × 215 kg" },
      { itemId: "RM-METHANOL", qty: 340, uom: "KG", rate: 78, drums: "2 × 170 kg" },
      { itemId: "RM-BINDER-K-61", qty: 1320, uom: "KG", rate: 185, drums: "6 × 220 kg (Kamicril 61)" },
    ] },
  { key: "CHEM-RESIN", supplierId: "SUP-05", date: "2026-06-17", recv: "2026-06-25", gap: 8,
    note: "Resins & laminating chemistry — chemical store drum count",
    lines: [
      { itemId: "RM-RESIN-DIC-LH-811", qty: 1240, uom: "KG", rate: 295, drums: "62 × 20 kg" },
      { itemId: "RM-HARDNER-LX-75-H", qty: 360, uom: "KG", rate: 410, drums: "72 × 5 kg" },
      { itemId: "RM-ACRYLIC-RESIN", qty: 1400, uom: "KG", rate: 210, drums: "7 × 200 kg" },
      { itemId: "RM-EPOXY-EPOFINE-RESIN", qty: 300, uom: "KG", rate: 385, drums: "12 × 25 kg" },
      { itemId: "RM-GR-PETLAM-WHITE", qty: 150, uom: "KG", rate: 268, drums: "6 × 25 kg" },
      { itemId: "RM-GR-PETLAM-BLACK", qty: 25, uom: "KG", rate: 268, drums: "1 × 25 kg" },
      { itemId: "RM-MF1310", qty: 200, uom: "KG", rate: 340, drums: "1 × 200 kg" },
      { itemId: "RM-EOXPAL-7063-0643", qty: 675, uom: "KG", rate: 355, drums: "3 × 225 kg" },
    ] },
  { key: "CHEM-ADHESIVE", supplierId: "SUP-06", date: "2026-06-25", recv: "2026-07-02", gap: 7,
    note: "Adhesives, hardeners & silicones — chemical store can count",
    lines: [
      { itemId: "RM-RESIN-LOCTITE", qty: 690, uom: "KG", rate: 560, drums: "3 × 230 kg (LA2642)" },
      { itemId: "RM-HARNER-5555", qty: 120, uom: "KG", rate: 640, drums: "24 × 5 kg (LA5555)" },
      { itemId: "RM-LOCTITE-CAC1511", qty: 25, uom: "KG", rate: 610, drums: "1 × 25 kg" },
      { itemId: "RM-HEXA-BOUND-GL-75HL", qty: 40, uom: "KG", rate: 520, drums: "8 × 5 kg" },
      { itemId: "RM-ADHESIVE-MOMENTIVE-PSA-6573A05G", qty: 72.64, uom: "KG", rate: 1180,
        drums: "4 × 18.16 kg" },
      { itemId: "RM-DOWSIL-Q27406", qty: 570, uom: "KG", rate: 980, drums: "3 × 190 kg" },
    ] },

  /* ---------- GROUND-FLOOR STORE ---------- */
  { key: "GLASS-YARN", supplierId: "SUP-02", date: "2026-06-10", recv: "2026-06-20", gap: 10,
    note: "Fibre-glass yarn — new building ground floor store",
    lines: [
      { itemId: "RM-FIBER-GLASS-YARN-150-1-0-33TEX", qty: 2000, uom: "KG", rate: 215,
        drums: "2 PLT (108 box) × 1000 kg" },
      { itemId: "RM-FIBER-GLASS-YARN-150-1-2-68TEX", qty: 6642, uom: "KG", rate: 208,
        drums: "6 PLT (210 box) × 1107 kg" },
    ] },
  { key: "WB-YARN", supplierId: "SUP-04", date: "2026-07-01", recv: "2026-07-10", gap: 9,
    note: "Water-blocking yarn & powder — ground floor + mica store",
    lines: [
      { itemId: "RM-WATER-BLOCKING-YARN-2000D", qty: 980, uom: "KG", rate: 340, drums: "28 box × 35 kg" },
      { itemId: "RM-WATER-BLOCKING-YARN-2000D", qty: 1050, uom: "KG", rate: 340, drums: "mica store" },
      { itemId: "RM-WATER-BLOCKING-YARN-1000D", qty: 4760, uom: "KG", rate: 365, drums: "mica store" },
      { itemId: "RM-WATER-BLOCKING-POWDER-GREEN", qty: 28600, uom: "KG", rate: 290, drums: "44 PLT" },
      { itemId: "RM-JAPAN-POWDER-180N", qty: 9, uom: "PLT", rate: 145000, drums: "basement store" },
    ] },
  { key: "PP-YARN", supplierId: "SUP-03", date: "2026-06-13", recv: "2026-06-22", gap: 9,
    note: "PP filler yarn & non-woven — new building ground floor store",
    lines: [
      { itemId: "RM-PP-FILLER-YARN-3", qty: 1026.2, uom: "KG", rate: 148, drums: "1 PLT" },
      { itemId: "RM-NON-WOVEN-WHITE-016-980MM", qty: 1080, uom: "KG", rate: 165,
        drums: "6 rolls × 180 kg, 980 mm wide" },
    ] },

  /* ---------- FABRIC STORE ---------- */
  { key: "FAB-DOLLAR", supplierId: "SUP-10", date: "2026-06-18", recv: "2026-06-27", gap: 9,
    note: "Woven fabric — Dollar",
    lines: [
      { itemId: "RM-FAB-DOLLAR-013T-65GSM", qty: 9, uom: "ROLL", rate: 8200 },
      { itemId: "RM-FAB-DOLLAR-014T-100GSM", qty: 30, uom: "ROLL", rate: 10400 },
      { itemId: "RM-FAB-DOLLAR-016T-90GSM", qty: 44, uom: "ROLL", rate: 9800 },
      { itemId: "RM-FAB-DOLLAR-020T-120GSM", qty: 58, uom: "ROLL", rate: 12600 },
      { itemId: "RM-FAB-DOLLAR-VHT-020T", qty: 2, uom: "ROLL", rate: 13500 },
    ] },
  { key: "FAB-CHINA", supplierId: "SUP-11", date: "2026-06-27", recv: "2026-07-06", gap: 9,
    note: "PWF series woven fabric — China",
    lines: [
      { itemId: "RM-FAB-PWF-11C", qty: 49, uom: "ROLL", rate: 9200 },
      { itemId: "RM-FAB-PWF-16C", qty: 12, uom: "ROLL", rate: 9800 },
      { itemId: "RM-FAB-PWF-22C", qty: 43, uom: "ROLL", rate: 11200 },
    ] },
  { key: "FAB-KUSUMGAR", supplierId: "SUP-12", date: "2026-07-07", recv: "2026-07-15", gap: 8,
    note: "PWPP coated fabric — Kusumgar",
    lines: [
      { itemId: "RM-FAB-PWPP9416-012T", qty: 13, uom: "ROLL", rate: 10600 },
      { itemId: "RM-FAB-PWPP9758-020T", qty: 34, uom: "ROLL", rate: 12400 },
    ] },

  /* ---------- BASEMENT STORE ---------- */
  { key: "BASEMENT", supplierId: "SUP-03", date: "2026-07-09", recv: "2026-07-18", gap: 9,
    note: "U2 basement store — film & tape rolls",
    lines: [
      { itemId: "RM-HF72", qty: 68, uom: "ROLL", rate: 7600 },
      { itemId: "RM-PP-TAPE-015-ROLL", qty: 60, uom: "ROLL", rate: 6900 },
      { itemId: "RM-PP-TAPE-020-ROLL", qty: 6, uom: "ROLL", rate: 8400 },
      { itemId: "RM-REINFORCE", qty: 30, uom: "ROLL", rate: 5200 },
      { itemId: "RM-LSZH-018-ROLL", qty: 22, uom: "ROLL", rate: 9800 },
    ] },
  { key: "TB-CHINA", supplierId: "SUP-11", date: "2026-07-13", recv: "2026-07-22", gap: 9,
    note: "TB — basement store pallets",
    lines: [
      { itemId: "RM-TB-CHINA", qty: 20, uom: "PLT", rate: 98000 },
    ] },

  /* ---------- MICA STORE, SECOND SHEET (bought-in tape held in store) ---------- */
  { key: "TAPE-STOCK", supplierId: "SUP-11", date: "2026-07-11", recv: "2026-07-20", gap: 9,
    note: "Bought-in / semi-finished tape held in the mica store",
    lines: [
      { itemId: "RM-RCT-020-JUMBO", qty: 21, uom: "ROLL", rate: 12500 },
      { itemId: "RM-RCT-030-JUMBO", qty: 2, uom: "ROLL", rate: 15800 },
      { itemId: "RM-SC-WOVEN-WBT-020-40MM", qty: 3000, uom: "SQM", rate: 310 },
      { itemId: "RM-CHDSW-030-60MM", qty: 1000, uom: "KG", rate: 340, drums: "150 000 m" },
      { itemId: "RM-CHDNW-030-65MM", qty: 3000, uom: "SQM", rate: 275 },
      { itemId: "RM-CHDNW-030-50MM", qty: 500, uom: "KG", rate: 300 },
      { itemId: "RM-CHSNW-015-50MM", qty: 150000, uom: "MTR", rate: 42 },
      { itemId: "RM-CHSNW-015-60MM", qty: 9, uom: "BOX", rate: 28000, drums: "30 000 m" },
      { itemId: "RM-NCWBT-030-16MM", qty: 500, uom: "KG", rate: 380, drums: "spool roll" },
      { itemId: "RM-PP-TAPE-010", qty: 11000, uom: "KG", rate: 158 },
    ] },
];

/* One order still in the pipe, so the Purchasing board shows an open
   commitment as well as closed receipts. Nothing is received against it. */
const OPEN_PURCHASE_ORDER = {
  key: "OPEN-MICA", supplierId: "SUP-01", date: "2026-07-27", eta: "2026-08-11",
  status: "Open", note: "Mica tape replenishment — in transit",
  lines: [
    { itemId: "RM-MICA-TAPE-CP25G-120MIC", kg: 4000, gsm: 170, rate: 90.5 },
    { itemId: "RM-MICA-TAPE-CM25G-140MIC", kg: 3000, gsm: 190, rate: 118.0 },
  ],
};

/* ============================================================
   3b. PRODUCTION MATERIALS — what the coating lines actually eat.
   ------------------------------------------------------------
   The five stock sheets are a snapshot of what is standing in the
   stores TODAY. They therefore do NOT list the fabric, paste, SAP
   and solvent that June's and July's production runs already used
   up. Those were bought and consumed, so they are bought here too:
   one purchase order per supplier, raised and received BEFORE the
   first run, covering exactly what the runs draw plus a small
   working remnant.

   Without this the store would be issuing material it never
   received and a quarter of the item master would show negative
   stock — which is the one thing this data must never do.

   Quantities are NOT written here: the loader adds up what the work
   orders genuinely consumed and orders that. Only the price and the
   supplier are a judgement call, so only those are stated.
   ============================================================ */
const PRODUCTION_MATERIALS = {
  /* fabrics, films and foils — Polyplex */
  "RM-NON-WOVEN-FABRIC-NORMAL": { rate: 18, supplierId: "SUP-03" },
  "RM-NON-WOVEN-FABRIC-NORMAL-120MIC": { rate: 18, supplierId: "SUP-03" },
  "RM-POLYESTER-FABRIC-PWF20": { rate: 95, supplierId: "SUP-03" },
  "RM-POLYESTER-FABRIC-25MIC": { rate: 26, supplierId: "SUP-03" },
  "RM-NON-WOVEN-FABRIC-COMPRESSED-50MIC": { rate: 22, supplierId: "SUP-03" },
  "RM-POLYOLYFIN": { rate: 38, supplierId: "SUP-03" },
  "RM-ALUMINIUM": { rate: 58, supplierId: "SUP-08" },
  /* mica tape — Bihar Mica */
  "RM-MICA-TAPE-CCM25G-80MIC": { rate: 105, supplierId: "SUP-01" },
  /* super-absorbent polymers — AquaBlock */
  "RM-SAP": { rate: 380, supplierId: "SUP-04" },
  "RM-SAP-HS150": { rate: 395, supplierId: "SUP-04" },
  "RM-SAP-180N": { rate: 385, supplierId: "SUP-04" },
  /* pastes, powders and binders — Bond-Tech */
  "RM-CARBON-PASTE-CLOFT-908": { rate: 235, supplierId: "SUP-06" },
  "RM-CARBON-PASTE-250-R": { rate: 240, supplierId: "SUP-06" },
  "RM-CARBON-POWDER-L85": { rate: 185, supplierId: "SUP-06" },
  "RM-BONDEX-8060": { rate: 310, supplierId: "SUP-06" },
  "RM-BINDER-DM-21": { rate: 195, supplierId: "SUP-06" },
  "RM-ADHESIVE-MOMENTIVE-595-NT": { rate: 1150, supplierId: "SUP-06" },
  /* inks — Aditya Resins */
  "RM-BLUE-INK-11013": { rate: 420, supplierId: "SUP-05" },
  "RM-WHITE-INK": { rate: 390, supplierId: "SUP-05" },
  /* solvents and catalysts — Karnataka Solvents */
  "RM-METHANOL": { rate: 78, supplierId: "SUP-07" },
  "RM-SOLVENT-ETHYLE-ACITATE": { rate: 104, supplierId: "SUP-07" },
  "RM-WATER-RO": { rate: 2, supplierId: "SUP-07" },
  "RM-DC": { rate: 0.5, supplierId: "SUP-07" },
  "RM-T-C": { rate: 0.8, supplierId: "SUP-07" },
  "RM-BPO": { rate: 1.2, supplierId: "SUP-07" },
  "RM-HARDNER-BENZOILE-PEROXIDE": { rate: 2.5, supplierId: "SUP-07" },
};

/* Raised and received before the first work order (2026-06-15), keeping the
   7-10 day gap the rest of the purchasing follows. */
const PRODUCTION_PO = { date: "2026-05-28", recv: "2026-06-06", gap: 9,
  note: "Production materials for the June / July coating programme" };

/* How much more than the runs consume to buy, so the store is left with a
   believable remnant rather than a shelf of exact zeroes. */
const PRODUCTION_BUFFER = 0.12;

/* ============================================================
   4. SELLING PRICES for the finished goods the demo trades in.
      (₹ / kg — the item master ships with 0 everywhere.)
   ============================================================ */
const FG_PRICE = {
  "FG-CP25G-08": 690, "FG-CP25G-10": 715, "FG-CP25G-11": 730, "FG-CP25G-12": 745,
  "FG-CP25G-14": 780, "FG-CP25G-15": 805, "FG-CM25G-08-10": 820, "FG-CM25G-11-12": 845,
  "FG-CM25G-13": 865, "FG-CM25G-14": 890, "FG-CCM25DG-125": 940, "FG-CCM25GE-10": 905,
  "FG-CCM25GE-13": 925, "FG-CCM25GE-16": 960, "FG-CP25GE-13": 870, "FG-CP25GE-145": 895,
  "FG-CHDNW-15-SINGLE-SIDE": 268, "FG-CHDNW-15-DOUBLE-SIDE": 285, "FG-CHDNW-20": 296,
  "FG-CHDNW-25": 310, "FG-CHDNW-30": 322, "FG-CHDNW-30E": 330, "FG-CHDNW-50": 372,
  "FG-CHDSW-25": 340, "FG-CHDSW-30": 352, "FG-CHDSW-321216": 360, "FG-CHDSW-40": 378,
  "FG-CHDSW-45": 392, "FG-CHDSW-50": 405, "FG-CHCNW-12": 258, "FG-CHCNW-15": 266,
  "FG-CHCNW-20": 278, "FG-CHN-12-TDM": 312, "FG-CHN-12-WS": 308, "FG-CHN-20-TDM": 336,
  "FG-CHN-20-WS": 330, "FG-CHN-25-TDMS": 352, "FG-CHN-30-TDM": 368, "FG-CHN-30-WS": 360,
  "FG-CHSCWWBT-18": 385, "FG-CHSCWWBT-20": 398, "FG-CHCWSCWBT-50": 640,
  "FG-CHSMWBT-F-100": 420, "FG-CHSMWBT-F-125": 442, "FG-CHSMWBT-F-150": 465,
  "FG-CHSMWBT-F-200": 498,
  "FG-CH-PET-15": 182, "FG-CH-PET-19": 188, "FG-CH-PET-25": 196, "FG-CH-PET-30": 204,
  "FG-CH-PET-36": 214, "FG-CH-PET-50": 232, "FG-CH-ALPET-33": 244, "FG-CH-ALPET-34": 248,
  "FG-CH-ALPET-40": 258, "FG-CH-ALPET-50": 272, "FG-CH-ALPET-60": 286,
  "FG-CH-ALPFT-34": 395, "FG-CH-ALPFT-50": 430, "FG-CH-NW-12": 168, "FG-CH-NW-15": 176,
  "FG-CH-NW-20": 186, "FG-CH-NW-B-07": 172, "FG-CH-NW-B-10": 180, "FG-CH-NW-B-15": 190,
  "FG-CH-NW-B-20": 205, "FG-CH-NW-F-05": 178, "FG-CH-NW-F-100": 192, "FG-CH-NW-F-125": 202,
  "FG-CH-FPP-10": 210, "FG-CH-FPP-125": 220, "FG-CH-FPP-15": 232, "FG-CH-FPP-20": 248,
  "FG-CH-LSZH-12": 288, "FG-CH-LSZH-20": 316, "FG-CH-FSZH-18": 425,
  "FG-CH-CT-15": 196, "FG-CH-CT-25": 208, "FG-CH-CT-35": 220,
  "FG-CH-PT-12-WHITE-COLOR": 214, "FG-CH-PT-12-GRAY-COLOR": 214,
  "FG-CH-PT-16-WHITE-COLOR": 226, "FG-CH-PT-16-GRAY-COLOR": 226,
  "FG-CH-RCT-15": 232, "FG-CH-RCT-20": 244, "FG-CH-RCT-30": 262,
  "FG-CH-RPST-13": 238, "FG-CH-RPST-16": 252, "FG-CH-BCT-20-SINGLE-SIDE": 226,
  "FG-CH-BCT-40-DOUBLE-SIDE": 248, "FG-CH-CUPET-50": 720,
  "FG-CH-PFT-25": 1180, "FG-CH-PFT-50": 1240, "FG-CH-PFT-75": 1310,
  "FG-CH-PFT-100": 1380, "FG-CH-PFT-125": 1450, "FG-CH-PFT-175": 1590,
  "FG-CH-PFGT-14": 356, "FG-CH-PFGT-16": 378,
  "FG-CH-PTFE-50": 1620, "FG-CH-PTFE-75": 1740, "FG-CH-PTFE-100": 1880,
};

/* ============================================================
   5. FINISHED-GOODS OPENING STOCK — Finished Goods Bay (WH-FG).
      56 of the 102 products we sell, across all three series.
      Total ≈ 5 665 kg, of which the sales orders below ship
      3 205 kg and one work order draws 250 kg off the shelf.

      IMPORTANT: a production stage never books stock IN (that is
      how this ERP is built), so a dispatch draws entirely on this
      opening stock. Every product on a dispatched order therefore
      carries at least the quantity that order ships.
   ============================================================ */
const FG_OPENING_DATE = "2026-06-01";
const FG_OPENING = [
  /* ---- mica series (16) ---- */
  ["FG-CP25G-08", 60], ["FG-CP25G-10", 50], ["FG-CP25G-11", 40], ["FG-CP25G-12", 760],
  ["FG-CP25G-14", 35], ["FG-CP25G-15", 30], ["FG-CM25G-08-10", 45], ["FG-CM25G-11-12", 40],
  ["FG-CM25G-13", 200], ["FG-CM25G-14", 55], ["FG-CCM25DG-125", 35], ["FG-CCM25GE-10", 30],
  ["FG-CCM25GE-13", 40], ["FG-CCM25GE-16", 25], ["FG-CP25GE-13", 30], ["FG-CP25GE-145", 25],
  /* ---- water-blocking series (22) ---- */
  ["FG-CHDNW-15-SINGLE-SIDE", 55], ["FG-CHDNW-20", 200], ["FG-CHDNW-25", 170],
  ["FG-CHDNW-30", 70], ["FG-CHDNW-50", 35], ["FG-CHDSW-25", 190], ["FG-CHDSW-30", 900],
  ["FG-CHDSW-40", 45], ["FG-CHDSW-45", 30], ["FG-CHDSW-50", 40], ["FG-CHCNW-12", 35],
  ["FG-CHCNW-15", 40], ["FG-CHCNW-20", 150], ["FG-CHN-12-TDM", 40], ["FG-CHN-20-TDM", 650],
  ["FG-CHN-20-WS", 35], ["FG-CHN-30-TDM", 30], ["FG-CHSCWWBT-18", 25], ["FG-CHSCWWBT-20", 30],
  ["FG-CHCWSCWBT-50", 20], ["FG-CHSMWBT-F-100", 25], ["FG-CHSMWBT-F-125", 20],
  /* ---- other tape series (18) ---- */
  ["FG-CH-PET-15", 150], ["FG-CH-PET-25", 300], ["FG-CH-PET-36", 45], ["FG-CH-PET-50", 35],
  ["FG-CH-ALPET-33", 120], ["FG-CH-ALPET-40", 160], ["FG-CH-ALPET-50", 35],
  ["FG-CH-ALPFT-34", 20], ["FG-CH-NW-15", 140], ["FG-CH-NW-B-10", 40], ["FG-CH-NW-F-100", 35],
  ["FG-CH-FPP-15", 45], ["FG-CH-LSZH-12", 30], ["FG-CH-FSZH-18", 25], ["FG-CH-CT-25", 40],
  ["FG-CH-PT-16-WHITE-COLOR", 35], ["FG-CH-RCT-20", 45], ["FG-CH-PFGT-16", 30],
];

/* ============================================================
   6. WORK ORDERS
      Route is NOT set here — the ERP decides it from the store,
      exactly as it does for a real job. What is chosen here is
      the product, the quantity, the tape width and how far the
      job is driven, by whom.

        fgQty: 0   → make it from raw material (do not take
                     finished rolls off the shelf)
        fgQty: null→ let the planner take finished stock, which
                     drops the route to Packing only
        advance    → how many stages to complete
      ============================================================ */
const WORK_ORDERS = [
  { key: "WO-DSW30", itemId: "FG-CHDSW-30", qty: 850, widthMM: 40, created: "2026-06-15",
    due: "2026-06-26", priority: "High", fgQty: 0,
    stages: [
      { day: "2026-06-16", by: "coating1", action: "start" },
      { day: "2026-06-18", by: "coating1", action: "complete" },
      { day: "2026-06-19", by: "slitting1", action: "start" },
      { day: "2026-06-20", by: "slitting1", action: "complete" },
      { day: "2026-06-22", by: "slitting1", action: "start" },
      { day: "2026-06-23", by: "slitting1", action: "complete" },
    ],
    note: "Gautam's line — full route, sold on SO-DSW30" },

  { key: "WO-CHN20", itemId: "FG-CHN-20-TDM", qty: 600, widthMM: 25, created: "2026-06-24",
    due: "2026-07-06", priority: "Normal", fgQty: 0,
    stages: [
      { day: "2026-06-25", by: "coating2", action: "start" },
      { day: "2026-06-27", by: "coating2", action: "complete" },
      { day: "2026-06-29", by: "slitting2", action: "start" },
      { day: "2026-06-30", by: "slitting2", action: "complete" },
      { day: "2026-07-01", by: "slitting2", action: "start" },
      { day: "2026-07-02", by: "slitting2", action: "complete" },
    ],
    note: "Ganesh's line — full route, sold on SO-CHN20" },

  { key: "WO-CP25G12", itemId: "FG-CP25G-12", qty: 700, widthMM: 20, created: "2026-07-01",
    due: "2026-07-10", priority: "High", fgQty: 0,
    stages: [
      { day: "2026-07-02", by: "slitting1", action: "start" },
      { day: "2026-07-03", by: "slitting1", action: "complete" },
      { day: "2026-07-04", by: "slitting1", action: "start" },
      { day: "2026-07-05", by: "slitting1", action: "complete" },
    ],
    note: "Mica tape is in the store, so the job starts at slitting — sold on SO-MICA" },

  { key: "WO-CWSC50", itemId: "FG-CHCWSCWBT-50", qty: 300, widthMM: 50, created: "2026-07-06",
    due: "2026-07-18", priority: "Normal", fgQty: 0, copperWires: 24,
    stages: [
      { day: "2026-07-07", by: "fiberglass", action: "start" },
      { day: "2026-07-09", by: "fiberglass", action: "complete" },
      { day: "2026-07-10", by: "coating2", action: "start" },
      { day: "2026-07-12", by: "coating2", action: "complete" },
      { day: "2026-07-13", by: "slitting1", action: "start" },
      { day: "2026-07-14", by: "slitting1", action: "complete" },
      { day: "2026-07-15", by: "slitting1", action: "start" },
      { day: "2026-07-16", by: "slitting1", action: "complete" },
    ],
    note: "Copper-woven tape — fibre-glass weaves the base, Ganesh coats it. Ready to sell." },

  { key: "WO-CM25G14", itemId: "FG-CM25G-14", qty: 450, widthMM: 30, created: "2026-07-13",
    due: "2026-07-22", priority: "Normal", fgQty: 0,
    stages: [
      { day: "2026-07-14", by: "slitting2", action: "start" },
      { day: "2026-07-15", by: "slitting2", action: "complete" },
      { day: "2026-07-16", by: "slitting2", action: "start" },
      { day: "2026-07-17", by: "slitting2", action: "complete" },
    ],
    note: "Muscovite mica — starts at slitting. Ready to sell." },

  { key: "WO-ALPET40", itemId: "FG-CH-ALPET-40", qty: 350, widthMM: 25, created: "2026-07-17",
    due: "2026-07-28", priority: "Normal", fgQty: 0,
    stages: [
      { day: "2026-07-18", by: "coating2", action: "start" },
      { day: "2026-07-20", by: "coating2", action: "complete" },
      { day: "2026-07-21", by: "slitting2", action: "start" },
      { day: "2026-07-22", by: "slitting2", action: "complete" },
      { day: "2026-07-23", by: "slitting2", action: "start" },
      { day: "2026-07-24", by: "slitting2", action: "complete" },
    ],
    note: "Aluminium-polyester laminate — full route. Ready to sell." },

  /* No tape width on this one ON PURPOSE. Finished stock is only matched to a
     width when the stock itself records one, and none of it does — asking for
     a width here would find no finished rolls and the job would have to be
     made from raw material that this bought-in product has none of. */
  { key: "WO-PET25", itemId: "FG-CH-PET-25", qty: 250, widthMM: null, created: "2026-07-21",
    due: "2026-07-27", priority: "Normal", fgQty: null,
    stages: [
      { day: "2026-07-22", by: "slitting1", action: "start" },
      { day: "2026-07-23", by: "slitting1", action: "complete" },
    ],
    note: "Covered in full by finished stock — the job is PACKING ONLY. Ready to sell." },

  /* ---- still running ---- */
  { key: "WO-CCM25GE13", itemId: "FG-CCM25GE-13", qty: 400, widthMM: 20, created: "2026-07-27",
    due: "2026-08-06", priority: "High", fgQty: 0,
    materialChoices: { 2: "RM-ADHESIVE-MOMENTIVE-595-NT" },
    stages: [
      { day: "2026-07-29", by: "coating2", action: "start" },
    ],
    note: "IN PRODUCTION — sitting on Ganesh's line right now" },

  { key: "WO-DNW30", itemId: "FG-CHDNW-30", qty: 500, widthMM: 35, created: "2026-07-25",
    due: "2026-08-04", priority: "Normal", fgQty: 0,
    stages: [
      { day: "2026-07-26", by: "coating1", action: "start" },
      { day: "2026-07-28", by: "coating1", action: "complete" },
      { day: "2026-07-30", by: "slitting1", action: "start" },
    ],
    note: "IN PRODUCTION — coating done, now on the slitting floor" },

  { key: "WO-DNW25", itemId: "FG-CHDNW-25", qty: 380, widthMM: 25, created: "2026-07-28",
    due: "2026-08-08", priority: "Normal", fgQty: 0,
    stages: [
      { day: "2026-07-30", by: "coating1", action: "start" },
    ],
    note: "IN PRODUCTION — sitting on Gautam's line right now, so both RM lines " +
          "and the slitting floor each have live work to show" },
];

/* ============================================================
   7. SALES ORDERS
      `batch` names the work order the line is claimed from, so a
      finished run is traceable straight through to the invoice.
      Dispatched orders post the outbound movement from WH-FG.
   ============================================================ */
const SALES_ORDERS = [
  { key: "SO-DSW30", customerId: "CUS-01", date: "2026-06-24", promised: "2026-07-04",
    priority: "High", dispatch: "2026-06-27", transporter: "TR-001",
    lines: [
      { itemId: "FG-CHDSW-30", qty: 850, batch: "WO-DSW30", width: 40, rate: 352 },
      { itemId: "FG-CHDNW-20", qty: 165, rate: 296 },
    ] },

  { key: "SO-CHN20", customerId: "CUS-02", date: "2026-07-03", promised: "2026-07-14",
    priority: "Normal", dispatch: "2026-07-07", transporter: "TR-003",
    lines: [
      { itemId: "FG-CHN-20-TDM", qty: 600, batch: "WO-CHN20", width: 25, rate: 336 },
      { itemId: "FG-CHCNW-20", qty: 125, rate: 278 },
      { itemId: "FG-CH-ALPET-33", qty: 95, rate: 244 },
    ] },

  { key: "SO-MICA", customerId: "CUS-03", date: "2026-07-06", promised: "2026-07-16",
    priority: "High", dispatch: "2026-07-09", transporter: "TR-005",
    lines: [
      { itemId: "FG-CP25G-12", qty: 700, batch: "WO-CP25G12", width: 20, rate: 745 },
      { itemId: "FG-CM25G-13", qty: 160, rate: 865 },
    ] },

  { key: "SO-MIXED", customerId: "CUS-05", date: "2026-07-19", promised: "2026-07-30",
    priority: "Normal", dispatch: "2026-07-24", transporter: "TR-002",
    lines: [
      { itemId: "FG-CHDSW-25", qty: 150, rate: 340 },
      { itemId: "FG-CHDNW-25", qty: 130, rate: 310 },
      { itemId: "FG-CH-PET-15", qty: 120, rate: 182 },
      { itemId: "FG-CH-NW-15", qty: 110, rate: 176 },
    ] },

  /* Confirmed but not yet dispatched — shows the open order book. */
  { key: "SO-OPEN", customerId: "CUS-04", date: "2026-07-28", promised: "2026-08-08",
    priority: "Normal", dispatch: null,
    lines: [
      { itemId: "FG-CM25G-14", qty: 450, batch: "WO-CM25G14", width: 30, rate: 890 },
      { itemId: "FG-CH-ALPET-40", qty: 160, rate: 258 },
    ] },
];

/* ============================================================
   8. LAB TEST CERTIFICATES — raised by the `lab` login against
      finished runs, so QC appears in the same chain.
   ============================================================ */
const LAB_REPORTS = [
  { woKey: "WO-DSW30", productCode: "CHDSW-30", date: "2026-06-23" },
  { woKey: "WO-CHN20", productCode: "CHN-20 TDM", date: "2026-07-02" },
  { woKey: "WO-CP25G12", productCode: "CP25G-12", date: "2026-07-05" },
  { woKey: "WO-CM25G14", productCode: "CM25G-14", date: "2026-07-17" },
];

module.exports = {
  TAG, NEW_SUPPLIERS, NEW_ITEMS, PURCHASE_ORDERS, OPEN_PURCHASE_ORDER,
  PRODUCTION_MATERIALS, PRODUCTION_PO, PRODUCTION_BUFFER,
  FG_PRICE, FG_OPENING, FG_OPENING_DATE, WORK_ORDERS, SALES_ORDERS, LAB_REPORTS,
};
