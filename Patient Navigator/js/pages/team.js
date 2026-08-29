// ============================================================
// Patient Navigator: Team & Queue Management v3
// Team tree · daily availability roster · build assignments ·
// bulk lead intake · live worklist. (profiles-based)
// ============================================================

import { getSupabase } from '../supabase.js';
import { isAdmin, isManagerOrAdmin, getCurrentProfile, startImpersonation } from '../auth.js';
import { showToast } from '../components/toast.js';
import { showModal, closeModal, confirmModal } from '../components/modal.js';
import { openSessionForm, suggestNextSession } from '../components/sessionForm.js';
import { formatDate, formatDateTime, formatRelativeTime, capitalize, getRoleBadge } from '../utils/formatters.js';
import { sanitize, validateEmail } from '../utils/validators.js';
import { icon } from '../components/icons.js';
import { navigate } from '../router.js';
import { DIAL_STATUSES, CONDITIONS } from '../utils/catalog.js';
import { withMvp, mvpBand, median } from '../utils/performance.js';

const AV_COLORS = ['#006469', '#7A4C00', '#5B4892', '#295B86', '#106841', '#953028'];
function avColor(n) { let h = 0; for (let i = 0; i < (n || '').length; i++) h = n.charCodeAt(i) + ((h << 5) - h); return AV_COLORS[Math.abs(h) % AV_COLORS.length]; }
function inits(n) { return n ? n.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2) : '?'; }

export async function renderTeam(container) {
  if (!isManagerOrAdmin()) { container.innerHTML = '<div class="empty"><h4>Access denied</h4><p>Only admins and managers can manage the team.</p></div>'; return; }
  const canCreateUsers = isManagerOrAdmin();

  container.innerHTML = `
    <div class="page-header">
      <h1>Team &amp; Queue</h1>
      <div class="flex gap-2">
        <button class="btn btn-secondary" id="add-leads-btn">${icon('userPlus')}Add new leads</button>
        <button class="btn btn-primary" id="assign-patients-btn">${icon('userPlus')}Assign patients</button>
        <button class="btn btn-primary" id="build-btn">${icon('refresh')}Build today's assignments</button>
        ${canCreateUsers ? `<button class="btn btn-secondary" id="invite-team-btn">${icon('users')}Invite member</button>` : ''}
      </div>
    </div>
    <div class="tabs" id="team-tabs">
      <button class="tab active" data-tab="availability">Availability today</button>
      <button class="tab" data-tab="queue">Today's queue</button>
      <button class="tab" data-tab="nutrition">Nutrition team</button>
      <button class="tab" data-tab="sessions">Saturday circles</button>
    </div>
    <div id="team-content">${Array(5).fill('<div class="sk skeleton-row"></div>').join('')}</div>`;

  document.getElementById('invite-team-btn')?.addEventListener('click', showInviteTeamMemberModal);
  document.getElementById('add-leads-btn')?.addEventListener('click', showBulkLeadModal);
  document.getElementById('assign-patients-btn')?.addEventListener('click', () => showAssignPatientsModal());
  document.getElementById('build-btn')?.addEventListener('click', buildAssignments);
  document.querySelectorAll('#team-tabs .tab').forEach(tab => tab.addEventListener('click', () => {
    document.querySelectorAll('#team-tabs .tab').forEach(t => t.classList.remove('active')); tab.classList.add('active');
    if (tab.dataset.tab === 'queue') loadQueue();
    else if (tab.dataset.tab === 'sessions') loadSessions();
    else if (tab.dataset.tab === 'nutrition') loadNutritionRoster();
    else loadAvailability();
  }));

  await loadAvailability();
}

// ---- Nutrition team: who holds whom, and the one button that changes it ----
// Deliberately a different roster from Availability: nutrition has no daily
// call target and no off-today rota, so borrowing get_team_caseload would
// have shown three columns of zeroes and one real number.
async function loadNutritionRoster() {
  const sb = getSupabase(); const content = document.getElementById('team-content');
  content.innerHTML = Array(4).fill('<div class="sk skeleton-row"></div>').join('');
  try {
    const { data, error } = await sb.rpc('get_nutrition_caseload');
    if (error) throw error;
    const rows = data || [];
    if (!rows.length) {
      content.innerHTML = `<div class="empty"><div class="ico-wrap">${icon('leaf')}</div><h4>No active nutritionists</h4><p>Invite one from the Admin page and they will show up here.</p></div>`;
      return;
    }
    const total = rows.reduce((a, r) => a + (r.in_care || 0), 0);
    const avg = total / rows.length;
    const held = rows.filter(r => r.in_care > 0).length;
    // Bottom third by caseload gets the same gentle nudge the mentor roster uses.
    const byLoad = rows.slice().sort((a, b) => (a.in_care || 0) - (b.in_care || 0));
    const needy = new Set(byLoad.slice(0, Math.max(1, Math.floor(rows.length / 3))).map(r => r.nutritionist_id));

    content.innerHTML = `
      <div class="card" style="display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;margin-bottom:var(--s4)">
        <div style="display:flex;align-items:center;gap:12px">
          <span class="stat-ico ok">${icon('handHeart')}</span>
          <div><div class="info-value"><strong>${total}</strong> patients held across <strong>${held}</strong> of ${rows.length} nutritionists</div>
          <div class="due-meta">Whoever holds a patient is the one who calls them. Average caseload ${avg.toFixed(1)}. Least-loaded first.</div></div>
        </div>
        <button class="btn btn-primary btn-sm" id="nut-assign-btn">${icon('userPlus')}Assign nutrition patients</button>
      </div>
      <div class="team-grid">${rows.map(r => {
        const stale = r.unworked_60d || 0;
        return `
        <div class="card team-card">
          <div style="display:flex;align-items:center;gap:11px;margin-bottom:10px">
            <span class="avatar" style="background:${avColor(r.full_name)}">${inits(r.full_name)}</span>
            <div style="flex:1;min-width:0">
              <div class="info-value">${sanitize(r.full_name)}</div>
              <div class="due-meta">${r.last_nutrition_touch ? 'last worked ' + formatRelativeTime(r.last_nutrition_touch) : 'no nutrition work logged yet'}</div>
            </div>
            ${needy.has(r.nutritionist_id) ? '<span class="badge badge-gold">Needs patients</span>' : ''}
          </div>
          <div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:10px">
            <div><div class="stat-num tnum">${r.in_care}</div><div class="stat-lbl">Held</div></div>
            <div><div class="stat-num tnum">${r.outreach_pending}</div><div class="stat-lbl">To offer today</div></div>
            <div><div class="stat-num tnum">${r.checkins_30d}</div><div class="stat-lbl">Check-ins 30d</div></div>
            <div><div class="stat-num tnum">${r.sessions_30d}</div><div class="stat-lbl">1:1s 30d</div></div>
          </div>
          ${stale ? `<div class="due-meta" style="color:var(--warn);margin-bottom:8px">${stale} held with no nutrition work in 60 days</div>` : ''}
          <button class="btn btn-secondary btn-sm give-nut" data-id="${r.nutritionist_id}">${icon('userPlus')}Give patients</button>
        </div>`;
      }).join('')}</div>`;

    document.getElementById('nut-assign-btn')?.addEventListener('click', () => showAssignPatientsModal(null, { team: 'nutrition' }));
    content.querySelectorAll('.give-nut').forEach(b =>
      b.addEventListener('click', () => showAssignPatientsModal(b.dataset.id, { team: 'nutrition' })));
  } catch (err) {
    content.innerHTML = `<div class="empty"><div class="ico-wrap">${icon('alertCircle')}</div><h4>Couldn't load the nutrition team</h4><p>${sanitize(err.message)}</p></div>`;
  }
}

// ---- Saturday circles (alternating nutrition / well-being) ----
async function loadSessions() {
  const sb = getSupabase(); const content = document.getElementById('team-content');
  try {
    const [{ data: sessions }, next] = await Promise.all([
      sb.from('group_sessions').select('*, profiles:facilitator_id(full_name)').order('session_date', { ascending: false }).limit(40),
      suggestNextSession(),
    ]);
    const nice = next.date.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' });
    const typeBadge = (t) => t === 'nutrition'
      ? '<span class="badge badge-ok badge-dot">Nutrition</span>'
      : t === 'wellbeing' ? '<span class="badge badge-violet badge-dot">Well-being</span>' : '<span class="badge badge-neutral">Other</span>';
    content.innerHTML = `
      <div class="card" style="display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;margin-bottom:var(--s4)">
        <div style="display:flex;align-items:center;gap:12px">
          <span class="stat-ico ${next.type === 'nutrition' ? 'ok' : 'violet'}">${icon(next.type === 'nutrition' ? 'leaf' : 'heart')}</span>
          <div><div class="info-value">Next circle: <strong>${next.type === 'nutrition' ? 'Nutrition' : 'Well-being'}</strong> · ${nice}</div>
          <div class="due-meta">They alternate each Saturday in the patient WhatsApp groups. Invite people on your calls this week.</div></div>
        </div>
        <button class="btn btn-primary btn-sm" id="log-session-btn">${icon('plus')}Log a session</button>
      </div>
      ${!sessions || sessions.length === 0
        ? `<div class="empty"><div class="ico-wrap">${icon('users')}</div><h4>No circles logged yet</h4><p>After Saturday's WhatsApp session, log the topic and turnout here. It feeds the impact analytics.</p></div>`
        : `<div class="table-container"><table class="data"><thead><tr><th>Date</th><th>Type</th><th>Topic</th><th>Reached</th><th>Led by</th><th>Notes</th></tr></thead><tbody>
            ${sessions.map(s => `<tr>
              <td>${formatDate(s.session_date)}</td>
              <td>${typeBadge(s.session_type)}</td>
              <td style="max-width:260px">${sanitize(s.topic || 'N/A')}</td>
              <td class="cell-mono">${s.attendees_count ?? 'N/A'}</td>
              <td>${sanitize(s.profiles?.full_name || 'N/A')}</td>
              <td style="max-width:280px;white-space:normal;color:var(--ink-2);font-size:13px">${sanitize((s.notes || '').slice(0, 120))}${(s.notes || '').length > 120 ? '…' : ''}</td>
            </tr>`).join('')}
          </tbody></table></div>`}`;
    document.getElementById('log-session-btn')?.addEventListener('click', () =>
      openSessionForm({ defaults: { type: next.type, date: next.last ? undefined : next.date }, onSaved: loadSessions }));
  } catch (err) { showToast('Failed to load sessions: ' + err.message, 'error'); }
}

async function buildAssignments() {
  const sb = getSupabase(); const btn = document.getElementById('build-btn');
  btn.disabled = true; const html = btn.innerHTML; btn.innerHTML = '<span class="spinner" style="width:16px;height:16px;border-width:2px"></span>Building…';
  try {
    await sb.rpc('distribute_new_patients'); // give every unowned, callable lead an owner first
    const { data, error } = await sb.rpc('build_daily_assignments');
    if (error) throw error;
    if (data?.error) showToast('Could not build: ' + data.error, 'warning');
    else showToast(`Done: ${data.follow_ups} follow-ups + ${data.new_leads} new across ${data.available_callers} caregiver mentors${data.covered ? ` (${data.covered} covered)` : ''}`, 'success');
    if (document.querySelector('#team-tabs .tab.active')?.dataset.tab === 'queue') loadQueue();
  } catch (err) { showToast('Build failed: ' + err.message, 'error'); }
  finally { btn.disabled = false; btn.innerHTML = html; }
}

// ---- Availability roster ----
async function loadAvailability() {
  const sb = getSupabase(); const content = document.getElementById('team-content');
  try {
    const [{ data, error }, restoresR, caseloadR, perfR] = await Promise.all([
      sb.rpc('get_team_availability'),
      sb.rpc('get_pending_restores'),
      sb.rpc('get_team_caseload'),
      // Same RPC the Leaderboard reads, scored with the same shared blend,
      // so the roster order and the scoreboard can never disagree.
      sb.rpc('get_leaderboard', { p_days: 30 }),
    ]);
    if (error) throw error;
    if (!data || data.length === 0) { content.innerHTML = '<div class="empty"><h4>No team members</h4></div>'; return; }
    const restores = restoresR.data || [];
    const caseload = caseloadR.data || [];
    const clById = {}; caseload.forEach(c => clById[c.caller_id] = c);
    // Performance, keyed by mentor. A missing row is a real answer (nothing
    // logged in 30 days), so it scores 0 rather than being hidden.
    const perf = withMvp(perfR.data || []);
    const perfById = {}; perf.forEach(p => perfById[p.caller_id] = p);
    const medianMvp = median(perf.map(p => p.mvp));
    // Bottom third of the team by callable caseload → gentle "needs patients" nudge.
    const byOwned = caseload.slice().sort((a, b) => (a.owned_callable || 0) - (b.owned_callable || 0));
    const needy = new Set(byOwned.slice(0, Math.floor(byOwned.length / 3)).map(c => c.caller_id));
    const onCount = data.filter(d => d.available).length;

    // The roster used to render in whatever order the RPC returned, which made
    // "how is the team doing" a question you had to answer by reading 21 cards.
    // Default is performance, worst-first is one click away because that is the
    // list a manager actually acts on.
    const mvpOf = (m) => perfById[m.caller_id]?.mvp ?? 0;
    // Managers and admins do not make calls, so they score 0 and would otherwise
    // sit at the top of "needs help first", which is the opposite of useful. Sink
    // every non-calling role to the end of BOTH performance sorts.
    const callsFirst = (a, b) => (CALLING_ROLES.has(b.role) ? 1 : 0) - (CALLING_ROLES.has(a.role) ? 1 : 0);
    const SORTS = {
      performance: { label: 'Performance: best first', cmp: (a, b) => callsFirst(a, b) || mvpOf(b) - mvpOf(a) },
      weakest:     { label: 'Performance: needs help first', cmp: (a, b) => callsFirst(a, b) || mvpOf(a) - mvpOf(b) },
      calls:       { label: 'Calls in 30 days', cmp: (a, b) => (perfById[b.caller_id]?.calls || 0) - (perfById[a.caller_id]?.calls || 0) },
      caseload:    { label: 'Caseload: heaviest first', cmp: (a, b) => (clById[b.caller_id]?.owned_callable || 0) - (clById[a.caller_id]?.owned_callable || 0) },
      name:        { label: 'Name A-Z', cmp: (a, b) => String(a.full_name || '').localeCompare(String(b.full_name || '')) },
    };
    const chosen = SORTS[teamSort] ? teamSort : 'performance';
    // Stable tiebreak on name, so equal scores do not shuffle between loads.
    const sorted = data.slice().sort((a, b) =>
      SORTS[chosen].cmp(a, b) || String(a.full_name || '').localeCompare(String(b.full_name || '')));
    const restoreBanner = restores.length ? `
      <div class="card" style="border-color:var(--gold-bright);background:var(--gold-soft);margin-bottom:var(--s4);padding:14px 18px">
        <div style="font:var(--t-body-strong);display:flex;align-items:center;gap:8px;margin-bottom:10px">${icon('handHeart')}Back from leave: restore their patients?</div>
        <div style="display:flex;flex-direction:column;gap:8px">
        ${restores.map(r => `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
          <span>${sanitize(r.full_name)} · <strong>${r.n}</strong> patient${r.n === 1 ? '' : 's'} currently covered by others</span>
          <button class="btn btn-primary btn-sm restore-btn" data-id="${r.user_id}" data-name="${sanitize(r.full_name)}">Restore ${r.n}</button>
        </div>`).join('')}
        </div>
      </div>` : '';
    content.innerHTML = `
      ${restoreBanner}
      <p class="muted" style="margin-bottom:var(--s4);color:var(--ink-2)"><strong>${onCount}</strong> of ${data.length} available today. This is <strong>today-only</strong>: toggling someone Off just skips them in today's build (their due calls get covered); use <strong>Cover</strong> to hand their whole caseload to present callers (ownership kept for restore). To remove someone permanently (left the team) deactivate their <em>account</em> in User Management. Only active accounts appear here.</p>
      <div class="table-toolbar" style="padding:0 0 var(--s4);border:none;background:none">
        <select class="form-select" id="team-sort" style="width:auto;min-width:210px"
                title="Performance blends reach, connect rate, probing depth and delivered support over the last 30 days. It is the same score the Leaderboard shows.">
          ${Object.entries(SORTS).map(([k, s]) =>
            `<option value="${k}"${k === chosen ? ' selected' : ''}>${s.label}</option>`).join('')}
        </select>
      </div>
      <div class="team-grid">
        ${sorted.map(m => {
          const c = clById[m.caller_id];
          const pf = perfById[m.caller_id];
          const band = mvpBand(pf?.mvp ?? 0, medianMvp);
          // The performance band belongs to people who make calls. Keying it off
          // ROLE rather than off "has a caseload row" matters in both directions:
          // a manager or admin never gets scored, so their card is not littered
          // with a meaningless "Nothing logged", and a mentor who has been given
          // no patients yet still gets badged, which is exactly the case a
          // manager needs to see.
          const flags = [
            CALLING_ROLES.has(m.role)
              ? `<span class="badge badge-${band.tone}" title="Performance ${pf?.mvp ?? 0} of 100 over the last 30 days. Team median ${medianMvp}. Blends reach, connect rate, probing depth and delivered support: the same score the Leaderboard shows.">${band.label} · ${pf?.mvp ?? 0}</span>`
              : '',
            c && needy.has(m.caller_id) ? '<span class="badge badge-warn" title="Bottom third of the team by callable caseload: consider giving them patients">Needs patients</span>' : '',
            c && (c.calls_7d || 0) === 0 ? '<span class="badge badge-danger" title="Zero calls logged in the last 7 days">No calls this week</span>' : '',
          ].filter(Boolean).join('');
          const stats = c ? `
            <div class="tc-stats">
              <div class="tc-stat" title="Callable patients this person owns"><div class="tc-num">${c.owned_callable ?? 0}</div><div class="tc-lbl">owns (callable)</div></div>
              <div class="tc-stat" title="Owned patients nobody has ever dialled"><div class="tc-num ${(c.never_called ?? 0) > 0 ? 'accent' : 'muted'}">${c.never_called ?? 0}</div><div class="tc-lbl">never called</div></div>
              <div class="tc-stat" title="Still to serve on today's list: target ~22/day"><div class="tc-num ${(c.servable_today ?? 0) > 22 ? 'over' : 'accent'}">${c.servable_today ?? 0}</div><div class="tc-lbl">on today's list</div></div>
            </div>
            <div class="tc-stats" style="border-top:none;padding-top:0">
              <div class="tc-stat" title="Calls completed today"><div class="tc-num">${c.done_today ?? 0}</div><div class="tc-lbl">done today</div></div>
              <div class="tc-stat" title="Calls logged in the last 7 days"><div class="tc-num ${(c.calls_7d ?? 0) === 0 ? 'over' : ''}">${c.calls_7d ?? 0}</div><div class="tc-lbl">calls / 7d</div></div>
              <div class="tc-stat" title="${c.last_call_at ? formatDateTime(c.last_call_at) : 'They have never logged a call'}"><div class="tc-num muted" style="font-size:15px;line-height:30px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${c.last_call_at ? formatRelativeTime(c.last_call_at) : 'Never'}</div><div class="tc-lbl">last call</div></div>
            </div>` : `
            <div class="tc-stats">
              <div class="tc-stat" title="Total patients this person owns"><div class="tc-num">${m.owned ?? 0}</div><div class="tc-lbl">patients</div></div>
              <div class="tc-stat" title="Due today. Missed calls pile on here; target ~22/day"><div class="tc-num ${(m.today ?? 0) > 22 ? 'over' : 'accent'}">${m.today ?? 0}</div><div class="tc-lbl">today</div></div>
              <div class="tc-stat" title="Scheduled for later days (spread ~22/day)"><div class="tc-num muted">${m.ahead ?? 0}</div><div class="tc-lbl">ahead</div></div>
            </div>`;
          return `
          <div class="card team-card">
            <div class="tc-head">
              <span class="avatar avatar-lg" style="background:${avColor(m.full_name)}">${inits(m.full_name)}</span>
              <div class="tc-id">
                <div class="tc-name">${sanitize(m.full_name)}</div>
                <div class="tc-role">${capitalize(m.role)}</div>
              </div>
              <div class="tc-actions">
                ${!m.available ? `<button class="btn btn-ghost btn-sm cover-btn" data-id="${m.caller_id}" data-name="${sanitize(m.full_name)}">Cover</button>` : ''}
                <button class="btn ${m.available ? 'btn-secondary' : 'btn-primary'} btn-sm av-toggle" data-id="${m.caller_id}" data-name="${sanitize(m.full_name)}" data-on="${m.available}">${m.available ? 'On' : 'Off'}</button>
              </div>
            </div>
            ${stats}
            ${c || flags ? `<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
              ${flags}
              ${c ? `<button class="btn btn-ghost btn-sm give-btn" data-id="${m.caller_id}" style="margin-left:auto" title="Open the assign tool with ${sanitize(m.full_name)} pre-selected">${icon('userPlus')}Give patients</button>` : ''}
            </div>` : ''}
          </div>`;
        }).join('')}
      </div>`;
    content.querySelectorAll('.av-toggle').forEach(btn => btn.addEventListener('click', async () => {
      const on = btn.dataset.on === 'true';
      // sb.rpc() resolves with { error } instead of throwing, so the old
      // try/catch never fired: a refused toggle just silently repainted the
      // old state. That is why managers reported the button doing nothing.
      btn.disabled = true;
      const { error } = await sb.rpc('mark_availability_for', { p_caller_id: btn.dataset.id, p_available: !on });
      btn.disabled = false;
      if (error) { showToast(error.message, 'error'); return; }
      showToast(`${btn.dataset.name || 'They'} marked ${on ? 'off' : 'on'} for today`, 'success');
      loadAvailability();
    }));
    content.querySelector('#team-sort')?.addEventListener('change', (e) => {
      teamSort = e.target.value;
      loadAvailability();
    });
    content.querySelectorAll('.give-btn').forEach(btn => btn.addEventListener('click', () => showAssignPatientsModal(btn.dataset.id)));
    content.querySelectorAll('.restore-btn').forEach(btn => btn.addEventListener('click', async () => {
      try { const { data: n, error: e } = await sb.rpc('restore_owned_patients', { p_user_id: btn.dataset.id });
        if (e) throw e; showToast(`Restored ${n || 0} patients to ${btn.dataset.name}`, 'success'); loadAvailability();
      } catch (e) { showToast(e.message, 'error'); }
    }));
    content.querySelectorAll('.cover-btn').forEach(btn => btn.addEventListener('click', () => {
      confirmModal(`Hand <strong>${btn.dataset.name}</strong>'s caseload to present caregiver mentors? Their original ownership is preserved, so you can restore it when they're back.`,
        async () => { try { const { data: n, error: e } = await sb.rpc('reassign_for_absence', { p_user_id: btn.dataset.id });
          if (e) throw e; showToast(`Covered ${n || 0} patients`, 'success'); loadAvailability();
        } catch (e) { showToast(e.message, 'error'); } },
        { title: 'Cover caseload', confirmLabel: 'Reassign', danger: false });
    }));
  } catch (err) { showToast('Failed to load availability: ' + err.message, 'error'); }
}

// ---- Team members ----
async function loadTeamMembers() {
  const sb = getSupabase(); const content = document.getElementById('team-content');
  try {
    const { data, error } = await sb.rpc('get_team_tree');
    if (error) throw error;
    if (!data || data.length === 0) {
      content.innerHTML = `<div class="empty"><h4>No team members</h4><p>${isAdmin() ? 'Invite your first team member.' : 'Only admins can add new users manually as of now.'}</p></div>`;
      return;
    }
    const byId = {}; data.forEach(p => byId[p.id] = p);
    const reports = {}; data.forEach(p => { if (p.manager_id && byId[p.manager_id]) reports[p.manager_id] = (reports[p.manager_id] || 0) + 1; });
    content.innerHTML = `<div class="team-grid">${data.map(p => {
      const mgr = p.manager_id && byId[p.manager_id] ? byId[p.manager_id].full_name : null;
      return `<div class="card team-card">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">
          <div style="display:flex;gap:11px;align-items:center;min-width:0"><span class="avatar" style="background:${avColor(p.full_name)}">${inits(p.full_name)}</span>
            <div style="min-width:0"><div class="info-value">${sanitize(p.full_name)}</div><div style="margin-top:3px">${getRoleBadge(p.role)}</div></div></div>
          <span class="badge ${p.is_active ? 'badge-ok' : 'badge-danger'}"><span class="dot"></span>${p.is_active ? 'Active' : 'Inactive'}</span>
        </div>
        <div class="team-stats">
          ${mgr ? `<div><div class="due-meta">Reports to</div><div class="info-value" style="font-size:13px">${sanitize(mgr)}</div></div>` : ''}
          ${reports[p.id] ? `<div><div class="due-meta">Team size</div><div class="info-value" style="font-size:13px">${reports[p.id]}</div></div>` : ''}
          <div><div class="due-meta">Joined</div><div class="info-value" style="font-size:13px">${formatDateTime(p.created_at)}</div></div>
        </div></div>`; }).join('')}</div>`;
  } catch (err) { showToast('Failed to load team: ' + err.message, 'error'); }
}

// ============================================================
// Today's queue: enriched, filterable, sortable board.
// Tags are honest: "New lead" = nobody has reached them yet;
// "Nth follow-up" = N real conversations on record (connected /
// voicemail / callback), not raw dial attempts. Uploaded = when
// intake added the lead (patients.created_at), never the assign date.
// ============================================================
let queueRows = [];
// How the availability roster is ordered. Module scope so it survives the
// re-render that every toggle triggers; a manager who sorted by "needs help
// first" should not be thrown back to the top of the list by marking someone off.
let teamSort = 'performance';

// Roles that actually make calls, so are the ones a performance score means
// anything for. A manager's card should not carry "Nothing logged".
const CALLING_ROLES = new Set(['caregiver_mentor', 'caller', 'nutritionist', 'therapist']);

const queueState = { search: '', type: 'all', status: 'all', caller: 'all', sort: 'smart', team: 'caregiver' };
const isNutritionRow = (r) => String(r.source || '').startsWith('nutrition');
const QSTATUS_TONE = { pending: 'warn', in_progress: 'info', callback: 'primary', completed: 'ok', skipped: 'danger', scheduled: 'neutral' };

function ordinal(n) { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
function followupTag(conv) {
  return conv <= 0
    ? { cls: 'gold', label: 'New lead', rank: 0 }
    : { cls: 'primary', label: ordinal(conv) + ' follow-up', rank: conv };
}
function loc(r) { return [r.city, r.state].filter(Boolean).join(', ') || 'N/A'; }

async function loadQueue() {
  const sb = getSupabase(); const content = document.getElementById('team-content');
  content.innerHTML = `<div class="card" style="padding:var(--s5)">${Array(5).fill('<div class="sk skeleton-row"></div>').join('')}</div>`;
  try {
    const { data, error } = await sb.rpc('get_queue_board');
    if (error) throw error;
    queueRows = data || [];
    renderQueueShell();
    applyAndRenderQueue();
  } catch (err) { showToast('Failed to load queue: ' + err.message, 'error'); }
}

function renderQueueShell() {
  const content = document.getElementById('team-content');
  if (!queueRows.length) {
    content.innerHTML = `<div class="empty"><div class="ico-wrap">${icon('inbox')}</div><h4>No one is queued yet</h4><p>Press <strong>Build today's assignments</strong> to generate the worklist, or <strong>Add new leads</strong> to bring people in.</p></div>`;
    return;
  }
  // The headline numbers describe the team you are looking at, not the union
  // of two teams' work. A manager reading "166 in the queue" and then finding
  // 30 mentor calls is the same class of bug as the counters that disagreed.
  const teamRows = queueState.team === 'all' ? queueRows
    : queueRows.filter(r => (queueState.team === 'nutrition') === isNutritionRow(r));
  const total = teamRows.length;
  const newCount = teamRows.filter(r => (r.conversations || 0) === 0).length;
  const followCount = total - newCount;
  const open = teamRows.filter(r => ['pending', 'in_progress', 'callback'].includes(r.status)).length;
  const nutTotal = queueRows.filter(isNutritionRow).length;
  const callers = [...new Set(teamRows.map(r => r.assigned_name).filter(Boolean))].sort();

  content.innerHTML = `
    <div class="queue-stats">
      <div class="qstat"><div class="qstat-num">${total}</div><div class="qstat-lbl">In the queue</div></div>
      <div class="qstat"><div class="qstat-num">${open}</div><div class="qstat-lbl">Still to reach</div></div>
      <div class="qstat"><div class="qstat-num">${newCount}</div><div class="qstat-lbl">New leads</div></div>
      <div class="qstat"><div class="qstat-num">${followCount}</div><div class="qstat-lbl">Follow-ups</div></div>
    </div>
    <div class="table-container">
      <div class="table-toolbar">
        <div class="table-search">
          ${icon('search')}
          <input class="form-input" id="q-search" placeholder="Search name, code or place…" value="${sanitize(queueState.search)}" />
        </div>
        <div class="table-filters">
          <select class="form-select" id="q-team" title="Which team's calls">
            <option value="caregiver">Caregiver calls</option>
            <option value="nutrition">Nutrition outreach${nutTotal ? ` · ${nutTotal}` : ''}</option>
            <option value="all">Both teams</option>
          </select>
          <select class="form-select" id="q-type" title="Lead type">
            <option value="all">All types</option>
            <option value="new">New leads</option>
            <option value="followup">Follow-ups</option>
          </select>
          <select class="form-select" id="q-status" title="Status">
            <option value="all">Any status</option>
            <option value="pending">Pending</option>
            <option value="in_progress">In progress</option>
            <option value="callback">Callback</option>
            <option value="completed">Completed</option>
            <option value="skipped">Skipped</option>
          </select>
          <select class="form-select" id="q-caller" title="Assigned caregiver mentor">
            <option value="all">Everyone</option>
            ${callers.map(c => `<option value="${sanitize(c)}">${sanitize(c)}</option>`).join('')}
          </select>
          <select class="form-select" id="q-sort" title="Sort by">
            <option value="smart">Smart order</option>
            <option value="uploaded_old">Oldest uploaded</option>
            <option value="uploaded_new">Newest uploaded</option>
            <option value="followups_most">Most follow-ups</option>
            <option value="lastcall_stale">Longest since a call</option>
            <option value="lastcall_recent">Most recently called</option>
            <option value="name_az">Name A-Z</option>
            <option value="caller_az">Assignee A-Z</option>
          </select>
        </div>
      </div>
      <div id="queue-board"></div>
      <div class="queue-foot" id="queue-foot"></div>
    </div>`;

  const sync = () => {
    queueState.search = document.getElementById('q-search').value.trim();
    queueState.team = document.getElementById('q-team').value;
    queueState.type = document.getElementById('q-type').value;
    queueState.status = document.getElementById('q-status').value;
    queueState.caller = document.getElementById('q-caller').value;
    queueState.sort = document.getElementById('q-sort').value;
    applyAndRenderQueue();
  };
  ['team', 'type', 'status', 'caller', 'sort'].forEach(k => { const sel = document.getElementById('q-' + k); if (sel) sel.value = queueState[k]; });
  let t; document.getElementById('q-search').addEventListener('input', () => { clearTimeout(t); t = setTimeout(sync, 220); });
  ['q-type', 'q-status', 'q-caller', 'q-sort'].forEach(id => document.getElementById(id).addEventListener('change', sync));
  // Switching team changes the headline numbers and the "assigned to" list, so
  // it rebuilds the shell rather than just refiltering the rows underneath it.
  document.getElementById('q-team').addEventListener('change', (e) => {
    queueState.team = e.target.value;
    queueState.caller = 'all';
    renderQueueShell();
    applyAndRenderQueue();
  });
}

function filterQueue() {
  const s = queueState.search.toLowerCase();
  return queueRows.filter(r => {
    if (queueState.team !== 'all' && (queueState.team === 'nutrition') !== isNutritionRow(r)) return false;
    if (queueState.type === 'new' && (r.conversations || 0) !== 0) return false;
    if (queueState.type === 'followup' && (r.conversations || 0) === 0) return false;
    if (queueState.status !== 'all' && r.status !== queueState.status) return false;
    if (queueState.caller !== 'all' && r.assigned_name !== queueState.caller) return false;
    if (s) {
      const hay = `${r.full_name || ''} ${r.patient_code || ''} ${r.city || ''} ${r.state || ''}`.toLowerCase();
      if (!hay.includes(s)) return false;
    }
    return true;
  });
}

function sortQueue(rows) {
  const t = (v) => v ? new Date(v).getTime() : null;
  const byName = (a, b) => (a.full_name || '').localeCompare(b.full_name || '');
  const cmps = {
    uploaded_old: (a, b) => (t(a.uploaded_at) || 0) - (t(b.uploaded_at) || 0),
    uploaded_new: (a, b) => (t(b.uploaded_at) || 0) - (t(a.uploaded_at) || 0),
    followups_most: (a, b) => (b.conversations || 0) - (a.conversations || 0) || (t(a.uploaded_at) || 0) - (t(b.uploaded_at) || 0),
    lastcall_recent: (a, b) => (t(b.last_call_at) || 0) - (t(a.last_call_at) || 0),
    lastcall_stale: (a, b) => (t(a.last_call_at) || Infinity) - (t(b.last_call_at) || Infinity),
    name_az: byName,
    caller_az: (a, b) => (a.assigned_name || '~').localeCompare(b.assigned_name || '~') || byName(a, b),
    // Smart: live work first → in-progress, then due follow-ups by most
    // progressed, then oldest-waiting new leads. Keeps the room moving.
    smart: (a, b) => {
      const openRank = (r) => r.status === 'in_progress' ? 0 : ['pending', 'callback'].includes(r.status) ? 1 : 2;
      if (openRank(a) !== openRank(b)) return openRank(a) - openRank(b);
      const srcA = a.conversations > 0 ? 0 : 1, srcB = b.conversations > 0 ? 0 : 1;
      if (srcA !== srcB) return srcA - srcB;
      if (srcA === 0) return (b.conversations || 0) - (a.conversations || 0);
      return (t(a.uploaded_at) || 0) - (t(b.uploaded_at) || 0);
    },
  };
  return rows.slice().sort(cmps[queueState.sort] || cmps.smart);
}

// How many days past its scheduled day an open row has been waiting: the
// "how far behind are we" signal. 0 for done rows or same-day work.
function overdueDays(r) {
  if (!['pending', 'in_progress', 'callback'].includes(r.status) || !r.generated_for) return 0;
  const t = new Date(); t.setHours(0, 0, 0, 0);
  const g = new Date(r.generated_for); g.setHours(0, 0, 0, 0);
  return Math.max(0, Math.round((t - g) / 86400000));
}
function waitBadge(r) {
  const d = overdueDays(r);
  if (!d) return '';
  return `<span class="badge badge-${d >= 7 ? 'danger' : 'warn'}" title="Rolled over ${d} day(s), not yet reached">${d}d overdue</span>`;
}

function applyAndRenderQueue() {
  const board = document.getElementById('queue-board'); if (!board) return;
  const canMove = isManagerOrAdmin();
  const rows = sortQueue(filterQueue());
  const foot = document.getElementById('queue-foot');
  const overdueN = rows.filter(r => overdueDays(r) > 0).length;
  if (foot) foot.textContent = `Showing ${rows.length} of ${queueRows.length}${overdueN ? ` · ${overdueN} overdue` : ''}`;
  if (!rows.length) {
    board.innerHTML = `<div class="empty" style="padding:var(--s7)"><div class="ico-wrap">${icon('search')}</div><h4>Nothing matches</h4><p>Try a different filter or clear the search.</p></div>`;
    return;
  }
  board.innerHTML = `
    <table class="data-table queue-table">
      <thead><tr>
        <th>Patient</th><th>Stage</th><th>Assigned to</th><th>Status</th>
        <th>Uploaded</th><th>Last call</th><th class="num">Calls</th>
      </tr></thead>
      <tbody>
        ${rows.map(r => {
          const tag = followupTag(r.conversations || 0);
          const attemptHint = (r.status === 'pending' || r.status === 'in_progress') && r.attempts > 0
            ? `<span class="q-attempt" title="Dial attempts today">${r.attempts}/${r.max_attempts}</span>` : '';
          const moveBtn = canMove && ['pending', 'in_progress', 'callback'].includes(r.status)
            ? `<button class="btn btn-ghost btn-sm q-move-btn" data-qid="${r.queue_id}" data-pid="${r.patient_id}" title="Move this call to someone else on the same team">Move</button>` : '';
          return `
          <tr class="row-link" data-pid="${r.patient_id}" tabindex="0">
            <td>
              <div class="q-patient">
                <strong class="q-code">${r.patient_code || 'N/A'}</strong>
                <span class="q-name">${sanitize(r.full_name || 'N/A')}</span>
                <span class="q-loc">${sanitize(loc(r))}${r.cancer_type ? ' · ' + sanitize(r.cancer_type) : ''}</span>
              </div>
            </td>
            <td><span class="badge badge-${tag.cls}">${tag.label}</span></td>
            <td><div style="display:flex;align-items:center;gap:8px">${r.assigned_name ? sanitize(r.assigned_name) : '<span class="q-dim">Unassigned</span>'}${moveBtn}</div></td>
            <td><span class="badge badge-${QSTATUS_TONE[r.status] || 'neutral'}"><span class="dot"></span>${capitalize((r.status || '').replace('_', ' '))}</span>${attemptHint}${waitBadge(r)}</td>
            <td>${r.uploaded_at ? `<span title="${formatDateTime(r.uploaded_at)}">${formatDate(r.uploaded_at)}</span>` : '<span class="q-dim">N/A</span>'}</td>
            <td>${r.last_call_at ? formatRelativeTime(r.last_call_at) : '<span class="q-dim">Never</span>'}</td>
            <td class="num"><span class="q-calls" title="${r.conversations || 0} conversations · ${r.total_calls || 0} dials">${r.conversations || 0}<span class="q-calls-sep">/</span>${r.total_calls || 0}</span></td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;
  const byId = {}; rows.forEach(r => byId[r.patient_id] = r);
  board.querySelectorAll('tr[data-pid]').forEach(tr => {
    const open = () => showQueueDetail(byId[tr.dataset.pid]);
    tr.addEventListener('click', open);
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === tr) open(); });
  });
  const byQid = {}; rows.forEach(r => byQid[r.queue_id] = r);
  board.querySelectorAll('.q-move-btn').forEach(btn => btn.addEventListener('click', (e) => {
    e.stopPropagation();
    showMoveQueueModal(byQid[btn.dataset.qid]);
  }));
}

// ---- Move a queued call to someone else on the same team (managers only) ----
// v89: a nutrition_pitch row can only go to a nutritionist, and the caregiver
// rows can only go to mentors. Offering the wrong team just produced a raise
// from move_queue_entry with no valid candidate anywhere in the list.
async function showMoveQueueModal(row) {
  if (!row) return;
  const sb = getSupabase();
  const isNutRow = String(row.source || '').startsWith('nutrition');
  const el = document.createElement('div');
  el.innerHTML = `<div style="padding:var(--s6);text-align:center;color:var(--ink-3)"><span class="spinner" style="width:22px;height:22px;border-width:2.5px"></span><div style="margin-top:10px">Loading the team…</div></div>`;
  showModal({ title: `Move ${sanitize(row.full_name || row.patient_code || 'this call')}`, content: el, size: 'lg' });
  try {
    let team;
    if (isNutRow) {
      const { data, error } = await sb.rpc('get_nutrition_caseload');
      if (error) throw error;
      team = (data || [])
        .filter(m => m.nutritionist_id !== row.assigned_to)
        .map(m => ({ caller_id: m.nutritionist_id, full_name: m.full_name, available: true, today: m.outreach_pending }));
    } else {
      const { data, error } = await sb.rpc('get_team_availability');
      if (error) throw error;
      team = (data || []).filter(m => ['caller', 'caregiver_mentor'].includes(m.role) && m.caller_id !== row.assigned_to);
    }
    if (!team.length) { el.innerHTML = `<div class="empty" style="padding:var(--s6)"><div class="ico-wrap">${icon('users')}</div><h4>No one to move to</h4><p>There is no other ${isNutRow ? 'nutritionist' : 'caregiver mentor'} to take this call.</p></div>`; return; }
    el.innerHTML = `
      <p style="color:var(--ink-2);font-size:14px;margin-bottom:var(--s4)">Hand <strong>${sanitize(row.full_name || row.patient_code || 'this patient')}</strong>'s call${row.assigned_name ? ` from <strong>${sanitize(row.assigned_name)}</strong>` : ''} to:</p>
      <div style="display:flex;flex-direction:column;gap:6px;max-height:320px;overflow-y:auto;margin-bottom:var(--s4)">
        ${team.map(m => `
          <label style="display:flex;align-items:center;gap:11px;padding:9px 12px;border:1px solid var(--line);border-radius:10px;cursor:${!m.available ? 'not-allowed' : 'pointer'};opacity:${!m.available ? '.55' : '1'}">
            <input type="radio" name="move-target" value="${m.caller_id}" ${!m.available ? 'disabled' : ''} />
            <span class="avatar" style="background:${avColor(m.full_name)}">${inits(m.full_name)}</span>
            <span class="info-value" style="flex:1;min-width:0">${sanitize(m.full_name)}</span>
            ${!m.available ? '<span class="badge badge-danger">Off today</span>' : ''}
            <span class="tc-num ${(!isNutRow && (m.today ?? 0) > 22) ? 'over' : 'muted'}" style="font-size:14px" title="${isNutRow ? 'Outreach calls waiting for them' : `Calls due today${(m.today ?? 0) > 22 ? ': already over the ~22/day target' : ''}`}">${m.today ?? 0} ${isNutRow ? 'to offer' : 'today'}</span>
          </label>`).join('')}
      </div>
      <label style="display:flex;align-items:flex-start;gap:9px;cursor:pointer">
        <input type="checkbox" id="move-ownership" checked style="margin-top:3px" />
        <span><span class="info-value">${isNutRow ? 'Also hand over nutrition care for this patient' : 'Also hand over the patient (future follow-ups go to them)'}</span>
        <span class="due-meta" style="display:block;margin-top:2px">${isNutRow
          ? 'Unchecked = this one call moves and nothing else. Checked, they become the nutrition POC on the record.'
          : 'Unchecked = today-only cover: only this call moves, and the next daily build may schedule future follow-ups back to the current owner.'}</span></span>
      </label>
      <div class="form-actions">
        <button class="btn btn-secondary" id="move-cancel">Cancel</button>
        <button class="btn btn-primary" id="move-confirm">${icon('users')}Move call</button>
      </div>`;
    el.querySelector('#move-cancel').addEventListener('click', closeModal);
    el.querySelector('#move-confirm').addEventListener('click', async () => {
      const picked = el.querySelector('input[name="move-target"]:checked');
      if (!picked) { showToast('Pick who takes this call', 'warning'); return; }
      const target = team.find(m => m.caller_id === picked.value);
      const btn = el.querySelector('#move-confirm');
      btn.disabled = true; btn.innerHTML = '<span class="spinner" style="width:16px;height:16px;border-width:2px"></span>Moving…';
      try {
        const { data: res, error: mvErr } = await sb.rpc('move_queue_entry', {
          p_queue_id: row.queue_id,
          p_to: picked.value,
          p_move_ownership: el.querySelector('#move-ownership').checked,
        });
        if (mvErr) throw mvErr;
        const n = res?.target_today ?? 0;
        showToast(`Moved to ${target?.full_name || 'them'}: now has ${n} today${n > 22 ? ' (over the ~22/day target, keep an eye on their load)' : ''}`, 'success');
        closeModal();
        loadQueue();
      } catch (err) { showToast(err.message, 'error'); btn.disabled = false; btn.innerHTML = `${icon('users')}Move call`; }
    });
  } catch (err) {
    el.innerHTML = `<div class="empty" style="padding:var(--s6)"><h4>Couldn't load the team</h4><p>${sanitize(err.message)}</p></div>`;
  }
}

// ---- Assign patients to a caregiver mentor (managers only) ----
// When today's-queue rows exist on both sides of an assignment the RPCs report
// them separately: `queued` = brand-new rows on today's list, `moved_queue` =
// existing open rows re-pointed to the new owner. Spell that out when both hit.
function queueSplitNote(r) {
  const q = r?.queued || 0, mv = r?.moved_queue || 0;
  return q > 0 && mv > 0 ? ` · ${q} new on today's list · ${mv} re-pointed` : '';
}

// One modal, two teams. The caregiver path is byte-identical to what it has
// always been; team: 'nutrition' swaps exactly four things - who can take
// patients, where the candidate list comes from, which RPC writes, and
// whether today's queue is offered. Cloning it would have meant maintaining
// the stale-response guard, the delegated picker and the count-mirroring
// button label twice.
async function showAssignPatientsModal(presetMentorId = null, opts = {}) {
  const preset = typeof presetMentorId === 'string' ? presetMentorId : null;
  const isNut = opts.team === 'nutrition';
  const sb = getSupabase();
  const el = document.createElement('div');
  el.innerHTML = `<div style="padding:var(--s6);text-align:center;color:var(--ink-3)"><span class="spinner" style="width:22px;height:22px;border-width:2.5px"></span><div style="margin-top:10px">Loading the team…</div></div>`;
  showModal({ title: isNut ? 'Assign nutrition patients' : 'Assign patients', content: el, size: 'lg' });

  let mentors = []; const nameById = {};
  try {
    if (isNut) {
      const { data, error } = await sb.rpc('get_nutrition_caseload');
      if (error) throw error;
      mentors = (data || []).map(m => ({
        caller_id: m.nutritionist_id, full_name: m.full_name, role: 'nutritionist',
        available: true, owned: m.in_care, today: m.outreach_pending,
      }));
      mentors.forEach(m => nameById[m.caller_id] = m.full_name);
    } else {
      const { data, error } = await sb.rpc('get_team_availability');
      if (error) throw error;
      (data || []).forEach(m => nameById[m.caller_id] = m.full_name);
      mentors = (data || []).filter(m => ['caller', 'caregiver_mentor'].includes(m.role));
    }
  } catch (err) {
    el.innerHTML = `<div class="empty" style="padding:var(--s6)"><h4>Couldn't load the team</h4><p>${sanitize(err.message)}</p></div>`;
    return;
  }
  if (!mentors.length) {
    el.innerHTML = `<div class="empty" style="padding:var(--s6)"><div class="ico-wrap">${icon('users')}</div><h4>No ${isNut ? 'nutritionists' : 'caregiver mentors'}</h4><p>There is no active ${isNut ? 'nutritionist' : 'caregiver mentor'} to assign patients to.</p></div>`;
    return;
  }

  const state = { mentor: null, mode: isNut ? 'unclaimed' : 'never_called', from: '', q: '', selected: new Set() };
  let shown = []; let loadSeq = 0;

  el.innerHTML = `
    <div style="font:var(--t-body-strong);margin-bottom:8px">1 · Who takes them</div>
    <div style="display:flex;flex-direction:column;gap:6px;max-height:200px;overflow-y:auto;margin-bottom:var(--s2)">
      ${mentors.map(m => `
        <label style="display:flex;align-items:center;gap:11px;padding:8px 12px;border:1px solid var(--line);border-radius:10px;cursor:pointer">
          <input type="radio" name="ap-mentor" value="${m.caller_id}" data-off="${!m.available}" />
          <span class="avatar" style="background:${avColor(m.full_name)}">${inits(m.full_name)}</span>
          <span class="info-value" style="flex:1;min-width:0">${sanitize(m.full_name)}</span>
          ${!m.available ? '<span class="badge badge-danger">Off today</span>' : ''}
          <span class="due-meta" style="white-space:nowrap">${isNut ? `holds ${m.owned ?? 0} · ${m.today ?? 0} to offer` : `owns ${m.owned ?? 0} · ${m.today ?? 0} today`}</span>
        </label>`).join('')}
    </div>
    <div class="due-meta" id="ap-off-hint" style="display:none;margin-bottom:var(--s3)">They're marked Off today. You can still assign, but queued calls may rotate to others tomorrow if they stay off.</div>
    <div style="font:var(--t-body-strong);margin:var(--s4) 0 8px">2 · Which patients</div>
    <div class="tabs" id="ap-mode" style="margin-bottom:var(--s3)">
      <button type="button" class="tab active" data-amode="manual">Pick manually</button>
      <button type="button" class="tab" data-amode="quick">Quick fill</button>
    </div>
    <div id="ap-manual">
      <div class="tabs" id="ap-tabs" style="margin-bottom:var(--s3)">
        ${isNut ? `
        <button type="button" class="tab active" data-mode="unclaimed">Unclaimed</button>
        <button type="button" class="tab" data-mode="never_touched">Never touched</button>
        <button type="button" class="tab" data-mode="by_nutritionist">From a nutritionist</button>
        <button type="button" class="tab" data-mode="search">Search</button>` : `
        <button type="button" class="tab active" data-mode="never_called">Never called</button>
        <button type="button" class="tab" data-mode="unassigned">Unassigned</button>
        <button type="button" class="tab" data-mode="by_mentor">From a mentor</button>
        <button type="button" class="tab" data-mode="search">Search</button>`}
      </div>
      <select class="form-select" id="ap-from" style="display:none;margin-bottom:var(--s3);width:100%">
        <option value="">Pick whose patients to move…</option>
        ${mentors.map(m => `<option value="${m.caller_id}">${sanitize(m.full_name)}</option>`).join('')}
      </select>
      <input class="form-input" id="ap-search" style="display:none;margin-bottom:var(--s3);width:100%" placeholder="Name or patient code: at least 2 characters" />
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;color:var(--ink-2)"><input type="checkbox" id="ap-all" disabled /> Select all shown</label>
        <span class="due-meta" id="ap-count">0 selected</span>
      </div>
      <div id="ap-list" style="display:flex;flex-direction:column;gap:2px;max-height:260px;overflow-y:auto;border:1px solid var(--line);border-radius:10px;padding:6px"></div>
    </div>
    <div id="ap-quick" style="display:none">
      <div style="display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap;margin-bottom:var(--s3)">
        <div style="flex:0 0 auto"><label class="form-label" for="ap-qty">How many?</label>
          <input class="form-input" id="ap-qty" type="number" min="1" max="100" value="30" style="width:110px" /></div>
        <div style="flex:1;min-width:220px"><label class="form-label" for="ap-qfrom">Take from (optional)</label>
          <select class="form-select" id="ap-qfrom" style="width:100%">
            <option value="">Smart pick: unassigned, then quiet or overloaded owners</option>
            ${mentors.map(m => `<option value="${m.caller_id}">${sanitize(m.full_name)}</option>`).join('')}
          </select></div>
      </div>
      <p class="due-meta" style="margin-bottom:var(--s2)">${isNut
        ? 'Smart pick fills from unclaimed patients first, then shaves the most loaded holders down towards the team average, never below it. Quiet holders are shaved first. Pick a nutritionist to pull from their caseload instead.'
        : 'Smart pick fills from unassigned patients first, then owners with no calls this week (never-called and stalest first), then trims the most loaded owners down to the team average, never below it. Pick a mentor to pull from their caseload instead.'}</p>
    </div>
    <label style="display:${isNut ? 'none' : 'flex'};align-items:flex-start;gap:9px;cursor:pointer;margin-top:var(--s4)">
      <input type="checkbox" id="ap-queue-today" checked style="margin-top:3px" />
      <span><span class="info-value">Also put them in today's queue</span>
      <span class="due-meta" style="display:block;margin-top:2px">Off = no call today. They'll surface on the mentor's future daily lists instead.</span></span>
    </label>
    ${isNut ? `<p class="due-meta" style="margin-top:var(--s4)">They land on the nutritionist's <strong>My patients</strong> tab straight away. Outreach calls are built fresh every morning and are not written by hand here.</p>` : ''}
    <div class="form-actions">
      <button class="btn btn-secondary" id="ap-cancel">Cancel</button>
      <button class="btn btn-primary" id="ap-confirm" disabled>${icon('userPlus')}Assign patients</button>
      <button class="btn btn-primary" id="ap-quick-go" style="display:none" disabled>${icon('userPlus')}Give 30 patients</button>
    </div>`;

  const listEl = el.querySelector('#ap-list');
  const emptyMsg = (msg) => `<div style="padding:var(--s5);text-align:center;color:var(--ink-3);font-size:13px">${msg}</div>`;
  const EMPTY = {
    never_called: 'No never-called patients right now. Every callable patient has been dialled at least once.',
    unassigned: 'No unassigned callable patients. Everyone has an owner.',
    by_mentor: 'They own no callable patients.',
    unclaimed: 'Nobody is waiting. Every patient in the nutrition pool is held by someone.',
    never_touched: 'Every patient here has had some nutrition work logged.',
    by_nutritionist: 'They hold no patients.',
    search: 'No matches. Try another name or code.',
  };

  const syncCounts = () => {
    const n = state.selected.size;
    el.querySelector('#ap-count').textContent = `${n} selected`;
    const all = el.querySelector('#ap-all');
    all.disabled = shown.length === 0;
    all.checked = shown.length > 0 && shown.every(r => state.selected.has(r.patient_id));
    const btn = el.querySelector('#ap-confirm');
    btn.disabled = !state.mentor || n === 0;
    btn.innerHTML = icon('userPlus') + (n ? `Assign ${n} patient${n === 1 ? '' : 's'}` : 'Assign patients');
    syncQuick();
  };

  // Quick fill: button label mirrors the count; needs a mentor + a sane count.
  const qtyEl = el.querySelector('#ap-qty');
  const syncQuick = () => {
    const raw = parseInt(qtyEl.value, 10);
    const n = Math.min(100, Math.max(1, raw || 1));
    const go = el.querySelector('#ap-quick-go');
    go.disabled = !state.mentor || !(raw >= 1 && raw <= 100);
    go.innerHTML = icon('userPlus') + `Give ${n} patient${n === 1 ? '' : 's'}`;
  };
  qtyEl.addEventListener('input', syncQuick);

  const setAssignMode = (mode) => {
    state.assignMode = mode;
    el.querySelectorAll('#ap-mode .tab').forEach(t => t.classList.toggle('active', t.dataset.amode === mode));
    el.querySelector('#ap-manual').style.display = mode === 'manual' ? '' : 'none';
    el.querySelector('#ap-quick').style.display = mode === 'quick' ? '' : 'none';
    el.querySelector('#ap-confirm').style.display = mode === 'manual' ? '' : 'none';
    el.querySelector('#ap-quick-go').style.display = mode === 'quick' ? '' : 'none';
    if (mode === 'quick') syncQuick();
  };
  el.querySelectorAll('#ap-mode .tab').forEach(t => t.addEventListener('click', () => setAssignMode(t.dataset.amode)));

  const nutritionRow = (r) => {
    const touch = r.last_nutrition_touch
      ? `<span class="due-meta" style="white-space:nowrap">last worked ${formatRelativeTime(r.last_nutrition_touch)}</span>`
      : '<span class="badge badge-gold" style="white-space:nowrap">Never touched</span>';
    return `<label style="display:flex;align-items:center;gap:10px;padding:7px 10px;border-radius:8px;cursor:pointer">
      <input type="checkbox" class="ap-pick" value="${r.patient_id}" ${state.selected.has(r.patient_id) ? 'checked' : ''} />
      <span style="flex:1;min-width:0">
        <span class="info-value">${sanitize(r.full_name || 'N/A')}</span>
        <strong class="q-code" style="margin-left:6px">${sanitize(r.patient_code || '')}</strong>
        ${r.must_score != null ? `<span class="badge badge-${Number(r.must_score) >= 2 ? 'danger' : Number(r.must_score) === 1 ? 'warn' : 'ok'}" style="margin-left:6px">MUST ${r.must_score}</span>` : ''}
        <span class="due-meta" style="display:block;margin-top:2px">${r.owner_name ? 'held by ' + sanitize(r.owner_name) : 'Unclaimed'}${r.hint_owner_name ? ` · ${sanitize(r.hint_owner_name)} worked with them before` : ''}</span>
      </span>
      ${touch}
    </label>`;
  };

  const patientRow = (r) => {
    if (isNut) return nutritionRow(r);
    const calls = r.total_calls || 0;
    const callInfo = calls === 0
      ? '<span class="badge badge-gold" style="white-space:nowrap">Never called</span>'
      : `<span class="due-meta" style="white-space:nowrap">${calls} call${calls === 1 ? '' : 's'} · last ${formatRelativeTime(r.last_call_date)}</span>`;
    const qOwner = r.open_queue_owner
      ? (nameById[r.open_queue_owner] || (r.open_queue_owner === r.owner_id ? r.owner_name : null) || 'someone')
      : null;
    return `<label style="display:flex;align-items:center;gap:10px;padding:7px 10px;border-radius:8px;cursor:pointer">
      <input type="checkbox" class="ap-pick" value="${r.patient_id}" ${state.selected.has(r.patient_id) ? 'checked' : ''} />
      <span style="flex:1;min-width:0">
        <span class="info-value">${sanitize(r.full_name || 'N/A')}</span>
        <strong class="q-code" style="margin-left:6px">${sanitize(r.patient_code || '')}</strong>
        <span class="badge badge-${r.patient_status === 'active' ? 'ok' : 'neutral'}" style="margin-left:6px">${capitalize((r.patient_status || 'N/A').replace('_', ' '))}</span>
        <span class="due-meta" style="display:block;margin-top:2px">${r.owner_name ? sanitize(r.owner_name) : 'Unassigned'}${qOwner ? ` · in ${sanitize(qOwner)}'s queue today` : ''}</span>
      </span>
      ${callInfo}
    </label>`;
  };

  async function loadPatients() {
    const seq = ++loadSeq;
    if ((state.mode === 'by_mentor' || state.mode === 'by_nutritionist') && !state.from) {
      shown = []; listEl.innerHTML = emptyMsg(`Pick a ${isNut ? 'nutritionist' : 'mentor'} above to see their patients.`); syncCounts(); return; }
    if (state.mode === 'search' && state.q.trim().length < 2) { shown = []; listEl.innerHTML = emptyMsg('Type at least 2 characters to search.'); syncCounts(); return; }
    listEl.innerHTML = `<div style="padding:var(--s5);text-align:center;color:var(--ink-3)"><span class="spinner" style="width:18px;height:18px;border-width:2px"></span></div>`;
    try {
      const args = { p_mode: state.mode };
      if (state.mode === 'by_mentor' || state.mode === 'by_nutritionist') args.p_from = state.from;
      if (state.mode === 'search') args.p_search = state.q.trim();
      const { data, error } = await sb.rpc(isNut ? 'get_assignable_nutrition_patients' : 'get_assignable_patients', args);
      if (error) throw error;
      if (seq !== loadSeq) return; // a newer load superseded this one
      shown = data || [];
      listEl.innerHTML = shown.length ? shown.map(patientRow).join('') : emptyMsg(EMPTY[state.mode]);
      syncCounts();
    } catch (err) {
      if (seq !== loadSeq) return;
      shown = []; listEl.innerHTML = emptyMsg(sanitize(err.message)); syncCounts();
    }
  }

  // Mentor pick
  el.querySelectorAll('input[name="ap-mentor"]').forEach(r => r.addEventListener('change', () => {
    state.mentor = r.value;
    el.querySelector('#ap-off-hint').style.display = r.dataset.off === 'true' ? 'block' : 'none';
    syncCounts();
  }));

  // Patient tab switching
  el.querySelectorAll('#ap-tabs .tab').forEach(tab => tab.addEventListener('click', () => {
    el.querySelectorAll('#ap-tabs .tab').forEach(t => t.classList.remove('active')); tab.classList.add('active');
    state.mode = tab.dataset.mode;
    el.querySelector('#ap-from').style.display = (state.mode === 'by_mentor' || state.mode === 'by_nutritionist') ? '' : 'none';
    el.querySelector('#ap-search').style.display = state.mode === 'search' ? '' : 'none';
    loadPatients();
  }));
  el.querySelector('#ap-from').addEventListener('change', (e) => { state.from = e.target.value; loadPatients(); });
  let searchT;
  el.querySelector('#ap-search').addEventListener('input', (e) => {
    state.q = e.target.value;
    clearTimeout(searchT); searchT = setTimeout(loadPatients, 300);
  });

  // Selection (delegated: list re-renders per tab)
  listEl.addEventListener('change', (e) => {
    if (!e.target.classList.contains('ap-pick')) return;
    if (e.target.checked) state.selected.add(e.target.value); else state.selected.delete(e.target.value);
    syncCounts();
  });
  el.querySelector('#ap-all').addEventListener('change', (e) => {
    shown.forEach(r => { if (e.target.checked) state.selected.add(r.patient_id); else state.selected.delete(r.patient_id); });
    listEl.querySelectorAll('.ap-pick').forEach(cb => cb.checked = e.target.checked);
    syncCounts();
  });

  el.querySelector('#ap-cancel').addEventListener('click', closeModal);
  el.querySelector('#ap-confirm').addEventListener('click', async () => {
    const ids = [...state.selected];
    if (!state.mentor || !ids.length) return;
    const btn = el.querySelector('#ap-confirm');
    btn.disabled = true; btn.innerHTML = '<span class="spinner" style="width:16px;height:16px;border-width:2px"></span>Assigning…';
    try {
      const { data: res, error } = isNut
        ? await sb.rpc('set_nutrition_owner', { p_patient_ids: ids, p_to: state.mentor })
        : await sb.rpc('assign_patients', {
            p_patient_ids: ids,
            p_to: state.mentor,
            p_queue_today: el.querySelector('#ap-queue-today').checked,
          });
      if (error) throw error;
      const r = res || {};
      const name = nameById[state.mentor] || 'them';
      let msg;
      if (isNut) {
        msg = `${r.claimed ?? 0} now with ${name}. They are on their My patients tab.`;
        if ((r.skipped || 0) > 0) msg += ` · ${r.skipped} skipped (no longer callable)`;
        if ((r.unchanged || 0) > 0) msg += ` · ${r.unchanged} already hers`;
      } else {
        msg = `Assigned ${r.assigned ?? ids.length} to ${name}: now owns ${r.target_owned ?? 'N/A'}, ${r.target_today ?? 'N/A'} on today's list`;
        msg += queueSplitNote(r);
        if ((r.skipped || 0) > 0) msg += ` · ${r.skipped} skipped (no longer callable)`;
        if (r.target_off_today) msg += ` · they're off today, so queued calls may rotate tomorrow`;
      }
      showToast(msg, 'success');
      closeModal();
      const activeTab = document.querySelector('#team-tabs .tab.active')?.dataset.tab;
      if (activeTab === 'queue') loadQueue();
      else if (activeTab === 'nutrition') loadNutritionRoster();
      else if (activeTab === 'availability') loadAvailability();
    } catch (err) { showToast(err.message, 'error'); syncCounts(); }
  });

  el.querySelector('#ap-quick-go').addEventListener('click', async () => {
    if (!state.mentor) { showToast('Pick who takes them first', 'warning'); return; }
    const raw = parseInt(qtyEl.value, 10);
    if (!(raw >= 1 && raw <= 100)) { showToast('How many? Enter a number from 1 to 100', 'warning'); return; }
    const from = el.querySelector('#ap-qfrom').value;
    if (from && from === state.mentor) { showToast(`They can't take patients from themselves, pick another ${isNut ? 'nutritionist' : 'mentor'} or leave it on smart pick`, 'warning'); return; }
    const go = el.querySelector('#ap-quick-go');
    go.disabled = true; go.innerHTML = '<span class="spinner" style="width:16px;height:16px;border-width:2px"></span>Assigning…';
    try {
      const args = isNut
        ? { p_to: state.mentor, p_count: raw }
        : { p_to: state.mentor, p_count: raw, p_queue_today: el.querySelector('#ap-queue-today').checked };
      if (from) args.p_from = from;
      const { data: res, error } = await sb.rpc(isNut ? 'quick_assign_nutrition' : 'quick_assign_patients', args);
      if (error) throw error;
      const r = res || {};
      const name = nameById[state.mentor] || 'them';
      if (isNut) {
        const got = r.claimed ?? 0, want = r.requested ?? raw;
        let m = `${got} of ${want} now with ${name}.`;
        if (r.note) m += ' ' + r.note;
        showToast(m, got < want ? 'warning' : 'success');
        closeModal();
        const tab = document.querySelector('#team-tabs .tab.active')?.dataset.tab;
        if (tab === 'nutrition') loadNutritionRoster(); else if (tab === 'queue') loadQueue();
        return;
      }
      const picked = r.picked ?? 0, requested = r.requested ?? raw;
      let msg = `Gave ${picked} of ${requested} to ${name}: now owns ${r.target_owned ?? 'N/A'}, ${r.target_today ?? 'N/A'} today`;
      msg += queueSplitNote(r);
      if ((r.sources || []).length) msg += ' · from ' + r.sources.map(s => (s.owner_name || 'unassigned') + ' (' + s.n + ')').join(', ');
      if ((r.skipped || 0) > 0) msg += ` · ${r.skipped} skipped (no longer callable)`;
      if (r.target_off_today) msg += ` · they're off today, so queued calls may rotate tomorrow`;
      const short = picked < requested;
      if (short) msg += ` · the pool ran short, no more patients to pull without dragging other mentors below the team average`;
      showToast(msg, short ? 'warning' : 'success');
      closeModal();
      const activeTab = document.querySelector('#team-tabs .tab.active')?.dataset.tab;
      if (activeTab === 'queue') loadQueue(); else if (activeTab === 'availability') loadAvailability();
    } catch (err) { showToast(err.message, 'error'); syncQuick(); }
  });

  // Pre-select a mentor when opened from a roster card's "Give patients".
  if (preset) {
    const radio = el.querySelector(`input[name="ap-mentor"][value="${preset}"]`);
    if (radio) { radio.checked = true; radio.dispatchEvent(new Event('change')); }
  }

  loadPatients();
}

// ---- Patient peek: info + the full call story, from the queue ----
async function showQueueDetail(row) {
  if (!row) return;
  const sb = getSupabase();
  const el = document.createElement('div');
  el.innerHTML = `<div style="padding:var(--s6);text-align:center;color:var(--ink-3)"><span class="spinner" style="width:22px;height:22px;border-width:2.5px"></span><div style="margin-top:10px">Loading their story…</div></div>`;
  showModal({ title: sanitize(row.full_name || row.patient_code || 'Patient'), content: el, size: 'lg' });
  try {
    const [{ data: p }, histRes] = await Promise.all([
      sb.from('patients').select('*').eq('id', row.patient_id).maybeSingle(),
      sb.rpc('get_patient_call_history', { p_patient_id: row.patient_id }),
    ]);
    const patient = p || {};
    const history = histRes.data || [];
    const tag = followupTag(row.conversations || 0);
    const info = [
      ['Code', patient.patient_code || row.patient_code || 'N/A'],
      ['Phone', patient.phone_full || row.phone_full || 'N/A'],
      ['Age · Gender', `${patient.age || 'N/A'} · ${capitalize(patient.gender || 'N/A')}`],
      ['Location', loc(row)],
      ['Cancer', patient.cancer_type || row.cancer_type || 'Not reported'],
      ['Stage', capitalize(patient.cancer_stage || 'N/A')],
      ['Status', capitalize((patient.patient_status || row.patient_status || 'N/A').replace('_', ' '))],
      ['Assigned to', row.assigned_name || 'Unassigned'],
      ['Uploaded', row.uploaded_at ? formatDateTime(row.uploaded_at) : 'N/A'],
      ['First reached', row.first_contact_at ? formatDate(row.first_contact_at) : 'Not yet'],
    ];
    el.innerHTML = `
      <div class="qd-head">
        <span class="badge badge-${tag.cls}">${tag.label}</span>
        <span class="qd-count">${row.conversations || 0} conversation${(row.conversations || 0) === 1 ? '' : 's'} · ${row.total_calls || 0} dial${(row.total_calls || 0) === 1 ? '' : 's'}</span>
      </div>
      <div class="kv" style="margin-bottom:var(--s5)">
        ${info.map(([k, v]) => `<div><div class="k">${k}</div><div class="v${v === 'N/A' || v === 'Not yet' || v === 'Unassigned' ? ' dim' : ''}">${sanitize(String(v))}</div></div>`).join('')}
      </div>
      ${patient.caregiver_name ? `<div class="qd-caregiver">${icon('users')}<div><div class="k">Caregiver</div><div class="v">${sanitize(patient.caregiver_name)}${patient.caregiver_relationship ? ' · ' + sanitize(patient.caregiver_relationship) : ''}${patient.caregiver_phone_full ? ' · ' + sanitize(patient.caregiver_phone_full) : ''}</div></div></div>` : ''}
      <div class="qd-history-title">${icon('phone')}The call story · ${history.length} log${history.length === 1 ? '' : 's'}</div>
      ${renderQueueHistory(history)}
      <div class="form-actions">
        <button class="btn btn-secondary" id="qd-close">Close</button>
        <button class="btn btn-primary" id="qd-open">${icon('user')}Open full patient</button>
      </div>`;
    el.querySelector('#qd-close').addEventListener('click', closeModal);
    el.querySelector('#qd-open').addEventListener('click', () => { closeModal(); navigate('patients/' + row.patient_id); });
  } catch (err) {
    el.innerHTML = `<div class="empty" style="padding:var(--s6)"><h4>Couldn't load the history</h4><p>${sanitize(err.message)}</p></div>`;
  }
}

function renderQueueHistory(history) {
  if (!history.length) {
    return `<div class="qd-empty">${icon('inbox')}<div>No calls logged yet. This relationship is still to be opened.</div></div>`;
  }
  return `<div class="qd-timeline">
    ${history.map(h => {
      const ds = DIAL_STATUSES.find(d => d.key === h.dial_status) || { label: capitalize(h.dial_status || 'N/A'), tone: 'neutral' };
      const cond = CONDITIONS.find(c => c.key === h.patient_condition);
      const reqs = h.structured?.requirements || [];
      return `<div class="qd-call">
        <div class="qd-call-top">
          <span class="badge badge-${ds.tone === 'ok' ? 'ok' : ds.tone === 'danger' ? 'danger' : ds.tone === 'warn' ? 'warn' : ds.tone === 'primary' ? 'primary' : 'neutral'}">${ds.label}</span>
          ${h.receptiveness_bucket ? `<span class="badge badge-primary">${capitalize(h.receptiveness_bucket)}</span>` : ''}
          ${cond ? `<span class="badge badge-${cond.tone === 'ok' ? 'ok' : cond.tone === 'danger' ? 'danger' : cond.tone === 'warn' ? 'warn' : 'neutral'}">${cond.label}</span>` : ''}
          <span class="qd-call-meta">${sanitize(capitalize((h.caller_name || 'N/A').toLowerCase()))} · ${formatDateTime(h.call_date)}${h.call_duration_mins ? ' · ' + h.call_duration_mins + ' min' : ''}</span>
        </div>
        ${reqs.length ? `<div class="chip-row" style="margin:6px 0">${reqs.map(r => `<span class="badge badge-gold">${sanitize(r)}</span>`).join('')}</div>` : ''}
        ${h.caller_notes ? `<div class="qd-note">${sanitize(h.caller_notes)}</div>` : ''}
        ${h.feedback_patient ? `<div class="qd-note qd-quote">“${sanitize(h.feedback_patient)}” · patient</div>` : ''}
        ${h.followup_strategy_notes ? `<div class="qd-note qd-handoff">↪ for the next caller: ${sanitize(h.followup_strategy_notes)}</div>` : ''}
        ${h.follow_up_date ? `<div class="qd-next">Next check-in set for ${formatDate(h.follow_up_date)}</div>` : ''}
      </div>`;
    }).join('')}
  </div>`;
}

// ---- Bulk lead intake ----
function normPhone(raw) {
  let p = String(raw || '').trim().replace(/\.0$/, '');
  const g = p.match(/\d[\d\s]+/g); if (!g) return null;
  for (const x of g) { const d = x.replace(/\s/g, ''); if (d.length === 10) return d; if (d.length === 12 && d.startsWith('91')) return d.slice(2); if (d.length === 11 && d.startsWith('0')) return d.slice(1); }
  const f = g[0].replace(/\s/g, ''); return f.length >= 9 ? f.slice(-10) : null;
}
function normGender(raw) { const g = String(raw || '').trim().toLowerCase(); if (g.startsWith('m')) return 'male'; if (g.startsWith('f')) return 'female'; return 'prefer_not_to_say'; }

function showBulkLeadModal() {
  const el = document.createElement('div');
  el.innerHTML = `
    <p style="color:var(--ink-2);font-size:14px;margin-bottom:var(--s4)">Paste rows from your sheet, one lead per line, columns separated by <strong>Tab or comma</strong>, in this order:</p>
    <div class="badge badge-neutral" style="margin-bottom:10px">Name · Phone · Age · Gender · Location · Cancer type · Caregiver name · Caregiver phone</div>
    <textarea class="textarea" id="bulk-text" style="min-height:180px;font-family:var(--font-mono);font-size:13px" placeholder="Ramesh Kumar	9876543210	54	Male	Pune, Maharashtra	Lung	Sita Kumar	9876543211"></textarea>
    <div class="hint" id="bulk-preview" style="margin-top:8px"></div>
    <div class="form-actions"><button class="btn btn-secondary" id="bulk-cancel">Cancel</button><button class="btn btn-primary" id="bulk-submit">${icon('userPlus')}Add leads</button></div>`;
  showModal({ title: 'Add new leads', content: el, size: 'lg' });
  const ta = el.querySelector('#bulk-text'); const prev = el.querySelector('#bulk-preview');
  const parse = () => ta.value.split('\n').map(l => l.trim()).filter(Boolean).map(l => { const c = l.split(/\t|,/).map(s => s.trim());
    return { full_name: c[0], phone: normPhone(c[1]), age: parseInt(c[2]) || null, gender: normGender(c[3]), location: c[4] || null, cancer_type: c[5] || null, caregiver_name: c[6] || null, caregiver_phone: normPhone(c[7]) }; }).filter(r => r.full_name);
  ta.addEventListener('input', () => { const rows = parse(); const valid = rows.filter(r => r.phone); prev.textContent = `${rows.length} rows · ${valid.length} with a valid phone`; });
  el.querySelector('#bulk-cancel').addEventListener('click', closeModal);
  el.querySelector('#bulk-submit').addEventListener('click', async () => {
    const rows = parse(); if (!rows.length) { showToast('Nothing to add', 'warning'); return; }
    const validRows = rows.filter(r => r.phone);
    if (!validRows.length) { showToast('No valid 10-digit phone numbers', 'warning'); return; }
    const btn = el.querySelector('#bulk-submit'); btn.disabled = true; btn.innerHTML = '<span class="spinner" style="width:16px;height:16px;border-width:2px"></span>Adding…';
    const sb = getSupabase();
    try {
      // Route through bulk_add_leads: one dedup path (in-paste + in-system),
      // gi_subtype derivation, and the DB unique-phone backstop. Splits
      // "City, State" location into the two columns the RPC expects.
      const payload = validRows.map(r => {
        const loc = (r.location || '').split(',').map(s => s.trim());
        return { phone: r.phone, name: r.full_name, age: r.age, gender: r.gender,
          city: loc[0] || null, state: loc[1] || null, cancer_type: r.cancer_type,
          caregiver_name: r.caregiver_name, caregiver_phone: r.caregiver_phone };
      });
      const { data, error } = await sb.rpc('bulk_add_leads', { p_rows: payload });
      if (error) throw error;
      const r = data || {};
      if (!r.added) { showToast(`Nothing added: ${r.duplicates || 0} already existed · ${r.invalid || 0} invalid`, 'info'); closeModal(); return; }
      showToast(`Added ${r.added} new lead${r.added === 1 ? '' : 's'}${r.duplicates ? ` · ${r.duplicates} already existed` : ''}${r.invalid ? ` · ${r.invalid} invalid` : ''}. Build the list to assign them.`, 'success');
      closeModal();
    } catch (err) { showToast('Could not add leads: ' + err.message, 'error'); btn.disabled = false; btn.innerHTML = 'Add leads'; }
  });
}

// ---- Invite team member (server-side, org default password) ----
async function showInviteTeamMemberModal() {
  if (!isManagerOrAdmin()) {
    showToast('Only admins and managers can add users.', 'warning');
    return;
  }
  const sb = getSupabase();
  const subRoles = [{ value: 'caregiver_mentor', label: 'Caregiver Mentor' }, { value: 'ground_poc', label: 'Ground POC' }, { value: 'therapist', label: 'Therapist' }, { value: 'nutritionist', label: 'Nutritionist' }, { value: 'content', label: 'Content' }, { value: 'uploader', label: 'Intake / Uploader' }];
  const allRoles = isAdmin()
    ? [...subRoles, { value: 'manager', label: 'Manager' }, { value: 'admin', label: 'Admin' }]
    : [...subRoles, { value: 'manager', label: 'Manager' }];
  const roleOptions = allRoles.map(r => `<option value="${r.value}">${r.label}</option>`).join('');
  const el = document.createElement('div');
  el.innerHTML = `
    <form id="invite-team-form">
      <div class="consent-banner" style="margin-bottom:var(--s4)">${icon('key')}<p style="margin:0">Only admins can create accounts. New accounts start on the team default password and set their own on first sign-in.</p></div>
      <div class="form-group"><label class="form-label">Email <span class="required">*</span></label><input class="input" id="tm-email" type="email" placeholder="firstname@carcinome.org" required /></div>
      <div class="form-group"><label class="form-label">Full name <span class="required">*</span></label><input class="input" id="tm-name" placeholder="Full name" required /></div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">Role</label><select class="select" id="tm-role">${roleOptions}</select></div>
        <div class="form-group"><label class="form-label">Assign to manager (optional)</label><select class="select" id="tm-manager"><option value="">No manager</option></select></div>
      </div>
      <div class="form-actions"><button type="button" class="btn btn-secondary" id="tm-cancel">Cancel</button><button type="submit" class="btn btn-primary" id="tm-submit">Create account</button></div>
    </form>`;
  showModal({ title: 'Invite team member', content: el, size: 'lg' });
  try { const { data: managers } = await sb.rpc('get_available_managers'); const opts = (managers || []).map(m => `<option value="${m.id}">${sanitize(m.full_name)} (${m.role})</option>`).join(''); const sel = el.querySelector('#tm-manager'); if (sel) sel.innerHTML += opts; } catch {}
  el.querySelector('#tm-cancel').addEventListener('click', () => closeModal());
  el.querySelector('#invite-team-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = el.querySelector('#tm-email').value.trim(), name = el.querySelector('#tm-name').value.trim(), role = el.querySelector('#tm-role').value;
    const btn = el.querySelector('#tm-submit');
    if (!validateEmail(email)) { showToast('Enter a valid email', 'warning'); return; }
    if (!name) { showToast('Full name is required', 'warning'); return; }
    btn.disabled = true; btn.innerHTML = '<span class="spinner" style="margin:0 auto"></span>';
    try {
      const managerId = el.querySelector('#tm-manager')?.value || null;
      const { data, error } = await sb.rpc('admin_create_user', { p_email: email, p_full_name: name, p_role: role, p_manager_id: managerId });
      if (error) throw error;
      closeModal();
      const creds = document.createElement('div');
      creds.innerHTML = `<div style="text-align:center;padding:var(--s4)"><div class="ico-wrap" style="width:60px;height:60px;border-radius:50%;background:var(--ok-soft);color:var(--ok);display:grid;place-items:center;margin:0 auto var(--s4)">${icon('checkCircle')}</div>
        <h3 style="margin-bottom:var(--s2)">${sanitize(name)} can sign in now</h3><p style="color:var(--ink-2);margin-bottom:var(--s5)">Share once. They'll set their own password on first sign-in:</p>
        <div class="card" style="text-align:left"><div class="form-group"><label class="form-label">Email</label><code>${data.email}</code></div><div class="form-group"><label class="form-label">First-time password</label><code>${data.default_password}</code></div><div class="form-group" style="margin:0"><label class="form-label">Role</label>${getRoleBadge(role)}</div></div>
        <div class="form-actions" style="justify-content:center;border:none;margin-top:var(--s4)"><button class="btn btn-primary" id="creds-done">Done</button></div></div>`;
      showModal({ title: 'Team member created', content: creds, size: 'lg' });
      creds.querySelector('#creds-done').addEventListener('click', () => { closeModal(); loadTeamMembers(); });
    } catch (err) { showToast('Failed: ' + err.message, 'error'); btn.disabled = false; btn.textContent = 'Create account'; }
  });
}
