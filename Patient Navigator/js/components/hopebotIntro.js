import { getSupabase } from '../supabase.js';
import { getCurrentUser, isImpersonating } from '../auth.js';
import { sanitize } from '../utils/validators.js';

export const HOPEBOT_INTRO_CONSENT = 'Family agreed on this call to get HopeBot on WhatsApp';
const introMountTurns = new WeakMap();
const when = (value) => new Date(value).toLocaleString('en-IN', {
  timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short',
});
const BLOCKS = {
  template_pending: 'Not sent: HopeBot intro is waiting for WhatsApp approval.',
  team_number: 'Not sent: this is a team number. Use the family WhatsApp number.',
  bad_number: 'Not sent: save a valid family WhatsApp number first.',
  no_consent: 'Not sent: record the family programme consent first.',
  opted_out: 'Not sent: the family asked us to stop WhatsApp messages.',
  do_not_call: 'Not sent: this family is marked not to be contacted.',
  blacklisted: 'Not sent: this family is blocked from contact.',
  inactive: 'Not sent: this family is inactive or deceased.',
  recent_intro: 'Not sent: wait 15 minutes after the previous HopeBot intro, then record agreement on a new connected call.',
  intro_pending: 'Not sent: a HopeBot intro is still waiting for its send or delivery status. Refresh delivery status before trying again.',
  intro_outcome_unknown: 'Not sent: the previous send outcome is unknown. Check its delivery status before requesting another intro.',
};
const STATES = {
  queued: 'Queued for HopeBot', offered: 'Waiting for HopeBot', in_hopebot: 'Queued for WhatsApp',
  accepted: 'Accepted by WhatsApp - delivery not confirmed', unknown: 'Send outcome unknown - do not send again',
  sent: 'Sent', delivered: 'Delivered', read: 'Read', failed: 'Failed',
  suppressed: 'Not sent', cancelled: 'Cancelled', expired: 'Expired without sending',
};

export function introContactSelection(value) {
  if (!value || typeof value !== 'object' || !/^[a-f0-9]{32}$/.test(value.version)
    || !Array.isArray(value.keys) || !value.keys.length || value.keys.length > 25
    || value.keys.some(k => typeof k !== 'string' || !/^[a-f0-9]{32}$/.test(k))
    || new Set(value.keys).size !== value.keys.length) return null;
  return { version: value.version, keys: [...value.keys] };
}

export async function requestHopebotIntro(patientId, callId, selection) {
  if (isImpersonating()) return { ok: false, error: 'Not sent: leave Preview as before requesting HopeBot.' };
  try {
    const chosen = introContactSelection(selection);
    if (selection !== undefined && !chosen) return { ok: false, error: 'Choose the saved numbers and record agreement on this call first.' };
    const { data, error } = await getSupabase().rpc(chosen ? 'manual_hopebot_intro_request_contacts51' : 'manual_hopebot_intro_request', chosen ? {
      p_patient: patientId, p_call_id: callId, p_version: chosen.version, p_agreed_keys: chosen.keys,
    } : {
      p_patient: patientId, p_call_id: callId, p_agreed: true,
    });
    if (error) return { ok: false, error: error.message };
    if (!data?.ok) return { ok: false, error: 'Not sent: the request was not confirmed. Refresh the family card before trying again.' };
    if (chosen) return { ...data, message: data.duplicate
      ? 'This call already has these recipient requests. Refresh delivery status to check each number.'
      : `${data.rows?.length || chosen.keys.length} recipient request(s) queued; delivery is not confirmed.` };
    return { ...data, message: data.duplicate
      ? `HopeBot was already requested on this call: ${STATES[data.state] || 'request recorded'}. Refresh delivery status to check it.`
      : 'HopeBot intro is queued; delivery is not confirmed.' };
  } catch {
    return { ok: false, error: 'The request response was lost. Refresh the family card before trying again; it may already be queued.' };
  }
}

// stageForCall records only a selection in the existing call draft. The request is
// made after that call is saved, using its real call_logs id.
export async function mountHopebotIntro(mount, patientId, options = {}) {
  if (!mount || isImpersonating()) return;
  const userId = getCurrentUser()?.id;
  const turn = {};
  introMountTurns.set(mount, turn);
  const stillHere = () => mount.isConnected && getCurrentUser()?.id === userId
    && introMountTurns.get(mount) === turn
    && (!options.isCurrent || options.isCurrent());
  if (!userId) return;
  const [panel, delivery] = await Promise.all([
    getSupabase().rpc('manual_hopebot_intro_panel', { p_patient: patientId }),
    getSupabase().rpc('hopebot_invite_delivery', { p_patient: patientId }),
  ]);
  const { data, error } = panel;
  if (!stillHere()) return;
  if (error) {
    if (error.code !== '42501') mount.textContent = 'HopeBot intro is unavailable. Refresh before trying again.';
    return;
  }
  if (Array.isArray(data?.recipients) && /^[a-f0-9]{32}$/.test(data.version)) {
    mountContactIntro(mount, patientId, data, delivery, options, stillHere);
    return;
  }
  const last = data.last;
  const legacy = delivery.error ? null : delivery.data;
  const calls = Array.isArray(data.calls) ? data.calls : [];
  const staged = !!options.getStaged?.();
  const blocked = data.blocked;
  const reason = blocked ? BLOCKS[blocked] || `Not sent: ${String(blocked).replaceAll('_', ' ')}.`
    : !options.stageForCall && !calls.length ? 'Save a new connected call first. Choose an unused call from the last 24 hours.' : '';
  mount.innerHTML = `<section class="card" style="padding:16px;margin-bottom:16px;overflow-wrap:anywhere" data-hopebot-intro>
    <h3 style="margin:0 0 8px">HopeBot on WhatsApp</h3>
    <p>Send one introduction and a Main menu button to this family's current saved WhatsApp number${data.to ? ` (${sanitize(data.to)})` : ''}. Their reply opens HopeBot. A new connected call and fresh agreement can request another intro after 15 minutes. A request still waiting for its outcome cannot be sent again.</p>
    ${options.stageForCall ? '<p>Send when this call is saved. A connected call and its consent answer are recorded together before anything is queued.</p>' : `<label class="form-label" for="hi-call">The call where they agreed (India time)</label>
      <select class="form-select" id="hi-call" ${!calls.length ? 'disabled' : ''}>${calls.map((c) => `<option value="${sanitize(c.id)}">${sanitize(when(c.called_at))}</option>`).join('')}</select>`}
    <label style="display:flex;gap:10px;align-items:flex-start;margin:12px 0"><input type="checkbox" data-hi-agreed ${staged ? 'checked' : ''} ${reason ? 'disabled' : ''}><span>${HOPEBOT_INTRO_CONSENT}</span></label>
    <button type="button" class="btn btn-primary btn-sm" data-hi-send ${reason || !staged ? 'disabled' : ''}>${options.stageForCall ? staged ? 'Remove from this call' : 'Send when this call is saved' : 'Send HopeBot on WhatsApp'}</button>
    <p role="status" aria-live="polite" data-hi-status>${sanitize(reason || (staged ? 'Selected. Send when this call is saved.' : 'Tick the agreement only after asking the family on this call.'))}</p>
    ${data.template?.body ? `<details><summary>${blocked === 'template_pending' ? 'Intro wording awaiting approval' : 'Approved intro wording'}</summary><p style="white-space:pre-wrap">${sanitize(data.template.body)}</p></details>` : ''}
    ${last ? `<div style="border-top:1px solid var(--line);margin-top:12px;padding-top:12px" data-hi-history>
      <strong>${sanitize(STATES[last.state] || last.state)}</strong>${last.reason ? `: ${sanitize(String(last.reason).replaceAll('_', ' '))}` : ''}
      <p style="margin:6px 0">Requested ${sanitize(when(last.recorded_at))} India time${last.recorded_name ? ` by ${sanitize(last.recorded_name)}` : ''}. Consent recorded${last.call_at ? ` on the call at ${sanitize(when(last.call_at))} India time` : ' on the selected connected call'}.</p>
      ${last.sent_at ? `<p style="margin:6px 0">Last sent ${sanitize(when(last.sent_at))} India time.</p>` : ''}
      ${data.next_allowed_at && blocked === 'recent_intro' ? `<p style="margin:6px 0">Next intro can be requested ${sanitize(when(data.next_allowed_at))} India time, with agreement on a new connected call.</p>` : ''}
    </div>` : '<p>No HopeBot intro has been requested for this family yet.</p>'}
    ${!last && data.next_allowed_at && blocked === 'recent_intro' ? `<p>HopeBot was sent recently. Next intro can be requested ${sanitize(when(data.next_allowed_at))} India time.</p>` : ''}
    ${legacy ? `<div data-hi-document-delivery><strong>Document reminder:</strong>${(legacy.recipients || [legacy]).map(r => `<p>${r.to ? `${sanitize(r.to)}: ` : ''}${sanitize(STATES[r.status] || r.status)}${r.reason ? `: ${sanitize(r.reason)}` : ''}. Requested ${sanitize(when(r.sent_at))} India time.</p>`).join('')}</div>` : delivery.error ? '<p>Document reminder delivery could not be checked. Refresh before trying again.</p>' : ''}
    <button type="button" class="btn btn-ghost btn-sm" data-hi-refresh>Refresh delivery status</button>
    <p class="muted">Queued and accepted do not confirm delivery. Sent, delivered and read are WhatsApp status updates. Consent, STOP, the current number and contact restrictions are checked again before sending.</p>
  </section>`;
  const agreed = mount.querySelector('[data-hi-agreed]');
  const button = mount.querySelector('[data-hi-send]');
  const status = mount.querySelector('[data-hi-status]');
  agreed.onchange = () => {
    if (!stillHere() || reason) return;
    button.disabled = !!reason || !agreed.checked;
    if (options.stageForCall) {
      options.onStageChange?.(agreed.checked);
      button.textContent = agreed.checked ? 'Remove from this call' : 'Send when this call is saved';
      status.textContent = agreed.checked ? 'Selected. Send when this connected call is saved.'
        : 'Not selected. Nothing will be sent when this call is saved.';
    }
  };
  button.onclick = async () => {
    if (!stillHere() || !agreed.checked || reason) return;
    if (options.stageForCall) {
      options.onStageChange?.(false);
      agreed.checked = false;
      button.textContent = 'Send when this call is saved';
      button.disabled = true;
      status.textContent = 'Not selected. Nothing will be sent when this call is saved.';
      return;
    }
    button.disabled = true;
    status.textContent = 'Requesting HopeBot...';
    const result = await requestHopebotIntro(patientId, mount.querySelector('#hi-call')?.value);
    if (!stillHere()) return;
    if (!result.ok) { status.textContent = result.error; button.disabled = false; return; }
    await mountHopebotIntro(mount, patientId, options);
  };
  mount.querySelector('[data-hi-refresh]').onclick = () => mountHopebotIntro(mount, patientId, options);
}

function mountContactIntro(mount, patientId, data, delivery, options, stillHere) {
  const calls = Array.isArray(data.calls) ? data.calls : [];
  const recipients = data.recipients.slice(0, 25);
  const saved = introContactSelection(options.getStaged?.());
  const validSaved = saved?.version === data.version && saved.keys.every(k => recipients.some(r => r.key === k && !r.blocked));
  const changed = !!saved && !validSaved;
  if (changed && options.stageForCall) options.onStageChange?.(null);
  const selected = new Set(validSaved ? saved.keys : []);
  const reason = data.family_blocked ? BLOCKS[data.family_blocked] || 'Not sent: family contact restrictions apply.'
    : !recipients.length ? 'Save a valid family WhatsApp number first.'
    : !options.stageForCall && !calls.length ? 'Save a new connected call first. Choose an unused call from the last 24 hours.' : '';
  const legacy = delivery.error ? null : delivery.data;
  mount.innerHTML = `<section class="card" style="padding:16px;margin-bottom:16px;overflow-wrap:anywhere" data-hopebot-intro>
    <h3 style="margin:0 0 8px">HopeBot on WhatsApp</h3>
    <p>Choose each saved number that agreed on this call to receive the HopeBot introduction and Main menu button. Ask about each number separately. Nothing is selected automatically.</p>
    ${options.stageForCall ? '<p>The selected introductions are queued only after this connected call and its consent answer are saved.</p>' : `<label class="form-label" for="hi-call">The call where they agreed (India time)</label><select class="form-select" id="hi-call" ${!calls.length ? 'disabled' : ''}>${calls.map(c => `<option value="${sanitize(c.id)}">${sanitize(when(c.called_at))}</option>`).join('')}</select>`}
    <div data-hi-recipients>${recipients.map(r => `<div style="border-top:1px solid var(--line);padding:10px 0">
      <label style="display:flex;gap:10px;align-items:flex-start"><input type="checkbox" data-hi-recipient="${sanitize(r.key)}" ${selected.has(r.key) ? 'checked' : ''} ${reason || r.blocked ? 'disabled' : ''}><span><strong>${sanitize(r.label || 'Family contact')}</strong> - ${sanitize(r.to)}<br>Agreed on this call to receive HopeBot at this number.</span></label>
      ${r.blocked ? `<p>${sanitize(BLOCKS[r.blocked] || 'Not sent: this number is currently restricted. Refresh delivery status.')}</p>` : ''}
      ${r.last ? `<p data-hi-recipient-history>${sanitize(STATES[r.last.state] || r.last.state)}${r.last.reason ? `: ${sanitize(String(r.last.reason).replaceAll('_', ' '))}` : ''}. Requested ${sanitize(when(r.last.recorded_at))} India time.${r.last.sent_at ? ` Last sent ${sanitize(when(r.last.sent_at))} India time.` : ''}</p>` : ''}
    </div>`).join('')}</div>
    <button type="button" class="btn btn-primary btn-sm" data-hi-send ${reason || !selected.size ? 'disabled' : ''}>${options.stageForCall ? 'Remove selections from this call' : 'Send HopeBot to selected numbers'}</button>
    <p role="status" aria-live="polite" data-hi-status>${sanitize(reason || (changed ? 'Saved contacts, wording or eligibility changed. Ask again and select the agreed numbers.' : selected.size ? 'Selected. Send when this connected call is saved.' : 'Tick each number only after asking for agreement on this call.'))}</p>
    ${data.template?.body ? `<details><summary>Intro wording</summary><p style="white-space:pre-wrap">${sanitize(data.template.body)}</p></details>` : ''}
    ${legacy ? `<div data-hi-document-delivery><strong>Document reminder:</strong>${(legacy.recipients || [legacy]).map(r => `<p>${sanitize(r.to || '')}: ${sanitize(STATES[r.status] || r.status)}${r.reason ? `: ${sanitize(r.reason)}` : ''}.</p>`).join('')}</div>` : delivery.error ? '<p>Document reminder delivery could not be checked. Refresh before trying again.</p>' : ''}
    <button type="button" class="btn btn-ghost btn-sm" data-hi-refresh>Refresh delivery status</button>
    <p class="muted">A new connected call and fresh agreement can request another intro after 15 minutes. Pending or unknown outcomes cannot be sent again. Queued and accepted do not confirm delivery. Consent, STOP and the current saved number are checked again before sending.</p>
  </section>`;
  const boxes = [...mount.querySelectorAll('[data-hi-recipient]')];
  const button = mount.querySelector('[data-hi-send]'), status = mount.querySelector('[data-hi-status]');
  let requesting = false;
  const selection = () => ({ version: data.version, keys: [...selected] });
  for (const box of boxes) box.onchange = () => {
    if (!stillHere() || reason) return;
    const key = box.getAttribute('data-hi-recipient'), row = recipients.find(r => r.key === key);
    if (!row || row.blocked || box.disabled) return;
    if (box.checked) selected.add(key); else selected.delete(key);
    button.disabled = !selected.size;
    if (options.stageForCall) options.onStageChange?.(selected.size ? selection() : null);
    status.textContent = selected.size ? `${selected.size} number(s) selected.${options.stageForCall ? ' Send when this connected call is saved.' : ''}` : 'Nothing selected. No introduction will be requested.';
  };
  button.onclick = async () => {
    if (!stillHere() || reason || !selected.size || requesting) return;
    if (options.stageForCall) {
      selected.clear(); boxes.forEach(b => { b.checked = false; }); options.onStageChange?.(null);
      button.disabled = true; status.textContent = 'Nothing selected. No introduction will be requested.'; return;
    }
    requesting = true; button.disabled = true; boxes.forEach(b => { b.disabled = true; });
    status.textContent = 'Requesting selected HopeBot introductions...';
    const result = await requestHopebotIntro(patientId, mount.querySelector('#hi-call')?.value, selection());
    if (!stillHere()) return;
    if (!result.ok) { status.textContent = result.error; return; }
    await mountHopebotIntro(mount, patientId, options);
  };
  mount.querySelector('[data-hi-refresh]').onclick = () => mountHopebotIntro(mount, patientId, options);
}
