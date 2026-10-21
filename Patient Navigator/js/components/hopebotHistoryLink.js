import { getSupabase } from '../supabase.js';
import { getCurrentUser, getRealProfile, getCurrentProfile, isImpersonating } from '../auth.js';

// Linking is an explicit manager identity review, never a name match/import.
export function mountHopebotHistoryLink(host, row, { isCurrent = () => true, onSaved = () => {} } = {}) {
  const identity = JSON.stringify([getCurrentUser()?.id, getRealProfile()?.id, getCurrentProfile()?.id]);
  let disposed = false, busy = false, candidate = null, generation = 0;
  const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  const current = () => {
    const pr = getRealProfile();
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    const day = ['year','month','day'].map(type => parts.find(part => part.type === type)?.value).join('-');
    return !disposed && host.isConnected && isCurrent() && !isImpersonating() && pr?.is_active === true && ['admin', 'manager'].includes(pr.role)
      && (!pr.ends_on || pr.ends_on >= day) && pr.id === getCurrentUser()?.id && getCurrentProfile()?.id === pr.id
      && identity === JSON.stringify([getCurrentUser()?.id, pr.id, getCurrentProfile()?.id]);
  };
  const dispose = () => { disposed = true; generation++; host.replaceChildren(); };
  if (!uuid(row?.id) || row.source !== 'imported_history' || !Number.isSafeInteger(row.version) || row.version < 1 || !current()) return { dispose };
  host.innerHTML = `<form style="min-width:0;overflow-wrap:anywhere">
    <p>This links this source row to a verified PN patient. It does not create a call, follow-up, consent or usage answer. Names alone are insufficient.</p>
    <label class="form-label">Exact PN Patient ID<input class="form-input" name="patientCode" maxlength="100" required autocomplete="off"></label>
    <button class="btn btn-secondary" type="button" data-find style="margin-top:10px">Find exact patient</button>
    <p data-patient role="status"></p>
    <label class="form-label">Identity evidence<textarea class="form-input" name="reason" minlength="10" maxlength="500" rows="3" required style="width:100%;box-sizing:border-box;resize:vertical"></textarea></label>
    <label style="display:flex;gap:8px;align-items:flex-start;margin:14px 0"><input type="checkbox" name="verified" required>I verified the exact patient using the source and the PN record.</label>
    <p data-message role="status" aria-live="polite"></p><button class="btn btn-primary" type="submit" disabled>Save verified link</button></form>`;
  const form = host.querySelector('form'), find = form.querySelector('[data-find]'), save = form.querySelector('[type=submit]');
  const message = value => { if (current()) form.querySelector('[data-message]').textContent = value; };
  const controls = () => { if (!current()) return; find.disabled = busy; for (const name of ['patientCode','reason','verified']) form.elements[name].disabled = busy; save.disabled = busy || !candidate || !form.elements.verified.checked; };
  form.elements.patientCode.addEventListener('input', () => { if (busy || !current()) return; generation++; candidate = null; form.elements.verified.checked = false; form.querySelector('[data-patient]').textContent = ''; controls(); });
  form.elements.verified.addEventListener('change', controls);
  find.addEventListener('click', async () => {
    if (!current() || busy) return;
    const code = form.elements.patientCode.value.trim(); if (!code) return;
    const seq = ++generation; busy = true; candidate = null; controls(); message('Finding the exact patient...');
    try {
      const { data, error } = await getSupabase().from('patients').select('id,patient_code,full_name').eq('patient_code', code).limit(2);
      if (!current() || seq !== generation) return;
      if (error || !Array.isArray(data) || data.length !== 1 || !uuid(data[0].id) || data[0].patient_code !== code || typeof data[0].full_name !== 'string') throw new Error();
      candidate = { ...data[0], code }; form.querySelector('[data-patient]').textContent = candidate.patient_code + ': ' + candidate.full_name;
      message('Check the patient against the source, then record the identity evidence.');
    } catch { if (current() && seq === generation) message('Could not verify one exact patient. Check the Patient ID and try again.'); }
    finally { if (current() && seq === generation) { busy = false; controls(); } }
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!current() || busy || !candidate || candidate.code !== form.elements.patientCode.value.trim() || !form.elements.verified.checked || !form.reportValidity()) return;
    const seq = ++generation, patient = candidate.id, reason = form.elements.reason.value.trim();
    if (reason.length < 10 || reason.length > 500) return;
    busy = true; controls(); message('Saving verified identity...');
    try {
      const { data, error } = await getSupabase().rpc('hopebot_feedback_history_link', { p_history: row.id, p_patient: patient, p_reason: reason, p_expected: row.version });
      if (!current() || seq !== generation) return;
      if (error || data?.id !== row.id || data.patient_id !== patient || data.verified !== true || data.revision !== row.version) throw new Error();
      message('Verified source link saved. Close this view and refresh the tracker.');
      form.querySelectorAll('input,textarea,button').forEach(control => { control.disabled = true; });
      onSaved();
    } catch { if (current() && seq === generation) { busy = false; controls(); message('Could not confirm the link. Your entries are kept. Retry the same verified identity, or refresh to review any source or identity change.'); } }
  });
  return { dispose };
}
