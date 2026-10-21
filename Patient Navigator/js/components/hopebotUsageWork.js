import { getSupabase } from '../supabase.js';
import { getCurrentUser, getCurrentProfile, getRealProfile, isImpersonating } from '../auth.js';
import { sanitize } from '../utils/validators.js';
import { showModal } from './modal.js';
import { showToast } from './toast.js';
import { mountHopebotFeedback } from './hopebotFeedback.js';

const mounts = new WeakMap();
const outcomes = { connected: 'Connected', no_answer: 'No answer', busy: 'Busy', voicemail: 'Voicemail', wrong_number: 'Wrong number', callback_requested: 'Callback requested' };
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const account = () => JSON.stringify([getCurrentUser()?.id, getRealProfile()?.id, getCurrentProfile()?.id, isImpersonating()]);
function today() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  return ['year', 'month', 'day'].map(key => parts.find(part => part.type === key)?.value).join('-');
}
function day(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return false;
  const parsed = new Date(value + 'T00:00:00Z'); return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function active() {
  const profile = getRealProfile();
  return !!getCurrentUser()?.id && profile?.id === getCurrentUser().id && profile.is_active === true
    && ['admin', 'manager', 'caller', 'caregiver_mentor', 'nutritionist', 'therapist'].includes(profile.role)
    && (!profile.ends_on || profile.ends_on >= today());
}
function result(data, member) {
  if (!data || data.member_id !== member || data.day !== today() || !Number.isSafeInteger(data.pending) || data.pending < 0
    || !Array.isArray(data.items) || data.items.length > 100 || data.pending < data.items.length) throw new Error('Unconfirmed usage list');
  const seen = new Set();
  const items = data.items.map(row => {
    if (!row || !uuid(row.id) || seen.has(row.id) || (row.lead_id != null && !uuid(row.lead_id)) || (row.patient_id != null && !uuid(row.patient_id))
      || !day(row.due_day) || !['pending', 'calling', 'held'].includes(row.state) || typeof row.servable !== 'boolean' || typeof row.awaiting_capacity !== 'boolean'
      || typeof row.name !== 'string' || row.name.length > 1000 || typeof row.features_text !== 'string' || row.features_text.length > 2000
      || (row.hold != null && typeof row.hold !== 'string')
      || (row.servable && (!uuid(row.lead_id) || row.hold != null || row.state === 'held' || row.due_day > data.day))) throw new Error('Unconfirmed usage item');
    seen.add(row.id); return { ...row };
  });
  return { ...data, items };
}

// One bounded usage projection, sharing the existing SQL215 routine header.
// Linked families stay in the patient Calling flow; no patient is fabricated.
export function mountHopebotUsageWork(element, { memberId, isCurrent = () => true, preview = false, onReturn = () => {} } = {}) {
  if (!element) return { refresh: async () => false, startNext: async () => false, dispose() {} };
  mounts.get(element)?.dispose();
  const identity = account(), route = window.location.hash;
  let disposed = false, generation = 0, loading = false, claiming = false, list = null, dialog = null, observer, subscription;
  const drafts = new Map();
  const previewing = () => { try { return isImpersonating() || (typeof preview === 'function' ? !!preview() : !!preview); } catch { return true; } };
  const owned = () => { try { return !disposed && mounts.get(element) === controller && element.isConnected && identity === account() && route === window.location.hash && active() && isCurrent(); } catch { return false; } };
  const writable = () => {
    const profile = getRealProfile();
    return owned() && !previewing() && memberId === getCurrentUser()?.id && getCurrentProfile()?.id === memberId
      && ['caller', 'caregiver_mentor'].includes(profile?.role) && Object.hasOwn(profile, 'on_probation') && !profile.on_probation;
  };
  function closeDialog(handle = dialog, notify = true) {
    if (!handle || dialog !== handle) return;
    dialog = null; handle.feedback?.dispose(); handle.feedback = null;
    handle.modal.querySelector('.modal-body')?.replaceChildren();
    handle.modal.closeOwnedModal();
    if (handle.saved && notify && current()) Promise.resolve(onReturn(handle.receipt)).catch(() => { if (current()) showToast('The call is saved. Refresh the daily list to confirm its current counts.', 'warning'); });
    else if (notify && current()) load().catch(() => {});
  }
  function dispose() {
    if (disposed) return;
    disposed = true; generation++; observer?.disconnect(); subscription?.unsubscribe();
    window.removeEventListener('hashchange', checkIdentity); document.removeEventListener('change', checkIdentity, true);
    if (dialog) { const handle = dialog; dialog = null; handle.feedback?.dispose(); handle.modal.replaceChildren(); handle.modal.closeOwnedModal(); handle.modal.remove(); }
    drafts.clear(); list = null;
    if (mounts.get(element) === controller) { element.replaceChildren(); mounts.delete(element); }
  }
  function checkIdentity() {
    if (!owned() || (dialog && !writable())) dispose();
    else if (dialog && !dialog.modal.isCurrentModal()) closeDialog(dialog);
  }
  function current(seq = generation) { if (disposed || seq !== generation) return false; if (!owned()) { dispose(); return false; } return true; }
  function message(value, error = false) {
    const host = element.querySelector('[data-huw-message]');
    if (host) { host.textContent = value; host.style.color = error ? 'var(--danger, #b42318)' : ''; }
  }
  function paint() {
    if (!current() || !list) return;
    const items = list.items.filter(row => row.patient_id == null);
    element.innerHTML = `<section class="card huw-work" style="padding:16px;min-width:0;overflow-wrap:anywhere">
      <style>.huw-work .huw-row{border-top:1px solid var(--line);padding:14px 0;min-width:0}.huw-work p,.huw-work .due-meta{white-space:normal;overflow-wrap:anywhere}.huw-work .huw-actions{display:flex;flex-wrap:wrap;gap:10px;align-items:center}.huw-work .btn{max-width:100%;white-space:normal}</style>
      <h3>HopeBot lead follow-ups</h3><p class="due-meta">These unlinked leads share the same fixed daily call limit above. They are not an extra call list. Linked families stay in the patient list.</p>
      ${previewing() ? '<p class="due-meta">Preview is read-only. Return to your own account to call or save an outcome.</p>' : ''}
      <p data-huw-message role="status" aria-live="polite"></p>
      ${!items.length ? '<p role="status">No unlinked lead follow-ups are shown. This does not confirm that a family has never used HopeBot.</p>' : items.map((row, index) => `<article class="huw-row" data-huw-row="${index}"><strong>${sanitize(row.name)}</strong>
       <p class="due-meta">${sanitize(row.features_text || 'Observed feature not recorded')}<br>Original due day: ${sanitize(row.due_day)}</p>
       <p>${row.hold || row.state === 'held' ? 'Held for review. Nothing can be called from this row.' : row.awaiting_capacity ? 'Awaiting a future daily plan. No replacement slot is added today.' : row.servable ? row.state === 'calling' ? 'Call already opened. Resume to record the actual outcome.' : 'Admitted to the shared daily list.' : 'Waiting for its due day or contact rest.'}</p>
       ${row.servable ? `<button type="button" class="btn btn-secondary" data-huw-start ${writable() ? '' : 'disabled'}>${row.state === 'calling' ? 'Resume lead call' : 'Open lead call'}</button>` : ''}</article>`).join('')}
      ${list.pending > list.items.length ? '<p class="due-meta">Showing a bounded set of up to100 usage follow-ups, with admitted and active work first. More records remain in the manager tracker.</p>' : ''}
      <button type="button" class="btn btn-secondary" data-huw-refresh>Refresh lead follow-ups</button></section>`;
    element.querySelectorAll('[data-huw-row]').forEach(card => {
      const row = items[Number(card.dataset.huwRow)];
      card.querySelector('[data-huw-start]')?.addEventListener('click', () => { if (current() && writable()) claim(row); });
    });
    element.querySelector('[data-huw-refresh]').onclick = () => { if (current()) load().catch(() => {}); };
  }
  async function load() {
    if (!current() || claiming || (dialog && !dialog.saved)) return false;
    const seq = ++generation; loading = true;
    element.innerHTML = '<section class="card" style="padding:16px"><h3>HopeBot lead follow-ups</h3><p role="status">Loading the current shared daily list...</p></section>';
    try {
      const response = await getSupabase().rpc('hopebot_usage_worklist', { p_member: memberId });
      if (!current(seq)) return false;
      if (response?.error) throw response.error;
      list = result(response?.data, memberId); loading = false; paint(); return true;
    } catch {
      if (!current(seq)) return false;
      loading = false; list = null;
      element.innerHTML = '<section class="card" style="padding:16px"><h3>HopeBot lead follow-ups</h3><p role="alert">Could not confirm the current lead follow-ups. They have not been marked finished.</p><button type="button" class="btn btn-secondary" data-huw-retry>Retry lead list</button></section>';
      element.querySelector('[data-huw-retry]').onclick = () => { if (current()) load().catch(() => {}); };
      return false;
    }
  }
  async function claim(row) {
    if (!current() || !writable() || claiming || loading || dialog || !row?.servable || row.patient_id != null || !uuid(row.lead_id)) return false;
    const seq = generation; claiming = true; message('Verifying this assigned lead before showing a number...');
    element.querySelectorAll('[data-huw-start]').forEach(button => { button.disabled = true; });
    try {
      const response = await getSupabase().rpc('hopebot_usage_claim', { p_work: row.id });
      if (!current(seq) || !writable()) return false;
      if (response?.error) throw response.error;
      const data = response?.data;
      if (!data || data.work_id !== row.id || data.id !== row.id || data.lead_id !== row.lead_id || data.patient_id != null
        || typeof data.name !== 'string' || typeof data.phone !== 'string' || !/^[1-9][0-9]{7,14}$/.test(data.phone)
        || typeof data.claimed_cutoff !== 'string' || !Number.isFinite(Date.parse(data.claimed_cutoff))) throw new Error('Unconfirmed lead claim');
      claiming = false; row.state = 'calling'; paint(); openCall(row, data); return true;
    } catch {
      if (!current(seq)) return false;
      claiming = false; paint(); message('Could not verify this lead call. No number is shown. Refresh the list and retry.', true); return false;
    } finally { if (current(seq)) { claiming = false; if (!dialog) element.querySelectorAll('[data-huw-start]').forEach(button => { button.disabled = !writable(); }); } }
  }
  function openCall(row, claimed) {
    if (!current() || !writable()) return;
    const draft = drafts.get(row.id) || { status: '', notes: '', attempted: null };
    drafts.set(row.id, draft);
    const body = document.createElement('div'); body.className = 'huw-call';
    body.innerHTML = `<style>.huw-call{min-width:0;overflow-wrap:anywhere}.huw-call p,.huw-call .due-meta{white-space:normal;overflow-wrap:anywhere}.huw-call textarea,.huw-call select{width:100%;max-width:100%;box-sizing:border-box}.huw-call .huw-actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:14px}.huw-call .btn{max-width:100%;white-space:normal}</style>
     <h4>${sanitize(claimed.name)}</h4><p>This is an unlinked HopeBot lead, not a PN patient record. Record only the call you actually made.</p>
     <p><a class="btn btn-secondary" href="tel:+${claimed.phone}" data-huw-dial>Call +${sanitize(claimed.phone)}</a></p>
     <form data-huw-form><label class="form-group" style="display:block"><span class="form-label">Actual call outcome</span><select class="form-select" data-huw-status required><option value="">Choose the actual outcome</option>${Object.entries(outcomes).map(([value, label]) => `<option value="${value}" ${draft.status === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
     <label class="form-group" style="display:block"><span class="form-label">Call notes (optional)</span><textarea class="form-input" data-huw-notes rows="4" maxlength="2000">${sanitize(draft.notes)}</textarea><span class="due-meta">Up to2000 characters. A call attempt does not confirm HopeBot use.</span></label>
     <p data-huw-call-message role="status" aria-live="polite"></p><div class="huw-actions"><button type="submit" class="btn btn-primary">Save actual call outcome</button><button type="button" class="btn btn-secondary" data-huw-close>Close and keep entries here</button></div></form>`;
    const handle = { saved: false, receipt: null, feedback: null, modal: null, saving: false };
    handle.modal = showModal({ title: 'HopeBot lead call', content: body, dismissible: false }); dialog = handle;
    const here = () => {
      if (!current()) return false;
      if (!writable()) { dispose(); return false; }
      return dialog === handle && handle.modal.isCurrentModal();
    };
    const form = body.querySelector('form'), status = body.querySelector('[data-huw-status]'), notes = body.querySelector('[data-huw-notes]'), button = form.querySelector('[type=submit]');
    const callMessage = (value, error = false) => { const host = body.querySelector('[data-huw-call-message]'); if (host) { host.textContent = value; host.style.color = error ? 'var(--danger, #b42318)' : ''; } };
    const values = () => ({ status: status.value, notes: notes.value.trim() });
    form.addEventListener('input', () => {
      if (!here() || handle.saving) return;
      draft.status = status.value; draft.notes = notes.value;
      if (draft.attempted && draft.attempted.key !== JSON.stringify(values())) draft.attempted = null;
      button.textContent = 'Save actual call outcome'; callMessage('Unsaved entries.');
    });
    body.querySelector('[data-huw-dial]').onclick = event => { if (!here() || handle.saving) event.preventDefault(); };
    body.querySelector('[data-huw-close]').onclick = () => { if (here() && !handle.saving) closeDialog(handle); };
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (!here() || handle.saving || handle.saved) return;
      const data = values();
      if (!Object.hasOwn(outcomes, data.status) || data.notes.length > 2000 || !form.reportValidity()) return;
      const key = JSON.stringify(data);
      try { if (!draft.attempted || draft.attempted.key !== key) draft.attempted = { key, nonce: crypto.randomUUID() }; }
      catch { callMessage('Could not begin a safe save. Your entries are kept.', true); return; }
      const nonce = draft.attempted.nonce;
      handle.saving = true; button.disabled = true; status.disabled = true; notes.disabled = true;
      body.querySelector('[data-huw-close]').disabled = true; callMessage('Saving the actual call outcome...');
      try {
        const response = await getSupabase().rpc('hopebot_usage_log_call', { p_work: row.id, p_status: data.status, p_notes: data.notes, p_nonce: nonce });
        if (!here()) return;
        if (response?.error) throw response.error;
        const receipt = response?.data;
        if (!receipt || !uuid(receipt.call_id) || receipt.anchor_type !== 'lead_call' || receipt.work_id !== row.id
          || receipt.lead_id !== row.lead_id || receipt.patient_id != null || receipt.dial_status !== data.status) throw new Error('Unconfirmed lead call save');
        handle.saving = false; handle.saved = true; handle.receipt = receipt; drafts.delete(row.id);
        body.replaceChildren();
        const done = document.createElement('p'); done.textContent = 'The actual lead call was saved. Saving a call outcome alone does not confirm HopeBot use. Record what was said on this call below.'; body.append(done);
        const slot = document.createElement('div'); body.append(slot);
        handle.feedback = mountHopebotFeedback(slot, receipt.call_id, { anchorType: 'lead_call', isCurrent: () => here() && handle.saved });
        const back = document.createElement('button'); back.type = 'button'; back.className = 'btn btn-secondary'; back.style.marginTop = '14px'; back.textContent = 'Return to the shared daily list';
        back.onclick = () => { if (here()) closeDialog(handle); }; body.append(back);
        load().catch(() => {});
      } catch {
        if (!here()) return;
        handle.saving = false; button.disabled = false; status.disabled = false; notes.disabled = false;
        body.querySelector('[data-huw-close]').disabled = false; button.textContent = 'Retry the same call outcome';
        callMessage('Could not confirm the saved call. Your entries are kept. Retry the same entries safely; changed entries use a new save identifier. A changed or unavailable assignment may need manager review.', true);
      }
    });
  }
  async function startNext() {
    if (!current() || !writable()) return false;
    if (dialog) return true;
    if (!await load()) { if (current()) throw new Error('Could not confirm the lead daily list. Refresh and retry.'); return false; }
    if (!current() || !writable()) return false;
    const row = list.items.find(item => item.patient_id == null && item.servable);
    if (!row) return false;
    if (!await claim(row)) { if (current()) throw new Error('Could not open this assigned lead. Refresh and retry.'); return false; }
    return true;
  }
  const controller = { refresh: load, startNext, hasOpenCall: () => !!dialog || claiming, dispose }; mounts.set(element, controller);
  if (!uuid(memberId) || !owned()) { dispose(); return controller; }
  subscription = getSupabase().auth?.onAuthStateChange?.((_event, session) => { if (session?.user?.id !== getCurrentUser()?.id || identity !== account()) dispose(); })?.data?.subscription;
  if (disposed) { subscription?.unsubscribe(); return controller; }
  observer = new MutationObserver(checkIdentity); observer.observe(document.body, { childList: true, subtree: true });
  window.addEventListener('hashchange', checkIdentity); document.addEventListener('change', checkIdentity, true);
  load().catch(() => {}); return controller;
}
