/* ============================================================
   CHHAPERIA ERP — LIGHTWEIGHT CANVAS CHARTS
   No external libs. Reads CSS custom props so charts recolor
   automatically with the dynamic accent + theme.
   Supports: line/area, grouped bars, donut, sparkline, gauge.
   Includes hover tooltips + entrance animation.
   ============================================================ */
(function (global) {
  "use strict";

  function css(v, el){ return getComputedStyle(el||document.documentElement).getPropertyValue(v).trim(); }
  function series(el){ return [1,2,3,4,5,6,7,8].map(i=>css("--c"+i, el)); }
  function dpr(){ return Math.max(1, window.devicePixelRatio||1); }

  function setup(canvas){
    const r = dpr(); const rect = canvas.getBoundingClientRect();
    const w = rect.width || canvas.parentElement.clientWidth || 600;
    const h = +canvas.dataset.h || 240;
    canvas.width = w*r; canvas.height = h*r;
    canvas.style.height = h+"px";
    const ctx = canvas.getContext("2d"); ctx.scale(r,r);
    return {ctx, w, h};
  }

  function ease(t){ return 1-Math.pow(1-t,3); }
  function animate(draw, dur=600){
    const start = performance.now();
    function frame(now){ let p=Math.min(1,(now-start)/dur); draw(ease(p)); if(p<1) requestAnimationFrame(frame); }
    requestAnimationFrame(frame);
  }

  function tip(box){
    let t = box.querySelector(".chart-tooltip");
    if(!t){ t=document.createElement("div"); t.className="chart-tooltip"; t.style.opacity=0; box.appendChild(t); }
    return t;
  }

  /* ---------------- LINE / AREA ---------------- */
  function line(canvas, cfg){
    const box = canvas.parentElement;
    const {ctx,w,h} = setup(canvas);
    const pad = {l:46,r:14,t:16,b:26};
    const labels = cfg.labels; const sets = cfg.series; // [{name,data,color}]
    const all = sets.flatMap(s=>s.data);
    let max = Math.max(...all, 1), min = Math.min(...all, 0);
    max = max*1.12 || 1; const range = (max-min)||1;
    const text = css("--text-mut"), line=css("--line");
    const cols = series(canvas);
    const X = i => pad.l + i*(w-pad.l-pad.r)/Math.max(1,labels.length-1);
    const Y = v => pad.t + (1-(v-min)/range)*(h-pad.t-pad.b);

    function render(prog){
      ctx.clearRect(0,0,w,h);
      // grid
      ctx.strokeStyle=line; ctx.lineWidth=1; ctx.font="10px "+css("--font"); ctx.fillStyle=text;
      const steps=4;
      for(let i=0;i<=steps;i++){ const v=min+range*i/steps; const y=Y(v);
        ctx.globalAlpha=.6; ctx.beginPath(); ctx.moveTo(pad.l,y); ctx.lineTo(w-pad.r,y); ctx.stroke(); ctx.globalAlpha=1;
        ctx.fillText(fmt(v), 6, y+3); }
      // x labels (sparse)
      const every=Math.ceil(labels.length/7);
      labels.forEach((lb,i)=>{ if(i%every) return; ctx.fillStyle=text;
        ctx.fillText(short(lb), X(i)-12, h-8); });
      // series
      sets.forEach((s,si)=>{
        const color = s.color || cols[si%cols.length];
        // area
        if(cfg.area!==false){
          const g=ctx.createLinearGradient(0,pad.t,0,h-pad.b);
          g.addColorStop(0, hexA(color,.28)); g.addColorStop(1, hexA(color,0));
          ctx.beginPath(); ctx.moveTo(X(0),Y(min));
          s.data.forEach((v,i)=>{ const yy=Y(min+(v-min)*prog); ctx.lineTo(X(i),yy); });
          ctx.lineTo(X(s.data.length-1),Y(min)); ctx.closePath(); ctx.fillStyle=g; ctx.fill();
        }
        ctx.beginPath(); ctx.lineWidth=2.4; ctx.strokeStyle=color; ctx.lineJoin="round";
        s.data.forEach((v,i)=>{ const yy=Y(min+(v-min)*prog); i?ctx.lineTo(X(i),yy):ctx.moveTo(X(i),yy); });
        ctx.stroke();
      });
    }
    animate(render);

    // hover
    const tt = tip(box);
    canvas.onmousemove = (e)=>{
      const r=canvas.getBoundingClientRect(); const mx=e.clientX-r.left;
      let i=Math.round((mx-pad.l)/((w-pad.l-pad.r)/Math.max(1,labels.length-1)));
      i=Math.max(0,Math.min(labels.length-1,i));
      tt.style.opacity=1; tt.style.left=Math.min(w-120,X(i)+8)+"px"; tt.style.top=pad.t+"px";
      tt.innerHTML=`<div class="tt-t">${short(labels[i],true)}</div>`+
        sets.map((s,si)=>`<div class="tt-r"><span class="d" style="background:${s.color||cols[si%cols.length]}"></span>${s.name}<b>${fmt(s.data[i])}</b></div>`).join("");
    };
    canvas.onmouseleave=()=>tt.style.opacity=0;

    function fmt(v){ return cfg.fmt? cfg.fmt(v): (Math.abs(v)>=1000?(v/1000).toFixed(1)+"k":Math.round(v)); }
    function short(d,full){ const m=/\d{4}-(\d{2})-(\d{2})/.exec(d); if(!m) return d;
      const mo=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][+m[1]-1];
      return full? `${+m[2]} ${mo}` : `${mo} ${+m[2]}`; }
  }

  /* ---------------- GROUPED / STACKED BARS ---------------- */
  function bars(canvas, cfg){
    const box=canvas.parentElement; const {ctx,w,h}=setup(canvas);
    const pad={l:46,r:14,t:16,b:30};
    const labels=cfg.labels, sets=cfg.series;
    const stacked=cfg.stacked;
    let max;
    if(stacked) max=Math.max(...labels.map((_,i)=>sets.reduce((s,se)=>s+se.data[i],0)),1);
    else max=Math.max(...sets.flatMap(s=>s.data),1);
    max*=1.14;
    const text=css("--text-mut"), line=css("--line"); const cols=series(canvas);
    const gw=(w-pad.l-pad.r)/labels.length;
    const Y=v=>pad.t+(1-v/max)*(h-pad.t-pad.b);

    function render(prog){
      ctx.clearRect(0,0,w,h);
      ctx.strokeStyle=line; ctx.font="10px "+css("--font"); ctx.fillStyle=text;
      for(let i=0;i<=4;i++){ const v=max*i/4; const y=Y(v); ctx.globalAlpha=.6;
        ctx.beginPath();ctx.moveTo(pad.l,y);ctx.lineTo(w-pad.r,y);ctx.stroke();ctx.globalAlpha=1;
        ctx.fillText(fmt(v),6,y+3); }
      labels.forEach((lb,i)=>{
        const x0=pad.l+i*gw;
        if(stacked){
          let acc=0;
          sets.forEach((s,si)=>{ const val=s.data[i]*prog; const bh=val/max*(h-pad.t-pad.b);
            const y=Y(acc)-bh; rr(ctx,x0+gw*.18,y,gw*.64,bh,si===sets.length-1?5:0,s.color||cols[si%cols.length]); acc+=s.data[i]*prog; });
        } else {
          const bw=gw*.7/sets.length;
          sets.forEach((s,si)=>{ const val=s.data[i]*prog; const bh=val/max*(h-pad.t-pad.b);
            const x=x0+gw*.15+si*bw; rr(ctx,x,Y(0)-bh,bw*.86,bh,4,s.color||cols[si%cols.length]); });
        }
        ctx.fillStyle=text; ctx.fillText(short(lb), x0+gw*.5-10, h-9);
      });
    }
    animate(render);
    const tt=tip(box);
    canvas.onmousemove=(e)=>{ const r=canvas.getBoundingClientRect(); const mx=e.clientX-r.left;
      let i=Math.floor((mx-pad.l)/gw); if(i<0||i>=labels.length){tt.style.opacity=0;return;}
      tt.style.opacity=1; tt.style.left=Math.min(w-130,pad.l+i*gw+gw*.5)+"px"; tt.style.top=pad.t+"px";
      tt.innerHTML=`<div class="tt-t">${short(labels[i],true)}</div>`+sets.map((s,si)=>`<div class="tt-r"><span class="d" style="background:${s.color||cols[si%cols.length]}"></span>${s.name}<b>${fmt(s.data[i])}</b></div>`).join(""); };
    canvas.onmouseleave=()=>tt.style.opacity=0;
    function fmt(v){ return cfg.fmt?cfg.fmt(v):(Math.abs(v)>=1000?(v/1000).toFixed(1)+"k":Math.round(v)); }
    function short(d,full){ const m=/\d{4}-(\d{2})-(\d{2})/.exec(d); if(!m) return d.length>8&&!full?d.slice(0,8)+"…":d;
      const mo=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][+m[1]-1]; return `${mo} ${+m[2]}`; }
  }

  /* ---------------- DONUT ---------------- */
  function donut(canvas, cfg){
    const box=canvas.parentElement; const {ctx,w,h}=setup(canvas);
    const cx=w/2, cy=h/2, R=Math.min(w,h)/2-8, r=R*0.62;
    const data=cfg.data; const total=data.reduce((s,d)=>s+d.value,0)||1;
    const cols=series(canvas);
    data.forEach((d,i)=> d._c = d.color||cols[i%cols.length]);
    function render(prog){
      ctx.clearRect(0,0,w,h); let a=-Math.PI/2;
      data.forEach(d=>{ const ang=d.value/total*Math.PI*2*prog;
        ctx.beginPath(); ctx.moveTo(cx,cy); ctx.arc(cx,cy,R,a,a+ang); ctx.closePath();
        ctx.fillStyle=d._c; ctx.fill(); a+=ang; });
      // hole
      ctx.globalCompositeOperation="destination-out"; ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2); ctx.fill();
      ctx.globalCompositeOperation="source-over";
      ctx.fillStyle=css("--text"); ctx.textAlign="center"; ctx.font="700 19px "+css("--font");
      ctx.fillText(cfg.center||"", cx, cy+2);
      ctx.fillStyle=css("--text-mut"); ctx.font="11px "+css("--font");
      ctx.fillText(cfg.centerSub||"", cx, cy+20); ctx.textAlign="left";
    }
    animate(render);
    const tt=tip(box);
    canvas.onmousemove=(e)=>{ const rc=canvas.getBoundingClientRect(); const mx=e.clientX-rc.left-cx, my=e.clientY-rc.top-cy;
      const dist=Math.hypot(mx,my); if(dist<r||dist>R){tt.style.opacity=0;return;}
      let ang=Math.atan2(my,mx)+Math.PI/2; if(ang<0)ang+=Math.PI*2; let acc=0,hit=null;
      for(const d of data){ const a2=d.value/total*Math.PI*2; if(ang>=acc&&ang<acc+a2){hit=d;break;} acc+=a2; }
      if(!hit){tt.style.opacity=0;return;}
      tt.style.opacity=1; tt.style.left=(e.clientX-rc.left+10)+"px"; tt.style.top=(e.clientY-rc.top)+"px";
      tt.innerHTML=`<div class="tt-r"><span class="d" style="background:${hit._c}"></span>${hit.name}<b>${(hit.value/total*100).toFixed(1)}%</b></div>`; };
    canvas.onmouseleave=()=>tt.style.opacity=0;
  }

  /* ---------------- SPARKLINE ---------------- */
  function spark(canvas, data, color){
    const {ctx,w,h}=setup(canvas);
    const max=Math.max(...data,1), min=Math.min(...data,0), rng=(max-min)||1;
    color = color||css("--accent");
    const X=i=>i*(w-4)/Math.max(1,data.length-1)+2, Y=v=>h-4-((v-min)/rng)*(h-8);
    const g=ctx.createLinearGradient(0,0,0,h); g.addColorStop(0,hexA(color,.35)); g.addColorStop(1,hexA(color,0));
    ctx.beginPath(); ctx.moveTo(X(0),h); data.forEach((v,i)=>ctx.lineTo(X(i),Y(v))); ctx.lineTo(X(data.length-1),h);
    ctx.closePath(); ctx.fillStyle=g; ctx.fill();
    ctx.beginPath(); ctx.lineWidth=2; ctx.strokeStyle=color; data.forEach((v,i)=>i?ctx.lineTo(X(i),Y(v)):ctx.moveTo(X(i),Y(v))); ctx.stroke();
    const lv=data[data.length-1]; ctx.beginPath(); ctx.arc(X(data.length-1),Y(lv),2.6,0,Math.PI*2); ctx.fillStyle=color; ctx.fill();
  }

  /* ---------------- GAUGE (radial progress) ---------------- */
  function gauge(canvas, pct, color){
    const {ctx,w,h}=setup(canvas);
    const cx=w/2, cy=h*0.92, R=Math.min(w/2,h)-10;
    color=color||css("--accent");
    function render(prog){
      ctx.clearRect(0,0,w,h);
      ctx.lineWidth=12; ctx.lineCap="round";
      ctx.beginPath(); ctx.arc(cx,cy,R,Math.PI,Math.PI*2); ctx.strokeStyle=css("--panel-3"); ctx.stroke();
      ctx.beginPath(); ctx.arc(cx,cy,R,Math.PI,Math.PI+(Math.PI*Math.min(1,pct/100))*prog); ctx.strokeStyle=color; ctx.stroke();
      ctx.fillStyle=css("--text"); ctx.textAlign="center"; ctx.font="700 22px "+css("--font");
      ctx.fillText(Math.round(pct*prog)+"%", cx, cy-8); ctx.textAlign="left";
    }
    animate(render);
  }

  /* ---------------- HORIZONTAL BARS (ranking) ----------------
     For ranked categorical data with long names (e.g. Revenue by
     Product). Each item is its own row — name on the left, bar to the
     right, value in a fixed right column — so labels never collide or
     get squeezed the way vertical-bar x-axis labels do on narrow
     screens. Full name shows in the hover/tap tooltip.
     cfg: { items:[{label,value,color?}], fmt, name, color } */
  function hbars(canvas, cfg){
    const box=canvas.parentElement; const {ctx,w,h}=setup(canvas);
    const items=cfg.items||[]; const n=Math.max(1,items.length);
    const pad={t:6,b:6,l:12,r:12};
    const valW=64;                                   // reserved value column
    const rowH=(h-pad.t-pad.b)/n;
    const barH=Math.max(9,Math.min(18,rowH*0.5));
    const max=Math.max(...items.map(d=>d.value),1);
    const text=css("--text"), mut=css("--text-mut");
    const accent=cfg.color||css("--accent");
    const labelW=Math.max(84,Math.min(w*0.36,200));
    const trackX=pad.l+labelW+10;
    const trackW=Math.max(20, w-trackX-valW-pad.r);
    const fontLbl="12px "+css("--font");
    function fmt(v){ return cfg.fmt?cfg.fmt(v):(Math.abs(v)>=1000?(v/1000).toFixed(1)+"k":Math.round(v)); }
    function elide(s,maxW){ s=String(s==null?"":s); ctx.font=fontLbl;
      if(ctx.measureText(s).width<=maxW) return s;
      let lo=0,hi=s.length;
      while(lo<hi){ const mid=(lo+hi+1)>>1; if(ctx.measureText(s.slice(0,mid)+"…").width<=maxW) lo=mid; else hi=mid-1; }
      return s.slice(0,Math.max(1,lo))+"…"; }
    function render(prog){
      ctx.clearRect(0,0,w,h); ctx.textBaseline="middle";
      items.forEach((d,i)=>{
        const cy=pad.t+i*rowH+rowH/2;
        rr(ctx,trackX,cy-barH/2,trackW,barH,barH/2,hexA(accent,.10));   // track
        const bw=Math.max(barH,d.value/max*trackW*prog);               // bar
        rr(ctx,trackX,cy-barH/2,bw,barH,barH/2,d.color||accent);
        ctx.font=fontLbl; ctx.textAlign="left"; ctx.fillStyle=text;    // name
        ctx.fillText(elide(d.label,labelW),pad.l,cy);
        ctx.font="700 11px "+css("--font"); ctx.textAlign="right"; ctx.fillStyle=mut;  // value
        ctx.fillText(fmt(d.value),w-pad.r,cy);
      });
      ctx.textAlign="left"; ctx.textBaseline="alphabetic";
    }
    animate(render);
    const tt=tip(box);
    canvas.onmousemove=(e)=>{ const r=canvas.getBoundingClientRect(); const my=e.clientY-r.top;
      let i=Math.floor((my-pad.t)/rowH); if(i<0||i>=items.length){tt.style.opacity=0;return;}
      const d=items[i]; tt.style.opacity=1;
      tt.style.left=Math.min(w-150,trackX)+"px"; tt.style.top=(pad.t+i*rowH)+"px";
      tt.innerHTML=`<div class="tt-t">${d.label}</div><div class="tt-r"><span class="d" style="background:${d.color||accent}"></span>${cfg.name||"Value"}<b>${fmt(d.value)}</b></div>`; };
    canvas.onmouseleave=()=>tt.style.opacity=0;
  }

  /* utils */
  function rr(ctx,x,y,w,h,r,fill){ if(h<=0)return; r=Math.min(r,w/2,h); ctx.beginPath();
    ctx.moveTo(x+r,y); ctx.arcTo(x+w,y,x+w,y+h,r); ctx.arcTo(x+w,y+h,x,y+h,0); ctx.arcTo(x,y+h,x,y,0); ctx.arcTo(x,y,x+w,y,r);
    ctx.closePath(); ctx.fillStyle=fill; ctx.fill(); }
  function hexA(hex,a){ hex=hex.replace('#',''); if(hex.length===3)hex=hex.split('').map(c=>c+c).join('');
    const n=parseInt(hex,16); return `rgba(${(n>>16)&255},${(n>>8)&255},${n&255},${a})`; }

  global.Charts = { line, bars, hbars, donut, spark, gauge };
})(window);
