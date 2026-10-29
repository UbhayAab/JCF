// Explicit, temporary browser audio capture. No permission is requested on mount.
// A shared tab's video track is needed for the browser chooser, but is never recorded.
export const SESSION_CAPTURE_MAX_BYTES = 50 * 1024 * 1024;
export const SESSION_CAPTURE_MAX_MS = 90 * 60 * 1000;

export function createSessionAudioCapture({ allowed, changed = () => {}, env = globalThis }) {
  let epoch = 0, disposed = false, phase = 'idle', streams = [], context, recorder, timer;
  let chunks = [], bytes = 0, started = 0, file = null, error = '', stopRequested = false;
  const state = () => ({ phase, file, error, seconds: started ? Math.floor((env.Date.now() - started) / 1000) : 0 });
  const notify = () => { if (!disposed) changed(state()); };
  const stopStream = (s) => s?.getTracks().forEach(t => { try { t.stop(); } catch { /* already stopped */ } });
  function release() {
    if (timer) env.clearInterval(timer);
    timer = null;
    streams.forEach(stopStream); streams = [];
    if (context) { context.close().catch(() => {}); context = null; }
  }
  function cancel(message = '') {
    epoch++; stopRequested = true;
    const old = recorder; recorder = null;
    if (old) { old.onstop = old.ondataavailable = old.onerror = null; if (old.state !== 'inactive') { try { old.stop(); } catch { /* terminal */ } } }
    release(); chunks = []; bytes = 0; file = null; started = 0; error = message; phase = message ? 'error' : 'idle'; notify();
  }
  async function start(mode = 'microphone') {
    if (disposed || !['idle', 'ready', 'error'].includes(phase)) return;
    cancel(); const turn = epoch;
    if (!allowed()) { error = 'Ask for and save the family\'s recording consent first.'; phase = 'error'; notify(); return; }
    const devices = env.navigator?.mediaDevices, MR = env.MediaRecorder;
    if (!env.isSecureContext || !devices?.getUserMedia || !MR) {
      error = 'Audio capture is unavailable in this browser. Upload a complete recording instead.'; phase = 'error'; notify(); return;
    }
    const mime = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find(t => MR.isTypeSupported(t));
    if (!mime || !['microphone', 'tab'].includes(mode)) { error = 'This audio source is not supported. Upload a recording instead.'; phase = 'error'; notify(); return; }
    phase = 'permission'; notify();
    const own = s => { if (disposed || turn !== epoch) { stopStream(s); throw new Error('cancelled'); } streams.push(s); return s; };
    try {
      // This must remain the first permission call in the click's activation.
      if (mode === 'tab') {
        if (!devices.getDisplayMedia) throw new Error('Shared-tab audio is unavailable. Use microphone-only or upload a recording.');
        const tab = own(await devices.getDisplayMedia({ video: true, audio: true }));
        if (!tab.getAudioTracks().length) throw new Error('No shared-tab audio was selected. Select a tab and enable Share tab audio, or upload a complete recording.');
      }
      own(await devices.getUserMedia({ audio: true, video: false }));
      if (!allowed()) throw new Error('Recording consent is no longer current. Nothing was recorded.');
      if (streams.some(s => !s.getAudioTracks().length || s.getAudioTracks().some(t => t.readyState === 'ended'))) throw new Error('The selected audio source has stopped. Try again.');
      let audio;
      if (mode === 'tab') {
        const AC = env.AudioContext || env.webkitAudioContext;
        if (!AC) throw new Error('Audio mixing is unavailable. Upload a complete recording instead.');
        context = new AC(); const sink = context.createMediaStreamDestination();
        streams.forEach(s => context.createMediaStreamSource(new env.MediaStream(s.getAudioTracks())).connect(sink));
        await context.resume();
        if (disposed || turn !== epoch) { stopStream(sink.stream); return; }
        audio = sink.stream; streams.push(audio);
      } else audio = new env.MediaStream(streams[0].getAudioTracks());
      if (disposed || turn !== epoch) return;
      recorder = new MR(audio, { mimeType: mime, audioBitsPerSecond: 64000 });
      const current = recorder; stopRequested = false; chunks = []; bytes = 0;
      streams.forEach(s => s.getTracks().forEach(t => t.addEventListener('ended', () => {
        if (!stopRequested && turn === epoch) cancel('An audio source stopped unexpectedly. This partial recording was discarded.');
      }, { once: true })));
      current.onerror = () => { if (turn === epoch) cancel('The browser could not finish recording. Upload a complete recording instead.'); };
      current.ondataavailable = event => {
        if (disposed || turn !== epoch || !event.data?.size) return;
        bytes += event.data.size;
        if (bytes > SESSION_CAPTURE_MAX_BYTES) { cancel('The recording exceeded 50 MB and was discarded. Upload a smaller complete recording.'); return; }
        chunks.push(event.data);
      };
      current.onstop = () => {
        if (disposed || turn !== epoch) return;
        if (!stopRequested) { cancel('Recording stopped unexpectedly. This partial recording was discarded.'); return; }
        const duration = Math.floor((env.Date.now() - started) / 1000), type = mime.split(';')[0];
        release(); recorder = null;
        if (!allowed() || bytes < 1024 || !chunks.length) { cancel('There is no complete consented audio clip to use. Try again or upload a recording.'); return; }
        file = new env.File(chunks, [`session-${env.Date.now()}.${type === 'audio/mp4' ? 'm4a' : type === 'audio/ogg' ? 'ogg' : 'webm'}`], { type, lastModified: env.Date.now() });
        chunks = []; phase = 'ready'; error = ''; started = 0; file.captureDurationSeconds = duration; notify();
      };
      current.start(1000); started = env.Date.now(); phase = 'recording'; notify();
      timer = env.setInterval(() => {
        if (!allowed()) { cancel('Recording consent changed. The local clip was discarded.'); return; }
        if (env.Date.now() - started >= SESSION_CAPTURE_MAX_MS) { cancel('The 90-minute limit was reached. The partial clip was discarded; upload a complete recording instead.'); return; }
        notify();
      }, 1000);
    } catch (e) {
      if (disposed || turn !== epoch) return;
      cancel(['NotAllowedError', 'PermissionDeniedError'].includes(e?.name) ? 'Microphone or sharing permission was not granted. You can still upload a recording.' : e?.message || 'Could not start audio capture.');
    }
  }
  function stop() {
    if (phase !== 'recording' || !recorder) return;
    stopRequested = true; phase = 'stopping'; notify();
    try { recorder.stop(); } catch { cancel('The recording could not be finished.'); }
    release(); // Stop hardware immediately. Final data/stop events still finish the file.
  }
  return { start, stop, cancel, state, dispose() { if (disposed) return; cancel(); disposed = true; } };
}

export function mountSessionAudioCapture(el, { allowed, acceptFile, changed = () => {} }) {
  let url = null, disposed = false;
  const revoke = () => { if (url) URL.revokeObjectURL(url); url = null; };
  const controller = createSessionAudioCapture({ allowed, changed(s) {
    if (disposed) return;
    revoke(); el.replaceChildren(); changed(s);
    const p = document.createElement('p'); p.className = 'due-meta wraps'; p.setAttribute('role', 'status');
    p.style.flexBasis = '100%';
    p.textContent = s.error || ({ idle: 'Choose an audio source after consent. Browser capture allows up to 90 minutes / 50 MB. Microphone-only does not capture the other person through headphones.', permission: 'Choose and allow the audio source in the browser prompt.', recording: `Recording audio - ${Math.floor(s.seconds / 60)}:${String(s.seconds % 60).padStart(2, '0')}. Stop when the session ends.`, stopping: 'Finishing the local audio clip...', ready: 'Local audio clip ready. Listen, then choose Use recording to upload it.' }[s.phase]);
    el.append(p);
    const button = (label, action) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn btn-secondary btn-sm'; b.textContent = label; b.style.whiteSpace = 'normal'; b.style.height = 'auto'; b.addEventListener('click', action); el.append(b); return b; };
    if (['idle', 'error'].includes(s.phase)) {
      button('Start microphone', () => controller.start('microphone'));
      button('Start microphone + tab audio', () => controller.start('tab'));
    }
    if (s.phase === 'recording') button('Stop recording', controller.stop);
    if (s.phase === 'ready') {
      url = URL.createObjectURL(s.file); const player = document.createElement('audio'); player.controls = true; player.src = url; player.style.maxWidth = '100%'; el.append(player);
      button('Use recording', async () => {
        if (!allowed()) { controller.cancel('Recording consent is no longer current.'); return; }
        const clip = s.file; controller.cancel(); await acceptFile(clip);
      });
    }
    if (s.phase !== 'idle' && s.phase !== 'error') button('Discard local clip', () => controller.cancel());
  } });
  controller.cancel();
  return { ...controller, dispose() { disposed = true; revoke(); controller.dispose(); el.replaceChildren(); } };
}
