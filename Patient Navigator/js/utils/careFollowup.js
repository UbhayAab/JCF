// Care-call calendar policy. Appointment/review dates do not pass through here.
export const CARE_CALL_PROVENANCE = 'care-call-v1';
export const CARE_CASE_FIELDS = 'is_active,do_not_call,patient_status,is_blacklisted,date_of_death,disinterest_level,engagement_hold_until';

export function validDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

export function indiaCallDay(value = new Date()) {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? new Date(time + 330 * 60_000).toISOString().slice(0, 10) : null;
}

export function dayPlus(day, days) {
  if (!validDay(day) || !Number.isInteger(days)) return null;
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

// Unknown metadata is not proof that the family is active and callable.
export function activeCareCase(patient, now = new Date()) {
  if (!patient || CARE_CASE_FIELDS.split(',').some((key) => !Object.hasOwn(patient, key))) return false;
  const time = new Date(now).getTime();
  const hold = patient.engagement_hold_until ? Date.parse(patient.engagement_hold_until) : NaN;
  if (!Number.isFinite(time) || (patient.engagement_hold_until && !Number.isFinite(hold))) return false;
  return patient.is_active === true && !patient.do_not_call && !patient.is_blacklisted && !patient.date_of_death
    && typeof patient.patient_status === 'string' && !['inactive', 'deceased'].includes(patient.patient_status)
    && !(patient.disinterest_level != null && hold > time);
}

export function careCallBounds({ callDay, outcome, active = false }) {
  return { min: dayPlus(callDay, outcome === 'connected' ? 7 : 3),
    max: active ? dayPlus(callDay, 15) : null };
}

export function normalizeCareCall(day, options) {
  if (!validDay(day)) return null;
  const { min, max } = careCallBounds(options);
  if (!min) return null;
  return day < min ? min : max && day > max ? max : day;
}

// Old cached/legacy suggestions have no guard-computed provenance. Never turn
// their arbitrary appointment date or day count into a care-call date.
export function verifiedCareCallDate(s, callDay) {
  const proof = s?.followup_care_call;
  const day = s?.followup_on?.value;
  if (proof?.value !== CARE_CALL_PROVENANCE || proof.call_day !== callDay || !validDay(day) || !validDay(callDay)) return null;
  const days = Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${callDay}T00:00:00Z`)) / 86_400_000);
  return days >= 3 && days <= 15 ? day : null;
}

// The actual recording-component boundary, kept pure so the independent
// source day cannot be lost between the API reply and any of the three forms.
export function recordingResultForForm(res, durationS = null) {
  return { summary: res.summary, note: res.note || null, points: res.points || [], turns: (res.transcript || []).length,
    suggestions: res.suggestions || {}, call_day: res.call_day, dropped: res.dropped || 0,
    quality: res.quality, language: res.language, durationS };
}
