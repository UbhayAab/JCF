// Patient-context entry to the existing, manually assigned medical request queue.
import * as auth from '../auth.js';
import { getSupabase } from '../supabase.js';
import { showModal } from './modal.js';
import { sanitize } from '../utils/validators.js';

const ROLES = new Set(['admin', 'manager', 'caller', 'caregiver_mentor']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function actorKey() {
  const user = auth.getCurrentUser();
  const profile = auth.getCurrentProfile?.();
  const real = auth.getRealProfile?.();
  if (!user?.id || auth.isImpersonating() || !profile || !real ||
      profile.id !== user.id || real.id !== user.id || profile.role !== real.role ||
      !ROLES.has(real.role) || real.is_active !== true || profile.is_active !== true ||
      real.must_change_password || profile.must_change_password) return null;
  return user.id + ':' + real.role;
}

export async function mountMedicalRequest130(mount, patient) {
  const actor = actorKey();
  const patientId = patient?.id;
  if (!mount?.isConnected || !actor || !UUID.test(patientId || '') ||
      patient.patient_status === 'deceased') return;
  const route = location.hash;
  const sb = getSupabase();
  let stopped = false, subscription = null, modal = null, dialog = null;
  let observer = null;

  function closeDialog() {
    const owned = modal;
    dialog = null;
    modal = null;
    if (owned) {
      const reason = owned.querySelector('textarea');
      if (reason) reason.value = '';
      owned.closeOwnedModal();
    }
  }
  function stop() {
    if (stopped) return;
    stopped = true;
    closeDialog();
    mount.replaceChildren();
    subscription?.unsubscribe();
    observer?.disconnect();
    window.removeEventListener('hashchange', stop);
    window.removeEventListener('pagehide', stop);
  }
  function current() {
    const valid = !stopped && mount.isConnected && patient.id === patientId &&
      patient.patient_status !== 'deceased' && location.hash === route && actorKey() === actor;
    if (!valid) stop();
    return valid;
  }
  function currentDialog(owner) {
    if (!current()) return false;
    if (dialog !== owner || !modal?.isCurrentModal() || !modal.isConnected) {
      if (dialog === owner) closeDialog();
      return false;
    }
    return true;
  }
  window.addEventListener('hashchange', stop);
  window.addEventListener('pagehide', stop);
  // Auth callbacks must stay synchronous: no SDK work under the Auth lock.
  subscription = sb.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT' || (session?.user?.id && !actor.startsWith(session.user.id + ':'))) stop();
    else current();
  }).data.subscription;
  if (stopped) { subscription.unsubscribe(); return; }
  observer = new MutationObserver(() => {
    if (!current()) return;
    if (dialog && (!modal?.isCurrentModal() || !modal.isConnected)) closeDialog();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  try {
    if (!current()) return;
    const { data, error } = await sb.rpc('can_care_for_patient', { p_id: patientId });
    if (!current()) return;
    if (error || data !== true) { stop(); return; }
  } catch {
    if (current()) stop();
    return;
  }
  if (!current()) return;
  mount.innerHTML = `<div class="card nw-request-prompt" data-medical-support>
    <div><h3>Medical support</h3><p class="nw-muted">Ask for medical navigator support for this patient. A manager assigns the request manually.</p></div>
    <button type="button" class="btn btn-primary" data-request-medical>Request medical navigator</button>
    <a class="btn btn-secondary" href="#medical-navigation">Open medical requests</a>
  </div>`;
  mount.querySelector('[data-request-medical]').addEventListener('click', () => {
    if (!current()) return;
    closeDialog();
    const owner = {};
    modal = showModal({
      title: 'Request medical navigator',
      onClose: closeDialog,
      content: `<form class="nw-form" data-medical-request-form>
        <p>Request support for <strong>${sanitize(patient.full_name || patient.patient_name || 'this patient')}</strong>.</p>
        <p class="nw-muted">The request goes to Medical navigation. A manager assigns a navigator manually.</p>
        <div class="form-group"><label class="form-label" for="medical-request-reason">Reason for support</label>
          <textarea id="medical-request-reason" class="form-input" rows="4" maxlength="4000" required></textarea></div>
        <p role="status" data-medical-result hidden></p>
        <a class="btn btn-secondary" href="#medical-navigation" data-medical-next hidden style="display:none">Open medical requests</a>
        <div class="nw-actions"><button type="button" class="btn btn-secondary" data-medical-cancel>Cancel</button>
          <button type="submit" class="btn btn-primary">Submit request</button></div>
      </form>`,
    });
    dialog = owner;
    const form = modal.querySelector('form');
    const reason = form.querySelector('textarea');
    const submit = form.querySelector('[type=submit]');
    const cancel = form.querySelector('[data-medical-cancel]');
    const result = form.querySelector('[data-medical-result]');
    const next = form.querySelector('[data-medical-next]');
    let pending = false, settled = false;
    cancel.addEventListener('click', closeDialog);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (!currentDialog(owner) || pending || settled || !form.reportValidity()) return;
      const text = reason.value.trim();
      if (!text || text.length > 4000) {
        result.textContent = 'Add a reason of 1 to 4000 characters.';
        result.hidden = false;
        reason.focus();
        return;
      }
      pending = true;
      submit.disabled = true;
      reason.readOnly = true;
      result.hidden = true;
      submit.textContent = 'Checking access...';
      try {
        if (!currentDialog(owner)) return;
        const access = await sb.rpc('can_care_for_patient', { p_id: patientId });
        if (!currentDialog(owner)) return;
        if (access.error || access.data !== true) {
          settled = true;
          result.textContent = 'Your access could not be confirmed. No request was submitted. Close this form and refresh the patient page.';
          result.hidden = false;
          submit.textContent = 'Access unavailable';
          return;
        }
      } catch {
        if (!currentDialog(owner)) return;
        pending = false;
        submit.disabled = false;
        reason.readOnly = false;
        submit.textContent = 'Submit request';
        result.textContent = 'Could not check access. No request was submitted. Please try again.';
        result.hidden = false;
        return;
      }
      if (!currentDialog(owner)) return;
      submit.textContent = 'Submitting request...';
      // The server serialises requests per patient and preserves an existing open
      // request. A lost response may follow a commit, so never replay this write.
      settled = true;
      try {
        const { data, error } = await sb.rpc('medical_navigation_raise', { p_patient: patientId, p_reason: text });
        if (!currentDialog(owner)) return;
        if (error) throw error;
        if (!UUID.test(data?.id || '') || typeof data.created !== 'boolean') throw new Error('Unconfirmed response');
        result.textContent = data.created
          ? 'Request raised. A manager will assign a medical navigator manually. Follow it in Medical navigation.'
          : 'An open medical request already exists. Its original reason and assignment were preserved; this new note was not saved. Follow it in Medical navigation.';
        submit.remove();
        cancel.textContent = 'Close';
      } catch (error) {
        if (!currentDialog(owner)) return;
        result.textContent = error?.code === '42501'
          ? 'The server refused this request. Close the form and refresh your patient access before trying again.'
          : 'The request was not confirmed and may have been received. Check Medical navigation before submitting anything again. Your note remains here until you close this form.';
        submit.remove();
      }
      if (!currentDialog(owner)) return;
      result.hidden = false;
      next.hidden = false;
      next.style.removeProperty('display');
    });
    reason.focus();
  });
}
