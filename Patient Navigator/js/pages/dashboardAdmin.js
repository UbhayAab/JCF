// ============================================================
// Patient Navigator: the manager and admin dashboard (v11, Oct 2026).
//
// Built from the redesign's "Admin Dashboard" frames. The old page was mostly
// numbers, and the work it pointed at lived one or two clicks away on
// Team > Availability and Team > Today's queue. This one leads with what is
// stuck today, each next to the action that unsticks it:
//   1. five headline numbers (the old hero card row and stat row, merged into
//      one hierarchy, with the redesign's pink tile for financial need)
//   2. Today's queue, urgent flags, due today with Move, calls that nobody
//      can make today with "Assign temporary caller", recent conversations
//      with what was actually said
//   3. a side column: Saturday circle, back from leave (Restore all), families
//      the team has not reached (care gaps, sql/151), blocked patients,
//      documents waiting, today's intake, WhatsApp replies
//   4. the pastel "How we're doing" wall and 30 days of calls
//
// Every number comes from the RPC its owning page uses, so the two cannot
// disagree: the queue counters are Team > Today's queue's own definitions,
// "Assign temporary caller" is that page's Move dialog opened as a today-only
// cover, and Restore all is the Availability tab's restore_owned_patients.
// The care-gap card is the one piece that needs the database (sql/151's
// get_care_gap_summary); until that exists the card stays empty.
// ============================================================

import { getSupabase } from '../supabase.js';
import { formatRelativeTime, formatDate } from '../utils/formatters.js';
import { concernReason } from '../utils/catalog.js';
import { showToast } from '../components/toast.js';
import { confirmModal } from '../components/modal.js';
import { navigate } from '../router.js';
import { icon } from '../components/icons.js';
import { sanitize } from '../utils/validators.js';
import { avatarColor, initials } from '../utils/avatar.js';
import { createChart, createGradient, CHART_COLORS } from '../utils/charts.js';
// team.js gained these two exports in this release. A device can hold the old
// team.js for a few minutes after a deploy (Pages caches modules for 10), and a
// static import of a name it lacks stops the WHOLE app from starting. Loaded on
// use, the worst case is one button asking for a refresh.
async function teamApi(name) {
  const mod = await import('./team.js');
  if (typeof mod[name] !== 'function') throw new Error('stale');
  return mod[name];
}
async function showMoveQueueModal(row, opts) {
  try { (await teamApi('showMoveQueueModal'))(row, opts); }
  catch { showToast('This needs the newest version of the app: tap Refresh app, then try again.', 'warning'); }
}
async function openTeamOn(tab) {
  try { (await teamApi('openTeamOn'))(tab); }
  catch { navigate('team'); }
}
import {
  talkTime, loadSaturdayCard, loadResourceReplies, loadBlockedCard,
  loadDocsWaitingCard, loadIntakeSummary, buildAssignments,
} from '../components/dashCards.js';

const OPEN = new Set(['pending', 'in_progress', 'callback']);
const isNutritionRow = (r) => String(r.source || '').startsWith('nutrition');
const istToday = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
// spread_daily_load (sql/38) parks a day's overflow on later days, so a row on
// today's board can be scheduled for tomorrow: it is not due today.
const isDueToday = (r) => !r.scheduled_for || String(r.scheduled_for).slice(0, 10) <= istToday();
// The page's "run today's build" action. Kept here so every reload of the queue
// (after a Move, a build or a Restore) keeps the Cover all button.
let coverAllFn = null;

function ordinal(n) { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
// Same tags and the same arithmetic as Team > Today's queue (js/pages/team.js).
function stageChip(conv) {
  return conv > 0
    ? `<span class="chip chip-beige">${ordinal(conv)} follow-up</span>`
    : '<span class="chip">New lead</span>';
}
function overdueDays(r) {
  if (!OPEN.has(r.status) || !r.generated_for) return 0;
  const t = new Date(); t.setHours(0, 0, 0, 0);
  const g = new Date(r.generated_for); g.setHours(0, 0, 0, 0);
  return Math.max(0, Math.round((t - g) / 86400000));
}
const STATUS_CHIP = {
  pending: ['badge-neutral', 'Pending'], in_progress: ['badge-info', 'In progress'],
  callback: ['badge-beige', 'Callback'], completed: ['badge-ok', 'Done'], skipped: ['badge-danger', 'Skipped'],
};
function statusCell(r) {
  const [cls, label] = STATUS_CHIP[r.status] || ['badge-neutral', r.status || 'N/A'];
  const od = overdueDays(r);
  return `<span class="badge ${cls}">${label}</span>${od ? `<span class="od">${od}d overdue</span>` : ''}`;
}
const greetingWord = () => { const h = new Date().getHours(); return h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening'; };

export async function renderAdminDashboard(container, { firstName, subtitle, today, role }) {
  container.innerHTML = `
    <div class="dash dash-v11">
      <div class="greet">
        <div>
          <h1>Good ${greetingWord()}, ${sanitize(firstName)}</h1>
          <p>${subtitle}</p>
        </div>
        <div class="date">${today}</div>
      </div>

      <div class="kpi-row" id="kpi-row">${Array(5).fill('<div class="kpi"><div class="sk" style="height:84px"></div></div>').join('')}</div>

      <div class="quick">
        <a class="qa" id="qa-build"><span class="qa-ico teal">${icon('list')}</span><div><div class="qa-title">Build today's list</div><div class="qa-sub">Assign calls to the team</div></div></a>
        <a class="qa" id="qa-leads"><span class="qa-ico coral">${icon('userPlus')}</span><div><div class="qa-title">Add new leads</div><div class="qa-sub">Bulk-add today's numbers</div></div></a>
        <a class="qa" id="qa-analytics"><span class="qa-ico blue">${icon('chart')}</span><div><div class="qa-title">See how we're doing</div><div class="qa-sub">Open analytics</div></div></a>
      </div>

      <div class="dash-cols">
        <div class="dash-main">
          <section class="card dq-queue" id="dq-queue">
            <div class="dq-queue-head"><h3 class="card-title">Today's queue</h3><span class="due-meta">Caregiver calls</span></div>
            <div class="dq-counters" id="dq-counters">${Array(4).fill('<div><div class="sk" style="height:46px"></div></div>').join('')}</div>
          </section>
          <div class="dash-pair">
            <section class="card card-flush" id="dq-urgent"><div style="padding:var(--s5)">${Array(3).fill('<div class="sk skeleton-row"></div>').join('')}</div></section>
            <section class="card card-flush" id="dq-due"><div style="padding:var(--s5)">${Array(3).fill('<div class="sk skeleton-row"></div>').join('')}</div></section>
          </div>
          <div id="dq-cover"></div>
          <section class="card card-flush" id="dq-convos"><div style="padding:var(--s5)">${Array(3).fill('<div class="sk skeleton-row"></div>').join('')}</div></section>
        </div>
        <aside class="dash-side">
          <div id="saturday-card"></div>
          <div id="dq-restore"></div>
          <div id="care-gap-card"></div>
          <div id="blocked-card"></div>
          <div id="docs-waiting-card"></div>
          <section class="card card-flush">
            <div class="card-head"><h3>Today's intake</h3><span style="width:20px;height:20px;color:var(--ink-3)">${icon('inbox')}</span></div>
            <div class="intake">
              <p style="font-size:13.5px;color:var(--ink-2)">New people added in the last 24 hours, waiting for assignment.</p>
              <div class="intake-nums" id="intake-nums">
                <div class="intake-num"><div class="n">…</div><div class="l">Added today</div></div>
                <div class="intake-num warn"><div class="n">…</div><div class="l">Not yet assigned</div></div>
              </div>
              <button class="btn btn-primary btn-block" id="distribute-btn">${icon('users')}Build today's assignments</button>
            </div>
          </section>
          <div id="resource-replies"></div>
        </aside>
      </div>

      <section class="dash-wall">
        <div class="wall-head"><h2>How we're doing</h2><a class="link-u" id="wall-analytics">Open analytics ${icon('arrowRight')}</a></div>
        <div class="tiles" id="dq-tiles">${Array(10).fill('<div class="tile"><div class="sk" style="height:70px"></div></div>').join('')}</div>
      </section>

      <section class="card dq-chart" id="dq-chart">
        <div class="dq-chart-head">
          <div><span class="chip chip-info">Last 30 days</span><h3 class="card-title" style="margin-top:8px">Calls over time</h3></div>
          <div class="legend"><span><i style="background:${CHART_COLORS.primary}"></i>Total</span><span><i style="background:${CHART_COLORS.success}"></i>Connected</span></div>
        </div>
        <div class="chart-canvas-wrap short"><canvas id="dq-calls-chart"></canvas></div>
      </section>
    </div>`;

  const reloadQueue = () => Promise.all([loadQueueSections(), loadKpis()]);
  const build = () => buildAssignments({
    buttons: [document.getElementById('distribute-btn'), document.getElementById('qa-build'), document.getElementById('dq-cover-all')],
    onDone: () => Promise.all([reloadQueue(), loadIntakeSummary()]),
  });
  // Cover all is the whole build (new leads, sweeps, top-ups), not just these
  // rows, so it says so before it runs.
  coverAllFn = () => confirmModal(
    'Run today\'s build now? It hands the calls nobody can make to mentors who are in today, and also gives out new leads and tops up everyone\'s list, exactly like "Build today\'s list".',
    build, { title: 'Run today\'s build', confirmLabel: 'Run the build', danger: false });
  document.getElementById('qa-build')?.addEventListener('click', build);
  document.getElementById('distribute-btn')?.addEventListener('click', build);
  document.getElementById('qa-leads')?.addEventListener('click', () => navigate('upload'));
  document.getElementById('qa-analytics')?.addEventListener('click', () => navigate('analytics'));
  document.getElementById('wall-analytics')?.addEventListener('click', () => navigate('analytics'));

  // The working half first; the wall and the chart are below the fold and
  // wait for it, so a slow day never queues them in front of the to-dos.
  const stats = loadKpis();
  await Promise.all([
    stats, loadQueueSections(), loadUrgentFlags(), loadConversations(), loadRestores(), loadCareGaps(),
    loadSaturdayCard(role, { side: true }), loadBlockedCard(), loadDocsWaitingCard(),
    loadIntakeSummary(), loadResourceReplies(),
  ]);
  await Promise.all([loadWall(await stats), loadCallsChart()]);
}

// ---- 1. Headline numbers --------------------------------------------------
async function loadKpis() {
  const sb = getSupabase();
  const el = document.getElementById('kpi-row');
  try {
    const [statsR, finR] = await Promise.all([
      sb.rpc('get_dashboard_stats', { p_user_id: null }),
      sb.rpc('get_insight_financial'),
    ]);
    if (statsR.error) throw statsR.error;
    const s = statsR.data || {};
    const f = finR.data || [];
    const totalP = f.reduce((a, x) => a + Number(x.n), 0) || 0;
    const uninsured = Number(f.find(x => x.status === 'uninsured')?.n || 0);
    const pct = totalP ? Math.round((uninsured / totalP) * 100) : 0;
    const connected = s.connected_today || 0, totalCalls = s.total_calls_today || 0, due = s.pending_follow_ups || 0;
    const cards = [
      { label: 'Reached today', ico: 'handHeart', well: 'stone', num: connected,
        sub: totalCalls ? `of ${totalCalls} ${totalCalls === 1 ? 'call' : 'calls'} connected` : 'No calls logged yet today' },
      { label: 'Check-ins due', ico: 'clock', well: 'lav', num: due,
        sub: due ? 'Follow-ups and callbacks waiting' : "You're all caught up.", go: 'queue' },
      { label: 'People in our care', ico: 'users', well: 'beige', num: s.total_patients || 0, sub: 'On the registry today', go: 'patients' },
      { label: 'New this month', ico: 'trendingUp', well: 'stone', num: s.patients_this_month || 0, sub: 'Registered since the 1st' },
      { label: 'Uninsured: need financial aid', ico: 'shieldCheck', num: `${pct}%`, sub: `${uninsured} of ${totalP} people`, go: 'analytics', hot: true },
    ];
    if (el) {
      el.innerHTML = cards.map((c, i) => `
        <div class="kpi${c.hot ? ' is-hot' : ''}${c.go ? ' clickable' : ''}" ${c.go ? `data-go="${c.go}" tabindex="0" role="button"` : ''} data-i="${i}">
          <div class="kpi-top"><div class="kpi-label">${c.label}</div><span class="kpi-ico well-${c.well || 'hot'}">${icon(c.ico)}</span></div>
          <div class="kpi-num tnum">${c.num}</div>
          <div class="kpi-sub">${c.sub}</div>
        </div>`).join('');
      el.querySelectorAll('[data-go]').forEach(k => {
        const go = () => (k.dataset.go === 'queue' ? openTeamOn('queue') : navigate(k.dataset.go));
        k.addEventListener('click', go);
        k.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      });
    }
    return s;
  } catch (err) {
    console.warn('Dashboard stats error:', err);
    if (el) el.innerHTML = '';
    if (!String(err?.message || err).includes('Failed to fetch')) showToast('Could not load dashboard summary', 'error');
    return {};
  }
}

// ---- 2. The queue: counters, due today, calls with no one to make them -----
async function loadQueueSections({ onCoverAll = coverAllFn } = {}) {
  const sb = getSupabase();
  try {
    const [boardR, availR] = await Promise.all([sb.rpc('get_queue_board'), sb.rpc('get_team_availability')]);
    if (boardR.error) throw boardR.error;
    const rows = (boardR.data || []).filter(r => !isNutritionRow(r));
    // Without availability nobody counts as off, and the card below would show
    // a false all-clear on exactly the calls it exists to catch.
    const availFailed = !!availR.error;
    if (availFailed) console.error('Team availability error:', availR.error);
    const team = availR.data || [];
    const offToday = new Set(team.filter(m => m.available === false).map(m => m.caller_id));
    const nameOf = Object.fromEntries(team.map(m => [m.caller_id, m.full_name]));
    renderCounters(rows);

    // Calls that nobody can make today: due, unstarted, and either with no
    // owner or with a mentor who is marked off. The daily build rotates exactly
    // these (build_daily_assignments, ROTATION), which is why "Cover all" is
    // the build; one at a time is Move as a today-only cover.
    const uncovered = rows.filter(r => ['pending', 'callback'].includes(r.status) && isDueToday(r)
      && (!r.assigned_to || offToday.has(r.assigned_to)));
    const uncoveredIds = new Set(uncovered.map(r => r.queue_id));
    const open = rows.filter(r => OPEN.has(r.status) && isDueToday(r) && !uncoveredIds.has(r.queue_id))
      .sort((a, b) => (overdueDays(b) - overdueDays(a))
        || ((a.status === 'in_progress' ? 0 : 1) - (b.status === 'in_progress' ? 0 : 1))
        || ((b.conversations || 0) - (a.conversations || 0)));
    const reload = () => Promise.all([loadQueueSections({ onCoverAll }), loadKpis()]);
    renderDue(open, reload);
    if (availFailed) renderCoverUnknown();
    else renderCover(uncovered, nameOf, reload, onCoverAll);
  } catch (err) {
    console.error('Queue sections error:', err);
    const due = document.getElementById('dq-due');
    if (due) due.innerHTML = `<div class="empty" style="padding:var(--s6)"><p>Could not load today's queue.</p></div>`;
  }
}

function renderCounters(rows) {
  const el = document.getElementById('dq-counters');
  if (!el) return;
  const n = {
    total: rows.length,
    open: rows.filter(r => OPEN.has(r.status) && isDueToday(r)).length,
    calling: rows.filter(r => r.status === 'in_progress').length,
    done: rows.filter(r => r.status === 'completed').length,
  };
  el.innerHTML = [
    ['On today\'s list', n.total, 'Everyone queued for today, the same count as Team > Today\'s queue'],
    ['Still to reach', n.open, 'Due today and not done: pending, in progress or waiting on a callback'],
    // in_progress stays set until the call is logged or the next build, so
    // "being called now" overstated it
    ['In progress', n.calling, 'Opened in the calling portal and not logged yet'],
    ['Done today', n.done, 'Calls completed from today\'s list'],
  ].map(([l, v, t]) => `<div title="${t}"><div class="l">${l}</div><div class="n tnum">${v}</div></div>`).join('');
}

function renderDue(open, reload) {
  const el = document.getElementById('dq-due');
  if (!el) return;
  const shown = open.slice(0, 6);
  el.innerHTML = `
    <div class="card-head"><h3>Due today</h3><span class="badge badge-neutral">${open.length}</span></div>
    ${shown.length ? `<div class="due-list">${shown.map(r => {
      const name = r.full_name || r.patient_code || 'Patient';
      return `
      <div class="due-row dq-row" data-pid="${r.patient_id}">
        <span class="avatar avatar-sm" style="background:${avatarColor(name)}">${initials(name)}</span>
        <div class="grow" style="flex:1;min-width:0">
          <div class="due-name">${sanitize(name)}</div>
          <div class="dq-sub">${stageChip(r.conversations || 0)}<span class="due-meta">with ${sanitize(r.assigned_name || 'no one')}</span></div>
        </div>
        <div class="dq-side">
          <div class="dq-status">${statusCell(r)}</div>
          <button class="btn btn-ghost btn-sm dq-move" data-qid="${r.queue_id}" title="Move this call to someone else on the team">Move</button>
        </div>
      </div>`; }).join('')}</div>`
    : `<div class="empty" style="padding:var(--s6)"><div class="ico-wrap" style="background:var(--ok-soft);color:var(--ok)">${icon('checkCircle')}</div><h4>Nothing waiting</h4><p>Every call on today's list has been made, or the list is not built yet.</p></div>`}
    <div class="card-foot"><a id="dq-open-queue">Open today's queue ${icon('arrowRight')}</a></div>`;
  const byQ = Object.fromEntries(shown.map(r => [r.queue_id, r]));
  el.querySelectorAll('.dq-move').forEach(b => b.addEventListener('click', (e) => {
    e.stopPropagation();
    showMoveQueueModal(byQ[b.dataset.qid], { onMoved: reload });
  }));
  el.querySelectorAll('.dq-row').forEach(row => row.addEventListener('click', () => navigate('patients/' + row.dataset.pid)));
  document.getElementById('dq-open-queue')?.addEventListener('click', () => openTeamOn('queue'));
}

function renderCoverUnknown() {
  const el = document.getElementById('dq-cover');
  if (!el) return;
  el.innerHTML = `
    <section class="card card-flush">
      <div class="card-head"><h3>Calls with no one to make them</h3></div>
      <div class="empty" style="padding:var(--s5)"><p>Could not check who is off today, so these calls cannot be listed right now. Team &gt; Availability shows it, or refresh in a minute.</p></div>
    </section>`;
}

function renderCover(rows, nameOf, reload, onCoverAll) {
  const el = document.getElementById('dq-cover');
  if (!el) return;
  if (!rows.length) { el.innerHTML = ''; return; }
  const shown = rows.slice(0, 6);
  el.innerHTML = `
    <section class="card card-flush">
      <div class="card-head">
        <div><h3>Calls with no one to make them</h3><div class="due-meta wraps" style="margin-top:2px">Due today, with no caller or with a mentor who is off today</div></div>
        ${onCoverAll ? `<button class="btn btn-secondary btn-sm" id="dq-cover-all" title="Runs today's build, which hands these to mentors who are in">${icon('users')}Cover all ${rows.length}</button>` : ''}
      </div>
      <div class="due-list">${shown.map(r => {
        const name = r.full_name || r.patient_code || 'Patient';
        const why = r.assigned_to ? `${sanitize(nameOf[r.assigned_to] || r.assigned_name || 'Their mentor')} is off today` : 'No caller assigned';
        return `
        <div class="due-row dq-row" data-pid="${r.patient_id}">
          <span class="avatar avatar-sm" style="background:${avatarColor(name)}">${initials(name)}</span>
          <div class="grow" style="flex:1;min-width:0">
            <div class="due-name">${sanitize(name)}</div>
            <div class="dq-sub">${stageChip(r.conversations || 0)}<span class="due-meta">${why}</span></div>
          </div>
          <div class="dq-side">
            <div class="dq-status">${statusCell(r)}</div>
            <button class="btn btn-primary btn-sm dq-temp" data-qid="${r.queue_id}">${icon('plus')}Assign temporary caller</button>
          </div>
        </div>`; }).join('')}</div>
      ${rows.length > shown.length ? `<div class="card-foot"><a id="dq-cover-more">${rows.length - shown.length} more on Today's queue ${icon('arrowRight')}</a></div>` : ''}
    </section>`;
  const byQ = Object.fromEntries(shown.map(r => [r.queue_id, r]));
  el.querySelectorAll('.dq-temp').forEach(b => b.addEventListener('click', (e) => {
    e.stopPropagation();
    const row = byQ[b.dataset.qid];
    showMoveQueueModal(row, { onMoved: reload, handOver: false,
      title: `Assign a temporary caller for ${sanitize(row.full_name || row.patient_code || 'this call')}` });
  }));
  el.querySelectorAll('.dq-row').forEach(row => row.addEventListener('click', () => navigate('patients/' + row.dataset.pid)));
  document.getElementById('dq-cover-more')?.addEventListener('click', () => openTeamOn('queue'));
  document.getElementById('dq-cover-all')?.addEventListener('click', () => onCoverAll?.());
}

// ---- Urgent flags (open concerns, urgent then high) ------------------------
async function loadUrgentFlags() {
  const sb = getSupabase();
  const el = document.getElementById('dq-urgent');
  if (!el) return;
  try {
    const [listR, urgentR] = await Promise.all([
      sb.from('patient_concerns')
        .select('id, severity, reason, created_at, patient_id, patients(full_name, patient_code)', { count: 'exact' })
        .in('status', ['open', 'acknowledged']).in('severity', ['urgent', 'high'])
        // care gaps (sql/151) are the team's misses, not a clinical flag: they
        // have their own card below. reason is NOT NULL, so not-like drops none.
        .not('reason', 'like', 'care_gap_%')
        // 'urgent' sorts after 'high', so descending puts urgent first
        .order('severity', { ascending: false }).order('created_at', { ascending: false }).limit(5),
      sb.from('patient_concerns').select('id', { count: 'exact', head: true })
        .in('status', ['open', 'acknowledged']).eq('severity', 'urgent')
        .not('reason', 'like', 'care_gap_%'),
    ]);
    if (listR.error) throw listR.error;
    const rows = listR.data || [];
    const urgentN = urgentR.count || 0;
    el.innerHTML = `
      <div class="card-head"><h3 class="is-urgent">Urgent flags</h3>${urgentN ? `<span class="badge badge-solid-danger">${urgentN} urgent</span>` : `<span class="badge badge-neutral">${listR.count || 0} high</span>`}</div>
      ${rows.length ? `<div class="due-list">${rows.map(r => {
        const name = r.patients?.full_name || r.patients?.patient_code || 'Patient';
        const urgent = r.severity === 'urgent';
        return `
        <div class="due-row dq-row" data-pid="${r.patient_id}">
          <span class="avatar avatar-sm" style="background:${urgent ? 'var(--av-1)' : 'var(--av-2)'}">${initials(name)}</span>
          <div class="grow" style="flex:1;min-width:0">
            <div class="due-name">${sanitize(name)}</div>
            <div class="due-meta">${sanitize(concernReason(r.reason).label)} · ${formatRelativeTime(r.created_at)}</div>
          </div>
          <span class="badge ${urgent ? 'badge-danger' : 'badge-beige'}">${urgent ? 'Urgent' : 'High'}</span>
        </div>`; }).join('')}</div>`
      : `<div class="empty" style="padding:var(--s6)"><div class="ico-wrap" style="background:var(--ok-soft);color:var(--ok)">${icon('checkCircle')}</div><h4>No urgent flags</h4><p>Nothing raised as urgent or high is waiting.</p></div>`}
      <div class="card-foot"><a id="dq-open-flags">Open flags &amp; concerns ${icon('arrowRight')}</a></div>`;
    el.querySelectorAll('.dq-row').forEach(row => row.addEventListener('click', () => navigate('patients/' + row.dataset.pid)));
    document.getElementById('dq-open-flags')?.addEventListener('click', () => navigate('concerns'));
  } catch (err) {
    console.error('Urgent flags error:', err);
    el.innerHTML = `<div class="empty" style="padding:var(--s6)"><p>Could not load flags.</p></div>`;
  }
}

// ---- Care gaps (sql/151): families the team has not reached ---------------
// The database raises and closes these itself (a daily sweep, plus a logged
// call or a scheduled session closing its own gap at once); this card only
// reads the summary. It says nothing when nothing is open, and also when the
// function is not there yet, so this build could ship before sql/151.
const GAP_KINDS = [
  ['never_reached', 'Never reached'],
  ['followup_overdue', 'Follow-up overdue'],
  ['flag_unattended', 'Flag, no call since'],
  ['session_stalled', 'Session stalled'],
];
function gapBreakdown(h) {
  return GAP_KINDS.filter(([k]) => Number(h[k] || 0) > 0)
    .map(([k, label]) => `${Number(h[k])} ${label.toLowerCase()}`).join(' · ');
}
async function loadCareGaps() {
  const el = document.getElementById('care-gap-card');
  if (!el) return;
  try {
    const { data, error } = await getSupabase().rpc('get_care_gap_summary');
    if (error) throw error;
    const families = Number(data?.families || 0);
    if (!families) { el.innerHTML = ''; return; }
    const open = data.open || {};
    const holders = (data.by_holder || []).slice(0, 5);
    el.innerHTML = `
      <section class="card card-flush cg-card">
        <div class="card-head"><h3>Families the team has not reached</h3><span class="badge badge-warn">${families}</span></div>
        <div class="cg-counts">${GAP_KINDS.map(([k, label]) => `
          <div class="cg-count${Number(open[k] || 0) ? '' : ' zero'}"><div class="n">${Number(open[k] || 0)}</div><div class="l">${label}</div></div>`).join('')}</div>
        ${holders.length ? `<div class="due-list">${holders.map(h => {
          const who = h.holder_id ? (h.holder || 'Someone') : 'Not held by anyone';
          return `
          <div class="due-row">
            <span class="avatar avatar-sm" style="background:${avatarColor(who)}">${initials(who)}</span>
            <div style="flex:1;min-width:0">
              <div class="due-name">${sanitize(who)}</div>
              <div class="due-meta wraps">${gapBreakdown(h)}</div>
            </div>
            <span class="badge badge-neutral">${Number(h.total || 0)}</span>
          </div>`; }).join('')}</div>` : ''}
        <div class="card-foot"><a id="cg-open">Open flags &amp; concerns ${icon('arrowRight')}</a></div>
      </section>`;
    document.getElementById('cg-open')?.addEventListener('click', () => navigate('concerns'));
  } catch (err) {
    console.warn('Care gaps not shown:', err?.message || err);
    el.innerHTML = '';
  }
}

// ---- Back from leave: Restore all ------------------------------------------
async function loadRestores() {
  const sb = getSupabase();
  const el = document.getElementById('dq-restore');
  if (!el) return;
  try {
    const { data, error } = await sb.rpc('get_pending_restores');
    if (error) throw error;
    const rows = data || [];
    if (!rows.length) { el.innerHTML = ''; return; }
    el.innerHTML = `
      <section class="card card-flush">
        <div class="card-head"><h3>Back from leave (${rows.length})</h3></div>
        <div class="rs-list">${rows.map(r => `
          <div class="rs-item">
            <div class="rs-top">
              <span class="avatar avatar-sm" style="background:${avatarColor(r.full_name)}">${initials(r.full_name)}</span>
              <div class="rs-name">${sanitize(r.full_name)}</div>
              <button class="btn btn-primary btn-sm" data-restore="${r.user_id}" data-name="${sanitize(r.full_name)}" data-n="${r.n}">Restore all</button>
            </div>
            <details class="rs-more" data-user="${r.user_id}">
              <summary>${r.n} ${r.n === 1 ? 'patient' : 'patients'} currently covered by others</summary>
              <div class="rs-pats"><div class="due-meta">Loading…</div></div>
            </details>
          </div>`).join('')}</div>
      </section>`;
    // dataset values come back DECODED, so the name is escaped again at every
    // place it is written as HTML (anyone can set their own name)
    el.querySelectorAll('[data-restore]').forEach(btn => btn.addEventListener('click', () => {
      const name = sanitize(btn.dataset.name);
      const n = Number(btn.dataset.n) || 0;
      confirmModal(`Give <strong>${name}</strong> back the ${n} ${n === 1 ? 'family' : 'families'} that are theirs (they reached or were first given them) and that someone else holds right now? That includes any moved on purpose, so open the list first if you are not sure.`, async () => {
        if (btn.disabled) return;
        btn.disabled = true;
        try {
          const { data: done, error: e } = await sb.rpc('restore_owned_patients', { p_user_id: btn.dataset.restore });
          if (e) throw e;
          showToast(`Restored ${Number(done) || 0} families to ${name}`, 'success');
          await Promise.all([loadRestores(), loadQueueSections()]);
        } catch (e) { showToast(sanitize(e.message), 'error'); btn.disabled = false; }
      }, { title: 'Restore their families', confirmLabel: 'Restore all', danger: false });
    }));
    el.querySelectorAll('details.rs-more').forEach(d => d.addEventListener('toggle', () => {
      if (d.open && !d.dataset.loaded) { d.dataset.loaded = '1'; loadCoveredPatients(d); }
    }));
  } catch (err) { console.error('Restores error:', err); el.innerHTML = ''; }
}

// The same rule as get_pending_restores: theirs by first contact (else by the
// original owner), active, and sitting with someone else right now.
async function loadCoveredPatients(details) {
  const uid = details.dataset.user;
  const box = details.querySelector('.rs-pats');
  try {
    const { data, error } = await getSupabase().from('patients')
      .select('id, full_name, patient_code, assigned_to, original_assigned_to, first_contacted_by, patient_status')
      .or(`original_assigned_to.eq.${uid},first_contacted_by.eq.${uid}`)
      .eq('is_active', true).limit(200);
    if (error) throw error;
    const mine = (data || []).filter(p => (p.first_contacted_by || p.original_assigned_to) === uid
      && p.assigned_to !== uid && !['deceased', 'inactive'].includes(p.patient_status));
    box.innerHTML = mine.length ? `${mine.slice(0, 8).map(p => `
      <div class="rs-pat" data-pid="${p.id}"><div><div class="due-name">${sanitize(p.full_name || 'Patient')}</div><div class="due-meta">${sanitize(p.patient_code || '')}</div></div>${icon('chevronRight')}</div>`).join('')}
      ${mine.length > 8 ? `<div class="due-meta" style="padding:6px 2px">+ ${mine.length - 8} more</div>` : ''}`
      : '<div class="due-meta">None left to restore.</div>';
    box.querySelectorAll('[data-pid]').forEach(r => r.addEventListener('click', () => navigate('patients/' + r.dataset.pid)));
  } catch (err) { box.innerHTML = `<div class="due-meta">Could not load the list: ${sanitize(err.message)}</div>`; }
}

// ---- Recent conversations: what was said, not just the outcome -------------
// Tinted chips, the mockups' colours: green "Connected", blue "Highly
// receptive". (They were black outline boxes, the heaviest thing on the card.)
const OUTCOME_CHIP = {
  connected: ['chip-ok', 'Connected', null], no_answer: ['chip-danger', 'No answer', 'phoneOff'],
  busy: ['chip-warn', 'Busy', null], callback_requested: ['chip-beige', 'Callback', 'phone'],
  voicemail: ['', 'Voicemail', null], wrong_number: ['chip-danger', 'Wrong number', null],
};
const RECEPTIVENESS = {
  highly_receptive: ['chip-info', 'Highly receptive'], neutral: ['', 'Neutral'], skeptical: ['chip-warn', 'Skeptical'],
  agitated: ['chip-warn', 'Agitated'], overwhelmed: ['chip-warn', 'Overwhelmed'],
};
async function loadConversations() {
  const sb = getSupabase();
  const el = document.getElementById('dq-convos');
  if (!el) return;
  try {
    const { data, error } = await sb.from('call_logs')
      .select('id, patient_id, call_date, dial_status, call_duration_mins, receptiveness_bucket, caller_notes, next_followup_date, contacted_by_name, patients(full_name, patient_code)')
      .order('call_date', { ascending: false }).limit(5);
    if (error) throw error;
    const rows = data || [];
    el.innerHTML = `
      <div class="card-head"><h3>Recent conversations</h3><span class="badge badge-neutral">Latest</span></div>
      ${rows.length ? `<div class="convo-list">${rows.map(c => {
        const name = c.patients?.full_name || c.patients?.patient_code || 'Patient';
        const [cls, label, ico] = OUTCOME_CHIP[c.dial_status] || ['', c.dial_status || 'Call', null];
        const rc = c.dial_status === 'connected' ? RECEPTIVENESS[c.receptiveness_bucket] : null;
        const recep = rc ? `<span class="chip ${rc[0]}">${rc[1]}</span>` : '';
        const next = c.next_followup_date ? `<span class="due-meta">· next check-in ${formatDate(c.next_followup_date)}</span>` : '';
        const dur = c.call_duration_mins ? ` · ${Math.round(c.call_duration_mins)} min` : '';
        return `
        <div class="convo" data-pid="${c.patient_id || ''}">
          <span class="avatar avatar-sm" style="background:${avatarColor(name)}">${initials(name)}</span>
          <div class="convo-main">
            <div class="convo-top"><span class="due-name">${sanitize(name)}</span><span class="convo-when">${formatRelativeTime(c.call_date)}${dur}</span></div>
            <div class="convo-chips"><span class="chip ${cls}">${ico ? icon(ico) : ''}${label}</span>${recep}${next}</div>
            ${c.caller_notes ? `<p class="convo-note">${sanitize(c.caller_notes)}</p>` : ''}
            ${c.contacted_by_name ? `<div class="due-meta">by ${sanitize(c.contacted_by_name)}</div>` : ''}
          </div>
        </div>`; }).join('')}</div>`
      : `<div class="empty"><div class="ico-wrap">${icon('phoneCall')}</div><h4>No conversations yet</h4><p>Once calls are logged, they appear here.</p></div>`}
      <div class="card-foot"><a id="dq-open-calls">Open call logs ${icon('arrowRight')}</a></div>`;
    el.querySelectorAll('.convo[data-pid]').forEach(r => r.addEventListener('click', () => { if (r.dataset.pid) navigate('patients/' + r.dataset.pid); }));
    document.getElementById('dq-open-calls')?.addEventListener('click', () => navigate('calls'));
  } catch (err) {
    console.error('Recent conversations error:', err);
    el.innerHTML = `<div class="empty" style="padding:var(--s6)"><p>Could not load conversations.</p></div>`;
  }
}

// ---- 4. How we're doing: the pastel wall -----------------------------------
async function loadWall(s = {}) {
  const sb = getSupabase();
  const el = document.getElementById('dq-tiles');
  if (!el) return;
  try {
    const [reachR, pipeR, reqsR, mixR, covR, deltaR] = await Promise.all([
      sb.rpc('get_insight_reach'), sb.rpc('get_insight_pipeline'),
      // one ask per call per category across the ticked list and the typed
      // note (sql/62); the old keyword sweep counted every ticked call twice
      sb.rpc('get_requirements_by_cancer', { p_gi_subtype: 'all', p_metric: 'mentions' }),
      sb.rpc('get_status_mix'), sb.rpc('get_support_coverage'), sb.rpc('get_impact_deltas'),
    ]);
    const r = reachR.data || {}, p = pipeR.data || {};
    const rq = reqsR.data?.rows || [];
    const mix = mixR.data || [], cov = covR.data || [], deltas = deltaR.data || [];
    const n = (k) => Number(mix.find(m => m.status === k)?.n || 0);
    const connectPct = r.total ? Math.round((r.connected / r.total) * 100) : 0;
    const supports = cov.reduce((a, c) => a + Number(c.n), 0);
    const aid = cov.reduce((a, c) => a + Number(c.total_amount || 0), 0);
    const sessions = cov.reduce((a, c) => a + Number(c.total_sessions || 0), 0);
    const reassessed = deltas.reduce((a, d) => a + Number(d.with_followup || 0), 0);
    const tiles = [
      { t: 'mint', wide: true, label: 'Calls connected', big: `${connectPct}%`, sub: `${r.connected || 0} of ${r.total || 0} · ${r.avg_duration || 0} min avg` },
      { t: 'pink', label: 'Time with families', big: talkTime(r.talk_mins), sub: `${r.avg_connected_duration || 0} min per connected call` },
      { t: 'blue', label: 'Consent on record', big: `${s.consent_rate || 0}%`, sub: 'of people in our care' },
      { t: 'cyan', label: 'Actively supported', big: n('active'), sub: `${n('new_lead')} new leads · ${n('inactive')} inactive · ${n('deceased')} remembered` },
      { t: 'lime', label: 'New leads waiting', big: p.never_called || 0, sub: `${p.unassigned || 0} unassigned · ${p.engaged || 0} engaged` },
      { t: 'rose', wide: true, label: 'Most asked for', big: rq[0]?.label || 'N/A', sub: rq[0] ? `${rq[0].n} asks from ${rq[0].patients} families` : 'Start capturing asks on calls', text: true },
      { t: 'peach', label: 'Avg. engagement (of 10)', big: s.avg_conversion_score || 0, sub: 'Across logged conversations' },
      { t: 'amber', label: 'Support levers delivered', big: supports, sub: supports ? `${cov.length} kinds of help` : 'Flip levers on patient pages' },
      aid
        ? { t: 'cream', label: 'Financial aid availed', big: `₹${Math.round(aid).toLocaleString('en-IN')}`, sub: `${sessions} care sessions on top` }
        : { t: 'cream', label: 'Care sessions held', big: sessions, sub: 'nutrition + well-being' },
      { t: 'lav', label: 'Wellbeing re-assessed', big: reassessed, sub: reassessed ? 'baseline → follow-up tracked' : 'Add baseline scores to begin' },
    ];
    el.innerHTML = tiles.map(x => `
      <div class="tile tile-${x.t}${x.wide ? ' wide' : ''}">
        <div class="tile-label">${x.label}</div>
        <div class="tile-big${x.text ? ' is-text' : ''} tnum">${sanitize(String(x.big))}</div>
        <div class="tile-sub">${sanitize(String(x.sub))}</div>
      </div>`).join('');
  } catch (err) { console.error('Wall error:', err); el.innerHTML = ''; }
}

async function loadCallsChart() {
  const card = document.getElementById('dq-chart');
  try {
    const { data, error } = await getSupabase().rpc('get_analytics_calls_timeline', { days_back: 30, p_filters: {} });
    if (error) throw error;
    const rows = data || [];
    const canvas = document.getElementById('dq-calls-chart');
    if (!rows.length || !canvas || !window.Chart) { if (card) card.style.display = 'none'; return; }
    const ctx = canvas.getContext('2d');
    createChart('dq-calls-chart', 'line', {
      labels: rows.map(d => new Date(d.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })),
      datasets: [
        { label: 'Total', data: rows.map(d => d.total_calls), borderColor: CHART_COLORS.primary,
          backgroundColor: createGradient(ctx, CHART_COLORS.primary, 240), fill: true, tension: 0.4, pointRadius: 0, pointHoverRadius: 5, borderWidth: 2.5 },
        { label: 'Connected', data: rows.map(d => d.connected_calls), borderColor: CHART_COLORS.success,
          backgroundColor: createGradient(ctx, CHART_COLORS.success, 240), fill: true, tension: 0.4, pointRadius: 0, pointHoverRadius: 5, borderWidth: 2.5 },
      ],
    }, {
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      interaction: { mode: 'index', intersect: false },
      scales: { x: { ticks: { maxTicksLimit: 8 } } },
    });
  } catch (err) { console.error('Calls chart error:', err); if (card) card.style.display = 'none'; }
}
