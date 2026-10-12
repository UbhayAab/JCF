// ============================================================
// "Call back later": when did the family ask to be called? (sql/182, 183)
// Three quick answers and an exact time. Resolves an ISO string, or null
// when closed without an answer (nothing is logged then).
// ============================================================
import { showModal, closeModal } from './modal.js';
import { sanitize } from '../utils/validators.js';

const pad = (n) => String(n).padStart(2, '0');
const localInput = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const label = (d) => d.toLocaleString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });

function choices(now = new Date()) {
  const out = [];
  const in2h = new Date(now.getTime() + 2 * 3600e3);
  if (in2h.getHours() < 21 && in2h.getHours() >= 9) out.push(['In 2 hours', in2h]);
  const evening = new Date(now); evening.setHours(18, 0, 0, 0);
  if (evening.getTime() - now.getTime() > 30 * 60e3) out.push(['This evening, 6 pm', evening]);
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1); tomorrow.setHours(10, 0, 0, 0);
  out.push(['Tomorrow, 10 am', tomorrow]);
  return out;
}

export function pickCallbackTime(name = 'them') {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; closeModal(); resolve(v); };
    const opts = choices();
    const min = new Date(Date.now() + 10 * 60e3);
    const max = new Date(Date.now() + 14 * 86400e3);
    const el = document.createElement('div');
    el.innerHTML = `
      <p style="margin:0 0 12px">When did ${sanitize(name)} ask you to call back?</p>
      <div style="display:flex;flex-direction:column;gap:8px">
        ${opts.map(([t, d], i) => `<button type="button" class="btn btn-secondary" data-cb="${i}" style="justify-content:space-between;flex-wrap:wrap;gap:6px">
          <span>${t}</span><span class="due-meta">${label(d)}</span></button>`).join('')}
      </div>
      <div class="form-group" style="margin-top:14px">
        <label class="form-label" for="cb-at">Or pick the exact time</label>
        <input class="form-input" type="datetime-local" id="cb-at" min="${localInput(min)}" max="${localInput(max)}" style="max-width:100%" />
      </div>
      <div class="due-meta" id="cb-err" style="color:var(--danger);min-height:1em"></div>`;
    showModal({
      title: 'Call back later', content: el, size: 'sm',
      footer: `<button class="btn btn-ghost" id="cb-cancel" type="button">Cancel</button>
               <button class="btn btn-primary" id="cb-set" type="button">Set this time</button>`,
      onClose: () => { if (!done) { done = true; resolve(null); } },
    });
    el.querySelectorAll('[data-cb]').forEach((b) => b.addEventListener('click', () => finish(opts[Number(b.dataset.cb)][1].toISOString())));
    document.getElementById('cb-cancel')?.addEventListener('click', () => finish(null));
    document.getElementById('cb-set')?.addEventListener('click', () => {
      const v = el.querySelector('#cb-at').value;
      const d = v ? new Date(v) : null;
      if (!d || Number.isNaN(d.getTime()) || d < min || d > max) {
        el.querySelector('#cb-err').textContent = 'Pick a time later today or in the next 14 days.';
        return;
      }
      finish(d.toISOString());
    });
  });
}
