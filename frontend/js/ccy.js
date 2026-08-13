/* ============================================================
   CHHAPERIA ERP — COUNTRIES, CURRENCIES AND THEIR LIVE RATES

   One question this answers: "the client is in <country>, so what
   money does their invoice get raised in?" The sales desk types
   the country on the customer master; the currency follows from
   this table and rides along onto the sales order and the
   commercial invoice.

   ---- The rule the country table follows --------------------
   Each country maps to the currency you would ACTUALLY INVOICE
   IN, which is not always the one on the banknotes. Dollarised
   economies (Ecuador, El Salvador, Panama, Timor-Leste,
   Zimbabwe) map to USD, because that is what the contract and
   the letter of credit are written in. Everything else is the
   country's own ISO-4217 currency.

   The derived currency is a DEFAULT, never a lock: the customer
   form leaves it editable, because a Nigerian or Vietnamese
   buyer very often settles an export in USD or EUR regardless of
   what is legal tender at home.

   ---- Rates ------------------------------------------------
   rate() asks the server's /api/fx/pair, which is Google
   Finance and nothing else — see backend/src/services/fxService.js
   for why there is deliberately no second source. A pair Google
   cannot quote resolves to null and the caller shows "—"; it
   never falls back to another provider or to a derived cross.

   Shared, dependency-free, and require()-able by the backend
   tests — same UMD wrapper as gst.js and bomcalc.js.
   ============================================================ */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.CCY = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ---- currency names + the symbol we print on a document -------------------
     Gulf and other Arabic-script currencies use their common Latin symbols
     (Dh, SR, KD …): the native RTL glyphs (د.إ) reorder unpredictably inside a
     Latin label. Where a currency has no symbol that is actually written in
     Latin script the symbol is left blank on purpose — the three-letter code
     stands on its own rather than carrying something invented. */
  var META = {
    // ---- the majors and the ones this office already trades in ----
    INR: ["Indian Rupee", "₹"],            USD: ["US Dollar", "$"],
    EUR: ["Euro", "€"],                    GBP: ["British Pound", "£"],
    AED: ["UAE Dirham", "Dh"],             SAR: ["Saudi Riyal", "SR"],
    JPY: ["Japanese Yen", "¥"],            CNY: ["Chinese Yuan", "CN¥"],
    SGD: ["Singapore Dollar", "S$"],       AUD: ["Australian Dollar", "A$"],
    CAD: ["Canadian Dollar", "C$"],        CHF: ["Swiss Franc", "Fr"],
    HKD: ["Hong Kong Dollar", "HK$"],      NZD: ["New Zealand Dollar", "NZ$"],
    SEK: ["Swedish Krona", "kr"],          NOK: ["Norwegian Krone", "kr"],
    DKK: ["Danish Krone", "kr"],           ZAR: ["South African Rand", "R"],
    THB: ["Thai Baht", "฿"],               MYR: ["Malaysian Ringgit", "RM"],
    IDR: ["Indonesian Rupiah", "Rp"],      PHP: ["Philippine Peso", "₱"],
    KRW: ["South Korean Won", "₩"],        TRY: ["Turkish Lira", "₺"],
    RUB: ["Russian Ruble", "₽"],           BRL: ["Brazilian Real", "R$"],
    MXN: ["Mexican Peso", "Mex$"],         PLN: ["Polish Zloty", "zł"],
    CZK: ["Czech Koruna", "Kč"],           HUF: ["Hungarian Forint", "Ft"],
    ILS: ["Israeli Shekel", "₪"],          KWD: ["Kuwaiti Dinar", "KD"],
    BHD: ["Bahraini Dinar", "BD"],         OMR: ["Omani Rial", "RO"],
    QAR: ["Qatari Riyal", "QR"],           LKR: ["Sri Lankan Rupee", "Rs"],
    BDT: ["Bangladeshi Taka", "৳"],        NPR: ["Nepalese Rupee", "रू"],
    PKR: ["Pakistani Rupee", "₨"],         EGP: ["Egyptian Pound", "E£"],
    VND: ["Vietnamese Dong", "₫"],         TWD: ["Taiwan Dollar", "NT$"],
    // ---- everywhere else a client could be ----
    AFN: ["Afghan Afghani", "Af"],         ALL: ["Albanian Lek", "L"],
    AMD: ["Armenian Dram", "֏"],           AOA: ["Angolan Kwanza", "Kz"],
    ARS: ["Argentine Peso", "AR$"],        AWG: ["Aruban Florin", "Afl"],
    AZN: ["Azerbaijani Manat", "₼"],       BAM: ["Bosnian Convertible Mark", "KM"],
    BBD: ["Barbadian Dollar", "Bds$"],
    // No country maps to BGN any more (Bulgaria took the euro on 1 Jan 2026);
    // it stays so an older customer record still saying BGN still renders.
    BGN: ["Bulgarian Lev", "лв"],
    BIF: ["Burundian Franc", "FBu"],       BMD: ["Bermudian Dollar", "BD$"],
    BND: ["Brunei Dollar", "BN$"],         BOB: ["Bolivian Boliviano", "Bs"],
    BSD: ["Bahamian Dollar", "B$"],        BTN: ["Bhutanese Ngultrum", "Nu"],
    BWP: ["Botswana Pula", "P"],           BYN: ["Belarusian Ruble", "Rbl"],
    BZD: ["Belize Dollar", "BZ$"],         CDF: ["Congolese Franc", "FC"],
    CLP: ["Chilean Peso", "CL$"],          COP: ["Colombian Peso", "CO$"],
    CRC: ["Costa Rican Colon", "₡"],       CUP: ["Cuban Peso", "CU$"],
    CVE: ["Cape Verdean Escudo", "Esc"],   DJF: ["Djiboutian Franc", "Fdj"],
    DOP: ["Dominican Peso", "RD$"],        DZD: ["Algerian Dinar", "DA"],
    ERN: ["Eritrean Nakfa", "Nfk"],        ETB: ["Ethiopian Birr", "Br"],
    FJD: ["Fijian Dollar", "FJ$"],         GEL: ["Georgian Lari", "₾"],
    GHS: ["Ghanaian Cedi", "₵"],           GMD: ["Gambian Dalasi", "D"],
    GNF: ["Guinean Franc", "FG"],          GTQ: ["Guatemalan Quetzal", "Q"],
    GYD: ["Guyanese Dollar", "GY$"],       HNL: ["Honduran Lempira", "L"],
    HTG: ["Haitian Gourde", "G"],          IQD: ["Iraqi Dinar", "ID"],
    IRR: ["Iranian Rial", ""],             ISK: ["Icelandic Krona", "kr"],
    JMD: ["Jamaican Dollar", "J$"],        JOD: ["Jordanian Dinar", "JD"],
    KES: ["Kenyan Shilling", "KSh"],       KGS: ["Kyrgyzstani Som", ""],
    KHR: ["Cambodian Riel", "៛"],          KMF: ["Comorian Franc", "CF"],
    KYD: ["Cayman Islands Dollar", "CI$"], KZT: ["Kazakhstani Tenge", "₸"],
    LAK: ["Lao Kip", "₭"],                 LBP: ["Lebanese Pound", "L£"],
    LRD: ["Liberian Dollar", "L$"],        LSL: ["Lesotho Loti", "L"],
    LYD: ["Libyan Dinar", "LD"],           MAD: ["Moroccan Dirham", "DH"],
    MDL: ["Moldovan Leu", "L"],            MGA: ["Malagasy Ariary", "Ar"],
    MKD: ["Macedonian Denar", "den"],      MMK: ["Myanmar Kyat", "K"],
    MNT: ["Mongolian Tugrik", "₮"],        MOP: ["Macanese Pataca", "MOP$"],
    MRU: ["Mauritanian Ouguiya", "UM"],    MUR: ["Mauritian Rupee", "Rs"],
    MVR: ["Maldivian Rufiyaa", "Rf"],      MWK: ["Malawian Kwacha", "MK"],
    MZN: ["Mozambican Metical", "MT"],     NAD: ["Namibian Dollar", "N$"],
    NGN: ["Nigerian Naira", "₦"],          NIO: ["Nicaraguan Cordoba", "C$"],
    PEN: ["Peruvian Sol", "S/"],           PGK: ["Papua New Guinean Kina", "K"],
    PYG: ["Paraguayan Guarani", "₲"],      RON: ["Romanian Leu", "lei"],
    RSD: ["Serbian Dinar", "din"],         RWF: ["Rwandan Franc", "FRw"],
    SBD: ["Solomon Islands Dollar", "SI$"],SCR: ["Seychellois Rupee", ""],
    SDG: ["Sudanese Pound", ""],           SLE: ["Sierra Leonean Leone", "Le"],
    SOS: ["Somali Shilling", "Sh"],        SRD: ["Surinamese Dollar", "SR$"],
    SSP: ["South Sudanese Pound", ""],     STN: ["Sao Tome Dobra", "Db"],
    SYP: ["Syrian Pound", "S£"],           SZL: ["Eswatini Lilangeni", "E"],
    TJS: ["Tajikistani Somoni", "SM"],     TMT: ["Turkmenistani Manat", "m"],
    TND: ["Tunisian Dinar", "DT"],         TOP: ["Tongan Pa'anga", "T$"],
    TTD: ["Trinidad & Tobago Dollar", "TT$"], TZS: ["Tanzanian Shilling", "TSh"],
    UAH: ["Ukrainian Hryvnia", "₴"],       UGX: ["Ugandan Shilling", "USh"],
    UYU: ["Uruguayan Peso", "$U"],         UZS: ["Uzbekistani Som", ""],
    VES: ["Venezuelan Bolivar", "Bs.S"],   VUV: ["Vanuatu Vatu", "VT"],
    WST: ["Samoan Tala", "WS$"],           XAF: ["Central African CFA Franc", "FCFA"],
    XCD: ["East Caribbean Dollar", "EC$"], XOF: ["West African CFA Franc", "CFA"],
    XPF: ["CFP Franc", "₣"],               YER: ["Yemeni Rial", "YR"],
    ZMW: ["Zambian Kwacha", "ZK"],
  };

  /* The set the dashboard's From/To pickers offer. It is a deliberate SUBSET of
     META: those are the currencies the office actually converts between, and
     listing all 130 would bury them. The customer master is the opposite case —
     it offers every currency, because a client can be anywhere. */
  var CONVERTER_CODES = [
    "INR", "USD", "EUR", "GBP", "AED", "SAR", "JPY", "CNY", "SGD", "AUD",
    "CAD", "CHF", "HKD", "NZD", "SEK", "NOK", "DKK", "ZAR", "THB", "MYR",
    "IDR", "PHP", "KRW", "TRY", "RUB", "BRL", "MXN", "PLN", "CZK", "HUF",
    "ILS", "KWD", "BHD", "OMR", "QAR", "LKR", "BDT", "NPR", "PKR", "EGP",
    "VND", "TWD",
  ];

  /* ---- country -> currency, [name, ISO-3166 alpha-2, ISO-4217] --------------
     Grouped the way a sales desk thinks about its markets, not alphabetically;
     the pickers sort by name at render time. */
  var LIST = [
    // South & Central Asia
    ["India", "IN", "INR"], ["Pakistan", "PK", "PKR"], ["Bangladesh", "BD", "BDT"],
    ["Sri Lanka", "LK", "LKR"], ["Nepal", "NP", "NPR"], ["Bhutan", "BT", "BTN"],
    ["Maldives", "MV", "MVR"], ["Afghanistan", "AF", "AFN"],
    ["Kazakhstan", "KZ", "KZT"], ["Kyrgyzstan", "KG", "KGS"],
    ["Tajikistan", "TJ", "TJS"], ["Turkmenistan", "TM", "TMT"],
    ["Uzbekistan", "UZ", "UZS"], ["Mongolia", "MN", "MNT"],
    // East & South-East Asia
    ["China", "CN", "CNY"], ["Hong Kong", "HK", "HKD"], ["Macau", "MO", "MOP"],
    ["Taiwan", "TW", "TWD"], ["Japan", "JP", "JPY"], ["South Korea", "KR", "KRW"],
    ["Singapore", "SG", "SGD"], ["Malaysia", "MY", "MYR"], ["Thailand", "TH", "THB"],
    ["Vietnam", "VN", "VND"], ["Indonesia", "ID", "IDR"], ["Philippines", "PH", "PHP"],
    ["Cambodia", "KH", "KHR"], ["Laos", "LA", "LAK"], ["Myanmar", "MM", "MMK"],
    ["Brunei", "BN", "BND"],
    ["Timor-Leste", "TL", "USD"],          // dollarised
    // Middle East
    ["United Arab Emirates", "AE", "AED"], ["Saudi Arabia", "SA", "SAR"],
    ["Qatar", "QA", "QAR"], ["Kuwait", "KW", "KWD"], ["Bahrain", "BH", "BHD"],
    ["Oman", "OM", "OMR"], ["Yemen", "YE", "YER"], ["Jordan", "JO", "JOD"],
    ["Lebanon", "LB", "LBP"], ["Israel", "IL", "ILS"], ["Iraq", "IQ", "IQD"],
    ["Iran", "IR", "IRR"], ["Syria", "SY", "SYP"], ["Turkiye", "TR", "TRY"],
    // Europe — the euro area (Bulgaria joined on 1 January 2026)
    ["Austria", "AT", "EUR"], ["Belgium", "BE", "EUR"], ["Bulgaria", "BG", "EUR"],
    ["Croatia", "HR", "EUR"], ["Cyprus", "CY", "EUR"], ["Estonia", "EE", "EUR"],
    ["Finland", "FI", "EUR"], ["France", "FR", "EUR"], ["Germany", "DE", "EUR"],
    ["Greece", "GR", "EUR"], ["Ireland", "IE", "EUR"], ["Italy", "IT", "EUR"],
    ["Latvia", "LV", "EUR"], ["Lithuania", "LT", "EUR"], ["Luxembourg", "LU", "EUR"],
    ["Malta", "MT", "EUR"], ["Netherlands", "NL", "EUR"], ["Portugal", "PT", "EUR"],
    ["Slovakia", "SK", "EUR"], ["Slovenia", "SI", "EUR"], ["Spain", "ES", "EUR"],
    ["Andorra", "AD", "EUR"], ["Monaco", "MC", "EUR"], ["San Marino", "SM", "EUR"],
    ["Montenegro", "ME", "EUR"], ["Kosovo", "XK", "EUR"],
    // Europe — outside the euro
    ["United Kingdom", "GB", "GBP"], ["Switzerland", "CH", "CHF"],
    ["Norway", "NO", "NOK"], ["Sweden", "SE", "SEK"], ["Denmark", "DK", "DKK"],
    ["Iceland", "IS", "ISK"], ["Poland", "PL", "PLN"], ["Czechia", "CZ", "CZK"],
    ["Hungary", "HU", "HUF"], ["Romania", "RO", "RON"], ["Serbia", "RS", "RSD"],
    ["Bosnia & Herzegovina", "BA", "BAM"], ["North Macedonia", "MK", "MKD"],
    ["Albania", "AL", "ALL"], ["Moldova", "MD", "MDL"], ["Ukraine", "UA", "UAH"],
    ["Belarus", "BY", "BYN"], ["Russia", "RU", "RUB"], ["Georgia", "GE", "GEL"],
    ["Armenia", "AM", "AMD"], ["Azerbaijan", "AZ", "AZN"],
    // Africa
    ["Egypt", "EG", "EGP"], ["Morocco", "MA", "MAD"], ["Algeria", "DZ", "DZD"],
    ["Tunisia", "TN", "TND"], ["Libya", "LY", "LYD"], ["Sudan", "SD", "SDG"],
    ["South Sudan", "SS", "SSP"], ["Ethiopia", "ET", "ETB"], ["Eritrea", "ER", "ERN"],
    ["Djibouti", "DJ", "DJF"], ["Somalia", "SO", "SOS"], ["Kenya", "KE", "KES"],
    ["Tanzania", "TZ", "TZS"], ["Uganda", "UG", "UGX"], ["Rwanda", "RW", "RWF"],
    ["Burundi", "BI", "BIF"], ["Nigeria", "NG", "NGN"], ["Ghana", "GH", "GHS"],
    ["Cote d'Ivoire", "CI", "XOF"], ["Senegal", "SN", "XOF"], ["Mali", "ML", "XOF"],
    ["Burkina Faso", "BF", "XOF"], ["Niger", "NE", "XOF"], ["Benin", "BJ", "XOF"],
    ["Togo", "TG", "XOF"], ["Guinea-Bissau", "GW", "XOF"], ["Guinea", "GN", "GNF"],
    ["Sierra Leone", "SL", "SLE"], ["Liberia", "LR", "LRD"], ["Gambia", "GM", "GMD"],
    ["Cameroon", "CM", "XAF"], ["Gabon", "GA", "XAF"], ["Chad", "TD", "XAF"],
    ["Central African Republic", "CF", "XAF"], ["Congo-Brazzaville", "CG", "XAF"],
    ["Equatorial Guinea", "GQ", "XAF"], ["DR Congo", "CD", "CDF"],
    ["Angola", "AO", "AOA"], ["Zambia", "ZM", "ZMW"],
    ["Zimbabwe", "ZW", "USD"],             // contracts are written in dollars
    ["Malawi", "MW", "MWK"], ["Mozambique", "MZ", "MZN"], ["Botswana", "BW", "BWP"],
    ["Namibia", "NA", "NAD"], ["South Africa", "ZA", "ZAR"], ["Lesotho", "LS", "LSL"],
    ["Eswatini", "SZ", "SZL"], ["Madagascar", "MG", "MGA"], ["Mauritius", "MU", "MUR"],
    ["Seychelles", "SC", "SCR"], ["Comoros", "KM", "KMF"], ["Cabo Verde", "CV", "CVE"],
    ["Sao Tome & Principe", "ST", "STN"], ["Mauritania", "MR", "MRU"],
    // Americas
    ["United States", "US", "USD"], ["Canada", "CA", "CAD"], ["Mexico", "MX", "MXN"],
    ["Guatemala", "GT", "GTQ"], ["Belize", "BZ", "BZD"], ["Honduras", "HN", "HNL"],
    ["El Salvador", "SV", "USD"],          // dollarised
    ["Nicaragua", "NI", "NIO"], ["Costa Rica", "CR", "CRC"],
    ["Panama", "PA", "USD"],               // balboa is pegged; invoices are USD
    ["Colombia", "CO", "COP"], ["Venezuela", "VE", "VES"],
    ["Ecuador", "EC", "USD"],              // dollarised
    ["Peru", "PE", "PEN"], ["Bolivia", "BO", "BOB"], ["Brazil", "BR", "BRL"],
    ["Chile", "CL", "CLP"], ["Argentina", "AR", "ARS"], ["Uruguay", "UY", "UYU"],
    ["Paraguay", "PY", "PYG"], ["Guyana", "GY", "GYD"], ["Suriname", "SR", "SRD"],
    ["Cuba", "CU", "CUP"], ["Dominican Republic", "DO", "DOP"], ["Haiti", "HT", "HTG"],
    ["Jamaica", "JM", "JMD"], ["Trinidad & Tobago", "TT", "TTD"],
    ["Bahamas", "BS", "BSD"], ["Barbados", "BB", "BBD"], ["Bermuda", "BM", "BMD"],
    ["Cayman Islands", "KY", "KYD"], ["Aruba", "AW", "AWG"],
    ["Antigua & Barbuda", "AG", "XCD"], ["Dominica", "DM", "XCD"],
    ["Grenada", "GD", "XCD"], ["St Kitts & Nevis", "KN", "XCD"],
    ["St Lucia", "LC", "XCD"], ["St Vincent & the Grenadines", "VC", "XCD"],
    // Oceania
    ["Australia", "AU", "AUD"], ["New Zealand", "NZ", "NZD"],
    ["Papua New Guinea", "PG", "PGK"], ["Fiji", "FJ", "FJD"],
    ["Solomon Islands", "SB", "SBD"], ["Vanuatu", "VU", "VUV"],
    ["Samoa", "WS", "WST"], ["Tonga", "TO", "TOP"],
    ["New Caledonia", "NC", "XPF"], ["French Polynesia", "PF", "XPF"],
  ];

  var COUNTRIES = LIST.map(function (r) { return { name: r[0], cc: r[1], ccy: r[2] }; });

  /* What people actually type or what an imported sheet already says. The key
     side is normalised the same way the input is, so "U.A.E." and "uae" both
     land here. */
  var ALIAS = {
    usa: "US", unitedstatesofamerica: "US", america: "US", us: "US",
    uk: "GB", greatbritain: "GB", britain: "GB", england: "GB", scotland: "GB",
    wales: "GB", northernireland: "GB", unitedkingdomofgreatbritain: "GB",
    uae: "AE", emirates: "AE", dubai: "AE", abudhabi: "AE", sharjah: "AE",
    ksa: "SA", saudi: "SA", kingdomofsaudiarabia: "SA",
    korea: "KR", republicofkorea: "KR", southkorea: "KR",
    holland: "NL", thenetherlands: "NL",
    turkey: "TR", turkiye: "TR",
    czechrepublic: "CZ", czechia: "CZ",
    ivorycoast: "CI", cotedivoire: "CI",
    burma: "MM", swaziland: "SZ", capeverde: "CV", macedonia: "MK",
    easttimor: "TL", timorleste: "TL",
    drc: "CD", democraticrepublicofthecongo: "CD", congokinshasa: "CD",
    congo: "CG", republicofthecongo: "CG", congobrazzaville: "CG",
    russianfederation: "RU", bharat: "IN", hindustan: "IN",
    vietnam: "VN", vietnamsocialistrepublic: "VN",
    saintlucia: "LC", saintkittsandnevis: "KN", saintvincent: "VC",
    saintvincentandthegrenadines: "VC", trinidad: "TT", antigua: "AG",
    saotome: "ST", saotomeandprincipe: "ST",
    bosnia: "BA", herzegovina: "BA",
    png: "PG", newguinea: "PG",
    // ISO-3 codes for the markets most likely to be typed in short form
    ind: "IN", are: "AE", gbr: "GB", deu: "DE", fra: "FR", esp: "ES", ita: "IT",
    chn: "CN", jpn: "JP", kor: "KR", sgp: "SG", mys: "MY", tha: "TH", idn: "ID",
    aus: "AU", nzl: "NZ", zaf: "ZA", bra: "BR", can: "CA", mex: "MX", egy: "EG",
    nga: "NG", ken: "KE", lka: "LK", bgd: "BD", npl: "NP", pak: "PK", vnm: "VN",
  };

  /* Diacritics folded, punctuation dropped: "Côte d'Ivoire", "cote divoire" and
     "COTE-D-IVOIRE" all normalise to the same key. */
  function norm(v) {
    var s = String(v == null ? "" : v);
    if (s.normalize) s = s.normalize("NFD").replace(/[̀-ͯ]/g, "");
    return s.toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  var BY_CC = {}, BY_NAME = {};
  COUNTRIES.forEach(function (c) { BY_CC[c.cc] = c; BY_NAME[norm(c.name)] = c; });

  /** Whatever the user typed -> the country record, or null.
      Accepts the full name, an ISO-2 code, an ISO-3 code or a common alias. */
  function country(input) {
    var n = norm(input);
    if (!n) return null;
    if (BY_NAME[n]) return BY_NAME[n];
    if (ALIAS[n] && BY_CC[ALIAS[n]]) return BY_CC[ALIAS[n]];
    if (n.length === 2 && BY_CC[n.toUpperCase()]) return BY_CC[n.toUpperCase()];
    return null;
  }
  /** Country -> the currency its invoices are raised in ("" when unrecognised,
      which the caller should treat as "leave whatever is already set"). */
  function forCountry(input) { var c = country(input); return c ? c.ccy : ""; }

  function name(code) { var m = META[String(code || "").toUpperCase()]; return m ? m[0] : String(code || ""); }
  function sym(code)  { var m = META[String(code || "").toUpperCase()]; return m ? m[1] : ""; }
  /** "USD $" — the collapsed form, for a picker's closed state or a chip. */
  function short(code) { return (String(code || "").toUpperCase() + " " + sym(code)).trim(); }
  /** "USD $ — US Dollar" — the open list, where there is room to read. */
  function full(code) { return short(code) + " — " + name(code); }
  function known(code) { return Object.prototype.hasOwnProperty.call(META, String(code || "").toUpperCase()); }

  /** Codes sorted by the NAME people read, not the code. Code order scatters
      the list (AED "UAE Dirham" would lead, CHF "Swiss Franc" would sit between
      Canadian and Chinese). */
  function sortedByName(codes) {
    return (codes || Object.keys(META)).slice().sort(function (a, b) {
      return name(a).localeCompare(name(b));
    });
  }
  /** {v,l} options for U.selectHTML / U.searchSelect. */
  function options(codes) { return sortedByName(codes).map(function (c) { return { v: c, l: full(c) }; }); }
  function countryOptions() {
    return COUNTRIES.slice()
      .sort(function (a, b) { return a.name.localeCompare(b.name); })
      .map(function (c) { return { v: c.name, l: c.name + " — " + short(c.ccy) }; });
  }

  /* ---- live rate ------------------------------------------------------------
     One pair, straight from the server's Google-only feed. Cached for a minute
     to match the dashboard's poll, so opening five customer records in a row is
     one fetch, not five. Resolves to null when Google cannot be read — the
     caller shows "—" and never a number from somewhere else. */
  var CACHE_MS = 60 * 1000;
  var rateCache = {};   // "USD-INR" -> { at, val }

  function rate(from, to) {
    from = String(from || "").toUpperCase();
    to = String(to || "INR").toUpperCase();
    if (!from || from === to) return Promise.resolve({ rate: 1, shown: "1", asOf: null });
    var key = from + "-" + to, hit = rateCache[key];
    if (hit && Date.now() - hit.at < CACHE_MS) return Promise.resolve(hit.val);
    if (typeof fetch !== "function") return Promise.resolve(null);
    return fetch("/api/fx/pair?from=" + encodeURIComponent(from) + "&to=" + encodeURIComponent(to))
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (j) {
        if (!(j && j.rate > 0)) throw new Error("no rate");
        var val = { rate: j.rate, shown: j.shown, asOf: j.asOf || null };
        rateCache[key] = { at: Date.now(), val: val };
        return val;
      })
      .catch(function () { return null; });
  }

  return {
    META: META, COUNTRIES: COUNTRIES, CONVERTER_CODES: CONVERTER_CODES,
    country: country, forCountry: forCountry, norm: norm,
    name: name, sym: sym, short: short, full: full, known: known,
    sortedByName: sortedByName, options: options, countryOptions: countryOptions,
    rate: rate,
  };
});
