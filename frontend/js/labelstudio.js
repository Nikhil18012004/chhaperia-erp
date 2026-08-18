/* ============================================================
   CHHAPERIA ERP — LABEL STUDIO   (Inventory ▸ Label Studio)
   A label designer in the shape of BarTender, living inside the
   ERP instead of beside it.

   WHERE IT LIVES: its own screen in the warehouse group, beside
   Stock Items and Warehouses — not a button in Procurement. It
   was a dialog opened from the Procurement page head once, and
   that was wrong twice over: a designer is not an errand you run
   off a buyer's screen, and a dialog caps the canvas at whatever
   is left inside it. It is a page now, and mod-label-studio.js is
   the two lines of module that mount it.

   WHY THIS EXISTS SEPARATELY FROM THE PO STICKER WIZARD
   The sticker wizard prints ONE fixed composition — a title, a
   product line, a field table — filled from a purchase order.
   It is a form, it belongs to the order, and it stays where it
   is (Procurement ▸ open a PO ▸ 🏷 Labels). This is a DESIGNER:
   an empty label and a toolbox, where the operator places text,
   barcodes, QR codes, pictures and shapes wherever they want
   them, at whatever size, and saves the result as a reusable
   template.

   WHAT WAS TAKEN FROM BARTENDER (researched 2026-08-12, see
   bartendersoftware.com/product/capabilities/create and the
   Seagull help at help.seagullscientific.com):
     · a canvas with rulers, a dot grid and snapping
     · a toolbox of object types — text, barcode, picture, line,
       box, ellipse
     · an object/layer list with z-order, duplicate and delete
     · a properties pane: exact X/Y/W/H in mm, rotation, font,
       alignment, colour, border, fill
     · DATA SOURCES rather than dead text — a field is fixed text,
       a date, an auto-incrementing serial, or a value prompted
       for at print time. This is the thing that makes BarTender a
       label tool and not a drawing tool, and it is why a barcode
       here can serialise across a run.
     · a print step with quantity, copies, serial start and the
       sheet/roll setup
     · 100+ symbologies is a specialist's list; the six that a
       cable-tape plant actually prints are implemented in full
       (Code 128, Code 39, EAN-13, ITF, plus QR and a QR-backed
       2D fallback), each encoded here in JS — no CDN, no plugin.

   WHERE THE DESIGNS LIVE
   In the ERP's own settings document, on the server, exactly like
   every other setting — the operator saves a template, and it is
   there for them on any machine that signs in. That is the only
   home a design has. A label can also be DOWNLOADED to a .json
   file and IMPORTED back, which is how one travels to a backup or
   arrives from another Chhaperia installation; an imported one is
   a saved template like any other from the moment it lands.

   ⚠ THAT FILE IS NOT A BarTender .btw AND CANNOT BE MADE INTO ONE.
   BarTender's .btw is Seagull's closed binary format; a browser
   cannot write it and BarTender rejects anything else outright
   (error #3323, "not a supported file type"). Feeding BarTender
   real work is what the SERVER-side bridge is for — see
   backend/services/bartenderService: it writes a CSV the operator's
   own .btw template is bound to, and starts BarTender on it.

   Printing goes through the browser's own print dialog, so the
   label printer the plant already uses is the one that gets the job.
   ============================================================ */
(function (global) {
  "use strict";
  const {h, esc, toast, modal, confirm} = UI;

  const PX_MM = 96 / 25.4;             // one CSS millimetre, for screen scaling
  const MAX_DOCS = 40;
  const MAX_OBJ = 120;
  const MAX_IMG = 900000;              // ~900 KB of data URL per picture

  /* ============================================================
     SECTION 1 — SYMBOLOGIES
     Every encoder returns a list of element widths in MODULES,
     alternating bar, space, bar, … starting on a bar. The renderer
     turns that into rectangles; nothing here knows about pixels,
     so the same encoding drives the screen and the printer.
     ============================================================ */

  /* ---- Code 128 -------------------------------------------------
     The 107 symbol patterns, each six element widths (the stop code
     carries a seventh — its terminating bar). Auto-switching between
     subset B (text) and subset C (pairs of digits) is what keeps a
     long numeric barcode short enough to fit a 40 mm label. */
  const C128 = ["212222","222122","222221","121223","121322","131222","122213","122312",
    "132212","221213","221312","231212","112232","122132","122231","113222","123122","123221",
    "223211","221132","221231","213212","223112","312131","311222","321122","321221","312212",
    "322112","322211","212123","212321","232121","111323","131123","131321","112313","132113",
    "132311","211313","231113","231311","112133","112331","132131","113123","113321","133121",
    "313121","211331","231131","213113","213311","213131","311123","311321","331121","312113",
    "312311","332111","314111","221411","431111","111224","111422","121124","121421","141122",
    "141221","112214","112412","122114","122411","142112","142211","241211","221114","413111",
    "241112","134111","111242","121142","121241","114212","124112","124211","411212","421112",
    "421211","212141","214121","412121","111143","111341","131141","114113","114311","411113",
    "411311","113141","114131","311141","411131","211412","211214","211232","2331112"];

  function code128(data){
    const s = String(data == null ? "" : data);
    if(!s) return null;
    // Subsets B and C between them cover 32..126; a control character would
    // need subset A, which this encoder does not switch into.
    if(/[^\x20-\x7E]/.test(s)) return null;
    const dig=(i)=>i<s.length && s[i]>="0" && s[i]<="9";
    const run=(i)=>{ let n=0; while(dig(i+n)) n++; return n; };
    const codes=[];
    let mode, i=0;
    const head=run(0);
    /* Opening in subset C pays for itself from four digits (two symbols
       instead of four); an odd run wastes one, so it wants six. */
    if(head>=6 || (head>=4 && head%2===0)){ codes.push(105); mode="C"; }
    else { codes.push(104); mode="B"; }
    while(i<s.length){
      if(mode==="C"){
        if(run(i)>=2){ codes.push(+s.substr(i,2)); i+=2; continue; }
        codes.push(100); mode="B"; continue;          // → subset B
      }
      const r=run(i);
      if(r>=6 || (r>=4 && i+r>=s.length)){
        if(r%2===1){ codes.push(s.charCodeAt(i)-32); i++; }   // odd digit stays in B
        codes.push(99); mode="C"; continue;           // → subset C
      }
      codes.push(s.charCodeAt(i)-32); i++;
    }
    let sum=codes[0];
    for(let j=1;j<codes.length;j++) sum+=codes[j]*j;
    codes.push(sum%103);                              // modulo-103 check symbol
    codes.push(106);                                  // stop
    const els=[];
    codes.forEach(c=>{ for(const ch of C128[c]) els.push(+ch); });
    return {els, quiet:10, text:s};
  }

  /* ---- Code 39 --------------------------------------------------
     Nine elements per character, narrow or wide, with a narrow space
     between characters. Wide:narrow is 3:1 — the ratio every scanner
     is specified against. */
  const C39 = {
    "0":"nnnwwnwnn","1":"wnnwnnnnw","2":"nnwwnnnnw","3":"wnwwnnnnn","4":"nnnwwnnnw",
    "5":"wnnwwnnnn","6":"nnwwwnnnn","7":"nnnwnnwnw","8":"wnnwnnwnn","9":"nnwwnnwnn",
    "A":"wnnnnwnnw","B":"nnwnnwnnw","C":"wnwnnwnnn","D":"nnnnwwnnw","E":"wnnnwwnnn",
    "F":"nnwnwwnnn","G":"nnnnnwwnw","H":"wnnnnwwnn","I":"nnwnnwwnn","J":"nnnnwwwnn",
    "K":"wnnnnnnww","L":"nnwnnnnww","M":"wnwnnnnwn","N":"nnnnwnnww","O":"wnnnwnnwn",
    "P":"nnwnwnnwn","Q":"nnnnnnwww","R":"wnnnnnwwn","S":"nnwnnnwwn","T":"nnnnwnwwn",
    "U":"wwnnnnnnw","V":"nwwnnnnnw","W":"wwwnnnnnn","X":"nwnnwnnnw","Y":"wwnnwnnnn",
    "Z":"nwwnwnnnn","-":"nwnnnnwnw",".":"wwnnnnwnn"," ":"nwwnnnwnn","$":"nwnwnwnnn",
    "/":"nwnwnnnwn","+":"nwnnnwnwn","%":"nnnwnwnwn","*":"nwnnwnwnn"
  };
  function code39(data){
    const s=String(data==null?"":data).toUpperCase();
    if(!s) return null;
    const chars=("*"+s+"*").split("");
    if(chars.some(c=>!C39[c])) return null;
    const els=[];
    chars.forEach((c,idx)=>{
      if(idx) els.push(1);                            // inter-character narrow space
      for(const w of C39[c]) els.push(w==="w"?3:1);
    });
    return {els, quiet:10, text:s};
  }

  /* ---- EAN-13 ---------------------------------------------------
     95 modules, fixed. The first digit is not drawn as bars at all —
     it is carried by WHICH of the L/G patterns the left half uses,
     which is why a 13-digit code fits in 12 digits of bars. */
  const EAN_L=["0001101","0011001","0010011","0111101","0100011","0110001","0101111","0111011","0110111","0001011"];
  const EAN_G=["0100111","0110011","0011011","0100001","0011101","0111001","0000101","0010001","0001001","0010111"];
  const EAN_R=["1110010","1100110","1101100","1000010","1011100","1001110","1010000","1000100","1001000","1110100"];
  const EAN_PARITY=["LLLLLL","LLGLGG","LLGGLG","LLGGGL","LGLLGG","LGGLLG","LGGGLL","LGLGLG","LGLGGL","LGGLGL"];
  function ean13(data){
    let s=String(data==null?"":data).replace(/\D/g,"");
    if(s.length===12){                                // supply the check digit
      let sum=0; for(let i=0;i<12;i++) sum+=(+s[i])*(i%2?3:1);
      s+=String((10-sum%10)%10);
    }
    if(s.length!==13) return null;
    let sum=0; for(let i=0;i<12;i++) sum+=(+s[i])*(i%2?3:1);
    if((10-sum%10)%10 !== +s[12]) return null;        // a wrong check digit is a wrong barcode
    const par=EAN_PARITY[+s[0]];
    let bits="101";
    for(let i=1;i<=6;i++) bits+=(par[i-1]==="L"?EAN_L:EAN_G)[+s[i]];
    bits+="01010";
    for(let i=7;i<=12;i++) bits+=EAN_R[+s[i]];
    bits+="101";
    return {els:bitsToEls(bits), quiet:11, text:s, ean:true};
  }
  /* A run-length pass over a module string: "1101" -> [2,1,1]. Every
     encoder that thinks in modules rather than in bar widths lands here. */
  function bitsToEls(bits){
    const els=[]; let cur=bits[0], n=0;
    for(const b of bits){ if(b===cur) n++; else { els.push(n); cur=b; n=1; } }
    els.push(n);
    // the list must START on a bar; a leading space becomes a zero-width bar
    return bits[0]==="1"?els:[0].concat(els);
  }

  /* ---- Interleaved 2 of 5 --------------------------------------
     Two digits share one symbol: the first is the bars, the second is
     the spaces between them. Needs an even digit count, so an odd one
     is padded — the drum-count barcodes on cartons are all ITF-14. */
  const ITF=["nnwwn","wnnnw","nwnnw","wwnnn","nnwnw","wnwnn","nwwnn","nnnww","wnnwn","nwnwn"];
  function itf(data){
    let s=String(data==null?"":data).replace(/\D/g,"");
    if(!s) return null;
    if(s.length%2) s="0"+s;
    const els=[1,1,1,1];                              // start: narrow bar/space ×2
    for(let i=0;i<s.length;i+=2){
      const a=ITF[+s[i]], b=ITF[+s[i+1]];
      for(let j=0;j<5;j++){ els.push(a[j]==="w"?3:1); els.push(b[j]==="w"?3:1); }
    }
    els.push(3,1,1);                                  // stop: wide bar, narrow space, narrow bar
    return {els, quiet:10, text:s};
  }

  /* ============================================================
     SECTION 2 — QR CODE
     A complete encoder: byte mode (so it carries any text), all 40
     versions, all four error-correction levels, and the eight masks
     scored the way the specification says to score them. Written out
     here because a label tool without a QR code is not a label tool,
     and this app loads no libraries from the network.
     ============================================================ */
  const QR_ECC=[
    [-1,7,10,15,20,26,18,20,24,30,18,20,24,26,30,22,24,28,30,28,28,28,28,30,30,26,28,30,30,30,30,30,30,30,30,30,30,30,30,30,30],
    [-1,10,16,26,18,24,16,18,22,22,26,30,22,22,24,24,28,28,26,26,26,26,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28],
    [-1,13,22,18,26,18,24,18,22,20,24,28,26,24,20,30,24,28,28,26,30,28,30,30,30,30,28,30,30,30,30,30,30,30,30,30,30,30,30,30,30],
    [-1,17,28,22,16,22,28,26,26,24,28,24,28,22,24,24,30,28,28,26,28,30,24,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30]];
  const QR_BLOCKS=[
    [-1,1,1,1,1,1,2,2,2,2,4,4,4,4,4,6,6,6,6,7,8,8,9,9,10,12,12,12,13,14,15,16,17,18,19,19,20,21,22,24,25],
    [-1,1,1,1,2,2,4,4,4,5,5,5,8,9,9,10,10,11,13,14,16,17,17,18,20,21,23,25,26,28,29,31,33,35,37,38,40,43,45,47,49],
    [-1,1,1,2,2,4,4,6,6,8,8,8,10,12,16,12,17,16,18,21,20,23,23,25,27,29,34,34,35,38,40,43,45,48,51,53,56,59,62,65,68],
    [-1,1,1,2,4,4,4,5,6,8,8,11,11,16,16,18,16,19,21,25,25,25,34,30,32,35,37,40,42,45,48,51,54,57,60,63,66,70,74,77,81]];
  const QR_FMT=[1,0,3,2];              // the format bits for L, M, Q, H

  function gfMul(x,y){                 // GF(256) product, modulo 0x11D
    let z=0;
    for(let i=7;i>=0;i--){ z=(z<<1)^((z>>>7)*0x11D); z^=((y>>>i)&1)*x; }
    return z&0xFF;
  }
  function rsDivisor(deg){
    const d=new Uint8Array(deg); d[deg-1]=1;
    let root=1;
    for(let i=0;i<deg;i++){
      for(let j=0;j<deg;j++){ d[j]=gfMul(d[j],root); if(j+1<deg) d[j]^=d[j+1]; }
      root=gfMul(root,0x02);
    }
    return d;
  }
  function rsRemainder(data,div){
    const r=new Uint8Array(div.length);
    for(const b of data){
      const f=b^r[0];
      r.copyWithin(0,1); r[r.length-1]=0;
      for(let i=0;i<div.length;i++) r[i]^=gfMul(div[i],f);
    }
    return r;
  }
  function qrRawModules(v){
    let n=(16*v+128)*v+64;
    if(v>=2){ const a=Math.floor(v/7)+2; n-=(25*a-10)*a-55; if(v>=7) n-=36; }
    return n;
  }
  function qrDataCodewords(v,ecl){
    return Math.floor(qrRawModules(v)/8) - QR_ECC[ecl][v]*QR_BLOCKS[ecl][v];
  }
  function qrAlign(v){
    if(v===1) return [];
    const n=Math.floor(v/7)+2, size=v*4+17;
    const step=(v===32)?26:Math.ceil((v*4+4)/(n*2-2))*2;
    const out=[6];
    for(let pos=size-7; out.length<n; pos-=step) out.splice(1,0,pos);
    return out;
  }
  function utf8(s){
    const out=[];
    for(const ch of String(s)){
      let c=ch.codePointAt(0);
      if(c<0x80) out.push(c);
      else if(c<0x800){ out.push(0xC0|c>>6,0x80|c&63); }
      else if(c<0x10000){ out.push(0xE0|c>>12,0x80|(c>>6)&63,0x80|c&63); }
      else { out.push(0xF0|c>>18,0x80|(c>>12)&63,0x80|(c>>6)&63,0x80|c&63); }
    }
    return out;
  }

  function qrEncode(text,eclName){
    const ecl=Math.max(0,["L","M","Q","H"].indexOf(eclName||"M"));
    const bytes=utf8(text==null?"":text);
    if(!bytes.length) return null;
    // the smallest version the payload fits, so the modules stay as big as possible
    let ver=1;
    for(; ver<=40; ver++){
      const cap=qrDataCodewords(ver,ecl)*8;
      const cc=ver<10?8:16;
      if(4+cc+bytes.length*8 <= cap) break;
    }
    if(ver>40) return null;
    const size=ver*4+17;
    const bits=[];
    const push=(val,len)=>{ for(let i=len-1;i>=0;i--) bits.push((val>>>i)&1); };
    push(4,4);                                        // byte mode
    push(bytes.length, ver<10?8:16);
    bytes.forEach(b=>push(b,8));
    const capBits=qrDataCodewords(ver,ecl)*8;
    push(0,Math.min(4,capBits-bits.length));          // terminator
    while(bits.length%8) bits.push(0);
    const pads=[0xEC,0x11];
    for(let i=0; bits.length<capBits; i++) push(pads[i%2],8);
    const dat=new Uint8Array(bits.length/8);
    bits.forEach((b,i)=>{ if(b) dat[i>>3]|=0x80>>>(i&7); });

    /* Split into blocks, give each its own ECC, then interleave — a
       scuff that destroys one region of the label then damages a few
       codewords of every block instead of all of one. */
    const nb=QR_BLOCKS[ecl][ver], ecLen=QR_ECC[ecl][ver];
    const total=Math.floor(qrRawModules(ver)/8);
    const shortLen=Math.floor(total/nb)-ecLen;
    const numShort=nb-total%nb;
    const div=rsDivisor(ecLen);
    const blocks=[]; let off=0;
    for(let i=0;i<nb;i++){
      const len=shortLen+(i<numShort?0:1);
      const d=dat.slice(off,off+len); off+=len;
      blocks.push({d, e:rsRemainder(d,div)});
    }
    const out=[];
    for(let i=0;i<shortLen+1;i++)
      blocks.forEach((b,j)=>{ if(i<shortLen || j>=numShort) out.push(b.d[i]); });
    for(let i=0;i<ecLen;i++) blocks.forEach(b=>out.push(b.e[i]));

    /* ---- the grid ---- */
    const mod=[], fn=[];
    for(let y=0;y<size;y++){ mod.push(new Array(size).fill(false)); fn.push(new Array(size).fill(false)); }
    const set=(x,y,v)=>{ mod[y][x]=v; fn[y][x]=true; };
    const finder=(cx,cy)=>{
      for(let dy=-4;dy<=4;dy++) for(let dx=-4;dx<=4;dx++){
        const x=cx+dx, y=cy+dy;
        if(x<0||y<0||x>=size||y>=size) continue;
        const d=Math.max(Math.abs(dx),Math.abs(dy));
        set(x,y,d!==2&&d!==4);
      }
    };
    finder(3,3); finder(size-4,3); finder(3,size-4);
    for(let i=0;i<size;i++){ if(!fn[6][i]) set(i,6,i%2===0); if(!fn[i][6]) set(6,i,i%2===0); }
    const al=qrAlign(ver);
    al.forEach((ax,i)=>al.forEach((ay,j)=>{
      if((i===0&&j===0)||(i===0&&j===al.length-1)||(i===al.length-1&&j===0)) return;
      for(let dy=-2;dy<=2;dy++) for(let dx=-2;dx<=2;dx++)
        set(ax+dx,ay+dy,Math.max(Math.abs(dx),Math.abs(dy))!==1);
    }));
    set(8,size-8,true);                                // the always-dark module
    /* Reserve every cell the format and version words will later occupy, so
       the data pass steps over them. These MUST mirror drawFormat/drawVersion
       exactly — a cell reserved here but not written there prints white, and a
       cell written there but not reserved here silently eats a data bit. */
    for(let i=0;i<=5;i++){ fn[i][8]=true; fn[8][i]=true; }
    fn[7][8]=true; fn[8][8]=true; fn[8][7]=true;
    for(let i=0;i<8;i++) fn[8][size-1-i]=true;
    for(let i=0;i<7;i++) fn[size-1-i][8]=true;
    if(ver>=7){
      for(let i=0;i<18;i++){
        const a=Math.floor(i/3), b=size-11+i%3;
        fn[b][a]=true; fn[a][b]=true;
      }
    }

    /* ---- data, laid in the two-wide zigzag ---- */
    let bi=0;
    for(let right=size-1; right>=1; right-=2){
      if(right===6) right=5;
      for(let v=0;v<size;v++){
        for(let j=0;j<2;j++){
          const x=right-j;
          const up=((right+1)&2)===0;
          const y=up?size-1-v:v;
          if(fn[y][x]) continue;
          mod[y][x]= bi<out.length*8 ? ((out[bi>>3]>>>(7-(bi&7)))&1)===1 : false;
          bi++;
        }
      }
    }

    /* ---- mask selection: every mask is drawn and scored, lowest wins ---- */
    const maskFn=[
      (x,y)=>(x+y)%2===0, (x,y)=>y%2===0, (x,y)=>x%3===0, (x,y)=>(x+y)%3===0,
      (x,y)=>(Math.floor(x/3)+Math.floor(y/2))%2===0,
      (x,y)=>(x*y)%2+(x*y)%3===0, (x,y)=>((x*y)%2+(x*y)%3)%2===0,
      (x,y)=>((x+y)%2+(x*y)%3)%2===0];
    let best=null, bestScore=Infinity;
    for(let m=0;m<8;m++){
      const g=mod.map(r=>r.slice());
      for(let y=0;y<size;y++) for(let x=0;x<size;x++)
        if(!fn[y][x] && maskFn[m](x,y)) g[y][x]=!g[y][x];
      drawFormat(g,ecl,m,size);
      if(ver>=7) drawVersion(g,ver,size);
      const sc=penalty(g,size);
      if(sc<bestScore){ bestScore=sc; best=g; }
    }
    return {size, modules:best};
  }
  function drawFormat(g,ecl,mask,size){
    const data=QR_FMT[ecl]<<3|mask;
    let rem=data;
    for(let i=0;i<10;i++) rem=(rem<<1)^((rem>>>9)*0x537);
    const bits=((data<<10)|rem)^0x5412;
    const b=(i)=>((bits>>>i)&1)===1;
    for(let i=0;i<=5;i++) g[i][8]=b(i);
    g[7][8]=b(6); g[8][8]=b(7); g[8][7]=b(8);
    for(let i=9;i<15;i++) g[8][14-i]=b(i);
    for(let i=0;i<8;i++) g[8][size-1-i]=b(i);
    for(let i=8;i<15;i++) g[size-15+i][8]=b(i);
    g[size-8][8]=true;
  }
  function drawVersion(g,ver,size){
    let rem=ver;
    for(let i=0;i<12;i++) rem=(rem<<1)^((rem>>>11)*0x1F25);
    const bits=(ver<<12)|rem;
    for(let i=0;i<18;i++){
      const bit=((bits>>>i)&1)===1, a=Math.floor(i/3), b=size-11+i%3;
      g[b][a]=bit; g[a][b]=bit;
    }
  }
  function penalty(g,size){
    let p=0;
    const run=(get)=>{
      for(let i=0;i<size;i++){
        let cur=get(i,0), n=1;
        for(let j=1;j<size;j++){
          const v=get(i,j);
          if(v===cur) { n++; if(n===5) p+=3; else if(n>5) p+=1; }
          else { cur=v; n=1; }
        }
      }
    };
    run((i,j)=>g[i][j]); run((i,j)=>g[j][i]);          // rule 1: runs of five or more
    for(let y=0;y<size-1;y++) for(let x=0;x<size-1;x++){ // rule 2: 2×2 blocks
      const v=g[y][x];
      if(v===g[y][x+1]&&v===g[y+1][x]&&v===g[y+1][x+1]) p+=3;
    }
    // rule 3: the finder-like 1:1:3:1:1 sequence anywhere in the grid
    const pat=[true,false,true,true,true,false,true];
    const look=(get)=>{
      for(let i=0;i<size;i++) for(let j=0;j<=size-7;j++){
        let hit=true;
        for(let k=0;k<7;k++) if(get(i,j+k)!==pat[k]){ hit=false; break; }
        if(!hit) continue;
        let before=true, after=true;
        for(let k=1;k<=4;k++){ if(j-k>=0&&get(i,j-k)) before=false; if(j+6+k<size&&get(i,j+6+k)) after=false; }
        if(before||after) p+=40;
      }
    };
    look((i,j)=>g[i][j]); look((i,j)=>g[j][i]);
    let dark=0;
    for(let y=0;y<size;y++) for(let x=0;x<size;x++) if(g[y][x]) dark++;
    // rule 4: how far the dark share strays from half
    p+=Math.floor(Math.abs(dark*20-size*size*10)/(size*size))*10;
    return p;
  }

  /* ============================================================
     SECTION 3 — DRAWING A SYMBOL
     Bars become one <svg> with preserveAspectRatio="none", so the
     symbol stretches to whatever box the operator drew and stays
     mathematically exact at every size and on every printer.
     ============================================================ */
  const SYMS=[
    {v:"code128",l:"Code 128",   d:"Any text or digits — the general-purpose one"},
    {v:"code39", l:"Code 39",    d:"Letters, digits and - . $ / + %"},
    {v:"ean13",  l:"EAN-13",     d:"13 digits (12 + check, or 12 and it computes it)"},
    {v:"itf",    l:"ITF / ITF-14",d:"Digits only, in pairs — carton codes"},
    {v:"qr",     l:"QR Code",    d:"2D — text, a URL, anything"},
  ];
  function encodeBar(sym,value){
    if(sym==="code39") return code39(value);
    if(sym==="ean13")  return ean13(value);
    if(sym==="itf")    return itf(value);
    return code128(value);
  }
  function barcodeSvg(sym,value,color){
    const enc=encodeBar(sym,value);
    if(!enc) return null;
    const q=enc.quiet;
    const total=enc.els.reduce((a,b)=>a+b,0)+q*2;
    let x=q, black=true, rects="";
    enc.els.forEach(w=>{
      if(black && w>0) rects+=`<rect x="${x}" y="0" width="${w}" height="100" fill="${color}"/>`;
      x+=w; black=!black;
    });
    /* preserveAspectRatio="none" lets the bars stretch to exactly the box the
       operator drew: the WIDTHS stay proportionally exact (which is all a
       scanner reads), and the height is free. */
    return {svg:`<svg viewBox="0 0 ${total} 100" preserveAspectRatio="none" `+
      `xmlns="http://www.w3.org/2000/svg" style="position:absolute;left:0;top:0;width:100%;height:100%">`+
      `<rect width="${total}" height="100" fill="none"/>${rects}</svg>`, text:enc.text};
  }
  function qrSvg(value,color,ecl){
    const q=qrEncode(value,ecl);
    if(!q) return null;
    const n=q.size, pad=4, dim=n+pad*2;           // the four-module quiet zone the spec demands
    let r="";
    for(let y=0;y<n;y++){
      let x=0;
      while(x<n){
        if(!q.modules[y][x]){ x++; continue; }
        let w=1; while(x+w<n && q.modules[y][x+w]) w++;   // merge a run into one rect
        r+=`<rect x="${x+pad}" y="${y+pad}" width="${w}" height="1" fill="${color}"/>`;
        x+=w;
      }
    }
    /* No preserveAspectRatio override here — a QR code must stay square, so it
       is centred and fitted inside whatever box it was given. */
    return {svg:`<svg viewBox="0 0 ${dim} ${dim}" xmlns="http://www.w3.org/2000/svg" `+
      `style="position:absolute;left:0;top:0;width:100%;height:100%" shape-rendering="crispEdges">${r}</svg>`,
      text:String(value)};
  }

  /* ============================================================
     SECTION 4 — THE DOCUMENT
     ============================================================ */
  /* ⚠ SINGLE QUOTES, NOT DOUBLE. Every one of these stacks is interpolated
     into a style="…" ATTRIBUTE. A double quote inside a family name closes
     that attribute early: `font:… "Courier New",…` was parsed as a style of
     `font:… ` followed by two bogus attributes (courier="" and new"), so the
     label silently fell back to the browser's default font — on screen and on
     the printed sheet. Three of the six stacks below need a quoted family, so
     three of six fonts were broken. CSS accepts either quote; HTML attributes
     do not, so the choice is made here once and for all. */
  const FONTS=[
    {v:"arial",   l:"Arial",           css:"Arial,Helvetica,sans-serif"},
    {v:"times",   l:"Times New Roman", css:"'Times New Roman',Times,serif"},
    {v:"georgia", l:"Georgia",         css:"Georgia,serif"},
    {v:"calibri", l:"Calibri",         css:"Calibri,Candara,Segoe,sans-serif"},
    {v:"courier", l:"Courier New",     css:"'Courier New',Courier,monospace"},
    {v:"impact",  l:"Impact",          css:"Impact,'Arial Black',sans-serif"},
  ];
  const fontCss=(v)=>(FONTS.find(f=>f.v===v)||FONTS[0]).css;
  const PAGES=[
    {v:"A4",w:210,h:297},{v:"A5",w:148,h:210},{v:"A6",w:105,h:148},
    {v:"A3",w:297,h:420},{v:"Letter",w:216,h:279},{v:"Legal",w:216,h:356},{v:"custom",w:0,h:0}];

  /* ============================================================
     LABEL LAYOUTS — the dimensions a label is actually cut to.

     BarTender opens on "what are you printing ON", because that is
     the one thing the operator cannot change: the sheets in the
     drawer and the roll on the printer are already bought. Picking
     a layout sets the label size, the page, the margins and the
     gaps in one go; the grid is still COMPUTED from them by
     sheetGrid, so a preset can never claim a column that does not
     fit.

     TWO FAMILIES, because they are bought and loaded differently:
       · ROLL — a die-cut roll on a thermal printer (Zebra, TSC,
         Godex). The page IS the label, one per page, no margins to
         get wrong. The sizes below are the ones a tape-converting
         plant runs, from a 4 × 6 dispatch label down to a 25 × 12
         cable flag. The inch sizes are named in inches as well as
         millimetres because that is how the roll is ordered.
       · A4 SHEET — die-cut laser sheets (Avery, Desmat, Multitec).
         The label is tiled across the page.

     ABOUT THE MARGINS. The seven original sheet layouts carry the
     die-cut margins measured off the real stock, so they are left
     exactly as they were. The layouts added since are marked `af`
     and hand their margins to auto-fit rather than carry a number
     nobody has checked against a physical sheet.

     ⚠ AND THAT IS WHY NO LAYOUT NAMES ITS OWN PER-PAGE COUNT.
     An auto-fit layout's count falls out of the solver, not out of
     the Avery catalogue, and the two do not always agree — Avery's
     40-up 45.7 × 25.4 sheet has a deeper lead-in than auto-fit
     leaves, so the solver fits 11 rows where the die cuts 10. The
     count shown on a card is therefore computed by perPageOf(),
     through the same sheetGrid() the printer uses. A layout that
     names a count it cannot print is the one thing this must never
     do.
     ============================================================ */
  const STOCKS=[
    /* --- roll: a 100 mm web, and what this plant dies out of it. The first
       two are the runs the shop floor actually does — two 50 × 25 side by side
       with the die leaving NO gap between them and ~5 mm of feed above and
       below, and a single 100 × 120 with the same 5 mm feed gap. `web` is the
       roll as bought; `across` is how many the die cuts out of it. --- */
    {v:"roll-100w-50x25x2", mode:"roll", w:50, h:25, web:100, across:2,
      rGapX:0, rGapY:5, n:"100 mm web — two up, no gap"},
    {v:"roll-100w-100x120", mode:"roll", w:100, h:120, web:100, across:1,
      rGapX:0, rGapY:5, n:"100 mm web — single, 5 mm feed"},
    {v:"roll-100x150", mode:"roll", w:100, h:150, n:"Dispatch carton (4 × 6 in)"},
    {v:"roll-100x125", mode:"roll", w:100, h:125, n:"Dispatch, short"},
    {v:"roll-100x100", mode:"roll", w:100, h:100, n:"Carton (4 × 4 in)"},
    {v:"roll-100x75",  mode:"roll", w:100, h:75,  n:"Carton, short (4 × 3 in)"},
    {v:"roll-100x50",  mode:"roll", w:100, h:50,  n:"Jumbo reel (4 × 2 in)"},
    {v:"roll-100x25",  mode:"roll", w:100, h:25,  n:"Reel edge (4 × 1 in)"},
    {v:"roll-75x100",  mode:"roll", w:75,  h:100, n:"Drum, tall (3 × 4 in)"},
    {v:"roll-75x50",   mode:"roll", w:75,  h:50,  n:"Drum (3 × 2 in)"},
    {v:"roll-75x25",   mode:"roll", w:75,  h:25,  n:"Drum band (3 × 1 in)"},
    {v:"roll-50x50",   mode:"roll", w:50,  h:50,  n:"Core / box (2 × 2 in)"},
    {v:"roll-50x25",   mode:"roll", w:50,  h:25,  n:"Small reel (2 × 1 in)"},
    {v:"roll-40x30",   mode:"roll", w:40,  h:30,  n:"Bin / rack"},
    {v:"roll-40x25",   mode:"roll", w:40,  h:25,  n:"Bin, short"},
    {v:"roll-38x25",   mode:"roll", w:38,  h:25,  n:"Barcode (1.5 × 1 in)"},
    {v:"roll-35x25",   mode:"roll", w:35,  h:25,  n:"Barcode, narrow"},
    {v:"roll-32x25",   mode:"roll", w:32,  h:25,  n:"Shelf / price"},
    {v:"roll-30x20",   mode:"roll", w:30,  h:20,  n:"Component"},
    {v:"roll-25x25",   mode:"roll", w:25,  h:25,  n:"Core plug (1 × 1 in)"},
    {v:"roll-25x15",   mode:"roll", w:25,  h:15,  n:"Reel-end flag"},
    {v:"roll-25x12",   mode:"roll", w:25,  h:12,  n:"Cable flag"},

    /* --- A4 sheet: NOVAJET self-adhesive MPL stock, the sheets this plant
       actually buys. Product code, label size and the across × down count come
       off the Novajet sheet chart; `cols`/`rows` are the DIE-CUT counts and are
       asserted against sheetGrid() at load (see assertStocks) so a preset can
       never quietly print fewer labels than the sheet holds.

       The margins are CENTRED and the gaps come from Novajet's own pitch
       columns (pitch − label = gap). The chart photo is a 531 px snapshot and
       several of its pitch figures are not legible with certainty; every row
       here is therefore reconciled arithmetically against A4 210 × 297 — margin
       = (page − (n·size + (n−1)·gap)) / 2 — and any row that would not fit is
       refused at load rather than shipped wrong. --- */
    {v:"nj-01P-297", mode:"sheet", nj:"01P", w:210, h:297, cols:1, rows:1, n:"Full sheet, no border",
      page:"A4", mTop:0, mBottom:0, mLeft:0, mRight:0, gapX:0, gapY:0},
    {v:"nj-01P-288", mode:"sheet", nj:"01P", w:210, h:288, cols:1, rows:1, n:"Full sheet",
      page:"A4", mTop:4.5, mBottom:4.5, mLeft:0, mRight:0, gapX:0, gapY:0},
    {v:"nj-02L", mode:"sheet", nj:"02L", w:200, h:146, cols:1, rows:2, n:"Half sheet",
      page:"A4", mTop:2.5, mBottom:2.5, mLeft:5, mRight:5, gapX:0, gapY:0},
    {v:"nj-04P", mode:"sheet", nj:"04P", w:100, h:145, cols:2, rows:2, n:"Quarter sheet",
      page:"A4", mTop:3.25, mBottom:3.25, mLeft:3.5, mRight:3.5, gapX:3, gapY:0.5},
    {v:"nj-06L", mode:"sheet", nj:"06L", w:99, h:93, cols:2, rows:3, n:"Large",
      page:"A4", mTop:4.5, mBottom:4.5, mLeft:3.5, mRight:3.5, gapX:5, gapY:4},
    {v:"nj-08L", mode:"sheet", nj:"08L", w:100, h:72, cols:2, rows:4, n:"Shipping",
      page:"A4", mTop:4.5, mBottom:4.5, mLeft:3.5, mRight:3.5, gapX:3, gapY:0},
    {v:"nj-08LA", mode:"sheet", nj:"08LA", w:90, h:55, cols:2, rows:4, n:"Shipping, small",
      page:"A4", mTop:16, mBottom:16, mLeft:7, mRight:7, gapX:10, gapY:15},
    {v:"nj-12L", mode:"sheet", nj:"12L", w:100, h:44, cols:2, rows:6, n:"Wide",
      page:"A4", mTop:12.5, mBottom:12.5, mLeft:3.5, mRight:3.5, gapX:3, gapY:0},
    {v:"nj-15L", mode:"sheet", nj:"15L", w:61, h:21, cols:3, rows:5, n:"Small, wide",
      page:"A4", mTop:36, mBottom:36, mLeft:10.5, mRight:10.5, gapX:3, gapY:30},
    {v:"nj-16L", mode:"sheet", nj:"16L", w:99, h:34, cols:2, rows:8, n:"Wide, short",
      page:"A4", mTop:12.5, mBottom:12.5, mLeft:4.5, mRight:4.5, gapX:3, gapY:0},
    {v:"nj-18L", mode:"sheet", nj:"18L", w:63.5, h:46.6, cols:3, rows:6, n:"Product",
      page:"A4", mTop:8.7, mBottom:8.7, mLeft:6.75, mRight:6.75, gapX:0, gapY:0},
    {v:"nj-21L", mode:"sheet", nj:"21L", w:63.5, h:38, cols:3, rows:7, n:"Address",
      page:"A4", mTop:15.5, mBottom:15.5, mLeft:6.75, mRight:6.75, gapX:0, gapY:0},
    {v:"nj-22L", mode:"sheet", nj:"22L", w:100, h:24, cols:2, rows:11, n:"Wide, narrow",
      page:"A4", mTop:16.5, mBottom:16.5, mLeft:3.5, mRight:3.5, gapX:3, gapY:0},
    {v:"nj-24L", mode:"sheet", nj:"24L", w:64, h:34, cols:3, rows:8, n:"Address, small",
      page:"A4", mTop:12.5, mBottom:12.5, mLeft:4.5, mRight:4.5, gapX:3, gapY:0},
    {v:"nj-30L", mode:"sheet", nj:"30L", w:67, h:27.5, cols:3, rows:10, n:"Barcode, wide",
      page:"A4", mTop:11, mBottom:11, mLeft:4, mRight:4, gapX:0.5, gapY:0},
    {v:"nj-30P", mode:"sheet", nj:"30P", w:39, h:47.5, cols:5, rows:6, n:"Tall",
      page:"A4", mTop:4.5, mBottom:4.5, mLeft:4.5, mRight:4.5, gapX:1.5, gapY:0},
    {v:"nj-32P", mode:"sheet", nj:"32P", w:25, h:70, cols:8, rows:4, n:"Spine / flag",
      page:"A4", mTop:8.5, mBottom:8.5, mLeft:5, mRight:5, gapX:0, gapY:0},
    {v:"nj-40L", mode:"sheet", nj:"40L", w:39, h:35, cols:5, rows:8, n:"Square-ish",
      page:"A4", mTop:8.5, mBottom:8.5, mLeft:4.5, mRight:4.5, gapX:1.5, gapY:0},
    {v:"nj-40P", mode:"sheet", nj:"40P", w:18, h:73, cols:10, rows:4, n:"Narrow spine",
      page:"A4", mTop:2.5, mBottom:2.5, mLeft:6, mRight:6, gapX:2, gapY:0},
    {v:"nj-48L", mode:"sheet", nj:"48L", w:48, h:24, cols:4, rows:12, n:"Barcode",
      page:"A4", mTop:4.5, mBottom:4.5, mLeft:5, mRight:5, gapX:2, gapY:0},
    {v:"nj-56L", mode:"sheet", nj:"56L", w:48, h:20, cols:4, rows:14, n:"Barcode, short",
      page:"A4", mTop:8.5, mBottom:8.5, mLeft:5, mRight:5, gapX:2, gapY:0},
    {v:"nj-65L", mode:"sheet", nj:"65L", w:38, h:21, cols:5, rows:13, n:"Mini",
      page:"A4", mTop:12, mBottom:12, mLeft:5, mRight:5, gapX:1, gapY:0},
    {v:"nj-84L", mode:"sheet", nj:"84L", w:46, h:11, cols:4, rows:21, n:"Cable flag",
      page:"A4", mTop:13, mBottom:13, mLeft:8.5, mRight:8.5, gapX:3, gapY:2},
    {v:"nj-110L", mode:"sheet", nj:"110L", w:35, h:10, cols:5, rows:22, n:"Mini flag",
      page:"A4", mTop:17.5, mBottom:17.5, mLeft:13.5, mRight:13.5, gapX:2, gapY:2},

    /* --- Novajet CDL — circle and disc stock. ⚠ UNVERIFIED. The circle rows
       on the chart photo are the most degraded of the lot and what can be made
       out does not reconcile: ~116.5 / 117 / 118 mm diameters against codes
       reading 02 / 03 / 06 / 08, and two 117 mm circles are 234 mm on a 210 mm
       sheet. These are therefore the STANDARD Novajet CDL diameters, not the
       chart's, and every one is flagged `unver` so the picker says so out loud.
       Replace with the real figures the moment a legible chart exists. --- */
    {v:"nj-cdl-1", mode:"sheet", nj:"CDL 01", w:116, h:116, cols:1, rows:2, round:true, unver:true, n:"Disc, large",
      page:"A4", mTop:29.5, mBottom:29.5, mLeft:47, mRight:47, gapX:0, gapY:6},
    {v:"nj-cdl-6", mode:"sheet", nj:"CDL 06", w:88, h:88, cols:2, rows:3, round:true, unver:true, n:"Disc",
      page:"A4", mTop:9.5, mBottom:9.5, mLeft:15, mRight:15, gapX:4, gapY:2},
    {v:"nj-cdl-12", mode:"sheet", nj:"CDL 12", w:63, h:63, cols:3, rows:4, round:true, unver:true, n:"Disc, small",
      page:"A4", mTop:19.5, mBottom:19.5, mLeft:9, mRight:9, gapX:1.5, gapY:2},
    {v:"nj-cdl-24", mode:"sheet", nj:"CDL 24", w:40, h:40, cols:4, rows:6, round:true, unver:true, n:"Core / seal",
      page:"A4", mTop:22.5, mBottom:22.5, mLeft:22, mRight:22, gapX:2, gapY:2},
  ];
  /* Every sheet preset names the count its die actually cuts. A preset whose
     geometry does not yield that count is a preset that will silently print a
     short sheet for the rest of its life, so it is caught HERE, at load, and
     reported — never shipped quietly. Roll presets are solved, not declared. */
  function stockProblems(){
    return STOCKS.filter(s=>s.mode==="sheet"&&s.cols&&s.rows).map(s=>{
      const g=sheetGrid(applyStock(cleanDoc({w:s.w,h:s.h}),s.v));
      return (g.cols===s.cols&&g.rows===s.rows) ? null
        : {v:s.v, want:s.cols+"×"+s.rows, got:g.cols+"×"+g.rows};
    }).filter(Boolean);
  }
  /* Millimetres read the way a ruler reads them: 100, not 100.00; 63.5, not 63.5000. */
  const mmS=(v)=>String(Math.round((+v||0)*100)/100);
  const sizeS=(w,h)=>mmS(w)+" × "+mmS(h)+" mm";
  const stockLabel=(s)=>(s.mode==="roll"
    ? "Roll · "+((+s.across||1)>1?(s.across+" up on a "+mmS(s.web||s.w)+" mm web · "):"")
    : "A4 sheet · "+(s.nj?"NJ MPL "+s.nj+" · ":""))+sizeS(s.w,s.h)+(s.n?" — "+s.n:"");
  /* How many of a sheet layout land on one page. COMPUTED, through the same
     sheetGrid() that lays out the printed sheet — see the warning above. */
  function perPageOf(s){
    /* A roll is no longer always one-up — a two-up die puts two across the web
       on every feed, and the card has to say so or the operator reads "1" and
       orders twice the stock. */
    if(s.mode==="roll") return Math.max(1,+s.across||1);
    try{ return sheetGrid(applyStock(cleanDoc({w:s.w,h:s.h}),s.v)).perPage; }
    catch(e){ return 0; }
  }
  function applyStock(d,v){
    const s=STOCKS.find(x=>x.v===v); if(!s) return d;
    d.mode=s.mode; d.w=s.w; d.h=s.h;
    if(s.mode==="roll"){
      /* A roll preset that names no web is a one-up roll: the web IS the
         label, which is what every single-up entry in the list above means. */
      d.rollW=+s.web||s.w; d.across=+s.across||1;
      d.rGapX=+s.rGapX||0; d.rGapY=+s.rGapY||0;
    }
    if(s.mode==="sheet"){
      d.page=s.page; d.landscape=false;
      if(s.af){ d.autoFit=true; applyAutoFit(d); }
      else{
        d.autoFit=false;
        d.mTop=s.mTop; d.mBottom=s.mBottom; d.mLeft=s.mLeft; d.mRight=s.mRight;
        d.gapX=s.gapX; d.gapY=s.gapY;
      }
    }
    return d;
  }
  /* Which preset a design currently matches, so the picker shows the truth
     rather than resetting to the first entry every time the panel repaints. */
  function stockOf(d){
    const near=(a,b)=>Math.abs(a-b)<0.06;
    const s=STOCKS.find(x=>{
      if(x.mode!==d.mode||!near(x.w,d.w)||!near(x.h,d.h)) return false;
      /* A roll is identified by its web and its across-count too, or the
         two-up 50 × 25 and a plain one-up 50 × 25 would read as the same
         stock and picking either would show the other as selected. */
      if(x.mode==="roll") return near(+x.web||x.w,d.rollW)&&
        (+x.across||1)===(d.across||1)&&
        near(+x.rGapX||0,d.rGapX)&&near(+x.rGapY||0,d.rGapY);
      if(x.page!==d.page) return false;
      /* An auto-fit layout is identified by its two sizes and the flag. Its
         margins are solved, so comparing them would only ever be comparing the
         solver against itself. */
      if(x.af) return !!d.autoFit;
      return near(x.gapX,d.gapX)&&near(x.gapY,d.gapY)&&
             near(x.mTop,d.mTop)&&near(x.mLeft,d.mLeft);
    });
    return s?s.v:"";
  }

  const num=(v,d,lo,hi)=>{ v=+v; return isNaN(v)?d:Math.min(hi,Math.max(lo,v)); };
  const int=(v,d,lo,hi)=>{ v=Math.round(+v); return isNaN(v)?d:Math.min(hi,Math.max(lo,v)); };
  const str=(v,d,max)=>String(v==null?d:v).slice(0,max);
  const hex=(v,d)=>/^#[0-9a-fA-F]{6}$/.test(String(v||""))?String(v).toLowerCase():d;
  const IMG_RE=/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;
  const uid=(p)=>p+Math.random().toString(36).slice(2,9);

  /* PRINT ORDER — the four BarTender offers. "Top" and "bottom" are which end
     of the sheet label 1 sits at; "across" and "down" are which way the count
     runs from there. On a roll there is only one row, so the two directions
     collapse and only the start corner has any effect. */
  const ORDERS=[
    {v:"th", l:"Top, across",    d:"Label 1 top-left, counting along each row"},
    {v:"tv", l:"Top, down",      d:"Label 1 top-left, counting down each column"},
    {v:"bh", l:"Bottom, across", d:"Label 1 bottom-left, counting along each row upwards"},
    {v:"bv", l:"Bottom, down",   d:"Label 1 bottom-left, counting up each column"},
  ];

  const OBJ_TYPES=[
    {v:"text",   l:"Text",    ic:"T"},
    {v:"barcode",l:"Barcode", ic:"▍▍"},
    {v:"qr",     l:"QR Code", ic:"▦"},
    {v:"image",  l:"Picture", ic:"🖼"},
    {v:"box",    l:"Box",     ic:"▭"},
    {v:"ellipse",l:"Ellipse", ic:"◯"},
    {v:"line",   l:"Line",    ic:"─"},
  ];

  /* ============================================================
     THE ICON SET

     Line art at a 24-unit grid, one weight, drawn rather than typed.
     The screen used to be lettered in emoji (💾 🖨 ↶), which render
     at a different size, weight and colour on every machine that
     signs in — a Windows 10 tablet in the plant draws none of them
     the way the office laptop does. These are paths: the same shape
     everywhere, and they take the colour of the button they sit in.
     ============================================================ */
  const ICONS={
    /* pointer and the toolbox */
    select:'<path fill="currentColor" stroke="none" d="M6 3.4v14.4l3.5-3.4 2.2 5.2 2.7-1.2-2.3-5.1h4.7z"/>',
    text:'<path d="M5 6.2V4.6h14v1.6M12 4.6v14.8M9 19.4h6"/>',
    richtext:'<path d="M3.5 18.5l4.3-11 4.3 11M5 15h5.6"/><path d="M15.5 8.5h5M15.5 12.5h5M15.5 16.5h5"/>',
    barcode:'<path fill="currentColor" stroke="none" d="M3 5h1.5v14H3zM5.8 5h.8v14h-.8zM8 5h1.8v14H8zM11 5h.9v14H11zM13.3 5h1.6v14h-1.6zM16.3 5h.9v14h-.9zM18.5 5h2v14h-2z"/>',
    qr:'<path d="M3.5 3.5h6.2v6.2H3.5zM14.3 3.5h6.2v6.2h-6.2zM3.5 14.3h6.2v6.2H3.5z"/><path d="M14.3 14.3h2.8v2.8h-2.8zM17.7 17.7h2.8v2.8h-2.8zM14.3 20.5h1.4M20.5 14.3v1.4"/>',
    line:'<path d="M4 19L20 5"/>',
    rect:'<path d="M3.5 6.2h17v11.6h-17z"/>',
    roundrect:'<path d="M6.7 6.2h10.6a3.2 3.2 0 013.2 3.2v5.2a3.2 3.2 0 01-3.2 3.2H6.7a3.2 3.2 0 01-3.2-3.2V9.4a3.2 3.2 0 013.2-3.2z"/>',
    ellipse:'<circle cx="12" cy="12" r="7.7"/>',
    image:'<path d="M5.5 4.6h13a2 2 0 012 2v10.8a2 2 0 01-2 2h-13a2 2 0 01-2-2V6.6a2 2 0 012-2z"/><circle cx="8.7" cy="9.5" r="1.5"/><path d="M4 17l4.6-4.6 3.4 3.4 3.2-3.2L20 17"/>',
    icon:'<circle cx="12" cy="12" r="8.4"/><path d="M12 7.6l1.42 2.9 3.18.46-2.3 2.24.54 3.18L12 14.83l-2.84 1.5.54-3.18-2.3-2.24 3.18-.46z"/>',
    counter:'<circle cx="12" cy="12" r="8.4"/><path d="M9.4 10.4l1.7-1.2v5.8M13.5 9.7a1.8 1.8 0 112.8 2.2L13.4 15h3.2"/>',
    datetime:'<path d="M5.4 5.4h13.2a1.9 1.9 0 011.9 1.9v11.3a1.9 1.9 0 01-1.9 1.9H5.4a1.9 1.9 0 01-1.9-1.9V7.3a1.9 1.9 0 011.9-1.9z"/><path d="M3.5 10h17M8.2 3.4v4M15.8 3.4v4"/>',

    /* clipboard */
    paste:'<path d="M9.4 3.6h5.2v3H9.4z"/><path d="M9.4 5.1H6.8a2 2 0 00-2 2v11.4a2 2 0 002 2h10.4a2 2 0 002-2V7.1a2 2 0 00-2-2h-2.6"/><path d="M8.6 12h6.8M8.6 15.4h4.6"/>',
    cut:'<circle cx="6.6" cy="17.8" r="2.4"/><circle cx="17.4" cy="17.8" r="2.4"/><path d="M8.4 16L18.6 3.8M15.6 16L5.4 3.8"/>',
    copy:'<path d="M9.4 8.4h9.2a1.8 1.8 0 011.8 1.8v9.2a1.8 1.8 0 01-1.8 1.8H9.4a1.8 1.8 0 01-1.8-1.8v-9.2A1.8 1.8 0 019.4 8.4z"/><path d="M16 5.4V4.6a1.8 1.8 0 00-1.8-1.8H5a1.8 1.8 0 00-1.8 1.8v9.2A1.8 1.8 0 005 15.6h.8"/>',
    trash:'<path d="M4.4 6.4h15.2M9.6 6.4V4.2h4.8v2.2M6.4 6.4l1 13.4h9.2l1-13.4M10.2 10v6.2M13.8 10v6.2"/>',

    /* the canvas toolbar */
    open:'<path d="M3.5 18.6V6a1.6 1.6 0 011.6-1.6h3.9l2.1 2.6h7.3A1.6 1.6 0 0120 8.6v10a1 1 0 01-1 1H4.5a1 1 0 01-1-1z"/>',
    newdoc:'<path d="M6 3.6h7.6L19 9v11.4H6z"/><path d="M13.6 3.6V9H19"/>',
    save:'<path d="M5 4.6h11.2L20 8.4v11H5z"/><path d="M8.4 4.6v4.8h7.2V4.6M7.8 19.4v-6.2h8.4v6.2"/>',
    print:'<path d="M7 9.4V4h10v5.4"/><path d="M5.6 9.4h12.8a2 2 0 012 2v5h-3.8v3.6H7.4V16.4H3.6v-5a2 2 0 012-2z"/><path d="M7.4 16.4h9.2"/>',
    undo:'<path d="M4.2 10.4h9.6a5.6 5.6 0 110 11.2H8.6"/><path d="M8.2 5.8L3.6 10.4l4.6 4.6"/>',
    redo:'<path d="M19.8 10.4h-9.6a5.6 5.6 0 100 11.2h5.2"/><path d="M15.8 5.8l4.6 4.6-4.6 4.6"/>',
    zoomin:'<circle cx="10.4" cy="10.4" r="6.6"/><path d="M15.2 15.2L20.6 20.6M7.6 10.4h5.6M10.4 7.6v5.6"/>',
    zoomout:'<circle cx="10.4" cy="10.4" r="6.6"/><path d="M15.2 15.2L20.6 20.6M7.6 10.4h5.6"/>',
    fit:'<path d="M4 9.2V4.4h4.8M15.2 4.4H20v4.8M20 14.8v4.8h-4.8M8.8 19.6H4v-4.8"/>',

    /* paragraph */
    alignleft:'<path d="M4 5.6h16M4 10h10M4 14.4h16M4 18.8h10"/>',
    aligncenter:'<path d="M4 5.6h16M7 10h10M4 14.4h16M7 18.8h10"/>',
    alignright:'<path d="M4 5.6h16M10 10h10M4 14.4h16M10 18.8h10"/>',
    alignjustify:'<path d="M4 5.6h16M4 10h16M4 14.4h16M4 18.8h16"/>',
    valigntop:'<path d="M3.6 4.2h16.8"/><path d="M7.4 8.4h9.2M7.4 12.4h9.2"/>',
    valignmid:'<path d="M7.4 6.6h9.2M3.6 12h16.8M7.4 17.4h9.2"/>',
    valignbot:'<path d="M7.4 11.6h9.2M7.4 15.6h9.2"/><path d="M3.6 19.8h16.8"/>',
    valignfit:'<path d="M3.6 4.2h16.8M3.6 19.8h16.8"/><path d="M12 7.4v9.2M9.6 9.8L12 7.4l2.4 2.4M9.6 14.2L12 16.6l2.4-2.4"/>',
    textdir:'<path d="M4.4 4.6v14.8M4.4 4.6h8.2M4.4 11.6h6"/><path d="M18.4 20.4V7.6M15.9 10.1l2.5-2.5 2.5 2.5"/>',
    wraptext:'<path d="M4 5.8h16M4 11.4h12.4a3.3 3.3 0 010 6.6h-2.6"/><path d="M15.6 15.4L13.2 17.8l2.4 2.4"/><path d="M4 17.8h4.6"/>',

    /* spacing */
    linespacing:'<path d="M9.2 6h10.8M9.2 12h10.8M9.2 18h10.8"/><path d="M4.4 5.4v13.2M2.4 7.4l2-2 2 2M2.4 16.6l2 2 2-2"/>',
    indentless:'<path d="M4 5.6h16M10 10h10M10 14.4h10M4 18.8h16"/><path d="M7.4 9.9L4.2 12.2l3.2 2.3z" fill="currentColor" stroke="none"/>',
    indentmore:'<path d="M4 5.6h16M10 10h10M10 14.4h10M4 18.8h16"/><path d="M4.2 9.9l3.2 2.3-3.2 2.3z" fill="currentColor" stroke="none"/>',
    spacingclear:'<path d="M4 5.6h16M4 12h9.4M4 18.4h16"/><path d="M16.6 9.8l4.4 4.4M21 9.8l-4.4 4.4"/>',

    /* panels and chrome */
    eye:'<path d="M2.6 12S6.1 5.6 12 5.6 21.4 12 21.4 12 17.9 18.4 12 18.4 2.6 12 2.6 12z"/><circle cx="12" cy="12" r="2.9"/>',
    eyeoff:'<path d="M4 4l16 16"/><path d="M9.7 6.2A9.6 9.6 0 0112 5.6c5.9 0 9.4 6.4 9.4 6.4a17.3 17.3 0 01-3.3 4M6.8 8.1A17.2 17.2 0 002.6 12S6.1 18.4 12 18.4a9.5 9.5 0 003.4-.6"/><path d="M9.9 9.9a3 3 0 004.2 4.2"/>',
    close:'<path d="M6.4 6.4l11.2 11.2M17.6 6.4L6.4 17.6"/>',
    plus:'<path d="M12 5.4v13.2M5.4 12h13.2"/>',
    chev:'<path d="M7 10l5 5 5-5"/>',
    prompt:'<path d="M4.6 4.6h14.8a1.7 1.7 0 011.7 1.7v8.4a1.7 1.7 0 01-1.7 1.7h-8.6L6 20v-3.6H4.6a1.7 1.7 0 01-1.7-1.7V6.3a1.7 1.7 0 011.7-1.7z"/><path d="M9.9 8.8a2.1 2.1 0 113.2 2.4l-1.1.9v.9M12 14.4v.1"/>',
    panelleft:'<path d="M4 5.2h16a.8.8 0 01.8.8v12a.8.8 0 01-.8.8H4a.8.8 0 01-.8-.8V6a.8.8 0 01.8-.8z"/><path d="M9.4 5.2v13.6"/>',
    panelright:'<path d="M4 5.2h16a.8.8 0 01.8.8v12a.8.8 0 01-.8.8H4a.8.8 0 01-.8-.8V6a.8.8 0 01.8-.8z"/><path d="M14.6 5.2v13.6"/>',
    panelrule:'<path d="M4 5.2h16a.8.8 0 01.8.8v12a.8.8 0 01-.8.8H4a.8.8 0 01-.8-.8V6a.8.8 0 01.8-.8z"/><path d="M3.2 9.4h17.6M8 5.2v13.6"/>',
    full:'<path d="M4 8.8V4.4h4.4M15.6 4.4H20v4.4M20 15.2v4.4h-4.4M8.4 19.6H4v-4.4"/>',
    grid:'<path d="M3.6 3.6h16.8v16.8H3.6z"/><path d="M9.2 3.6v16.8M14.8 3.6v16.8M3.6 9.2h16.8M3.6 14.8h16.8"/>',
  };
  /* Built through innerHTML on an HTML span rather than createElementNS: the
     namespace-aware path is the one older WebKit builds get wrong, and this
     screen is opened on tablets in the plant. */
  function ico(name,size){
    const s=size||16;
    const w=h("span",{class:"ls-ic","aria-hidden":"true"});
    w.innerHTML='<svg viewBox="0 0 24 24" width="'+s+'" height="'+s+'" fill="none" '+
      'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" '+
      'stroke-linejoin="round">'+(ICONS[name]||"")+'</svg>';
    return w;
  }

  /* ============================================================
     THE TOOLBOX, AS THE DESIGNER LISTS IT

     `t` is the document object the tool makes; `extra` is what makes
     one tool different from another of the same type — a Counter and
     a Date/Time field are both text, and the difference between them
     IS the data source, not a second kind of object.
     ============================================================ */
  const TOOLS=[
    {v:"select",   l:"Select"},
    {v:"text",     l:"Text",              t:"text"},
    {v:"richtext", l:"Rich Text",         t:"text",  extra:{rich:true}},
    {v:"barcode",  l:"Barcode",           t:"barcode"},
    {v:"qr",       l:"QR Code",           t:"qr"},
    {v:"line",     l:"Line",              t:"line"},
    {v:"rect",     l:"Rectangle",         t:"box"},
    {v:"roundrect",l:"Rounded Rectangle", t:"box",   extra:{radius:2}},
    {v:"ellipse",  l:"Ellipse",           t:"ellipse"},
    {v:"image",    l:"Image",             t:"image"},
    {v:"icon",     l:"Icon",              t:"text",  extra:{icon:true}},
    {v:"counter",  l:"Counter",           t:"text",  extra:{src:{kind:"serial",start:1,step:1,pad:6}}},
    {v:"datetime", l:"Date / Time",       t:"text",  extra:{src:{kind:"date",fmt:"DD.MM.YYYY"}}},
  ];
  /* The glyphs the Icon tool offers. Not decoration — these are the marks a
     tape-converting plant is required to put on a carton. */
  const GLYPHS=["⚠","♻","☂","⇧","✆","✉","✓","✕","★","●","▲","■","℃","⌀","№","®","™","CE"];

  function newObject(type,doc){
    const cx=Math.max(2,doc.w/2-15), cy=Math.max(2,doc.h/2-6);
    const base={id:uid("o_"),type,x:+cx.toFixed(1),y:+cy.toFixed(1),rot:0,
      src:{kind:"fixed",prefix:"",suffix:""}};
    if(type==="text")    return Object.assign(base,{w:Math.min(60,doc.w-4),h:8,text:"Text",
      font:"times",size:4,bold:false,italic:false,underline:false,strike:false,
      align:"left",valign:"middle",color:"#000000",lineH:1.25,shrink:true,
      tcase:"none",shade:"",indentL:0,indentR:0});
    if(type==="barcode") return Object.assign(base,{w:Math.min(60,doc.w-4),h:18,text:"12345678",
      sym:"code128",color:"#000000",showText:true,font:"arial",size:3});
    if(type==="qr")      return Object.assign(base,{w:24,h:24,text:"https://www.chhaperiatapes.com",
      sym:"qr",ecl:"M",color:"#000000",showText:false,font:"arial",size:3});
    if(type==="image")   return Object.assign(base,{w:30,h:20,data:"",fit:"contain"});
    if(type==="line")    return Object.assign(base,{w:Math.min(60,doc.w-4),h:0.6,
      stroke:"#000000",strokeW:0.6});
    return Object.assign(base,{w:40,h:20,fill:"",stroke:"#000000",strokeW:0.4,radius:0});
  }

  function cleanObject(o,doc){
    if(!o||typeof o!=="object") return null;
    const t=OBJ_TYPES.some(x=>x.v===o.type)?o.type:"text";
    const W=doc.w||100, H=doc.h||100;
    const r={id:/^o_[a-z0-9]{1,12}$/.test(String(o.id||""))?o.id:uid("o_"), type:t,
      x:num(o.x,0,-W,W*2), y:num(o.y,0,-H,H*2),
      w:num(o.w,10,0.2,W*3), h:num(o.h,10,0.05,H*3),
      rot:[0,90,180,270].indexOf(int(o.rot,0,0,270))>=0?int(o.rot,0,0,270):num(o.rot,0,-360,360),
      /* The eye in Object Layers. A hidden object is hidden EVERYWHERE — on the
         canvas and on the sheet — because an eye that only closed on screen
         would let you print something you had every reason to think was gone. */
      hidden:!!o.hidden};
    const s=o.src||{};
    const kind=["fixed","date","serial","prompt"].indexOf(s.kind)>=0?s.kind:"fixed";
    r.src={kind, prefix:str(s.prefix,"",40), suffix:str(s.suffix,"",40),
      fmt:str(s.fmt,"DD.MM.YYYY",40),
      start:int(s.start,1,0,999999999), step:int(s.step,1,1,10000), pad:int(s.pad,0,0,12),
      prompt:str(s.prompt,"",40), def:str(s.def,"",120)};
    if(t==="text"||t==="barcode"||t==="qr"){
      r.text=str(o.text,"",600);
      /* The fallback matches the DEFAULT, so a font that has gone missing from
         a saved design lands where a new one would rather than somewhere else.
         Text is set in Times; the human-readable line under a barcode stays
         sans, which is the convention every scanner label follows. */
      r.font=FONTS.some(f=>f.v===o.font)?o.font:(t==="text"?"times":"arial");
      r.size=num(o.size,4,0.6,120);
      r.color=hex(o.color,"#000000");
    }
    if(t==="text"){
      r.bold=!!o.bold; r.italic=!!o.italic;
      r.underline=!!o.underline; r.strike=!!o.strike;
      r.align=["left","center","right","justify"].indexOf(o.align)>=0?o.align:"left";
      r.valign=["start","middle","end"].indexOf(o.valign)>=0?o.valign:"middle";
      r.lineH=num(o.lineH,1.25,.8,3); r.shrink=o.shrink!==false;
      /* Word's Wrap Text. Off, the line runs on and is clipped by the box —
         which is what a one-line caption on a 25 mm flag wants. */
      r.wrap=o.wrap!==false;
      /* Word's "Change Case". A transform, not a rewrite: the data source keeps
         whatever it actually is, so a serial still counts and a prompt still
         reads back the way it was typed. */
      r.tcase=["none","upper","lower","title"].indexOf(o.tcase)>=0?o.tcase:"none";
      /* Word's paint bucket. "" is no shading at all, which is not the same as
         white — a white band on a white label is invisible but still prints. */
      r.shade=hex(o.shade,"");
      r.indentL=num(o.indentL,0,0,200); r.indentR=num(o.indentR,0,0,200);
    }
    if(t==="barcode"||t==="qr"){
      r.sym=SYMS.some(x=>x.v===o.sym)?o.sym:(t==="qr"?"qr":"code128");
      if(t==="qr") r.sym="qr";
      r.showText=!!o.showText;
      r.ecl=["L","M","Q","H"].indexOf(o.ecl)>=0?o.ecl:"M";
    }
    if(t==="image"){
      r.data=(typeof o.data==="string"&&o.data.length<=MAX_IMG&&IMG_RE.test(o.data))?o.data:"";
      r.fit=["contain","cover","fill"].indexOf(o.fit)>=0?o.fit:"contain";
    }
    if(t==="line"){ r.stroke=hex(o.stroke,"#000000"); r.strokeW=num(o.strokeW,.6,.05,20); }
    if(t==="box"||t==="ellipse"){
      r.fill=hex(o.fill,""); r.stroke=hex(o.stroke,"#000000");
      r.strokeW=num(o.strokeW,.4,0,20); r.radius=num(o.radius,0,0,100);
    }
    return r;
  }

  function newDoc(name){
    return cleanDoc({id:uid("d_"),name:name||"New Label",w:100,h:60,objects:[]});
  }
  function cleanDoc(d){
    d=d||{};
    const o={
      id:/^d_[a-z0-9]{1,12}$/.test(String(d.id||""))?d.id:uid("d_"),
      name:str(d.name,"Label",60) || "Label",
      w:num(d.w,100,5,1000), h:num(d.h,60,5,1000),
      bg:hex(d.bg,"#ffffff"),
      /* A background PICTURE on the label itself — a pre-printed sleeve, a
         company watermark, a die-cut artwork the fields are laid over. Held
         inside the template like any other picture, and validated the same
         way: a data URL of a known raster type, under the size cap. */
      bgImage:(typeof d.bgImage==="string"&&d.bgImage.length<=MAX_IMG&&IMG_RE.test(d.bgImage))
        ?d.bgImage:"",
      /* How the picture sits on the label. "custom" is the one that can be
         adjusted: it carries its own position and size in millimetres and is
         dragged on the canvas like anything else. */
      bgFit:["cover","contain","fill","tile","custom"].indexOf(d.bgFit)>=0?d.bgFit:"cover",
      bgX:num(d.bgX,0,-2000,2000), bgY:num(d.bgY,0,-2000,2000),
      /* 0 means "as big as the label" — a size that follows the label when the
         stock changes, rather than a number left over from the old one. */
      bgW:num(d.bgW,0,0,2000), bgH:num(d.bgH,0,0,2000),
      /* A watermark under the type is the whole point of most background
         pictures, and a watermark at full strength is a picture. */
      bgOpacity:num(d.bgOpacity,100,5,100),
      /* A NEW label is cut with rounded corners, because that is how label
         stock is actually die-cut — a square corner lifts and catches. Only a
         label that has never been given a shape gets this: every design
         already saved carries its own, so nothing in the library moves. */
      shape:["rect","round","ellipse"].indexOf(d.shape)>=0?d.shape:"round",
      radius:num(d.radius,3,0,100),
      border:!!d.border, borderC:hex(d.borderC,"#000000"), borderW:num(d.borderW,.3,.05,10),
      grid:num(d.grid,2,.5,20), snap:d.snap!==false,
      /* Sheet or roll. A roll is what a label printer wants — but it is NOT
         always one label per page. The plant runs a 100 mm web and dies two
         50 × 25 labels across it with no gap between them, so the web, how
         many sit across it and the two gaps are all real numbers a roll
         carries. One-up is just across=1. */
      mode:d.mode==="roll"?"roll":"sheet",
      /* The web: the width of the roll as it is bought, which the labels are
         die-cut out of. Independent of the label width — that is the whole
         point of a multi-up roll. */
      rollW:num(d.rollW,100,5,1000),
      /* How many labels sit across the web. 0 = work it out from the web and
         the label, which is what an operator means by "fit what fits". */
      across:int(d.across,0,0,50),
      /* The roll's OWN gaps, deliberately not the sheet's gapX/gapY. Those two
         default to 3 mm, and a roll printed before this existed carried that
         default while the printer ignored it — reusing them would have made
         every saved roll template silently 3 mm taller on its next print. */
      rGapX:num(d.rGapX,0,0,100), rGapY:num(d.rGapY,0,0,100),
      page:PAGES.some(p=>p.v===d.page)?d.page:"A4",
      pageW:num(d.pageW,210,20,1000), pageH:num(d.pageH,297,20,1000),
      landscape:!!d.landscape,
      mTop:num(d.mTop,8,0,200), mBottom:num(d.mBottom,8,0,200),
      mLeft:num(d.mLeft,8,0,200), mRight:num(d.mRight,8,0,200),
      gapX:num(d.gapX,3,0,100), gapY:num(d.gapY,3,0,100),
      /* Auto-fit solves the margins and gaps from the label and page size, so
         the sheet holds as many as it physically can and they sit evenly. */
      autoFit:!!d.autoFit,
      /* Which die-cut gets label 1, and where 2 goes from there. BarTender's
         four, and they are not cosmetic: a run of serials peeled off in the
         wrong direction goes onto the drums in the wrong order, and nobody
         finds out until the despatch note disagrees with the stack. */
      printOrder:ORDERS.some(o=>o.v===d.printOrder)?d.printOrder:"th",
      copies:int(d.copies,1,1,500), qty:int(d.qty,1,1,5000),
      updated:str(d.updated,"",30),
      /* When this template was last opened or saved. `updated` is a DATE and
         everything saved today sorts equal, which is no use for a "recent"
         list — this is the full instant, and it is what Recent reads. */
      usedAt:str(d.usedAt,"",40),
    };
    o.objects=(Array.isArray(d.objects)?d.objects:[]).slice(0,MAX_OBJ)
      .map(x=>cleanObject(x,o)).filter(Boolean);
    return o;
  }

  /* ---- storage: the ERP's settings document, never a local file ---- */
  function loadDocs(){
    const raw=(ENG.data.settings&&ENG.data.settings.labelDocs)||[];
    return (Array.isArray(raw)?raw:[]).slice(0,MAX_DOCS).map(cleanDoc);
  }
  function saveDocs(docs){
    const clean=docs.slice(0,MAX_DOCS).map(cleanDoc);
    ENG.data.settings=Object.assign({},ENG.data.settings,{labelDocs:clean});
    try{ const p=DB.saveSettings({labelDocs:clean}); if(p&&p.catch) p.catch(()=>{}); }catch(e){}
    return clean;
  }

  /* ============================================================
     SECTION 5 — DATA SOURCES
     What a field actually says at the moment of printing.
     ============================================================ */
  function fmtDate(dt,f){
    const p2=(n)=>String(n).padStart(2,"0");
    const MON=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    return String(f||"DD.MM.YYYY").replace(/YYYY|YY|MMM|MM|DD|HH|mm|ss/g,(t)=>({
      YYYY:String(dt.getFullYear()), YY:p2(dt.getFullYear()%100), MMM:MON[dt.getMonth()],
      MM:p2(dt.getMonth()+1), DD:p2(dt.getDate()),
      HH:p2(dt.getHours()), mm:p2(dt.getMinutes()), ss:p2(dt.getSeconds())}[t]));
  }
  function srcValue(o,ctx){
    const s=o.src||{kind:"fixed"};
    let v="";
    if(s.kind==="date") v=fmtDate(ctx.now||new Date(), s.fmt);
    else if(s.kind==="serial"){
      const start=(ctx.serialStart!=null&&ctx.serialStart!=="")?+ctx.serialStart:(+s.start||0);
      const n=start+(ctx.index||0)*(+s.step||1);
      v=String(n); if(s.pad>0) v=v.padStart(s.pad,"0");
    }
    else if(s.kind==="prompt"){
      const key=s.prompt||"Value";
      v=(ctx.prompts&&ctx.prompts[key]!=null&&ctx.prompts[key]!=="")?String(ctx.prompts[key]):(s.def||"");
    }
    else v=o.text||"";
    return (s.prefix||"")+v+(s.suffix||"");
  }
  /* Every distinct prompt on the label, so the print step can ask for each
     one exactly once however many objects read it. */
  function promptsOf(doc){
    const seen=[];
    doc.objects.forEach(o=>{
      if(o.src&&o.src.kind==="prompt"){
        const k=o.src.prompt||"Value";
        if(!seen.some(p=>p.key===k)) seen.push({key:k, def:o.src.def||""});
      }
    });
    return seen;
  }

  /* ============================================================
     SECTION 6 — RENDERING
     ONE generator behind the canvas, the preview and the printer,
     so what the operator drags is what leaves the tray.
     ============================================================ */
  function objHtml(o,ctx){
    const mm=(n)=>(+n).toFixed(2)+"mm";
    const rot=o.rot?`transform:rotate(${o.rot}deg);`:"";
    const box=`position:absolute;left:${mm(o.x)};top:${mm(o.y)};width:${mm(o.w)};height:${mm(o.h)};`+rot;
    /* Every object carries its id into the render, so the designer can find
       the RENDERED node and measure it — the only honest way to answer "does
       this fit". An attribute on a div; the printed sheet is none the wiser. */
    const tag=` data-i="${esc(o.id)}"`;
    const val=srcValue(o,ctx||{});
    if(o.type==="text"){
      const fw=o.bold?"700":"400", fi=o.italic?"italic":"normal";
      const just=o.align==="center"?"center":o.align==="right"?"flex-end":"flex-start";
      /* Word's Font group, as far as a label can honour it. Underline and
         strike are one declaration; CASE is a transform rather than a rewrite
         of the value, so the data source underneath is left alone and a serial
         still serialises. Shading is the paragraph fill — Word's paint bucket —
         and is what gives you white text in a solid black band. */
      const deco=[o.underline?"underline":"",o.strike?"line-through":""].filter(Boolean).join(" ");
      const tc=o.tcase&&o.tcase!=="none"
        ? "text-transform:"+(o.tcase==="upper"?"uppercase":o.tcase==="lower"?"lowercase":"capitalize")+";"
        : "";
      const shade=o.shade?`background:${o.shade};`:"";
      const pad=(o.indentL||o.indentR)
        ? `padding-left:${mm(o.indentL||0)};padding-right:${mm(o.indentR||0)};` : "";
      /* data-i lets the designer find this object's RENDERED node and measure
         it — which is the only honest way to answer "does this text fit". It
         is an attribute on a div, so it costs the printed sheet nothing. */
      return `<div${tag} style="${box}display:flex;align-items:${o.valign==="start"?"flex-start":o.valign==="end"?"flex-end":"center"};`+
        `justify-content:${just};${shade}overflow:hidden">`+
        `<div style="width:100%;text-align:${o.align};font:${fi} ${fw} ${mm(o.size)}/${o.lineH} ${fontCss(o.font)};`+
        `color:${o.color};${tc}${pad}${deco?"text-decoration:"+deco+";":""}`+
        (o.wrap===false?`white-space:pre;overflow-wrap:normal`
                       :`white-space:pre-wrap;overflow-wrap:anywhere`)+
        `">${esc(val)}</div></div>`;
    }
    if(o.type==="barcode"||o.type==="qr"){
      const is2d=o.type==="qr"||o.sym==="qr";
      const r=is2d?qrSvg(val,o.color,o.ecl):barcodeSvg(o.sym,val,o.color);
      if(!r) return `<div${tag} style="${box}display:flex;align-items:center;justify-content:center;`+
        `border:.2mm dashed #b02a2a;color:#b02a2a;font:600 ${mm(Math.min(3,o.h/3))}/1.2 Arial,sans-serif;`+
        `text-align:center;padding:.5mm;overflow:hidden">${esc(val?"Not valid for "+o.sym:"No data")}</div>`;
      const cap=o.showText
        ? `<div style="flex:0 0 auto;text-align:center;font:400 ${mm(o.size)}/1.15 ${fontCss(o.font)};`+
          `color:${o.color};padding-top:.4mm;letter-spacing:.06em;overflow:hidden">${esc(r.text)}</div>`
        : "";
      return `<div${tag} style="${box}display:flex;flex-direction:column;overflow:hidden">`+
        `<div style="flex:1 1 auto;min-height:0;position:relative">${r.svg}</div>${cap}</div>`;
    }
    if(o.type==="image"){
      if(!o.data) return `<div${tag} style="${box}display:flex;align-items:center;justify-content:center;`+
        `border:.2mm dashed #999;color:#999;font:400 3mm/1.2 Arial,sans-serif">No picture</div>`;
      return `<img${tag} src="${o.data}" alt="" style="${box}object-fit:${o.fit}">`;
    }
    if(o.type==="line"){
      return `<div${tag} style="${box}background:${o.stroke};height:${mm(Math.max(o.strokeW,.05))}"></div>`;
    }
    const rad=o.type==="ellipse"?"border-radius:50%;":(o.radius?`border-radius:${mm(o.radius)};`:"");
    const bd=o.strokeW>0?`border:${mm(o.strokeW)} solid ${o.stroke};`:"";
    return `<div${tag} style="${box}${rad}${bd}background:${o.fill||"transparent"}"></div>`;
  }

  /* ============================================================
     THE BACKGROUND PICTURE — a real layer, not a CSS background.

     It used to be `background-image` on the label itself. That was
     enough to SHOW a picture and no use at all for working with
     one: a CSS background cannot be faded (so no watermark under
     the type), cannot be given a position and a size in millimetres
     without fighting the shorthand, and cannot be dragged, because
     there is no element to take hold of.

     So it is an element: first in the label, under every object,
     with its own position, size and opacity. The canvas draws it
     through the SAME generator as the printer — which is why
     adjusting it on the canvas is adjusting what will be printed.
     ============================================================ */
  function bgHtml(doc){
    if(!doc.bgImage) return "";
    const mm=(n)=>(+n).toFixed(2)+"mm";
    const op=Math.max(5,Math.min(100,+doc.bgOpacity||100))/100;
    /* ⚠ SINGLE quotes inside url() — this whole string becomes a style="…"
       ATTRIBUTE, and a double quote would close it early. See the note on the
       font stacks for the day that cost. A data URL never contains one. */
    const img=`background-image:url('${doc.bgImage}');`;
    if(doc.bgFit==="custom"){
      const w=doc.bgW>0?doc.bgW:doc.w, hh=doc.bgH>0?doc.bgH:doc.h;
      return `<div style="position:absolute;left:${mm(doc.bgX)};top:${mm(doc.bgY)};`+
        `width:${mm(w)};height:${mm(hh)};opacity:${op};${img}`+
        `background-size:100% 100%;background-repeat:no-repeat"></div>`;
    }
    const size=doc.bgFit==="fill"?"100% 100%"
             :doc.bgFit==="contain"?"contain"
             :doc.bgFit==="tile"?"auto":"cover";
    return `<div style="position:absolute;left:0;top:0;width:100%;height:100%;`+
      `opacity:${op};${img}background-size:${size};background-position:center;`+
      `background-repeat:${doc.bgFit==="tile"?"repeat":"no-repeat"}"></div>`;
  }
  /* A label's SKIN — everything about it that is not its size: the stock
     colour, the die shape, the cut border. Split out from labelCss so a sheet
     can carry several designs at once: they share one size, so they share the
     .lbl box, and each brings its own skin. */
  function labelSkinCss(doc,cls){
    const rad=doc.shape==="ellipse"?"50%":doc.shape==="round"?(doc.radius+"mm"):"0";
    const bd=doc.border?`box-shadow:inset 0 0 0 ${doc.borderW}mm ${doc.borderC};`:"";
    return `.${cls}{background:${doc.bg};border-radius:${rad};${bd}}`;
  }
  function labelBoxCss(doc){
    return `.lbl{position:relative;width:${doc.w}mm;height:${doc.h}mm;overflow:hidden;`+
      `-webkit-print-color-adjust:exact;print-color-adjust:exact}`;
  }
  function labelCss(doc){
    return labelBoxCss(doc)+"\n  "+labelSkinCss(doc,"lbl");
  }
  /* Two designs may share a sheet only if they are cut the same. Everything
     else about them may differ — the colour, the shape, what is on them. */
  function sameStock(a,b){
    if(!a||!b) return false;
    const near=(p,q)=>Math.abs(p-q)<0.06;
    if(a.mode!==b.mode||!near(a.w,b.w)||!near(a.h,b.h)) return false;
    if(a.mode==="roll") return true;
    return a.page===b.page&&near(a.mTop,b.mTop)&&near(a.mLeft,b.mLeft)&&
           near(a.gapX,b.gapX)&&near(a.gapY,b.gapY);
  }
  /* ctx.skip — ONE object left out of this render, for the designer to use
     while that object is being typed on: the editor draws it instead, and
     drawing it twice would show the text doubled and slightly offset. The
     print path never sets it, so a printed label always carries everything. */
  function labelInner(doc,ctx){
    const skip=ctx&&ctx.skip;
    return bgHtml(doc)+
      doc.objects.filter(o=>!o.hidden&&o.id!==skip).map(o=>objHtml(o,ctx)).join("");
  }
  function labelHtml(doc,ctx){
    return `<div class="lbl">${labelInner(doc,ctx)}</div>`;
  }

  function pageMM(doc){
    const p=PAGES.find(x=>x.v===doc.page)||PAGES[0];
    const w=p.v==="custom"?doc.pageW:p.w, hh=p.v==="custom"?doc.pageH:p.h;
    return doc.landscape?{w:hh,h:w}:{w:w,h:hh};
  }
  /* How many labels a sheet holds. Computed, never typed: the operator
     sets the label size and the margins, and the grid is whatever fits —
     so a sheet can never be configured to clip its own last column.

     ⚠ THE ROUNDING IS NOT OPTIONAL. Die-cut stock divides its page exactly:
     an A4 8-up label is 67.7 mm tall with 13.1 mm margins, and 297-13.1-13.1
     is 270.79999999999995 in binary floating point while 67.7×4 is 270.8. The
     naive floor() therefore answers 3 rows, and a sheet that holds 8 labels
     prints 6 — quietly, on every run, for the rest of its life. Rounding the
     RATIO to six places absorbs that error (a millionth of a label) while
     still refusing a label that genuinely overhangs by any real amount. */
  function fitCount(inner,size,gap){
    if(size<=0) return 0;
    return Math.max(0,Math.floor(+((inner+gap)/(size+gap)).toFixed(6)));
  }
  /* ---- AUTO-FIT ----
     "How many fit, and where exactly do they sit?" answered by arithmetic
     instead of by an operator with a ruler. Fit as many whole labels as the
     page physically holds outside a 4 mm unprintable edge, then share every
     millimetre that is left over equally between the margins and the gaps —
     so the sheet is centred and the columns are evenly spaced, which is what
     anyone laying out labels by hand is trying to achieve anyway.
     A gap wider than 10 mm looks like a mistake rather than a layout, so the
     surplus past that is pushed back out into the margins. */
  const AF_EDGE=4, AF_MAXGAP=10;
  function autoFitOf(doc){
    const pg=pageMM(doc);
    /* Millimetres are reported to two places, so the solved figures are floored
       to two places as well — rounding a margin UP would eat the very column it
       was placed to make room for. Then the answer is checked against the same
       fitCount() the printer uses, and the margin shaved until it agrees: a
       layout that claims a column it cannot print is the one thing this must
       never do. */
    const f2=(v)=>Math.floor(v*100)/100;
    const solve=(page,size)=>{
      const n=Math.max(1,Math.floor(+((page-AF_EDGE*2)/size).toFixed(6)));
      const gap=n>1?f2(Math.min(AF_MAXGAP,(page-n*size)/(n+1))):0;
      let margin=f2((page-n*size-gap*(n-1))/2);
      for(let i=0;i<6&&margin>0&&fitCount(page-margin*2,size,gap)<n;i++) margin=f2(margin-0.05);
      return {n:Math.min(n,fitCount(page-Math.max(0,margin)*2,size,gap)),
              gap, margin:Math.max(0,margin)};
    };
    const x=solve(pg.w,doc.w), y=solve(pg.h,doc.h);
    return {mLeft:x.margin,mRight:x.margin,gapX:x.gap,
            mTop:y.margin,mBottom:y.margin,gapY:y.gap,cols:x.n,rows:y.n};
  }
  /* Applied into the document, so what auto-fit worked out is what gets saved,
     printed and shown in the margin boxes — never a hidden second answer. */
  function applyAutoFit(doc){
    if(doc.mode!=="sheet"||!doc.autoFit) return doc;
    const a=autoFitOf(doc);
    doc.mLeft=a.mLeft; doc.mRight=a.mRight; doc.gapX=a.gapX;
    doc.mTop=a.mTop; doc.mBottom=a.mBottom; doc.gapY=a.gapY;
    return doc;
  }

  /* A roll's "page" is ONE ROW ACROSS THE WEB, and its height is the label
     plus the gap the die leaves before the next one. That is what actually
     comes off a thermal printer: the feed advances by the pitch, so making the
     page the pitch is what puts the gap on the stock instead of inside the
     artwork. Width is the web, never the label — on a two-up 100 mm web the
     label is 50 and the page is still 100.
     `across` 0 means "as many as fit", solved through the same fitCount() the
     sheet uses, so a roll can never claim a column it cannot print either. */
  function rollGrid(doc){
    const web=Math.max(doc.w,+doc.rollW||doc.w);
    const gx=+doc.rGapX||0, gy=+doc.rGapY||0;
    const cols=doc.across>0
      ? Math.max(1,Math.min(doc.across,fitCount(web,doc.w,gx)||1))
      : Math.max(1,fitCount(web,doc.w,gx));
    return {cols,rows:1,perPage:cols,pgW:web,pgH:doc.h+gy,
            innerW:web,innerH:doc.h};
  }
  /* Sequence position → grid position, for the four print orders. Returns a
     function rather than an array so the caller can ask about one label at a
     time — the print preview numbers the die-cuts with exactly this, so the
     numbers drawn on screen and the labels on the sheet cannot disagree. */
  function orderSlot(doc,g){
    const C=Math.max(1,g.cols), R=Math.max(1,g.rows);
    const ord=ORDERS.some(o=>o.v===doc.printOrder)?doc.printOrder:"th";
    if(ord==="tv") return (i)=>{ const col=Math.floor(i/R), row=i%R; return row*C+col; };
    if(ord==="bh") return (i)=>{ const row=R-1-Math.floor(i/C), col=i%C; return row*C+col; };
    if(ord==="bv") return (i)=>{ const col=Math.floor(i/R), row=R-1-(i%R); return row*C+col; };
    return (i)=>i;
  }

  function sheetGrid(doc){
    if(doc.mode==="roll") return rollGrid(doc);
    if(doc.autoFit) applyAutoFit(doc);
    const pg=pageMM(doc);
    const innerW=pg.w-doc.mLeft-doc.mRight, innerH=pg.h-doc.mTop-doc.mBottom;
    const cols=fitCount(innerW,doc.w,doc.gapX);
    const rows=fitCount(innerH,doc.h,doc.gapY);
    return {cols,rows,perPage:cols*rows,pgW:pg.w,pgH:pg.h,innerW,innerH};
  }

  /* How a run falls across pages, once, so the print dialog's page count and
     the sheet it actually prints can never disagree. `skip` leaves the first
     N die-cuts of the FIRST page empty — see sheetHtml. */
  function paginate(doc,total,skip){
    const per=Math.max(1,sheetGrid(doc).perPage);
    const sk=doc.mode==="roll"?0:Math.max(0,Math.min(per-1,Math.round(+skip||0)));
    const first=Math.max(1,per-sk);
    if(total<=first) return {per,skip:sk,first,pages:1};
    return {per,skip:sk,first,pages:1+Math.ceil((total-first)/per)};
  }

  function sheetHtml(doc,ctxs,opts){
    opts=opts||{};
    const g=sheetGrid(doc);
    const per=Math.max(1,g.perPage);
    /* A PART-USED SHEET. Six of the twenty-four are already peeled off, so the
       run has to start at position seven or it prints onto backing paper and
       the sheet is thrown away. The skipped positions are real empty cells in
       the same grid — not a margin — so every label after them still lands on
       its own die-cut. */
    const pg=paginate(doc,ctxs.length,opts.skip);
    const chunks=[];
    chunks.push({blanks:pg.skip, cells:ctxs.slice(0,pg.first)});
    for(let i=pg.first;i<ctxs.length;i+=per) chunks.push({blanks:0, cells:ctxs.slice(i,i+per)});
    let use=opts.onlyPage!=null
      ?[chunks[Math.min(opts.onlyPage,chunks.length-1)]||{blanks:0,cells:[]}]
      :chunks;
    /* A PAGE RANGE. One sheet of twenty-four came out smudged; reprinting the
       whole run to replace it wastes the other pages and burns the serials
       twice. The numbers are 1-based because that is how the operator counts
       the sheets in their hand. */
    if(opts.onlyPage==null&&(opts.from||opts.to)){
      const lo=Math.max(1,Math.min(chunks.length,Math.round(+opts.from||1)));
      const hi=Math.max(lo,Math.min(chunks.length,Math.round(+opts.to||chunks.length)));
      use=chunks.slice(lo-1,hi);
    }
    const cut=!!opts.cut&&doc.mode!=="roll";
    /* The grid always fills in reading order, so the print order is applied by
       deciding WHICH die-cut each label in the run lands on rather than by
       reordering the grid. `skip` counts as consumed positions, so a part-used
       sheet starts where the operator says it does in whatever direction the
       run is numbered. */
    const slotOf=orderSlot(doc,g);
    const perSlots=Math.max(1,g.perPage);
    const pages=use.map(c=>{
      const slots=new Array(perSlots).fill(null);
      c.cells.forEach((ctx,i)=>{
        const p=slotOf(i+c.blanks);
        if(p>=0&&p<perSlots) slots[p]=ctx;
      });
      return `<div class="pg${cut?" cut":""}">`+
        slots.map(ctx=>ctx?labelHtml(doc,ctx):`<div class="sk"></div>`).join("")+`</div>`;
    }).join("");
    const roll=doc.mode==="roll";
    /* A multi-up roll still has to place its labels ON the web. The die leaves
       the vertical gap SPLIT above and below — half of it on each page — so
       consecutive pages meet at exactly one full gap and the label sits in the
       middle of its pitch, which is what the die actually cuts. Across the web
       the row is centred in whatever is left over. */
    const rPadY=roll?(+doc.rGapY||0)/2:0;
    const rPadX=roll
      ? Math.max(0,(g.pgW-(g.cols*doc.w+(g.cols-1)*(+doc.rGapX||0)))/2)
      : 0;
    const padT=roll?rPadY:doc.mTop,   padB=roll?rPadY:doc.mBottom;
    const padL=roll?rPadX:doc.mLeft,  padR=roll?rPadX:doc.mRight;
    const colGap=roll?(+doc.rGapX||0):doc.gapX;
    const rowGap=roll?0:doc.gapY;
    return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(doc.name)} — Labels</title>
<style>
  /* The sheet size is declared, or the browser falls back to Letter and
     clips the right-hand column off every page. */
  @page{size:${g.pgW}mm ${g.pgH}mm;margin:0}
  *{margin:0;padding:0;box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  html,body{background:#fff}
  .pg{width:${g.pgW}mm;height:${g.pgH}mm;overflow:hidden;background:#fff;
    padding:${padT}mm ${padR}mm ${padB}mm ${padL}mm;
    display:grid;grid-template-columns:repeat(${Math.max(1,g.cols)},${doc.w}mm);
    grid-auto-rows:${doc.h}mm;column-gap:${colGap}mm;row-gap:${rowGap}mm;
    align-content:start;justify-content:start;page-break-after:always;break-after:page}
  .pg:last-child{page-break-after:auto;break-after:auto}
  /* a die-cut deliberately left empty on a part-used sheet */
  .sk{width:${doc.w}mm;height:${doc.h}mm}
  /* CUT LINES, for plain sheet stock that is not die-cut: a hairline round
     each label to cut along. An OUTLINE, not a border — an outline takes no
     space, so adding it cannot shift a single label off its grid position. */
  .pg.cut .lbl{outline:.1mm dashed #9aa0a6}
  .pg.cut .sk{outline:.1mm dashed #d5d7da}
  ${labelCss(doc)}
</style></head><body>${pages}${opts.print?`
<script>window.onload=function(){setTimeout(function(){window.print();},350);};<\/script>`:""}
</body></html>`;
  }
  /* ============================================================
     A COMPOSED SHEET — several designs, laid out by hand.

     One sheet of stock, and you say what goes in each die-cut:
     six of the carton label, six of the reel label, a dozen blanks
     because the rest of the sheet is for tomorrow. Every design has
     to be cut the same — same size, same page, same margins — or
     they are not positions on one sheet, they are two jobs.

     `cells` is one entry per die-cut, in reading order, each either
     {d:doc, ctx} or null for a position deliberately left empty.
     The page grid, the margins and the gaps come from the FIRST
     design, which is safe precisely because sameStock() has already
     said they all agree.
     ============================================================ */
  function composeHtml(base,cells,opts){
    opts=opts||{};
    const g=sheetGrid(base);
    const per=Math.max(1,g.perPage);
    /* one skin class per distinct design on the sheet */
    const uniq=[];
    cells.forEach(c=>{ if(c&&c.d&&uniq.indexOf(c.d)<0) uniq.push(c.d); });
    const skins=uniq.map((d,i)=>labelSkinCss(d,"s"+i)).join("\n  ");
    const pages=[];
    for(let i=0;i<cells.length;i+=per) pages.push(cells.slice(i,i+per));
    if(!pages.length) pages.push([]);
    const use=opts.onlyPage!=null
      ?[pages[Math.min(opts.onlyPage,pages.length-1)]||[]] : pages;
    const cut=!!opts.cut&&base.mode!=="roll";
    const body=use.map(p=>`<div class="pg${cut?" cut":""}">`+
      p.map(c=>c&&c.d
        ? `<div class="lbl s${uniq.indexOf(c.d)}">${labelInner(c.d,c.ctx)}</div>`
        : `<div class="sk"></div>`).join("")+`</div>`).join("");
    const roll=base.mode==="roll";
    return `<!doctype html><html><head><meta charset="utf-8"><title>Labels</title>
<style>
  @page{size:${g.pgW}mm ${g.pgH}mm;margin:0}
  *{margin:0;padding:0;box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  html,body{background:#fff}
  .pg{width:${g.pgW}mm;height:${g.pgH}mm;overflow:hidden;background:#fff;
    padding:${roll?0:base.mTop}mm ${roll?0:base.mRight}mm ${roll?0:base.mBottom}mm ${roll?0:base.mLeft}mm;
    display:grid;grid-template-columns:repeat(${Math.max(1,g.cols)},${base.w}mm);
    grid-auto-rows:${base.h}mm;column-gap:${roll?0:base.gapX}mm;row-gap:${roll?0:base.gapY}mm;
    align-content:start;justify-content:start;page-break-after:always;break-after:page}
  .pg:last-child{page-break-after:auto;break-after:auto}
  .sk{width:${base.w}mm;height:${base.h}mm}
  .pg.cut .lbl{outline:.1mm dashed #9aa0a6}
  .pg.cut .sk{outline:.1mm dashed #d5d7da}
  ${labelBoxCss(base)}
  ${skins}
</style></head><body>${body}${opts.print?`
<script>window.onload=function(){setTimeout(function(){window.print();},350);};<\/script>`:""}
</body></html>`;
  }

  function oneHtml(doc,ctx){
    return `<!doctype html><html><head><meta charset="utf-8"><style>
  *{margin:0;padding:0;box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  html,body{background:#fff}
  ${labelCss(doc)}
</style></head><body>${labelHtml(doc,ctx)}</body></html>`;
  }

  /* One context per label in the run: the serial advances per LABEL, and a
     copy repeats the same label — two stickers for one drum must carry the
     same number, not two consecutive ones. */
  function buildRun(doc,opts){
    opts=opts||{};
    const qty=Math.max(1,Math.min(5000,+opts.qty||doc.qty||1));
    const copies=Math.max(1,Math.min(500,+opts.copies||doc.copies||1));
    const now=new Date();
    const out=[];
    for(let i=0;i<qty;i++){
      const ctx={index:i,now,prompts:opts.prompts||{},serialStart:opts.serialStart};
      for(let c=0;c<copies;c++) out.push(ctx);
    }
    /* REVERSE ORDER. A laser that stacks face-up hands back a pile running
       backwards, and a run of serialised labels then has to be re-sorted by
       hand. Printing the run backwards means the stack comes out forwards.
       The SERIALS are not reversed — only the order they are laid down in —
       so 1..50 is still 1..50, just printed 50 first. */
    return opts.reverse?out.slice().reverse():out;
  }

  global.LabelStudio = {
    mount, loadDocs, saveDocs, newDoc, cleanDoc, sheetHtml, oneHtml, buildRun, paginate,
    composeHtml, sameStock, labelSkinCss,
    SYMS, FONTS, PAGES, OBJ_TYPES, qrEncode, encodeBar, sheetGrid, promptsOf,
    STOCKS, applyStock, stockOf, stockLabel, perPageOf, sizeS, autoFitOf, applyAutoFit,
  };

  /* ============================================================
     SECTION 7 — THE DESIGNER

     Laid out the way BarTender lays out its designer, and with each
     control in exactly ONE place.

       menu bar          File · Edit · View · Insert · Arrange
       main toolbar      the handful of things done every minute
       text toolbar      font, size, weight, alignment, colour
       toolbox (left)    the pointer and the objects you can place
       canvas (centre)   rulers, grid, true millimetres
       objects (right)   what is on the label, for picking one out
       status bar        size · count · selection · per page · zoom
       dialogs           Properties, Page Setup, Print

     WHY DIALOGS AND NOT PANES. This screen used to carry a ribbon AND
     a properties rail AND a settings dock, and the same control turned
     up in two or three of them: the font sat on the ribbon and in the
     rail, the label size on the ribbon and in the dock, the data source
     on a ribbon tab and in the rail, z-order on the ribbon and on every
     row of the object list. Two of anything is one too many — you can
     never be sure which one you last touched. BarTender's answer is the
     one used here: the surfaces above hold what you reach for while
     drawing, and everything else lives behind Properties or Page Setup,
     once each.
     ============================================================ */
  function mount(host){
    let docs=loadDocs();
    /* The studio ALWAYS opens on the gallery of saved labels — the way
       BarTender opens on its documents. You choose what you are working on
       before you are given a canvas; nothing is picked for you. */
    let screen="gallery";
    let opened=false;                // has a template been opened into the designer?
    let di=0, zoom=1;

    /* ============================================================
       THE SELECTION — a LIST, the way a drawing program has one.

       It used to be a single id, which meant every job that touches
       more than one object had to be done one object at a time:
       three fields to make bold was three trips to the ribbon, and
       aligning a stack meant aligning each of them and hoping.

       `selIds` is in the order things were picked. The LAST one is
       the primary — the one the properties panel reads and the one
       an alignment lines the others up against, which is what
       BarTender does and what "align to the last thing I clicked"
       means to anyone who has used a drawing program.
       ============================================================ */
    let selIds=[];
    const isSel=(o)=>selIds.indexOf(o.id)>=0;
    const selObjs=()=>doc().objects.filter(isSel);
    /* Never a stale id: an object deleted or undone out of existence must not
       keep the panel pointing at something that is not on the label. */
    const selObj=()=>{
      for(let i=selIds.length-1;i>=0;i--){
        const o=doc().objects.find(x=>x.id===selIds[i]);
        if(o) return o;
      }
      return null;
    };
    const setSel=(id)=>{ selIds=id?[id]:[]; };
    const addSel=(id)=>{
      const i=selIds.indexOf(id);
      if(i>=0) selIds.splice(i,1); else selIds.push(id);
    };
    const pruneSel=()=>{
      selIds=selIds.filter(id=>doc().objects.some(o=>o.id===id));
    };
    let dirty=false;
    let rulers=true;
    let galStock="";                 // the stock a new blank label is cut to
    let full=false;                  // the designer, filling the screen
    let tool=null;                   // the armed toolbox tool, or null for the pointer
    let showTools=true;              // the Tools panel, down the left
    let showProps=true;              // Object Properties and Object Layers, down the right
    let clip=null;                   // the clipboard — one object, cut or copied
    /* Adjusting the background picture is a MODE, entered and left on purpose.
       It used to be inferred from the fit being "custom", which meant the
       amber handles never went away again — the screen sat there saying you
       were editing the picture long after you had finished with it. */
    let bgEdit=false;
    /* Which object is being typed on. The canvas leaves it out of the render
       because the editor is drawing it — see labelInner's ctx.skip. */
    let editingId=null;
    /* EVERY canvas redraw goes through this, so they cannot disagree about
       what is being edited — one of them missing the skip would show the text
       twice, and one of them adding it at the wrong moment would blank an
       object nobody was touching. */
    const canvasCtx=()=>({index:0,now:new Date(),
      prompts:runOpts.prompts||{},skip:editingId});

    const root=h("div",{class:"ls"});
    host.appendChild(root);

    /* A page can be navigated away from, and the router simply empties the
       view — so the warning has to be hung on the router. */
    const guard=()=>dirty?"Label Studio has unsaved changes. Leave without saving?":null;
    if(global.App&&typeof App.setLeaveGuard==="function") App.setLeaveGuard(guard);

    /* Never undefined: every screen that uses it is only reachable with a
       template open, but a delete can empty the list between a click and a
       repaint, and a designer that throws is worse than one that blinks. */
    const doc=()=>docs[di]||docs[0]||newDoc("Label");

    /* ---- RECENT ----
       Stamped when a template is opened and when it is saved, so "recent"
       means recently WORKED ON rather than recently created. `updated` is a
       date and everything touched today sorts equal, which is why this is a
       full instant of its own. */
    function stampUsed(d){
      if(d) d.usedAt=new Date().toISOString();
    }
    /* Most recently worked on first; anything never stamped falls to the back
       in its saved order, so an old library does not shuffle itself. */
    function recentDocs(){
      return docs.map((d,i)=>({d,i}))
        .sort((a,b)=>String(b.d.usedAt||"").localeCompare(String(a.d.usedAt||"")));
    }
    const usedAgo=(d)=>{
      if(!d.usedAt) return d.updated?("saved "+d.updated):"not saved yet";
      const ms=Date.now()-Date.parse(d.usedAt);
      if(!isFinite(ms)) return "";
      const m=Math.round(ms/60000);
      if(m<1)  return "just now";
      if(m<60) return m+" min ago";
      const hr=Math.round(m/60);
      if(hr<24) return hr+(hr===1?" hour ago":" hours ago");
      const dy=Math.round(hr/24);
      return dy<8?(dy+(dy===1?" day ago":" days ago")):("saved "+(d.updated||""));
    };

    /* ---- undo / redo ----
       Snapshots of the open design, not a log of operations: the whole document
       is small and a snapshot cannot get out of step with the thing it is meant
       to restore. touch() runs AFTER every mutation, so what it banks is the
       state as it was BEFORE that mutation — exactly what Ctrl+Z has to put back. */
    const HIST=60;
    let undoS=[], redoS=[], lastSnap=JSON.stringify(docs[di]||newDoc("Label"));
    function touch(){
      dirty=true;
      undoS.push(lastSnap);
      if(undoS.length>HIST) undoS.shift();
      redoS.length=0;
      lastSnap=JSON.stringify(doc());
    }
    /* Switching or creating a template starts a new history — undoing across a
       template switch would silently rewrite a design you cannot see. */
    function resetHistory(){ undoS=[]; redoS=[]; lastSnap=JSON.stringify(doc()); }
    function undo(){
      if(!undoS.length) return toast("Nothing to undo",{type:"warn"});
      redoS.push(JSON.stringify(doc()));
      docs[di]=cleanDoc(JSON.parse(undoS.pop()));
      lastSnap=JSON.stringify(doc()); dirty=true;
      pruneSel();
      paint();
    }
    function redo(){
      if(!redoS.length) return toast("Nothing to redo",{type:"warn"});
      undoS.push(JSON.stringify(doc()));
      docs[di]=cleanDoc(JSON.parse(redoS.pop()));
      lastSnap=JSON.stringify(doc()); dirty=true;
      pruneSel();
      paint();
    }

    /* ---- saving: to the ERP's settings, for everyone, on the server ---- */
    function save(){
      doc().updated=new Date().toISOString().slice(0,10);
      stampUsed(doc());
      docs=saveDocs(docs);
      dirty=false;
      toast("“"+doc().name+"” saved",{type:"ok"});
      paint();
    }

    /* ---- form helpers, matching the app's own idiom ---- */
    const fld=(label,el,hint)=>h("div",{class:"field"},
      [h("label",{text:label}),el,hint?h("div",{class:"hint",text:hint}):null]);
    function nInput(val,onCh,step,min,max){
      const el=h("input",{class:"input",type:"number",step:String(step==null?.5:step),
        min:min==null?"":String(min),max:max==null?"":String(max)});
      el.value=(Math.round((+val||0)*100)/100);
      el.addEventListener("input",()=>onCh(+el.value));
      return el;
    }
    function tInput(val,onCh,ph,max){
      const el=h("input",{class:"input",type:"text",placeholder:ph||"",maxlength:String(max||200)});
      el.value=val==null?"":String(val);
      el.addEventListener("input",()=>onCh(el.value));
      return el;
    }
    function taInput(val,onCh,ph,max){
      const el=h("textarea",{class:"wz-ta",rows:"2",placeholder:ph||"",maxlength:String(max||600)});
      el.value=val==null?"":String(val);
      const grow=()=>{ el.style.height="auto"; el.style.height=Math.min(180,Math.max(38,el.scrollHeight+2))+"px"; };
      el.addEventListener("input",()=>{ onCh(el.value); grow(); });
      requestAnimationFrame(grow);
      return el;
    }
    function sel1(val,opts,onCh){
      const el=h("select",{class:"select"},opts.map(o=>h("option",{value:o.v},o.l)));
      el.value=val;
      el.addEventListener("change",()=>onCh(el.value));
      return el;
    }
    function cInput(val,onCh,allowEmpty){
      const wrap=h("div",{class:"ls-col"});
      const el=h("input",{type:"color"});
      el.value=/^#[0-9a-fA-F]{6}$/.test(String(val||""))?val:"#000000";
      el.addEventListener("input",()=>onCh(el.value));
      wrap.appendChild(el);
      if(allowEmpty) wrap.appendChild(h("button",{class:"btn sm ghost",title:"No fill",
        onclick:()=>onCh(""),text:val?"✕":"—"}));
      return wrap;
    }
    const chk=(label,val,onCh)=>{
      const el=h("input",{type:"checkbox"}); el.checked=!!val;
      el.addEventListener("change",()=>onCh(el.checked));
      return h("label",{class:"ls-chk"},[el,h("span",{text:label})]);
    };
    const row=(n,kids)=>h("div",{class:"ls-row",style:`grid-template-columns:repeat(${n},1fr)`},kids);

    /* Every control that edits "the selected object" goes through this. A
       disabled control is a convention, not a guarantee — a stale click or a
       repaint landing mid-gesture can still fire the handler, and `o.bold = …`
       on a null selection throws and takes the screen down. The selection is
       re-read at the moment of the edit, so it also cannot act on an object
       that has since been deleted. */
    function onSel(fn){
      return (...a)=>{
        /* EVERY selected object, not just the primary. Picking three captions
           and pressing Bold should make three captions bold — going back to
           the ribbon once per object is the thing a selection is FOR. */
        const list=selObjs(); if(!list.length) return;
        list.forEach(s=>fn(s,...a));
        touch(); paint();
      };
    }

    /* ============================================================
       PAINT
       ============================================================ */
    function paint(){
      root.innerHTML="";
      root.classList.toggle("ls-full",!!full);
      closeCtx();
      /* A repaint throws the text editor away, so whatever it was drawing has
         to go back to the canvas. Clearing it HERE rather than trusting every
         caller means an object can never be left invisible because one path
         out of the editor forgot. */
      editingId=null;
      if(screen!=="gallery"&&(!opened||!docs.length)) screen="gallery";
      if(screen==="gallery"){
        root.classList.add("ls-browse");
        root.appendChild(galleryBar());
        root.appendChild(galleryPane());
        return;
      }
      root.classList.remove("ls-browse");
      /* ribbon · Tools | canvas | Object Properties · document tabs · status
         bar — the four bands the designer is read in, top to bottom. */
      root.appendChild(ribbon());
      const cols=[], kids=[];
      if(showTools){ cols.push("var(--ls-toolsw)"); kids.push(toolsPanel()); }
      cols.push("minmax(0,1fr)"); kids.push(centrePane());
      if(showProps){ cols.push("var(--ls-rightw)"); kids.push(rightRail()); }
      root.appendChild(h("div",{class:"ls-body",
        style:"grid-template-columns:"+cols.join(" ")},kids));
      root.appendChild(docTabs());
      root.appendChild(statusBar());
      fitStudio();
      lastSnap=JSON.stringify(doc());
    }

    /* ============================================================
       THE STUDIO'S HEIGHT, MEASURED RATHER THAN GUESSED.

       This was calc(100vh - 194px): the top bar, the view's padding
       and the page head added up by hand. Any one of them changing —
       a title wrapping to two lines on a narrow window, a browser
       with a different chrome height, the ERP growing a banner —
       left the studio either overflowing the page or floating short
       of the bottom with a dead strip under it. Neither is something
       the operator can do anything about.

       So it is measured: find where the studio actually starts, and
       give it the rest of the window. Full screen is left to CSS,
       which owns that case entirely.
       ============================================================ */
    function fitStudio(){
      if(!root.isConnected) return;
      if(full||screen!=="design"){ root.style.height=""; return; }
      const top=root.getBoundingClientRect().top;
      root.style.height=Math.max(520,Math.round(global.innerHeight-top-18))+"px";
    }
    const onResize=()=>{
      if(!root.isConnected){ global.removeEventListener("resize",onResize); return; }
      fitStudio();
    };
    global.addEventListener("resize",onResize);

    /* ============================================================
       FULL SCREEN — the studio over the viewport, in CSS.

       ⚠ THIS DELIBERATELY DOES NOT USE THE FULLSCREEN API.

       It used to call root.requestFullscreen(), and that quietly
       broke half the screen. The Fullscreen API renders the
       fullscreen element's SUBTREE AND NOTHING ELSE — and every
       dialog this studio opens is drawn into #modalHost, which is a
       sibling of the whole app shell, not a child of the studio. So
       in full screen:

         · Label layout, Page setup, Print and Properties opened
           into a node that was not being rendered — the dialog was
           there, doing its job, invisible. The new-label size
           chooser too, which is the FIRST thing a new label does.
         · Toasts (#toasts, also a sibling) never appeared, so
           "Saved", "Copied" and every warning went silent.
         · The operating system's file dialog cannot be raised over
           a fullscreen window on Windows — which is how this was
           found: "Choose picture…" did nothing.
         · window.open() for the print sheet came up behind.

       Pinning the studio over the viewport in CSS costs the browser
       chrome staying visible — a strip at the top of the screen —
       and buys back every dialog, every toast, the file explorer
       and the printer. That is not a close trade.
       ============================================================ */
    function toggleFull(){
      full=!full;
      paint();
    }
    const fullBtn=(cls)=>h("button",{class:cls||"btn sm ls-fs",
      title:full?"Leave full screen  (Esc)":"Fill the screen with the designer",
      onclick:toggleFull,text:full?"⛶ Exit full screen":"⛶ Full screen"});

    /* ============================================================
       THE GALLERY — YOUR labels, not ours.
       ============================================================ */
    /* The bar above the start page carried the title, the count and a New
       button — all three of which the banner underneath now says louder and
       with room to breathe. What is left is the one thing the banner cannot
       hold, because it belongs to the window rather than the page. */
    function galleryBar(){
      return h("div",{class:"ls-top"},[
        h("div",{class:"sp"}),
        fullBtn(),
      ]);
    }

    /* ============================================================
       A NEW LABEL STARTS WITH ITS SIZE.

       "What are you printing on" is the one decision that cannot be
       deferred: it is the only thing on this screen the operator
       cannot change — the sheets are in the drawer and the roll is
       on the printer already — and every position placed afterwards
       is measured against it. Changing the stock later moves
       everything already laid down relative to the label, which is
       how a design ends up half off the edge.

       So the size is asked FIRST, the way BarTender's new-document
       wizard asks it. The blank is made at the default and the
       chooser opens on top of it, so closing the chooser leaves a
       real, usable 100 × 60 label rather than a half-built document
       or nothing at all.
       ============================================================ */
    function newBlank(){ if(newBlankAt(galStock)) layoutDialog({isNew:true}); }
    /* Making the blank, at a stock that is already known. The start page's
       size tiles use this directly — being asked "what are you printing on?"
       immediately after answering it would be the machine not listening. */
    function newBlankAt(stock){
      if(docs.length>=MAX_DOCS){
        toast("That is the "+MAX_DOCS+"-template limit",{type:"warn"});
        return false;
      }
      const nd=cleanDoc(applyStock(newDoc("Label "+(docs.length+1)),stock||""));
      stampUsed(nd);
      docs.push(nd);
      di=docs.length-1; selIds=[]; tool=null; bgEdit=false;
      opened=true; screen="design"; dirty=true;
      resetHistory(); paint(); fitOnce();
      return true;
    }
    /* Opening a template, from wherever — the gallery, a document tab, the
       Recent list. One route, so the Recent stamp cannot be forgotten on one
       of them and the history cannot be left pointing at the last design. */
    function openDoc(i){
      if(i<0||i>=docs.length) return;
      di=i; selIds=[]; tool=null; bgEdit=false; opened=true; screen="design";
      stampUsed(docs[i]);
      resetHistory(); paint(); fitOnce();
    }

    /* ============================================================
       THE START PAGE

       The first thing the studio shows, and for most of the plant
       the only thing they will use: they are not designing a new
       label, they are opening the one they print every day and
       sending it to the printer.

       So it is built around GETTING BACK TO WORK: the labels you
       touched last, large and first, each with PRINT on its face —
       because printing is what most people came here to do, and
       making them open the designer to find the button is three
       clicks of ceremony for a job that is one.

       WHAT IS NOT HERE. A row of stock sizes used to sit under the
       banner, offering four presets to start a label at. It read
       like a menu of things to do and was none of them: the size
       chooser that opens with every new label already draws EVERY
       roll and sheet to scale, so the row was four of forty
       options, taking the width of the page to say less.
       ============================================================ */
    let galQuery="";                 // the search box on the start page

    /* Open a label and go straight to its print dialog. */
    function printFrom(i){
      openDoc(i);
      printDialog();
    }

    /* ============================================================
       A TEMPLATE AS A FILE — download and import

       The designs live in the ERP's settings document and always
       will; a file is not a second home for them, it is how one
       TRAVELS — out to a backup or another installation, in from
       a supplier who drew your label for you.

       Everything that comes in goes through cleanDoc(), the same
       gate the server's own settings pass, so a hand-edited or
       corrupt file cannot put anything into the studio that the
       studio could not have made itself.
       ============================================================ */
    const MAX_IMPORT=12*1024*1024;      // a design may carry placed pictures
    const LABEL_KIND="chhaperia-label";
    /* THE EXTENSION IS .json — which is precisely what the bytes are, and
       every machine already knows what to do with them.

       .label was tried, and Windows answered plainly: "This file does not
       have an app associated with it." .btw was tried before that and was
       worse — a real .btw is Seagull's own closed binary, so naming our file
       .btw does not make BarTender read it; it only hands the file to the one
       application certain to reject it, error #3323, "not a supported file
       type". .json double-clicks open in an editor, drops into any other tool
       that speaks it, and reads as plain text when somebody needs to look.

       Import never looks at the extension anyway; it reads the bytes. This
       name is for the human in the downloads folder. */
    const LABEL_EXT=".json";

    function downloadDoc(d){
      const payload={kind:LABEL_KIND, version:1,
        note:"Chhaperia Label Studio template. Import it from Label Studio — "+
             "this is not a Seagull BarTender document.",
        exported:new Date().toISOString(),
        labels:[cleanDoc(JSON.parse(JSON.stringify(d)))]};
      const name=String(d.name||"label").replace(/[^\w .()-]+/g,"_")
        .replace(/\s+/g," ").trim().slice(0,60)||"label";
      const blob=new Blob([JSON.stringify(payload,null,2)],{type:"application/json"});
      const url=URL.createObjectURL(blob);
      const a=h("a",{href:url,download:name+LABEL_EXT,style:"display:none"});
      document.body.appendChild(a);
      a.click();
      setTimeout(()=>{ URL.revokeObjectURL(url); a.remove(); },0);
      toast("Saved “"+name+LABEL_EXT+"” — bring it back with Import. "+
            "It is a Label Studio file, not a BarTender one.",
            {type:"ok",title:"Downloaded",dur:6000});
    }

    /* A name nobody else in the library is already using, so two imports of the
       same file do not leave two identically-named templates behind. */
    function uniqueDocName(base){
      const name=String(base||"Label").slice(0,60)||"Label";
      if(!docs.some(d=>d.name===name)) return name;
      for(let n=2;n<999;n++){
        const t=(name+" "+n).slice(0,60);
        if(!docs.some(d=>d.name===t)) return t;
      }
      return name;
    }

    /* One file may hold one label, a handful, or a whole settings dump — take
       the labels out of whichever shape turned up. */
    function labelsIn(json){
      if(!json||typeof json!=="object") return [];
      if(Array.isArray(json)) return json;
      if(Array.isArray(json.labels)) return json.labels;
      if(Array.isArray(json.labelDocs)) return json.labelDocs;
      if(json.label&&typeof json.label==="object") return [json.label];
      return [json];
    }
    /* cleanDoc() will happily turn {} into a valid empty label, so the shape has
       to be checked BEFORE it — otherwise any .json at all imports as a blank
       template and the operator is left wondering what they just added. */
    const looksLikeLabel=(x)=>!!x&&typeof x==="object"&&!Array.isArray(x)&&
      (typeof x.w==="number"||typeof x.h==="number"||Array.isArray(x.objects));

    /* ---- WHAT KIND OF FILE IS THIS? FROM ITS BYTES. ----

       ⚠ THE BYTES, NOT THE DECODED TEXT. FileReader.readAsText decodes UTF-8,
       and D0 CF 11 E0 — the first four bytes of every OLE compound file, and
       therefore of every BarTender .btw — is not valid UTF-8. It comes back as
       U+FFFD replacement characters, so a signature test against the decoded
       string CAN NEVER MATCH. That is why a genuine BarTender file was turned
       away with the unhelpful "does not hold a label" instead of being named.

       ⚠ AND THE BYTES, NOT THE EXTENSION. A label downloaded from this studio
       may be sitting under the same three letters; only the content separates
       them, so nothing here looks at the file name. */
    const OLE_SIG=[0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1];   // older .btw
    const ZIP_SIG=[0x50,0x4b,0x03,0x04];                       // newer .btw
    const startsWith=(b,sig)=>{
      if(!b||b.length<sig.length) return false;
      for(let i=0;i<sig.length;i++) if(b[i]!==sig[i]) return false;
      return true;
    };
    /* ⚠ THE ONE THAT ACTUALLY TURNS UP. A .btw is NOT an OLE blob — every file
       checked out of this plant, BarTender 11.5 and 12.0 alike, opens with a
       plain-ASCII banner:

           \r\nBar Tender Format File\r\n(c) 1992 - 2026 Seagull Scientific...

       Testing only for OLE and ZIP therefore called a real BarTender file
       "text", JSON.parse threw on the banner, and the operator was told their
       label "does not hold a label". This test goes FIRST because it is the
       one that fires. OLE and ZIP stay behind it for versions that use them. */
    const BTW_BANNER="Bar Tender Format File";
    function isBtwText(bytes){
      const n=Math.min(bytes.length,64);
      let s="";
      for(let i=0;i<n;i++) s+=String.fromCharCode(bytes[i]);
      return s.replace(/^[\r\n\s]+/,"").indexOf(BTW_BANNER)===0;
    }
    function sniff(bytes){
      if(isBtwText(bytes)) return "btw";
      if(startsWith(bytes,OLE_SIG)||startsWith(bytes,ZIP_SIG)) return "btw";
      /* Any other binary. A NUL byte early on is the giveaway, and no text
         file that could hold a label has one. */
      const n=Math.min(bytes.length,512);
      for(let i=0;i<n;i++) if(bytes[i]===0) return "binary";
      return "text";
    }
    /* UTF-8 first, then Windows-1252. A label hand-edited in Notepad on a
       Hindi- or European-locale machine is not UTF-8, and throwing it away for
       that would be refusing a perfectly good file over an encoding. */
    function decode(bytes){
      try{ return new TextDecoder("utf-8",{fatal:true}).decode(bytes); }
      catch(e){
        try{ return new TextDecoder("windows-1252").decode(bytes); }
        catch(e2){ return ""; }
      }
    }
    function whyNot(f,kind){
      const nm="\u201c"+(f.name||"that file")+"\u201d";
      if(kind==="btw")
        return nm+" is a BarTender file, but nothing could be read out of it "+
               "\u2014 no template size, or no artwork. Open it in BarTender and "+
               "save it again, or rebuild the label here.";
      if(kind==="binary")
        return nm+" is a binary file, not a label Label Studio can read.";
      return nm+" does not hold a label Label Studio can read.";
    }

    /* ============================================================
       READING A BarTender .btw

       It turns out a .btw is NOT the opaque OLE blob it was assumed to be.
       Seagull writes a plain-text header first — checked against real files
       from this plant, BarTender 11.5 and 12.0 both:

         Bar Tender Format File
         (c) 1992 - 2026 Seagull Scientific, LLC
         ----------------------------------------------
         Application: Version=12.0.0; Build=252359; ...
         Document: CompatibleVersion=2022 and Higher; ...
         Printer: Name=EPSON L11050 Series; ...
         <Metadata>...<TemplateSize>98.8 x 34.1 mm</TemplateSize>
                      <Title>BOX TEMPLATE</Title></Metadata>
         ----------------------------------------------
         <binary>

       …and embedded in the binary is a PNG: BarTender's own render of the
       label, letterboxed inside a square canvas on a grey ground.

       So two of the three things a label needs are right there in the file —
       ITS SIZE IN MILLIMETRES and A PICTURE OF IT. That is enough to bring the
       label in: a template cut to the exact stock, carrying the artwork.

       ⚠ WHAT THIS IS NOT. The text, barcodes and fields are objects in the
       proprietary part of the file and are NOT recovered — what arrives is a
       picture of them. It prints correctly and it is the right size, but to
       make a field variable you re-draw it here on top. The toast says so
       rather than letting anyone discover it at the printer. */
    const PNG_SIG=[0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a];
    const PNG_END=[0x49,0x45,0x4e,0x44,0xae,0x42,0x60,0x82];
    const findSig=(b,sig,from)=>{
      outer: for(let i=from;i+sig.length<=b.length;i++){
        for(let j=0;j<sig.length;j++) if(b[i+j]!==sig[j]) continue outer;
        return i;
      }
      return -1;
    };
    /* Every PNG in the file; the biggest is the label render, the small one is
       a thumbnail of it. */
    function pngsIn(bytes){
      const out=[]; let from=0;
      for(;;){
        const s=findSig(bytes,PNG_SIG,from);
        if(s<0) break;
        const e=findSig(bytes,PNG_END,s);
        if(e<0) break;
        out.push({at:s,len:e+8-s});
        from=e+8;
      }
      return out;
    }
    function btwHeader(bytes){
      /* latin-1 by hand: the header is ASCII, and TextDecoder("windows-1252")
         is not guaranteed everywhere. 8 KB is far past the second rule. */
      let s="";
      const n=Math.min(bytes.length,8192);
      for(let i=0;i<n;i++) s+=String.fromCharCode(bytes[i]);
      const grab=(re)=>{ const m=re.exec(s); return m?m[1].trim():""; };
      const size=grab(/<TemplateSize>([^<]*)<\/TemplateSize>/);
      const wh=/([\d.]+)\s*x\s*([\d.]+)\s*mm/i.exec(size);
      return {
        title:grab(/<Title>([^<]*)<\/Title>/),
        w:wh?+wh[1]:0,
        h:wh?+wh[2]:0,
        app:grab(/<Application>([^<]*)<\/Application>/),
      };
    }

    /* THE LETTERBOX. BarTender renders into a SQUARE canvas and pads the label
       out to it with flat grey, so pasting the PNG in whole would import a
       98.8 x 34.1 mm label as a square with two grey bars. The label sits
       centred and fills one axis, so the crop is pure arithmetic off the
       template's own aspect ratio — no pixel-hunting, nothing to tune. */
    /* THE GREY HAS TO GO. BarTender renders into a SQUARE canvas and pads the
       label out to it with flat grey. Cropping to the label's aspect takes off
       the bars, but a rounded label still leaves four grey wedges where its
       corners curve away — and those would print.

       So after the crop, the grey is flood-filled away from each corner and
       left transparent. FLOOD-FILLED, not matched globally: a label may
       legitimately contain that same grey somewhere in its artwork, and a
       blanket colour swap would punch holes in it. Only grey reachable from
       outside the label is outside the label. */
    function clearSurround(cx,w,h){
      let img;
      try{ img=cx.getImageData(0,0,w,h); }catch(e){ return; }   // tainted canvas
      const d=img.data;
      const at=(x,y)=>(y*w+x)*4;
      const seed=[at(0,0),at(w-1,0),at(0,h-1),at(w-1,h-1)];
      /* all four corners must agree, or this is not a letterboxed render */
      const r0=d[seed[0]], g0=d[seed[0]+1], b0=d[seed[0]+2];
      const near=(i,tol)=>Math.abs(d[i]-r0)<=tol&&Math.abs(d[i+1]-g0)<=tol&&
                          Math.abs(d[i+2]-b0)<=tol;
      for(const s of seed) if(!near(s,10)) return;
      /* a white or near-white ground is the label itself on white stock —
         clearing that would erase the label */
      if(r0>235&&g0>235&&b0>235) return;
      const seen=new Uint8Array(w*h);
      const stack=[];
      const push=(x,y)=>{
        if(x<0||y<0||x>=w||y>=h) return;
        const p=y*w+x;
        if(seen[p]) return;
        seen[p]=1;
        if(!near(p*4,26)) return;
        d[p*4+3]=0;
        stack.push(p);
      };
      push(0,0); push(w-1,0); push(0,h-1); push(w-1,h-1);
      while(stack.length){
        const p=stack.pop(), x=p%w, y=(p-x)/w;
        push(x+1,y); push(x-1,y); push(x,y+1); push(x,y-1);
      }
      cx.putImageData(img,0,0);
    }
    function cropToLabel(img,wmm,hmm){
      const want=wmm/hmm, have=img.width/img.height;
      let sx=0, sy=0, sw=img.width, sh=img.height;
      if(have>want){ sw=Math.round(img.height*want); sx=Math.round((img.width-sw)/2); }
      else if(have<want){ sh=Math.round(img.width/want); sy=Math.round((img.height-sh)/2); }
      const cv=document.createElement("canvas");
      cv.width=sw; cv.height=sh;
      const cx=cv.getContext("2d");
      if(!cx) return "";
      cx.drawImage(img,sx,sy,sw,sh,0,0,sw,sh);
      clearSurround(cx,sw,sh);
      /* PNG, and PNG only: the transparency just cut into the corners is the
         whole point, and JPEG has none. If it will not fit under the cap the
         picture is dropped rather than flattened back onto grey. */
      const url=cv.toDataURL("image/png");
      return url.length<=MAX_IMG?url:"";
    }

    /* Hands a finished doc to its callback, or null if the file gives up
       nothing usable. Asynchronous, because decoding a PNG is. */
    /* ---- THE TEXT INSIDE A .btw ----

       The artwork alone is a photograph of a label: right size, right look,
       nothing you can change. The words are in there too, and they are worth
       digging out — an operator who imports a box label wants to edit the type
       code on it, not admire it.

       WHERE THEY ARE. Past the header the file carries one zlib stream (0x78
       0x9c and friends). Inflated it is BarTender's own binary record format —
       undocumented, and not worth guessing at — but the text of every field
       sits in it as a plain RTF blob in UTF-16, complete with the size,
       weight and alignment it was typed at.

       WHAT IS NOT IN REACH. Positions. The int32s around each blob are flags
       and DPI figures, not coordinates; nothing in them reads as x/y in any
       unit the label could be measured in. Rather than guess and quietly print
       a field in the wrong place, the recovered text is stacked down the label
       and the original artwork is left underneath at low opacity as a TRACING
       GUIDE. Drag each line onto its place, then clear the background.

       DecompressionStream is how a browser inflates; it is asynchronous, hence
       the callback. Anything at all going wrong here falls back to the picture
       on its own, which is always better than failing the import. */
    function inflateZlib(bytes,done){
      if(typeof DecompressionStream!=="function") return done(null);
      try{
        const ds=new DecompressionStream("deflate");
        new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer()
          .then(buf=>done(new Uint8Array(buf)))
          .catch(()=>done(null));
      }catch(e){ done(null); }
    }
    /* The first zlib stream that actually inflates. Only a handful of offsets
       ever look like one, so this is cheap. */
    function inflateFirst(bytes,done){
      const at=[];
      for(let i=0;i+1<bytes.length;i++){
        if(bytes[i]===0x78&&(bytes[i+1]===0x01||bytes[i+1]===0x9c||bytes[i+1]===0xda))
          at.push(i);
        if(at.length>24) break;
      }
      let k=0;
      (function next(){
        if(k>=at.length) return done(null);
        const off=at[k++];
        inflateZlib(bytes.slice(off),(out)=>{
          if(out&&out.length>1024) return done(out);
          next();
        });
      })();
    }

    /* RTF down to the words. The font table, colour table and stylesheet are
       GROUPS, not text — stripped by matching braces rather than by regex,
       because "{\fonttbl{\f0 Calibri;}{\f1 Arial;}}" nests and a flat pattern
       leaves "Calibri;Arial;" glued to the front of every label. */
    function rtfText(rtf){
      let s=String(rtf||"");
      const drop=/\{\\(?:\*|fonttbl|colortbl|stylesheet|themedata|generator|info|listtable|listoverridetable|latentstyles|datastore)/;
      for(;;){
        const m=drop.exec(s);
        if(!m) break;
        let d=0,i=m.index;
        for(;i<s.length;i++){
          if(s[i]==="{") d++;
          else if(s[i]==="}"){ d--; if(!d){ i++; break; } }
        }
        s=s.slice(0,m.index)+s.slice(i);
      }
      return s
        .replace(/\\par[d]?\b/g,"\n")
        .replace(/\\line\b/g,"\n")
        .replace(/\\tab\b/g,"\t")
        .replace(/\\'([0-9a-fA-F]{2})/g,(x,hh)=>String.fromCharCode(parseInt(hh,16)))
        .replace(/\\u(-?\d+)\s?\??/g,(x,n)=>String.fromCharCode(+n<0?+n+65536:+n))
        .replace(/\\[a-zA-Z]+-?\d*\s?/g,"")
        .replace(/[{}]/g,"")
        .split("\n").map(l=>l.replace(/[ \t]+/g," ").trim())
        .filter(Boolean).join("\n").trim();
    }

    /* Every distinct field in the stream, in the order BarTender wrote them.
       A field turns up twice — once for the template and once for the data
       entry form — so the same words are taken only once. */
    function fieldsIn(stream){
      const s=(function(){
        let out="";
        /* UTF-16LE by hand: TextDecoder would be tidier but the stream is not
           valid UTF-16 throughout and a fatal decode would throw it all away. */
        for(let i=0;i+1<stream.length;i+=2)
          out+=String.fromCharCode(stream[i]|(stream[i+1]<<8));
        return out;
      })();
      const out=[], seen={};
      let from=0;
      for(;;){
        const a=s.indexOf("{\\rtf",from);
        if(a<0) break;
        /* to the end of the RTF group */
        let d=0,i=a;
        for(;i<s.length;i++){
          if(s[i]==="{") d++;
          else if(s[i]==="}"){ d--; if(!d){ i++; break; } }
        }
        const blob=s.slice(a,i);
        from=i;
        const text=rtfText(blob);
        if(!text||text.length>600) continue;
        const key=text.toLowerCase();
        if(seen[key]) continue;
        seen[key]=1;
        const al=/\\(qc|ql|qr|qj)\b/.exec(blob);
        const fs2=/\\fs(\d+)/.exec(blob);
        out.push({
          text:text,
          bold:/\\b\b(?!\w)/.test(blob),
          italic:/\\i\b(?!\w)/.test(blob),
          /* RTF sizes are HALF-points; the studio measures type in mm. */
          mm:fs2?Math.max(1.5,Math.min(40,(+fs2[1]/2)*25.4/72)):4,
          align:al?({qc:"center",ql:"left",qr:"right",qj:"justify"})[al[1]]:"left",
        });
        if(out.length>=24) break;
      }
      return out;
    }

    /* Stacked down the label with a small margin, each line given room in
       proportion to its type size. Not where BarTender had them — see above —
       but on the label, editable, and over a guide showing where to drag. */
    function layoutFields(list,w,h){
      if(!list.length) return [];
      const mx=Math.max(1,w*0.04), my=Math.max(1,h*0.06);
      const iw=w-mx*2, ih=h-my*2;
      const weight=list.map(f=>Math.max(1,f.mm));
      const total=weight.reduce((a,b)=>a+b,0);
      let y=my;
      return list.map((f,i)=>{
        const bh=Math.max(2,ih*(weight[i]/total));
        const o={ id:uid("o_"), type:"text", text:f.text,
          x:+mx.toFixed(2), y:+y.toFixed(2), w:+iw.toFixed(2), h:+bh.toFixed(2),
          size:+Math.min(f.mm,bh*0.8).toFixed(2),
          bold:f.bold, italic:f.italic, align:f.align, valign:"middle",
          font:"arial" };
        y+=bh;
        return o;
      });
    }

    /* THE FILE NAME BEATS THE STORED TITLE. Every .btw checked out of this
       plant — six of them, different labels, different colours — carries
       <Title>BOX TEMPLATE</Title>, because each was made by "save as" from one
       original and BarTender keeps the metadata of the file it was born from.
       Importing six labels all called BOX TEMPLATE is technically faithful and
       practically useless; the name on the file is the name the operator knows
       it by. The stored title is the fallback, not the other way round. */
    function btwName(fileName,title){
      const base=String(fileName||"").replace(/\.[^.]*$/,"").trim();
      return (base||title||"Imported label").slice(0,60);
    }
    function readBtw(bytes,done,fileName){
      const hdr=btwHeader(bytes);
      if(!hdr.w||!hdr.h) return done(null,0);
      const pngs=pngsIn(bytes);
      if(!pngs.length) return done(null,0);
      const big=pngs.slice().sort((a,b)=>b.len-a.len)[0];
      const blob=new Blob([bytes.slice(big.at,big.at+big.len)],{type:"image/png"});
      const url=URL.createObjectURL(blob);
      const img=new Image();
      img.onload=()=>{
        let data="";
        try{ data=cropToLabel(img,hdr.w,hdr.h); }catch(e){ data=""; }
        URL.revokeObjectURL(url);
        /* Now go back for the words. The picture is already in hand, so if the
           text cannot be recovered the import still succeeds — it just arrives
           as artwork, which is what it used to do every time. */
        inflateFirst(bytes,(stream)=>{
          let fields=[];
          try{ fields=stream?fieldsIn(stream):[]; }catch(e){ fields=[]; }
          const objects=layoutFields(fields,hdr.w,hdr.h);
          done(cleanDoc({
            name:btwName(fileName,hdr.title),
            w:hdr.w, h:hdr.h, mode:"sheet", autoFit:true,
            /* Square: BarTender's render already carries whatever corners the
               label has, and rounding it again would shave them twice. */
            shape:"rect",
            bgImage:data, bgFit:"fill",
            /* IT ARRIVES LOOKING EXACTLY AS BarTender DRAWS IT — the render at
               full strength, at the true size, and nothing laid over it.

               The recovered fields come too, but HIDDEN. Showing them would
               print every word twice, once as type and once as part of the
               picture beneath, and dimming the picture to avoid that means the
               label does not look like itself on arrival. So the label is
               exact, and the text is waiting in Object Layers: show a field,
               drag it over its printed twin, then clear the background. */
            objects:objects.map(o=>Object.assign({},o,{hidden:true})),
          }),fields.length);
        });
      };
      img.onerror=()=>{ URL.revokeObjectURL(url); done(null,0); };
      img.src=url;
    }

    function importFiles(files){
      const list=[].slice.call(files||[]).filter(Boolean);
      if(!list.length) return;
      let added=0, skipped=0, full=false, fromBtw=0, btwText=0, btwFlat=0,
          pending=list.length;
      const why=[];
      const finish=()=>{
        if(--pending) return;
        if(added){
          docs=saveDocs(docs);
          screen="gallery"; paint();
          toast("Imported "+added+" label"+(added===1?"":"s")+
            (skipped?" \u2014 "+skipped+" file"+(skipped===1?"":"s")+" skipped":""),
            {type:"ok"});
          /* An imported .btw arrives as ARTWORK, and nobody should find that
             out at the printer. Said separately so it is not lost in a count. */
          if(btwText) toast("Imported exactly as BarTender draws it. The "+
            btwText+" text field"+(btwText===1?"":"s")+" BarTender stored "+
            (btwText===1?"is":"are")+" here too, hidden \u2014 open Object Layers "+
            "and show "+(btwText===1?"it":"one")+" to edit the wording.",
            {type:"info",title:"From BarTender",dur:11000});
          if(btwFlat) toast(btwFlat+" BarTender label"+(btwFlat===1?"":"s")+
            " came in at the right size, but no text could be read out "+
            (btwFlat===1?"of it":"of them")+" \u2014 what you have is the artwork.",
            {type:"info",title:"From BarTender",dur:9000});
        } else if(full){
          toast("That is the "+MAX_DOCS+"-template limit \u2014 nothing imported",
            {type:"warn"});
        } else {
          toast(why[0]||"Nothing to import.",
            {type:"warn",title:"Could not import",dur:8000});
        }
      };
      list.forEach(f=>{
        if(f.size>MAX_IMPORT){
          skipped++;
          why.push("\u201c"+f.name+"\u201d is larger than 12 MB");
          return finish();
        }
        const r=new FileReader();
        r.onerror=()=>{
          skipped++;
          why.push("\u201c"+f.name+"\u201d could not be read");
          finish();
        };
        r.onload=()=>{
          const bytes=new Uint8Array(r.result||new ArrayBuffer(0));
          const kind=sniff(bytes);
          if(kind==="btw"){
            /* A BarTender file: bring in its size and its artwork. */
            return readBtw(bytes,(nd,nFields)=>{
              if(!nd){ skipped++; why.push(whyNot(f,"btw")); return finish(); }
              if(docs.length>=MAX_DOCS){ full=true; return finish(); }
              nd.id=uid("d_");
              nd.name=uniqueDocName(nd.name);
              stampUsed(nd);
              docs.push(nd); added++; fromBtw++;
              if(nFields) btwText+=nFields; else btwFlat++;
              finish();
            },f.name);
          }
          if(kind!=="text"){ skipped++; why.push(whyNot(f,kind)); return finish(); }
          /* A byte-order mark and stray whitespace both make JSON.parse throw
             on a file that is otherwise perfectly good \u2014 Notepad and plenty
             of export tools leave one behind. Trim before judging. */
          const text=decode(bytes).replace(/^\uFEFF/,"").trim();
          let json=null;
          try{ json=JSON.parse(text); }
          catch(e){ skipped++; why.push(whyNot(f,"text")); return finish(); }
          const raw=labelsIn(json).filter(looksLikeLabel);
          if(!raw.length){ skipped++; why.push(whyNot(f,"text")); return finish(); }
          raw.forEach(x=>{
            if(docs.length>=MAX_DOCS){ full=true; return; }
            const nd=cleanDoc(x);
            /* A fresh identity, always. An imported file carries the ids it was
               saved with, and reusing one would have two templates answering to
               the same name inside the run planner. */
            nd.id=uid("d_");
            nd.name=uniqueDocName(nd.name);
            nd.objects.forEach(o=>{ o.id=uid("o_"); });
            stampUsed(nd);
            docs.push(nd); added++;
          });
          finish();
        };
        /* ArrayBuffer, not text: see sniff() above. */
        r.readAsArrayBuffer(f);
      });
    }

    /* One hidden input, reused: a fresh one per click litters the document, and
       the same file picked twice in a row fires no change event unless the value
       is cleared first. */
    let importInput=null;
    function askForFile(){
      if(!importInput){
        /* NO accept FILTER AT ALL. A label may arrive named .btw, .json, .txt,
           .label or nothing whatever, and a filter that guesses wrong greys out
           the very file the operator came to import — with no explanation, in a
           dialog that cannot show one. Everything is offered; what it actually
           holds is decided by reading it, and whyNot() explains any refusal in
           words. */
        importInput=h("input",{type:"file",multiple:"multiple",
          style:"display:none"});
        importInput.addEventListener("change",()=>{
          /* ⚠ COPY THE LIST FIRST. input.files is LIVE, and clearing the value
             empties it — do that before the reads and there is nothing left to
             read by the time they run. */
          const picked=[].slice.call(importInput.files||[]);
          importInput.value="";
          importFiles(picked);
        });
      }
      /* ⚠ ON document.body, NOT the studio root. paint() empties the root on
         every repaint — including the repaint at the end of an import — so an
         input parked there is thrown away and the NEXT click opens nothing. */
      if(!importInput.isConnected) document.body.appendChild(importInput);
      importInput.click();
    }

    function galleryPane(){
      const wrap=h("div",{class:"ls-gal"});
      const total=docs.length;

      /* ---- the banner ---- */
      wrap.appendChild(h("div",{class:"ls-hero"},[
        h("div",{class:"ls-hero-l"},[
          h("div",{class:"ls-hero-k",text:"LABEL STUDIO"}),
          h("div",{class:"ls-hero-t",text:total?"Welcome back":"Design your first label"}),
          h("div",{class:"ls-hero-s",text:total
            ? "Open a label to edit and print it, or start a new one. Everything you save is on the server — it is there on every machine that signs in."
            : "Text, barcodes, QR codes and pictures, printed by the sheet or the roll. Start with the size you are printing on and the canvas does the rest."}),
          /* The banner keeps one control only: the way BACK to a label
             already open. Starting one and importing one both belong with
             the library itself, below — which is where you are looking when
             you want either. The two counters that used to sit on the right
             answered a question nobody was asking. */
          opened?h("div",{class:"ls-hero-a"},[
            h("button",{class:"btn",onclick:()=>{screen="design";paint();},
              text:"← Back to “"+doc().name+"”"}),
          ]):null,
        ].filter(Boolean)),
      ]));

      /* ---- everything, searchable ---- */
      const q=galQuery.trim().toLowerCase();
      const hits=docs.map((d,i)=>({d,i})).filter(({d})=>
        !q||d.name.toLowerCase().indexOf(q)>=0||sizeS(d.w,d.h).indexOf(q)>=0);

      const search=h("input",{class:"input ls-search",type:"search",
        placeholder:"Search your labels…","aria-label":"Search labels"});
      search.value=galQuery;
      /* Filtered in place: rebuilding the pane on every keystroke would take
         the caret out of the box on the first letter. */
      search.addEventListener("input",()=>{
        galQuery=search.value;
        const qq=galQuery.trim().toLowerCase();
        let shown=0;
        wrap.querySelectorAll(".ls-gal-card[data-name]").forEach(el=>{
          const hit=!qq||el.getAttribute("data-name").indexOf(qq)>=0;
          el.hidden=!hit; if(hit) shown++;
        });
        const none=wrap.querySelector(".ls-gal-none");
        if(none) none.hidden=!!shown;
      });

      wrap.appendChild(h("div",{class:"ls-sec"},[
        h("div",{class:"ls-sec-h"},[
          h("span",{class:"ls-lbl",text:total?"All labels":"Nothing saved yet"}),
          h("span",{class:"hint",style:"margin:0",text:total
            ? "Click one to open it. Right-click a name in the designer for more."
            : "Start one below, design it, and press Save — it will be waiting here next time."}),
          h("div",{class:"sp"}),
          /* Import sits with the library it adds to. It is an occasional
             errand — a supplier's file, a restore from a backup — and the
             banner was too loud a place to keep asking about it. */
          h("button",{class:"btn sm",onclick:askForFile,
            title:"Bring in a label downloaded from a Label Studio. Any file name "+
                  "will do — the contents decide. One file may hold several. "+
                  "BarTender .btw files cannot be read."},
            [ico("open",13),h("span",{text:"Import label…"})]),
          total>3?search:null,
        ].filter(Boolean)),
      ]));

      const grid=h("div",{class:"ls-gal-grid"});
      grid.appendChild(h("button",{class:"ls-gal-card ls-gal-new",
        title:"Start a new label — it will ask what you are printing on",
        onclick:()=>newBlank()},[
        h("div",{class:"ls-gal-pv ls-gal-blank"},h("div",{class:"ls-gal-plus",text:"＋"})),
        h("div",{class:"ls-gal-n",text:"New label"}),
        h("div",{class:"ls-gal-d",
          text:"It asks what you are printing on — a roll, an A4 sheet, or your own size."}),
        h("div",{class:"ls-gal-m",text:"Choose the size first"}),
      ]));

      docs.forEach((d,i)=>{
        const tw=196, th=132;
        const k=Math.min(tw/(d.w*PX_MM), th/(d.h*PX_MM));
        const openIt=()=>openDoc(i);
        const card=h("div",{class:"ls-gal-card"+(i===di&&opened?" on":""),
          role:"button",tabindex:"0",title:"Open “"+d.name+"”",
          /* what the search box matches on, so filtering never has to rebuild
             the grid and take the caret with it */
          "data-name":(d.name+" "+sizeS(d.w,d.h)+" "+(d.mode==="roll"?"roll":"sheet")).toLowerCase(),
          onclick:(e)=>{ if(e.target.closest&&e.target.closest(".ls-gal-act")) return; openIt(); }},[
          h("div",{class:"ls-gal-pv",style:`height:${th}px`},
            h("div",{class:"wz-frame",
              style:`width:${(d.w*PX_MM*k).toFixed(1)}px;height:${(d.h*PX_MM*k).toFixed(1)}px`},
              h("iframe",{srcdoc:oneHtml(d,{index:0,now:new Date(),prompts:{}}),
                scrolling:"no","aria-hidden":"true",tabindex:"-1",
                style:`width:${d.w}mm;height:${d.h}mm;transform:scale(${k.toFixed(4)});transform-origin:top left`}))),
          h("div",{class:"ls-gal-n",text:d.name}),
          h("div",{class:"ls-gal-d",
            text:d.objects.length?(d.objects.length+" object"+(d.objects.length===1?"":"s")
                  +" · "+usedAgo(d)):"Empty — nothing on it yet"}),
          h("div",{class:"ls-gal-m"},[
            h("span",{text:sizeS(d.w,d.h)+" · "+(d.mode==="roll"?"roll":"sheet")}),
            h("div",{class:"sp"}),
            /* Printing is the errand most of the plant came here on. It does
               not belong behind a hover, so it sits on the card. */
            h("button",{class:"ls-gal-print",type:"button",
              title:"Open “"+d.name+"” and print it",
              onclick:(e)=>{ e.stopPropagation(); printFrom(i); }},
              [ico("print",13),h("span",{text:"Print"})]),
          ]),
          h("div",{class:"ls-gal-act"},[
            h("button",{class:"mini",title:"Rename",onclick:(e)=>{ e.stopPropagation();
              const nm=prompt("Template name",d.name); if(nm==null) return;
              d.name=String(nm).slice(0,60)||d.name; docs=saveDocs(docs); paint();
              toast("Renamed",{type:"ok"}); }},"✎"),
            h("button",{class:"mini",title:"Duplicate",onclick:(e)=>{ e.stopPropagation();
              if(docs.length>=MAX_DOCS) return toast("That is the "+MAX_DOCS+"-template limit",{type:"warn"});
              const c=cleanDoc(JSON.parse(JSON.stringify(d)));
              c.id=uid("d_"); c.name=(d.name+" copy").slice(0,60);
              c.objects.forEach(o=>o.id=uid("o_"));
              docs.push(c); docs=saveDocs(docs); paint(); toast("Duplicated",{type:"ok"}); }},"⧉"),
            h("button",{class:"mini",
              title:"Download “"+d.name+"” as a "+LABEL_EXT+" file — for backup, or to "+
                    "import into another Chhaperia ERP. BarTender cannot open it.",
              onclick:(e)=>{ e.stopPropagation(); downloadDoc(d); }},"⤓"),
            h("button",{class:"mini danger",title:"Delete",onclick:(e)=>{ e.stopPropagation();
              confirm("Delete the template “"+d.name+"”? This cannot be undone.",
                {title:"Delete template",danger:true}).then(ok=>{
                if(!ok) return;
                docs.splice(i,1);
                if(!docs.length){ opened=false; di=0; }
                else if(di>=docs.length) di=docs.length-1;
                docs=saveDocs(docs); dirty=false; paint(); toast("Template deleted",{type:"ok"});
              }); }},"✕"),
          ]),
        ]);
        card.addEventListener("keydown",(e)=>{
          if(e.key==="Enter"||e.key===" "){ e.preventDefault(); openIt(); }
        });
        grid.appendChild(card);
      });

      grid.appendChild(h("div",{class:"ls-gal-none",hidden:hits.length?"":null,
        text:"No label matches that."}));
      wrap.appendChild(grid);
      return wrap;
    }

    /* ============================================================
       THE CONTEXT MENU

       The designer's chrome is four bands and two panels, and every
       one of them is on the screen at once — so there is no menu bar
       to hang the rest of the commands on. They hang on the right
       button instead, over the thing they act on, which is where a
       drawing program has put them since before there were ribbons.
       ============================================================ */
    let ctxEl=null;
    function closeCtx(){ if(ctxEl){ ctxEl.remove(); ctxEl=null; } }
    /* Placing ANY popover — the context menu, the colour palette, a combo's
       drop-down — inside the studio's own box, measured rather than guessed,
       and never two at once. */
    function popAt(x,y,box){
      closeCtx();
      root.appendChild(box);
      ctxEl=box;
      const rr=root.getBoundingClientRect(), bb=box.getBoundingClientRect();
      box.style.left=Math.max(4,Math.min(x-rr.left,rr.width -bb.width -6))+"px";
      box.style.top =Math.max(4,Math.min(y-rr.top ,rr.height-bb.height-6))+"px";
      return box;
    }
    function ctxMenu(x,y,items){
      const box=h("div",{class:"ls-ctx"});
      items.forEach(it=>{
        if(it.sep) return box.appendChild(h("div",{class:"ls-ctx-sep"}));
        const el=h("button",{class:"ls-ctx-i"+(it.disabled?" off":"")+(it.danger?" danger":""),
          type:"button",
          onclick:(e)=>{ e.stopPropagation(); closeCtx();
            if(!it.disabled&&it.onclick) it.onclick(); }},[
          h("span",{class:"ls-ctx-m",text:it.check?"✓":""}),
          h("span",{class:"ls-ctx-l",text:it.label}),
          h("span",{class:"ls-ctx-k",text:it.hint||""}),
        ]);
        if(it.disabled) el.disabled=true;
        box.appendChild(el);
      });
      root.appendChild(box);
      ctxEl=box;
      /* Placed AFTER it is in the document, so the size that keeps it on screen
         is its measured size rather than a guess at it. */
      const rr=root.getBoundingClientRect(), bb=box.getBoundingClientRect();
      box.style.left=Math.max(4,Math.min(x-rr.left,rr.width -bb.width -6))+"px";
      box.style.top =Math.max(4,Math.min(y-rr.top ,rr.height-bb.height-6))+"px";
      return box;
    }
    /* A click anywhere else puts it away. */
    const onDocClick=()=>{
      if(!root.isConnected){ document.removeEventListener("click",onDocClick); return; }
      closeCtx();
    };
    document.addEventListener("click",onDocClick);

    /* Everything that can be done TO an object, over the object. */
    function objectMenu(e,o){
      e.preventDefault(); e.stopPropagation();
      /* Right-clicking an object selects it first — a menu that acts on
         something other than what is under the pointer is a trap. */
      /* Right-clicking an object that is NOT picked selects it. Right-clicking
         one that IS — or bare label while several are picked — leaves the
         selection alone, so "align these six" is reachable from inside the
         selection instead of destroying it on the way to the menu. */
      if(o&&!isSel(o)){ setSel(o.id); paint(); }
      const s=selObj(), d=doc();
      ctxMenu(e.clientX,e.clientY,[
        {label:"Cut",             hint:"Ctrl+X", disabled:!s, onclick:cutSel},
        {label:"Copy",            hint:"Ctrl+C", disabled:!s, onclick:copySel},
        {label:"Paste",           hint:"Ctrl+V", disabled:!clip, onclick:pasteClip},
        {label:"Duplicate",       hint:"Ctrl+D", disabled:!s, onclick:dupSel},
        {label:"Delete",          hint:"Del", danger:true, disabled:!s, onclick:delSel},
        {sep:true},
        {label:"Bring to front",  disabled:!s, onclick:()=>order("front")},
        {label:"Bring forward",   disabled:!s, onclick:()=>order("up")},
        {label:"Send backward",   disabled:!s, onclick:()=>order("down")},
        {label:"Send to back",    disabled:!s, onclick:()=>order("back")},
        {sep:true},
        {label:"Select all",      hint:"Ctrl+A", onclick:()=>{
          selIds=d.objects.filter(x=>!x.hidden).map(x=>x.id); paint(); }},
        {sep:true},
        {label:selIds.length>1?"Align left edges":"Align left",
          disabled:!s, onclick:()=>alignTo("left")},
        {label:selIds.length>1?"Centre on each other":"Centre across",
          disabled:!s, onclick:()=>alignTo("cx")},
        {label:selIds.length>1?"Align right edges":"Align right",
          disabled:!s, onclick:()=>alignTo("right")},
        {label:selIds.length>1?"Align tops":"Align top",
          disabled:!s, onclick:()=>alignTo("top")},
        {label:selIds.length>1?"Centre in a row":"Centre down",
          disabled:!s, onclick:()=>alignTo("cy")},
        {label:selIds.length>1?"Align bottoms":"Align bottom",
          disabled:!s, onclick:()=>alignTo("bottom")},
        {label:"Fit to label width", disabled:!s, onclick:()=>alignTo("full")},
        {label:"Shrink text to fit its box",
          disabled:!s||s.type!=="text", onclick:()=>fitTextToBox(s)},
        {sep:true},
        {label:"Spread evenly across", disabled:selIds.length<3,
          onclick:()=>distribute("x")},
        {label:"Spread evenly down",   disabled:selIds.length<3,
          onclick:()=>distribute("y")},
        {sep:true},
        {label:"Snap to grid",    check:d.snap,  onclick:()=>{d.snap=!d.snap;touch();paint();}},
        {label:"Rulers",          check:rulers,  onclick:()=>{rulers=!rulers;paint();}},
        {label:"Label layout…",   hint:sizeS(d.w,d.h), onclick:layoutDialog},
        {label:"Page setup…",     onclick:pageSetupDialog},
        {sep:true},
        {label:"Properties…",     hint:"double-click", disabled:!s, onclick:()=>propsDialog()},
      ]);
    }

    /* ============================================================
       THE CLIPBOARD — one object, cut or copied.
       Held in the studio rather than in the system clipboard: the
       thing being carried is a document object with a data source, a
       symbology and a position in millimetres, and none of that
       survives a round trip through text/plain.
       ============================================================ */
    function copySel(){
      const o=selObj(); if(!o) return;
      clip=JSON.parse(JSON.stringify(o));
      toast("Copied",{type:"ok"});
      paint();
    }
    function cutSel(){
      const o=selObj(); if(!o) return;
      clip=JSON.parse(JSON.stringify(o));
      delSel();
    }
    function pasteClip(){
      if(!clip) return toast("Nothing on the clipboard",{type:"warn"});
      if(doc().objects.length>=MAX_OBJ)
        return toast("That is the "+MAX_OBJ+"-object limit",{type:"warn"});
      /* Re-validated against the CURRENT label, not the one it was copied from:
         a 60 mm-wide field pasted onto a 25 mm flag has to be clamped. */
      const c=cleanObject(JSON.parse(JSON.stringify(clip)),doc());
      if(!c) return;
      c.id=uid("o_"); c.x=+(c.x+3).toFixed(1); c.y=+(c.y+3).toFixed(1);
      doc().objects.push(c); setSel(c.id); touch(); paint();
    }

    /* ============================================================
       THE RIBBON — Clipboard · Font · Paragraph · Spacing

       Groups of stacked rows with the group's name underneath, the
       way every office application has drawn a ribbon since 2007.
       This is the ONLY place type is formatted on the ribbon; the
       Object Properties panel on the right edits the SAME fields of
       the SAME object, so the two can never disagree — they are two
       views of one value, not two settings.
       ============================================================ */
    /* the sizes a label is ever set in — 0.6 mm is unreadable, 120 mm a poster */
    const SIZES=["1.5","2","2.5","3","3.5","4","4.5","5","6","7","8","9","10","12","14","16","20","24"];
    /* A design saved before this list existed can carry a size that is not on
       it. Rather than show an empty box — which reads as "no size" and is a lie
       — the size it actually is joins the list, in its place. */
    const optsWith=(list,cur)=>{
      const c=String(+cur);
      return (list.indexOf(c)>=0?list:list.concat([c]).sort((a,b)=>(+a)-(+b)))
        .map(x=>({v:x,l:x}));
    };
    const LINEHS=["1","1.15","1.25","1.5","2","2.5","3"];

    const rbtn=(opt)=>{
      const b=h("button",{class:"ls-b"+(opt.on?" on":"")+(opt.cls?" "+opt.cls:""),
        type:"button",title:opt.title||opt.label||"",
        onclick:opt.off?null:opt.onclick});
      if(opt.icon) b.appendChild(ico(opt.icon,opt.size||16));
      if(opt.html) b.appendChild(h("span",{class:"ls-bt",html:opt.html}));
      else if(opt.text) b.appendChild(h("span",{class:"ls-bt",text:opt.text}));
      if(opt.off){ b.disabled=true; b.classList.add("off"); }
      return b;
    };
    /* the tall buttons: an icon over its caption */
    const rbig=(opt)=>{
      const b=h("button",{class:"ls-bb"+(opt.on?" on":""),type:"button",
        title:opt.title||opt.label.replace(/\n/g," "),onclick:opt.off?null:opt.onclick},[
        ico(opt.icon,opt.size||22),
        h("span",{class:"ls-bbl",text:opt.label}),
      ]);
      if(opt.off){ b.disabled=true; b.classList.add("off"); }
      return b;
    };
    /* the small labelled rows stacked beside Paste */
    const rsm=(opt)=>{
      const b=h("button",{class:"ls-bs",type:"button",title:opt.title||opt.label,
        onclick:opt.off?null:opt.onclick},[ico(opt.icon,13),h("span",{text:opt.label})]);
      if(opt.off){ b.disabled=true; b.classList.add("off"); }
      return b;
    };
    const rsel=(val,opts,onCh,w,title,off)=>{
      const el=h("select",{class:"ls-sel",title:title||"",
        style:w?("width:"+w+"px"):""},opts.map(x=>h("option",{value:x.v},x.l)));
      el.value=val;
      el.addEventListener("change",()=>onCh(el.value));
      if(off) el.disabled=true;
      return el;
    };
    /* ============================================================
       COLOUR — a palette, not just the operating system's picker.

       The OS picker is a good tool and a bad default: it is modal, it
       looks different on every machine that signs in, and it makes
       you MIX a colour when what you wanted was black. A label is
       printed in a handful of colours — the blacks and greys of
       thermal transfer, the reds and ambers of a warning, the brand
       orange — and picking one of those should be one click.

       So the chip opens a palette: the printable colours, the ones
       you used last, a box to type a hex value off a brand sheet,
       and the OS picker still there under "More colours" for the day
       you genuinely need to mix one.
       ============================================================ */
    const SWATCHES=[
      "#000000","#3c4043","#5f6368","#80868b","#9aa0a6","#bdc1c6","#dadce0","#ffffff",
      "#7f0000","#b00020","#d93025","#ea4335","#f28b82","#fce8e6","#e8710a","#f06820",
      "#5c3d00","#a35200","#f9ab00","#fbbc04","#fdd663","#fef7e0","#33691e","#0d652d",
      "#137333","#1e8e3e","#34a853","#81c995","#e6f4ea","#004d40","#0b7b83","#12b5cb",
      "#0b3d91","#174ea6","#1a73e8","#4285f4","#8ab4f8","#e8f0fe","#4a148c","#7627bb",
      "#a142f4","#d7aefb","#3e2723","#6d4c41","#8d6e63","#bcaaa4","#efebe9","#e84820",
    ];
    /* Held for the session, not written to the server: a colour you reached for
       a minute ago is worth a click, a colour you reached for last March is
       just noise in the palette. */
    let recentCols=[];
    function pushRecent(v){
      if(!/^#[0-9a-fA-F]{6}$/.test(String(v||""))) return;
      v=String(v).toLowerCase();
      recentCols=[v].concat(recentCols.filter(x=>x!==v)).slice(0,16);
    }
    function colorPop(anchor,cur,onPick,allowNone){
      const ab=anchor.getBoundingClientRect();
      const box=h("div",{class:"ls-cpop"});
      const take=(v)=>{ pushRecent(v); closeCtx(); onPick(v); };
      const swat=(v)=>h("button",{type:"button",title:String(v).toUpperCase(),
        class:"ls-cs"+(String(cur||"").toLowerCase()===String(v).toLowerCase()?" on":""),
        style:"background:"+v,onclick:(e)=>{ e.stopPropagation(); take(v); }});

      if(allowNone) box.appendChild(h("button",{class:"ls-cnone",type:"button",
        title:"Leave it clear — not white, but nothing at all",
        onclick:(e)=>{ e.stopPropagation(); closeCtx(); onPick(""); }},[
        h("i",{class:"ls-swc none"}), h("span",{text:"No colour"})]));

      box.appendChild(h("div",{class:"ls-chead",text:"Label colours"}));
      box.appendChild(h("div",{class:"ls-cgrid"},SWATCHES.map(swat)));
      if(recentCols.length){
        box.appendChild(h("div",{class:"ls-chead",text:"Recent"}));
        box.appendChild(h("div",{class:"ls-cgrid"},recentCols.map(swat)));
      }

      box.appendChild(h("div",{class:"ls-chead",text:"Type a hex value"}));
      const hexIn=h("input",{class:"ls-chex",type:"text",maxlength:"7",spellcheck:"false",
        placeholder:"#1A73E8","aria-label":"Hex colour"});
      hexIn.value=/^#[0-9a-fA-F]{6}$/.test(String(cur||""))?String(cur).toUpperCase():"";
      const takeHex=()=>{
        let v=String(hexIn.value||"").trim();
        if(/^[0-9a-fA-F]{6}$/.test(v)) v="#"+v;
        if(!/^#[0-9a-fA-F]{6}$/.test(v))
          return toast("A hex colour reads like #1A73E8 — six digits after the hash",{type:"warn"});
        take(v.toLowerCase());
      };
      hexIn.addEventListener("keydown",(e)=>{
        if(!(e.ctrlKey||e.metaKey)) e.stopPropagation();
        if(e.key==="Enter"){ e.preventDefault(); takeHex(); } });
      box.appendChild(h("div",{class:"ls-crow"},[hexIn,
        h("button",{class:"ls-cok",type:"button",text:"Use",
          onclick:(e)=>{ e.stopPropagation(); takeHex(); }})]));

      /* the platform picker, still here, for the day a colour must be mixed */
      const native=h("input",{type:"color",class:"ls-swin"});
      native.value=/^#[0-9a-fA-F]{6}$/.test(String(cur||""))?cur:"#000000";
      native.addEventListener("change",()=>take(native.value));
      box.appendChild(h("label",{class:"ls-cmore",title:"The full colour picker"},
        [ico("grid",13), h("span",{text:"More colours…"}), native]));

      /* clicks inside the palette are the palette's own business */
      box.addEventListener("click",(e)=>e.stopPropagation());
      return popAt(ab.left,ab.bottom+3,box);
    }
    /* The chip that shows a colour and opens the palette above.
       opts: {glyph} a letter over a colour BAR, Word-style, for the two chips
       that sit side by side; {read} spell the value out; {full} fill the
       column; {allowNone} offer "no colour". */
    const colorBtn=(cur,title,onPick,off,opts)=>{
      opts=opts||{};
      const kids=[];
      if(opts.glyph) kids.push(h("span",{class:"ls-cw"},[
        h("span",{class:"ls-cglyph",text:opts.glyph}),
        h("i",{class:"ls-swc bar"+(cur?"":" none"),style:cur?("background:"+cur):""}),
      ]));
      else kids.push(h("i",{class:"ls-swc"+(cur?"":" none"),style:cur?("background:"+cur):""}));
      if(opts.read) kids.push(h("span",{class:"ls-swt",
        text:cur?String(cur).toUpperCase():"None"}));
      kids.push(ico("chev",11));
      const b=h("button",{type:"button",title:title||"",
        class:"ls-swatch"+(off?" off":"")+(opts.full?" ls-swfull":""),
        onclick:off?null:(e)=>{ e.stopPropagation(); colorPop(b,cur,onPick,opts.allowNone); }},kids);
      if(off) b.disabled=true;
      return b;
    };

    /* ============================================================
       A TYPABLE COMBO — the presets one click away, and any value
       in between simply typed.

       A drop-down alone cannot say 4.2 mm, and 4.2 mm is exactly
       what fits when 4.5 overruns the box by a hair and 4 leaves a
       gap. The list is the common sizes; the box is the truth.
       ============================================================ */
    function combo(val,list,onCommit,w,title,off,unit){
      const wrap=h("div",{class:"ls-combo"+(off?" off":""),style:w?("width:"+w+"px"):""});
      const inp=h("input",{class:"ls-cin",type:"text",inputmode:"decimal",
        spellcheck:"false",title:title||"","aria-label":title||""});
      inp.value=String(+val);
      inp.disabled=!!off;
      const take=()=>onCommit(parseFloat(String(inp.value).replace(",",".")));
      inp.addEventListener("change",take);
      inp.addEventListener("keydown",(e)=>{
        /* Typing belongs to the box; Ctrl+S still belongs to the studio. */
        if(!(e.ctrlKey||e.metaKey)) e.stopPropagation();
        if(e.key==="Enter"){ e.preventDefault(); inp.blur(); }
      });
      const car=h("button",{class:"ls-ccar",type:"button",title:title||"",
        onclick:off?null:(e)=>{
          e.stopPropagation();
          const b=wrap.getBoundingClientRect();
          ctxMenu(b.left,b.bottom+2,list.map(x=>({
            /* millimetres AND points: the number a label is measured in, and
               the number everyone has typed a font size in since school */
            label:unit==="mm"?(x+" mm"+"   ("+mmToPt(x)+" pt)")
                 :unit?(x+" "+unit):String(x),
            check:String(+x)===String(+inp.value), onclick:()=>onCommit(+x)})));
        }},ico("chev",11));
      if(off) car.disabled=true;
      wrap.appendChild(inp); wrap.appendChild(car);
      return wrap;
    }
    const caseMenu=(e,o)=>{
      e.stopPropagation();
      const b=e.currentTarget.getBoundingClientRect();
      const set=(v)=>onSel((s)=>{s.tcase=v;})();
      ctxMenu(b.left,b.bottom+2,[
        {label:"Aa   As typed",             check:o.tcase==="none",  onclick:()=>set("none")},
        {label:"AA   UPPERCASE",            check:o.tcase==="upper", onclick:()=>set("upper")},
        {label:"aa   lowercase",            check:o.tcase==="lower", onclick:()=>set("lower")},
        {label:"Aa   Capitalise Each Word", check:o.tcase==="title", onclick:()=>set("title")},
      ]);
    };

    function ribbon(){
      const o=selObj();
      const isText=!!o&&o.type==="text";
      const canType=!!o&&(o.type==="text"||o.type==="barcode"||o.type==="qr");
      /* Colour means the ink of whatever is selected: the type of a text field,
         the bars of a barcode, the stroke of a shape or a rule. */
      const inkOf=(s)=>(s.type==="line"||s.type==="box"||s.type==="ellipse")?s.stroke:s.color;
      const setInk=(v)=>{
        const s=selObj(); if(!s) return;
        if(s.type==="line"||s.type==="box"||s.type==="ellipse") s.stroke=v; else s.color=v;
        touch(); paint();
      };

      /* ---- Clipboard ---- */
      const gClip=h("div",{class:"ls-rgb"},[
        rbig({icon:"paste",label:"Paste",off:!clip,onclick:pasteClip,
          title:"Paste the object on the clipboard  (Ctrl+V)"}),
        h("div",{class:"ls-rcol ls-rstack"},[
          rsm({icon:"cut",  label:"Cut",   off:!o, onclick:cutSel, title:"Cut  (Ctrl+X)"}),
          rsm({icon:"copy", label:"Copy",  off:!o, onclick:copySel,title:"Copy  (Ctrl+C)"}),
          rsm({icon:"trash",label:"Delete",off:!o, onclick:delSel, title:"Delete  (Del)"}),
        ]),
      ]);

      /* ---- Font ---- */
      const gFont=h("div",{class:"ls-rgb"},[h("div",{class:"ls-rcol"},[
        h("div",{class:"ls-rrow"},[
          rsel(canType?o.font:"times",FONTS.map(f=>({v:f.v,l:f.l})),
            onSel((s,v)=>{s.font=v;}),150,"Font",!canType),
          /* TYPE ANY SIZE. This was a drop-down of the common sizes and
             nothing else, so a field that needed 4.2 mm could not be set at
             all. The list is still one click away on the caret. */
          combo(canType?o.size:4,SIZES,(v)=>setSize(v),66,
            o&&o.type!=="text"?"Size of the printed caption, in millimetres — type any value"
                              :"Type size in millimetres — type any value, or pick one",
            !canType,"mm"),
          h("span",{class:"ls-unit",text:"mm"}),
        ]),
        h("div",{class:"ls-rrow"},[
          rbtn({text:"B",cls:"ls-fx-b",title:"Bold",off:!isText,on:isText&&o.bold,
            onclick:onSel(s=>{s.bold=!s.bold;})}),
          rbtn({text:"I",cls:"ls-fx-i",title:"Italic",off:!isText,on:isText&&o.italic,
            onclick:onSel(s=>{s.italic=!s.italic;})}),
          rbtn({text:"U",cls:"ls-fx-u",title:"Underline",off:!isText,on:isText&&o.underline,
            onclick:onSel(s=>{s.underline=!s.underline;})}),
          rbtn({html:'A<i>▲</i>',cls:"ls-fx-a",title:"Grow the type one step",off:!canType,
            onclick:()=>stepSize(1)}),
          rbtn({html:'A<i>▼</i>',cls:"ls-fx-a",title:"Shrink the type one step",off:!canType,
            onclick:()=>stepSize(-1)}),
          h("div",{class:"ls-rsep"}),
          rbtn({html:'A<i>▾</i>',cls:"ls-fx-a",title:"Change case",off:!isText,
            onclick:(e)=>caseMenu(e,o)}),
          colorBtn(o?inkOf(o):"#000000",
            o&&o.type!=="text"?"Colour — the ink this prints in"
                              :"Text colour — the ink the type prints in",
            setInk,!o,{glyph:"A"}),
          /* WORD'S HIGHLIGHTER. The block of colour BEHIND the text, which is
             what gives you white type in a solid black band — the clearest
             thing you can put on a carton, and the model has always carried
             it. It had no control on this screen until now. */
          colorBtn(isText?(o.shade||""):"",
            "Text background — the block of colour behind the type",
            (v)=>{ const s=selObj(); if(!s) return; s.shade=v; touch(); paint(); },
            !isText,{glyph:"▙",allowNone:true}),
        ]),
      ])]);

      /* ---- Paragraph ---- */
      const al=(icon,v,title)=>rbtn({icon,title,off:!isText,on:isText&&o.align===v,
        onclick:onSel(s=>{s.align=v;})});
      const va=(icon,v,title)=>rbtn({icon,title,off:!isText,on:isText&&o.valign===v,
        onclick:onSel(s=>{s.valign=v;})});
      const gPara=h("div",{class:"ls-rgb"},[
        h("div",{class:"ls-rcol"},[
          h("div",{class:"ls-rrow"},[
            al("alignleft","left","Align left"),
            al("aligncenter","center","Centre"),
            al("alignright","right","Align right"),
            al("alignjustify","justify","Justify — spread the lines to both edges"),
          ]),
          h("div",{class:"ls-rrow"},[
            va("valigntop","start","Text to the top of its box"),
            va("valignmid","middle","Text centred in its box"),
            va("valignbot","end","Text to the bottom of its box"),
            rbtn({icon:"valignfit",title:"Fit the box to the label's width",off:!o,
              onclick:()=>alignTo("full")}),
          ]),
        ]),
        rbig({icon:"textdir",label:"Text\nDirection",off:!o,on:!!o&&!!o.rot,
          title:"Turn the object a quarter turn at a time",
          onclick:onSel(s=>{s.rot=((+s.rot||0)+90)%360;})}),
        rbig({icon:"wraptext",label:"Wrap\nText",off:!isText,on:isText&&o.wrap!==false,
          title:"Let the line wrap inside its box, instead of running on",
          onclick:onSel(s=>{s.wrap=s.wrap===false;})}),
      ]);

      /* ---- Spacing ---- */
      const lh=h("input",{class:"ls-num",type:"number",step:"0.05",min:"0.8",max:"3",
        title:"Line spacing"});
      lh.value=isText?String(o.lineH):"1.0";
      lh.disabled=!isText;
      lh.addEventListener("input",()=>{
        const s=selObj(); if(!s) return;
        s.lineH=Math.min(3,Math.max(.8,+lh.value||1.25));
        refreshCanvas();
      });
      lh.addEventListener("change",()=>{ if(selObj()){ touch(); paint(); } });
      const gSpace=h("div",{class:"ls-rgb"},[h("div",{class:"ls-rcol"},[
        h("div",{class:"ls-rrow"},[
          h("span",{class:"ls-rico"+(isText?"":" off")},ico("linespacing",16)), lh,
        ]),
        h("div",{class:"ls-rrow"},[
          rbtn({icon:"indentless",title:"Less indent",off:!isText,
            onclick:onSel(s=>{s.indentL=Math.max(0,+(s.indentL-1).toFixed(1));})}),
          rbtn({icon:"indentmore",title:"More indent",off:!isText,
            onclick:onSel(s=>{s.indentL=Math.min(200,+(s.indentL+1).toFixed(1));})}),
          rbtn({icon:"spacingclear",title:"Back to plain text at the default spacing",
            off:!isText,onclick:onSel(s=>{ s.bold=false; s.italic=false; s.underline=false;
              s.strike=false; s.tcase="none"; s.shade=""; s.lineH=1.25;
              s.indentL=0; s.indentR=0; s.align="left"; s.valign="middle"; })}),
        ]),
      ])]);

      const grp=(name,content)=>h("div",{class:"ls-rg"},[
        h("div",{class:"ls-rgc"},content),
        h("div",{class:"ls-rgl",text:name}),
      ]);
      return h("div",{class:"ls-ribbon"},[
        grp("Clipboard",gClip),
        grp("Font",gFont),
        grp("Paragraph",gPara),
        grp("Spacing",gSpace),
        h("div",{class:"sp"}),
        docBox(),
      ]);
    }

    /* ============================================================
       THE SIZE BLOCK — top right.

       "Label Size: 100.0 mm x 60.0 mm" was in the far corner of the
       status bar, which is the last place on a screen anyone looks
       and the furthest possible point from the canvas it describes.
       It is the fact this screen is checked for most often, so it
       sits where the eye already is. Clicking it opens the chooser,
       as it does in BarTender.

       The label NAMES are not here — they are along the foot, where
       a document's tabs belong and where they were.
       ============================================================ */
    function docBox(){
      const d=doc();
      return h("div",{class:"ls-docbox"},[
        h("button",{class:"ls-dsize",type:"button",onclick:()=>layoutDialog(),
          title:"Label size and stock — click to change",text:
            "Label Size: "+(+d.w).toFixed(1)+" mm x "+(+d.h).toFixed(1)+" mm"}),
        h("span",{class:"ls-dmode",
          text:d.mode==="roll"?"roll":(sheetGrid(d).perPage||"—")+"-up A4"}),
        h("button",{class:"ls-rfs",type:"button",
          title:full?"Leave full screen  (Esc)":"Fill the screen with the designer",
          onclick:toggleFull},ico("full",14)),
        /* THE WAY OUT, in the top-right corner where a way out belongs.
           The designer is a room you walked into from the library, and a room
           needs a door you can SEE. One existed — right-click a document tab
           for "Close", or find "Browse all labels…" inside the Open menu — but
           both are doors only somebody who already knows about them can find.

           It asks nothing before leaving, because nothing is at risk: this
           only changes which screen is drawn. The edits stay in `docs`, the
           library card shows them, and opening the label again picks up
           exactly where it left off. A confirmation here would be asking
           permission for something that costs nothing. */
        h("button",{class:"ls-exit",type:"button",
          title:dirty
            ? "Back to the label library — this design keeps its unsaved changes"
            : "Back to the label library",
          onclick:()=>{ screen="gallery"; paint(); }},[
          ico("chev",14),
          h("span",{text:"My Labels"}),
        ]),
      ]);
    }

    /* ============================================================
       THE DOCUMENT TABS — one per label, along the foot.
       ============================================================ */
    function docTabs(){
      const bar=h("div",{class:"ls-tabs"});
      docs.forEach((x,i)=>{
        const on=i===di;
        bar.appendChild(h("div",{class:"ls-tab"+(on?" on":""),
          title:x.name+"  —  click to open, double-click to rename",
          onclick:()=>{ if(i!==di) openDoc(i); },
          ondblclick:()=>{ di=i; renameDoc(); },
          oncontextmenu:(e)=>{
            e.preventDefault(); e.stopPropagation();
            if(i!==di) openDoc(i);
            ctxMenu(e.clientX,e.clientY,[
              {label:"Save",           hint:"Ctrl+S", onclick:save},
              {label:"Rename…",        onclick:renameDoc},
              {label:"Save as a copy", onclick:duplicateDoc},
              {sep:true},
              {label:"Label size…",    hint:sizeS(doc().w,doc().h), onclick:()=>layoutDialog()},
              {label:"Page setup…",    onclick:pageSetupDialog},
              {label:"Print…",         hint:"Ctrl+P", onclick:printDialog},
              {sep:true},
              {label:"Close",          onclick:()=>{screen="gallery";paint();}},
              {label:"Delete this label…",danger:true, onclick:()=>delDoc(i)},
            ]);
          }},[
          h("span",{class:"ls-tabn",text:x.name}),
          on&&dirty?h("span",{class:"ls-tabd",title:"Unsaved changes",text:"•"}):null,
          /* The cross DELETES the label — it does not "close a tab". There is
             nowhere for a label to go when it is closed, so a cross that only
             hid it would be a cross that lost your work. It asks first. */
          h("button",{class:"ls-tabx",type:"button",title:"Delete “"+x.name+"”",
            onclick:(e)=>{ e.stopPropagation(); delDoc(i); }},ico("close",11)),
        ].filter(Boolean)));
      });
      bar.appendChild(h("button",{class:"ls-tabadd",type:"button",
        title:"New label — it will ask what you are printing on",
        onclick:newBlank},ico("plus",13)));
      return bar;
    }

    /* Deleting a label, from the cross or from a menu. One route, one
       question, and never a silent delete. */
    function delDoc(i){
      const d=docs[i]; if(!d) return;
      confirm("Delete the label “"+d.name+"”? This cannot be undone.",
        {title:"Delete label",danger:true}).then(ok=>{
        if(!ok) return;
        docs.splice(i,1);
        if(!docs.length){ opened=false; di=0; screen="gallery"; }
        else if(di>=docs.length) di=docs.length-1;
        selIds=[]; docs=saveDocs(docs); dirty=false; resetHistory(); paint();
        toast("Label deleted",{type:"ok"});
      });
    }

    /* Any size that can be typed, held to what a label can actually print.
       Gibberish repaints rather than throwing a number away silently: the box
       goes back to the size the object really is. */
    function setSize(v){
      const s=selObj(); if(!s) return;
      if(!isFinite(v)) return paint();
      s.size=Math.round(Math.min(120,Math.max(.6,v))*100)/100;
      touch(); paint();
    }
    /* Stepping the type by the sizes people actually set, not by ±1 mm. */
    function stepSize(dir){
      const s=selObj(); if(!s) return;
      const cur=+s.size||4;
      let i=SIZES.findIndex(x=>+x>=cur-0.001);
      if(i<0) i=SIZES.length-1;
      if(dir>0) i=Math.min(SIZES.length-1,i+(+SIZES[i]===cur?1:0));
      else      i=Math.max(0,i-1);
      s.size=Math.min(120,Math.max(.6,+SIZES[i]||cur));
      touch(); paint();
    }

    /* ============================================================
       THE CANVAS TOOLBAR — the six things done every minute, and
       the zoom. It sits over the canvas rather than at the top of
       the screen because it acts on the canvas and nothing else.
       ============================================================ */
    function canvasToolbar(){
      const zpc=String(Math.round(zoom*100));
      const list=["25","50","75","100","150","200","300","400"];
      if(list.indexOf(zpc)<0){ list.push(zpc); list.sort((a,b)=>(+a)-(+b)); }
      const step=(d)=>{ zoom=Math.max(.2,Math.min(6,+(zoom+d).toFixed(2))); paint(); };
      return h("div",{class:"ls-ctb"},[
        /* OPEN, with the recent labels under it. Going back to the gallery to
           fetch the template you had open ten minutes ago is three clicks and
           a wall of cards; this is one click and a list. */
        rbtn({icon:"open",title:"Open a recent label, or browse them all",
          onclick:(e)=>{
            e.stopPropagation();
            const b=e.currentTarget.getBoundingClientRect();
            const rec=recentDocs().slice(0,10);
            const items=rec.map(({d,i})=>({
              label:d.name, hint:i===di?"open":usedAgo(d),
              check:i===di, onclick:()=>{ if(i!==di) openDoc(i); }}));
            if(items.length) items.push({sep:true});
            items.push({label:"Browse all labels…",onclick:()=>{screen="gallery";paint();}});
            items.push({label:"New label",onclick:newBlank});
            ctxMenu(b.left,b.bottom+3,items);
          }}),
        rbtn({icon:"newdoc",title:"New label",onclick:newBlank}),
        h("div",{class:"ls-ctbsep"}),
        rbtn({icon:"save",  title:"Save  (Ctrl+S)",onclick:save}),
        rbtn({icon:"print", title:"Print…  (Ctrl+P)",onclick:printDialog}),
        h("div",{class:"ls-ctbsep"}),
        rbtn({icon:"undo",  title:"Undo  (Ctrl+Z)",off:!undoS.length,onclick:undo}),
        rbtn({icon:"redo",  title:"Redo  (Ctrl+Y)",off:!redoS.length,onclick:redo}),
        h("div",{class:"ls-ctbsep"}),
        rbtn({icon:"zoomout",title:"Zoom out",onclick:()=>step(-.1)}),
        rsel(zpc,list.map(x=>({v:x,l:x+"%"})),
          (v)=>{ zoom=Math.max(.2,Math.min(6,(+v)/100)); paint(); },80,"Zoom"),
        rbtn({icon:"fit",   title:"Zoom so the whole label fits",
          onclick:()=>{zoom=fitZoom();paint();}}),
        rbtn({icon:"zoomin",title:"Zoom in",onclick:()=>step(.1)}),
      ]);
    }

    /* ============================================================
       THE TOOLS PANEL — arm a tool, then draw it on the label.
       ============================================================ */
    function armTool(t){
      tool={key:t.v,type:t.t,extra:t.extra||null};
      paint();
    }
    function toolsPanel(){
      const box=h("div",{class:"ls-panel ls-tools"});
      box.appendChild(h("div",{class:"ls-ph"},[
        h("span",{text:"Tools"}),
        h("button",{class:"ls-px",type:"button",title:"Hide the Tools panel",
          onclick:()=>{showTools=false;paint();}},ico("close",13)),
      ]));
      const list=h("div",{class:"ls-tlist"});
      TOOLS.forEach(t=>{
        const on=t.v==="select"?!tool:(!!tool&&tool.key===t.v);
        list.appendChild(h("button",{class:"ls-tool"+(on?" on":""),type:"button",
          title:t.v==="select"?"Select and move objects"
               :t.l+" — click the tool, then click the label or drag out its size",
          onclick:()=>{ if(t.v==="select"){ tool=null; paint(); } else armTool(t); }},[
          ico(t.v,16), h("span",{class:"ls-tooll",text:t.l}),
        ]));
      });
      box.appendChild(list);
      return box;
    }

    /* The canvas and its toolbar, as one column. */
    function centrePane(){
      return h("div",{class:"ls-centre"},[canvasToolbar(),canvasPane()]);
    }

    /* placing an armed tool, at a point or into a drawn rectangle */
    function placeTool(x,y,w,hh){
      if(doc().objects.length>=MAX_OBJ){ tool=null;
        return toast("That is the "+MAX_OBJ+"-object limit",{type:"warn"}); }
      const o=newObject(tool.type,doc());
      if(tool.extra){
        const ex=tool.extra;
        if(ex.src) Object.assign(o.src,ex.src);
        if(ex.prefix!=null) o.src.prefix=ex.prefix;
        if(ex.radius!=null) o.radius=ex.radius;
        /* Rich Text is a text BLOCK — several lines that wrap inside their own
           box. Text is the one-line caption a label is mostly made of. Same
           object, different starting shape, exactly as they differ in
           BarTender. */
        if(ex.rich){ o.h=Math.max(o.h,14); o.text="Rich Text"; o.wrap=true; }
        /* Icon: one glyph, centred and set large. The marks a carton is
           REQUIRED to carry are letters in a font, not pictures to upload. */
        if(ex.icon){ o.text=GLYPHS[0]; o.size=8; o.align="center";
                     o.w=Math.min(o.w,14); o.h=14; }
        if(o.src.kind!=="fixed") o.text="";
      }
      o.x=+Math.max(0,x).toFixed(1); o.y=+Math.max(0,y).toFixed(1);
      if(w>3&&hh>1){ o.w=+w.toFixed(1); o.h=+Math.max(o.type==="line"?0.2:2,hh).toFixed(1); }
      if(o.type==="line") o.h=o.strokeW;
      doc().objects.push(o); setSel(o.id); tool=null; touch(); paint();
      /* A NEW TEXT FIELD OPENS READY TO TYPE ON.
         Drawing a caption and then having to click it twice more to say what
         it says is two clicks between deciding and writing, every time. The
         placeholder is selected, so the first thing typed replaces it. */
      if(o.type==="text"&&o.src.kind==="fixed"){
        const c=root.querySelector(".ls-canvas");
        if(c) editText(o,c,PX_MM*zoom);
      }
      /* Anything else that was just placed leaves the CANVAS holding focus, so
         Delete and the arrow-key nudge reach the object straight away instead
         of after a stray click somewhere to give the canvas the keyboard. */
      else{
        const c=root.querySelector(".ls-canvas");
        if(c&&c.focus) try{ c.focus({preventScroll:true}); }catch(err){ c.focus(); }
      }
    }

    /* ---- the actions the menus perform, on EVERYTHING selected ---- */
    function dupSel(){
      const list=selObjs(); if(!list.length) return;
      if(doc().objects.length+list.length>MAX_OBJ)
        return toast("That is the "+MAX_OBJ+"-object limit",{type:"warn"});
      const made=[];
      list.forEach(o=>{
        const c=cleanObject(JSON.parse(JSON.stringify(o)),doc());
        c.id=uid("o_"); c.x=+(c.x+3).toFixed(1); c.y=+(c.y+3).toFixed(1);
        doc().objects.push(c); made.push(c.id);
      });
      selIds=made; touch(); paint();
    }
    function delSel(){
      const list=selObjs(); if(!list.length) return;
      list.forEach(o=>{
        const i=doc().objects.indexOf(o);
        if(i>=0) doc().objects.splice(i,1);
      });
      selIds=[]; touch(); paint();
    }
    /* ALIGNMENT. One object lines up against the LABEL. Two or more line up
       against each other — against the last one picked, which is the one the
       operator was looking at when they decided. That is what every drawing
       program does and it is the only reading of "align these" that does not
       need explaining. */
    function alignTo(what){
      const list=selObjs(); if(!list.length) return;
      const d=doc(), M=2;                       // the 2 mm margin a die-cut needs
      if(what==="full"){
        list.forEach(o=>{ o.x=M; o.w=Math.max(1,+(d.w-M*2).toFixed(1)); });
        touch(); paint(); return;
      }
      if(list.length===1){
        const o=list[0];
        if(what==="left")   o.x=M;
        if(what==="right")  o.x=+(d.w-o.w-M).toFixed(1);
        if(what==="cx")     o.x=+((d.w-o.w)/2).toFixed(1);
        if(what==="top")    o.y=M;
        if(what==="bottom") o.y=+(d.h-o.h-M).toFixed(1);
        if(what==="cy")     o.y=+((d.h-o.h)/2).toFixed(1);
        touch(); paint(); return;
      }
      const a=selObj();                          // the primary — the last picked
      list.forEach(o=>{
        if(o===a) return;
        if(what==="left")   o.x=a.x;
        if(what==="right")  o.x=+(a.x+a.w-o.w).toFixed(1);
        if(what==="cx")     o.x=+(a.x+(a.w-o.w)/2).toFixed(1);
        if(what==="top")    o.y=a.y;
        if(what==="bottom") o.y=+(a.y+a.h-o.h).toFixed(1);
        if(what==="cy")     o.y=+(a.y+(a.h-o.h)/2).toFixed(1);
      });
      touch(); paint();
    }
    /* SPREAD EVENLY — three or more, with the outermost two left where they
       are and the gaps between the rest made equal. Doing this by hand on a
       row of six is arithmetic nobody should be doing with a mouse. */
    function distribute(axis){
      const list=selObjs();
      if(list.length<3) return toast("Select three or more to spread them evenly",{type:"warn"});
      const lo=(o)=>axis==="x"?o.x:o.y, sz=(o)=>axis==="x"?o.w:o.h;
      const sorted=list.slice().sort((p,q)=>lo(p)-lo(q));
      const first=sorted[0], last=sorted[sorted.length-1];
      const span=(lo(last)+sz(last))-lo(first);
      const used=sorted.reduce((n,o)=>n+sz(o),0);
      const gap=(span-used)/(sorted.length-1);
      let at=lo(first);
      sorted.forEach(o=>{
        if(axis==="x") o.x=+at.toFixed(1); else o.y=+at.toFixed(1);
        at+=sz(o)+gap;
      });
      touch(); paint();
    }
    function order(where){
      const list=selObjs(); if(!list.length) return;
      const a=doc().objects;
      /* Front-to-back order is kept WITHIN the moved group: sending three
         objects to the back must not shuffle them against each other. */
      const moving=a.filter(o=>list.indexOf(o)>=0);
      if(where==="front"||where==="back"){
        moving.forEach(o=>a.splice(a.indexOf(o),1));
        if(where==="front") moving.forEach(o=>a.push(o));
        else moving.slice().reverse().forEach(o=>a.unshift(o));
      } else {
        const step=where==="up"?1:-1;
        const seq=step>0?moving.slice().reverse():moving;
        seq.forEach(o=>{
          const i=a.indexOf(o);
          const j=i+step;
          if(j<0||j>=a.length) return;
          a.splice(i,1); a.splice(j,0,o);
        });
      }
      touch(); paint();
    }
    function duplicateDoc(){
      if(docs.length>=MAX_DOCS) return toast("That is the "+MAX_DOCS+"-template limit",{type:"warn"});
      const c=cleanDoc(JSON.parse(JSON.stringify(doc())));
      c.id=uid("d_"); c.name=(doc().name+" copy").slice(0,60);
      c.objects.forEach(o=>o.id=uid("o_"));
      docs.push(c); di=docs.length-1; selIds=[]; dirty=true; resetHistory(); paint();
    }
    function renameDoc(){
      const nm=prompt("Label name",doc().name);
      if(nm==null) return;
      doc().name=String(nm).slice(0,60)||doc().name; touch(); paint();
    }
    /* Deleting the label that is open — the same question and the same route
       as the cross on its name, so there is only one way a label can go. */
    function deleteDoc(){ delDoc(di); }
    /* Re-render just the label, for edits arriving keystroke by keystroke — a
       full repaint on every character steals the caret out of the input. */
    function refreshCanvas(){
      const l=root.querySelector(".ls-layer");
      if(l) l.innerHTML=labelInner(doc(),canvasCtx());
    }
    /* A label opens as large as the stage will show it — measured after the
       paint has landed, because an element that is not in the document yet has
       no width to divide by. One frame, one refit, never a loop. */
    function fitOnce(){
      requestAnimationFrame(()=>{
        if(!root.isConnected||screen!=="design") return;
        const z=fitZoom();
        if(Math.abs(z-zoom)>0.01){ zoom=z; paint(); }
      });
    }
    function fitZoom(){
      const st=root.querySelector(".ls-stage");
      const d=doc();
      const availW=(st?st.clientWidth:640)-56, availH=(st?st.clientHeight:420)-56;
      if(availW<=0||availH<=0) return 1;
      return Math.max(.2,Math.min(6,
        +Math.min(availW/(d.w*PX_MM),availH/(d.h*PX_MM)).toFixed(2)));
    }

    /* ============================================================
       RULERS
       Word and BarTender both put a millimetre rule along the top and
       down the side, for the same reason: a label is a physical object
       and the operator is thinking in millimetres. The ticks come from
       the SAME mm-per-pixel constant the canvas is scaled by, so the
       rule and the label cannot disagree.
       ============================================================ */
    function ruler(mm,horiz,k){
      const r=h("div",{class:"ls-ruler "+(horiz?"h":"v"),
        style:horiz?`width:${(mm*k).toFixed(1)}px`:`height:${(mm*k).toFixed(1)}px`});
      const px10=10*k;
      const every=px10>=34?10:px10>=17?20:50;
      for(let v=0;v<=Math.floor(mm);v++){
        const major=v%every===0, mid=v%(every/2)===0;
        if(!major&&!mid&&k<2.2) continue;                 // hide 1 mm ticks when tight
        r.appendChild(h("i",{class:"tk"+(major?" mj":mid?" md":""),
          style:horiz?`left:${(v*k).toFixed(1)}px`:`top:${(v*k).toFixed(1)}px`}));
        if(major&&v>0) r.appendChild(h("b",{class:"tn",
          style:horiz?`left:${(v*k).toFixed(1)}px`:`top:${(v*k).toFixed(1)}px`,text:String(v)}));
      }
      return r;
    }

    /* ============================================================
       THE CANVAS — true millimetres, scaled by the zoom
       ============================================================ */
    function canvasPane(){
      const d=doc();
      const pane=h("div",{class:"ls-canvas-wrap"});
      const k=PX_MM*zoom;
      const stage=h("div",{class:"ls-stage"});
      const cv=h("div",{class:"ls-canvas"+(tool?" arm":""),tabindex:"0",
        style:`width:${(d.w*k).toFixed(1)}px;height:${(d.h*k).toFixed(1)}px;background:${d.bg};`+
          (d.shape==="ellipse"?"border-radius:50%;":d.shape==="round"?`border-radius:${d.radius*k}px;`:"")+
          (d.border?`box-shadow:inset 0 0 0 ${Math.max(1,d.borderW*k)}px ${d.borderC};`:"")});
      /* The dot grid is a CSS BACKGROUND of the canvas, not content — it exists
         only while designing and can never leak into the printed label. The
         label's own background PICTURE is not here: it is a layer inside the
         render, drawn by the same generator the printer uses, so what is on
         the canvas is the picture that will print rather than a copy of it. */
      if(d.grid>0){
        cv.style.backgroundImage="radial-gradient(circle, rgba(127,127,127,.45) "+
          Math.max(.5,k*d.grid*.035).toFixed(2)+"px, transparent "+
          Math.max(.6,k*d.grid*.04).toFixed(2)+"px)";
        cv.style.backgroundSize=(d.grid*k).toFixed(2)+"px "+(d.grid*k).toFixed(2)+"px";
      }

      /* Objects are rendered by the SAME generator the printer uses, inside a
         mm-sized layer that is then scaled — so the canvas is not an
         approximation of the label, it is the label at a different zoom. */
      const layer=h("div",{class:"ls-layer",
        style:`width:${d.w}mm;height:${d.h}mm;transform:scale(${zoom});transform-origin:top left`});
      layer.innerHTML=labelInner(d,canvasCtx());
      cv.appendChild(layer);

      /* ---- ADJUSTING THE BACKGROUND PICTURE ON THE CANVAS ----
         Only while the mode is ON, and only in Custom fit: the other fits are
         rules ("fill the label", "tile it") and dragging something that is
         obeying a rule can only fight the rule. The box sits UNDER the object
         hit-boxes, so an object over the picture is still the thing you grab,
         and its tag is the way out. */
      const skin=h("div",{class:"ls-skin"});
      if(bgEdit&&d.bgImage&&d.bgFit==="custom"&&!tool){
        const bw=d.bgW>0?d.bgW:d.w, bh=d.bgH>0?d.bgH:d.h;
        const bg=h("div",{class:"ls-bghit",title:"The background picture — drag to move, "+
          "drag a corner to resize",
          style:`left:${(d.bgX*k).toFixed(1)}px;top:${(d.bgY*k).toFixed(1)}px;`+
            `width:${Math.max(6,bw*k).toFixed(1)}px;height:${Math.max(6,bh*k).toFixed(1)}px`});
        /* The tag is the way out — the exit sits on the thing being edited,
           not only in a panel that may be closed. */
        bg.appendChild(h("button",{class:"ls-bgtag",type:"button",
          title:"Finish adjusting the background picture",
          onclick:(e)=>{ e.stopPropagation(); bgEdit=false; paint(); }},
          [ico("close",10),h("span",{text:"Background — done"})]));
        const dragBg=(e,dir)=>{
          e.preventDefault(); e.stopPropagation();
          const sx=e.clientX, sy=e.clientY;
          const b0={x:d.bgX,y:d.bgY,w:bw,h:bh};
          let moved=false;
          const snap=(v)=>d.snap&&d.grid>0?Math.round(v/d.grid)*d.grid:Math.round(v*10)/10;
          const move=(ev)=>{
            if(Math.abs(ev.clientX-sx)>2||Math.abs(ev.clientY-sy)>2) moved=true;
            const dx=(ev.clientX-sx)/k, dy=(ev.clientY-sy)/k;
            if(!dir){ d.bgX=snap(b0.x+dx); d.bgY=snap(b0.y+dy); }
            else{
              if(dir.indexOf("e")>=0) d.bgW=Math.max(2,snap(b0.w+dx));
              if(dir.indexOf("s")>=0) d.bgH=Math.max(2,snap(b0.h+dy));
              if(dir.indexOf("w")>=0){ const nx=snap(b0.x+dx);
                d.bgW=Math.max(2,b0.w+(b0.x-nx)); d.bgX=nx; }
              if(dir.indexOf("n")>=0){ const ny=snap(b0.y+dy);
                d.bgH=Math.max(2,b0.h+(b0.y-ny)); d.bgY=ny; }
            }
            /* live, through the real generator — no preview of a preview */
            layer.innerHTML=labelInner(d,canvasCtx());
            bg.style.left=(d.bgX*k).toFixed(1)+"px"; bg.style.top=(d.bgY*k).toFixed(1)+"px";
            bg.style.width=Math.max(6,(d.bgW>0?d.bgW:d.w)*k).toFixed(1)+"px";
            bg.style.height=Math.max(6,(d.bgH>0?d.bgH:d.h)*k).toFixed(1)+"px";
          };
          const up=()=>{
            document.removeEventListener("mousemove",move);
            document.removeEventListener("mouseup",up);
            if(moved) touch();
            paint();
          };
          document.addEventListener("mousemove",move);
          document.addEventListener("mouseup",up);
        };
        bg.addEventListener("mousedown",(e)=>dragBg(e,null));
        ["nw","ne","se","sw"].forEach(dir=>{
          const hd=h("div",{class:"ls-h ls-h-"+dir});
          hd.addEventListener("mousedown",(e)=>dragBg(e,dir));
          bg.appendChild(hd);
        });
        skin.appendChild(bg);
      }
      d.objects.forEach(o=>{
        const el=h("div",{class:"ls-hit"+(isSel(o)?" on":""),
          style:`left:${(o.x*k).toFixed(1)}px;top:${(o.y*k).toFixed(1)}px;`+
            `width:${Math.max(3,o.w*k).toFixed(1)}px;height:${Math.max(3,o.h*k).toFixed(1)}px;`+
            (o.rot?`transform:rotate(${o.rot}deg);`:"")});
        el.addEventListener("mousedown",(e)=>{
          if(tool) return;                       // a tool is armed: draw, don't drag
          e.preventDefault();
          /* Taking hold of an object ends any background adjusting — you have
             plainly moved on to something else. */
          bgEdit=false;
          const add=e.shiftKey||e.ctrlKey||e.metaKey;
          const wasSel=isSel(o);
          if(add){
            /* Shift or Ctrl adds to the selection, or takes out again — and a
               click that only ADDED must not also start typing. */
            addSel(o.id); paint();
            if(isSel(o)) startDrag(e,o,null,false);
            return;
          }
          /* Clicking one of several already-selected objects keeps the group,
             so a picked-out row can be dragged as a row. Clicking anything
             else selects just that. */
          if(!wasSel) setSel(o.id);
          /* CLICK ONCE to select, CLICK AGAIN to type — the way text works on
             a canvas in Word, in PowerPoint and in every drawing program. It
             cannot be the FIRST click: that click is also the start of a drag,
             and a field that dropped into edit mode the moment you touched it
             could never be moved. Only ever on a single selection. */
          startDrag(e,o,null,wasSel&&selIds.length===1);
        });
        /* Double-click TYPES on a text field — the way it does in Word, in
           PowerPoint and on the BarTender canvas. Opening a dialog to change
           a word was the single most-repeated complaint about this screen.
           Anything that is not typed into (a barcode, a picture, a shape)
           still opens its properties, because that is all there is to do. */
        el.addEventListener("dblclick",(e)=>{ e.preventDefault(); e.stopPropagation();
          setSel(o.id);
          if(textEditable(o)) editText(o,cv,k);
          else propsDialog(); });
        el.addEventListener("contextmenu",(e)=>objectMenu(e,o));
        /* Handles only on a SINGLE selection. Eight grips on each of six
           objects is a screen of grips, and resizing a group is a different
           gesture that would need its own bounding box to be honest about. */
        if(isSel(o)&&selIds.length===1&&!tool)
          ["nw","n","ne","e","se","s","sw","w"].forEach(dir=>{
            const hd=h("div",{class:"ls-h ls-h-"+dir});
            hd.addEventListener("mousedown",(e)=>{ e.preventDefault(); e.stopPropagation();
              startDrag(e,o,dir); });
            el.appendChild(hd);
          });
        skin.appendChild(el);
      });
      /* A dashed box round everything picked, so a multi-selection reads as
         ONE thing about to be moved rather than several things highlighted. */
      if(selIds.length>1){
        const list=selObjs();
        const x0=Math.min.apply(null,list.map(o=>o.x));
        const y0=Math.min.apply(null,list.map(o=>o.y));
        const x1=Math.max.apply(null,list.map(o=>o.x+o.w));
        const y1=Math.max.apply(null,list.map(o=>o.y+o.h));
        skin.appendChild(h("div",{class:"ls-selbox",
          style:`left:${(x0*k).toFixed(1)}px;top:${(y0*k).toFixed(1)}px;`+
            `width:${((x1-x0)*k).toFixed(1)}px;height:${((y1-y0)*k).toFixed(1)}px`},
          h("span",{class:"ls-selcount",text:list.length+" selected"})));
      }
      /* the smart guides live here, drawn and cleared during a drag */
      const guides=h("div",{class:"ls-guides"});
      skin.appendChild(guides);
      cv.appendChild(skin);

      /* ---- TEXT THAT DOES NOT FIT ----
         Measured after the layer is in the document, because an element that
         is not on screen yet has no height to measure. Marked on the object
         itself: finding out at the printer is finding out too late. */
      requestAnimationFrame(()=>{
        if(!cv.isConnected) return;
        d.objects.forEach(o=>{
          if(o.type!=="text"||o.hidden||!textOverflows(o)) return;
          const w=h("div",{class:"ls-over",
            style:`left:${(o.x*k).toFixed(1)}px;top:${(o.y*k).toFixed(1)}px;`+
              `width:${Math.max(3,o.w*k).toFixed(1)}px;`+
              `height:${Math.max(3,o.h*k).toFixed(1)}px`},
            h("span",{class:"ls-overtag",text:"does not fit"}));
          skin.insertBefore(w,guides);
        });
      });

      /* Drag and resize. The pointer is converted to millimetres once, so
         snapping, the readout and the stored value are all the same number. */
      /* ============================================================
         SMART GUIDES

         While something is being dragged, its edges and its centre are
         compared against the edges and centres of everything ELSE on the
         label, and against the label's own edges and middle. Anything within
         a whisker snaps to it and draws the line it snapped to.

         The whisker is measured in PIXELS and converted to millimetres, so it
         stays the same distance under the cursor at every zoom: a tolerance
         fixed in millimetres would be unusable at 400% and would snap to
         everything at 25%.
         ============================================================ */
      function guideLines(movers){
        const others=d.objects.filter(o=>movers.indexOf(o)<0&&!o.hidden);
        const V=[{v:0,edge:true},{v:d.w/2,mid:true},{v:d.w,edge:true}];
        const H=[{v:0,edge:true},{v:d.h/2,mid:true},{v:d.h,edge:true}];
        others.forEach(o=>{
          V.push({v:o.x},{v:o.x+o.w/2,mid:true},{v:o.x+o.w});
          H.push({v:o.y},{v:o.y+o.h/2,mid:true},{v:o.y+o.h});
        });
        return {V,H};
      }
      function bestSnap(cands,vals,tol){
        let best=null;
        cands.forEach(c=>{
          vals.forEach(val=>{
            const gap=c.v-val.v;
            if(Math.abs(gap)>tol) return;
            if(!best||Math.abs(gap)<Math.abs(best.gap)) best={gap,at:c.v,kind:val.k};
          });
        });
        return best;
      }
      function drawGuides(list){
        guides.innerHTML="";
        list.forEach(g=>{
          guides.appendChild(h("i",{class:"ls-g "+(g.axis==="x"?"v":"h")+(g.mid?" mid":""),
            style:g.axis==="x"?`left:${(g.at*k).toFixed(1)}px`:`top:${(g.at*k).toFixed(1)}px`}));
        });
      }

      function startDrag(e,o,dir,clickToType,noDup){
        const sx=e.clientX, sy=e.clientY;
        /* Alt while dragging leaves a copy behind and moves the copy — the
           fastest way to lay out a column of six identical fields.
           ⚠ noDup on the recursive call. Without it the SAME event, which
           still carries altKey, duplicates again on the way in, and again,
           until the 120-object limit stops it. */
        let movers=dir?[o]:selObjs();
        if(!movers.length) movers=[o];
        if(!dir&&e.altKey&&!noDup&&doc().objects.length+movers.length<=MAX_OBJ){
          const made=[];
          movers.forEach(m=>{
            const c=cleanObject(JSON.parse(JSON.stringify(m)),doc());
            c.id=uid("o_"); doc().objects.push(c); made.push(c);
          });
          selIds=made.map(c=>c.id);
          touch(); paint();
          return startDrag(e,made[0],null,false,true);  // drag the copies
        }
        const start=movers.map(m=>({o:m,x:m.x,y:m.y,w:m.w,h:m.h}));
        const o0={x:o.x,y:o.y,w:o.w,h:o.h};
        const ratio=o0.h>0?o0.w/o0.h:1;
        let moved=false;
        const gs=guideLines(movers);
        const snapG=(v)=>d.snap&&d.grid>0?Math.round(v/d.grid)*d.grid:Math.round(v*10)/10;

        const move=(ev)=>{
          /* A couple of pixels is a click with a shaky hand, not a drag. */
          if(Math.abs(ev.clientX-sx)>2||Math.abs(ev.clientY-sy)>2) moved=true;
          let dx=(ev.clientX-sx)/k, dy=(ev.clientY-sy)/k;
          const tol=6/k;                       // a fixed whisker on screen, in mm

          if(!dir){
            /* Shift locks the drag to whichever way you set off — the way a
               field is nudged along a row without drifting off it. */
            if(ev.shiftKey){
              if(Math.abs(dx)>Math.abs(dy)) dy=0; else dx=0;
            }
            const shown=[];
            /* The guides are computed from the PRIMARY object's box and the
               same correction is applied to everything moving with it, so a
               group keeps its shape while still snapping to something real. */
            const px={x:o0.x+dx,y:o0.y+dy};
            const vx=[{v:px.x,k:"l"},{v:px.x+o0.w/2,k:"c"},{v:px.x+o0.w,k:"r"}];
            const vy=[{v:px.y,k:"t"},{v:px.y+o0.h/2,k:"c"},{v:px.y+o0.h,k:"b"}];
            const gx=bestSnap(gs.V,vx,tol), gy=bestSnap(gs.H,vy,tol);
            if(gx){ dx+=gx.gap; shown.push({axis:"x",at:gx.at,mid:gx.kind==="c"}); }
            if(gy){ dy+=gy.gap; shown.push({axis:"y",at:gy.at,mid:gy.kind==="c"}); }
            drawGuides(shown);
            start.forEach(s=>{
              /* Only fall back to the grid when nothing better was found —
                 a guide the operator can SEE beats an invisible grid step. */
              s.o.x=gx?+(s.x+dx).toFixed(2):snapG(s.x+dx);
              s.o.y=gy?+(s.y+dy).toFixed(2):snapG(s.y+dy);
            });
          } else {
            /* Shift keeps the proportions while resizing. */
            if(dir.includes("e")) o.w=Math.max(1,snapG(o0.w+dx));
            if(dir.includes("s")) o.h=Math.max(.2,snapG(o0.h+dy));
            if(dir.includes("w")){ const nx=snapG(o0.x+dx); o.w=Math.max(1,o0.w+(o0.x-nx)); o.x=nx; }
            if(dir.includes("n")){ const ny=snapG(o0.y+dy); o.h=Math.max(.2,o0.h+(o0.y-ny)); o.y=ny; }
            if(ev.shiftKey&&dir.length===2&&o.type!=="line"){
              o.h=Math.max(.2,+(o.w/(ratio||1)).toFixed(2));
              if(dir.includes("n")) o.y=+(o0.y+o0.h-o.h).toFixed(2);
            }
          }
          quickPaint(movers);
        };
        const up=()=>{
          document.removeEventListener("mousemove",move);
          document.removeEventListener("mouseup",up);
          guides.innerHTML="";
          /* A click that moved nothing on an already-selected text field puts
             the caret in it, right there on the label. */
          if(!moved&&clickToType&&textEditable(o)){
            paint();
            const c=root.querySelector(".ls-canvas");
            if(c) editText(o,c,PX_MM*zoom);
            return;
          }
          /* Only bank an undo step if something actually moved — selecting an
             object used to cost a press of Ctrl+Z to get past. */
          if(moved) touch();
          paint();
        };
        document.addEventListener("mousemove",move);
        document.addEventListener("mouseup",up);
      }
      /* Re-render only what moved while the mouse is down — repainting the
         whole screen on every mousemove made dragging feel like treacle. */
      function quickPaint(movers){
        const list=Array.isArray(movers)?movers:[movers];
        layer.innerHTML=labelInner(d,canvasCtx());
        /* The hit boxes are in document order and the background box, if it is
           showing, sits in front of them — so index by the OBJECT, not by a
           count that shifts when the background appears. */
        const base=(d.bgImage&&d.bgFit==="custom"&&bgEdit&&!tool)?1:0;
        list.forEach(o=>{
          const hit=skin.children[base+d.objects.indexOf(o)];
          if(!hit) return;
          hit.style.left=(o.x*k).toFixed(1)+"px"; hit.style.top=(o.y*k).toFixed(1)+"px";
          hit.style.width=Math.max(3,o.w*k).toFixed(1)+"px";
          hit.style.height=Math.max(3,o.h*k).toFixed(1)+"px";
        });
        const rd=root.querySelector(".ls-read");
        const o=list[list.length-1];
        if(rd) rd.textContent=list.length>1
          ? (list.length+" selected  ·  moved to X "+o.x.toFixed(1)+"  Y "+o.y.toFixed(1)+" mm")
          : `X ${o.x.toFixed(1)}  Y ${o.y.toFixed(1)}  W ${o.w.toFixed(1)}  H ${o.h.toFixed(1)} mm`;
      }

      /* Drawing a newly armed object, BarTender-style: click for a default
         size, or drag out the rectangle you want it to fill. */
      cv.addEventListener("mousedown",(e)=>{
        if(!tool){
          if(e.target!==cv&&e.target!==skin&&e.target!==guides) return;
          /* ---- RUBBER-BAND SELECTION ----
             Drag across bare label and everything the band TOUCHES comes with
             it. Touching rather than enclosing, because a 2 mm rule at the
             foot of a label is nearly impossible to lasso whole and is
             exactly the sort of thing you are trying to catch. */
          e.preventDefault();
          const box=cv.getBoundingClientRect();
          const ax=(e.clientX-box.left)/k, ay=(e.clientY-box.top)/k;
          const keep=(e.shiftKey||e.ctrlKey||e.metaKey)?selIds.slice():[];
          const band=h("div",{class:"ls-band",
            style:`left:${(ax*k).toFixed(1)}px;top:${(ay*k).toFixed(1)}px;width:0;height:0`});
          cv.appendChild(band);
          let dragged=false;
          const bmove=(ev)=>{
            dragged=true;
            const bx=(ev.clientX-box.left)/k, by=(ev.clientY-box.top)/k;
            const x0=Math.min(ax,bx), y0=Math.min(ay,by);
            const x1=Math.max(ax,bx), y1=Math.max(ay,by);
            band.style.left=(x0*k).toFixed(1)+"px"; band.style.top=(y0*k).toFixed(1)+"px";
            band.style.width=((x1-x0)*k).toFixed(1)+"px";
            band.style.height=((y1-y0)*k).toFixed(1)+"px";
            const hit=d.objects.filter(o=>!o.hidden&&
              o.x<x1&&o.x+o.w>x0&&o.y<y1&&o.y+o.h>y0).map(o=>o.id);
            selIds=keep.concat(hit.filter(id=>keep.indexOf(id)<0));
            /* live: the hit boxes light up as the band passes over them */
            [].forEach.call(skin.children,(el)=>{
              const idx=[].indexOf.call(skin.children,el);
              const ob=d.objects[idx-((d.bgImage&&d.bgFit==="custom"&&bgEdit&&!tool)?1:0)];
              if(ob) el.classList.toggle("on",selIds.indexOf(ob.id)>=0);
            });
          };
          const bup=()=>{
            document.removeEventListener("mousemove",bmove);
            document.removeEventListener("mouseup",bup);
            band.remove();
            if(!dragged) selIds=keep.length?keep:[];   // a bare click clears
            paint();
          };
          document.addEventListener("mousemove",bmove);
          document.addEventListener("mouseup",bup);
          return;
        }
        e.preventDefault();
        const box=cv.getBoundingClientRect();
        const x0=(e.clientX-box.left)/k, y0=(e.clientY-box.top)/k;
        const band=h("div",{class:"ls-band",
          style:`left:${(x0*k).toFixed(1)}px;top:${(y0*k).toFixed(1)}px;width:0;height:0`});
        cv.appendChild(band);
        let x1=x0, y1=y0;
        const move=(ev)=>{
          x1=(ev.clientX-box.left)/k; y1=(ev.clientY-box.top)/k;
          band.style.left=(Math.min(x0,x1)*k).toFixed(1)+"px";
          band.style.top=(Math.min(y0,y1)*k).toFixed(1)+"px";
          band.style.width=(Math.abs(x1-x0)*k).toFixed(1)+"px";
          band.style.height=(Math.abs(y1-y0)*k).toFixed(1)+"px";
        };
        const up=()=>{
          document.removeEventListener("mousemove",move);
          document.removeEventListener("mouseup",up);
          band.remove();
          placeTool(Math.min(x0,x1),Math.min(y0,y1),Math.abs(x1-x0),Math.abs(y1-y0));
        };
        document.addEventListener("mousemove",move);
        document.addEventListener("mouseup",up);
      });
      /* The right button over bare label: the same menu, with the object
         commands greyed and the view and page commands live. */
      cv.addEventListener("contextmenu",(e)=>{
        if(e.target===cv||e.target===skin) objectMenu(e,null);
      });

      /* keyboard on the canvas: nudge, cycle, select all, delete */
      cv.addEventListener("keydown",(e)=>{
        const objs=d.objects.filter(o=>!o.hidden);
        /* TAB walks the objects in order — the way you check a label field by
           field without hunting for small ones with the mouse. */
        if(e.key==="Tab"&&objs.length){
          e.preventDefault();
          const cur=selObj();
          let i=cur?objs.indexOf(cur):-1;
          i=(i+(e.shiftKey?-1:1)+objs.length+1)%objs.length;
          setSel(objs[i].id); paint();
          const c=root.querySelector(".ls-canvas"); if(c) c.focus();
          return;
        }
        if((e.ctrlKey||e.metaKey)&&(e.key||"").toLowerCase()==="a"){
          e.preventDefault();
          selIds=objs.map(o=>o.id); paint();
          const c=root.querySelector(".ls-canvas"); if(c) c.focus();
          return;
        }
        const list=selObjs(); if(!list.length) return;
        const stepMM=(d.snap&&d.grid>0?d.grid:.5)*(e.shiftKey?5:1);
        const map={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]};
        if(map[e.key]){ e.preventDefault();
          list.forEach(o=>{
            o.x=+(o.x+map[e.key][0]*stepMM).toFixed(2);
            o.y=+(o.y+map[e.key][1]*stepMM).toFixed(2);
          });
          touch(); paint(); const c=root.querySelector(".ls-canvas"); if(c) c.focus(); return; }
        if(e.key==="Delete"||e.key==="Backspace"){ e.preventDefault(); delSel(); }
      });

      /* The label sits in a grid whose first row and column are the rules, so
         they stay pinned to its edges at every zoom without a hand-computed
         offset. */
      if(rulers){
        stage.appendChild(h("div",{class:"ls-rig"},[
          h("div",{class:"ls-corner",text:"mm"}),
          ruler(d.w,true,k),
          ruler(d.h,false,k),
          cv,
        ]));
      } else {
        stage.appendChild(cv);
      }
      pane.appendChild(stage);
      if(tool) pane.appendChild(h("div",{class:"ls-armhint",
        text:"Click the label to place it, or drag out the size you want.  Esc cancels."}));
      return pane;
    }

    /* Double-click, from wherever: type on a fixed text field, open the
       properties of anything else. Both routes must behave the same. */
    function editOrProps(o){
      setSel(o.id);
      if(textEditable(o)){
        paint();
        const cv=root.querySelector(".ls-canvas");
        if(cv) editText(o,cv,PX_MM*zoom);
      } else propsDialog();
    }

    /* ============================================================
       TYPING ON THE LABEL
       A textarea laid exactly over the object, in the object's own font
       at the object's own size, so what is being typed sits where it
       will print rather than in a box somewhere else. Enter makes a new
       line (a label field is often two or three); Escape abandons the
       edit; clicking away or Ctrl+Enter commits it.

       Only FIXED text can be typed on. A serial, a date or a prompt is
       not text — it is a rule that produces text at print time, and
       typing over it would be typing over the rule.
       ============================================================ */
    /* ============================================================
       DOES THE TEXT FIT ITS BOX?

       The document model has carried a `shrink` flag since the first
       version and nothing ever read it, so type that was too big for
       its box simply ran out of the box — on the canvas and on the
       printed sheet, silently.

       This does not quietly rescale anything at print time: a design
       that prints one size today must not print another size
       tomorrow because a measurement came out differently. It
       MEASURES the rendered object, says plainly when the text does
       not fit, and offers one click to bring it down to a size that
       does — an edit the operator makes and can undo, not a
       correction the machine applies behind them.
       ============================================================ */
    function objNode(o){
      const l=root.querySelector(".ls-layer");
      if(!l||!o) return null;
      try{ return l.querySelector('[data-i="'+o.id+'"]'); }catch(e){ return null; }
    }
    function textOverflows(o){
      if(!o||o.type!=="text") return false;
      const n=objNode(o);
      const inner=n&&(n.firstElementChild||n.firstChild);
      if(!inner||!inner.scrollHeight) return false;
      return inner.scrollHeight>n.clientHeight+1||inner.scrollWidth>inner.clientWidth+1;
    }
    /* The largest size that fits, found by halving the range against the REAL
       rendered node — so it uses the actual font, at the actual box, with the
       actual line spacing, rather than a guess at glyph widths. */
    function fitTextToBox(o){
      if(!o||o.type!=="text") return;
      const n=objNode(o);
      const inner=n&&(n.firstElementChild||n.firstChild);
      if(!inner) return toast("Open the label first",{type:"warn"});
      const fits=(sz)=>{
        inner.style.fontSize=sz+"mm";
        return inner.scrollHeight<=n.clientHeight+1&&inner.scrollWidth<=inner.clientWidth+1;
      };
      const was=o.size;
      if(fits(was)){ inner.style.fontSize=""; return toast("It already fits",{type:"ok"}); }
      let lo=.6, hi=Math.max(.6,was), best=null;
      for(let i=0;i<18;i++){
        const mid=(lo+hi)/2;
        if(fits(mid)){ best=mid; lo=mid; } else hi=mid;
      }
      inner.style.fontSize="";
      if(best==null)
        return toast("Even the smallest type will not fit — make the box bigger",{type:"warn"});
      o.size=Math.max(.6,Math.floor(best*10)/10);
      touch(); paint();
      toast("Type brought down to "+o.size+" mm to fit",{type:"ok"});
    }
    /* Millimetres are what a label is measured in; POINTS are what everyone
       has typed a font size in since school, and the reference app shows them.
       Both, so 24 is never typed meaning 24 pt and landing 24 mm tall. */
    const mmToPt=(mm)=>Math.round((+mm||0)*2.83465*10)/10;

    /* Anything whose value is typed rather than worked out. A serial, a date
       and a prompt are RULES that produce text at print time — typing over one
       would be typing over the rule — but a barcode's data is just as much a
       thing you type as a caption is, and it had to go through a dialog. */
    function textEditable(o){
      return !!o&&!o.hidden&&o.src&&o.src.kind==="fixed"&&
        (o.type==="text"||o.type==="barcode"||o.type==="qr");
    }
    /* the words an object is BORN with — typing should replace those outright,
       and never a value the operator has actually written */
    const BORN=["Text","Rich Text","12345678","https://www.chhaperiatapes.com"];

    function editText(o,cv,k){
      if(cv.querySelector(".ls-editbox")) return;               // already editing
      if(!textEditable(o)) return;
      const before=o.text;
      const isText=o.type==="text";
      const px=o.size*PX_MM*zoom;

      /* THE BOX IS A FLEX FRAME, THE TEXTAREA SITS INSIDE IT.
         A textarea cannot centre its own content vertically, so a field set to
         middle or bottom used to jump to the top the moment you started typing
         and jump back when you stopped — you were never editing what you were
         looking at. The frame does the vertical alignment and carries the
         shading, so the caret sits exactly where the ink will be. */
      const box=h("div",{class:"ls-editbox"+(isText?"":" data"),
        style:`left:${(o.x*k).toFixed(1)}px;top:${(o.y*k).toFixed(1)}px;`+
          `width:${Math.max(16,o.w*k).toFixed(1)}px;`+
          `height:${Math.max(12,o.h*k).toFixed(1)}px;`+
          `align-items:${!isText?"center"
            :o.valign==="start"?"flex-start":o.valign==="end"?"flex-end":"center"};`+
          (isText&&o.shade?`background:${o.shade};`:"")});

      const ta=h("textarea",{class:"ls-edit",spellcheck:"false",rows:"1",
        "aria-label":isText?"Text on the label":"Barcode data",
        style:isText
          ? `font:${o.italic?"italic":"normal"} ${o.bold?700:400} `+
            `${px.toFixed(2)}px/${o.lineH} ${fontCss(o.font)};`+
            `color:${o.color};text-align:${o.align==="justify"?"justify":o.align};`+
            (o.indentL?`padding-left:${(o.indentL*k).toFixed(1)}px;`:"")+
            (o.indentR?`padding-right:${(o.indentR*k).toFixed(1)}px;`:"")+
            (o.wrap===false?"white-space:pre;overflow-x:auto;":"white-space:pre-wrap;")+
            (o.underline||o.strike
              ? "text-decoration:"+[o.underline?"underline":"",o.strike?"line-through":""]
                  .filter(Boolean).join(" ")+";" : "")+
            (o.tcase&&o.tcase!=="none"
              ? "text-transform:"+(o.tcase==="upper"?"uppercase"
                  :o.tcase==="lower"?"lowercase":"capitalize")+";" : "")
          : `font:600 ${Math.max(11,Math.min(17,px||13)).toFixed(1)}px/1.35 `+
            `ui-monospace,Menlo,Consolas,monospace;color:#111827;text-align:center;`+
            `white-space:pre`});
      ta.value=o.text;
      box.appendChild(ta);
      /* From here the canvas stops drawing this object — the editor is the
         one drawing it. Everything ELSE on the label keeps rendering, which
         is the whole point: the label's background, its picture and every
         other object stay exactly as they were. */
      editingId=o.id;
      refreshCanvas();
      cv.appendChild(box);
      /* The hint is a SIBLING of the frame, not a child of it — a child would
         have to be un-clipped, and un-clipping the frame is what let the text
         sprawl out of its box in the first place. */
      const tip=h("div",{class:"ls-edittip"+(isText?"":" data"),
        style:`left:${(o.x*k).toFixed(1)}px;`+
          `top:${(o.y*k+Math.max(12,o.h*k)+3).toFixed(1)}px`,
        text:isText
          ? "Enter = new line · Tab = next field · Esc = cancel"
          : "Tab = next field · Esc = cancel"});
      cv.appendChild(tip);

      /* The box grows down to fit what is typed, and scrolls once it has run
         out of object to grow into — so a long value is never silently
         invisible while you are writing it. */
      const cap=Math.max(12,o.h*k);
      const grow=()=>{
        ta.style.height="auto";
        const want=ta.scrollHeight;
        ta.style.height=Math.min(want,cap)+"px";
        ta.style.overflowY=want>cap?"auto":"hidden";
      };
      grow();

      ta.focus();
      /* A field still holding the words it was born with is a placeholder, and
         typing should replace it outright. Anything actually written gets the
         caret at the END and nothing selected — so a correction adds to the
         value instead of wiping it, which select-all did every single time.
         Clicking inside now lands the caret where you clicked, because the
         textarea is focused and on top and the browser does it for us. */
      if(BORN.indexOf(String(o.text))>=0) ta.select();
      else { const n=ta.value.length; try{ ta.setSelectionRange(n,n); }catch(e){} }

      let done=false;
      const finish=(keep)=>{
        if(done) return before; done=true;
        ta.removeEventListener("blur",onBlur);
        const v=ta.value;
        box.remove(); tip.remove();
        editingId=null;                 // the canvas draws it again from here
        if(keep){ if(v!==before){ o.text=v; touch(); } }
        else o.text=before;
        return v;
      };
      /* TAB WALKS THE FIELDS. Filling in a label is filling in a form, and a
         form you have to aim at with a mouse between every entry is the slow
         way to do it. Commits what is there and opens the next one. */
      const step=(dir)=>{
        const list=doc().objects.filter(textEditable);
        const i=list.indexOf(o);
        finish(true);
        if(list.length<2||i<0){ paint(); return; }
        const nxt=list[(i+dir+list.length)%list.length];
        setSel(nxt.id); paint();
        const c=root.querySelector(".ls-canvas");
        if(c) editText(nxt,c,PX_MM*zoom);
      };
      const onBlur=()=>{ finish(true); paint(); };
      ta.addEventListener("blur",onBlur);
      ta.addEventListener("keydown",(e)=>{
        e.stopPropagation();                       // Ctrl+S etc. belong to the field here
        if(e.key==="Escape"){ e.preventDefault(); finish(false); paint(); return; }
        if(e.key==="Tab"){ e.preventDefault(); step(e.shiftKey?-1:1); return; }
        if(e.key==="Enter"&&(e.ctrlKey||e.metaKey)){ e.preventDefault(); finish(true); paint(); return; }
        /* A barcode's data is one line by definition — Enter finishes it
           rather than putting a newline into something that must scan. */
        if(e.key==="Enter"&&!isText){ e.preventDefault(); finish(true); paint(); return; }
      });
      /* live: what is typed appears on the label underneath as it is typed */
      ta.addEventListener("input",()=>{
        o.text=ta.value;
        grow();
        const l=root.querySelector(".ls-layer");
        if(l) l.innerHTML=labelInner(doc(),canvasCtx());
      });
    }

    /* ============================================================
       THE RIGHT RAIL — Object Properties, over Object Layers.

       The properties panel and the ribbon edit the SAME fields of
       the SAME object. That is not two copies of a control: a
       ribbon is reached with the mouse already in the air and is
       read at a glance, a panel is read down a column with its
       fields named in words, and both are wanted by different
       people on different days. What matters is that neither holds
       a value of its own — they read the object and write the
       object, so a repaint always agrees with itself.
       ============================================================ */
    const ICO_OF={text:"text",barcode:"barcode",qr:"qr",image:"image",
                  box:"rect",ellipse:"ellipse",line:"line"};

    /* WHAT AN OBJECT IS, as the operator would say it.
       A counter, a date field and a prompt are all text objects — the
       difference between them is the data source, and that difference is the
       whole point of them. A layer list that calls all three "Text" is a list
       you have to click through to read. */
    function objKind(o){
      if(o.type==="text"){
        if(o.src.kind==="serial") return "Counter";
        if(o.src.kind==="date")   return "Date / Time";
        if(o.src.kind==="prompt") return "Prompt";
        return "Text";
      }
      return (OBJ_TYPES.find(x=>x.v===o.type)||OBJ_TYPES[0]).l;
    }
    function objIcon(o){
      if(o.type==="text"){
        if(o.src.kind==="serial") return "counter";
        if(o.src.kind==="date")   return "datetime";
        if(o.src.kind==="prompt") return "prompt";
        return "text";
      }
      return ICO_OF[o.type]||"text";
    }
    /* "Text 1", "Barcode 2" — counted per kind, in document order, exactly the
       way a layer list names things. Computed rather than stored, so deleting
       the first of three never leaves a gap in the names. */
    function objName(o){
      const kind=objKind(o);
      let n=0;
      for(const x of doc().objects){ if(objKind(x)===kind){ n++; if(x.id===o.id) break; } }
      return kind+" "+n;
    }

    function rightRail(){
      return h("div",{class:"ls-right"},[propsPanel(),layersPanel()]);
    }

    /* ---- the fields the right-hand panel is built from ----
       Typing must NOT repaint — a repaint takes the caret with it. The value
       goes onto the object and the label re-renders; history is banked when
       the field is left. */
    const pLive=()=>refreshCanvas();
    const pCommit=()=>{ touch(); paint(); };
    const fL=(label,el)=>h("div",{class:"ls-f"},[h("span",{class:"ls-fl",text:label}),el]);
    const fR=(label,el)=>h("div",{class:"ls-fr"},[h("span",{class:"ls-fl",text:label}),el]);
    const pta=(val,onCh,ph)=>{
      const el=h("textarea",{class:"ls-in ls-ta",rows:"1",spellcheck:"false",
        placeholder:ph||"",maxlength:"600"});
      el.value=val==null?"":String(val);
      el.addEventListener("input",()=>{ onCh(el.value); pLive(); });
      el.addEventListener("change",pCommit);
      return el;
    };
    const psel=(val,opts,onCh,title)=>{
      const el=h("select",{class:"ls-in",title:title||""},
        opts.map(x=>h("option",{value:x.v},x.l)));
      el.value=val;
      el.addEventListener("change",()=>{ onCh(el.value); pCommit(); });
      return el;
    };
    const pnum=(val,onCh,step,min,max)=>{
      const el=h("input",{class:"ls-in",type:"number",step:String(step==null?.5:step),
        min:min==null?"":String(min),max:max==null?"":String(max)});
      el.value=String(Math.round((+val||0)*100)/100);
      el.addEventListener("input",()=>{ onCh(+el.value); pLive(); });
      el.addEventListener("change",pCommit);
      return el;
    };
    const pchk=(label,val,onCh)=>{
      const el=h("input",{type:"checkbox"}); el.checked=!!val;
      el.addEventListener("change",()=>{ onCh(el.checked); pCommit(); });
      return h("label",{class:"ls-pchk"},[el,h("span",{text:label})]);
    };
    /* the full-width colour field: the same palette the ribbon chip opens */
    const pcol=(val,onCh,allowNone,title)=>
      colorBtn(val,title||"",(v)=>{ onCh(v); pCommit(); },false,
        {full:true,read:true,allowNone:!!allowNone});
    /* A PICTURE FIELD — a thumbnail and a button, not a file input.
       A bare <input type="file"> renders as the operating system's own
       control: a different width, a different height and a different set of
       words on every machine, all of them wider than a 210 px column. The
       input is still what does the work; it is just inside the button. */
    const ppic=(cur,onSet,onClear)=>{
      const file=h("input",{class:"ls-pickin",type:"file",
        accept:"image/png,image/jpeg,image/webp,image/gif"});
      file.addEventListener("change",()=>{
        const f=file.files&&file.files[0]; if(!f) return;
        if(f.size>MAX_IMG*0.7)
          return toast("That picture is too large — keep it under about 600 KB",{type:"warn"});
        const rd=new FileReader();
        rd.onload=()=>{
          const s=String(rd.result||"");
          if(!IMG_RE.test(s)||s.length>MAX_IMG)
            return toast("That image type cannot be stored on a label",{type:"warn"});
          onSet(s); touch(); paint(); toast("Picture placed",{type:"ok"});
        };
        rd.readAsDataURL(f);
      });
      const thumb=cur
        ? h("div",{class:"ls-pic-th",style:"background-image:url('"+cur+"')"})
        : h("div",{class:"ls-pic-th none"},ico("image",18));
      /* ⚠ THE INPUT IS A SIBLING OF THE BUTTON, NEVER A CHILD OF IT.
         It was a child, and that is why "Choose picture…" did nothing:
         file.click() dispatches a click on a DESCENDANT of the button, which
         bubbles straight back up into the button's own handler and re-enters
         it. Browsers guard against re-entrant activation like that, so the
         chooser was suppressed every time and the button looked dead. An
         <input> is also not legal content for a <button> in the first place.
         Kept apart, the button asks and the input answers. */
      const pick=h("button",{class:"ls-pic-btn",type:"button",
        title:cur?"Choose a different picture":"Choose a picture from this computer",
        onclick:(e)=>{
          e.preventDefault(); e.stopPropagation();
          /* Clearing it first means choosing the SAME file twice still fires
             `change` — otherwise a re-pick after a mistake does nothing. */
          try{ file.value=""; }catch(err){}
          try{ file.click(); }
          catch(err){ toast("This browser would not open the file chooser",{type:"warn"}); }
        }},[
        ico("image",13),
        h("span",{text:cur?"Replace…":"Choose picture…"}),
      ]);
      return [h("div",{class:"ls-pic"},[
        thumb,
        h("div",{class:"ls-pic-c"},[
          pick,
          cur?h("button",{class:"ls-pic-rm",type:"button",title:"Take the picture off",
            onclick:()=>{ onClear(); touch(); paint(); },text:"Remove"}):null,
        ].filter(Boolean)),
        file,
      ])];
    };

    /* ============================================================
       LABEL PROPERTIES — the sticker itself, not what is on it.

       The background colour, a background PICTURE, the die shape,
       the cut border and the design grid. All of this existed only
       three fields down the Page setup dialog, which is a place you
       go once when you make a label and never again — so in practice
       the background of a label could not be changed. It is a
       property of the thing on the screen, so it lives beside the
       thing on the screen.
       ============================================================ */
    function labelProps(b){
      const d=doc();
      b.appendChild(h("div",{class:"ls-ptype"},[ico("rect",15),h("span",{text:"Label"})]));
      b.appendChild(h("div",{class:"ls-phint"},
        "Nothing is selected, so this is the label itself. Click an object to edit it instead."));

      b.appendChild(fL("Background colour",
        pcol(d.bg,(v)=>{ d.bg=v||"#ffffff"; },false,"The colour of the sticker itself")));

      b.appendChild(h("div",{class:"ls-psec",text:"Background picture"}));
      ppic(d.bgImage,(s)=>{d.bgImage=s;},
        ()=>{ d.bgImage=""; d.bgFit="cover"; d.bgX=0; d.bgY=0; d.bgW=0; d.bgH=0;
              d.bgOpacity=100; bgEdit=false; })
        .forEach(el=>b.appendChild(el));
      if(!d.bgImage){
        b.appendChild(h("div",{class:"ls-phint"},
          "A pre-printed sleeve, a watermark, or artwork the fields sit on top of. It prints with the label."));
      } else {
        b.appendChild(fR("Fit",psel(d.bgFit,[
          {v:"cover",  l:"Fill the label"},
          {v:"contain",l:"Fit inside"},
          {v:"fill",   l:"Stretch"},
          {v:"tile",   l:"Tile"},
          {v:"custom", l:"Place it myself"},
        ],v=>{
          /* Stepping into Custom starts from where the picture already is —
             the whole label — rather than dropping it at 0,0 at some size
             nobody chose. Stepping OUT of it ends the adjusting: the handles
             would have nothing left to move. */
          if(v==="custom"){ if(!(d.bgW>0)){ d.bgX=0; d.bgY=0; d.bgW=d.w; d.bgH=d.h; } }
          else bgEdit=false;
          d.bgFit=v;
        })));
        /* Fading it is what turns a picture into a watermark you can read type
           over, so it is offered for every fit, not only Custom. */
        b.appendChild(fR("Opacity %",pnum(d.bgOpacity,
          v=>{d.bgOpacity=Math.min(100,Math.max(5,v));},5,5,100)));

        /* ONE button in and out of adjusting. It also does the switch to
           Custom for you: being told "change the fit first" is the machine
           knowing what you meant and making you say it again. */
        b.appendChild(h("button",{class:"ls-pbtn"+(bgEdit?" on":""),type:"button",
          title:bgEdit?"Stop moving the picture"
                      :"Move and resize the picture on the canvas",
          onclick:()=>{
            if(bgEdit){ bgEdit=false; paint(); return; }
            if(d.bgFit!=="custom"){
              if(!(d.bgW>0)){ d.bgX=0; d.bgY=0; d.bgW=d.w; d.bgH=d.h; }
              d.bgFit="custom"; touch();
            }
            bgEdit=true; paint();
          }},[
          ico(bgEdit?"close":"select",13),
          h("span",{text:bgEdit?"Done adjusting":"Adjust on canvas"}),
        ]));

        if(d.bgFit==="custom"){
          b.appendChild(h("div",{class:"ls-f"},[
            h("span",{class:"ls-fl",text:"Position X · Y (mm)"}),
            h("div",{class:"ls-frow"},[
              pnum(d.bgX,v=>{d.bgX=v;},.5),
              pnum(d.bgY,v=>{d.bgY=v;},.5),
            ]),
          ]));
          b.appendChild(h("div",{class:"ls-f"},[
            h("span",{class:"ls-fl",text:"Size W · H (mm)"}),
            h("div",{class:"ls-frow"},[
              pnum(d.bgW>0?d.bgW:d.w,v=>{d.bgW=Math.max(2,v);},.5,2),
              pnum(d.bgH>0?d.bgH:d.h,v=>{d.bgH=Math.max(2,v);},.5,2),
            ]),
          ]));
          b.appendChild(h("button",{class:"ls-plink",type:"button",
            title:"Put it back over the whole label",
            onclick:()=>{ d.bgX=0; d.bgY=0; d.bgW=d.w; d.bgH=d.h; touch(); paint(); },
            text:"Reset to the whole label"}));
          if(bgEdit) b.appendChild(h("div",{class:"ls-phint"},
            "Drag the picture on the canvas to move it, or a corner to resize it. "+
            "Esc, or the tag on the picture, finishes."));
        }
      }

      b.appendChild(h("div",{class:"ls-psec",text:"Shape and border"}));
      b.appendChild(fR("Shape",psel(d.shape,[
        {v:"rect",   l:"Rectangle"},
        {v:"round",  l:"Rounded"},
        {v:"ellipse",l:"Ellipse"},
      ],v=>{d.shape=v;})));
      if(d.shape==="round")
        b.appendChild(fR("Corner (mm)",pnum(d.radius,v=>{d.radius=Math.max(0,v);},.5,0)));
      b.appendChild(pchk("Print a cut / outline border",d.border,v=>{d.border=v;}));
      if(d.border){
        b.appendChild(fL("Border colour",pcol(d.borderC,(v)=>{d.borderC=v||"#000000";})));
        b.appendChild(fR("Border (mm)",pnum(d.borderW,v=>{d.borderW=Math.max(.05,v);},.1,.05)));
      }

      b.appendChild(h("div",{class:"ls-psec",text:"Size and grid"}));
      b.appendChild(h("div",{class:"ls-f"},[
        h("span",{class:"ls-fl",text:"Width × Height (mm)"}),
        h("div",{class:"ls-frow"},[
          pnum(d.w,v=>{d.w=Math.min(1000,Math.max(5,v));},1,5,1000),
          pnum(d.h,v=>{d.h=Math.min(1000,Math.max(5,v));},1,5,1000),
        ]),
      ]));
      b.appendChild(fR("Grid (mm)",pnum(d.grid,v=>{d.grid=Math.min(20,Math.max(.5,v));},.5,.5,20)));
      b.appendChild(pchk("Snap to the grid",d.snap,v=>{d.snap=v;}));
      b.appendChild(h("button",{class:"ls-plink ls-pall",type:"button",
        onclick:layoutDialog,text:"Label layout and stock…"}));
    }

    function propsPanel(){
      const o=selObj();
      const box=h("div",{class:"ls-panel ls-props"});
      box.appendChild(h("div",{class:"ls-ph"},[
        /* With nothing selected the panel shows the LABEL — its background,
           its shape, its border. That is what a designer's properties pane
           does when you click the empty page, and it is the only sensible
           home for "what colour is the sticker itself". */
        h("span",{text:o?"Object Properties":"Label Properties"}),
        h("button",{class:"ls-px",type:"button",title:"Hide the properties panel",
          onclick:()=>{showProps=false;paint();}},ico("close",13)),
      ]));
      const b=h("div",{class:"ls-pbody"});
      box.appendChild(b);
      if(!o){ labelProps(b); return box; }
      const isText=o.type==="text";
      const canType=isText||o.type==="barcode"||o.type==="qr";

      b.appendChild(h("div",{class:"ls-ptype"},[
        ico(objIcon(o),15), h("span",{text:objKind(o)})]));
      /* With several picked, say so and say which one the fields below are
         reading — the panel edits ALL of them, but it has to show ONE. */
      if(selIds.length>1) b.appendChild(h("div",{class:"ls-pmulti"},
        selIds.length+" objects selected — changes here apply to all of them. "+
        "The fields show “"+objName(o)+"”."));

      /* ---- what the field says ---- */
      if(canType){
        if(o.src.kind==="fixed")
          b.appendChild(fL(isText?"Content":"Data",
            pta(o.text,v=>{o.text=v;},isText?"Text":"e.g. CHH-001234")));
        else
          b.appendChild(fL("Content",h("button",{class:"ls-plink",type:"button",
            title:"Open the data source",onclick:()=>propsDialog(),
            text:(o.src.kind==="serial"?"Serial number"
                 :o.src.kind==="date"  ?"Date / time"
                 :"Ask at print: "+(o.src.prompt||"—"))+" — edit…"})));
      }

      /* ---- text ---- */
      if(isText){
        b.appendChild(fL("Font",psel(o.font,FONTS.map(f=>({v:f.v,l:f.l})),v=>{o.font=v;})));
        b.appendChild(h("div",{class:"ls-f"},[
          h("span",{class:"ls-fl",text:"Size"}),
          h("div",{class:"ls-frow"},[
            /* no fixed width: the panel is 210 px and this box shares its row
               with four buttons, so it takes what is left rather than a number
               that was right on one screen and overflowed the next */
            combo(o.size,SIZES,(v)=>setSize(v),0,
              "Type size in millimetres — type any value, or pick one",false,"mm"),
            rbtn({text:"B",cls:"ls-fx-b",title:"Bold",on:o.bold,
              onclick:onSel(s=>{s.bold=!s.bold;})}),
            rbtn({text:"I",cls:"ls-fx-i",title:"Italic",on:o.italic,
              onclick:onSel(s=>{s.italic=!s.italic;})}),
            rbtn({text:"U",cls:"ls-fx-u",title:"Underline",on:o.underline,
              onclick:onSel(s=>{s.underline=!s.underline;})}),
            rbtn({html:'A<i>▾</i>',cls:"ls-fx-a",title:"Change case",
              onclick:(e)=>caseMenu(e,o)}),
          ]),
        ]));
        b.appendChild(h("div",{class:"ls-phint",
          text:"That is "+mmToPt(o.size)+" pt — a label is measured in millimetres, "+
               "so 4 mm is about 11 pt."}));
        /* Said where it can be acted on, with the action next to it. */
        if(textOverflows(o)) b.appendChild(h("div",{class:"ls-pover"},[
          h("div",{text:"This text does not fit its box — the part that overruns "+
            "will be cut off when it prints."}),
          h("button",{class:"ls-pbtn",type:"button",onclick:()=>fitTextToBox(o)},[
            ico("valignfit",13), h("span",{text:"Shrink it to fit"}),
          ]),
        ]));
        b.appendChild(fL("Color",pcol(o.color,v=>{o.color=v||"#000000";},false,
          "The ink the type prints in")));
        /* the block of colour behind the type — white on black, on a carton */
        b.appendChild(fL("Text background",pcol(o.shade,v=>{o.shade=v;},true,
          "The block of colour behind the type")));
        b.appendChild(fL("Alignment",h("div",{class:"ls-frow ls-fgrid"},[
          rbtn({icon:"alignleft",   title:"Align left",on:o.align==="left",
            onclick:onSel(s=>{s.align="left";})}),
          rbtn({icon:"aligncenter", title:"Centre",on:o.align==="center",
            onclick:onSel(s=>{s.align="center";})}),
          rbtn({icon:"alignright",  title:"Align right",on:o.align==="right",
            onclick:onSel(s=>{s.align="right";})}),
          rbtn({icon:"alignjustify",title:"Justify",on:o.align==="justify",
            onclick:onSel(s=>{s.align="justify";})}),
        ])));
        b.appendChild(fR("Line Spacing",psel(String(+o.lineH),
          optsWith(LINEHS,o.lineH),v=>{o.lineH=+v;})));
        b.appendChild(fR("Text Direction",h("div",{class:"ls-frow"},[
          rbtn({icon:"alignjustify",title:"Reads across the label",on:!o.rot,
            onclick:onSel(s=>{s.rot=0;})}),
          rbtn({icon:"textdir",title:"Reads up the label — a quarter turn",on:o.rot===270,
            onclick:onSel(s=>{s.rot=270;})}),
        ])));
      }

      /* ---- barcode and QR ---- */
      if(o.type==="barcode"||o.type==="qr"){
        if(o.type==="barcode")
          b.appendChild(fL("Symbology",psel(o.sym,
            SYMS.filter(s=>s.v!=="qr").map(s=>({v:s.v,l:s.l})),v=>{o.sym=v;})));
        else
          b.appendChild(fL("Error correction",psel(o.ecl,[
            {v:"L",l:"L — 7%"},{v:"M",l:"M — 15%"},
            {v:"Q",l:"Q — 25%"},{v:"H",l:"H — 30%"}],v=>{o.ecl=v;})));
        b.appendChild(fL("Color",pcol(o.color,v=>{o.color=v||"#000000";},false,
          "The ink the bars print in — a scanner wants dark bars on a light label")));
        b.appendChild(pchk("Print the value underneath",o.showText,v=>{o.showText=v;}));
        if(o.showText){
          b.appendChild(fL("Caption font",psel(o.font,FONTS.map(f=>({v:f.v,l:f.l})),
            v=>{o.font=v;})));
          b.appendChild(fR("Caption size",combo(o.size,SIZES,(v)=>setSize(v),0,
            "Caption size in millimetres — type any value",false,"mm")));
        }
        const val=srcValue(o,{index:0,now:new Date(),prompts:{}});
        const enc=(o.type==="qr"||o.sym==="qr")?!!qrEncode(val,o.ecl):!!encodeBar(o.sym,val);
        b.appendChild(h("div",{class:enc?"ls-pok":"ls-pbad",
          text:enc?"✓ Encodes — scanner-ready"
                  :"✕ This value cannot be encoded as "+
                    ((SYMS.find(s=>s.v===o.sym)||{}).l||o.sym)}));
      }

      /* ---- picture ---- */
      if(o.type==="image"){
        b.appendChild(h("span",{class:"ls-fl",text:"Picture"}));
        ppic(o.data,(s)=>{o.data=s;},()=>{o.data="";}).forEach(el=>b.appendChild(el));
        b.appendChild(fL("Fit",psel(o.fit,[{v:"contain",l:"Fit inside the box"},
          {v:"cover",l:"Fill the box (crops)"},{v:"fill",l:"Stretch to the box"}],
          v=>{o.fit=v;})));
      }

      /* ---- shapes and rules ---- */
      if(o.type==="box"||o.type==="ellipse"){
        b.appendChild(fL("Fill",pcol(o.fill,v=>{o.fill=v;},true,
          "The colour inside the shape — or none, to leave it clear")));
        b.appendChild(fL("Border",pcol(o.stroke,v=>{o.stroke=v||"#000000";})));
        b.appendChild(fR("Border (mm)",pnum(o.strokeW,v=>{o.strokeW=Math.max(0,v);},.1,0)));
        if(o.type==="box")
          b.appendChild(fR("Corner (mm)",pnum(o.radius,v=>{o.radius=Math.max(0,v);},.5,0)));
      }
      if(o.type==="line"){
        b.appendChild(fL("Color",pcol(o.stroke,v=>{o.stroke=v||"#000000";})));
        b.appendChild(fR("Thickness (mm)",
          pnum(o.strokeW,v=>{o.strokeW=Math.max(.05,v);o.h=o.strokeW;},.1,.05)));
      }

      /* Millimetres, rotation and the data source in full are one click away
         rather than another eight rows down a 186 px column. */
      b.appendChild(h("button",{class:"ls-plink ls-pall",type:"button",
        onclick:()=>propsDialog(),text:"All properties…"}));
      return box;
    }

    function layersPanel(){
      const box=h("div",{class:"ls-panel ls-layers"});
      box.appendChild(h("div",{class:"ls-ph"},[h("span",{text:"Object Layers"})]));
      const list=h("div",{class:"ls-llist"});
      const objs=doc().objects;
      if(!objs.length) list.appendChild(h("div",{class:"ls-none",
        text:"Nothing on the label yet. Pick a tool on the left, then draw it here."}));
      /* Front of the label at the top, the way a layer list is always read. */
      objs.slice().reverse().forEach(o=>{
        const row=h("div",{class:"ls-lrow"+(isSel(o)?" on":"")+(o.hidden?" off":""),
          title:"Click to select · double-click for its properties · right-click for more",
          onclick:(e)=>{
            if(e&&(e.shiftKey||e.ctrlKey||e.metaKey)) addSel(o.id); else setSel(o.id);
            paint();
          },
          ondblclick:()=>editOrProps(o),
          oncontextmenu:(e)=>objectMenu(e,o)},[
          h("button",{class:"ls-eye",type:"button",
            title:o.hidden?"Show this object":"Hide this object — it will not print either",
            onclick:(e)=>{ e.stopPropagation(); o.hidden=!o.hidden; touch(); paint(); }},
            ico(o.hidden?"eyeoff":"eye",14)),
          h("span",{class:"ls-lnm",text:objName(o)}),
        ]);
        list.appendChild(row);
      });
      box.appendChild(list);
      return box;
    }

    /* ============================================================
       THE STATUS BAR
       What is ON the label and where the selection sits — the
       running commentary. The label's name and size are no longer
       here: they are facts about the document, and they have gone
       to the document block at the top right where they can be seen.
       ============================================================ */
    function statusBar(){
      const d=doc(), o=selObj(), g=sheetGrid(d);
      const zpc=Math.round(zoom*100);

      /* Dragging the slider must not repaint on every tick — a repaint rebuilds
         the slider under the thumb and the drag is dropped. The label is
         re-scaled live and the screen is put right when the drag ends. */
      const sl=h("input",{class:"ls-zsl",type:"range",min:"20",max:"400",step:"5",
        title:"Zoom","aria-label":"Zoom"});
      sl.value=String(Math.min(400,Math.max(20,zpc)));
      sl.addEventListener("input",()=>{
        zoom=Math.max(.2,Math.min(6,+sl.value/100));
        const cv=root.querySelector(".ls-canvas"), lay=root.querySelector(".ls-layer");
        if(cv){ cv.style.width =(d.w*PX_MM*zoom).toFixed(1)+"px";
                cv.style.height=(d.h*PX_MM*zoom).toFixed(1)+"px"; }
        if(lay) lay.style.transform="scale("+zoom+")";
        const zt=root.querySelector(".ls-zpc");
        if(zt) zt.textContent=Math.round(zoom*100)+"%";
      });
      sl.addEventListener("change",()=>paint());

      const vbtn=(icon,title,on,onclick)=>h("button",
        {class:"ls-vb"+(on?" on":""),type:"button",title:title,onclick:onclick},ico(icon,15));

      return h("div",{class:"ls-status"},[
        h("span",{class:"ls-st-i",
          text:d.objects.length+" object"+(d.objects.length===1?"":"s")}),
        h("span",{class:"ls-st-i"+(g.perPage?"":" bad"),
          text:d.mode==="roll"?"Roll — 1 per page"
            :(g.perPage?g.cols+" × "+g.rows+" = "+g.perPage+" per page"
                       :"Does not fit the page")}),
        h("div",{class:"sp"}),
        h("span",{class:"ls-read",
          text:selIds.length>1
            ? selIds.length+" selected  ·  drag to move them together, or right-click to align"
            : (o?`X ${o.x.toFixed(1)}  Y ${o.y.toFixed(1)}  W ${o.w.toFixed(1)}  H ${o.h.toFixed(1)} mm`
                :(tool?"Draw the new object on the label"
                      :"Click to select · again to type · drag the label to pick out several"))}),
        vbtn("panelleft","Tools panel",showTools,()=>{showTools=!showTools;paint();}),
        vbtn("panelright","Object Properties and Object Layers",showProps,
          ()=>{showProps=!showProps;paint();}),
        vbtn("panelrule","Rulers",rulers,()=>{rulers=!rulers;paint();}),
        h("span",{class:"ls-zpc",text:zpc+"%"}),
        sl,
        h("button",{class:"ls-vb",type:"button",title:"Zoom in",
          onclick:()=>{zoom=Math.min(6,+(zoom+.1).toFixed(2));paint();}},ico("plus",15)),
      ]);
    }

    /* ============================================================
       PROPERTIES — a dialog with a category list, the way BarTender
       does it. Everything about ONE object that is not on the text
       toolbar lives here, and nowhere else.
       ============================================================ */
    function propsDialog(){
      const o=selObj();
      if(!o) return toast("Select an object first",{type:"warn"});
      const t=OBJ_TYPES.find(x=>x.v===o.type)||OBJ_TYPES[0];
      const cats=[];
      if(o.type==="text"||o.type==="barcode"||o.type==="qr") cats.push({v:"data",l:"Data source"});
      if(o.type==="barcode"||o.type==="qr") cats.push({v:"sym",l:"Symbology"});
      if(o.type==="image") cats.push({v:"pic",l:"Picture"});
      if(o.type==="box"||o.type==="ellipse") cats.push({v:"shape",l:"Shape"});
      if(o.type==="line") cats.push({v:"line",l:"Line"});
      cats.push({v:"pos",l:"Size & position"});
      let cat=cats[0].v;

      const body=h("div",{class:"ls-props-dlg"});
      const nav=h("div",{class:"ls-pcats"});
      const panel=h("div",{class:"ls-ppanel"});
      body.appendChild(nav); body.appendChild(panel);

      /* live: the canvas behind the dialog updates as you type, so you are
         never editing blind */
      const live=(full)=>{ touch(); if(full) redrawBehind(); else refreshCanvas(); };
      function redrawBehind(){
        const cv=root.querySelector(".ls-canvas");
        if(!cv) return;
        refreshCanvas();
        const d=doc(), k=PX_MM*zoom;
        const skin=root.querySelector(".ls-skin");
        if(skin){ const hit=skin.children[d.objects.indexOf(o)];
          if(hit){ hit.style.left=(o.x*k).toFixed(1)+"px"; hit.style.top=(o.y*k).toFixed(1)+"px";
            hit.style.width=Math.max(3,o.w*k).toFixed(1)+"px";
            hit.style.height=Math.max(3,o.h*k).toFixed(1)+"px"; } }
        const rd=root.querySelector(".ls-read");
        if(rd) rd.textContent=`X ${o.x.toFixed(1)}  Y ${o.y.toFixed(1)}  W ${o.w.toFixed(1)}  H ${o.h.toFixed(1)} mm`;
      }

      function drawNav(){
        nav.innerHTML="";
        cats.forEach(c=>nav.appendChild(h("button",{class:"ls-pcat"+(cat===c.v?" on":""),
          onclick:()=>{cat=c.v;drawNav();drawPanel();},text:c.l})));
      }
      function drawPanel(){
        panel.innerHTML="";
        if(cat==="data")  panelData();
        if(cat==="sym")   panelSym();
        if(cat==="pic")   panelPic();
        if(cat==="shape") panelShape();
        if(cat==="line")  panelLine();
        if(cat==="pos")   panelPos();
      }

      function panelData(){
        panel.appendChild(h("div",{class:"wz-sec",text:"What this field says"}));
        panel.appendChild(fld("Comes from",sel1(o.src.kind,[
          {v:"fixed", l:"Fixed text — the same on every label"},
          {v:"date",  l:"Date / time — filled in when you print"},
          {v:"serial",l:"Serial number — counts up across the run"},
          {v:"prompt",l:"Ask me at print time"},
        ],v=>{o.src.kind=v;live(true);drawPanel();})));
        if(o.src.kind==="fixed")
          panel.appendChild(fld(o.type==="text"?"Text":"Barcode value",
            taInput(o.text,v=>{o.text=v;live(false);},
              o.type==="text"?"Type the text — Enter starts a new line":"e.g. CHH-001234"),
            o.type==="text"?"Enter starts a new line.":null));
        if(o.src.kind==="date")
          panel.appendChild(fld("Format",sel1(o.src.fmt,[
            {v:"DD.MM.YYYY",l:"31.12.2026"},{v:"DD/MM/YYYY",l:"31/12/2026"},
            {v:"DD-MMM-YYYY",l:"31-Dec-2026"},{v:"YYYY-MM-DD",l:"2026-12-31"},
            {v:"MMM YYYY",l:"Dec 2026"},{v:"DD.MM.YYYY HH:mm",l:"31.12.2026 14:05"}],
            v=>{o.src.fmt=v;live(false);}),
            "DD day · MM month · MMM Jan · YYYY / YY year · HH:mm:ss time"));
        if(o.src.kind==="serial"){
          panel.appendChild(row(3,[
            fld("Start at",nInput(o.src.start,v=>{o.src.start=Math.max(0,Math.round(v));live(false);},1,0)),
            fld("Step by",nInput(o.src.step,v=>{o.src.step=Math.max(1,Math.round(v));live(false);},1,1)),
            fld("Digits",nInput(o.src.pad,v=>{o.src.pad=Math.max(0,Math.round(v));live(false);},1,0,12)),
          ]));
          panel.appendChild(h("div",{class:"hint",
            text:"“Digits” pads with leading zeros — 6 turns 42 into 000042. The number advances once per label, so two copies of one label share it."}));
        }
        if(o.src.kind==="prompt"){
          panel.appendChild(fld("Ask for",tInput(o.src.prompt,v=>{o.src.prompt=v;live(false);},"e.g. Batch No",40),
            "The name shown on the print dialog. Two fields asking the same name are filled once."));
          panel.appendChild(fld("Default",tInput(o.src.def,v=>{o.src.def=v;live(false);},"optional",120)));
        }
        panel.appendChild(row(2,[
          fld("Before the value",tInput(o.src.prefix,v=>{o.src.prefix=v;live(false);},"prefix",40)),
          fld("After the value",tInput(o.src.suffix,v=>{o.src.suffix=v;live(false);},"suffix",40)),
        ]));
      }
      function panelSym(){
        panel.appendChild(h("div",{class:"wz-sec",text:"Symbology"}));
        if(o.type==="barcode"){
          panel.appendChild(fld("Type",sel1(o.sym,SYMS.filter(s=>s.v!=="qr").map(s=>({v:s.v,l:s.l})),
            v=>{o.sym=v;live(true);drawPanel();}),(SYMS.find(s=>s.v===o.sym)||{}).d));
        } else {
          panel.appendChild(fld("Error correction",sel1(o.ecl,[
            {v:"L",l:"L — 7% (most data, smallest modules)"},
            {v:"M",l:"M — 15% (the usual choice)"},
            {v:"Q",l:"Q — 25%"},
            {v:"H",l:"H — 30% (survives a scuffed label)"}],v=>{o.ecl=v;live(true);}),
            "Higher correction still scans when part of the code is damaged, at the cost of a denser grid."));
        }
        panel.appendChild(chk("Print the value underneath",o.showText,v=>{o.showText=v;live(true);}));
        const val=srcValue(o,{index:0,now:new Date(),prompts:{}});
        const enc=(o.type==="qr"||o.sym==="qr")?!!qrEncode(val,o.ecl):!!encodeBar(o.sym,val);
        panel.appendChild(h("div",{class:enc?"ls-ok":"ls-bad",
          text:enc?"✓ Encodes — scanner-ready":"✕ This value cannot be encoded as "+
            ((SYMS.find(s=>s.v===o.sym)||{}).l||o.sym)}));
      }
      function panelPic(){
        panel.appendChild(h("div",{class:"wz-sec",text:"Picture"}));
        const file=h("input",{class:"input",type:"file",accept:"image/png,image/jpeg,image/webp,image/gif"});
        file.addEventListener("change",()=>{
          const f=file.files&&file.files[0]; if(!f) return;
          if(f.size>MAX_IMG*0.7) return toast("That picture is too large — keep it under about 600 KB",{type:"warn"});
          const rd=new FileReader();
          rd.onload=()=>{ const s=String(rd.result||"");
            if(!IMG_RE.test(s)||s.length>MAX_IMG) return toast("That image type cannot be stored on a label",{type:"warn"});
            o.data=s; live(true); drawPanel(); toast("Picture placed",{type:"ok"}); };
          rd.readAsDataURL(f);
        });
        panel.appendChild(fld("Choose a picture",file,
          "Stored inside the template on the server — nothing is written to this computer."));
        panel.appendChild(fld("Fit",sel1(o.fit,[{v:"contain",l:"Fit inside the box"},
          {v:"cover",l:"Fill the box (crops)"},{v:"fill",l:"Stretch to the box"}],
          v=>{o.fit=v;live(true);})));
        if(o.data) panel.appendChild(h("button",{class:"btn sm danger",
          onclick:()=>{o.data="";live(true);drawPanel();},text:"Remove picture"}));
      }
      function panelShape(){
        panel.appendChild(h("div",{class:"wz-sec",text:"Shape"}));
        panel.appendChild(row(2,[
          fld("Fill",cInput(o.fill,v=>{o.fill=v;live(true);},true)),
          fld("Border",cInput(o.stroke,v=>{o.stroke=v;live(true);})),
        ]));
        panel.appendChild(row(2,[
          fld("Border (mm)",nInput(o.strokeW,v=>{o.strokeW=Math.max(0,v);live(true);},.1,0)),
          o.type==="box"?fld("Corner (mm)",nInput(o.radius,v=>{o.radius=Math.max(0,v);live(true);},.5,0)):h("div"),
        ]));
      }
      function panelLine(){
        panel.appendChild(h("div",{class:"wz-sec",text:"Line"}));
        panel.appendChild(row(2,[
          fld("Colour",cInput(o.stroke,v=>{o.stroke=v;live(true);})),
          fld("Thickness (mm)",nInput(o.strokeW,v=>{o.strokeW=Math.max(.05,v);o.h=o.strokeW;live(true);},.1,.05)),
        ]));
      }
      function panelPos(){
        panel.appendChild(h("div",{class:"wz-sec",text:"Size & position"}));
        panel.appendChild(row(2,[
          fld("X (mm)",nInput(o.x,v=>{o.x=v;live(true);},.5)),
          fld("Y (mm)",nInput(o.y,v=>{o.y=v;live(true);},.5)),
        ]));
        panel.appendChild(row(2,[
          fld("Width (mm)",nInput(o.w,v=>{o.w=Math.max(.5,v);live(true);},.5,.5)),
          o.type==="line"
            ? fld("Thickness (mm)",nInput(o.strokeW,v=>{o.strokeW=Math.max(.05,v);o.h=o.strokeW;live(true);},.1,.05))
            : fld("Height (mm)",nInput(o.h,v=>{o.h=Math.max(.2,v);live(true);},.5,.2)),
        ]));
        panel.appendChild(fld("Rotation",sel1(String(o.rot||0),
          [{v:"0",l:"0° — normal"},{v:"90",l:"90° — reads upward"},
           {v:"180",l:"180° — upside down"},{v:"270",l:"270° — reads downward"}],
          v=>{o.rot=+v;live(true);})));
      }

      drawNav(); drawPanel();
      const mo=modal({title:t.l+" properties", sub:"Everything about this object that is not on the toolbar",
        wide:true, body,
        foot:[h("button",{class:"btn primary",onclick:()=>{mo.close();paint();},text:"Done"})]});
    }

    /* ============================================================
       LABEL LAYOUT — the dimensions, picked off a card or typed.

       Lifted out of Page setup and given its own place on the
       toolbar AND the status bar, because the size is the first
       decision on a new label and the one most often changed
       afterwards; it had no business being three fields down a
       setup dialog. BarTender keeps it under the cursor at
       "Label Size: 100.0 mm x 60.0 mm" and opens the chooser when
       you click it, so that is what the status bar does here.

       Three tabs — the roll sizes, the A4 sheet layouts, and a
       custom size typed in millimetres. Every card draws its label
       TO SCALE against the largest in the group, so a 25 × 12 mm
       cable flag looks like a flag beside a 4 × 6 dispatch label
       and nobody picks the wrong one twice.
       ============================================================ */
    function layoutDialog(opts){
      opts=opts||{};
      const isNew=!!opts.isNew;
      const body=h("div",{class:"ls-lay"});
      /* Open on the family the label is already cut to; a size that matches no
         preset is a custom size, and saying so is more use than highlighting
         nothing on a tab of cards. A NEW label opens on the rolls, which is
         what a label printer takes and what most runs are. */
      let tab=isNew?"roll"
        :(stockOf(doc())?(doc().mode==="roll"?"roll":"sheet"):"custom");
      let mo=null;

      /* Picking a stock no longer closes the dialog. The whole point of the
         preview on the right is to be looked at BEFORE committing — a chooser
         that shuts the moment you touch a card never lets you compare two, and
         the operator finds out what they picked by printing it. The footer
         button is what leaves. */
      function pick(s){
        applyStock(doc(),s.v);
        touch(); paint(); fitOnce(); build();
      }

      function cards(){
        const cur=stockOf(doc());
        const list=STOCKS.filter(s=>s.mode===(tab==="roll"?"roll":"sheet"));
        /* One scale for the whole tab. Scaling each card to its own box would
           draw a 25 mm flag the same size as a 150 mm carton label, which is
           the one thing a picture of a label must not do. */
        const k=56/Math.max.apply(null,list.map(s=>Math.max(s.w,s.h)));
        const grid=h("div",{class:"ls-lay-grid"});
        list.forEach(s=>{
          const per=perPageOf(s);
          grid.appendChild(h("button",{class:"ls-lay-c"+(cur===s.v?" on":""),
            title:stockLabel(s), onclick:()=>pick(s)},[
            h("div",{class:"ls-lay-pv"},[
              h("div",{class:"ls-lay-box",style:
                `width:${Math.max(5,s.w*k).toFixed(1)}px;height:${Math.max(4,s.h*k).toFixed(1)}px`}),
            ]),
            h("div",{class:"ls-lay-sz",text:sizeS(s.w,s.h)}),
            s.n?h("div",{class:"ls-lay-n",text:s.n}):null,
            s.mode==="sheet"
              ? h("div",{class:"ls-lay-per"+(per?"":" bad"),
                  text:per?per+" per A4 page":"does not fit A4"})
              : null,
          ].filter(Boolean)));
        });
        return grid;
      }

      /* The custom pane is built ONCE and never rebuilt while you type. Only
         the readout under the boxes is refreshed — rebuilding the pane on
         every keystroke takes the caret with it, and a width box you cannot
         type "125" into is worse than having no box at all. Nothing writes
         back into the inputs either, so a half-typed "1" on its way to "100"
         is clamped in the document without the field arguing with your
         fingers. */
      function customPane(){
        const d=doc();
        const pane=h("div",{class:"ls-lay-custom"});
        const out=h("div",{});
        const clamp=(v)=>Math.min(1000,Math.max(5,+v||5));
        /* Auto-fit belongs on this pane, not only in Page setup. A size typed
           here almost never matches the die-cut margins left behind by whatever
           preset was selected before it, and the result is a sheet that prints
           three labels where twelve would fit. The box is offered rather than
           flipped on quietly: margins that were measured off real stock are not
           something to overwrite behind the operator's back. */
        const afRow=h("div",{class:"ls-inline"},[
          chk("Auto-fit — solve the margins and gaps for this size",d.autoFit,
            v=>{ d.autoFit=v; if(v) applyAutoFit(d); refresh(); }),
        ]);
        const refresh=()=>{
          touch(); paint(); drawPreview();
          const g=sheetGrid(d);
          const ok=d.mode==="roll"||!!g.perPage;
          afRow.hidden=(d.mode!=="sheet");
          const box=afRow.querySelector("input");
          if(box) box.checked=!!d.autoFit;
          out.className=ok?"ls-ok":"ls-bad";
          out.textContent=d.mode==="roll"
            ? "✓ "+g.cols+(g.cols===1?" label":" labels")+" across a "+mmS(g.pgW)+
              " mm web — set the web and the gaps on the Roll tab."
            : (g.perPage
                ? `✓ ${g.cols} across × ${g.rows} down = ${g.perPage} per A4 page`
                  +(d.autoFit?"":" — tick auto-fit above if that looks low.")
                : "✕ Bigger than the printable area — reduce the size, or tick auto-fit above.");
        };
        const wI=nInput(d.w,v=>{d.w=clamp(v);refresh();},1,5,1000);
        const hI=nInput(d.h,v=>{d.h=clamp(v);refresh();},1,5,1000);
        pane.appendChild(row(2,[fld("Width (mm)",wI),fld("Height (mm)",hI)]));
        pane.appendChild(h("div",{class:"ls-lay-swap"},[
          h("button",{class:"btn sm",title:"Turn the label on its side",
            onclick:()=>{ const w=d.w; d.w=d.h; d.h=w;
              wI.value=mmS(d.w); hI.value=mmS(d.h); refresh(); },
            text:"⇄ Swap width and height"}),
        ]));
        pane.appendChild(fld("Prints on",sel1(d.mode,[
          {v:"roll", l:"Roll — one label per page, for a label printer"},
          {v:"sheet",l:"A4 sheet — many labels tiled on a page"}],
          v=>{ d.mode=v;
            /* Turning a custom size into a sheet with whatever margins the last
               layout happened to leave behind is how you get one label per page
               and no idea why. Auto-fit solves them from the size instead. */
            if(v==="sheet"){ d.autoFit=true; applyAutoFit(d); }
            refresh(); })));
        pane.appendChild(afRow);
        pane.appendChild(out);
        pane.appendChild(h("div",{class:"hint",
          text:"The exact margins and gaps are in Page setup. Switching to a sheet here turns "+
               "auto-fit on, so they are solved from the size you typed."}));
        refresh();
        return pane;
      }

      /* ---- the roll's own numbers ----
         A roll is not just a size. The web is what was bought, the across-count
         is what the die cuts out of it, and the two gaps are what the die
         leaves — two 50 × 25 with nothing between them across a 100 mm web is a
         different roll from two with 3 mm between them, and only these boxes
         can say which. Built once and never rebuilt while you type, for the
         same caret reason customPane() documents above. */
      function rollPane(){
        const d=doc();
        const pane=h("div",{class:"ls-lay-roll"});
        const out=h("div",{});
        const refresh=()=>{ touch(); paint(); drawPreview();
          const g=sheetGrid(d);
          out.className="ls-ok";
          out.textContent="✓ "+g.cols+(g.cols===1?" label":" labels")+" across a "+
            mmS(g.pgW)+" mm web — each feed advances "+mmS(g.pgH)+" mm.";
        };
        pane.appendChild(h("div",{class:"wz-sec",text:"The roll"}));
        pane.appendChild(row(2,[
          fld("Web width (mm)",nInput(d.rollW,v=>{d.rollW=Math.max(5,v);refresh();},1,5,1000),
            "The roll as bought."),
          fld("Across",nInput(d.across||0,v=>{d.across=Math.max(0,Math.round(v));refresh();},1,0,50),
            "0 = fit as many as the web takes."),
        ]));
        pane.appendChild(row(2,[
          fld("Gap across (mm)",nInput(d.rGapX,v=>{d.rGapX=Math.max(0,v);refresh();},.5,0,100),
            "Between labels side by side. 0 for a butt-cut die."),
          fld("Gap down (mm)",nInput(d.rGapY,v=>{d.rGapY=Math.max(0,v);refresh();},.5,0,100),
            "The feed gap above and below."),
        ]));
        pane.appendChild(out);
        refresh();
        return pane;
      }

      /* ---- THE PREVIEW, on the right ----
         Two things, because they answer two different questions: what the label
         itself looks like at this size and shape, and how a whole sheet or web
         of them lands. Both drawn to scale from the same sheetGrid() the
         printer uses, so what is shown here is what comes out. */
      const prevWrap=h("div",{class:"ls-lay-prev"});
      function drawPreview(){
        const d=doc();
        prevWrap.innerHTML="";
        const g=sheetGrid(d), roll=d.mode==="roll";
        const shapeCss=(w,hh)=>d.shape==="ellipse"?"border-radius:50%"
          :d.shape==="round"?("border-radius:"+Math.max(1,Math.min(w,hh)*(d.radius/Math.max(d.w,d.h))*2).toFixed(1)+"px")
          :"";

        /* 1 — the label itself, as big as the panel allows */
        prevWrap.appendChild(h("div",{class:"ls-lay-pt",text:"The label"}));
        const k1=Math.min(210/Math.max(d.w,1),150/Math.max(d.h,1));
        const lw=Math.max(8,d.w*k1), lh=Math.max(6,d.h*k1);
        prevWrap.appendChild(h("div",{class:"ls-lay-one"},[
          h("div",{class:"ls-lay-onebox",
            style:`width:${lw.toFixed(1)}px;height:${lh.toFixed(1)}px;${shapeCss(lw,lh)}`}),
        ]));
        prevWrap.appendChild(h("div",{class:"ls-lay-cap",text:sizeS(d.w,d.h)+
          (d.shape==="ellipse"?" · ellipse":d.shape==="round"?" · rounded":"")}));

        /* 2 — the stock, tiled */
        prevWrap.appendChild(h("div",{class:"ls-lay-pt",
          text:roll?"On the web":"On the sheet"}));
        const pw=g.pgW, ph=roll?Math.min(g.pgH*3,g.pgH*3):g.pgH;   // 3 feeds of a roll reads as a roll
        const k2=Math.min(200/Math.max(pw,1),210/Math.max(ph,1));
        const page=h("div",{class:"ls-lay-page",
          style:`width:${(pw*k2).toFixed(1)}px;height:${(ph*k2).toFixed(1)}px`});
        const reps=roll?3:1;
        for(let r=0;r<reps;r++){
          for(let row0=0;row0<g.rows;row0++){
            for(let c=0;c<g.cols;c++){
              const x=roll
                ? Math.max(0,(pw-(g.cols*d.w+(g.cols-1)*(+d.rGapX||0)))/2)+c*(d.w+(+d.rGapX||0))
                : d.mLeft+c*(d.w+d.gapX);
              const y=roll
                ? r*g.pgH+(+d.rGapY||0)/2
                : d.mTop+row0*(d.h+d.gapY);
              const bw=d.w*k2, bh=d.h*k2;
              page.appendChild(h("div",{class:"ls-lay-cell",
                style:`left:${(x*k2).toFixed(1)}px;top:${(y*k2).toFixed(1)}px;`+
                      `width:${bw.toFixed(1)}px;height:${bh.toFixed(1)}px;${shapeCss(bw,bh)}`}));
            }
          }
          if(roll&&r<reps-1) page.appendChild(h("div",{class:"ls-lay-feed",
            style:`top:${((r+1)*g.pgH*k2).toFixed(1)}px`}));
        }
        prevWrap.appendChild(h("div",{class:"ls-lay-pagewrap"},[page]));
        const bad=!roll&&!g.perPage;
        prevWrap.appendChild(h("div",{class:"ls-lay-cap"+(bad?" bad":""),
          text:bad?"Bigger than the printable area — it will not print."
            :roll?(g.cols+" across a "+mmS(g.pgW)+" mm web · "+mmS(g.pgH)+" mm per feed")
                 :(g.cols+" across × "+g.rows+" down = "+g.perPage+" per "+d.page+" sheet")}));
        const st=STOCKS.find(x=>x.v===stockOf(d));
        if(st&&st.unver) prevWrap.appendChild(h("div",{class:"ls-lay-unver",
          text:"⚠ These circle sizes are the standard Novajet range, not read off your chart — "+
               "check one against a real sheet before a long run."}));
      }

      function build(){
        body.innerHTML="";
        const left=h("div",{class:"ls-lay-l"});
        left.appendChild(h("div",{class:"ls-lay-tabs"},
          [{v:"roll",l:"Roll"},{v:"sheet",l:"A4 sheet"},{v:"custom",l:"Custom size"}]
            .map(t=>h("button",{class:"ls-lay-tab"+(tab===t.v?" on":""),
              onclick:()=>{tab=t.v;build();},text:t.l}))));
        left.appendChild(h("div",{class:"ls-lay-sub",text:
          tab==="roll"
            ? "A die-cut roll on a thermal printer — Zebra, TSC, Godex. Pick a stock, then set the web and the gaps under it."
          : tab==="sheet"
            ? "Novajet die-cut A4 sheets. How many land on a page is worked out from the sizes, not taken on trust."
            : "Any size you like, in millimetres."}));
        left.appendChild(tab==="custom"?customPane():cards());
        if(tab==="roll") left.appendChild(rollPane());
        body.appendChild(h("div",{class:"ls-lay-2"},[left,prevWrap]));
        drawPreview();
      }
      build();
      mo=modal({
        title:isNew?"New label — what are you printing on?":"Label layout",
        sub:isNew
          ? "Pick the roll or the sheet this label is cut to. Everything you place afterwards is measured against it."
          : doc().name+" — "+sizeS(doc().w,doc().h),
        wide:true, body,
        foot:[h("button",{class:"btn primary",onclick:()=>{mo.close();paint();},
          text:isNew?"Start designing":"Done"})]});
    }

    /* ============================================================
       PAGE SETUP — the label and the stock it prints on, once.
       ============================================================ */
    function pageSetupDialog(){
      const d=doc();
      const body=h("div",{class:"ls-setup2"});
      const left=h("div",{}), right=h("div",{});
      const redraw=()=>{ touch(); body.innerHTML=""; build(); paint(); };
      function build(){
        left.innerHTML=""; right.innerHTML="";
        left.appendChild(h("div",{class:"wz-sec",text:"Label stock"}));
        left.appendChild(fld("Stock",sel1(stockOf(d),
          [{v:"",l:"Custom size"}].concat(STOCKS.map(s=>({v:s.v,l:stockLabel(s)}))),
          v=>{ if(!v) return; applyStock(d,v); redraw(); }),
          "The sheet in the drawer or the roll on the printer."));
        left.appendChild(h("div",{class:"ls-inline"},[
          h("button",{class:"btn sm",title:"See every layout drawn to scale, or type a size",
            onclick:()=>{ mo.close(); layoutDialog(); },text:"▭ Browse layouts…"}),
        ]));
        left.appendChild(h("div",{class:"wz-sec",text:"The label"}));
        left.appendChild(row(2,[
          fld("Width (mm)",nInput(d.w,v=>{d.w=Math.max(5,v);redraw();},1,5,1000)),
          fld("Height (mm)",nInput(d.h,v=>{d.h=Math.max(5,v);redraw();},1,5,1000)),
        ]));
        left.appendChild(row(2,[
          fld("Shape",sel1(d.shape,[{v:"rect",l:"Rectangle"},{v:"round",l:"Rounded rectangle"},
            {v:"ellipse",l:"Ellipse / circle"}],v=>{d.shape=v;redraw();})),
          d.shape==="round"?fld("Corner (mm)",nInput(d.radius,v=>{d.radius=Math.max(0,v);redraw();},.5,0))
            :fld("Background",cInput(d.bg,v=>{d.bg=v;redraw();})),
        ]));
        if(d.shape==="round") left.appendChild(fld("Background",cInput(d.bg,v=>{d.bg=v;redraw();})));
        left.appendChild(h("div",{class:"ls-inline"},[
          chk("Print a cut/outline border",d.border,v=>{d.border=v;redraw();}),
        ]));
        if(d.border) left.appendChild(row(2,[
          fld("Border colour",cInput(d.borderC,v=>{d.borderC=v;redraw();})),
          fld("Border (mm)",nInput(d.borderW,v=>{d.borderW=Math.max(.05,v);redraw();},.1,.05)),
        ]));
        left.appendChild(fld("Design grid (mm)",
          nInput(d.grid,v=>{d.grid=Math.min(20,Math.max(.5,v));redraw();},.5,.5,20),
          "The dots on the canvas, and the step objects snap and nudge by."));

        right.appendChild(h("div",{class:"wz-sec",text:"How it prints"}));
        right.appendChild(fld("Stock type",sel1(d.mode,[
          {v:"sheet",l:"Sheet — many labels on a page (A4, Letter…)"},
          {v:"roll", l:"Roll — one label per page, for a label printer"}],
          v=>{d.mode=v;redraw();}),
          d.mode==="roll"
            ? "The page becomes the label itself: "+d.w+" × "+d.h+" mm, no margins. This is what a Zebra or TSC printer expects."
            : "Labels are tiled across the page; the grid is worked out from the sizes below."));
        /* PRINT ORDER lives here rather than on the print screen because it is
           a fact about the stock, not about one run: a die-cut sheet is fed the
           way it is fed. It decides which physical die-cut is number one, so it
           is also what the numbered sheet on the print screen counts by — and
           what "Start at position 7" therefore means.
           On a roll there is one row, so "across" and "down" are the same
           journey and only the start corner does anything; offering four
           identical-looking choices there would be a lie. */
        right.appendChild(fld("Print order",
          sel1(d.printOrder||"th",
            (d.mode==="roll"?ORDERS.filter(o=>o.v==="th"||o.v==="bh"):ORDERS)
              .map(o=>({v:o.v,l:o.l})),
            v=>{ d.printOrder=v; redraw(); }),
          (ORDERS.find(o=>o.v===(d.printOrder||"th"))||ORDERS[0]).d));
        right.appendChild(fld("Copies of each",
          nInput(d.copies,v=>{d.copies=Math.max(1,Math.min(500,Math.round(v)||1));redraw();},1,1,500),
          "How many stickers one label is worth — two drums off the same reel "+
          "carry the same number, so a copy repeats the label rather than "+
          "advancing it."));
        if(d.mode==="sheet"){
          right.appendChild(row(2,[
            fld("Page",sel1(d.page,PAGES.map(p=>({v:p.v,l:p.v==="custom"?"Custom":p.v})),
              v=>{d.page=v;redraw();})),
            fld("Orientation",sel1(d.landscape?"1":"0",[{v:"0",l:"Portrait"},{v:"1",l:"Landscape"}],
              v=>{d.landscape=v==="1";redraw();})),
          ]));
          if(d.page==="custom") right.appendChild(row(2,[
            fld("Page width (mm)",nInput(d.pageW,v=>{d.pageW=Math.max(20,v);redraw();},1,20)),
            fld("Page height (mm)",nInput(d.pageH,v=>{d.pageH=Math.max(20,v);redraw();},1,20)),
          ]));
          /* AUTO-FIT. The operator knows the label size and the paper; working
             out the margins and gaps that get the most out of a sheet is
             arithmetic, and arithmetic is the machine's job. On, the four
             margins and both gaps are solved and shown read-only, so what will
             be printed is still on the screen — just not typed by hand. */
          right.appendChild(h("div",{class:"wz-sec",text:"Margins and gaps"}));
          right.appendChild(h("div",{class:"ls-inline"},[
            chk("Auto-fit — work them out for me",d.autoFit,v=>{
              d.autoFit=v; if(v) applyAutoFit(d); redraw(); }),
          ]));
          right.appendChild(h("div",{class:"hint",style:"margin:-2px 0 10px",
            text:d.autoFit
              ? "Solved from the label and the page: as many whole labels as the sheet holds, centred, with the space left over shared out evenly."
              : "Type your own margins and gaps, or let auto-fit solve them."}));
          const ro=(label,val)=>{
            const el=h("input",{class:"input",type:"number",value:String(val)});
            el.disabled=true; el.readOnly=true;
            return fld(label,el);
          };
          if(d.autoFit){
            right.appendChild(row(4,[
              ro("Top",d.mTop),ro("Bottom",d.mBottom),ro("Left",d.mLeft),ro("Right",d.mRight),
            ]));
            right.appendChild(row(2,[
              ro("Gap across (mm)",d.gapX),ro("Gap down (mm)",d.gapY),
            ]));
          } else {
            right.appendChild(row(4,[
              fld("Top",nInput(d.mTop,v=>{d.mTop=Math.max(0,v);redraw();},1,0)),
              fld("Bottom",nInput(d.mBottom,v=>{d.mBottom=Math.max(0,v);redraw();},1,0)),
              fld("Left",nInput(d.mLeft,v=>{d.mLeft=Math.max(0,v);redraw();},1,0)),
              fld("Right",nInput(d.mRight,v=>{d.mRight=Math.max(0,v);redraw();},1,0)),
            ]));
            right.appendChild(row(2,[
              fld("Gap across (mm)",nInput(d.gapX,v=>{d.gapX=Math.max(0,v);redraw();},.5,0)),
              fld("Gap down (mm)",nInput(d.gapY,v=>{d.gapY=Math.max(0,v);redraw();},.5,0)),
            ]));
          }
          const g=sheetGrid(d);
          right.appendChild(h("div",{class:g.perPage?"ls-ok":"ls-bad",
            text:g.perPage?`✓ ${g.cols} across × ${g.rows} down = ${g.perPage} label${g.perPage===1?"":"s"} per page`
              :"✕ The label is bigger than the printable area — reduce the label size or the margins."}));
        }
        body.appendChild(left); body.appendChild(right);
      }
      build();
      const mo=modal({title:"Page setup", sub:doc().name, wide:true, body,
        foot:[h("button",{class:"btn primary",onclick:()=>{mo.close();paint();},text:"Done"})]});
    }

    /* ---- WHAT THIS RUN IS, as against what the design says ----
       Quantity and copies are remembered on the design, because a label that
       is always printed 24-up is always printed 24-up. Everything else here
       belongs to THIS run and nothing else: which serial it carries on from
       and what the prompts were answered with. Neither is a fact about the
       design, and writing them into it would be writing down a guess.

       WHERE THE RUN STARTS IS NOT HERE ANY MORE. A part-used sheet used to be
       one number for the whole job, which could only ever describe a job with
       one design on it. It now lives per design, in planAt — see arrangePlan. */
    let runOpts={qty:null,copies:null,serialStart:"",prompts:{},
                 cut:false,reverse:false};

    /* THE SERIALS A RUN WILL CONSUME.
       A serialised run eats a block of numbers that can never be handed out
       again. Reading the first and the last back BEFORE the job goes out is
       the difference between noticing an overlap and finding it on a carton
       three weeks later. Computed through srcValue, so the prefix, the padding
       and the suffix are the ones that will actually print. */
    function serialSpan(count){
      const d=doc();
      const o=d.objects.find(x=>x.src&&x.src.kind==="serial"&&!x.hidden);
      if(!o||!count) return null;
      const mk=(i)=>srcValue(o,{index:i,now:new Date(),
        prompts:runOpts.prompts,serialStart:runOpts.serialStart});
      return {first:mk(0), last:mk(count-1), count:count};
    }

    /* ============================================================
       PRINT — A PAGE PLANNER

       One screen, no tabs, and the thing you are deciding is always
       on it: THE PAGES. Every page of the run is a thumbnail in a
       strip along the top; click one and it opens below as a grid
       of die-cut positions you can click.

       It is one model, not two. A plain run of 50 of one design and
       a hand-mixed sheet are the same object — a list of pages,
       each a list of positions — so there is no "simple mode" to
       leave and no "advanced mode" to find.

       WHERE EACH DESIGN GOES IS TYPED, NOT PAINTED. Every die-cut on
       the sheet preview carries the number it prints in, and those
       are the numbers the operator writes against a design: "1-8, 12"
       puts that label on those nine die-cuts and nowhere else. A
       design with no positions typed simply flows, filling whatever
       the hand-placed ones left.

       Only designs cut to the SAME stock may share the run: same
       size, same page, same margins. The palette offers those and
       nothing else, so a mismatch cannot reach the printer.
       ============================================================ */
    let plan=[];          // [[docId|"" × perPage], …] — one entry per page
    let planPage=0;       // the page being looked at
    let planQty={};       // docId → how many, for Arrange
    let planAt={};        // docId → the die-cut IT starts on, as typed text
    let planNote="";      // what Arrange had to bend, said out loud
    /* WHICH DESIGNS ARE ON THIS RUN, in the order they were put there. The run
       opens holding ONLY the label you came in with — every other template cut
       to the same stock is a candidate, not a participant, and is added by
       hand. A sheet quietly filling itself with every label of that size is
       not a convenience, it is a printed mistake. */
    let planUse=null;
    let planAdding=false; // the "add another label" picker, open or shut

    /* POSITIONS RUN ON ACROSS THE WHOLE RUN. A 65-up sheet numbers 1..65, and
       sheet two carries straight on at 66 — so a die-cut has ONE address for
       the length of the job and "starts at 70" needs no page number beside it.
       Returned 0-based; page and slot are worked out from it by division. */
    const MAX_PLAN_PAGES=50;
    function startOf(id,per){
      const raw=String(planAt[id]==null?"":planAt[id]).trim();
      if(!raw) return {at:null, bad:""};
      if(!/^\d+$/.test(raw)) return {at:null, bad:raw};
      const n=+raw;
      /* Refused, not clamped: silently turning 9000 into the last die-cut puts
         labels somewhere nobody asked for. */
      if(n<1||n>per*MAX_PLAN_PAGES) return {at:null, bad:raw};
      return {at:n-1, bad:""};
    }

    const perPage=()=>Math.max(1,sheetGrid(doc()).perPage);
    const blankPage=()=>new Array(perPage()).fill("");
    /* Every design cut the same way as the open one — the only ones that MAY
       share a page with it. Candidates for the run, not members of it. */
    const stockMates=()=>docs.filter(d=>sameStock(d,doc()));
    /* The ones actually on the run, in the order they were added. Anything
       deleted or re-sized out of the stock since drops out on its own. */
    const usedDocs=()=>(planUse||[]).map(id=>docs.find(x=>x.id===id))
      .filter(m=>m&&sameStock(m,doc()));

    /* The plan always has at least one page, and every page is exactly as long
       as the stock has die-cuts — the label size can change under it. */
    function ensurePlan(){
      const per=perPage();
      if(!plan.length) plan=[blankPage()];
      plan.forEach(p=>{ while(p.length<per) p.push(""); if(p.length>per) p.length=per; });
      if(planPage>=plan.length) planPage=plan.length-1;
      if(planPage<0) planPage=0;
    }
    /* BUILD THE PAGES — EVERY DESIGN FROM ITS OWN STARTING DIE-CUT.

       Each design in the palette carries two numbers: how many, and which
       position it begins on. It is laid down from that die-cut onwards, one
       after another, and it steps over anything an earlier design already
       occupies rather than printing over it. A design left without a start
       simply carries on from where the previous one finished, which is what
       an operator means by "and then the rest".

       This is per DESIGN, not per run: two labels on one sheet is the ordinary
       case here — 40 of Alpha from die-cut 1 and 44 of Bravo from die-cut 41 —
       and a single run-wide start could never express it.

       ⚠ THE WALK IS IN PRINT ORDER, not reading order. "Position 7" means the
       die-cut the sheet preview draws a 7 on, and on a bottom-up or
       column-wise order that is not the seventh cell of the page. orderSlot is
       the only thing that knows which one it is, and it is the very function
       the preview numbers with — so the number typed and the number printed
       cannot come apart. */
    function arrangePlan(opts){
      opts=opts||{};
      const d0=doc(), g=sheetGrid(d0), per=perPage();
      const slot=orderSlot(d0,g);
      const cop=Math.max(1,runOpts.copies==null?d0.copies:runOpts.copies);
      const mates=usedDocs();
      planNote="";
      plan=[blankPage()];

      const bad=[], moved=[];
      let placed=0;

      /* Lay one design down from a given address, stepping over anything
         already there and opening fresh sheets as it needs them. Returns where
         it finished, so the next design without a start of its own can carry
         straight on. */
      function lay(d,n,at){
        let pg=Math.floor(at/per), i=at%per;
        while(plan.length<=pg) plan.push(blankPage());
        let bumped=false;
        for(let k=0;k<n;k++){
          for(;;){
            if(i>=per){ pg++; i=0; }
            if(!plan[pg]) plan[pg]=blankPage();
            if(!plan[pg][slot(i)]) break;
            if(k===0) bumped=true;
            i++;
          }
          const p=slot(i);
          if(p>=0&&p<per){ plan[pg][p]=d.id; placed++; }
          i++;
        }
        if(bumped) moved.push(d.name+" → "+(at+1)+" was taken");
        return pg*per+i;
      }

      /* TWO PASSES, AND THE ORDER MATTERS. Every design that was GIVEN a start
         is laid down first, all of them, before any design that was not.
         Otherwise a design left to flow would reach position 20 and take it
         while the design actually asked for position 20 was still waiting its
         turn further down the list — the typed number would lose to a blank
         box, which is exactly backwards. */
      const pinned=[], flowing=[];
      mates.forEach(d=>{
        const s=startOf(d.id,per);
        if(s.bad&&bad.indexOf(s.bad)<0) bad.push(s.bad);
        const n=Math.max(0,Math.round(planQty[d.id]||0))*cop;
        if(!n) return;
        (s.at==null?flowing:pinned).push({d:d,n:n,at:s.at});
      });
      pinned.forEach(e=>lay(e.d,e.n,e.at));
      let cur=0;                       // where the flowing ones carry on from
      flowing.forEach(e=>{ cur=lay(e.d,e.n,cur); });

      const notes=[];
      if(bad.length) notes.push("ignored “"+bad.slice(0,4).join("”, “")+"”"+
        (bad.length>4?" and more":"")+" — positions run 1 to "+(per*MAX_PLAN_PAGES));
      if(moved.length) notes.push(moved.slice(0,3).join(" · ")+
        (moved.length>3?" · …":"")+", so it went to the next free die-cut");
      planNote=notes.join(" · ");

      if(!placed){
        if(!opts.quiet) toast("Give at least one design a quantity",{type:"warn"});
        planPage=0;
        return false;
      }
      planPage=0;
      return true;
    }
    /* The plan as a flat list of cells for the renderer, with a per-design
       counter so each design's serials run through ITS OWN labels rather than
       counting positions on a page. */
    function planCells(opts){
      const now=new Date(), seen={};
      const base=doc(), g=sheetGrid(base), per=Math.max(1,g.perPage);
      const slot=orderSlot(base,g);
      const out=[];
      plan.forEach(p=>{
        /* WALKED IN PRINT ORDER, FILLED IN READING ORDER. composeHtml lays the
           cells out left-to-right down the page, so the array it is handed has
           to stay in reading order — but a design's serials must advance the
           way the sheet actually prints, and on a bottom-up order that is a
           different journey. Counting through orderSlot is what puts the
           seventh number of the run on the die-cut the preview draws a 7 on. */
        const page=new Array(per).fill(null);
        for(let i=0;i<per;i++){
          const pos=slot(i);
          if(pos<0||pos>=per) continue;
          const id=p[pos];
          if(!id) continue;
          const d=docs.find(x=>x.id===id);
          if(!d) continue;
          const n=seen[id]||0; seen[id]=n+1;
          page[pos]={d,ctx:{index:n,now,prompts:runOpts.prompts,
            serialStart:runOpts.serialStart}};
        }
        out.push.apply(out,page);
      });
      if(opts&&opts.raw) return out;
      return runOpts.reverse?out.slice().reverse():out;
    }
    /* One page of the plan, carrying the WHOLE run's numbering — so page three
       of a serialised job does not start counting at one again. */
    const pageCells=(i)=>{
      const per=perPage();
      return planCells({raw:true}).slice(i*per,(i+1)*per);
    };
    const planTotal=()=>plan.reduce((n,p)=>n+p.filter(Boolean).length,0);
    /* a stable colour per design, so a position is recognisable at thumbnail
       size without reading anything */
    /* Colour by the order the design was ADDED to the run, not by its place in
       the library: the first label you came in with is always the first colour,
       whatever else happens to be cut to the same stock. */
    const hueOf=(id)=>{
      const list=(planUse&&planUse.length)?planUse:stockMates().map(m=>m.id);
      const i=list.indexOf(id);
      return i<0?0:i%8;
    };

    function printDialog(){
      const d=doc();
      const body=h("div",{class:"ls-pp"});
      const redraw=()=>{ body.innerHTML=""; build(); };
      /* A redraw that does not steal the caret. The panel is rebuilt whole on
         every change — the cheapest way to keep the numbered sheet, the page
         strip and the totals agreeing — so the field that caused the rebuild
         has to be found again afterwards, or the second click on a spinner
         lands on an element that no longer exists. */
      const redrawKeeping=(key)=>{
        redraw();
        const el=body.querySelector('[data-f="'+key+'"]');
        if(el){ el.focus(); if(el.select) el.select(); }
      };

      const num=(val,onCh,lo,hi,w)=>{
        const el=h("input",{class:"ls-pp-in",type:"number",step:"1",
          min:String(lo),max:String(hi),style:w?("width:"+w+"px"):""});
        el.value=String(val);
        el.addEventListener("change",()=>onCh(+el.value));
        return el;
      };
      const field=(label,el,hint)=>h("label",{class:"ls-pp-f"},[
        h("span",{class:"ls-pp-l",text:label}), el,
        hint?h("span",{class:"ls-pp-h",text:hint}):null,
      ].filter(Boolean));

      /* A BLANK LABEL CUT TO THIS EXACT STOCK. Cloned from the open design's
         paper — size, page, margins, gaps, feed order — and nothing else: no
         artwork, because it is a new label and not a copy of this one. Those
         are precisely the fields sameStock() weighs, so the result is
         guaranteed to be allowed on the sheet it was made for. */
      function newMate(){
        if(docs.length>=MAX_DOCS){
          toast("That is the "+MAX_DOCS+"-template limit",{type:"warn"});
          return null;
        }
        const b=doc();
        const nd=cleanDoc({
          name:"Label "+(docs.length+1),
          w:b.w, h:b.h, shape:b.shape, radius:b.radius, mode:b.mode,
          page:b.page, pageW:b.pageW, pageH:b.pageH, landscape:b.landscape,
          mTop:b.mTop, mBottom:b.mBottom, mLeft:b.mLeft, mRight:b.mRight,
          gapX:b.gapX, gapY:b.gapY, autoFit:b.autoFit,
          rollW:b.rollW, across:b.across, rGapX:b.rGapX, rGapY:b.rGapY,
          printOrder:b.printOrder, objects:[]});
        stampUsed(nd);
        docs.push(nd);
        dirty=true;
        return nd;
      }

      /* A BLANK LABEL IS NOT A LABEL YET. Making one and leaving the operator
         staring at the print screen would put an empty sticker on the sheet and
         call it done — so the new template is added to the run, the dialog
         steps out of the way, and the designer opens on it. Pressing Print
         again comes back to a run that still holds BOTH, because the new label
         is on planUse and reopening only re-seeds when the open design is not. */
      function startNewLabel(){
        const nd=newMate();
        if(!nd) return;
        planUse.push(nd.id);
        mo.close();
        openDoc(docs.length-1);
        toast("Design “"+nd.name+"”, then press Print again — it will be on the "+
              "sheet with the one you started from",{type:"ok"});
      }

      function build(){
        ensurePlan();
        const g=sheetGrid(d), per=perPage();
        const mates=stockMates();      // what COULD share the sheet
        const using=usedDocs();        // what actually is on the run
        const total=planTotal();

        /* ---- THE ANSWER, ACROSS THE TOP ----
           Three numbers and the stock they are true of. "Free" is the one that
           earns its place on a shared sheet: it is what the next design's start
           box has left to aim at, and counting empty die-cuts by eye off an
           84-up preview is exactly the job a screen should be doing. */
        const used=(plan[planPage]||[]).filter(Boolean).length;
        const stat=(n,l,cls)=>h("div",{class:"ls-pp-sum"+(cls?" "+cls:"")},[
          h("b",{text:String(n)}), h("span",{text:l})]);
        body.appendChild(h("div",{class:"ls-pp-top"+(g.perPage?"":" bad")},[
          stat(total,total===1?"label":"labels"),
          h("div",{class:"ls-pp-arrow",text:"→"}),
          stat(plan.length,d.mode==="roll"
            ? (plan.length===1?"page":"pages")
            : (plan.length===1?"sheet":"sheets")),
          d.mode==="sheet"&&g.perPage
            ? stat(per-used,"free on sheet","quiet")
            : null,
          h("div",{class:"ls-pp-meta"},[
            h("div",{class:"ls-pp-chip"},[
              ico("rect",12),
              h("span",{text:sizeS(d.w,d.h)+(d.mode==="roll"?" · roll"
                :" · "+per+" per "+d.page)}),
            ]),
            h("div",{class:"ls-pp-h",text:d.mode==="roll"
              ? "A roll takes one label per page"
              : g.cols+" across × "+g.rows+" down"}),
          ]),
        ].filter(Boolean)));
        if(!g.perPage) body.appendChild(h("div",{class:"ls-pp-warn"},
          "The label is bigger than the printable area. Fix the size or the "+
          "margins in Page setup — nothing will come out right."));

        /* THREE COLUMNS: what you are deciding, what it looks like, and where
           it lands. They are three different questions and they get three
           different columns rather than one long scroll. */
        const main=h("div",{class:"ls-pp-main"});
        const side=h("div",{class:"ls-pp-side"});
        const mid=h("div",{class:"ls-pp-mid"});
        const right=h("div",{class:"ls-pp-right"});
        /* Every group of the screen is a card, so the eye can tell one decision
           from the next without reading a word of it. */
        const card=(...kids)=>{
          const c=h("div",{class:"ls-pp-card"});
          kids.flat().filter(Boolean).forEach(k=>c.appendChild(k));
          return c;
        };

        /* ---- WHAT TO PRINT, AND WHERE ---- */
        const sideCard=card();
        side.appendChild(sideCard);
        sideCard.appendChild(h("div",{class:"ls-pp-sec"},[
          h("span",{text:"What to print"}),
          h("span",{class:"ls-pp-h",text:"how many of each, and where they start"}),
        ]));
        const list=h("div",{class:"ls-pp-designs"});
        using.forEach(m=>{
          const mine=plan.reduce((n,p)=>n+p.filter(x=>x===m.id).length,0);
          const row=h("div",{class:"ls-pp-d"+(mine?" live":""),
            "data-k":String(hueOf(m.id)),
            title:m.name+" — this is the colour it wears on the sheet alongside"},[
            h("div",{class:"ls-pp-dtop"},[
              h("span",{class:"ls-pp-dot"}),
              h("span",{class:"ls-pp-dn",text:m.name}),
              mine?h("span",{class:"ls-pp-dq",text:"×"+mine}):null,
              (function(){
                const q=num(planQty[m.id]||0,
                  v=>{ planQty[m.id]=Math.max(0,Math.min(5000,Math.round(v)||0));
                       arrangePlan({quiet:true}); redrawKeeping("q"+m.id); },0,5000,64);
                q.setAttribute("data-f","q"+m.id);
                q.title="How many of this design to print";
                return q;
              })(),
              /* The label you came in with is the run; the ones you added are
                 guests, and a guest you cannot show out is a trap. */
              m.id===d.id?null:h("button",{class:"ls-pp-dx",type:"button",
                title:"Take “"+m.name+"” off this run",
                onclick:()=>{ planUse=planUse.filter(x=>x!==m.id);
                  delete planQty[m.id]; delete planAt[m.id];
                  arrangePlan({quiet:true}); redraw(); }},ico("close",11)),
            ].filter(Boolean)),
          ]);
          /* WHERE THIS ONE STARTS. Its own die-cut, per design — that is the
             whole point of a shared sheet. Only on a sheet: a roll has one
             label per page, so there is no position to choose and a box
             offering one would be a lie. */
          if(d.mode==="sheet"&&per>1){
            const el=h("input",{class:"ls-pp-in ls-pp-at",type:"number",
              step:"1",min:"1",max:String(per),
              placeholder:"next free",
              title:"The die-cut this design begins on — read it off the "+
                    "numbered sheet alongside. Leave it empty to carry on "+
                    "from the design above."});
            el.value=planAt[m.id]||"";
            el.setAttribute("data-f","at"+m.id);
            /* On CHANGE, not on input: re-laying the whole run between two
               keystrokes of "12" would place it at 1 first, and the sheet
               would jump somewhere the operator never asked for. */
            el.addEventListener("change",()=>{
              planAt[m.id]=el.value.trim();
              arrangePlan({quiet:true}); redrawKeeping("at"+m.id);
            });
            row.appendChild(h("label",{class:"ls-pp-dpos"},[
              h("span",{text:"starts at"}), el,
            ]));
          }
          list.appendChild(row);
        });
        sideCard.appendChild(list);

        /* ---- ADD ANOTHER LABEL ----
           A second design joins the sheet only when it is asked for. The pick
           list offers what is ALREADY cut to this stock, because those are the
           only ones that can share the paper; if nothing is, one can be made
           to fit here and now rather than sending the operator back to the
           gallery to work out the margins by hand. */
        if(d.mode!=="roll"||per>1){
          const spare=mates.filter(m=>using.indexOf(m)<0);
          if(!planAdding){
            sideCard.appendChild(h("button",{class:"ls-pp-addl",type:"button",
              title:spare.length
                ? "Put another label of this same size on the sheet"
                : "Nothing else is cut to "+sizeS(d.w,d.h)+" — this starts a new one",
              /* NOTHING TO PICK FROM MEANS THERE IS NO PICKER. Opening a list
                 whose only entry is "make one" is a question with one answer;
                 go straight to the designer instead. */
              onclick:()=>{ if(!spare.length) return startNewLabel();
                planAdding=true; redraw(); }},[
              ico("plus",14),
              h("span",{text:spare.length?"Add another label":"Add another label — design it"}),
            ]));
          } else {
            const pick=h("div",{class:"ls-pp-pick"});
            pick.appendChild(h("div",{class:"ls-pp-h"},
              spare.length
                ? "Already cut to "+sizeS(d.w,d.h)+" — pick one to share the sheet:"
                : "Nothing else is cut to "+sizeS(d.w,d.h)+" yet."));
            spare.forEach(m=>{
              const n=(m.objects||[]).length;
              pick.appendChild(h("button",{class:"ls-pp-pk",type:"button",
                onclick:()=>{ planUse.push(m.id); planAdding=false;
                  arrangePlan({quiet:true}); redraw(); }},[
                h("span",{class:"ls-pp-pkn",text:m.name}),
                h("span",{class:"ls-pp-h",text:n?(n+" object"+(n===1?"":"s")):"empty"}),
              ]));
            });
            pick.appendChild(h("button",{class:"ls-pp-pk new",type:"button",
              title:"A blank label cut to exactly this stock — opens in the designer",
              onclick:()=>{ planAdding=false; startNewLabel(); }},[
              ico("newdoc",13),
              h("span",{class:"ls-pp-pkn",text:"Create a new label this size…"}),
            ]));
            pick.appendChild(h("button",{class:"ls-pp-pkx",type:"button",
              onclick:()=>{ planAdding=false; redraw(); },text:"Cancel"}));
            sideCard.appendChild(pick);
          }
        }

        if(d.mode==="sheet"&&per>1)
          sideCard.appendChild(h("div",{class:"ls-pp-h"},
            using.length>1
              ? "Each design begins on the die-cut you give it and runs on from "+
                "there. Leave one empty and it follows the design above. "+
                "Positions carry on across sheets."
              : "Leave the start empty to begin at die-cut 1, or type the first "+
                "free one on a part-used sheet."));
        if(planNote) sideCard.appendChild(h("div",{class:"ls-pp-flag",text:planNote}));

        sideCard.appendChild(h("button",{class:"ls-pp-go",type:"button",
          title:"Lay the run out again from the quantities and the starts typed above",
          onclick:()=>{ if(arrangePlan()) redraw(); }},[
          ico("grid",14), h("span",{text:"Arrange the pages"}),
        ]));

        /* A PROMPT IS NOT A PRINT SETTING. The design asks for it and cannot
           render a truthful label without an answer, so it gets its own card
           rather than being buried among the quantities. */
        const prompts=promptsOf(d);
        if(prompts.length){
          const pc=card(h("div",{class:"ls-pp-sec"},[
            h("span",{text:"The design asks for"}),
            h("span",{class:"ls-pp-h",text:"filled in on every label of the run"}),
          ]));
          prompts.forEach(p=>{
            if(runOpts.prompts[p.key]==null) runOpts.prompts[p.key]=p.def||"";
            const el=h("input",{class:"ls-pp-in",type:"text",placeholder:p.def||""});
            el.value=runOpts.prompts[p.key];
            el.addEventListener("input",()=>{ runOpts.prompts[p.key]=el.value; });
            pc.appendChild(field(p.key,el));
          });
          side.appendChild(pc);
        }

        /* The block of serial numbers this run eats, before it eats them.
           Reading the first and the last back BEFORE the job goes out is the
           difference between noticing an overlap and finding it on a carton
           three weeks later. */
        if(d.objects.some(o=>o.src&&o.src.kind==="serial")){
          const own=plan.reduce((n,p)=>n+p.filter(x=>x===d.id).length,0);
          const sp=serialSpan(own);
          if(sp) side.appendChild(card(
            h("div",{class:"ls-pp-sec"},[
              h("span",{text:"Serial numbers"}),
              h("span",{class:"ls-pp-h",text:"used up for good"}),
            ]),
            h("div",{class:"ls-pp-span"},[
              h("b",{text:sp.first}), h("span",{class:"ls-pp-arrow",text:"→"}),
              h("b",{text:sp.last}),
              h("span",{class:"ls-pp-h",text:sp.count+" number"+(sp.count===1?"":"s")}),
            ])));
        }

        /* ---- WHAT IT WILL LOOK LIKE ----
           Two pictures, the same two the PO label wizard shows, because the
           question before a print run is always the same pair: is the sticker
           itself right, and does the sheet of them land where the die is. Both
           are rendered through the very functions that print — oneHtml and
           composeHtml — so a preview cannot flatter the output. */
        {
          const ctx0={index:0,now:new Date(),prompts:runOpts.prompts,
            serialStart:runOpts.serialStart};
          const k=Math.min(360/(d.w*PX_MM),230/(d.h*PX_MM),2.4);
          mid.appendChild(card(
            h("div",{class:"ls-pp-sec"},[
              h("span",{text:"The label"}),
              h("span",{class:"ls-pp-h",text:"one sticker, exactly as it prints"}),
            ]),
            h("div",{class:"ls-pp-one"},[
              h("div",{class:"wz-frame",
                style:`width:${(d.w*PX_MM*k).toFixed(1)}px;height:${(d.h*PX_MM*k).toFixed(1)}px`},
                h("iframe",{srcdoc:oneHtml(d,ctx0),scrolling:"no","aria-hidden":"true",
                  tabindex:"-1",
                  style:`width:${d.w}mm;height:${d.h}mm;transform:scale(${k.toFixed(4)});`+
                        `transform-origin:top left`})),
            ]),
            h("div",{class:"ls-pp-cap",text:sizeS(d.w,d.h)})));
        }

        /* THE SHEET, AS A BOARD OF ADDRESSES.
           One tile per die-cut, laid out the way the stock is — as many across
           as the sheet is — and numbered 1..n in PRINT order. It is a
           schematic, not a scale drawing, and that is the point: these numbers
           are what gets typed into "starts at", so they have to be readable at
           a glance rather than faithful to a millimetre. The scale drawing is
           the page thumbnail in the middle column, which stays honest. */
        if(g.perPage){
          const cells=pageCells(planPage);
          const slotOf=orderSlot(d,g);
          const sheetCard=card(h("div",{class:"ls-pp-sec"},[
            h("span",{text:d.mode==="roll"?"On the web":"On the sheet"}),
            h("span",{class:"ls-pp-h",text:"numbered in print order"}),
          ]));
          right.appendChild(sheetCard);

          /* A tile shows the real artwork while there is room to see it. Past
             that many, every tile would be a separate live document rebuilt on
             each keystroke, so a filled one falls back to its design's colour —
             which is the same key the palette and the legend use. */
          const ART_CAP=28;
          const withArt=cells.filter(c=>c&&c.d).length<=ART_CAP;
          const ar=Math.min(3.6,Math.max(1.15,d.w/Math.max(1,d.h)));
          const tiles=h("div",{class:"ls-pp-tiles",
            style:`grid-template-columns:repeat(${Math.max(1,g.cols)},minmax(0,1fr))`});
          /* THE NUMBERS RUN ON ACROSS THE RUN. Sheet one is 1..65, sheet two
             starts at 66 — a die-cut keeps one address for the whole job, which
             is what makes "starts at 70" mean something without a page beside
             it. Restarting at 1 on every sheet would make the same number name
             a different piece of paper depending on which tab you were looking
             at, and the start boxes would be quietly ambiguous. */
          const base=planPage*per;
          for(let i=0;i<per;i++){
            const p=slotOf(i);
            const c=(p>=0&&p<per)?cells[p]:null;
            const m=c&&c.d;
            const t=h("div",{class:"ls-pp-t"+(m?" on":""),
              "data-k":m?String(hueOf(m.id)):"",
              style:"aspect-ratio:"+ar.toFixed(3),
              title:"Position "+(base+i+1)+" — "+(m?m.name:"free")});
            if(m&&withArt){
              const tk=Math.min(66/(m.w*PX_MM),40/(m.h*PX_MM));
              t.appendChild(h("div",{class:"ls-pp-tart"},
                h("iframe",{srcdoc:oneHtml(m,c.ctx),scrolling:"no",
                  "aria-hidden":"true",tabindex:"-1",
                  style:`width:${m.w}mm;height:${m.h}mm;`+
                        `transform:scale(${tk.toFixed(4)});transform-origin:top left`})));
            }
            t.appendChild(h("span",{class:"ls-pp-tn",text:String(base+i+1)}));
            tiles.appendChild(t);
          }
          sheetCard.appendChild(h("div",{class:"ls-pp-board"},[tiles]));

          /* THE KEY TO THE COLOURS. On a shared sheet the tiles are the only
             thing saying which design is where, and a colour with no name
             against it is a decoration rather than information. */
          const onPage=[];
          cells.forEach(c=>{ if(c&&c.d&&onPage.indexOf(c.d)<0) onPage.push(c.d); });
          if(onPage.length>1){
            sheetCard.appendChild(h("div",{class:"ls-pp-legend"},
              onPage.map(m=>h("span",{class:"ls-pp-lg","data-k":String(hueOf(m.id))},[
                h("i"), h("span",{text:m.name}),
                h("b",{text:String(cells.filter(c=>c&&c.d===m).length)}),
              ]))));
          }
          sheetCard.appendChild(h("div",{class:"ls-pp-cap",
            text:(d.mode==="roll"
                    ?(g.cols+" across a "+mmS(g.pgW)+" mm web · "+mmS(g.pgH)+" mm per feed")
                    :(g.cols+" across × "+g.rows+" down = "+per+" per "+d.page+" sheet"))+
                 (plan.length>1?" · page "+(planPage+1)+" of "+plan.length:"")}));
        }

        /* ---- THE PAGES ---- */
        const pagesCard=card(h("div",{class:"ls-pp-sec"},[
          h("span",{text:"The pages"}),
          h("span",{class:"ls-pp-h",
            text:"every page of the run — click one to open it on the board"}),
        ]));
        mid.appendChild(pagesCard);
        const strip=h("div",{class:"ls-pp-strip"});
        plan.forEach((page,i)=>{
          const mini=h("div",{class:"ls-pp-mini",
            style:`grid-template-columns:repeat(${g.cols},1fr)`});
          page.forEach(id=>mini.appendChild(h("i",{class:id?"on":"",
            "data-k":id?String(hueOf(id)):""})));
          strip.appendChild(h("div",{class:"ls-pp-page"+(i===planPage?" on":""),
            title:"Page "+(i+1)+" — "+page.filter(Boolean).length+" of "+per+" used",
            onclick:()=>{ planPage=i; redraw(); }},[
            mini,
            h("div",{class:"ls-pp-pn"},[
              h("span",{text:"Page "+(i+1)}),
              h("div",{class:"sp"}),
              h("button",{class:"ls-pp-x",type:"button",title:"Print only this page",
                onclick:(e)=>{ e.stopPropagation(); printOnly(i); }},ico("print",11)),
              plan.length>1?h("button",{class:"ls-pp-x",type:"button",title:"Remove this page",
                onclick:(e)=>{ e.stopPropagation(); plan.splice(i,1);
                  if(planPage>=plan.length) planPage=plan.length-1; redraw(); }},
                ico("close",11)):null,
            ].filter(Boolean)),
          ]));
        });
        strip.appendChild(h("button",{class:"ls-pp-add",type:"button",
          title:"Add an empty page",
          onclick:()=>{ plan.push(blankPage()); planPage=plan.length-1; redraw(); }},[
          ico("plus",16), h("span",{text:"Add page"}),
        ]));
        pagesCard.appendChild(strip);

        /* WHAT IS LEFT OF THE PAGE EDITOR is what is not placement: emptying a
           page and repeating one. Where a label goes is typed, not clicked, so
           the grid of die-cuts you used to paint on is gone — the numbered
           sheet above is now the only picture of the page, and it is a picture
           of the real thing rather than a diagram of it. */
        const page=plan[planPage]||blankPage();
        pagesCard.appendChild(h("div",{class:"ls-pp-acts"},[
          h("button",{class:"ls-pp-b",type:"button",
            title:"Empty every position on this page",
            onclick:()=>{ plan[planPage]=blankPage(); redraw(); }},[
            ico("trash",12), h("span",{text:"Clear page "+(planPage+1)})]),
          h("button",{class:"ls-pp-b",type:"button",
            title:"Add a copy of this page after it",
            onclick:()=>{ plan.splice(planPage+1,0,page.slice());
              planPage++; redraw(); }},[
            ico("copy",12), h("span",{text:"Duplicate page"})]),
        ]));

        main.appendChild(side); main.appendChild(mid); main.appendChild(right);
        body.appendChild(main);
      }

      /* One page of the plan, on its own — numbered as part of the WHOLE run,
         so reprinting page three does not hand out serials 1..n again. */
      function printOnly(i){
        const cells=pageCells(i);
        if(!cells.some(Boolean)) return toast("That page is empty",{type:"warn"});
        const w=window.open("","_blank");
        if(!w) return toast("Popup blocked — allow popups for this site to print",{type:"warn"});
        w.document.write(composeHtml(doc(),cells,{print:true,cut:!!runOpts.cut}));
        w.document.close();
      }

      /* THE RUN OPENS ON ONE LABEL — the one you came in with. Re-seeded when
         the open design is not on the list, which is what happens after
         switching templates and pressing Print again: the previous run's guests
         are not this run's business. */
      if(!Array.isArray(planUse)||planUse.indexOf(doc().id)<0){
        planUse=[doc().id];
        planAdding=false;
      }
      /* Opening the dialog on a run that was never arranged should not show an
         empty sheet — fill it from the design's own quantity once.
         Per DESIGN, not "is the run empty": coming back after designing a label
         that was created from this screen, the run already holds the first
         label's quantity, and a run-wide test would leave the new one on zero
         with no hint as to why. */
      ensurePlan();
      if(planQty[doc().id]==null)
        planQty[doc().id]=Math.max(1,runOpts.qty==null?doc().qty:runOpts.qty);
      /* Re-lay when the OPEN design has nothing on the sheet, not merely when
         the sheet is bare: the label just designed would otherwise sit at a
         quantity of one with no position, behind a plan built before it
         existed. */
      const openHas=plan.reduce((n,p)=>n+p.filter(x=>x===doc().id).length,0);
      if(!planTotal()||!openHas) arrangePlan({quiet:true});
      build();
      const mo=modal({title:"Print Layout", sub:doc().name+" — "+sizeS(doc().w,doc().h),
        xwide:true, body, foot:[
        h("button",{class:"btn ghost",onclick:()=>{mo.close();paint();},text:"Cancel"}),
        h("button",{class:"btn",title:"Print a single label to check the alignment",
          onclick:()=>doPrint({test:true})},[
          ico("print",14), h("span",{text:"Test — one label"})]),
        h("button",{class:"btn primary",onclick:()=>{ if(doPrint()) mo.close(); }},[
          ico("print",14), h("span",{text:"Print all pages"})]),
      ]});
      /* The head badge is hung on afterwards rather than taught to modal(),
         which every other dialog in the ERP shares — one screen wanting a
         crest is not a reason to change the shell for all of them. */
      mo.el.classList.add("ls-ppm");
      const head=mo.el.querySelector(".modal-head");
      if(head) head.insertBefore(h("div",{class:"ls-pp-crest"},ico("print",20)),head.firstChild);
    }




    /* opts.test — one label, on a fresh sheet, at position one. It ignores the
       quantity, the copies, the range and the part-used skip on purpose: the
       job of a test print is to answer "is the paper lined up", and every one
       of those settings only gets in the way of that question. */
    function doPrint(opts){
      opts=opts||{};
      const d=doc();
      const g=sheetGrid(d);
      if(!g.perPage){
        toast("The label is bigger than the page — fix it in Page setup first",{type:"warn"});
        return false; }

      /* A TEST PRINT is one label of the design that is open, on a fresh
         sheet, at position one. It ignores the plan on purpose: the question
         it answers is "is the paper lined up", and the plan only gets in the
         way of that. */
      if(opts.test){
        if(!d.objects.some(o=>!o.hidden)){
          toast("This label has nothing on it to test",{type:"warn"});
          return false; }
        const wt=window.open("","_blank");
        if(!wt){ toast("Popup blocked — allow popups for this site to print",{type:"warn"});
          return false; }
        wt.document.write(sheetHtml(d,
          buildRun(d,{qty:1,copies:1,prompts:runOpts.prompts,
                      serialStart:runOpts.serialStart}),
          {print:true,skip:0,cut:!!runOpts.cut}));
        wt.document.close();
        toast("One test label sent — check it against the stock",{type:"ok"});
        return true;
      }

      /* THE PLAN IS THE RUN. There is no second path: a plain run of fifty of
         one design and a hand-mixed sheet are the same list of pages, so they
         print through the same renderer and there is nowhere for the two to
         drift apart. */
      const cells=planCells();
      if(!cells.some(Boolean)){
        toast("No labels are placed yet — give a design a quantity and press "+
              "Arrange the pages",{type:"warn"});
        return false; }
      const w=window.open("","_blank");
      if(!w){ toast("Popup blocked — allow popups for this site to print",{type:"warn"});
        return false; }
      w.document.write(composeHtml(d,cells,{print:true,cut:!!runOpts.cut}));
      w.document.close();
      return true;
    }

    /* ============================================================
       KEYBOARD
       On the DOCUMENT, not the studio's own root: a keystroke goes to
       whatever has focus and bubbles up from there, and on a freshly
       opened page nothing inside the studio has focus yet — so a
       listener on the root never sees the Ctrl+S of someone who has
       done nothing but look at the label. It takes itself off the
       moment the studio leaves the document.
       ============================================================ */
    const onKey=(e)=>{
      if(!root.isConnected){ document.removeEventListener("keydown",onKey); return; }
      const t=e.target;
      const typing=t&&/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName);
      const k=(e.key||"").toLowerCase();
      /* Escape unwinds one thing at a time, innermost first — and full screen
         is now ours to leave, since the browser is no longer holding it. */
      if(e.key==="Escape"){
        if(ctxEl){ closeCtx(); return; }
        if(bgEdit){ bgEdit=false; paint(); return; }
        if(tool){ tool=null; paint(); return; }
        if(full){ full=false; paint(); return; }
      }
      /* Delete removes the selection wherever the studio has focus — but never
         out from under someone typing into a field.

         ⚠ THE FOCUS TEST USED TO SWALLOW THE KEY. Clicking the canvas to place
         or pick an object leaves document.activeElement on <body>, and <body>
         is not inside root — so `root.contains(activeElement)` was false and
         Delete did nothing at the exact moment an operator expects it to work:
         object selected, handles showing, nothing typed. "Nothing in
         particular is focused" belongs to the screen you are looking at, so it
         counts as the studio; only focus that genuinely sits in another widget
         (the assistant's input, a field outside root) hands the key over. */
      const ae=document.activeElement;
      const loose=!ae||ae===document.body||ae===document.documentElement;
      if((e.key==="Delete")&&!typing&&screen==="design"&&selObj()
         &&(loose||root.contains(ae))){
        e.preventDefault(); delSel(); return;
      }
      if(!(e.ctrlKey||e.metaKey)) return;
      if(screen!=="design") return;
      if(k==="s"){ e.preventDefault(); save(); return; }
      if(k==="p"){ e.preventDefault(); printDialog(); return; }
      if(typing) return;                       // the rest belong to the field
      if(k==="z"&&!e.shiftKey){ e.preventDefault(); undo(); return; }
      if(k==="y"||(k==="z"&&e.shiftKey)){ e.preventDefault(); redo(); return; }
      if(k==="d"){ e.preventDefault(); dupSel(); return; }
      if(k==="x"){ e.preventDefault(); cutSel(); return; }
      if(k==="c"){ e.preventDefault(); copySel(); return; }
      if(k==="v"){ e.preventDefault(); pasteClip(); return; }
    };
    document.addEventListener("keydown",onKey);

    paint();
  }

})(window);
