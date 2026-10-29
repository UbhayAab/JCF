import { getSupabase, mustWrite } from '../supabase.js';
import { getCurrentUser, getCurrentProfile, getRealProfile, isImpersonating } from '../auth.js';
import { showModal } from './modal.js';
import { showToast } from './toast.js';
import { sanitize } from '../utils/validators.js';
import * as recording from './callRecording.js';
import { mountSessionAudioCapture } from './sessionAudioCapture128.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const identity = () => {
  const u = getCurrentUser(), p = getCurrentProfile(), real = getRealProfile();
  const day = new Date(Date.now() + 19800000).toISOString().slice(0, 10);
  return u?.id && p?.id === u.id && real?.id === u.id && p.is_active === true && real.is_active === true
    && !isImpersonating() && (!p.ends_on || p.ends_on >= day) ? JSON.stringify([u.id, p.role]) : null;
};
const read = async (operation) => {
  let timer; try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Read timed out. Reopen to retry.')), 8000); })]); }
  finally { clearTimeout(timer); }
};

export async function openSessionRecording128(sessionId, onSaved = () => {}) {
  if (!UUID.test(sessionId) || !identity()) { showToast('Use your own active account to record a session.', 'warning'); return; }
  const owner = identity(), route = location.hash, sb = getSupabase(), el = document.createElement('div');
  el.innerHTML = '<p role="status">Opening this session...</p>';
  let ended = false, section, capture, observer, subscription, recordingState = recording.blankRecording?.(), captureState = { phase: 'idle' };
  const dispose = () => {
    if (ended) return; ended = true; capture?.dispose(); section?.dispose(); observer?.disconnect(); subscription?.unsubscribe?.();
    window.removeEventListener('hashchange', contextChanged); el.replaceChildren();
  };
  const overlay = showModal({ title: 'Session notes and recording', content: el, size: 'lg', onClose: dispose,
    footer: '<button class="btn btn-secondary" type="button" id="sr128-cancel">Close</button><button class="btn btn-primary" type="button" id="sr128-save" disabled>Save held session</button>' });
  // Keep title/Close and save actions visible while long notes/consent scroll.
  const modal = overlay.querySelector('.modal'), body = overlay.querySelector('.modal-body');
  Object.assign(modal.style, { display: 'flex', flexDirection: 'column', maxHeight: 'calc(100dvh - 24px)', overflow: 'hidden' });
  Object.assign(body.style, { overflowY: 'auto', minHeight: '0' });
  overlay.querySelector('.modal-header').style.flexShrink = '0';
  overlay.querySelector('.modal-footer').style.flexShrink = '0';
  overlay.querySelector('#sr128-cancel').addEventListener('click', () => overlay.closeOwnedModal(dispose));
  const current = () => !ended && owner === identity() && route === location.hash && el.isConnected && overlay.isCurrentModal?.() === true;
  function contextChanged() { if (!current()) { dispose(); overlay.closeOwnedModal(dispose); } }
  observer = new MutationObserver(contextChanged); observer.observe(document.body, { childList: true, subtree: true });
  subscription = sb.auth?.onAuthStateChange?.(() => contextChanged())?.data?.subscription;
  window.addEventListener('hashchange', contextChanged);
  try {
    if (recording.SESSION_RECORDING_BINDING128 !== 1) throw Error('The recording component is out of date. Refresh the app before recording.');
    const [sessionReply, historyReply] = await Promise.all([
      read(sb.from('care_sessions').select('id,patient_id,status,held_at,updated_at,session_notes,duration_mins,patient:patients(full_name,consent_given)').eq('id', sessionId).single()),
      read(sb.from('call_recordings').select('id,status,created_at,audio_deleted_at').eq('care_session_id', sessionId).not('session_attached_at', 'is', null).order('created_at', { ascending: false }).limit(20)),
    ]);
    if (!current()) return;
    const s = sessionReply.data;
    if (sessionReply.error || !s || !UUID.test(s.patient_id) || !['scheduled', 'held'].includes(s.status)) throw Error('This session is no longer available for recording.');
    const patient = Array.isArray(s.patient) ? s.patient[0] : s.patient;
    el.innerHTML = `<p>Session with <strong>${sanitize(patient?.full_name || 'Patient record restricted')}</strong></p>
      <p class="due-meta wraps">Recording is optional. Ask first. Audio stays on this device until you choose Use recording, or choose an existing file to upload. Closing a local clip discards it; an uploaded unsaved draft is cleared after a day.</p>
      <div class="form-group"><label class="form-label" for="sr128-duration">Duration (minutes)</label><input class="input" id="sr128-duration" type="number" min="1" max="240" value="${Number.isInteger(s.duration_mins) ? s.duration_mins : ''}" placeholder="45"></div>
      <div class="form-group"><label class="form-label" for="sr128-notes">Session notes</label><textarea class="textarea" id="sr128-notes" maxlength="50000" rows="6">${sanitize(s.session_notes || '')}</textarea></div>
      <button class="btn btn-secondary btn-sm" type="button" id="sr128-use-draft" style="display:none;white-space:normal;height:auto">Append reviewed AI draft to my notes</button>
      ${patient?.consent_given !== true ? `<p class="due-meta wraps">General consent to keep notes is not on file. Ask and record it on the <a href="#patients/${s.patient_id}">patient record</a> before audio capture or upload.</p>` : ''}
      <div id="sr128-recording"></div><div id="sr128-capture" style="display:flex;gap:8px;flex-wrap:wrap;margin:12px 0"></div>
      <p id="sr128-state" role="status" class="due-meta wraps"></p>
      <details style="margin-top:16px"><summary>Saved recordings for this session</summary><div id="sr128-history"></div><div id="sr128-viewer"></div></details>`;
    const notes = el.querySelector('#sr128-notes'), duration = el.querySelector('#sr128-duration'), saveButton = overlay.querySelector('#sr128-save'), state = el.querySelector('#sr128-state'), draftButton = el.querySelector('#sr128-use-draft');
    const usedDrafts = new Set();
    let saving = false; const nonce = crypto.randomUUID();
    const allowed = () => current() && patient?.consent_given === true && recordingState?.decision === 'agreed'
      && recordingState?.wordingVersion === recording.SESSION_CONSENT_VERSION128 && !!recordingState?.consentId && !recordingState?.recordingId;
    const sync = () => {
      if (!current()) return;
      const capturing = ['permission', 'recording', 'stopping', 'ready'].includes(captureState.phase);
      saveButton.disabled = saving || capturing || ['uploading'].includes(recordingState?.status);
      draftButton.style.display = (recordingState?.result?.draft_summary || recordingState?.result?.summary) && !usedDrafts.has(recordingState.recordingId) ? '' : 'none';
      if (capture) el.querySelector('#sr128-capture').style.display = !recordingState?.recordingId && recordingState?.decision === 'agreed' ? 'flex' : 'none';
    };
    section = recording.mountRecordingSection(el.querySelector('#sr128-recording'), {
      sessionId, patientId: s.patient_id, inline: true, get: () => recordingState,
      set: (value) => { recordingState = value; if (capture && !allowed()) capture.cancel(); sync(); },
      consentOnFile: () => current() && patient?.consent_given === true,
      consentHint: 'record general consent on the patient record first.', callSeconds: () => Number(duration.value) * 60 || 0,
      callAt: () => null, apply: () => [],
    });
    capture = mountSessionAudioCapture(el.querySelector('#sr128-capture'), {
      allowed, acceptFile: (file) => section.acceptFile(file), changed: (s) => { captureState = s; sync(); },
    });
    sync();
    draftButton.addEventListener('click', () => {
      const draft = recordingState?.result?.draft_summary || recordingState?.result?.summary, id = recordingState?.recordingId;
      if (!current() || !draft || usedDrafts.has(id)) return;
      const next = `${notes.value.trim()}${notes.value.trim() ? '\n\n' : ''}From the session recording (AI draft):\n${draft}`;
      if (next.length > 50000) { showToast('The combined notes are too long. Edit them before appending the draft.', 'warning'); return; }
      notes.value = next; usedDrafts.add(id); sync();
    });
    const history = el.querySelector('#sr128-history');
    if (historyReply.error || !Array.isArray(historyReply.data)) history.textContent = 'Saved recordings could not be loaded. Reopen to retry.';
    else if (!historyReply.data.length) history.textContent = 'No saved recordings available to your account.';
    else for (const r of historyReply.data) {
      if (!UUID.test(r.id)) continue;
      const b = document.createElement('button'); b.type = 'button'; b.className = 'btn btn-ghost btn-sm'; b.textContent = `Open saved recording - ${r.status || 'processing'}`;
      b.addEventListener('click', () => { if (current()) recording.renderRecordingViewer(el.querySelector('#sr128-viewer'), r.id); }); history.append(b);
    }
    saveButton.addEventListener('click', async () => {
      if (!current() || saving || saveButton.disabled) return;
      const mins = Number(duration.value);
      if (!Number.isInteger(mins) || mins < 1 || mins > 240) { state.textContent = 'Enter a duration from 1 to 240 minutes.'; return; }
      saving = true; sync(); state.textContent = 'Saving session...';
      const recordingId = recordingState.recordingId;
      try {
        if (recordingId) {
          const { data, error } = await sb.rpc('save_recorded_session128', { p_session_id: sessionId, p_recording_id: recordingId,
            p_expected_updated_at: s.updated_at, p_nonce: nonce, p_notes: notes.value.trim(), p_duration_mins: mins });
          if (error || data?.saved !== true || data.session_id !== sessionId || data.recording_id !== recordingId) throw error || Error('The session save was not confirmed.');
          // The session is durable. Cleanup failure must not re-save or roll it back.
          void sb.functions.invoke('call-recording-finalize', { body: { recording_id: recordingId, care_session_id: sessionId } }).catch(() => {});
        } else {
          await mustWrite(sb.from('care_sessions').update({ status: 'held', held_at: s.held_at || new Date().toISOString(), duration_mins: mins, session_notes: notes.value.trim() || null }).eq('id', sessionId).eq('updated_at', s.updated_at), 'session');
        }
        if (!current()) return;
        overlay.closeOwnedModal(dispose); showToast('Session saved with your notes.', 'success'); await onSaved();
      } catch (e) { if (current()) state.textContent = `Could not confirm the save: ${e.message || 'check your connection'}. Your draft is kept here. Reopen the session to check before making a different save.`; }
      finally { saving = false; sync(); }
    });
  } catch (e) { if (current()) { section?.dispose(); capture?.dispose(); el.replaceChildren(); const p = document.createElement('p'); p.setAttribute('role', 'alert'); p.textContent = e.message || 'The session could not be opened. Reopen to retry.'; el.append(p); } }
}
