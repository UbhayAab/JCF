// ============================================================
// Patient Navigator: Step-by-step wellbeing assessment flow
// A calm, mobile-first wizard for administering the wellbeing
// questionnaires (PHQ-4, Zarit caregiver burden, BGQ grief,
// QoL, activation, …). Designed for psychology interns talking
// to cancer patients & caregivers:
//   • Overview first: pick what to do, see what's already done.
//   • One measure per step (progress "2 of 5", Back / Skip / Next).
//   • Guided INSTRUMENTS read item-by-item; the score sums itself
//     and the interpretation band updates live; the item breakdown
//     is stored in patient_assessments.details.
//   • Single-number MEASURES use a big tap-scale.
//   • PARTIAL SAVE is mandatory. Every completed measure is saved
//     immediately & independently. The user may close anytime and
//     resume later; saved measures show as "done" in the overview.
// ============================================================

import { getSupabase } from '../supabase.js';
import { getCurrentProfile, getCurrentUser } from '../auth.js';
import { showModal, closeModal } from './modal.js';
import { showToast } from './toast.js';
import { icon } from './icons.js';
import { formatRelativeTime } from '../utils/formatters.js';
import { MEASURES, BEREAVEMENT_MEASURES, INSTRUMENTS } from '../utils/catalog.js';

// Which measures each care role is most likely to administer: these
// surface first / pre-suggested. Everyone can still do any of them.
const ROLE_PRIORITY = {
  nutritionist:     ['must_malnutrition', 'qol_physical', 'activation'],
  therapist:        ['phq4_patient', 'phq4_caregiver', 'zarit_burden', 'qol_emotional'],
  caregiver_mentor: ['caregiver_confidence', 'zarit_burden', 'phq4_caregiver'],
};

// Group the measures the way an intern thinks about them.
const GROUPS = [
  { key: 'patient',     label: 'How the patient is doing',  icon: 'heart',
    keys: ['qol_physical', 'qol_emotional', 'must_malnutrition', 'financial_toxicity', 'phq4_patient', 'activation'] },
  { key: 'caregiver',   label: 'How the caregiver is holding up', icon: 'users',
    keys: ['phq4_caregiver', 'zarit_burden', 'caregiver_confidence'] },
  { key: 'bereavement', label: 'After the loss (bereavement)', icon: 'handHeart',
    keys: ['grief_screen', 'caregiver_support_6m'] },
];

const ALL = [...MEASURES, ...BEREAVEMENT_MEASURES];
const measureDef = (key) => ALL.find(m => m.key === key);

// Live interpretation band for a single-number measure.
function bandFor(m, v) {
  if (v == null || v === '') return '';
  const span = m.max - m.min;
  const good = m.dir > 0 ? v >= m.min + span * 0.66 : v <= m.min + span * 0.34;
  const bad  = m.dir > 0 ? v <= m.min + span * 0.34 : v >= m.min + span * 0.66;
  const label = good ? 'doing well' : bad ? 'needs attention' : 'in the middle';
  const tone  = good ? 'ok' : bad ? 'danger' : 'warn';
  return `<span class="badge badge-${tone}">${label}</span>`;
}

// Live interpretation for a guided instrument from the running total.
function instBand(m, inst, total) {
  // Pull the friendly cut-off text straight from the catalog interpret line.
  return `<span class="badge badge-info">Score ${total} / ${m.max}</span>
          <span style="font:var(--t-xs);color:var(--ink-3)">${inst.interpret}</span>`;
}

// opts: { patient: {id, full_name}, role, onSaved }
export async function openAssessmentFlow({ patient, role = null, onSaved = null } = {}) {
  if (!patient?.id) { showToast('No patient selected', 'warning'); return; }
  const sb = getSupabase();
  const me = getCurrentProfile() || { id: getCurrentUser()?.id };

  // ---- shell ----
  const el = document.createElement('div');
  el.className = 'asmt-flow';
  showModal({
    title: `Wellbeing check-in · ${esc(patient.full_name || 'patient')}`,
    content: el, size: 'lg',
  });

  // saved[key] = { score, recorded_at }: latest per measure for this patient.
  const saved = {};
  el.innerHTML = `<div class="asmt-loading" style="padding:40px 0;text-align:center;color:var(--ink-3)">
    <span class="spinner" style="width:26px;height:26px;border-width:3px"></span>
    <div style="margin-top:12px;font:var(--t-sm)">Loading what we already know…</div></div>`;

  // Fetch existing assessments so the overview can show "done" state.
  try {
    const { data } = await sb.from('patient_assessments')
      .select('measure, score, recorded_at')
      .eq('patient_id', patient.id)
      .order('recorded_at', { ascending: true });
    for (const r of (data || [])) saved[r.measure] = { score: Number(r.score), recorded_at: r.recorded_at };
  } catch (_) { /* non-fatal: overview just shows none done */ }

  let didSaveAny = false;

  // ====================================================
  // OVERVIEW: pick which measures to do.
  // ====================================================
  function renderOverview() {
    const prio = ROLE_PRIORITY[role] || [];
    const groupHTML = GROUPS.map(g => {
      const rows = g.keys.map(key => {
        const m = measureDef(key); if (!m) return '';
        const inst = INSTRUMENTS[key];
        const done = saved[key];
        const isPrio = prio.includes(key);
        const meta = done
          ? `<span class="badge badge-ok">${icon('check')} ${done.score}/${m.max}</span>
             <span style="font:var(--t-xs);color:var(--ink-3)">${formatRelativeTime(done.recorded_at)}</span>`
          : isPrio
            ? `<span class="badge badge-gold">suggested for you</span>`
            : `<span style="font:var(--t-xs);color:var(--ink-3)">not yet recorded</span>`;
        return `
          <button type="button" class="asmt-pick" data-pick="${key}" style="
            display:flex;align-items:center;gap:12px;width:100%;text-align:left;
            padding:13px 14px;border:1px solid var(--line);border-radius:var(--r-md);
            background:var(--surface);cursor:pointer;margin-bottom:8px;transition:all .15s">
            <span class="asmt-pick-tick" style="flex:none;width:22px;height:22px;border-radius:50%;
              border:2px solid var(--line-strong);display:grid;place-items:center;color:var(--on-primary)${done ? ';background:var(--ok);border-color:var(--ok)' : ''}">${done ? icon('check') : ''}</span>
            <span style="flex:1;min-width:0">
              <span style="display:block;font:var(--t-sm);font-weight:650;color:var(--ink)">${m.label}${inst ? ' <span style="font-weight:500;color:var(--ink-3)">· guided</span>' : ''}</span>
              <span style="display:block;font:var(--t-xs);color:var(--ink-3)">${m.hint}</span>
            </span>
            <span style="flex:none;display:flex;flex-direction:column;align-items:flex-end;gap:3px">${meta}</span>
          </button>`;
      }).join('');
      return `
        <div style="margin-bottom:18px">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;color:var(--primary)">
            ${icon(g.icon)}<span style="font:var(--t-sm);font-weight:700;color:var(--ink)">${g.label}</span>
          </div>
          ${rows}
        </div>`;
    }).join('');

    el.innerHTML = `
      <p style="font:var(--t-sm);color:var(--ink-2);margin:0 0 4px">
        Pick the check-ins that feel natural in this conversation. There's no need to do them all.
        Each one saves on its own, so you can stop anytime and pick up later.
      </p>
      <p style="font:var(--t-xs);color:var(--ink-3);margin:0 0 18px">
        Tap to select · already-recorded ones are ticked with their last score.
      </p>
      ${groupHTML}
      <div class="form-actions" style="position:sticky;bottom:0;background:var(--surface);padding-top:12px;border-top:1px solid var(--line)">
        <button type="button" class="btn btn-secondary" id="asmt-close">${didSaveAny ? 'Done' : 'Close'}</button>
        <button type="button" class="btn btn-primary" id="asmt-begin" disabled>${icon('arrowRight')}Start (<span id="asmt-count">0</span>)</button>
      </div>`;

    const picked = new Set();
    el.querySelectorAll('.asmt-pick').forEach(btn => {
      btn.addEventListener('click', () => {
        const k = btn.dataset.pick;
        const tick = btn.querySelector('.asmt-pick-tick');
        if (picked.has(k)) {
          picked.delete(k);
          btn.style.borderColor = 'var(--line)'; btn.style.background = 'var(--surface)';
          tick.style.background = ''; tick.style.borderColor = 'var(--line-strong)';
          tick.innerHTML = saved[k] ? icon('check') : '';
          if (saved[k]) tick.style.background = 'var(--ok)', tick.style.borderColor = 'var(--ok)';
        } else {
          picked.add(k);
          btn.style.borderColor = 'var(--primary)'; btn.style.background = 'var(--primary-soft)';
          tick.style.background = 'var(--primary)'; tick.style.borderColor = 'var(--primary)';
          tick.innerHTML = icon('check');
        }
        const begin = el.querySelector('#asmt-begin');
        el.querySelector('#asmt-count').textContent = picked.size;
        begin.disabled = picked.size === 0;
      });
      // Pre-tint saved rows' ticks green (without selecting them).
      if (saved[btn.dataset.pick]) {
        const t = btn.querySelector('.asmt-pick-tick');
        t.style.background = 'var(--ok)'; t.style.borderColor = 'var(--ok)';
      }
    });

    el.querySelector('#asmt-close').addEventListener('click', () => closeModal());
    el.querySelector('#asmt-begin').addEventListener('click', () => {
      if (picked.size) startWizard([...picked]);
    });
  }

  // ====================================================
  // WIZARD: one measure per step.
  // ====================================================
  function startWizard(keys) {
    let idx = 0;

    function renderStep() {
      const key = keys[idx];
      const m = measureDef(key);
      const inst = INSTRUMENTS[key];
      const total = keys.length;
      const progressPct = ((idx) / total) * 100;

      el.innerHTML = `
        <div style="margin-bottom:16px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <span style="font:var(--t-xs);font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--ink-3)">Step ${idx + 1} of ${total}</span>
            ${saved[key] ? `<span class="badge badge-ok">already saved · ${saved[key].score}/${m.max}</span>` : ''}
          </div>
          <div style="height:6px;background:var(--surface-3);border-radius:999px;overflow:hidden">
            <div id="asmt-bar" style="height:100%;width:${progressPct}%;background:linear-gradient(90deg,var(--primary-bright),var(--primary));transition:width .3s"></div>
          </div>
        </div>
        <h3 style="font:var(--t-h3);color:var(--ink);margin:0 0 4px">${m.label}</h3>
        <p style="font:var(--t-xs);color:var(--ink-3);margin:0 0 16px">${m.hint}</p>
        <div id="asmt-body"></div>
        <div id="asmt-band" style="margin-top:16px;min-height:24px;display:flex;align-items:center;gap:10px;flex-wrap:wrap"></div>
        <div class="form-actions" style="position:sticky;bottom:0;background:var(--surface);padding-top:12px;border-top:1px solid var(--line);margin-top:18px;display:flex;gap:10px;flex-wrap:wrap">
          <button type="button" class="btn btn-ghost" id="asmt-back">${icon('arrowLeft')}${idx === 0 ? 'Overview' : 'Back'}</button>
          <button type="button" class="btn btn-secondary" id="asmt-skip">Skip</button>
          <button type="button" class="btn btn-primary grow" id="asmt-next" style="flex:1" disabled>${icon('check')}Save &amp; ${idx + 1 < total ? 'next' : 'finish'}</button>
        </div>`;

      const body = el.querySelector('#asmt-body');
      const band = el.querySelector('#asmt-band');
      const nextBtn = el.querySelector('#asmt-next');
      // capture object for the current step
      const cap = { score: null, details: null };

      if (inst) renderGuided(m, inst, body, band, nextBtn, cap);
      else      renderScale(m, body, band, nextBtn, cap);

      el.querySelector('#asmt-back').addEventListener('click', () => {
        if (idx === 0) renderOverview();
        else { idx--; renderStep(); }
      });
      el.querySelector('#asmt-skip').addEventListener('click', () => advance());
      nextBtn.addEventListener('click', async () => {
        if (cap.score == null) return;
        nextBtn.disabled = true;
        nextBtn.innerHTML = '<span class="spinner" style="width:16px;height:16px;border-width:2.5px"></span>Saving…';
        const ok = await saveMeasure(key, cap.score, cap.details);
        if (!ok) {
          nextBtn.disabled = false;
          nextBtn.innerHTML = `${icon('check')}Save &amp; ${idx + 1 < total ? 'next' : 'finish'}`;
          return;
        }
        advance();
      });

      function advance() {
        if (idx + 1 < total) { idx++; renderStep(); }
        else renderOverview(); // back to overview, now with fresh "done" state
      }
    }

    renderStep();
  }

  // ---- single-number measure: read the prompt, then a big tap-scale ----
  function renderScale(m, body, band, nextBtn, cap) {
    // Anchor words come from the measure when given, else a sensible default.
    const lowLabel  = m.lowAnchor  || (m.dir > 0 ? 'worst' : 'low');
    const highLabel = m.highAnchor || (m.dir > 0 ? 'best' : 'high');
    const steps = [];
    for (let v = m.min; v <= m.max; v++) steps.push(v);
    body.innerHTML = `
      ${m.prompt ? `<div style="padding:12px 14px;background:var(--surface-2);border:1px solid var(--line);border-radius:var(--r-sm);margin-bottom:16px;line-height:1.55">
        <div style="font:var(--t-sm);color:var(--ink)">${esc(m.prompt)}</div>
        ${m.hindi ? `<div style="font:var(--t-sm);font-style:italic;color:var(--ink-2);margin-top:5px">${esc(m.hindi)}</div>` : ''}
        ${m.probe ? `<div style="font:var(--t-xs);color:var(--ink-3);margin-top:7px">Probe: ${esc(m.probe)}</div>` : ''}
      </div>` : ''}
      <div style="display:flex;justify-content:space-between;font:var(--t-xs);color:var(--ink-3);margin-bottom:8px">
        <span>${m.min} · ${lowLabel}</span><span>${m.max} · ${highLabel}</span>
      </div>
      <div class="asmt-scale" style="display:flex;flex-wrap:wrap;gap:8px">
        ${steps.map(v => `<button type="button" class="asmt-step seg-btn" data-v="${v}" style="
          flex:1 0 auto;min-width:44px;min-height:48px;font:var(--t-sm);font-weight:700;
          font-variant-numeric:tabular-nums">${v}</button>`).join('')}
      </div>
      ${m.levels ? `<div style="margin-top:10px;display:flex;flex-direction:column;gap:3px">${m.levels.map((lv, i) => `<div style="font:var(--t-xs);color:var(--ink-3)"><strong style="color:var(--ink-2)">${m.min + i}</strong> · ${esc(lv)}</div>`).join('')}</div>` : ''}`;
    body.querySelectorAll('.asmt-step').forEach(btn => btn.addEventListener('click', () => {
      const v = Number(btn.dataset.v);
      body.querySelectorAll('.asmt-step').forEach(b => b.className = 'asmt-step seg-btn');
      btn.className = 'asmt-step seg-btn on tone-primary';
      cap.score = v; cap.details = null;
      band.innerHTML = bandFor(m, v);
      nextBtn.disabled = false;
    }));
  }

  // ---- guided instrument: read items, options as big tap targets ----
  function renderGuided(m, inst, body, band, nextBtn, cap) {
    // An item is either a string (uses the instrument's shared `options`)
    // or an object { q, options } carrying its own option set, e.g. MUST,
    // where BMI / weight-loss / acute-illness each score on a different band.
    const qText = (it) => (it && typeof it === 'object') ? it.q : it;
    const qOpts = (it) => (it && typeof it === 'object' && it.options) ? it.options : inst.options;
    const answers = new Array(inst.items.length).fill(null);
    body.innerHTML = `
      <div style="padding:11px 13px;background:var(--surface-2);border:1px solid var(--line);border-radius:var(--r-sm);margin-bottom:16px">
        <div style="font:var(--t-xs);color:var(--ink-2);line-height:1.5">${esc(inst.intro)}</div>
      </div>
      ${inst.note ? `<div style="padding:11px 13px;background:var(--surface-2);border:1px solid var(--warn,var(--line));border-radius:var(--r-sm);margin-bottom:16px">
        <div style="font:var(--t-xs);color:var(--ink-2);line-height:1.5"><strong>Before you score: </strong>${esc(inst.note)}</div>
      </div>` : ''}
      ${inst.items.map((it, qi) => `
        <div class="asmt-q" data-q="${qi}" style="margin-bottom:16px">
          <div style="font:var(--t-sm);font-weight:600;color:var(--ink);margin-bottom:4px">
            <span style="color:var(--ink-3)">${qi + 1}.</span> ${esc(qText(it))}
          </div>
          ${(it && it.hindi) ? `<div style="font:var(--t-sm);font-style:italic;color:var(--ink-2);margin-bottom:4px">${esc(it.hindi)}</div>` : ''}
          ${(it && it.probe) ? `<div style="font:var(--t-xs);color:var(--ink-3);margin-bottom:8px">Probe: ${esc(it.probe)}</div>` : ''}
          <div style="display:flex;flex-wrap:wrap;gap:8px">
            ${qOpts(it).map(([lab, pts]) => `
              <button type="button" class="asmt-opt seg-btn" data-q="${qi}" data-pts="${pts}" style="
                min-height:42px;padding:8px 14px;font:var(--t-xs);font-weight:600">${esc(lab)}</button>`).join('')}
          </div>
        </div>`).join('')}`;

    const recompute = () => {
      const answered = answers.every(a => a != null);
      if (!answered) { band.innerHTML = `<span style="font:var(--t-xs);color:var(--ink-3)">${inst.items.length === 1 ? 'Pick an answer to score' : `Answer all ${inst.items.length} to score`}</span>`; nextBtn.disabled = true; cap.score = null; return; }
      const total = answers.reduce((a, b) => a + b, 0);
      cap.score = total;
      cap.details = { instrument: m.key, items: inst.items.map((it, i) => ({ q: qText(it), points: answers[i] })), total };
      band.innerHTML = instBand(m, inst, total);
      nextBtn.disabled = false;
    };

    body.querySelectorAll('.asmt-opt').forEach(btn => btn.addEventListener('click', () => {
      const qi = Number(btn.dataset.q);
      body.querySelectorAll(`.asmt-opt[data-q="${qi}"]`).forEach(b => b.className = 'asmt-opt seg-btn');
      btn.className = 'asmt-opt seg-btn on tone-primary';
      answers[qi] = Number(btn.dataset.pts);
      recompute();
    }));
    recompute();
  }

  // ---- partial save: one measure → one new row ----
  async function saveMeasure(key, score, details) {
    try {
      const row = { patient_id: patient.id, measure: key, score, recorded_by: me.id };
      if (details) row.details = details;
      const { error } = await sb.from('patient_assessments').insert(row);
      if (error) throw error;
      saved[key] = { score, recorded_at: new Date().toISOString() };
      didSaveAny = true;
      showToast(`${measureDef(key)?.label || 'Score'} saved · ${score}`, 'success');
      const coach = AUTO_FLAG_COACH[key];
      if (coach && score >= coach.at) showToast(coach.msg(score), 'warning');
      if (typeof onSaved === 'function') onSaved();
      return true;
    } catch (err) {
      showToast('Could not save: ' + (err.message || err), 'error');
      return false;
    }
  }

  renderOverview();
}

// Mirrors the auto-flag thresholds in sql/43: when a score crosses the line
// the DB has ALREADY raised a concern for the supervisors. This just tells
// the intern what happens next, so the moment teaches instead of staying silent.
const AUTO_FLAG_COACH = {
  phq4_patient:       { at: 6, msg: (s) => `PHQ-4 ${s}/12: ${s >= 9 ? 'severe' : 'moderate'} band. A concern went to your supervisor; offer a well-being session today.` },
  phq4_caregiver:     { at: 6, msg: (s) => `Caregiver PHQ-4 ${s}/12: they need support too. Flag raised; suggest a caregiver session.` },
  zarit_burden:       { at: 8, msg: (s) => `Zarit ${s}/16: high caregiver strain. Flag raised; talk respite and a support session.` },
  financial_toxicity: { at: 7, msg: (s) => `Financial toxicity ${s}/10: costs are hurting the family badly. Flag raised for financial-aid follow-up.` },
  must_malnutrition:  { at: 2, msg: (s) => `MUST ${s}: high malnutrition risk. Flag raised; the nutrition team should see them this week.` },
  grief_screen:       { at: 5, msg: (s) => `Grief screen ${s}/10: possible complicated grief. Flag raised; a counselling referral helps here.` },
};

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
