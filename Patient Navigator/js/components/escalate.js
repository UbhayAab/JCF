// ============================================================
// Patient Navigator: "Flag this patient / take them off my list"
//
// Reported 01/09 by Prachi: "there does not appear to be a clear option for
// interns to flag such cases or request that the patient be removed /
// reassigned. It would be helpful to introduce an Escalate/Flag Patient or
// Request Reassignment option on the dashboard."
//
// THE MECHANISM ALREADY EXISTED AND HAD NEVER BEEN USED ONCE.
// request_patient_reassignment(uuid, text, text, text) has been live since
// sql/113 and is gated on nothing but is_active_user(). Measured on the live
// database 2026-09-10: 321 rows in patient_concerns, 0 with
// reassign_requested = true. Not one intern has ever found it.
//
// WHY, with evidence, all three of these at once:
//
//  1. ONE ENTRY POINT, IN ONE PLACE. The only trigger anywhere in the app was
//     `#f-concern` in js/pages/calling.js:1093, a btn-ghost btn-sm inside the
//     log form header. Nothing on the patient record, the patients list, the
//     dashboard or the morning brief.
//  2. IT DOES NOT SAY WHAT IT DOES. The button reads "Raise a concern".
//     Prachi's own words are "escalate", "flag", "request reassignment". A
//     mentor looking for a way out of a call does not read "raise a concern"
//     as that.
//  3. THE CONTROL IS HIDDEN BEHIND TWO CORRECT GUESSES. In the modal, the
//     "take this patient off my list" checkbox lives in
//     `#cn-reassign-wrap`, rendered `display:none`, and only appears after
//     picking one of exactly two chips out of thirteen, in a second row
//     headed "Or is this about the call itself?".
//
// So: not a missing feature, and not a role gate. A reach problem. This
// module is the reach: one self-contained modal, opened from the patient
// record, the patients list, and anywhere else that has a patient id, calling
// the same live RPC. It asks the intern nothing she would have to justify to
// the patient, and it never needs a call to be in progress.
// ============================================================

import { getSupabase } from '../supabase.js';
import { showModal, closeModal } from './modal.js';
import { showToast } from './toast.js';
import { icon } from './icons.js';
import { sanitize } from '../utils/validators.js';
import { CONCERN_REASONS, CALLER_CONCERNS, CONCERN_SEVERITIES } from '../utils/catalog.js';

// Opens the flag / hand-over modal for one patient.
//   patient   { id, full_name }
//   opts.presetOff   open with "take them off my list" already ticked
//   opts.onDone      called after a successful save
export function openEscalateModal(patient, opts = {}) {
  const state = { reason: '', severity: 'high', sevTouched: false };
  const el = document.createElement('div');

  const chip = (r) => `<button type="button" class="chip seg-btn" data-reason="${r.key}"
      data-tone="danger" title="${sanitize(r.hint)}" style="padding:8px 12px"><span>${sanitize(r.label)}</span></button>`;

  el.innerHTML = `
    <p style="font:var(--t-sm);color:var(--ink-2);margin:0 0 var(--s4)">
      This goes straight to the supervisors' queue. You are never expected to carry it alone,
      and you never have to explain any of this to the patient.</p>

    <!-- The caller's own safety comes FIRST here, not in a second row under a
         heading she has to read past. That ordering is the whole fix: on the
         calling portal these two are the last two chips of thirteen. -->
    <div class="field">
      <label>Is this about how the call is going for you? <span class="req">*</span></label>
      <div class="chips" id="es-self" style="display:flex;flex-wrap:wrap;gap:8px">
        ${CONCERN_REASONS.filter(r => CALLER_CONCERNS.includes(r.key)).map(chip).join('')}
      </div>
      <!-- text-transform reset: .field > label is uppercase mono (components.css:85),
           which is right for a four-word field name and wrong for a sentence. -->
      <label class="svc" id="es-off-wrap" style="margin-top:10px;align-items:flex-start;gap:9px;padding:10px 12px;opacity:.55;text-transform:none;letter-spacing:normal;font:var(--t-sm);color:var(--ink)">
        <input type="checkbox" id="es-off" disabled ${opts.presetOff ? 'checked' : ''} />
        <span style="font:var(--t-sm)">Take this patient off my list and give them to someone else.
          <span style="display:block;font:var(--t-xs);color:var(--ink-3);margin-top:2px">
            They come off your list the moment you send this. A supervisor decides who picks them up.
            Pick one of the two above to turn this on.</span>
        </span>
      </label>
    </div>

    <div class="field" style="margin-top:var(--s4)">
      <label>Or is it about the family's welfare?</label>
      <div class="chips" id="es-welfare" style="display:flex;flex-wrap:wrap;gap:8px">
        ${CONCERN_REASONS.filter(r => !CALLER_CONCERNS.includes(r.key)).map(chip).join('')}
      </div>
    </div>

    <div class="field" style="margin-top:var(--s4)"><label>How urgent?</label>
      <div class="seg" style="grid-template-columns:repeat(3,1fr)" id="es-sev">
        ${CONCERN_SEVERITIES.map(s => `<button type="button" class="seg-btn ${s.key === 'high' ? 'on tone-warn' : ''}"
          data-sev="${s.key}" data-tone="${s.tone}"><span>${s.label}</span></button>`).join('')}
      </div>
    </div>

    <div class="field" style="margin-top:var(--s4)"><label>What happened, in your words</label>
      <textarea class="textarea" id="es-note"
        placeholder="What they said, what you noticed, anything the supervisor should know first…"></textarea></div>

    <div class="form-actions" style="margin-top:var(--s4)">
      <button class="btn btn-secondary" id="es-cancel">Cancel</button>
      <button class="btn btn-danger" id="es-save">${icon('alertTriangle')}Send it</button>
    </div>`;

  showModal({ title: `Flag this · ${sanitize(patient.full_name || '')}`, content: el, size: 'lg' });

  const allChips = () => el.querySelectorAll('#es-self .chip, #es-welfare .chip');
  allChips().forEach(btn => btn.addEventListener('click', () => {
    state.reason = btn.dataset.reason;
    allChips().forEach(b => { b.className = 'chip seg-btn'; b.style.padding = '8px 12px'; });
    btn.className = 'chip seg-btn on tone-danger'; btn.style.padding = '8px 12px';

    // Asking to be taken off is only offered for the reasons it answers. A
    // welfare flag means the mentor STAYS on the family: that is the point of
    // flagging it. Unlike the portal, the control is always visible and merely
    // disabled, so she can see the option exists before she knows the word for
    // what happened to her.
    const wrap = el.querySelector('#es-off-wrap');
    const box = el.querySelector('#es-off');
    const offerable = CALLER_CONCERNS.includes(state.reason);
    box.disabled = !offerable;
    wrap.style.opacity = offerable ? '1' : '.55';
    if (!offerable) box.checked = false;

    if (!state.sevTouched && ['self_harm', 'condition_critical'].includes(state.reason)) {
      state.severity = 'urgent';
      el.querySelectorAll('#es-sev .seg-btn').forEach(b =>
        b.className = 'seg-btn' + (b.dataset.sev === 'urgent' ? ' on tone-danger' : ''));
    }
  }));

  el.querySelectorAll('#es-sev .seg-btn').forEach(btn => btn.addEventListener('click', () => {
    state.severity = btn.dataset.sev; state.sevTouched = true;
    el.querySelectorAll('#es-sev .seg-btn').forEach(b => b.className = 'seg-btn');
    btn.className = `seg-btn on tone-${btn.dataset.tone}`;
  }));

  el.querySelector('#es-cancel').addEventListener('click', () => closeModal());
  el.querySelector('#es-save').addEventListener('click', async () => {
    if (!state.reason) { showToast('Pick what happened. That is what routes the help.', 'warning'); return; }
    const btn = el.querySelector('#es-save');
    const wantsOff = !!el.querySelector('#es-off')?.checked;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner" style="width:16px;height:16px;border-width:2px"></span>Sending…';
    const note = el.querySelector('#es-note').value.trim() || null;
    try {
      const sb = getSupabase();
      if (wantsOff) {
        // Same RPC the portal uses (sql/113). It raises the flag AND cancels
        // her queue rows in one transaction, so she is never told "done" while
        // the person is still on tomorrow's list.
        const { data, error } = await sb.rpc('request_patient_reassignment', {
          p_patient_id: patient.id, p_reason: state.reason,
          p_severity: state.severity, p_note: note,
        });
        if (error) throw error;
        closeModal();
        // Read the response before claiming anything: sql/113 returns
        // already_pending when she has asked before, and telling her "sent"
        // twice while nothing new happened is how a mentor stops trusting it.
        showToast(data?.already_pending
          ? 'You had already asked. Your note has been added to that request; a supervisor still has it.'
          : 'Sent. They are off your list from now, and a supervisor will pick it up. You did the right thing.',
          'success', 8000);
      } else {
        const { data, error } = await sb.rpc('raise_call_concern', {
          p_patient_id: patient.id, p_reason: state.reason,
          p_severity: state.severity, p_note: note,
        });
        if (error) throw error;
        closeModal();
        showToast(data?.created === false
          ? 'Added to the flag already open on them. A supervisor has it.'
          : 'Flagged. A supervisor will see it. Well done for raising it.', 'success');
      }
      opts.onDone?.(wantsOff);
    } catch (e) {
      showToast('Could not send it: ' + e.message, 'error');
      btn.disabled = false; btn.innerHTML = `${icon('alertTriangle')}Send it`;
    }
  });
}

// ---- "They are not engaging" / "They are completely disinterested" -------
// Asked for on 09/09 by the Ground POC lead. Backed by
// mark_patient_disinterest (sql/125), which reuses patient_status = 'inactive'
// and adds a DATED hold rather than inventing a fifth status or abusing
// do_not_call. See the long note in sql/125 for why.
const LEVELS = [
  { key: 'not_engaging', label: 'Not engaging right now',
    hint: 'Still worth trying later. They stop being handed around while we wait.' },
  { key: 'completely_disinterested', label: 'Completely disinterested',
    hint: 'They do not want the programme. Nobody calls them, and nobody is handed them, for the deferral period.' },
];

export function openDisinterestModal(patient, opts = {}) {
  const state = { level: '' };
  const el = document.createElement('div');
  el.innerHTML = `
    <p style="font:var(--t-sm);color:var(--ink-2);margin:0 0 var(--s4)">
      This stops <strong>${sanitize(patient.full_name || 'them')}</strong> being passed from mentor to mentor
      while they are not taking part. It is not a do-not-call: the deferral runs out on its own
      and they come back into the call order.</p>
    <div class="field">
      <label>Which is it? <span class="req">*</span></label>
      <div class="chips" id="di-levels" style="display:flex;flex-direction:column;gap:8px">
        ${LEVELS.map(l => `<button type="button" class="chip seg-btn" data-level="${l.key}"
          style="padding:10px 12px;text-align:left;justify-content:flex-start">
          <span><strong>${l.label}</strong>
          <span style="display:block;font:var(--t-xs);color:var(--ink-3);margin-top:2px">${l.hint}</span></span>
        </button>`).join('')}
      </div>
    </div>
    <div class="field" style="margin-top:var(--s4)"><label>What did they say?</label>
      <textarea class="textarea" id="di-note"
        placeholder="Their own words if you have them. The next person to reach them will read this."></textarea></div>
    <div class="form-actions" style="margin-top:var(--s4)">
      <button class="btn btn-secondary" id="di-cancel">Cancel</button>
      <button class="btn btn-primary" id="di-save">${icon('check')}Save</button>
    </div>`;
  showModal({ title: 'Not taking part', content: el, size: 'md' });

  el.querySelectorAll('#di-levels .chip').forEach(b => b.addEventListener('click', () => {
    state.level = b.dataset.level;
    el.querySelectorAll('#di-levels .chip').forEach(x => {
      x.className = 'chip seg-btn'; x.style.padding = '10px 12px';
      x.style.textAlign = 'left'; x.style.justifyContent = 'flex-start';
    });
    b.className = 'chip seg-btn on tone-warn'; b.style.padding = '10px 12px';
    b.style.textAlign = 'left'; b.style.justifyContent = 'flex-start';
  }));

  el.querySelector('#di-cancel').addEventListener('click', () => closeModal());
  el.querySelector('#di-save').addEventListener('click', async () => {
    if (!state.level) { showToast('Pick one of the two.', 'warning'); return; }
    const btn = el.querySelector('#di-save');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner" style="width:16px;height:16px;border-width:2px"></span>Saving…';
    try {
      const { data, error } = await getSupabase().rpc('mark_patient_disinterest', {
        p_patient_id: patient.id, p_level: state.level,
        p_note: el.querySelector('#di-note').value.trim() || null,
      });
      if (error) throw error;
      closeModal();
      // The number comes back from the server, not from a constant here: the
      // deferral is an admin setting and a hardcoded sentence would go stale
      // the first time somebody changes it.
      const days = data?.hold_days;
      showToast(days
        ? `Saved. Nobody is handed them for ${days} days, then they come back into the order.`
        : 'Saved.', 'success', 7000);
      opts.onDone?.(data);
    } catch (e) {
      showToast('Could not save: ' + e.message, 'error');
      btn.disabled = false; btn.innerHTML = `${icon('check')}Save`;
    }
  });
}

export async function clearDisinterest(patient, onDone) {
  try {
    const { error } = await getSupabase().rpc('clear_patient_disinterest', {
      p_patient_id: patient.id, p_note: null,
    });
    if (error) throw error;
    showToast('Back in the programme. They return to the call order on the next daily build.', 'success');
    onDone?.();
  } catch (e) { showToast('Could not lift the hold: ' + e.message, 'error'); }
}
