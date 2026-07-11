/* ============================================================
   CHHAPERIA ERP — APP CONTROLLER
   Boot, routing, theme/accent, command palette, alerts.
   ============================================================ */
(function (global) {
  "use strict";
  console.log("%c[Chhaperia ERP] build v12 loaded — Inventory: 🚚 Receive via PO + 📦 Add Stock + instant auto-refresh","color:#F06820;font-weight:700");
  const {$, $$, h, esc, toast} = UI;

  const App = {
    current:"dashboard", params:null,
    theme:"dark", accent:"orange", autoAccent:false,

    async boot(){
      // 1) gate on authentication — no session ⇒ show login
      const sessionUser = DB.auth.user();
      if(!sessionUser || !DB.auth.token()){
        this.showLogin();
        return;
      }
      // 2) verify the token is still valid + get fresh user/role
      let me;
      try{ me = (await DB.auth.me()).user; }
      catch(err){ this.showLogin(); return; }

      this.user = me;

      // 3) supervisors get the dedicated panel (rendered inside the shell)
      if(me.role === "supervisor"){
        $("#login").hidden = true;
        if(global.SUP && typeof SUP.boot === "function") SUP.boot(me);
        else { this.hideSplash(); $("#app").hidden=false; $("#view").innerHTML='<div style="padding:40px;text-align:center">Supervisor panel unavailable.</div>'; }
        return;
      }

      // 4) admin / office ⇒ full ERP
      await this.bootFullApp();
    },

    async bootFullApp(){
      let data;
      try{
        data = await DB.loadAsync();
      }catch(err){
        console.error("Failed to load data from API:", err);
        this.hideSplash();
        $("#login").hidden = true;
        $("#app").hidden=false;
        $("#view").innerHTML = '<div class="empty" style="margin-top:60px"><div class="big">⚠</div>'+
          '<div style="font-weight:700;font-size:18px">Cannot load data</div>'+
          '<div style="color:var(--text-mut);margin-top:8px">'+esc(err.message)+'</div></div>';
        return;
      }
      ENG.init(data);
      this._lastSig=this._stateSig(data);   // baseline for auto-refresh change detection
      const app=$("#app"); app.classList.remove("sup-mode"); // clear supervisor mode if switching roles
      // restore settings
      const s = data.settings||{};
      this.theme = s.theme||"dark";
      this.accent = s.accent||"orange";
      this.autoAccent = !!s.autoAccent;
      document.documentElement.setAttribute("data-theme", this.theme);
      document.documentElement.setAttribute("data-accent", this.accent);

      this.buildNav();
      this.bindChrome();
      this.renderAccentMenu();
      this.refreshAlerts();
      this.applyRoleChrome();

      // route from hash
      const hash=location.hash.replace("#","");
      if(hash && M[hash]) this.current=hash;
      this.go(this.current);

      // reveal app
      this.hideSplash();
      $("#login").hidden = true;
      $("#app").hidden=false;

      // keep the UI live: poll the server and auto-apply changes made by
      // other users / sessions without a manual browser refresh
      this.startAutoRefresh();
    },

    /* ---- auto-refresh ----
       Poll the server periodically and, when the dataset actually changed,
       re-render the current view. Skipped while the tab is hidden, a modal /
       palette / drawer is open, or the user is typing — so it never yanks
       the UI out from under an in-progress edit. */
    _stateSig(s){ try{ return JSON.stringify(s); }catch(e){ return String(Math.random()); } },
    _uiBusy(){
      const mh=$("#modalHost"); if(mh && !mh.hidden) return true;
      const ck=$("#cmdk"); if(ck && !ck.hidden) return true;
      const ad=$("#alertDrawer"); if(ad && ad.classList.contains("open")) return true;
      const ae=document.activeElement; if(ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) return true;
      return false;
    },
    startAutoRefresh(ms){
      this.stopAutoRefresh();
      this._pollTimer=setInterval(()=>this.pollState(), ms||15000);
    },
    stopAutoRefresh(){ if(this._pollTimer){ clearInterval(this._pollTimer); this._pollTimer=null; } },
    async pollState(){
      if(this._polling || document.hidden || this._uiBusy()) return;
      this._polling=true;
      try{
        const fresh=await DB.loadAsync();
        const sig=this._stateSig(fresh);
        if(sig!==this._lastSig){
          this._lastSig=sig;
          if(this._uiBusy()) return;            // user started interacting mid-fetch — apply next tick
          ENG.init(fresh); this.buildNav(); this.refreshAlerts(); this.refreshView();
        }
      }catch(e){ /* transient network/auth blip — try again next tick */ }
      finally{ this._polling=false; }
    },

    hideSplash(){
      const sp=$("#splash"); if(sp){ sp.classList.add("hide"); setTimeout(()=>sp.remove(),600); }
    },

    /* ---- LOGIN GATE ---- */
    showLogin(message){
      this.hideSplash();
      $("#app").hidden = true;
      const login = $("#login"); login.hidden = false;
      const err = $("#loginError");
      if(message){ err.hidden=false; err.textContent=message; } else { err.hidden=true; }
      const form = $("#loginForm"), user=$("#loginUser"), pass=$("#loginPass"), btn=$("#loginBtn");
      user.value=""; pass.value="";
      setTimeout(()=>user.focus(), 50);
      form.onsubmit = async (e)=>{
        e.preventDefault();
        err.hidden=true;
        btn.disabled=true; btn.textContent="Signing in…";
        try{
          const r = await DB.auth.login(user.value.trim(), pass.value);
          if(!r || !r.token) throw new Error("Login failed");
          this.user = r.user;
          location.hash = "";
          // route by role
          if(r.user.role === "supervisor"){
            login.hidden = true;
            if(global.SUP && typeof SUP.boot==="function") SUP.boot(r.user);
          } else {
            this.current = "dashboard";
            await this.bootFullApp();
          }
        }catch(ex){
          err.hidden=false; err.textContent = ex.message==="401"||/invalid/i.test(ex.message) ? "Invalid username or password" : ex.message;
          btn.disabled=false; btn.textContent="Sign In";
          pass.focus();
        }
      };
    },

    async logout(){
      this.stopAutoRefresh();
      try{ await DB.auth.logout(); }catch{}
      this.user=null;
      location.hash="";
      this.showLogin("You have been signed out.");
    },

    /* hide admin-only chrome from office; label the user chip */
    applyRoleChrome(){
      const u=this.user||{};
      const nameEl=$("#userName"), roleEl=$("#userRole"), av=$("#userAvatar");
      if(nameEl) nameEl.textContent = u.name || u.username || "User";
      if(roleEl) roleEl.textContent = ({admin:"Administrator",office:"Office Desk",supervisor:"Supervisor"})[u.role] || u.role || "";
      if(av) av.textContent = (u.name||u.username||"U").split(" ").map(x=>x[0]).slice(0,2).join("").toUpperCase();
      const logout=$("#logoutBtn"); if(logout) logout.onclick=()=>this.logout();
      // theme + accent are system settings — only admin may change them
      const admin=this.isAdmin();
      const themeBtn=$("#themeToggle"); if(themeBtn) themeBtn.hidden=!admin;
      const accentPop=document.querySelector(".accent-pop"); if(accentPop) accentPop.hidden=!admin;
    },

    buildNav(){
      const nav=$("#nav"); nav.innerHTML="";
      const isAdmin = this.user && this.user.role === "admin";
      UI.NAV.forEach(n=>{
        if(n.adminOnly && !isAdmin) return; // hide admin-only items from office
        if(n.sec){ nav.appendChild(h("div",{class:"nav-section",text:n.sec})); return; }
        const item=h("div",{class:"nav-item"+(n.id===this.current?" active":""),"data-id":n.id,
          role:"button",tabindex:"0","aria-label":n.label,
          onclick:()=>this.go(n.id),
          onkeydown:(e)=>{ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); this.go(n.id); } }},[
          h("span",{class:"ic","aria-hidden":"true",text:n.icon}),
          h("span",{class:"lbl",text:n.label}),
        ]);
        // pills (open counts / alerts)
        if(n.pillKey){ const v=ENG.kpis()[n.pillKey];
          if(v) item.appendChild(h("span",{class:"pill",text:v})); }
        if(n.id==="inventory"){ const low=ENG.kpis().lowStock; if(low) item.appendChild(h("span",{class:"pill danger",text:low})); }
        nav.appendChild(item);
      });
    },

    /* ---- role-based module access ----
       Admin sees everything. Other roles (office) are denied any NAV item
       flagged adminOnly — currently the Overview and System sections. */
    isAdmin(){ return !!(this.user && this.user.role === "admin"); },
    canAccess(id){
      const meta = UI.NAV.find(n => n.id === id);
      return meta ? !(meta.adminOnly && !this.isAdmin()) : true;
    },
    homeId(){
      const first = UI.NAV.find(n => n.id && !(n.adminOnly && !this.isAdmin()));
      return first ? first.id : "dashboard";
    },

    go(id, params){
      if(!M[id]){ id=this.homeId(); }
      if(!this.canAccess(id)){ id=this.homeId(); } // block hidden modules by hash/palette
      this.current=id; this.params=params||null;
      location.hash=id;
      // nav active state
      $$(".nav-item").forEach(el=>el.classList.toggle("active", el.getAttribute("data-id")===id));
      // auto accent
      if(this.autoAccent){ const meta=UI.NAV.find(n=>n.id===id); if(meta&&meta.accent){ document.documentElement.setAttribute("data-accent",meta.accent); } }
      else { document.documentElement.setAttribute("data-accent", this.accent); }
      // crumbs
      const mod=M[id];
      $("#crumbs").innerHTML=`<span>Chhaperia</span><span class="sep">/</span><span class="cur">${esc(mod.title)}</span>`;
      // render
      const view=$("#view"); view.innerHTML=""; view.classList.remove("fade-in"); void view.offsetWidth; view.classList.add("fade-in");
      try{ mod.render(view, params); }
      catch(err){ console.error("Module error:",err); view.appendChild(h("div",{class:"empty"},[h("div",{class:"big",text:"⚠"}),h("div",{text:"Module failed to render: "+err.message})])); }
      view.scrollTop=0;
      // on tablet, picking a menu item closes the drawer
      if(this.isDrawerWidth&&this.isDrawerWidth()) this.closeNavDrawer();
    },

    persistAndRefresh(){
      ENG.data.settings={theme:this.theme,accent:this.accent,autoAccent:this.autoAccent,lowStockOnly:false};
      DB.save(ENG.data);
      ENG.rebuild();
      this.buildNav();
      this.refreshAlerts();
      this.refreshView();
    },

    /* Persist ONLY the UI settings document (theme/accent) via the dedicated
       PATCH /settings fast path — no need to rewrite the whole dataset just to
       flip a colour. Re-renders locally so the change shows instantly. */
    persistSettings(){
      if(!this.isAdmin()) return; // theme/accent are system settings — admin only
      const s={theme:this.theme,accent:this.accent,autoAccent:this.autoAccent,lowStockOnly:false};
      ENG.data.settings=s;
      DB.saveSettings(s);
      this.buildNav();
      this.refreshView();
    },

    /* Optimistic granular save: the caller has ALREADY mutated ENG.data
       locally; we reflect it in the UI immediately, then persist via a
       targeted API call. If the server rejects, we reload the truth so
       the UI never drifts from the database. */
    async saveDelta(apiCall){
      ENG.rebuild();
      this.buildNav();
      this.refreshAlerts();
      this.refreshView();
      try{ await apiCall(); }
      catch(e){
        UI.toast("Save failed — reloaded from server",{type:"danger",title:"Sync error"});
        await this.reloadState();
        throw e;
      }
    },

    /* Replace the in-memory dataset with the server's, then re-render. */
    async reloadState(){
      try{
        const fresh=await DB.loadAsync();
        this._lastSig=this._stateSig(fresh);   // keep auto-refresh baseline in sync
        ENG.init(fresh);
        this.buildNav(); this.refreshAlerts(); this.refreshView();
      }catch(e){ console.warn("reloadState failed",e); }
    },

    /* re-render the CURRENT module so newly added/removed data shows
       instantly — no manual page refresh needed after a save. */
    refreshView(){
      if(this.current && M[this.current]) this.go(this.current, this.params);
    },

    /* ---- theme/accent ---- */
    setTheme(t){ this.theme=t; document.documentElement.setAttribute("data-theme",t); this.persistSettings(); },
    setAccent(a){ this.accent=a; this.autoAccent=false; document.documentElement.setAttribute("data-accent",a); this.renderAccentMenu(); this.persistSettings(); },
    setAutoAccent(v){ this.autoAccent=v; this.persistSettings(); },

    renderAccentMenu(){
      const accents=[["orange","#F06820"],["red","#E84820"],["blue","#2f7fe0"],["teal","#0fb5ae"],["violet","#7c5cff"],["green","#16a34a"],["pink","#ec4899"],["amber","#e0a000"]];
      const box=$("#swatches"); box.innerHTML="";
      accents.forEach(([a,hex])=>{ const sw=h("div",{class:"swatch"+(this.accent===a&&!this.autoAccent?" sel":""),style:`background:${hex}`,title:a,onclick:()=>this.setAccent(a)}); box.appendChild(sw); });
      const auto=$("#autoAccent"); if(auto) auto.checked=this.autoAccent;
    },

    /* ---- alerts / notifications ----
       Alerts are computed live from data (they have no natural timestamp), so
       we persist a small "first-seen" log in localStorage: each alert is dated
       the day it first appeared, grouped day-by-day, and AUTO-EXPIRES after
       NOTIF_RETENTION_DAYS — after which it vanishes and is dropped from the
       log. An aged-out alert is not resurrected while its condition persists;
       once the condition clears, its log entry is removed so it can recur. */
    NOTIF_KEY:"chh_notiflog", NOTIF_RETENTION_DAYS:3,
    _notifLog(){ try{ return JSON.parse(localStorage.getItem(this.NOTIF_KEY)||"{}")||{}; }catch{ return {}; } },
    _saveNotifLog(o){ try{ localStorage.setItem(this.NOTIF_KEY, JSON.stringify(o)); }catch{} },
    _alertKey(a){ return [a.kind||"gen", a.itemId||a.id||a.title||""].join("|"); },
    /* register today's alerts, purge resolved/expired, return day-grouped view */
    notifications(){
      const al = ENG.alerts();
      const today = DB.helpers.iso(DB.helpers.today());
      const cutoff = DB.helpers.daysAgo(this.NOTIF_RETENTION_DAYS-1);  // keep first-seen >= cutoff
      const log = this._notifLog();
      const active = new Set(al.map(a=>this._alertKey(a)));
      // stamp newly-appeared alerts with today's date (keep existing first-seen)
      al.forEach(a=>{ const k=this._alertKey(a); if(!log[k]) log[k]=today; });
      // a resolved condition frees its slot (so it can recur later as new)
      Object.keys(log).forEach(k=>{ if(!active.has(k)) delete log[k]; });
      this._saveNotifLog(log);
      // visible = active alerts still inside the retention window
      const visible = al.filter(a=> (log[this._alertKey(a)]||today) >= cutoff);
      const byDate={}; visible.forEach(a=>{ const d=log[this._alertKey(a)]; (byDate[d]=byDate[d]||[]).push(a); });
      const groups = Object.keys(byDate).sort((a,b)=> a<b?1:-1)
        .map(date=>({date, label:this._notifLabel(date), items:byDate[date]}));
      return { groups, count:visible.length };
    },
    _notifLabel(date){
      const today = DB.helpers.iso(DB.helpers.today());
      if(date===today) return "Today";
      if(date===DB.helpers.daysAgo(1)) return "Yesterday";
      try{ return new Date(date+"T12:00:00").toLocaleDateString(undefined,{weekday:"short",day:"2-digit",month:"short"}); }
      catch{ return date; }
    },
    refreshAlerts(){
      const n=this.notifications(); const badge=$("#bellBadge");
      if(n.count){ badge.hidden=false; badge.textContent=n.count>99?"99+":n.count; }
      else badge.hidden=true;
    },
    openAlerts(){
      const n=this.notifications(); const list=$("#alertList"); list.innerHTML="";
      if(!n.count){ list.appendChild(h("div",{class:"empty"},[h("div",{class:"big",text:"✓"}),h("div",{text:"No active alerts — all systems healthy."})])); }
      n.groups.forEach(g=>{
        list.appendChild(h("div",{class:"alert-date"},[
          h("span",{class:"alert-date-lbl",text:g.label}),
          h("span",{class:"alert-date-rule"}),
          h("span",{class:"alert-date-n",text:g.items.length+(g.items.length>1?" alerts":" alert")})
        ]));
        g.items.forEach(a=>{
          const st={danger:"background:var(--danger-soft);color:var(--danger)",warn:"background:var(--warn-soft);color:var(--warn)",info:"background:var(--info-soft);color:var(--info)"}[a.sev];
          list.appendChild(h("div",{class:"alert-item",onclick:()=>{ this.closeDrawer();
            if(a.kind==="stock") this.go("inventory");
            else if(a.kind==="po") this.go("purchase");
            else if(a.kind==="so") this.go("sales");
            else if(a.kind==="lead") this.go("crm"); }},[
            h("div",{class:"alert-ic",style:st,text:a.ic}),
            h("div",{style:"flex:1;min-width:0"},[ h("div",{class:"t",text:a.title}), h("div",{class:"d",text:a.desc}) ])
          ]));
        });
      });
      $("#alertDrawer").hidden=false; $("#scrim").hidden=false;
      requestAnimationFrame(()=>$("#alertDrawer").classList.add("open"));
    },
    closeDrawer(){ $("#alertDrawer").classList.remove("open"); $("#scrim").hidden=true; setTimeout(()=>$("#alertDrawer").hidden=true,300); },

    /* ---- command palette ---- */
    openCmdk(){
      const cmdk=$("#cmdk"); cmdk.hidden=false; const input=$("#cmdkInput"); input.value=""; this.cmdkSel=0;
      this.cmdkRender(""); input.focus();
    },
    closeCmdk(){ $("#cmdk").hidden=true; },
    cmdkItems(q){
      q=q.toLowerCase(); const out=[];
      UI.NAV.forEach(n=>{ if(n.sec||!this.canAccess(n.id))return; if(!q||n.label.toLowerCase().includes(q)) out.push({ic:n.icon,label:n.label,tag:"Module",act:()=>this.go(n.id)}); });
      // quick actions registered by modules (Add Stock, Receive PO, …)
      const acts=global.ERPActions||{};
      Object.keys(acts).forEach(k=>{ const a=acts[k];
        if(!q||a.label.toLowerCase().includes(q)) out.push({ic:a.ic||"⚡",label:a.label,tag:"Action",act:()=>a.run()}); });
      if(q.length>=2){
        ENG.data.items.forEach(it=>{ if((it.name+" "+it.id).toLowerCase().includes(q)) out.push({ic:"📦",label:it.name,meta:it.id,tag:"Item",act:()=>this.go("inventory")}); });
        ENG.data.salesorders.forEach(s=>{ if(s.id.toLowerCase().includes(q)) out.push({ic:"🧾",label:s.id+" — "+ENG.custName(s.customerId),tag:"Sales",act:()=>this.go("sales")}); });
        ENG.data.purchaseorders.forEach(p=>{ if(p.id.toLowerCase().includes(q)) out.push({ic:"🛒",label:p.id+" — "+ENG.sup(p.supplierId),tag:"PO",act:()=>this.go("purchase")}); });
        ENG.data.workorders.forEach(w=>{ const nm=(ENG.item(w.itemId)||{}).name||w.itemId; if((w.id+" "+nm).toLowerCase().includes(q)) out.push({ic:"⚙️",label:w.id+" — "+nm,tag:"Work Order",act:()=>this.go("production")}); });
        (ENG.data.leads||[]).forEach(l=>{ if((l.company+" "+l.id).toLowerCase().includes(q)) out.push({ic:"🎯",label:l.company,meta:l.id,tag:"Lead",act:()=>this.go("crm")}); });
        ENG.data.customers.forEach(c=>{ if((c.name+" "+c.id).toLowerCase().includes(q)) out.push({ic:"🤝",label:c.name,tag:"Customer",act:()=>this.go("customers")}); });
        ENG.data.suppliers.forEach(s=>{ if((s.name+" "+s.id).toLowerCase().includes(q)) out.push({ic:"🏭",label:s.name,tag:"Supplier",act:()=>this.go("suppliers")}); });
      }
      return out.slice(0,24);
    },
    cmdkRender(q){
      const items=this.cmdkItems(q); this.cmdkList=items; const box=$("#cmdkResults"); box.innerHTML="";
      if(!items.length){ box.appendChild(h("div",{class:"empty",style:"padding:30px"},"No matches")); return; }
      items.forEach((it,i)=>{ box.appendChild(h("div",{class:"cmdk-row"+(i===this.cmdkSel?" sel":""),onclick:()=>{it.act();this.closeCmdk();}},[
        h("span",{class:"ic",text:it.ic}), h("span",{text:it.label}),
        it.meta?h("span",{class:"meta",text:it.meta}):null, h("span",{class:"tag",text:it.tag})
      ])); });
    },

    /* on tablet widths the collapsed class opens a labelled drawer over the
       content; show a dim backdrop behind it and close on scrim/nav tap */
    isDrawerWidth(){ return window.matchMedia("(max-width:1100px) and (min-width:821px)").matches; },
    syncNavScrim(){
      if(!this.navScrim) return;
      const open=this.isDrawerWidth() && $("#app").classList.contains("collapsed");
      this.navScrim.classList.toggle("show", open);
    },
    closeNavDrawer(){ $("#app").classList.remove("collapsed"); this.syncNavScrim(); },

    bindChrome(){
      $("#themeToggle").onclick=()=>this.setTheme(this.theme==="dark"?"light":"dark");
      this.navScrim=h("div",{class:"nav-scrim",onclick:()=>this.closeNavDrawer()});
      document.body.appendChild(this.navScrim);
      $("#menuToggle").onclick=()=>{ $("#app").classList.toggle("collapsed"); this.syncNavScrim(); };
      window.addEventListener("resize",()=>this.syncNavScrim());
      $("#bellBtn").onclick=()=>this.openAlerts();
      $("#closeDrawer").onclick=()=>this.closeDrawer();
      $("#scrim").onclick=()=>this.closeDrawer();
      $("#accentToggle").onclick=(e)=>{ e.stopPropagation(); const m=$("#accentMenu"); m.hidden=!m.hidden; };
      document.addEventListener("click",(e)=>{ if(!e.target.closest(".accent-pop")) $("#accentMenu").hidden=true; });
      $("#autoAccent").onchange=(e)=>this.setAutoAccent(e.target.checked);
      $("#searchTrigger").onclick=()=>this.openCmdk();
      // org name/sub from data — the user chip (name/avatar) is set by
      // applyRoleChrome() from the logged-in account, never from org contacts.
      const org=ENG.data.org;
      const on=$("#orgName"), os=$("#orgSub");
      if(on) on.textContent=org.short||org.name;
      if(os) os.textContent="Doddaballapur, Bangalore";
      // command palette keys
      const input=$("#cmdkInput");
      input.oninput=()=>{ this.cmdkSel=0; this.cmdkRender(input.value); };
      $("#cmdk").onclick=(e)=>{ if(e.target.id==="cmdk") this.closeCmdk(); };
      document.addEventListener("keydown",(e)=>{
        if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="k"){ e.preventDefault(); $("#cmdk").hidden?this.openCmdk():this.closeCmdk(); return; }
        if($("#cmdk").hidden) return;
        if(e.key==="Escape") this.closeCmdk();
        else if(e.key==="ArrowDown"){ e.preventDefault(); this.cmdkSel=Math.min((this.cmdkList||[]).length-1,this.cmdkSel+1); this.cmdkRender(input.value); }
        else if(e.key==="ArrowUp"){ e.preventDefault(); this.cmdkSel=Math.max(0,this.cmdkSel-1); this.cmdkRender(input.value); }
        else if(e.key==="Enter"){ const it=(this.cmdkList||[])[this.cmdkSel]; if(it){ it.act(); this.closeCmdk(); } }
      });
      window.addEventListener("hashchange",()=>{ const hash=location.hash.replace("#",""); if(hash&&M[hash]&&hash!==this.current) this.go(hash); });
    }
  };

  global.App = App;
  document.addEventListener("DOMContentLoaded",()=>App.boot());
})(window);
