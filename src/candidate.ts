import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {itemKey,identityKey,load} from "./tag-store.mjs";
const runLocal = promisify(execFile);
// Filters only the experimental router's outgoing request. Never executes a
// candidate or changes an existing agent's permissions.
const searchTool = "find_capabilities";
// Reserve these agent IDs for isolated evaluations. For benchmarks using a
// normal agent ID, launch a standalone server with OPENCODE_EVAL_MODE=1.
const isolatedEval=(id:string)=>process.env.OPENCODE_EVAL_MODE==="1" ||
  /^(?:abtest|brief-test|auditprobe|probe)$|(?:^|[-_])eval(?:s|uator)?(?:$|[-_])/i.test(id);
const evalWrite="ai-memory_memory_write_page";
const norm = (v: string) => v.normalize("NFD").replace(/\p{M}/gu,"").toLowerCase();
const segmenter = new Intl.Segmenter(undefined,{granularity:"word"});
const words = (v: string) => Array.from(segmenter.segment(norm(v).replace(/[_-]/g," ")))
  .filter(x=>x.isWordLike && (x.segment.length>1 || /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(x.segment)))
  .map(x=>x.segment);
const common=new Set("the a an of to in on for with from this that it its as is are be by or and at into using use when you your please need want can current".split(" "));
const negativeTerm = String.raw`(?:(?:execut(?:e|ing)|run(?:ning)?)\s+(?:(?:shell|terminal)\s+)?commands?\b|(?:modify|modifying|edit|editing|write|writing|change|changing)\s+files?\b|[\p{L}\p{N}_-]+)`;
const negative = () => new RegExp(String.raw`\b(?:do not|don't|not|no|without|nao|não|sem|sin)\s+(?:(?:to|a|o|the|de)\s+)?${negativeTerm}(?:\s+(?:or|and|ou|e|o|y|nor|nem|ni)\s+${negativeTerm})*`, "giu");
const exclusionSection = () => /\b(?:exclude|exclusions?|omit|avoid)\s*:\s*([\s\S]*?)(?=,\s*(?:then|and\s+then|but|afterwards)\b|[.;!?\n]|$)/giu;
const negativeText=(v:string)=>[...Array.from(v.matchAll(negative()),m=>m[0]),...Array.from(v.matchAll(exclusionSection()),m=>m[1])].join(" ");
const positive = (v:string) => v.replace(exclusionSection()," ").replace(negative()," ");
const actionFlags = (v:string) => {
  const w=words(v);
  const read=w.some(x=>/^(read|reading|view|viewing|inspect|inspecting|show|list|listing|get|fetch|search|find|ler|leia|leitura|leer|leyendo|lectura|consultar|ver|abrir|查看|读取|阅读)$/.test(x));
  const write=w.some(x=>/^(write|writes|writing|edit|edits|editing|patch|modify|modifies|modifying|change|changing|changes|alter|altering|delete|deletes|deleting|deletion|remove|removes|removing|create|creates|creating|creation|append|appends|appending|design|designing|produce|producing|draw|generate|generating|move|moves|moving|rename|renames|renaming|copy|copies|copying|overwrite|overwrites|overwriting|truncate|truncates|truncating|relocate|mutate|mutation|destructive|escrever|editar|editando|alterar|gravar|corrigir|criar|excluir|eliminar|eliminando|borrar|mover|renomear|写入|修改|编辑|删除)$/.test(x));
  return {read,write};
};
const action = (v:string) => {
  const {read,write}=actionFlags(positive(v));
  return read&&!write?"read":write&&!read?"write":"";
};
const scopeHeads=new Set("tenant account project workspace organization organisation team customer environment cluster repository repo instance".split(" "));
const scopeStop=new Set("all any each every without with not no only where from in of the scope scopes status details detail history data information info files file summary overview report records record".split(" "));
const typedScopes=(tokens:string[])=>{
  const result:{type:string,value:string}[]=[];
  for(let i=0;i<tokens.length;i++)if(scopeHeads.has(tokens[i])){
    const type=tokens[i];
    let j=i+1;
    while(j<tokens.length&&!scopeStop.has(tokens[j])&&!common.has(tokens[j])&&!action(tokens[j])&&!scopeHeads.has(tokens[j])){
      result.push({type,value:tokens[j++]});
      if(tokens[j]!=="and"&&tokens[j]!=="or")break;
      j++;
    }
  }
  return result;
};
const qualifiers=(tokens:string[])=>typedScopes(tokens).map(x=>x.value);
const aliases = {
  read:"read file open inspect log logs", patch:"edit fix change write file", shell:"run test execute command terminal python",
  grep:"search content find occurrences", glob:"find files list paths",
};
type Item = {kind:string,id:string,description:string};
type SearchMemo = {signature:string,selected:Item[]};
type Turn = {agent:string,items:Item[],indexedAt:number,tools:Set<string>,fingerprint:string,marker:string|null,lastSearch?:SearchMemo};
const selectionKey=(i:Item)=>`${i.kind}:${i.id}`;
type Concepts = {action:string[],object:string[],scope:string[],effects:string[],aliases:string[]};
const conceptLists=["action","object","scope","effects","aliases"] as const;
const canonical=(s:string)=>norm(s).trim().replace(/\s+/g," ");
const stem=(s:string)=>s.length>4?s.replace(/ies$/,"y").replace(/s$/,""):s;
const conceptWords=(s:string)=>words(s).map(stem).filter(w=>!common.has(w));
const operation=(s:string)=>words(s).flatMap(w=>
  /^(read|reading|inspect|inspecting|view|viewing|list|listing|get|fetch|search|find)$/.test(w)?["read"]:
  /^(create|creates|creating|creation|design|designing|produce|producing|draw|generate|generating)$/.test(w)?["create"]:
  /^(append|appends|appending)$/.test(w)?["append"]:
  /^(overwrite|overwrites|overwriting)$/.test(w)?["overwrite"]:
  /^(truncate|truncates|truncating)$/.test(w)?["truncate"]:
  /^(edit|edits|editing|modify|modifies|modifying|modification|modifications|update|updating|change|changes|changing|write|writes|writing|patch|mutate|mutation)$/.test(w)?["update"]:
  /^(delete|deletes|deleting|deletion|remove|removes|removing|destructive)$/.test(w)?["delete"]:
  /^(move|moves|moving|rename|renames|renaming|relocate)$/.test(w)?["move"]:
  /^(copy|copies|copying)$/.test(w)?["copy"]:[]);
const sectionSupports=(query:string,c:Concepts)=>{
  const action=new Set(c.action.flatMap(operation)),object=new Set([...c.object,...c.aliases].flatMap(conceptWords).filter(w=>!operation(w).length));
  return positive(query).split(/\b(?:and|then|also)\b|[;.!?]/i).some(part=>
    (operation(part).some(a=>action.has(a))||action.has("create")&&operation(positive(query)).includes("create")&&/\b(?:perform|performing|undertake)\b/i.test(part))&&
    conceptWords(part).some(w=>!operation(w).length&&object.has(w)));
};
const validList=(x:unknown):x is string[]=>Array.isArray(x)&&x.length<=32&&x.every(v=>typeof v==="string"&&v.length>0&&v.length<=100&&!/[\x00-\x1f\x7f-\x9f]/.test(v));
function normalizedConcepts(raw:unknown):Map<string,Concepts>{
  const result=new Map<string,Concepts>();
  if(!(raw instanceof Map))return result;
  for(const [key,value] of raw){
    if(typeof key!=="string"||!value||!conceptLists.every(k=>validList(value[k])))continue;
    result.set(key,Object.fromEntries(conceptLists.map(k=>[k,value[k].map(canonical)])) as Concepts);
  }
  return result;
}
function postingHits(items:Item[],concepts:Map<string,Concepts>,intent:{action:string[],object:string[]}):Set<string>{
  const postings=(fields:("action"|"object"|"aliases")[])=>{
    const out=new Map<string,Set<string>>();
    for(const i of items){const key=i.kind+":"+i.id,c=concepts.get(key);if(!c)continue;
      for(const field of fields)for(const term of c[field])for(const token of fields.includes("action")?[canonical(term)]:conceptWords(term)){if(!out.has(token))out.set(token,new Set());out.get(token)!.add(key)}
    }
    return out;
  };
  const actions=postings(["action"]),objects=postings(["object","aliases"]);
  const a=new Set(intent.action.flatMap(x=>[...(actions.get(x)??[])]));
  const o=new Set(intent.object.flatMap(x=>conceptWords(x).flatMap(w=>[...(objects.get(w)??[])])));
  return new Set([...a].filter(x=>o.has(x)));
}
type Objective={action:string,object:string};
const validObjectives=(x:unknown):x is Objective[]=>Array.isArray(x)&&x.length<=32&&x.every(v=>v&&typeof v==="object"&&validList([v.action,v.object]));
const boundSupports=(objectives:Objective[],c:Concepts)=>objectives.some(o=>
  c.action.includes(canonical(o.action))&&conceptWords(o.object).some(w=>[...c.object,...c.aliases].flatMap(conceptWords).includes(w)));
export default {
  id:"capability-router",
  async setup(ctx) {
    await ctx.agent.transform(editor=>{
      if(editor.get("indexer")!==undefined)return;
      editor.update("indexer",agent=>{
        agent.mode="subagent";
        agent.hidden=true;
        agent.permissions=[{action:"*",resource:"*",effect:"deny"}];
      });
    });
    const turns = new Map<string,Turn>();
    // Session selections outlive prompt changes, compaction and catalog eviction.
    const selections = new Map<string,Set<string>>();
    function remember(sessionID:string,items:Item[]){
      if(!items.length)return;
      let selected=selections.get(sessionID);
      if(!selected)selections.set(sessionID,selected=new Set());
      for(const item of items)selected.add(selectionKey(item));
    }
    const adapter=import("./semantic-indexer.ts").catch(()=>null);
    async function userMarker(sessionID:string):Promise<string|null>{
      try{
        if(typeof ctx.session.context!=="function")return null;
        const entries=await ctx.session.context({sessionID});
        if(!Array.isArray(entries))return null;
        const users=entries.filter(e=>e?.type==="user");
        if(!users.length||users.some(e=>typeof e.id!=="string"||!e.id||!Number.isFinite(e.time?.created)))return null;
        return users[users.length-1].id;
      }catch{return null}
    }
    await ctx.session.hook("prompt",e=>{
      const t=turns.get(e.sessionID);
      if(t)t.lastSearch=undefined;
    });
    await ctx.permission.hook("evaluate",e=>{
      if(isolatedEval(String(e.agent??"")) && String(e.action).startsWith("ai-memory_") && e.action!==evalWrite)e.effect="deny";
    });
    // Root = 0; five generations of child sessions. Cache only proven ancestry.
    const maxDepth=5, depths=new Map<string,number>();
    async function depth(id:string):Promise<number|null>{
      const chain:string[]=[];
      try{
        while(!depths.has(id)){
          if(chain.includes(id)||chain.length>64)return null;
          const res=await ctx.session.get({sessionID:id}), s=res.data??res;
          if(s.id!==id)return null;
          if(!s.parentID){depths.set(id,0);break}
          chain.push(id);id=s.parentID;
        }
        let n=depths.get(id)!;
        for(const child of chain.reverse())depths.set(child,++n);
        if(depths.size>1024)depths.clear();
        return n;
      }catch{return null}
    }
    await ctx.tool.hook("execute.before",async e=>{
      if(e.tool!=="subagent"||e.input?.sessionID)return; // continuation creates no child
      const d=await depth(e.sessionID);
      if(d===null||d>=maxDepth)throw Error(d===null?"Session ancestry cannot be verified.":"Subagent depth limit of 5 reached.");
    });
    await ctx.tool.transform(ed=>ed.add({
      name:searchTool, options:{codemode:false},
       description:"Discover missing tools or skills without executing them. Write a concise English query with the requested action, object, exact paths, scope and explicit exclusions. Include structured intent when scope or exclusions affect the selection, or when actions must be paired with different objects. For simple lookups, query alone is enough. Leave exact IDs and diagnostic keywords unchanged. Host permissions apply.",
       input:{type:"object",properties:{query:{type:"string",minLength:1,maxLength:240,description:"Task in English with relevant scope, paths and explicit negatives, or an unchanged exact ID or diagnostic keyword."},intent:{type:"object",description:"For constrained or multi-objective discovery, include objectives plus any explicit scope and exclusions. Extract from the request; do not invent details.",properties:{...Object.fromEntries(Object.entries({action:"Requested actions.",object:"Objects of the requested actions.",scope:"Explicit boundaries, such as project names or exact paths; put 'only this file' here.",exclude:"Explicitly forbidden actions, such as execute terminal commands or modify files. Do not restate the requested action as an exclusion; encode object limits in scope."}).map(([key,description])=>[key,{type:"array",maxItems:32,items:{type:"string",minLength:1,maxLength:100},description}])),objectives:{type:"array",maxItems:32,description:"Bind each requested action to its specific object, keeping exact paths.",items:{type:"object",properties:{action:{type:"string",minLength:1,maxLength:100},object:{type:"string",minLength:1,maxLength:100}},required:["action","object"],additionalProperties:false}}},additionalProperties:false},kind:{type:"string",enum:["tool","mcp","skill","command","agent"],description:"Restrict results to one kind. If both a tool and a skill are needed and missing, omit kind and search once for both. Otherwise, specify the missing kind when known."}},required:["query"],additionalProperties:false},
      execute:async ({query,kind,intent},call)=>{
        const t=turns.get(call.sessionID);
        if(!t||call.agent!==t.agent)return {content:"Discovery is unavailable for this turn."};
        const key=norm(query.trim());
        const profile=process.env.OPENCODE_TAG_PROFILE??"default", project=ctx.location?.directory??"";
        if(["runtime-gate","compaction","compact","task","subagent","delegation"].includes(key)){
          t.lastSearch=undefined;
          const gate=key==="runtime-gate", info={};
          if(gate||["compaction","compact"].includes(key)){
            let auto:boolean|undefined;
            try{
              const res=await ctx.config.get();
              const docs=Array.isArray(res)?res:res.data;
              const values=docs.map(d=>d.info?.compaction?.auto).filter(v=>typeof v==="boolean");
              if(values.length && values.every(v=>v===values[0]))auto=values[0];
            }catch{/* No reliable evidence about effective automatic settings. */}
            let source="plugin config API";
            if(auto===undefined){
              try{
                // Only trust the CLI's server if it knows this exact session.
                // Commands are constants; no prompt text is evaluated by the shell.
                if(!/^ses_[a-zA-Z0-9]+$/.test(call.sessionID))throw Error("invalid session");
                const cli=process.platform==="win32"?"opencode.cmd":"opencode";
                const opts={cwd:ctx.location.directory,timeout:12000,maxBuffer:4*1024*1024,shell:process.platform==="win32"};
                const session=JSON.parse((await runLocal(cli,["api","get","/api/session/"+call.sessionID],opts)).stdout);
                if((session.data??session).id!==call.sessionID)throw Error("different server");
                const response=JSON.parse((await runLocal(cli,["api","get","/api/config"],opts)).stdout);
                const docs=response.data??response;
                const flags=docs.map(d=>d.info?.compaction?.auto).filter(v=>typeof v==="boolean");
                if(flags.length && flags.every(v=>v===flags[0])){auto=flags[0];source="OpenCode config API via CLI, session verified";}
              }catch{/* Keep the unknown state on mismatched or unreachable servers. */}
            }
            info.compaction={status:typeof ctx.session.compact==="function"?"available":"not_verifiable",mechanism:"session API, not a tool",autoConfigured:auto??"not_verifiable",source:auto===undefined?null:source,executed:false};
          }
          if(gate||!["compaction","compact"].includes(key)){
            const targets=t.items.filter(i=>i.kind==="agent");
            const d=await depth(call.sessionID);
            info.delegation={status:t.tools.has("subagent")&&targets.length?"available":"unavailable",tool:"subagent",examples:targets.map(i=>i.id),note:"Per-target permissions are enforced on invocation. Use kind=agent with the destination ID."};
            Object.assign(info.delegation,{depth:d,maxDepth,newChildAllowed:d===null?false:d<maxDepth&&info.delegation.status==="available"});
            if(info.delegation.status==="available")remember(call.sessionID,[{kind:"tool",id:"subagent",description:"Delegate"}]);
          }
          if(gate)for(const [name,ids] of Object.entries({read:["read"],grep:["grep"],edit:["edit","patch","write"],skill:["skill"]})){
            const id=ids.find(id=>t.tools.has(id));info[name]={status:id?"available":"unavailable",tool:id??null};
          }
          return {content:JSON.stringify(info)};
        }
        const exact=t.items.find(i=>(!kind||i.kind===kind)&&norm(i.id)===key);
        if(exact){
          t.lastSearch=undefined;
          if(exact.kind!=="command")remember(call.sessionID,[exact]);
          return {content:JSON.stringify([{kind:exact.kind,id:exact.id,...(exact.kind==="command"?{use:"/"+exact.id}:{})}])};
        }
        const terms=[...new Set(words(positive(query)))];
        const excluded=actionFlags(negativeText(query));
        const negativeTerms=words(negativeText(query));
        const requested=actionFlags(positive(query));
        const objects=terms.filter(w=>!common.has(w)&&!action(w)).flatMap(w=>w.endsWith(".log")?[w,"log"]:w.endsWith(".txt")?[w,"file"]:[w]);
        const structured=intent&&typeof intent==="object"&&["action","object","scope","exclude"].every(k=>intent[k]===undefined||validList(intent[k]))&&(intent.objectives===undefined||validObjectives(intent.objectives))?intent:{};
        const restrictionTerms=[...negativeTerms,...(structured.exclude??[]).flatMap(words)];
        const excludesExecution=restrictionTerms.some(w=>/^(execute|execution|executing|shell|terminal|command|commands)$/.test(w));
        const forbiddenOperations=new Set(operation(restrictionTerms.join(" ")));
        const requestedOperations=new Set(operation(positive(query)));
        const rawActions=words(positive(query));
        const inferredActions=[...(requested.read?["read"]:[]),...rawActions.filter(w=>/^(create|design|produce|draw|generate|creating|designing|generating)$/.test(w)).map(()=>"create")];
        const objectives:Objective[]=structured.objectives??[];
        const semanticIntent={action:[...(structured.action??inferredActions),...objectives.map(x=>x.action)].map(canonical),object:[...(structured.object??objects),...objectives.map(x=>x.object)].map(canonical)};
        const requestedScopes=[...qualifiers(words(positive(query))),...(structured.scope??[]).flatMap(s=>{const w=words(s);const q=qualifiers(w);return q.length?q:w})];
        const requestedTyped=[...typedScopes(words(positive(query))),...(structured.scope??[]).flatMap(s=>typedScopes(words(s)))];
        const ranges=Array.from(norm(positive(query)).matchAll(/\b([a-z]+)[-_](\d+)\s+(?:through|to|until)\s+([a-z]+)[-_](\d+)\b/g))
          .filter(m=>m[1]===m[3]&&scopeHeads.has(m[1])).map(m=>({type:m[1],start:BigInt(m[2]),end:BigInt(m[4])}));
        const readOnly=!requested.write&&(requested.read||excluded.write);
        const tags=project?await load(profile,project):{};
        let concepts=new Map<string,Concepts>();
        try{const m=await adapter;if(m)concepts=normalizedConcepts(await m.loadConcepts(ctx))}catch{/* Fall back to lexical discovery. */}
        const semantic=postingHits(t.items,concepts,semanticIntent);
        const candidates=t.items.filter(i=>!kind||i.kind===kind).map(i=>{
          const id=words(i.id.replace(/([a-z0-9])([A-Z])/g,"$1 $2")),alias=words(aliases[i.id]??""),desc=words(i.description),entry=tags[identityKey(i)];
          const tagWords=words((entry?.version===itemKey(i)?entry.tags:[]).join(" "));
          const matched=objects.filter(w=>id.includes(w)||alias.includes(w)||desc.includes(w)||tagWords.includes(w));
          const description=positive(i.description);
          const primaryDescription=description.match(/^\s*(?:(?:this\s+)?(?:tool|function)\s+(?:can|will|to|for)\s+)?[\p{L}]+/iu)?.[0]??"";
          const concept=concepts.get(i.kind+":"+i.id);
          const semanticEffects=concept?[...concept.action,...concept.effects].join(" "):"";
          const candidateFlags=[id.join(" "),aliases[i.id]??"",tagWords.join(" "),semanticEffects].map(v=>actionFlags(positive(v)));
          const descFlags=actionFlags(description),primaryFlags=actionFlags(primaryDescription);
          candidateFlags.push({read:descFlags.read,write:primaryFlags.write});
          const candidateWords=words([id.join(" "),aliases[i.id]??"",tagWords.join(" "),semanticEffects,primaryDescription].join(" "));
          const proceduralCreate=i.kind==="skill"&&!!concept&&concept.action.some(x=>operation(x).includes("create"))&&
            requestedOperations.has("create")&&(sectionSupports(query,concept)||boundSupports(objectives,concept))&&
            !/\b(?:write|writes|writing|append|appends|appending|overwrite|overwrites|delete|deletes|remove|removes)\s+(?:(?:the|a|an|existing|new)\s+)?(?:files?|directories|data)\b/i.test(description)&&
            ![id.join(" "),aliases[i.id]??"",tagWords.join(" "),primaryDescription,...concept.effects].some(s=>
              operation(positive(s)).some(op=>op!=="read"&&op!=="create")||/\b(?:shell|exec(?:ute)?|run|command)\b/i.test(s))&&
            !concept.effects.some(s=>operation(positive(s)).includes("create"));
          const broadExclusion=restrictionTerms.some(w=>/^(write|writing|edit|editing|modify|modifying|modification|modifications|change|changes|changing|mutate|mutation|escrever|editar|alterar|gravar)$/.test(w));
          const destructiveExclusion=restrictionTerms.some(w=>/^(delete|deleting|deletion|remove|removing|excluir|eliminar|borrar)$/.test(w));
          const moveExclusion=restrictionTerms.some(w=>/^(move|moving|rename|renaming|mover|renomear)$/.test(w));
          const candidateOperations=operation(candidateWords.join(" "));
          const forbidden=candidateFlags.some(f=>excluded.read&&f.read||broadExclusion&&f.write&&!proceduralCreate)||
            destructiveExclusion&&candidateWords.some(w=>/^(delete|deleting|deletion|remove|removing|destructive|excluir|eliminar|borrar)$/.test(w))||
            moveExclusion&&candidateWords.some(w=>/^(move|moving|rename|renaming|mover|renomear)$/.test(w))||
            candidateOperations.some(op=>forbiddenOperations.has(op));
          const aligned=candidateFlags.some(f=>requested.read&&f.read||requested.write&&f.write);
          const score=matched.reduce((s,w)=>s+(id.includes(w)?6:alias.includes(w)?4:tagWords.includes(w)?3:1),0)+(aligned?3:0);
          const linked=!!concept&&(sectionSupports(query,concept)||boundSupports(objectives,concept));
          const semanticMatch=semantic.has(i.kind+":"+i.id)&&
            (new Set(semanticIntent.action).size<2||new Set(semanticIntent.object).size<2||linked);
          const evidence=semanticMatch||matched.length>0&&(aligned||matched.length>1);
          const unrequestedWrite=!requested.write&&candidateFlags.some(f=>f.write);
          const impliedCreate=requestedOperations.has("append")&&concept?.action.some(x=>operation(x).includes("append"))&&
            concept.effects.some(x=>/\bcreat(?:e|es|ing)\b.*\bif\s+(?:missing|absent|not\s+exist)/i.test(x))&&!forbiddenOperations.has("create");
          const unrequestedEffect=candidateOperations.some(op=>{
            if(op==="read"||op==="create"&&impliedCreate)return false;
            if(!requestedOperations.has(op))return true;
            const effectConcept:Concepts={action:[op],object:concept?.object??[i.description],scope:[],effects:[],aliases:concept?.aliases??[]};
            return !sectionSupports(query,effectConcept)&&!boundSupports(objectives,effectConcept);
          });
          const executor=[...id,...words(semanticEffects)].some(w=>/^(shell|bash|powershell|terminal|cmd|exec|execute|run|command|python|javascript|node|eval)$/.test(w))||
            /^(?:(?:this\s+)?(?:tool|function)\s+(?:can|will|to|for)\s+)?(?:execute|executes|run|runs|evaluate|evaluates)\b/i.test(primaryDescription.trim());
          const knownTyped=[...typedScopes(words(description)),...(concept?.scope??[]).flatMap(s=>typedScopes(words(s)))];
          const knownScopes=knownTyped.map(s=>s.type+":"+s.value);
          const matchesScope=knownTyped.some(s=>requestedTyped.some(r=>r.type===s.type&&r.value===s.value)||/^\d+$/.test(s.value)&&ranges.some(r=>r.type===s.type&&BigInt(s.value)>=r.start&&BigInt(s.value)<=r.end));
          const scopeState=requestedTyped.length&&knownTyped.length?(matchesScope?"compatible":"incompatible"):"unknown";
          const excludedConcepts=(structured.exclude??[]).map(canonical);
          const excludedEffect=concept?.effects.some(x=>excludedConcepts.includes(x))??false;
          const misbound=!!concept&&new Set(semanticIntent.action).size>1&&new Set(semanticIntent.object).size>1&&
            concept.action.some(x=>operation(x).length>0)&&!linked;
          const rawAction=operation(id.join(" ")+" "+primaryDescription);
          const lexicalMisbound=!concept&&new Set(operation(positive(query))).size>1&&rawAction.length>0&&
            !sectionSupports(query,{action:rawAction,object:[i.description],scope:[],effects:[],aliases:[]});
          const lexicalCore=matched.some(w=>!scopeHeads.has(w)&&!requestedScopes.includes(w)&&!common.has(w));
          return {i,concept,knownScopes,semanticMatch,lexicalCore,score:forbidden||excludedEffect||unrequestedWrite||unrequestedEffect||(readOnly||excludesExecution)&&executor||scopeState==="incompatible"||misbound||lexicalMisbound||!evidence ? 0 : score+(semanticMatch&&!lexicalCore?4:0)};
        });
        const ranked=candidates.filter(x=>x.score>0).sort((a,b)=>Number(b.lexicalCore)-Number(a.lexicalCore)||b.score-a.score||a.i.id.localeCompare(b.i.id));
        const signature=JSON.stringify([canonical(query),kind??null,structured]);
        const previous=t.lastSearch;
        const requestedActionSet=[...requestedOperations];
        const inferredObjects=words(positive(query)).filter(w=>!common.has(w)&&!scopeHeads.has(w)&&!requestedScopes.includes(w)&&!operation(w).length&&!/^(only|just|each|every|both)$/.test(w));
        const goals:Objective[]=objectives.length?objectives:
          structured.action?.length===1&&structured.object?.length===1?[{action:structured.action[0],object:structured.object[0]}]:
          !structured.action&&!structured.object&&requestedActionSet.length===1&&inferredObjects.length?[{action:requestedActionSet[0],object:inferredObjects.join(" ")}]:[];
        const declared=new Set([...(structured.action??[]),...(structured.object??[]),...(structured.scope??[]),...goals.flatMap(x=>[x.action,x.object])].flatMap(words));
        const fullyDescribed=words(positive(query)).every(w=>common.has(w)||scopeHeads.has(w)||scopeStop.has(w)&&/^(only|just|each|every|both)$/.test(w)||requestedScopes.includes(w)||declared.has(w)||operation(w).length>0);
        const prior=previous?.selected.map(i=>ranked.find(x=>x.i.kind===i.kind&&x.i.id===i.id&&x.i.description===i.description));
        const reusable=!!t.marker&&previous?.signature===signature&&!!prior?.length&&prior.every(Boolean)&&
          !ranges.length&&!/\b(?:alternatives?|another|different|more|expand|others?|additional)\b/i.test(query)&&
          !!goals.length&&fullyDescribed&&(!(structured.scope??[]).length||requestedTyped.length>0)&&
          goals.every(goal=>{
            const covered=(scope?:{type:string,value:string})=>prior!.some(x=>{
              const c=x?.concept;if(!c||!c.action.includes(canonical(goal.action)))return false;
              const required=conceptWords(goal.object),available=new Set(c.object.flatMap(conceptWords));
              if(!required.length||!required.every(w=>available.has(w)))return false;
              return !scope||c.scope.flatMap(s=>typedScopes(words(s))).some(s=>s.type===scope.type&&s.value===scope.value);
            });
            return requestedTyped.length?requestedTyped.every(covered):covered();
          });
        if(reusable){
          const chosen=prior!.map(x=>x!.i);
          return {content:JSON.stringify({suggestions:chosen.map(i=>({kind:i.kind,id:i.id})),note:"Tools and skills selected; other entries require explicit use."})};
        }
        const seen=new Set<string>();
        const selected:typeof ranked=[];
        const singleProvider=/\b(?:one|single)\s+(?:provider|tool|service)\s+(?:for|per|in)\s+(?:each\s+)?/i.test(query);
        for(const x of ranked){
          const key=JSON.stringify([x.i.kind,x.i.id]);if(seen.has(key))continue;seen.add(key);
          const duplicate=x.semanticMatch&&x.concept&&x.knownScopes.length&&selected.some(y=>{
            if(y.i.kind!==x.i.kind||!y.concept||!y.knownScopes.some(s=>x.knownScopes.includes(s)))return false;
            const sharedAction=x.concept!.action.some(a=>y.concept!.action.includes(a)&&semanticIntent.action.includes(a));
            const xWords=new Set([...x.concept!.object,...x.concept!.aliases].flatMap(conceptWords));
            const sharedObject=[...y.concept!.object,...y.concept!.aliases].flatMap(conceptWords).some(w=>xWords.has(w));
            return sharedAction&&sharedObject&&singleProvider;
          });
          if(!duplicate)selected.push(x);
        }
        const chosen=selected.map(x=>x.i);
        const activatable=chosen.filter(i=>["tool","mcp","skill"].includes(i.kind));
        remember(call.sessionID,activatable);
        t.lastSearch=t.marker&&activatable.length===chosen.length?{signature,selected:activatable}:undefined;
        const suggestions=chosen.map(i=>({kind:i.kind,id:i.id,...(i.kind==="command"?{use:"/"+i.id}:{})}));
        return {content:JSON.stringify({suggestions,note:suggestions.length?"Tools and skills selected; other entries require explicit use.":"No sufficient evidence among exposed capabilities."})};
      }
    }));
    await ctx.session.hook("context",async e=>{
      if(e.agent==="indexer")return;
      if(isolatedEval(e.agent)){
        for(const id of Object.keys(e.tools))if(id.startsWith("ai-memory_")&&id!==evalWrite)delete e.tools[id];
        for(const part of e.system)if(typeof part.text==="string")
          part.text=part.text.replace(/<server name="ai-memory"[^>]*>[\s\S]*?<\/server>/g,"");
      }
      const primary=(await depth(e.sessionID))===0;
      const discovery=!primary || e.agent==="router" || e.agent==="orchestrator";
      // A read-only specialist may deny plugin tools. Never add a denied tool
      // or remove its original capabilities when discovery is unavailable.
      if(!e.tools[searchTool])return;
      let t=turns.get(e.sessionID);
      const marker=await userMarker(e.sessionID);
      if(t && (t.agent!==e.agent || marker!==null && marker!==t.marker))t.lastSearch=undefined;
      const sources=e.system.flatMap(p=>p.metadata?.experimental?.instructions??[]);
      const block=(key:string)=>sources.find(x=>x.key===key)?.text??"";
      const serverNames=Array.from(block("core/mcp-guidance").matchAll(/<server name="([^"]+)"/g),m=>m[1]);
      const isMcp=(id:string)=>serverNames.some(n=>id.startsWith(n+"_"))||id.includes("_")&&!["ast_grep_replace","ast_grep_search","experimental_image_generate"].includes(id);
      const skillResult=e.tools.skill?await ctx.skill.list():[];
      const skills=Array.isArray(skillResult)?skillResult:skillResult.data;
      const fingerprint=JSON.stringify([Object.entries(e.tools).map(([id,v])=>[id,v.description??""]).sort((a,b)=>a[0].localeCompare(b[0])),serverNames,skills.map(x=>[x.id,x.description??""])]);
      if(!t||t.agent!==e.agent||t.fingerprint!==fingerprint||Date.now()-t.indexedAt>300000){
        const [agents,commands]=(await Promise.all([ctx.agent.list(),ctx.command.list()])).map(result=>Array.isArray(result)?result:result.data);
        const toolItems=Object.entries(e.tools).filter(([id])=>![searchTool,"skill","subagent"].includes(id)).map(([id,v])=>({kind:isMcp(id)?"mcp":"tool",id,description:v.description??""}));
        const items=[...toolItems,...(e.tools.skill?skills:[]).map(x=>({kind:"skill",id:x.id,description:x.description??""})),...(e.tools.subagent?agents:[]).filter(x=>x.mode!=="primary"&&!x.hidden).map(x=>({kind:"agent",id:x.id,description:x.description??""})),...commands.map(x=>({kind:"command",id:x.name,description:x.description??""}))];
        const lastSearch=t?.agent===e.agent&&t.lastSearch?.selected.every(s=>items.some(i=>i.kind===s.kind&&i.id===s.id&&i.description===s.description))?t.lastSearch:undefined;
        t={agent:e.agent,items,indexedAt:Date.now(),tools:new Set(Object.keys(e.tools)),fingerprint,marker:t?.agent===e.agent?t.marker:null,lastSearch};
        turns.delete(e.sessionID);turns.set(e.sessionID,t);if(turns.size>64)turns.delete(turns.keys().next().value);
        const exposed=items.filter(i=>["tool","mcp","skill"].includes(i.kind));
        void adapter.then(m=>m?.syncSemanticIndex(ctx,exposed,e.model)).catch(()=>{});
      }
      if(!discovery){delete e.tools[searchTool];return}
      e.system.push({type:"text",text:"Use visible tools and loaded skill instructions directly; search only for missing capabilities. In find_capabilities, describe the task in English in query, retaining exact paths and explicit exclusions. When a tool or skill search has an explicit scope, exclusions, or multiple action-object pairs, also send intent.objectives (the requested action and its object), intent.scope (if given), and intent.exclude (if given). Put 'only this file' in scope, not in exclude as 'read other files'. Example: query: 'Read only logs/service.log without executing commands or modifying files'; intent: {objectives:[{action:'read',object:'logs/service.log'}],scope:['logs/service.log'],exclude:['execute commands','modify files']}. For a natural-language search, include one short detail of the situation only if it changes which tool or skill is appropriate (for example: log source, runtime, or failure stage). Leave out unrelated history, raw logs and secrets. For simple lookups, query alone is enough; pass exact IDs and diagnostic keywords unchanged. Preserve role and permissions."});
      // Compaction can hide the user message without starting a new prompt.
      if(marker!==null)t.marker=marker;
      t.tools=new Set(Object.keys(e.tools));
      const selected=selections.get(e.sessionID);
      const active=t.items.filter(i=>selected?.has(selectionKey(i)));
      const memoryTools=primary||isolatedEval(e.agent)?Object.keys(e.tools).filter(id=>id.startsWith("ai-memory_")):[];
      const keep=new Set([searchTool,...memoryTools,...active.map(i=>i.kind==="agent"?"subagent":i.kind==="skill"?"skill":i.id)]);
      if(selected?.has("tool:subagent")&&t.items.some(i=>i.kind==="agent"))keep.add("subagent");
      for(const id of Object.keys(e.tools)){if(!keep.has(id))delete e.tools[id];}
      // Expose only selected metadata, never other server capabilities.
      for(const part of e.system){
        if(typeof part.text!=="string")continue;
        for(const key of ["core/skill-guidance","core/mcp-guidance"]){
          const original=block(key);if(!original)continue;
          const replacement=key==="core/skill-guidance"?active.filter(i=>i.kind==="skill").map(i=>`Skill available: ${i.id}: ${i.description.slice(0,180)}`).join("\n"):
            active.filter(i=>i.kind==="mcp").map(i=>`MCP tool available: ${i.id}: ${i.description.slice(0,180)}`).join("\n");
          part.text=part.text.replace(original,()=>replacement);
        }
      }
    });
  }
};
