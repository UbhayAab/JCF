import { sanitize } from '../utils/validators.js';
import { DIAL_STATUSES, RECEPTIVENESS, CONDITIONS, REQUIREMENTS, GI_SUBTYPES, stageGuide } from '../utils/catalog.js';
import { indiaCallDay, validDay, dayPlus, normalizeCareCall, careCallBounds } from '../utils/careFollowup.js';
import { renderCareCallForm136 } from './careCallForm136.js';
import { hopebotActivityHTML } from './hopebotActivity.js';
import { mountHopebotFeedback } from './hopebotFeedback.js';
import { showModal } from './modal.js';

export const uuid136 = v => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const copy = v => JSON.parse(JSON.stringify(v));
const canonicalJSON = v => JSON.stringify(v, (_k, x) => x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x);
const blank = () => ({ dial_status: '', duration_seconds: 0, receptiveness: null, condition: null, requirements: [], custom_requirements: '', services_offered: [], whatsapp_link_sent: null, whatsapp_joined: null, social_followed: null, consent: 'unknown', notes: '', followup_date: null, strategy: '', patient_feedback: '', caregiver_feedback: '', clinical: {} });
const serviceDefs = [
  { key: 'therapy', column: 'pitched_therapy_at', label: 'Therapy & counselling', icon: 'heart' },
  { key: 'nutrition', column: 'pitched_nutrition_at', label: 'Nutrition guidance', icon: 'leaf' },
  { key: 'caregiver', column: 'pitched_caregiver_at', label: 'Caregiver support', icon: 'users' },
  { key: 'clinical_trial', column: 'pitched_clinical_trial_at', label: 'Clinical-trial info', icon: 'fileText' },
  { key: 'financial_aid', column: 'pitched_financial_aid_at', label: 'Financial-aid guidance', icon: 'shieldCheck' },
];
const STATUS_DAYS = { no_answer: 7, busy: 7, voicemail: 7, callback_requested: 7, wrong_number: null };
const clinicalText = ['treating_hospital', 'current_treatment', 'payment_method', 'primary_language'];
const stages = ['stage_i', 'stage_ii', 'stage_iii', 'stage_iv', 'not_applicable', 'unknown'];
const keyIn = (v, list) => list.some(x => x.key === v);
const bounded = (v, max, field) => { if (typeof v !== 'string' || v.length > max) throw new Error(`${field} is too long or invalid.`); return v.trim(); };
function codes(v, allowed, field) { if (!Array.isArray(v) || v.length > allowed.length || new Set(v).size !== v.length || v.some(x => !allowed.includes(x))) throw new Error(`Check ${field}.`); return [...v].sort(); }

// Only the closed API shape crosses a save or draft boundary. Unknown or
// refused care consent cannot carry private fields, including hidden inputs.
export function fields136(raw, { allowEmpty = false, normalizeDate = true } = {}) {
  const f = { ...blank(), ...raw };
  if ((!allowEmpty || f.dial_status) && !keyIn(f.dial_status, DIAL_STATUSES)) throw new Error('Choose the actual call outcome.');
  if (!Number.isInteger(f.duration_seconds) || f.duration_seconds < 0 || f.duration_seconds > 36000) throw new Error('Duration must be 0 to 36000 seconds.');
  if (!['unknown', 'given', 'refused'].includes(f.consent)) throw new Error('Confirm care consent.');
  const out = blank(); out.dial_status = f.dial_status; out.duration_seconds = f.duration_seconds; out.consent = f.consent;
  if (f.followup_date != null && f.followup_date !== '' && !validDay(f.followup_date)) throw new Error('Choose a valid care-call date.');
  if (f.consent !== 'refused' && (f.consent === 'given' || f.dial_status === 'callback_requested') && f.followup_date) {
    out.followup_date = normalizeDate ? normalizeCareCall(f.followup_date, { callDay: indiaCallDay(), outcome: f.dial_status, active: false }) : f.followup_date;
  }
  if (f.consent !== 'given') return out;
  if (f.receptiveness != null && !keyIn(f.receptiveness, RECEPTIVENESS)) throw new Error('Choose how they were doing.');
  if (!allowEmpty && f.dial_status === 'connected' && !f.receptiveness) throw new Error('Choose how they were doing.');
  if (f.condition != null && !keyIn(f.condition, CONDITIONS)) throw new Error('Check patient condition.');
  out.receptiveness = f.receptiveness; out.condition = f.condition;
  out.requirements = codes(f.requirements, REQUIREMENTS.map(x => x.key), 'requested help');
  out.services_offered = codes(f.services_offered, serviceDefs.map(x => x.key), 'services');
  for (const [name, max] of [['custom_requirements', 1000], ['notes', 5000], ['strategy', 2000], ['patient_feedback', 2000], ['caregiver_feedback', 2000]]) out[name] = bounded(f[name], max, name.replaceAll('_', ' '));
  for (const name of ['whatsapp_link_sent', 'whatsapp_joined', 'social_followed']) { if (f[name] !== null && typeof f[name] !== 'boolean') throw new Error('Check the Yes / No answers.'); out[name] = f[name]; }
  if (!f.clinical || typeof f.clinical !== 'object' || Array.isArray(f.clinical) || Object.keys(f.clinical).some(k => !['gi_subtype', 'cancer_stage', ...clinicalText].includes(k))) throw new Error('Check the clinical details.');
  for (const [k, v] of Object.entries(f.clinical)) {
    if (v == null || v === '') continue;
    if (k === 'gi_subtype' ? !keyIn(v, GI_SUBTYPES) : k === 'cancer_stage' ? !stages.includes(v) : typeof v !== 'string' || v.length > 200) throw new Error(`Check ${k.replaceAll('_', ' ')}.`);
    out.clinical[k] = typeof v === 'string' ? v.trim() : v;
  }
  return out;
}

const PREFIX = 'pn-family-call136:v1:';
const TTL = 20 * 60 * 60 * 1000;
const draftKey = (owner, work) => `${PREFIX}${encodeURIComponent(owner)}:${work}`;
const instant136 = value => typeof value === 'string' && value.length <= 64 && /^\d{4}-\d{2}-\d{2}T/.test(value) && validDay(value.slice(0, 10)) && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) + ' IST' : 'Date not recorded';
export function draftStore136(owner, storage) {
  if (!storage) { try { storage = globalThis.localStorage; } catch {} }
  function read(work, lead) {
    try {
      const v = JSON.parse(storage.getItem(draftKey(owner, work)) || 'null');
      if (!v || v.version !== 1 || v.owner !== owner || v.work_id !== work || (lead && v.lead_id !== lead) || !uuid136(v.lead_id)
        || !Number.isFinite(v.updated_at) || Date.now() - v.updated_at > TTL || v.updated_at > Date.now() + 60000) { storage.removeItem(draftKey(owner, work)); return null; }
      const f = fields136(v.fields, { allowEmpty: true, normalizeDate: false });
      // Never restore unsafe private data smuggled into a minimal envelope.
      if (JSON.stringify(f) !== JSON.stringify(v.fields)) return null;
      if (!Number.isFinite(v.started_at) || v.started_at > Date.now() + 60000 || (v.manual_seconds !== null && (!Number.isInteger(v.manual_seconds) || v.manual_seconds < 0 || v.manual_seconds > 36000))) return null;
      if (v.clock && (!Number.isInteger(v.clock.elapsed_seconds) || v.clock.elapsed_seconds < 0 || v.clock.elapsed_seconds > 36000 || (v.clock.running_since !== null && (!Number.isFinite(v.clock.running_since) || v.clock.running_since > Date.now() + 60000)))) return null;
      if (v.attempted && (!uuid136(v.attempted.nonce) || JSON.stringify(fields136(v.attempted.fields, { normalizeDate: false })) !== JSON.stringify(v.attempted.fields))) return null;
      if (v.registration && (!uuid136(v.registration.nonce) || !validIdentity136(v.registration.identity) || v.fields.consent !== 'given' || v.attempted)) return null;
      if (v.registration?.snapshot) {
        const s = v.registration.snapshot;
        if (s.work_id !== work || s.lead_id !== v.lead_id || s.fields?.consent !== 'given'
          || canonicalJSON(fields136(s.fields, { allowEmpty: true, normalizeDate: false })) !== canonicalJSON(s.fields)
          || s.duration_seconds !== s.fields.duration_seconds) return null;
      }
      if (v.attempted && v.attempted.fields.consent !== v.fields.consent) return null;
      if (v.transition && !transition136(v.transition, work, v.lead_id)) return null;
      return copy(v);
    } catch { return null; }
  }
  function write(v) {
    const safe = { version: 1, owner, work_id: v.work_id, lead_id: v.lead_id, updated_at: Date.now(), started_at: v.started_at, resume_on_load: v.resume_on_load !== false,
      manual_seconds: v.manual_seconds, clock: v.clock ? copy(v.clock) : { elapsed_seconds: 0, running_since: null }, manual_followup: v.manual_followup === true, fields: fields136(v.fields, { allowEmpty: true, normalizeDate: false }),
      attempted: v.attempted ? copy(v.attempted) : null, registration: v.registration ? copy(v.registration) : null, transition: v.transition ? copy(v.transition) : null };
    if (!uuid136(safe.work_id) || !uuid136(safe.lead_id)) throw new Error('Draft identity is invalid.');
    // Registrations always require given care consent. A minimal envelope may
    // retain only its minimal frozen save, never a previous private attempt.
    if (safe.fields.consent !== 'given') { safe.registration = null; safe.transition = null; if (safe.attempted) safe.attempted.fields = fields136(safe.attempted.fields, { normalizeDate: false }); }
    try { storage.setItem(draftKey(owner, safe.work_id), JSON.stringify(safe)); return true; } catch { return false; }
  }
  function remove(work) { try { storage.removeItem(draftKey(owner, work)); } catch {} }
  function clearOwner() { try { for (let i = storage.length - 1; i >= 0; i--) { const k = storage.key(i); if (k?.startsWith(`${PREFIX}${encodeURIComponent(owner)}:`)) storage.removeItem(k); } } catch {} }
  function pending() {
    try { const rows = []; for (let i = 0; i < storage.length; i++) { const k = storage.key(i); if (!k?.startsWith(`${PREFIX}${encodeURIComponent(owner)}:`)) continue; const id = k.slice(k.lastIndexOf(':') + 1); const d = uuid136(id) && read(id); if (d) rows.push(d); } return rows.sort((a, b) => b.updated_at - a.updated_at); } catch { return []; }
  }
  return { read, write, remove, clearOwner, pending };
}

function validIdentity136(v) {
  return !!v && typeof v.patient_name === 'string' && v.patient_name.trim().length >= 2 && v.patient_name.length <= 200
    && Object.keys(v).every(k => ['patient_name', 'contact_role', 'caregiver_name', 'confirmed_identity', 'consent', 'patient_id'].includes(k))
    && ['patient', 'caregiver'].includes(v.contact_role) && typeof v.caregiver_name === 'string' && v.caregiver_name.length <= 200
    && (v.contact_role !== 'caregiver' || v.caregiver_name.trim().length >= 2) && v.confirmed_identity === true && v.consent === 'given'
    && (v.contact_role !== 'patient' || v.caregiver_name === '') && !/^Lead [0-9]{4}$/.test(v.patient_name.trim())
    && (v.patient_id == null || uuid136(v.patient_id));
}
export function transition136(v, work, lead) {
  return !!v && v.anchor_type === 'patient_call' && v.work_id === work && v.lead_id === lead && uuid136(v.patient_id) && uuid136(v.queue_id);
}
export function receipt136(v, work, lead, expected) {
  if (!v || v.anchor_type !== 'lead_call' || v.work_id !== work || v.lead_id !== lead || v.patient_id != null || !uuid136(v.call_id) || v.dial_status !== expected.dial_status) return false;
  try {
    const canonical = fields136(v.fields, { normalizeDate: false }), compare = copy(expected);
    const minimal = canonical.consent !== 'given';
    const expectedShape = minimal ? { dial_status: canonical.dial_status, duration_seconds: canonical.duration_seconds, consent: canonical.consent, followup_date: canonical.followup_date } : canonical;
    if (v.fields.followup_date !== canonical.followup_date || canonicalJSON(expectedShape) !== canonicalJSON(v.fields)) return false;
    // The server owns calendar/rest normalization. All other collected values
    // must round trip exactly, and any returned date must be a real future day.
    if (canonical.followup_date !== compare.followup_date && (!canonical.followup_date || canonical.followup_date < indiaCallDay())) return false;
    compare.followup_date = canonical.followup_date;
    return canonicalJSON(compare) === canonicalJSON(canonical);
  } catch { return false; }
}

// The parent owns authorization and list lifecycle. This module owns only its
// connected inline workspace and uses the supplied exact-work RPC boundary.
export function mountFamilyContactCall136(element, { row, claimed, rpc, current, store, draft = null, onClose, onSkip, onRegistered } = {}) {
  let disposed = false, busy = false, saved = false, identityDialog = false, durationInvalid = false, contextSeq = 0, timer, modal = null, feedback = null;
  let state = draft || { work_id: row.id, lead_id: row.lead_id, started_at: Date.now(), manual_seconds: null, fields: blank(), attempted: null, registration: null, transition: null };
  state.resume_on_load = true;
  state.clock ||= { elapsed_seconds: 0, running_since: null };
  let historySuppressed = state.fields.consent === 'refused';
  let callNum = 1, context = null;
  const here = () => !disposed && element.isConnected && current();
  const q = s => element.querySelector(s);
  const qa = s => [...element.querySelectorAll(s)];
  const duration = () => state.manual_seconds ?? Math.min(36000, state.clock.elapsed_seconds + (state.clock.running_since === null ? 0 : Math.max(0, Math.floor((Date.now() - state.clock.running_since) / 1000))));
  function pauseClock() { if (state.clock.running_since !== null) { state.clock.elapsed_seconds = Math.min(36000, state.clock.elapsed_seconds + Math.max(0, Math.floor((Date.now() - state.clock.running_since) / 1000))); state.clock.running_since = null; } }
  function startClock() { if (!here() || busy || saved || identityDialog || state.attempted || state.registration || state.transition || durationInvalid) return; if (state.manual_seconds !== null) { state.clock.elapsed_seconds = state.manual_seconds; state.manual_seconds = null; } if (state.clock.running_since === null) state.clock.running_since = Date.now(); persist(); tick(); controls(); }
  const persist = () => { if (!here() || saved) return; try { state.fields = readFields(true); if (!store.write(state)) message('Browser storage is unavailable. Keep this call open until the server confirms saving.', true); } catch (e) { message(e.message, true); } };
  function message(text, error = false) { const el = q('[data-family-message136]'); if (el) { el.textContent = text; el.style.color = error ? 'var(--danger)' : ''; } }
  function snapshot() { const fields = readFields(true); return { version: 1, work_id: row.id, lead_id: row.lead_id, fields: copy(fields), clinical: copy(fields.clinical), consent: fields.consent, started_at: state.clock.running_since === null ? null : Date.now() - fields.duration_seconds * 1000, duration_seconds: fields.duration_seconds, manual_seconds: state.manual_seconds, timer_running: state.clock.running_since !== null, clock: copy(state.clock), attempted: state.attempted ? copy(state.attempted) : null }; }
  function readFields(allowEmpty = false) {
    const input = q('[data-family-duration136]');
    if (durationInvalid || (input && (!input.checkValidity() || (input.value !== '' && (!Number.isInteger(Number(input.value)) || Number(input.value) < 0 || Number(input.value) > 36000))))) throw new Error('Duration must be 0 to 36000 whole seconds.');
    const raw = { ...state.fields, duration_seconds: duration() };
    for (const [id, key] of [['f-customreq', 'custom_requirements'], ['f-notes', 'notes'], ['f-strategy', 'strategy'], ['f-fb-patient', 'patient_feedback'], ['f-fb-caregiver', 'caregiver_feedback']]) if (q(`#${id}`)) raw[key] = q(`#${id}`).value;
    if (q('#f-followup')) raw.followup_date = q('#f-followup').value || null;
    if (q('#services')) raw.services_offered = qa('#services .svc').filter(x => x.querySelector('input')?.checked).map(x => x.dataset.svc);
    return fields136(raw, { allowEmpty });
  }
  function controls() {
    if (!here() || saved) return;
    const frozen = identityDialog || !!state.attempted || !!state.registration || !!state.transition;
    qa('.logform button,.logform input,.logform textarea,[data-family-duration136]').forEach(el => { el.disabled = busy || frozen; });
    // Care questions are visible in the common form, but private answers only
    // become editable after an explicit Yes. Outcome and callback date remain.
    if (state.fields.consent !== 'given') {
      qa('#recep button,#seg-condition button,#reqs button,#services input,#f-customreq,#f-notes,#f-strategy,#f-fb-patient,#f-fb-caregiver,#f-details-btn,.yesno:not([data-yn="consent"]) button').forEach(el => { el.disabled = true; });
      if (state.fields.consent === 'refused' || state.fields.dial_status !== 'callback_requested') q('#f-followup').disabled = true;
    }
    q('#f-wellbeing-btn')?.setAttribute('disabled', '');
    const submit = q('#f-submit'); submit.disabled = busy || identityDialog || !!state.registration || !!state.transition;
    q('[data-family-start-timer136]').disabled = busy || frozen || durationInvalid || state.clock.running_since !== null;
    q('[data-family-pause-timer136]').disabled = busy || frozen || durationInvalid || state.clock.running_since === null;
    let why = '';
    try { readFields(); } catch (e) { why = e.message; if (!state.attempted) submit.disabled = true; }
    submit.textContent = busy ? 'Working...' : state.attempted ? 'Retry the same saved call' : 'Submit & next call';
    q('#f-why').textContent = state.attempted ? 'The previous save is unconfirmed. Retry its exact answers safely before making changes.' : why || 'Ready to save the actual call.';
    q('[data-family-close136]').disabled = busy;
    // A pending identity operation can be retried from its action button.
    q('[data-family-register136]').disabled = busy || identityDialog || !!state.attempted;
    if (state.registration || state.transition) q('[data-family-register136]').textContent = 'Resume confirmed record';
    if (durationInvalid) { submit.disabled = true; q('[data-family-register136]').disabled = true; }
  }
  function paint() {
    const guide = stageGuide(callNum);
    element.innerHTML = `<div class="portal-grid family-call136"><div class="col-left"><section class="card" style="padding:18px;overflow-wrap:anywhere"><div class="row gap5 wrap"><span class="badge badge-info">HopeBot channel</span><span class="due-meta">${callNum >= 3 ? 'Third call onwards' : `Call ${callNum}`}</span></div><h2>${sanitize(claimed.name)}</h2><p class="due-meta">Saved contact. Confirm who the patient is before linking a record.</p><a class="btn btn-primary" href="tel:+${sanitize(claimed.phone)}" data-family-dial136>Call +${sanitize(claimed.phone)}</a><p><span data-family-timer136 role="timer"></span></p><div class="row gap5 wrap"><button type="button" class="btn btn-secondary" data-family-start-timer136>Start call timer</button><button type="button" class="btn btn-secondary" data-family-pause-timer136>Pause call timer</button></div><p class="due-meta">Start when you call; pause when the conversation ends. Opening this screen does not count as call time.</p><label class="field">Actual duration in seconds (optional correction)<input type="number" min="0" max="36000" step="1" class="input" data-family-duration136 value="${state.manual_seconds ?? ''}" placeholder="Timer runs automatically"></label><button type="button" class="btn btn-secondary" data-family-close136>Close and keep draft</button></section><section class="card" style="padding:16px"><h3>${sanitize(guide.title)}</h3><p>${sanitize(guide.what)}</p><p class="due-meta">${sanitize(guide.capture)}</p></section><div data-family-context136></div><div data-family-history136></div></div><div class="col-right">${renderCareCallForm136({ full_name: claimed.name, consent_given: false }, { callNum, services: serviceDefs, contactMode: true })}<p data-family-message136 role="status" aria-live="polite"></p></div></div>`;
    restoreFields(); bind(); paintContext(); tick(); controls();
  }
  function restoreFields() {
    const f = state.fields;
    const chosen = (selector, value, attr) => qa(selector).forEach(el => { const on = el.dataset[attr] === value; el.classList.toggle('on', on); el.classList.toggle('selected', on); el.setAttribute('aria-pressed', String(on)); });
    chosen('#seg-outcome [data-status]', f.dial_status, 'status'); chosen('#recep [data-recep]', f.receptiveness, 'recep'); chosen('#seg-condition [data-cond]', f.condition, 'cond');
    qa('#reqs [data-req]').forEach(el => { const on = f.requirements.includes(el.dataset.req); el.classList.toggle('on', on); el.classList.toggle('selected', on); el.setAttribute('aria-pressed', String(on)); });
    for (const [id, key] of [['f-customreq', 'custom_requirements'], ['f-notes', 'notes'], ['f-strategy', 'strategy'], ['f-fb-patient', 'patient_feedback'], ['f-fb-caregiver', 'caregiver_feedback'], ['f-followup', 'followup_date']]) if (q(`#${id}`)) q(`#${id}`).value = f[key] ?? '';
    for (const [yn, key] of [['waLink', 'whatsapp_link_sent'], ['whatsapp', 'whatsapp_joined'], ['social', 'social_followed'], ['consent', 'consent']]) qa(`.yesno[data-yn="${yn}"] .yn`).forEach(el => { const val = key === 'consent' ? f.consent === 'given' ? 'yes' : f.consent === 'refused' ? 'no' : null : f[key] === null ? null : f[key] ? 'yes' : 'no'; const on = el.dataset.v === val; el.classList.toggle('on', on); el.classList.toggle('selected', on); el.setAttribute('aria-pressed', String(on)); });
    qa('#services .svc').forEach(el => { el.querySelector('input').checked = f.services_offered.includes(el.dataset.svc); el.classList.toggle('on', el.querySelector('input').checked); });
    q('#reveal-connected')?.classList.toggle('open', f.dial_status === 'connected');
    const bounds = careCallBounds({ callDay: indiaCallDay(), outcome: f.dial_status, active: false }); q('#f-followup').min = bounds.min || ''; q('#f-followup').max = bounds.max || '';
    q('#fu-auto').style.display = !state.manual_followup && f.followup_date ? '' : 'none';
    qa('.yesno .yn').forEach(el => { const on = el.classList.contains('on'); el.classList.toggle('yes', on && el.dataset.v === 'yes'); el.classList.toggle('no', on && el.dataset.v === 'no'); });
    qa('#seg-outcome .seg-btn,#seg-condition .seg-btn,#reqs .chip').forEach(el => { for (const tone of ['ok', 'info', 'warn', 'danger', 'neutral', 'primary']) el.classList.remove(`tone-${tone}`); if (el.classList.contains('on')) el.classList.add(`tone-${el.dataset.tone || 'primary'}`); });
    const limits = { 'f-customreq': 1000, 'f-notes': 5000, 'f-strategy': 2000, 'f-fb-patient': 2000, 'f-fb-caregiver': 2000 }; for (const [id, max] of Object.entries(limits)) q(`#${id}`)?.setAttribute('maxlength', max);
  }
  function mutate(fn) { if (!here() || busy || saved || identityDialog || state.attempted || state.registration || state.transition) return; try { state.fields = readFields(true); fn(state.fields); state.fields = fields136(state.fields, { allowEmpty: true }); restoreFields(); persist(); controls(); } catch (e) { message(e.message, true); } }
  function bind() {
    const suggest = f => { if (state.manual_followup) return; const days = f.dial_status === 'connected' ? RECEPTIVENESS.find(x => x.key === f.receptiveness)?.days : STATUS_DAYS[f.dial_status]; f.followup_date = days == null ? null : normalizeCareCall(dayPlus(indiaCallDay(), Math.max(days, 7)), { callDay: indiaCallDay(), outcome: f.dial_status, active: false }); };
    qa('#seg-outcome [data-status]').forEach(el => el.onclick = () => mutate(f => { f.dial_status = el.dataset.status; if (f.dial_status !== 'connected') f.receptiveness = null; suggest(f); }));
    qa('#recep [data-recep]').forEach(el => el.onclick = () => mutate(f => { f.receptiveness = el.dataset.recep; suggest(f); }));
    qa('#seg-condition [data-cond]').forEach(el => el.onclick = () => mutate(f => { f.condition = f.condition === el.dataset.cond ? null : el.dataset.cond; }));
    qa('#reqs [data-req]').forEach(el => el.onclick = () => mutate(f => { f.requirements = f.requirements.includes(el.dataset.req) ? f.requirements.filter(x => x !== el.dataset.req) : [...f.requirements, el.dataset.req]; }));
    qa('.yesno .yn').forEach(el => el.onclick = () => {
      if (el.closest('.yesno').dataset.yn === 'consent' && el.dataset.v === 'no') {
        if (!here() || busy || saved || identityDialog || state.attempted || state.registration || state.transition) return;
        // A malformed duration must never prevent a current privacy refusal.
        state.fields = fields136({ ...state.fields, duration_seconds: duration(), consent: 'refused' }, { allowEmpty: true });
        historySuppressed = true; contextSeq++; if (context) context = { ...context, history: [] }; paintContext(); restoreFields(); store.write(state); controls(); return;
      }
      mutate(f => {
      const yn = el.closest('.yesno').dataset.yn;
      if (yn === 'consent') { f.consent = el.dataset.v === 'yes' ? 'given' : 'refused'; if (f.consent !== 'given') { Object.assign(f, fields136(f, { allowEmpty: true })); historySuppressed = true; contextSeq++; if (context) context = { ...context, history: [] }; paintContext(); } else suggest(f); }
      else f[{ waLink: 'whatsapp_link_sent', whatsapp: 'whatsapp_joined', social: 'social_followed' }[yn]] = el.dataset.v === 'yes';
      });
    });
    q('.logform').addEventListener('input', event => { if (!here() || busy || state.attempted || state.registration || state.transition) return; if (event.target.id === 'f-followup') state.manual_followup = true; persist(); controls(); });
    q('[data-family-duration136]').oninput = e => { if (!here() || busy || state.attempted || state.registration || state.transition) return; e.target.setCustomValidity(''); const v = e.target.value; const seconds = v === '' ? null : Number(v); durationInvalid = !e.target.validity.valid || (seconds !== null && (!Number.isInteger(seconds) || seconds < 0 || seconds > 36000)); if (durationInvalid) { e.target.setCustomValidity('Duration must be 0 to 36000 whole seconds.'); message('Duration must be 0 to 36000 whole seconds.', true); controls(); return; } if (seconds !== null) { pauseClock(); state.clock.elapsed_seconds = seconds; } state.manual_seconds = seconds; persist(); controls(); tick(); };
    q('[data-family-start-timer136]').onclick = startClock;
    q('[data-family-pause-timer136]').onclick = () => { if (!here() || busy || state.attempted || state.registration || state.transition) return; pauseClock(); persist(); tick(); controls(); };
    q('#f-submit').onclick = save;
    q('#f-skip').onclick = skip;
    q('[data-family-register136]').onclick = register;
    q('#f-details-btn')?.addEventListener('click', clinicalDialog);
    q('[data-family-close136]').onclick = () => { if (!here() || busy || durationInvalid) return; pauseClock(); state.resume_on_load = false; persist(); onClose(); };
    q('[data-family-dial136]').onclick = e => { if (!here() || busy || state.transition || state.attempted || state.registration || durationInvalid) e.preventDefault(); else startClock(); };
  }
  function tick() { if (!here()) return; const el = q('[data-family-timer136]'); if (el) { const s = duration(); el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; } }
  function paintContext() {
    const host = q('[data-family-context136]'); if (!host) return;
    if (!context) { host.innerHTML = '<section class="card" style="padding:16px"><h3>HopeBot view</h3><p role="status">Loading the authorized saved summary and help requests...</p></section>'; return; }
    // Reuse summary rendering, replacing patient-only explanatory copy. Never
    // mount patient document actions against a lead identity.
    host.innerHTML = hopebotActivityHTML({ ...context, contacts_count: null }, { summaryOnly: true });
    host.querySelector('.due-meta')?.replaceChildren(document.createTextNode('Saved context for this contact. Confirm the summary and requested help with the family.'));
    host.querySelector('[data-hb-summary-empty]')?.replaceChildren(document.createTextNode('No synced conversation summary is available for this contact yet. This does not confirm that they have never used HopeBot.'));
    const allowed = { doctor_search: 'Help finding a doctor', stay_search: 'Help with a place to stay', money_help: 'Financial help', diet_plan: 'Diet support', trials_request: 'Clinical trial information', roadmap_request: 'Treatment roadmap', reports_review: 'Report review', community_join: 'Community support', user_requested: 'Asked to speak to a person', grief: 'Bereavement support', safety_self_harm: 'Safety concern', safety_emergency: 'Urgent medical concern', other: 'Help requested' };
    const needs = (context.needs || []).filter(x => x && Object.hasOwn(allowed, x.reason)).slice(0, 50);
    const section = document.createElement('section'); section.className = 'card'; section.style.padding = '16px'; section.innerHTML = `<h3>What they are looking for</h3>${needs.length ? `<ul>${needs.map(x => `<li>${sanitize(allowed[x.reason])} - ${sanitize(['open', 'closed', 'calling'].includes(x.state) ? x.state : 'status not recorded')}</li>`).join('')}</ul>` : '<p>No saved care request is available. Ask the family what would help.</p>'}${context.needs_truncated || (context.needs || []).length > 50 ? '<p class="due-meta">Only a bounded set of care requests is shown.</p>' : ''}`; host.append(section);
    host.querySelector('[data-hb-activity-refresh]').onclick = loadContext;
    const history = q('[data-family-history136]'); const rows = historySuppressed ? [] : (context.history || []).slice(0, 25);
    history.innerHTML = `<section class="card" style="padding:16px"><h3>Previous care calls</h3>${rows.length ? rows.map(x => `<p>${sanitize(instant136(x.call_date))} - ${sanitize(DIAL_STATUSES.find(s => s.key === x.dial_status)?.label || 'Outcome not recorded')}${x.fields?.consent === 'given' && typeof x.fields.notes === 'string' ? `<br><span style="white-space:pre-wrap">${sanitize(x.fields.notes.slice(0, 5000))}</span>` : ''}</p>`).join('') : `<p>${historySuppressed ? 'Private care history is hidden after the current refusal.' : 'No authorized previous care calls are available.'}</p>`}</section>`;
  }
  async function loadContext() {
    const seq = ++contextSeq;
    try {
      const value = await rpc('family_call_context136', { p_work: row.id });
      if (!here() || seq !== contextSeq) return;
      if (!value || value.work_id !== row.id || value.lead_id !== row.lead_id || value.patient_id != null || !Array.isArray(value.summaries) || !Array.isArray(value.needs) || !Array.isArray(value.history)) throw new Error('Unconfirmed context');
      context = historySuppressed ? { ...value, history: [] } : value; const nextNum = Math.min(3, Math.max(1, value.history.length + 1));
      if (!saved && callNum !== nextNum && !busy && !identityDialog && !state.attempted && !state.registration && !state.transition) { state.fields = readFields(true); callNum = nextNum; paint(); }
      else paintContext();
    } catch {
      if (!here() || seq !== contextSeq) return;
      const host = q('[data-family-context136]'); host.innerHTML = '<section class="card" style="padding:16px"><h3>HopeBot view</h3><p role="alert">Could not verify this contact\'s saved context. Ask the family directly and retry.</p><button class="btn btn-secondary" type="button" data-family-context-retry136>Retry context</button></section>'; host.querySelector('button').onclick = loadContext;
    }
  }
  function clinicalDialog() {
    if (!here() || busy || state.attempted || state.registration || state.transition) return;
    if (state.fields.consent !== 'given') { message('Ask for care consent before collecting clinical details.', true); return; }
    state.fields = readFields(true);
    const body = document.createElement('form');
    body.innerHTML = `<p>Only details the family explicitly shared. These remain a self-report until reviewed in the confirmed patient record.</p><label class="field">GI subtype<select class="select" name="gi_subtype"><option value="">Not shared</option>${GI_SUBTYPES.map(x => `<option value="${x.key}">${sanitize(x.label)}</option>`).join('')}</select></label><label class="field">Stage<select class="select" name="cancer_stage"><option value="">Not shared</option>${stages.map(x => `<option value="${x}">${sanitize(x.replaceAll('_', ' '))}</option>`).join('')}</select></label>${clinicalText.map(k => `<label class="field">${sanitize(k.replaceAll('_', ' '))}<input class="input" name="${k}" maxlength="200"></label>`).join('')}<p role="status" data-clinical-message136></p><button type="submit" class="btn btn-primary">Keep shared details</button><button type="button" class="btn btn-secondary" data-clinical-cancel136>Cancel</button>`;
    for (const [k, v] of Object.entries(state.fields.clinical)) body.elements.namedItem(k).value = v;
    modal = showModal({ title: 'Clinical details they shared', content: body }); const own = modal;
    body.querySelector('[data-clinical-cancel136]').onclick = () => own.closeOwnedModal();
    body.onsubmit = event => { event.preventDefault(); if (!here() || modal !== own || !own.isCurrentModal() || busy || state.fields.consent !== 'given') return; try { const clinical = {}; for (const k of ['gi_subtype', 'cancer_stage', ...clinicalText]) { const value = body.elements.namedItem(k).value.trim(); if (value) clinical[k] = value; } state.fields = fields136({ ...readFields(true), clinical }, { allowEmpty: true }); persist(); own.closeOwnedModal(); message('Shared clinical details kept in this consented draft.'); } catch (e) { body.querySelector('[data-clinical-message136]').textContent = e.message; } };
  }
  async function save() {
    if (!here() || busy || saved || identityDialog || state.registration || state.transition) return;
    try { if (!state.attempted) { readFields(); pauseClock(); state.attempted = { nonce: crypto.randomUUID(), fields: readFields() }; } } catch (e) { message(e.message, true); return; }
    // The complete attempted payload and nonce become immutable until receipt.
    state.fields = copy(state.attempted.fields);
    if (!store.write(state)) { controls(); message('Browser storage is unavailable. Keep the call open and retry; no request was sent without its recoverable identifier.', true); return; }
    busy = true; controls(); message('Saving the actual call...');
    try {
      const attempted = copy(state.attempted);
      const receipt = await rpc('family_call_save136', { p_work: row.id, p_nonce: attempted.nonce, p_fields: attempted.fields });
      if (!here()) return;
      if (!receipt136(receipt, row.id, row.lead_id, attempted.fields)) throw new Error('The complete saved call could not be confirmed.');
      saved = true; busy = false; contextSeq++; clearInterval(timer); store.remove(row.id); state.attempted = null;
      q('.col-right').innerHTML = `<section class="card" style="padding:16px"><h3>Call saved</h3><p>The actual call and collected answers were confirmed.${receipt.fields.followup_date ? ` Next care call: ${sanitize(receipt.fields.followup_date)}.` : ''}</p><div data-family-feedback136></div><button type="button" class="btn btn-primary" data-family-next136>Return to today's calls</button></section>`;
      if (attempted.fields.consent === 'given') feedback = mountHopebotFeedback(q('[data-family-feedback136]'), receipt.call_id, { anchorType: 'lead_call', isCurrent: () => here() && saved });
      else q('[data-family-feedback136]').textContent = 'Care consent was not given, so no private feedback is collected for this attempt.';
      q('[data-family-next136]').onclick = () => { if (here()) onClose(receipt); };
      q('[data-family-close136]').textContent = 'Return to today\'s calls'; q('[data-family-close136]').disabled = false; q('[data-family-close136]').onclick = () => { if (here()) onClose(receipt); };
    } catch (error) {
      if (!here()) return; busy = false; controls(); message('Save is unconfirmed. Your complete answers and save identifier are frozen. Retry safely; an assignment or identity change may require manager review.', true);
      if (String(error?.code) === '22023') { state.attempted = null; store.write(state); controls(); message(error.message || 'The server rejected these answers without saving. Correct them and submit again.', true); }
    }
  }
  async function skip() {
    if (!here() || busy || saved || identityDialog || state.attempted || state.registration || state.transition || durationInvalid) return;
    pauseClock(); state.resume_on_load = false; persist(); busy = true; controls();
    try { await rpc('family_call_skip136', { p_work: row.id }); if (!here()) return; busy = false; await onSkip(row.id); }
    catch { if (here()) { state.resume_on_load = true; persist(); busy = false; controls(); message('Skip could not be confirmed. The draft is kept and no call is marked complete.', true); } }
  }
  async function deliverTransition() {
    if (!here() || busy || !state.transition) return false;
    busy = true; controls();
    try { await onRegistered(copy(state.transition), copy(state.registration?.snapshot || snapshot())); store.remove(row.id); return true; }
    catch { if (here()) { busy = false; controls(); message('The patient record was confirmed, but its workspace could not open. Keep this draft and use Resume confirmed record to retry the same transition.', true); } return false; }
  }
  function register() {
    if (!here() || busy || saved || identityDialog || state.attempted || durationInvalid) return;
    if (state.transition) { deliverTransition(); return; }
    if (state.fields.consent !== 'given') { message('Ask for explicit care consent before confirming a patient record.', true); return; }
    if (state.registration?.identity.patient_id) { message('This existing family needs manager review in its patient record. Your call draft is kept.', true); return; }
    state.fields = readFields(true); persist();
    const body = document.createElement('form');
    body.innerHTML = `<p>Confirm with the family who the patient is. The contact name is not automatically the patient name.</p><label class="field">Confirmed patient name<input class="input" name="patient_name" required minlength="2" maxlength="200"></label><label class="field">Who is this contact?<select class="select" name="contact_role"><option value="">Choose explicitly</option><option value="patient">Patient</option><option value="caregiver">Caregiver</option></select></label><label class="field" data-caregiver-identity136>Caregiver name (required for a caregiver contact)<input class="input" name="caregiver_name" maxlength="200"></label><p class="due-meta">If this family already has a patient record, ask a manager to review that record. Your collected call answers stay in this draft.</p><label style="display:flex;gap:8px"><input type="checkbox" name="confirmed_identity" required>I confirmed this patient's identity and this contact's relationship with the family. They explicitly agreed to care notes and contact.</label><p data-register-message136 role="status"></p><button type="submit" class="btn btn-primary">Confirm and open patient record</button><button type="button" class="btn btn-secondary" data-register-cancel136>Cancel</button>`;
    if (state.registration) { for (const k of ['patient_name', 'contact_role', 'caregiver_name']) body.elements.namedItem(k).value = state.registration.identity[k] || ''; body.elements.namedItem('confirmed_identity').checked = true; [...body.elements].forEach(el => { if (!el.matches('button')) el.disabled = true; }); body.querySelector('[type=submit]').textContent = 'Retry the same confirmation'; }
    const identityRole = () => { if (state.registration) return; const caregiver = body.elements.namedItem('contact_role').value === 'caregiver'; body.querySelector('[data-caregiver-identity136]').hidden = !caregiver; body.elements.namedItem('caregiver_name').disabled = !caregiver; body.elements.namedItem('caregiver_name').required = caregiver; if (!caregiver) body.elements.namedItem('caregiver_name').value = ''; };
    body.elements.namedItem('contact_role').addEventListener('change', identityRole); identityRole();
    identityDialog = true; controls();
    modal = showModal({ title: 'Confirm patient record', content: body, dismissible: false }); const own = modal;
    body.querySelector('[data-register-cancel136]').onclick = () => { if (!busy) { identityDialog = false; own.closeOwnedModal(); controls(); } };
    body.onsubmit = async event => {
      event.preventDefault(); if (!here() || busy || modal !== own || !own.isCurrentModal() || state.fields.consent !== 'given') return;
      const msg = body.querySelector('[data-register-message136]');
      try {
        if (!state.registration) {
          const identity = { patient_name: body.elements.namedItem('patient_name').value.trim(), contact_role: body.elements.namedItem('contact_role').value, caregiver_name: body.elements.namedItem('caregiver_name').value.trim(), confirmed_identity: body.elements.namedItem('confirmed_identity').checked, consent: 'given' };
          if (identity.contact_role === 'patient') identity.caregiver_name = '';
          if (!validIdentity136(identity)) throw new Error('Confirm the patient name, contact role, caregiver name if applicable, and identity checkbox.');
          const frozenSnapshot = snapshot(); state.fields = copy(frozenSnapshot.fields);
          state.registration = { nonce: crypto.randomUUID(), identity, snapshot: frozenSnapshot };
        }
        if (!store.write(state)) throw new Error('Browser storage is unavailable. Patient confirmation needs a recoverable draft; keep this call open and retry.');
        busy = true; controls(); [...body.elements].forEach(el => { el.disabled = true; }); msg.textContent = 'Confirming the exact patient record...';
        const result = await rpc('family_call_register136', { p_work: row.id, p_nonce: state.registration.nonce, p_identity: copy(state.registration.identity) });
        if (!here() || modal !== own || !own.isCurrentModal()) return;
        if (!transition136(result, row.id, row.lead_id)) throw new Error('Patient transition could not be confirmed.');
        state.transition = copy(result); contextSeq++; store.write(state); busy = false; identityDialog = false; own.closeOwnedModal(); await deliverTransition();
      } catch (e) {
        if (!here()) return; busy = false;
        if (String(e?.code) === '22023') { state.registration = null; store.write(state); }
        controls(); msg.textContent = state.registration ? 'Confirmation is unconfirmed or the family record needs review. Ask a manager to open its existing patient record if one exists. Your draft is kept; retry only the same confirmation.' : e.message || 'The confirmation was rejected without creating a record. Correct the identity and try again.';
        body.querySelector('[type=submit]').disabled = false; body.querySelector('[type=submit]').textContent = state.registration ? 'Retry the same confirmation' : 'Confirm and open patient record'; body.querySelector('[data-register-cancel136]').disabled = false;
        if (!state.registration) { [...body.elements].forEach(el => { el.disabled = false; }); identityRole(); }
      }
    };
  }
  function dispose({ erase = false } = {}) { if (disposed) return; disposed = true; pauseClock(); if (!saved && !erase) { state.fields.duration_seconds = duration(); store.write(state); } contextSeq++; clearInterval(timer); feedback?.dispose(); if (modal) { modal.querySelector('.modal-body')?.replaceChildren(); modal.closeOwnedModal(); } if (erase) store.clearOwner(); element.replaceChildren(); }
  paint(); timer = setInterval(tick, 1000); loadContext();
  if (state.transition) queueMicrotask(deliverTransition);
  return { dispose, snapshot, hasSaved: () => saved, resumeTransition: deliverTransition };
}
