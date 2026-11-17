// The call note's sections and plain-text draft (pure: no imports, no DOM).
// The headings match the note text call-transcribe writes (guard.ts composeNote).
export const NOTE_HEADS = [['condition', 'Condition and symptoms'], ['treatment', 'Treatment'], ['reports', 'Reports mentioned'],
  ['needs', 'Needs and requests'], ['follow_ups', 'Follow-ups'], ['other', 'Other']];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function noteDay(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isFinite(d.getTime()) ? `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}` : '';
}

// Fixboard #211 (reopened 16 Nov): a draft held for checking used to leave the
// form's notes empty, so staff thought no note was made and uploaded again.
// The held draft now goes into the notes as plain text under a line saying it
// is NOT checked, with every flagged line marked. Outcome, condition, needs and
// the next call date are still left for the person: those raise alerts and
// book calls.
export const DRAFT_NOT_CHECKED = 'AI draft, NOT checked. Check each point against the transcript or recording, correct it, then save.';
export function draftNoteText(r) {
  const n = r?.note;
  const mark = (l) => l.review_reason ? ` [check: ${l.review_reason}${l.at ? ` Listen at ${l.at}.` : ''}]`
    : l.unverified ? ` [check: quote not exact, listen to the recording${l.at ? ` at ${l.at}` : ''}]` : '';
  const day = (d) => (d ? noteDay(d) : '');
  const line = (l) => `- ${l.status && !['ongoing', 'not_applicable'].includes(l.status) ? `${l.status}: ` : ''}${String(l.text || '').trim()}${day(l.date) ? ` (${day(l.date)})` : ''}${mark(l)}`;
  const lines = (items) => (Array.isArray(items) ? items : []).map((l) => (typeof l === 'string' ? { text: l } : l))
    .filter((l) => l && typeof l === 'object' && String(l.text || '').trim()).map(line);
  let body = [];
  if (n && typeof n === 'object') {
    const flags = lines(n.red_flags);
    if (flags.length) body.push('Red flags:', ...flags);
    if (typeof n.spoke_with?.value === 'string' && n.spoke_with.value.trim()) body.push(`Spoke with: ${n.spoke_with.value.trim()}`);
    for (const [k, t] of NOTE_HEADS) { const x = lines(n[k]); if (x.length) body.push(`${t}:`, ...x); }
  }
  if (!body.length && Array.isArray(r?.points) && r.points.length) body = r.points.map((p) => `- ${String(p?.text ?? p ?? '').trim()}`).filter((p) => p.length > 2);
  if (!body.length && String(r?.draft_summary || '').trim()) body = [String(r.draft_summary).trim()];
  return body.length ? `${DRAFT_NOT_CHECKED}\n${body.join('\n')}` : '';
}
