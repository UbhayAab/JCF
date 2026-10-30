// Existing patient intake navigation. Reads use the signed-in SDK and RLS;
// this module never creates patients, records consent or writes clinical data.
import { getSupabase } from '../supabase.js';
import { getCurrentUser } from '../auth.js';
import { sanitize } from '../utils/validators.js';

const FIELDS = 'id,full_name,patient_code,consent_given,patient_status,primary_language';
const LIMIT = 20;
const noteStyle = 'white-space:normal;overflow:visible;text-overflow:clip';
export const validPatientId = id => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
export function intakeSearchTerm(value) {
  return String(value || '').replace(/[,%()*"'\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}
function phoneTerm(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return /^\d{10}$/.test(digits) ? digits : null;
}
function current(allowed) { if (!allowed()) throw Error('This view or signed-in account changed. Open Update existing again.'); }
async function queryRows(query, allowed) {
  current(allowed);
  const { data, error } = await query;
  current(allowed);
  if (error) throw Error('Could not load the records available to your account. Check your connection and try again.');
  return Array.isArray(data) ? data : [];
}
export async function findExistingPatients(sb, value, { allowed = () => true } = {}) {
  current(allowed);
  const term = intakeSearchTerm(value);
  if (term.length < 2) return { rows: [], more: false };
  const phone = phoneTerm(value); let rows;
  if (phone) {
    // Secondary/caregiver numbers belong to the same patient. Even if an old
    // phone policy returns an ID, the subsequent patient SELECT obeys RLS.
    const phones = await queryRows(sb.from('patient_phones').select('patient_id').eq('phone', phone).limit(LIMIT + 1), allowed);
    const ids = [...new Set(phones.map(p => p.patient_id).filter(validPatientId))];
    const mapped = ids.length ? await queryRows(sb.from('patients').select(FIELDS).in('id', ids).eq('is_active', true).limit(LIMIT + 1), allowed) : [];
    const legacy = await queryRows(sb.from('patients').select(FIELDS).or(`phone_full.eq.${phone},caregiver_phone_full.eq.${phone}`).eq('is_active', true).limit(LIMIT + 1), allowed);
    rows = mapped.concat(legacy);
  } else {
    rows = await queryRows(sb.from('patients').select(FIELDS).or(`full_name.ilike.*${term}*,patient_code.ilike.*${term}*`).eq('is_active', true).order('updated_at', { ascending: false }).limit(LIMIT + 1), allowed);
  }
  const unique = [...new Map(rows.filter(p => validPatientId(p.id)).map(p => [p.id, p])).values()];
  return { rows: unique.slice(0, LIMIT), more: unique.length > LIMIT };
}

export function existingPatientHTML(patient, { keepForm = false } = {}) {
  if (!validPatientId(patient?.id)) return '<p class="due-meta">Use Update existing to find the accessible patient record. Nothing was saved from this form.</p>';
  const language = Object.prototype.hasOwnProperty.call(patient, 'primary_language')
    && (patient.primary_language === null || typeof patient.primary_language === 'string')
      ? (patient.primary_language || '').trim() || 'Not recorded' : 'Language unavailable';
  const base = '#patients/' + encodeURIComponent(patient.id);
  const target = keepForm ? ' target="_blank" rel="noopener"' : '';
  const consent = patient.consent_given === true ? 'Consent is recorded. Reconfirm with the family before entering new details.'
    : patient.consent_given === false ? 'Consent is missing. Record the family’s agreement in Update details before saving measurements.'
      : 'Check and record the family’s consent in Update details before saving measurements.';
  return `<article class="card" style="padding:14px;min-width:0;overflow-wrap:anywhere">
    <h3 style="margin:0 0 6px">${sanitize(patient.full_name || 'Existing patient')}</h3>
    <p class="due-meta" style="${noteStyle}">${sanitize(patient.patient_code || '')} · Existing record</p>
    <p class="info-value" style="${noteStyle};overflow-wrap:anywhere;margin:8px 0"><strong>Preferred language:</strong> ${sanitize(language)}</p>
    <p class="due-meta" style="${noteStyle};margin:8px 0">${consent}</p>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <a class="btn btn-primary btn-sm" href="${base}?tab=overview&amp;focus=edit"${target}>Update details / consent</a>
      <a class="btn btn-secondary btn-sm" href="${base}?tab=overview&amp;focus=measurements"${target}>Height, weight &amp; BMI</a>
      <a class="btn btn-secondary btn-sm" href="${base}?tab=documents"${target}>Papers / protocol</a>
    </div>
    <p class="form-hint" style="margin:10px 0 0">Use the same patient record. Diagnosis and current protocol are in Update details; dated measurements and BMI are in Height and weight. Changes to an existing measurement need review and confirmation.</p>
    ${keepForm ? `<p class="due-meta" style="${noteStyle};margin:8px 0 0"><strong>Your entry and selected files are still in this form and have not been submitted.</strong> The links open a new tab so you can refer to them while updating the existing record. They are not copied or saved automatically.</p>` : ''}
  </article>`;
}

// A single-add decision is read-only. An existing patient cannot be sent to
// the new-lead endpoint merely because a lookup or permission check failed.
export async function singleIntakeDecision(sb, status, { allowed = () => true } = {}) {
  current(allowed);
  if (!status || status.unchecked) throw Error('Could not check whether this patient already exists. Nothing was submitted. Try again.');
  if (!status.found) return { kind: 'new' };
  if (!validPatientId(status.patient_id)) throw Error('The existing record could not be identified. Use Update existing; nothing was submitted.');
  const rows = await queryRows(sb.from('patients').select(FIELDS).eq('id', status.patient_id).eq('is_active', true).limit(1), allowed);
  if (!rows.length || !validPatientId(rows[0].id)) return { kind: 'unavailable' };
  return { kind: 'existing', patient: rows[0] };
}

export function mountExistingPatients(host, { sb = getSupabase() } = {}) {
  if (!host) return { dispose() {} };
  const owner = getCurrentUser()?.id; let sequence = 0, timer, disposed = false;
  host.innerHTML = `<h2 style="margin:0 0 8px">Update an existing patient</h2>
    <p class="due-meta" style="${noteStyle}">Find a record you are allowed to access. Update their consent, diagnosis or protocol, add dated measurements and see BMI without adding them again.</p>
    <label class="form-label" for="existing-patient-search">Name, PAT code or patient / caregiver phone</label>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin:10px 0">
      <input class="form-input" id="existing-patient-search" type="search" autocomplete="off" maxlength="80" style="flex:1;min-width:180px" placeholder="Enter at least two characters, or a full phone number">
      <button class="btn btn-secondary" type="button" data-existing-search>Search</button>
    </div><div data-existing-results aria-live="polite"><p class="due-meta" style="${noteStyle}">Search by name, PAT code or the full 10-digit number. Only records available to your account are shown.</p></div>`;
  const input = host.querySelector('#existing-patient-search'), results = host.querySelector('[data-existing-results]');
  const active = () => !disposed && host.isConnected && host.querySelector('[data-existing-results]') === results && !!owner && getCurrentUser()?.id === owner;
  const run = async () => {
    const mine = ++sequence, raw = input.value;
    const allowed = () => active() && mine === sequence && input.value === raw;
    if (!active()) { results.textContent = 'Please sign in again before searching for patient records.'; return; }
    if (intakeSearchTerm(raw).length < 2) { results.textContent = 'Enter at least two characters or the full phone number.'; return; }
    results.textContent = 'Checking the records available to your account...';
    try {
      const found = await findExistingPatients(sb, raw, { allowed });
      if (!allowed()) return;
      results.innerHTML = found.rows.length ? `<div style="display:flex;flex-direction:column;gap:10px">${found.rows.map(p => existingPatientHTML(p)).join('')}</div>${found.more ? `<p class="due-meta" style="${noteStyle}">Showing the first 20 matches. Refine the name, code or phone.</p>` : ''}`
        : `<p class="due-meta" style="${noteStyle}">No accessible active record matched. Check the code or number. If another team registered this patient, ask their coordinator or a manager for the correct record; do not create another copy.</p>`;
    } catch {
      if (!allowed()) return;
      results.innerHTML = '<p role="alert">Could not load these records. Check your connection and try again.</p><button type="button" class="btn btn-secondary" data-existing-retry>Try again</button>';
      results.querySelector('[data-existing-retry]')?.addEventListener('click', run, { once: true });
    }
  };
  input.addEventListener('input', () => { clearTimeout(timer); ++sequence; results.textContent = 'Ready to search...'; timer = setTimeout(run, 350); });
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); run(); } });
  host.querySelector('[data-existing-search]').addEventListener('click', () => { clearTimeout(timer); run(); });
  return { search: run, dispose() { disposed = true; ++sequence; clearTimeout(timer); results.textContent = ''; } };
}
