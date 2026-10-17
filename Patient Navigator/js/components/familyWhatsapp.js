import { getSupabase } from '../supabase.js';
import { getCurrentUser, isImpersonating } from '../auth.js';
import { sanitize } from '../utils/validators.js';
import { indiaInput, indiaISO } from '../utils/circleMessage.js';
import { showModal, closeModal, confirmModal } from './modal.js';
import { showToast } from './toast.js';
import { mountPosterControl } from './whatsappPoster.js';

const WHEN = s => new Date(s).toLocaleString('en-IN', { timeZone:'Asia/Kolkata', dateStyle:'medium', timeStyle:'short' });
const current = owner => !!owner && getCurrentUser()?.id === owner && !isImpersonating();
const DELIVERY = (status, poster = false) => status === 'accepted' || (status === 'sent' && !poster)
  ? 'Accepted by WhatsApp - delivery not confirmed'
  : status === 'unknown' ? 'Delivery pending - WhatsApp acceptance not confirmed'
    : status === 'sent' ? 'Sent by WhatsApp - delivery not confirmed' : String(status || '').replaceAll('_',' ');
const FIELDS = {
  care_session_invite_v1:['First name','Session title','Session date','Session time','Joining link'],
  wellness_session_invite:['First name','Session date','Session time'],
  wellness_session_reminder:['First name','Session time','Joining link'],
};
const LABELS = { care_session_invite_v1:'Session invitation with a link', wellness_session_invite:'Wellness reminder: date and time', wellness_session_reminder:'Wellness starts in 5 minutes' };
const REASONS = {
  family_messages_switched_off:'Not sent: family WhatsApp messages are switched off. Call the family instead.',
  no_whatsapp_permission:'WhatsApp permission is not recorded for this number.',
  opted_out:'Not sent: WhatsApp messages were stopped.', team_number:'Not sent: this is a team number.',
  number_changed:'Not sent: this number is no longer saved for the family.',
  no_consent:'Not sent: programme consent is missing.', bad_number:'Not sent: save a valid main number first.',
};
const reasonText = reason => REASONS[reason] || `Not sent: ${String(reason || 'contact check held').replaceAll('_',' ')}.`;
const targetName = recipient => `${String(recipient.role || 'contact').replaceAll('_',' ')}: ${recipient.to}`;

export async function mountFamilyWhatsapp(mount, patient) {
  const owner = getCurrentUser()?.id;
  if (!mount || !current(owner)) return;
  const stillHere = () => mount.isConnected && current(owner);
  const { data, error } = await getSupabase().rpc('family_whatsapp_panel', { p_patient:patient.id });
  if (!stillHere()) return;
  if (error) {
    if (error.code !== '42501') mount.textContent = 'Scheduled WhatsApp is unavailable. Please reload and try again.';
    return;
  }
  const recipients = Array.isArray(data.recipients) ? data.recipients : [];
  const available = recipients.filter(r => !r.reason);
  mount.innerHTML = `<details class="card" style="padding:16px;margin-bottom:16px;overflow-wrap:anywhere" id="family-wa">
    <summary style="cursor:pointer;font-weight:600">Scheduled WhatsApp</summary>
    <p>Choose saved patient and caregiver numbers for a session message. Each number needs its own WhatsApp permission. Repeated numbers receive one message. Only approved wording is available.</p>
    <p>Delivery is from 9 AM to before 9 PM India time. The daily limit is 100 recipient messages; each attached poster reserves one more slot per recipient.</p>
    ${data.blocked ? `<p role="status">${sanitize(reasonText(data.blocked))}</p>` : ''}
    <div id="fw-permissions">${recipients.length ? recipients.map(r => `<div style="border-top:1px solid var(--line);padding:12px 0">
      <strong>${sanitize(targetName(r))}</strong>
      <p style="margin:6px 0">${r.permission?.granted ? `WhatsApp permission recorded ${sanitize(WHEN(r.permission.recorded_at))}.` : 'WhatsApp permission is not recorded for this number.'}</p>
      ${r.reason ? `<p style="margin:6px 0">${sanitize(reasonText(r.reason))}</p>` : ''}
      <button type="button" class="btn btn-secondary btn-sm" data-fw-permission="${sanitize(r.key)}">${r.permission?.granted ? 'Withdraw permission' : 'Record permission'}</button>
    </div>`).join('') : '<p>No valid saved patient or caregiver numbers were found. Correct the contact numbers on the family record first.</p>'}</div>
    <button type="button" class="btn btn-primary btn-sm" id="fw-new" ${data.blocked || !available.length ? 'disabled' : ''}>Schedule a message</button>
    <div id="fw-history">${data.messages.length ? data.messages.map(m => `<div style="border-top:1px solid var(--line);padding:12px 0;overflow-wrap:anywhere">
      <strong>${sanitize(LABELS[m.template_name] || m.template_name.replaceAll('_',' '))}</strong>
      <div>${m.to ? sanitize(m.to) : 'Earlier saved family number'}</div>
      <div>${sanitize(WHEN(m.scheduled_for))} India time</div>
      <div>${sanitize(DELIVERY(m.delivery_status || m.status))}${m.reason ? `: ${sanitize(m.reason)}` : ''}</div>
      ${m.poster ? `<div>Poster attached: ${sanitize(m.poster.file_name)}</div>` : ''}
      ${m.poster_status ? `<div>Poster: ${sanitize(DELIVERY(m.poster_status,true))}${m.poster_reason ? `: ${sanitize(m.poster_reason)}` : ''}</div>` : ''}
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
      ${!data.blocked && available.some(r => r.key === m.recipient_key) && m.status === 'scheduled' && m.delivery_status === 'pending' && new Date(m.scheduled_for) > new Date() ? `<button class="btn btn-secondary btn-sm" data-fw-edit="${m.id}">Edit</button>` : ''}
      ${m.status !== 'cancelled' && ['pending','sending','queued','held'].includes(m.delivery_status) ? `<button class="btn btn-ghost btn-sm" data-fw-cancel="${m.id}">Cancel message</button>` : ''}
      </div></div>`).join('') : '<p>No scheduled messages for this family yet.</p>'}</div>
    <p class="muted">Permission, STOP, saved numbers and contact restrictions are checked again before sending. Cancellation is checked before sending; a message already being sent may still arrive. Each number has its own delivery result. The history shows the most recent 100 messages.</p>
  </details>`;
  const refresh = async () => {
    if (!stillHere()) return;
    await mountFamilyWhatsapp(mount, patient);
    if (stillHere()) { const details = mount.querySelector('details'); if (details) details.open = true; }
  };
  mount.querySelectorAll('[data-fw-permission]').forEach(button => button.onclick = () => {
    if (!stillHere()) return;
    const recipient = recipients.find(r => r.key === button.dataset.fwPermission);
    if (!recipient) return;
    if (!recipient.permission?.granted) return permissionForm(patient, recipient, owner, refresh);
    confirmModal(`Withdraw WhatsApp permission for ${targetName(recipient)} and cancel its messages still waiting?`, async () => {
      if (!stillHere()) return;
      const r = await getSupabase().rpc('family_whatsapp_contact_permission', { p_patient:patient.id, p_key:recipient.key, p_granted:false, p_method:recipient.permission.method });
      if (!stillHere()) return;
      if (r.error) return showToast(r.error.message,'error');
      await refresh();
    }, { title:'Withdraw WhatsApp permission', confirmLabel:'Withdraw and cancel' });
  });
  mount.querySelector('#fw-new').onclick = () => { if (stillHere() && !data.blocked && available.length) composer(patient,data.templates,recipients,null,owner,refresh); };
  mount.querySelectorAll('[data-fw-edit]').forEach(button => button.onclick = () => {
    if (stillHere()) composer(patient,data.templates,recipients,data.messages.find(m => m.id === button.dataset.fwEdit),owner,refresh);
  });
  mount.querySelectorAll('[data-fw-cancel]').forEach(button => button.onclick = () => confirmModal('Cancel this recipient message? A message already being sent may still arrive and cannot be recalled.', async () => {
    if (!stillHere()) return;
    const r = await getSupabase().rpc('family_whatsapp_cancel', { p_patient:patient.id, p_id:button.dataset.fwCancel });
    if (!stillHere()) return;
    if (r.error) return showToast(r.error.message,'error');
    await refresh();
  }, { title:'Cancel WhatsApp message', confirmLabel:'Cancel message' }));
}

function permissionForm(patient, recipient, owner, refresh) {
  const el = document.createElement('div');
  el.innerHTML = `<p><strong>${sanitize(targetName(recipient))}</strong></p>
    <p>Ask the person who uses this number: "May Jarurat Care send you WhatsApp messages about care and sessions on this number? You can say STOP on WhatsApp or ask the team to stop at any time."</p>
    <label style="display:flex;gap:10px;align-items:flex-start;margin:16px 0"><input id="fw-agreed" type="checkbox"><span>The person using this number agreed. This permission covers this number only.</span></label>
    <label class="form-label" for="fw-method">How did they agree?</label><select class="form-select" id="fw-method"><option value="verbal_during_call">Verbally, on a call</option><option value="in_person">In person</option><option value="written">In writing</option><option value="digital">Digitally</option></select>
    <p id="fw-error" role="alert"></p><button class="btn btn-primary" id="fw-save-permission">Record permission</button>`;
  const modal = showModal({ title:'WhatsApp permission for this number',content:el });
  el.querySelector('#fw-save-permission').onclick = async event => {
    if (!current(owner)) return;
    if (!el.querySelector('#fw-agreed').checked) { el.querySelector('#fw-error').textContent = 'Record permission only after this person agrees.'; return; }
    event.currentTarget.disabled = true;
    const r = await getSupabase().rpc('family_whatsapp_contact_permission', { p_patient:patient.id,p_key:recipient.key,p_granted:true,p_method:el.querySelector('#fw-method').value });
    if (!current(owner)) return;
    if (r.error) { event.target.disabled = false; el.querySelector('#fw-error').textContent = r.error.message; return; }
    if (modal.closeOwnedModal) modal.closeOwnedModal(); else if (modal.classList.contains('active')) closeModal();
    await refresh();
  };
}

function composer(patient, templates, recipients, existing, owner, refresh) {
  const requestId = crypto.randomUUID();
  const el = document.createElement('div');
  const tomorrow = new Date(Date.now()+86400000+330*60000); tomorrow.setUTCHours(10,0,0,0);
  el.innerHTML = `<p>Choose the saved numbers that should receive this message. Held numbers cannot be selected. Each chosen number has a separate result.</p>
    <fieldset style="border:0;padding:0;margin:0 0 16px"><legend class="form-label">Recipients</legend>${recipients.map(r => `<label style="display:flex;gap:10px;align-items:flex-start;margin:10px 0"><input type="checkbox" data-fw-recipient value="${sanitize(r.key)}" ${!r.reason && (!existing || existing.recipient_key === r.key) ? 'checked' : ''} ${r.reason || (existing && existing.recipient_key !== r.key) ? 'disabled' : ''}><span>${sanitize(targetName(r))}${r.reason ? `<br>${sanitize(reasonText(r.reason))}` : ''}</span></label>`).join('')}</fieldset>
    <label class="form-label" for="fw-template">Approved format</label><select class="form-select" id="fw-template">${templates.map((t,i) => `<option value="${i}">${sanitize(LABELS[t.name] || t.name.replaceAll('_',' '))} (${sanitize(t.language)})</option>`).join('')}</select>
    <div id="fw-fields" style="margin-top:12px"></div>
    <label class="form-label" for="fw-when">Send at (India time)</label><input class="form-input" type="datetime-local" id="fw-when" value="${sanitize(existing ? indiaInput(existing.scheduled_for) : tomorrow.toISOString().slice(0,16))}">
    <h3>What they will see</h3><div id="fw-preview" style="white-space:pre-wrap;overflow-wrap:anywhere;padding:12px;background:var(--surface-2);border-radius:8px"></div>
    <div id="fw-poster" style="margin-top:16px"></div><p id="fw-slots" class="form-hint"></p>
    <p id="fw-error" role="alert"></p><button class="btn btn-primary" id="fw-schedule">${existing ? 'Save changes' : 'Schedule for selected numbers'}</button>`;
  let poster, estimateGeneration = 0, saving = false;
  const modal = showModal({ title:existing ? 'Edit recipient message' : 'Schedule WhatsApp message',content:el,onClose:() => poster?.dispose() });
  const select = el.querySelector('#fw-template');
  if (existing) select.value = String(Math.max(0,templates.findIndex(t => t.name === existing.template_name && t.language === existing.language)));
  const keys = () => [...el.querySelectorAll('[data-fw-recipient]:checked')].map(input => input.value);
  const vars = () => [...el.querySelectorAll('[data-fw-var]')].map(input => input.value.trim());
  async function estimatePoster(template, when) {
    const generation = ++estimateGeneration;
    const counts = el.querySelector('[data-poster-counts]');
    let posterId; try { posterId = poster?.id(); } catch { if (counts) counts.textContent = ''; return null; }
    if (!posterId || !template || !when || !keys().length) { if (counts) counts.textContent = ''; return null; }
    if (!current(owner)) return null;
    if (counts) counts.textContent = 'Checking selected numbers for this poster...';
    const r = await getSupabase().rpc('family_whatsapp_poster_preview', { p_patient:patient.id,p_template:template.name,p_language:template.language || 'en',p_when:when,p_recipient_keys:keys() });
    if (!current(owner) || generation !== estimateGeneration) return null;
    if (r.error) { if (counts) counts.textContent = 'Delivery counts could not be checked. Reload before scheduling.'; return null; }
    const d = r.data;
    if (counts) counts.textContent = `${d.poster} with poster; ${d.text_only} text only; ${d.held} held; ${d.unknown} window not confirmed. ${d.note || ''}`;
    return d;
  }
  const preview = () => {
    el.querySelector('#fw-error').textContent = '';
    const template = templates[Number(select.value)], values = vars();
    el.querySelector('#fw-preview').textContent = (template?.body || '').replace(/\{\{(\d+)\}\}/g,(_,n) => (values[Number(n)-1] || `[blank ${n}]`).replaceAll('{first_name}','[recipient greeting]'));
    let extra = 0; try { extra = poster?.id() ? 1 : 0; } catch {}
    el.querySelector('#fw-slots').textContent = `${keys().length} selected numbers reserve ${keys().length*(1+extra)} daily send slots${extra ? ' including posters' : ''}.`;
    estimatePoster(template,indiaISO(el.querySelector('#fw-when').value));
  };
  const fields = (initial = false) => {
    const template = templates[Number(select.value)];
    el.querySelector('#fw-fields').innerHTML = Array.from({ length:template?.variables_count || 0 },(_,i) => `<label class="form-label" for="fw-var-${i}">${sanitize(FIELDS[template.name]?.[i] || `Blank ${i+1}`)}</label><input class="form-input" id="fw-var-${i}" data-fw-var="${i}" maxlength="500" ${FIELDS[template.name]?.[i] === 'Joining link' ? 'type="url" placeholder="https://..."' : 'type="text"'} value="${sanitize(initial && existing ? existing.variables[i] || '' : i === 0 && FIELDS[template.name]?.[0] === 'First name' ? '{first_name}' : '')}" style="margin-bottom:12px">`).join('');
    el.querySelectorAll('[data-fw-var]').forEach(input => input.oninput = preview); preview();
  };
  poster = mountPosterControl(el.querySelector('#fw-poster'), { patientId:patient.id,existing:existing?.poster,onChange:preview });
  fields(true); select.onchange = () => fields(); el.querySelector('#fw-when').onchange = preview;
  el.querySelectorAll('[data-fw-recipient]').forEach(input => input.onchange = preview);
  el.querySelector('#fw-schedule').onclick = async event => {
    if (saving || !current(owner)) return;
    const button = event.currentTarget, template = templates[Number(select.value)], error = el.querySelector('#fw-error');
    if (!keys().length) { error.textContent = 'Choose at least one eligible number.'; return; }
    if (!template) { error.textContent = 'No approved formats are available. Ask a manager to refresh WhatsApp approvals.'; return; }
    const invalidLink = [...el.querySelectorAll('[data-fw-var][type="url"]')].find(input => !/^https?:\/\//i.test(input.value.trim()) || !input.checkValidity());
    if (invalidLink) { error.textContent = 'Use a complete joining link starting with https:// or http://.'; invalidLink.focus(); return; }
    const when = indiaISO(el.querySelector('#fw-when').value);
    if (!when) { error.textContent = 'Choose a date and time.'; return; }
    let posterId; try { posterId = poster.id(); } catch (e) { error.textContent = e.message; return; }
    saving = true; button.disabled = true;
    const draft = { id:existing?.id || null,request_id:requestId,recipient_keys:keys(),template_name:template.name,language:template.language,variables:vars(),scheduled_for:when,poster_id:posterId };
    if (posterId && !await estimatePoster(template,when)) { saving = false; button.disabled = false; error.textContent = 'Check poster delivery counts before scheduling.'; return; }
    if (!current(owner)) return;
    const r = await getSupabase().rpc('family_whatsapp_save_contacts', { p_patient:patient.id,p:draft });
    if (!current(owner)) return;
    if (r.error) { saving = false; button.disabled = false; error.textContent = r.error.message; return; }
    poster.dispose();
    if (modal.closeOwnedModal) modal.closeOwnedModal(); else if (modal.classList.contains('active')) closeModal();
    showToast(r.data.duplicate ? 'Existing request found. Check each number in the history.' : existing ? 'Scheduled recipient message updated' : `Scheduled for ${r.data.recipients_count} numbers. Delivery is not yet confirmed.`,'success');
    await refresh();
  };
}
