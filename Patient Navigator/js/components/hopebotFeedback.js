import { getSupabase } from '../supabase.js';
import { getCurrentUser, getCurrentProfile, getRealProfile, isImpersonating } from '../auth.js';
import { sanitize } from '../utils/validators.js';
import { showToast } from './toast.js';

export const HOPEBOT_FEEDBACK_FEATURES = Object.freeze({
  doctor_search: 'Finding a doctor', money_help: 'Financial help', stay_travel: 'Stay or travel',
  diet: 'Diet support', trials: 'Clinical trials', community: 'Community', passport: 'Health passport',
  roadmap: 'Treatment roadmap', reports_review: 'Report review', medical_question: 'Medical question',
  feelings: 'Emotional support', other: 'Other',
});
const mounts = new WeakMap();
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const kinds = new Set(['patient_call', 'lead_call']);
const account = () => JSON.stringify([getCurrentUser()?.id, getRealProfile()?.id, getCurrentProfile()?.id, isImpersonating()]);
function activeMember() {
  const profile = getRealProfile();
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const today = ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)?.value).join('-');
  return !!getCurrentUser()?.id && profile?.id === getCurrentUser().id && profile.is_active === true && (!profile.ends_on || profile.ends_on >= today);
}
function nonce() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16); globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function record(data, callId, kind) {
  if (!data || data.call_id !== callId || data.anchor_type !== kind || !Number.isSafeInteger(data.version) || data.version < 0 || !['unknown', 'yes', 'no'].includes(data.usage)) throw new Error('Unconfirmed feedback');
  const patient = data.patient_id ?? null, lead = data.lead_id ?? null;
  if ((patient !== null && !uuid(patient)) || (lead !== null && !uuid(lead)) || (kind === 'patient_call' && !uuid(patient)) || (kind === 'lead_call' && !uuid(lead))) throw new Error('Unconfirmed call identity');
  if (typeof data.dial_status !== 'string' || !data.dial_status || (data.dial_status !== 'connected' && data.usage !== 'unknown')) throw new Error('Unconfirmed call outcome');
  if (!Array.isArray(data.features) || data.features.length > 12 || new Set(data.features).size !== data.features.length || data.features.some(code => !Object.hasOwn(HOPEBOT_FEEDBACK_FEATURES, code))) throw new Error('Unconfirmed features');
  const other = data.other ?? '', feedback = data.feedback ?? '';
  if (typeof other !== 'string' || other.length > 500 || typeof feedback !== 'string' || feedback.length > 2000 || (data.usage !== 'yes' && (data.features.length || other)) || (other && !data.features.includes('other'))) throw new Error('Unconfirmed feedback fields');
  return { ...data, patient_id: patient, lead_id: lead, features: [...data.features].sort(), other, feedback };
}
const values = data => ({ usage: data.usage, features: [...data.features].sort(), other: data.other.trim(), feedback: data.feedback.trim() });
const key = data => JSON.stringify(values(data));
const sameAnchor = (a, b) => a.patient_id === b.patient_id && a.lead_id === b.lead_id;
const stale = error => String(error?.code) === '40001' || String(error?.code) === '409' || Number(error?.status) === 409;

export function mountHopebotFeedback(element, callId, { isCurrent = () => true, preview = false, anchorType = 'patient_call' } = {}) {
  if (!element) return { refresh() {}, dispose() {} };
  mounts.get(element)?.dispose();
  const identity = account(), route = window.location.hash;
  let disposed = false, generation = 0, loaded = null, saving = false, loading = false;
  let uncertain = false, needsReload = false, attempted = null, observer, subscription, pinnedAnchor = null, anchorChanged = false;
  const previewing = () => { try { return isImpersonating() || (typeof preview === 'function' ? !!preview() : !!preview); } catch { return true; } };
  const owned = () => {
    try { return !disposed && mounts.get(element) === controller && element.isConnected && route === window.location.hash && identity === account() && activeMember() && isCurrent(); } catch { return false; }
  };
  function dispose() {
    if (disposed) return;
    disposed = true; generation++; observer?.disconnect(); subscription?.unsubscribe();
    window.removeEventListener('hashchange', checkIdentity);
    document.removeEventListener('change', checkIdentity, true);
    if (mounts.get(element) === controller) { element.replaceChildren(); mounts.delete(element); }
    loaded = null; attempted = null;
  }
  function checkIdentity() { if (!owned()) dispose(); }
  function current(seq = generation) { if (seq !== generation || disposed) return false; if (!owned()) { dispose(); return false; } return true; }
  function message(text, error = false) {
    const host = element.querySelector('[data-hbf-message]');
    if (host) { host.textContent = text; host.style.color = error ? 'var(--danger, #b42318)' : ''; }
  }
  function draft() {
    const form = element.querySelector('form');
    const usage = form?.querySelector('[name="hbf-usage"]:checked')?.value || 'unknown';
    return { usage, features: usage === 'yes' ? [...form.querySelectorAll('[data-hbf-feature]:checked')].map(input => input.value).sort() : [], other: usage === 'yes' && form.querySelector('[data-hbf-feature="other"]')?.checked ? form.querySelector('[data-hbf-other]').value.trim() : '', feedback: form?.querySelector('[data-hbf-feedback]')?.value.trim() || '' };
  }
  const dirty = () => !!loaded && !!element.querySelector('form') && key(draft()) !== key(loaded);
  function controls() {
    const form = element.querySelector('form'); if (!form || !loaded) return;
    const readOnly = previewing() || loaded.can_edit !== true;
    form.querySelector('[data-hbf-fields]').disabled = saving || readOnly || needsReload;
    const button = form.querySelector('[type="submit"]');
    button.disabled = saving || readOnly || needsReload || (loaded.version > 0 && !dirty() && !uncertain);
    button.textContent = saving ? 'Saving...' : uncertain ? 'Retry save' : loaded.version ? 'Save correction' : 'Save feedback';
    const explanation = form.querySelector('[data-hbf-readonly]');
    explanation.hidden = !readOnly;
    explanation.textContent = previewing() ? 'Preview is read-only. No feedback can be saved here.' : 'This saved call is read-only for your account.';
    form.querySelector('[data-hbf-reload-confirm-wrap]').hidden = !dirty();
    form.querySelector('[data-hbf-reload]').disabled = saving || (dirty() && !form.querySelector('[data-hbf-reload-confirm]').checked);
  }
  function paint() {
    element.innerHTML = `<section class="card hbf-feedback" style="padding:16px;min-width:0;overflow-wrap:anywhere">
      <style>.hbf-feedback fieldset{border:0;padding:0;margin:0;min-width:0}.hbf-feedback .hbf-choices,.hbf-feedback .hbf-actions{display:flex;flex-wrap:wrap;gap:10px;align-items:center}.hbf-feedback .hbf-choice{display:flex;gap:8px;align-items:center;min-height:32px}.hbf-feedback .hbf-features{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr));gap:6px 12px}.hbf-feedback input[type=radio],.hbf-feedback input[type=checkbox]{flex:0 0 auto}.hbf-feedback textarea{width:100%;max-width:100%;box-sizing:border-box;resize:vertical}.hbf-feedback p,.hbf-feedback .due-meta{white-space:normal;overflow-wrap:anywhere}.hbf-feedback [hidden]{display:none!important}</style>
      <h3>HopeBot usage and feedback</h3><p class="due-meta">For this saved ${anchorType === 'lead_call' ? 'lead ' : ''}call. This does not change the call outcome or source history.</p>
      <form><fieldset data-hbf-fields><fieldset><legend class="form-label">Did the patient or caregiver use HopeBot?</legend><div class="hbf-choices">${[['unknown', 'Not asked / unknown'], ['yes', 'Yes'], ['no', 'No']].filter(([code]) => loaded.dial_status === 'connected' || code === 'unknown').map(([code, label]) => `<label class="hbf-choice"><input type="radio" name="hbf-usage" value="${code}" ${loaded.usage === code ? 'checked' : ''}>${label}</label>`).join('')}</div></fieldset>
      ${loaded.dial_status !== 'connected' ? '<p class="due-meta">This call did not connect. Usage must remain Not asked / unknown; feedback can still describe the attempt.</p>' : '<p class="due-meta">Record what was said on the call. Missing bot activity does not mean No.</p>'}
      ${loaded.usage_invalidated === true ? '<p class="due-meta" data-hbf-usage-invalidated role="status">The call outcome changed. Present usage is Not asked / unknown. The earlier usage answer remains in history.</p>' : ''}
      <div data-hbf-yes><fieldset><legend class="form-label">Features or purpose (if known)</legend><div class="hbf-features">${Object.entries(HOPEBOT_FEEDBACK_FEATURES).map(([code, label]) => `<label class="hbf-choice"><input type="checkbox" value="${code}" data-hbf-feature="${code}" ${loaded.features.includes(code) ? 'checked' : ''}>${label}</label>`).join('')}</div></fieldset>
      <label class="form-group" data-hbf-other-wrap style="display:block;margin-top:12px"><span class="form-label">Other purpose</span><textarea class="form-input" data-hbf-other minlength="3" maxlength="500" rows="2">${sanitize(loaded.other)}</textarea><span class="due-meta">Use at least 3 characters, up to 500.</span></label></div>
      <label class="form-group" style="display:block;margin-top:12px"><span class="form-label">Feedback (optional)</span><textarea class="form-input" data-hbf-feedback maxlength="2000" rows="4">${sanitize(loaded.feedback)}</textarea><span class="due-meta">Up to 2000 characters. Keep to what was reported or observed on this call.</span></label></fieldset>
      <p data-hbf-readonly class="due-meta" hidden></p><p data-hbf-message role="status" aria-live="polite"></p>
      <div class="hbf-actions"><button type="submit" class="btn btn-primary">Save feedback</button><button type="button" class="btn btn-secondary" data-hbf-reload>Reload saved feedback</button></div>
      <label class="hbf-choice" data-hbf-reload-confirm-wrap style="margin-top:10px" hidden><input type="checkbox" data-hbf-reload-confirm>Discard my unsaved entries when reloading.</label>
      </form></section>`;
    const form = element.querySelector('form');
    function yesFields() {
      const d = draft(); form.querySelector('[data-hbf-yes]').hidden = d.usage !== 'yes';
      form.querySelector('[data-hbf-other-wrap]').hidden = !d.features.includes('other');
      form.querySelector('[data-hbf-other]').required = d.usage === 'yes' && d.features.includes('other');
    }
    form.addEventListener('input', event => {
      if (!current() || saving || previewing() || loaded.can_edit !== true || needsReload) return;
      if (event.target.matches('[name="hbf-usage"]') && event.target.value !== 'yes') {
        form.querySelectorAll('[data-hbf-feature]').forEach(input => { input.checked = false; }); form.querySelector('[data-hbf-other]').value = '';
      }
      form.querySelector('[data-hbf-other]').setCustomValidity('');
      if (attempted && attempted.key !== key(draft())) attempted = null;
      uncertain = false; yesFields(); controls(); message(dirty() ? 'Unsaved entries.' : '');
    });
    form.querySelector('[data-hbf-reload-confirm]').onchange = controls;
    form.querySelector('[data-hbf-reload]').onclick = async () => {
      if (!current() || saving || (dirty() && !form.querySelector('[data-hbf-reload-confirm]').checked)) return;
      await load();
    };
    form.addEventListener('submit', saveFeedback);
    yesFields(); controls();
    message(loaded.usage_invalidated === true ? `Version ${loaded.version}: the earlier usage answer is retained in history; present usage is unknown after the call outcome changed.` : loaded.version ? `Saved feedback - version ${loaded.version}. Corrections retain server history.` : 'No feedback has been saved for this call.');
  }
  async function saveFeedback(event) {
    event.preventDefault();
    if (!current() || !loaded || saving || loading || needsReload) return;
    if (previewing() || loaded.can_edit !== true) { controls(); message('This view is read-only. Nothing was saved.', true); return; }
    const form = element.querySelector('form'), data = draft();
    if (loaded.dial_status !== 'connected' && data.usage !== 'unknown') { message('An unconnected call must keep usage unknown.', true); return; }
    if (data.features.includes('other') && data.other.length < 3) form.querySelector('[data-hbf-other]').setCustomValidity('Add at least 3 characters for Other purpose.');
    if (!form.reportValidity() || data.other.length > 500 || data.feedback.length > 2000) return;
    const expected = loaded, seq = generation, draftKey = key(data);
    try { if (!attempted || attempted.key !== draftKey) attempted = { key: draftKey, nonce: nonce() }; }
    catch { message('Could not start a safe save. Your entries are kept. Reload the app and try again.', true); return; }
    const operation = attempted.nonce;
    saving = true; controls(); message('Saving feedback...');
    try {
      const response = await getSupabase().rpc('hopebot_feedback_save', { p_call: callId, p_kind: anchorType, p_usage: data.usage, p_features: data.features, p_other: data.other, p_feedback: data.feedback, p_expected: expected.version, p_nonce: operation });
      if (!current(seq)) return;
      if (response?.error) throw { ...response.error, status: response.error.status ?? response.status };
      const saved = record(response?.data, callId, anchorType);
      if (!sameAnchor(saved, expected) || saved.version !== expected.version + 1 || key(saved) !== draftKey) throw new Error('Save not confirmed');
      loaded = saved; attempted = null; uncertain = false; saving = false; paint(); message('Feedback saved.');
      showToast('HopeBot feedback saved.', 'success');
    } catch (error) {
      if (!current(seq)) return;
      saving = false; needsReload = stale(error); uncertain = !needsReload;
      message(needsReload ? 'A newer version exists. Your entries are kept and are not saved. Reload the saved feedback explicitly before making a correction.' : 'Could not confirm the save. Your entries are kept. Retry the same entries safely, or reload the saved feedback.', true);
      controls();
    }
  }
  async function load() {
    if (!current() || saving || anchorChanged) return;
    const seq = ++generation; loading = true;
    element.innerHTML = '<section class="card" style="padding:16px"><h3>HopeBot usage and feedback</h3><p role="status">Loading feedback for this saved call...</p></section>';
    try {
      const response = await getSupabase().rpc('hopebot_feedback_get', { p_call: callId, p_kind: anchorType });
      if (!current(seq)) return;
      if (response?.error) throw response.error;
      const next = record(response?.data, callId, anchorType);
      if (pinnedAnchor && !sameAnchor(next, pinnedAnchor)) {
        loaded = null; attempted = null; loading = false; anchorChanged = true;
        element.innerHTML = '<section class="card" style="padding:16px"><h3>HopeBot usage and feedback</h3><p role="alert">The saved call link changed. Close this view and reopen the correct call. Nothing can be saved here.</p></section>';
        return;
      }
      pinnedAnchor = { patient_id: next.patient_id, lead_id: next.lead_id };
      loaded = next; loading = false; uncertain = false; needsReload = false; attempted = null; paint();
    } catch {
      if (!current(seq)) return;
      loading = false;
      element.innerHTML = '<section class="card" style="padding:16px"><h3>HopeBot usage and feedback</h3><p role="alert">Could not verify feedback for this saved call. Nothing can be saved here until it loads.</p><button type="button" class="btn btn-secondary" data-hbf-retry>Retry load</button></section>';
      element.querySelector('[data-hbf-retry]').onclick = () => { if (current()) load(); };
    }
  }
  async function refresh() {
    if (!current() || saving || anchorChanged) return;
    if (dirty() || uncertain || needsReload) { message('Your entries are kept. Use Reload saved feedback and confirm discarding unsaved entries to refresh.', true); return; }
    return load();
  }
  const controller = { refresh, dispose }; mounts.set(element, controller);
  if (!uuid(callId) || !kinds.has(anchorType)) { element.textContent = 'HopeBot feedback is available only after a real call has been saved.'; return controller; }
  if (!owned()) { dispose(); return controller; }
  subscription = getSupabase().auth?.onAuthStateChange?.((_event, session) => { if (session?.user?.id !== getCurrentUser()?.id || identity !== account()) dispose(); })?.data?.subscription;
  if (disposed) { subscription?.unsubscribe(); return controller; }
  observer = new MutationObserver(checkIdentity); observer.observe(document.body, { childList: true, subtree: true });
  window.addEventListener('hashchange', checkIdentity); document.addEventListener('change', checkIdentity, true);
  load(); return controller;
}
