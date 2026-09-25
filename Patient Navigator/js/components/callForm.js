// ============================================================
// Patient Navigator: shared structured "Log a call" modal
// Same tap-first questionnaire as the calling portal, usable from
// the patient detail page and the call-logs page.
// IMPORTANT: writes BOTH follow_up_date (legacy) and
// next_followup_date (what build_daily_assignments reads).
// ============================================================

import { getSupabase } from '../supabase.js';
import { getCurrentUser, getCurrentProfile, isManagerOrAdmin, getUserRole } from '../auth.js';
import { showToast } from './toast.js';
import { showModal, closeModal } from './modal.js';
import { icon } from './icons.js';
import { sanitize } from '../utils/validators.js';
import { DIAL_STATUSES, RECEPTIVENESS, CONDITIONS, REQUIREMENTS, LEVER_GROUPS, MEASURES, INSTRUMENTS, leverLabel } from '../utils/catalog.js';

// Which wellbeing measures each care role captures by default (IMPACT section).
const ROLE_MEASURES = {
  nutritionist:     ['must_malnutrition', 'qol_physical', 'activation'],
  therapist:        ['phq4_patient', 'phq4_caregiver', 'zarit_burden', 'qol_emotional'],
  caregiver_mentor: ['caregiver_confidence', 'zarit_burden', 'phq4_caregiver'],
};
const DEFAULT_MEASURES = ['qol_physical', 'qol_emotional', 'activation'];
// Lever group a role should see expanded first.
const ROLE_LEVER_GROUP = {
  nutritionist: 'Nutrition & wellbeing', therapist: 'Nutrition & wellbeing',
  caregiver_mentor: 'Information & engagement',
};

const STATUS_DAYS = { no_answer: 7, busy: 7, voicemail: 7, callback_requested: 7, wrong_number: null };

function addDays(n) { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().split('T')[0]; }

// ---- Save must always be reachable, and must always say what it is waiting for ----
// Field report, 25 Sep 2026 (a nutrition intern on an iPhone): "Save Call
// is not getting enabled". The API gateway logs show this form opened 46 times
// between 07 and 23 Sep on her phone and laptop, and not one call_logs insert.
// Two different things sat on top of the action row at the bottom of this
// sheet on her iPhone: from 22 Sep the PWA install bar (position:fixed,
// z-index 9998, over the modal's 70), and before that the bottom of the sheet
// itself, because a phone modal was sized 100vh, which on iOS Safari is taller
// than the space the fixed overlay really has while the toolbar shows, so the
// sticky Save row sat under the toolbar. Both are fixed where they live
// (js/pwa.js, js/components/modal.js, css/layout.css). This file makes the form
// defend itself against the next overlay nobody has thought of yet:
//   1. Save is never `disabled` for "not ready yet", only aria-disabled. A tap
//      on it always does something: it says what is missing and takes you there.
//   2. After opening, and whenever the viewport changes (keyboard, rotation,
//      toolbar), the form hit-tests Save. If anything covers it or it is off
//      the visible screen, the action row moves to the top of the sheet.
const LC_STYLE_ID = 'lc-form-style';
function injectCallFormStyle() {
  if (document.getElementById(LC_STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = LC_STYLE_ID;
  s.textContent = `
    #lc-form .lc-need { outline: 2px solid var(--danger, #B3261E); outline-offset: 6px; border-radius: 10px; }
    #lc-form .lc-need-msg { color: var(--danger, #B3261E); font-size: 12.5px; font-weight: 600; margin: 8px 0 0; }
    #lc-why.lc-why-alert { color: var(--danger, #B3261E); font-weight: 700; }
    .modal #lc-form .form-actions.lc-actions-top {
      position: sticky; top: 0; bottom: auto;
      margin: calc(-1 * var(--s6)) calc(-1 * var(--s6)) var(--s5);
      padding-bottom: var(--s4);
      border-top: 0; border-bottom: 1px solid var(--line); border-radius: 0;
    }
    @media (max-width: 480px) {
      .modal #lc-form .form-actions { flex-wrap: wrap; }
      .modal #lc-form #lc-why { flex: 1 1 100%; }
    }
  `;
  document.head.appendChild(s);
}

function describeEl(node) {
  if (!node) return 'nothing';
  if (node.id) return `#${node.id}`;
  const cls = typeof node.className === 'string' ? node.className.trim().split(/\s+/)[0] : '';
  const host = node.closest?.('[id]');
  return `${node.tagName.toLowerCase()}${cls ? '.' + cls : ''}${host ? ` inside #${host.id}` : ''}`;
}

// Is the button inside the visible screen, and is it the topmost thing at
// three points along its middle? elementFromPoint is what a tap hits, so a bar
// painted over the button fails this even though the button is "visible".
function hitTestButton(btn) {
  if (!btn || !btn.isConnected) return { ok: true };
  const r = btn.getBoundingClientRect();
  if (!r.width || !r.height) return { ok: false, why: 'not laid out' };
  const vv = window.visualViewport;
  const top = vv ? vv.offsetTop : 0;
  const bottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
  if (r.top < top - 1 || r.bottom > bottom + 1) return { ok: false, why: 'outside the visible screen' };
  for (const fx of [0.5, 0.15, 0.85]) {
    const hit = document.elementFromPoint(r.left + r.width * fx, r.top + r.height / 2);
    if (hit && hit !== btn && !btn.contains(hit)) return { ok: false, why: `covered by ${describeEl(hit)}` };
  }
  return { ok: true };
}

// opts: { patient: {id, full_name} | null, onSaved: fn | null }
export async function openCallForm({ patient = null, onSaved = null } = {}) {
  const sb = getSupabase();
  const me = getCurrentProfile() || { id: getCurrentUser()?.id };
  injectCallFormStyle();

  // Patient choices when not pre-selected. Care roles (mentors, nutrition,
  // therapy) read through RLS can_care_for_patient, which already covers
  // assigned, queued, logged, nutrition-held and specialist patients. Adding
  // an extra assigned_to/created_by filter on top hid everyone a nutritionist
  // holds via continuity, leaving an empty dropdown and a Save button that
  // never enables. That was the "Save a Call not appearing" report. So care
  // roles get the RLS view unfiltered; intake-only roles keep the narrow
  // "what you uploaded" scope.
  let patientOptions = [];
  if (!patient) {
    let q = sb.from('patients').select('id, patient_code, full_name, consent_given')
      .eq('is_active', true).neq('patient_status', 'deceased').order('full_name').limit(800);
    if (!isManagerOrAdmin()) {
      const r = getUserRole();
      const careRoles = ['caller', 'caregiver_mentor', 'therapist', 'nutritionist'];
      if (!careRoles.includes(r)) q = q.eq('created_by', me.id);
    }
    const { data } = await q;
    patientOptions = data || [];
  }

  // Consent used to be reachable only from Patient -> Edit, so a mentor who
  // took it on the call had to go and find the record afterwards, and often
  // did not. It is asked here, where she already is. Only asked of people who
  // have not given it: re-ticking it would overwrite the original date.
  let consentOnFile = false;
  if (patient?.id) {
    const { data: pc } = await sb.from('patients').select('consent_given').eq('id', patient.id).maybeSingle();
    consentOnFile = !!pc?.consent_given;
  }

  const role = getUserRole();
  const state = { dial: '', recep: '', cond: '', reqs: [], waLink: null, waJoin: null,
                  levers: {}, mainResolved: null, interruption: null, consent: null };
  const measureKeys = ROLE_MEASURES[role] || DEFAULT_MEASURES;
  const shownMeasures = MEASURES.filter(m => measureKeys.includes(m.key));
  const openGroup = ROLE_LEVER_GROUP[role] || null;

  // ---- ACTION section: support-lever ledger (writes patient_services) ----
  const fieldInput = (l) => {
    if (l.field === 'amount')   return `<input class="input lever-field" data-lever="${l.key}" data-field="amount" type="number" min="0" step="100" placeholder="${l.fieldLabel}" />`;
    if (l.field === 'sessions') return `<input class="input lever-field" data-lever="${l.key}" data-field="sessions" type="number" min="0" step="1" placeholder="${l.fieldLabel}" />`;
    if (l.field === 'detail')   return `<input class="input lever-field" data-lever="${l.key}" data-field="detail" placeholder="${l.fieldLabel}" />`;
    if (l.field === 'outcome')  return `<select class="select lever-field" data-lever="${l.key}" data-field="outcome"><option value="">${l.fieldLabel || 'Outcome'}…</option>${l.options.map(o => `<option value="${o.key}">${o.label}</option>`).join('')}</select>`;
    return '';
  };
  const actionHTML = `
    <details class="ria-sec" ${openGroup ? 'open' : ''} style="margin-top:var(--s5);border:1px solid var(--color-border);border-radius:12px;padding:6px 12px">
      <summary style="cursor:pointer;font-weight:600;padding:8px 0"><span class="ria-pill" style="font-family:var(--font-mono);background:var(--primary);color:var(--on-primary);font-size:9.5px;font-weight:600;letter-spacing:.22em;padding:4px 9px;border-radius:5px;margin-right:9px;vertical-align:1px">ACTION</span>Support activated today <span style="color:var(--color-text-muted);font-weight:400">(tap what you helped with)</span></summary>
      <div style="padding:6px 0 10px">
        ${LEVER_GROUPS.map(g => `
          <div class="lever-group" style="margin-bottom:12px">
            <div style="font-size:12px;font-weight:700;color:var(--color-text-muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">${g.group}</div>
            <div class="chip-row">
              ${g.levers.map(l => `<button type="button" class="fchip lever-chip" data-lever="${l.key}">${sanitize(l.label)}</button>`).join('')}
            </div>
            ${g.levers.filter(l => l.field).map(l => `<div class="lever-field-wrap" data-lever="${l.key}" style="display:none;margin-top:6px">${fieldInput(l)}</div>`).join('')}
          </div>`).join('')}
      </div>
    </details>`;

  // ---- IMPACT section: outcomes + wellbeing scores (writes patient_assessments) ----
  // Instrument items come in two shapes: a plain string with one shared
  // option set (PHQ-4), or an object carrying its own options per question
  // (MUST). Reading only the shared set threw "Cannot read properties of
  // undefined (reading 'map')" the moment a nutritionist opened this form,
  // and rendering `it` directly printed [object Object] for every guided
  // question. Same two helpers the assessment flow already uses.
  const qText = (inst, it) => (it && typeof it === 'object') ? it.q : it;
  const qOpts = (inst, it) => (it && typeof it === 'object' && it.options) ? it.options : inst.options;
  const measureRow = (m) => {
    const raw = INSTRUMENTS[m.key];
    const inst = (raw && Array.isArray(raw.items) && raw.items.length) ? raw : null;
    return `
      <div class="field" style="margin-bottom:10px">
        <label>${m.label} <span style="font-weight:400;color:var(--color-text-muted)">· ${m.hint}</span></label>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <input class="input meas-input" id="lc-meas-${m.key}" data-meas="${m.key}" type="number" min="${m.min}" max="${m.max}" step="1" style="max-width:120px" placeholder="${m.min}-${m.max}" />
          ${inst ? `<button type="button" class="btn btn-secondary btn-sm meas-guide-btn" data-meas="${m.key}">Guided</button>` : ''}
        </div>
        ${inst ? `<div class="guide-panel" id="lc-guide-${m.key}" style="display:none;margin-top:8px;padding:10px;border:1px solid var(--color-border);border-radius:10px;background:rgba(0,0,0,.12)">
          <p style="font-size:12px;color:var(--color-text-muted);margin:0 0 8px">${inst.intro}</p>
          ${inst.note ? `<p style="font-size:12px;color:var(--warn,var(--color-text-muted));margin:0 0 8px"><strong>Before you score:</strong> ${sanitize(inst.note)}</p>` : ''}
          ${inst.items.map((it, qi) => `<div class="guide-item" data-q="${qi}" style="margin-bottom:8px"><div style="font-size:13px;margin-bottom:4px">${qi + 1}. ${sanitize(qText(inst, it))}</div>${it && it.hindi ? `<div style="font-size:12px;font-style:italic;color:var(--color-text-muted);margin-bottom:4px">${sanitize(it.hindi)}</div>` : ''}<div style="display:flex;flex-wrap:wrap;gap:6px">${(qOpts(inst, it) || []).map(([lab, pts]) => `<button type="button" class="gopt" data-pts="${pts}" style="font-size:12px;padding:4px 9px;border-radius:8px;border:1px solid var(--color-border);background:transparent;color:var(--color-text);cursor:pointer">${sanitize(lab)}</button>`).join('')}</div></div>`).join('')}
          <div style="font-size:12px;color:var(--color-text-muted);margin-top:4px">${inst.interpret}</div>
        </div>` : ''}
      </div>`;
  };
  const impactHTML = `
    <details class="ria-sec" ${role && role !== 'caller' && role !== 'manager' && role !== 'admin' ? 'open' : ''} style="margin-top:var(--s4);border:1px solid var(--color-border);border-radius:12px;padding:6px 12px">
      <summary style="cursor:pointer;font-weight:600;padding:8px 0"><span class="ria-pill" style="font-family:var(--font-mono);background:var(--clay);color:var(--on-primary);font-size:9.5px;font-weight:600;letter-spacing:.22em;padding:4px 9px;border-radius:5px;margin-right:9px;vertical-align:1px">IMPACT</span>How they're doing <span style="color:var(--color-text-muted);font-weight:400">(scores &amp; outcomes)</span></summary>
      <div style="padding:6px 0 10px">
        <div class="row" style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:8px">
          <div class="field" style="flex:1;min-width:170px"><label>Main request resolved?</label>
            <div class="ynp" data-yn="mainResolved"><button type="button" class="yn" data-v="yes">Yes</button><button type="button" class="yn" data-v="no">No</button></div></div>
          <div class="field" style="flex:1;min-width:170px"><label>Treatment interruption?</label>
            <div class="ynp" data-yn="interruption"><button type="button" class="yn" data-v="yes">Yes</button><button type="button" class="yn" data-v="no">No</button></div></div>
        </div>
        <input class="input" id="lc-interrupt-reason" placeholder="If yes: what interrupted treatment?" style="display:none;margin-bottom:10px" />
        ${shownMeasures.map(measureRow).join('')}
        <p style="font-size:12px;color:var(--color-text-muted);margin:4px 0 0">Leave blank if not assessed this call. First score becomes the baseline; later scores show the change in Analytics.</p>
      </div>
    </details>`;

  const el = document.createElement('div');
  el.innerHTML = `
    <form id="lc-form" novalidate>
      ${patient ? '' : `
        <div class="field" style="margin-bottom:var(--s5)">
          <label>Patient <span class="req">*</span></label>
          <select class="select" id="lc-patient" required>
            <option value="">Choose a patient…</option>
            ${patientOptions.map(p => `<option value="${p.id}">${p.patient_code} · ${sanitize(p.full_name)}</option>`).join('')}
          </select>
          ${patientOptions.length ? '' : `
            <p id="lc-nopatients" style="font-size:12.5px;line-height:1.45;color:var(--danger,#B3261E);margin:8px 0 0">
              <strong>This list is empty, so this form cannot save.</strong>
              Nobody is visible to you from here. Open the person from the
              Patients page and use "Log a call" on their own page instead, or
              ask your manager to put them on your list. Tell the tech pod if
              this keeps happening; your role is ${sanitize(role || 'unknown')}.
            </p>`}
        </div>`}

      <div class="field" style="margin-bottom:var(--s5)">
        <label>Call outcome <span class="req">*</span></label>
        <div class="seg seg-wrap" id="lc-outcome">
          ${DIAL_STATUSES.map(o => `<button type="button" class="seg-btn" data-status="${o.key}" data-tone="${o.tone}">${icon(o.icon)}<span>${o.label}</span></button>`).join('')}
        </div>
      </div>

      <div class="reveal" id="lc-connected"><div class="reveal-inner">
        <div class="field"><label>How were they doing? <span class="req">*</span></label>
          <div class="recep" id="lc-recep">
            ${RECEPTIVENESS.map(r => `<button type="button" class="recep-btn" data-recep="${r.key}"><div class="recep-label">${r.label}</div><div class="recep-hint">${r.hint}</div></button>`).join('')}
          </div>
        </div>
        <div class="field"><label>How is the patient doing?</label>
          <div class="seg" style="grid-template-columns:repeat(5,1fr)" id="lc-cond">
            ${CONDITIONS.map(c => `<button type="button" class="seg-btn" data-cond="${c.key}" data-tone="${c.tone}"><span>${c.label}</span></button>`).join('')}
          </div>
        </div>
        <div class="field"><label>What did they ask for?</label>
          <div class="chip-row" id="lc-reqs">
            ${REQUIREMENTS.map(r => `<button type="button" class="fchip" data-req="${r.key}">${icon(r.icon)}<span>${r.key}</span></button>`).join('')}
          </div>
          <input class="input" id="lc-customreq" placeholder="Anything else they asked for…" style="margin-top:8px" />
        </div>
        <div class="row" style="display:flex;gap:16px;flex-wrap:wrap">
          <div class="field" style="flex:1;min-width:150px"><label>WhatsApp link sent?</label>
            <div class="ynp" data-yn="waLink"><button type="button" class="yn" data-v="yes">Yes</button><button type="button" class="yn" data-v="no">No</button></div></div>
          <div class="field" style="flex:1;min-width:150px"><label>Joined the group?</label>
            <div class="ynp" data-yn="waJoin"><button type="button" class="yn" data-v="yes">Yes</button><button type="button" class="yn" data-v="no">No</button></div></div>
        </div>
        <div class="field" id="lc-consent-wrap" style="display:${consentOnFile ? 'none' : ''}">
          <label>Did they give consent on this call?</label>
          <p style="font-size:12px;color:var(--color-text-muted);margin:2px 0 8px">“Is it alright if we stay in touch and keep a few notes about your care? It stays private, and you can ask us to stop any time.” Tick it here and it goes on the record: no need to open Patient Edit afterwards.</p>
          <div class="ynp" data-yn="consent"><button type="button" class="yn" data-v="yes">They consented</button><button type="button" class="yn" data-v="no">Not today</button></div>
        </div>
        <div class="row" style="display:flex;gap:16px;flex-wrap:wrap">
          <div class="field" style="flex:1;min-width:200px"><label>Feedback from patient</label>
            <input class="input" id="lc-fb-patient" placeholder="In their words…" /></div>
          <div class="field" style="flex:1;min-width:200px"><label>Feedback from caregiver</label>
            <input class="input" id="lc-fb-caregiver" placeholder="In their words…" /></div>
        </div>
      </div></div>

      ${actionHTML}
      ${impactHTML}

      <div class="row" style="display:flex;gap:16px;flex-wrap:wrap;margin-top:var(--s5)">
        <div class="field" style="width:150px"><label>Duration (min)</label>
          <input class="input" id="lc-duration" type="number" min="0" step="1" value="0" /></div>
        <div class="field" style="flex:1;min-width:170px"><label>Next check-in <span class="fu-auto" id="lc-auto" style="display:none">suggested</span></label>
          <input class="input" id="lc-followup" type="date" min="${addDays(3)}" /></div>
      </div>
      <div class="field" style="margin-top:var(--s4)"><label>Notes</label>
        <textarea class="textarea" id="lc-notes" placeholder="Anything worth remembering about this conversation…"></textarea></div>
      <div class="field" style="margin-top:var(--s4)"><label>A note to hand the next caller</label>
        <textarea class="textarea" id="lc-strategy" placeholder="What helped, what to lead with, best time to reach them…"></textarea></div>

      <!-- A greyed-out Save with no explanation cost the nutrition pod two
           weeks of logging: the patient dropdown was coming back empty and
           nothing on screen said so, so it read as "the button is broken".
           The reason lives INSIDE .form-actions on purpose, because that row
           is the sticky one; anywhere else in this 1500px form it scrolls out
           of sight and is no better than no message at all.
           aria-disabled, NOT disabled: a disabled button swallows the tap, so
           a person who cannot see the reason gets nothing at all. This one
           answers every tap with what is missing (see explainMissing). -->
      <div class="form-actions">
        <span id="lc-why" role="status" aria-live="polite" style="margin-right:auto;font-size:12.5px;line-height:1.35;color:var(--ink-3,var(--color-text-muted));text-align:left"></span>
        <button type="button" class="btn btn-secondary" id="lc-cancel">Cancel</button>
        <button type="submit" class="btn btn-primary" id="lc-submit" aria-disabled="true">${icon('check')}Save call</button>
      </div>
    </form>
  `;

  // Set by guardSaveReachable() below; every way out of the sheet calls it, so
  // the guard's resize listeners never outlive the form.
  let stopGuard = () => {};
  showModal({
    title: patient ? `Log a call · ${sanitize(patient.full_name)}` : 'Log a call',
    content: el, size: 'lg', onClose: () => stopGuard(),
  });

  const $ = (sel) => el.querySelector(sel);
  const $$ = (sel) => el.querySelectorAll(sel);
  let dateManual = false;

  function suggestFollowup() {
    if (dateManual) return;
    let days = null;
    if (state.dial === 'connected') days = RECEPTIVENESS.find(x => x.key === state.recep)?.days ?? null;
    else if (state.dial) days = STATUS_DAYS[state.dial];
    const input = $('#lc-followup'), auto = $('#lc-auto');
    if (days != null) { input.value = addDays(days); auto.style.display = ''; }
    else { input.value = ''; auto.style.display = 'none'; }
  }
  // One list of what is missing, used by the reason text, by the button's
  // state and by a tap on the button, so the three can never disagree.
  // `anchor` is the control a person has to touch to clear the item.
  function missingItems() {
    const missing = [];
    if (!patient && !$('#lc-patient')?.value) {
      missing.push({ text: patientOptions.length ? 'pick the patient' : 'no patient is available to pick', anchor: '#lc-patient' });
    }
    if (!state.dial) missing.push({ text: 'tap how the call went', anchor: '#lc-outcome' });
    if (state.dial === 'connected' && !state.recep) missing.push({ text: 'tap how they were doing', anchor: '#lc-recep' });
    return missing;
  }
  function reasonText(missing) {
    return missing.length ? `Still needed to save: ${missing.map(m => m.text).join(', ')}.` : '';
  }
  function updateSubmit() {
    const missing = missingItems();
    const btn = $('#lc-submit');
    btn.setAttribute('aria-disabled', missing.length ? 'true' : 'false');
    btn.title = missing.length ? reasonText(missing) : 'Save this call';
    const why = $('#lc-why');
    if (why) {
      why.textContent = reasonText(missing);
      if (!missing.length) why.classList.remove('lc-why-alert');
    }
    // A field that was flagged and is now answered stops shouting.
    $$('.lc-need').forEach(f => {
      if (!missing.some(m => f.contains($(m.anchor)))) {
        f.classList.remove('lc-need');
        f.querySelector('.lc-need-msg')?.remove();
      }
    });
  }
  // A tap on Save while something is missing: say it next to the button, in
  // a toast, and at the field itself, then bring that field into view.
  function explainMissing(missing) {
    const why = $('#lc-why');
    if (why) { why.textContent = reasonText(missing); why.classList.add('lc-why-alert'); }
    const first = missing[0];
    const control = first ? $(first.anchor) : null;
    const field = control?.closest('.field') || control;
    if (field) {
      field.classList.add('lc-need');
      if (!field.querySelector('.lc-need-msg')) {
        const msg = document.createElement('p');
        msg.className = 'lc-need-msg';
        msg.textContent = `Needed to save: ${first.text}.`;
        field.appendChild(msg);
      }
      field.scrollIntoView({ block: 'center', behavior: 'smooth' });
      const focusable = control.matches?.('select, button, input') ? control : control.querySelector?.('button, select, input');
      focusable?.focus({ preventScroll: true });
    }
    showToast(reasonText(missing), 'warning', 6000);
  }

  $('#lc-patient')?.addEventListener('change', updateSubmit);
  // Picking a patient from the dropdown decides whether the consent
  // question is worth asking at all.
  $('#lc-patient')?.addEventListener('change', (e) => {
    const chosen = patientOptions.find(p => p.id === e.target.value);
    const wrap = $('#lc-consent-wrap');
    if (!wrap) return;
    const already = !!chosen?.consent_given;
    wrap.style.display = already ? 'none' : '';
    if (already) state.consent = null;
  });
  $$('#lc-outcome .seg-btn').forEach(btn => btn.addEventListener('click', () => {
    state.dial = btn.dataset.status;
    $$('#lc-outcome .seg-btn').forEach(b => b.className = 'seg-btn');
    btn.className = `seg-btn on tone-${btn.dataset.tone}`;
    const connected = state.dial === 'connected';
    $('#lc-connected').classList.toggle('open', connected);
    if (!connected) state.recep = '';
    suggestFollowup(); updateSubmit();
  }));
  $$('#lc-recep .recep-btn').forEach(btn => btn.addEventListener('click', () => {
    state.recep = btn.dataset.recep;
    $$('#lc-recep .recep-btn').forEach(b => b.classList.remove('on'));
    btn.classList.add('on'); suggestFollowup(); updateSubmit();
  }));
  $$('#lc-cond .seg-btn').forEach(btn => btn.addEventListener('click', () => {
    state.cond = state.cond === btn.dataset.cond ? '' : btn.dataset.cond;
    $$('#lc-cond .seg-btn').forEach(b => b.className = 'seg-btn');
    if (state.cond) btn.className = `seg-btn on tone-${btn.dataset.tone}`;
  }));
  $$('#lc-reqs .fchip').forEach(btn => btn.addEventListener('click', () => {
    const k = btn.dataset.req;
    if (state.reqs.includes(k)) { state.reqs = state.reqs.filter(x => x !== k); btn.classList.remove('on'); }
    else { state.reqs.push(k); btn.classList.add('on'); }
  }));
  $$('.ynp').forEach(group => {
    const field = group.dataset.yn;
    group.querySelectorAll('.yn').forEach(btn => btn.addEventListener('click', () => {
      const val = btn.dataset.v === 'yes';
      state[field] = val;
      group.querySelectorAll('.yn').forEach(b => b.classList.remove('yes', 'no'));
      btn.classList.add(val ? 'yes' : 'no');
      if (field === 'interruption') { const r = $('#lc-interrupt-reason'); if (r) r.style.display = val ? '' : 'none'; }
    }));
  });

  // ACTION: support levers
  $$('.lever-chip').forEach(btn => btn.addEventListener('click', () => {
    const k = btn.dataset.lever;
    if (state.levers[k]) { delete state.levers[k]; btn.classList.remove('on'); }
    else { state.levers[k] = {}; btn.classList.add('on'); }
    const wrap = el.querySelector(`.lever-field-wrap[data-lever="${k}"]`);
    if (wrap) wrap.style.display = state.levers[k] ? '' : 'none';
  }));
  $$('.lever-field').forEach(inp => inp.addEventListener('input', () => {
    const k = inp.dataset.lever;
    if (state.levers[k]) state.levers[k][inp.dataset.field] = inp.value;
  }));

  // IMPACT: guided instruments (PHQ-4, Zarit, BGQ) auto-sum into the score
  $$('.meas-guide-btn').forEach(btn => btn.addEventListener('click', () => {
    const panel = el.querySelector(`#lc-guide-${btn.dataset.meas}`);
    if (panel) panel.style.display = panel.style.display === 'none' ? '' : 'none';
  }));
  $$('.guide-panel').forEach(panel => {
    const meas = panel.id.replace('lc-guide-', '');
    const sums = {};
    panel.querySelectorAll('.guide-item').forEach(item => {
      item.querySelectorAll('.gopt').forEach(opt => opt.addEventListener('click', () => {
        item.querySelectorAll('.gopt').forEach(o => { o.style.background = 'transparent'; o.style.color = 'var(--color-text)'; });
        opt.style.background = 'var(--primary)'; opt.style.color = 'var(--on-primary)';
        sums[item.dataset.q] = Number(opt.dataset.pts);
        const input = el.querySelector(`#lc-meas-${meas}`);
        if (input) input.value = Object.values(sums).reduce((a, b) => a + b, 0);
      }));
    });
  });

  $('#lc-followup').addEventListener('input', () => { dateManual = true; $('#lc-auto').style.display = 'none'; });
  $('#lc-cancel').addEventListener('click', () => { stopGuard(); closeModal(); });

  // Say what is missing from the moment the form opens, not only after the
  // first tap. An empty dropdown is then visible immediately.
  updateSubmit();
  stopGuard = guardSaveReachable();

  // After the sheet has animated in, and again whenever the visible screen
  // changes size (keyboard, rotation, a browser toolbar showing or hiding),
  // check that a tap on Save would actually land on Save. If it would not,
  // move the whole action row, reason included, to the top of the sheet,
  // which no bottom bar, toolbar or keyboard can reach. Once moved it stays
  // moved for the life of this form, so it cannot flicker.
  function guardSaveReachable() {
    const overlay = el.closest('.modal-overlay');
    let moved = false;
    let tries = 0;
    const check = () => {
      if (!el.isConnected) { detach(); return; }
      // The overlay ignores pointer events until it is .active, so a hit test
      // before that would blame the page underneath. Wait for it.
      if (overlay && !overlay.classList.contains('active')) {
        if (++tries < 20) setTimeout(check, 150);
        return;
      }
      const res = hitTestButton($('#lc-submit'));
      if (res.ok || moved) {
        if (!res.ok) console.warn(`[callForm] Save call is still not reachable at the top of the sheet (${res.why}).`);
        return;
      }
      moved = true;
      const actions = $('.form-actions');
      const form = $('#lc-form');
      if (actions && form) {
        form.insertBefore(actions, form.firstChild);
        actions.classList.add('lc-actions-top');
        el.closest('.modal')?.scrollTo({ top: 0 });
      }
      console.warn(`[callForm] Save call was not reachable (${res.why}); moved the action row to the top of the sheet.`);
      setTimeout(check, 250);
    };
    const onResize = () => setTimeout(check, 200);
    const detach = () => {
      window.removeEventListener('resize', onResize);
      window.visualViewport?.removeEventListener('resize', onResize);
    };
    window.addEventListener('resize', onResize);
    window.visualViewport?.addEventListener('resize', onResize);
    setTimeout(check, 450);
    return detach;
  }

  $('#lc-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#lc-submit');
    if (btn.disabled) return;   // a save is already in flight
    const missing = missingItems();
    if (missing.length) { explainMissing(missing); return; }
    const patientId = patient?.id || $('#lc-patient')?.value;
    const connected = state.dial === 'connected';

    btn.disabled = true; btn.innerHTML = '<span class="spinner" style="width:17px;height:17px;border-width:2.5px"></span>Saving…';

    const customReq = $('#lc-customreq')?.value.trim() || '';
    const reqList = [...state.reqs]; if (customReq) reqList.push(customReq);
    const followUp = $('#lc-followup').value || null;
    const structured = {
      requirements: state.reqs, custom_requirement: customReq || null,
      condition: state.cond || null, whatsapp_link_sent: state.waLink, whatsapp: state.waJoin,
      consent_taken: state.consent,
    };
    try {
      const { error } = await sb.from('call_logs').insert({
        patient_id: patientId,
        caller_id: me.id,
        contacted_by_name: me.full_name ? me.full_name.toUpperCase() : null,
        call_date: new Date().toISOString(),
        dial_status: state.dial,
        call_duration_mins: parseFloat($('#lc-duration').value) || 0,
        receptiveness_bucket: connected ? state.recep : null,
        patient_condition: state.cond || null,
        structured,
        whatsapp_link_sent: state.waLink === true,
        whatsapp_group_joined: state.waJoin === true,
        feedback_patient: $('#lc-fb-patient')?.value.trim() || null,
        feedback_caregiver: $('#lc-fb-caregiver')?.value.trim() || null,
        caller_notes: $('#lc-notes').value.trim() || null,
        requirements_noted: reqList.length ? reqList.join(', ') : null,
        follow_up_date: followUp,
        next_followup_date: followUp ? followUp + 'T00:00:00Z' : null,
        followup_strategy_notes: $('#lc-strategy').value.trim() || null,
        main_request_resolved: state.mainResolved,
        unplanned_interruption: state.interruption,
        unplanned_interruption_reason: state.interruption ? ($('#lc-interrupt-reason')?.value.trim() || null) : null,
        lead_source: 'other',
      });
      if (error) throw error;

      // Consent, taken on the call, written on the call. Direct update
      // rather than update_patient_from_call: that RPC needs a queue row
      // touched in the last 12 hours, which a call logged from the patient
      // page does not have. This is the same write the Patient Edit form
      // makes, so it needs no permission the mentor did not already have.
      // Said out loud when it fails: a consent that silently did not save
      // is worse than one nobody ticked.
      if (state.consent === true) {
        const nowIso = new Date().toISOString();
        const { error: cErr } = await sb.from('patients')
          .update({ consent_given: true, consent_date: nowIso, consent_method: 'verbal_during_call' })
          .eq('id', patientId);
        if (cErr) showToast('The call saved, but consent did not: ' + cErr.message, 'error', 8000);
      }

      // ACTION: upsert the support-lever ledger
      const leverRows = Object.entries(state.levers).map(([lever, f]) => ({
        patient_id: patientId, lever, done: true,
        amount: f.amount ? Number(f.amount) : null,
        sessions: f.sessions ? parseInt(f.sessions, 10) : null,
        detail: f.detail || null, outcome: f.outcome || null, recorded_by: me.id,
      }));
      // The support ledger is what shows up on the patient's profile, and it
      // used to fail in silence: the toast said "Call logged · 3 support" while
      // console.error ate the reason and nothing reached the profile, which is
      // exactly what the team hit ("I have to enter it manually now"). Retry
      // row by row so one bad lever cannot take the rest down with it, and say
      // out loud when something did not save.
      const leverFailures = [];
      if (leverRows.length) {
        const { error: e2 } = await sb.from('patient_services').upsert(leverRows, { onConflict: 'patient_id,lever' });
        if (e2) {
          console.error('lever save (batch):', e2.message);
          for (const row of leverRows) {
            const { error: e2b } = await sb.from('patient_services').upsert(row, { onConflict: 'patient_id,lever' });
            if (e2b) { console.error('lever save:', row.lever, e2b.message); leverFailures.push({ lever: row.lever, msg: e2b.message }); }
          }
        }
      }
      // IMPACT: insert any wellbeing scores entered this call
      const assessRows = shownMeasures.map(m => {
        const v = $(`#lc-meas-${m.key}`)?.value;
        return (v !== '' && v != null) ? { patient_id: patientId, measure: m.key, score: Number(v), recorded_by: me.id } : null;
      }).filter(Boolean);
      let scoreFailed = null;
      if (assessRows.length) {
        const { error: e3 } = await sb.from('patient_assessments').insert(assessRows);
        if (e3) { console.error('assessment save:', e3.message); scoreFailed = e3.message; }
      }

      stopGuard();
      closeModal();
      const savedLevers = leverRows.length - leverFailures.length;
      const extras = (savedLevers ? ` · ${savedLevers} support` : '')
        + (assessRows.length && !scoreFailed ? ` · ${assessRows.length} scores` : '');
      showToast('Call logged' + extras, 'success');
      // Never let a partial save read as a clean one.
      if (leverFailures.length) {
        showToast(`Support not saved (${leverFailures.map(f => leverLabel(f.lever)).join(', ')}): ${leverFailures[0].msg}. Add it from the patient's Support tab.`, 'error', 9000);
      }
      if (scoreFailed) showToast(`Wellbeing scores not saved: ${scoreFailed}`, 'error', 9000);
      if (typeof onSaved === 'function') onSaved();
    } catch (err) {
      showToast('Could not save: ' + err.message, 'error');
      btn.disabled = false; btn.innerHTML = `${icon('check')}Save call`;
    }
  });
}
