// Display-only projection. The service retains all authority/consent/CAS checks.
export function processing153(value) {
  if (!value || value.version !== 1 || typeof value.transcript_complete !== 'boolean'
      || typeof value.notes_complete !== 'boolean' || typeof value.coverage_confirmed !== 'boolean'
      || !Number.isSafeInteger(value.source_spans) || value.source_spans < 0 || value.source_spans > 3000) return null;
  const finish = v => v === null || typeof v === 'string' && /^[A-Z_]{1,40}$/.test(v);
  if (!finish(value.transcript_finish) || !finish(value.note_finish)
      || value.transcript_complete && (value.transcript_finish !== 'STOP' || value.audio_coverage_confirmed !== true)
      || value.notes_complete && (!value.transcript_complete || value.note_finish !== 'STOP' || !value.coverage_confirmed)) return null;
  return { transcript_complete: value.transcript_complete, notes_complete: value.notes_complete && value.review_checked === true };
}
export function retry153(value) {
  return value?.allowed === true && typeof value.version === 'string' && value.version.length <= 80
    && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/.test(value.version)
    && Number.isFinite(Date.parse(value.version)) ? { allowed: true, version: value.version } : null;
}
export function savedRetry153(row, needsReview, actorId) {
  if (!actorId || row?.uploaded_by !== actorId || row.audio_deleted_at || !Number.isInteger(row.attempts)
      || row.attempts < 0 || row.attempts >= 3 || !(['uploaded', 'failed'].includes(row.status) || row.status === 'done' && needsReview)) return null;
  return retry153({ allowed: true, version: row.status_at });
}
