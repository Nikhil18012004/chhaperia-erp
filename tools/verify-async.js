/* Find promises that get dropped: a call to an async function whose result
   is neither awaited, returned, nor explicitly handled. */
const fs=require("fs"), path=require("path");
const acorn=require("../backend/node_modules/acorn");
const FILES=process.argv.slice(2).map(p=>path.resolve(p));
const ARRAY_CB=new Set(["forEach","map","filter","some","every","find","findIndex","sort","reduce","flatMap"]);

/* collect async function names per file, and exported names */
const asyncByFile=new Map(), exportsByFile=new Map();
const parse=(s)=>acorn.parse(s,{ecmaVersion:2022,sourceType:"script"});
const walk=(n,p,f)=>{ if(!n||typeof n.type!=="string")return; f(n,p);
  for(const k of Object.keys(n)){ if(k==="loc")continue; const v=n[k];
    for(const c of (Array.isArray(v)?v:[v])) if(c&&typeof c.type==="string") walk(c,n,f);} };

for(const file of FILES){
  const src=fs.readFileSync(file,"utf8"); const ast=parse(src);
  const a=new Set(), e=new Map();
  walk(ast,null,(n,p)=>{
    if(n.type==="FunctionDeclaration"&&n.async&&n.id) a.add(n.id.name);
    if((n.type==="FunctionExpression"||n.type==="ArrowFunctionExpression")&&n.async&&
       p&&p.type==="VariableDeclarator"&&p.id.type==="Identifier") a.add(p.id.name);
    if(n.type==="AssignmentExpression"&&n.left.type==="MemberExpression"&&
       n.left.object.name==="module"&&n.right.type==="ObjectExpression")
      for(const pr of n.right.properties)
        if(pr.type==="Property"&&pr.value.type==="Identifier") e.set(pr.key.name||pr.key.value,pr.value.name);
  });
  asyncByFile.set(file,a); exportsByFile.set(file,e);
}
const resolveReq=(from,spec)=>{ if(!spec.startsWith("."))return null;
  let p=path.resolve(path.dirname(from),spec); if(!p.endsWith(".js"))p+=".js"; return p; };
const DB=["repository.js","userRepository.js"];

let problems=0;
for(const file of FILES){
  const src=fs.readFileSync(file,"utf8"); const ast=parse(src);
  const imports=new Map();
  walk(ast,null,(n)=>{ if(n.type==="VariableDeclarator"&&n.init&&n.init.type==="CallExpression"&&
      n.init.callee.name==="require"&&n.id.type==="Identifier"){
      const a=n.init.arguments[0]; if(a&&typeof a.value==="string"){
        const r=resolveReq(file,a.value); if(r) imports.set(n.id.name,r);}}});
  const localAsync=asyncByFile.get(file);
  const line=(pos)=>src.slice(0,pos).split("\n").length;

  walk(ast,null,(n,p)=>{
    /* an async function handed to an array method throws its promise away */
    if((n.type==="FunctionExpression"||n.type==="ArrowFunctionExpression")&&n.async&&
       p&&p.type==="CallExpression"&&p.callee.type==="MemberExpression"&&
       ARRAY_CB.has(p.callee.property.name)&&p.arguments.includes(n)){
      console.log(`  ⚠ ${path.basename(file)}:${line(n.start)} async callback passed to .${p.callee.property.name}()`);
      problems++;
    }
    if(n.type!=="CallExpression") return;
    let isAsyncTarget=false;
    const c=n.callee;
    if(c.type==="Identifier"&&localAsync.has(c.name)) isAsyncTarget=true;
    if(c.type==="MemberExpression"&&c.object.type==="Identifier"&&!c.computed){
      const mod=imports.get(c.object.name);
      if(mod){
        if(DB.includes(path.basename(mod))) isAsyncTarget=true;
        else{ const em=exportsByFile.get(mod), am=asyncByFile.get(mod);
          if(em&&am){ const l=em.get(c.property.name); if(l&&am.has(l)) isAsyncTarget=true; } }
      }
    }
    if(!isAsyncTarget) return;
    const handled=p&&(p.type==="AwaitExpression"||p.type==="ReturnStatement"||
      (p.type==="MemberExpression"&&p.object===n)||p.type==="ArrowFunctionExpression");
    if(!handled){
      console.log(`  ✗ ${path.basename(file)}:${line(n.start)} UNAWAITED async call`);
      problems++;
    }
  });
}
console.log(problems? `\n${problems} problem(s) found` : "\nNo dropped promises found.");
