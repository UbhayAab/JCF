// ============================================================
// HopeBot in Patient Navigator (sql/172; one caller per request, sql/182).
//
// HopeBot tells a family "a Saarthi will call this number within 4 hours,
// 9 am to 9 pm, and will say the call is from JCF Hope Bot", and pushes the
// request here together with what the family wrote, the sorter's tags and a
// short staff summary. Three views:
//   mountHopebotRequests  open requests, on top of the Calling Portal and the
//                         WhatsApp leads page. Safety first, then by due time.
//                         Each request is ASSIGNED to one caller (Fixboard #31):
//                         the database shows a caller only theirs (and safety),
//                         managers everything, with Assign and the history.
//                         The caller sees the number and the outcomes at once;
//                         No answer and Call back later set the next due time,
//                         Reached closes it and HopeBot reads it.
//   mountHopebotCard      a PN family's HopeBot card on their record.
//   digestHTML            tags, last questions and summary for a lead card.
// Everything a family wrote goes through sanitize() before innerHTML.
// ============================================================
import { getSupabase } from '../supabase.js';
import { getUserRole, isImpersonating } from '../auth.js';
import { showToast } from './toast.js';
import { confirmModal } from './modal.js';
import { icon } from './icons.js';
import { sanitize } from '../utils/validators.js';
import { formatRelativeTime } from '../utils/formatters.js';
import { loadRoster, rosterSelectHTML, reasonText, historyHTML, forgetRoster } from './assignPicker.js';

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
  how_to_send_reports: 'How to send reports', my_reports_back: 'Wants their reports back',
};
// What HopeBot read from the family's reports (sql/175), in the order a caller needs it.
const READ_FIELDS = [['patient', 'Patient'], ['diagnosis', 'Diagnosis'], ['treatment', 'Treatment'], ['genes', 'Genes or markers'],
  ['other_conditions', 'Other conditions'], ['hospital', 'Hospital'], ['doctor', 'Doctor'], ['goal', 'What they want']];
const readLabel = (k) => READ_FIELDS.find(([f]) => f === k)?.[1] || String(k || '').replace(/_/g, ' ');
const CANCERS = {
  breast: 'Breast', muh_gala_ya_jeebh: 'Mouth, throat or tongue', lung_phephde: 'Lung',
  cervix_bachchedani_ka_muh: 'Cervix', ovary: 'Ovary', colon_ya_rectum: 'Colon or rectum',
  pet_ya_khaane_ki_nali: 'Stomach or food pipe', liver_ya_gallbladder: 'Liver or gallbladder',
  brain: 'Brain', blood_cancer: 'Blood cancer', prostate: 'Prostate', koi_aur: 'Other cancer', pata_nahi: 'Cancer type not known',
};
const OUTCOMES = [
  ['reached', 'Reached', 'btn-primary'],
  ['no_answer', 'No answer', 'btn-secondary'],
  ['call_back', 'Call back later', 'btn-secondary'],
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
// The language the family chose on HopeBot (sql/208 keeps 'bn'). Each view
// keeps its own fallback for a missing value, so English and Hindi read as before.
const LANGS = new Map([['en', 'English'], ['hi', 'Hindi'], ['bn', 'Bengali']]);
export const langLabel = (code, fallback) => LANGS.get(code) || fallback;
const BENGALI_TIP = 'This family chose Bengali on HopeBot. A Bengali-speaking Saarthi should call.';
const timeIN = (d) => new Date(d).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true });
const dayIN = (d) => {
  const x = new Date(d); const t = new Date();
  if (x.toDateString() === t.toDateString()) return 'today';
  const y = new Date(t); y.setDate(t.getDate() + 1);
  if (x.toDateString() === y.toDateString()) return 'tomorrow';
  return x.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
};
const fmtPhone = (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length === 12 ? `+91 ${d.slice(2, 7)} ${d.slice(7)}` : d; };

const isManager = () => ['admin', 'manager'].includes(getUserRole());
const ago = (ms) => { const h = Math.floor(ms / 3600e3); const m = Math.round((ms % 3600e3) / 60e3); return `${h ? `${h} h ` : ''}${m} min`; };

// Overdue is measured against the NEXT time a call is due: after No answer
// that is 2 working hours later, after Call back later the time the family
// asked for (sql/182). Before, it only read the first due time, so a family
// that had been called still read "Overdue" (Fixboard #31).
function dueBadge(x) {
  if (x.closed) return `<span class="badge badge-neutral">${sanitize(CLOSED[x.outcome] || 'Closed')}</span>`;
  if (x.safety) return `<span class="badge badge-danger"><span class="dot"></span>Call now</span>`;
  if (isDelete(x)) return `<span class="badge badge-warn"><span class="dot"></span>Delete request</span>`;
  const at = x.effective_due || x.next_due_at || x.due_at;
  const late = Date.now() - Date.parse(at);
  const what = x.callback_at ? 'Call back' : x.attempts > 0 ? 'Try again' : null;
  if (late > 0) {
    return `<span class="badge badge-danger"><span class="dot"></span>${what ? `${what}: overdue` : 'Overdue'} ${ago(late)}</span>`;
  }
  const label = what === 'Call back' ? 'Call back' : what === 'Try again' ? 'Try again by' : 'Due';
  return `<span class="badge ${late > -3600e3 ? 'badge-warn' : 'badge-info'}"><span class="dot"></span>${label} ${timeIN(at)} ${dayIN(at)}</span>`;
}

// Whose it is: a manager reads who has it and why; a caller reads "Yours".
function ownerLine(x) {
  if (x.closed) return '';
  if (x.unassigned) return '<span class="badge badge-warn" title="Nobody is on shift for this team yet; a manager can pick someone">Not assigned yet</span>';
  if (x.assigned_to_me) return '<span class="badge badge-ok">Yours</span>';
  if (!x.assigned_name) return '';
  return `<span class="due-meta wraps">With <strong>${sanitize(x.assigned_name)}</strong>${reasonText(x.assign_reason) ? ` · ${sanitize(reasonText(x.assign_reason))}` : ''}</span>`;
}

function familyLine(f) {
  return [
    f.role === 'caregiver' ? 'Caregiver' : f.role === 'patient' ? 'Patient' : null,
    f.city ? sanitize(f.city) : null,
    cancerLabel(f.cancer_type) ? sanitize(cancerLabel(f.cancer_type)) : null,
    stageLabel(f.stage) ? sanitize(stageLabel(f.stage)) : null,
    langLabel(f.lang, 'Hindi'),
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

function readingHTML(rr) {
  const rows = READ_FIELDS.filter(([k]) => rr?.fields?.[k]);
  const told = (rr?.told_by_family || []).slice(0, 5);
  if (!rows.length && !told.length) return '';
  const files = Number(rr.files_read || 0);
  const meta = [files ? `${files} file${files === 1 ? '' : 's'} read` : null, rr.read_at ? `read ${formatRelativeTime(rr.read_at)}` : null].filter(Boolean).join(' · ');
  return `<details style="margin-top:6px"><summary class="due-meta" style="cursor:pointer;color:var(--ink-1)"><strong>What HopeBot read from their reports</strong>${meta ? ` · ${meta}` : ''}</summary>
    <div class="due-meta wraps" style="margin-top:4px;display:flex;flex-direction:column;gap:2px;color:var(--ink-1)">
      ${rows.map(([k, label]) => `<div><span style="color:var(--ink-3)">${label}:</span> ${sanitize(rr.fields[k])}</div>`).join('')}</div>
    ${told.length ? `<div class="due-meta wraps" style="margin-top:4px">The family corrected: ${told.map((t) => `"${sanitize(t.words)}"${t.field ? ` (${sanitize(readLabel(t.field))})` : ''}`).join('; ')}</div>` : ''}
    <div class="due-meta wraps" style="margin-top:4px">Read by AI from the papers they sent, then checked with the family on WhatsApp. Confirm it on the call before acting on it.</div></details>`;
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
    ${recentHTML(d.recent, max)}
    ${readingHTML(d.report_reading)}`;
}

function requestCardHTML(x, roster) {
  const f = x.family || {};
  const name = f.patient_name || f.name || 'Name not given';
  // Assigned to me: the number and the outcomes straight away, no "I will
  // call" first. A safety call (everyone sees it) or a manager calling for
  // someone still holds it first, so nobody rings twice.
  // "Open as" someone: the screen is theirs but the database acts as you, so
  // nothing here may be pressed (it would move their work to you).
  const act = !isImpersonating();
  const mine = act && !x.closed && (x.held_by_me || (x.assigned_to_me && !x.held_by));
  // Taking someone else's request moves it to you: say so on the button.
  const takeover = x.assigned_name && !x.assigned_to_me && !x.safety;
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
      ${ownerLine(x) ? `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:4px">${ownerLine(x)}</div>` : ''}
      <div class="due-meta wraps" style="margin-top:2px">${familyLine(f)}</div>
      ${x.channel === 'chat' ? '<div class="due-meta wraps" style="margin-top:4px">Asked for a reply in the WhatsApp chat. A call is fine too.</div>' : ''}
      ${x.safety && !x.closed ? `<div class="due-meta wraps" style="margin-top:6px;color:var(--danger)">Call now. If they may be in danger, stay on the line and give Tele-MANAS 14416 (free, 24 hours, Hindi too) or 112.</div>` : ''}
      ${isDelete(x) && !x.closed ? `<div class="due-meta wraps" style="margin-top:6px;color:var(--clay)">They asked HopeBot to delete their data. Nothing has been deleted: call to confirm what they want removed, then ask an admin to erase it, and log the call here.</div>` : ''}
      ${x.hopebot_status === 'claimed' && x.state === 'open' ? '<div class="due-meta" style="margin-top:4px">Someone in the HopeBot console has picked this up.</div>' : ''}
      ${tried ? `<div class="due-meta" style="margin-top:4px">${tried}</div>` : ''}
      ${x.callback_at && !x.closed ? `<div class="due-meta wraps" style="margin-top:4px">They asked to be called back ${timeIN(x.callback_at)} ${dayIN(x.callback_at)}.</div>` : ''}
      ${x.note && !x.closed ? `<div class="due-meta wraps" style="margin-top:4px">Last note: ${sanitize(x.note)}</div>` : ''}
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
                 ${x.held_by_me ? '<button type="button" class="btn btn-ghost btn-sm" data-release>Not now</button>' : ''}
                 ${x.assigned_to_me && !x.safety ? '<button type="button" class="btn btn-ghost btn-sm" data-handback title="Give it to the next caregiver on shift">I cannot call them</button>' : ''}
               </div>
               ${x.held_by_me ? `<div class="due-meta" style="margin-top:4px">Held for you until ${timeIN(x.held_until)}.</div>` : ''}`
            : x.held_by
              ? `<div class="due-meta">${sanitize(x.held_by)} is calling them.</div>`
              : !act ? '<div class="due-meta wraps">Viewing as someone else: actions are off.</div>'
                : `<button type="button" class="btn ${takeover ? 'btn-secondary' : 'btn-primary'} btn-sm" data-take ${takeover ? `data-takeover="${sanitize(x.assigned_name)}"` : ''}>${icon('phoneCall')}${takeover ? 'Take over and call' : 'I will call'}</button>`}
        ${act && !x.closed && isManager() && roster ? `<div class="hb-assign" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px">
            <span class="due-meta">Assign to</span>${rosterSelectHTML(roster, x.assigned_to, { id: x.id, currentName: x.assigned_name })}</div>` : ''}
        ${isManager() ? historyHTML(x.events) : ''}
      </div>
    </div>`;
}

/**
 * The requests block. opts.mode 'calling' hides itself when nothing is open;
 * 'leads' also lists the last day's closed ones.
 */
export async function mountHopebotRequests(el, { mode = 'calling' } = {}) {
  if (!el) return;
  let all = []; let filter = 'all'; const rosters = new Map();
  const load = async () => {
    // Managers read the last week of closed ones on the leads page: the history.
    const hours = mode === 'leads' ? (isManager() ? 168 : 24) : 0;
    const { data, error } = await getSupabase().rpc('hopebot_requests_open', { p_closed_hours: hours });
    if (error) throw error;
    all = Array.isArray(data) ? data : [];
    if (isManager()) {
      for (const team of new Set(all.filter((x) => !x.closed).map((x) => x.team))) {
        try { rosters.set(team, await loadRoster(team)); } catch (e) { console.warn('[hopebot] roster:', e.message); }
      }
    }
  };
  const paint = () => {
    if (!el.isConnected) return;
    const mgr = isManager();
    const open = all.filter((x) => !x.closed);
    const late = (x) => x.safety || x.overdue || (x.overdue == null && Date.parse(x.due_at) < Date.now());
    const shown = !mgr || filter === 'all' ? open
      : filter === 'unassigned' ? open.filter((x) => x.unassigned) : open.filter(late);
    const closed = mode === 'leads' ? all.filter((x) => x.closed) : [];
    if (mode === 'calling' && !open.length) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    const nLate = open.filter(late).length;
    const nFree = open.filter((x) => x.unassigned).length;
    el.innerHTML = `
      <div class="card card-flush" style="${nLate ? 'border-color:var(--danger)' : ''}">
        <div class="card-head"><h3>${mgr ? 'Asked HopeBot for a call' : 'Your HopeBot call requests'}</h3>
          <span class="badge ${nLate ? 'badge-danger' : 'badge-info'}">${open.length} waiting${nLate ? ` · ${nLate} now` : ''}${mgr && nFree ? ` · ${nFree} not assigned` : ''}</span></div>
        <div style="padding:0 var(--s5) var(--s4)">
          <div class="due-meta wraps" style="margin-bottom:10px">${mgr
            ? "HopeBot promised these families a call within 4 hours, 9 am to 9 pm. Each one goes to one caller: the family's own caregiver, else whoever is on shift with the fewest. Use Assign to change it."
            : 'HopeBot promised these families a call within 4 hours, 9 am to 9 pm. They are yours: call, then tap what happened. No answer and Call back later set the next time; Reached closes it, here and in HopeBot.'}</div>
          ${mgr && open.length ? `<div class="chip-row" style="margin-bottom:10px">
            ${[['all', `All ${open.length}`], ['unassigned', `Not assigned ${nFree}`], ['late', `Due now ${nLate}`]].map(([k, l]) =>
              `<button type="button" class="fchip ${filter === k ? 'on' : ''}" data-hbf="${k}">${l}</button>`).join('')}</div>` : ''}
          <div style="display:flex;flex-direction:column;gap:8px">
            ${shown.map((x) => requestCardHTML(x, rosters.get(x.team))).join('') || `<div class="due-meta">${open.length ? 'Nothing under this filter.' : 'Nothing waiting.'}</div>`}
          </div>
          ${closed.length ? `<div class="due-meta" style="margin:14px 0 6px">${mgr ? 'Closed in the last 7 days' : 'Closed in the last day'}</div>
            <div style="display:flex;flex-direction:column;gap:8px">${closed.map((x) => requestCardHTML(x, null)).join('')}</div>` : ''}
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
    el.querySelectorAll('[data-hbf]').forEach((b) => b.addEventListener('click', () => { filter = b.dataset.hbf; paint(); }));
    el.querySelectorAll('.hb-req').forEach((card) => {
      const id = card.dataset.hb;
      const x = all.find((r) => r.id === id) || {};
      card.querySelector('[data-take]')?.addEventListener('click', (e) => {
        const btn = e.currentTarget;
        const from = btn.dataset.takeover;
        if (!from) { act(btn, 'hopebot_request_take', { p_id: id }, null); return; }
        confirmModal(`This request is with ${sanitize(from)}. Taking over moves it from them to you, and they stop seeing it.`,
          () => act(btn, 'hopebot_request_take', { p_id: id }, 'It is yours now. Call them.'),
          { title: 'Take over this call?', confirmLabel: 'Take over and call', danger: false });
      });
      card.querySelector('[data-release]')?.addEventListener('click', (e) => act(e.currentTarget, 'hopebot_request_release', { p_id: id }, 'Given back for someone else to call.'));
      card.querySelector('[data-handback]')?.addEventListener('click', (e) => act(e.currentTarget, 'hopebot_request_handback', { p_id: id },
        'Handed to the next caregiver on shift.'));
      card.querySelector('[data-assign]')?.addEventListener('change', (e) => {
        forgetRoster();
        act(e.currentTarget, 'hopebot_request_assign', { p_id: id, p_to: e.currentTarget.value || null },
          e.currentTarget.value ? 'Assigned.' : 'Back to automatic.');
      });
      card.querySelectorAll('[data-out]').forEach((b) => b.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        const out = btn.dataset.out;
        const note = card.querySelector('.hb-note')?.value || null;
        let back = null;
        if (out === 'call_back') {
          const { pickCallbackTime } = await import('./callbackPicker.js');
          back = await pickCallbackTime(x.family?.patient_name || x.family?.name || 'they');
          if (!back) return;
        }
        act(btn, 'hopebot_request_log', back ? { p_id: id, p_outcome: out, p_note: note, p_callback_at: back } : { p_id: id, p_outcome: out, p_note: note },
          out === 'no_answer' ? (Number(x.attempts) >= 2 ? 'That was the third try: the request is closed as not reached.'
            : 'Logged. Try again in about 2 working hours; it is not overdue until then.')
            : out === 'call_back' ? 'Logged. It comes due again at the time they asked for.'
              : 'Logged. HopeBot will close their request.');
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
        <strong>Talked to HopeBot on WhatsApp</strong>${d.lang === 'bn' ? `<span class="badge badge-info" data-hb-lang="bn" title="${BENGALI_TIP}">Bengali</span>` : ''}
        <span class="due-meta">${d.last_message_at ? `last message ${formatRelativeTime(d.last_message_at)}` : ''}${d.first_seen_at ? ` · first ${formatRelativeTime(d.first_seen_at)}` : ''}</span>
      </div>
      ${open.length ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">${open.map((r) => `<span class="badge badge-warn">${sanitize(reasonLabel(r.reason))}: open</span>`).join('')}
        <a class="due-meta" href="#calling">Call them from the Calling Portal</a></div>` : ''}
      ${digestHTML(d, { max: 5 })}
    </div>`;
}
