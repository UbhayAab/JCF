import {getSupabase} from '../supabase.js';
import {getCurrentUser,isManagerOrAdmin,isImpersonating} from '../auth.js';
import {showModal} from './modal.js';
import {navigate} from '../router.js';

const node=(tag,text='',className='')=>{const n=document.createElement(tag);n.textContent=String(text??'');if(className)n.className=className;return n;};
const button=(text,run)=>{const b=node('button',text,'btn btn-secondary');b.type='button';b.addEventListener('click',run);return b;};
const field=(label,input)=>{const box=node('label','','form-group');box.append(node('span',label),input);return box;};
const rpc=async(name,args)=>{const r=await getSupabase().rpc(name,args);if(r.error)throw new Error(r.error.message);return r.data;};
const date=value=>value?new Date(value).toLocaleString():'';
const label=key=>key.replace(/154$/,'').replaceAll('_',' ');
const staffCanMerge=()=>isManagerOrAdmin()&&!isImpersonating();
function profileCard(profile,title){
 const card=node('section','','card');card.style.minWidth='0';
 card.append(node('h4',title),node('strong',profile.name),node('p',profile.code),node('p',profile.phone));return card;
}
function originalDetails(record,title){
 const details=node('details'),summary=node('summary',title);details.append(summary);
 const list=node('dl');list.style.cssText='display:grid;grid-template-columns:minmax(95px,1fr) minmax(0,2fr);gap:6px;overflow-wrap:anywhere;white-space:pre-wrap';
 for(const[k,v]of Object.entries(record||{}))if(v!==null&&v!==''){
  list.append(node('dt',label(k)),node('dd',typeof v==='object'?JSON.stringify(v,null,2):String(v)));
 }
 details.append(list);return details;
}

export function openPatientMerge154(patient){
 if(!staffCanMerge())return;
 const actor=getCurrentUser()?.id,body=node('div'),status=node('p','','form-help');status.setAttribute('role','status');
 const search=node('input','','form-input');search.type='search';search.placeholder='Name, patient ID or phone';search.maxLength=100;
 const results=node('div'),selection=node('div'),review=node('div');
 body.append(node('p','Merge only two records of the same person. Main keeps its ID, primary phone and current clinical profile. Every original remains traceable.'),field('Find the other profile',search),button('Search',find),status,results,selection,review);
 const overlay=showModal({title:'Merge patient profiles',content:body,size:'lg',dismissible:false});
 const alive=()=>overlay.isCurrentModal()&&getCurrentUser()?.id===actor&&staffCanMerge();
 let version=0,other=null,main=patient.id,preview=null,busy=false;
 const cancel=button('Cancel',()=>overlay.closeOwnedModal());body.append(cancel);
 search.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();find();}});
 async function find(){
  const turn=++version;if(busy||!alive())return;
  results.replaceChildren();selection.replaceChildren();review.replaceChildren();preview=null;other=null;
  status.textContent='Searching...';
  try{
   const rows=await rpc('search_patient_merge154',{p_query:search.value.trim(),p_exclude:patient.id});
   if(!alive()||turn!==version)return;status.textContent=rows.length?'Choose the matching person.':'No matching profiles. Try a full ID, name or phone.';
   for(const row of rows){const b=button(`${row.name} | ${row.code} | ${row.phone}`,()=>choose(row));b.style.cssText='display:block;width:100%;white-space:normal;text-align:left;overflow-wrap:anywhere;margin-bottom:8px';results.append(b);}
  }catch(e){if(alive()&&turn===version)status.textContent=e.message;}
 }
 function choose(row){
  other=row;main=patient.id;preview=null;results.replaceChildren();review.replaceChildren();selection.replaceChildren();
  const grid=node('div');grid.style.cssText='display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px';
  const first={id:patient.id,name:patient.full_name,code:patient.patient_code,phone:patient.phone_full};
  for(const p of[first,other]){const card=profileCard(p,'Choose Main'),radio=node('input');radio.type='radio';radio.name='merge-main154';radio.value=p.id;radio.checked=p.id===main;
   radio.addEventListener('change',()=>{main=p.id;preview=null;review.replaceChildren();});card.prepend(field('Keep this as Main',radio));grid.append(card);}
  selection.append(grid,button('Compare records',compare));status.textContent='Choose Main, then compare. No records have changed.';
 }
 async function compare(){
  if(!alive()||busy||!other)return;busy=true;review.replaceChildren();status.textContent='Checking current identities, restrictions and histories...';
  const turn=++version;selection.querySelectorAll('input,button').forEach(n=>n.disabled=true);
  try{
   const value=await rpc('preview_patient_merge154',{p_main:main,p_source:main===patient.id?other.id:patient.id});
   if(!alive()||turn!==version)return;preview=value;renderConfirmation();status.textContent='Comparison ready. It expires in10 minutes; changes to either history require a new comparison.';
  }catch(e){if(alive())status.textContent=e.message;}finally{busy=false;if(alive())selection.querySelectorAll('input,button').forEach(n=>n.disabled=false);}
 }
 function renderConfirmation(){
  review.replaceChildren();const grid=node('div');grid.style.cssText='display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px';
  grid.append(profileCard(preview.main,'Main stays active'),profileCard(preview.secondary,'Becomes Dormant (Merged)'));review.append(grid,node('p',preview.policy));
  const counts=node('details');counts.append(node('summary','Compare every history category'));
  if(preview.testimonials)review.append(node('p',`Patient and caregiver testimonials: Main ${preview.testimonials.main}, secondary ${preview.testimonials.secondary}.`));
  for(const r of preview.records)counts.append(node('p',`${r.label}: Main ${r.main}, secondary ${r.secondary}. ${r.will_move??r.secondary} move under Main; ${r.retained_original??0} retain their original scope${r.already_linked_original?`; ${r.already_linked_original} remain in previously linked history`:''}. ${r.strategy==='retain'?'Original number-specific history stays linked.':r.strategy==='fold'?'Conflicting facts remain labelled original history for human review.':'Preserved with original identity.'}`));
  review.append(counts);
  const reason=node('textarea','','form-input');reason.rows=3;reason.minLength=5;reason.maxLength=1000;reason.required=true;
  const confirm=node('input','','form-input');confirm.autocomplete='off';confirm.spellcheck=false;
  const save=button('Merge these profiles',commit);save.className='btn btn-primary';save.disabled=true;
  const validate=()=>{save.disabled=busy||confirm.value.trim()!=='MERGE'||reason.value.trim().length<5;};
  confirm.addEventListener('input',validate);reason.addEventListener('input',validate);
  review.append(field('Why are these the same patient?',reason),field('Type MERGE to confirm',confirm),save);
  async function commit(){
   if(!alive()||save.disabled||busy||!preview)return;
   busy=true;save.disabled=true;cancel.disabled=true;search.disabled=true;selection.querySelectorAll('input,button').forEach(n=>n.disabled=true);
   status.textContent='Saving one atomic merge. Please wait...';
   try{
    const result=await rpc('commit_patient_merge154',{p_preview:preview.preview,p_confirmation:confirm.value.trim(),p_reason:reason.value.trim()});
    if(!alive())return;review.replaceChildren(node('h4','Merge completed'),node('p',`${result.source_code} is Dormant (Merged). ${result.main_code} remains Main.`),originalDetails(result.records,'Saved record counts'),button('Open Main profile',()=>{overlay.closeOwnedModal();navigate('patients/'+result.main);}));
    selection.replaceChildren();results.replaceChildren();status.textContent='Saved. Main ID and primary phone are unchanged. Originals and the audit are preserved.';
   }catch(e){if(alive()){status.textContent=e.message+' If the connection failed, retry this same confirmation to retrieve its saved result; do not choose another pair.';save.textContent='Retry same confirmation';}}
   finally{busy=false;if(alive()){cancel.disabled=false;validate();}}
  }
 }
}

export async function renderMergedHistory154(mount,patientId,{isCurrent=()=>mount.isConnected}={}){
 const actor=getCurrentUser()?.id,alive=()=>isCurrent()&&mount.isConnected&&getCurrentUser()?.id===actor;
 mount.replaceChildren(node('p','Loading linked histories...'));
 try{
  const status=await rpc('patient_merge_status154',{p_patient:patientId});if(!alive())return;
  mount.replaceChildren(node('h3','Combined patient history'),node('p','Main shows the current profile. Original conflicting facts remain labelled history for human review. Contact permissions remain specific to the original number.'));
  for(const p of status.origins)mount.append(node('p',`${p.code} | ${p.phone}${p.dormant?' | Dormant (Merged) on '+date(p.merged_at):' | Main'}`));
  const profiles=await rpc('patient_merge_original_profiles154',{p_main:patientId});if(!alive())return;
  for(const p of profiles)mount.append(originalDetails(p.profile,'Original profile at merge: '+p.profile.patient_code+' | '+date(p.at)));
  const select=node('select','','form-select');select.setAttribute('aria-label','History category');
  for(const category of status.categories){const option=node('option',category.label);option.value=category.key;select.append(option);}
  const records=node('div'),pager=node('div');let offset=0,sequence=0;mount.append(field('History category',select),records,pager);
  select.addEventListener('change',()=>{offset=0;load();});
  async function load(){
   const turn=++sequence;records.replaceChildren(node('p','Loading history...'));pager.replaceChildren();
   try{
    const result=await rpc('patient_merge_records154',{p_main:patientId,p_relation:select.value,p_offset:offset,p_limit:25});if(!alive()||turn!==sequence)return;
    records.replaceChildren(node('p',result.restricted?'This category is restricted by your current role.':`${result.count} records in your current scope.`));
    for(const r of result.rows)records.append(originalDetails(r,[r.merge_origin_code154?'Original '+r.merge_origin_code154:'Patient history',date(r.created_at||r.recorded_at||r.call_date)].filter(Boolean).join(' | ')));
    if(offset>0)pager.append(button('Previous',()=>{offset-=25;load();}));if(offset+25<result.count)pager.append(button('Next',()=>{offset+=25;load();}));
   }catch(e){if(alive()&&turn===sequence)records.replaceChildren(node('p',e.message));}
  }
  await load();
  if(isManagerOrAdmin())mount.append(button('Merge audit history',()=>openMergeAudit154(patientId)));
 }catch(e){if(alive())mount.replaceChildren(node('p','Combined history could not load: '+e.message));}
}

export function openMergeAudit154(patientId=null){
 if(!staffCanMerge())return;const body=node('div'),status=node('p','Loading...');body.append(status);
 const overlay=showModal({title:'Merge history',content:body,size:'lg'}),actor=getCurrentUser()?.id;
 const alive=()=>overlay.isCurrentModal()&&getCurrentUser()?.id===actor&&staffCanMerge();
 let cursor=null,loading=false,total=0;const more=button('Load older merges',load);body.append(more);
 async function load(){if(loading||!alive())return;loading=true;more.disabled=true;
  try{const rows=await rpc('patient_merge_history154',{p_main:patientId,p_before:cursor?.completed_at||null,p_before_id:cursor?.id||null});if(!alive())return;
   total+=rows.length;status.textContent=total?`${total} completed merges loaded.`:'No completed merges.';
   for(const row of rows){const card=node('section','','card');card.append(node('h4',row.source_code+' to '+row.main_code),node('p',date(row.completed_at)+' | '+row.actor_name),node('p',row.reason),originalDetails(row.result?.records,'Record counts'),button('Open Main',()=>{overlay.closeOwnedModal();navigate('patients/'+row.main_id);}));body.insertBefore(card,more);}
   if(rows.length)cursor=rows.at(-1);more.hidden=rows.length<30;
  }catch(e){if(alive())status.textContent=e.message;}finally{loading=false;if(alive())more.disabled=false;}
 }
 load();
}
