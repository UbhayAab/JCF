// Reviewed directory imports. Public resource data only; no patient interface.
export const PACK_SCHEMA = 'jcf.resource-import/1';
export const MAX_ROWS = 4000;
export const MAX_FILE_BYTES = 16000000;
const CATEGORIES = new Set(['accommodation','financial_aid','palliative','travel','food','medicines','nutrition','counselling','caregiver','community','clinical','other']);
const TYPES = new Set(['dharamshala','ngo_guest_house','hospital_hostel','shelter','hospice','dormitory','budget_hotel','govt_scheme','hospital_fund','ngo_grant','crowdfunding','insurance','medicine_support','equipment_support','travel_support','guidance_only','other','home_based','inpatient_hospice','opd_clinic','helpline','network_organisation']);
const TEXT = {title:240,state:160,city:160,summary:6000,eligibility:6000,contact_phone:500,address:2000,link:1500,email:1000,how_to_apply:6000,documents_needed:2000,who_to_ask:300};
const ENUMS = {category:CATEGORIES,subtype:TYPES,cost:new Set(['free','subsidised','paid','unknown']),amount_basis:new Set(['per_night','per_month','per_cycle','one_time','per_admission','per_case','varies'])};
const NUMBERS = new Set(['price_from','amount_min_inr','amount_max_inr','age_min','age_max']);
const ARRAYS = new Set(['serves_states','serves_cities']);
const FLAG_FIELDS = new Set(['match_ready']);
const own = (v,k)=>Object.prototype.hasOwnProperty.call(v,k);
const obj = x=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&Object.getPrototypeOf(x)===Object.prototype;
const fail = m=>{throw new Error(m);};
export function normalizedName(s) { return String(s??'').normalize('NFKD').toLowerCase().replace(/&/g,'and').replace(/[^\p{L}\p{N}]/gu,''); }
export function canonicalJSON(v) {
 if(Array.isArray(v))return '['+v.map(canonicalJSON).join(',')+']';
 if(obj(v))return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonicalJSON(v[k])).join(',')+'}';
 return JSON.stringify(v);
}
export async function digest73(v) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(typeof v==='string'?v:canonicalJSON(v))))].map(x=>x.toString(16).padStart(2,'0')).join(''); }
export async function importId73(key) { const h=await digest73('jcf-resource73:'+key);return h.slice(0,8)+'-'+h.slice(8,12)+'-8'+h.slice(13,16)+'-a'+h.slice(17,20)+'-'+h.slice(20,32); }
export function identity73(r) { return [r.category,r.title,r.city||'',r.state||''].map(normalizedName).join('|'); }
export function safeSourceURL(s) {
 if(typeof s!=='string'||s.length>1500||/[\s<>"\\]/.test(s))return false;
 try {const u=new URL(s);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&!u.search.includes('%')&&/\.[a-z]{2,}$/i.test(u.hostname)&&!/(^|\.)(localhost|local|internal|invalid|test)$/i.test(u.hostname)&&!/^\d+(\.\d+){3}$/.test(u.hostname)&&![...u.searchParams.keys()].some(k=>/token|secret|password|auth|signature|api.?key|^key$|^code$/i.test(k));}catch{return false;}
}
function day(s,label) {if(typeof s!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(s)||!Number.isFinite(Date.parse(s+'T00:00:00Z'))||new Date(s+'T00:00:00Z').toISOString().slice(0,10)!==s)fail(label+' needs a real date.');return s;}
function text(s,n,label,empty=true) {if(s===null&&empty)return null;if(typeof s!=='string'||s.length>n||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s))fail(label+' is invalid.');const v=s.trim();if(!v&&!empty)fail(label+' is empty.');return v||null;}
export function validatePack73(raw,{today=new Date().toISOString().slice(0,10)}={}) {
 if(!obj(raw)||raw.schema!==PACK_SCHEMA||!Array.isArray(raw.rows)||!raw.rows.length||raw.rows.length>MAX_ROWS)fail('Use a reviewed resource pack with 1-'+MAX_ROWS+' entries.');
 if(raw.verified!==true)fail('The source pack must be marked verified.');
 if(!Array.isArray(raw.sources)||!raw.sources.length||raw.sources.length>40)fail('Source manifest is missing or too large.');
 const sources=raw.sources.map(s=>{if(!obj(s))fail('Invalid source.');return {id:text(s.id,120,'Source ID',false),title:text(s.title,200,'Source title',false),url:safeSourceURL(s.url)?s.url:fail('Invalid source URL.'),as_of:day(s.as_of,'Source date')};});
 const sourceMap=new Map(sources.map(s=>[s.id,s]));if(sourceMap.size!==sources.length)fail('Duplicate source IDs.');
 const identities=new Set(),keys=new Set();
 const rows=raw.rows.map((r,i)=>{
  if(!obj(r)||!obj(r.fields))fail('Invalid entry '+(i+1));
  const fields={};
  for(const[k,v]of Object.entries(r.fields)){
   if(own(TEXT,k)){fields[k]=text(v,TEXT[k],k,k!=='title');if(k==='link'&&fields[k]&&!safeSourceURL(fields[k]))fail('Invalid organisation link in entry '+(i+1));}
   else if(own(ENUMS,k)){if(v===null&&k!=='category'&&k!=='cost')fields[k]=null;else if(!ENUMS[k].has(v))fail('Invalid '+k+' in entry '+(i+1));else fields[k]=v;}
   else if(NUMBERS.has(k)){if(v!==null&&(!Number.isFinite(v)||v<0||v>1000000000))fail('Invalid amount or age.');fields[k]=v;}
   else if(ARRAYS.has(k)){if(v!==null&&(!Array.isArray(v)||v.length>40||v.some(x=>typeof x!=='string'||x.length>160)))fail('Invalid service area.');fields[k]=v===null?null:[...new Set(v.map(x=>x.trim()).filter(Boolean))];}
   else if(FLAG_FIELDS.has(k)){if(typeof v!=='boolean')fail('Invalid readiness flag.');fields[k]=v;}
   else fail('Unsupported resource field: '+k);
  }
  if(!fields.title||!CATEGORIES.has(fields.category))fail('Title and category are required.');
  if(fields.age_min!=null&&fields.age_max!=null&&fields.age_min>fields.age_max)fail('Invalid age range.');
  if(fields.amount_min_inr!=null&&fields.amount_max_inr!=null&&fields.amount_min_inr>fields.amount_max_inr)fail('Invalid amount range.');
  if(fields.category==='financial_aid'&&/\b(loan|credit|gold loan|personal finance)\b/i.test(fields.title+' '+(fields.summary||''))&&(fields.subtype==='ngo_grant'||fields.cost==='free'))fail('A loan cannot be labelled as a free grant.');
  const key=text(r.key,400,'Entry key',false),identity=identity73(fields);
  if(keys.has(key)||identities.has(identity))fail('Duplicate entry identity: '+fields.title);keys.add(key);identities.add(identity);
  if(!Array.isArray(r.references)||!r.references.length||r.references.length>40)fail('Entry source references are missing.');
  const references=r.references.map(x=>{if(!obj(x)||!sourceMap.has(x.source_id)||!Number.isInteger(x.row)||x.row<1||x.row>100000)fail('Invalid entry source reference.');return{source_id:x.source_id,tab:text(x.tab,150,'Source tab',false),row:x.row};});
  let publication=null;
  if(r.publication!==null&&r.publication!==undefined){const p=r.publication;if(!obj(p)||!safeSourceURL(p.url)||/^(docs|drive)\.google\.com$/i.test(new URL(p.url).hostname))fail('Publication needs a public organisation reference, not a private sheet.');publication={url:p.url,title:text(p.title,200,'Publication source title',false),source_date:day(p.source_date,'Publication source date'),checked_on:day(p.checked_on,'Review date')};if(publication.source_date>publication.checked_on||publication.checked_on>today||publication.checked_on<new Date(Date.parse(today+'T00:00:00Z')-180*86400000).toISOString().slice(0,10))fail('Publication source/review dates are out of range.');}
  return {key,identity,fields,references,publication};
 });
 return {schema:PACK_SCHEMA,verified:true,title:text(raw.title,200,'Pack title',false),sources,rows};
}
export function notReady73(f) {
 if(!f.city)return 'City or service area missing';
 if(f.match_ready!==true)return 'Not ready for matching';
 if(f.category==='palliative'){
  if(!['home_based','inpatient_hospice','opd_clinic','helpline','network_organisation'].includes(f.subtype))return 'Palliative service type missing';
  if(/^(national|india|all india|pan.?india)$/i.test(f.city)&&!['helpline','network_organisation'].includes(f.subtype))return 'Local service needs a real city';
 }
 if(!['palliative','financial_aid','accommodation'].includes(f.category))return 'Saved to the library; this category has no HopeBot feed';
 for(const [key,max] of Object.entries({title:200,city:100,state:100,summary:4000,eligibility:4000,contact_phone:100,address:1000,how_to_apply:4000})){
  if(typeof f[key]==='string'&&f[key].length>max)return 'Saved in full; '+key.replaceAll('_',' ')+' exceeds the HopeBot display limit';
 }
 return null;
}
function patchFor(r,old,entryDigest,pack) {
 const patch={...r.fields,is_sample:false,verified_on:r.publication?.checked_on||old?.verified_on||null};
 if(!old){patch.is_active=true;patch.is_public=true;}
 else {if(old.match_ready===false)patch.match_ready=false;delete patch.is_active;delete patch.is_public;}
 patch.content={...(obj(old?.content)?old.content:{}),resource_import73:{key:r.key,entry_digest:entryDigest,pack_title:pack.title,references:r.references,sources:pack.sources.filter(s=>r.references.some(x=>x.source_id===s.id))}};
 return patch;
}
export async function planImport73(pack,existing) {
 if(!Array.isArray(existing)||existing.length>10000)fail('Existing resource inventory is incomplete or too large.');
 const byKey=new Map(),byIdentity=new Map();
 for(const old of existing){if(old.content?.resource_import73?.key){const k=old.content.resource_import73.key;byKey.set(k,[...(byKey.get(k)||[]),old]);}const identity=identity73(old);byIdentity.set(identity,[...(byIdentity.get(identity)||[]),old]);}
 const plan=[];
 for(const row of pack.rows){
  const exact=byKey.get(row.key)||byIdentity.get(row.identity)||[],entryDigest=await digest73({fields:row.fields,references:row.references,publication:row.publication,sources:pack.sources.filter(s=>row.references.some(x=>x.source_id===s.id))});
  if(exact.length>1){plan.push({row,status:'ambiguous',reason:'Several existing resources match; review them separately.'});continue;}
  const old=exact[0]||null;
  if(old&&(old.is_active===false||old.is_public===false||old.is_sample===true)){plan.push({row,old,status:'blocked',reason:'Existing private, retired or sample entry is preserved.'});continue;}
  const patch=patchFor(row,old,entryDigest,pack),same=old&&old.content?.resource_import73?.entry_digest===entryDigest&&Object.keys(patch).filter(k=>k!=='content').every(k=>canonicalJSON(old[k]??null)===canonicalJSON(patch[k]??null));
  plan.push({row,old,id:old?.id||await importId73(row.key),patch,entryDigest,status:same?'unchanged':old?'update':'add',reason:notReady73({...old,...patch})});
 }
 return plan;
}
export class UnknownImportResult extends Error {constructor(id,stage){super('Could not confirm '+stage+' for '+id+'. Processing stopped. Reopen this same pack to read the saved state before resuming.');this.name='UnknownImportResult';this.id=id;this.stage=stage;}}
export async function runImport73(plan,adapter,{current=()=>true,stopped=()=>false,publish=false,onResult=()=>{}}={}) {
 const results=[];
 const active=()=>{if(!current())fail('Account, page or review changed. Processing stopped.');if(stopped())return false;return true;};
 for(const item of plan){
  if(!active())break;
  if(['ambiguous','blocked'].includes(item.status)){const result={id:item.id||null,title:item.row.fields.title,status:item.status,reason:item.reason};results.push(result);onResult(result);continue;}
  let saved=item.old;
  if(item.status!=='unchanged'){
   try {saved=await adapter.write(item);}catch(e){if(e?.definite===true)throw e;throw new UnknownImportResult(item.id,'save');}
   if(!current())throw new UnknownImportResult(item.id,'save after account/page change');
   if(!saved||saved.id!==item.id||Object.keys(item.patch).some(k=>canonicalJSON(saved[k]??null)!==canonicalJSON(item.patch[k]??null)))throw new UnknownImportResult(item.id,'saved row readback');
  }
  const result={id:item.id,title:item.row.fields.title,status:item.status==='unchanged'?'unchanged':'saved',publication:'not requested',reason:item.reason};
  if(publish&&item.row.publication&&!item.reason){
   if(!active()){results.push(result);onResult(result);break;}
   let review;
   try {review=await adapter.review(item.id);}catch{throw new Error('Saved, but publication review failed for '+item.id+'. Reopen this pack before continuing.');}
   if(!active()){results.push(result);onResult(result);break;}
    if(review?.resource?.id!==item.id||! /^[a-f0-9]{64}$/.test(review.digest||''))fail('The current publication review could not be confirmed.');
    if(Object.keys(item.patch).some(k=>canonicalJSON(review.resource[k]??null)!==canonicalJSON(item.patch[k]??null)))fail('The resource changed after saving. Reopen the pack to review it before publishing.');
   if(review.not_ready){result.publication='held';result.reason=review.not_ready;}
   else if(review.status==='published'&&review.publication?.source_url===item.row.publication.url&&review.publication?.source_title===item.row.publication.title&&review.publication?.source_date===item.row.publication.source_date&&review.publication?.checked_on===item.row.publication.checked_on){result.publication='already published';result.revision=review.publication.revision;}
   else {
    let p;try {p=await adapter.publish(item.id,review.digest,item.row.publication);}catch{throw new UnknownImportResult(item.id,'publication');}
    if(!current())throw new UnknownImportResult(item.id,'publication after account/page change');
    if(p?.resource_id!==item.id||!p.revision)throw new UnknownImportResult(item.id,'publication receipt');
    let after;try {after=await adapter.review(item.id);}catch{throw new UnknownImportResult(item.id,'publication readback');}
    if(!current())throw new UnknownImportResult(item.id,'publication readback after account/page change');
    if(after?.status!=='published'||after.resource?.id!==item.id||String(after.publication?.revision)!==String(p.revision))throw new UnknownImportResult(item.id,'publication readback');
    result.publication='published';result.revision=p.revision;
   }
  } else if(publish){result.publication='not ready';result.reason=item.reason||'Public organisation/source reference missing';}
  results.push(result);onResult(result);
 }
 return results;
}
