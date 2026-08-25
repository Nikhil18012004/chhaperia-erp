#!/usr/bin/env node
/* ============================================================
   CHHAPERIA ERP — temporary directory data (customers, suppliers,
   dispatch/transporters, workers)

     node tools/temp-directories.js load | status | verify | remove

   Adds 50 demonstration records to each of the four directories so
   the screens can be shown and tested with a realistic amount of
   data. Everything it writes is TEMPORARY and removable.

   HOW IT STAYS REMOVABLE

     1. Every record carries  _temp: "<TAG>"  — the same convention
        tools/temp-demo already uses.
     2. Every created id is written to data/temp-directories-manifest.json
        AS IT IS CREATED. Do not delete that file by hand.

     `remove` deletes only ids named in the manifest AND still
     carrying the tag. A record you have since edited into real data
     (tag removed) is left alone and reported, never silently dropped.

   Writes go through the ERP's own services, so the records are
   shaped exactly like hand-entered ones. Nothing here touches
   stock, orders, movements or money.

   The database credentials come from the environment, the same as
   every other tool here:
     CHHAPERIA_DB_HOST  _PORT  _USER  _PASSWORD  _NAME
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const erp = require(path.join(ROOT, "backend/src/services/erpService"));
const hr = require(path.join(ROOT, "backend/src/services/hrService"));
const repo = require(path.join(ROOT, "backend/src/db/repository"));
const { closeDb } = require(path.join(ROOT, "backend/src/db/connection"));

const TAG = "TEMP-DIR-2026-08-25";
const DATA_DIR = process.env.CHHAPERIA_DATA_DIR || path.join(ROOT, "data");
const MANIFEST = path.join(DATA_DIR, "temp-directories-manifest.json");
const N = 50;

/* ---------- deterministic helpers: same input, same output ---------- */
function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a += 0x6d2b79f5; a >>>= 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (r, arr) => arr[Math.floor(r() * arr.length) % arr.length];
const between = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
const LET = "ABCDEFGHJKLMNPQRSTUVWXYZ";
function pan(r) {
  let s = "";
  for (let i = 0; i < 5; i++) s += LET[Math.floor(r() * LET.length)];
  s += String(between(r, 1000, 9999));
  s += LET[Math.floor(r() * LET.length)];
  return s;
}
const gstin = (r, code) => code + pan(r) + "1Z" + LET[Math.floor(r() * LET.length)];
const phone = (r) => "+91 " + between(r, 70, 99) + between(r, 100, 999) + " " + String(between(r, 10000, 99999));
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 14);

/* GST state codes paired with their state and a plant town. */
const PLACES = [
  ["27", "Maharashtra", ["Pune", "Nashik", "Aurangabad", "Nagpur", "Thane"]],
  ["29", "Karnataka", ["Bengaluru", "Mysuru", "Hubballi", "Belagavi"]],
  ["33", "Tamil Nadu", ["Coimbatore", "Chennai", "Hosur", "Salem"]],
  ["24", "Gujarat", ["Vadodara", "Vapi", "Rajkot", "Surat"]],
  ["06", "Haryana", ["Faridabad", "Gurugram", "Panipat"]],
  ["07", "Delhi", ["New Delhi", "Narela"]],
  ["09", "Uttar Pradesh", ["Ghaziabad", "Kanpur", "Noida"]],
  ["19", "West Bengal", ["Kolkata", "Howrah", "Durgapur"]],
  ["36", "Telangana", ["Hyderabad", "Medak"]],
  ["32", "Kerala", ["Kochi", "Thrissur"]],
  ["03", "Punjab", ["Ludhiana", "Sangrur", "Mohali"]],
  ["08", "Rajasthan", ["Jaipur", "Bhiwadi", "Alwar"]],
  ["23", "Madhya Pradesh", ["Indore", "Pithampur"]],
  ["21", "Odisha", ["Cuttack", "Rourkela"]],
  ["05", "Uttarakhand", ["Haridwar", "Rudrapur"]],
  ["22", "Chhattisgarh", ["Raipur", "Bhilai"]],
];
const TERMS = ["30 days", "45 days", "60 days", "15 days", "Advance", "PDC 30 days"];
const GRADES = ["A", "A", "B", "B", "B", "C"];

/* ---------- names ---------- */
const CUSTOMER_NAMES = [
  "Sundaram Conductors Pvt Ltd", "Veenus Cables & Wires", "Anantha Power Cables",
  "Krishmi Electricals", "Deccan Wire Industries", "Marudhar Cab-Tech",
  "Suryodaya Cables Ltd", "Trimurti Conductors", "Nandini Elektrik",
  "Vaayu Power Systems", "Hariom Wire Udyog", "Sahyadri Cable Works",
  "Bhaskar Insulations", "Nilkanth Cab-Tech", "Raghav Power Products",
  "Ambika Wires Pvt Ltd", "Yashodhan Cables", "Pravin Conductor Co.",
  "Girnar Electricals", "Kaveri Cable Industries", "Shreeji Wire Products",
  "Tejas Power Cables", "Amrutha Elektro", "Balaji Conductors Ltd",
  "Vindhya Cable Corp", "Satyam Wire Mills", "Chetan Insulated Wires",
  "Prathama Power Cables", "Naveen Cab Industries", "Rudra Electricals",
  "Meghdoot Cables", "Saanvi Conductors", "Ojas Power Tech",
  "Vaibhav Wire Works", "Indraprastha Cables", "Konark Elektrik Ltd",
  "Panchal Wire Industries", "Hemadri Cable Co.", "Nirmal Power Conductors",
  "Arihant Cab-Tech", "Sparsh Electricals", "Bhoomi Wire Udyog",
  "Tapti Cable Industries", "Gokul Conductors", "Vasudha Power Cables",
];
const EXPORT_CUSTOMERS = [
  { name: "Emirates Cable Trading LLC", city: "Dubai", state: "Dubai", country: "United Arab Emirates", currency: "AED" },
  { name: "Lanka Wire Imports Pvt Ltd", city: "Colombo", state: "Western", country: "Sri Lanka", currency: "USD" },
  { name: "Mekong Cable Supply Co.", city: "Ho Chi Minh City", state: "Ho Chi Minh", country: "Vietnam", currency: "USD" },
  { name: "Nairobi Power Distributors Ltd", city: "Nairobi", state: "Nairobi", country: "Kenya", currency: "USD" },
  { name: "Dhaka Conductors Ltd", city: "Dhaka", state: "Dhaka", country: "Bangladesh", currency: "USD" },
];
const SEGMENTS = ["LV/HT Cables", "Control Cables", "Instrumentation Cables", "Solar Cables",
  "Fire Survival Cables", "Telecom Cables", "Submarine & Special", "Building Wire"];

const SUPPLIERS = [
  ["Prabhat Technofab", "Fabric"], ["Shreenath Nonwovens", "Fabric"], ["Vardhman Polyweaves", "Fabric"],
  ["Suraj Textile Mills", "Fabric"], ["Rachana Weaving Works", "Fabric"], ["Cosmos Glass Fabrics", "Fabric"],
  ["Himgiri Mica Products", "Mica"], ["Kanchan Mica Industries", "Mica"], ["Bharat Phlogopite Co.", "Mica"],
  ["Ashwini Muscovite Traders", "Mica"], ["Vikram Chemicals Ltd", "Chemical"], ["Sanjivani Polymers", "Chemical"],
  ["Kalyani Speciality Chem", "Chemical"], ["Nutan Organics", "Chemical"], ["Sanmati Peroxides", "Chemical"],
  ["Vishwas Latex Products", "Chemical"], ["Anand PVA Suppliers", "Chemical"], ["Jyoti Binder Solutions", "Chemical"],
  ["Ultra TPU Polymers", "Chemical"], ["Bitumen Traders India", "Chemical"], ["Aroma Solvents Pvt Ltd", "Solvent"],
  ["Deepak Solvent Traders", "Solvent"], ["Ganesh Methanol Traders", "Solvent"], ["Ravi Toluene Agencies", "Solvent"],
  ["Precision MEK Suppliers", "Solvent"], ["Manor Adhesives", "Adhesive"], ["Bandhan Bonding Agents", "Adhesive"],
  ["Silcon Silicone Systems", "Adhesive"], ["Kalpataru Carbon Black", "Carbon"], ["Agni Carbon Industries", "Carbon"],
  ["Neelkanth Conductive Paste", "Carbon"], ["Hydrogel Superabsorbents", "SAP"], ["Aqualock Polymers", "SAP"],
  ["Swastik SAP Traders", "SAP"], ["Polyfilm India Pvt Ltd", "Film"], ["Surabhi Polyester Films", "Film"],
  ["Zenith PTFE Products", "Film"], ["Deccan Polyimide Traders", "Film"], ["Tirupati Yarn Agencies", "Yarn"],
  ["Sagar Polyester Yarn", "Yarn"], ["Ganga Packaging Works", "Packaging"], ["Shubh Corrugators", "Packaging"],
  ["Om Pallet Industries", "Packaging"], ["Metro Aluminium Foils", "Metal"], ["Sterling Copper Wires", "Metal"],
  ["Talc Minerals Corp", "Mineral"], ["Rajhans Talc & Fillers", "Mineral"], ["Fireguard ATH Minerals", "Mineral"],
  ["Bright Hydroxide Co.", "Mineral"], ["Nishant Ink & Coatings", "Ink"],
];

const TRANSPORTERS = [
  "Sharma Roadlines", "Konkan Carriers", "Deccan Freight Movers", "Bharat Cargo Express",
  "Vijay Transport Co.", "Sai Krupa Logistics", "Nandan Roadways", "Sagar Transport Service",
  "Annapurna Carriers", "Highway Cargo Movers", "Prime Freight Systems", "Yash Logistics",
  "Mahalaxmi Roadlines", "Sundar Transport Agency", "Vaishnavi Cargo", "Balaji Freight Lines",
  "Ekta Transport Corp", "Rathore Carriers", "Ganesh Roadways", "Silver Line Logistics",
  "Nataraj Transport", "Sri Venkatesh Cargo", "Trans India Movers", "Shakti Freight Carriers",
  "Om Sai Roadlines", "Bhagyalaxmi Transport", "Pioneer Cargo Systems", "Jai Bharat Carriers",
  "Coastal Freight Movers", "Narmada Roadlines", "Kaveri Transport Service", "Sunrise Logistics",
  "Ashoka Cargo Carriers", "Milan Transport Co.", "Vishal Roadways", "Sneha Freight Agency",
  "Krishna Cargo Lines", "Patel Transport Service", "Gateway Logistics India", "Ramdev Roadlines",
  "Sharda Cargo Movers", "Nakoda Transport", "Blue Dart Roadlines Pvt", "Suvidha Freight Systems",
  "Anand Carriers & Movers", "Shri Ram Transport Co.", "Trinity Cargo Express", "Vayu Logistics",
  "Chetak Roadlines", "Sampark Freight Carriers",
];
const VEHICLES = ["32 ft SXL", "32 ft MXL", "24 ft Container", "20 ft Container", "17 ft Truck",
  "14 ft Tempo", "Tata Ace", "Trailer 40 ft", "Reefer"];
const RATE_BASIS = ["KG", "TON", "TRIP", "KM", "BOX"];

const WORKER_FIRST = ["Ramesh", "Suresh", "Mahesh", "Ganesh", "Prakash", "Vinod", "Anil", "Sunil",
  "Rajesh", "Mukesh", "Deepak", "Sanjay", "Manoj", "Ashok", "Vikas", "Pankaj", "Ravi", "Kiran",
  "Naveen", "Basavaraj", "Shivanand", "Mallesh", "Nagaraj", "Praveen", "Santosh", "Girish",
  "Lakshmi", "Savitha", "Rekha", "Kavitha", "Shobha", "Geetha", "Sunita", "Pushpa", "Renuka",
  "Mamatha", "Yallappa", "Hanumanth", "Sharanappa", "Basappa", "Irfan", "Imran", "Salim",
  "Abdul", "Farooq", "Joseph", "Thomas", "Antony", "David", "Peter"];
const WORKER_LAST = ["Kumar", "Naik", "Patil", "Shetty", "Gowda", "Rao", "Hegde", "Reddy", "Sharma",
  "Verma", "Yadav", "Singh", "Desai", "Kulkarni", "Joshi", "Pawar", "Jadhav", "Bhat", "Nayak",
  "Prasad", "Murthy", "Iyer", "Menon", "Pillai", "Khan"];
const DESIGNATIONS = {
  coating: ["Machine Operator", "Coating Helper", "Mixing Operator", "Line Supervisor", "Coating Assistant"],
  slitting: ["Slitting Operator", "Rewinder Operator", "Packing Helper", "Slitting Helper"],
  fiberglass: ["Weaving Operator", "Fibre-Glass Helper", "Loom Attendant", "Sizing Operator"],
  packing: ["Packing & QC", "Carton Packer", "Dispatch Helper", "Weighment Clerk"],
  admin: ["Store Keeper", "Accounts Assistant", "HR Assistant", "Security Guard", "Data Entry Operator"],
  maintenance: ["Electrician", "Fitter", "Boiler Operator", "Maintenance Helper"],
};
const DEPTS = Object.keys(DESIGNATIONS);
const SHIFTS = ["General", "General", "General", "A Shift", "B Shift", "C Shift"];
const BANKS = ["SBIN0001234", "HDFC0000456", "ICIC0000789", "KARB0000321", "CNRB0002468", "UBIN0801234"];

/* ---------- record builders ---------- */
function buildCustomers(ids) {
  const r = rng(1001);
  return ids.map((id, i) => {
    if (i >= CUSTOMER_NAMES.length) {
      const x = EXPORT_CUSTOMERS[i - CUSTOMER_NAMES.length];
      return {
        id, name: x.name, segment: pick(r, SEGMENTS), gst: "", stateCode: "", state: x.state,
        address: between(r, 1, 90) + " Industrial Road, " + x.city, shipTo: "",
        city: x.city, country: x.country, currency: x.currency, rating: pick(r, GRADES),
        contact: pick(r, ["Export Desk", "Purchase Head", "Mr. K. Lee", "Ms. A. Rahman", "Procurement"]),
        phone: "+" + between(r, 60, 971) + " " + between(r, 100, 999) + " " + between(r, 100000, 999999),
        email: "purchase@" + slug(x.name) + ".com", terms: pick(r, ["Advance", "LC 60 days", "LC 90 days", "30 days"]),
        since: String(between(r, 2018, 2025)), _temp: TAG,
      };
    }
    const [code, state, towns] = pick(r, PLACES);
    const city = pick(r, towns);
    const name = CUSTOMER_NAMES[i];
    return {
      id, name, segment: pick(r, SEGMENTS), gst: gstin(r, code), stateCode: code, state,
      address: "Plot " + between(r, 1, 220) + ", " + pick(r, ["MIDC", "KIADB", "SIPCOT", "GIDC", "HSIIDC", "RIICO"]) +
        " Industrial Area, " + city,
      shipTo: "", city: city + ", " + state, country: "India", currency: "INR",
      rating: pick(r, GRADES),
      contact: pick(r, WORKER_FIRST) + " " + pick(r, WORKER_LAST),
      phone: phone(r), email: "purchase@" + slug(name) + ".co.in",
      terms: pick(r, TERMS), since: String(between(r, 2016, 2025)), _temp: TAG,
    };
  });
}

function buildSuppliers(ids) {
  const r = rng(2002);
  return ids.map((id, i) => {
    const [name, category] = SUPPLIERS[i];
    const [code, state, towns] = pick(r, PLACES);
    const city = pick(r, towns);
    return {
      id, name, category, gst: gstin(r, code), stateCode: code, state,
      address: pick(r, ["Unit", "Shed", "Plot", "Godown"]) + " " + between(r, 1, 140) + ", " + city,
      city: city + ", " + state, country: "India",
      contact: pick(r, WORKER_FIRST) + " " + pick(r, WORKER_LAST),
      phone: phone(r), email: "sales@" + slug(name) + ".co.in",
      terms: pick(r, TERMS), rating: between(r, 3, 5), onTime: between(r, 78, 99),
      lead: between(r, 5, 35), _temp: TAG,
    };
  });
}

function buildTransporters(ids) {
  const r = rng(3003);
  return ids.map((id, i) => {
    const name = TRANSPORTERS[i];
    const [code, state, towns] = pick(r, PLACES);
    const city = pick(r, towns);
    const from = pick(r, ["Bengaluru", "Hyderabad", "Chennai", "Pune", "Mumbai"]);
    const to = pick(r, ["Delhi NCR", "Kolkata", "Ahmedabad", "Coimbatore", "Ludhiana", "Nagpur", "Kochi"]);
    const basis = pick(r, RATE_BASIS);
    const nv = between(r, 1, 3);
    const vt = [];
    for (let k = 0; k < nv; k++) { const v = pick(r, VEHICLES); if (!vt.includes(v)) vt.push(v); }
    return {
      id, name, contact: pick(r, WORKER_FIRST) + " " + pick(r, WORKER_LAST),
      phone: phone(r), email: "booking@" + slug(name) + ".co.in",
      city, state, gstin: gstin(r, code), pan: pan(r),
      vehicleTypes: vt, routes: from + " - " + to,
      rateBasis: basis,
      baseRate: basis === "TRIP" ? between(r, 14000, 46000) : basis === "TON" ? between(r, 1800, 4200)
        : basis === "KM" ? between(r, 28, 62) : basis === "BOX" ? between(r, 90, 260) : between(r, 6, 22),
      onTime: between(r, 74, 99), rating: pick(r, GRADES),
      owner: pick(r, ["Dispatch", "Stores", "Sales", "Plant"]),
      terms: pick(r, ["MONTHLY", "15 days", "30 days", "To Pay", "Paid"]),
      active: r() > 0.12, notes: "", _temp: TAG,
    };
  });
}

function buildWorkers(ids, deviceStart) {
  const r = rng(4004);
  const used = new Set();
  return ids.map((id, i) => {
    let name;
    do { name = pick(r, WORKER_FIRST) + " " + pick(r, WORKER_LAST); } while (used.has(name));
    used.add(name);
    const dept = DEPTS[i % DEPTS.length];
    const designation = pick(r, DESIGNATIONS[dept]);
    const monthly = /Supervisor|Assistant|Keeper|Clerk|Operator$/.test(designation) && r() > 0.72;
    const y = between(r, 2019, 2025);
    return {
      id, name, dept, designation,
      payType: monthly ? "monthly" : "daily",
      dailyRate: monthly ? 0 : between(r, 480, 860),
      monthlyCtc: monthly ? between(r, 18, 46) * 1000 : 0,
      deviceUid: String(deviceStart + i),
      phone: String(between(r, 70, 99)) + String(between(r, 10000000, 99999999)),
      joined: y + "-" + String(between(r, 1, 12)).padStart(2, "0") + "-" + String(between(r, 1, 28)).padStart(2, "0"),
      pfNo: "KN/BNG/" + between(r, 10000, 99999) + "/" + String(between(r, 1, 999)).padStart(3, "0"),
      esiNo: String(between(r, 3100000000, 3199999999)),
      bankAcc: String(between(r, 1000000000, 9999999999)) + String(between(r, 10, 99)),
      bankIfsc: pick(r, BANKS),
      active: r() > 0.08, shift: pick(r, SHIFTS), _temp: TAG,
    };
  });
}

/* ---------- id allocation ---------- */
function seq(existingIds, prefix, count) {
  // Only ids that match "<prefix><digits>" define the sequence. Foreign-looking
  // ids (the transporter directory holds GSTINs and vehicle numbers as ids)
  // must not drag the counter to five digits.
  const re = new RegExp("^" + prefix.replace(/[-[\]{}()*+?.,\\^$|#]/g, "\\$&") + "(\\d+)$");
  let max = 0, width = 3;
  existingIds.forEach((id) => {
    const m = re.exec(String(id || ""));
    if (m) { max = Math.max(max, +m[1]); width = Math.max(width, m[1].length); }
  });
  const taken = new Set(existingIds.map(String));
  const out = [];
  let n = max;
  while (out.length < count) {
    n++;
    const id = prefix + String(n).padStart(width, "0");
    if (!taken.has(id)) out.push(id);
  }
  return out;
}

/* ---------- manifest ---------- */
const emptyManifest = () => ({ tag: TAG, created: null, ids: { customers: [], suppliers: [], transporters: [], hrWorkers: [] } });
function readManifest() {
  try { return JSON.parse(fs.readFileSync(MANIFEST, "utf8")); } catch (e) { return emptyManifest(); }
}
function writeManifest(m) {
  fs.mkdirSync(path.dirname(MANIFEST), { recursive: true });
  fs.writeFileSync(MANIFEST, JSON.stringify(m, null, 2));
}

/* ---------- commands ---------- */
async function load() {
  const m = readManifest();
  const already = Object.values(m.ids).reduce((a, v) => a + v.length, 0);
  if (already) {
    console.log("A temp directory set is already loaded (" + already + " records, " + m.created + ").");
    console.log("Run `node tools/temp-directories.js remove` first, or `status` to see it.");
    return 1;
  }

  const st = await repo.getState();
  const ids = {
    customers: seq((st.customers || []).map((x) => x.id), "CUS-", N),
    suppliers: seq((st.suppliers || []).map((x) => x.id), "SUP-", N),
    transporters: seq((st.transporters || []).map((x) => x.id), "TR-", N),
    hrWorkers: seq((st.hrWorkers || []).map((x) => x.id), "EMP-", N),
  };

  // biometric device ids must be unique across ALL workers, not just ours
  const usedDev = new Set((st.hrWorkers || []).map((w) => String(w.deviceUid || "")));
  let devStart = 2001;
  while (ids.hrWorkers.some((_, i) => usedDev.has(String(devStart + i)))) devStart += 100;

  const sets = {
    customers: buildCustomers(ids.customers),
    suppliers: buildSuppliers(ids.suppliers),
    transporters: buildTransporters(ids.transporters),
    hrWorkers: buildWorkers(ids.hrWorkers, devStart),
  };

  m.created = new Date().toISOString();
  const create = {
    customers: (rec) => erp.upsertCustomer(rec),
    suppliers: (rec) => erp.createSupplier(rec),
    transporters: (rec) => erp.createTransporter(rec),
    hrWorkers: (rec) => hr.createWorker(rec),
  };

  for (const key of ["customers", "suppliers", "transporters", "hrWorkers"]) {
    for (const rec of sets[key]) {
      await create[key](rec);
      m.ids[key].push(rec.id);          // record as created, never by diffing
      writeManifest(m);
    }
    console.log("  " + key.padEnd(13) + " +" + m.ids[key].length);
  }
  console.log("\nLoaded " + Object.values(m.ids).reduce((a, v) => a + v.length, 0) +
    " temporary records, tagged " + TAG + ".");
  console.log("Manifest: " + path.relative(ROOT, MANIFEST));
  console.log("Remove them with: node tools/temp-directories.js remove");
  return 0;
}

async function inspect() {
  const m = readManifest();
  const st = await repo.getState();
  const live = { customers: st.customers, suppliers: st.suppliers, transporters: st.transporters, hrWorkers: st.hrWorkers };
  const report = {};
  for (const key of Object.keys(m.ids)) {
    const byId = new Map((live[key] || []).map((x) => [x.id, x]));
    let present = 0, edited = 0, gone = 0;
    m.ids[key].forEach((id) => {
      const rec = byId.get(id);
      if (!rec) gone++;
      else if (rec._temp === TAG) present++;
      else edited++;
    });
    report[key] = { total: (live[key] || []).length, mine: m.ids[key].length, present, edited, gone };
  }
  return { m, report };
}

async function status() {
  const { m, report } = await inspect();
  if (!m.created) { console.log("No temporary directory set is loaded."); return 0; }
  console.log("Tag " + m.tag + "  loaded " + m.created + "\n");
  console.log("  directory      in ERP   mine   removable   edited   already gone");
  for (const [k, v] of Object.entries(report)) {
    console.log("  " + k.padEnd(13) + String(v.total).padStart(6) + String(v.mine).padStart(7) +
      String(v.present).padStart(12) + String(v.edited).padStart(9) + String(v.gone).padStart(15));
  }
  const edited = Object.values(report).reduce((a, v) => a + v.edited, 0);
  if (edited) console.log("\n" + edited + " record(s) no longer carry the tag — `remove` will LEAVE THEM ALONE.");
  return 0;
}

async function remove() {
  const { m, report } = await inspect();
  if (!m.created) { console.log("Nothing to remove — no manifest."); return 0; }
  const st = await repo.getState();
  const live = { customers: st.customers, suppliers: st.suppliers, transporters: st.transporters, hrWorkers: st.hrWorkers };
  const del = {
    customers: (id) => erp.deleteCustomer(id),
    suppliers: (id) => erp.deleteSupplier(id),
    transporters: (id) => erp.deleteTransporter(id),
    hrWorkers: (id) => hr.deleteWorker(id),
  };
  const kept = [];
  let removed = 0;

  for (const key of ["hrWorkers", "transporters", "suppliers", "customers"]) {
    const byId = new Map((live[key] || []).map((x) => [x.id, x]));
    const remaining = [];
    for (const id of m.ids[key]) {
      const rec = byId.get(id);
      if (!rec) continue;                                  // already gone
      if (rec._temp !== TAG) { kept.push(key + " " + id + " (tag removed - treated as real)"); remaining.push(id); continue; }
      try { await del[key](id); removed++; }
      catch (e) { kept.push(key + " " + id + ": " + e.message); remaining.push(id); }
    }
    m.ids[key] = remaining;
    writeManifest(m);
  }

  const left = Object.values(m.ids).reduce((a, v) => a + v.length, 0);
  console.log("Removed " + removed + " temporary record(s).");
  if (kept.length) {
    console.log("\nLeft in place (" + kept.length + "):");
    kept.forEach((k) => console.log("  - " + k));
    console.log("\nThe manifest keeps these so a later `remove` can retry.");
  }
  if (!left) { try { fs.unlinkSync(MANIFEST); } catch (e) {} console.log("\nManifest cleared - nothing of this set is left."); }
  return 0;
}

async function verify() {
  const { report } = await inspect();
  let bad = 0;
  for (const [k, v] of Object.entries(report)) {
    const ok = v.present === v.mine;
    if (!ok) bad++;
    console.log((ok ? "  ok   " : "  FAIL ") + k.padEnd(13) + v.present + "/" + v.mine + " present and tagged");
  }
  console.log(bad ? "\n" + bad + " directory(ies) differ from the manifest." : "\nAll manifest records are present and tagged.");
  return bad ? 1 : 0;
}

/* ---------- main ---------- */
const CMD = { load, status, remove, verify };
(async () => {
  const cmd = (process.argv[2] || "").toLowerCase();
  if (!CMD[cmd]) {
    console.log("usage: node tools/temp-directories.js load | status | verify | remove");
    process.exit(2);
  }
  let code = 0;
  try { code = await CMD[cmd](); }
  catch (e) { console.error("\n" + cmd + " failed: " + e.message); code = 1; }
  finally { try { await closeDb(); } catch (e) {} }
  process.exit(code);
})();
