// ============================================================
// Fixboard 243: may this person open a family's record?
//
// A family someone else registered is outside a ground POC's care scope, so
// its record does not open for them, and the "Open their record" link on the
// upload screen used to end on "Patient not found". The patient page opens
// for can_care_for_patient or can_open_patient_record
// (patient_merge_scope154), so this asks the same two. When neither answer
// can be read, can_open stays null and the link shows as before.
// ============================================================
import { sanitize } from '../utils/validators.js';

export async function withOpenAccess(sb, st) {
  if (!st?.found || !st.patient_id) return st;
  try {
    const [care, open] = await Promise.all([
      sb.rpc('can_care_for_patient', { p_id: st.patient_id }),
      sb.rpc('can_open_patient_record', { p_patient_id: st.patient_id }),
    ]);
    if (care?.data === true || open?.data === true) return { ...st, can_open: true };
    if (care?.error || open?.error) return { ...st, can_open: null };
    return { ...st, can_open: false };
  } catch { return { ...st, can_open: null }; }
}

// Who to ask when the record is not this person's to open. .due-meta is one
// line with an ellipsis by default, which cut this sentence off on a phone.
export function notYoursHTML(st) {
  const mentor = st?.assigned_mentor ? sanitize(st.assigned_mentor) : '';
  return `<div class="due-meta" style="margin-top:4px;white-space:normal;overflow:visible;text-overflow:clip;overflow-wrap:anywhere">${mentor
    ? `Their record is looked after by ${mentor}, so it opens only for ${mentor} and managers. Ask ${mentor} or a manager for anything you need from it.`
    : 'Their record opens only for the mentor who looks after them and managers. Ask a manager for anything you need from it.'}</div>`;
}

// The link, or who to ask instead.
export function openRecordHTML(st) {
  if (!st?.patient_id) return '';
  if (st.can_open === false) return notYoursHTML(st);
  return `<a href="#patients/${encodeURIComponent(st.patient_id)}" style="font-size:13px;color:var(--primary-ink);font-weight:600">Open their record →</a>`;
}
