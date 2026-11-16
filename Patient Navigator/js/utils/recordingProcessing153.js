// Display-only projection. The service retains all authority/consent/CAS checks.
export function processing153(value) {
  if (!value || value.version !== 1 || typeof value.transcript_complete !== 'boolean'
      || typeof value.notes_complete !== 'boolean' || typeof value.coverage_confirmed !== 'boolean'
      || !Number.isSafeInteger(value.source_spans) || value.source_spans < 0 || value.source_spans > 3000) return null;
  const finish = v => v === null || typeof v === 'string' && /^[A-Z_]{1,40}$/.test(v);
  if (!finish(value.transcript_finish) || !finish(value.note_finish)
      || value.transcript_complete && (value.transcript_finish !== 'STOP' || value.audio_coverage_confirmed !== true)
      || value.notes_complete && (!value.transcript_complete || value.note_finish !== 'STOP' || !value.coverage_confirmed)) return null;
  // notes_drafted: the whole source was written and every note window finished.
  // A draft can still be held for checking (notes_complete false); another
  // processing attempt then usually flags the same lines and spends 1 of 3
  // attempts, so the screens offer it only as a secondary choice (#211).
  const notesDrafted = value.transcript_complete && value.note_finish === 'STOP'
    && value.coverage_confirmed === true && value.review_checked === true;
  return { transcript_complete: value.transcript_complete, notes_complete: value.notes_complete && value.review_checked === true,
    notes_drafted: notesDrafted };
}
// Retry control for a held or unfinished draft. Primary only when processing
// itself did not finish; a finished draft that needs checking keeps it quiet.
export function retryControl153(p, attrs) {
  const drafted = p?.notes_drafted === true;
  return drafted
    ? `<button type="button" class="btn btn-ghost btn-sm" ${attrs}>Process again</button><p style="font:var(--t-xs);color:var(--ink-3);margin:2px 0 8px">Only if the transcript is cut off or wrong. The transcript and notes were written in full; processing again usually flags the same points and uses one of the recording's 3 attempts. Your notes are kept.</p>`
    : `<button type="button" class="btn btn-primary btn-sm" ${attrs}>Try processing again</button><p style="font:var(--t-xs);color:var(--ink-3);margin:2px 0 8px">The transcript or notes are not complete. Uses the retained recording for one new attempt. Your notes are kept.</p>`;
}
export function retry153(value) {
  return value?.allowed === true && typeof value.version === 'string' && value.version.length <= 80
    && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/.test(value.version)
    && Number.isFinite(Date.parse(value.version)) ? { allowed: true, version: value.version } : null;
}
export function savedRetry153(row, needsReview, actorId) {
  const stalled = row?.status === 'transcribing' && Number.isFinite(Date.parse(row?.status_at))
    && Date.now() - Date.parse(row.status_at) >= 420000;
  if (!actorId || row?.uploaded_by !== actorId || row.audio_deleted_at || !Number.isInteger(row.attempts)
      || row.attempts < 0 || row.attempts >= 3 || !(['uploaded', 'failed'].includes(row.status) || row.status === 'done' && needsReview || stalled)) return null;
  return retry153({ allowed: true, version: row.status_at });
}
