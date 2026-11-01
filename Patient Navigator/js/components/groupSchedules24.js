import { getSupabase } from '../supabase.js';
import { getCurrentUser, getCurrentProfile, getRealProfile, isImpersonating } from '../auth.js';
import { sanitize } from '../utils/validators.js';
import { showModal } from './modal.js';
import { showToast } from './toast.js';

const states = new WeakMap();
const reviews = new WeakMap();
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
export function captureScheduleActor24() {
  const key = () => JSON.stringify([getCurrentUser()?.id, getCurrentProfile()?.id, getCurrentProfile()?.role,
    getRealProfile()?.id, getRealProfile()?.role, getRealProfile()?.is_active, getRealProfile()?.ends_on, isImpersonating()]);
  const before = key();
  return () => {
    const user = getCurrentUser(), real = getRealProfile();
    const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
    return key() === before && !!user?.id && real?.id === user.id && getCurrentProfile()?.id === user.id
      && !isImpersonating() && real.is_active === true && ['manager', 'admin'].includes(real.role)
      && (!real.ends_on || real.ends_on >= today);
  };
}
export async function schedulingState24() {
  try {
    const { data, error } = await getSupabase().rpc('broadcast_scheduling_state24');
    if (error || !data || typeof data.enabled !== 'boolean' || data.daily_slots !== 100) return null;
    return data;
  } catch { return null; }
}
const money = value => Number(value).toLocaleString('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 4 });
export function clearScheduleReview24(host) { reviews.set(host, (reviews.get(host) || 0) + 1); const review = host.querySelector('#wb-review'); if (review) review.replaceChildren(); }

export async function reviewGroupSchedule24({ host, payload, requestId, current, onSaved, beginSave = () => true, finishSave = () => {} }) {
  if (!current()) return;
  const generation = (reviews.get(host) || 0) + 1; reviews.set(host, generation);
  const review = host.querySelector('#wb-review');
  review.textContent = 'Checking saved contacts, permissions and daily message slots...';
  let response;
  try { response = await getSupabase().rpc('broadcast_schedule_preview24', { p: payload }); }
  catch { response = { error: true }; }
  if (!current() || reviews.get(host) !== generation) return;
  const data = response.data;
  const valid = !response.error && data && /^[a-f0-9]{64}$/.test(data.preview_hash)
    && Number.isInteger(data.contacts) && data.contacts > 0 && Number.isInteger(data.slots) && data.slots >= data.contacts
    && Number.isInteger(data.remaining) && typeof data.can_schedule === 'boolean'
    && Array.isArray(data.contact_labels) && data.contact_labels.length === data.contacts
    && data.contact_labels.every(label => typeof label === 'string' && !/\d{7}/.test(label))
    && Number.isFinite(Number(data.estimated_inr)) && Number(data.estimated_inr) > 0;
  if (!valid) {
    review.textContent = response.error?.message || 'The delivery preview could not be checked. Refresh the group and try again.';
    return;
  }
  const fingerprint = JSON.stringify(payload);
  review.innerHTML = `<section class="card" style="padding:14px;margin-top:12px;overflow-wrap:anywhere" role="status">
    <h3>Review scheduled delivery</h3><p><strong>${data.contacts} saved contacts</strong> · ${data.slots} message slots · ${data.remaining} slots available on this India date.</p>
    <p>Estimated ${money(data.estimated_inr)} before taxes. A poster reserves one additional message slot per contact.</p>
    <p>${Number(data.held) || 0} saved contacts held because their number or permission is not eligible. Nothing has been scheduled yet.</p>
    <details><summary>Check the selected destinations</summary><ul>${data.contact_labels.map(label => `<li>${sanitize(label)}</li>`).join('')}</ul></details>
    ${data.can_schedule ? '<button class="btn btn-primary" type="button" id="wb-confirm-schedule">Confirm scheduled delivery</button>'
      : '<p>Delivery is paused or the daily message limit would be exceeded. Deselect contacts, choose another date, or save a draft.</p>'}
    <p data-schedule-result aria-live="polite"></p></section>`;
  const button = review.querySelector('#wb-confirm-schedule');
  if (!button) return;
  let busy = false;
  button.addEventListener('click', async () => {
    if (busy || !current() || !button.isConnected || reviews.get(host) !== generation) return;
    // A changed form clears this review. The payload used here is the exact reviewed snapshot.
    if (JSON.stringify(payload) !== fingerprint) { clearScheduleReview24(host); return; }
    if (!beginSave()) return;
    busy = true; button.disabled = true;
    let saved;
    try { saved = await getSupabase().rpc('broadcast_schedule_save24', { p: { ...payload, request_id: requestId, preview_hash: data.preview_hash } }); }
    catch { saved = { error: { message: 'Scheduling was not confirmed. Review the unchanged draft again to check the same request safely.' } }; }
    finishSave();
    if (!current()) return;
    if (saved.error) {
      review.querySelector('[data-schedule-result]').textContent = saved.error.message || 'Scheduling was not confirmed. Retry this unchanged draft.';
      busy = false; button.disabled = false; return;
    }
    if (!uuid(saved.data?.group_id) || !Array.isArray(saved.data?.ids) || !saved.data.ids.every(uuid) || saved.data.contacts !== data.contacts) {
      review.querySelector('[data-schedule-result]').textContent = 'The saved result could not be confirmed. Keep this draft unchanged and refresh the scheduled list before trying again.';
      return;
    }
    onSaved(saved.data);
  });
}

export async function mountScheduledGroups24(container) {
  let state = states.get(container);
  if (!state || !state.owns()) {
    state = { owns: captureScheduleActor24(), sequence: 0, busy: false };
    states.set(container, state);
  }
  const mount = container.querySelector('#wb-scheduled-groups');
  const current = () => mount?.isConnected && states.get(container) === state && state.owns();
  if (!current()) return;
  const sequence = ++state.sequence;
  let response;
  try { response = await getSupabase().rpc('broadcast_groups_list24', { p_limit: 25 }); } catch { response = { error: true }; }
  if (!current() || sequence !== state.sequence) return;
  const rows = response.data?.rows;
  if (response.error || !Array.isArray(rows) || rows.some(row => !uuid(row.id) || typeof row.title !== 'string')) {
    mount.innerHTML = '<p>Scheduled delivery history is unavailable. Drafts and earlier message history remain below.</p>'; return;
  }
  mount.innerHTML = `<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><h2>Scheduled messages</h2><button class="btn btn-secondary btn-sm" type="button" data-refresh-groups>Refresh delivery status</button></div>
    ${rows.length ? rows.map(row => `<article class="card" style="padding:16px;margin-bottom:12px;overflow-wrap:anywhere" data-group-id="${row.id}">
      <strong>${sanitize(row.title)}</strong><p>${sanitize(new Date(row.scheduled_for).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }))} India time</p>
      <p>${Number(row.contacts)} contacts · ${Number(row.waiting)} waiting · ${Number(row.delivered)} text delivered · ${Number(row.failed)} failed · ${Number(row.cancelled)} stopped</p>
      <p>${Number(row.slots)} reserved message slots · estimated ${money(row.estimated_inr)} before taxes</p>
      <details><summary>Delivery results</summary><ul>${(row.deliveries || []).map(delivery => `<li>${sanitize(delivery.label)}: ${sanitize(String(delivery.status || '').replaceAll('_', ' '))}${delivery.poster_status ? ` · poster ${sanitize(delivery.poster_status)}` : ''}</li>`).join('')}</ul></details>
      ${row.waiting > 0 ? '<button type="button" class="btn btn-secondary btn-sm" data-stop-group>Stop waiting deliveries</button>' : ''}
    </article>`).join('') : '<p>No verified group schedules yet. Use New message to prepare one.</p>'}`;
  mount.querySelector('[data-refresh-groups]').onclick = () => { if (current() && !state.busy) mountScheduledGroups24(container); };
  mount.querySelectorAll('[data-stop-group]').forEach(button => button.onclick = () => {
    if (!current() || state.busy) return;
    const id = button.closest('[data-group-id]').dataset.groupId;
    const modal = showModal({ title: 'Stop waiting deliveries', content: '<p>This stops contacts still waiting. A message already being sent may still arrive. Sent and delivered results stay in the history.</p><p data-error role="alert"></p>', footer: '<button type="button" class="btn btn-secondary" data-no>Keep schedule</button><button type="button" class="btn btn-primary" data-yes>Stop waiting deliveries</button>' });
    modal.querySelector('[data-no]').onclick = () => modal.closeOwnedModal();
    modal.querySelector('[data-yes]').onclick = async () => {
      if (!current() || !modal.isCurrentModal() || state.busy) return;
      state.busy = true; modal.querySelectorAll('button').forEach(b => b.disabled = true);
      let result; try { result = await getSupabase().rpc('broadcast_group_cancel24', { p_id: id }); } catch { result = { error: true }; }
      state.busy = false;
      if (!current()) { modal.closeOwnedModal(); return; }
      if (result.error) { modal.querySelector('[data-error]').textContent = 'Could not confirm the stop. Refresh delivery status before retrying.'; modal.querySelector('[data-no]').disabled = false; return; }
      modal.closeOwnedModal(); showToast(`${Number(result.data?.stopped) || 0} waiting deliveries stopped.`, 'success');
      await mountScheduledGroups24(container);
    };
  });
}
