import { getSupabase } from '../supabase.js';
import { getCurrentUser, getCurrentProfile, getRealProfile, isImpersonating } from '../auth.js';
import { sanitize } from '../utils/validators.js';
import { showModal } from './modal.js';
import { showToast } from './toast.js';

const mounts = new WeakMap(), SIZE = 25;
const idle = new Set(['draft', 'cancelled', 'missed', 'sent']);
const labels = { draft:'Draft', cancelled:'Stopped', missed:'Missed', sent:'Sent', scheduled:'Scheduled', sending:'Sending', awaiting_approval:'Waiting for WhatsApp approval' };
const audience = { connected_week:'Families we spoke to this week', connected_15:'Families last spoken to 15+ days ago', connected_30:'Families last spoken to 30+ days ago', all_active:'All active families', interns:'Interns', hopebot_session_reminders:"HopeBot's list" };
const uuid = v => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const identity = () => JSON.stringify([getCurrentUser()?.id, getRealProfile()?.id, getCurrentProfile()?.id, isImpersonating()]);
function allowed() {
  const p=getRealProfile(), u=getCurrentUser();
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
  const day=['year','month','day'].map(k=>parts.find(x=>x.type===k)?.value).join('-');
  return !!u?.id && p?.id===u.id && getCurrentProfile()?.id===u.id && !isImpersonating() && p.is_active===true && ['admin','manager'].includes(p.role) && (!p.ends_on || p.ends_on>=day);
}
function rowHTML(b, archived) {
  const when=new Date(b.scheduled_for), stamp=Number.isFinite(when.getTime())?when.toLocaleString('en-IN',{timeZone:'Asia/Kolkata',day:'numeric',month:'short',year:'numeric',hour:'numeric',minute:'2-digit'}):'Time not recorded';
  const editable=b.status==='draft'||['scheduled','awaiting_approval'].includes(b.status)&&when-Date.now()>60000;
  const counts=['total','waiting','sent','delivered','read','failed','held','skipped','cancelled'].filter(k=>b[k]>0).map(k=>`${b[k]} ${k==='total'?'people':k==='cancelled'?'stopped':k}`);
  return `<article class="card" style="padding:16px;margin-bottom:12px;overflow-wrap:anywhere" data-message-id="${b.id}"><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><strong>${sanitize(b.title)}</strong><span class="badge badge-neutral">${sanitize(labels[b.status]||b.status)}</span>${archived?'<span class="badge badge-neutral">Archived</span>':''}</div><p style="margin:6px 0">${sanitize(stamp)} India time · ${sanitize(audience[b.audience_kind]||b.audience_kind)}</p><p class="due-meta">${sanitize(String(b.template_name||'').replaceAll('_',' '))}${b.created_by_name?' · by '+sanitize(b.created_by_name):''}</p><p class="due-meta">${counts.map(sanitize).join(' · ')}</p><div style="display:flex;gap:8px;flex-wrap:wrap">${archived?'<button class="btn btn-secondary btn-sm" data-action="restore">Restore to current</button>':`${editable?'<button class="btn btn-secondary btn-sm" data-action="edit">Edit</button>':''}${['draft','scheduled','sending','awaiting_approval'].includes(b.status)?'<button class="btn btn-ghost btn-sm" data-action="stop">Stop</button>':''}${idle.has(b.status)?'<button class="btn btn-ghost btn-sm" data-action="archive">Archive</button>':''}`}</div></article>`;
}
export async function mountBroadcastArchive66(container, { onEdit }) {
  const root=container.querySelector('#wb-list');
  const old=mounts.get(container); if(old)old.disposed=true;
  const state={root,container,onEdit,archived:false,offset:0,generation:0,busy:false,identity:identity(),hash:location.hash,disposed:false};
  mounts.set(container,state);
  if(!allowed()){root.textContent='Only an active manager or admin can open WhatsApp messages.';return;}
  root.innerHTML='<div role="group" aria-label="Message views" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px"><button class="btn btn-secondary btn-sm" data-view="current" aria-pressed="true">Current messages</button><button class="btn btn-ghost btn-sm" data-view="archived" aria-pressed="false">Archived</button></div><p data-explanation style="font-size:13px;line-height:1.5;color:var(--ink-2)">Archive hides a draft, stopped or completed message from this list. Delivery history stays available.</p><div data-rows aria-live="polite"></div><div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap"><button class="btn btn-secondary btn-sm" data-prev>Previous</button><span data-page></span><button class="btn btn-secondary btn-sm" data-next>Next</button></div>';
  root.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>{if(!current(state)||state.busy)return;state.archived=b.dataset.view==='archived';state.offset=0;load(state);}));
  root.querySelector('[data-prev]').addEventListener('click',()=>{if(current(state)&&!state.busy){state.offset=Math.max(0,state.offset-SIZE);load(state);}});
  root.querySelector('[data-next]').addEventListener('click',()=>{if(current(state)&&!state.busy){state.offset+=SIZE;load(state);}});
  await load(state);
}
function current(s) {return !s.disposed&&mounts.get(s.container)===s&&s.root.isConnected&&s.container.contains(s.root)&&identity()===s.identity&&location.hash===s.hash&&allowed();}
function controls(s,loading=false) {
  s.root.querySelectorAll('[data-view]').forEach(b=>{const selected=(b.dataset.view==='archived')===s.archived;b.disabled=s.busy;b.setAttribute('aria-pressed',String(selected));b.className='btn btn-sm '+(selected?'btn-secondary':'btn-ghost');});
  s.root.querySelector('[data-prev]').disabled=s.busy||loading||s.offset===0;
  s.root.querySelector('[data-next]').disabled=s.busy||loading||!s.more;
  s.root.querySelector('[data-explanation]').textContent=s.archived?'Restoring only returns a message to the current list. It does not schedule or send it. Delivery history is preserved.':'Archive hides a draft, stopped or completed message from this list. Delivery history stays available.';
}
async function load(s) {
  if(!current(s))return;
  const generation=++s.generation, offset=s.offset, archived=s.archived;
  const box=s.root.querySelector('[data-rows]');box.textContent='Loading messages...';s.more=false;controls(s,true);
  let data,error;
  try{({data,error}=await getSupabase().rpc('broadcasts_list66',{p_archived:archived,p_offset:offset,p_limit:SIZE}));}catch(e){error=e;}
  if(!current(s)||generation!==s.generation)return;
  const valid=!error&&data&&Array.isArray(data.rows)&&data.rows.length<=SIZE&&typeof data.has_more==='boolean'&&data.offset===offset&&data.limit===SIZE&&data.rows.every(b=>uuid(b.id)&&typeof b.title==='string'&&typeof b.status==='string'&&(!archived||idle.has(b.status)))&&new Set(data.rows.map(b=>b.id)).size===data.rows.length;
  if(!valid){box.innerHTML='<div class="card" style="padding:20px"><p>Could not load messages. Please retry.</p><button class="btn btn-secondary" data-retry>Retry</button></div>';box.querySelector('[data-retry]').onclick=()=>{if(!s.busy)load(s);};s.root.querySelector('[data-page]').textContent='Messages unavailable';controls(s);return;}
  // Deleting a last page entry can leave an empty page. Move back once per request.
  if(!data.rows.length&&offset>0){s.offset=Math.max(0,offset-SIZE);return load(s);}
  s.more=data.has_more;
  box.innerHTML=data.rows.length?data.rows.map(b=>rowHTML(b,archived)).join(''):`<div class="card" style="padding:24px">${archived?'No archived messages.':'No current messages. Use New message to save a draft.'}</div>`;
  s.root.querySelector('[data-page]').textContent=data.rows.length?`Messages ${offset+1}-${offset+data.rows.length}`:'No messages';controls(s);
  box.querySelectorAll('[data-action]').forEach(button=>button.addEventListener('click',()=>{
    if(!current(s)||s.busy||generation!==s.generation)return;
    const row=data.rows.find(r=>r.id===button.closest('[data-message-id]').dataset.messageId), action=button.dataset.action;
    if(action==='edit'){s.onEdit(s.container,row);return;}
    confirmAction(s,row,action,generation);
  }));
}
function confirmAction(s,row,action,generation) {
  const restoring=action==='restore', stopping=action==='stop';
  const label=restoring?'Restore':stopping?'Stop':'Archive';
  const explanation=restoring?'This returns it to the current list with its existing status. It does not schedule or send it.':stopping?'Recipients who have not received it will be stopped.':'This hides it from the current list. Its message, recipients and delivery history remain available under Archived.';
  const modal=showModal({title:`${label} message`,content:`<p><strong>${sanitize(row.title)}</strong></p><p>${explanation}</p><p data-error role="alert"></p>`,footer:`<button class="btn btn-secondary" data-no>Cancel</button><button class="btn btn-primary" data-yes>${label}</button>`});
  modal.querySelector('[data-no]').onclick=()=>modal.closeOwnedModal();
  modal.querySelector('[data-yes]').onclick=async()=>{
    if(!modal.isCurrentModal()||!current(s)||s.busy||generation!==s.generation){modal.closeOwnedModal();return;}
    s.busy=true;modal.querySelectorAll('button').forEach(b=>b.disabled=true);controls(s);
    let error;
    try{({error}=await getSupabase().rpc(stopping?'broadcast_cancel':'broadcast_archive66',stopping?{p_id:row.id}:{p_id:row.id,p_archived:!restoring}));}catch(e){error=e;}
    s.busy=false;
    if(!current(s)){modal.closeOwnedModal();return;}
    controls(s);
    if(error){if(modal.isCurrentModal()){modal.querySelector('[data-error]').textContent='Could not save this change. Reload the list and retry.';modal.querySelector('[data-yes]').disabled=true;modal.querySelector('[data-no]').disabled=false;}return;}
    modal.closeOwnedModal();showToast(restoring?'Restored. Nothing was scheduled or sent.':stopping?'Message stopped.':'Archived. Delivery history is preserved.','success');await load(s);
  };
}
export async function reloadBroadcastArchive66(container) {
  const state=mounts.get(container);if(state&&current(state)){state.archived=false;state.offset=0;await load(state);}
}
