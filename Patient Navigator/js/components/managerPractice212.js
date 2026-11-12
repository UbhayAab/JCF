// Three fictional profiles with separate practice history. Never a patient write.
import * as Auth from '../auth.js';
import { getSupabase } from '../supabase.js';
import { showModal } from './modal.js';
import * as Recording from './callRecording.js';
import * as Source from '../utils/careFollowup.js?v=nutrition217';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const identity = () => JSON.stringify([Auth.getCurrentUser()?.id, Auth.getRealProfile()?.id, Auth.getCurrentProfile()?.id, Auth.isImpersonating()]);
export function canPractice212() {
  const me = Auth.getRealProfile(), today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return !Auth.isImpersonating() && me?.id === Auth.getCurrentUser()?.id && me?.id === Auth.getCurrentProfile()?.id
    && me?.is_active === true && me?.must_change_password !== true && ['manager', 'admin'].includes(me?.role)
    && (!me.ends_on || me.ends_on >= today);
}
const rpc = async (name, args = {}) => {
  const { data, error } = await getSupabase().rpc(name, args);
  if (error) throw new Error(error.message || 'The practice request was not confirmed.');
  return data;
};
const invoke = async (id, action) => {
  const { data, error } = await getSupabase().functions.invoke('manager-practice212', { body: { id, action } });
  if (error || !data?.ok) throw new Error(data?.reason || 'The request did not confirm its result. Choose Check saved result before doing anything else.');
  return data;
};
const label = slot => ['Fictional family one', 'Fictional family two', 'Fictional family three'][Number(slot) - 1] || 'Fictional practice';
const date = value => new Date(value).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' });

export async function openManagerPractice212() {
  if (!canPractice212()) throw new Error('Exit Open as and use your own active manager account.');
  const account = identity(), host = document.createElement('div');
  host.setAttribute('data-manager-practice212', '');
  let overlay, busy = false, closed = false, stream = null, recorder = null, recordingStart = 0, micTimer = null;
  let file = null, seconds = null, selectedSlot = 1, selectedId = null, state = { profiles: [], calls: [] };
  let poll = null, pollingUntil = 0;
  const notes = new Map(), verified = new Map();
  const current = () => !closed && overlay?.isCurrentModal?.() && identity() === account && canPractice212();
  const stopTracks = () => { for (const track of stream?.getTracks() || []) track.stop(); stream = null; };
  const dispose = () => {
    if (closed) return;
    closed = true;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    stopTracks(); clearTimeout(poll); clearTimeout(micTimer);
    for (const audio of host.querySelectorAll('audio')) { audio.pause(); audio.removeAttribute('src'); audio.load(); }
    clearInterval(watch);
  };
  overlay = showModal({ title: 'Practice calls', content: host, size: 'lg', onClose: dispose });
  const watch = setInterval(() => { if (!current()) { dispose(); overlay?.closeOwnedModal?.(); } }, 400);
  const selected = () => state.calls.find(row => row.id === selectedId);
  const message = (text, error = false) => {
    if (!current()) return;
    const target = host.querySelector('[data-message]');
    if (target) { target.textContent = text; target.style.color = error ? 'var(--danger)' : 'var(--ink-3)'; }
  };
  const keepNotes = () => {
    const note = host.querySelector('[data-note]'), check = host.querySelector('[data-verified]');
    if (selectedId && note) notes.set(selectedId, note.value);
    if (selectedId && check) verified.set(selectedId, check.checked);
  };
  const disableControls = value => {
    for (const el of host.querySelectorAll('button,input,select,textarea')) {
      if (value) {
        if (!el.hasAttribute('data-practice-disabled')) el.setAttribute('data-practice-disabled', String(el.disabled));
        el.disabled = true;
      } else if (el.hasAttribute('data-practice-disabled')) {
        el.disabled = el.getAttribute('data-practice-disabled') === 'true';
        el.removeAttribute('data-practice-disabled');
      }
    }
  };
  const operation = async run => {
    if (!current() || busy) return;
    keepNotes(); busy = true;
    disableControls(true);
    try { await run(); }
    catch (error) { if (current()) { render(); message(error.message, true); } }
    finally { busy = false; if (current()) disableControls(false); }
  };
  const load = async (notice = '') => {
    const data = await rpc('manager_practice_list212');
    if (!current()) return;
    if (!Array.isArray(data?.profiles) || data.profiles.length !== 3 || !Array.isArray(data?.calls)) throw new Error('The practice area is not ready. Reload the latest update.');
    state = data;
    if (selectedId && !selected()) selectedId = null;
    render();
    if (notice) message(notice);
    scheduleObservation();
  };
  const scheduleObservation = () => {
    clearTimeout(poll);
    if (!current() || !selected() || selected().status !== 'processing' || Date.now() >= pollingUntil) return;
    poll = setTimeout(async () => {
      if (!current() || busy) { scheduleObservation(); return; }
      keepNotes();
      try { await load(); } catch (error) { message(error.message, true); }
    }, 2500);
  };
  const cleanup = async id => {
    try { await invoke(id, 'cleanup'); } catch { /* exact state is read back below; never report deletion from HTTP acceptance */ }
  };
  const fileSummary = () => file ? `${file.name} - ${(file.size / 1024 / 1024).toFixed(2)} MB${seconds ? ` - ${Recording.fmtDur(seconds)}` : ''}` : 'Choose a fictional call recording, or record a short practice conversation.';
  function resultHTML(row) {
    if (!row?.result) return row?.status === 'processing'
      ? '<p role="status">A transcription request has started. Check its saved result without another upload. If the response was interrupted, the same source will not be processed again automatically.</p>'
      : row?.status === 'unknown' ? '<p role="status">Processing ended without a confirmed full result. Check the saved result or delete this practice call. It will not run again automatically.</p>' : '';
    if (typeof Source.recordingResultForRead !== 'function' || typeof Recording.recordingReviewHTML !== 'function') return '<p>Reload the latest update to view this result.</p>';
    const result = Source.recordingResultForRead({ ...row.result, status: row.status === 'unknown' ? 'failed' : 'done' });
    // A practice source starts once. Keep the shared review flags and source
    // phases, without suggesting an unavailable retry of this recording.
    const review = Recording.recordingReviewHTML(result)
      .replace('Notes still need checking or another processing attempt.', 'Notes still need checking.');
    return review
      + `<details open><summary>Show the transcript (${Array.isArray(row.result.transcript) ? row.result.transcript.length : 0} turns)</summary><div data-source></div></details>`
      + `<details><summary>Suggested notes - check before using</summary>${typeof Recording.noteHTML === 'function' ? Recording.noteHTML(result) : ''}</details>`;
  }
  function render() {
    if (!current()) return;
    for (const audio of host.querySelectorAll('audio')) { audio.pause(); audio.removeAttribute('src'); audio.load(); }
    const row = selected(), isAdmin = Auth.getRealProfile()?.role === 'admin';
    host.innerHTML = `
      <p>Use only fictional conversations, with everyone agreeing to recording and transcription. Never upload a patient call here.</p>
      <p class="text-muted">These three practice profiles and saved practice calls stay separate from patient records, calling queues and reports. This tests recording, transcription and practice Save; it does not test a real family's assignment or care actions.</p>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,145px),1fr));gap:8px;margin:16px 0" data-profiles>
        ${state.profiles.map(profile => `<button type="button" class="btn ${profile.slot === selectedSlot ? 'btn-primary' : 'btn-secondary'}" data-slot="${profile.slot}" aria-pressed="${profile.slot === selectedSlot}">${escape(profile.name)}</button>`).join('')}
      </div>
      <p class="text-muted">Practice audio is removed after you save. Unsaved audio is removed after a day. Written practice results are removed within seven days. You can delete them sooner. A record of practice attempts remains for daily limits, without audio or written conversation. Up to ten minutes, 10 MB and five transcriptions a day.</p>
      <div data-message role="status" aria-live="polite" style="margin:12px 0;overflow-wrap:anywhere"></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin:12px 0">
        <button type="button" class="btn btn-secondary" data-refresh>Check saved result</button>
        <button type="button" class="btn btn-secondary" data-new>New practice call</button>
      </div>
      ${!row ? `<section aria-label="New practice call">
        <h4>${escape(label(selectedSlot))}</h4>
        <label style="display:flex;align-items:start;gap:8px;margin:12px 0"><input type="checkbox" data-agreed> <span>Everyone in this fictional recording agreed to recording, transcription and the practice retention notice above.</span></label>
        <label class="form-label">Upload recording<input type="file" accept="audio/*,.m4a,.mp3,.wav,.aac,.ogg,.webm" data-file class="form-input"></label>
        <p data-file-summary style="overflow-wrap:anywhere">${escape(fileSummary())}</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin:12px 0"><button type="button" class="btn btn-secondary" data-mic>Record practice conversation</button><button type="button" class="btn btn-secondary" data-stop hidden>Stop recording</button></div>
        <label style="display:flex;align-items:start;gap:8px;margin:12px 0"><input type="checkbox" data-right-file> <span>This is the correct fictional recording for ${escape(label(selectedSlot))}.</span></label>
        <button type="button" class="btn btn-primary" data-upload>Upload and transcribe</button>
      </section>` : `<section aria-label="Selected practice call" style="overflow-wrap:anywhere">
        <h4>${escape(label(row.slot))}</h4><p>${escape(date(row.created_at))}</p>
        ${row.error ? `<p role="status">${escape(row.error)}</p>` : ''}
        ${row.purge_requested ? '<p>Practice content cleared. Audio removal is still pending until the saved source confirms it is gone.</p>' : resultHTML(row)}
        ${!row.audio_deleted_at && !row.purge_requested ? '<audio controls preload="none" data-audio style="width:100%;max-width:100%"></audio><p><button type="button" class="btn btn-ghost" data-play>Load recording for playback</button></p>' : row.audio_deleted_at ? '<p>Practice audio removed. The saved written source remains until it expires or you delete it.</p>' : ''}
        ${row.status === 'uploading' && row.upload_present && !row.purge_requested ? '<button type="button" class="btn btn-primary" data-start>Start transcription</button>' : ''}
        ${row.result && !row.saved_at && !row.purge_requested ? `<label class="form-label">Your verified practice notes<textarea class="form-input" data-note maxlength="6000" rows="5">${escape(notes.get(row.id) || '')}</textarea></label>
          <label style="display:flex;align-items:start;gap:8px;margin:12px 0"><input type="checkbox" data-verified ${verified.get(row.id) ? 'checked' : ''}> <span>I checked the written source and these practice notes. I understand the audio is removed after Save.</span></label>
          <button type="button" class="btn btn-primary" data-save>Save practice call</button>` : ''}
        ${row.saved_at ? `<div class="alert alert-success" role="status"><strong>Practice call saved</strong><p>${escape(row.human_note || '')}</p><p>${row.audio_deleted_at ? 'Audio removal confirmed.' : 'Audio removal is pending.'}</p></div>` : ''}
        <p><button type="button" class="btn btn-secondary" data-delete>${row.purge_requested ? 'Retry audio removal' : 'Delete this practice call'}</button></p>
      </section>`}
      <h4 style="margin-top:20px">Your practice history</h4>
      <div data-history style="display:grid;gap:8px">${state.calls.length ? state.calls.map(call => `<button type="button" class="btn btn-secondary" data-open="${call.id}" style="display:block;text-align:left;white-space:normal">${escape(label(call.slot))}<br><span>${escape(date(call.created_at))} - ${call.purge_requested ? 'removal pending' : call.saved_at ? 'saved' : call.status === 'done' ? 'ready to check' : escape(call.status)}</span></button>`).join('') : '<p>No practice calls yet.</p>'}</div>
      ${state.pending_purges ? '<p role="status">Some practice audio removals are still pending. They have not been marked complete.</p>' : ''}
      <p><button type="button" class="btn btn-secondary" data-delete-all>Delete all my practice calls</button></p>
      ${isAdmin ? '<details><summary>Erase staff practice calls</summary><p>Erase the selected account practice files before deleting that staff account. Patient files are not part of this action.</p><button type="button" class="btn btn-secondary" data-people>Choose staff account</button><div data-people-list></div></details>' : ''}`;
    if (Array.isArray(row?.result?.transcript)) {
      const source = host.querySelector('[data-source]');
      for (const turn of row.result.transcript) {
        if (!source || typeof turn.text !== 'string') continue;
        const p = document.createElement('p');
        p.textContent = `${turn.speaker === 'caller' ? 'Caller' : turn.speaker === 'family' ? 'Family' : 'Speaker'}: ${turn.text}`;
        source.append(p);
      }
    }
    host.querySelectorAll('[data-slot]').forEach(button => button.onclick = () => { if (busy) return; keepNotes(); selectedSlot = Number(button.dataset.slot); selectedId = state.calls.find(call => call.slot === selectedSlot && !call.saved_at && !call.purge_requested)?.id || null; render(); });
    host.querySelectorAll('[data-open]').forEach(button => button.onclick = () => { if (busy) return; keepNotes(); selectedId = button.dataset.open; selectedSlot = selected().slot; file = null; render(); scheduleObservation(); });
    host.querySelector('[data-new]')?.addEventListener('click', () => { if (busy) return; keepNotes(); selectedId = state.calls.find(call => call.slot === selectedSlot && !call.saved_at && !call.purge_requested)?.id || null; file = null; seconds = null; render(); if (selectedId) message('Reopen or delete this unsaved practice call before starting another on this profile.'); });
    host.querySelector('[data-refresh]')?.addEventListener('click', () => operation(() => load('Saved result checked. No new transcription was requested.')));
    host.querySelector('[data-file]')?.addEventListener('change', async event => {
      const chosen = event.target.files?.[0] || null;
      file = chosen; seconds = null;
      let duration = null;
      if (chosen) try { duration = await Recording.readAudioDuration(chosen); } catch { /* upload refuses an unknown duration */ }
      if (file !== chosen) return;
      seconds = duration;
      if (current()) { const summary = host.querySelector('[data-file-summary]'); if (summary) summary.textContent = fileSummary(); }
    });
    host.querySelector('[data-mic]')?.addEventListener('click', startMic);
    host.querySelector('[data-stop]')?.addEventListener('click', () => { if (recorder?.state === 'recording') recorder.stop(); stopTracks(); });
    host.querySelector('[data-upload]')?.addEventListener('click', () => operation(upload));
    host.querySelector('[data-start]')?.addEventListener('click', () => operation(async () => { pollingUntil = Date.now() + 360000; await invoke(row.id, 'process'); await load(); }));
    host.querySelector('[data-save]')?.addEventListener('click', () => operation(async () => {
      await rpc('manager_practice_save212', { p_id: row.id, p_note: notes.get(row.id) || '', p_verified: verified.get(row.id) === true });
      if (!current()) return;
      await cleanup(row.id); await load('Practice call saved. Check its audio removal status below.');
    }));
    host.querySelector('[data-play]')?.addEventListener('click', () => operation(async () => {
      const { data, error } = await getSupabase().storage.from('manager-practice212').createSignedUrl(row.path, 60);
      if (error || !data?.signedUrl) throw new Error('This practice recording is unavailable.');
      if (!current() || selectedId !== row.id) return;
      const audio = host.querySelector('[data-audio]'); if (audio) { audio.src = data.signedUrl; await audio.play(); }
    }));
    host.querySelector('[data-delete]')?.addEventListener('click', () => operation(async () => {
      if (!row.purge_requested && !window.confirm('Delete this fictional practice call and its recording?')) return render();
      if (!row.purge_requested) await rpc('manager_practice_purge212', { p_id: row.id });
      await cleanup(row.id); await load('Removal checked. Any pending audio remains labelled pending.');
    }));
    host.querySelector('[data-delete-all]')?.addEventListener('click', () => operation(async () => {
      if (!window.confirm('Delete all your fictional practice calls and recordings?')) return render();
      const ids = await rpc('manager_practice_purge212'); for (const id of ids) { if (!current()) return; await cleanup(id); }
      await load('Practice data removal checked. Pending files have not been marked deleted.');
    }));
    host.querySelector('[data-people]')?.addEventListener('click', () => operation(async () => {
      const people = await rpc('manager_practice_people212'); if (!current()) return;
      const area = host.querySelector('[data-people-list]');
      area.replaceChildren();
      for (const person of people) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'btn btn-secondary';
        button.style.cssText = 'display:block;margin:8px 0;white-space:normal;text-align:left';
        button.textContent = `Erase practice calls: ${person.full_name} (${person.calls} ${Number(person.calls) === 1 ? 'call' : 'calls'})`;
        button.onclick = () => operation(async () => {
          if (!window.confirm(`Erase ${person.full_name}'s fictional practice calls and recordings?`)) return;
          const ids = await rpc('manager_practice_purge212', { p_owner: person.id });
          let pending = false;
          for (const id of ids) { if (!current()) return; try { const out = await invoke(id, 'cleanup'); if (out.cleanup?.pending || out.cleanup?.planned !== 1) pending = true; } catch { pending = true; } }
          await load(pending ? 'Some audio removal is pending. Do not delete the staff account until removal is confirmed.' : 'The selected practice sources confirmed removal. Recheck the account before deleting it.');
        });
        area.append(button);
      }
      if (!people.length) area.textContent = 'No staff practice data remains.';
    }));
    if (busy) disableControls(true);
  }
  async function startMic() {
    if (!current() || busy || recorder?.state === 'recording') return;
    if (!host.querySelector('[data-agreed]')?.checked) return message('Confirm participant agreement before recording.', true);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') return message('Microphone recording is unavailable in this browser. Upload a fictional audio file instead.', true);
    busy = true; disableControls(true);
    try {
      const pending = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!current()) { pending.getTracks().forEach(track => track.stop()); return; }
      stream = pending; const parts = []; let recordedBytes = 0;
      const type = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find(value => MediaRecorder.isTypeSupported(value));
      recorder = type ? new MediaRecorder(stream, { mimeType: type }) : new MediaRecorder(stream);
      const activeRecorder = recorder;
      recordingStart = Date.now();
      recorder.ondataavailable = event => {
        if (event.data.size) { parts.push(event.data); recordedBytes += event.data.size; }
        if (recordedBytes > 10 * 1024 * 1024 && activeRecorder.state === 'recording') activeRecorder.stop();
      };
      recorder.onstop = () => {
        stopTracks(); clearTimeout(micTimer); busy = false;
        if (!current()) return;
        const mime = activeRecorder.mimeType || parts[0]?.type || 'audio/webm';
        seconds = Math.max(1, Math.ceil((Date.now() - recordingStart) / 1000));
        file = new File(parts, mime.includes('mp4') ? 'fictional-practice.m4a' : 'fictional-practice.webm', { type: mime });
        host.querySelector('[data-file-summary]').textContent = fileSummary();
        disableControls(false); host.querySelector('[data-mic]').disabled = false; host.querySelector('[data-stop]').hidden = true;
        message('Practice recording stopped. Check the file and confirm it before uploading.');
      };
      recorder.onerror = () => { stopTracks(); clearTimeout(micTimer); busy = false; disableControls(false); message('Microphone recording stopped with an error. Use a fictional audio file instead.', true); };
      recorder.start(1000);
      host.querySelector('[data-mic]').disabled = true; host.querySelector('[data-stop]').hidden = false; host.querySelector('[data-stop]').disabled = false;
      micTimer = setTimeout(() => { if (activeRecorder.state === 'recording') activeRecorder.stop(); stopTracks(); }, 599000);
      message('Recording the practice conversation. Stop within ten minutes.');
    } catch { stopTracks(); busy = false; if (current()) disableControls(false); message('Microphone permission was not available. You can upload a fictional recording instead.', true); }
  }
  async function upload() {
    if (!file || !host.querySelector('[data-agreed]')?.checked || !host.querySelector('[data-right-file]')?.checked) throw new Error('Choose the fictional recording and confirm agreement and the correct file.');
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 600 || file.size < 1024 || file.size > 10 * 1024 * 1024) throw new Error('Choose a readable recording up to ten minutes and 10 MB.');
    const kind = Recording.canonicalAudioType(file.name, file.type);
    if (!kind) throw new Error('Choose an m4a, mp3, wav, aac, ogg or webm audio file.');
    const sourceFile = file, slot = selectedSlot, id = crypto.randomUUID();
    const prepared = await rpc('manager_practice_prepare212', { p_id: id, p_slot: slot, p_mime: kind,
      p_bytes: sourceFile.size, p_seconds: Math.ceil(seconds), p_agreed: true });
    if (!current()) return;
    selectedId = id;
    const body = new Blob([sourceFile], { type: prepared.mime_type || kind });
    const { error } = await getSupabase().storage.from('manager-practice212').upload(prepared.path, body,
      { contentType: prepared.mime_type || kind, upsert: false, cacheControl: '0' });
    if (error) { await load(); throw new Error('The upload was not confirmed. Check the saved result before uploading anything again.'); }
    if (!current()) return;
    pollingUntil = Date.now() + 360000;
    await load('Upload confirmed. Transcription is starting once.');
    try { await invoke(id, 'process'); }
    finally { if (current()) { await load(); file = null; } }
  }
  try { await load(); } catch (error) { if (current()) { host.textContent = error.message; } }
  return overlay;
}
