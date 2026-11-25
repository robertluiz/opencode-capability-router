import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {syncSemanticIndex,loadConcepts} from './semantic-indexer.ts';
const root=await mkdtemp(path.join(os.tmpdir(),'router-model-'));
process.env.XDG_DATA_HOME=root;
const saved={...process.env};
const deny=[{action:'*',resource:'*',effect:'deny'}];
let count=0;
async function check(name,model,env,expected,permissions=deny,agentModel){
  for(const k of ['OPENCODE_SEMANTIC_INDEX_ENABLED','OPENCODE_SEMANTIC_INDEX_MODEL','OPENCODE_SEMANTIC_INDEX_TEST']) delete process.env[k];
  Object.assign(process.env,env);
  let created,batch; const hooks={};
  const item={kind:'tool',id:'alpha',description:'Example description'};
  const ctx={location:{directory:'test-'+ ++count},tool:{list:async()=>[{name:'alpha',description:item.description}]},skill:{list:async()=>[]},agent:{list:async()=>[{id:'indexer',mode:'subagent',permissions,model:agentModel}]},session:{
    hook:async(name,f)=>{hooks[name]=f},create:async x=>{created=x;return {id:'index',agent:'indexer'}},prompt:async x=>{
      const request=model=>hooks['model.request']({agent:'indexer',sessionID:'index',model});
      const chosen=created.model;
      request({...chosen,variant:chosen.variant??'default'});
      assert.throws(()=>request({...chosen,providerID:'other'}));
      assert.throws(()=>request({...chosen,id:'changed'}));
      assert.throws(()=>request({...chosen,variant:'changed'}));
      if(chosen.variant && chosen.variant!=='default') assert.throws(()=>request({...chosen,variant:'default'}));
      if(chosen.variant) assert.throws(()=>request({...chosen,variant:undefined}));
      batch=JSON.parse(x.text.split('Catalog: ')[1]);
    },wait:async()=>{},context:async()=>[{type:'assistant',agent:'indexer',time:{completed:1},content:[{type:'text',text:JSON.stringify({items:batch.map(x=>({kind:x.kind,id:x.id,concepts:{action:['read'],object:[],scope:[],effects:[],aliases:[]}}))})}]}]}};
  await syncSemanticIndex(ctx,[item],model);
  if(expected){assert.deepEqual(created.model,expected,name);assert.equal(created.parentID,undefined);const e={agent:'indexer',tools:{read:{},shell:{}}};hooks.context(e);assert.deepEqual(e.tools,{});assert.ok((await loadConcepts(ctx)).has('tool:alpha'));}
  else assert.equal(created,undefined,name);
}
try{
  const main={providerID:'openai',id:'main',variant:'fast'}, terra={providerID:'openai',id:'fixture-indexer'};
  await check('explicit configured selection', main, {}, terra, deny, terra);
  await check('explicit variant', main, {}, {...terra,variant:'high'}, deny, {...terra,variant:'high'});
  await check('explicit default variant', main, {}, {...terra,variant:'default'}, deny, {...terra,variant:'default'});
  await check('environment wins', main, {OPENCODE_SEMANTIC_INDEX_MODEL:'openai/override'}, {providerID:'openai',id:'override'}, deny, terra);
  await check('disabled with explicit agent', main, {OPENCODE_SEMANTIC_INDEX_ENABLED:'0'}, null, deny, terra);
  await check('invalid agent model', main, {}, null, deny, {...terra,id:'fixture-indexer#fast'});
  await check('inherit', {providerID:'openai',id:'gpt-test',variant:'high'}, {}, {providerID:'openai',id:'gpt-test',variant:'high'});
  await check('override', {providerID:'openai',id:'gpt-test'}, {OPENCODE_SEMANTIC_INDEX_MODEL:'openai/other'}, {providerID:'openai',id:'other'});
  await check('openai session one', {providerID:'openai',id:'openai-model-one',variant:'high'}, {}, {providerID:'openai',id:'openai-model-one',variant:'high'});
  await check('openai session two', {providerID:'openai',id:'openai-model-two'}, {}, {providerID:'openai',id:'openai-model-two'});
  await check('openai override', {providerID:'openai',id:'openai-model-one'}, {OPENCODE_SEMANTIC_INDEX_MODEL:'openai/openai-model-two'}, {providerID:'openai',id:'openai-model-two'});
  await check('cross-provider openai to stub', {providerID:'openai',id:'gpt-test'}, {OPENCODE_SEMANTIC_INDEX_MODEL:'stub/test',OPENCODE_SEMANTIC_INDEX_TEST:'1'}, null);
  await check('opt-out', {providerID:'openai',id:'gpt-test'}, {OPENCODE_SEMANTIC_INDEX_ENABLED:'0'}, null);
  await check('disallowed', {providerID:'other',id:'test'}, {OPENCODE_SEMANTIC_INDEX_MODEL:'openai/other'}, null);
  await check('unknown', undefined, {}, null);
  await check('invalid override', {providerID:'openai',id:'gpt-test'}, {OPENCODE_SEMANTIC_INDEX_MODEL:'other/test'}, null);
  await check('stub denied', {providerID:'stub',id:'test'}, {}, null);
  await check('stub test', {providerID:'stub',id:'test'}, {OPENCODE_SEMANTIC_INDEX_TEST:'1'}, {providerID:'stub',id:'test'});
  await check('unsafe agent', {providerID:'openai',id:'gpt-test'}, {}, null, [...deny,{action:'read',resource:'*',effect:'allow'}]);
  for(const k of ['OPENCODE_SEMANTIC_INDEX_ENABLED','OPENCODE_SEMANTIC_INDEX_MODEL','OPENCODE_SEMANTIC_INDEX_TEST']) delete process.env[k];
  const registry=[{name:'one',description:'first'}], calls=[], hooks={}; let currentBatch, configured;
  const shared={location:{directory:'shared-session-test'},tool:{list:async()=>registry},skill:{list:async()=>[]},agent:{list:async()=>[{id:'indexer',mode:'subagent',permissions:deny,model:configured}]},session:{
    hook:async(name,f)=>{hooks[name]=f},create:async x=>{calls.push(x);return {id:'index-'+calls.length,agent:'indexer'}},
    prompt:async x=>{hooks['model.request']({agent:'indexer',sessionID:x.sessionID,model:calls.at(-1).model});currentBatch=JSON.parse(x.text.split('Catalog: ')[1])},wait:async()=>{},
    context:async()=>[{type:'assistant',agent:'indexer',time:{completed:1},content:[{type:'text',text:JSON.stringify({items:currentBatch.map(x=>({kind:x.kind,id:x.id,concepts:{action:[],object:[],scope:[],effects:[],aliases:[]}}))})}]}]}};
  await syncSemanticIndex(shared,[{kind:'tool',id:'one',description:'first'}],{providerID:'openai',id:'first-model'});
  configured=terra;
  await syncSemanticIndex(shared,[{kind:'tool',id:'one',description:'first'}],{providerID:'openai',id:'first-model'});
  assert.equal(calls.length,1,'changing only the indexer model does not schedule a job');
  configured=undefined;
  registry.push({name:'two',description:'second'});
  await syncSemanticIndex(shared,[{kind:'tool',id:'two',description:'second'}],{providerID:'openai',id:'second-model',variant:'high'});
  assert.deepEqual(calls.map(x=>x.model),[{providerID:'openai',id:'first-model'},{providerID:'openai',id:'second-model',variant:'high'}]);
  console.log('Model inheritance and explicit opt-in, override precedence, opt-out, model/provider/variant veto, isolation, deny-all and no model-only job: passed');
}finally{process.env=saved;await rm(root,{recursive:true,force:true})}
