import { sanitize } from './validators.js';
import { DIAL_STATUSES, RECEPTIVENESS, CONDITIONS, REQUIREMENTS, GI_SUBTYPES } from './catalog.js';

export const historyUUID136 = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const time = value => typeof value === 'string' && value.length <= 64 && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const text = (value, max) => typeof value === 'string' && [...value].length <= max ? value : '';
const code = (value, values) => values.some(x => x.key === value) ? value : null;
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value ? value : null;
const unique = (items, allowed) => Array.isArray(items) && items.length <= allowed.length && items.every(x => allowed.includes(x)) && new Set(items).size === items.length ? [...items] : [];
const defaults = Object.freeze({ patient: 'unconfirmed', contact: 'unconfirmed', bounded: false });

function list136(rows, state) {
  Object.defineProperty(rows, 'history136', { value: Object.freeze({ ...state }), enumerable: false, writable: false });
  return rows;
}
export function historyState136(rows) { return Array.isArray(rows) && object(rows.history136) ? rows.history136 : defaults; }
export function historyIncomplete136(rows) { const s = historyState136(rows); return s.patient !== 'confirmed' || s.contact !== 'confirmed' || s.bounded; }
export function restrictContactHistory136(rows) { return list136((Array.isArray(rows) ? rows : []).filter(row => row.anchor_type === 'patient_call'), { ...historyState136(rows), contact: 'restricted' }); }
export function historyNotice136(rows) {
  const s = historyState136(rows);
  const messages = [];
  if (s.patient !== 'confirmed') messages.push('Some care-call history could not be confirmed.');
  if (s.contact !== 'confirmed') messages.push('Earlier calls before patient registration could not be confirmed.');
  if (s.bounded) messages.push('This is a limited view of saved care calls; earlier conversations may be missing.');
  return messages.length ? `<p class="due-meta" role="status" data-history-warning136>${sanitize(messages.join(' '))} Call guidance uses the history available here.</p>` : '';
}
export function historyCallNumber136(patient, rows) {
  const stage = Number.isInteger(patient?.call_stage) && patient.call_stage >= 0 ? patient.call_stage : 0;
  return Math.min(Math.max(stage, Array.isArray(rows) ? rows.length : 0) + 1, 99);
}

function patientRows136(rows, patientId) {
  if (!Array.isArray(rows)) throw new Error('Patient history is unconfirmed.');
  const seen = new Set();
  return rows.map(row => {
    if (!object(row) || (row.patient_id != null && row.patient_id !== patientId) || (row.anchor_type != null && row.anchor_type !== 'patient_call')
      || (row.id != null && (!historyUUID136(row.id) || seen.has(row.id)))) throw new Error('Patient history anchor changed.');
    if (row.id) seen.add(row.id);
    // Preserve the ordinary patient row and real recording/correction ID.
    return { ...row, anchor_type: 'patient_call' };
  });
}
function contactRows136(rows, patientId) {
  if (!Array.isArray(rows) || rows.length > 100) throw new Error('Earlier care history is unconfirmed.');
  const seen = new Set();
  return rows.map(row => {
    const f = row?.fields;
    if (!object(row) || row.anchor_type !== 'lead_call' || !historyUUID136(row.call_id) || seen.has(row.call_id) || !historyUUID136(row.lead_id)
      || (row.patient_id != null && row.patient_id !== patientId) || !object(f) || f.consent !== 'given'
      || !DIAL_STATUSES.some(x => x.key === row.dial_status) || time(row.call_date) === null
      || !Number.isInteger(f.duration_seconds) || f.duration_seconds < 0 || f.duration_seconds > 36000) throw new Error('Earlier care history anchor is unconfirmed.');
    for (const [key, max] of [['notes', 5000], ['custom_requirements', 1000], ['patient_feedback', 2000], ['caregiver_feedback', 2000], ['strategy', 2000]]) {
      if (typeof f[key] !== 'string' || [...f[key]].length > max) throw new Error('Earlier care history fields are unconfirmed.');
    }
    for (const [key, values] of [['requirements', REQUIREMENTS.map(x => x.key)], ['services_offered', ['therapy', 'nutrition', 'caregiver', 'clinical_trial', 'financial_aid']]]) {
      if (!Array.isArray(f[key]) || unique(f[key], values).length !== f[key].length) throw new Error('Earlier care history choices are unconfirmed.');
    }
    if (f.receptiveness != null && !code(f.receptiveness, RECEPTIVENESS) || f.condition != null && !code(f.condition, CONDITIONS)
      || (row.dial_status === 'connected' && !code(f.receptiveness, RECEPTIVENESS)) || (f.followup_date != null && !date(f.followup_date))) throw new Error('Earlier care history values are unconfirmed.');
    for (const key of ['whatsapp_link_sent', 'whatsapp_joined', 'social_followed']) if (f[key] != null && typeof f[key] !== 'boolean') throw new Error('Earlier care history answers are unconfirmed.');
    const clinical = {};
    if (!object(f.clinical)) throw new Error('Earlier clinical self-report is unconfirmed.');
    for (const [key, value] of Object.entries(f.clinical)) {
      if (!['gi_subtype', 'cancer_stage', 'treating_hospital', 'current_treatment', 'payment_method', 'primary_language'].includes(key)
        || (value != null && (typeof value !== 'string' || [...value].length > 200))) throw new Error('Earlier clinical self-report is unconfirmed.');
      if (value == null || value === '') continue;
      if (key === 'gi_subtype' && !GI_SUBTYPES.some(x => x.key === value) || key === 'cancer_stage' && !['unknown', 'stage_i', 'stage_ii', 'stage_iii', 'stage_iv', 'not_applicable'].includes(value)) throw new Error('Earlier clinical choice is unconfirmed.');
      clinical[key] = value;
    }
    seen.add(row.call_id);
    // Do not spread row or f: an unexpected id must never become a call_log ID.
    return { anchor_type: 'lead_call', call_id: row.call_id, lead_id: row.lead_id, patient_id: row.patient_id ?? null,
      call_date: row.call_date, dial_status: row.dial_status, is_mine: row.is_mine === true, caller_name: 'Care team',
      caller_notes: text(f.notes, 5000), receptiveness_bucket: code(f.receptiveness, RECEPTIVENESS), patient_condition: code(f.condition, CONDITIONS),
      structured: { requirements: unique(f.requirements, REQUIREMENTS.map(x => x.key)), services_offered: unique(f.services_offered, ['therapy', 'nutrition', 'caregiver', 'clinical_trial', 'financial_aid']) },
      custom_requirements: text(f.custom_requirements, 1000), feedback_patient: text(f.patient_feedback, 2000), feedback_caregiver: text(f.caregiver_feedback, 2000),
      followup_strategy_notes: text(f.strategy, 2000), followup_date: date(f.followup_date), duration_seconds: f.duration_seconds, reported_clinical: clinical,
      whatsapp_link_sent: typeof f.whatsapp_link_sent === 'boolean' ? f.whatsapp_link_sent : null,
      whatsapp_joined: typeof f.whatsapp_joined === 'boolean' ? f.whatsapp_joined : null,
      social_followed: typeof f.social_followed === 'boolean' ? f.social_followed : null };
  });
}
function sorted136(rows) { return rows.sort((a, b) => (time(b.call_date) ?? -Infinity) - (time(a.call_date) ?? -Infinity) || String(a.anchor_type).localeCompare(String(b.anchor_type)) || String(a.id || a.call_id || '').localeCompare(String(b.id || b.call_id || ''))); }
export function mergeFamilyHistory136(data, patientId) {
  if (!historyUUID136(patientId) || !object(data) || data.patient_id !== patientId) throw new Error('The history belongs to a different patient.');
  const patient = patientRows136(data.patient_calls, patientId), contact = contactRows136(data.contact_calls, patientId);
  // The API has no total/truncated field. Reaching its LIMIT100 is visibly
  // bounded rather than evidence that these are every past conversation.
  return list136(sorted136([...patient, ...contact]), { patient: 'confirmed', contact: 'confirmed', bounded: patient.length >= 100 || contact.length >= 100 });
}

export async function loadFamilyHistory136(sb, patientId, { isCurrent = () => true, actorId = null } = {}) {
  const current = () => { if (!isCurrent()) { const e = new Error('Calling history request is stale.'); e.code = 'HISTORY_STALE136'; throw e; } };
  if (!historyUUID136(patientId)) throw new Error('Invalid patient identity.');
  current();
  try {
    const { data, error } = await sb.rpc('family_call_patient_history136', { p_patient: patientId }); current();
    if (error) throw error;
    return mergeFamilyHistory136(data, patientId);
  } catch (e) { if (e?.code === 'HISTORY_STALE136') throw e; current(); }
  try {
    const { data, error } = await sb.rpc('get_patient_call_history', { p_patient_id: patientId }); current();
    if (error) throw error;
    return list136(sorted136(patientRows136(data, patientId)), { patient: 'confirmed', contact: 'unconfirmed', bounded: data.length >= 100 });
  } catch (e) { if (e?.code === 'HISTORY_STALE136') throw e; current(); }
  try {
    const { data, error } = await sb.from('call_logs').select('*').eq('patient_id', patientId).order('call_date', { ascending: false }).limit(100); current();
    if (error) throw error;
    const rows = patientRows136(data, patientId).map(row => ({ ...row, caller_name: row.contacted_by_name, is_mine: row.caller_id === actorId }));
    return list136(sorted136(rows), { patient: 'limited', contact: 'unconfirmed', bounded: true });
  } catch (e) { if (e?.code === 'HISTORY_STALE136') throw e; current(); return list136([], { patient: 'unconfirmed', contact: 'unconfirmed', bounded: false }); }
}

export function renderContactHistory136(h) {
  if (h?.anchor_type !== 'lead_call') return '';
  const ds = DIAL_STATUSES.find(x => x.key === h.dial_status), receptiveness = RECEPTIVENESS.find(x => x.key === h.receptiveness_bucket), condition = CONDITIONS.find(x => x.key === h.patient_condition);
  const services = { therapy: 'Therapy & counselling', nutrition: 'Nutrition guidance', caregiver: 'Caregiver support', clinical_trial: 'Clinical-trial info', financial_aid: 'Financial-aid guidance' };
  const when = time(h.call_date) === null ? 'Date not recorded' : new Date(h.call_date).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) + ' IST';
  const sec = Number.isInteger(h.duration_seconds) && h.duration_seconds >= 0 && h.duration_seconds <= 36000 ? h.duration_seconds : 0;
  const yn = (label, value) => typeof value === 'boolean' ? `<span>${sanitize(label)}: ${value ? 'Yes' : 'No'}</span>` : '';
  const clinicalLabels = { gi_subtype: 'GI subtype', cancer_stage: 'Cancer stage', treating_hospital: 'Treating hospital', current_treatment: 'Current treatment', payment_method: 'How the family pays', primary_language: 'Preferred language' };
  const stageLabels = { unknown: 'Not known', stage_i: 'Stage I', stage_ii: 'Stage II', stage_iii: 'Stage III', stage_iv: 'Stage IV', not_applicable: 'Not applicable' };
  return `<div class="hist-row" data-contact-history136 style="flex-direction:column;gap:5px;align-items:stretch">
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><span class="badge badge-info">Before patient registration</span><span class="badge badge-neutral">${sanitize(ds?.label || 'Outcome not recorded')}</span>${receptiveness ? `<span class="badge badge-primary">${sanitize(receptiveness.label)}</span>` : ''}${condition ? `<span class="badge badge-neutral">${sanitize(condition.label)}</span>` : ''}<span class="hist-meta">${h.is_mine ? 'You' : 'Care team'} - ${sanitize(when)} - ${Math.floor(sec / 60)}m ${sec % 60}s</span></div>
    ${h.caller_notes ? `<div class="hist-note" style="white-space:pre-wrap">${sanitize(h.caller_notes)}</div>` : ''}
    ${h.feedback_patient ? `<div class="hist-note">Patient: ${sanitize(h.feedback_patient)}</div>` : ''}
    ${h.feedback_caregiver ? `<div class="hist-note">Caregiver: ${sanitize(h.feedback_caregiver)}</div>` : ''}
    ${h.followup_strategy_notes ? `<div class="hist-note">For the next caregiver mentor: ${sanitize(h.followup_strategy_notes)}</div>` : ''}
    ${(h.structured?.requirements || []).length ? `<div>${h.structured.requirements.map(x => `<span class="badge badge-gold">${sanitize(x)}</span>`).join(' ')}</div>` : ''}
    ${h.custom_requirements ? `<div class="hist-note">Other help requested: ${sanitize(h.custom_requirements)}</div>` : ''}
    ${(h.structured?.services_offered || []).length ? `<div class="hist-note">Services offered: ${h.structured.services_offered.map(x => sanitize(services[x] || x)).join(', ')}</div>` : ''}
    ${h.followup_date ? `<div class="hist-note">Next care call: ${sanitize(h.followup_date)}</div>` : ''}
    ${Object.keys(h.reported_clinical || {}).length ? `<details><summary>Clinical details shared by the family</summary>${Object.entries(h.reported_clinical).map(([key, value]) => `<p class="hist-note">${sanitize(clinicalLabels[key])}: ${sanitize(key === 'gi_subtype' ? GI_SUBTYPES.find(x => x.key === value)?.label : key === 'cancer_stage' ? stageLabels[value] : value)}</p>`).join('')}</details>` : ''}
    <div class="due-meta" style="display:flex;gap:10px;flex-wrap:wrap">${yn('WhatsApp link sent', h.whatsapp_link_sent)}${yn('Joined WhatsApp', h.whatsapp_joined)}${yn('Following channels', h.social_followed)}</div>
  </div>`;
}
