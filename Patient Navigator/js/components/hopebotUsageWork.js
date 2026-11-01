import { getSupabase } from '../supabase.js';
import { getCurrentUser, getCurrentProfile, getRealProfile, isImpersonating } from '../auth.js';
import { sanitize } from '../utils/validators.js';
import { indiaCallDay, validDay } from '../utils/careFollowup.js';
import { mountFamilyContactCall136, draftStore136, transition136, uuid136, receipt136 } from './familyContactCall136.js';
import { mountHopebotFeedback } from './hopebotFeedback.js';

const mounts = new WeakMap();
const account = () => JSON.stringify([getCurrentUser()?.id, getRealProfile()?.id, getCurrentProfile()?.id, isImpersonating()]);
const node = value => { try { return typeof value === 'function' ? value() : value; } catch { return null; } };
function active() {
  const p = getRealProfile();
  return !!getCurrentUser()?.id && p?.id === getCurrentUser().id && p.is_active === true
    && ['admin', 'manager', 'caller', 'caregiver_mentor', 'nutritionist', 'therapist'].includes(p.role)
    && (!p.ends_on || p.ends_on >= indiaCallDay());
}
export function familyWorklist136(data, member) {
  if (!data || data.member_id !== member || data.day !== indiaCallDay() || !Number.isSafeInteger(data.pending) || data.pending < 0
    || !Array.isArray(data.items) || data.items.length > 100 || data.pending < data.items.length) throw new Error('Unconfirmed family list');
  const ids = new Set();
  const items = data.items.map(row => {
    if (!row || !uuid136(row.id) || ids.has(row.id) || (row.lead_id != null && !uuid136(row.lead_id)) || (row.patient_id != null && !uuid136(row.patient_id))
      || !validDay(row.due_day) || !['pending', 'calling', 'held'].includes(row.state) || typeof row.servable !== 'boolean' || typeof row.awaiting_capacity !== 'boolean'
      || typeof row.name !== 'string' || row.name.length > 1000 || typeof row.features_text !== 'string' || row.features_text.length > 2000
      || (row.hold != null && typeof row.hold !== 'string')
      || (row.servable && (!uuid136(row.lead_id) || row.hold != null || row.state === 'held' || row.due_day > data.day))) throw new Error('Unconfirmed family item');
    ids.add(row.id); return { ...row };
  });
  return { ...data, items };
}

// The legacy public interface stays stable. Contact rows are an extension of
// today's shared list; the intake channel does not select a smaller call form.
export function mountHopebotUsageWork(element, { memberId, isCurrent = () => true, preview = false, onReturn = () => {},
  callHost, listHost, listCard, countHost, onRegistered = async () => { throw new Error('The verified patient workspace is unavailable.'); } } = {}) {
  if (!element) return { refresh: async () => false, refreshRows() {}, startNext: async () => false, hasOpenCall: () => false, dispose() {} };
  mounts.get(element)?.dispose();
  const identity = account(), route = window.location.hash, store = draftStore136(identity);
  let disposed = false, generation = 0, loading = false, claiming = false, list = null, session = null, activeRow = null, observer, subscription;
  let error = '', autoResumed = false, handoffActive = false, rowsOwner = null;
  const previewing = () => { try { return isImpersonating() || (typeof preview === 'function' ? !!preview() : !!preview); } catch { return true; } };
  const owned = () => { try { return !disposed && mounts.get(element) === controller && element.isConnected && identity === account() && route === window.location.hash && active() && isCurrent(); } catch { return false; } };
  const writable = () => {
    const p = getRealProfile();
    return owned() && !previewing() && memberId === getCurrentUser()?.id && getCurrentProfile()?.id === memberId
      && ['caller', 'caregiver_mentor'].includes(p?.role) && Object.hasOwn(p, 'on_probation') && !p.on_probation;
  };
  function current(seq = generation) { if (disposed || seq !== generation) return false; if (!owned()) { dispose({ erase: identity !== account() }); return false; } return true; }
  function removeRows() { rowsOwner?.remove(); rowsOwner = null; }
  function dispose({ erase = false } = {}) {
    if (disposed) return;
    disposed = true;
    // Route disposal preserves this owner's draft, identity disposal clears it.
    session?.dispose({ erase }); session = null;
    if (erase) store.clearOwner();
    generation++; observer?.disconnect(); subscription?.unsubscribe(); removeRows();
    window.removeEventListener('hashchange', checkIdentity); document.removeEventListener('change', checkIdentity, true);
    if (mounts.get(element) === controller) { element.replaceChildren(); mounts.delete(element); }
    list = null; activeRow = null;
  }
  function checkIdentity() {
    if (identity !== account()) { dispose({ erase: true }); return; }
    if (!owned() || (session && !writable())) dispose();
  }
  function refreshRows() {
    if (!current() || session) return;
    removeRows();
    const target = node(listHost);
    const host = target?.querySelector('.due-list') || target || element;
    const wrapper = document.createElement('div'); wrapper.dataset.familyRows136 = ''; wrapper.className = 'family-rows136';
    rowsOwner = wrapper; host.append(wrapper);
    const items = (list?.items || []).filter(row => row.patient_id == null);
    const recoveries = writable() ? store.pending().filter(d => d.attempted) : [];
    wrapper.innerHTML = `<style>.family-rows136{display:contents}.family-rows136 .due-row{min-width:0;overflow-wrap:anywhere}.family-rows136 .due-meta{white-space:normal}.family-rows136 .btn{white-space:normal}</style>
      ${previewing() ? '<p class="due-meta">Preview is read-only. Return to your own account to call or save.</p>' : ''}
      ${error ? `<p role="alert">${sanitize(error)}</p>` : loading ? '<p role="status">Confirming today\'s remaining families...</p>' : ''}
      ${items.map((row, i) => `<article class="due-row wl-row" data-family-row136="${i}"><div><strong>${sanitize(row.name)}</strong><span class="badge badge-info" style="margin-left:8px">HopeBot channel</span><p class="due-meta">${sanitize(row.features_text || 'Saved intake contact')}<br>Original due day: ${sanitize(row.due_day)}</p><p class="due-meta">${row.hold || row.state === 'held' ? 'Held for review. This row cannot be called.' : row.awaiting_capacity ? 'Waiting for a future daily plan. No replacement slot is added today.' : row.servable ? row.state === 'calling' ? 'Call opened. Resume the same actual call.' : 'Ready in today\'s shared daily list.' : 'Waiting for its due day or contact rest.'}</p></div>${row.servable ? `<button type="button" class="btn btn-secondary" data-family-start136 ${!writable() || claiming ? 'disabled' : ''}>${row.state === 'calling' ? 'Resume this call' : 'Start this call'}</button>` : ''}</article>`).join('')}
      ${list && list.pending > list.items.length ? '<p class="due-meta">This bounded view shows up to 100 contact tasks, with admitted work first. More waiting work remains in the manager tracker.</p>' : ''}
      ${recoveries.map((d, i) => `<article class="due-row wl-row"><p>One earlier call save is unconfirmed. Recover its exact receipt before changing those answers.</p><button type="button" class="btn btn-secondary" data-family-recover136="${i}">Recover previous save</button></article>`).join('')}
      ${(error || items.length || loading) ? '<button type="button" class="btn btn-ghost btn-sm" data-family-refresh136>Refresh today\'s contacts</button>' : ''}`;
    wrapper.querySelectorAll('[data-family-row136]').forEach(el => { const row = items[Number(el.dataset.familyRow136)]; el.querySelector('[data-family-start136]')?.addEventListener('click', () => { if (current() && writable()) claim(row); }); });
    wrapper.querySelector('[data-family-refresh136]')?.addEventListener('click', () => load());
    wrapper.querySelectorAll('[data-family-recover136]').forEach(el => el.onclick = () => { if (current() && writable()) recoverSave(recoveries[Number(el.dataset.familyRecover136)]); });
    const count = node(countHost), eligible = items.filter(row => row.servable).length;
    if (count) { const patients = Number(count.dataset.patientCount); count.dataset.contactCount = String(eligible); if (Number.isSafeInteger(patients) && patients >= 0) count.textContent = String(patients + eligible); }
    const card = node(listCard); if (card && (items.length || recoveries.length || loading || error)) { card.hidden = false; card.style.display = ''; }
    // The legacy mount is a lifecycle anchor, not another HopeBot list card.
    if (target && !element.contains(wrapper)) element.replaceChildren();
  }
  async function rpc(name, args) {
    if (!current() || !writable()) throw new Error('This account cannot write this assigned call.');
    const seq = generation;
    const response = await getSupabase().rpc(name, args);
    if (!current(seq) || !writable()) throw new Error('The call identity or assignment changed.');
    if (response?.error) throw response.error;
    return response?.data;
  }
  async function load({ restore = true } = {}) {
    if (!current() || claiming || session) return false;
    const seq = ++generation; loading = true; error = ''; refreshRows();
    try {
      const response = await getSupabase().rpc('family_call_worklist136', { p_member: memberId });
      if (!current(seq)) return false;
      if (response?.error) throw response.error;
      list = familyWorklist136(response?.data, memberId); loading = false; refreshRows();
      if (restore && !autoResumed && writable()) {
        autoResumed = true;
        const drafts = store.pending();
        // Only a server-authorized active row may restore ordinary contact
        // drafts. A committed registration can be absent from the unlinked
        // list, so its typed saved envelope is revalidated by resume itself.
        for (const draft of drafts) {
          if (draft.attempted) { if (draft.resume_on_load !== false) { await recoverSave(draft); break; } continue; }
          if (draft.resume_on_load === false && !draft.transition && !draft.registration) continue;
          const row = list.items.find(x => x.id === draft.work_id && x.lead_id === draft.lead_id && x.servable && x.patient_id == null);
          if (row || draft.transition || draft.registration) {
            const candidate = row || { id: draft.work_id, lead_id: draft.lead_id, patient_id: null, servable: true };
            if (await claim(candidate, draft)) break;
          }
        }
      }
      return true;
    } catch {
      handoffActive = false;
      if (!current(seq)) return false;
      loading = false; list = null; error = 'Could not confirm today\'s contact work. Nothing has been marked finished. Refresh and retry.'; refreshRows(); return false;
    }
  }
  async function returnToList(receipt = null) {
    if (!current()) return;
    session?.dispose(); session = null; activeRow = null; removeRows();
    try { await onReturn(receipt); }
    catch { if (current()) { error = 'The call state is kept. Refresh today\'s list to confirm the current plan.'; refreshRows(); } }
  }
  async function recoverSave(draft) {
    if (!current() || !writable() || session || claiming || !draft?.attempted) return false;
    const seq = generation, attempt = JSON.parse(JSON.stringify(draft.attempted));
    let recoveryDisposed = false, saving = false, feedback = null;
    const here = () => !recoveryDisposed && current(seq) && writable();
    const host = node(callHost); removeRows();
    if (host && host !== element && !element.contains(host)) host.replaceChildren(element);
    if (!current(seq)) return false;
    session = { dispose() { recoveryDisposed = true; feedback?.dispose(); element.replaceChildren(); } };
    element.innerHTML = '<div class="portal-grid"><div class="col-left"><section class="card" style="padding:16px"><h3>Recover the previous call save</h3><p>No new call has been opened. The exact original answers and save identifier are retained.</p></section></div><div class="col-right"><section class="card" style="padding:16px"><p data-recovery-message136 role="status"></p><div data-recovery-feedback136></div><button type="button" class="btn btn-primary" data-recovery-retry136>Retry the same save</button><button type="button" class="btn btn-secondary" data-recovery-close136>Return to today\'s calls</button></section></div></div>';
    const retry = element.querySelector('[data-recovery-retry136]'), close = element.querySelector('[data-recovery-close136]'), message = element.querySelector('[data-recovery-message136]');
    close.onclick = () => { if (!here() || saving) return; draft.resume_on_load = false; store.write(draft); returnToList(); };
    async function retryReceipt() {
      if (!here() || saving) return;
      saving = true; retry.disabled = true; close.disabled = true; message.textContent = 'Confirming the exact saved call...';
      try {
        const receipt = await rpc('family_call_save136', { p_work: draft.work_id, p_nonce: attempt.nonce, p_fields: JSON.parse(JSON.stringify(attempt.fields)) });
        if (!here()) return;
        if (!receipt136(receipt, draft.work_id, draft.lead_id, attempt.fields)) throw new Error('Unconfirmed receipt');
        store.remove(draft.work_id); saving = false; retry.remove(); close.disabled = false;
        message.textContent = 'Call saved. Its complete answers and original save identifier were confirmed; no new daily slot was opened.';
        if (attempt.fields.consent === 'given') feedback = mountHopebotFeedback(element.querySelector('[data-recovery-feedback136]'), receipt.call_id, { anchorType: 'lead_call', isCurrent: here });
        close.onclick = () => { if (here()) returnToList(receipt); };
      } catch (error) {
        if (!here()) return;
        saving = false; retry.disabled = false; close.disabled = false;
        message.textContent = 'The saved call could not be confirmed. Its exact answers are kept. Retry safely or ask a manager to review changed ownership or identity.';
        const row = list?.items.find(r => r.id === draft.work_id && r.lead_id === draft.lead_id && r.servable && r.patient_id == null);
        if (String(error?.code) === '22023' && row) {
          message.textContent = error.message || 'The server rejected the request without saving. Reopen the authorized call to correct the answers.';
          retry.textContent = 'Correct rejected answers'; retry.onclick = async () => { if (!here()) return; draft.attempted = null; draft.resume_on_load = true; store.write(draft); session.dispose(); session = null; await claim(row, draft); };
        }
      }
    }
    retry.onclick = retryReceipt; await retryReceipt(); return true;
  }
  async function claim(row, restored = null) {
    if (!current() || !writable() || claiming || loading || session || !row?.servable || row.patient_id != null || !uuid136(row.id) || !uuid136(row.lead_id)) return false;
    const seq = generation; claiming = true; error = ''; refreshRows();
    try {
      const value = await rpc('family_call_resume136', { p_work: row.id });
      if (!current(seq) || !writable()) return false;
      if (!value || value.work_id !== row.id || (value.id != null && value.id !== row.id) || value.lead_id !== row.lead_id) throw new Error('The family anchor changed.');
      const draft = restored || store.read(row.id, row.lead_id);
      if (value.anchor_type === 'patient_call') {
        if (!transition136(value, row.id, row.lead_id)) throw new Error('Patient transition is unconfirmed.');
        handoffActive = true;
        if (!draft) { await onRegistered(value, { version: 1, verified_transition_recovery: true, work_id: row.id, lead_id: row.lead_id, duration_seconds: 0, fields: { consent: 'given' } }); return true; }
        if (draft.fields.consent !== 'given') throw new Error('The retained patient transition draft lacks explicit care consent.');
        draft.transition = value; store.write(draft);
        const snap = draft.registration?.snapshot || { version: 1, work_id: row.id, lead_id: row.lead_id, fields: draft.fields, clinical: draft.fields.clinical, consent: draft.fields.consent,
          started_at: draft.clock?.running_since == null ? null : draft.clock.running_since - (draft.clock.elapsed_seconds || 0) * 1000,
          duration_seconds: draft.manual_seconds ?? Math.min(36000, (draft.clock?.elapsed_seconds || 0) + (draft.clock?.running_since == null ? 0 : Math.max(0, Math.floor((Date.now() - draft.clock.running_since) / 1000)))),
          timer_running: draft.clock?.running_since != null, clock: draft.clock, manual_seconds: draft.manual_seconds, attempted: draft.attempted };
        await onRegistered(value, snap); store.remove(row.id); return true;
      }
      if (value.anchor_type !== 'lead_call' || value.patient_id != null || typeof value.name !== 'string' || value.name.length > 1000 || typeof value.phone !== 'string'
        || !/^[1-9][0-9]{7,14}$/.test(value.phone) || typeof value.claimed_cutoff !== 'string' || !Number.isFinite(Date.parse(value.claimed_cutoff))) throw new Error('Unconfirmed assigned family call');
      if (draft?.transition) throw new Error('The saved patient transition no longer matches the server anchor.');
      claiming = false; activeRow = row; removeRows();
      const host = node(callHost);
      if (host && host !== element && !element.contains(host)) host.replaceChildren(element);
      if (!current(seq)) return false;
      handoffActive = false;
      session = mountFamilyContactCall136(element, { row, claimed: value, rpc, current: () => current(seq) && writable(), store, draft,
        onClose: returnToList, onRegistered,
        onSkip: async skipped => {
          if (!current(seq)) return;
          session?.dispose(); session = null; activeRow = null;
          // Reload the frozen shared plan; only another already admitted row
          // may start. The skipped slot is neither completed nor replenished.
          if (!await load({ restore: false })) { await returnToList(); return; }
          const next = list.items.find(x => x.id !== skipped && x.patient_id == null && x.servable);
          if (next) { if (!await claim(next)) await returnToList(); } else await returnToList();
        } });
      return true;
    } catch {
      handoffActive = false;
      if (!current(seq)) return false;
      error = 'Could not verify this assigned family or patient transition. The draft is kept. No unverified phone is shown; refresh or ask a manager to review changed ownership.'; refreshRows(); return false;
    } finally { if (current(seq)) { claiming = false; if (!session) refreshRows(); } }
  }
  async function startNext() {
    if (!current() || !writable()) return false;
    if (session || claiming || handoffActive) return true;
    if (!await load()) { if (current()) throw new Error('Could not confirm the shared daily list.'); return false; }
    if (session || handoffActive) return true;
    const pendingSave = store.pending().find(d => d.attempted); if (pendingSave) return recoverSave(pendingSave);
    const row = list?.items.find(x => x.patient_id == null && x.servable);
    if (!row) return false;
    const opened = await claim(row);
    if (!opened && current()) throw new Error('Could not verify the assigned family.');
    return opened;
  }
  const controller = { refresh: load, refreshRows, startNext, hasOpenCall: () => !!session || claiming || handoffActive, dispose };
  mounts.set(element, controller);
  if (!uuid136(memberId) || !owned()) { dispose(); return controller; }
  subscription = getSupabase().auth?.onAuthStateChange?.((event, authSession) => { if (event === 'SIGNED_OUT' || authSession?.user?.id !== getCurrentUser()?.id || identity !== account()) dispose({ erase: true }); })?.data?.subscription;
  if (disposed) { subscription?.unsubscribe(); return controller; }
  observer = new MutationObserver(checkIdentity); observer.observe(document.body, { childList: true, subtree: true });
  window.addEventListener('hashchange', checkIdentity); document.addEventListener('change', checkIdentity, true);
  load().catch(() => {}); return controller;
}
