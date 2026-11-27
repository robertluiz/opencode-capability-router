import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
if (!process.env.ROUTER_TEST_CHILD) {
  const dir = await mkdtemp(path.join(tmpdir(), 'router-package-test-'));
  try {
    const p = spawnSync(process.execPath, [import.meta.filename], {stdio:'inherit', env:{...process.env, ROUTER_TEST_CHILD:'1', USERPROFILE:dir, HOME:dir, XDG_DATA_HOME:path.join(dir,'data'), OPENCODE_TAG_PROFILE:'test'}});
    assert.equal(p.status, 0);
  } finally { await rm(dir, {recursive:true, force:true}); }
} else {
  const {homedir} = await import('node:os');
  const {loadConcepts} = await import('../src/semantic-indexer.ts');
  const {cleanTags, identityKey, itemKey, indexPath, load, save} = await import('../src/tag-store.mjs');
  const hash = x => createHash('sha256').update(x).digest('hex');
  const file = hash(JSON.stringify(['test','project']))+'.json';
  const legacy = path.join(homedir(),'.config','opencode','router-qa','semantic-indexes',file);
  const current = path.join(process.env.XDG_DATA_HOME,'opencode','capability-router','semantic-indexes',file);
  const state = action => JSON.stringify({version:1,seen:{'tool:example':{description:hash('example'),concepts:{action:[action],object:[],scope:[],effects:[],aliases:[]}}}});
  const ctx = {location:{directory:'project'},tool:{list:async()=>[{name:'example',description:'example'}]},skill:{list:async()=>[]}};
  await mkdir(path.dirname(legacy),{recursive:true}); await writeFile(legacy,state('legacy'));
  assert.equal((await loadConcepts(ctx)).get('tool:example').action[0],'legacy');
  await mkdir(path.dirname(current),{recursive:true}); await writeFile(current,state('current'));
  assert.equal((await loadConcepts(ctx)).get('tool:example').action[0],'current');
  await writeFile(current,'invalid'); assert.equal((await loadConcepts(ctx)).size,0);
  const profile=process.env.OPENCODE_TAG_PROFILE, project=ctx.location.directory;
  const item={kind:'tool',id:'example',description:'example'};
  const key=identityKey(item), version=itemKey(item);
  const tags=cleanTags([' Read ', 'READ', 'C++', 'has\nnewline', '???', 42, 'x'.repeat(41)]);
  assert.deepEqual(tags,['read','c++']);
  assert.throws(()=>cleanTags(Array(13).fill('read')), /Invalid tags structure/);
  await save(profile,project,[{key,version,tags:[...tags,'read']}]);
  const expected={[key]:{version,tags}};
  assert.deepEqual(await load(profile,project),expected);
  assert.deepEqual(await load('other-profile',project),{});
  assert.deepEqual(await load(profile,'other-project'),{});
  await assert.rejects(save(profile,project,[{key,version,tags:['READ']}]), /Invalid index entries/);
  assert.deepEqual(await load(profile,project),expected);
  await writeFile(indexPath(profile,project),JSON.stringify({version:1,tags:{
    ...expected,
    invalid:{version,tags},
    [hash('invalid tags')]:{version,tags:['READ']},
  }}));
  assert.deepEqual(await load(profile,project),expected);
  console.log('Legacy fallback, current precedence, invalid-index lexical fallback: passed');
}
