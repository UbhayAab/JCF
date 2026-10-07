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
import { showToast } from './toast.js';
import { showModal, closeModal, confirmModal } from './modal.js';
import { icon } from './icons.js';

// The consent line, exactly as agreed for Ubhay (chat #533). A change of words
// is a new version: the version is saved with every answer.
export const CONSENT_WORDING_VERSION = 'rec-v1-2026-10-08';
export const CONSENT_LINE_EN = 'May I record this call so I do not miss anything you tell me? Only our care team will listen to it, and the recording is deleted after three months. Is that all right?';
export const CONSENT_LINE_HI = 'Kya hum yeh call record kar sakte hain, taaki aapki koi baat chhoot na jaaye? Ise sirf hamari care team sunegi, aur teen mahine baad recording hata di jaati hai. Kya yeh theek hai?';
// The privacy line families hear with the general consent question.
// Names the computer service, because the audio does leave the team to be written down.
export const PRIVACY_LINE = 'Sometimes we ask to record a call so we do not miss anything. Only our care team listens to it; a computer service (Google) writes it down as notes for them, and the recording is deleted after three months.';

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
  return { reminded: false, intent: null, dialedAt: null, consentId: null, decision: null,
    recordingId: null, path: null, fileName: '', status: null, error: null, result: null, applied: null };
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
//   callSeconds   the call's length from the timer or the typed minutes
export function checkRecordingFile({ lastModified, durationS, dialedAt, callSeconds, now = Date.now() }) {
  const problems = [];
  if (Number.isFinite(lastModified) && lastModified > 0) {
    const earliest = dialedAt ? dialedAt - 2 * MINUTE : now - 6 * 60 * MINUTE;
    if (lastModified < earliest) {
      problems.push(dialedAt
        ? `This recording is from ${fmtWhen(lastModified)}, before this call (you dialled at ${fmtWhen(dialedAt)}).`
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
const SHARE_CACHE = 'jcf-shared-recording';
const SHARED_KEY = './__shared-recording';
const SHARED_MAX_AGE_MS = 6 * 3600 * 1000;

export async function takeSharedRecording() {
  try {
    if (!('caches' in window)) return null;
    const cache = await caches.open(SHARE_CACHE);
    const res = await cache.match(SHARED_KEY);
    if (!res) return null;
    const sharedAt = Number(res.headers.get('X-Shared-At') || 0);
    if (!sharedAt || Date.now() - sharedAt > SHARED_MAX_AGE_MS) { await cache.delete(SHARED_KEY); return null; }
    const blob = await res.blob();
    const name = decodeURIComponent(res.headers.get('X-File-Name') || 'recording');
    // Only an audio file of a sane size is ever offered; anything else is dropped.
    if (!blob.size || blob.size > MAX_SHARED_BYTES || !canonicalAudioType(name, blob.type)) { await cache.delete(SHARED_KEY); return null; }
    return new File([blob], name, { type: blob.type, lastModified: Number(res.headers.get('X-Last-Modified') || sharedAt) });
  } catch { return null; }
}
async function dropSharedRecording() {
  try { await (await caches.open(SHARE_CACHE)).delete(SHARED_KEY); } catch { /* nothing to drop */ }
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

export function openRecordingSetupGuide(onChosen = null) {
  const current = savedPhone();
  const options = Object.entries(PHONES).map(([k, p]) => `
    <button type="button" class="btn ${k === current ? 'btn-primary' : 'btn-secondary'} rec-phone" data-phone="${k}" style="width:100%;justify-content:flex-start;text-align:left;margin-bottom:8px">${esc(p.label)}</button>`).join('');
  const overlay = showModal({
    title: 'Record calls on your phone',
    content: `<p style="margin:0 0 12px;color:var(--ink-2)">Which phone do you call from? You do this once.</p>${options}<div id="rec-steps"></div>`,
  });
  const show = (k) => {
    const p = PHONES[k]; if (!p) return;
    savePhone(k);
    overlay.querySelectorAll('.rec-phone').forEach((b) => { b.className = `btn ${b.dataset.phone === k ? 'btn-primary' : 'btn-secondary'} rec-phone`; });
    overlay.querySelector('#rec-steps').innerHTML = `
      <ol style="list-style:decimal;margin:12px 0 8px 18px;padding:0;color:var(--ink-2)">${p.steps.map((s) => `<li style="margin-bottom:6px">${esc(s)}</li>`).join('')}</ol>
      <p style="font:var(--t-xs);color:var(--ink-3);margin:0">${esc(p.after)}</p>`;
    onChosen?.(k);
  };
  overlay.querySelectorAll('.rec-phone').forEach((b) => b.addEventListener('click', () => show(b.dataset.phone)));
  if (current) show(current);
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

function openReminder(href, ctx) {
  const phone = savedPhone();
  const tel = esc(href);
  const overlay = showModal({
    title: 'Before you call: recording',
    content: `
      <p style="margin:0 0 8px;color:var(--ink-2)">When they pick up, ask first:</p>
      <p style="margin:0 0 8px;padding:10px 12px;background:var(--surface-3);border-radius:var(--r-sm);color:var(--ink)">“${esc(CONSENT_LINE_EN)}”</p>
      <p lang="hi-Latn" style="margin:0 0 10px;padding:10px 12px;background:var(--surface-3);border-radius:var(--r-sm);color:var(--ink)">“${esc(CONSENT_LINE_HI)}”</p>
      <p style="font:var(--t-xs);color:var(--ink-2);margin:0 0 8px">If they agree, keep recording on. If they say no, stop the recording, or delete it from your phone after the call.</p>
      ${phoneTipHTML(phone)}
      <button type="button" class="btn btn-ghost btn-sm" id="rec-howto" style="margin-top:6px;gap:6px">${icon('info')}How to turn on recording on this phone</button>`,
    footer: `
      <a class="btn btn-secondary" id="rec-call-off" href="${tel}">Call without recording</a>
      <a class="btn btn-primary" id="rec-call-on" href="${tel}">${icon('phone')}Call now</a>`,
  });
  overlay.querySelector('#rec-howto')?.addEventListener('click', () => openRecordingSetupGuide());
  const go = (intent) => () => {
    ctx.set({ ...ctx.get(), reminded: true, intent, dialedAt: Date.now() });
    ctx.onDial();
    setTimeout(() => closeModal(), 300);   // after the link has been followed
  };
  overlay.querySelector('#rec-call-on')?.addEventListener('click', go('record'));
  overlay.querySelector('#rec-call-off')?.addEventListener('click', go('off'));
}

// ---------------------------------------------------------------- after the call
// ctx: { patientId, get(): rec, set(rec), consentOnFile(): bool,
//        callSeconds(): number, apply(result): string[] (labels filled) }
// Returns { refresh() } for when the general consent changes.
export function mountRecordingSection(el, ctx) {
  if (!el) return { refresh() {}, dispose() {} };
  let pendingFile = null;      // picked but not uploaded yet (a check asked first)
  let pendingProblems = [];
  let busy = false;
  let disposed = false;        // the call moved on: late answers must not touch the next family's form
  const sb = getSupabase();

  const update = (patch) => { if (disposed) return; ctx.set({ ...ctx.get(), ...patch }); render(); };

  function card(inner, tone = 'neutral') {
    const border = tone === 'ok' ? 'var(--ok)' : tone === 'warn' ? 'var(--gold)' : tone === 'danger' ? 'var(--danger)' : 'var(--line)';
    const bg = tone === 'ok' ? 'var(--ok-soft)' : tone === 'warn' ? 'var(--gold-soft)' : 'var(--surface-2, var(--surface))';
    return `<div class="followup rec-card" style="border-color:${border};background:${bg};padding:12px 14px">
      <div class="fu-head">${icon('mic')}<span>Call recording</span></div>${inner}</div>`;
  }

  function render() {
    if (disposed) return;
    const rec = ctx.get();
    const btn = (id, label, kind = 'btn-secondary', ico = '') => `<button type="button" class="btn ${kind} btn-sm" id="${id}" style="gap:6px">${ico ? icon(ico) : ''}${label}</button>`;
    const small = (t, color = 'var(--ink-3)') => `<p style="font:var(--t-xs);color:${color};margin:6px 0 0">${t}</p>`;
    const howto = `<button type="button" class="btn btn-ghost btn-sm" id="rec-howto" style="gap:6px;padding-left:0">${icon('info')}How to turn on recording on your phone</button>`;

    if (!rec.decision) {
      el.innerHTML = card(`
        <p style="font:var(--t-xs);color:var(--ink-2);margin:6px 0 10px">Did the family agree to this call being recorded?${rec.intent === 'off' ? ' You chose to call without recording.' : ''}</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap">${btn('rec-yes', 'Yes, they agreed', 'btn-primary')}${btn('rec-no', 'No')}</div>
        ${small('Not recorded, or nobody picked up? Leave this and log the call as usual.')}
        ${howto}`);
    } else if (rec.decision === 'declined') {
      el.innerHTML = card(`
        <p style="font:var(--t-xs);color:var(--ink-2);margin:6px 0 8px"><strong>The family said no.</strong> Do not upload anything. If your phone recorded this call, delete that recording from your phone.</p>
        ${btn('rec-change', 'Change the answer', 'btn-ghost')}`, 'warn');
    } else if (!ctx.consentOnFile()) {
      el.innerHTML = card(`
        <p style="font:var(--t-xs);color:var(--ink-2);margin:6px 0 8px">They agreed to the recording. Before it can be saved, they must also agree to us keeping notes: ask the consent question above first.</p>
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
        <p style="font:var(--t-xs);color:var(--ink-2);margin:6px 0 10px">They agreed. Upload the recording your phone saved: a transcript and suggested answers fill this form for you to check.</p>
        <label class="btn btn-primary btn-sm" style="gap:6px;cursor:pointer">${icon('upload')}Upload recording
          <input type="file" id="rec-file" accept="audio/*,.m4a,.mp3,.wav,.aac,.ogg,.opus,.webm" hidden /></label>
        ${note}${phoneTipHTML(savedPhone())}
        <div style="display:flex;gap:4px;flex-wrap:wrap">${howto}${btn('rec-change', 'Change the answer', 'btn-ghost')}</div>
        <div id="rec-shared"></div>`);
    } else if (rec.status === 'uploading' || rec.status === 'transcribing') {
      el.innerHTML = card(`
        <div style="display:flex;align-items:center;gap:10px;margin-top:8px"><span class="spinner" style="width:18px;height:18px;border-width:2.5px"></span>
          <span style="font:var(--t-xs);color:var(--ink-2)" role="status">${rec.status === 'uploading' ? `Uploading ${esc(rec.fileName)}...` : 'Listening to the call. This takes about 10 to 40 seconds; you can keep filling the form.'}</span></div>`);
    } else if (rec.status === 'done' && rec.result) {
      const r = rec.result;
      const filled = (rec.applied || []).length ? `Filled in below: ${esc(rec.applied.join(', '))}. Check them before you save.` : 'Nothing new to fill in: the form already had your answers.';
      el.innerHTML = card(`
        <p style="font:var(--t-xs);color:var(--ink-3);margin:6px 0 4px">Written by AI from the recording, not checked by a person.</p>
        ${r.points?.length ? `<ul style="list-style:disc;margin:0 0 8px 18px;padding:0;color:var(--ink-2);font:var(--t-xs)">${r.points.map((p) => `<li style="margin-bottom:3px">${esc(p.text)}</li>`).join('')}</ul>`
          : `<p style="font:var(--t-xs);color:var(--ink-2);margin:0 0 8px">${r.quality === 'no_speech' ? 'No conversation was heard in this recording.' : 'No summary could be made from this recording.'}</p>`}
        <p style="font:var(--t-xs);color:var(--ok);margin:0 0 8px">${filled}</p>
        ${transcripts.has(rec.recordingId)
          ? `<details><summary style="cursor:pointer;font:var(--t-xs);color:var(--ink-2)">Show the transcript (${transcripts.get(rec.recordingId).length} turns${r.language ? `, ${esc(r.language)}` : ''})</summary>
          <div style="max-height:260px;overflow-y:auto;margin-top:6px">${transcripts.get(rec.recordingId).map((t) => `<p style="font:var(--t-xs);margin:0 0 4px"><strong>${t.speaker === 'caller' ? 'You' : t.speaker === 'family' ? 'Family' : 'Someone'}:</strong> ${esc(t.text)}</p>`).join('')}</div></details>`
          : btn('rec-read', 'Read the transcript', 'btn-ghost', 'fileText')}
        ${btn('rec-remove', 'Remove recording', 'btn-ghost', 'trash')}`, 'ok');
    } else if (rec.status === 'saved') {
      el.innerHTML = card(`
        <p style="font:var(--t-xs);color:var(--ink-2);margin:6px 0 8px"><strong>Recording saved.</strong> ${esc(rec.error || 'No transcript was made; fill the log by hand.')}</p>
        ${btn('rec-remove', 'Remove recording', 'btn-ghost', 'trash')}`, 'ok');
    } else {   // failed
      el.innerHTML = card(`
        <p style="font:var(--t-xs);color:var(--danger);margin:6px 0 8px">${esc(rec.error || 'The transcript could not be made.')}</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap">${btn('rec-retry', 'Try again', 'btn-primary', 'refresh')}${btn('rec-remove', 'Remove recording', 'btn-ghost', 'trash')}</div>`, 'warn');
    }
    wire();
  }

  async function answer(decision) {
    if (busy) return; busy = true;
    try {
      const { data, error } = await sb.rpc('record_call_recording_consent',
        { p_patient_id: ctx.patientId, p_decision: decision, p_wording_version: CONSENT_WORDING_VERSION });
      if (error) throw error;
      update({ consentId: data, decision });
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
      confirmModal('Remove the uploaded recording and answer again?', async () => {
        if (await removeRecording()) update({ decision: null, consentId: null });
      }, { title: 'Change the answer', confirmLabel: 'Remove and change' });
      return;
    }
    update({ decision: null, consentId: null });
  }

  async function picked(file) {
    if (!file) return;
    const type = canonicalAudioType(file.name, file.type);
    if (!type) {
      const ext = (file.name.split('.').pop() || '').toLowerCase();
      showToast(`This file (.${ext}) cannot be read. Pick the recording your phone saved (m4a, mp3, wav, aac or ogg).`, 'warning', 8000);
      return;
    }
    const consentId = ctx.get().consentId;
    const durationS = await readAudioDuration(file);
    if (!sameConsent(consentId)) return;
    const rec = ctx.get();
    const check = checkRecordingFile({ lastModified: file.lastModified, durationS, dialedAt: rec.dialedAt, callSeconds: ctx.callSeconds() });
    file._jcf = { type, durationS };
    if (!check.ok) { pendingFile = file; pendingProblems = check.problems; render(); return; }
    await upload(file);
  }

  async function upload(file) {
    if (busy) return; busy = true;
    pendingFile = null; pendingProblems = [];
    const rec = ctx.get();
    const consentId = rec.consentId;
    const { type, durationS } = file._jcf || { type: canonicalAudioType(file.name, file.type), durationS: null };
    // An earlier try that never got its file: its row goes first (the sweep would take it anyway).
    if (rec.recordingId && (rec.status === 'upload_failed' || rec.status === 'interrupted')) {
      try { await sb.rpc('discard_call_recording', { p_recording_id: rec.recordingId }); } catch { /* the sweep takes it */ }
      if (!sameConsent(consentId)) { busy = false; return; }
      ctx.set({ ...ctx.get(), recordingId: null, path: null });
    }
    update({ status: 'uploading', fileName: file.name, error: null });
    try {
      const { data: opened, error } = await sb.rpc('start_call_recording', {
        p_consent_id: consentId, p_file_name: file.name, p_mime_type: type, p_size_bytes: file.size,
        p_duration_seconds: durationS ? Math.round(durationS) : null,
        p_file_modified_at: file.lastModified ? new Date(file.lastModified).toISOString() : null,
      });
      if (error) throw error;
      if (!sameConsent(consentId)) { busy = false; return; }
      update({ recordingId: opened.id, path: opened.path });
      // Sent with the canonical type: a File keeps its own (Android often gives
      // none at all), and the bucket accepts only audio types it knows.
      const body = new Blob([file], { type: opened.content_type });
      const { error: upErr } = await sb.storage.from(BUCKET).upload(opened.path, body, { contentType: opened.content_type, upsert: false });
      if (upErr) throw upErr;
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
      const result = { summary: res.summary, points: res.points || [], turns: (res.transcript || []).length,
        suggestions: res.suggestions || {}, dropped: res.dropped || 0, quality: res.quality, language: res.language };
      let applied = [];
      try { applied = ctx.apply(result) || []; } catch (e) { console.warn('[recording] could not fill the form:', e); }
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
      ctx.set({ ...ctx.get(), recordingId: null, path: null, fileName: '', status: null, error: null, result: null, applied: null });
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
    slot.innerHTML = `
      <div style="margin-top:10px;padding:10px 12px;border:1px dashed var(--line);border-radius:var(--r-sm)">
        <p style="font:var(--t-xs);color:var(--ink-2);margin:0 0 8px"><strong>A recording was shared to the Navigator:</strong> ${esc(file.name)}, ${esc(fmtWhen(file.lastModified))}. Attach it to this call?</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button type="button" class="btn btn-primary btn-sm" id="rec-shared-use">Attach it</button>
          <button type="button" class="btn btn-ghost btn-sm" id="rec-shared-drop">Not this one</button></div></div>`;
    slot.querySelector('#rec-shared-use').addEventListener('click', async () => { await dropSharedRecording(); picked(file); });
    slot.querySelector('#rec-shared-drop').addEventListener('click', async () => { await dropSharedRecording(); slot.innerHTML = ''; });
  }

  function wire() {
    if (el.querySelector('#rec-shared')) offerShared();
    el.querySelector('#rec-yes')?.addEventListener('click', () => answer('agreed'));
    el.querySelector('#rec-no')?.addEventListener('click', () => answer('declined'));
    el.querySelector('#rec-change')?.addEventListener('click', changeAnswer);
    el.querySelector('#rec-howto')?.addEventListener('click', () => openRecordingSetupGuide(() => render()));
    el.querySelector('#rec-file')?.addEventListener('change', (e) => picked(e.target.files?.[0]));
    el.querySelector('#rec-anyway')?.addEventListener('click', () => { const f = pendingFile; if (f) upload(f); });
    el.querySelector('#rec-repick')?.addEventListener('click', () => { pendingFile = null; pendingProblems = []; render(); el.querySelector('#rec-file')?.click(); });
    el.querySelector('#rec-retry')?.addEventListener('click', () => transcribe());
    el.querySelector('#rec-read')?.addEventListener('click', () => openRecordingViewer(ctx.get().recordingId));
    el.querySelector('#rec-remove')?.addEventListener('click', () => confirmModal('Remove this recording? The transcript goes with it.', removeRecording,
      { title: 'Remove recording', confirmLabel: 'Remove' }));
  }

  // A reload in the middle (the phone's file picker can reload the page): ask
  // the server, which knows whether the file arrived. Arrived: the transcript
  // goes ahead. Not arrived: "interrupted, pick it again".
  const start = ctx.get();
  render();
  if (start.recordingId && (start.status === 'uploading' || start.status === 'transcribing')) transcribe();
  else if (start.status === 'uploading') update({ status: 'interrupted' });
  return { refresh: render, dispose() { disposed = true; } };
}

// After the call log is saved: the answer and its recording join it. Never
// blocks the log: a failure is said, and the nightly sweep handles leftovers.
export async function attachRecordingToLog(callLogId, rec) {
  if (!callLogId || !rec?.consentId) return 0;
  const { data, error } = await getSupabase().rpc('attach_call_recording', { p_call_log_id: callLogId, p_consent_id: rec.consentId });
  if (error) {
    console.warn('[recording] attach failed:', error.message);
    showToast('The call is logged, but its recording could not be attached. Tell your team lead.', 'warning', 8000);
    return 0;
  }
  return data || 0;
}

// ---------------------------------------------------------------- past calls
// Fills <span class="rec-slot" data-log="<call_log id>"> with a Recording
// button where one exists and the reader may hear it (RLS decides).
export async function decorateRecordings(container) {
  const slots = [...(container?.querySelectorAll('.rec-slot[data-log]') || [])];
  const ids = [...new Set(slots.map((s) => s.dataset.log).filter(Boolean))];
  if (!ids.length) return;
  const { data, error } = await getSupabase().from('call_recordings')
    .select('id, call_log_id, status').in('call_log_id', ids);
  if (error || !data?.length) return;
  const byLog = new Map(data.map((r) => [r.call_log_id, r]));
  for (const slot of slots) {
    const r = byLog.get(slot.dataset.log);
    if (!r) continue;
    slot.innerHTML = `<button type="button" class="btn btn-ghost btn-sm" style="gap:5px;padding:2px 8px">${icon('play')}Recording</button>`;
    slot.querySelector('button').addEventListener('click', () => openRecordingViewer(r.id));
  }
}

export async function openRecordingViewer(recordingId) {
  const sb = getSupabase();
  const { data: r, error } = await sb.from('call_recordings')
    .select('id, storage_path, status, summary, transcript, duration_seconds, audio_deleted_at, created_at, language, uploaded_by')
    .eq('id', recordingId).maybeSingle();
  if (error || !r) { showToast('This recording is not open to you.', 'warning'); return; }
  const turns = Array.isArray(r.transcript) ? r.transcript : [];
  const overlay = showModal({
    title: 'Call recording',
    size: 'lg',
    content: `
      ${r.audio_deleted_at ? `<p style="color:var(--ink-2);margin:0 0 10px">The audio was deleted after 90 days. The transcript stays with the call.</p>`
        : '<audio id="rec-audio" controls preload="none" style="width:100%;margin-bottom:10px"></audio>'}
      <p style="font:var(--t-xs);color:var(--ink-3);margin:0 0 8px">Recorded ${esc(fmtWhen(new Date(r.created_at).getTime()))}${r.duration_seconds ? ` · ${fmtDur(r.duration_seconds)}` : ''}${r.language ? ` · ${esc(r.language)}` : ''}. Only the caller, their managers and admins can open it.</p>
      ${r.summary ? `<p style="margin:0 0 10px;color:var(--ink-2)"><strong>Summary (AI, not checked by a person):</strong> ${esc(r.summary)}</p>` : ''}
      ${turns.length ? `<div style="max-height:320px;overflow-y:auto;border-top:1px solid var(--line);padding-top:8px">${turns.map((t) =>
        `<p style="margin:0 0 6px"><strong>${t.speaker === 'caller' ? 'Caller' : t.speaker === 'family' ? 'Family' : 'Someone'}:</strong> ${esc(t.text)}</p>`).join('')}</div>`
        : `<p style="color:var(--ink-3);margin:0">${r.status === 'done' ? 'No speech was found.' : 'No transcript yet.'}</p>`}`,
  });
  if (!r.audio_deleted_at) {
    const audio = overlay.querySelector('#rec-audio');
    const sign = async () => (await sb.storage.from(BUCKET).createSignedUrl(r.storage_path, SIGNED_URL_SECONDS)).data?.signedUrl || null;
    const url = await sign();
    if (!url) { if (audio) audio.outerHTML = '<p style="color:var(--danger);margin:0 0 10px">The audio could not be opened just now.</p>'; }
    else if (audio) {
      audio.src = url;
      // The link lasts five minutes; a longer listen asks for a fresh one and carries on.
      let renewals = 0;
      audio.addEventListener('error', async () => {
        if (renewals++ >= 6 || !document.body.contains(audio)) return;
        const at = audio.currentTime; const playing = !audio.paused;
        const fresh = await sign();
        if (!fresh) return;
        audio.src = fresh; audio.currentTime = at;
        if (playing) audio.play().catch(() => {});
      });
    }
  }
}
