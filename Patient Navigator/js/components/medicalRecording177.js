const CONSENT = 'medical-phone-notice-v1';
const MAX_BYTES = 12 * 1024 * 1024;

export const phoneRecordingNotice177 = 'May I record this call so the care team can check what was said? The Phone app will tell everyone when recording starts. I will upload it privately for this medical call. Google can produce a draft for me to check. The audio is kept for up to 90 days, and reviewed notes can stay with the call. Is everyone comfortable with that?';

export function mountMedicalRecording177(holder, { sb, request, version, entry, current, denied }) {
  const controller = new AbortController();
  let audioUrl = null;
  let state;
  let busy = false;
  const active = () => !controller.signal.aborted && holder.isConnected && current();
  const revoke = () => {
    const player = holder.querySelector('audio');
    if (player) { player.pause(); player.removeAttribute('src'); player.remove(); }
    if (audioUrl) { URL.revokeObjectURL(audioUrl); audioUrl = null; }
  };
  const hidePrivate = () => {
    revoke();
    const draft = holder.querySelector('[data-recording-draft]');
    if (draft) draft.hidden = true;
  };
  const dispose = () => {
    controller.abort();
    revoke();
    holder.replaceChildren();
    holder.hidden = true;
  };
  const say = (message) => {
    if (active()) holder.querySelector('[data-recording-status]').textContent = message;
  };
  const invoke = async (action, file) => {
    const query = new URLSearchParams({ action, request, version, entry });
    if (file) query.set('consent', CONSENT);
    if (action === 'process' && state?.state_at) query.set('expected', state.state_at);
    const { data, error } = await sb.functions.invoke('medical-call-recording?' + query, {
      body: file || {}, signal: controller.signal,
    });
    if (!active()) return null;
    if (error) {
      const response = error.context;
      const problem = await response?.json?.().catch(() => null);
      if (!active()) return null;
      if (response?.status === 401 || response?.status === 403) {
        dispose();
        denied(problem?.error || 'Recording access changed. Refresh your work.');
        return null;
      }
      throw new Error(problem?.error || 'Recording status could not be confirmed. Refresh before retrying.');
    }
    return data;
  };
  function render(notice = '') {
    if (!active()) return;
    revoke();
    const canUpload = state && ['empty', 'uploading'].includes(state.state) && state.can_import;
    const canProcess = state?.audio_available && state.attempts < 3 && state.duration > 0 && state.duration <= 1800
      && (['ready', 'failed'].includes(state.state) || state.stale || state.draft?.retryable && state.state === 'done');
    holder.innerHTML = '<h5>Phone recording import (fallback)</h5>' +
      '<p>Navigator opens the Phone app for calls. It cannot record both sides inside Safari.</p>' +
      '<p role="status" data-recording-status></p>' +
      (canUpload ? '<p>Ask everyone before recording. If everyone agrees, use the Phone app’s recording control and wait for its audible notice. After the call, open the recording in Notes, save the audio to Files, and select it here.</p>' +
        '<label><input type="checkbox" data-recording-consent> Everyone agreed and heard the Phone recording notice. This is the file for this call.</label>' +
        '<label>Recording file (AAC M4A or PCM WAV, up to 12 MB)<input class="form-control" type="file" accept=".m4a,.wav,audio/mp4,audio/wav,audio/x-m4a" data-recording-file disabled></label>' +
        '<button class="btn btn-secondary" type="button" data-recording-upload disabled>Import recording</button>' : '') +
      (state?.audio_available ? '<button class="btn btn-secondary" type="button" data-recording-audio>Listen to recording</button>' : '') +
      (canProcess ? '<button class="btn btn-secondary" type="button" data-recording-process>' +
        (state.attempts ? 'Try generating draft again' : 'Generate AI draft') + '</button>' : '') +
      (state && !['empty', 'withdrawn'].includes(state.state)
        ? '<button class="btn btn-secondary" type="button" data-recording-withdraw>Withdraw recording consent</button>' : '') +
      '<button class="btn btn-secondary" type="button" data-recording-refresh>Refresh recording status</button>' +
      '<button class="btn btn-secondary" type="button" data-recording-close>Close recording panel</button>' +
      '<div data-recording-draft></div>';
    const status = {
      empty: state?.can_import ? 'Import the agreed recording for this connected call.' : 'Recording import is available for connected calls from the last seven days.',
      uploading: 'The import is incomplete. Select the same file to resume.',
      ready: 'Recording attached. Generate an AI draft when ready.',
      processing: state?.stale ? 'The previous attempt did not finish. You can try again.' : 'AI draft is processing. Refresh to check its status.',
      done: 'AI draft saved separately. Check the source before using it.',
      failed: 'The draft did not finish. Your recording and typed notes are saved.',
      withdrawn: 'Recording consent was withdrawn. Audio and the AI draft are unavailable.',
    };
    const long = state?.audio_available && state.duration > 1800
      ? ' AI drafting supports recordings up to 30 minutes.'
      : state?.audio_available && !state.duration ? ' Its duration could not be verified. Use the recording to write notes by hand.' : '';
    say(notice || ((state ? status[state.state] || '' : 'Checking assignment…') + long));

    if (state?.draft) {
      const draft = state.draft;
      const section = holder.querySelector('[data-recording-draft]');
      section.hidden = document.hidden;
      const label = document.createElement('p');
      label.textContent = (draft.transcript_complete ? 'Written transcript complete.' : 'Written transcript incomplete.') +
        (draft.notes_complete ? ' Review the AI draft before using it.' : ' AI draft needs review.');
      section.append(label);
      const text = document.createElement('p'); text.style.whiteSpace = 'pre-wrap';
      text.textContent = [...(draft.reasons || []), draft.text].filter(Boolean).join('\n\n');
      section.append(text);
      if (draft.transcript?.length) {
        const details = document.createElement('details');
        const summary = document.createElement('summary'); summary.textContent = 'Read written transcript';
        details.append(summary);
        for (const turn of draft.transcript) {
          const line = document.createElement('p');
          line.textContent = [turn.at, turn.speaker, turn.text].filter(Boolean).join(' ');
          details.append(line);
        }
        section.append(details);
      }
    }

    const checkbox = holder.querySelector('[data-recording-consent]');
    const file = holder.querySelector('[data-recording-file]');
    const upload = holder.querySelector('[data-recording-upload]');
    if (checkbox) {
      checkbox.onchange = () => {
        file.disabled = !checkbox.checked;
        if (!checkbox.checked) file.value = '';
        upload.disabled = !checkbox.checked || !file.files.length;
      };
      file.onchange = () => { upload.disabled = !checkbox.checked || !file.files.length; };
      upload.onclick = () => {
        if (!checkbox.checked || !file.files.length) return;
        if (file.files[0].size > MAX_BYTES) { say('Choose an audio file up to 12 MB.'); return; }
        void update('upload', file.files[0]);
      };
    }
    holder.querySelector('[data-recording-audio]')?.addEventListener('click', () => void update('audio'));
    holder.querySelector('[data-recording-process]')?.addEventListener('click', () => void update('process'));
    holder.querySelector('[data-recording-withdraw]')?.addEventListener('click', () => {
      if (window.confirm('Withdraw recording consent and remove access to this audio and its AI draft? Typed notes will stay.'))
        void update('withdraw');
    });
    holder.querySelector('[data-recording-refresh]').onclick = () => void update('get');
    holder.querySelector('[data-recording-close]').onclick = dispose;
  }
  async function update(action, file) {
    if (busy || !active()) return;
    busy = true;
    const buttons = [...holder.querySelectorAll('button:not([data-recording-close]):not(:disabled)')];
    buttons.forEach(button => { button.disabled = true; });
    const fileInput = holder.querySelector('[data-recording-file]');
    const consentInput = holder.querySelector('[data-recording-consent]');
    if (fileInput) fileInput.disabled = true;
    if (consentInput) consentInput.disabled = true;
    say(action === 'process' ? 'Generating an AI draft. You can close this panel and check later.' : 'Checking recording…');
    try {
      const result = await invoke(action, file);
      if (!result || !active()) return;
      if (action === 'audio') {
        if (document.hidden) return;
        revoke();
        audioUrl = URL.createObjectURL(new Blob([result], { type: state.mime }));
        const player = document.createElement('audio');
        player.controls = true;
        player.src = audioUrl;
        player.style.maxWidth = '100%';
        holder.querySelector('[data-recording-audio]').after(player);
        say('Audio is ready to play.');
      } else {
        state = result;
        render(result.notice);
      }
    } catch (error) { say(error.message); }
    finally {
      busy = false;
      buttons.forEach(button => { if (active() && button.isConnected) button.disabled = false; });
      if (active() && consentInput?.isConnected) {
        consentInput.disabled = false;
        fileInput.disabled = !consentInput.checked;
      }
    }
  }
  holder.hidden = false;
  render();
  void update('get');
  async function verifyPrivate() {
    if (!active() || busy || (!state?.draft && !audioUrl)) return;
    const previous = state;
    try {
      const fresh = await invoke('get');
      if (!fresh || !active() || busy || state !== previous) return;
      if (fresh.state !== state.state || fresh.state_at !== state.state_at || fresh.audio_available !== state.audio_available) {
        state = fresh;
        render();
      } else {
        holder.querySelector('[data-recording-draft]').hidden = document.hidden;
      }
    } catch {
      hidePrivate();
      say('Recording access could not be verified. Refresh recording status.');
    }
  }
  return { dispose, hidePrivate, verifyPrivate };
}
