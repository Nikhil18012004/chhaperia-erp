"use strict";
const path=require("path");
const { JSDOM, VirtualConsole, ResourceLoader } = require("jsdom");

const vc=new VirtualConsole();
const errors=[];
vc.on("jsdomError",(e)=>errors.push("jsdomError: "+(e.detail&&e.detail.stack||e.message)));
vc.on("error",(...a)=>errors.push("console.error: "+a.map(String).join(" ")));

(async()=>{
  const dom=await JSDOM.fromURL("http://localhost:4000/",{
    resources: "usable",
    runScripts:"dangerously",
    pretendToBeVisual:true,
    virtualConsole:vc,
    beforeParse(window){
      /* a fetch that behaves like a browser: carries cookies between calls */
      const jar={};
      window.fetch=async(url,opts)=>{
        opts=opts||{}; opts.headers=Object.assign({},opts.headers);
        const ck=Object.entries(jar).map(([k,v])=>k+"="+v).join("; ");
        if(ck) opts.headers["Cookie"]=ck;
        const res=await fetch(new URL(url,"http://localhost:4000/").href,opts);
        const sc=res.headers.getSetCookie?res.headers.getSetCookie():[];
        for(const c of sc){ const m=c.match(/^([^=]+)=([^;]*)/); if(m) jar[m[1]]=m[2]; }
        return res;
      };
      window.matchMedia=window.matchMedia||((q)=>({matches:false,media:q,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}}));
      window.scrollTo=()=>{};
      window.ResizeObserver=window.ResizeObserver||class{observe(){}unobserve(){}disconnect(){}};
      window.addEventListener("error",(e)=>errors.push("window.onerror: "+(e.error&&e.error.stack||e.message)));
      window.addEventListener("unhandledrejection",(e)=>errors.push("unhandledrejection: "+(e.reason&&e.reason.stack||e.reason)));
    },
  });
  await new Promise(r=>setTimeout(r,3000));
  /* drive the real login form, exactly as a user would */
  {
    const d=dom.window.document;
    d.querySelector("#loginUser").value="admin";
    d.querySelector("#loginPass").value="admin@123";
    d.querySelector("#loginForm").dispatchEvent(new dom.window.Event("submit",{bubbles:true,cancelable:true}));
  }
  await new Promise(r=>setTimeout(r,12000));
  const d=dom.window.document;
  const splash=d.querySelector("#splash");
  const login=d.querySelector("#login");
  const app=d.querySelector("#app");
  console.log("splash present:", !!splash, splash? "class="+splash.className : "");
  console.log("login hidden:", login? login.hidden : "(missing)");
  console.log("app hidden:", app? app.hidden : "(missing)");
  const le=d.querySelector("#loginError");
  console.log("loginError:", le? JSON.stringify({hidden:le.hidden,text:le.textContent}) : "(missing)");
  const view=d.querySelector("#view");
  console.log("view content head:", view? view.innerHTML.slice(0,200).replace(/s+/g," ") : "(missing)");
  console.log("--- captured errors ("+errors.length+") ---");
  for(const e of errors.slice(0,10)) console.log(e.split("\n").slice(0,4).join("\n"));
  process.exit(0);
})().catch(e=>{ console.log("HARNESS FAIL:", e.message); process.exit(1); });
