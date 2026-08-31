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
      // (the token itself lives in an httpOnly cookie, so only the stored
      //  user profile signals "probably signed in"; /me verifies for real)
      const sessionUser = DB.auth.user();
      if(!sessionUser){
        this.showLogin();
        return;
      }
      // 2) verify the session is still valid + get fresh user/role
      let me;
      try{ me = (await DB.auth.me()).user; }
      catch(err){ this.showLogin(); return; }

      this.user = me;
      /* No password change is forced on sign-in. The form is still there and
         can be opened deliberately (⌘K → "Change Password"). */

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
      this._leaveGuard=null;          // a fresh shell owes nothing to the last one
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
      /* A module that registered a leave guard is an editor, and an editor is
         never re-rendered from under its user. Label Studio draws on a canvas
         rather than into inputs, so an operator can spend ten minutes placing
         objects with the activeElement test below never once firing — and the
         poll would rebuild the screen from the server and take the design with
         it. Such a screen shows no live ERP figures, so pausing costs nothing. */
      if(this._leaveGuard) return true;
      /* Anything with focus that takes typing pauses the refresh, so a re-render
         can never yank a half-finished edit out from under the user. */
      const ae=document.activeElement;
      if(ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) return true;
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
      /* the button is the SAME element every time this screen is shown, and a
         successful sign-in leaves it disabled reading "Signing in…" — reset it
         here or switching user lands on a dead form. */
      btn.disabled=false; btn.textContent="Sign In";
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
      /* The signed-out screen has no module on it, so a guard left behind from
         the last one would stall the next session's first render and its poll. */
      this._leaveGuard=null;
      try{ await DB.auth.logout(); }catch{}
      this.user=null;
      location.hash="";
      this.showLogin("You have been signed out.");
    },

    /* Changing your password is entirely OPTIONAL and only ever opened on
       purpose — nothing forces this dialog at sign-in. */
    forcePasswordChange(){
      const {h, modal, toast} = UI;
      const body=h("div",{},[
        h("p",{class:"dim",style:"font-size:13px;margin-bottom:14px;line-height:1.6",
          text:"Set a new password for this account — at least 8 characters."}),
        h("div",{class:"form-grid"},[
          h("div",{class:"field full"},[h("label",{text:"Current Password"}),h("input",{class:"input",id:"pw_cur",type:"password",autocomplete:"current-password"})]),
          h("div",{class:"field full"},[h("label",{text:"New Password"}),h("input",{class:"input",id:"pw_new",type:"password",autocomplete:"new-password"})]),
          h("div",{class:"field full"},[h("label",{text:"Confirm New Password"}),h("input",{class:"input",id:"pw_new2",type:"password",autocomplete:"new-password"})]),
        ])
      ]);
      const mo=modal({title:"🔒 Change Password", sub:"Optional — only if you want a new one", body,
        foot:[h("button",{class:"btn ghost",onclick:()=>mo.close(),text:"Cancel"}),
          h("button",{class:"btn primary",id:"pwBtn",onclick:save,text:"Set New Password"})]});
      const self=this;
      async function save(){
        const cur=UI.$("#pw_cur").value, nw=UI.$("#pw_new").value, nw2=UI.$("#pw_new2").value;
        if(nw.length<8){ toast("New password must be at least 8 characters",{type:"warn"}); return; }
        if(nw!==nw2){ toast("New passwords don't match",{type:"warn"}); return; }
        const btn=UI.$("#pwBtn"); btn.disabled=true; btn.textContent="Saving…";
        try{
          const r=await DB.auth.changePassword(cur, nw);
          self.user=r.user;
          mo.close();
          toast("Password updated — old sessions have been signed out",{type:"ok",title:"Secured"});
        }catch(e){
          toast(e.message,{type:"danger"});
          btn.disabled=false; btn.textContent="Set New Password";
        }
      }
    },

    /* hide admin-only chrome from office; label the user chip */
    applyRoleChrome(){
      const u=this.user||{};
      const nameEl=$("#userName"), roleEl=$("#userRole"), av=$("#userAvatar");
      if(nameEl) nameEl.textContent = u.name || u.username || "User";
      if(roleEl) roleEl.textContent = ({admin:"Administrator",office:"Office Desk",lab:"Lab Incharge (QC)",supervisor:"Supervisor"})[u.role] || u.role || "";
      if(av) av.textContent = (u.name||u.username||"U").split(" ").map(x=>x[0]).slice(0,2).join("").toUpperCase();
      const logout=$("#logoutBtn"); if(logout) logout.onclick=()=>this.logout();
      // theme + accent are system settings — only admin may change them
      const admin=this.isAdmin();
      const themeBtn=$("#themeToggle"); if(themeBtn) themeBtn.hidden=!admin;
    },

    /* ---- nav dropdown state — which sections are open ----
       Per browser (localStorage), not a server setting: how a person folds
       their own menu is theirs, like scroll position. First run opens only
       the section the current page lives in. */
    navState(){
      if(!this.navOpen){
        try{ this.navOpen = JSON.parse(localStorage.getItem("chhaperia.navOpen")) || {}; }
        catch(e){ this.navOpen = {}; }
        if(typeof this.navOpen !== "object" || Array.isArray(this.navOpen)) this.navOpen = {};
      }
      return this.navOpen;
    },
    saveNavState(){ try{ localStorage.setItem("chhaperia.navOpen", JSON.stringify(this.navOpen||{})); }catch(e){} },
    secOfView(id){
      let sec=null;
      for(const n of UI.NAV){ if(n.sec){ sec=n.sec; continue; } if(n.id===id) return sec; }
      return null;
    },

    buildNav(){
      const nav=$("#nav"); nav.innerHTML="";
      const isAdmin = this.user && this.user.role === "admin";
      const isLab = this.isLab();
      /* ONE set of figures for the whole bar. The pills used to ask for them
         per nav item — six pillKeys plus the low-stock badge, so seven full
         passes over every purchase order, sales order and work order in the
         business. buildNav runs on every save, which is what made a change
         anywhere in the app sit for a second before the screen came back. */
      const k = ENG.kpis();
      const open = this.navState();
      const activeSec = this.secOfView(this.current);
      let itemsHost = null;
      UI.NAV.forEach(n=>{
        // the lab incharge gets an explicit allowlist, not "everything minus
        // admin-only" — the server enforces the same shape (viewService.stateForLab)
        if(isLab){ if(!n.labOk) return; }
        else if(n.adminOnly && !isAdmin) return; // hide admin-only items from office
        if(n.sec){
          const secName=n.sec;
          // a saved fold wins; otherwise only the active page's section starts open
          const isOpen = open[secName]!=null ? !!open[secName] : secName===activeSec;
          const grp=h("div",{class:"nav-group"+(isOpen?" open":""),"data-sec":secName});
          const head=h("button",{class:"nav-section",type:"button","aria-expanded":String(isOpen),
            onclick:()=>{
              const now=!grp.classList.contains("open");
              grp.classList.toggle("open",now);
              head.setAttribute("aria-expanded",String(now));
              this.navState()[secName]=now; this.saveNavState();
              this.decorateNavHeads();
            }},[
            h("span",{class:"nav-sec-lbl",text:secName}),
            h("span",{class:"nav-sec-badge",hidden:true}),
            h("span",{class:"nav-sec-chev","aria-hidden":"true",text:"▾"}),
          ]);
          itemsHost=h("div",{class:"nav-group-items"});
          grp.appendChild(head); grp.appendChild(itemsHost);
          nav.appendChild(grp);
          return;
        }
        const item=h("div",{class:"nav-item"+(n.id===this.current?" active":""),"data-id":n.id,
          role:"button",tabindex:"0","aria-label":n.label,
          onclick:()=>this.go(n.id),
          onkeydown:(e)=>{ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); this.go(n.id); } }},[
          h("span",{class:"ic","aria-hidden":"true",text:n.icon}),
          h("span",{class:"lbl",text:n.label}),
        ]);
        // pills (open counts / alerts)
        if(n.pillKey){ const v=k[n.pillKey];
          if(v) item.appendChild(h("span",{class:"pill",text:v})); }
        if(n.id==="inventory"){ const low=k.lowStock; if(low) item.appendChild(h("span",{class:"pill danger",text:low})); }
        // orders with quantity waiting on material — amber, it needs the office
        if(n.id==="production"){ const p=k.pendingWO; if(p) item.appendChild(h("span",{class:"pill warn",text:p})); }
        (itemsHost||nav).appendChild(item);
      });
      // a role can pass a section head yet fail every item in it — no empty folds
      $$(".nav-group",nav).forEach(g=>{ if(!g.querySelector(".nav-item")) g.remove(); });
      this.decorateNavHeads();
    },

    /* A closed section must not bury its alerts: the head carries the sum of
       its hidden items' pills, coloured by the most urgent one inside. */
    decorateNavHeads(){
      $$("#nav .nav-group").forEach(g=>{
        const badge=g.querySelector(".nav-sec-badge"); if(!badge) return;
        if(g.classList.contains("open")){ badge.hidden=true; return; }
        let sum=0, cls="";
        g.querySelectorAll(".nav-item .pill").forEach(p=>{
          const v=parseInt(p.textContent,10); if(v>0) sum+=v;
          if(p.classList.contains("danger")) cls="danger";
          else if(p.classList.contains("warn") && cls!=="danger") cls="warn";
        });
        if(sum>0){ badge.textContent=sum>99?"99+":String(sum); badge.className="nav-sec-badge"+(cls?" "+cls:""); badge.hidden=false; }
        else badge.hidden=true;
      });
    },

    /* ---- role-based module access ----
       Admin sees everything. Office is denied any NAV item flagged adminOnly
       (the Overview and System sections). The lab incharge is the other way
       round — an explicit allowlist (labOk), read-only everywhere except Lab
       Reports (labWrite). This is presentation only: the server independently
       scopes both the payload and every write. */
    isAdmin(){ return !!(this.user && this.user.role === "admin"); },
    isLab(){ return !!(this.user && this.user.role === "lab"); },
    canAccess(id){
      const meta = UI.NAV.find(n => n.id === id);
      if(this.isLab()) return !!(meta && meta.labOk);
      return meta ? !(meta.adminOnly && !this.isAdmin()) : true;
    },
    /** May the current user create/edit inside this module? */
    canWrite(id){
      if(!this.isLab()) return true;
      const meta = UI.NAV.find(n => n.id === (id || this.current));
      return !!(meta && meta.labWrite);
    },
    homeId(){
      if(this.isLab()) return "lab-reports";
      // the first item a role may see is where the app opens
      const first = UI.NAV.find(n => n.id && !(n.adminOnly && !this.isAdmin()));
      return first ? first.id : "dashboard";
    },

    /* A module with unsaved work registers a guard when it renders; the next
       navigation away asks before it throws that work out. Label Studio is the
       one screen where you can lose twenty minutes to a mis-click on the menu.
       The guard is cleared by the navigation itself, so it can never outlive
       the module that set it. */
    setLeaveGuard(fn){ this._leaveGuard = typeof fn==="function" ? fn : null; },

    /* Back to the tab this one was reached from, in the state it was left in.
       go() will note THIS tab on the way out, so back from there returns —
       two tabs toggle rather than the trail dead-ending after one hop. */
    back(){
      /* Walk the TRAIL — the pages actually travelled, newest first. Entries
         whose module has vanished or become inaccessible are stepped over, so
         one revoked section cannot dead-end the whole way home. */
      const t=this._trail||[];
      let b=null;
      while(t.length){ const c=t.pop(); if(M[c.id]&&this.canAccess(c.id)){ b=c; break; } }
      this._fromBack=true;                 // going back is not a new departure
      try{ if(b) this.go(b.id, b.params); else this.go(this.homeId()); }
      finally{ this._fromBack=false; }
    },

    go(id, params){
      if(!M[id]){ id=this.homeId(); }
      if(!this.canAccess(id)){ id=this.homeId(); } // block hidden modules by hash/palette
      /* Same-module navigation is guarded too: the menu item for the screen you
         are already on re-renders it, which is just as destructive as leaving. */
      if(this._leaveGuard){
        /* A guard may answer with a plain message (leave / stay) or with
           {message, save} — the second says "I know how to keep this work",
           and earns the operator a third answer. */
        const g=this._leaveGuard();
        const msg=(g&&typeof g==="object")?g.message:g;
        const saveFn=(g&&typeof g==="object"&&typeof g.save==="function")?g.save:null;
        // the hash may already have moved (someone edited the URL) — put it back
        const stay=()=>{
          if(location.hash.replace("#","")!==this.current) location.hash=this.current; };
        if(msg&&saveFn){
          UI.confirmSave(msg,{title:"Unsaved changes"}).then(async(answer)=>{
            if(answer==="cancel") return stay();
            if(answer==="save"){
              try{ await saveFn(); }
              catch(err){
                /* the work is still here and still unsaved — staying put is
                   the only honest outcome */
                UI.toast("Could not save: "+((err&&err.message)||"unknown error")+
                  " — you are still on this screen and nothing was lost",
                  {type:"err",title:"Not saved",dur:8000});
                return stay();
              }
            }
            this._leaveGuard=null; this.go(id,params);
          });
          return;
        }
        if(msg){
          UI.confirm(msg,{title:"Unsaved changes",danger:true}).then(ok=>{
            if(ok){ this._leaveGuard=null; this.go(id,params); }
            else stay();
          });
          return;
        }
      }
      this._leaveGuard=null;
      /* WHERE YOU CAME FROM, with the state it was in. A jump across tabs —
         inventory to the ledger, a lead to its customer — remembers the tab
         it left AND its params, so "back" lands on the screen as it was, not
         a fresh copy of the module. Re-rendering the same tab is not a jump
         and must not eat the trail. */
      if(this.current && this.current!==id && M[this.current] && !this._fromBack){
        /* …but not the one-shot params. openNew / create / openPending are
           commands, not state — carried back, they would re-open a "New …"
           dialog the user already dealt with. */
        let bp=null;
        if(this.params){
          bp={...this.params};
          delete bp.openNew; delete bp.create; delete bp.openPending;
          delete bp.highlight; delete bp.open;
          if(!Object.keys(bp).length) bp=null;
        }
        /* the TRAIL: every page on the way here, so back retraces the whole
           journey — ledger to the order to production and back again — instead
           of toggling between the last two tabs. Capped so a long day at the
           terminal cannot grow it without bound. */
        this._trail=this._trail||[];
        this._trail.push({id:this.current, params:bp});
        if(this._trail.length>20) this._trail.shift();
      }
      this.current=id; this.params=params||null;
      location.hash=id;
      // nav active state
      $$(".nav-item").forEach(el=>el.classList.toggle("active", el.getAttribute("data-id")===id));
      // navigating opens the destination's own section — the active item is
      // never left inside a closed fold (⌘K and cross-links land here too)
      const actEl=$('#nav .nav-item[data-id="'+id+'"]');
      const grp=actEl && actEl.closest(".nav-group");
      if(grp && !grp.classList.contains("open")){
        grp.classList.add("open");
        const hd=grp.querySelector(".nav-section");
        if(hd) hd.setAttribute("aria-expanded","true");
        const sec=grp.getAttribute("data-sec");
        if(sec){ this.navState()[sec]=true; this.saveNavState(); }
        this.decorateNavHeads();
      }
      // auto accent
      if(this.autoAccent){ const meta=UI.NAV.find(n=>n.id===id); if(meta&&meta.accent){ document.documentElement.setAttribute("data-accent",meta.accent); } }
      else { document.documentElement.setAttribute("data-accent", this.accent); }
      // crumbs — with the way back, when there is one
      const mod=M[id];
      const cr=$("#crumbs"); cr.innerHTML="";
      const bk=(this._trail&&this._trail.length)?this._trail[this._trail.length-1]:null;
      if(bk && M[bk.id] && this.canAccess(bk.id))
        cr.appendChild(h("button",{class:"crumb-back",type:"button",
          title:"Back to "+M[bk.id].title,
          onclick:()=>this.back()},[
          h("span",{class:"crumb-back-a",text:"‹"}),
          h("span",{class:"crumb-back-t",text:M[bk.id].title}),
        ]));
      cr.appendChild(h("span",{class:"brandcrumb",text:"Chhaperia"}));
      cr.appendChild(h("span",{class:"sep",text:"/"}));
      cr.appendChild(h("span",{class:"cur",text:mod.title}));
      // render
      const view=$("#view"); view.innerHTML=""; view.classList.remove("fade-in"); void view.offsetWidth; view.classList.add("fade-in");
      try{ mod.render(view, params); }
      catch(err){ console.error("Module error:",err); view.appendChild(h("div",{class:"empty"},[h("div",{class:"big",text:"⚠"}),h("div",{text:"Module failed to render: "+err.message})])); }
      view.scrollTop=0;
      /* params.highlight names a record this navigation was ABOUT — a jump
         from another screen sends the row it was about. Landing on the
         module and leaving you to find the line again is what made those marks
         feel like they went nowhere, so bring it into view and flash it. */
      if(params&&params.highlight!=null) this.flashRow(String(params.highlight));
      // on tablet, picking a menu item closes the drawer
      if(this.isDrawerWidth&&this.isDrawerWidth()) this.closeNavDrawer();
    },

    /* Find the row a navigation was about, scroll it into view and flash it.
       Runs after the module has rendered; a table built asynchronously gets a
       second look on the next frame before we give up. Rows are stamped with
       data-row-id by UI.table(), so this works for every section at once. */
    flashRow(id){
      const view=$("#view");
      if(!view||!id) return;
      const find=()=>view.querySelector('[data-row-id="'+(window.CSS&&CSS.escape?CSS.escape(id):id.replace(/"/g,'\\"'))+'"]');
      const put=(el)=>{
        if(!el) return false;
        el.classList.remove("row-flash");
        void el.offsetWidth;                    // restart the animation on a repeat click
        el.classList.add("row-flash");
        try{ el.scrollIntoView({block:"center",behavior:"smooth"}); }
        catch{ el.scrollIntoView(); }
        setTimeout(()=>el.classList.remove("row-flash"), 2600);
        return true;
      };
      if(put(find())) return;
      requestAnimationFrame(()=>{ if(!put(find())) setTimeout(()=>put(find()),180); });
    },

    /* the settings document — both save paths build it here so neither can
       drop a key the other writes */
    settingsDoc(){
      return {theme:this.theme,accent:this.accent,autoAccent:this.autoAccent,lowStockOnly:false};
    },

    persistAndRefresh(){
      ENG.data.settings=this.settingsDoc();
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
      const s=this.settingsDoc();
      ENG.data.settings=s;
      /* theme and accent are a preference, not the day’s work — a failed
         write is worth a line in the console and nothing more */
      DB.saveSettings(s).catch((e)=>console.warn("settings save failed",e));
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
    /* Re-render the current module WITHOUT moving the operator.
       go() rebuilds #view from scratch, which drops the scroll position back
       to the top — so a background poll, or a save made while a dialog was
       open (printing labels, filing a lab report), used to yank the page back
       to where it started. Anything that refreshes in place restores the
       scroll, so you stay exactly where you were. A deliberate navigation
       still starts at the top, because that is a different page. */
    refreshView(){
      if(!(this.current && M[this.current])) return;
      /* Never rebuild an editor — a refresh is housekeeping, and it does not get
         to throw the operator's design away. Live again the moment they leave. */
      if(this._leaveGuard) return;
      const view=$("#view");
      const top=view?view.scrollTop:0;
      const prev=view?view.style.scrollBehavior:"";
      if(view) view.style.scrollBehavior="auto";   // smooth scrolling would animate the restore
      this.go(this.current, this.params);
      if(!view) return;
      const put=()=>{ if(view.scrollTop!==top) view.scrollTop=top; };
      put();
      // again after layout settles, so late content (charts, images) can't shift it
      requestAnimationFrame(()=>{ put(); view.style.scrollBehavior=prev; });
    },

    /* ---- theme/accent ---- */
    setTheme(t){ this.theme=t; document.documentElement.setAttribute("data-theme",t); this.persistSettings(); },
    setAccent(a){ this.accent=a; this.autoAccent=false; document.documentElement.setAttribute("data-accent",a); this.renderAccentMenu(); this.persistSettings(); },
    setAutoAccent(v){ this.autoAccent=v; this.persistSettings(); },

    renderAccentMenu(){
      // hexes must match theme.css [data-accent] — the swatch shows what you get
      const accents=[["orange","#F06820"],["red","#E84820"],["blue","#3b82f6"],["teal","#0fb5ae"],["violet","#8b5cf6"],["green","#18b364"],["pink","#ec4899"],["amber","#eab308"]];
      const box=$("#swatches"); if(!box) return; box.innerHTML="";
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
            else if(a.kind==="lead") this.go("crm");
            /* A failed lot needs a decision, not a page: land on Procurement and
               open the queue itself, so the ruling is one click from the alert. */
            else if(a.kind==="qcDecision"){ this.go("purchase");
              const q=(window._erpUtil||{}).qcDecisionQueue;
              if(q) setTimeout(q,60); } }},[
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
        (ENG.data.quotations||[]).forEach(qt=>{ if((qt.id+" "+(qt.company||"")+" "+(qt.productName||"")).toLowerCase().includes(q)) out.push({ic:"📄",label:qt.id+" — "+(qt.company||ENG.custName(qt.customerId)),meta:(qt.productName||"")+" · "+qt.status,tag:"Quotation",act:()=>this.go("quotations",{tab:"quotations",open:qt.id})}); });
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

  /* Changing a password is never forced, so it needs a way in: searching the
     command palette (⌘K) for "password" opens the same form. */
  global.ERPActions = Object.assign(global.ERPActions||{}, {
    changePassword: { ic:"🔒", label:"Change Password", run:()=>App.forcePasswordChange() },
  });

  /* The caret left in a number field turns the mouse wheel into a spinner:
     scrolling a form changed the quantity under the pointer (reported
     2026-08-27, after the arrow buttons were already hidden). Chrome spins
     only a FOCUSED number input, so the wheel takes the focus away first —
     the value stays where it was typed and the page scrolls as it would
     anywhere else. */
  document.addEventListener("wheel",(e)=>{
    const t=e.target;
    if(t&&t.tagName==="INPUT"&&t.type==="number"&&t===document.activeElement) t.blur();
  },{capture:true,passive:true});

  document.addEventListener("DOMContentLoaded",()=>App.boot());
})(window);
