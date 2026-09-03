// ============================================================
// Patient Navigator: Dashboard (warm "here's today" landing)
// Care-oriented. v2: assignment ops, availability, live insights.
// ============================================================

import { getSupabase } from '../supabase.js';
import { getCurrentProfile, isManagerOrAdmin, getUserRole } from '../auth.js';
import { formatRelativeTime, capitalize } from '../utils/formatters.js';
import { measureLabel } from '../utils/catalog.js';
import { showToast } from '../components/toast.js';
import { navigate } from '../router.js';
import { icon } from '../components/icons.js';
import { openSessionForm, suggestNextSession } from '../components/sessionForm.js';
import { sanitize } from '../utils/validators.js';
import { AVATAR_COLORS, avatarColor, initials } from '../utils/avatar.js';

const RESOURCE_REPLIES_URL = 'https://uhesnagqbmuyqiuzfhcv.supabase.co/functions/v1/resource-replies';
const INTAKE_ROLES = ['ground_poc', 'uploader'];
function greetingWord() { const h = new Date().getHours(); return h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening'; }

const OUTCOME = {
  connected: { label: 'Connected', tone: 'ok' }, no_answer: { label: 'No answer', tone: 'warn' },
  busy: { label: 'Busy', tone: 'warn' }, callback_requested: { label: 'Callback', tone: 'info' },
  voicemail: { label: 'Voicemail', tone: 'neutral' }, wrong_number: { label: 'Wrong number', tone: 'danger' },
};
function outcomeBadge(s) { const o = OUTCOME[s] || { label: capitalize(s || 'N/A'), tone: 'neutral' }; return `<span class="badge badge-${o.tone}"><span class="dot"></span>${o.label}</span>`; }
function scoreBar(score) { const s = Number(score) || 0; if (!s) return '<span style="color:var(--ink-3)">Not scored</span>'; return `<span class="scorebar"><span class="track"><span class="fill" style="width:${Math.min(s, 10) * 10}%"></span></span><span class="num">${s}</span></span>`; }

export async function renderDashboard(container) {
  const profile = getCurrentProfile();
  const isAdmin = isManagerOrAdmin();
  const role = getUserRole();
  const isIntake = INTAKE_ROLES.includes(role);
  const isSpecialist = ['nutritionist', 'therapist'].includes(role);
  const isContent = role === 'content';
  const isCaller = ['caller', 'caregiver_mentor'].includes(role);
  const firstName = profile?.full_name?.split(' ')[0] || 'there';
  const today = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const subtitle = isAdmin
    ? "Here's how the team and the people in our care are doing today."
    : isIntake
      ? "Add the numbers gathered on the ground. Your uploads stay visible here until managers allot them."
      : isSpecialist
        ? "The people in your care and how they're doing. Record well-being whenever it fits the conversation."
        : isContent
          ? "An overview of the people in our care and the work going on."
          : 'A few people are waiting to hear from you today. No rush: one good conversation at a time.';

  container.innerHTML = `
    <div class="dash">
      <div class="greet">
        <div>
          <h1>Good ${greetingWord()}, <span class="serif">${firstName}</span></h1>
          <p>${subtitle}</p>
        </div>
        <div class="date">${today}</div>
      </div>

      ${isCaller ? `<div id="caller-avail"></div>` : ''}

      <div class="quick">
        ${isAdmin ? `
        <a class="qa" id="qa-build"><span class="qa-ico teal">${icon('refresh')}</span><div><div class="qa-title">Build today's list</div><div class="qa-sub">Assign calls to the team</div></div></a>
        <a class="qa" id="qa-leads"><span class="qa-ico coral">${icon('userPlus')}</span><div><div class="qa-title">Add new leads</div><div class="qa-sub">Bulk-add today's numbers</div></div></a>
        <a class="qa" id="qa-analytics"><span class="qa-ico blue">${icon('chart')}</span><div><div class="qa-title">See how we're doing</div><div class="qa-sub">Open analytics</div></div></a>
        ` : isIntake ? `
        <a class="qa" id="qa-upload"><span class="qa-ico coral">${icon('upload')}</span><div><div class="qa-title">Upload numbers</div><div class="qa-sub">Paste a list or add one lead</div></div></a>
        <a class="qa" id="qa-patients"><span class="qa-ico blue">${icon('users')}</span><div><div class="qa-title">My uploaded leads</div><div class="qa-sub">Review what you added</div></div></a>
        <a class="qa" id="qa-profile"><span class="qa-ico teal">${icon('user')}</span><div><div class="qa-title">Profile</div><div class="qa-sub">Password and account settings</div></div></a>
        ` : isSpecialist ? `
        <a class="qa" id="qa-patients"><span class="qa-ico teal">${icon('users')}</span><div><div class="qa-title">People in your care</div><div class="qa-sub">Your nutrition / therapy patients</div></div></a>
        <a class="qa" id="qa-callhist"><span class="qa-ico blue">${icon('phone')}</span><div><div class="qa-title">Conversations</div><div class="qa-sub">Calls with your patients</div></div></a>
        <a class="qa" id="qa-resources"><span class="qa-ico coral">${icon('handHeart')}</span><div><div class="qa-title">Money &amp; stay help</div><div class="qa-sub">Funds and places to stay, by state</div></div></a>
        <a class="qa" id="qa-learn"><span class="qa-ico coral">${icon('book')}</span><div><div class="qa-title">Learning Hub</div><div class="qa-sub">Playbooks &amp; instruments</div></div></a>
        ` : `
        <a class="qa" id="qa-call"><span class="qa-ico coral">${icon('phoneCall')}</span><div><div class="qa-title">Start calling</div><div class="qa-sub">Open your worklist</div></div></a>
        <a class="qa" id="qa-learn"><span class="qa-ico teal">${icon('book')}</span><div><div class="qa-title">Learning Hub</div><div class="qa-sub">Playbooks &amp; instruments</div></div></a>
        <a class="qa" id="qa-patients"><span class="qa-ico blue">${icon('users')}</span><div><div class="qa-title">People in your care</div><div class="qa-sub">Browse and search</div></div></a>
        <a class="qa" id="qa-resources"><span class="qa-ico coral">${icon('handHeart')}</span><div><div class="qa-title">Money &amp; stay help</div><div class="qa-sub">Funds and places to stay, by state</div></div></a>`}
      </div>

      <div id="saturday-card"></div>
      <div id="resource-replies"></div>

      <div class="hero-metrics" id="hero-metrics">
        <div class="hero-card teal"><span class="hc-ico">${icon('handHeart')}</span><div class="hc-label">Reached today</div><div class="hc-num">…</div><div class="hc-sub">Loading…</div></div>
        <div class="hero-card paper"><span class="hc-ico">${icon('clock')}</span><div class="hc-label">Check-ins due</div><div class="hc-num">…</div><div class="hc-sub">Loading…</div></div>
      </div>

      <div class="stats" id="stats">${Array(isAdmin ? 4 : 3).fill('<div class="stat"><span class="stat-ico"></span><div><div class="stat-num"><span class="sk" style="display:inline-block;width:36px;height:22px"></span></div><div class="stat-lbl">Loading…</div></div></div>').join('')}</div>

      ${isAdmin ? `<div id="insights"></div>` : ''}

      <div class="dash-grid">
        <div class="card card-flush">
          <div class="card-head"><h3>${isSpecialist ? 'Recent check-ins' : 'Recent conversations'}</h3><span class="badge badge-neutral">Latest</span></div>
          <div id="recent-calls"><div style="padding:var(--s5)">${Array(4).fill('<div class="sk skeleton-row"></div>').join('')}</div></div>
          <div class="card-foot"><a id="view-all-calls">${isSpecialist ? 'Open 1:1 sessions' : 'View all conversations'} ${icon('arrowRight')}</a></div>
        </div>
        <div class="side-col">
          <div class="card card-flush">
            <div class="card-head"><h3>${isSpecialist ? 'Your people' : (isIntake ? 'My uploaded leads' : (isAdmin ? 'Due today' : 'Your list today'))}</h3><span class="badge badge-neutral" id="due-count">…</span></div>
            <div id="due-today"><div style="padding:var(--s4)">${Array(3).fill('<div class="sk skeleton-row"></div>').join('')}</div></div>
            <div class="card-foot"><a id="open-portal">${isSpecialist ? 'Open the full worklist' : (isIntake ? 'Open upload' : (isAdmin ? 'Open calling portal' : 'Start calling'))} ${icon('arrowRight')}</a></div>
          </div>
          ${isAdmin ? `
          <div class="card card-flush">
            <div class="card-head"><h3>Today's intake</h3><span style="width:20px;height:20px;color:var(--ink-3)">${icon('inbox')}</span></div>
            <div class="intake">
              <p style="font-size:13.5px;color:var(--ink-2)">New people added in the last 24 hours, waiting for assignment.</p>
              <div class="intake-nums" id="intake-nums">
                <div class="intake-num"><div class="n">…</div><div class="l">Added today</div></div>
                <div class="intake-num warn"><div class="n">…</div><div class="l">Not yet assigned</div></div>
              </div>
              <button class="btn btn-primary btn-block" id="distribute-btn">${icon('users')}Build today's assignments</button>
            </div>
          </div>` : ''}
        </div>
      </div>
    </div>`;

  // quick actions
  document.getElementById('qa-build')?.addEventListener('click', buildAssignments);
  document.getElementById('qa-leads')?.addEventListener('click', () => navigate('upload'));
  document.getElementById('qa-analytics')?.addEventListener('click', () => navigate('analytics'));
  document.getElementById('qa-upload')?.addEventListener('click', () => navigate('upload'));
  document.getElementById('qa-call')?.addEventListener('click', () => navigate('calling'));
  document.getElementById('qa-learn')?.addEventListener('click', () => navigate('learn'));
  document.getElementById('qa-patients')?.addEventListener('click', () => navigate(role === 'nutritionist' ? 'nutrition' : 'patients'));
  document.getElementById('qa-profile')?.addEventListener('click', () => navigate('profile'));
  document.getElementById('view-all-calls')?.addEventListener('click', () => navigate(isSpecialist ? 'sessions' : 'calls'));
  document.getElementById('qa-callhist')?.addEventListener('click', () => navigate('calls'));
  // Straight onto the financial + accommodation shelf, which is the pair the
  // field team asked to have "in the dashboard itself for easy and quick
  // access" (2026-09-03). resources.js reads the route param.
  document.getElementById('qa-resources')?.addEventListener('click', () => navigate('resources/money_stay'));
  document.getElementById('open-portal')?.addEventListener('click', () => navigate(isSpecialist ? (role === 'nutritionist' ? 'nutrition' : 'sessions') : (isIntake ? 'upload' : 'calling')));
  document.getElementById('distribute-btn')?.addEventListener('click', buildAssignments);

  const tasks = [loadStats(),
    isSpecialist ? loadRecentCheckins() : loadRecentCalls(),
    isSpecialist ? loadSpecialistPeople(role) : loadDueToday(isIntake),
    loadSaturdayCard(role), loadResourceReplies()];
  if (isAdmin) { tasks.push(loadIntakeSummary(), loadInsights()); }
  else if (isCaller) tasks.push(loadCallerAvailability());
  await Promise.all(tasks);
}

// Next Saturday circle: visible to everyone (callers invite patients on
// their calls); loggable by the teams who run them.
async function loadSaturdayCard(role) {
  const el = document.getElementById('saturday-card');
  if (!el) return;
  try {
    const next = await suggestNextSession();
    const canLog = ['admin', 'manager', 'therapist', 'nutritionist'].includes(role);
    const nice = next.date.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' });
    const lastLine = next.last
      ? `Last circle: ${next.last.session_type === 'nutrition' ? 'nutrition' : 'well-being'} on ${new Date(next.last.session_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}.`
      : 'No circles logged yet.';
    el.innerHTML = `
      <div class="card" style="display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;padding:16px 20px">
        <div style="display:flex;align-items:center;gap:12px">
          <span class="stat-ico ${next.type === 'nutrition' ? 'ok' : 'violet'}">${icon(next.type === 'nutrition' ? 'leaf' : 'heart')}</span>
          <div><div class="info-value">Next circle: <strong>${next.type === 'nutrition' ? 'Nutrition' : 'Well-being'}</strong> · ${nice}</div>
            <div class="due-meta">${lastLine} Invite your patients on this week's calls.</div></div>
        </div>
        ${canLog ? `<button class="btn btn-secondary btn-sm" id="sat-log-btn">${icon('plus')}Log a session</button>` : ''}
      </div>`;
    document.getElementById('sat-log-btn')?.addEventListener('click', () =>
      openSessionForm({ defaults: { type: next.type }, onSaved: () => loadSaturdayCard(role) }));
  } catch { el.innerHTML = ''; }
}

// Patients who replied on WhatsApp to resources this mentor sent. The POC sees
// their messages and can follow up. Reply text is sanitized (patient-typed).
// Self-hides when there are no replies. Tap a row to expand the conversation.
async function loadResourceReplies() {
  const el = document.getElementById('resource-replies');
  if (!el) return;
  const me = getCurrentProfile();
  if (!me?.id) { el.innerHTML = ''; return; }
  try {
    const { data: sess } = await getSupabase().auth.getSession();
    const token = sess?.session?.access_token;
    if (!token) { el.innerHTML = ''; return; }
    const res = await fetch(RESOURCE_REPLIES_URL, {
      method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ mentorId: me.id }),
    });
    const body = await res.json().catch(() => ({}));
    const threads = (body.threads || []).filter(t => (t.messages || []).some(m => m.dir === 'in'));
    if (!threads.length) { el.innerHTML = ''; return; }
    el.innerHTML = `
      <div class="card card-flush">
        <div class="card-head"><h3>Replies to resources you sent</h3><span class="badge badge-primary">${threads.length}</span></div>
        <div class="due-list">${threads.slice(0, 8).map((t, i) => resourceThread(t, i)).join('')}</div>
      </div>`;
    el.querySelectorAll('[data-thr]').forEach(row => row.addEventListener('click', () => {
      const m = document.getElementById('thr-msgs-' + row.dataset.thr);
      if (m) m.style.display = m.style.display === 'none' ? '' : 'none';
    }));
  } catch (e) { console.warn('Resource replies error:', e); el.innerHTML = ''; }
}

function resourceThread(t, i) {
  const name = t.patient_name || t.phone || 'Patient';
  const msgs = t.messages || [];
  const lastIn = [...msgs].reverse().find(m => m.dir === 'in');
  const snippet = lastIn ? lastIn.text : '';
  return `
    <div>
      <div class="due-row clickable" data-thr="${i}" style="cursor:pointer">
        <span class="avatar avatar-sm" style="background:${avatarColor(name)}">${initials(name)}</span>
        <div class="grow" style="flex:1;min-width:0"><div class="due-name">${sanitize(name)}</div><div class="due-meta cell-clamp">“${sanitize(snippet)}”</div></div>
        <span class="badge badge-neutral">${formatRelativeTime(t.last_reply_at)}</span>
      </div>
      <div id="thr-msgs-${i}" style="display:none;padding:6px 16px 12px;background:var(--surface-2)">
        ${msgs.map(m => `<div style="display:flex;justify-content:${m.dir === 'in' ? 'flex-start' : 'flex-end'};margin:3px 0">
          <div style="max-width:78%;padding:7px 11px;border-radius:12px;font-size:13px;line-height:1.4;background:${m.dir === 'in' ? 'var(--surface-3)' : 'var(--primary-soft)'};color:var(--ink)">${sanitize(m.text)}<div style="font-size:12px;color:var(--ink-3);margin-top:3px">${formatRelativeTime(m.at)}</div></div>
        </div>`).join('')}
      </div>
    </div>`;
}

async function loadCallerAvailability() {
  const sb = getSupabase();
  const me = getCurrentProfile();
  const el = document.getElementById('caller-avail');
  if (!el || !me?.id) return;
  let available = true, summary = { pending: 0, follow_ups: 0, new_leads: 0, done_today: 0 };
  try { const { data } = await sb.from('caller_availability').select('available').eq('caller_id', me.id).eq('day', new Date().toISOString().slice(0, 10)).maybeSingle(); available = data ? data.available : true; } catch {}
  try { const { data } = await sb.rpc('get_worklist_summary', { p_caller_id: me.id }); if (data) summary = data; } catch {}
  el.innerHTML = `
    <div class="card" style="display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;padding:16px 20px">
      <div id="avail-open" style="display:flex;align-items:center;gap:12px;cursor:pointer" title="Open your worklist">
        <span class="stat-ico ${available ? 'ok' : 'warn'}">${icon(available ? 'checkCircle' : 'clock')}</span>
        <div><div class="info-value">${available ? "You're on for calls today" : "You're marked off today"}</div>
          <div class="due-meta">${summary.pending} to reach · ${summary.follow_ups} follow-ups · ${summary.new_leads} new · ${summary.done_today} done ${icon('arrowRight')}</div></div>
      </div>
      <button class="btn ${available ? 'btn-secondary' : 'btn-primary'} btn-sm" id="dash-avail">${available ? 'Mark me off today' : "I'm calling today"}</button>
    </div>`;
  document.getElementById('avail-open')?.addEventListener('click', () => navigate('calling'));
  document.getElementById('dash-avail')?.addEventListener('click', async () => {
    try { await sb.rpc('mark_availability', { p_available: !available });
      showToast(!available ? "You're on for calls today" : "Marked off. Your patients will be covered", !available ? 'success' : 'info');
      loadCallerAvailability();
    } catch (e) { showToast(e.message, 'error'); }
  });
}

async function buildAssignments() {
  const sb = getSupabase();
  const btns = [document.getElementById('distribute-btn'), document.getElementById('qa-build')].filter(Boolean);
  btns.forEach(b => { b.dataset.html = b.innerHTML; b.style.pointerEvents = 'none'; });
  const main = document.getElementById('distribute-btn');
  if (main) { main.disabled = true; main.innerHTML = '<span class="spinner" style="width:18px;height:18px;border-width:2px"></span>Building…'; }
  try {
    await sb.rpc('distribute_new_patients'); // give every unowned, callable lead an owner first
    const { data, error } = await sb.rpc('build_daily_assignments');
    if (error) throw error;
    if (data?.error) { showToast('Could not build: ' + data.error, 'warning'); }
    else showToast(`Today's list ready: ${data.follow_ups} follow-ups + ${data.new_leads} new across ${data.available_callers} caregiver mentors${data.covered ? ` (${data.covered} covered)` : ''}`, 'success');
    await Promise.all([loadStats(true), loadDueToday(), loadIntakeSummary()]);
  } catch (err) { showToast('Could not build assignments: ' + err.message, 'error'); }
  finally { if (main) { main.disabled = false; main.innerHTML = `${icon('users')}Build today's assignments`; } btns.forEach(b => { b.style.pointerEvents = ''; }); }
}

// Thousands of minutes is not a number anyone can feel. Past two hours it
// reads as hours; the exact minutes stay available in the Data room export.
function talkTime(mins) {
  const m = Math.round(Number(mins) || 0);
  if (m < 120) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 1000 ? `${h} hrs` : `${(h / 1000).toFixed(1)}k hrs`;
}

async function loadInsights() {
  const sb = getSupabase();
  const el = document.getElementById('insights');
  if (!el) return;
  try {
    const [fin, reach, pipe, reqs] = await Promise.all([
      sb.rpc('get_insight_financial'), sb.rpc('get_insight_reach'), sb.rpc('get_insight_pipeline'),
      // Asks come from get_requirements_by_cancer, which counts one ask per
      // call per category across BOTH the ticked list and the typed note. The
      // old get_insight_requirements added a keyword sweep of caller_notes on
      // top of the ticked list, so every ticked call was counted twice and the
      // headline read roughly double. See sql/62.
      sb.rpc('get_requirements_by_cancer', { p_gi_subtype: 'all', p_metric: 'mentions' }),
    ]);
    const f = fin.data || []; const r = reach.data || {}; const p = pipe.data || {};
    const rq = reqs.data?.rows || [];
    const totalP = f.reduce((a, x) => a + Number(x.n), 0) || 1;
    const uninsured = (f.find(x => x.status === 'uninsured')?.n) || 0;
    const uninsuredPct = Math.round((uninsured / totalP) * 100);
    const connectPct = r.total ? Math.round((r.connected / r.total) * 100) : 0;
    const topReq = rq[0]?.label || 'N/A';
    const cards = [
      { ico: 'shieldCheck', cls: 'warn', big: `${uninsuredPct}%`, label: 'Uninsured: need financial aid', sub: `${uninsured} of ${totalP} people` },
      { ico: 'phoneCall', cls: 'ok', big: `${connectPct}%`, label: 'Calls connected', sub: `${r.connected || 0} of ${r.total || 0} · ${r.avg_duration || 0} min avg` },
      // Talk time. The connect rate says how many families picked up; this says
      // whether the team actually sat with them once they did.
      { ico: 'clock', cls: 'violet', big: talkTime(r.talk_mins), label: 'Time with families',
        sub: `${r.avg_connected_duration || 0} min per connected call` },
      { ico: 'inbox', cls: '', big: `${p.never_called || 0}`, label: 'New leads waiting', sub: `${p.unassigned || 0} unassigned · ${p.engaged || 0} engaged` },
      { ico: 'heart', cls: 'violet', big: topReq, label: 'Most asked for',
        sub: rq[0] ? `${rq[0].n} asks from ${rq[0].patients} families` : 'Start capturing on calls' },
    ];
    el.innerHTML = `<div class="stats">${cards.map(c => `
      <div class="stat"><span class="stat-ico ${c.cls}">${icon(c.ico)}</span>
        <div style="min-width:0"><div class="stat-num" style="font-size:${String(c.big).length > 6 ? '16px' : '24px'}">${c.big}</div><div class="stat-lbl">${c.label}</div>
        <div class="due-meta" style="margin-top:2px">${c.sub}</div></div></div>`).join('')}</div>
      <div id="care-insights" style="margin-top:var(--s4)"></div>`;
    loadCareInsights();
  } catch (err) { console.error('Insights error:', err); el.innerHTML = ''; }
}

// Second insight row: lifecycle mix, support delivered, measurable impact.
async function loadCareInsights() {
  const sb = getSupabase();
  const el = document.getElementById('care-insights');
  if (!el) return;
  try {
    const [mixR, covR, deltaR] = await Promise.all([
      sb.rpc('get_status_mix'), sb.rpc('get_support_coverage'), sb.rpc('get_impact_deltas'),
    ]);
    const mix = mixR.data || [], cov = covR.data || [], deltas = deltaR.data || [];
    const n = (k) => Number(mix.find(m => m.status === k)?.n || 0);
    const totalSupports = cov.reduce((a, c) => a + Number(c.n), 0);
    const aidTotal = cov.reduce((a, c) => a + Number(c.total_amount || 0), 0);
    const sessions = cov.reduce((a, c) => a + Number(c.total_sessions || 0), 0);
    const withFollowup = deltas.reduce((a, d) => a + Number(d.with_followup || 0), 0);
    const cards = [
      { ico: 'users', cls: '', big: `${n('active')}`, label: 'Actively supported', sub: `${n('new_lead')} new leads · ${n('inactive')} inactive · ${n('deceased')} remembered` },
      { ico: 'handHeart', cls: 'ok', big: `${totalSupports}`, label: 'Support levers delivered', sub: totalSupports ? `${cov.length} kinds of help` : 'Flip levers on patient pages' },
      { ico: 'shieldCheck', cls: 'warn', big: aidTotal ? `₹${Math.round(aidTotal).toLocaleString('en-IN')}` : `${sessions}`, label: aidTotal ? 'Financial aid availed' : 'Care sessions held', sub: aidTotal ? `${sessions} care sessions on top` : 'nutrition + well-being' },
      { ico: 'activity', cls: 'violet', big: `${withFollowup}`, label: 'Wellbeing re-assessed', sub: withFollowup ? 'baseline → follow-up tracked' : 'Add baseline scores to begin' },
    ];
    el.innerHTML = `<div class="stats">${cards.map(c => `
      <div class="stat"><span class="stat-ico ${c.cls}">${icon(c.ico)}</span>
        <div style="min-width:0"><div class="stat-num" style="font-size:${String(c.big).length > 8 ? '16px' : '24px'}">${c.big}</div><div class="stat-lbl">${c.label}</div>
        <div class="due-meta" style="margin-top:2px">${c.sub}</div></div></div>`).join('')}</div>`;
  } catch (err) { console.error('Care insights error:', err); el.innerHTML = ''; }
}

async function renderSpecialistStats(id) {
  const sb = getSupabase();
  const role = getUserRole();
  let s = {};
  try { const { data } = await sb.rpc('get_specialist_stats', { p_user_id: id }); s = data || {}; } catch (e) { console.warn('specialist stats', e); }
  // Optional outreach the builder picked for this nutritionist today (sql/88).
  let outMine = null;
  if (role === 'nutritionist') {
    try {
      const { data } = await sb.rpc('get_nutrition_outreach');
      outMine = (data || []).filter(r => r.mine).length;
    } catch (e) { console.warn('outreach count', e); }
  }
  // Fall back gracefully if the DB predates v49 (no mine/pool split yet).
  const mine = s.my_patients ?? s.domain_patients ?? 0;
  const pool = s.domain_patients ?? 0;
  const poolName = role === 'nutritionist' ? 'nutrition pool' : 'well-being pool';
  const hero = document.getElementById('hero-metrics');
  if (hero) hero.innerHTML = `
    <div class="hero-card teal"><span class="hc-ico">${icon('users')}</span><div class="hc-label">People in your care</div><div class="hc-num">${mine}</div>
      <div class="hc-sub">${s.my_patients != null ? `yours, of ${pool} in the ${poolName}` : 'routed to you for support'}</div></div>
    <div class="hero-card paper"><span class="hc-ico">${icon('activity')}</span><div class="hc-label">Well-being check-ins</div><div class="hc-num">${s.assessments_logged || 0}</div>
      <div class="hc-sub">${s.assessments_month || 0} this month</div></div>`;
  const grid = document.getElementById('stats');
  if (grid) grid.innerHTML = [
    { ico: 'users', cls: '', num: mine, lbl: 'People in your care' },
    { ico: role === 'nutritionist' ? 'handHeart' : 'heart', cls: 'ok', num: s.unclaimed ?? '…',
      lbl: 'Waiting to be claimed', go: role === 'nutritionist' ? 'nutrition' : null },
    ...(outMine != null ? [{ ico: 'phone', cls: 'warn', num: outMine, lbl: 'To offer nutrition today', go: 'nutrition' }] : []),
    { ico: 'heart', cls: '', num: s.new_this_month || 0, lbl: 'New this month' },
    { ico: 'activity', cls: 'warn', num: s.assessments_month || 0, lbl: 'Check-ins this month' },
  ].map(c => `<div class="stat${c.go ? ' clickable' : ''}"${c.go ? ` data-go="${c.go}" style="cursor:pointer"` : ''}><span class="stat-ico ${c.cls}">${icon(c.ico)}</span><div><div class="stat-num tnum">${c.num}</div><div class="stat-lbl">${c.lbl}</div></div></div>`).join('');
  grid?.querySelectorAll('[data-go]').forEach(el => el.addEventListener('click', () => navigate(el.dataset.go)));
}

// Specialist side card: the actual people (names, numbers, context),
// not a bare count. Nutritionists get their continuity patients from the
// worklist; therapists get the sessions sitting with them.
async function loadSpecialistPeople(role) {
  const sb = getSupabase();
  const me = getCurrentProfile();
  const el = document.getElementById('due-today'); const countEl = document.getElementById('due-count');
  if (!el || !me?.id) return;
  try {
    if (role === 'nutritionist') {
      const { data, error } = await sb.rpc('get_nutrition_worklist');
      if (error) throw error;
      const rows = data || [];
      // v89: ownership is explicit now - "mine" means somebody pressed
      // Claim, or a lead assigned them. The card still shows unclaimed
      // people underneath, because a nutritionist who has claimed nobody
      // yet must not open the app to an empty screen while dozens wait.
      const mine = rows.filter(r => r.continuity_id === me.id);   // worklist is oldest-contact-first already
      const unclaimed = rows.filter(r => !r.continuity_id);
      const shown = [...mine, ...unclaimed].slice(0, 8);
      if (countEl) countEl.textContent = mine.length
        ? `${mine.length} yours · ${unclaimed.length} waiting`
        : `${unclaimed.length} waiting`;
      if (!rows.length) {
        el.innerHTML = `<div class="empty" style="padding:var(--s6)"><div class="ico-wrap">${icon('leaf')}</div>
          <h4>Nobody is in nutrition care yet</h4>
          <p>People arrive here when a mentor marks <strong>Nutritionist assigned</strong>, when nutrition work is logged, or when a lead assigns them to you.</p></div>`;
        return;
      }
      el.innerHTML = `<div class="due-list">${shown.map(p => {
        const mineRow = p.continuity_id === me.id;
        const name = p.full_name || p.patient_code || 'Patient';
        const mustChip = p.must_score != null
          ? ` · <span style="color:var(--${Number(p.must_score) >= 2 ? 'danger' : Number(p.must_score) === 1 ? 'warn' : 'ok'})">MUST ${p.must_score}</span>`
          : '';
        const meta = ([p.city, p.gi_subtype || p.cancer_type].filter(Boolean).join(' · ') || (p.patient_code || '')) + mustChip;
        const tag = mineRow
          ? `<span class="badge badge-primary" title="Yours. You claimed them, or a lead assigned them to you.">Yours</span>`
          : `<span class="badge badge-gold" title="Nobody is holding them yet. Press Claim on the Nutrition page.">Unclaimed</span>`;
        return `<div class="due-row clickable" data-pid="${p.patient_id}" style="cursor:pointer"><span class="avatar avatar-sm" style="background:${avatarColor(name)}">${initials(name)}</span><div class="grow" style="flex:1;min-width:0"><div class="due-name">${name}</div><div class="due-meta">${meta}</div></div>${tag}</div>`;
      }).join('')}</div>${unclaimed.length && shown.length < (mine.length + unclaimed.length)
        ? `<div class="due-meta" style="padding:10px 14px;color:var(--ink-3)">+ ${mine.length + unclaimed.length - shown.length} more in the nutrition pool: open the full worklist to claim them.</div>`
        : ''}`;
      el.querySelectorAll('[data-pid]').forEach(r => r.addEventListener('click', () => navigate('patients/' + r.dataset.pid)));
    } else {
      const { data, error } = await sb.from('care_sessions')
        .select('id, kind, status, scheduled_at, created_at, patients(id, full_name, patient_code)')
        .eq('assigned_to', me.id).in('status', ['agreed', 'scheduled'])
        .order('scheduled_at', { ascending: true }).limit(8);
      if (error) throw error;
      const rows = data || [];
      if (countEl) countEl.textContent = rows.length;
      if (!rows.length) {
        el.innerHTML = `<div class="empty" style="padding:var(--s6)"><div class="ico-wrap" style="background:var(--ok-soft);color:var(--ok)">${icon('checkCircle')}</div><h4>No sessions waiting</h4><p>When someone says yes on a call, their session lands on the 1:1 Sessions page.</p></div>`;
        return;
      }
      el.innerHTML = `<div class="due-list">${rows.map(r => {
        const name = r.patients?.full_name || r.patients?.patient_code || 'Patient';
        const when = r.scheduled_at ? new Date(r.scheduled_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : 'needs a date';
        return `<div class="due-row clickable" data-pid="${r.patients?.id || ''}" style="cursor:pointer"><span class="avatar avatar-sm" style="background:${avatarColor(name)}">${initials(name)}</span><div class="grow" style="flex:1;min-width:0"><div class="due-name">${name}</div><div class="due-meta">${capitalize(r.kind)} · ${when}</div></div><span class="badge badge-${r.status === 'scheduled' ? 'primary' : 'gold'}">${r.status === 'scheduled' ? 'Scheduled' : 'Said yes'}</span></div>`;
      }).join('')}</div>`;
      el.querySelectorAll('[data-pid]').forEach(r => r.addEventListener('click', () => { if (r.dataset.pid) navigate('patients/' + r.dataset.pid); }));
    }
  } catch (err) {
    console.error('Specialist people error:', err);
    el.innerHTML = `<div class="empty" style="padding:var(--s6)"><p>Could not load your people.</p></div>`;
  }
}

// Specialists don't dial. Their story is check-ins, not call logs.
async function loadRecentCheckins() {
  const sb = getSupabase();
  const me = getCurrentProfile();
  const el = document.getElementById('recent-calls');
  if (!el || !me?.id) return;
  try {
    const { data, error } = await sb.from('patient_assessments')
      .select('measure, score, recorded_at, patients(id, full_name, patient_code)')
      .eq('recorded_by', me.id)
      .order('recorded_at', { ascending: false }).limit(6);
    if (error) throw error;
    if (!data || data.length === 0) {
      el.innerHTML = `<div class="empty"><div class="ico-wrap">${icon('activity')}</div><h4>No check-ins yet</h4><p>Open someone from “Your people” and record a check-in. It appears here and in the impact analytics.</p></div>`;
      return;
    }
    el.innerHTML = `<div class="table-wrap"><table class="data"><thead><tr><th>Patient</th><th>Measure</th><th>Score</th><th>When</th></tr></thead><tbody>
      ${data.map(a => { const name = a.patients?.full_name || a.patients?.patient_code || 'N/A';
        return `<tr class="clickable" data-id="${a.patients?.id || ''}"><td><div style="display:flex;align-items:center;gap:8px"><span class="avatar avatar-sm" style="background:${avatarColor(name)}">${initials(name)}</span>${name}</div></td>
          <td>${measureLabel(a.measure)}</td><td class="cell-mono">${a.score}</td><td style="color:var(--ink-2)">${formatRelativeTime(a.recorded_at)}</td></tr>`; }).join('')}
      </tbody></table></div>`;
    el.querySelectorAll('tr.clickable').forEach(tr => tr.addEventListener('click', () => { if (tr.dataset.id) navigate(`patients/${tr.dataset.id}`); }));
  } catch (err) { console.error('Recent check-ins error:', err); }
}

async function loadStats() {
  const sb = getSupabase();
  const role = getUserRole();
  if (['nutritionist', 'therapist'].includes(role)) return renderSpecialistStats(getCurrentProfile()?.id);
  try {
    // Org view for admin/manager/content; everyone else gets THEIR own numbers
    // (including a manager's "Open as" target).
    const org = isManagerOrAdmin() || role === 'content';
    const { data, error } = await sb.rpc('get_dashboard_stats', { p_user_id: org ? null : (getCurrentProfile()?.id || null) });
    if (error) throw error;
    const s = data || {};
    const hero = document.getElementById('hero-metrics');
    if (hero) {
      const connected = s.connected_today || 0, totalCalls = s.total_calls_today || 0, due = s.pending_follow_ups || 0;
      // The due tile opens the calling portal, a number you can act on,
      // not a static count.
      const canCall = isManagerOrAdmin() || ['caller', 'caregiver_mentor'].includes(role);
      hero.innerHTML = `
        <div class="hero-card teal"><span class="hc-ico">${icon('handHeart')}</span><div class="hc-label">Reached today</div><div class="hc-num">${connected}</div>
          <div class="hc-sub">${totalCalls ? `of ${totalCalls} ${totalCalls === 1 ? 'call' : 'calls'} connected` : 'No calls logged yet today'}</div></div>
        <div class="hero-card paper" id="hero-due" ${canCall ? 'style="cursor:pointer" title="Open the calling portal"' : ''}><span class="hc-ico">${icon('clock')}</span><div class="hc-label">Check-ins due</div><div class="hc-num">${due}</div>
          <div class="hc-sub">${due ? 'Follow-ups and callbacks waiting' : "You're all caught up."}</div></div>`;
      if (canCall) document.getElementById('hero-due')?.addEventListener('click', () => navigate('calling'));
    }
    const grid = document.getElementById('stats');
    if (grid) {
      const cards = [
        { ico: 'users', cls: '', num: s.total_patients || 0, lbl: 'People in our care' },
        { ico: 'shieldCheck', cls: 'ok', num: `${s.consent_rate || 0}%`, lbl: 'Consent on record' },
        { ico: 'heart', cls: '', num: s.patients_this_month || 0, lbl: 'New this month' },
      ];
      if (isManagerOrAdmin()) cards.push({ ico: 'activity', cls: 'warn', num: s.avg_conversion_score || 0, lbl: 'Avg. engagement (of 10)' });
      grid.innerHTML = cards.map(c => `<div class="stat"><span class="stat-ico ${c.cls}">${icon(c.ico)}</span><div><div class="stat-num tnum">${c.num}</div><div class="stat-lbl">${c.lbl}</div></div></div>`).join('');
    }
  } catch (err) {
    console.warn('Dashboard stats error:', err);
    // "Failed to fetch" = request aborted by navigation/reload or a network
    // blip. The page is already usable, don't alarm the user.
    if (!String(err?.message || err).includes('Failed to fetch')) showToast('Could not load dashboard summary', 'error');
  }
}

async function loadRecentCalls() {
  const sb = getSupabase();
  try {
    // Recent conversations are scoped to the effective user (caller / "Open as"); managers see org-wide.
    let q = sb.from('call_logs').select('*, patients(patient_code, full_name, cancer_type)').order('call_date', { ascending: false }).limit(6);
    if (!isManagerOrAdmin()) { const me = getCurrentProfile(); if (me?.id) q = q.eq('caller_id', me.id); }
    const { data, error } = await q;
    if (error) throw error;
    const el = document.getElementById('recent-calls'); if (!el) return;
    if (!data || data.length === 0) { el.innerHTML = `<div class="empty"><div class="ico-wrap">${icon('phoneCall')}</div><h4>No conversations yet</h4><p>Once you start logging calls, they'll appear here.</p></div>`; return; }
    const condBadge = (k) => { const m = { improving: ['ok', 'Improving'], stable: ['info', 'Stable'], declining: ['warn', 'Declining'], critical: ['danger', 'Critical'] }[k]; return m ? `<span class="badge badge-${m[0]}">${m[1]}</span>` : '<span style="color:var(--ink-3)">N/A</span>'; };
    el.innerHTML = `<div class="table-wrap"><table class="data"><thead><tr><th>Patient</th><th>Outcome</th><th class="col-hide-sm">Duration</th><th class="col-hide-sm">Condition</th><th>When</th></tr></thead><tbody>
      ${data.map(c => { const name = c.patients?.full_name || c.patients?.patient_code || 'N/A'; const dur = c.call_duration_mins ? `${c.call_duration_mins} min` : '<span style="color:var(--ink-3)">N/A</span>';
        return `<tr class="clickable" data-id="${c.patient_id || ''}"><td><div style="display:flex;align-items:center;gap:8px"><span class="avatar avatar-sm" style="background:${avatarColor(name)}">${initials(name)}</span>${name}</div></td>
          <td>${outcomeBadge(c.dial_status)}</td><td class="cell-mono col-hide-sm">${dur}</td><td class="col-hide-sm">${condBadge(c.patient_condition)}</td><td style="color:var(--ink-2)">${formatRelativeTime(c.call_date)}</td></tr>`; }).join('')}
      </tbody></table></div>`;
    el.querySelectorAll('tr.clickable').forEach(tr => tr.addEventListener('click', () => { if (tr.dataset.id) navigate(`patients/${tr.dataset.id}`); }));
  } catch (err) { console.error('Recent calls error:', err); }
}

async function loadDueToday(isIntake = false) {
  const sb = getSupabase();
  try {
    const me = getCurrentProfile(); const admin = isManagerOrAdmin();
    if (isIntake) {
      if (!me?.id) return;
      const { data, error } = await sb.from('patients')
        .select('id, full_name, patient_code, city, treating_hospital, created_at')
        .eq('created_by', me.id)
        .order('created_at', { ascending: false })
        .limit(8);
      if (error) throw error;
      const el = document.getElementById('due-today'); const countEl = document.getElementById('due-count');
      if (!el) return; if (countEl) countEl.textContent = data?.length || 0;
      if (!data || data.length === 0) {
        el.innerHTML = `<div class="empty" style="padding:var(--s6)"><div class="ico-wrap" style="background:var(--ok-soft);color:var(--ok)">${icon('upload')}</div><h4>No uploads yet</h4><p>Use Upload leads to add numbers gathered on the ground.</p></div>`;
        return;
      }
      el.innerHTML = `<div class="due-list">${data.map(p => { const name = p.full_name || p.patient_code || 'Lead';
        const place = [p.treating_hospital, p.city].filter(Boolean).join(' · ') || 'Ground intake';
        return `<div class="due-row"><span class="avatar avatar-sm" style="background:${avatarColor(name)}">${initials(name)}</span><div class="grow" style="flex:1;min-width:0"><div class="due-name">${name}</div><div class="due-meta">${place}</div></div><span class="badge badge-neutral">${formatRelativeTime(p.created_at)}</span></div>`; }).join('')}</div>`;
      return;
    }
    if (!admin) {
      if (!me?.id) return; // profile still loading. RLS would hide rows anyway
      return loadMyWorklistCard();
    }
    const { data, error } = await sb.from('call_queue').select('id, status, source, scheduled_for, priority, patients(full_name, patient_code)').eq('status', 'pending').order('source', { ascending: true }).limit(8);
    if (error) throw error;
    const el = document.getElementById('due-today'); const countEl = document.getElementById('due-count');
    if (!el) return; if (countEl) countEl.textContent = data?.length || 0;
    if (!data || data.length === 0) { el.innerHTML = `<div class="empty" style="padding:var(--s6)"><div class="ico-wrap" style="background:var(--ok-soft);color:var(--ok)">${icon('checkCircle')}</div><h4>${admin ? 'No calls queued' : 'All caught up'}</h4><p>${admin ? "Click 'Build today's assignments' to generate the list." : 'Nothing assigned to you right now.'}</p></div>`; return; }
    el.innerHTML = `<div class="due-list">${data.map(q => { const name = q.patients?.full_name || q.patients?.patient_code || 'N/A'; const kind = q.source === 'followup' ? 'Follow-up' : 'New lead';
      const tone = q.source === 'followup' ? 'primary' : 'gold';
      return `<div class="due-row"><span class="avatar avatar-sm" style="background:${avatarColor(name)}">${initials(name)}</span><div class="grow" style="flex:1;min-width:0"><div class="due-name">${name}</div><div class="due-meta">${kind}</div></div><span class="badge badge-${tone}">${capitalize(q.priority || 'medium')}</span></div>`; }).join('')}</div>`;
  } catch (err) { console.error('Due-today error:', err); const el = document.getElementById('due-today'); if (el) el.innerHTML = `<div class="empty" style="padding:var(--s6)"><p>Could not load the list.</p></div>`; }
}

// Callers: "Your list today" mirrors EXACTLY what the calling portal will
// serve. get_my_worklist is the same definition behind get_next_call. No
// more "4 follow-ups" the portal then refuses to serve: the badge counts
// only servable people, and resting ones stay visible in a collapsed group
// with the date they resurface instead of silently vanishing.
async function loadMyWorklistCard() {
  const sb = getSupabase();
  const el = document.getElementById('due-today'); const countEl = document.getElementById('due-count');
  if (!el) return;
  try {
    const { data, error } = await sb.rpc('get_my_worklist');
    if (error) throw error;
    const rows = data || [];
    const servable = rows.filter(r => r.servable).sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999));
    const waiting = rows.filter(r => !r.servable)
      .sort((a, b) => String(a.resting_until || a.scheduled_for || '9999').localeCompare(String(b.resting_until || b.scheduled_for || '9999')));
    if (countEl) countEl.textContent = servable.length;
    if (!rows.length) {
      el.innerHTML = `<div class="empty" style="padding:var(--s6)"><div class="ico-wrap" style="background:var(--ok-soft);color:var(--ok)">${icon('checkCircle')}</div><h4>All caught up</h4><p>Nothing assigned to you right now.</p></div>`;
      return;
    }
    const fmtDay = (d) => d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : 'soon';
    const servableHTML = servable.slice(0, 8).map(r => {
      const name = r.full_name || r.patient_code || 'N/A';
      const kind = r.source === 'followup' ? 'Follow-up' : 'New lead';
      const tone = r.source === 'followup' ? 'primary' : 'gold';
      const meta = r.overdue_days > 0
        ? `<span style="color:var(--${r.overdue_days >= 7 ? 'danger' : 'clay'})">${r.overdue_days}d overdue</span>`
        : (r.last_call_date ? `Last call ${formatRelativeTime(r.last_call_date)}` : 'First conversation');
      return `<div class="due-row clickable" data-nav="calling" style="cursor:pointer" title="Open the calling portal"><span class="avatar avatar-sm" style="background:${avatarColor(name)}">${initials(name)}</span><div class="grow" style="flex:1;min-width:0"><div class="due-name">${name}</div><div class="due-meta">${meta}</div></div><span class="badge badge-${tone}">${kind}</span></div>`;
    }).join('');
    const restingHTML = waiting.length ? `
      <details style="border-top:1px solid var(--line)">
        <summary style="cursor:pointer;padding:10px var(--s5);font:var(--t-xs);color:var(--ink-3)">Resting: resurfaces later · ${waiting.length}</summary>
        <div class="due-list" style="opacity:.6;padding-top:0">
          ${waiting.slice(0, 10).map(r => {
            const name = r.full_name || r.patient_code || 'N/A';
            const when = r.resting ? `resurfaces ${fmtDay(r.resting_until)}` : r.scheduled_for ? `scheduled ${fmtDay(r.scheduled_for)}` : 'waiting';
            return `<div class="due-row"><span class="avatar avatar-sm" style="background:${avatarColor(name)}">${initials(name)}</span><div class="grow" style="flex:1;min-width:0"><div class="due-name">${name}</div><div class="due-meta">${when}</div></div></div>`;
          }).join('')}
          ${waiting.length > 10 ? `<div class="due-meta" style="padding:8px 6px;color:var(--ink-3)">+ ${waiting.length - 10} more</div>` : ''}
        </div>
      </details>` : '';
    el.innerHTML = `${servable.length
      ? `<div class="due-list">${servableHTML}</div>${servable.length > 8 ? `<div class="due-meta" style="padding:0 var(--s5) var(--s3);color:var(--ink-3)">+ ${servable.length - 8} more: open the calling portal.</div>` : ''}`
      : `<div class="empty" style="padding:var(--s5)"><div class="ico-wrap" style="background:var(--ok-soft);color:var(--ok)">${icon('checkCircle')}</div><h4>No one to call right now</h4><p>Everyone on your list is resting or scheduled ahead.</p></div>`}
    ${restingHTML}`;
    el.querySelectorAll('[data-nav]').forEach(r => r.addEventListener('click', () => navigate('calling')));
  } catch (err) {
    console.error('Worklist card error:', err);
    el.innerHTML = `<div class="empty" style="padding:var(--s6)"><p>Could not load the list.</p></div>`;
  }
}

async function loadIntakeSummary() {
  const sb = getSupabase();
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const [{ count: newToday }, { count: unassigned }] = await Promise.all([
      sb.from('patients').select('*', { count: 'exact', head: true }).gte('created_at', since),
      sb.from('patients').select('*', { count: 'exact', head: true }).is('assigned_to', null).eq('do_not_call', false).not('patient_status', 'in', '(deceased,inactive)'),
    ]);
    const el = document.getElementById('intake-nums'); if (!el) return;
    el.innerHTML = `<div class="intake-num"><div class="n">${newToday || 0}</div><div class="l">Added today</div></div><div class="intake-num warn${(unassigned || 0) === 0 ? ' zero' : ''}"><div class="n">${unassigned || 0}</div><div class="l">Not yet assigned</div></div>`;
  } catch (err) { console.error('Intake summary error:', err); }
}
