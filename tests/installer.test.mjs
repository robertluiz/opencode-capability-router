import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import crypto from 'node:crypto';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'router-installer-'));
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const known=process.env.ROUTER_LEGACY_FIXTURE;
if (known) assert.equal(hash(known),'1904fe7dd8ce4f2b0f36e0c5baa857ea598120bf058c2bb49c8cc797fc39f174');
try {
  const config=path.join(root,'profile','opencode.json'), dest=path.join(root,'data','package'), old=path.join(root,'profile','plugins','capability-router.ts');
  fs.mkdirSync(path.dirname(config),{recursive:true});
  const run=(which,ok=true,extra=[])=>{const p=spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.resolve(which+'.ps1'),'-ConfigPath',config,'-Destination',dest,...extra],{encoding:'utf8'});assert.equal(p.status,ok?0:1,`${which}: ${p.stdout} ${p.stderr}`)};
  const read=()=>JSON.parse(fs.readFileSync(config,'utf8'));
  fs.writeFileSync(config,'{"secret":"not-printed","plugins":["other"],"number":1234567890123456789012345}');
  const originalNumber='1234567890123456789012345';
  run('install'); assert.deepEqual(read().plugins,['other',dest.replaceAll('\\','/')]); assert.ok(fs.readFileSync(config,'utf8').includes(originalNumber));
  run('install'); assert.equal(read().plugins.length,2);
  const unknown=path.join(dest,'src','unknown.txt');
  const beforeUnknown=fs.readFileSync(config);
  fs.writeFileSync(unknown,'keep');
  for (const operation of ['install','uninstall']) {
    run(operation,false);
    assert.deepEqual(fs.readFileSync(config),beforeUnknown);
    assert.equal(fs.readFileSync(unknown,'utf8'),'keep');
  }
  fs.unlinkSync(unknown);
  let t=fs.readFileSync(config,'utf8').replace('"secret":"not-printed"','"secret":"edited"');fs.writeFileSync(config,t);
  run('uninstall'); assert.deepEqual(read().plugins,['other']); assert.equal(read().secret,'edited');
  run('uninstall');
  if (known) {
    fs.mkdirSync(path.dirname(old),{recursive:true}); fs.copyFileSync(known,old);
  run('install'); assert.ok(!fs.existsSync(old));
  run('install'); assert.ok(!fs.existsSync(old));
  fs.writeFileSync(old,'conflict'); const before=fs.readFileSync(config,'utf8'); run('uninstall',false); assert.equal(fs.readFileSync(config,'utf8'),before); fs.unlinkSync(old);
  run('uninstall'); assert.equal(hash(old),hash(known));
  }
  fs.mkdirSync(path.dirname(old),{recursive:true});
  fs.writeFileSync(old,'unknown'); run('install',false); assert.equal(fs.readFileSync(old,'utf8'),'unknown'); fs.unlinkSync(old);
  for(const invalid of ['{"plugins": [}', '{"plugins":[],"plugins":[]}', '{//comment\n"plugins":[]}']) {fs.writeFileSync(config,invalid);run('install',false);assert.equal(fs.readFileSync(config,'utf8'),invalid)}
  fs.writeFileSync(config,'{"plugins":[]}');run('install',true,['-WhatIf']);assert.deepEqual(read().plugins,[]);
  console.log('fresh, reinstall, uninstall, config edits, upgrade, optional legacy restore, conflicts, invalid JSON and WhatIf: passed');
} finally {fs.rmSync(root,{recursive:true,force:true})}
