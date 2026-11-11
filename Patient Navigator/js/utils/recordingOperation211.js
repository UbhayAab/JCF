// One deliberate generation; all recovery observation is read-only.
export function createRecordingOperation211({ invoke, current, now = Date.now,
  schedule = setTimeout, cancel = clearTimeout, onResult, onWaiting,
  onStopped, maxWaitMs = 420000, requestWaitMs = 20000, pollMs = 4000 }) {
  let stopped = false, running = false, generation = 0, pending = null;
  const timers = new Map();
  const alive = token => !stopped && generation === token && current();
  const wait = ms => new Promise(resolve => {
    const timer = schedule(() => { timers.delete(timer); resolve(true); }, ms);
    timers.set(timer, () => resolve(false));
  });
  const bounded = async (promise, remainingMs) => {
    let timer;
    try { return await Promise.race([promise, new Promise(resolve => {
      timer = schedule(() => { timers.delete(timer); resolve(null); }, Math.min(requestWaitMs, Math.max(1, remainingMs)));
      timers.set(timer, () => resolve(null));
    })]); }
    finally { if (timer !== undefined) { cancel(timer); timers.delete(timer); } }
  };
  const stop = () => {
    stopped = true; generation++;
    for (const [timer, release] of timers) { cancel(timer); release(); }
    timers.clear();
  };
  const run = (recovery = null, observeOnly = false) => {
    if (stopped || !current()) return Promise.resolve();
    if (running) return pending;
    running = true;
    const token = ++generation, deadline = now() + maxWaitMs;
    const operation = async () => {
      let readOnly = observeOnly;
      while (alive(token)) {
        let result = null;
        try { result = await bounded(Promise.resolve().then(() => {
          if (!alive(token)) return null;
          return invoke(readOnly ? { status_only: true } : recovery);
        }), deadline - now()); } catch { /* An uncertain send is observed, never repeated. */ }
        if (!alive(token)) return;
        // Only this operation's first request may carry a generation/retry nonce.
        readOnly = true;
        if (result?.ok === true) { onResult(result); return; }
        if (result && result.running !== true && result.pending !== true) {
          onStopped(result); return;
        }
        if (now() >= deadline) {
          onStopped({ pending: true, reason: 'The recording is retained. Processing has not been confirmed yet. Check the saved result; do not upload the file again.' });
          return;
        }
        onWaiting(result);
        if (!await wait(Math.min(pollMs, deadline - now()))) return;
      }
    };
    pending = operation().finally(() => { if (generation === token) { running = false; pending = null; } });
    return pending;
  };
  return { run, stop, isRunning: () => running && !stopped };
}
