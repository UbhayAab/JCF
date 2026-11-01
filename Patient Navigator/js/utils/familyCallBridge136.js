import { DIAL_STATUSES, RECEPTIVENESS, CONDITIONS, REQUIREMENTS, GI_SUBTYPES } from './catalog.js';

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const key = (value, vocabulary, fallback = '') => vocabulary.includes(value) ? value : fallback;
const text = (value, max) => typeof value === 'string' && value.length <= max ? value : '';
const bool = value => typeof value === 'boolean' ? value : null;
const list = (value, vocabulary) => Array.isArray(value) ? [...new Set(value.filter(x => vocabulary.includes(x)))].slice(0, vocabulary.length) : [];
const date = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return '';
  const parsed = new Date(value + 'T00:00:00Z'); return Number.isFinite(+parsed) && parsed.toISOString().slice(0, 10) === value ? value : '';
};

export function cleanPendingClinical136(value) {
  if (!plain(value)) return null;
  const result = {};
  for (const name of ['treating_hospital', 'current_treatment', 'payment_method', 'primary_language']) {
    if (Object.hasOwn(value, name) && typeof value[name] === 'string' && value[name].trim() && value[name].length <= 200) result[name] = value[name];
  }
  if (Object.hasOwn(value, 'gi_subtype') && GI_SUBTYPES.some(x => x.key === value.gi_subtype)) result.gi_subtype = value.gi_subtype;
  if (Object.hasOwn(value, 'cancer_stage') && ['unknown', 'stage_i', 'stage_ii', 'stage_iii', 'stage_iv', 'not_applicable'].includes(value.cancer_stage)) result.cancer_stage = value.cancer_stage;
  return Object.keys(result).length ? result : null;
}

export function registrationDraft136(transition, snapshot) {
  if (!plain(transition) || transition.anchor_type !== 'patient_call' || !uuid(transition.queue_id) || !uuid(transition.patient_id) || !uuid(transition.work_id) || !uuid(transition.lead_id)) throw new Error('Invalid registered call identity.');
  if (!plain(snapshot) || snapshot.work_id !== transition.work_id || snapshot.lead_id !== transition.lead_id || !plain(snapshot.fields) || snapshot.fields.consent !== 'given') throw new Error('The draft does not belong to this registered call.');
  const f = snapshot.fields;
  const seconds = snapshot.duration_seconds ?? f.duration_seconds;
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 36000) throw new Error('Invalid call duration.');
  const running = snapshot.timer_running === true;
  if (running && (!Number.isFinite(snapshot.started_at) || snapshot.started_at > Date.now() || Date.now() - snapshot.started_at > 20 * 60 * 60 * 1000)) throw new Error('Invalid running call clock.');
  return {
    queueId: transition.queue_id, patientId: transition.patient_id, durationSeconds: seconds,
    timerRunning: running, timerStartEpoch: running ? snapshot.started_at : null,
    form: {
      dialStatus: key(f.dial_status, DIAL_STATUSES.map(x => x.key)),
      receptiveness: key(f.receptiveness, RECEPTIVENESS.map(x => x.key)),
      condition: key(f.condition, CONDITIONS.map(x => x.key)),
      requirements: list(f.requirements, REQUIREMENTS.map(x => x.key)),
      services: list(f.services_offered, ['therapy', 'nutrition', 'caregiver', 'clinical_trial', 'financial_aid']),
      customReq: text(f.custom_requirements, 1000), notes: text(f.notes, 5000), strategy: text(f.strategy, 2000),
      fbPatient: text(f.patient_feedback, 2000), fbCaregiver: text(f.caregiver_feedback, 2000),
      waLink: bool(f.whatsapp_link_sent), whatsapp: bool(f.whatsapp_joined), social: bool(f.social_followed),
      consent: true, consentSaved: true, followupDate: date(f.followup_date), dateManual: !!date(f.followup_date),
      pendingClinical136: cleanPendingClinical136(snapshot.clinical ?? f.clinical),
    },
  };
}

// Separate from the current-call draft: moving to another call must not erase
// details awaiting explicit review. Never authorize a patient from this cache.
const prefix = 'jcf_pending_clinical136:';
const ttl = 20 * 60 * 60 * 1000;
const storageKey = (owner, patient) => prefix + encodeURIComponent(owner) + ':' + patient;
export function storeClinicalDraft136(storage, owner, patient, clinical, now = Date.now()) {
  const fields = cleanPendingClinical136(clinical);
  if (typeof owner !== 'string' || !owner || !uuid(patient) || !fields) throw new Error('Invalid clinical draft identity.');
  const key = storageKey(owner, patient);
  let at = now;
  try {
    const prior = JSON.parse(storage.getItem(key) || 'null');
    if (plain(prior) && prior.version === 1 && prior.owner === owner && prior.patient === patient && Number.isFinite(prior.at) && prior.at <= now && JSON.stringify(prior.fields) === JSON.stringify(fields)) at = prior.at;
  } catch { /* initial storage write below fails explicitly if unavailable */ }
  const value = JSON.stringify({version:1, owner, patient, at, fields});
  storage.setItem(key, value);
  if (storage.getItem(key) !== value) throw new Error('Clinical draft could not be kept. Review or discard before continuing.');
}
export function readClinicalDraft136(storage, owner, patient, now = Date.now()) {
  if (!owner || !uuid(patient)) return null;
  const key = storageKey(owner, patient);
  try {
    const value = JSON.parse(storage.getItem(key) || 'null');
    if (plain(value) && value.version === 1 && value.owner === owner && value.patient === patient && Number.isFinite(value.at) && value.at <= now && now - value.at < ttl) return cleanPendingClinical136(value.fields);
    storage.removeItem(key);
  } catch { try { storage.removeItem(key); } catch {} }
  return null;
}
export function removeClinicalDraft136(storage, owner, patient) {
  const key = storageKey(owner, patient); storage.removeItem(key);
  if (storage.getItem(key) !== null) throw new Error('Draft removal could not be confirmed.');
}
export function clearClinicalDrafts136(storage, keepOwner = null) {
  const keepPrefix = keepOwner ? prefix + encodeURIComponent(keepOwner) + ':' : null;
  try {
    for (let n = storage.length - 1; n >= 0; n--) {
      const key = storage.key(n);
      if (key?.startsWith(prefix) && (!keepPrefix || !key.startsWith(keepPrefix))) storage.removeItem(key);
    }
  } catch { /* unavailable storage cannot reveal a prior draft */ }
}
