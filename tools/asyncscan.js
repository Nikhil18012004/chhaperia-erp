/* Analysis only — reports what an async conversion must touch. No edits. */
const fs=require("fs"), path=require("path");
const acorn=require("../backend/node_modules/acorn");
const walk=require("../backend/node_modules/acorn-walk");

const ARRAY_CB=new Set(["forEach","map","filter","some","every","find","findIndex","sort","reduce","flatMap"]);

function analyse(file){
  const src=fs.readFileSync(file,"utf8");
  const ast=acorn.parse(src,{ecmaVersion:2022,sourceType:"script",locations:true});
  /* which local identifiers are the DB modules? */
  const dbMods=new Set();
  walk.simple(ast,{VariableDeclarator(n){
    if(n.init&&n.init.type==="CallExpression"&&n.init.callee.name==="require"){
      const a=n.init.arguments[0];
      if(a&&typeof a.value==="string"&&/repository|userRepository/.test(a.value)&&n.id.type==="Identifier")
        dbMods.add(n.id.name);
    }
  }});

  /* stack-aware walk so we know the enclosing function of every call */
  const fnStack=[]; const hits=[]; const cbHits=[];
  const isFn=(n)=>/Function/.test(n.type);
  (function visit(node,parent,cbCtx){
    if(!node||typeof node.type!=="string") return;
    if(isFn(node)) fnStack.push({node,cbCtx});
    if(node.type==="CallExpression"){
      const c=node.callee;
      if(c.type==="MemberExpression"&&c.object.type==="Identifier"&&dbMods.has(c.object.name)){
        const top=fnStack[fnStack.length-1];
        hits.push({line:node.loc.start.line,call:c.object.name+"."+(c.property.name||"?")});
        if(top&&top.cbCtx) cbHits.push({line:node.loc.start.line,
          call:c.object.name+"."+(c.property.name||"?"),cb:top.cbCtx});
      }
    }
    for(const k of Object.keys(node)){
      if(k==="loc"||k==="parent") continue;
      const v=node[k];
      const kids=Array.isArray(v)?v:[v];
      for(const ch of kids){
        if(ch&&typeof ch.type==="string"){
          /* is this child a callback handed to an array method? */
          let ctx=null;
          if(node.type==="CallExpression"&&node.callee.type==="MemberExpression"&&
             ARRAY_CB.has(node.callee.property.name)&&node.arguments.includes(ch)&&isFn(ch))
            ctx=node.callee.property.name;
          visit(ch,node,ctx);
        }
      }
    }
    if(isFn(node)) fnStack.pop();
  })(ast,null,null);

  return {file:path.relative(process.cwd(),file),total:hits.length,cbHits};
}

const files=process.argv.slice(2);
let grand=0, risky=0;
for(const f of files){
  const r=analyse(f);
  grand+=r.total; risky+=r.cbHits.length;
  console.log(`${r.file}: ${r.total} db calls, ${r.cbHits.length} inside array callbacks`);
  for(const h of r.cbHits) console.log(`    ⚠ line ${h.line}: ${h.call} inside .${h.cb}()`);
}
console.log(`\nTOTAL: ${grand} db calls, ${risky} in array-callback position (must become for…of)`);
