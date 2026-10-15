import { getSupabase } from '../supabase.js';
import { getCurrentUser, isImpersonating } from '../auth.js';
import { sanitize } from '../utils/validators.js';

export const HOPEBOT_INTRO_CONSENT = 'Family agreed on this call to get HopeBot on WhatsApp';
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
  recent_intro: 'Not sent: HopeBot was already requested in the last 7 days.',
};
const STATES = {
  queued: 'Queued for HopeBot', offered: 'Waiting for HopeBot', in_hopebot: 'Queued for WhatsApp',
  accepted: 'Accepted by WhatsApp - delivery not confirmed', unknown: 'Send outcome unknown - do not send again',
  sent: 'Sent', delivered: 'Delivered', read: 'Read', failed: 'Failed',
  suppressed: 'Not sent', cancelled: 'Cancelled', expired: 'Expired without sending',
};

export async function requestHopebotIntro(patientId, callId) {
  if (isImpersonating()) return { ok: false, error: 'Not sent: leave Preview as before requesting HopeBot.' };
  try {
    const { data, error } = await getSupabase().rpc('manual_hopebot_intro_request', {
      p_patient: patientId, p_call_id: callId, p_agreed: true,
    });
    if (error) return { ok: false, error: error.message };
    if (!data?.ok) return { ok: false, error: 'Not sent: the request was not confirmed. Refresh the family card before trying again.' };
    return data;
  } catch {
    return { ok: false, error: 'The request response was lost. Refresh the family card before trying again; it may already be queued.' };
  }
}

// stageForCall records only a selection in the existing call draft. The request is
// made after that call is saved, using its real call_logs id.
export async function mountHopebotIntro(mount, patientId, options = {}) {
  if (!mount || isImpersonating()) return;
  const userId = getCurrentUser()?.id;
  const stillHere = () => mount.isConnected && getCurrentUser()?.id === userId
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
  const last = data.last;
  const legacy = delivery.error ? null : delivery.data;
  const calls = Array.isArray(data.calls) ? data.calls : [];
  const staged = !!options.getStaged?.();
  const blocked = data.blocked;
  const reason = blocked ? BLOCKS[blocked] || `Not sent: ${String(blocked).replaceAll('_', ' ')}.`
    : !options.stageForCall && !calls.length ? 'Save your connected call first. Choose a call from the last 24 hours.' : '';
  mount.innerHTML = `<section class="card" style="padding:16px;margin-bottom:16px;overflow-wrap:anywhere" data-hopebot-intro>
    <h3 style="margin:0 0 8px">HopeBot on WhatsApp</h3>
    <p>Send one introduction and a Main menu button to this family's current saved WhatsApp number${data.to ? ` (${sanitize(data.to)})` : ''}. Their reply opens HopeBot. At most one intro per family in 7 days.</p>
    ${options.stageForCall ? '<p>Send when this call is saved. A connected call and its consent answer are recorded together before anything is queued.</p>' : `<label class="form-label" for="hi-call">The call where they agreed (India time)</label>
      <select class="form-select" id="hi-call" ${!calls.length ? 'disabled' : ''}>${calls.map((c) => `<option value="${sanitize(c.id)}">${sanitize(when(c.called_at))}</option>`).join('')}</select>`}
    <label style="display:flex;gap:10px;align-items:flex-start;margin:12px 0"><input type="checkbox" data-hi-agreed ${staged ? 'checked' : ''} ${reason ? 'disabled' : ''}><span>${HOPEBOT_INTRO_CONSENT}</span></label>
    <button type="button" class="btn btn-primary btn-sm" data-hi-send ${reason || !staged ? 'disabled' : ''}>${staged ? 'Remove from this call' : 'Send HopeBot on WhatsApp'}</button>
    <p role="status" aria-live="polite" data-hi-status>${sanitize(reason || (staged ? 'Selected. Send when this call is saved.' : 'Tick the agreement only after asking the family on this call.'))}</p>
    ${data.template?.body ? `<details><summary>${blocked === 'template_pending' ? 'Intro wording awaiting approval' : 'Approved intro wording'}</summary><p style="white-space:pre-wrap">${sanitize(data.template.body)}</p></details>` : ''}
    ${last ? `<div style="border-top:1px solid var(--line);margin-top:12px;padding-top:12px" data-hi-history>
      <strong>${sanitize(STATES[last.state] || last.state)}</strong>${last.reason ? `: ${sanitize(String(last.reason).replaceAll('_', ' '))}` : ''}
      <p style="margin:6px 0">Requested ${sanitize(when(last.recorded_at))} India time${last.recorded_name ? ` by ${sanitize(last.recorded_name)}` : ''}. Consent recorded${last.call_at ? ` on the call at ${sanitize(when(last.call_at))} India time` : ' on the selected connected call'}.</p>
      ${last.sent_at ? `<p style="margin:6px 0">Last sent ${sanitize(when(last.sent_at))} India time.</p>` : ''}
      ${data.next_allowed_at ? `<p style="margin:6px 0">Next intro can be requested ${sanitize(when(data.next_allowed_at))} India time.</p>` : ''}
    </div>` : '<p>No HopeBot intro has been requested for this family yet.</p>'}
    ${!last && data.next_allowed_at && blocked === 'recent_intro' ? `<p>HopeBot was sent recently. Next intro can be requested ${sanitize(when(data.next_allowed_at))} India time.</p>` : ''}
    ${legacy ? `<p data-hi-document-delivery><strong>Document reminder:</strong> ${sanitize(STATES[legacy.status] || legacy.status)}${legacy.reason ? `: ${sanitize(legacy.reason)}` : ''}. Requested ${sanitize(when(legacy.sent_at))} India time.</p>` : delivery.error ? '<p>Document reminder delivery could not be checked. Refresh before trying again.</p>' : ''}
    <button type="button" class="btn btn-ghost btn-sm" data-hi-refresh>Refresh delivery status</button>
    <p class="muted">Queued and accepted do not confirm delivery. Sent, delivered and read are WhatsApp status updates. Consent, STOP, the current number and contact restrictions are checked again before sending.</p>
  </section>`;
  const agreed = mount.querySelector('[data-hi-agreed]');
  const button = mount.querySelector('[data-hi-send]');
  const status = mount.querySelector('[data-hi-status]');
  agreed.onchange = () => {
    button.disabled = !!reason || !agreed.checked;
    if (!agreed.checked && options.stageForCall) {
      options.onStageChange?.(false);
      button.textContent = 'Send HopeBot on WhatsApp';
      status.textContent = 'Not selected. Nothing will be sent when this call is saved.';
    }
  };
  button.onclick = async () => {
    if (!stillHere() || !agreed.checked || reason) return;
    if (options.stageForCall) {
      const next = !options.getStaged?.();
      options.onStageChange?.(next);
      agreed.checked = next;
      button.textContent = next ? 'Remove from this call' : 'Send HopeBot on WhatsApp';
      button.disabled = !next;
      status.textContent = next ? 'Selected. Send when this call is saved.' : 'Not selected. Nothing will be sent when this call is saved.';
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
