// Exact nutrition request outcomes and activity links. No free-text inference.
import { getSupabase } from '../supabase.js';
import { getCurrentUser, isImpersonating } from '../auth.js';
import { sanitize } from '../utils/validators.js';
import { showModal } from './modal.js';
import { showToast } from './toast.js';
import * as nutritionRequests from './nutritionRequest.js';

export const RESOLUTION_REASONS = { plan_shared: 'Plan shared for this request', query_addressed: 'Question or concern addressed', existing_plan: 'Existing plan is sufficient', no_intervention: 'No dietary intervention needed', other: 'Other resolved need' };
const day = value => value ? new Date(value).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium' }) : 'Date unknown';
const operationId = () => crypto.randomUUID();
const accountGuard = current => { const id = getCurrentUser()?.id; return () => !!id && getCurrentUser()?.id === id && !isImpersonating() && current(); };
const supportedRow = row => row?.can_record_plan_outcome === true && row?.status !== 'closed' && !!row.updated_at;
const safeReply = (data, row) => data?.ok === true && data.request_id === row.id && !!data.action_id;
const needLabel = row => nutritionRequests.NUTRITION_REASONS?.[row.reason] || 'Nutrition support';
function followupSnapshot(items, id) {
  const item = (items || []).find(x => x.call_id === id), version = item?.schedule_version;
  if (!item || !/^\d+$/.test(String(version ?? '')) || !/^\d{4}-\d{2}-\d{2}$/.test(item.due_on || ''))
    throw new Error('This follow-up needs a fresh schedule. Refresh the tracker before linking it.');
  return { version: String(version), due: item.due_on };
}

export function openNutritionResolution({ row, isCurrent, onSaved = async () => {} }) {
  const current = accountGuard(isCurrent);
  if (!current() || !supportedRow(row)) return;
  const actor = getCurrentUser()?.id, operation = operationId(), evidence = (row.completion_evidence || []).filter(x => ['ledger_event', 'service_flag'].includes(x.kind));
  const modal = showModal({ title: 'Close nutrition request', content: `<form class="nw-form" data-resolution-form>
    <p><strong>${sanitize(row.patient_name || 'This patient')}</strong> - request raised ${sanitize(day(row.raised_at))}.</p>
    <p class="nw-muted">Close only this resolved need. Closing does not send a message or change any separately scheduled follow-up.</p>
    <div class="form-group"><label class="form-label" for="nutrition-resolution-reason">How was this request resolved?</label><select class="form-select" id="nutrition-resolution-reason" required><option value="">Choose a resolution</option>${Object.entries(RESOLUTION_REASONS).map(([value,label]) => `<option value="${value}">${label}</option>`).join('')}</select></div>
    <div class="form-group"><label class="form-label" for="nutrition-resolution-evidence">Previously recorded plan or support</label><select class="form-select" id="nutrition-resolution-evidence"><option value="">No saved plan evidence selected</option>${evidence.map((x,i) => `<option value="${i}">${sanitize(x.label)} - ${sanitize(day(x.occurred_on))}</option>`).join('')}</select><p class="nw-muted">A date or old checkbox alone does not prove it resolved this request. Confirm its relevance below. For an older plan, choose Existing plan is sufficient.</p></div>
    <div class="form-group"><label class="form-label" for="nutrition-resolution-note">Resolution note (required)</label><textarea class="form-input" id="nutrition-resolution-note" maxlength="2000" rows="3" required></textarea></div>
    <label class="nw-attestation"><input type="checkbox" data-resolution-confirm required><span>I confirm this exact request is resolved, the selected evidence applies, and no action for this need remains.</span></label>
    <p class="nw-error" data-resolution-error role="alert" hidden></p><div class="nw-actions"><button type="button" class="btn btn-secondary" data-resolution-cancel>Cancel</button><button type="submit" class="btn btn-primary">Close request</button></div></form>` });
  const owned = () => current() && modal.isConnected && modal.isCurrentModal();
  const form = modal.querySelector('form'), reason = form.querySelector('select'), note = form.querySelector('textarea'), source = form.querySelector('#nutrition-resolution-evidence'), message = form.querySelector('[data-resolution-error]');
  const update = () => { source.required = reason.value === 'plan_shared'; note.setCustomValidity(''); };
  reason.addEventListener('change', update); note.addEventListener('input', () => note.setCustomValidity('')); update();
  form.querySelector('[data-resolution-cancel]').onclick = () => modal.closeOwnedModal();
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (!owned()) return;
    if (!note.value.trim()) note.setCustomValidity('Explain how this need was resolved.');
    if (!form.reportValidity()) return;
    const button = form.querySelector('[type="submit"]'); if (button.disabled) return;
    const item = source.value === '' ? null : evidence[Number(source.value)];
    button.disabled = true; message.hidden = true;
    try {
      const { data, error } = await getSupabase().rpc('resolve_nutrition_request', { p_request: row.id, p_reason: reason.value, p_note: note.value.trim(), p_evidence_kind: item?.kind || null, p_evidence_id: item?.id || null, p_confirm_applies: form.querySelector('[data-resolution-confirm]').checked, p_expected_updated_at: row.updated_at, p_operation: operation, p_actor: actor });
      if (!owned()) return;
      if (error || !safeReply(data,row) || !['closed','open','assigned','called','plan_shared'].includes(data.current_status)) throw new Error('unconfirmed');
      modal.closeOwnedModal();
      showToast(data.current_status === 'closed' ? 'Resolution saved. This request is closed.' : 'The resolution was saved earlier; this request has since changed. Review its current status.', 'success');
      if (current()) await onSaved(data);
    } catch { if (owned()) { message.textContent = 'Could not confirm this resolution. Your entries are kept. Retry the same save, or refresh if the request changed.'; message.hidden = false; button.disabled = false; } }
  });
}

export async function promptNutritionCompletion({ patientId, isCurrent, mayOpen = () => true, onSaved = async () => {} }) {
  const current = accountGuard(isCurrent); if (!current()) return;
  try {
    const { data, error } = await getSupabase().rpc('get_nutrition_tracker', { p_patient_ids: [patientId] });
    if (!current() || !mayOpen()) return;
    if (error || !Array.isArray(data)) throw new Error('unavailable');
    const rows = data.filter(supportedRow); if (!rows.length) return;
    const modal = showModal({ title: 'Review the nutrition request', content: `<p>The support or call is saved. Select the exact resolved request before closing it.</p><div class="form-group"><label class="form-label" for="nutrition-completion-request">Request</label><select class="form-select" id="nutrition-completion-request"><option value="">Choose a request</option>${rows.map((r,i) => `<option value="${i}">${sanitize(day(r.raised_at))} - ${sanitize(needLabel(r))}${r.note ? ' - '+sanitize(r.note) : ''}</option>`).join('')}</select></div><div class="nw-actions"><button class="btn btn-secondary" data-completion-later>Review later</button><button class="btn btn-primary" data-completion-next disabled>Document resolution</button></div>` });
    const select = modal.querySelector('select'), next = modal.querySelector('[data-completion-next]');
    select.onchange = () => { next.disabled = select.value === ''; };
    modal.querySelector('[data-completion-later]').onclick = () => modal.closeOwnedModal();
    next.onclick = () => { if (!current() || !modal.isCurrentModal() || select.value === '') return; const row=rows[Number(select.value)]; modal.closeOwnedModal(); openNutritionResolution({row,isCurrent:current,onSaved}); };
  } catch { if (current()) showToast('The care entry is saved, but request status could not be checked. Refresh Nutrition tracker to review it.', 'warning',8000); }
}

export function mountNutritionCallLink(host, { getPatient, isCurrent, isConnected }) {
  const current = accountGuard(isCurrent); let rows=[], generation=0, loadedPatient='', loading=false;
  const paintOrigins = () => {
    const request = rows.find(r => r.id === host.querySelector('[data-nutrition-call-request]')?.value);
    const select = host.querySelector('[data-nutrition-call-origin]'); if (!select) return;
    select.innerHTML = '<option value="">Not completing an earlier scheduled activity</option>'+(request?.pending_followups || []).map(x => `<option value="${sanitize(x.call_id)}">Call ${sanitize(day(x.call_date))} - follow-up due ${sanitize(day(x.due_on))}</option>`).join('');
  };
  async function refresh() {
    const pid=getPatient(), seq=++generation; rows=[]; loadedPatient=''; loading=true;
    host.innerHTML='<p class="nw-muted" role="status">Loading optional nutrition request links...</p>';
    if (!pid) { loading=false; host.innerHTML=''; return; }
    try {
      const {data,error}=await getSupabase().rpc('get_nutrition_tracker',{p_patient_ids:[pid]});
      if (!current() || generation!==seq || getPatient()!==pid || !host.isConnected) return;
      if(error || !Array.isArray(data)) throw new Error('unavailable');
      rows=data.filter(r=>r.can_record_plan_outcome===true || r.status==='closed'); loadedPatient=pid;
      const hasWork=rows.some(r=>r.status!=='closed' || (r.pending_followups||[]).length);
      host.innerHTML=`<div class="field"><label for="nutrition-call-request">Related nutrition request${hasWork ? ' (choose the exact need)' : ' (optional)'}</label><select class="select" id="nutrition-call-request" data-nutrition-call-request><option value="">${hasWork?'Choose a request or mark this call unrelated':'No request linked'}</option>${hasWork?'<option value="__unrelated__">Unrelated call - leave all existing work pending</option>':''}${rows.map(r=>`<option value="${sanitize(r.id)}">${sanitize(day(r.raised_at))} - ${sanitize(needLabel(r))}${r.status==='closed'?' - closed need':''}</option>`).join('')}</select><div class="muted" style="font-size:12px">Choose the exact need. Logging a call does not automatically close a pending plan.</div></div><div class="field"><label for="nutrition-call-origin">Earlier follow-up completed by this connected call</label><select class="select" id="nutrition-call-origin" data-nutrition-call-origin></select></div>`;
      host.querySelector('[data-nutrition-call-request]').onchange=paintOrigins; paintOrigins();
    } catch { if(current() && generation===seq) host.innerHTML='<p class="nw-muted" role="status">Request links could not load. The call can still be saved without a link; use Nutrition tracker to link it later.</p>'; }
    finally { if(generation===seq) loading=false; }
  }
  return { refresh, fields() {
    if (!current()) throw new Error('Your session changed. Reopen this call form.');
    const request=host.querySelector('[data-nutrition-call-request]')?.value || '';
    if (request==='__unrelated__') return {};
    if (!request) { if(rows.some(r=>r.status!=='closed' || (r.pending_followups||[]).length)) throw new Error('Choose the exact nutrition request, or mark this call unrelated so existing work stays pending.'); return {}; }
    if(loading || loadedPatient!==getPatient() || !rows.some(r=>r.id===request)) throw new Error('The patient or request changed. Refresh before saving.');
    const origin=host.querySelector('[data-nutrition-call-origin]')?.value || null;
    if(origin && !isConnected()) throw new Error('An earlier activity can only be completed by a connected nutrition call. Leave it pending for an unsuccessful attempt.');
    const snapshot=origin?followupSnapshot(rows.find(r=>r.id===request)?.pending_followups,origin):null;
    return {nutrition_request_id:request,nutrition_followup_of:origin,nutrition_followup_version:snapshot?.version??null,nutrition_followup_due_on:snapshot?.due??null};
  } };
}

export async function openNutritionCallHistoryLink({row,isCurrent,onSaved=async()=>{}}) {
  const current=accountGuard(isCurrent); if(!current() || !row.updated_at || row.can_link_calls!==true) return;
  const actor=getCurrentUser()?.id,operation=operationId(),modal=showModal({title:'Link a completed nutrition call',content:'<div data-call-link-content role="status">Loading saved calls...</div>'});
  const owned=()=>current() && modal.isCurrentModal() && modal.isConnected,host=modal.querySelector('[data-call-link-content]');
  try {
    const {data,error}=await getSupabase().rpc('get_nutrition_call_context',{p_patient:row.patient_id});
    if(!owned()) return; if(error || !Array.isArray(data?.calls)) throw new Error('unavailable');
    const calls=data.calls.filter(c=>c.dial_status==='connected' && (!c.nutrition_request_id || c.nutrition_request_id===row.id) && new Date(c.call_date)>=new Date(row.raised_at));
    host.innerHTML=`<form class="nw-form"><p>Choose a saved connected call that addressed this exact request. Unrelated or unsuccessful calls do not complete it. A pending plan remains pending.</p><div class="form-group"><label for="nutrition-saved-call" class="form-label">Completed call</label><select id="nutrition-saved-call" class="form-select" required><option value="">Choose a call</option>${calls.map((c,i)=>`<option value="${i}">${sanitize(new Date(c.call_date).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'}))}</option>`).join('')}</select></div><div class="form-group"><label for="nutrition-saved-origin" class="form-label">Scheduled activity this completed (optional)</label><select id="nutrition-saved-origin" class="form-select"><option value="">This was not an earlier scheduled activity</option>${(row.pending_followups||[]).map(x=>`<option value="${sanitize(x.call_id)}">Due ${sanitize(day(x.due_on))} from call ${sanitize(day(x.call_date))}</option>`).join('')}</select></div><label class="nw-attestation"><input type="checkbox" required><span>I confirm this saved call belongs to this request and completed the selected activity.</span></label><p class="nw-error" data-call-link-error role="alert" hidden></p><div class="nw-actions"><button type="button" class="btn btn-secondary" data-call-link-cancel>Cancel</button><button type="submit" class="btn btn-primary">Link completed call</button></div></form>`;
    const form=host.querySelector('form'),message=form.querySelector('[data-call-link-error]');
    const savedCall=form.querySelector('#nutrition-saved-call'),originSelect=form.querySelector('#nutrition-saved-origin');
    const refreshOrigins=()=>{const call=calls[Number(savedCall.value)],hasCall=savedCall.value!=='';originSelect.innerHTML='<option value="">Not completing a scheduled activity</option>'+(row.pending_followups||[]).filter(x=>hasCall && new Date(call.call_date)>=new Date(x.scheduled_at||x.call_date)).map(x=>`<option value="${sanitize(x.call_id)}">Due ${sanitize(day(x.due_on))} from call ${sanitize(day(x.call_date))}</option>`).join('');};
    savedCall.addEventListener('change',refreshOrigins);refreshOrigins();
    form.querySelector('[data-call-link-cancel]').onclick=()=>modal.closeOwnedModal();
    form.onsubmit=async event=>{event.preventDefault(); if(!owned() || !form.reportValidity()) return; const button=form.querySelector('[type="submit"]');if(button.disabled)return;button.disabled=true;message.hidden=true;
      try {const selected=calls[Number(form.querySelector('#nutrition-saved-call').value)];if(!selected)throw new Error('missing');const originId=form.querySelector('#nutrition-saved-origin').value||null,snapshot=originId?followupSnapshot(row.pending_followups,originId):null;const {data,error}=await getSupabase().rpc('link_nutrition_call',{p_request:row.id,p_call:selected.id,p_followup_of:originId,p_followup_version:snapshot?.version??null,p_followup_due_on:snapshot?.due??null,p_expected_updated_at:row.updated_at,p_operation:operation,p_actor:actor});if(!owned())return;if(error||!safeReply(data,row))throw new Error('unconfirmed');modal.closeOwnedModal();showToast(data.replayed && data.activity_still_current===false?'This earlier call link was already saved. The schedule changed; its current follow-up remains pending.':'Saved call linked. Current pending work has been refreshed.','success');if(current())await onSaved(data);}
      catch {if(owned()){message.textContent='Could not confirm this link. Your entries are kept. Retry, or refresh if the activity changed.';message.hidden=false;button.disabled=false;}}
    };
  } catch {if(owned())host.innerHTML='<p class="nw-error" role="alert">Could not load completed calls. Close this dialog and refresh the tracker.</p>';}
}
