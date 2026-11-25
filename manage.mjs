import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const fail = message => { throw new Error(message); };
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const exists = p => fs.existsSync(p);
const [action, source, ...args] = process.argv.slice(2);
try {
  if (!['install','uninstall'].includes(action) || args.length % 2) fail('Invalid arguments');
  const options = {};
  for (let i=0; i<args.length; i+=2) {
    if (!['--config','--destination'].includes(args[i]) || options[args[i]]) fail('Invalid arguments');
    options[args[i]] = args[i+1];
  }
  const configRoot = process.env.XDG_CONFIG_HOME || path.join(os.homedir(),'.config');
  const dataRoot = process.env.XDG_DATA_HOME || path.join(os.homedir(),'.local','share');
  const config = path.resolve(options['--config'] || path.join(configRoot,'opencode','opencode.json'));
  const destination = path.resolve(options['--destination'] || path.join(dataRoot,'opencode','capability-router','package'));
  const profile = path.dirname(config);
  const discovery = path.join(profile,'plugins');
  const relative = path.relative(discovery,destination);
  if (!relative || (!relative.startsWith('..'+path.sep) && relative !== '..' && !path.isAbsolute(relative))) fail('Destination must be outside the plugins autodiscovery directory');
  const stateDir = destination + '.router-state';
  const stateFile = path.join(stateDir,'state.json');
  const legacy = path.join(discovery,'capability-router.ts');
  const legacyBackup = path.join(profile,'.capability-router-legacy-'+hash(config.toLowerCase()).slice(0,16)+'.ts');
  const legacyHash = '1904fe7dd8ce4f2b0f36e0c5baa857ea598120bf058c2bb49c8cc797fc39f174';
  const packageInfo = JSON.parse(fs.readFileSync(path.join(source,'package.json'),'utf8'));
  if (packageInfo.name !== 'opencode-capability-router') fail('Unexpected package');
  const files = [...packageInfo.files, 'package.json'];
  if (files.some(f=>path.basename(f)!==f) || new Set(files).size !== files.length) fail('Invalid package file list');
  const sourceHashes = Object.fromEntries(files.map(f=>[f,hash(fs.readFileSync(path.join(source,f)))]));
  let state = exists(stateFile) ? JSON.parse(fs.readFileSync(stateFile,'utf8')) : null;
  if (state && (state.config !== config || state.destination !== destination || state.name !== packageInfo.name)) fail('State belongs to another config or destination');
  if (!state && (exists(destination) || exists(stateDir))) fail('Destination or state directory already exists and is not managed');
  if (state && (!state.files || typeof state.files !== 'object' || typeof state.legacy !== 'boolean')) fail('Invalid installation state');
  if (state && exists(destination)) {
    const current = fs.readdirSync(destination);
    if (current.some(f=>!Object.hasOwn(state.files,f)) || Object.entries(state.files).some(([f,h])=>!exists(path.join(destination,f)) || hash(fs.readFileSync(path.join(destination,f)))!==h)) fail('Installed package was modified; refusing to overwrite');
  } else if (state) fail('Managed package directory is missing');
  if (state?.legacy && (!exists(legacyBackup) || hash(fs.readFileSync(legacyBackup)) !== legacyHash)) fail('Legacy backup is missing or changed');
  if (!state?.legacy && exists(legacyBackup)) fail('Unexpected legacy backup');
  if (exists(legacy) && hash(fs.readFileSync(legacy)) !== legacyHash) fail('Unknown legacy router; refusing to move it');
  if (action==='uninstall' && state?.legacy && exists(legacy)) fail('Legacy router restore target is occupied');
  if (action==='install' && state?.legacy && exists(legacy)) fail('Legacy router reappeared while its backup is active');

  // Validate strict JSON and duplicate keys, retaining exact offsets of the top-level plugins value.
  const text = exists(config) ? fs.readFileSync(config,'utf8') : '{}';
  let parsed;
  try { parsed=JSON.parse(text); } catch { fail('Invalid JSON configuration.'); }
  let i=0, pluginsRange;
  const ws=()=>{while (/\s/.test(text[i] || '') && i<text.length) i++};
  function str(){const start=i++; while(i<text.length){if(text[i]==='\\'){i+=2;continue} if(text[i++]==='"') return JSON.parse(text.slice(start,i));} fail('Invalid JSON string')}
  function value(root=false){ws(); const start=i, ch=text[i];
    if(ch==='"') str();
    else if(ch==='{'){i++;ws();const keys=new Set();if(text[i]!=='}') while(true){ws();const k=str();if(keys.has(k)) fail('Duplicate JSON key');keys.add(k);ws();i++;ws();const s=i;value();if(root && k==='plugins') pluginsRange=[s,i];ws();if(text[i]===','){i++;continue}break}i++}
    else if(ch==='['){i++;ws();if(text[i]!==']')while(true){value();ws();if(text[i]===','){i++;continue}break}i++}
    else {while(i<text.length && !/[\s,\]}]/.test(text[i]))i++}
    return [start,i];
  }
  ws(); if(text[i]!=='{') fail('Configuration must be a JSON object'); value(true); ws();
  const plugins=parsed.plugins === undefined ? [] : parsed.plugins;
  if (!Array.isArray(plugins) || plugins.some(x=>typeof x!=='string')) fail('plugins must be an array of strings');
  const same = x => { try { return path.resolve(x).toLowerCase() === destination.toLowerCase() } catch { return false } };
  if (plugins.filter(same).length>1) fail('Duplicate router registration');
  if (!state && plugins.some(same)) fail('Existing router registration is not managed');
  let next = action==='install' ? (plugins.some(same) ? plugins : [...plugins,destination.replaceAll('\\','/')]) : plugins.filter(x=>!same(x));
  if (action==='uninstall' && !state) { console.log('Nothing installed by these scripts.'); process.exit(0); }
  let updated=text;
  if (JSON.stringify(next)!==JSON.stringify(plugins)) {
    if (pluginsRange) updated=text.slice(0,pluginsRange[0])+JSON.stringify(next)+text.slice(pluginsRange[1]);
    else { const close=text.lastIndexOf('}'); updated=text.slice(0,close)+(Object.keys(parsed).length?',':'')+'\n  "plugins": '+JSON.stringify(next)+'\n'+text.slice(close); }
  }
  if (action==='install') {
    if (!state) {
      fs.mkdirSync(path.dirname(destination),{recursive:true}); fs.mkdirSync(stateDir); fs.mkdirSync(destination);
      state={name:packageInfo.name,config,destination,files:{},legacy:false};
    }
    for (const f of files) if (path.resolve(source,f)!==path.resolve(destination,f)) fs.copyFileSync(path.join(source,f),path.join(destination,f));
    for (const f of Object.keys(state.files)) if (!files.includes(f)) fs.unlinkSync(path.join(destination,f));
    state.files=sourceHashes;
    if (exists(legacy)) { fs.renameSync(legacy,legacyBackup); state.legacy=true; }
    fs.writeFileSync(stateFile,JSON.stringify(state));
  }
  if (updated!==text || !exists(config)) { fs.mkdirSync(profile,{recursive:true}); fs.writeFileSync(config,updated,{encoding:'utf8',mode:0o600}); }
  if (action==='uninstall' && state.legacy) {
    fs.renameSync(legacyBackup,legacy); state.legacy=false; fs.writeFileSync(stateFile,JSON.stringify(state));
  }
  console.log(action==='install' ? 'Router registered. Restart or reload separately.' : 'Router registration removed. Restart or reload separately.');
} catch (e) { console.error('Router operation refused:', e.message); process.exitCode=1; }
