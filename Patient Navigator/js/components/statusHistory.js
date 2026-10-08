// ============================================================
// Why families drop out, and one status history (sql/174, Fixboard #27).
//
// Reported 8 Oct by Aadrika for CGMP: marking a patient Inactive should ask
// why they dropped out, separately from Not taking part (not engaging pauses
// calls for 15 days, completely disinterested for 30), and the record should
// keep one history of all of it with dates and reasons.
//   openInactiveModal   the reason, asked when the status menu says Inactive
//                       (or afterwards, for a family already inactive)
//   mountStatusHistory  the history card on the record's Overview
// The keys match dropout_reason_ok() in sql/174.
// ============================================================
import { getSupabase } from '../supabase.js';
import { showToast } from './toast.js';
import { showModal, closeModal } from './modal.js';
import { icon } from './icons.js';
import { sanitize } from '../utils/validators.js';
import { PATIENT_STATUSES } from '../utils/catalog.js';

export const DROPOUT_REASONS = [
  { key: 'treated_elsewhere', label: 'Getting care or support elsewhere' },
  { key: 'treatment_finished', label: 'Treatment finished, no support needed now' },
  { key: 'stopped_treatment', label: 'Stopped treatment' },
  { key: 'too_unwell', label: 'Too unwell to take part' },
  { key: 'moved_away', label: 'Moved away or changed hospital' },
  { key: 'family_declined', label: 'Family does not want support any more' },
  { key: 'unreachable', label: 'Could not be reached for a long time' },
  { key: 'cost_or_travel', label: 'Cost or travel made it too hard' },
  { key: 'other', label: 'Other (write it below)' },
];
export const dropoutLabel = (k) => (k === 'not_recorded' ? 'Reason not recorded'
  : k === 'completely_disinterested' ? 'Completely disinterested (Not taking part)'
    : DROPOUT_REASONS.find((r) => r.key === k)?.label || String(k || '').replace(/_/g, ' '));
const statusLabel = (k) => PATIENT_STATUSES.find((s) => s.key === k)?.label || String(k || '').replace(/_/g, ' ');
const dayIN = (d) => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

/**
 * Ask why they dropped out, then save. opts.already: the family is already
 * inactive and only the reason is being added. onDone() after a save.
 */
export function openInactiveModal(patient, { already = false, onDone = () => {} } = {}) {
  let reason = '';
  const el = document.createElement('div');
  el.innerHTML = `
    <p style="margin:0 0 12px">${already
      ? 'This family is inactive with no reason on record. Why did they drop out?'
      : 'Use this when a family has left the support programme. It is not the same as <strong>Not taking part</strong>, which only pauses calls for 15 or 30 days.'}</p>
    <div class="field"><label>Why did they drop out? *</label>
      <div class="chips" id="dr-reasons" style="display:flex;flex-direction:column;gap:6px">
        ${DROPOUT_REASONS.map((r) => `<button type="button" class="chip seg-btn" data-reason="${r.key}"
          style="padding:9px 12px;text-align:left;justify-content:flex-start">${sanitize(r.label)}</button>`).join('')}
      </div>
    </div>
    <div class="field" style="margin-top:var(--s4)"><label>What did they say?</label>
      <textarea class="textarea" id="dr-note" maxlength="1000"
        placeholder="Their own words if you have them. Needed for Other."></textarea></div>
    <div class="form-actions" style="margin-top:var(--s4)">
      <button class="btn btn-secondary" id="dr-cancel">Cancel</button>
      <button class="btn btn-primary" id="dr-save">${icon('check')}Save</button>
    </div>`;
  showModal({ title: already ? 'Why did they drop out?' : 'Mark as inactive', content: el, size: 'md' });

  el.querySelectorAll('#dr-reasons .chip').forEach((b) => b.addEventListener('click', () => {
    reason = b.dataset.reason;
    el.querySelectorAll('#dr-reasons .chip').forEach((x) => { x.classList.remove('on', 'tone-warn'); });
    b.classList.add('on', 'tone-warn');
  }));
  el.querySelector('#dr-cancel').addEventListener('click', () => closeModal());
  el.querySelector('#dr-save').addEventListener('click', async (e) => {
    const note = el.querySelector('#dr-note')?.value.trim() || '';
    if (!reason) { showToast('Pick why they dropped out.', 'warning'); return; }
    if (reason === 'other' && note.length < 3) { showToast('Write down the reason in their words.', 'warning'); return; }
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const { error } = await getSupabase().rpc('set_patient_status', {
        p_patient: patient.id, p_status: 'inactive', p_reason: reason, p_note: note || null });
      if (error) throw error;
      closeModal();
      showToast(already ? 'Reason saved' : 'Marked inactive, with the reason', 'success');
      onDone();
    } catch (err) {
      btn.disabled = false;
      showToast('Could not save: ' + err.message, 'error');
    }
  });
}

function eventHTML(e) {
  let title;
  if (e.kind === 'not_engaging') title = 'Not taking part: not engaging right now';
  else if (e.kind === 'completely_disinterested') title = 'Not taking part: completely disinterested';
  else if (e.kind === 'back_in_programme') title = e.by ? 'Back in the programme' : 'Pause ended';
  else if (e.from === e.to && e.to === 'inactive') title = 'Dropout reason recorded';
  else title = `${sanitize(statusLabel(e.from))} → ${sanitize(statusLabel(e.to))}`;
  const why = e.kind === 'status' && e.to === 'inactive'
    ? (e.reason ? sanitize(dropoutLabel(e.reason)) : '<span style="color:var(--ink-3)">Reason not recorded</span>')
    : '';
  return `
    <div style="display:flex;gap:10px;padding:8px 0;border-top:1px solid var(--line)">
      <div class="due-meta" style="min-width:92px">${dayIN(e.at)}</div>
      <div style="flex:1;min-width:0">
        <div style="font-weight:600">${title}</div>
        ${why ? `<div class="due-meta wraps" style="color:var(--ink-1)">${why}</div>` : ''}
        ${e.note ? `<div class="due-meta wraps" style="color:var(--ink-2)">"${sanitize(e.note)}"</div>` : ''}
        <div class="due-meta">${e.by ? sanitize(e.by) : e.source === 'system' ? 'Automatic' : ''}</div>
      </div>
    </div>`;
}

/** The record's status history: newest first, six at a time. */
export async function mountStatusHistory(el, patient, { onChange = () => {} } = {}) {
  if (!el || !patient?.id) return;
  let rows = [];
  try {
    const { data, error } = await getSupabase().rpc('patient_status_history', { p_patient: patient.id });
    if (error) throw error;
    rows = Array.isArray(data) ? data : [];
  } catch (e) {
    console.warn('[status history]', e.message);
    return;
  }
  if (!el.isConnected) return;
  // An inactive family whose last move there carries no reason: ask for it.
  const lastDrop = rows.find((r) => (r.kind === 'status' && r.to === 'inactive') || r.kind === 'completely_disinterested');
  const needsReason = patient.patient_status === 'inactive' && !patient.disinterest_level
    && !rows.some((r) => r.reason && lastDrop && Date.parse(r.at) >= Date.parse(lastDrop.at));
  let showAll = false;
  const paint = () => {
    const list = showAll ? rows : rows.slice(0, 6);
    el.innerHTML = `
      <div class="card" style="padding:12px 14px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
          <span style="display:inline-flex;width:18px;height:18px">${icon('clock')}</span>
          <strong>Status history</strong>
          <span class="due-meta">${rows.length ? `${rows.length} change${rows.length === 1 ? '' : 's'}` : 'nothing yet'}</span>
        </div>
        ${needsReason ? `<div class="due-meta wraps" style="margin:6px 0;color:var(--clay)">Inactive with no reason on record.
          <button type="button" class="btn btn-secondary btn-sm" id="sh-add-reason" style="margin-left:6px">Add why they dropped out</button></div>` : ''}
        ${list.map(eventHTML).join('') || '<div class="due-meta">No status changes recorded yet.</div>'}
        ${rows.length > 6 && !showAll ? `<button type="button" class="btn btn-ghost btn-sm" id="sh-all" style="margin-top:6px">Show all ${rows.length}</button>` : ''}
      </div>`;
    el.querySelector('#sh-all')?.addEventListener('click', () => { showAll = true; paint(); });
    el.querySelector('#sh-add-reason')?.addEventListener('click', () =>
      openInactiveModal(patient, { already: true, onDone: onChange }));
  };
  paint();
}
