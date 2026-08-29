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

// opts: { patient: {id, full_name} | null, onSaved: fn | null }
export async function openCallForm({ patient = null, onSaved = null } = {}) {
  const sb = getSupabase();
  const me = getCurrentProfile() || { id: getCurrentUser()?.id };

  // Patient choices when not pre-selected (role-scoped like the patients page).
  let patientOptions = [];
  if (!patient) {
    let q = sb.from('patients').select('id, patient_code, full_name')
      .eq('is_active', true).neq('patient_status', 'deceased').order('full_name').limit(800);
    if (!isManagerOrAdmin()) q = q.or(`assigned_to.eq.${me.id},created_by.eq.${me.id}`);
    const { data } = await q;
    patientOptions = data || [];
  }

  const role = getUserRole();
  const state = { dial: '', recep: '', cond: '', reqs: [], waLink: null, waJoin: null,
                  levers: {}, mainResolved: null, interruption: null };
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

      <div class="form-actions">
        <button type="button" class="btn btn-secondary" id="lc-cancel">Cancel</button>
        <button type="submit" class="btn btn-primary" id="lc-submit" disabled>${icon('check')}Save call</button>
      </div>
    </form>
  `;

  showModal({
    title: patient ? `Log a call · ${sanitize(patient.full_name)}` : 'Log a call',
    content: el, size: 'lg',
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
  function updateSubmit() {
    const need = !state.dial || (state.dial === 'connected' && !state.recep) || (!patient && !$('#lc-patient')?.value);
    $('#lc-submit').disabled = need;
  }

  $('#lc-patient')?.addEventListener('change', updateSubmit);
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
  $('#lc-cancel').addEventListener('click', () => closeModal());

  $('#lc-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const patientId = patient?.id || $('#lc-patient')?.value;
    if (!patientId) { showToast('Please choose a patient', 'warning'); return; }
    if (!state.dial) { showToast('Please choose how the call went', 'warning'); return; }
    const connected = state.dial === 'connected';
    if (connected && !state.recep) { showToast('Please note how they were doing', 'warning'); return; }

    const btn = $('#lc-submit');
    btn.disabled = true; btn.innerHTML = '<span class="spinner" style="width:17px;height:17px;border-width:2.5px"></span>Saving…';

    const customReq = $('#lc-customreq')?.value.trim() || '';
    const reqList = [...state.reqs]; if (customReq) reqList.push(customReq);
    const followUp = $('#lc-followup').value || null;
    const structured = {
      requirements: state.reqs, custom_requirement: customReq || null,
      condition: state.cond || null, whatsapp_link_sent: state.waLink, whatsapp: state.waJoin,
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
