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
import { getCurrentUser, getCurrentProfile, isManagerOrAdmin, isImpersonating } from '../auth.js';
import { leadKind, LEAD_LABELS, newestLeads } from '../utils/leadTriage.js';
import { loadRoster, rosterSelectHTML, forgetRoster } from '../components/assignPicker.js';

const leadMounts = new WeakMap();
// The family's HopeBot language (sql/208 keeps 'bn'). A local copy, not an
// import: a phone may still hold the previous hopebotFamily.js for a while
// (tools/stale_import_check.mjs).
const LEAD_LANGS = new Map([['en', 'English'], ['hi', 'Hindi'], ['bn', 'Bengali']]);

export async function renderLeads(container) {
  let rows = [];
  let digests = new Map(); // lead_id -> what they wrote, tags, summary (sql/172)
  let filter = 'new'; // new | contacted | all | nocaller (managers) | team
  let roster = null;  // managers: who can take a family (hopebot_assignable)
  let requestsKnown = false; // Never offer a journal action while callback state is unknown.
  let openReqs = new Map(); // lead_id -> open HopeBot request ids this person may log
  let searchQ = '';

  let loadGeneration=0;
  const token={};leadMounts.set(container,token);
  const actor=getCurrentUser()?.id;const routeAtMount=window.location.hash;
  const current=()=>!!actor&&window.location.hash===routeAtMount&&container.isConnected&&leadMounts.get(container)===token&&getCurrentUser()?.id===actor&&getCurrentProfile()?.id===actor&&!isImpersonating();
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
        <button type="button" class="fchip" data-f="review">Needs review</button>
        <button type="button" class="fchip" data-f="team" title="Confirmed staff test numbers, separate from families">Team tests</button>
      </div>
      <div class="table-search" style="max-width:420px;flex:1 1 260px">
        ${icon('search')}
        <input class="form-input" id="wl-search" type="search" autocomplete="off"
          placeholder="Name, phone, city, cancer type…" aria-label="Search leads" />
      </div>
    </div>
    <p class="due-meta" style="margin:0 0 14px;overflow-wrap:anywhere;white-space:normal">Assigned WhatsApp-only leads stay here. Registered families are in <a href="#patients">Patients</a>. Each account sees its authorised records, so its total can differ from a manager's. Choose All to include Contacted leads. For an assigned lead without a requested callback, use Log follow-up after the conversation.</p>
    <p class="due-meta wraps">Newest leads first, by date added. Showing up to the latest 300 accessible leads; contacting or assigning a lead does not move it above a new signup.</p>
    <details class="card" style="padding:12px;margin-bottom:14px"><summary style="cursor:pointer">Patient view for team testing and registration review</summary><p class="wraps">For a confirmed team number, open HopeBot on WhatsApp, type TEAM and choose Try the family bot. The existing test lasts two hours and keeps test leads, requests and papers out of Patient Navigator. Type TEAM to exit. If your number is not recognised, confirm it with your manager first.</p><p class="wraps">Patient and caregiver badges reflect what the person told HopeBot. AI summaries can help review their words; they do not establish identity or consent. For an unlinked number, check existing family/contact records in <a href="#patients">Patients</a>. Register only after confirming the patient identity and informed consent. A caregiver's name or number must not be copied as the patient by assumption. Assigned unlinked leads can still use their existing follow-up journal.</p></details>
    <p data-lead-classification-warning class="due-meta wraps" role="status" hidden>Some leads are withheld because team classification could not be confirmed. Refresh to retry.</p>
    <div id="wl-requests" style="margin-bottom:var(--s3)"></div>
    <div id="wl-body"><div class="card" style="padding:28px;text-align:center;color:var(--ink-3)">Loading leads…</div></div>`;

  if(!current()){container.querySelector('#wl-body').textContent='Return to your own signed-in account to view WhatsApp leads.';return;}
  // A bare `load` here received the click EVENT as its container and threw on
  // container.querySelector, so Refresh never refreshed anything.
  container.querySelector('#wl-refresh')?.addEventListener('click', () => {
    if(!current())return;
    mountHopebotRequests(container.querySelector('#wl-requests'), { mode: 'leads', excludeTeamTests: true });
    load(container);
  });
  container.querySelectorAll('#wl-filter .fchip').forEach(b => b.addEventListener('click', () => {
    if(!current())return;
    filter = b.dataset.f;
    paint(container);
  }));
  container.querySelector('#wl-search')?.addEventListener('input', (e) => {
    if(!current())return;
    searchQ = e.target.value.trim().toLowerCase();
    paint(container);
  });
  mountHopebotRequests(container.querySelector('#wl-requests'), { mode: 'leads', excludeTeamTests: true });
  await load(container);

  async function load(container) {
    if(!current())return;
    const generation=++loadGeneration;
    const body = container.querySelector('#wl-body');
    requestsKnown = false;
    try {
      // New signup history, not mutable staff contact/assignment timestamps.
      const { data, error } = await getSupabase().from('hopebot_leads')
        .select('*, is_team').order('created_at', { ascending: false }).order('id', { ascending: false }).limit(300);
      if(!current()||generation!==loadGeneration)return;
      if(error||!Array.isArray(data))throw new Error('unavailable');
      rows=newestLeads(data);
      // Only the calling roles read these; for anyone else this is simply empty.
      const { data: dg } = await getSupabase().from('hopebot_family_digest')
        .select('lead_id, counts, recent, summary, summary_at, report_reading').limit(1000);
      if(!current()||generation!==loadGeneration)return;
      digests = new Map((dg || []).map(d => [d.lead_id, d]));
      // sql/182 (cos rework of #31): a family with an open call request is not
      // "contacted" by a tap here; the call has to be logged on the request, or
      // the request stays Overdue and HopeBot never hears what happened. Row
      // security returns only the requests this person may act on.
      openReqs = new Map();
      // A deletion request is a person's other job (sql/173), never "a call".
      const { data: rq, error: requestError } = await getSupabase().from('hopebot_requests')
        .select('id, lead_id, team').neq('state', 'closed').neq('team', 'admin').order('due_at').limit(1000);
      if(!current()||generation!==loadGeneration)return;
      requestsKnown = !requestError;
      (rq || []).forEach((x) => openReqs.set(x.lead_id, [...(openReqs.get(x.lead_id) || []), x.id]));
      if (isManagerOrAdmin()) {
        try { const result=await loadRoster('cgmp');if(!current()||generation!==loadGeneration)return;roster=result; } catch { if(!current()||generation!==loadGeneration)return;roster=null; }
      }
    } catch (e) {
      if(!current()||generation!==loadGeneration)return;
      rows=[];digests.clear();openReqs.clear();
      if(body){body.innerHTML='<div class="empty"><h4>Could not load verified leads</h4><p>Refresh to confirm team classification before viewing family leads.</p><button type="button" class="btn btn-secondary" data-lead-retry>Retry</button></div>';body.querySelector('[data-lead-retry]').onclick=()=>load(container);}
      return;
    }
    if(current()&&generation===loadGeneration)paint(container);
  }

  function visible() {
    return rows
      .filter(r => filter === 'team' ? leadKind(r)==='team' : !['team','unavailable'].includes(leadKind(r)))
      .filter(r => filter === 'all' || filter === 'team' ? true : filter === 'contacted' ? r.contacted
        : filter === 'review' ? !r.patient_id : filter === 'nocaller' ? !r.patient_id && !r.assigned_to : !r.contacted)
      .filter(r => !searchQ || [r.name, r.phone, r.city, r.cancer_type, r.stage, r.notes, digests.get(r.id)?.summary]
        .filter(Boolean).join(' ').toLowerCase().includes(searchQ));
  }

  function paint(container) {
    const body = container.querySelector('#wl-body');
    if (!body||!current()) return;
    container.querySelectorAll('#wl-filter .fchip').forEach(b =>
      b.classList.toggle('on', b.dataset.f === filter));
    const list = visible();
    const fresh = rows.filter(r => !r.contacted && !['team','unavailable'].includes(leadKind(r))).length;
    const hiddenUnknown=rows.some(r=>leadKind(r)==='unavailable');
    container.querySelector('[data-lead-classification-warning]').hidden=!hiddenUnknown;
    if (!list.length) {
      body.innerHTML = `<div class="card" style="padding:28px;text-align:center;color:var(--ink-3)">
        ${filter === 'team' ? 'No verified team test leads in this view. Patient testing instructions are above.'
          : fresh ? 'Nothing under this filter.' : 'No WhatsApp leads yet. They appear here when someone writes to HopeBot.'}</div>`;
      return;
    }
    body.innerHTML = `
      <div class="due-meta wraps" style="margin-bottom:8px">${filter === 'team'
        ? `${list.length} team member${list.length === 1 ? '' : 's'} who wrote to HopeBot from their own number. Separate from family leads. Use the patient testing instructions above; linked actual families remain family records.`
        : `${fresh} new lead${fresh === 1 ? '' : 's'}`}</div>
      <div style="display:flex;flex-direction:column;gap:8px">
      ${list.map(r => `
        <div class="card" data-lead-row="${sanitize(r.id)}" style="padding:12px 14px;${r.contacted ? 'opacity:.65' : ''}">
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
            <span style="font-weight:700">${sanitize(r.name || 'Unknown')}</span>
            <a class="tnum" href="tel:${sanitize(String(r.phone).replace(/[^+\d]/g, ''))}">${sanitize(r.phone)}</a>
            ${r.is_team ? '<span class="badge badge-warn" title="Confirmed staff test number">Team test</span>'
              : r.contacted ? '<span class="badge badge-ok">Contacted</span>' : '<span class="badge badge-info">New</span>'}
            ${!r.is_team ? `<span class="badge badge-neutral">${sanitize(LEAD_LABELS[leadKind(r)])}</span>` : ''}
            <span style="flex:1"></span>
            ${r.patient_id ? `<a class="due-meta" href="#patients/${sanitize(r.patient_id)}">Already a PN family</a>` : ''}
            <span class="due-meta">Added ${sanitize(formatRelativeTime(r.created_at || r.first_seen_at))}</span>
            <span class="due-meta">${r.last_message_at ? 'wrote ' + formatRelativeTime(r.last_message_at) : formatRelativeTime(r.updated_at || r.created_at)}</span>
            ${r.is_team ? '' : openReqs.has(r.id)
              ? `<button class="btn btn-primary btn-sm" data-log-call="${sanitize(r.id)}" title="They asked HopeBot for a call: say what happened, and the request closes here and in HopeBot">Log the call</button>`
              : `<button class="btn ${r.contacted ? 'btn-secondary' : 'btn-primary'} btn-sm" data-lead="${r.id}" data-to="${r.contacted ? 0 : 1}">
              ${r.contacted ? 'Reopen' : 'Mark contacted'}
            </button>`}
          </div>
          ${!r.is_team && !r.patient_id && !openReqs.has(r.id) && (isManagerOrAdmin() || r.assigned_to === getCurrentProfile()?.id) ? `<div style="margin-top:8px"><button type="button" class="btn btn-secondary btn-sm" data-log-followup="${sanitize(r.id)}" ${requestsKnown ? '' : 'disabled'} title="${requestsKnown ? 'Record a follow-up already completed with this assigned lead' : 'Refresh to check existing callback requests first'}">Log follow-up</button></div>` : ''}
          ${r.is_team ? '' : callerLine(r)}
          ${r.is_team ? '<p class="due-meta wraps">Staff test number, excluded from family leads and clinical patient counts.</p>' : `<div class="due-meta" style="margin-top:4px">${[
            r.role === 'caregiver' ? 'Caregiver' : r.role === 'patient' ? 'Patient' : null,
            r.city && r.city !== 'other' ? sanitize(r.city) : 'City not pinned',
            r.cancer_type ? sanitize(cancerLabel(r.cancer_type)) : null,
            r.stage && r.stage !== 'unknown' ? sanitize(/^stage_|pata_nahi/.test(r.stage) ? stageLabel(r.stage) : 'Stage ' + r.stage) : null,
            LEAD_LANGS.get(r.lang) || 'English',
          ].filter(Boolean).join(' · ')}</div>`}
          ${!r.is_team && r.notes ? `<div class="due-meta" style="margin-top:6px;color:var(--ink-1);white-space:pre-wrap">${sanitize(r.notes)}</div>` : ''}
          ${r.is_team ? '' : digestHTML(digests.get(r.id))}
        </div>`).join('')}
      </div>`;
    body.querySelectorAll('[data-lead-assign]').forEach(sel => sel.addEventListener('change', async () => {
      if(!current())return;
      sel.disabled = true;
      try {
        const { error } = await getSupabase().rpc('hopebot_lead_assign', { p_lead: sel.dataset.leadAssign, p_to: sel.value || null });
        if(!current())return;
        if (error) throw error;
        forgetRoster();
        showToast(sel.value ? 'Assigned under WhatsApp leads. Their open call requests went with it.' : 'No caller now.', 'success', 2500);
      } catch {
        if(!current())return;
        showToast('Could not assign. Refresh and try again.', 'error');
      }
      await load(container);
      mountHopebotRequests(container.querySelector('#wl-requests'), { mode: 'leads', excludeTeamTests: true });
    }));
    body.querySelectorAll('[data-log-followup]').forEach(b => b.addEventListener('click', async () => {
      if(!current())return;
      const r = rows.find(x => x.id === b.dataset.logFollowup);
      const actor = getCurrentProfile()?.id, route = window.location.hash;
      const journalCurrent = () => container.isConnected && leadMounts.get(container)===token && getCurrentUser()?.id===actor && getCurrentProfile()?.id===actor && !isImpersonating() && window.location.hash===route;
      b.disabled = true;
      try {
        const journal = await import('../components/leadFollowup.js?v=assigned102');
        if (!journalCurrent()) return;
        if (typeof journal.openLeadFollowup !== 'function') throw new Error('Reload to get the follow-up form.');
        journal.openLeadFollowup(r, { isCurrent: journalCurrent, onSaved: async () => { if (journalCurrent()) { filter = 'all'; await load(container); } } });
      } catch (e) { if (journalCurrent()) showToast(e.message || 'Could not open follow-up. Reload and try again.', 'error'); }
      finally { if (b.isConnected && journalCurrent()) b.disabled = false; }
    }));
    body.querySelectorAll('[data-log-call]').forEach(b => b.addEventListener('click', () => {
      if(!current())return;
      const r = rows.find(x => x.id === b.dataset.logCall);
      openLogCall(container, r, openReqs.get(b.dataset.logCall) || []);
    }));
    body.querySelectorAll('[data-lead]').forEach(b => b.addEventListener('click', async () => {
      if(!current())return;
      b.disabled = true;
      try {
        const { error } = await getSupabase().from('hopebot_leads')
          .update({ contacted: b.dataset.to === '1', updated_at: new Date().toISOString() })
          .eq('id', b.dataset.lead);
        if(!current())return;
        if (error) throw error;
        rows = rows.map(r => r.id === b.dataset.lead ? { ...r, contacted: b.dataset.to === '1' } : r);
        showToast(b.dataset.to === '1' ? 'Marked contacted' : 'Reopened', 'success', 2000);
      } catch {
        if(!current())return;
        showToast('Could not update. Refresh and try again.', 'error');
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
    if (!current() || !r || !reqIds.length) return;
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
      if(!current())return;
      const out = btn.dataset.lc;
      const note = el.querySelector('#lc-note').value || null;
      let back = null;
      if (out === 'call_back') {
        closeModal();
        const { pickCallbackTime } = await import('../components/callbackPicker.js');
        back = await pickCallbackTime(r.name || 'they');
        if (!back||!current()) return;
      }
      el.querySelectorAll('[data-lc]').forEach((x) => { x.disabled = true; });
      // Each request on its own: one refused (someone else on the call, already
      // closed) never stops or repeats the others. The page reloads either way.
      const failed = [];
      let logged = 0;
      for (const id of reqIds) {
        if(!current())return;
        const { error } = await getSupabase().rpc('hopebot_request_log',
          back ? { p_id: id, p_outcome: out, p_note: note, p_callback_at: back } : { p_id: id, p_outcome: out, p_note: note });
        if (error) failed.push(error.message); else logged++;
      }
      if(!current())return;
      if (out === 'reached' && logged) {
        const { error } = await getSupabase().from('hopebot_leads')
          .update({ contacted: true, updated_at: new Date().toISOString() }).eq('id', r.id);
        if (error) failed.push('Logged, but the family could not be marked contacted: ' + error.message);
      }
      if(!current())return;
      if (failed.length) showToast(failed[0], 'error', 6000);
      else showToast(out === 'reached' ? 'Logged. HopeBot will close their request.'
        : out === 'no_answer' ? 'Logged. Try again in about 2 working hours; it is not overdue until then.'
          : out === 'call_back' ? 'Logged. It comes due again at the time they asked for.' : 'Logged.', 'success', 3500);
      closeModal();
      await load(container);
      mountHopebotRequests(container.querySelector('#wl-requests'), { mode: 'leads', excludeTeamTests: true });
    }));
  }

}
