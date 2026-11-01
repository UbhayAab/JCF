import {getSupabase} from '../supabase.js';
import {getCurrentUser,isManagerOrAdmin,isImpersonating} from '../auth.js';
import {showModal} from './modal.js';
import {showToast} from './toast.js';
import {MAX_FILE_BYTES,validatePack73,planImport73,runImport73} from '../utils/resourceImport73.js';

const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const columns='id,title,category,state,city,subtype,summary,eligibility,contact_phone,address,link,email,how_to_apply,documents_needed,who_to_ask,cost,price_from,amount_min_inr,amount_max_inr,amount_basis,age_min,age_max,serves_states,serves_cities,match_ready,is_public,is_active,is_sample,verified_on,updated_at,content';
function definite(message){const e=new Error(message);e.definite=true;return e;}

export async function openResourceImport73({onChanged=()=>{}}={}) {
 const actor=getCurrentUser()?.id,route=location.hash;
 const sameActor=()=>!!actor&&getCurrentUser()?.id===actor&&isManagerOrAdmin()&&!isImpersonating();
 if(!sameActor()){showToast('Import resources as your own active manager account.','warning');return;}
 const el=document.createElement('div');let cancelled=false,busy=false,pack=null,plan=null,results=[];
 const modal=showModal({title:'Import verified resources',content:el,size:'xl',onClose:()=>{cancelled=true;}});
 const current=()=>sameActor()&&el.isConnected&&modal.isCurrentModal()&&location.hash===route;
 const stop=()=>{cancelled=true;const s=el.querySelector('[data-import-status]');if(s)s.textContent='Stopping after the current request. Completed changes are kept.';};
 el.innerHTML=`<p>Use a reviewed resource pack from the team's verified source sheets. Preview every change before importing. Existing private, retired and held entries keep their controls.</p>
  <label class="form-label" for="resource73-file">Verified resource pack (.json, up to 16 MB)</label><input class="input" id="resource73-file" type="file" accept=".json,application/json">
  <div data-import-preview style="margin-top:16px;overflow-wrap:anywhere"></div>
  <p role="status" aria-live="polite" data-import-status></p>
  <p role="alert" data-import-error hidden style="color:var(--danger);overflow-wrap:anywhere"></p>
  <label class="form-checkbox" style="margin:12px 0"><input type="checkbox" data-import-confirm><span>I am using the verified source pack and approve the previewed public resource details.</span></label>
  <label class="form-checkbox" style="margin:12px 0"><input type="checkbox" data-import-publish><span>Also publish ready entries to HopeBot using their recorded public references. Missing details and existing holds stay unpublished.</span></label>
  <div class="form-actions" style="flex-wrap:wrap"><button class="btn btn-secondary" data-import-close>Close</button><button class="btn btn-secondary" data-import-stop hidden>Stop after this request</button><button class="btn btn-secondary" data-import-download hidden>Download results</button><button class="btn btn-primary" data-import-run disabled>Import previewed entries</button></div>`;
 const q=s=>el.querySelector(s),status=q('[data-import-status]'),error=q('[data-import-error]'),run=q('[data-import-run]'),file=q('#resource73-file');
 const shown=(selector,value)=>{const node=q(selector);node.hidden=!value;node.style.display=value?'':'none';};
 shown('[data-import-stop]',false);shown('[data-import-download]',false);
 const showError=m=>{if(current()){error.textContent=m;error.hidden=false;}};
 const canRun=()=>{run.disabled=busy||!plan||!q('[data-import-confirm]').checked;};
 q('[data-import-confirm]').addEventListener('change',canRun);
 q('[data-import-close]').addEventListener('click',()=>{stop();modal.closeOwnedModal();});
 q('[data-import-stop]').addEventListener('click',stop);
 function download(){const blob=new Blob([JSON.stringify({schema:'jcf.resource-import-result/1',pack:pack?.title,at:new Date().toISOString(),results},null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='resource-import-results.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
 q('[data-import-download]').addEventListener('click',download);
 async function inventory(){
  const rows=[];
  for(let from=0;from<10000;from+=500){
   if(!current())throw definite('Account or page changed.');
   const r=await getSupabase().from('resources').select(columns).order('id').range(from,from+499);
   if(r.error||!Array.isArray(r.data))throw definite('Could not read the current resource inventory. Nothing was imported.');
   if(!current())throw definite('Account or page changed.');
   rows.push(...r.data);if(r.data.length<500)return rows;
  }
  throw definite('Resource inventory exceeds this import window. Nothing was imported.');
 }
 file.addEventListener('change',async()=>{
  if(busy||!current())return;pack=null;plan=null;error.hidden=true;run.disabled=true;results=[];shown('[data-import-download]',false);
  const f=file.files?.[0];if(!f)return;
  if(f.size>MAX_FILE_BYTES){showError('This pack is over 16 MB. Split it into smaller reviewed packs.');return;}
  file.disabled=true;status.textContent='Validating the pack and comparing the current library...';
  try{
   const raw=await f.text();if(!current())return;
   pack=validatePack73(JSON.parse(raw));const existing=await inventory();if(!current())return;
   plan=await planImport73(pack,existing);if(!current())return;
   const counts=Object.fromEntries(['add','update','unchanged','ambiguous','blocked'].map(k=>[k,plan.filter(p=>p.status===k).length]));
   if(existing.length+counts.add>5000)throw definite('This import would exceed the current directory snapshot capacity. No entries were imported.');
   const notReady=plan.filter(p=>p.reason).length;
   q('[data-import-preview]').innerHTML=`<p><strong>${esc(pack.title)}</strong><br>${pack.sources.length} source sheets; ${plan.length} entries.</p><p>${counts.add} new, ${counts.update} updates, ${counts.unchanged} unchanged, ${counts.ambiguous} ambiguous, ${counts.blocked} protected. ${notReady} need review before publication.</p><div style="max-height:340px;overflow:auto"><table style="width:100%;font-size:13px"><thead><tr><th>Entry</th><th>Change</th><th>Publication check</th></tr></thead><tbody>${plan.map(p=>`<tr><td>${esc(p.row.fields.title)}<br><small>${esc([p.row.fields.city,p.row.fields.state].filter(Boolean).join(', '))}</small></td><td>${esc(p.status)}</td><td>${esc(p.reason||(!p.row.publication?'Public reference missing':'Ready for native review'))}</td></tr>`).join('')}</tbody></table></div>`;
   status.textContent='Preview ready. No changes have been made. Reopening the same pack recognises saved entries.';canRun();
  }catch(e){pack=null;plan=null;showError(e.message||'The pack could not be read. Nothing was imported.');status.textContent='Not imported.';}
  finally{if(current())file.disabled=false;}
 });
 run.addEventListener('click',async()=>{
  if(busy||!current()||!plan||!q('[data-import-confirm]').checked)return;
  busy=true;cancelled=false;error.hidden=true;run.disabled=true;file.disabled=true;shown('[data-import-stop]',true);results=[];
  const publish=q('[data-import-publish]').checked;
  q('[data-import-confirm]').disabled=true;q('[data-import-publish]').disabled=true;
  const sb=getSupabase();
  const adapter={
   async write(item){
    if(!current())throw definite('Account or page changed before saving.');
    let request;
    if(item.old){if(!item.old.updated_at)throw definite('Missing update preimage. Reopen the pack.');request=sb.from('resources').update(item.patch).eq('id',item.id).eq('updated_at',item.old.updated_at);}
    else request=sb.from('resources').insert({...item.patch,id:item.id,created_by:actor});
    const r=await request.select(columns);
    if(r.error)throw definite('Could not confirm the save for '+item.row.fields.title+'. Reopen the pack to check its state before resuming.');
    if(!Array.isArray(r.data)||r.data.length!==1)throw definite('The entry changed or access was refused. Reopen the pack before continuing.');
    return r.data[0];
   },
   async review(id){if(!current())throw definite('Account or page changed.');const r=await sb.rpc('review_resource_publication73',{p_id:id});if(r.error)throw definite('Publication review refused.');return r.data;},
   async publish(id,digest,p){if(!current())throw definite('Account or page changed.');const r=await sb.rpc('publish_resource73',{p_id:id,p_expected_digest:digest,p_source_url:p.url,p_source_title:p.title,p_source_date:p.source_date,p_checked_on:p.checked_on});if(r.error)throw definite('Publication was refused. Reopen the pack to inspect the saved state.');return r.data;}
  };
  try{
   // Re-read the reviewed inventory immediately before writing. Any change to an
   // entry's target or preimage requires a new visible preview, not an auto-merge.
   const fresh=await planImport73(pack,await inventory());
   if(fresh.length!==plan.length||fresh.some((p,i)=>p.status!==plan[i].status||p.id!==plan[i].id||p.old?.updated_at!==plan[i].old?.updated_at))throw definite('The library changed after this preview. Reopen the pack to review it again.');
   await runImport73(plan,adapter,{current,stopped:()=>cancelled,publish,onResult:r=>{results.push(r);if(current())status.textContent=results.length+' of '+plan.length+' checked. Last: '+r.title+' - '+r.status+' / '+(r.publication||r.reason||'');}});
   if(current())status.textContent=(cancelled?'Stopped. ':'Finished. ')+results.length+' entries checked. Download the results for saved, held and unpublished entries.';
  }catch(e){showError(e.message||'Import stopped. Inspect the saved state before resuming.');if(current())status.textContent='Processing stopped. Acknowledged changes are kept; later entries were not started.';}
  finally{
   busy=false;plan=null;
   if(current()){shown('[data-import-stop]',false);shown('[data-import-download]',true);file.disabled=false;q('[data-import-confirm]').checked=false;q('[data-import-confirm]').disabled=false;q('[data-import-publish]').disabled=false;run.disabled=true;await onChanged();}
  }
 });
 return modal;
}
