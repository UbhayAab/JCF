// ============================================================
// Patient Navigator: WhatsApp leads (HopeBot profiles)
//
// People who finished the HopeBot onboarding (name, city, cancer type,
// stage) land in hopebot_leads, phone-keyed. A lead is NOT a patient:
// nothing here feeds the registry or the impact numbers. Staff call them
// and either mark contacted or convert by hand into a real patient record.
// Since sql/172 HopeBot also pushes what each family wrote, the sorter's
// tags and a short summary (hopebot_family_digest, calling roles only), and
// callback requests remain available in a compact disclosure below search.
// Since sql/182 (Fixboard #31) a family that is not a PN family has ONE
// caller: a caller reads only their own (row security), a manager reads all
// and gives a family to someone with the Caller select.
// ============================================================

import { getSupabase } from '../supabase.js';
import { showToast } from '../components/toast.js';
import { showModal, closeModal } from '../components/modal.js';
import { icon } from '../components/icons.js';
import { sanitize } from '../utils/validators.js';
import { formatRelativeTime } from '../utils/formatters.js';
import { mountHopebotRequests, digestHTML, cancerLabel, stageLabel } from '../components/hopebotFamily.js';
import { getCurrentProfile, isManagerOrAdmin } from '../auth.js';
import { loadRoster, rosterSelectHTML, forgetRoster } from '../components/assignPicker.js';

let rows = [];
let digests = new Map(); // lead_id -> what they wrote, tags, summary (sql/172)
let filter = 'new'; // new | contacted | all | nocaller (managers) | team
let roster = null;  // managers: who can take a family (hopebot_assignable)
let requestsKnown = false; // Never offer a journal action while callback state is unknown.
let openReqs = new Map(); // lead_id -> open HopeBot request ids this person may log
let searchQ = '';
// The family's HopeBot language (sql/208 keeps 'bn'). A local copy, not an
// import: a phone may still hold the previous hopebotFamily.js for a while
// (tools/stale_import_check.mjs).
const LEAD_LANGS = new Map([['en', 'English'], ['hi', 'Hindi'], ['bn', 'Bengali']]);

export async function renderLeads(container) {
  filter = 'new';
  searchQ = '';
  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>WhatsApp leads</h1>
        <p class="header-subtitle" style="margin:4px 0 0">${isManagerOrAdmin()
          ? 'Everyone who wrote to HopeBot on WhatsApp: what they asked, who is waiting for a call, and which caller has them.'
          : 'The families who wrote to HopeBot on WhatsApp and are yours to call: what they asked, and who is waiting for a call.'}</p>
      </div>
      <button class="btn btn-secondary btn-sm" id="wl-refresh">${icon('refresh')}Refresh</button>
    </div>
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:var(--s2)">
      <div class="chip-row" id="wl-filter">
        <button type="button" class="fchip" data-f="new">New</button>
        <button type="button" class="fchip" data-f="contacted">Contacted</button>
        <button type="button" class="fchip" data-f="all">All</button>
        ${isManagerOrAdmin() ? '<button type="button" class="fchip" data-f="nocaller">No caller yet</button>' : ''}
        <button type="button" class="fchip" data-f="team" title="Team members' own numbers: not families">Team</button>
      </div>
      <div class="table-search" style="max-width:420px;flex:1 1 260px">
        ${icon('search')}
        <input class="form-input" id="wl-search" type="search" autocomplete="off"
          placeholder="Name, phone, city, cancer type…" aria-label="Search leads" />
      </div>
    </div>
    <p class="due-meta" style="margin:0 0 14px;overflow-wrap:anywhere;white-space:normal">Assigned WhatsApp-only leads stay here. Registered families are in <a href="#patients">Patients</a>. Each account sees its authorised records, so its total can differ from a manager's. Choose All to include Contacted leads. For an assigned lead without a requested callback, use Log follow-up after the conversation.</p>
    <div id="wl-requests" style="margin-bottom:var(--s3)"></div>
    <div id="wl-body"><div class="card" style="padding:28px;text-align:center;color:var(--ink-3)">Loading leads…</div></div>`;

  // A bare `load` here received the click EVENT as its container and threw on
  // container.querySelector, so Refresh never refreshed anything.
  container.querySelector('#wl-refresh')?.addEventListener('click', () => {
    mountHopebotRequests(container.querySelector('#wl-requests'), { mode: 'leads' });
    load(container);
  });
  container.querySelectorAll('#wl-filter .fchip').forEach(b => b.addEventListener('click', () => {
    filter = b.dataset.f;
    paint(container);
  }));
  container.querySelector('#wl-search')?.addEventListener('input', (e) => {
    searchQ = e.target.value.trim().toLowerCase();
    paint(container);
  });
  mountHopebotRequests(container.querySelector('#wl-requests'), { mode: 'leads' });
  await load(container);
}

async function load(container) {
  const body = container.querySelector('#wl-body');
  requestsKnown = false;
  try {
    // Newest ACTIVITY first, not newest signup: when someone asks HopeBot for a
    // volunteer call, their lead is reopened with the request in `notes`, and
    // it has to come to the top instead of staying where it first landed.
    // is_team (sql/190): a team member's own number, matched live against
    // confirmed numbers. Not a family: kept apart from the family lists.
    let { data, error } = await getSupabase().from('hopebot_leads')
      .select('*, is_team').order('updated_at', { ascending: false }).limit(300);
    if (error && /is_team/.test(error.message || '')) {
      ({ data, error } = await getSupabase().from('hopebot_leads')
        .select('*').order('updated_at', { ascending: false }).limit(300));
    }
    if (error) throw error;
    rows = data || [];
    // Only the calling roles read these; for anyone else this is simply empty.
    const { data: dg } = await getSupabase().from('hopebot_family_digest')
      .select('lead_id, counts, recent, summary, summary_at, report_reading').limit(1000);
    digests = new Map((dg || []).map(d => [d.lead_id, d]));
    // sql/182 (cos rework of #31): a family with an open call request is not
    // "contacted" by a tap here; the call has to be logged on the request, or
    // the request stays Overdue and HopeBot never hears what happened. Row
    // security returns only the requests this person may act on.
    openReqs = new Map();
    // A deletion request is a person's other job (sql/173), never "a call".
    const { data: rq, error: requestError } = await getSupabase().from('hopebot_requests')
      .select('id, lead_id, team').neq('state', 'closed').neq('team', 'admin').order('due_at').limit(1000);
    requestsKnown = !requestError;
    (rq || []).forEach((x) => openReqs.set(x.lead_id, [...(openReqs.get(x.lead_id) || []), x.id]));
    if (isManagerOrAdmin()) {
      try { roster = await loadRoster('cgmp'); } catch (e) { roster = null; console.warn('[leads] roster:', e.message); }
    }
  } catch (e) {
    if (body) body.innerHTML = `<div class="empty"><h4>Could not load leads</h4><p>${sanitize(e.message)}</p></div>`;
    return;
  }
  paint(container);
}

function visible() {
  return rows
    .filter(r => filter === 'team' ? r.is_team : !r.is_team)
    .filter(r => filter === 'all' || filter === 'team' ? true : filter === 'contacted' ? r.contacted
      : filter === 'nocaller' ? !r.patient_id && !r.assigned_to : !r.contacted)
    .filter(r => !searchQ || [r.name, r.phone, r.city, r.cancer_type, r.stage, r.notes, digests.get(r.id)?.summary]
      .filter(Boolean).join(' ').toLowerCase().includes(searchQ));
}

function paint(container) {
  const body = container.querySelector('#wl-body');
  if (!body) return;
  container.querySelectorAll('#wl-filter .fchip').forEach(b =>
    b.classList.toggle('on', b.dataset.f === filter));
  const list = visible();
  const fresh = rows.filter(r => !r.contacted && !r.is_team).length;
  if (!list.length) {
    body.innerHTML = `<div class="card" style="padding:28px;text-align:center;color:var(--ink-3)">
      ${filter === 'team' ? 'No team member has written to HopeBot from their own number.'
        : fresh ? 'Nothing under this filter.' : 'No WhatsApp leads yet. They appear here when someone writes to HopeBot.'}</div>`;
    return;
  }
  body.innerHTML = `
    <div class="due-meta" style="margin-bottom:8px">${filter === 'team'
      ? `${list.length} team member${list.length === 1 ? '' : 's'} who wrote to HopeBot from their own number. Not families: HopeBot gives them the team menu.`
      : `${fresh} new lead${fresh === 1 ? '' : 's'}`}</div>
    <div style="display:flex;flex-direction:column;gap:8px">
    ${list.map(r => `
      <div class="card" style="padding:12px 14px;${r.contacted ? 'opacity:.65' : ''}">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <span style="font-weight:700">${sanitize(r.name || 'Unknown')}</span>
          <a class="tnum" href="tel:${sanitize(String(r.phone).replace(/[^+\d]/g, ''))}">${sanitize(r.phone)}</a>
          ${r.is_team ? '<span class="badge badge-warn" title="Own number of a team member: not a family">Team</span>'
            : r.contacted ? '<span class="badge badge-ok">Contacted</span>' : '<span class="badge badge-info">New</span>'}
          <span style="flex:1"></span>
          ${r.patient_id ? `<a class="due-meta" href="#patients/${sanitize(r.patient_id)}">Already a PN family</a>` : ''}
          <span class="due-meta">${r.last_message_at ? 'wrote ' + formatRelativeTime(r.last_message_at) : formatRelativeTime(r.updated_at || r.created_at)}</span>
          ${r.is_team ? '' : openReqs.has(r.id)
            ? `<button class="btn btn-primary btn-sm" data-log-call="${sanitize(r.id)}" title="They asked HopeBot for a call: say what happened, and the request closes here and in HopeBot">Log the call</button>`
            : `<button class="btn ${r.contacted ? 'btn-secondary' : 'btn-primary'} btn-sm" data-lead="${r.id}" data-to="${r.contacted ? 0 : 1}">
            ${r.contacted ? 'Reopen' : 'Mark contacted'}
          </button>`}
        </div>
        ${!r.is_team && !r.patient_id && !openReqs.has(r.id) && (isManagerOrAdmin() || r.assigned_to === getCurrentProfile()?.id) ? `<div style="margin-top:8px"><button type="button" class="btn btn-secondary btn-sm" data-log-followup="${sanitize(r.id)}" ${requestsKnown ? '' : 'disabled'} title="${requestsKnown ? 'Record a follow-up already completed with this assigned lead' : 'Refresh to check existing callback requests first'}">Log follow-up</button></div>` : ''}
        ${r.is_team ? '' : callerLine(r)}
        <div class="due-meta" style="margin-top:4px">${[
          r.role === 'caregiver' ? 'Caregiver' : r.role === 'patient' ? 'Patient' : null,
          r.city && r.city !== 'other' ? sanitize(r.city) : 'City not pinned',
          r.cancer_type ? sanitize(cancerLabel(r.cancer_type)) : null,
          r.stage && r.stage !== 'unknown' ? sanitize(/^stage_|pata_nahi/.test(r.stage) ? stageLabel(r.stage) : 'Stage ' + r.stage) : null,
          LEAD_LANGS.get(r.lang) || 'English',
        ].filter(Boolean).join(' · ')}</div>
        ${r.notes ? `<div class="due-meta" style="margin-top:6px;color:var(--ink-1);white-space:pre-wrap">${sanitize(r.notes)}</div>` : ''}
        ${digestHTML(digests.get(r.id))}
      </div>`).join('')}
    </div>`;
  body.querySelectorAll('[data-lead-assign]').forEach(sel => sel.addEventListener('change', async () => {
    sel.disabled = true;
    try {
      const { error } = await getSupabase().rpc('hopebot_lead_assign', { p_lead: sel.dataset.leadAssign, p_to: sel.value || null });
      if (error) throw error;
      forgetRoster();
      showToast(sel.value ? 'Assigned under WhatsApp leads. Their open call requests went with it.' : 'No caller now.', 'success', 2500);
    } catch (e) {
      showToast(e.message || 'Could not assign.', 'error');
    }
    await load(container);
    mountHopebotRequests(container.querySelector('#wl-requests'), { mode: 'leads' });
  }));
  body.querySelectorAll('[data-log-followup]').forEach(b => b.addEventListener('click', async () => {
    const r = rows.find(x => x.id === b.dataset.logFollowup);
    const actor = getCurrentProfile()?.id, route = window.location.hash;
    const current = () => container.isConnected && getCurrentProfile()?.id === actor && window.location.hash === route;
    b.disabled = true;
    try {
      const journal = await import('../components/leadFollowup.js?v=assigned102');
      if (!current()) return;
      if (typeof journal.openLeadFollowup !== 'function') throw new Error('Reload to get the follow-up form.');
      journal.openLeadFollowup(r, { isCurrent: current, onSaved: async () => { if (current()) { filter = 'all'; await load(container); } } });
    } catch (e) { if (current()) showToast(e.message || 'Could not open follow-up. Reload and try again.', 'error'); }
    finally { if (b.isConnected && current()) b.disabled = false; }
  }));
  body.querySelectorAll('[data-log-call]').forEach(b => b.addEventListener('click', () => {
    const r = rows.find(x => x.id === b.dataset.logCall);
    openLogCall(container, r, openReqs.get(b.dataset.logCall) || []);
  }));
  body.querySelectorAll('[data-lead]').forEach(b => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      const { error } = await getSupabase().from('hopebot_leads')
        .update({ contacted: b.dataset.to === '1', updated_at: new Date().toISOString() })
        .eq('id', b.dataset.lead);
      if (error) throw error;
      rows = rows.map(r => r.id === b.dataset.lead ? { ...r, contacted: b.dataset.to === '1' } : r);
      showToast(b.dataset.to === '1' ? 'Marked contacted' : 'Reopened', 'success', 2000);
    } catch (e) {
      showToast('Could not update: ' + e.message, 'error');
    }
    paint(container);
  }));
}

// Who calls this family. A PN family is called by its own caregiver (their
// record says who); a WhatsApp-only family has one caller (sql/182).
function callerLine(r) {
  if (r.patient_id) return '';
  if (isManagerOrAdmin() && roster) {
    return `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:6px">
      <span class="due-meta">Caregiver mentor</span>${rosterSelectHTML(roster, r.assigned_to, { attr: 'data-lead-assign', id: r.id, auto: 'Nobody yet', onlyTeam: true })}</div>`;
  }
  if (r.assigned_to && r.assigned_to === getCurrentProfile()?.id) return '<div style="margin-top:6px"><span class="badge badge-ok">Yours to call</span></div>';
  return '';
}

// "Log the call" for a family with an open HopeBot request: the same outcomes
// as the request card (hopebot_request_log), for every open request of theirs
// this person may log. Reached also marks the family contacted here.
const LOG_OUTCOMES = [
  ['reached', 'Reached', 'btn-primary'],
  ['no_answer', 'No answer', 'btn-secondary'],
  ['call_back', 'Call back later', 'btn-secondary'],
  ['wrong_number', 'Wrong number', 'btn-secondary'],
  ['not_needed', 'Not needed', 'btn-ghost'],
];
function openLogCall(container, r, reqIds) {
  if (!r || !reqIds.length) return;
  const el = document.createElement('div');
  el.innerHTML = `
    <p style="margin:0 0 10px">${sanitize(r.name || 'This family')} asked HopeBot for a call. What happened when you called?</p>
    <textarea class="form-input" id="lc-note" rows="2" maxlength="1000" placeholder="What did you do for them? (optional)" style="width:100%"></textarea>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px">
      ${LOG_OUTCOMES.map(([v, l, cls]) => `<button type="button" class="btn ${cls} btn-sm" data-lc="${v}">${l}</button>`).join('')}
    </div>
    <p class="due-meta wraps" style="margin-top:10px">No answer sets the next try about 2 working hours later; Call back later waits for the time they asked for. Reached closes it here and in HopeBot.</p>`;
  showModal({ title: 'Log the call', content: el, size: 'sm' });
  el.querySelectorAll('[data-lc]').forEach((btn) => btn.addEventListener('click', async () => {
    const out = btn.dataset.lc;
    const note = el.querySelector('#lc-note').value || null;
    let back = null;
    if (out === 'call_back') {
      closeModal();
      const { pickCallbackTime } = await import('../components/callbackPicker.js');
      back = await pickCallbackTime(r.name || 'they');
      if (!back) return;
    }
    el.querySelectorAll('[data-lc]').forEach((x) => { x.disabled = true; });
    // Each request on its own: one refused (someone else on the call, already
    // closed) never stops or repeats the others. The page reloads either way.
    const failed = [];
    let logged = 0;
    for (const id of reqIds) {
      const { error } = await getSupabase().rpc('hopebot_request_log',
        back ? { p_id: id, p_outcome: out, p_note: note, p_callback_at: back } : { p_id: id, p_outcome: out, p_note: note });
      if (error) failed.push(error.message); else logged++;
    }
    if (out === 'reached' && logged) {
      const { error } = await getSupabase().from('hopebot_leads')
        .update({ contacted: true, updated_at: new Date().toISOString() }).eq('id', r.id);
      if (error) failed.push('Logged, but the family could not be marked contacted: ' + error.message);
    }
    if (failed.length) showToast(failed[0], 'error', 6000);
    else showToast(out === 'reached' ? 'Logged. HopeBot will close their request.'
      : out === 'no_answer' ? 'Logged. Try again in about 2 working hours; it is not overdue until then.'
        : out === 'call_back' ? 'Logged. It comes due again at the time they asked for.' : 'Logged.', 'success', 3500);
    closeModal();
    await load(container);
    mountHopebotRequests(container.querySelector('#wl-requests'), { mode: 'leads' });
  }));
}
