/* ============================================================
   asyncify — turn the synchronous SQLite call graph into an
   awaited MySQL one.

   Seeds from the two DAO modules (every export of which is async
   now), inserts `await` at each call site, marks the enclosing
   function `async`, then repeats: a function that just became
   async makes ITS callers async too. Runs to a fixpoint.

   Two details that matter:
   · `repo.getState().items` must become `(await repo.getState()).items`,
     not `await repo.getState().items` — the latter reads .items off a
     promise and yields undefined, silently.
   · Edits are applied back-to-front so earlier offsets stay valid.
   ============================================================ */
const fs=require("fs"), path=require("path");
const acorn=require("../backend/node_modules/acorn");

const FILES=process.argv.slice(2).map(f=>path.resolve(f));
const DB=[path.resolve("backend/src/db/repository.js"),
          path.resolve("backend/src/db/userRepository.js")].map(p=>p.toLowerCase());

const parse=(src)=>acorn.parse(src,{ecmaVersion:2022,sourceType:"script"});
const isFn=(n)=>n&&/^(FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(n.type);

function resolveReq(fromFile,spec){
  if(!spec.startsWith(".")) return null;
  let p=path.resolve(path.dirname(fromFile),spec);
  if(!p.endsWith(".js")) p+=".js";
  return p.toLowerCase();
}

/* per-file model */
const model=new Map();
for(const f of FILES){
  const src=fs.readFileSync(f,"utf8");
  const ast=parse(src);
  const imports=new Map();      // localName -> resolved path
  const exportsMap=new Map();   // exportedName -> localName
  walk(ast,null,(n)=>{
    if(n.type==="VariableDeclarator"&&n.init&&n.init.type==="CallExpression"&&
       n.init.callee.name==="require"&&n.id.type==="Identifier"){
      const a=n.init.arguments[0];
      if(a&&typeof a.value==="string"){
        const r=resolveReq(f,a.value); if(r) imports.set(n.id.name,r);
      }
    }
    if(n.type==="AssignmentExpression"&&n.left.type==="MemberExpression"&&
       n.left.object.name==="module"&&n.left.property.name==="exports"&&
       n.right.type==="ObjectExpression"){
      for(const p of n.right.properties){
        if(p.type!=="Property") continue;
        const k=p.key.name||p.key.value;
        const v=p.value.type==="Identifier"?p.value.name:null;
        if(k&&v) exportsMap.set(k,v);
      }
    }
  });
  model.set(f,{src,ast,imports,exportsMap});
}

function walk(node,parent,fn){
  if(!node||typeof node.type!=="string") return;
  fn(node,parent);
  for(const k of Object.keys(node)){
    if(k==="loc") continue;
    const v=node[k];
    for(const ch of (Array.isArray(v)?v:[v]))
      if(ch&&typeof ch.type==="string") walk(ch,node,fn);
  }
}

/* name of a function node, for local-call resolution */
function fnName(n,parent){
  if(n.type==="FunctionDeclaration"&&n.id) return n.id.name;
  if(parent&&parent.type==="VariableDeclarator"&&parent.id.type==="Identifier") return parent.id.name;
  return null;
}

const asyncFns=new Set();               // "file#localName"
const key=(f,n)=>f.toLowerCase()+"#"+n;

/* is this call a call to something already known async? */
function targetOf(node,m,file){
  const c=node.callee;
  if(c.type==="MemberExpression"&&c.object.type==="Identifier"&&!c.computed){
    const mod=m.imports.get(c.object.name);
    if(!mod) return null;
    if(DB.includes(mod)) return "db";
    const om=model.get([...model.keys()].find(k=>k.toLowerCase()===mod));
    if(om){ const local=om.exportsMap.get(c.property.name);
      if(local&&asyncFns.has(key(mod,local))) return "mod"; }
    return null;
  }
  if(c.type==="Identifier"&&asyncFns.has(key(file,c.name))) return "local";
  return null;
}

let pass=0, changed=true;
const plan=new Map(FILES.map(f=>[f,{awaits:[],asyncs:new Set()}]));
while(changed&&pass<12){
  changed=false; pass++;
  for(const f of FILES){
    const m=model.get(f);
    const stack=[];
    walk(m.ast,null,()=>{});    // no-op; real walk below needs the stack
    (function visit(n,parent){
      if(!n||typeof n.type!=="string") return;
      const pushed=isFn(n); if(pushed) stack.push({n,parent});
      if(n.type==="CallExpression"&&targetOf(n,m,f)){
        const holder=stack[stack.length-1];
        if(holder){
          const nm=fnName(holder.n,holder.parent);
          if(nm&&!asyncFns.has(key(f,nm))){ asyncFns.add(key(f,nm)); changed=true; }
          if(!holder.n.async){ holder.n.async=true; plan.get(f).asyncs.add(holder.n.start); changed=true; }
        }
        /* no enclosing function = top level of a CJS file: an await there is
           a syntax error at require() time. The call is left alone; the file
           has to route it through an async main() itself. */
        if(stack.length&&!n.__awaited&&!(parent&&parent.type==="AwaitExpression")){
          n.__awaited=true;
          const wrap=parent&&parent.type==="MemberExpression"&&parent.object===n;
          plan.get(f).awaits.push({start:n.start,end:n.end,wrap});
          changed=true;
        }
      }
      for(const k of Object.keys(n)){
        if(k==="loc"||k.startsWith("__")) continue;
        const v=n[k];
        for(const ch of (Array.isArray(v)?v:[v]))
          if(ch&&typeof ch.type==="string") visit(ch,n);
      }
      if(pushed) stack.pop();
    })(m.ast,null);
  }
}

/* apply */
let totalA=0,totalW=0;
for(const f of FILES){
  const p=plan.get(f); if(!p.awaits.length&&!p.asyncs.size) continue;
  let src=model.get(f).src;
  const edits=[];
  for(const s of p.asyncs) edits.push({pos:s,text:"async ",kind:"a"});
  for(const w of p.awaits){
    if(w.wrap){ edits.push({pos:w.start,text:"(await ",kind:"w"});
                edits.push({pos:w.end,text:")",kind:"w"}); }
    else edits.push({pos:w.start,text:"await ",kind:"w"});
  }
  edits.sort((a,b)=>b.pos-a.pos||(a.text===")"?-1:1));
  for(const e of edits) src=src.slice(0,e.pos)+e.text+src.slice(e.pos);
  fs.writeFileSync(f,src);
  totalA+=p.asyncs.size; totalW+=p.awaits.length;
  console.log(`${path.relative(process.cwd(),f)}: +${p.asyncs.size} async, +${p.awaits.length} await`);
}
console.log(`\npasses: ${pass} · functions made async: ${totalA} · awaits inserted: ${totalW}`);
