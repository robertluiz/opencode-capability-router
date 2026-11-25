import {createHash,randomBytes} from 'node:crypto';
import {readFile,writeFile,mkdir,rename,unlink} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
const digest=value=>createHash('sha256').update(value).digest('hex');
export const itemKey=item=>digest(JSON.stringify([item.kind,item.id,item.description]));
export const identityKey=item=>digest(JSON.stringify([item.kind,item.id]));
export const initializedKey=digest('tag-index-initialized-v1');
export const indexPath=(profile,project)=>path.join(homedir(),'.config','opencode','router-qa','semantic-router','legacy-tags',digest(JSON.stringify([profile,project]))+'.json');
const validKey=k=>/^[a-f0-9]{64}$/.test(k);
const validTag=t=>typeof t==='string'&&t.length<=40&&/^[a-z0-9 .+#/_-]+$/.test(t)&&/[a-z0-9]/.test(t)&&t===t.trim();
const validTags=tags=>Array.isArray(tags)&&tags.length<=12&&tags.every(validTag);
export function cleanTags(tags){
  if(!Array.isArray(tags)||tags.length>12)throw Error('Invalid tags structure.');
  return [...new Set(tags.flatMap(t=>{
    if(typeof t!=='string'||t.length>40||/[\x00-\x1f\x7f-\x9f]/.test(t))return [];
    const normalized=t.trim().toLowerCase();
    return validTag(normalized)?[normalized]:[];
  }))];
}
export async function load(profile,project){
  try{
    const text=await readFile(indexPath(profile,project),'utf8');
    if(text.length>1000000)return {};
    const data=JSON.parse(text);
    if(!data||data.version!==1||!data.tags||typeof data.tags!=='object'||Array.isArray(data.tags))return {};
    return Object.fromEntries(Object.entries(data.tags).filter(([key,entry])=>validKey(key)&&entry&&validKey(entry.version)&&Array.isArray(entry.tags)&&(entry.tags.length===0||validTags(entry.tags))));
  }catch{return {}}
}
export async function save(profile,project,updates){
  if(!Array.isArray(updates)||updates.length<1||updates.length>5000||updates.some(x=>!x||!validKey(x.key)||!validKey(x.version)||!Array.isArray(x.tags)||(x.tags.length>0&&!validTags(x.tags))))throw Error('Invalid index entries.');
  const target=indexPath(profile,project),dir=path.dirname(target);
  await mkdir(dir,{recursive:true,mode:0o700});
  const tags=await load(profile,project);
  for(const x of updates)tags[x.key]={version:x.version,tags:[...new Set(x.tags)]};
  const json=JSON.stringify({version:1,tags});
  if(json.length>1000000)throw Error('Index size limit reached.');
  const tmp=target+'.'+randomBytes(12).toString('hex')+'.tmp';
  try{await writeFile(tmp,json,{flag:'wx',mode:0o600});await rename(tmp,target)}
  finally{await unlink(tmp).catch(()=>{})}
}
