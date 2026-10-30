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

export function careCallBounds({ callDay, outcome, active = false, team = 'caregiver' }) {
  // Nutrition preparation/explanation is deliberately scheduled. It is not a
  // caregiver cooldown, and an initial assessment may have no appointment yet.
  if (team === 'nutrition') return { min: validDay(callDay) ? callDay : null, max: null };
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
  const auto_apply = res.transcription_complete === true && res.review?.required !== true && res.quality === 'clear';
  return { summary: auto_apply ? res.summary : '', note: !auto_apply && res.draft_note ? res.draft_note : res.note || null,
    points: !auto_apply && Array.isArray(res.draft_points) ? res.draft_points : res.points || [], turns: (res.transcript || []).length,
    suggestions: auto_apply ? res.suggestions || {} : {}, call_day: res.call_day, dropped: res.dropped || 0,
    quality: res.quality, language: res.language, durationS, auto_apply,
    transcription_complete: res.transcription_complete === true,
    review: {required:!auto_apply, reasons:res.review?.reasons||[]},
    draft_summary: res.draft_summary || res.summary || '' };
}

// Saved-recording reads do not pass through the transcription HTTP projection.
// Keep this display-only: no write, autofill, access or completion decision.
const SAVED_NOTE_SECTIONS = ['red_flags', 'condition', 'treatment', 'reports', 'needs', 'follow_ups', 'other'];
const SAVED_SOURCE_REVIEW = 'The supporting quote is not located within one transcript turn. Check the original speech before using this draft.';
const SAVED_UNVERIFIED = 'Unverified AI proposal. Check the transcript or recording before using it.';
const savedQuotePlain = value => String(value ?? '').toLowerCase().normalize('NFKC')
  .replace(/[‘’'`]/g, '').replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();
function savedQuoteSources(turns, evidence) {
  const raw = String(evidence ?? ''), quote = savedQuotePlain(raw);
  if (raw.length > 300 || quote.length < 6 || quote.split(' ').length > 30) return [];
  return turns.map((turn, index) => ({ turn, index }))
    .filter(({ turn }) => ` ${savedQuotePlain(turn.text)} `.includes(` ${quote} `));
}
// These are the existing bounded note checks, not translation or truth proof.
const savedNorm = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const SAVED_RESOLVED = /\b(resolved|no longer (?:need|needs|needed|require|requires|have|has|having)|(?:do|does) not (?:need|require)|(?:don t|doesn t) (?:need|require)|no .{0,22}(?:anymore|any more)|ab .{0,18}(?:nahi|nahin|nhi)|ab (?:theek|thik))\b/i;
const SAVED_CURRENT = /\b(still|currently|ongoing|active|continues?|persists?|needs?|requires?|has|having|suffers?)\b/i;
const SAVED_HISTORICAL = /\b(previously|earlier|used to|last week|no longer|resolved|does not|do not|not needed|no .{0,18}(?:anymore|any more))\b/i;
const SAVED_QUESTION = /\?|^(?:(?:is|are|was|were|do|does|did|can|could|would|will|have|has)\s+(?:you|we|they|it|there|he|she|the|your|our|any|a|i)\b|kya\b)/i;
const SAVED_STOP = new Set('the a an and or of for from with without this that it is are was were be been to in on at now today still no not any more anymore longer problem needs need have has had do does patient family caller please'.split(' '));
const savedTopics = value => new Set(savedNorm(value).split(' ').filter(word => word.length >= 4 && !SAVED_STOP.has(word) && !SAVED_RESOLVED.test(word)));
const SAVED_CLOCK = /\b(?:after|before|at|around)\s+\d{1,2}(?::\d{2})?(?:\s*(?:a\.?m\.?|p\.?m\.?|in the (?:morning|afternoon|evening|night)))\b|\b\d{1,2}:\d{2}\b/i;
function savedLineIssue(section, line, turns) {
  const sources = savedQuoteSources(turns, line.evidence);
  if (!sources.length) return SAVED_SOURCE_REVIEW;
  const text = String(line.text ?? ''), evidence = String(line.evidence ?? '');
  if (section === 'follow_ups' && SAVED_CLOCK.test(evidence) && !SAVED_CLOCK.test(text))
    return 'The source includes a time that is missing from this follow-up. Check the agreed time before using it.';
  const clinical = ['red_flags', 'condition', 'treatment', 'reports'].includes(section);
  if (sources.every(({ turn }) => SAVED_QUESTION.test(turn.text.trim()) && (clinical || turn.speaker === 'caller' && section === 'needs')))
    return 'The supporting quote is a question, not a reported fact. Check the family response.';
  if (SAVED_CURRENT.test(savedNorm(text)) && !SAVED_HISTORICAL.test(savedNorm(text))) {
    if (SAVED_RESOLVED.test(savedNorm(evidence)))
      return 'The note describes a current problem but its quote says it was resolved or is no longer needed.';
    const words = savedTopics(evidence), last = sources.at(-1).index;
    if (words.size && turns.slice(last + 1).some(turn => turn.speaker === 'family' && SAVED_RESOLVED.test(savedNorm(turn.text))
        && [...savedTopics(turn.text)].some(word => words.has(word))))
      return 'A later family statement may resolve this same problem. Check the later statement before using the note.';
  }
  return null;
}
export function recordingResultForRead(row) {
  const stored = row?.suggestions && typeof row.suggestions === 'object' ? row.suggestions : {};
  const original = stored.note && typeof stored.note === 'object' && !Array.isArray(stored.note) ? stored.note : null;
  const turns = Array.isArray(row?.transcript) ? row.transcript.slice(0, 3000)
    .filter(turn => turn && typeof turn.text === 'string' && typeof turn.speaker === 'string') : [];
  const reasons = [];
  if (row?.transcription_complete !== true) reasons.push('The service has not confirmed a complete written transcript and note.');
  if (row?.audio_quality !== 'clear') reasons.push('Some speech is unclear or no conversation was heard.');
  if (stored.note_review?.required === true) reasons.push('Some proposed facts need checking against the transcript or recording.');
  if (Array.isArray(row?.dropped) && row.dropped.some(item => String(item?.field || '').startsWith('note.')))
    reasons.push('Some proposed note details were omitted by validation or a size limit.');
  // Spoke-with metadata is rendered, but cannot replace substantive fallback text.
  const hadSections = !!original && SAVED_NOTE_SECTIONS.some(section =>
    Array.isArray(original[section]) && original[section].some(line => String(line?.text ?? '').trim()));
  const hadNote = !!original && (!!original.spoke_with?.value || hadSections);
  let note = hadNote ? { ...original, ...(original.spoke_with ? { spoke_with: { ...original.spoke_with } } : {}) } : null;
  const projectLine = (line, section) => {
    if (!line || typeof line !== 'object') return line;
    const copy = { ...line }, issue = savedLineIssue(section, copy, turns);
    if (copy.unverified === true || copy.review_required === true || issue) {
      copy.review_required = true;
      if (section === 'red_flags') copy.unverified = true;
      copy.review_reason = section === 'red_flags' ? `${SAVED_UNVERIFIED}${issue ? ' ' + issue : ''}`
        : issue || copy.review_reason || 'Check this saved proposal against the original speech before using it.';
      reasons.push(issue || copy.review_reason);
    }
    return copy;
  };
  if (note) {
    if (note.spoke_with?.value && !savedQuoteSources(turns, note.spoke_with.evidence).length) reasons.push(SAVED_SOURCE_REVIEW);
    for (const section of SAVED_NOTE_SECTIONS) if (Array.isArray(original[section]))
      note[section] = (section === 'red_flags' ? original[section].slice(0, 31) : original[section]).map(line => projectLine(line, section));
  }
  const points = Array.isArray(stored.points) ? stored.points.map(line => projectLine(typeof line === 'string' ? { text: line, evidence: '' } : line, 'other')) : [];
  if (stored.condition?.value === 'critical') {
    // This preserves a proposed value, not a newly asserted clinical fact.
    const proposal = { text: 'AI condition proposal: critical.', evidence: String(stored.condition.evidence ?? ''), at: null,
      status: 'uncertain', unverified: true, review_required: true, review_reason: SAVED_UNVERIFIED };
    const flags = Array.isArray(note?.red_flags) ? note.red_flags : [];
    const same = line => savedQuotePlain(line?.text) === savedQuotePlain(proposal.text)
      && savedQuotePlain(line?.evidence) === savedQuotePlain(proposal.evidence);
    note = note || { spoke_with: null };
    note.red_flags = [proposal, ...flags.filter(line => !same(line))];
    reasons.push(SAVED_UNVERIFIED);
  }
  if (note && Array.isArray(note.red_flags) && (note.red_flags.length > 30 || original?.red_flags?.length > 30)) {
    note.red_flags = [...note.red_flags.slice(0, 30), { text: 'Additional AI safety proposals do not fit this view. Check the complete stored note and source.',
      evidence: '', at: null, status: 'uncertain', unverified: true, review_required: true, review_reason: SAVED_UNVERIFIED }];
    reasons.push('More safety proposals exist than fit in this view. Check the complete stored note and source.');
  }
  return { note, points, draft_summary: typeof row?.summary === 'string' ? row.summary : '', show_fallback: !hadSections,
    review: { required: reasons.length > 0, reasons: [...new Set(reasons)].slice(0, 12) }, auto_apply: false, suggestions: {} };
}
