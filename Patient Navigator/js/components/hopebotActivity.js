// SQL213: read-only care projection for this patient, including assigned
// probation staff. Global lead/request actions keep their existing boundaries.
import { getSupabase } from '../supabase.js';
import { getCurrentUser, getCurrentProfile } from '../auth.js';
import { sanitize } from '../utils/validators.js';
import { mountWhatsappOriginals } from './hopebotFiles.js';

const mounts = new WeakMap();
const identity = () => `${getCurrentUser()?.id || ''}:${getCurrentProfile()?.id || ''}`;
const reasons = {
  doctor_search: 'Help finding a doctor', stay_search: 'Help with a place to stay', money_help: 'Financial help',
  diet_plan: 'Diet support', trials_request: 'Clinical trial information', roadmap_request: 'Treatment roadmap',
  reports_review: 'Report review', community_join: 'Community support', user_requested: 'Asked to speak to a person',
  grief: 'Bereavement support', safety_self_harm: 'Safety concern', safety_emergency: 'Urgent medical concern', other: 'Help requested',
};
const language = code => code === 'en' ? 'English' : code === 'hi' ? 'Hindi' : code === 'bn' ? 'Bengali' : code === 'mr' ? 'Marathi' : 'Language not recorded';
const role = value => value === 'patient' ? 'Patient' : value === 'caregiver' ? 'Caregiver' : 'Saved contact';
const instant = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const when = value => instant(value) === null ? 'Time not recorded' : new Date(value).toLocaleString('en-IN', {
  timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short',
}) + ' IST';
const count = value => Number.isInteger(value) && value >= 0 ? value : null;
const text = (value, max) => typeof value === 'string' ? value.slice(0, max).trim() : '';
const status = value => value === 'closed' ? 'Closed' : value === 'open' ? 'Open' : value === 'calling' ? 'In progress' : 'Status not recorded';

export function hopebotActivityHTML(data) {
  const summaries = (Array.isArray(data.summaries) ? data.summaries : []).slice(0, 25);
  // Only care categories appear here. Admin/deletion workflows stay in their
  // existing managed surfaces, even if an unexpected payload includes them.
  const needs = (Array.isArray(data.needs) ? data.needs : []).filter(need => need && Object.hasOwn(reasons, need.reason)).slice(0, 50);
  const docs = data.documents || {}, files = count(docs.count), waiting = count(docs.waiting), contacts = count(data.contacts_count);
  const empty = !data.last_inbound_at && !summaries.some(summary => text(summary?.summary, 1200)) && !needs.length && files === 0;
  return `<section class="card wrap-meta" data-hopebot-activity style="padding:12px 14px;margin:8px 0 12px;overflow-wrap:anywhere">
    <h3 style="margin:0 0 6px">HopeBot activity</h3>
    <p class="due-meta" style="margin:0 0 8px">Only saved contacts linked to this patient are shown.${contacts !== null ? ` ${contacts} linked contact${contacts === 1 ? '' : 's'}.` : ''}</p>
    ${data.last_inbound_at ? `<p class="due-meta">Latest inbound message: ${sanitize(when(data.last_inbound_at))}. This is when the family wrote to HopeBot.</p>` : ''}
    ${empty ? '<p data-hb-activity-empty>No HopeBot activity is available for this patient yet. This does not confirm that they have never used HopeBot.</p>' : ''}
    ${data.summaries_truncated || data.summaries?.length > 25 ? `<p class="due-meta" data-hb-summaries-truncated>Showing the latest ${summaries.length} of ${count(data.summaries_total) ?? contacts ?? 'the linked'} contact summaries. This is a bounded view.</p>` : ''}
    ${summaries.map(summary => {
      const body = text(summary?.summary, 1200), made = instant(summary?.summary_at), inbound = instant(summary?.last_inbound_at);
      const stale = made !== null && inbound !== null && made < inbound;
      return `<div data-hb-summary style="border-top:1px solid var(--line);padding-top:8px;margin-top:8px">
        <strong>${sanitize(role(summary?.role))} - ${sanitize(language(summary?.language))}</strong>
        ${body ? `<p style="white-space:pre-wrap;margin:6px 0">${sanitize(body)}</p><p class="due-meta">AI summary, not verified. Confirm with the family before acting.</p>
          <p class="due-meta">Summary made: ${sanitize(when(summary.summary_at))}${summary.last_inbound_at ? `. Latest inbound: ${sanitize(when(summary.last_inbound_at))}` : ''}.</p>
          ${stale ? '<p class="due-meta" data-hb-summary-stale>Newer inbound messages may be missing from this summary.</p>' : made === null || inbound === null ? '<p class="due-meta" data-hb-summary-age-unknown>Summary coverage could not be checked.</p>' : ''}`
          : '<p class="due-meta">No synced summary is available for this contact yet.</p>'}
      </div>`;
    }).join('')}
    ${needs.length ? `<div style="margin-top:10px"><strong>Help requested through HopeBot</strong>${data.needs_truncated || data.needs?.length > 50 ? `<p class="due-meta" data-hb-needs-truncated>Showing the first ${needs.length} of ${count(data.needs_total) ?? 'the available'} care requests, with open and safety requests first. This is not the complete request history.</p>` : ''}<ul style="padding-left:20px;margin:6px 0">${needs.map(need => `<li style="margin-bottom:6px">${sanitize(reasons[need.reason])} - ${sanitize(status(need.state))}
      <span class="due-meta">Asked ${sanitize(when(need.asked_at))}${need.closed_at ? `; closed ${sanitize(when(need.closed_at))}` : ''}</span></li>`).join('')}</ul><p class="due-meta">This is a read-only summary. Existing request assignments and actions are unchanged.</p></div>` : ''}
    <div style="border-top:1px solid var(--line);padding-top:8px;margin-top:10px" data-hb-stored-documents>
      <strong>Stored WhatsApp originals</strong>
      <p class="due-meta">${files === null ? 'File count is unavailable.' : `${files} stored original${files === 1 ? '' : 's'}.${waiting !== null ? ` ${waiting} waiting for the reader.` : ''}`}${docs.latest_at ? ` Latest original received ${sanitize(when(docs.latest_at))}.` : ''} These are actual filed documents; AI report-reading counts are separate.${files > 100 ? ' View stored originals lists the latest 100 files.' : ''}</p>
      ${files > 0 ? '<button type="button" class="btn btn-secondary btn-sm" data-hb-show-originals>View stored originals</button><div data-hb-originals hidden></div>' : ''}
    </div>
    <button type="button" class="btn btn-ghost btn-sm" data-hb-activity-refresh style="margin-top:8px">Refresh activity</button>
  </section>`;
}

export function mountHopebotActivity(el, patientId, { isCurrent = () => true } = {}) {
  if (!el || !patientId) return { refresh() {}, dispose() {} };
  mounts.get(el)?.dispose();
  const account = identity(); let generation = 0, disposed = false, observer, subscription;
  const active = () => !disposed && mounts.get(el) === controller && el.isConnected && identity() === account && isCurrent();
  const clear = () => { if (mounts.get(el) === controller) { el.replaceChildren(); el.hidden = true; } };
  const dispose = () => { if (disposed) return; disposed = true; generation++; clear(); observer?.disconnect(); subscription?.unsubscribe(); };
  const current = seq => {
    if (seq !== generation || disposed || mounts.get(el) !== controller) return false;
    if (!active()) { dispose(); return false; } return true;
  };
  const unavailable = (denied = false) => {
    el.hidden = false;
    el.innerHTML = `<section class="card" style="padding:12px 14px;margin:8px 0 12px;overflow-wrap:anywhere"><h3 style="margin:0 0 6px">HopeBot activity</h3>
      <p role="status">${denied ? 'HopeBot activity is not available for this account and patient. Access could not be confirmed.' : 'HopeBot activity could not load. Refresh to try again.'}</p>
      <button type="button" class="btn btn-ghost btn-sm" data-hb-activity-refresh>Refresh activity</button></section>`;
    el.querySelector('[data-hb-activity-refresh]').onclick = refresh;
  };
  async function refresh() {
    const seq = ++generation;
    if (!current(seq)) return;
    el.hidden = false; el.innerHTML = '<section class="card" style="padding:12px 14px;margin:8px 0 12px"><h3>HopeBot activity</h3><p role="status">Loading activity for this patient...</p></section>';
    let response;
    try { response = await getSupabase().rpc('hopebot_activity_for_patient', { p_patient: patientId }); }
    catch { if (current(seq)) unavailable(); return; }
    if (!current(seq)) return;
    const { data, error } = response || {};
    if (error || !data || data.patient_id !== patientId) { unavailable(error?.code === '42501'); return; }
    el.innerHTML = hopebotActivityHTML(data);
    el.querySelector('[data-hb-activity-refresh]').onclick = refresh;
    const button = el.querySelector('[data-hb-show-originals]');
    if (button) button.onclick = async () => {
      if (!current(seq)) return;
      const slot = el.querySelector('[data-hb-originals]');
      if (!slot.hidden) { slot.hidden = true; button.textContent = 'View stored originals'; return; }
      slot.hidden = false; button.textContent = 'Hide stored originals';
      slot.textContent = 'Loading stored originals...';
      try { await mountWhatsappOriginals(slot, patientId); }
      catch { if (current(seq)) slot.textContent = 'WhatsApp originals could not load. Refresh to try again.'; }
      current(seq); // clears a stale account/patient even if its child just completed
    };
  }
  const controller = { refresh, dispose }; mounts.set(el, controller);
  if (!getCurrentUser()?.id || !getCurrentProfile()?.id) { dispose(); return controller; }
  // Clear already-painted content on logout/account change. No data is cached.
  subscription = getSupabase().auth?.onAuthStateChange?.((_event, session) => {
    if (session?.user?.id !== account.split(':')[0] || identity() !== account) dispose();
  })?.data?.subscription;
  if (disposed) { subscription?.unsubscribe(); return controller; }
  // Page modules have no universal route-dispose hook. Remove subscriptions
  // when the slot disconnects, changes patient generation or changes account.
  observer = new MutationObserver(() => { if (!active()) dispose(); });
  observer.observe(document.body, { childList: true, subtree: true });
  refresh(); return controller;
}
