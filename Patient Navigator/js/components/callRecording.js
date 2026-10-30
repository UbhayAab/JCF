// ============================================================
// Call recordings (Fixboard #22; sql/166; Edge Function call-transcribe).
//
// Before the call: the first time a number is tapped on a call, a card shows
// the consent line to say when they pick up (English and Hindi) and how this
// phone records. After the call, at the top of the log: "Did the family agree
// to this call being recorded?", then Upload recording, a check that the file
// is this call's, the upload to the private bucket, the transcript and
// suggested answers that fill the form. The caller checks them and saves as
// before. Past calls get a Recording button for those allowed to hear it (the
// caller, her managers, admins: the database decides, not this file).
//
// The rules are in the database, not here: no agreed answer, no upload; no
// general consent on file, no upload; only the uploader makes the transcript.
// ============================================================

import { getSupabase } from '../supabase.js';
import * as recordingAuth from '../auth.js';
const { getCurrentProfile } = recordingAuth;
import { showToast } from './toast.js';
import { showModal, closeModal, confirmModal } from './modal.js';
import { icon } from './icons.js';
import { mountCallMeasurements } from './measurements.js';
import { verifiedCareCallDate, recordingResultForForm } from '../utils/careFollowup.js';
import * as savedRecordingRead from '../utils/careFollowup.js';
import { createSharedRecordingStore, SHARE_TTL_MS } from '../utils/sharedRecording.js';

// Historical wording is never relabelled. sql/212 opts in only a fresh rec-v2
// answer while its prospective completion policy is enabled.
export const CONSENT_WORDING_VERSION = 'rec-v2';
export const SESSION_RECORDING_BINDING128 = 1;
export const SESSION_CONSENT_VERSION128 = 'session-rec-v1';
const SESSION_NOTICE128 = { version: SESSION_CONSENT_VERSION128,
  en: 'May I record this session so I do not miss what you tell me? Only our care team can listen. A computer service, Google, writes it down for the team to check. Once the complete written note is ready and the session is saved, the cloud audio is deleted. Incomplete processing or review is kept for no more than 90 days. An unsaved upload is cleared after a day. Written notes stay with the session. Is that all right?',
  hi: 'Kya hum yeh session record kar sakte hain, taaki aapki koi baat chhoot na jaaye? Sirf hamari care team ise sun sakti hai. Google ki computer seva ise team ki jaanch ke liye likhti hai. Poori likhit note taiyaar hone aur session save hone ke baad cloud audio hata di jaayegi. Adhoori processing ya jaanch ka audio zyada se zyada 90 din rahega. Bina save kiye upload ek din baad hata diya jaayega. Likhi hui baatein session ke saath rahengi. Kya yeh theek hai?' };
export const CONSENT_LINE_EN = 'May I record this call so I do not miss anything you tell me? Only our care team will listen to it. Once a complete written note is ready and the call is saved, the cloud recording is deleted. If processing or review is incomplete, it is kept for no more than three months. The written notes stay with the call. Is that all right?';
export const CONSENT_LINE_HI = 'Kya hum yeh call record kar sakte hain, taaki aapki koi baat chhoot na jaaye? Ise sirf hamari care team sunegi. Poori likhit note taiyaar hone aur call save hone ke baad cloud recording hata di jaayegi. Agar processing ya jaanch adhoori ho, to recording zyada se zyada teen mahine rakhi jaayegi. Likhi hui baatein call ke saath rahengi. Kya yeh theek hai?';
const LEGACY_CONSENT = { version: 'rec-v1-2026-10-08',
  en: 'May I record this call so I do not miss anything you tell me? Only our care team will listen to it, and the recording is deleted after three months. Is that all right?',
  hi: 'Kya hum yeh call record kar sakte hain, taaki aapki koi baat chhoot na jaaye? Ise sirf hamari care team sunegi, aur teen mahine baad recording hata di jaati hai. Kya yeh theek hai?' };
export function recordingConsentNotice(policy) {
  return policy?.completion_cleanup_enabled === true && policy.wording_version === CONSENT_WORDING_VERSION && policy.max_audio_days === 90
    ? { version: CONSENT_WORDING_VERSION, en: CONSENT_LINE_EN, hi: CONSENT_LINE_HI } : { ...LEGACY_CONSENT };
}
async function currentRecordingConsentNotice() {
  try {
    const { data, error } = await getSupabase().rpc('call_recording_retention_policy');
    if (!error) return recordingConsentNotice(data);
  } catch { /* offline or rollback: keep the established notice */ }
  return { ...LEGACY_CONSENT };
}
// The privacy line families hear with the general consent question.
// Names the computer service, because the audio does leave the team to be written down.
export const PRIVACY_LINE = 'Sometimes we ask to record a call so we do not miss anything. Only our care team listens to it; a computer service (Google) writes it down as notes for them. The recording is deleted within three months, and the written notes stay with the call.';

const BUCKET = 'call-recordings';
const PHONE_KEY = 'jcf_rec_phone';
const SIGNED_URL_SECONDS = 300;    // short; the player asks for a fresh link if it runs out mid-call
const MAX_SHARED_BYTES = 50 * 1024 * 1024;
const MINUTE = 60_000;

const PHONES = {
  samsung: {
    label: 'Samsung',
    steps: ['Open the Phone app.', 'Tap the three dots at the top right, then Settings.', 'Tap Record calls.',
      'Turn on Auto record calls, and choose All calls (or Calls with numbers not saved).'],
    after: 'After the call, come back here, tap Upload recording and pick the newest file under Recent. Samsung keeps them in Recordings, then Call.',
  },
  google: {
    label: 'Google Phone app (Pixel, Motorola, Nokia, and many Xiaomi, Redmi, POCO, Realme and OnePlus phones)',
    steps: ['Open the Phone app.', 'Tap the three dots at the top right, then Settings.', 'Tap Call recording.',
      'Under Always record, turn on Numbers not in your contacts.'],
    after: 'Family numbers are usually not saved in your contacts, so their calls record by themselves, and the family hears that the call is being recorded. The Phone app keeps the recording inside itself: after the call open Recents, tap the call, tap Share on the recording and choose Jarurat Care (the Navigator, once it is added to your home screen from Chrome). It waits on the call log for you. If Jarurat Care is not in the list, save it to your phone instead (for example in Files), then tap Upload recording here.',
  },
  other: {
    label: 'Another Android phone',
    steps: ['Open the Phone app and its Settings.', 'Look for Call recording or Record calls.',
      'Turn on automatic recording for all calls, or for numbers not in your contacts.'],
    after: 'If your phone has no such setting, tell your team lead. You can still log the call by hand.',
  },
  iphone: {
    label: 'iPhone',
    steps: ['An iPhone cannot record every call by itself.',
      'When the family agrees, tap the record button at the top left of the call screen (iOS 18.1 or later). Both of you hear that the call is being recorded.'],
    after: 'When the call ends, the recording is saved in the Notes app. Open that note, tap the three dots on the recording and choose Save Audio to Files. Then tap Upload recording here and pick it from Recents.',
  },
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function blankRecording() {
  return { reminded: false, intent: null, dialedAt: null, wordingVersion: null, consentId: null, decision: null,
    recordingId: null, path: null, fileName: '', durationS: null, status: null, error: null, result: null, applied: null,
    sharedRecording: null, sharedUploadDurable: false, sharedCleanupError: null };
}

// sql/193: a recording joins a call made within 7 days of the family's answer.
export const RECORDING_WINDOW_DAYS = 7;

// ---------------------------------------------------------------- the call note (prompt v3, Fixboard #36)
// The headings match the note text call-transcribe writes (guard.ts composeNote).
const NOTE_HEADS = [['condition', 'Condition and symptoms'], ['treatment', 'Treatment'], ['reports', 'Reports mentioned'],
  ['needs', 'Needs and requests'], ['follow_ups', 'Follow-ups'], ['other', 'Other']];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function noteDay(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isFinite(d.getTime()) ? `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}` : '';
}

// The note, section by section, for the box. A result from before v3 has no
// note: its short points are shown instead.
export function noteHTML(r) {
  const n = r?.note;
  // A red flag whose quote was not exact stays (guard.ts safety exception), marked, with where to listen.
  const unverified = (l) => l.review_reason
    ? ` <span style="color:var(--danger);font-weight:600">(needs review: ${esc(l.review_reason)}${l.at ? ` Listen at ${esc(l.at)}.` : ''})</span>` : (l.unverified
    ? ` <span style="color:var(--danger);font-weight:600">(red flag, quote not exact: listen to the recording${l.at ? ` at ${esc(l.at)}` : ''})</span>` : '');
  const li = (l) => `<li style="margin-bottom:3px;overflow-wrap:anywhere">${l.status && !['ongoing','not_applicable'].includes(l.status) ? `<strong>${esc(l.status)}:</strong> ` : ''}${esc(l.text)}${l.date ? ` <span style="color:var(--ink-3)">(${esc(noteDay(l.date))})</span>` : ''}${unverified(l)}${l.evidence ? `<details style="margin:3px 0 5px"><summary>Source quote${l.at ? ` at ${esc(l.at)}` : ''}</summary><blockquote style="margin:4px 0 4px 10px;overflow-wrap:anywhere">${esc(l.evidence)}</blockquote></details>` : ''}</li>`;
  const ul = (items) => `<ul style="list-style:disc;margin:0 0 8px 18px;padding:0;color:var(--ink-2);font:var(--t-xs)">${items.map(li).join('')}</ul>`;
  const head = (t, color = 'var(--ink)') => `<p style="font:var(--t-xs);font-weight:700;color:${color};margin:8px 0 3px">${t}</p>`;
  if (!n) return r?.points?.length ? ul(r.points) : r?.draft_summary ? `<p style="white-space:pre-line">${esc(r.draft_summary)}</p>` : '';
  return [
    n.red_flags?.length ? `<div class="rec-flags" style="border-left:3px solid var(--danger);padding:2px 0 2px 10px;margin:6px 0">${head('Red flags', 'var(--danger)')}${ul(n.red_flags)}</div>` : '',
    n.spoke_with ? `<p style="font:var(--t-xs);color:var(--ink-2);margin:6px 0 0"><strong>Spoke with:</strong> ${esc(n.spoke_with.value)}</p>` : '',
    ...NOTE_HEADS.map(([k, t]) => (n[k]?.length ? head(t) + ul(n[k]) : '')),
  ].join('');
}

export function recordingReviewHTML(r) {
  return r?.review?.required ? `<div role="status" style="border:1px solid var(--gold);border-radius:8px;padding:10px;margin:8px 0"><strong>Review needed - draft notes</strong><p style="margin:4px 0 0">Processing may be incomplete or some proposed facts need checking. Use the source quotes, transcript and recording before using these notes.</p>${r.review.reasons?.length ? `<ul>${r.review.reasons.map(reason=>`<li>${esc(reason)}</li>`).join('')}</ul>` : ''}</div>` : '';
}

// Today plus n days in the phone's own calendar, YYYY-MM-DD. (toISOString is
// UTC: the day before between midnight and 05:30 in India.)
export function localDateIn(n) {
  const d = new Date(); d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// The day the family agreed for the next call, YYYY-MM-DD, or null. Prompt v3
// names the day itself (followup_on), so a recording added the day after the
// call does not move it. Older results lack independently verified provenance.
export function suggestedFollowup(s, sourceCallDay) {
  return verifiedCareCallDate(s, sourceCallDay);
}

// The note goes into the call log's notes, always under a line saying it came
// from the recording, so the saved record never passes AI text off as the
// caller's own. Notes she already typed are kept above it; added once.
export const NOTE_FROM_RECORDING = 'From the call recording (AI note):';
export function appendNote(existing, note) {
  const mine = String(existing || '').trim();
  const add = String(note || '').trim();
  if (!add || mine.includes(add)) return mine;
  return mine ? `${mine}\n\n${NOTE_FROM_RECORDING}\n${add}` : `${NOTE_FROM_RECORDING}\n${add}`;
}

// ---------------------------------------------------------------- pure helpers
const BY_TYPE = {
  'audio/mp4': 'audio/mp4', 'audio/x-m4a': 'audio/mp4', 'audio/m4a': 'audio/mp4',
  'audio/aac': 'audio/aac', 'audio/x-aac': 'audio/aac', 'audio/mpeg': 'audio/mpeg', 'audio/mp3': 'audio/mpeg',
  'audio/wav': 'audio/wav', 'audio/x-wav': 'audio/wav', 'audio/wave': 'audio/wav',
  'audio/ogg': 'audio/ogg', 'audio/opus': 'audio/ogg', 'audio/webm': 'audio/webm',
};
const BY_EXT = { m4a: 'audio/mp4', aac: 'audio/aac', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/ogg', oga: 'audio/ogg', webm: 'audio/webm' };

// The bucket's own type for a picked file, or null when it cannot be read
// (AMR and 3GP from some older phones). Android often reports no type at all,
// so the file name decides then.
export function canonicalAudioType(name, type) {
  const byType = BY_TYPE[String(type || '').toLowerCase().split(';')[0].trim()];
  if (byType) return byType;
  const ext = String(name || '').toLowerCase().split('.').pop();
  return BY_EXT[ext] || null;
}

export function fmtDur(s) {
  const n = Math.max(0, Math.round(Number(s) || 0));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
}
const fmtWhen = (ms) => new Date(ms).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

// Is this file this call's recording? Problems are plain sentences for the caller.
//   lastModified  the file's time (ms), when the phone gives one
//   durationS     its length in seconds, when the browser can read it
//   dialedAt      when she tapped the number in the Navigator (ms), if she did
//   loggedAt      when the call was logged (ms), for a logged call reopened with no dial:
//                 its recording can be from a little before (the log is written after
//                 the call) or after it (a call back), so six hours either side of it
//   callSeconds   the call's length from the timer or the typed minutes
export function checkRecordingFile({ lastModified, durationS, dialedAt, loggedAt = null, callSeconds, now = Date.now() }) {
  const problems = [];
  if (Number.isFinite(lastModified) && lastModified > 0) {
    const earliest = dialedAt ? dialedAt - 2 * MINUTE : loggedAt ? loggedAt - 6 * 60 * MINUTE : now - 6 * 60 * MINUTE;
    if (lastModified < earliest) {
      problems.push(dialedAt
        ? `This recording is from ${fmtWhen(lastModified)}, before this call (you dialled at ${fmtWhen(dialedAt)}).`
        : loggedAt
          ? `This recording is from ${fmtWhen(lastModified)}, more than six hours before this call was logged (${fmtWhen(loggedAt)}).`
          : `This recording is from ${fmtWhen(lastModified)}, more than six hours ago.`);
    } else if (lastModified > now + 2 * MINUTE) {
      problems.push('This recording has a time in the future. Check it is the right file.');
    }
  }
  if (Number.isFinite(durationS) && durationS > 0 && callSeconds >= 30) {
    if (durationS < callSeconds * 0.5) problems.push(`This recording is ${fmtDur(durationS)} long, but the call lasted ${fmtDur(callSeconds)}.`);
    else if (durationS > callSeconds + 180) problems.push(`This recording is ${fmtDur(durationS)} long, much longer than the call (${fmtDur(callSeconds)}).`);
  }
  return { ok: problems.length === 0, problems };
}

// The length of an audio file, read by the browser; null when it cannot tell.
export function readAudioDuration(file, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let done = false;
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    const finish = (v) => { if (done) return; done = true; URL.revokeObjectURL(url); resolve(v); };
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => finish(Number.isFinite(audio.duration) ? audio.duration : null);
    audio.onerror = () => finish(null);
    setTimeout(() => finish(null), timeoutMs);
    audio.src = url;
  });
}

// ---------------------------------------------------------------- shared files
// Google's Phone app keeps its recordings inside itself: Share is the way out.
// The installed app is a share target (manifest.webmanifest); sw.js keeps the
// shared file in this cache until the next call offers it, for six hours.
export async function takeSharedRecording() {
  try {
    if (!('caches' in window)) return null;
    const store = createSharedRecordingStore(), share = (await store.list())[0];
    if (!share || !canonicalAudioType(share.file.name, share.file.type)) return null;
    share.file._jcfShared = { ...store.refOf(share), binding: share.binding };
    return share.file;
  } catch { return null; }
}

async function verifySharedAttachment(expected) {
  if (!expected.uploaderId || expected.uploaderId !== getCurrentProfile()?.id) return { attached: false, uploaded: false };
  const sb = getSupabase();
  const { data: row, error } = await sb.from('call_recordings')
    .select('id,consent_id,call_log_id,storage_path,patient_id,uploaded_by,status,audio_deleted_at,audio_delete_reason,delete_audio_after_transcription,transcription_complete,transcribed_at,audio_quality,transcript,summary,suggestions')
    .eq('id', expected.recordingId).maybeSingle();
  if (error) throw error;
  const { data: log, error: logError } = await sb.from('call_logs').select('id,patient_id,caller_id').eq('id', expected.callLogId).maybeSingle();
  if (logError) throw logError;
  const attached = row?.id === expected.recordingId && row.consent_id === expected.consentId
    && row.call_log_id === expected.callLogId && row.storage_path === expected.path && row.patient_id === expected.patientId
    && row.uploaded_by === expected.uploaderId && log?.id === expected.callLogId
    && log.patient_id === expected.patientId && log.caller_id === expected.uploaderId;
  // attach_call_recording only leaves 'uploading' after verifying the stored
  // object exists. Reloads with persisted matching upload metadata can retry
  // cleanup without invoking transcription again.
  // Transcription can finish before a local cleanup retry. Only the explicit
  // completed-note policy is equivalent to the verified original upload;
  // erasure, consent withdrawal and legacy expiry are never such a receipt.
  const completedDeletion = row?.audio_deleted_at && completedAudioReceipt(row);
  return { attached, uploaded: !!attached && (completedDeletion
    || (!row.audio_deleted_at && ['uploaded','transcribing','done','failed'].includes(row.status))) };
}

export function completedAudioReceipt(row) {
  const flags = row?.suggestions?.note?.red_flags;
  const needsListening = (value) => typeof value === 'string' ? /listen to (?:the )?recording/i.test(value)
    : Array.isArray(value) ? value.some(needsListening)
      : value && typeof value === 'object' ? value.unverified === true || Object.values(value).some(needsListening) : false;
  return row?.delete_audio_after_transcription === true && row.audio_delete_reason === 'completed_transcript_saved_call'
    && row.transcription_complete === true && row.status === 'done' && row.audio_quality === 'clear' && Number.isFinite(Date.parse(row.transcribed_at))
    && typeof row.summary === 'string' && !!row.summary.trim() && Array.isArray(row.transcript)
    && row.transcript.some((turn) => typeof turn?.text === 'string' && !!turn.text.trim())
    && Array.isArray(flags) && flags.every((flag) => flag?.unverified !== true && typeof flag?.evidence === 'string' && !!flag.evidence.trim())
    && !needsListening(row.suggestions);
}

// This cannot invalidate an upload or a saved call. The server checks exact
// attachment and policy; failures remain eligible for the existing sweep.
export async function finalizeRecordingAudio(recordingId, callLogId) {
  if (!recordingId || !callLogId) return null;
  try {
    const { data, error } = await getSupabase().functions.invoke('call-recording-finalize', {
      body: { recording_id: recordingId, call_log_id: callLogId },
    });
    if (error || !data?.ok) return { state: 'pending' };
    return data.cleanup || { state: 'pending' };
  } catch { return { state: 'pending' }; }
}

async function invokeTranscribe(recordingId) {
  const { data, error } = await getSupabase().functions.invoke('call-transcribe', { body: { recording_id: recordingId } });
  if (!error) return data;
  let body = null;
  try { body = await error.context?.json?.(); } catch { /* not json */ }
  if (body) return body;
  throw new Error('The transcript service could not be reached. Your recording is saved; tap Try again.');
}

// ---------------------------------------------------------------- before the call
function savedPhone() { try { return localStorage.getItem(PHONE_KEY) || ''; } catch { return ''; } }
function savePhone(k) { try { localStorage.setItem(PHONE_KEY, k); } catch { /* private mode */ } }

function phoneTipHTML(k) {
  const p = PHONES[k];
  if (!p) return '<p style="font:var(--t-xs);color:var(--ink-3);margin:0">Turn on automatic recording in your phone once, and every call records by itself.</p>';
  return `<p style="font:var(--t-xs);color:var(--ink-3);margin:0">${k === 'iphone'
    ? 'iPhone: tap the record button on the call screen once they agree.'
    : `${esc(p.label.split(' (')[0])}: your phone records by itself once automatic recording is on.`}</p>`;
}

// The phone picker and its steps, in any container: its own modal from the
// Calling Portal, or inside the recording box when the box itself sits in a
// modal (Edit call, Log a call), where opening a second modal would close the form.
function guideHTML() {
  const current = savedPhone();
  return `<p style="margin:0 0 12px;color:var(--ink-2)">Which phone do you call from? You do this once.</p>
    ${Object.entries(PHONES).map(([k, p]) => `
    <button type="button" class="btn ${k === current ? 'btn-primary' : 'btn-secondary'} rec-phone" data-phone="${k}" style="width:100%;justify-content:flex-start;text-align:left;margin-bottom:8px;white-space:normal;height:auto">${esc(p.label)}</button>`).join('')}
    <div class="rec-steps"></div>`;
}
function wireGuide(box, onChosen = null) {
  const show = (k) => {
    const p = PHONES[k]; if (!p) return;
    savePhone(k);
    box.querySelectorAll('.rec-phone').forEach((b) => { b.className = `btn ${b.dataset.phone === k ? 'btn-primary' : 'btn-secondary'} rec-phone`; });
    const steps = box.querySelector('.rec-steps');
    if (steps) steps.innerHTML = `
      <ol style="list-style:decimal;margin:12px 0 8px 18px;padding:0;color:var(--ink-2)">${p.steps.map((s) => `<li style="margin-bottom:6px">${esc(s)}</li>`).join('')}</ol>
      <p style="font:var(--t-xs);color:var(--ink-3);margin:0">${esc(p.after)}</p>`;
    onChosen?.(k);
  };
  box.querySelectorAll('.rec-phone').forEach((b) => b.addEventListener('click', () => show(b.dataset.phone)));
  const current = savedPhone();
  if (current) show(current);
}

export function openRecordingSetupGuide(onChosen = null) {
  const overlay = showModal({ title: 'Record calls on your phone', content: guideHTML() });
  wireGuide(overlay, onChosen);
}

// The first tap on a number in this call opens the reminder; its two buttons
// are real tel: links, so dialling works exactly as the tapped number did
// (the Android app, Chrome and Safari all handle a tel: link the same way).
//   links    the tel: anchors to guard
//   ctx      { get(): rec, set(rec), onDial() }
export function guardDialLinks(links, ctx) {
  links.forEach((a) => a.addEventListener('click', (e) => {
    const rec = ctx.get();
    if (rec.reminded) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    openReminder(a.getAttribute('href') || '', ctx);
  }, true));
}

async function openReminder(href, ctx) {
  const before = ctx.get();
  // Some callers return a fresh blank object until the first state write.
  // Persist that same object so the async policy read can detect a changed call.
  ctx.set(before);
  const notice = await currentRecordingConsentNotice();
  if (ctx.get() !== before) return; // changed family/call while the policy loaded
  const phone = savedPhone();
  const tel = esc(href);
  const overlay = showModal({
    title: 'Before you call: recording',
    content: `
      <p style="margin:0 0 8px;color:var(--ink-2)">When they pick up, ask first:</p>
      <p style="margin:0 0 8px;padding:10px 12px;background:var(--surface-3);border-radius:var(--r-sm);color:var(--ink)">“${esc(notice.en)}”</p>
      <p lang="hi-Latn" style="margin:0 0 10px;padding:10px 12px;background:var(--surface-3);border-radius:var(--r-sm);color:var(--ink)">“${esc(notice.hi)}”</p>
      <p style="font:var(--t-xs);color:var(--ink-2);margin:0 0 8px">If they agree, keep recording on. If they say no, stop the recording, or delete it from your phone after the call.</p>
      ${phoneTipHTML(phone)}
      <button type="button" class="btn btn-ghost btn-sm" id="rec-howto" style="margin-top:6px;gap:6px">${icon('info')}How to turn on recording on this phone</button>`,
    footer: `
      <a class="btn btn-secondary" id="rec-call-off" href="${tel}">Call without recording</a>
      <a class="btn btn-primary" id="rec-call-on" href="${tel}">${icon('phone')}Call now</a>`,
  });
  overlay.querySelector('#rec-howto')?.addEventListener('click', () => openRecordingSetupGuide());
  const go = (intent) => () => {
    ctx.set({ ...ctx.get(), reminded: true, intent, dialedAt: Date.now(), wordingVersion: notice.version });
    ctx.onDial();
    setTimeout(() => closeModal(), 300);   // after the link has been followed
  };
  overlay.querySelector('#rec-call-on')?.addEventListener('click', go('record'));
  overlay.querySelector('#rec-call-off')?.addEventListener('click', go('off'));
}

// ---------------------------------------------------------------- after the call
// ctx: { patientId, get(): rec, set(rec), consentOnFile(): bool,
//        callSeconds(): number, apply(result): string[] (labels filled),
//        callAt?(): ms of the logged call, for the right-file check when there was no dial,
//        consentHint?: where the general consent question is on this form,
//        inline?: true when the box sits inside a modal (Edit call, Log a call):
//                 the setup steps, "are you sure?" and the transcript then open
//                 inside the box, because a second modal would close the form }
// Returns { refresh() } for when the general consent changes.
export function mountRecordingSection(el, ctx) {
  if (!el) return { refresh() {}, dispose() {} };
  let pendingFile = null;      // picked but not uploaded yet (a check asked first)
  let pendingProblems = [];
  let pendingConfirm = null;   // inline "are you sure?": { text, label, run }
  let guideOpen = false;       // inline setup steps
  let busy = false;
  let disposed = false;        // the call moved on: late answers must not touch the next family's form
  let selectionEpoch = 0;     // a slow duration check must not replace a newer selection
  let measurementBox = null;
  // A notice already read on this call keeps its original version through a
  // reload. Older drafts without a version remain v1, never silently opted in.
  let consentNotice = ctx.get().wordingVersion === CONSENT_WORDING_VERSION
    ? recordingConsentNotice({ completion_cleanup_enabled: true, wording_version: CONSENT_WORDING_VERSION, max_audio_days: 90 })
    : ctx.get().reminded ? { ...LEGACY_CONSENT } : null;
  const measurementStates = new Map(); // private to this mounted call, never an automatic write
  const sb = getSupabase();
  const inline = !!ctx.inline;
  const sessionMode = !!ctx.sessionId;
  if (sessionMode) consentNotice = null; // Never fall back to a phone-call notice.
  let noticeError = '';
  const transcriptAccount = recordingViewIdentity(), transcriptRoute = window.location.hash;
  const transcriptOwner = recordingAuth.getCurrentUser?.()?.id;
  let transcriptRead = null, transcriptSubscription, transcriptObserver;
  const transcriptContextChanged = () => {
    if (disposed) return;
    if (el.isConnected && transcriptAccount === recordingViewIdentity() && transcriptRoute === window.location.hash) return;
    dispose();
    if (el.isConnected) el.innerHTML = '<p role="status">Open the recording again from your current account.</p>';
  };
  function dispose() {
    if (disposed) return;
    disposed = true; transcriptRead = null; transcripts.clear(); measurementBox?.dispose();
    transcriptSubscription?.unsubscribe?.(); transcriptObserver?.disconnect();
    window.removeEventListener('hashchange', transcriptContextChanged);
  }
  // A question before something that cannot be undone: a modal on the portal, inside the box in a modal.
  const confirmFirst = (text, label, run, title) => {
    if (!inline) { confirmModal(text, run, { title, confirmLabel: label }); return; }
    pendingConfirm = { text, label, run };
    render();
  };

  const update = (patch) => { if (disposed) return; ctx.set({ ...ctx.get(), ...patch }); render(); };

  function card(inner, tone = 'neutral') {
    const border = tone === 'ok' ? 'var(--ok)' : tone === 'warn' ? 'var(--gold)' : tone === 'danger' ? 'var(--danger)' : 'var(--line)';
    const bg = tone === 'ok' ? 'var(--ok-soft)' : tone === 'warn' ? 'var(--gold-soft)' : 'var(--surface-2, var(--surface))';
    const rec = ctx.get();
    const local = rec.sharedRecording ? `<p style="font:var(--t-xs);color:var(--ink-2);margin:8px 0 0">${rec.sharedRecording.legacy ? 'This older shared copy cannot be safely removed automatically. Ask your team lead about legacy app-storage cleanup.' : 'The app-held shared copy is available here for six hours, or until upload and saved-call attachment are confirmed. Expired copies are cleared when the Navigator next checks them.'} The original in Phone or Files must be deleted manually.${rec.sharedCleanupError ? ` ${esc(rec.sharedCleanupError)}` : ''}</p>` : '';
    return `<div class="followup rec-card" style="border-color:${border};background:${bg};padding:12px 14px">
      <div class="fu-head">${icon('mic')}<span>${sessionMode ? 'Session recording' : 'Call recording'}</span></div>${inner}${local}</div>`;
  }

  function render() {
    if (disposed) return;
    measurementBox?.dispose(); measurementBox = null;
    const rec = ctx.get();
    const btn = (id, label, kind = 'btn-secondary', ico = '') => `<button type="button" class="btn ${kind} btn-sm" id="${id}" style="gap:6px">${ico ? icon(ico) : ''}${label}</button>`;
    const small = (t, color = 'var(--ink-3)') => `<p style="font:var(--t-xs);color:${color};margin:6px 0 0">${t}</p>`;
    const howto = `<button type="button" class="btn btn-ghost btn-sm" id="rec-howto" style="gap:6px;padding-left:0;white-space:normal;height:auto;text-align:left">${icon('info')}How to turn on recording on your phone</button>`;

    if (pendingConfirm) {
      el.innerHTML = card(`
        <p style="font:var(--t-xs);color:var(--ink-2);margin:6px 0 10px"><strong>${esc(pendingConfirm.text)}</strong></p>
        <div style="display:flex;gap:8px;flex-wrap:wrap">${btn('rec-confirm-no', 'Keep it')}${btn('rec-confirm-yes', esc(pendingConfirm.label), 'btn-danger')}</div>`, 'warn');
      el.querySelector('#rec-confirm-no')?.addEventListener('click', () => { pendingConfirm = null; render(); });
      el.querySelector('#rec-confirm-yes')?.addEventListener('click', async () => { const run = pendingConfirm?.run; pendingConfirm = null; render(); await run?.(); });
      return;
    }

    if (!rec.decision) {
      el.innerHTML = card(`
        ${!rec.reminded ? consentNotice ? `<details ${sessionMode ? 'open' : ''} style="font:var(--t-xs);margin:6px 0 8px"><summary>If you have not read the recording notice, ask before choosing Yes</summary><p>${esc(consentNotice.en)}</p><p lang="hi-Latn">${esc(consentNotice.hi)}</p></details>` : small('Checking the recording notice...') : ''}
        <p style="font:var(--t-xs);color:var(--ink-2);margin:6px 0 10px">Did the family agree to this ${sessionMode ? 'session' : 'call'} being recorded?${rec.intent === 'off' ? ' You chose to call without recording.' : ''}</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap">${consentNotice ? btn('rec-yes', 'Yes, they agreed', 'btn-primary') : ''}${!sessionMode || consentNotice ? btn('rec-no', 'No') : ''}</div>
        ${small(sessionMode ? noticeError || 'Recording is optional. You can save human-written session notes without it.' : 'Not recorded, or nobody picked up? Leave this and log the call as usual.')}
        ${sessionMode ? '' : howto}`);
    } else if (rec.decision === 'declined') {
      el.innerHTML = card(`
        <p style="font:var(--t-xs);color:var(--ink-2);margin:6px 0 8px"><strong>The family said no.</strong> Do not upload anything. If your phone recorded this call, delete that recording from your phone.</p>
        ${btn('rec-change', 'Change the answer', 'btn-ghost')}`, 'warn');
    } else if (!ctx.consentOnFile()) {
      el.innerHTML = card(`
        <p style="font:var(--t-xs);color:var(--ink-2);margin:6px 0 8px">They agreed to the recording. Before it can be saved, they must also agree to us keeping notes: ${esc(ctx.consentHint || 'ask the consent question above first.')}</p>
        ${btn('rec-change', 'Change the answer', 'btn-ghost')}`, 'warn');
    } else if (pendingFile) {
      el.innerHTML = card(`
        <p style="font:var(--t-xs);color:var(--ink-2);margin:6px 0 6px"><strong>Is this the right recording?</strong> ${esc(pendingFile.name)}</p>
        <ul style="list-style:disc;margin:0 0 10px 18px;padding:0;font:var(--t-xs);color:var(--ink-2)">${pendingProblems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
        <div style="display:flex;gap:8px;flex-wrap:wrap">${btn('rec-anyway', 'Use it anyway', 'btn-secondary')}${btn('rec-repick', 'Pick another', 'btn-primary')}</div>`, 'warn');
    } else if (!rec.recordingId || rec.status === 'upload_failed' || rec.status === 'interrupted') {
      const note = rec.status === 'upload_failed' ? small(`The upload failed: ${esc(rec.error || 'no connection')}. Pick the file again.`, 'var(--danger)')
        : rec.status === 'interrupted' ? small('The upload was interrupted. Pick the file again.', 'var(--danger)') : '';
      el.innerHTML = card(`
        <p style="font:var(--t-xs);color:var(--ink-2);margin:6px 0 10px">${sessionMode ? 'They agreed. Capture audio below or upload this session\'s complete recording. Review the AI draft before choosing to use it.' : 'They agreed. Upload the recording your phone saved: a transcript and suggested answers fill this form for you to check.'}</p>
        <label class="btn btn-primary btn-sm" style="gap:6px;cursor:pointer">${icon('upload')}Upload recording
          <input type="file" id="rec-file" accept="audio/*,.m4a,.mp3,.wav,.aac,.ogg,.opus,.webm" hidden /></label>
        ${note}${sessionMode ? '' : phoneTipHTML(savedPhone())}
        <div style="display:flex;gap:4px;flex-wrap:wrap">${sessionMode ? '' : howto}${btn('rec-change', 'Change the answer', 'btn-ghost')}</div>
        <div id="rec-shared"></div>`);
    } else if (rec.status === 'uploading' || rec.status === 'transcribing') {
      el.innerHTML = card(`
        <div style="display:flex;align-items:center;gap:10px;margin-top:8px"><span class="spinner" style="width:18px;height:18px;border-width:2.5px"></span>
          <span style="font:var(--t-xs);color:var(--ink-2)" role="status">${rec.status === 'uploading' ? `Uploading ${esc(rec.fileName)}...` : 'Listening to the call. This takes about 10 to 40 seconds; you can keep filling the form.'}</span></div>`);
    } else if (rec.status === 'done' && rec.result) {
      const r = rec.result;
      const filled = sessionMode ? 'Your human notes were kept. Review this AI draft and the transcript before using any of it.' : r.auto_apply === false ? 'Nothing was filled automatically. Listen, check the transcript and write the verified notes in the form.' : (rec.applied || []).length ? `Filled in below: ${esc(rec.applied.join(', '))}. Check them before you save.` : 'Nothing new to fill in: the form already had your answers.';
      const note = noteHTML(r);
      // Only when it was actually filled: a condition she had already chosen is never replaced.
      const critical = r.suggestions?.condition?.value === 'critical' && r.suggestions.condition.unverified
        && (rec.applied || []).includes('How the patient is doing')
        ?`<p style="font:var(--t-xs);color:var(--danger);font-weight:600;margin:6px 0 4px">"Critical" was filled in from words the AI could not match exactly. Listen to the recording before you save: a critical call alerts a supervisor.</p>` : '';
      el.innerHTML = card(`
        <p style="font:var(--t-xs);color:var(--ink-3);margin:6px 0 4px">Written by AI from the recording, not checked by a person.</p>${critical}
        ${recordingReviewHTML(r)}
        ${note || `<p style="font:var(--t-xs);color:var(--ink-2);margin:0 0 8px">${r.quality === 'no_speech' ? 'No conversation was heard in this recording.' : 'No call note could be made from this recording.'}</p>`}
        <p style="font:var(--t-xs);color:var(${r.auto_apply === false ? '--ink-2' : '--ok'});margin:0 0 8px">${filled}</p>
        ${transcripts.has(rec.recordingId)
          ? `<details open><summary style="cursor:pointer;font:var(--t-xs);color:var(--ink-2)">Show the transcript (${transcripts.get(rec.recordingId).length} turns${r.language ? `, ${esc(r.language)}` : ''})</summary>
          <div style="max-height:260px;overflow-y:auto;margin-top:6px">${transcripts.get(rec.recordingId).map((t) => `<p style="font:var(--t-xs);margin:0 0 4px"><strong>${t.speaker === 'caller' ? 'You' : t.speaker === 'family' ? 'Family' : 'Someone'}:</strong> ${esc(t.text)}</p>`).join('')}</div></details>`
          : btn('rec-read', 'Read the transcript', 'btn-ghost', 'fileText')}
        <div id="rec-measurements"></div>
        ${btn('rec-remove', 'Remove recording', 'btn-ghost', 'trash')}`, r.review?.required ? 'warn' : 'ok');
    } else if (rec.status === 'saved') {
      el.innerHTML = card(`
        <p style="font:var(--t-xs);color:var(--ink-2);margin:6px 0 8px"><strong>Recording saved.</strong> ${esc(rec.error || 'No transcript was made; fill the log by hand.')}</p>
        ${btn('rec-remove', 'Remove recording', 'btn-ghost', 'trash')}`, 'ok');
    } else {   // failed
      el.innerHTML = card(`
        <p style="font:var(--t-xs);color:var(--danger);margin:6px 0 8px">${esc(rec.error || 'The transcript could not be made.')}</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap">${btn('rec-retry', 'Try again', 'btn-primary', 'refresh')}${btn('rec-remove', 'Remove recording', 'btn-ghost', 'trash')}</div>`, 'warn');
    }
    if (inline && guideOpen && el.querySelector('#rec-howto')) {
      const g = document.createElement('div');
      g.className = 'rec-guide';
      g.style.cssText = 'margin-top:10px;padding-top:10px;border-top:1px solid var(--line)';
      g.innerHTML = guideHTML();
      el.querySelector('.rec-card')?.appendChild(g);
      wireGuide(g);
    }
    wire();
    const measurements = rec.result?.suggestions?.measurements;
    if (!sessionMode && rec.status === 'done' && rec.decision === 'agreed' && ctx.consentOnFile()
        && rec.recordingId && Array.isArray(measurements) && measurements.length) {
      if (!measurementStates.has(rec.recordingId)) measurementStates.set(rec.recordingId, {});
      measurementBox = mountCallMeasurements(el.querySelector('#rec-measurements'), ctx.patientId, {
        suggestions: measurements, recordingId: rec.recordingId, state: measurementStates.get(rec.recordingId), sb,
        allowed: () => sameRecording(rec.recordingId) && ctx.get().decision === 'agreed' && ctx.consentOnFile(),
        onStateChanged: () => { if (sameRecording(rec.recordingId)) render(); },
      });
    }
  }

  async function answer(decision) {
    if (busy) return; busy = true;
    try {
      if (sessionMode && !consentNotice) throw new Error('Reopen the session to check the current recording notice.');
      const wordingVersion = consentNotice?.version || LEGACY_CONSENT.version;
      const { data, error } = await sb.rpc(sessionMode ? 'record_session_consent128' : 'record_call_recording_consent',
        { ...(sessionMode ? { p_session_id: ctx.sessionId } : { p_patient_id: ctx.patientId }), p_decision: decision, p_wording_version: wordingVersion });
      if (error) throw error;
      update({ consentId: data, decision, wordingVersion });
    } catch (e) {
      showToast(`Could not save the answer: ${e.message}`, 'error', 7000);
    } finally { busy = false; }
  }

  // After any wait the caller may have moved on (Skip, a flag, the next family)
  // or removed the recording: is this box still about the same answer, the
  // same recording? If not, a late reply fills nothing and writes nothing.
  const sameConsent = (consentId) => !disposed && !!consentId && ctx.get().consentId === consentId;
  const sameRecording = (recordingId) => !disposed && !!recordingId && ctx.get().recordingId === recordingId;
  // Transcripts stay on the server: the active-call draft (localStorage) never
  // holds one. This page keeps the last one in memory to show it.
  const transcripts = new Map();

  async function changeAnswer() {
    const rec = ctx.get();
    if (rec.recordingId) {
      confirmFirst('Remove the uploaded recording and answer again?', 'Remove and change', async () => {
        if (await removeRecording()) update({ decision: null, consentId: null });
      }, 'Change the answer');
      return;
    }
    update({ decision: null, consentId: null });
  }

  async function picked(file, shareRef = null) {
    if (!file || disposed || busy || ctx.get().decision !== 'agreed' || !ctx.consentOnFile()) return;
    if (sessionMode && ctx.get().recordingId && !['upload_failed','interrupted'].includes(ctx.get().status)) {
      showToast('Remove the current draft recording before choosing another.', 'warning'); return;
    }
    const selection = ++selectionEpoch;
    const type = canonicalAudioType(file.name, file.type);
    if (!type) {
      const ext = (file.name.split('.').pop() || '').toLowerCase();
      showToast(`This file (.${ext}) cannot be read. Pick the recording your phone saved (m4a, mp3, wav, aac or ogg).`, 'warning', 8000);
      return;
    }
    const consentId = ctx.get().consentId;
    const sharedRecording = shareRef ? { id: shareRef.id, key: shareRef.key, legacy: !!shareRef.legacy,
      sharedAt: shareRef.sharedAt, patientId: ctx.patientId, uploaderId: getCurrentProfile()?.id } : null;
    update({ sharedRecording, sharedUploadDurable: false, sharedCleanupError: null });
    if (sharedRecording && !sharedRecording.legacy) {
      try { await createSharedRecordingStore().bind(sharedRecording, { consentId, patientId: ctx.patientId, uploaderId: sharedRecording.uploaderId }); }
      catch { update({ sharedCleanupError: 'Local retry metadata could not be saved; the shared copy is kept.' }); }
    }
    const measuredDuration = await readAudioDuration(file);
    const durationS = Number.isFinite(measuredDuration) && measuredDuration > 0 ? measuredDuration
      : sessionMode && Number.isFinite(file.captureDurationSeconds) ? file.captureDurationSeconds : measuredDuration;
    if (!sameConsent(consentId) || selection !== selectionEpoch) return;
    const rec = ctx.get();
    // No dial in the Navigator (a logged call reopened, a call back): measured from when the call was logged.
    const loggedAt = rec.dialedAt ? null : (ctx.callAt?.() || null);
    const check = checkRecordingFile({ lastModified: file.lastModified, durationS, dialedAt: rec.dialedAt, loggedAt, callSeconds: ctx.callSeconds() });
    file._jcf = { type, durationS, sharedRecording };
    if (!check.ok) { pendingFile = file; pendingProblems = check.problems; render(); return; }
    await upload(file);
  }

  async function upload(file) {
    if (busy) return; busy = true;
    pendingFile = null; pendingProblems = [];
    const rec = ctx.get();
    const consentId = rec.consentId;
    const { type, durationS, sharedRecording = null } = file._jcf || { type: canonicalAudioType(file.name, file.type), durationS: null };
    if (sharedRecording && !sharedRecording.legacy && Date.now() - sharedRecording.sharedAt > SHARE_TTL_MS) {
      await createSharedRecordingStore().discard(sharedRecording);
      busy = false;
      update({ sharedRecording: null, sharedUploadDurable: false, sharedCleanupError: null });
      showToast('That app-held shared copy has expired. Choose the original recording from Phone or Files if it should still be uploaded.', 'warning', 9000);
      return;
    }
    // An earlier try that never got its file: its row goes first (the sweep would take it anyway).
    if (rec.recordingId && (rec.status === 'upload_failed' || rec.status === 'interrupted')) {
      try { await sb.rpc('discard_call_recording', { p_recording_id: rec.recordingId }); } catch { /* the sweep takes it */ }
      if (!sameConsent(consentId)) { busy = false; return; }
      ctx.set({ ...ctx.get(), recordingId: null, path: null });
    }
    update({ status: 'uploading', fileName: file.name, durationS: durationS || null, error: null, sharedRecording, sharedUploadDurable: false });
    try {
      const { data: opened, error } = await sb.rpc('start_call_recording', {
        p_consent_id: consentId, p_file_name: file.name, p_mime_type: type, p_size_bytes: file.size,
        p_duration_seconds: durationS ? Math.round(durationS) : null,
        p_file_modified_at: file.lastModified ? new Date(file.lastModified).toISOString() : null,
      });
      if (error) throw error;
      if (!sameConsent(consentId)) { busy = false; return; }
      update({ recordingId: opened.id, path: opened.path });
      const sharedBinding = { consentId, recordingId: opened.id, path: opened.path,
        patientId: sharedRecording?.patientId, uploaderId: sharedRecording?.uploaderId };
      if (sharedRecording && !sharedRecording.legacy) {
        try { await createSharedRecordingStore().bind(sharedRecording, { ...sharedBinding, uploaded: false }); }
        catch { if (sameRecording(opened.id)) update({ sharedCleanupError: 'Local retry metadata could not be saved; the shared copy is kept.' }); }
      }
      // Sent with the canonical type: a File keeps its own (Android often gives
      // none at all), and the bucket accepts only audio types it knows.
      const body = new Blob([file], { type: opened.content_type });
      const { error: upErr } = await sb.storage.from(BUCKET).upload(opened.path, body, { contentType: opened.content_type, upsert: false });
      if (upErr) throw upErr;
      if (sharedRecording && !sharedRecording.legacy) {
        try { await createSharedRecordingStore().bind(sharedRecording, { ...sharedBinding, uploaded: true }); }
        catch { if (sameRecording(opened.id)) update({ sharedCleanupError: 'Upload succeeded. Local cleanup metadata could not be saved; the shared copy is kept.' }); }
      }
      if (sameRecording(opened.id)) update({ sharedUploadDurable: true });
      busy = false;
      if (sameRecording(opened.id)) await transcribe();
    } catch (e) {
      busy = false;
      if (sameConsent(consentId)) update({ status: 'upload_failed', error: e.message });
    }
  }

  async function transcribe(tries = 0) {
    const id = ctx.get().recordingId;
    if (!id) return;
    update({ status: 'transcribing', error: null });
    let res;
    try { res = await invokeTranscribe(id); }
    catch (e) { if (sameRecording(id)) update({ status: 'failed', error: e.message }); return; }
    if (!sameRecording(id)) return;   // moved on or removed meanwhile: fill nothing
    if (res?.ok) {
      transcripts.set(id, res.transcript || []);
      // note: the full call note by section (prompt v3); summary: the same note as the text the log keeps.
      const result = recordingResultForForm(res, ctx.get().durationS || null);
      let applied = [];
      try { if(!sessionMode && result.auto_apply !== false) applied = ctx.apply(result) || []; } catch (e) { console.warn('[recording] could not fill the form:', e); }
      update({ status: 'done', result, applied });
      return;
    }
    if (res?.running && tries < 12) { setTimeout(() => { if (sameRecording(id)) transcribe(tries + 1); }, 4000); return; }
    if (res?.off) { update({ status: 'saved', error: res.reason }); return; }
    if (res?.missing) { update({ status: 'interrupted', error: null }); return; }
    if (res?.gone) {
      update({ recordingId: null, path: null, fileName: '', status: null, error: null, result: null, applied: null });
      showToast('That recording was removed, so nothing was filled in.', 'info');
      return;
    }
    update({ status: 'failed', error: res?.reason || 'The transcript could not be made.' });
  }

  // True when the file and its row are gone. A failed remove leaves the answer as it was.
  async function removeRecording() {
    const rec = ctx.get();
    if (!rec.recordingId) return true;
    try {
      if (rec.path) {
        const { error: rmErr } = await sb.storage.from(BUCKET).remove([rec.path]);
        if (rmErr) throw rmErr;
      }
      const { error } = await sb.rpc('discard_call_recording', { p_recording_id: rec.recordingId });
      if (error) throw error;
      transcripts.delete(rec.recordingId);
      ctx.set({ ...ctx.get(), recordingId: null, path: null, fileName: '', status: null, error: null, result: null, applied: null,
        sharedRecording: null, sharedUploadDurable: false, sharedCleanupError: null });
      showToast('Recording removed', 'success');
      render();
      return true;
    } catch (e) {
      showToast(`Could not remove it: ${e.message}`, 'error', 7000);
      render();
      return false;
    }
  }

  // A recording shared into the app from the Phone app waits in the service
  // worker's cache: offer it here, through the same right-file check.
  async function offerShared() {
    const file = await takeSharedRecording();
    const slot = el.querySelector('#rec-shared');
    if (!file || disposed || !slot) return;
    const ref = file._jcfShared;
    // A previous cleanup may have failed after a successful saved-call attach.
    // Recover only from this share's persisted binding and exact server rows.
    if (ref?.binding?.recordingId && ref.binding.path && ref.binding.consentId) {
      const binding = { ...ref.binding };
      try {
        const { data: row, error } = await sb.from('call_recordings').select('call_log_id').eq('id', binding.recordingId).maybeSingle();
        if (error) throw error;
        if (row?.call_log_id) {
          const result = await createSharedRecordingStore().cleanupAttached(ref, { ...binding, callLogId: row.call_log_id }, verifySharedAttachment);
          if (disposed || !slot.isConnected) return;
          slot.textContent = result.cleaned ? `${result.alreadyAbsent ? 'The selected app-held shared copy is no longer present.' : 'App-held shared copy removed after the saved call was verified.'} Delete the original in Phone or Files manually.` : result.reason;
          return;
        }
      } catch { /* unverified: retain bytes and offer the ordinary file check */ }
    }
    slot.innerHTML = `
      <div style="margin-top:10px;padding:10px 12px;border:1px dashed var(--line);border-radius:var(--r-sm)">
        <p style="font:var(--t-xs);color:var(--ink-2);margin:0 0 8px"><strong>A recording was shared to the Navigator:</strong> ${esc(file.name)}, ${esc(fmtWhen(file.lastModified))}. Attach it to this call?</p>
        <p style="font:var(--t-xs);margin:0 0 8px">${ref?.legacy ? 'This older shared copy cannot be safely removed automatically; ask your team lead about legacy app-storage cleanup.' : 'This app-held copy is available here for six hours; expired copies are cleared when the Navigator next checks them. After a confirmed saved-call attachment, only this app copy is removed.'} Delete the original in Phone or Files manually.</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button type="button" class="btn btn-primary btn-sm" id="rec-shared-use">Attach it</button>
          <button type="button" class="btn btn-ghost btn-sm" id="rec-shared-drop">Not this one</button></div></div>`;
    slot.querySelector('#rec-shared-use').addEventListener('click', () => picked(file, ref));
    slot.querySelector('#rec-shared-drop').addEventListener('click', async () => {
      const result = await createSharedRecordingStore().discard(ref);
      if (result.cleaned) slot.innerHTML = '';
      else slot.textContent = result.reason;
    });
  }

  function wire() {
    if (el.querySelector('#rec-shared')) offerShared();
    el.querySelector('#rec-yes')?.addEventListener('click', () => answer('agreed'));
    el.querySelector('#rec-no')?.addEventListener('click', () => answer('declined'));
    el.querySelector('#rec-change')?.addEventListener('click', changeAnswer);
    el.querySelector('#rec-howto')?.addEventListener('click', () => {
      if (inline) { guideOpen = !guideOpen; render(); return; }
      openRecordingSetupGuide(() => render());
    });
    el.querySelector('#rec-file')?.addEventListener('change', (e) => picked(e.target.files?.[0]));
    el.querySelector('#rec-anyway')?.addEventListener('click', () => { const f = pendingFile; if (f) upload(f); });
    el.querySelector('#rec-repick')?.addEventListener('click', () => { pendingFile = null; pendingProblems = []; render(); el.querySelector('#rec-file')?.click(); });
    el.querySelector('#rec-retry')?.addEventListener('click', () => transcribe());
    el.querySelector('#rec-read')?.addEventListener('click', async () => {
      const id = ctx.get().recordingId;
      const alive = () => sameRecording(id) && el.isConnected && transcriptAccount === recordingViewIdentity()
        && transcriptRoute === window.location.hash;
      if (!alive() || transcriptRead) return;
      if (!inline) { void openRecordingViewer(id); return; }
      const operation = {}, button = el.querySelector('#rec-read'); transcriptRead = operation;
      const current = () => transcriptRead === operation && alive();
      button.disabled = true; button.textContent = 'Opening transcript...';
      try {
        const response = await recordingRead(sb.from('call_recordings').select('transcript').eq('id', id).maybeSingle());
        if (!current()) return;
        if (response?.error || !Array.isArray(response?.data?.transcript)) throw new Error('recording_unavailable');
        transcripts.set(id, response.data.transcript); render();
      } catch {
        if (current()) showToast('The saved transcript could not be opened. Your form is kept. Check your connection or access and try again.', 'warning');
      } finally {
        const owned = current(); if (transcriptRead === operation) transcriptRead = null;
        if (owned && button.isConnected) { button.disabled = false; button.textContent = 'Read the transcript'; }
      }
    });
    el.querySelector('#rec-remove')?.addEventListener('click', () => confirmFirst('Remove this recording? The transcript goes with it.', 'Remove',
      removeRecording, 'Remove recording'));
  }

  // A reload in the middle (the phone's file picker can reload the page): ask
  // the server, which knows whether the file arrived. Arrived: the transcript
  // goes ahead. Not arrived: "interrupted, pick it again".
  const start = ctx.get();
  render();
  if (!consentNotice && !start.decision) {
    if (sessionMode) Promise.resolve(sb.rpc('session_recording_policy128', { p_session_id: ctx.sessionId })).then(({ data, error }) => {
      if (disposed) return;
      if (error || data?.available !== true || data.wording_version !== SESSION_CONSENT_VERSION128 || data.max_audio_days !== 90) {
        noticeError = 'Recording is unavailable. You can still save human-written notes. Reopen the session to retry.';
      } else consentNotice = { ...SESSION_NOTICE128 };
      render();
    }).catch(() => { if (!disposed) { noticeError = 'The recording notice could not be checked. Save human notes or reopen to retry.'; render(); } });
    else currentRecordingConsentNotice().then((notice) => { if (!disposed) { consentNotice = notice; render(); } });
  }
  if (start.recordingId && (start.status === 'uploading' || start.status === 'transcribing')) transcribe();
  else if (start.status === 'uploading') update({ status: 'interrupted' });
  transcriptSubscription = sb.auth?.onAuthStateChange?.((event, session) => {
    if (event === 'SIGNED_OUT' || transcriptOwner && session?.user?.id && transcriptOwner !== session.user.id) {
      dispose();
      if (el.isConnected) el.innerHTML = '<p role="status">Open the recording again from your current account.</p>';
    } else transcriptContextChanged();
  })?.data?.subscription;
  if (disposed) transcriptSubscription?.unsubscribe?.();
  else {
    window.addEventListener('hashchange', transcriptContextChanged);
    transcriptObserver = new MutationObserver(transcriptContextChanged);
    transcriptObserver.observe(document.body, { childList: true, subtree: true });
  }
  return { refresh: render, dispose, acceptFile: picked };
}

// After the call log is saved: the answer and its recording join it. Never
// blocks the log: a failure is said, and the nightly sweep handles leftovers.
export async function attachRecordingToLog(callLogId, rec) {
  if (!callLogId || !rec?.consentId) return 0;
  const captured = { ...rec, sharedRecording: rec.sharedRecording ? { ...rec.sharedRecording } : null };
  const { data, error } = await getSupabase().rpc('attach_call_recording', { p_call_log_id: callLogId, p_consent_id: captured.consentId });
  if (error) {
    console.warn('[recording] attach failed:', error.message);
    showToast('The call is logged, but its recording could not be attached. Tell your team lead.', 'warning', 8000);
    return 0;
  }
  try {
    const store = createSharedRecordingStore();
    const recovered = captured.sharedRecording ? null : await store.find({ recordingId: captured.recordingId, consentId: captured.consentId });
    const ref = captured.sharedRecording || (recovered ? store.refOf(recovered) : null);
    if (ref) {
      const expected = { ...(recovered?.binding || {}), ...ref, consentId: captured.consentId,
        recordingId: captured.recordingId, path: captured.path, callLogId };
      const result = await store.cleanupAttached(ref, expected, verifySharedAttachment);
      rec.sharedCleanupError = result.cleaned ? null : result.reason;
      showToast(result.cleaned ? `${result.alreadyAbsent ? 'The selected app-held shared copy is no longer present.' : 'App-held shared copy removed.'} Delete the original in Phone or Files manually.`
        : `The call is saved. ${result.reason} Delete the original in Phone or Files manually only after checking the saved recording.`, result.cleaned ? 'info' : 'warning', 10000);
    }
  } catch {
    rec.sharedCleanupError = 'The app-held shared copy could not be checked or removed. It is kept within its six-hour limit.';
    showToast(`The call is saved. ${rec.sharedCleanupError} Delete the original in Phone or Files manually after checking it.`, 'warning', 10000);
  }
  // Local cleanup runs first; the transcription hook or sweep may already
  // have finished cloud cleanup, which the exact readback also recognizes.
  const cleanup = await finalizeRecordingAudio(captured.recordingId, callLogId);
  if (cleanup?.state === 'pending') showToast('The call is saved. Cloud audio cleanup is pending and will be retried; the written note stays with the call.', 'info', 9000);
  return data || 0;
}

// ---------------------------------------------------------------- past calls
// Fills <span class="rec-slot" data-log="<call_log id>"> with a Recording
// button where one exists and the reader may hear it (RLS decides). A slot
// marked data-inline plays inside itself: it sits in a modal already.
export async function decorateRecordings(container) {
  const slots = [...(container?.querySelectorAll('.rec-slot[data-log]') || [])];
  const ids = [...new Set(slots.map((s) => s.dataset.log).filter(Boolean))];
  if (!ids.length) return;
  const { data, error } = await getSupabase().from('call_recordings')
    .select('id, call_log_id, status, audio_deleted_at, audio_delete_reason, delete_audio_after_transcription').in('call_log_id', ids);
  if (error || !data?.length) return;
  const byLog = new Map(data.map((r) => [r.call_log_id, r]));
  for (const slot of slots) {
    const r = byLog.get(slot.dataset.log);
    if (!r) continue;
    const gone = !!r.audio_deleted_at;
    const title = gone ? 'Read the saved transcript and note; the cloud audio was deleted'
      : r.delete_audio_after_transcription ? 'Cloud audio is deleted after a complete clear transcript and saved call; incomplete processing or review keeps it for at most 90 days'
        : 'Protected cloud copy retained for 90 days; this recording uses the original retention policy';
    slot.innerHTML = `<button type="button" class="btn btn-ghost btn-sm" title="${esc(title)}" style="gap:5px;padding:2px 8px">${icon(gone ? 'fileText' : 'play')}${gone ? 'Call note' : 'Cloud recording'}</button>`;
    slot.querySelector('button').addEventListener('click', () => {
      if (slot.dataset.inline) renderRecordingViewer(slot, r.id);
      else openRecordingViewer(r.id);
    });
  }
}

// ---------------------------------------------------------------- a call that is already logged
// Edit call and "Fix that log" (Fixboard #36): the family called back after a
// "No answer", or the recording came later. Only the person who made the call
// adds one (the file is on her phone, and attach_call_recording refuses anyone
// else), within RECORDING_WINDOW_DAYS of it; a call that already has a
// recording shows it instead. The box sits inside the Edit call modal, so it
// runs inline. Returns { attach(), uploading(), dispose() } or null.
//   log: the call_logs row (id, patient_id, caller_id, call_date)
export async function mountLogRecording(el, { log, meId, consentOnFile, callSeconds, apply }) {
  if (!el || !log?.id) return null;
  const sb = getSupabase();
  const note = (html, tone = 'neutral') => {
    const border = tone === 'ok' ? 'var(--ok)' : 'var(--line)';
    el.innerHTML = `<div class="followup rec-card" style="border-color:${border};padding:12px 14px">
      <div class="fu-head">${icon('mic')}<span>Call recording</span></div>${html}</div>`;
  };
  const couldNotCheck = () => note(`<p style="font:var(--t-xs);color:var(--ink-2);margin:6px 0 0">This call's recording could not be checked just now. Close this and open the call again to add one.</p>`);
  const { data: existing, error: exErr } = await sb.from('call_recordings').select('id').eq('call_log_id', log.id).limit(1);
  // Unknown is not "none": offering an upload could put a second recording on the call.
  if (exErr) { couldNotCheck(); return null; }
  if (existing?.length) {
    note(`<p style="font:var(--t-xs);color:var(--ink-2);margin:6px 0 8px">This call already has a recording.</p>
      <div id="rec-inline-viewer"><button type="button" class="btn btn-secondary btn-sm" id="rec-open" style="gap:6px">${icon('fileText')}Open the recording and note</button></div>`, 'ok');
    el.querySelector('#rec-open')?.addEventListener('click', () => renderRecordingViewer(el.querySelector('#rec-inline-viewer'), existing[0].id));
    return null;
  }
  if (log.caller_id !== meId) {
    note(`<p style="font:var(--t-xs);color:var(--ink-2);margin:6px 0 0">Only the person who made this call can add its recording, from their phone.</p>`);
    return null;
  }
  // A "No" saved with this call stands (attach_call_recording refuses a "Yes"
  // after it). Said here, before anything is uploaded or sent to be transcribed.
  const { data: answers, error: ansErr } = await sb.from('call_recording_consents').select('decision').eq('call_log_id', log.id);
  if (ansErr) { couldNotCheck(); return null; }
  if (answers?.some((a) => a.decision === 'declined')) {
    note(`<p style="font:var(--t-xs);color:var(--ink-2);margin:6px 0 0">The family said no to recording on this call, so no recording can be added to it. If they called back and agreed, log the call back as a new call: Log a call, on their page.</p>`);
    return null;
  }
  const at = Date.parse(log.call_date);
  if (!Number.isFinite(at) || Date.now() - at > RECORDING_WINDOW_DAYS * 86_400_000) {
    note(`<p style="font:var(--t-xs);color:var(--ink-2);margin:6px 0 0">A recording can be added within ${RECORDING_WINDOW_DAYS} days of a call. This call was on ${esc(fmtWhen(at))}.</p>`);
    return null;
  }
  let consent = consentOnFile;
  if (typeof consent !== 'function') {
    const { data: p } = await sb.from('patients').select('consent_given').eq('id', log.patient_id).maybeSingle();
    consent = () => !!p?.consent_given;
  }
  let rec = blankRecording();
  const section = mountRecordingSection(el, {
    patientId: log.patient_id, inline: true,
    get: () => rec, set: (r) => { rec = r; },
    consentOnFile: consent, callSeconds, apply,
    callAt: () => at,
    consentHint: "tick their consent on the family's page first (Edit, then Consent), then come back here.",
  });
  return {
    attach: (callLogId) => attachRecordingToLog(callLogId, rec),
    answered: () => !!rec.consentId,
    uploading: () => rec.status === 'uploading',
    dispose: () => section.dispose(),
  };
}

// A recording's player, call note and transcript, in a modal (the portal's
// history) or inside any container (the Edit call modal, which a second modal would close).
// Read ownership is separate from transcription and never changes a saved call.
const recordingViewLoads = new WeakMap();
const recordingViewIdentity = () => JSON.stringify([
  recordingAuth.getCurrentUser?.()?.id, recordingAuth.getRealProfile?.()?.id,
  recordingAuth.getRealProfile?.()?.role, recordingAuth.getRealProfile?.()?.is_active,
  getCurrentProfile()?.id, getCurrentProfile()?.role, recordingAuth.isImpersonating?.(),
]);
async function recordingRead(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('recording_read_timeout')), 8000);
  })]); }
  finally { clearTimeout(timer); }
}

export async function renderRecordingViewer(container, recordingId) {
  if (!container?.isConnected) return null;
  recordingViewLoads.get(container)?.dispose?.();
  const request = {}, account = recordingViewIdentity(), route = window.location.hash;
  const ownerId = recordingAuth.getCurrentUser?.()?.id;
  let ended = false, subscription, observer;
  recordingViewLoads.set(container, request);
  const overlay = container.closest('.modal-overlay');
  const current = () => !ended && container.isConnected && recordingViewLoads.get(container) === request
    && account === recordingViewIdentity() && route === window.location.hash && overlay?.isCurrentModal?.() !== false;
  const end = (hide = false) => {
    if (ended) return;
    ended = true; subscription?.unsubscribe?.(); observer?.disconnect();
    window.removeEventListener('hashchange', changed);
    if (recordingViewLoads.get(container) !== request) return;
    recordingViewLoads.delete(container);
    if (hide && container.isConnected) {
      container.innerHTML = '<p role="status">This recording view has ended. Open it again from your current account.</p>';
      overlay?.closeOwnedModal?.();
    }
  };
  const changed = () => { if (!current()) end(true); };
  request.dispose = () => end();
  const retry = () => { if (current()) void renderRecordingViewer(container, recordingId); };
  const unavailable = () => {
    if (!current()) return;
    container.innerHTML = '<p role="status">The saved recording and transcript could not be opened. Check your connection or access, then try again. No new transcript has been requested.</p><button type="button" class="btn btn-secondary" data-recording-retry>Try again</button>';
    container.querySelector('[data-recording-retry]').addEventListener('click', retry);
  };
  container.innerHTML = '<p role="status">Opening the saved recording and transcript...</p>';
  let sb, r;
  try {
    sb = getSupabase();
    subscription = sb.auth?.onAuthStateChange?.((event, session) => {
      if (event === 'SIGNED_OUT' || account !== recordingViewIdentity()
          || ownerId && session?.user?.id && ownerId !== session.user.id) end(true);
    })?.data?.subscription;
    if (ended) { subscription?.unsubscribe?.(); return null; }
    window.addEventListener('hashchange', changed);
    observer = new MutationObserver(changed);
    observer.observe(document.body, { childList: true, subtree: true });
    const response = await recordingRead(sb.from('call_recordings')
      .select('id, patient_id, care_session_id, storage_path, status, summary, suggestions, transcript, duration_seconds, audio_deleted_at, audio_delete_reason, delete_audio_after_transcription, created_at, language, uploaded_by, transcription_complete, audio_quality, dropped')
      .eq('id', recordingId).maybeSingle());
    if (!current()) return null;
    if (response?.error || !response?.data || response.data.id !== recordingId) { unavailable(); return null; }
    r = response.data;
  } catch { unavailable(); return null; }
  const turns = Array.isArray(r.transcript) ? r.transcript : [];
  // A stale cached client adapter must not fall back to unchecked saved data.
  const saved = savedRecordingRead.recordingResultForRead?.(r);
  if (!saved) { unavailable(); return null; }
  const n = saved.note;
  container.innerHTML = `
      <p style="font:var(--t-xs);color:var(--ink-2);margin:0 0 8px">${r.care_session_id
        ? 'Session audio is deleted after a complete clear transcript and a saved held session. Incomplete processing or review keeps it for at most 90 days. Unsaved uploads are cleared after a day. The transcript and written notes stay with the session.'
        : r.delete_audio_after_transcription
        ? 'This recording uses the new cleanup policy: cloud audio is deleted after a complete clear transcript and a saved call. Incomplete processing or review keeps it for at most 90 days.'
        : 'This recording uses the original policy: the protected cloud audio is retained for 90 days when linked to a saved call.'} ${r.care_session_id ? 'Original files in Phone or Files must be deleted manually.' : 'The transcript and written notes stay with the call. The temporary app-held shared copy is cleaned separately after upload and saved-call attachment. The original in Phone or Files must be deleted manually.'}</p>
      ${r.audio_deleted_at ? `<p style="color:var(--ink-2);margin:0 0 10px">${['completed_transcript_saved_call', 'completed_transcript_saved_session'].includes(r.audio_delete_reason)
        ? `The cloud audio was deleted after the complete transcript and saved ${r.care_session_id ? 'session' : 'call'} were confirmed.`
        : ['kept90days', 'kept 90 days'].includes(r.audio_delete_reason) ? 'The cloud audio was deleted after 90 days.' : 'The cloud audio has been deleted.'} The transcript stays with the ${r.care_session_id ? 'session' : 'call'}.</p>`
        : '<audio id="rec-audio" class="rec-audio" controls preload="none" style="width:100%;margin-bottom:10px"></audio>'}
      <p style="font:var(--t-xs);color:var(--ink-3);margin:0 0 8px">Recorded ${esc(fmtWhen(new Date(r.created_at).getTime()))}${r.duration_seconds ? ` · ${fmtDur(r.duration_seconds)}` : ''}${r.language ? ` · ${esc(r.language)}` : ''}. Only the caller, their managers and admins can open it.</p>
      ${recordingReviewHTML(saved)}
      ${turns.length ? `<details open><summary style="cursor:pointer;font:var(--t-xs);color:var(--ink-2)">The transcript (${turns.length} turns)</summary>
        <div style="max-height:320px;overflow-y:auto;border-top:1px solid var(--line);padding-top:8px;margin-top:6px">${turns.map((t) =>
        `<p style="margin:0 0 6px"><strong>${t.speaker === 'caller' ? 'Caller' : t.speaker === 'family' ? 'Family' : 'Someone'}:</strong> ${esc(t.text)}</p>`).join('')}</div></details>`
        : `<p style="color:var(--ink-3);margin:0">${r.status === 'done' ? 'No saved transcript text is available for this recording.' : 'No transcript yet.'}</p>`}
      ${n || saved.points.length || saved.draft_summary ? `<div style="margin:0 0 10px"><p style="font:var(--t-xs);color:var(--ink-3);margin:0">Call note (AI, not checked by a person):</p>${noteHTML(saved)}${n && saved.show_fallback ? noteHTML({ points: saved.points, draft_summary: saved.draft_summary }) : ''}</div>` : ''}
      <div id="rec-past-measurements"></div><button type="button" class="btn btn-ghost" data-recording-retry>Reload saved recording</button>`;
  container.querySelector('[data-recording-retry]').addEventListener('click', retry);
  if (!r.care_session_id && r.status === 'done' && Array.isArray(r.suggestions?.measurements) && r.suggestions.measurements.length) {
    try {
      const { data: patient } = await recordingRead(sb.from('patients').select('consent_given').eq('id', r.patient_id).maybeSingle());
      if (current() && patient?.consent_given) mountCallMeasurements(container.querySelector('#rec-past-measurements'), r.patient_id, {
        suggestions: r.suggestions.measurements, recordingId, sb, allowed: current,
      });
    } catch {
      if (current()) container.querySelector('#rec-past-measurements').textContent = 'Suggested measurement controls could not be loaded. The saved transcript is still available.';
    }
  }
  if (current() && !r.audio_deleted_at) void wirePlayer(container.querySelector('.rec-audio'), r.storage_path, current);
  return r;
}

export async function openRecordingViewer(recordingId) {
  const overlay = showModal({ title: 'Call recording', size: 'lg', content: '<p style="color:var(--ink-3);margin:0">Opening the recording...</p>' });
  await renderRecordingViewer(overlay.querySelector('.modal-body'), recordingId);
}

async function wirePlayer(audio, storagePath, current = () => true) {
  if (!audio) return;
  const sb = getSupabase();
  const sign = async () => {
    try { return (await recordingRead(sb.storage.from(BUCKET).createSignedUrl(storagePath, SIGNED_URL_SECONDS)))?.data?.signedUrl || null; }
    catch { return null; }
  };
  const url = await sign();
  if (!current() || !document.body.contains(audio)) return;
  if (!url) { audio.outerHTML = '<p style="color:var(--danger);margin:0 0 10px">The audio could not be opened just now. The saved transcript is still available.</p>'; return; }
  audio.src = url;
  let renewals = 0;
  audio.addEventListener('error', async () => {
    if (renewals++ >= 6 || !current() || !document.body.contains(audio)) return;
    const at = audio.currentTime; const playing = !audio.paused;
    const fresh = await sign();
    if (!fresh || !current() || !document.body.contains(audio)) return;
    audio.src = fresh; audio.currentTime = at;
    if (playing) audio.play().catch(() => {});
  });
}
