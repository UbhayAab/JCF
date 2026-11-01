import { getSupabase } from '../supabase.js';
import { getCurrentUser, getCurrentProfile, getRealProfile, isImpersonating } from '../auth.js';
import { sanitize } from '../utils/validators.js';

const ROLES = ['admin','manager','caller','caregiver_mentor','therapist','nutritionist','content'];
const DAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
const STATUS = { unread:'Unread',upcoming:'Upcoming',acknowledged:'Acknowledged',missed:'Missed',cancelled:'Stopped' };
const mounts = new WeakMap();
const esc = value => sanitize(value == null ? '' : String(value));
const when = value => new Date(value).toLocaleString('en-IN', { timeZone:'Asia/Kolkata',dateStyle:'medium',timeStyle:'short' }) + ' IST';
const indiaDay = date => new Date(date.getTime() + 330 * 60000).toISOString().slice(0,10);
export function safeContentLink20(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !u.port && /^[a-z0-9][a-z0-9.-]*$/i.test(u.hostname) && !/[\s<>\x00-\x1f]/.test(value) ? u.href : null; } catch { return null; }
}
export function captureContentActor20(manager = false) {
  const id = getCurrentUser()?.id;
  return () => {
    const p = getRealProfile();
    return !!id && getCurrentUser()?.id === id && !isImpersonating() && getCurrentProfile()?.id === id && p?.id === id
      && p.is_active === true && p.must_change_password !== true && ROLES.includes(p.role)
      && (!manager || ['admin','manager'].includes(p.role)) && (!p.ends_on || p.ends_on >= indiaDay(new Date()));
  };
}
function contentHTML(items) {
  return (items || []).map((item,i) => `<section style="padding:12px 0;border-top:1px solid var(--line)"><strong>Piece ${i+1}</strong><p style="white-space:pre-wrap;margin:6px 0;overflow-wrap:anywhere">${esc(item.body)}</p>${[['link_url','Open content'],['audio_url','Open audio']].map(([key,label]) => safeContentLink20(item[key]) ? `<a href="${esc(safeContentLink20(item[key]))}" target="_blank" rel="noopener noreferrer" style="margin-right:16px">${label}</a>` : '').join('')}</section>`).join('');
}
const card = 'class="card" style="padding:18px;margin:14px 0;min-width:0;overflow-wrap:anywhere"';

export async function renderStaffReminders20(container) {
  const actor = captureContentActor20(), manager = captureContentActor20(true), token = {}, route = window.location.hash;
  mounts.set(container,token);
  if (!actor()) { container.textContent = 'Exit Open as and use your active signed-in staff account to open reminders.'; return; }
  container.innerHTML = `<style>[data-plan-form] [hidden] { display:none !important; }</style><div class="page-header"><div><h1>Staff reminders</h1><p class="header-subtitle">Your content plans and reminders, in India time.</p></div></div>
    <p>Reminders stay in your account when this page is closed. Refresh to check what is due. Missed reminders remain in history.</p>
    <section ${card}><div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap"><h2 style="margin:0">For you</h2><strong data-unread></strong><button class="btn btn-secondary btn-sm" type="button" data-refresh>Refresh reminders</button></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin:14px 0" data-filters>${['unread','upcoming','all'].map(v=>`<button type="button" class="btn btn-secondary btn-sm" data-view="${v}" aria-pressed="${v==='unread'}">${v==='all'?'All history':STATUS[v]}</button>`).join('')}</div><div data-inbox role="status">Loading reminders...</div><div data-paging style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"></div></section>
    ${manager() ? `<section ${card}><div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap"><h2 style="margin:0">Reusable content</h2><button type="button" class="btn btn-primary btn-sm" data-new>New content block</button><button type="button" class="btn btn-secondary btn-sm" data-library-refresh>Refresh content and plans</button></div><p>Save ordered content pieces once, then reuse a fixed version in one-off or weekly staff plans. Editing creates a new version; existing plans keep their original content.</p><div data-library>Loading content...</div></section><section data-editor></section><section ${card}><h2>Staff plans</h2><div data-plans>Loading plans...</div></section><section data-schedule></section>` : ''}`;
  const marker = container.querySelector('[data-inbox]');
  const current = () => mounts.get(container) === token && container.isConnected && marker.isConnected && container.contains(marker) && window.location.hash === route && actor();
  const managerCurrent = () => current() && manager();
  const sb = getSupabase();
  let view = 'unread', offset = 0, inboxGeneration = 0, libraryGeneration = 0, library;
  const rpc = async (name,args={}) => { const r = await sb.rpc(name,args); if (r.error) throw r.error; return r.data; };
  const errorText = error => error?.code && /^[0-9A-Z]{5}$/.test(error.code) ? error.message : 'The result could not be confirmed. Retry the same request before creating another.';
  function fail(mount,message) { mount.innerHTML = `<p role="alert" style="color:var(--danger)">${esc(message)}</p>`; }
  async function loadInbox() {
    if (!current()) return;
    const generation = ++inboxGeneration;
    marker.textContent = 'Loading reminders...'; container.querySelector('[data-paging]').replaceChildren();
    try {
      const data = await rpc('content_reminders20',{p_view:view,p_offset:offset});
      if (!current() || generation !== inboxGeneration) return;
      if (!data || !Array.isArray(data.items)) throw new Error('Invalid inbox');
      container.querySelector('[data-unread]').textContent = `${data.unread} unread`;
      marker.innerHTML = data.items.length ? data.items.map((r,i)=>`<article ${card}><div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><h3 style="margin:0">${esc(r.title)}</h3><span class="badge badge-${r.status==='unread'?'primary':'neutral'}">${esc(STATUS[r.status]||'Unknown')}</span></div><p>${esc(r.plan_title)} - content v${esc(r.version)}<br>Trigger: ${esc(when(r.due_at))}<br>Reminder: ${esc(when(r.remind_at))}<br>Completion window ends: ${esc(when(r.expires_at))}</p>${contentHTML(r.items)}${r.status==='unread'?`<button class="btn btn-primary btn-sm" type="button" data-ack="${i}">Acknowledge reminder</button>`:r.acknowledged_at?`<p>Acknowledged ${esc(when(r.acknowledged_at))}</p>`:''}<div data-row-error></div></article>`).join('') : `<p>No ${view==='all'?'saved':view} reminders.</p>`;
      marker.querySelectorAll('[data-ack]').forEach(button => button.onclick = async () => {
        if (!current() || generation !== inboxGeneration || button.disabled) return;
        const row = data.items[Number(button.dataset.ack)], error = button.parentElement.querySelector('[data-row-error]');
        button.disabled = true;
        try { const result = await rpc('content_reminder_ack20',{p_id:row.id}); if (!current() || generation !== inboxGeneration) return; if (!result?.ok) throw new Error('Unconfirmed'); await loadInbox(); }
        catch(e) { if (current() && generation === inboxGeneration && button.isConnected) { fail(error,errorText(e));button.disabled=false;button.textContent='Retry acknowledgement'; } }
      });
      const paging = container.querySelector('[data-paging]');
      paging.innerHTML = `<span>${data.total ? offset+1 : 0}-${Math.min(offset+data.items.length,data.total)} of ${Number(data.total)||0}</span>${offset ? '<button class="btn btn-secondary btn-sm" type="button" data-prev>Previous</button>' : ''}${offset+data.items.length<data.total?'<button class="btn btn-secondary btn-sm" type="button" data-next>Next</button>':''}<small>Checked ${esc(when(data.server_now))}</small>`;
      paging.querySelector('[data-prev]')?.addEventListener('click',()=>{if(current()){offset=Math.max(0,offset-50);loadInbox();}});
      paging.querySelector('[data-next]')?.addEventListener('click',()=>{if(current()){offset+=50;loadInbox();}});
    } catch { if (current() && generation === inboxGeneration) fail(marker,'Could not load reminders. Use Refresh reminders to try again.'); }
  }
  container.querySelector('[data-refresh]').onclick = loadInbox;
  container.querySelectorAll('[data-view]').forEach(button => button.onclick = () => { if (!current()) return; view=button.dataset.view;offset=0;container.querySelectorAll('[data-view]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));loadInbox(); });

  // Request IDs remain bound to frozen form values while an uncertain write is retried.
  function writer(form,button,operation,onDone) {
    let pending = null, busy = false;
    return async payload => {
      if (!managerCurrent() || !form.isConnected || busy) return;
      busy=true;
      if (!pending) pending={...payload,request_id:crypto.randomUUID()};
      form.querySelectorAll('input,textarea,select,button').forEach(el=>el.disabled=true);
      button.disabled=true;button.textContent='Saving...';
      const error = form.querySelector('[data-save-error]');error.replaceChildren();
      try {
        const result = await rpc(operation,{p:pending});
        if (!managerCurrent() || !form.isConnected) return;
        if (!result?.ok) throw new Error('Unconfirmed');
        pending=null;await onDone(result);
      } catch(e) {
        if (!managerCurrent() || !form.isConnected) return;
        fail(error,errorText(e));
        if (e?.code && /^[0-9A-Z]{5}$/.test(e.code)) { pending=null;form.querySelectorAll('input,textarea,select,button').forEach(el=>el.disabled=false);button.textContent='Try saving again'; }
        else { button.disabled=false;button.textContent='Retry same save'; }
      } finally { busy=false; }
    };
  }
  async function loadLibrary() {
    if (!managerCurrent()) return;
    const generation = ++libraryGeneration, mount = container.querySelector('[data-library]'), plans = container.querySelector('[data-plans]');
    try {
      const data = await rpc('content_library20');
      if (!managerCurrent() || generation !== libraryGeneration) return;
      if (!data || !Array.isArray(data.blocks) || !Array.isArray(data.staff) || !Array.isArray(data.plans)) throw new Error('Invalid library');
      library = data;
      mount.innerHTML = data.blocks.length ? data.blocks.map((b,i)=>`<article ${card}><h3>${esc(b.title)} <small>v${esc(b.revision)}</small></h3>${contentHTML(b.items)}<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px"><button type="button" class="btn btn-secondary btn-sm" data-edit="${i}">Edit as new version</button><button type="button" class="btn btn-primary btn-sm" data-plan="${i}">Schedule staff reminders</button>${b.wording_id?`<button type="button" class="btn btn-secondary btn-sm" data-wording="${i}">Review linked WhatsApp wording</button>`:''}</div><div data-wording-error></div></article>`).join('') : '<p>No content blocks yet. Create one to start.</p>';
      mount.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>{if(managerCurrent())editBlock(data.blocks[Number(b.dataset.edit)]);});
      mount.querySelectorAll('[data-plan]').forEach(b=>b.onclick=()=>{if(managerCurrent())editPlan(data.blocks[Number(b.dataset.plan)]);});
      mount.querySelectorAll('[data-wording]').forEach(button=>button.onclick=async()=>{
        if (!managerCurrent() || button.disabled) return; button.disabled=true;
        const b=data.blocks[Number(button.dataset.wording)], error=button.parentElement.parentElement.querySelector('[data-wording-error]');
        try {
          const preset=await rpc('content_wording20',{p_version:b.version_id});
          if (!managerCurrent() || !button.isConnected) return;
          const module=await import('./broadcasts.js');
          if (managerCurrent() && button.isConnected) await module.openBroadcastComposer(container,null,preset);
        }catch(e){if(managerCurrent()&&button.isConnected)fail(error,errorText(e));}
        finally{if(managerCurrent()&&button.isConnected)button.disabled=false;}
      });
      plans.innerHTML = data.plans.length ? data.plans.map((p,i)=>`<article ${card}><h3>${esc(p.title)}</h3><p>${esc(p.block_title)} v${esc(p.version)}<br>${esc(p.config.mode==='once'?'One-off':(p.config.weekdays||[]).map(n=>DAYS[n-1]).join(', '))}: ${esc(p.config.first_day)} to ${esc(p.config.last_day)}, ${esc(p.config.local_time)} IST<br>Staff: ${esc((p.staff||[]).map(s=>s.name+(s.eligible?'':' (inactive)')).join(', '))}<br>Reminder ${p.config.lead_minutes===0?'at trigger':esc(p.config.lead_minutes)+' minutes before'}; completion window ${esc(p.config.grace_minutes)} minutes<br>${esc(p.acknowledged)} acknowledged of ${esc(p.reminders)} reminders${p.next_due?'<br>Next remaining trigger: '+esc(when(p.next_due)):''}</p>${p.cancelled_at?`<strong>Stopped ${esc(when(p.cancelled_at))}. Earlier history is retained.</strong>`:`<button class="btn btn-secondary btn-sm" type="button" data-stop="${i}">Stop future reminders</button><div data-stop-error></div>`}</article>`).join('') : '<p>No staff plans yet.</p>';
      plans.querySelectorAll('[data-stop]').forEach(button=>{
        const p=data.plans[Number(button.dataset.stop)], request={id:p.id,request_id:crypto.randomUUID()};
        button.onclick=async()=>{
          if(!managerCurrent()||button.disabled)return;
          button.disabled=true;
          try { const r=await rpc('content_plan_cancel20',{p:request});if(!managerCurrent()||!button.isConnected)return;if(!r?.ok)throw new Error('Unconfirmed');await Promise.all([loadLibrary(),loadInbox()]); }
          catch(e){if(managerCurrent()&&button.isConnected){fail(button.parentElement.querySelector('[data-stop-error]'),errorText(e));button.disabled=false;button.textContent='Retry stopping this plan';}}
        };
      });
    }catch{if(managerCurrent()&&generation===libraryGeneration){fail(mount,'Could not load content. Use Refresh content and plans to retry.');fail(plans,'Could not load plans.');}}
  }
  function editBlock(existing=null) {
    if (!managerCurrent() || !library) return;
    const mount=container.querySelector('[data-editor]'), items=structuredClone(existing?.items||[{body:'',link_url:null,audio_url:null}]);
    mount.innerHTML=`<form ${card} data-block-form><h2>${existing?'New content version':'New content block'}</h2><div class="form-group"><label class="form-label" for="content-title20">Block name</label><input class="form-input" id="content-title20" maxlength="120" required value="${esc(existing?.title)}"></div><div data-pieces></div><button type="button" class="btn btn-secondary btn-sm" data-add>Add content piece</button><div class="form-group" style="margin-top:16px"><label class="form-label" for="content-wording20">Linked custom WhatsApp wording (optional)</label><select class="form-select" id="content-wording20"><option value="">Staff content only</option>${(library.wordings||[]).map(w=>`<option value="${esc(w.id)}"${w.id===existing?.wording_id?' selected':''}>${esc(w.label)} - ${esc(w.language)} (${esc(w.status)})</option>`).join('')}</select><p class="form-hint">This links an immutable wording version. Sending still requires its approval and the separate contact, cost and delivery review.</p></div><div data-save-error role="status"></div><div style="display:flex;gap:10px;flex-wrap:wrap"><button class="btn btn-primary" type="submit" data-save>Save content version</button><button class="btn btn-secondary" type="button" data-close>Close editor</button></div></form>`;
    const form=mount.querySelector('form'), pieces=form.querySelector('[data-pieces]');
    const collect=()=>[...pieces.querySelectorAll('[data-piece]')].map(el=>({body:el.querySelector('textarea').value,link_url:el.querySelector('[data-link]').value||null,audio_url:el.querySelector('[data-audio]').value||null}));
    function paint(){
      pieces.innerHTML=items.map((p,i)=>`<fieldset data-piece style="margin:12px 0;padding:12px;min-width:0;border:1px solid var(--line)"><legend>Piece ${i+1}</legend><label class="form-label" for="content-body20-${i}">Content text</label><textarea class="form-input" id="content-body20-${i}" rows="4" maxlength="4000" required>${esc(p.body)}</textarea><label class="form-label" for="content-link20-${i}">Content or meeting link (HTTPS, optional)</label><input class="form-input" id="content-link20-${i}" type="url" maxlength="2000" data-link value="${esc(p.link_url)}"><label class="form-label" for="content-audio20-${i}">Recording link (HTTPS, optional)</label><input class="form-input" id="content-audio20-${i}" type="url" maxlength="2000" data-audio value="${esc(p.audio_url)}">${items.length>1?`<button type="button" class="btn btn-ghost btn-sm" data-remove="${i}">Remove piece ${i+1}</button>`:''}</fieldset>`).join('');
      pieces.querySelectorAll('[data-remove]').forEach(b=>b.onclick=()=>{if(managerCurrent()){const values=collect();values.splice(Number(b.dataset.remove),1);items.splice(0,items.length,...values);paint();}});
      form.querySelector('[data-add]').disabled=items.length>=10;
    }
    paint();
    form.querySelector('[data-add]').onclick=()=>{if(managerCurrent()&&items.length<10){items.splice(0,items.length,...collect(),{body:'',link_url:null,audio_url:null});paint();}};
    form.querySelector('[data-close]').onclick=()=>{if(managerCurrent())mount.replaceChildren();};
    const write=writer(form,form.querySelector('[data-save]'),'content_block_save20',async()=>{mount.replaceChildren();await loadLibrary();});
    form.onsubmit=event=>{event.preventDefault();if(!managerCurrent())return;const values=collect();if(values.some(p=>[p.link_url,p.audio_url].some(u=>u&&!safeContentLink20(u)))){fail(form.querySelector('[data-save-error]'),'Use complete HTTPS links without a username, password or custom port.');return;}write({id:existing?.id||null,revision:existing?.revision||null,title:form.querySelector('#content-title20').value,items:values,wording_id:form.querySelector('#content-wording20').value||null});};
    mount.scrollIntoView({block:'start',behavior:'smooth'});
  }
  function editPlan(block) {
    if(!managerCurrent()||!library)return;
    const mount=container.querySelector('[data-schedule]'), tomorrow=indiaDay(new Date(Date.now()+86400000));
    mount.innerHTML=`<form ${card} data-plan-form><h2>Schedule: ${esc(block.title)} v${esc(block.revision)}</h2><p>This plan keeps this exact content version. Staff reminders do not send WhatsApp messages.</p><div class="form-group"><label class="form-label" for="plan-title20">Plan name</label><input class="form-input" id="plan-title20" maxlength="120" required value="${esc(block.title)}"></div><div class="form-group"><label class="form-label" for="plan-mode20">Repeat</label><select class="form-select" id="plan-mode20"><option value="once">Once</option><option value="weekly">Selected weekdays</option></select></div><fieldset data-days hidden style="padding:12px;min-width:0;border:1px solid var(--line)"><legend>Weekdays</legend><div style="display:flex;gap:12px;flex-wrap:wrap">${DAYS.map((d,i)=>`<label><input type="checkbox" name="day" value="${i+1}"> ${d}</label>`).join('')}</div></fieldset><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(220px,100%),1fr));gap:12px;margin:12px 0"><div><label class="form-label" for="plan-first20">First date (India)</label><input class="form-input" type="date" id="plan-first20" required value="${tomorrow}"></div><div data-last-group hidden><label class="form-label" for="plan-last20">Last date (India)</label><input class="form-input" type="date" id="plan-last20" value="${tomorrow}"></div><div><label class="form-label" for="plan-time20">Trigger time (India)</label><input class="form-input" type="time" id="plan-time20" required value="11:00" step="60"></div><div><label class="form-label" for="plan-lead20">Remind before trigger (minutes)</label><input class="form-input" type="number" min="0" max="10080" step="1" id="plan-lead20" required value="30"><small>Use 0 for At trigger.</small></div><div><label class="form-label" for="plan-grace20">Completion window (minutes)</label><input class="form-input" type="number" min="1" max="1440" step="1" id="plan-grace20" required value="60"></div></div><fieldset style="padding:12px;min-width:0;border:1px solid var(--line)"><legend>Named staff who receive reminders (1 to 30)</legend>${library.staff.map(s=>`<label style="display:block;margin:8px 0"><input type="checkbox" name="staff" value="${esc(s.id)}"> ${esc(s.full_name)} (${esc(s.role)})</label>`).join('')}</fieldset><p>Dates can extend up to one year ahead. Unacknowledged reminders become missed when their completion window ends. Stopping a plan cancels its future triggers and keeps earlier history.</p><button class="btn btn-secondary" type="submit" data-preview>Review staff plan</button><button class="btn btn-ghost" type="button" data-close>Close plan</button><div data-review></div><div data-save-error role="status"></div><button class="btn btn-primary" type="button" data-save hidden>Confirm staff plan</button></form>`;
    const form=mount.querySelector('form'), review=form.querySelector('[data-review]'), saveButton=form.querySelector('[data-save]');
    let previewBody=null, previewGeneration=0;
    const invalidate=()=>{previewGeneration++;previewBody=null;review.replaceChildren();saveButton.hidden=true;form.querySelector('[data-preview]').disabled=false;};
    form.addEventListener('input',invalidate);form.addEventListener('change',invalidate);
    form.querySelector('#plan-mode20').addEventListener('change',()=>{const weekly=form.querySelector('#plan-mode20').value==='weekly';form.querySelector('[data-days]').hidden=!weekly;form.querySelector('[data-last-group]').hidden=!weekly;});
    form.querySelector('[data-close]').onclick=()=>{if(managerCurrent())mount.replaceChildren();};
    const write=writer(form,saveButton,'content_plan_save20',async()=>{mount.replaceChildren();await Promise.all([loadLibrary(),loadInbox()]);});
    saveButton.onclick=()=>{if(previewBody)write(previewBody);};
    form.onsubmit=async event=>{
      event.preventDefault();if(!managerCurrent())return;
      const button=form.querySelector('[data-preview]'), mode=form.querySelector('#plan-mode20').value;
      const body={version_id:block.version_id,title:form.querySelector('#plan-title20').value,mode,first_day:form.querySelector('#plan-first20').value,last_day:mode==='once'?form.querySelector('#plan-first20').value:form.querySelector('#plan-last20').value,local_time:form.querySelector('#plan-time20').value,weekdays:mode==='once'?[]:[...form.querySelectorAll('[name=day]:checked')].map(i=>Number(i.value)),staff_ids:[...form.querySelectorAll('[name=staff]:checked')].map(i=>i.value),lead_minutes:Number(form.querySelector('#plan-lead20').value),grace_minutes:Number(form.querySelector('#plan-grace20').value)};
      const generation=++previewGeneration;button.disabled=true;review.textContent='Checking the exact schedule and current team...';saveButton.hidden=true;
      try {
        const v=await rpc('content_plan_preview20',{p:body});
        if(!managerCurrent()||!form.isConnected||generation!==previewGeneration)return;
        if(!v?.preview_hash||!Array.isArray(v.occurrences)||!v.occurrences.length)throw new Error('Invalid preview');
        previewBody={...body,preview_hash:v.preview_hash};
        review.innerHTML=`<section ${card}><h3>Review before confirming</h3><p>${esc(block.title)} v${esc(block.revision)}<br>${esc(v.mode==='once'?'Once':v.weekdays.map(n=>DAYS[n-1]).join(', '))}, ${esc(v.first_day)} to ${esc(v.last_day)} at ${esc(v.local_time)} IST<br>${v.occurrences.length} triggers, ${esc(v.reminders)} staff reminders<br>Staff: ${esc(v.staff_ids.map(id=>library.staff.find(s=>s.id===id)?.full_name||'Team member').join(', '))}<br>Remind ${v.lead_minutes===0?'at trigger':esc(v.lead_minutes)+' minutes before'}; completion window ${esc(v.grace_minutes)} minutes</p><p>First: ${esc(when(v.occurrences[0].due_at))}<br>Last: ${esc(when(v.occurrences.at(-1).due_at))}</p>${contentHTML(block.items)}<p>Confirming creates persistent in-app staff reminders for this exact content version.</p></section>`;
        saveButton.hidden=false;saveButton.disabled=false;
      }catch(e){if(managerCurrent()&&form.isConnected&&generation===previewGeneration)fail(review,errorText(e));}
      finally{if(managerCurrent()&&form.isConnected&&generation===previewGeneration)button.disabled=false;}
    };
    mount.scrollIntoView({block:'start',behavior:'smooth'});
  }
  if(manager()){container.querySelector('[data-new]').onclick=()=>editBlock();container.querySelector('[data-library-refresh]').onclick=loadLibrary;}
  await Promise.all([loadInbox(),manager()?loadLibrary():Promise.resolve()]);
}
