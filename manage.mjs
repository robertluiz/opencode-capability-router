import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const fail = message => { throw new Error(message); };
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const exists = p => fs.existsSync(p);
const stat = p => fs.lstatSync(p, {throwIfNoEntry:false});
const simpleName = name => name && !/[^a-z0-9._-]/i.test(name) && !name.endsWith('.') &&
  !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name);
const validFile = f => typeof f === 'string' && (f.startsWith('src/')
  ? simpleName(f.slice(4)) : simpleName(f) && f.toLowerCase() !== 'src');
const validFiles = files => files.every(validFile) && new Set(files.map(f=>f.toLowerCase())).size === files.length;
const inSrc = f => f.startsWith('src/');

function readJson(text, parseError, objectError) {
  let parsed;
  try { parsed=JSON.parse(text); } catch { fail(parseError); }
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
  ws(); if(text[i]!=='{') fail(objectError); value(true); ws();
  return { parsed, pluginsRange };
}

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
  const {parsed:packageInfo} = readJson(fs.readFileSync(path.join(source,'package.json'),'utf8'), 'Invalid package JSON', 'Invalid package JSON');
  if (packageInfo.name !== 'opencode-capability-router') fail('Unexpected package');
  if (!Array.isArray(packageInfo.files)) fail('Invalid package file list');
  const files = [...packageInfo.files, 'package.json'];
  if (!validFiles(files)) fail('Invalid package file list');
  const needsSrc = files.some(inSrc);
  const sourceHashes = Object.fromEntries(files.map(f=>[f,hash(fs.readFileSync(path.join(source,f)))]));

  let state = null;
  const stateDirectory = stat(stateDir);
  if (stateDirectory) {
    if (!stateDirectory.isDirectory()) fail('Invalid installation state directory');
    const metadata = stat(stateFile);
    if (!metadata?.isFile() || metadata.nlink !== 1) fail('Invalid installation state file');
    ({parsed:state} = readJson(fs.readFileSync(stateFile,'utf8'), 'Invalid installation state', 'Invalid installation state'));
    if (state.config !== config || state.destination !== destination || state.name !== packageInfo.name) fail('State belongs to another config or destination');
    if (!state.files || typeof state.files !== 'object' || Array.isArray(state.files) || typeof state.legacy !== 'boolean' ||
        !validFiles(Object.keys(state.files)) || Object.values(state.files).some(h=>typeof h !== 'string' || h.length !== 64 || /[^0-9a-f]/.test(h))) fail('Invalid installation state');
  }

  const installed = stat(destination);
  if (!state && installed) fail('Destination or state directory already exists and is not managed');
  const oldFiles = Object.keys(state?.files ?? {});
  const hadSrc = oldFiles.some(inSrc);
  const srcDir = path.join(destination,'src');
  if (state) {
    if (!installed?.isDirectory()) fail('Managed package directory is missing or invalid');
    const modified = () => fail('Installed package was modified; refusing to overwrite');
    const current = fs.readdirSync(destination);
    if (current.includes('src') !== hadSrc) modified();
    if (hadSrc) {
      if (!stat(srcDir)?.isDirectory()) modified();
      current.splice(current.indexOf('src'),1,...fs.readdirSync(srcDir).map(f=>'src/'+f));
    }
    if (current.length !== oldFiles.length || current.some(f=>!Object.hasOwn(state.files,f))) modified();
    for (const f of oldFiles) {
      const p = path.join(destination,f);
      const entry = stat(p);
      if (!entry?.isFile() || entry.nlink !== 1 || hash(fs.readFileSync(p)) !== state.files[f]) modified();
    }
    if (action==='install' && !validFiles([...new Set([...oldFiles,...files])])) fail('Conflicting package file names');
  }
  if (state?.legacy && (!exists(legacyBackup) || hash(fs.readFileSync(legacyBackup)) !== legacyHash)) fail('Legacy backup is missing or changed');
  if (!state?.legacy && exists(legacyBackup)) fail('Unexpected legacy backup');
  if (exists(legacy) && hash(fs.readFileSync(legacy)) !== legacyHash) fail('Unknown legacy router; refusing to move it');
  if (action==='uninstall' && state?.legacy && exists(legacy)) fail('Legacy router restore target is occupied');
  if (action==='install' && state?.legacy && exists(legacy)) fail('Legacy router reappeared while its backup is active');

  // Retain exact offsets of the top-level plugins value.
  const text = exists(config) ? fs.readFileSync(config,'utf8') : '{}';
  const { parsed, pluginsRange } = readJson(text, 'Invalid JSON configuration.', 'Configuration must be a JSON object');
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
    if (needsSrc && !hadSrc) fs.mkdirSync(srcDir);
    for (const f of files) if (path.resolve(source,f)!==path.resolve(destination,f)) {
      fs.copyFileSync(path.join(source,f),path.join(destination,f),Object.hasOwn(state.files,f) ? 0 : fs.constants.COPYFILE_EXCL);
    }
    for (const f of Object.keys(state.files)) if (!files.includes(f)) fs.unlinkSync(path.join(destination,f));
    if (hadSrc && !needsSrc) fs.rmdirSync(srcDir);
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
