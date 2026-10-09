import { getSupabase } from '../supabase.js';
import { showModal, closeModal, confirmModal } from './modal.js';
import { showToast } from './toast.js';
import { sanitize } from '../utils/validators.js';
import { CIRCLE_FIELDS, DEFAULT_CIRCLE_BODY, CIRCLE_EXAMPLES, circlePreview } from '../utils/circleMessage.js';

const LABELS = { draft:'Draft wording',requested:'Waiting for submission',submitting:'Submitting to WhatsApp',pending:'WhatsApp review',approved:'Approved',rejected:'Rejected',error:'Submission needs retry' };
export async function renderCircleMessages(container) {
  const {openBroadcastComposer,renderBroadcasts}=await import('../pages/broadcasts.js?v=20261010b');
  container.innerHTML = `<section class="card" style="padding:20px;margin-bottom:20px;overflow-wrap:anywhere">
    <div style="display:flex;gap:12px;justify-content:space-between;align-items:center;flex-wrap:wrap"><div><h2>Invitations and schedules</h2><p>Write your own circle invitation, add the meeting link, then choose who gets it and when.</p></div>
      <button class="btn btn-primary" id="circle-new" disabled>Create custom wording</button></div>
    <p style="color:var(--ink-2)">New wording goes to WhatsApp for approval. You can schedule ahead while it is reviewed. If approval is not ready by the delivery time, the message is marked missed and is not sent late. Family delivery still follows HopeBot consent, STOP and sending controls.</p>
    <div id="circle-wordings">Loading wording...</div>
    <button class="btn btn-secondary" id="circle-approved" disabled>Use the approved session invitation</button>
    <button class="btn btn-ghost" id="circle-refresh" disabled>Refresh approval status</button>
  </section><div id="circle-broadcasts"></div>`;
  const {data,error}=await getSupabase().from('wa_circle_templates').select('*').order('created_at',{ascending:false}).limit(100);
  if (!container.isConnected) return;
  container.querySelector('#circle-wordings').innerHTML=error ? `<p>${sanitize(error.message)}</p>` : (data||[]).map(t => `<div style="padding:12px 0;border-top:1px solid var(--line)">
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><strong>${sanitize(t.label)}</strong><span class="badge badge-${t.status==='approved'?'ok':'neutral'}">${LABELS[t.status]||sanitize(t.status)}</span><span>v${t.version} · ${t.language==='hi'?'Hindi':'English'}</span></div>
    ${t.reason ? `<p style="color:var(--ink-2)">${sanitize(t.reason)}</p>`:''}
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
      <button class="btn btn-secondary btn-sm" data-circle-edit="${t.id}">${t.status==='draft'?'Edit wording':'Copy to a new version'}</button>
      ${['draft','error'].includes(t.status)?`<button class="btn btn-secondary btn-sm" data-circle-submit="${t.id}">Request WhatsApp approval</button>`:''}
      ${['requested','submitting','pending','approved'].includes(t.status)?`<button class="btn btn-primary btn-sm" data-circle-use="${t.id}">Set session and delivery time</button>`:''}
    </div></div>`).join('') || '<p>No custom wording saved yet. Start with the caregiver session example and make it yours.</p>';
  const refresh=()=>renderCircleMessages(container);
  container.querySelector('#circle-new').onclick=()=>editWording(null,refresh);
  container.querySelector('#circle-refresh').onclick=refresh;
  const schedules=container.querySelector('#circle-broadcasts');
  container.querySelector('#circle-approved').onclick=()=>openBroadcastComposer(schedules,null,{template_name:'care_session_invite_v1',title:'Caregiver Therapy Session',variables:['{first_name}',CIRCLE_EXAMPLES.session_title,CIRCLE_EXAMPLES.session_date,CIRCLE_EXAMPLES.session_time,CIRCLE_EXAMPLES.joining_link]});
  container.querySelectorAll('[data-circle-edit]').forEach(b=>b.onclick=()=>editWording(data.find(t=>t.id===b.dataset.circleEdit),refresh));
  container.querySelectorAll('[data-circle-submit]').forEach(b=>b.onclick=()=>submitWording(b.dataset.circleSubmit,refresh));
  container.querySelectorAll('[data-circle-use]').forEach(b=>b.onclick=()=>{
    const t=data.find(t=>t.id===b.dataset.circleUse);
    openBroadcastComposer(schedules,null,{template_name:t.template_name,title:t.label,variables:t.examples});
  });
  container.querySelectorAll('#circle-new,#circle-approved,#circle-refresh').forEach(b=>b.disabled=false);
  await renderBroadcasts(schedules);
}

function submitWording(id,onSaved) {
  confirmModal('Submit this wording to WhatsApp? This version will be locked. Changed wording needs a new approval. This does not send a message to anyone.',async()=>{
    const {error}=await getSupabase().rpc('circle_template_submit',{p_id:id});
    if(error){showToast(error.message,'error');return;}
    showToast('Approval requested. Refresh here to see the result.','success');onSaved();
  },{title:'Request WhatsApp approval',confirmLabel:'Request approval',danger:false});
}

function editWording(existing,onSaved) {
  const examples=Object.fromEntries((existing?.parameter_keys||[]).map((k,i)=>[k,existing.examples[i]]));
  const el=document.createElement('div');
  el.innerHTML=`<p>Edit every sentence. Insert a named field where the session details should go. Approval examples below are sample values; set the actual session details when scheduling.</p>
    <div class="form-group"><label class="form-label" for="circle-label">Wording name</label><input class="form-input" id="circle-label" maxlength="120" value="${sanitize(existing?.label||'Caregiver therapy invitation')}"></div>
    <div class="form-group"><label class="form-label" for="circle-language">Message language</label><select class="form-select" id="circle-language"><option value="en">English</option><option value="hi"${existing?.language==='hi'?' selected':''}>Hindi</option></select></div>
    <div class="form-group"><label class="form-label" for="circle-body">Custom message wording</label><textarea class="form-input" id="circle-body" rows="11" maxlength="1024">${sanitize(existing?.source_body||DEFAULT_CIRCLE_BODY)}</textarea></div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">${Object.entries(CIRCLE_FIELDS).map(([k,l])=>`<button class="btn btn-ghost btn-sm" data-insert="${k}">${l}</button>`).join('')}</div>
    <p class="form-hint">Include the joining link field or a complete meeting link, plus a STOP instruction. A literal link is locked after approval; use the joining link field to change it for each session. Saving adds a STOP line if needed. Only the language you write is submitted.</p>
    ${Object.entries(CIRCLE_FIELDS).map(([k,l])=>`<div class="form-group"><label class="form-label" for="circle-example-${k}">${l} example</label><input class="form-input" id="circle-example-${k}" maxlength="500" ${k==='joining_link'?'type="url"':''} value="${sanitize(examples[k]||CIRCLE_EXAMPLES[k])}"></div>`).join('')}
    <label class="form-label">Preview</label><div class="card" id="circle-preview" style="padding:16px;white-space:pre-wrap;overflow-wrap:anywhere"></div>
    <button class="btn btn-primary" id="circle-save" style="margin-top:16px">Save wording draft</button>`;
  showModal({title:existing?.status==='draft'?'Edit circle wording':'Custom circle wording',content:el,size:'lg'});
  const values=()=>Object.fromEntries(Object.keys(CIRCLE_FIELDS).map(k=>[k,el.querySelector(`#circle-example-${k}`).value.trim()]));
  const paint=()=>{el.querySelector('#circle-preview').textContent=circlePreview(el.querySelector('#circle-body').value,values());};
  el.querySelectorAll('input,textarea').forEach(i=>i.oninput=paint);
  el.querySelectorAll('[data-insert]').forEach(b=>b.onclick=()=>{const input=el.querySelector('#circle-body');input.setRangeText(`{${b.dataset.insert}}`,input.selectionStart,input.selectionEnd,'end');input.focus();paint();});
  el.querySelector('#circle-save').onclick=async e=>{
    e.target.disabled=true;
    const {error}=await getSupabase().rpc('circle_template_save',{p:{id:existing?.status==='draft'?existing.id:null,label:el.querySelector('#circle-label').value,source_body:el.querySelector('#circle-body').value,language:el.querySelector('#circle-language').value,examples:values()}});
    e.target.disabled=false;if(error){showToast(error.message,'error');return;}
    closeModal();showToast('Wording saved. Request approval when ready.','success');onSaved();
  };
  paint();
}
