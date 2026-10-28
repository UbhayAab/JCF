import {getSupabase} from '../supabase.js';
import {getCurrentUser,isManagerOrAdmin,isImpersonating} from '../auth.js';
import {showModal} from './modal.js';
import {showToast} from './toast.js';

const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const reasons={retired:'Retired',private:'Not public',sample:'Sample entry',not_match_ready:'Not ready to match',
 complaint_hold:'Held after a family report',closed:'Closed',full:'No capacity recorded',unreachable:'Phone never answered',missing_title:'Title needed',
 missing_city:'City needed',palliative_subtype:'Choose a palliative service type',local_area_required:'Local city needed',
 unsupported_category:'Category not supported by HopeBot'};
const statuses={not_published:'Not published to HopeBot',published:'Published to HopeBot',changed:'Changed - review again',
 withdrawn:'Withdrawn from HopeBot',review_due:'Review overdue'};

// Every asynchronous response belongs to this exact modal and signed-in user.
// The backend independently checks the actual active manager, not this UI role.
export async function openResourcePublication73(id,{onChanged=()=>{}}={}) {
 const actor=getCurrentUser()?.id;
 const sameActor=()=>!!actor&&getCurrentUser()?.id===actor&&isManagerOrAdmin()&&!isImpersonating();
 if(!UUID.test(String(id))||!sameActor()){
  showToast('Open Resources as your own manager account to review publication.','warning');return;
 }
 const el=document.createElement('div');
 el.innerHTML='<p role="status">Opening the current resource and publication record...</p>';
 const modal=showModal({title:'HopeBot publication',content:el,size:'lg'});
 const current=()=>sameActor()&&el.isConnected&&modal.isCurrentModal();
 let busy=false;
 const message=(text)=>{if(current())el.innerHTML=`<p role="alert">${esc(text)}</p>`;};
 async function load(){
  let response;
  try{response=await getSupabase().rpc('review_resource_publication73',{p_id:id});}
  catch{message('Publication is unavailable. Your existing resource has not been changed.');return;}
  if(!current())return;
  if(response?.error){message('Publication is unavailable. Check your manager access and try again.');return;}
  const d=response?.data;
  if(!d){message('This resource no longer exists.');return;}
  if(d.resource?.id!==id||!/^[a-f0-9]{64}$/.test(d.digest)||typeof d.status!=='string'){
   message('The publication record could not be verified. Try opening it again.');return;
  }
  const r=d.resource,p=d.publication||{},blocked=d.not_ready;
  el.innerHTML=`
   <p><strong>${esc(r.title)}</strong><br><span class="due-meta">${esc([r.city,r.state].filter(Boolean).join(', '))}</span></p>
   <p data-pub-status role="status"><strong>${esc(statuses[d.status]||reasons[d.status]||'Not available for publication')}</strong>${p.revision?` - revision ${esc(p.revision)}`:''}</p>
   ${blocked?`<p role="alert" class="rs-hold">${esc(reasons[blocked]||'Not ready to publish')}. Edit or re-check this entry before publishing.</p>`:''}
   <div style="white-space:pre-wrap;overflow-wrap:anywhere;background:var(--surface-2);padding:12px;border-radius:var(--r-sm);margin-bottom:16px" data-pub-preview>${esc([r.summary,r.eligibility,r.how_to_apply,r.contact_phone,r.address,r.link].filter(Boolean).join('\n\n')||'No public details recorded.')}</div>
   <p class="due-meta" data-pub-guidance style="white-space:normal;overflow:visible;text-overflow:clip">Review the current details against a source that families can open. Editing, retiring or withdrawing an entry stops its current HopeBot listing until it is reviewed again. Publication does not confirm availability or eligibility.</p>
   <form id="resource-publication73">
    <div class="form-group"><label class="form-label" for="pub73-title">Public source title</label><input class="input" id="pub73-title" required minlength="3" maxlength="200" value="${esc(p.source_title)}"></div>
    <div class="form-group"><label class="form-label" for="pub73-url">Public source URL</label><input class="input" id="pub73-url" required type="url" maxlength="1500" placeholder="https://..." value="${esc(p.source_url)}"></div>
    <div class="form-row">
     <div class="form-group"><label class="form-label" for="pub73-source-date">Date on the source</label><input class="input" id="pub73-source-date" required type="date" value="${esc(p.source_date)}"></div>
     <div class="form-group"><label class="form-label" for="pub73-checked">Date you actually reviewed it</label><input class="input" id="pub73-checked" required type="date" value="${esc(p.checked_on)}"></div>
    </div>
    <label class="form-checkbox" style="margin:12px 0"><input type="checkbox" id="pub73-confirm" required><span>I reviewed these current details and the source, and can share them publicly with families.</span></label>
    <p data-pub-error role="alert" hidden style="color:var(--danger)"></p>
    <div class="form-actions" style="flex-wrap:wrap">
     ${p.resource_id&&!p.withdrawn_at?'<button type="button" class="btn btn-secondary" data-pub-withdraw>Withdraw from HopeBot</button>':''}
     <button type="button" class="btn btn-secondary" data-pub-cancel>Close</button>
     <button type="submit" class="btn btn-primary" ${blocked?'disabled':''}>Publish reviewed version</button>
    </div>
   </form>`;
  const form=el.querySelector('form'),error=el.querySelector('[data-pub-error]');
  const fail=text=>{if(current()){error.textContent=text;error.hidden=false;}};
  el.querySelector('[data-pub-cancel]').addEventListener('click',()=>modal.closeOwnedModal());
  async function act(name,args){
   if(busy||!current()){if(!sameActor())showToast('Account changed. Reopen the review in your own manager account.','warning');return;}
   busy=true;error.hidden=true;
   const buttons=[...form.querySelectorAll('button:not([data-pub-cancel])')];
   buttons.forEach(b=>b.disabled=true);
   try{
    const result=await getSupabase().rpc(name,args);
    if(!current())return;
    if(result?.error){fail(result.error.code==='40001'?'The resource changed while you reviewed it. Close and reopen this review.':'Could not confirm publication. Your entries are kept. Reopen the review to check its current status before retrying.');return;}
    if(name==='publish_resource73'&&(result?.data?.resource_id!==id||!result.data.revision)){
     fail('The publication result could not be confirmed. Reopen this review to check its current status.');return;
    }
    if(name==='withdraw_resource73'&&result?.data!==true&&result?.data!==false){
     fail('Withdrawal could not be confirmed. Reopen this review to check its current status.');return;
    }
    showToast(name==='publish_resource73'?'Reviewed version published.':'Withdrawn from the current HopeBot directory.','success');
    await load();
    if(current())await onChanged();
   }catch{fail('Could not confirm the change. Your entries are kept. Reopen the review to check its current status.');}
   finally{busy=false;if(current()&&form.isConnected)buttons.forEach(b=>b.disabled=b.type==='submit'&&!!blocked);}
  }
  form.addEventListener('submit',e=>{
   e.preventDefault();if(!form.reportValidity()||blocked)return;
   const value=k=>el.querySelector('#'+k).value.trim();
   act('publish_resource73',{p_id:id,p_expected_digest:d.digest,p_source_url:value('pub73-url'),
    p_source_title:value('pub73-title'),p_source_date:value('pub73-source-date'),p_checked_on:value('pub73-checked')});
  });
  el.querySelector('[data-pub-withdraw]')?.addEventListener('click',()=>act('withdraw_resource73',{p_id:id}));
 }
 await load();
}
