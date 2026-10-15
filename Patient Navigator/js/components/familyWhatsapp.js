import { getSupabase } from '../supabase.js';
import { isImpersonating } from '../auth.js';
import { sanitize } from '../utils/validators.js';
import { indiaInput, indiaISO } from '../utils/circleMessage.js';
import { showModal, closeModal, confirmModal } from './modal.js';
import { showToast } from './toast.js';
import { mountPosterControl } from './whatsappPoster.js';

const WHEN = (s) => new Date(s).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
const DELIVERY = (status, poster = false) => status === 'accepted' || (status === 'sent' && !poster)
  ? 'Accepted by WhatsApp - delivery not confirmed'
  : status === 'unknown' ? 'Delivery pending - WhatsApp acceptance not confirmed'
    : status === 'sent' ? 'Sent by WhatsApp - delivery not confirmed' : String(status || '').replaceAll('_',' ');
const FIELDS = {
  care_session_invite_v1: ['First name', 'Session title', 'Session date', 'Session time', 'Joining link'],
  wellness_session_invite: ['First name', 'Session date', 'Session time'],
  wellness_session_reminder: ['First name', 'Session time', 'Joining link'],
};
const LABELS = { care_session_invite_v1: 'Session invitation with a link', wellness_session_invite: 'Wellness reminder: date and time', wellness_session_reminder: 'Wellness starts in 5 minutes' };

export async function mountFamilyWhatsapp(mount, patient) {
  if (!mount || isImpersonating()) return;
  const { data, error } = await getSupabase().rpc('family_whatsapp_panel', { p_patient: patient.id });
  if (!mount.isConnected) return;
  if (error) {
    // A record may be visible without permission to care for it.
    if (error.code !== '42501') mount.textContent = 'Scheduled WhatsApp is unavailable. Please reload and try again.';
    return;
  }
  const granted = data.permission?.granted && data.blocked !== 'no_whatsapp_permission';
  mount.innerHTML = `<details class="card" style="padding:16px;margin-bottom:16px" id="family-wa">
    <summary style="cursor:pointer;font-weight:600">Scheduled WhatsApp</summary>
    <p>Schedule one message for this family. Only approved wording is available. Delivery is from 9 AM to before 9 PM India time, with a total limit of 100 messages per day.</p>
    <p id="fw-permission">${granted ? `WhatsApp permission recorded ${sanitize(WHEN(data.permission.recorded_at))}.` : 'Record the family\'s permission for WhatsApp messages before scheduling.'}</p>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
      <button type="button" class="btn btn-secondary btn-sm" id="fw-consent">${granted ? 'Withdraw WhatsApp permission' : 'Record WhatsApp permission'}</button>
      <button type="button" class="btn btn-primary btn-sm" id="fw-new" ${data.blocked ? 'disabled' : ''}>Schedule a message</button>
    </div>
    ${data.blocked && data.blocked !== 'no_whatsapp_permission' ? `<p role="status">Scheduling is held: ${sanitize(data.blocked.replaceAll('_', ' '))}.</p>` : ''}
    <div id="fw-history">${data.messages.length ? data.messages.map((m) => `<div style="border-top:1px solid var(--line);padding:12px 0;overflow-wrap:anywhere">
      <strong>${sanitize(LABELS[m.template_name] || m.template_name.replaceAll('_', ' '))}</strong>
      <div>${sanitize(WHEN(m.scheduled_for))} India time</div>
      <div>${sanitize(DELIVERY(m.delivery_status || m.status))}${m.reason ? `: ${sanitize(m.reason)}` : ''}</div>
      ${m.poster ? `<div>Poster attached: ${sanitize(m.poster.file_name)}</div>` : ''}
      ${m.poster_status ? `<div>Poster: ${sanitize(DELIVERY(m.poster_status,true))}${m.poster_reason ? `: ${sanitize(m.poster_reason)}` : ''}</div>` : ''}
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
      ${m.status === 'scheduled' && m.delivery_status === 'pending' && new Date(m.scheduled_for) > new Date() ? `<button class="btn btn-secondary btn-sm" data-fw-edit="${m.id}">Edit</button>` : ''}
      ${m.status !== 'cancelled' && ['pending','sending','queued','held'].includes(m.delivery_status) ? `<button class="btn btn-ghost btn-sm" data-fw-cancel="${m.id}">Cancel message</button>` : ''}
      </div></div>`).join('') : '<p>No scheduled messages for this family yet.</p>'}</div>
    <p class="muted">Permission, STOP, the current number and contact restrictions are checked again before sending. Cancellation is checked before sending; a message already being sent may still arrive. The history shows the most recent 100 messages, with sent, delivered, read, failed or held updates.</p>
  </details>`;
  const refresh = async () => { await mountFamilyWhatsapp(mount, patient); const details = mount.querySelector('details'); if (details) details.open = true; };
  mount.querySelector('#fw-consent').onclick = () => granted
    ? confirmModal('Withdraw permission and cancel messages still waiting for this family?', async () => {
      const r = await getSupabase().rpc('family_whatsapp_permission', { p_patient: patient.id, p_granted: false, p_method: data.permission.method });
      if (r.error) return showToast(r.error.message, 'error');
      await refresh();
    }, { title: 'Withdraw WhatsApp permission', confirmLabel: 'Withdraw and cancel' })
    : permissionForm(patient, refresh);
  mount.querySelector('#fw-new').onclick = () => composer(patient, data.templates, null, refresh);
  mount.querySelectorAll('[data-fw-edit]').forEach((button) => button.onclick = () => composer(patient, data.templates, data.messages.find((m) => m.id === button.dataset.fwEdit), refresh));
  mount.querySelectorAll('[data-fw-cancel]').forEach((button) => button.onclick = () => confirmModal('Cancel this message? A message already being sent may still arrive and cannot be recalled.', async () => {
    const r = await getSupabase().rpc('family_whatsapp_cancel', { p_patient: patient.id, p_id: button.dataset.fwCancel });
    if (r.error) return showToast(r.error.message, 'error');
    await refresh();
  }, { title: 'Cancel WhatsApp message', confirmLabel: 'Cancel message' }));
}

function permissionForm(patient, refresh) {
  const el = document.createElement('div');
  el.innerHTML = `<p>Ask the family: "May Jarurat Care send you WhatsApp messages about your care and sessions on the number saved here? You can say STOP on WhatsApp or ask the team to stop at any time."</p>
    <label style="display:flex;gap:10px;align-items:flex-start;margin:16px 0"><input id="fw-agreed" type="checkbox"><span>The family agreed to WhatsApp messages on the current saved number.</span></label>
    <label class="form-label" for="fw-method">How did they agree?</label><select class="form-select" id="fw-method">
      <option value="verbal_during_call">Verbally, on a call</option><option value="in_person">In person</option><option value="written">In writing</option><option value="digital">Digitally</option></select>
    <p id="fw-error" role="alert"></p><button class="btn btn-primary" id="fw-save-permission">Record permission</button>`;
  const modal = showModal({ title: 'WhatsApp permission', content: el });
  el.querySelector('#fw-save-permission').onclick = async (event) => {
    if (!el.querySelector('#fw-agreed').checked) { el.querySelector('#fw-error').textContent = 'Record permission only after the family agrees.'; return; }
    event.currentTarget.disabled = true;
    const r = await getSupabase().rpc('family_whatsapp_permission', { p_patient: patient.id, p_granted: true, p_method: el.querySelector('#fw-method').value });
    if (r.error) { event.target.disabled = false; el.querySelector('#fw-error').textContent = r.error.message; return; }
    if (modal.closeOwnedModal) modal.closeOwnedModal(); else if (modal.classList.contains('active')) closeModal();
    await refresh();
  };
}

function composer(patient, templates, existing, refresh) {
  const el = document.createElement('div');
  const tomorrow = new Date(Date.now() + 86400000 + 330 * 60000);
  tomorrow.setUTCHours(10, 0, 0, 0);
  el.innerHTML = `<p>This message goes only to this family. Fill the approved wording, then review the preview.</p>
    <label class="form-label" for="fw-template">Approved format</label><select class="form-select" id="fw-template">
      ${templates.map((t, i) => `<option value="${i}">${sanitize(LABELS[t.name] || t.name.replaceAll('_', ' '))} (${sanitize(t.language)})</option>`).join('')}</select>
    <div id="fw-fields" style="margin-top:12px"></div>
    <label class="form-label" for="fw-when">Send at (India time)</label><input class="form-input" type="datetime-local" id="fw-when" value="${sanitize(existing ? indiaInput(existing.scheduled_for) : tomorrow.toISOString().slice(0,16))}">
    <h3>What they will see</h3><div id="fw-preview" style="white-space:pre-wrap;overflow-wrap:anywhere;padding:12px;background:var(--surface-2);border-radius:8px"></div>
    <div id="fw-poster" style="margin-top:16px"></div>
    <p id="fw-error" role="alert"></p><button class="btn btn-primary" id="fw-schedule">${existing ? 'Save changes' : 'Schedule'}</button>`;
  let poster;
  const modal = showModal({ title: existing ? 'Edit scheduled WhatsApp' : 'Schedule WhatsApp message', content: el, onClose: () => poster?.dispose() });
  const select = el.querySelector('#fw-template');
  if (existing) select.value = String(Math.max(0, templates.findIndex((t) => t.name === existing.template_name && t.language === existing.language)));
  const vars = () => [...el.querySelectorAll('[data-fw-var]')].map((input) => input.value.trim());
  const preview = () => {
    el.querySelector('#fw-error').textContent = '';
    const template = templates[Number(select.value)];
    const values = vars();
    el.querySelector('#fw-preview').textContent = (template?.body || '').replace(/\{\{(\d+)\}\}/g, (_, n) => (values[Number(n) - 1] || `[blank ${n}]`).replaceAll('{first_name}', patient.full_name?.split(' ')[0] || 'there'));
    poster?.estimate(template, indiaISO(el.querySelector('#fw-when').value));
  };
  const fields = (initial = false) => {
    const template = templates[Number(select.value)];
    el.querySelector('#fw-fields').innerHTML = Array.from({ length: template?.variables_count || 0 }, (_, i) => `<label class="form-label" for="fw-var-${i}">${sanitize(FIELDS[template.name]?.[i] || `Blank ${i + 1}`)}</label><input class="form-input" id="fw-var-${i}" data-fw-var="${i}" maxlength="500" ${FIELDS[template.name]?.[i] === 'Joining link' ? 'type="url" placeholder="https://..."' : 'type="text"'} value="${sanitize(initial && existing ? existing.variables[i] || '' : i === 0 && FIELDS[template.name]?.[0] === 'First name' ? '{first_name}' : '')}" style="margin-bottom:12px">`).join('');
    el.querySelectorAll('[data-fw-var]').forEach((input) => input.oninput = preview);
    preview();
  };
  poster = mountPosterControl(el.querySelector('#fw-poster'), { patientId: patient.id, existing: existing?.poster, onChange: preview });
  fields(true); select.onchange = () => fields();
  el.querySelector('#fw-when').onchange = preview;
  el.querySelector('#fw-schedule').onclick = async (event) => {
    const button = event.currentTarget;
    const template = templates[Number(select.value)];
    const error = el.querySelector('#fw-error');
    if (!template) { error.textContent = 'No approved formats are available. Ask a manager to refresh WhatsApp approvals.'; return; }
    const invalidLink = [...el.querySelectorAll('[data-fw-var][type="url"]')].find((input) => !/^https?:\/\//i.test(input.value.trim()) || !input.checkValidity());
    if (invalidLink) { error.textContent = 'Use a complete joining link starting with https:// or http://.'; invalidLink.focus(); return; }
    const when = indiaISO(el.querySelector('#fw-when').value);
    if (!when) { error.textContent = 'Choose a date and time.'; return; }
    let posterId;
    try { posterId = poster.id(); } catch (e) { error.textContent = e.message; return; }
    button.disabled = true;
    if (posterId && !await poster.estimate(template, when)) { button.disabled = false; error.textContent = 'Check the poster delivery counts before scheduling.'; return; }
    const r = await getSupabase().rpc('family_whatsapp_save', { p_patient: patient.id, p: {
      id: existing?.id || null, template_name: template.name, language: template.language,
      variables: vars(), scheduled_for: when, poster_id: posterId,
    } });
    if (r.error) { event.target.disabled = false; error.textContent = r.error.message; return; }
    poster.dispose();
    if (modal.closeOwnedModal) modal.closeOwnedModal(); else if (modal.classList.contains('active')) closeModal();
    showToast(existing ? 'Scheduled message updated' : 'Message scheduled', 'success'); await refresh();
  };
}
