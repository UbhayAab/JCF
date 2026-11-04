// PM authority is checked by dedicated server functions on every operation.
// Queue metadata never grants access to somebody else's clinical assignment.
import {getSupabase} from '../supabase.js';
import {getCurrentProfile,getCurrentUser,isImpersonating} from '../auth.js';
import {sanitize} from '../utils/validators.js';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid=x=>typeof x==='string'&&x.length===36&&UUID.test(x);
const validMember=r=>r&&uuid(r.id)&&typeof r.full_name==='string';
export function mountMedicalPm151(host,{isCurrent=()=>true,onAssigned=()=>{},onOpen=()=>{}}={}){
 const actor=getCurrentUser()?.id,role=getCurrentProfile()?.role,route=location.hash;
 const sb=getSupabase();let stopped=false,generation=0,busy=false,offset=0,state=null,rows=[],members=[];
 const current=()=>!stopped&&host.isConnected&&isCurrent()&&getCurrentUser()?.id===actor
  &&getCurrentProfile()?.id===actor&&getCurrentProfile()?.role===role&&getCurrentProfile()?.is_active===true
  &&getCurrentProfile()?.must_change_password!==true&&!isImpersonating()&&location.hash===route;
 const message=text=>{if(current()){const p=host.querySelector('[data-pm-message]');if(p)p.textContent=text;}};
 function unavailable(text){generation++;state=null;rows=[];members=[];if(current())host.innerHTML='<section class="card" style="padding:16px;margin:16px 0"><p role="status">'+sanitize(text)+'</p><button class="btn btn-secondary" data-pm-retry>Retry PM access</button></section>';host.querySelector('[data-pm-retry]')?.addEventListener('click',()=>void refresh());}
 async function rpc(name,args={},stamp=generation){
  if(!current())throw Error('Account changed. Reopen Medical navigation.');
  let timer;
  try{
   const answer=await Promise.race([sb.rpc(name,args),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Request timed out. Refresh before continuing.')),12000);})]);
   if(!current()||stamp!==generation)throw Error('Stale PM response ignored');
   if(answer.error)throw Error(answer.error.message||'Medical PM request failed');
   return answer.data;
  }finally{clearTimeout(timer);}
 }
 async function act(button,fn){
  if(busy||!current())return;busy=true;if(button)button.disabled=true;
  try{await fn();}catch(e){if(current()&&e.message!=='Stale PM response ignored')unavailable(e.message);}
  finally{busy=false;if(button?.isConnected)button.disabled=false;}
 }
 function shell(){
  if(!current()||!state)return;
  host.innerHTML='<section class="card" style="padding:16px;margin:16px 0;min-width:0;overflow-wrap:anywhere" data-pm151>'+
   '<h2>'+(state.can_manage?'Medical Navigator PM appointments':'Medical Navigator PM - request allocation')+'</h2>'+
   '<p>'+(state.can_manage?'Appoint a medical navigator to allocate incoming medical support requests. This does not grant general manager access.':'New and unassigned medical support requests appear here. Allocate them to an eligible medical navigator. Patient history remains limited to your own current clinical assignments.')+'</p>'+
   '<p role="status" aria-live="polite" data-pm-message></p><button class="btn btn-secondary" data-pm-refresh>Refresh '+(state.can_manage?'appointments':'requests')+'</button>'+
   '<div data-pm-content style="margin-top:16px"></div><div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px"><button class="btn btn-secondary" data-pm-prev hidden style="display:none">Previous requests</button><button class="btn btn-secondary" data-pm-next hidden style="display:none">More requests</button></div></section>';
  host.querySelector('[data-pm-refresh]').onclick=e=>act(e.target,()=>refresh(true));
  host.querySelector('[data-pm-prev]').onclick=e=>act(e.target,async()=>{offset=Math.max(0,offset-50);await refresh();});
  host.querySelector('[data-pm-next]').onclick=e=>act(e.target,async()=>{offset+=50;await refresh();});
 }
 function renderRoster(){
  const body=host.querySelector('[data-pm-content]');
  body.innerHTML=members.length?members.map((m,i)=>'<div style="padding:12px 0;border-bottom:1px solid var(--line);display:flex;gap:12px;flex-wrap:wrap;align-items:center"><div style="flex:1;min-width:140px"><strong>'+sanitize(m.full_name)+'</strong><p style="margin:4px 0">'+(m.is_pm?'Medical Navigator PM':'Medical Navigator')+(!m.eligible?' - inactive, expired or account setup incomplete':'')+'</p></div><button type="button" class="btn btn-secondary" data-pm-appoint="'+i+'" '+(!m.is_pm&&!m.eligible?'disabled':'')+'>'+(m.is_pm?'Remove PM appointment':'Appoint as PM')+'</button></div>').join(''):'<p>No medical navigators are registered yet. Add their medical navigator accounts in User management first.</p>';
  body.querySelectorAll('[data-pm-appoint]').forEach(button=>button.onclick=()=>act(button,async()=>{
   const member=members[Number(button.dataset.pmAppoint)];if(!member)return;
   await rpc('medical_navigation_pm_set151',{p_user:member.id,p_enabled:!member.is_pm});await refresh();message('PM appointment updated. Existing clinical assignments are unchanged.');
  }));
 }
 function renderQueue(result){
  const body=host.querySelector('[data-pm-content]');
  body.innerHTML='<p class="text-muted">Eligible active medical navigators are shown below; anyone explicitly marked unavailable today is excluded. This is not a live online-status indicator.</p>'+
   (rows.length?rows.map((q,i)=>'<article style="padding:16px 0;border-bottom:1px solid var(--line)"><h3>'+sanitize(q.full_name)+'</h3><p>'+sanitize(q.patient_code||'')+' - '+sanitize(q.assignee_name||'Unassigned')+'</p><p style="white-space:pre-wrap">'+sanitize(q.reason)+'</p><form data-pm-assign="'+i+'" style="display:flex;gap:10px;flex-wrap:wrap;align-items:end"><label style="flex:1;min-width:0">Assign medical navigator<select name="assignee" class="form-select" style="width:100%;max-width:100%">'+(q.assigned_to&&!members.some(m=>m.id===q.assigned_to)?'<option value="keep" selected disabled>Choose a change (current assignee unavailable)</option>':'')+'<option value="">Unassigned</option>'+members.map(m=>'<option value="'+m.id+'" '+(m.id===q.assigned_to?'selected':'')+'>'+sanitize(m.full_name)+'</option>').join('')+'</select></label><button class="btn btn-primary" type="submit">Save assignment</button></form>'+
    (!members.length?'<p>No eligible medical navigator is available right now. Refresh after availability or account setup is updated.</p>':'')+
    (q.assigned_to&&!members.some(m=>m.id===q.assigned_to)?'<p>The current assignee is no longer eligible for new assignments. Choose another navigator or explicitly unassign.</p>':'')+
    (q.can_open===true?'<button type="button" class="btn btn-secondary" data-pm-open="'+i+'" style="margin-top:12px">Open my clinical assignment</button>':'')+'</article>').join(''):'<p>No eligible open medical requests right now. New requests will appear after refresh; no request has been marked completed.</p>');
  for(const[selector,hidden]of[['[data-pm-prev]',offset===0],['[data-pm-next]',!result.has_more]]){const b=host.querySelector(selector);b.hidden=hidden;b.style.display=hidden?'none':'';}
  body.querySelectorAll('[data-pm-assign]').forEach(form=>form.onsubmit=e=>{e.preventDefault();void act(form.querySelector('button'),async()=>{
   const row=rows[Number(form.dataset.pmAssign)];if(!row)return;
   const assignee=form.elements.assignee.value||null;
   if(assignee!==null&&!members.some(m=>m.id===assignee))throw Error('Refresh and choose an eligible medical navigator.');
   await rpc('medical_navigation_pm_assign151',{p_request:row.id,p_assignee:assignee,p_version:row.version});await refresh();await onAssigned();message('Assignment saved. The current assignee can open the medical work.');
  });});
  body.querySelectorAll('[data-pm-open]').forEach(button=>button.onclick=()=>act(button,async()=>{const row=rows[Number(button.dataset.pmOpen)];if(row?.can_open===true)await onOpen(row.id);}));
 }
 async function refresh(reset=false){
  if(!current())return;if(reset)offset=0;const stamp=++generation;
  try{
   const next=await rpc('medical_navigation_pm_state151',{},stamp);
   if(!next||typeof next.is_pm!=='boolean'||typeof next.can_manage!=='boolean')throw Error('PM authority could not be confirmed.');
   state=next;rows=[];members=[];
   if(!state.can_manage&&!state.is_pm){host.replaceChildren();return;}
   shell();message('Checking current permissions and assignments...');
   if(state.can_manage){
    const data=await rpc('medical_navigation_pm_roster151',{},stamp);
    if(!Array.isArray(data)||data.some(m=>!validMember(m)||typeof m.is_pm!=='boolean'||typeof m.eligible!=='boolean'))throw Error('The medical navigator roster was incomplete.');
    members=data;renderRoster();
   }else{
    const data=await rpc('medical_navigation_pm_assignees151',{},stamp);
    if(!Array.isArray(data)||data.some(m=>!validMember(m)))throw Error('The eligible navigator list was incomplete.');members=data;
    const result=await rpc('medical_navigation_pm_queue151',{p_offset:offset},stamp);
    if(!result||!Array.isArray(result.rows)||typeof result.has_more!=='boolean'||result.rows.some(q=>!q||!uuid(q.id)||!uuid(q.patient_id)||!Number.isSafeInteger(q.version)||q.version<1||typeof q.full_name!=='string'||typeof q.reason!=='string'||(q.assigned_to!==null&&!uuid(q.assigned_to))||typeof q.can_open!=='boolean'))throw Error('The PM request queue was incomplete.');
    rows=result.rows;renderQueue(result);
   }
   message('');
  }catch(e){if(current()&&stamp===generation&&e.message!=='Stale PM response ignored')unavailable(e.message);}
 }
 const recheck=()=>{if(current()&&!busy&&!document.hidden)void refresh();};
 const timer=setInterval(recheck,30000);window.addEventListener('focus',recheck);document.addEventListener('visibilitychange',recheck);
 const dispose=()=>{stopped=true;generation++;state=null;rows=[];members=[];clearInterval(timer);window.removeEventListener('focus',recheck);document.removeEventListener('visibilitychange',recheck);host.replaceChildren();};
 if(current())void refresh();
 return{refresh,dispose};
}
