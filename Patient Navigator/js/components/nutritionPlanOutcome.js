import { getSupabase } from '../supabase.js';
import { sanitize } from '../utils/validators.js';
import { showModal } from './modal.js';
import { showToast } from './toast.js';
import * as nutritionCare from './nutritionCare.js';

export const PLAN_ATTEMPT_REASONS = { unreachable: 'Unreachable', no_whatsapp: 'No WhatsApp', not_interested: 'Not interested', already_supported_tata: 'Already supported through Tata', awaiting_reports: 'Awaiting reports', other: 'Other' };
const STATES = { open: 'Open', assigned: 'Assigned', called: 'Called', plan_shared: 'Completion needs confirmation', closed: 'Closed' };
const KINDS = { not_shared: 'Plan not shared', plan_recorded: 'Plan sharing recorded', plan_corrected: 'Plan sharing corrected', request_resolved: 'Request resolved', call_linked: 'Completed call linked' };
export function nutritionDay(value = new Date()) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}
function dateLabel(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown date' : date.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
}
function operationId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  const bytes = new Uint8Array(16); crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function openNutritionPlanOutcome({ row, shared, isCurrent, onSaved }) {
  if (!isCurrent() || row.can_record_plan_outcome !== true || row.status === 'closed') return;
  let operation;
  try { operation = operationId(); } catch { showToast('Could not open this form. Refresh and try again.', 'error'); return; }
  const today = nutritionDay(), requestDay = nutritionDay(row.raised_at);
  const oldest = new Date(today + 'T00:00:00Z'); oldest.setUTCDate(oldest.getUTCDate() - 30);
  const minDay = requestDay > oldest.toISOString().slice(0, 10) ? requestDay : oldest.toISOString().slice(0, 10);
  const modal = showModal({ title: shared ? 'Record plan shared' : 'Plan not shared', content: `<form class="nw-form" id="${shared ? 'nutrition-plan-form' : 'nutrition-attempt-form'}"><p>For <strong>${sanitize(row.patient_name || 'this patient')}</strong>.</p>
    ${shared ? `<p class="nw-muted">Request raised ${sanitize(dateLabel(row.raised_at))}, India time. Record a plan actually shared after this request. A qualifying share closes this request.</p><div class="form-group"><label class="form-label" for="nutrition-plan-date">Date shared</label><input type="date" class="form-input" id="nutrition-plan-date" min="${sanitize(minDay)}" max="${today}" value="${today}" required></div><label class="nw-attestation" data-plan-attestation hidden><input type="checkbox" data-plan-confirm><span>This sharing happened after this request was raised.</span></label>` : `<p class="nw-muted">Record this attempt. The request stays open and its follow-up dates stay in place.</p><div class="form-group"><label class="form-label" for="nutrition-attempt-reason">Why was the plan not shared?</label><select class="form-select" id="nutrition-attempt-reason" required><option value="">Choose a reason</option>${Object.entries(PLAN_ATTEMPT_REASONS).map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select></div>`}
    <div class="form-group"><label class="form-label" for="nutrition-outcome-note" data-outcome-note-label>Note (optional)</label><textarea class="form-input" id="nutrition-outcome-note" maxlength="2000" rows="3"></textarea></div><p class="nw-error" data-outcome-error role="alert" hidden></p><div class="nw-actions"><button type="button" class="btn btn-secondary" data-outcome-cancel>Cancel</button><button type="submit" class="btn btn-primary">${shared ? 'Record plan shared' : 'Save attempt'}</button></div></form>` });
  const owned = () => isCurrent() && modal.isConnected && modal.isCurrentModal();
  const form = modal.querySelector('form'), note = form.querySelector('textarea'), message = form.querySelector('[data-outcome-error]');
  const day = form.querySelector('#nutrition-plan-date'), confirm = form.querySelector('[data-plan-confirm]'), reason = form.querySelector('select');
  const update = () => {
    note.setCustomValidity('');
    if (shared) {
      const sameDay = day.value === requestDay;
      form.querySelector('[data-plan-attestation]').hidden = !sameDay;
      confirm.required = sameDay; confirm.checked = false;
    } else {
      note.required = reason.value === 'other';
      form.querySelector('[data-outcome-note-label]').textContent = note.required ? 'Note (required for Other)' : 'Note (optional)';
    }
  };
  (day || reason).addEventListener('change', update); note.addEventListener('input', () => note.setCustomValidity('')); update();
  form.querySelector('[data-outcome-cancel]').onclick = () => modal.closeOwnedModal();
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!owned()) return;
    if (!shared && reason.value === 'other' && !note.value.trim()) note.setCustomValidity('Add a short note for Other.');
    if (!form.reportValidity()) return;
    const button = form.querySelector('[type="submit"]'); if (button.disabled) return;
    if (shared && (!requestDay || day.value < minDay || day.value > today || (day.value === requestDay && !confirm.checked))) {
      message.textContent = 'Choose a valid sharing day after this request, and confirm the order for a same-day share.'; message.hidden = false; return;
    }
    button.disabled = true; message.hidden = true;
    try {
      const { data, error } = await getSupabase().rpc(shared ? 'record_nutrition_request_plan' : 'record_nutrition_plan_attempt', {
        p_request: row.id, p_note: note.value.trim() || null, p_operation: operation,
        ...(shared ? { p_occurred_on: day.value, p_after_request_confirmed: day.value === requestDay && confirm.checked } : { p_reason: reason.value }),
      });
      if (!owned()) return;
      if (error || !data?.ok || data.request_id !== row.id || !data.action_id || !STATES[data.current_status]) throw new Error('unconfirmed');
      modal.closeOwnedModal();
      showToast(shared ? (data.current_status === 'closed' ? 'Plan sharing recorded. Request closed.' : 'Plan sharing recorded. Check the current request status.') : 'Attempt recorded. Check the current request status.', 'success');
      if (isCurrent()) await onSaved(data);
    } catch {
      if (!owned()) return;
      message.textContent = 'Could not confirm this save. Your entries are kept. Retry, or refresh the tracker before starting another form.'; message.hidden = false; button.disabled = false;
    }
  });
}
export async function openNutritionRequestHistory({ row, isCurrent }) {
  if (!isCurrent()) return;
  const modal = showModal({ title: 'Nutrition request history', content: `<p>For <strong>${sanitize(row.patient_name || 'this patient')}</strong>.</p><div data-nutrition-history role="status">Loading history...</div>` });
  const owned = () => isCurrent() && modal.isCurrentModal() && modal.isConnected;
  const host = modal.querySelector('[data-nutrition-history]');
  try {
    const { data, error } = await getSupabase().rpc('get_nutrition_request_actions', { p_request: row.id });
    if (!owned()) return;
    if (error || !Array.isArray(data?.items)) throw new Error('unavailable');
    host.innerHTML = `${data.truncated ? '<p class="nw-muted">Showing the latest 20 actions.</p>' : ''}<p class="nw-muted">${Math.max(Number(data.total) || 0, data.items.length)} recorded actions.</p>${data.items.length ? `<ol class="nw-history">${data.items.map(item => `<li><strong>${sanitize(KINDS[item.kind] || 'Care update')}${(PLAN_ATTEMPT_REASONS[item.reason] || nutritionCare.RESOLUTION_REASONS[item.reason]) ? ' - ' + sanitize(PLAN_ATTEMPT_REASONS[item.reason] || nutritionCare.RESOLUTION_REASONS[item.reason]) : ''}</strong><div class="nw-muted">${sanitize(dateLabel(item.created_at))} - ${sanitize(item.actor_name || 'Care team')}</div>${item.shared_on ? `<p>Shared on ${sanitize(item.shared_on)}. Date recorded; time unknown.</p>` : ''}${item.result_status ? `<p>Result: ${sanitize(STATES[item.result_status] || 'Status not recorded')}</p>` : ''}${item.note ? `<p class="nw-private-note">${sanitize(item.note)}</p>` : ''}</li>`).join('')}</ol>` : '<p class="nw-muted">No recorded actions yet.</p>'}`;
  } catch { if (owned()) host.innerHTML = '<p class="nw-error" role="alert">Could not load history. Close this dialog and try again.</p>'; }
}
