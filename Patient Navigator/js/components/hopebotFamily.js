// ============================================================
// HopeBot in Patient Navigator (sql/172).
//
// HopeBot tells a family "a Saarthi will call this number within 4 hours,
// 9 am to 9 pm, and will say the call is from JCF Hope Bot", and pushes the
// request here together with what the family wrote, the sorter's tags and a
// short staff summary. Three views:
//   mountHopebotRequests  open requests, on top of the Calling Portal and the
//                         WhatsApp leads page. Safety first, then by due time.
//                         "I will call" holds one for 30 minutes and shows the
//                         number; the outcome closes it and HopeBot reads it.
//   mountHopebotCard      a PN family's HopeBot card on their record.
//   digestHTML            tags, last questions and summary for a lead card.
// Everything a family wrote goes through sanitize() before innerHTML.
// ============================================================
import { getSupabase } from '../supabase.js';
import { getUserRole } from '../auth.js';
import { showToast } from './toast.js';
import { icon } from './icons.js';
import { sanitize } from '../utils/validators.js';
import { formatRelativeTime } from '../utils/formatters.js';

const REASONS = {
  doctor_search: 'Wants a doctor near them',
  stay_search: 'Needs a place to stay',
  money_help: 'Needs help with money',
  diet_plan: 'Wants a diet plan',
  trials_request: 'Asked about clinical trials',
  roadmap_request: 'Wants a treatment roadmap',
  reports_review: 'Wants their reports read',
  community_join: 'Wants to join the community',
  user_requested: 'Asked to talk to a person',
  grief: 'Bereaved: someone in the family has died',
  safety_self_harm: 'Safety: may harm themselves',
  safety_emergency: 'Medical emergency',
  deletion_request: 'Delete request: a person handles it',
  other: 'Asked for help (read their words)',
};
const INTENTS = {
  doctor_search: 'Doctor', money_help: 'Money help', stay_travel: 'Stay or travel', diet: 'Diet',
  trials: 'Trials', community: 'Community', passport: 'Passport', roadmap: 'Roadmap',
  roadmap_status: 'Roadmap status', medical_question: 'Medical question', feelings: 'Feelings',
  complaint: 'Complaint', asks_if_human: 'Asked for a person', asks_cost: 'Asked about cost', off_topic: 'Off topic',
};
const CANCERS = {
  breast: 'Breast', muh_gala_ya_jeebh: 'Mouth, throat or tongue', lung_phephde: 'Lung',
  cervix_bachchedani_ka_muh: 'Cervix', ovary: 'Ovary', colon_ya_rectum: 'Colon or rectum',
  pet_ya_khaane_ki_nali: 'Stomach or food pipe', liver_ya_gallbladder: 'Liver or gallbladder',
  brain: 'Brain', blood_cancer: 'Blood cancer', prostate: 'Prostate', koi_aur: 'Other cancer', pata_nahi: 'Cancer type not known',
};
const OUTCOMES = [
  ['reached', 'Reached', 'btn-primary'],
  ['no_answer', 'No answer', 'btn-secondary'],
  ['wrong_number', 'Wrong number', 'btn-secondary'],
  ['not_needed', 'Not needed', 'btn-secondary'],
];
const CLOSED = { reached: 'Reached', wrong_number: 'Wrong number', not_needed: 'Not needed', unreachable: 'Unreachable after 3 tries', handled_in_hopebot: 'Handled in the HopeBot console' };

const pretty = (s) => String(s || '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
export const reasonLabel = (r) => REASONS[r] || pretty(r) || 'Asked for a call';
// HopeBot keeps an open request's first reason when a crisis arrives and only
// marks it safety (sql/173), so say both.
const requestTitle = (x) => (x.safety && !String(x.reason || '').startsWith('safety_')
  ? `Safety: HopeBot flagged a crisis. First asked: ${reasonLabel(x.reason)}`
  : reasonLabel(x.reason));
const isDelete = (x) => x.reason === 'deletion_request' && !x.safety;
const intentLabel = (k) => INTENTS[k] || pretty(k);
export const cancerLabel = (c) => (c ? CANCERS[c] || pretty(c) : null);
export const stageLabel = (s) => (!s ? null : s === 'pata_nahi' || s === 'unknown' ? 'Stage not known' : /^stage_\d$/.test(s) ? `Stage ${s.slice(6)}` : pretty(s));
const timeIN = (d) => new Date(d).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true });
const dayIN = (d) => {
  const x = new Date(d); const t = new Date();
  if (x.toDateString() === t.toDateString()) return 'today';
  const y = new Date(t); y.setDate(t.getDate() + 1);
  if (x.toDateString() === y.toDateString()) return 'tomorrow';
  return x.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
};
const fmtPhone = (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length === 12 ? `+91 ${d.slice(2, 7)} ${d.slice(7)}` : d; };

// Which team's requests a person sees first. Everyone sees safety.
function myTeams() {
  const r = getUserRole();
  if (r === 'nutritionist') return ['nutrition', 'all'];
  if (r === 'caregiver_mentor' || r === 'caller') return ['cgmp', 'all'];
  return null;   // managers, admins, therapists: every team
}

function dueBadge(x) {
  if (x.closed) return `<span class="badge badge-neutral">${sanitize(CLOSED[x.outcome] || 'Closed')}</span>`;
  if (x.safety) return `<span class="badge badge-danger"><span class="dot"></span>Call now</span>`;
  if (isDelete(x)) return `<span class="badge badge-warn"><span class="dot"></span>Delete request</span>`;
  const late = Date.now() - Date.parse(x.due_at);
  if (late > 0) {
    const h = Math.floor(late / 3600e3); const m = Math.round((late % 3600e3) / 60e3);
    return `<span class="badge badge-danger"><span class="dot"></span>Overdue ${h ? `${h} h ` : ''}${m} min</span>`;
  }
  return `<span class="badge ${late > -3600e3 ? 'badge-warn' : 'badge-info'}"><span class="dot"></span>Due ${timeIN(x.due_at)} ${dayIN(x.due_at)}</span>`;
}

function familyLine(f) {
  return [
    f.role === 'caregiver' ? 'Caregiver' : f.role === 'patient' ? 'Patient' : null,
    f.city ? sanitize(f.city) : null,
    cancerLabel(f.cancer_type) ? sanitize(cancerLabel(f.cancer_type)) : null,
    stageLabel(f.stage) ? sanitize(stageLabel(f.stage)) : null,
    f.lang === 'en' ? 'English' : 'Hindi',
  ].filter(Boolean).join(' · ');
}

function recentHTML(list, max = 3) {
  const items = (list || []).slice(0, max);
  if (!items.length) return '';
  return `<div style="display:flex;flex-direction:column;gap:4px;margin-top:6px">${items.map((e) => `
    <div class="due-meta wraps" style="color:var(--ink-2)">
      ${e.safety
        ? '<span class="badge badge-danger" style="margin-right:4px">Safety</span><em>Their words are not kept for a safety message.</em>'
        : `"${sanitize(e.text || '')}"`}
      <span style="color:var(--ink-3)"> · ${e.intent ? sanitize(intentLabel(e.intent)) + ' · ' : ''}${formatRelativeTime(e.at)}</span>
    </div>`).join('')}</div>`;
}

// Tags, last questions and summary. Used on a lead card and the record card.
export function digestHTML(d, { max = 3 } = {}) {
  if (!d) return '';
  const by = Object.entries(d.counts?.by_intent || {}).sort((a, b) => b[1] - a[1]).slice(0, 6);
  return `
    ${d.summary ? `<div class="due-meta wraps" style="margin-top:6px;color:var(--ink-1)"><strong>HopeBot's summary:</strong> ${sanitize(d.summary)}</div>` : ''}
    ${by.length || d.counts?.in ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">
      ${d.counts?.in ? `<span class="badge badge-neutral">${Number(d.counts.in)} message${Number(d.counts.in) === 1 ? '' : 's'} to HopeBot</span>` : ''}
      ${by.map(([k, n]) => `<span class="badge badge-info">${sanitize(intentLabel(k))} ${Number(n)}</span>`).join('')}
      ${d.counts?.safety ? `<span class="badge badge-danger">Safety ${Number(d.counts.safety)}</span>` : ''}
      ${d.counts?.stop ? `<span class="badge badge-warn">Said STOP</span>` : ''}
    </div>` : ''}
    ${recentHTML(d.recent, max)}`;
}

function requestCardHTML(x) {
  const f = x.family || {};
  const name = f.patient_name || f.name || 'Name not given';
  const mine = x.held_by_me;
  const tried = x.attempts > 0 ? `Tried ${x.attempts} time${x.attempts === 1 ? '' : 's'}, last ${formatRelativeTime(x.last_attempt_at)}` : null;
  return `
    <div class="card hb-req" data-hb="${sanitize(x.id)}" style="padding:12px 14px;${x.closed ? 'opacity:.65;' : ''}${x.safety && !x.closed ? 'border-color:var(--danger);' : ''}${isDelete(x) && !x.closed ? 'border-color:var(--clay);' : ''}">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        ${dueBadge(x)}
        <span style="font-weight:700">${sanitize(name)}</span>
        ${f.patient_id ? `<a class="due-meta" href="#patients/${sanitize(f.patient_id)}">Open their record</a>` : ''}
        <span style="flex:1"></span>
        <span class="due-meta">asked ${formatRelativeTime(x.asked_at)}</span>
      </div>
      <div style="margin-top:4px;font-weight:600">${sanitize(requestTitle(x))}</div>
      <div class="due-meta wraps" style="margin-top:2px">${familyLine(f)}</div>
      ${x.channel === 'chat' ? '<div class="due-meta wraps" style="margin-top:4px">Asked for a reply in the WhatsApp chat. A call is fine too.</div>' : ''}
      ${x.safety && !x.closed ? `<div class="due-meta wraps" style="margin-top:6px;color:var(--danger)">Call now. If they may be in danger, stay on the line and give Tele-MANAS 14416 (free, 24 hours, Hindi too) or 112.</div>` : ''}
      ${isDelete(x) && !x.closed ? `<div class="due-meta wraps" style="margin-top:6px;color:var(--clay)">They asked HopeBot to delete their data. Nothing has been deleted: call to confirm what they want removed, then ask an admin to erase it, and log the call here.</div>` : ''}
      ${x.hopebot_status === 'claimed' && x.state === 'open' ? '<div class="due-meta" style="margin-top:4px">Someone in the HopeBot console has picked this up.</div>' : ''}
      ${tried ? `<div class="due-meta" style="margin-top:4px">${tried}</div>` : ''}
      ${digestHTML(x.digest)}
      <div class="hb-actions" style="margin-top:10px">
        ${x.closed
          ? `<div class="due-meta">${x.closed_by ? `${sanitize(x.closed_by)} · ` : ''}${formatRelativeTime(x.closed_at)}${x.my_note ? ` · ${sanitize(x.my_note)}` : ''}</div>`
          : mine
            ? `<div class="due-meta wraps" style="margin-bottom:6px;color:var(--ink-1)">Say you are calling from <strong>JCF Hope Bot</strong>; that is what HopeBot told them.</div>
               <a class="btn btn-gold btn-sm" href="tel:+${sanitize(String(f.phone || '').replace(/\D/g, ''))}">${icon('phoneCall')}${sanitize(fmtPhone(f.phone))}</a>
               <textarea class="form-input hb-note" rows="2" maxlength="1000" placeholder="What did you do for them? (optional)" style="margin-top:8px;width:100%"></textarea>
               <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">
                 ${OUTCOMES.map(([v, label, cls]) => `<button type="button" class="btn ${cls} btn-sm" data-out="${v}">${label}</button>`).join('')}
                 <button type="button" class="btn btn-ghost btn-sm" data-release>Not now</button>
               </div>
               <div class="due-meta" style="margin-top:4px">Held for you until ${timeIN(x.held_until)}.</div>`
            : x.held_by
              ? `<div class="due-meta">${sanitize(x.held_by)} is calling them.</div>`
              : `<button type="button" class="btn btn-primary btn-sm" data-take>${icon('phoneCall')}I will call</button>`}
      </div>
    </div>`;
}

/**
 * The requests block. opts.mode 'calling' hides itself when nothing is open;
 * 'leads' also lists the last day's closed ones.
 */
export async function mountHopebotRequests(el, { mode = 'calling' } = {}) {
  if (!el) return;
  let all = []; let showAll = false;
  const load = async () => {
    const { data, error } = await getSupabase().rpc('hopebot_requests_open', { p_closed_hours: mode === 'leads' ? 24 : 0 });
    if (error) throw error;
    all = Array.isArray(data) ? data : [];
  };
  const paint = () => {
    if (!el.isConnected) return;
    const teams = myTeams();
    const open = all.filter((x) => !x.closed);
    const mineFirst = teams && !showAll ? open.filter((x) => teams.includes(x.team)) : open;
    const others = open.length - mineFirst.length;
    const closed = mode === 'leads' ? all.filter((x) => x.closed) : [];
    if (mode === 'calling' && !open.length) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    const late = mineFirst.filter((x) => x.safety || Date.parse(x.due_at) < Date.now()).length;
    el.innerHTML = `
      <div class="card card-flush" style="${late ? 'border-color:var(--danger)' : ''}">
        <div class="card-head"><h3>Asked HopeBot for a call</h3>
          <span class="badge ${late ? 'badge-danger' : 'badge-info'}">${mineFirst.length} waiting${late ? ` · ${late} now` : ''}</span></div>
        <div style="padding:0 var(--s5) var(--s4)">
          <div class="due-meta wraps" style="margin-bottom:10px">HopeBot promised these families a call within 4 hours, between 9 am and 9 pm. Take one, call, and log what happened; HopeBot closes their request.</div>
          <div style="display:flex;flex-direction:column;gap:8px">
            ${mineFirst.map(requestCardHTML).join('') || '<div class="due-meta">Nothing waiting for your team.</div>'}
          </div>
          ${others > 0 ? `<button type="button" class="btn btn-ghost btn-sm" data-show-all style="margin-top:8px">Show ${others} for the other team</button>` : ''}
          ${closed.length ? `<div class="due-meta" style="margin:14px 0 6px">Closed in the last day</div>
            <div style="display:flex;flex-direction:column;gap:8px">${closed.map(requestCardHTML).join('')}</div>` : ''}
        </div>
      </div>`;
    wire();
  };
  const act = async (btn, fn, args, done) => {
    btn.disabled = true;
    try {
      const { error } = await getSupabase().rpc(fn, args);
      if (error) throw error;
      if (done) showToast(done, 'success', 2500);
    } catch (e) {
      showToast(e.message || 'That did not work. Try again.', 'error');
    }
    try { await load(); } catch {}
    paint();
  };
  const wire = () => {
    el.querySelector('[data-show-all]')?.addEventListener('click', () => { showAll = true; paint(); });
    el.querySelectorAll('.hb-req').forEach((card) => {
      const id = card.dataset.hb;
      card.querySelector('[data-take]')?.addEventListener('click', (e) => act(e.currentTarget, 'hopebot_request_take', { p_id: id }, null));
      card.querySelector('[data-release]')?.addEventListener('click', (e) => act(e.currentTarget, 'hopebot_request_release', { p_id: id }, 'Given back for someone else to call.'));
      card.querySelectorAll('[data-out]').forEach((b) => b.addEventListener('click', (e) => {
        const out = e.currentTarget.dataset.out;
        const note = card.querySelector('.hb-note')?.value || null;
        act(e.currentTarget, 'hopebot_request_log', { p_id: id, p_outcome: out, p_note: note },
          out === 'no_answer' ? 'Logged. It stays on the list for another try.' : 'Logged. HopeBot will close their request.');
      }));
    });
  };
  try {
    await load();
  } catch (e) {
    // Not deployed yet, or a network blip: the page around it still works.
    console.warn('[hopebot] requests unavailable:', e.message);
    if (mode === 'leads') el.innerHTML = `<div class="due-meta">Could not load HopeBot requests: ${sanitize(e.message)}</div>`;
    else el.hidden = true;
    return;
  }
  paint();
}

/** A PN family's HopeBot card on their record. Hidden when they never wrote. */
export async function mountHopebotCard(el, patientId) {
  if (!el || !patientId) return;
  let d = null;
  try {
    const { data, error } = await getSupabase().rpc('hopebot_family_for_patient', { p_patient: patientId });
    if (error) throw error;
    d = data;
  } catch (e) {
    console.warn('[hopebot] card unavailable:', e.message);
  }
  if (!el.isConnected) return;
  if (!d) { el.hidden = true; el.innerHTML = ''; return; }
  const open = (d.requests || []).filter((r) => r.state !== 'closed');
  el.hidden = false;
  el.innerHTML = `
    <div class="card" style="padding:12px 14px;margin:0 0 12px">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span style="display:inline-flex;width:18px;height:18px">${icon('message')}</span>
        <strong>Talked to HopeBot on WhatsApp</strong>
        <span class="due-meta">${d.last_message_at ? `last message ${formatRelativeTime(d.last_message_at)}` : ''}${d.first_seen_at ? ` · first ${formatRelativeTime(d.first_seen_at)}` : ''}</span>
      </div>
      ${open.length ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">${open.map((r) => `<span class="badge badge-warn">${sanitize(reasonLabel(r.reason))}: open</span>`).join('')}
        <a class="due-meta" href="#calling">Call them from the Calling Portal</a></div>` : ''}
      ${digestHTML(d, { max: 5 })}
    </div>`;
}
