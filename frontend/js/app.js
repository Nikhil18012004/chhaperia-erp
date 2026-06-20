/* ============================================================
   CHHAPERIA ERP — APP CONTROLLER
   Boot, routing, theme/accent, command palette, alerts.
   ============================================================ */
(function (global) {
  "use strict";
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
    },

    buildNav(){
      const nav=$("#nav"); nav.innerHTML="";
      const isAdmin = this.user && this.user.role === "admin";
      UI.NAV.forEach(n=>{
        if(n.adminOnly && !isAdmin) return; // hide admin-only items from office
        if(n.sec){ nav.appendChild(h("div",{class:"nav-section",text:n.sec})); return; }
        const item=h("div",{class:"nav-item"+(n.id===this.current?" active":""),"data-id":n.id,onclick:()=>this.go(n.id)},[
          h("span",{class:"ic",text:n.icon}),
          h("span",{class:"lbl",text:n.label}),
        ]);
        // pills (open counts / alerts)
        if(n.pillKey){ const v=ENG.kpis()[n.pillKey];
          if(v) item.appendChild(h("span",{class:"pill",text:v})); }
        if(n.id==="inventory"){ const low=ENG.kpis().lowStock; if(low) item.appendChild(h("span",{class:"pill danger",text:low})); }
        nav.appendChild(item);
      });
    },

    go(id, params){
      if(!M[id]){ id="dashboard"; }
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
    },

    persistAndRefresh(){
      ENG.data.settings={theme:this.theme,accent:this.accent,autoAccent:this.autoAccent,lowStockOnly:false};
      DB.save(ENG.data);
      ENG.rebuild();
      this.buildNav();
      this.refreshAlerts();
    },

    /* ---- theme/accent ---- */
    setTheme(t){ this.theme=t; document.documentElement.setAttribute("data-theme",t); this.persistAndRefresh(); this.go(this.current,this.params); },
    setAccent(a){ this.accent=a; this.autoAccent=false; document.documentElement.setAttribute("data-accent",a); this.renderAccentMenu(); this.persistAndRefresh(); this.go(this.current,this.params); },
    setAutoAccent(v){ this.autoAccent=v; this.persistAndRefresh(); this.go(this.current,this.params); },

    renderAccentMenu(){
      const accents=[["orange","#F06820"],["red","#E84820"],["blue","#2f7fe0"],["teal","#0fb5ae"],["violet","#7c5cff"],["green","#16a34a"],["pink","#ec4899"],["amber","#e0a000"]];
      const box=$("#swatches"); box.innerHTML="";
      accents.forEach(([a,hex])=>{ const sw=h("div",{class:"swatch"+(this.accent===a&&!this.autoAccent?" sel":""),style:`background:${hex}`,title:a,onclick:()=>this.setAccent(a)}); box.appendChild(sw); });
      const auto=$("#autoAccent"); if(auto) auto.checked=this.autoAccent;
    },

    /* ---- alerts ---- */
    refreshAlerts(){
      const al=ENG.alerts(); const badge=$("#bellBadge");
      if(al.length){ badge.hidden=false; badge.textContent=al.length>99?"99+":al.length; }
      else badge.hidden=true;
    },
    openAlerts(){
      const al=ENG.alerts(); const list=$("#alertList"); list.innerHTML="";
      if(!al.length){ list.appendChild(h("div",{class:"empty"},[h("div",{class:"big",text:"✓"}),h("div",{text:"No active alerts — all systems healthy."})])); }
      al.forEach(a=>{
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
      UI.NAV.forEach(n=>{ if(n.sec)return; if(!q||n.label.toLowerCase().includes(q)) out.push({ic:n.icon,label:n.label,tag:"Module",act:()=>this.go(n.id)}); });
      if(q.length>=2){
        ENG.data.items.forEach(it=>{ if((it.name+" "+it.id).toLowerCase().includes(q)) out.push({ic:"📦",label:it.name,meta:it.id,tag:"Item",act:()=>this.go("inventory")}); });
        ENG.data.salesorders.forEach(s=>{ if(s.id.toLowerCase().includes(q)) out.push({ic:"🧾",label:s.id+" — "+ENG.custName(s.customerId),tag:"Sales",act:()=>this.go("sales")}); });
        ENG.data.purchaseorders.forEach(p=>{ if(p.id.toLowerCase().includes(q)) out.push({ic:"🛒",label:p.id+" — "+ENG.sup(p.supplierId),tag:"PO",act:()=>this.go("purchase")}); });
      }
      return out.slice(0,18);
    },
    cmdkRender(q){
      const items=this.cmdkItems(q); this.cmdkList=items; const box=$("#cmdkResults"); box.innerHTML="";
      if(!items.length){ box.appendChild(h("div",{class:"empty",style:"padding:30px"},"No matches")); return; }
      items.forEach((it,i)=>{ box.appendChild(h("div",{class:"cmdk-row"+(i===this.cmdkSel?" sel":""),onclick:()=>{it.act();this.closeCmdk();}},[
        h("span",{class:"ic",text:it.ic}), h("span",{text:it.label}),
        it.meta?h("span",{class:"meta",text:it.meta}):null, h("span",{class:"tag",text:it.tag})
      ])); });
    },

    bindChrome(){
      $("#themeToggle").onclick=()=>this.setTheme(this.theme==="dark"?"light":"dark");
      $("#menuToggle").onclick=()=>$("#app").classList.toggle("collapsed");
      $("#bellBtn").onclick=()=>this.openAlerts();
      $("#closeDrawer").onclick=()=>this.closeDrawer();
      $("#scrim").onclick=()=>this.closeDrawer();
      $("#accentToggle").onclick=(e)=>{ e.stopPropagation(); const m=$("#accentMenu"); m.hidden=!m.hidden; };
      document.addEventListener("click",(e)=>{ if(!e.target.closest(".accent-pop")) $("#accentMenu").hidden=true; });
      $("#autoAccent").onchange=(e)=>this.setAutoAccent(e.target.checked);
      $("#searchTrigger").onclick=()=>this.openCmdk();
      // org/user from data
      const org=ENG.data.org; $("#userName").textContent=org.contacts[0].name; $("#userAvatar").textContent=org.contacts[0].name.split(" ").map(x=>x[0]).slice(0,2).join("");
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
