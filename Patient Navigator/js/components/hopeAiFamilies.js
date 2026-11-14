// ============================================================
// Fixboard 242: Hope AI for the families you registered.
//
// On the intake dashboard (ground POCs, uploaders): how many of the families
// this person registered were invited to Hope AI, joined it, used a service,
// and are still active; then who to follow up. Data: the read-only RPC
// my_hope_ai_families242 (sql/254), limited to the caller's own families in
// their care scope. QR scans themselves cannot be counted: Hope AI only sees
// a person once they message it.
// ============================================================
import { sanitize } from '../utils/validators.js';

const DAYS = [7, 14, 30];
const n = (v) => Number(v || 0).toLocaleString('en-IN');
const day = (v) => (v ? new Date(v).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }) : 'not recorded');

export function validHopeAi(data, days) {
  const ok = (v) => Number.isSafeInteger(v) && v >= 0;
  if (!data || data.version !== 1 || data.quiet_days !== days || !data.counts) throw new Error('shape');
  for (const k of ['families', 'invited', 'joined', 'used', 'active', 'quiet', 'invited_not_joined', 'follow_up', 'not_joined']) if (!ok(data.counts[k])) throw new Error('count');
  if (!Array.isArray(data.follow_up) || !Array.isArray(data.not_joined) || data.follow_up.length > 50 || data.not_joined.length > 50) throw new Error('lists');
  return data;
}

function step(label, value, note) {
  return `<div class="hai-step"><strong>${sanitize(n(value))}</strong><span>${sanitize(label)}</span>${note ? `<small>${sanitize(note)}</small>` : ''}</div>`;
}

function person(p, line) {
  return `<li class="hai-person"><a href="#patients/${encodeURIComponent(p.patient_id)}"><span class="hai-name">${sanitize(p.name || 'Unnamed family')}</span>`
    + `<span class="hai-meta">${sanitize(p.code || '')}${p.code ? ' · ' : ''}${sanitize(line)}</span></a></li>`;
}

export function hopeAiHTML(d) {
  const c = d.counts, q = d.quiet_days;
  const follow = d.follow_up.map((p) => person(p, p.reason === 'not_used'
    ? `Joined ${day(p.joined_at)}, has not used a Hope AI service yet`
    : `No message to Hope AI in ${q} days (last ${day(p.last_message_at)})`));
  const waiting = d.not_joined.map((p) => person(p, `Invited ${day(p.invited_at)}, has not joined yet`));
  const more = (shown, total) => (total > shown ? `<p class="due-meta">Showing the latest ${shown} of ${n(total)}.</p>` : '');
  return `<div class="hai-funnel" role="list" aria-label="Hope AI for the families you registered">
      ${step('families you registered', c.families)}
      ${step('invited to Hope AI', c.invited)}
      ${step('joined Hope AI', c.joined)}
      ${step('used a Hope AI service', c.used)}
      ${step(`active in the last ${q} days`, c.active)}
    </div>
    <details class="hai-list" ${follow.length ? 'open' : ''}><summary>Follow up: joined but not using it (${n(c.follow_up)})</summary>
      ${follow.length ? `<ul>${follow.join('')}</ul>${more(follow.length, c.follow_up)}` : '<p class="due-meta">Nobody to follow up right now.</p>'}
    </details>
    <details class="hai-list"><summary>Invited but not joined yet (${n(c.not_joined)})</summary>
      ${waiting.length ? `<ul>${waiting.join('')}</ul>${more(waiting.length, c.not_joined)}` : '<p class="due-meta">Everyone you invited has joined.</p>'}
    </details>
    <p class="due-meta hai-note">Scans of the QR code cannot be counted: Hope AI only sees a person once they message it. A family shows here when you registered them in Navigator and the number they use on Hope AI is theirs or their caregiver's. Families who asked not to be contacted are left out of the lists.</p>`;
}

const STYLE = `<style>.hai-funnel{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin:10px 0 14px}
.hai-step{background:var(--surface-2,rgba(0,0,0,.03));border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:2px;min-width:0}
.hai-step strong{font-size:22px;line-height:1.1}.hai-step span{font-size:13px;color:var(--color-text-muted)}
.hai-list{margin:8px 0}.hai-list summary{cursor:pointer;font-weight:600;padding:6px 0}.hai-list ul{list-style:none;margin:6px 0;padding:0}
.hai-person a{display:flex;flex-direction:column;gap:2px;padding:8px 0;border-top:1px solid var(--border,rgba(0,0,0,.08));text-decoration:none;color:inherit}
.hai-name{font-weight:600}.hai-meta{font-size:13px;color:var(--color-text-muted);white-space:normal;overflow-wrap:anywhere}
.hai-note{white-space:normal;overflow:visible;text-overflow:clip;margin-top:10px}</style>`;

export async function mountHopeAiFamilies(host, { sb, active = () => true } = {}) {
  if (!host || !sb) return;
  host.innerHTML = `${STYLE}<section class="card" style="padding:16px" aria-labelledby="hai-title">
    <div style="display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap">
      <h3 id="hai-title" style="margin:0">Hope AI for the families you registered</h3>
      <label class="due-meta">Active means a message in the last
        <select class="form-select" data-hai-days style="width:auto;display:inline-block">${DAYS.map((d) => `<option value="${d}"${d === 14 ? ' selected' : ''}>${d} days</option>`).join('')}</select></label>
    </div><div data-hai-body aria-live="polite"><p role="status">Loading Hope AI use...</p></div></section>`;
  const body = host.querySelector('[data-hai-body]'), select = host.querySelector('[data-hai-days]');
  let seq = 0;
  const load = async () => {
    const mine = ++seq, days = Number(select.value);
    if (!DAYS.includes(days)) return;
    const current = () => active() && host.isConnected && seq === mine && Number(select.value) === days;
    body.innerHTML = '<p role="status">Loading Hope AI use...</p>';
    try {
      const { data, error } = await sb.rpc('my_hope_ai_families242', { p_quiet_days: days });
      if (!current()) return;
      if (error) throw error;
      body.innerHTML = hopeAiHTML(validHopeAi(data, days));
    } catch {
      if (!current()) return;
      body.innerHTML = '<p role="alert">Hope AI use could not load. Nothing has been guessed. Check your connection and refresh.</p>';
    }
  };
  select.addEventListener('change', load);
  await load();
}
